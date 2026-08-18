// ROWS INTO LIKELIHOOD TERMS, and the fit over them (JOS-387, split out of resistModel.ts).
//
// Pure. The seam is one step of the pipeline: `resistModel.ts` decides WHICH rows are evidence and
// what to say about them afterwards, this file turns an admitted row into the one arithmetic object
// the fitter understands, and `resistFit.ts` turns a bag of those into a number with an interval.
// The split is along that seam because the three change for different reasons — the first when the
// ledger or the rules move, this one when the game's own formula does, the last when the statistics
// do — and because the pair was over the repo's 400-code-line ceiling (the rule there is SPLIT,
// never ratchet).
//
// ── WHY THREE LIKELIHOODS AND NOT ONE ───────────────────────────────────────────────────────────
//
// The log prints three genuinely different things and each one localises R differently. An
// all-or-nothing spell is a clean Bernoulli on rc/200 — the most informative evidence there is, and
// the cheapest to get wrong if a level or a debuff is unknown. A fixed-damage nuke additionally
// distinguishes "full" from "silently reduced", which pins rc from BOTH sides at once (the full
// rate and the resist-message rate are different functions of rc, so their agreement is a free
// consistency check). A variable-damage proc can only ever say "message or no message", which is
// rc/600 and nothing else.
//
// MISCLASSIFYING A FIXED SPELL AS VARIABLE IS SAFE; THE REVERSE IS NOT. P(resist message) is rc/600
// either way, so treating fixed-damage evidence as variable merely throws the partial information
// away. Treating a genuinely variable spell as fixed reads its ordinary low rolls as "partials" and
// invents resistance out of a damage range. `damageKind` (resistDamage.ts) is where that verdict is
// made and where its measurements live.

import {
  IMMUNE_LEVEL_MOD,
  effectiveResistAdj,
  levelMod,
  pFullDamage,
  pResistAon,
  pResistMessage,
  priorResist,
} from './resistFormula'
import { type DamageRef, damageKind, splitDamage } from './resistDamage'
import type { ResistAxis, ResistRow, SpellResistInfo, SpellResistTable } from './resistTypes'
import { type GridFit, gridFit } from './resistFit'

/**
 * THE SMALLEST PROBABILITY ANY OUTCOME IS ALLOWED TO HAVE. The roll is a discrete 1..200, so an
 * outcome that the model says is impossible really is impossible — but a likelihood that answers
 * -infinity to one stray observation lets a single mis-parsed line decide the whole fit. A
 * half-count floor (0.5 / 200) is the standard regularisation and it costs nothing: it is applied
 * uniformly across every rc in an unidentifiable region, so a flat likelihood stays flat.
 */
const P_FLOOR = 1 / 400

/** log of a probability, floored at both ends. */
function lg(p: number): number {
  return Math.log(p < P_FLOOR ? P_FLOOR : p > 1 - P_FLOOR ? 1 - P_FLOOR : p)
}

export type Term =
  | { kind: 'aon'; offset: number; resist: number; land: number; weight: number }
  | { kind: 'ddFix'; offset: number; full: number; partial: number; resist: number; weight: number }
  | { kind: 'ddVar'; offset: number; land: number; resist: number; weight: number }

function termLogL(term: Term, R: number): number {
  const rc = R + term.offset
  if (term.kind === 'aon') {
    const p = pResistAon(rc)
    return term.resist * lg(p) + term.land * lg(1 - p)
  }
  if (term.kind === 'ddVar') {
    const p = pResistMessage(rc)
    return term.resist * lg(p) + term.land * lg(1 - p)
  }
  const full = pFullDamage(rc)
  const msg = pResistMessage(rc)
  return term.full * lg(full) + term.partial * lg(1 - full - msg) + term.resist * lg(msg)
}

function totalLogL(terms: Term[], R: number): number {
  let sum = 0
  for (const t of terms) sum += t.weight * termLogL(t, R)
  return sum
}

/** How many observations one term carries, whatever shape they came in. */
export function termN(t: Term): number {
  if (t.kind === 'aon') return t.resist + t.land
  if (t.kind === 'ddVar') return t.resist + t.land
  return t.full + t.partial + t.resist
}

/** How many resist messages the model expects across these terms at this R. */
function expectedResists(terms: Term[], R: number): number {
  let sum = 0
  for (const t of terms) {
    const rc = R + t.offset
    const p = t.kind === 'aon' ? pResistAon(rc) : pResistMessage(rc)
    sum += t.weight * termN(t) * p
  }
  return sum
}

/** How many the game actually printed, weighted the same way. */
function obsResists(terms: Term[]): { resisted: number; total: number } {
  let resisted = 0
  let total = 0
  for (const t of terms) {
    resisted += t.weight * t.resist
    total += t.weight * termN(t)
  }
  return { resisted, total }
}

/**
 * WHAT THE OBSERVATIONS THEMSELVES SAY, with no model in the way (owner review, 2026-08-16).
 *
 *   `resisted`  the game printed the resist message. This is the number the "does not fit the
 *               model" sentence prints, because it is the one a player can check against their own
 *               memory of the pull.
 *   `hard`      resisted, OR silently reduced. Partial damage is the game telling you the roll went
 *               against you on a spell that cannot be refused outright, so the hard data rule reads
 *               it as the same answer.
 */
export function empiricalOf(terms: Term[]): { total: number; resisted: number; hard: number } {
  let total = 0
  let resisted = 0
  let hard = 0
  for (const t of terms) {
    total += termN(t)
    resisted += t.resist
    hard += t.kind === 'ddFix' ? t.resist + t.partial : t.resist
  }
  return { total, resisted, hard }
}

