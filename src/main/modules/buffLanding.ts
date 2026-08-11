// buffLanding.ts — THE GATE: what, if anything, does a landing sentence entitle the model to draw
// (JOS-140, rulings 2 and 3). Pure over the two collaborators it is handed; no state of its own.
//
// It lives beside `modules/buffs.ts` rather than inside it because that module was at its
// factoring ceiling and because this is one self-contained decision with four cases, each of which
// is a rule somebody will want to read on its own:
//
//   1. A NAMED ANCHOR wins. `You begin casting <S>.` names the spell AND the rank, so a candidate
//      with one of those inside the window resolves outright — and the row can then print the RANK
//      the landing line never carries (`Mesmerization VII`, not `Mesmerization`, which is also the
//      one field JOS-126 found the alerts tracker missing).
//   2. SEVERAL of your own casts sharing one sentence resolve to the MOST RECENT. Not a coin flip
//      between you and a stranger — every candidate here is yours — and the same recency rule
//      Task #34 shipped.
//   3. A QUICK BUFF BURST admits the landing as yours but names NO spell (owner amendment,
//      2026-08-09, from live testing: the AA applies many spells at once with no cast line of
//      their own, so a rule demanding one per spell would refuse the player's own buffs). Two
//      narrowings then apply, in order, and NEITHER admits anything — the burst already did:
//      a candidate you have ever cast, then a candidate you already have up. Failing both, the row
//      stays a FAMILY and states a duration only when every candidate agrees on one and on its
//      nature. A family mints nothing into the learner, ever.
//   4. Nothing else. An unanchored landing produces NOTHING — the Focus Death case, where one
//      sentence is six spells and the player cast none of them.

import { spellNature, type SpellDb } from '../data/spellDb'
import { statedDuration } from '../../shared/buffTimers'
import type { CastAnchors } from './buffAnchors'
import { spellKey } from './buffsShapes'

/** A candidate spell carried by an ambiguous landing message (Task #34). */
export interface Candidate {
  name: string
  durationMs: number | null
  illusion: boolean
}

/** What the gate admitted, in the shape `BuffInstances.applyMessageBuff` takes. */
export interface AdmittedLanding {
  /** The display name: the ranked cast name, the candidate's own name, or the joined family. */
  spell: string
  durationMs: number | null
  illusion: boolean
  caster: string
  /** The LINE this instance is identified by, when it differs from the display name. */
  lineKey?: string
  /** Present only for a family row — every spell the sentence could be (drives the ~ chip). */
  candidates?: string[]
}

/** Everything the gate needs to ask about, injected so this file stays testable and pure-ish. */
export interface LandingContext {
  anchors: CastAnchors
  db?: SpellDb
  /** True when an instance of this spell line is already up — the second burst narrowing. */
  hasActiveSpell: (lineKey: string) => boolean
}

/** One candidate resolved outright, with the display name the caller should print. */
function resolved(cand: Candidate, display: string, caster: string): AdmittedLanding {
  // The RANKED display name from the cast line, keyed on the rank-STRIPPED line — so the row reads
  // `Mesmerization VII` while the learner, the DB lookup and the instance identity all stay on the
  // one line the DB actually has a row for (ruling 4's pooling).
  return {
    spell: display,
    durationMs: cand.durationMs,
    illusion: cand.illusion,
    caster,
    lineKey: spellKey(cand.name)
  }
}

/** Case 1 and 2: the candidate with a NAMED anchor in window, most recently cast first. */
function namedLanding(cands: readonly Candidate[], ts: number, ctx: LandingContext): AdmittedLanding | null {
  let best: AdmittedLanding | null = null
  let bestTs = -1
  for (const c of cands) {
    const at = ctx.anchors.namedAnchorFor(c.name, ts)
    if (at == null) continue
    const t = ctx.anchors.lastCastTs(c.name) ?? -1
    if (t <= bestTs) continue
    best = resolved(c, at.display ?? c.name, at.caster)
    bestTs = t
  }
  return best
}

/** Burst narrowing (a): the candidate you have EVER cast, most recent first. */
function everCastLanding(cands: readonly Candidate[], caster: string, ctx: LandingContext): AdmittedLanding | null {
  let best: Candidate | null = null
  let bestTs = -1
  for (const c of cands) {
    const t = ctx.anchors.lastCastTs(c.name)
    if (t == null || t <= bestTs) continue
    best = c
    bestTs = t
  }
  return best ? resolved(best, best.name, caster) : null
}

/** Burst narrowing (b): the candidate you already have up (EQ stacking keeps one per family). */
function activeLanding(cands: readonly Candidate[], caster: string, ctx: LandingContext): AdmittedLanding | null {
  for (const c of cands) {
    if (ctx.hasActiveSpell(spellKey(c.name))) return resolved(c, c.name, caster)
  }
  return null
}

/**
 * A landing the burst admits but nobody can narrow — the shape the reporter of JOS-136 hit.
 *
 * MEASURED: their Quick Buff lands eleven spells in one second, and `is resistant to magic.` is
 * `Resist Magic`, `Group Resist Magic` AND `Resistance to Magic` in the committed DB. The old
 * resolver returned null for exactly this and the bar simply did not exist — which is a worse
 * answer than a family row whenever the ambiguity does not reach a claim.
 *
 * So a family is admitted only when it does not: every candidate must agree on NATURE (or the row
 * could not choose a window) and `statedDuration` must find one number they all state (world-model
 * law 3's rule, reused verbatim from the crowd-control half). Disagree on either and the answer is
 * still nothing, because a row that picked one of them would be the coin flip JOS-84 forbids —
 * which is what happens to that particular sentence, where the third candidate states 60 minutes
 * against the other two's 36.
 */
function familyLanding(cands: readonly Candidate[], caster: string, ctx: LandingContext): AdmittedLanding | null {
  const natures = new Set(cands.map((c) => spellNature(ctx.db?.byKey.get(spellKey(c.name))?.spellType)))
  if (natures.size !== 1) return null
  const durationMs = statedDuration(cands)
  if (durationMs == null) return null
  const names = [...new Set(cands.map((c) => c.name))].sort((a, b) => a.localeCompare(b))
  return {
    spell: names.join(' / '),
    durationMs,
    illusion: cands.every((c) => c.illusion),
    caster,
    // Keyed on the alphabetically first candidate's LINE — a stable pick, and a safe one only
    // because the family was admitted on unanimous nature and one agreed duration, so every
    // question the key answers has the same answer whichever member it names.
    lineKey: spellKey(names[0]),
    candidates: names
  }
}

/** THE GATE. See this file's header for the four cases, in order. */
export function admitLanding(cands: Candidate[], ts: number, ctx: LandingContext): AdmittedLanding | null {
  if (cands.length === 0) return null
  const named = namedLanding(cands, ts, ctx)
  if (named) return named
  // The spell-less self anchor. `attribute` reports `unnamed` for every candidate under a burst,
  // so asking with the first one is asking about the burst.
  const burst = ctx.anchors.attribute(cands[0].name, ts)
  if (burst?.unnamed !== true) return null
  if (cands.length === 1) return resolved(cands[0], cands[0].name, burst.caster)
  return (
    everCastLanding(cands, burst.caster, ctx) ??
    activeLanding(cands, burst.caster, ctx) ??
    familyLanding(cands, burst.caster, ctx)
  )
}