/**
 * THE PRIOR IS A WEAK PENALTY ON R ITSELF, not four pseudo-observations (JOS-387).
 *
 * The pseudo-observation prior was written for a fitter that used it ONLY to pick a point out of
 * the likelihood's maximum and computed the interval from the likelihood alone — and it had to be,
 * because it is pathological at the model's own boundary: its four pseudo-LANDINGS are impossible
 * once rc reaches 200, so their log-likelihood floors at -6 apiece and the prior charges 22 log
 * units to say "this mob resists everything". That is not shrinkage, it is a wall.
 *
 * Once the point AND the interval both come off one posterior (`resistFit.ts`), that wall would
 * decide both. So the prior is what it always meant: a broad Gaussian pull toward the Torven
 * typical value, which never says a resistance is impossible, costs about a log unit at 140 points
 * away from the baseline, and is swamped by any real evidence.
 */
export const PRIOR_SIGMA = 100

export function priorLog(axis: ResistAxis, mobLevel: number | null): (R: number) => number {
  const centre = priorResist(axis, mobLevel)
  return (R) => {
    const d = R - centre
    return -(d * d) / (2 * PRIOR_SIGMA * PRIOR_SIGMA)
  }
}

/**
 * ONE POSTERIOR, TWO NUMBERS: the median and the central 95%.
 *
 * The evidence plus the mild Torven prior make one distribution over R, and both the point and the
 * interval are read off it. The arithmetic, and the measured argument for the median over the
 * maximum (a saturating likelihood has PLATEAUX, and the argmax sits at the weakest edge of one),
 * lives in `resistFit.ts`.
 */
export function fitTerms(terms: Term[], prior: (R: number) => number): GridFit {
  return gridFit((R) => totalLogL(terms, R) + prior(R), (R) => expectedResists(terms, R), obsResists(terms))
}

/** The debuff amount one slot delivers on this axis at this caster level. */
function slotAmount(slot: { base: number; calc: number; max: number }, level: number | null): number {
  const base = Math.abs(slot.base)
  const max = Math.abs(slot.max)
  const lvl = level ?? 60
  let v = base
  if (slot.calc === 101) v = base + lvl / 2
  else if (slot.calc === 102) v = base + lvl
  if (max > 0 && v > max) v = max
  return v
}

/**
 * Total resist reduction on this axis from the debuffs the row recorded. The row stores WHICH
 * debuffs were up, never how much they were worth — the amount is a function of the client's
 * spell data and the caster's level, so a patch that retunes Malaise re-estimates instead of
 * re-folding. The debuff's own caster is not recorded, so the row's caster level stands in for
 * it; where that is unknown the slot's cap is used, which is what a max-level caster produces.
 */
export function debuffAmount(
  debuffs: string,
  axis: ResistAxis,
  level: number | null,
  spells: SpellResistTable
): number {
  if (debuffs === '') return 0
  let total = 0
  for (const key of debuffs.split('|')) {
    const slots = spells[key]?.debuffSlots
    if (!slots) continue
    for (const slot of slots) {
      if (slot.axis !== axis && slot.axis !== 'all') continue
      total += slotAmount(slot, level)
    }
  }
  return total
}

/**
 * What one row is read against: the client's facts about its spell, the axis being asked about,
 * the table the debuff amounts come out of, and what the whole ledger knows about this (spell,
 * caster level)'s damage. An OBJECT rather than four more positional parameters — the repo's
 * `max-params` ceiling is 4 and this is the fifth, but the real reason is that they are one context
 * and read better named.
 */
export interface RowCtx {
  info: SpellResistInfo
  axis: ResistAxis
  spells: SpellResistTable
  /**
   * The full-damage reference, and whether the spell produces partials at all
   * (shared/resistDamage.ts). Undefined means the histogram could not name a reference, and the row
   * is then read as variable damage: resist-or-not, no partial information.
   */
  mode: DamageRef | undefined
}

/** One row -> one likelihood term, or null when the row cannot say anything about R. */
export function rowTerm(row: ResistRow, ctx: RowCtx): Term | null {
  const { info, axis, spells, mode } = ctx
  if (row.casterLevel === null || row.mobLevel === null) return null
  const lm = levelMod(row.casterLevel, row.mobLevel)
  if (lm === IMMUNE_LEVEL_MOD) return null
  // THE CAST'S OWN ADJUST, not the spell's (JOS-387): a rank is -15 each and the overchannel
  // invocation is -150 plus -15 per non-hybrid caster class, and both moved the roll this row
  // counts. The row carries them so a baseline observation is read at the offset it was MADE under.
  const adj = effectiveResistAdj(info.resistAdj, row)
  const offset = lm + adj - debuffAmount(row.debuffs, axis, row.casterLevel, spells)
  const kind = damageKind(row, info, mode)
  const { total, full, partial } = splitDamage(row, kind === 'ddFix' ? mode?.value : undefined)
  if (total === 0) {
    if (row.resist + row.land === 0) return null
    return { kind: 'aon', offset, resist: row.resist, land: row.land, weight: 1 }
  }
  // A DoT OR A PROC LANDS OR IS REFUSED, so its damage lines are LANDINGS and the clean Bernoulli
  // is the right likelihood for them (JOS-387; see `PARTIAL_FREE_AT`).
  if (kind === 'aon') return { kind: 'aon', offset, resist: row.resist, land: total + row.land, weight: 1 }
  if (kind === 'ddFix') return { kind: 'ddFix', offset, full, partial, resist: row.resist, weight: 1 }
  return { kind: 'ddVar', offset, land: total + row.land, resist: row.resist, weight: 1 }
}
