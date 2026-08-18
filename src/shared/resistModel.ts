// RESIST ESTIMATION — the pure math (JOS-382, docs/plans/resist-mining.md section 4.3).
//
// No Electron, no node, no React. Unit-tested against SYNTHETIC ROLLS in
// tests/resistModel.test.mts: the test simulates the Live formula for known R, level gaps,
// resist adjusts and debuffs, feeds the resulting rows back through `estimate()`, and asserts the
// true R lands inside the reported interval. A model that cannot recover a number it generated
// itself has no business estimating one off the log.
//
// THE FILE IS ONE STEP OF FOUR, and the other three are its neighbours. `resistFormula.ts` is what
// the game does with a roll; `resistTerms.ts` turns an admitted row into a likelihood term and
// carries the prior; `resistFit.ts` turns a bag of terms into a number with an interval. THIS file
// is the half that decides which rows are evidence at all, and what to say about the answer
// afterwards — the blindness guard, the invocation holdout, the npc switch, the baseline weighting,
// the per-spell drilldown and the three verdicts the surfaces read. The splits happened as the pair
// crossed the repo's 400-code-line ceiling (JOS-385, then JOS-387); the rule there is SPLIT, never
// ratchet.
//
// ---------------------------------------------------------------------------------------------
// AND ONE SPELL CAN POISON A WHOLE AXIS, SO THE ESTIMATOR CHECKS FOR IT (JOS-382, round 2).
//
// A binomial needs both outcomes. If every observation this app has of a spell is a RESIST — no
// landing, no damage number, nothing — then the maximum-likelihood answer is "rc is as large as
// the grid allows", and one such spell drags the whole axis to "nearly immune" however much honest
// evidence sits beside it. The cause is never a mob that resists everything; it is a spell whose
// LANDINGS we cannot see.
//
// MEASURED, and this is why the guard is general rather than a fix for one spell: the first
// shipped baseline carried Largo's Melodic Binding at 400 resists and 0 landings (a bard song
// under the Symphonic Aura, whose pulses print no cast line for the landing emote to join to) AND
// 'clumsiness strike' at 37 resists and 0 landings (a proc whose landing prints nothing at all).
// Two different causes, one shape. 'landingsNotObservable' is that shape: it is decided across the
// WHOLE ledger for the axis, so a mob that genuinely resisted every cast of a spell that lands
// elsewhere is untouched, and the rows stay in the per-spell drilldown saying exactly why.
//
// ---------------------------------------------------------------------------------------------
// YOUR OWN LOG BEATS THE FROZEN BASELINE (owner, 2026-08-16 — patch resilience). The shipped
// baseline is a snapshot of one player's four weeks; a future patch that retunes a mob makes it
// wrong, and the person who finds out first is the one fighting the mob. So a baseline
// observation is DOWN-WEIGHTED against the user's own: `wB = K/(K + nUser)` with K = 20, so at 20
// of your own observations the shipped data counts half, at 100 about 17%, and at
// `USER_ONLY_AT` = 50 it counts nothing at all and survives only as a faded reference marker.
// And when both sides are well populated (n >= 30 each) with 95% intervals that do not overlap,
// `differsFromShipped` goes true: that is the patch detector, and it is a statement about the
// DATA, never an automatic correction of it.
//
// ---------------------------------------------------------------------------------------------
// AND RECENT EVIDENCE BEATS OLD EVIDENCE, WHOSEVER IT IS (owner, 2026-08-16 — JOS-397). A second
// weight rides every term: `max(0.15, 0.5 ^ (ageDays / 21))`, aged in whole weeks from the newest
// observation the LEDGER holds rather than from the wall clock, so a paused log does not decay
// itself. It MULTIPLIES the baseline down-weighting above rather than replacing it — "the shipped
// file counts less because you have your own data" and "it counts less because it is old" are two
// different statements and a row that is both should pay for both. The argument for the half-life
// and for the floor is in `shared/resistDecay.ts`, and it is the ONE place recency speaks: JOS-397
// also shipped a separate run detector that printed a second verdict beside this estimate, and the
// owner removed it the same day (JOS-400). A card says one thing about a creature, and this is it.

import {
  LOW_SAMPLE_BELOW,
  RESIST_CASTER_KINDS,
  type ResistAxis,
  type ResistCasterKind,
  type ResistEstimate,
  type ResistFamily,
  type ResistFit,
  type ResistRow,
  type ResistSpellEvidence,
  type SpellResistInfo,
  type SpellResistTable,
} from './resistTypes'
import {
  OVERCHANNEL_PER_CASTER_CLASS,
  OVERCHANNEL_RESIST_ADJ,
  isInformativeSpell,
} from './resistFormula'
import { type DamageRef, damageKind, damageRefKey, fullDamageRefs, splitDamage } from './resistDamage'
import { decayWeight, newestWeekOf } from './resistDecay'
import { type Term, empiricalOf, fitTerms, priorLog, rowTerm, termN } from './resistTerms'

/** Baseline down-weighting: one baseline observation weighs K/(K + nUser). */
export const BASELINE_K = 20
/** At this many of your own observations in a cell, the baseline stops counting entirely. */
export const USER_ONLY_AT = 50
/** Both sides need this much data before disagreeing about a mob means anything. */
export const DIFFERS_MIN_N = 30

/** Re-exported so a caller needs one import for the grid, the terms and the estimator over them. */
export { R_MAX, R_MIN, R_STEP } from './resistFit'
export { PRIOR_SIGMA, debuffAmount } from './resistTerms'

/**
 * THE HARD DATA RULE (owner review, 2026-08-16), which sits ON TOP of the model rather than inside
 * it. A cell with real evidence where almost everything was resisted is reported in the top band
 * whatever the fitter says: the model is a model, and "it resisted 118 of the 120 casts we watched"
 * is a fact that no level term, prior or grid can be allowed to talk a player out of.
 *
 * The two numbers are deliberately unambitious. Ten informative observations is the same line
 * `LOW_SAMPLE_BELOW` draws, and 90% is far enough above the `resistant` band's own 50% that the
 * rule can only ever agree with a working fit or overrule a broken one.
 */
export const ALL_RESISTED_MIN_N = 10
export const ALL_RESISTED_SHARE = 0.9


/** How many damage lines a row holds, whatever they were worth. */
function dmgTotalOf(row: ResistRow): number {
  let total = 0
  for (const count of Object.values(row.dmg)) total += count
  return total
}

/**
 * A row is evidence about `axis` only when the client's spell data says so, and only when the
 * game was not refusing it for a reason that has nothing to do with the mob's resist stat: a mez
 * that says "up to level 55" ALWAYS fails above 55, and filing that resist would invent a
 * magic-resistant mob out of a level cap (world-model law 1).
 */
function rowIsEvidence(row: ResistRow, info: SpellResistInfo | undefined, axis: ResistAxis): info is SpellResistInfo {
  if (info?.axis !== axis) return false
  if (info.levelCap !== undefined && row.mobLevel !== null && row.mobLevel > info.levelCap) return false
  return true
}

/**
 * THE PATCH DETECTOR. Both sides well populated, and 95% intervals that do not overlap: the log in
 * front of this user says something the shipped data does not, which is what a retuned mob looks
 * like. It is a statement about the DATA and never a correction of it - by the time it can fire,
 * the user's own observations already outweigh the baseline entirely.
 */
function differs(userFit: ResistFit | null, baselineFit: ResistFit | null): boolean {
  if (!userFit || !baselineFit) return false
  if (userFit.n < DIFFERS_MIN_N || baselineFit.n < DIFFERS_MIN_N) return false
  return disjoint(userFit, baselineFit)
}

function fitFrom(terms: Term[], axis: ResistAxis, mobLevel: number | null): ResistFit {
  const n = terms.reduce((acc, t) => acc + termN(t), 0)
  const { R, lo, hi } = fitTerms(terms, priorLog(axis, mobLevel))
  return { R, lo, hi, n }
}

function disjoint(a: ResistFit, b: ResistFit): boolean {
  return a.hi < b.lo || b.hi < a.lo
}

export interface EstimateOpts {
  axis: ResistAxis
  /** The mob's level, only used to pick which Torven prior to shrink toward. */
  mobLevel?: number | null
  /** Songs are their own family precisely so they can be excluded from R in ONE place. */
  includeSongs?: boolean
  /**
   * Do charmed pets and NPC casters weigh in this number? (JOS-385, `shared/resistPrefs.ts`.)
   *
   * THE SWITCH LIVES HERE AND NOWHERE ELSE, which is the same argument `includeSongs` makes: the
   * ledger folds npc rows unconditionally, so the ONLY place the answer can change is the one line
   * below that decides whether such a row becomes a likelihood term. Their counts are tallied into
   * `byCaster` and their per-spell evidence into `perSpell` either way — a switched-off family is
   * still something the log saw.
   *
   * Defaults to TRUE when omitted, matching the shipped preference, so a unit test or a script
   * that says nothing gets the app's own behaviour.
   */
  includeNpcCasters?: boolean
  /**
   * Spells whose landings this app cannot see, decided over the WHOLE ledger by the caller. See
   * `unobservableSpells`; omitted, the estimator falls back to what `rows` alone can say, which is
   * right for a unit test and too narrow for a mob page.
   */
  unobservable?: ReadonlySet<string>
  /**
   * The full-damage reference per (spell, caster level), decided over the WHOLE ledger by the
   * caller (`shared/resistDamage.ts fullDamageRefs`). Omitted, the estimator falls back to what
   * `rows` alone can say — right for a unit test, and too narrow for a mob page, where a cell with
   * four hits would be asked to establish a reference the rest of the ledger already knows.
   */
  modes?: ReadonlyMap<string, DamageRef>
  /**
   * THE NEWEST WEEK ANYTHING IN THE LEDGER WAS OBSERVED IN — the reference every row's age is
   * measured against (JOS-397, `shared/resistDecay.ts`).
   *
   * WHOLE-LEDGER, like `unobservable` and `modes`, and for a sharper reason than either: age has to
   * be measured against the same instant for every cell, or a creature nobody has fought in months
   * would report itself as freshly observed simply because its own newest row is its own newest row.
   * Omitted, the estimator falls back to the newest week among `rows` — right for a unit test, and
   * too narrow for a mob page.
   *
   * AND IT IS A WEEK RATHER THAN A WALL CLOCK on purpose: a paused log must not decay itself.
   */
  newestWeek?: string
}

/** One term, with the two things about its ROW the estimate has to report on afterwards. */
interface SourcedTerm {
  term: Term
  source: 'user' | 'baseline'
  informative: boolean
  casterKind: ResistCasterKind
}

interface Prepared {
  terms: SourcedTerm[]
  evidence: Map<string, ResistSpellEvidence>
  byFamily: Record<ResistFamily, { n: number; resist: number; land: number }>
  byCaster: Record<ResistCasterKind, { n: number; resist: number; land: number }>
  /** Of the observations that entered the fit, the ones that could have gone either way. */
  nInformative: number
  droppedNoLevel: number
  /** Observations held out of the fit because their spell's landings are not observable. */
  droppedUnobservable: number
  /** Your own casts held out because nothing had yet stated which invocation was up (JOS-387). */
  droppedUnknownInvocation: number
}

function blankEvidence(row: ResistRow, info: SpellResistInfo): ResistSpellEvidence {
  return {
    spellKey: row.spellKey,
    family: row.family,
    casts: 0,
    resisted: 0,
    partial: 0,
    full: 0,
    land: 0,
    fromBaseline: 0,
    fromYou: 0,
    resistAdj: info.resistAdj,
    informative: isInformativeSpell(info.resistAdj),
    ranks: [],
    overchannel: null,
    unknownInvocation: 0,
  }
}

/**
 * The rank and invocation half of one row's evidence line (JOS-387). It is what makes the ticket's
 * acceptance visible to a reader: a rank-IV cast is modelled at -60 and an overchannel cast at -150
 * or more, and the drilldown says so on the spell's own line.
 */
function noteCastTerms(ev: ResistSpellEvidence, row: ResistRow, total: number): void {
  if (row.rank > 0 && !ev.ranks.includes(row.rank)) {
    ev.ranks.push(row.rank)
    ev.ranks.sort((a, b) => a - b)
  }
  if (row.overchannel === null) {
    if (row.casterKind === 'self') ev.unknownInvocation += total
    return
  }
  if (!row.overchannel) return
  const casterClasses = row.casterClasses ?? 0
  const adj = OVERCHANNEL_RESIST_ADJ + OVERCHANNEL_PER_CASTER_CLASS * casterClasses
  const held = ev.overchannel
  ev.overchannel = held
    ? { casts: held.casts + total, adj: Math.min(held.adj, adj), casterClasses: Math.max(held.casterClasses, casterClasses) }
    : { casts: total, adj, casterClasses }
}

/**
 * Which spells have no observable landings ANYWHERE in the rows handed to it.
 *
 * PASS IT THE WHOLE LEDGER, not one mob's rows, and the caller that matters does exactly that
 * (`src/main/ipc/resist.ts`, once per read). The distinction is the difference between two very
 * different statements: "this app has never seen this spell land on anything", which is a fact
 * about our own blindness, and "this mob resisted every cast of it", which is a fact about the
 * mob and is exactly the evidence the estimator exists to use. Scoped to one mob it would throw
 * the second away with the first.
 *
 * Axis-agnostic on purpose: whether we can SEE a spell land has nothing to do with which
 * resistance it rolls against.
 */
export function unobservableSpells(rows: readonly ResistRow[]): Set<string> {
  const seen = new Map<string, { resist: number; land: number }>()
  for (const row of rows) {
    const acc = seen.get(row.spellKey) ?? { resist: 0, land: 0 }
    acc.resist += row.resist
    acc.land += row.land + dmgTotalOf(row)
    seen.set(row.spellKey, acc)
  }
  const out = new Set<string>()
  for (const [key, acc] of seen) {
    if (acc.resist > 0 && acc.land === 0) out.add(key)
  }
  return out
}

function noteEvidence(prep: Prepared, row: ResistRow, info: SpellResistInfo, mode: DamageRef | undefined): void {
  const key = row.spellKey + '|' + row.family
  const ev = prep.evidence.get(key) ?? blankEvidence(row, info)
  const fixed = damageKind(row, info, mode) === 'ddFix'
  const { total: dmgTotal, full, partial } = splitDamage(row, fixed ? mode?.value : undefined)
  ev.resisted += row.resist
  ev.full += full
  ev.partial += partial
  ev.land += row.land + (fixed ? 0 : dmgTotal)
  const total = row.resist + row.land + dmgTotal
  ev.casts += total
  if (row.source === 'baseline') ev.fromBaseline += total
  else ev.fromYou += total
  noteCastTerms(ev, row, total)
  prep.evidence.set(key, ev)
  const fam = prep.byFamily[row.family]
  fam.n += total
  fam.resist += row.resist
  fam.land += row.land + dmgTotal
  const by = prep.byCaster[row.casterKind]
  // Defensive: a hand-edited ledger or a row from a future build can carry a kind this build has
  // never heard of, and a tally is not worth a crash.
  if (by) {
    by.n += total
    by.resist += row.resist
    by.land += row.land + dmgTotal
  }
}

/** A zero tally per caster kind — the shape `byCaster` always has, empty cells included. */
function blankByCaster(): Record<ResistCasterKind, { n: number; resist: number; land: number }> {
  const out = {} as Record<ResistCasterKind, { n: number; resist: number; land: number }>
  for (const kind of RESIST_CASTER_KINDS) out[kind] = { n: 0, resist: 0, land: 0 }
  return out
}

/**
 * THE THREE WAYS A COUNTED OBSERVATION IS KEPT OUT OF THE FIT, in one place so the loop below
 * stays readable and so a fourth cannot be added without meeting the other three.
 *
 * Every one of them is COUNTED first (`noteEvidence` has already run) and weighed never — the
 * ledger's own rule applied to the estimate: what the log saw is not the same question as what the
 * number rests on.
 */
function isHeldOut(
  row: ResistRow,
  opts: EstimateOpts,
  blind: ReadonlySet<string>,
  prep: Prepared
): boolean {
  if (blind.has(row.spellKey)) {
    // A spell this app has never seen land ANYWHERE. Shown in the drilldown, labelled there.
    prep.droppedUnobservable += row.resist + row.land + dmgTotalOf(row)
    const ev = prep.evidence.get(row.spellKey + '|' + row.family)
    if (ev) ev.landingsNotObservable = true
    return true
  }
  if (row.family === 'song' && opts.includeSongs === false) return true
  // AN UNKNOWN -150 IS NOT EVIDENCE (JOS-387). Your own casts made before the log's first
  // invocation line carry `overchannel: null`, and there is no honest offset to fit them at —
  // guessing "off" would read every one of them as landing against a harder number than it did.
  // They are counted and shown; they simply do not vote.
  //
  // SELF ONLY, and this is the ticket's rule narrowed by a measurement rather than followed off a
  // cliff. Another player's and a creature's rows carry `null` too, but for a different reason:
  // nothing states THEIR invocation and nothing ever will. A `pc` row has no caster level either,
  // so it was already out of the fit; an `npc` row is the evidence family JOS-385 measured and
  // shipped ON, and holding it out here on a null that can never be filled would silently delete
  // that whole family from every number in the app.
  if (row.casterKind === 'self' && row.overchannel === null) {
    prep.droppedUnknownInvocation += row.resist + row.land + dmgTotalOf(row)
    return true
  }
  // THE ONE LINE THE npc SWITCH IS (JOS-385).
  return row.casterKind === 'npc' && opts.includeNpcCasters === false
}

function prepare(rows: readonly ResistRow[], spells: SpellResistTable, opts: EstimateOpts): Prepared {
  const prep: Prepared = {
    terms: [],
    evidence: new Map(),
    byFamily: { cast: { n: 0, resist: 0, land: 0 }, song: { n: 0, resist: 0, land: 0 } },
    byCaster: blankByCaster(),
    nInformative: 0,
    droppedNoLevel: 0,
    droppedUnobservable: 0,
    droppedUnknownInvocation: 0,
  }
  // The caller's whole-ledger verdicts when it has them; else what these rows alone can say. Both
  // are deliberately about the LEDGER rather than about this cell — see their own headers.
  const blind = opts.unobservable ?? unobservableSpells(rows)
  const modes = opts.modes ?? fullDamageRefs(rows)
  const newest = opts.newestWeek ?? newestWeekOf(rows)
  for (const row of rows) {
    const info = spells[row.spellKey]
    if (!rowIsEvidence(row, info, opts.axis)) continue
    const mode = modes.get(damageRefKey(row.spellKey, row.casterLevel))
    noteEvidence(prep, row, info, mode)
    if (isHeldOut(row, opts, blind, prep)) continue
    const term = rowTerm(row, { info, axis: opts.axis, spells, mode })
    if (!term) {
      prep.droppedNoLevel += row.resist + row.land + dmgTotalOf(row)
      continue
    }
    // COUNTED SEPARATELY, NOT WEIGHED SEPARATELY (JOS-385): a -250 proc's casts still enter the
    // likelihood, where they say the one true thing they can ("R is not enormous"), and are kept
    // out of the number a player reads as this cell's evidence.
    const informative = isInformativeSpell(info.resistAdj)
    if (informative) prep.nInformative += termN(term)
    prep.terms.push({
      // RECENT EVIDENCE WEIGHS MORE (JOS-397). The weight is the row's own decay and nothing else
      // here; the baseline's down-weighting is a SECOND factor applied once, in `estimate` below,
      // so the two compose by multiplication and neither can quietly swallow the other. Nothing
      // about the COUNTS moves: `termN` and `empiricalOf` are weight-blind, so `n`, the low-samples
      // caveat and the hard data rule all still speak in observations a player could count.
      term: { ...term, weight: term.weight * decayWeight(row.week, newest) },
      source: row.source === 'baseline' ? 'baseline' : 'user',
      informative,
      casterKind: row.casterKind,
    })
  }
  return prep
}

/**
 * THE THREE THINGS THE OBSERVATIONS SAY WITHOUT THE MODEL (owner review, 2026-08-16).
 *
 * All three are read off the INFORMATIVE terms that entered the fit — the casts that could actually
 * have been resisted — because a rule stated in observations has to be stated in the observations a
 * player would count themselves.
 */
function verdicts(prep: Prepared): {
  empirical: { total: number; resisted: number }
  resistsAlmostEverything: boolean
  npcOnly: boolean
} {
  const informative = prep.terms.filter((t) => t.informative)
  const emp = empiricalOf(informative.map((t) => t.term))
  const enough = emp.total >= ALL_RESISTED_MIN_N
  return {
    empirical: { total: emp.total, resisted: emp.resisted },
    resistsAlmostEverything: enough && emp.hard / emp.total >= ALL_RESISTED_SHARE,
    // NOTHING BUT PETS AND OTHER CREATURES (owner review). The number rests entirely on casters
    // whose level this app took off a catalog rather than off the game's own statement, and the Eye
    // of Veeshan case shows what that can cost — so the surfaces say so on the row and the chip.
    npcOnly: informative.length > 0 && informative.every((t) => t.casterKind === 'npc'),
  }
}

/**
 * THE ESTIMATOR. `rows` may mix the shipped baseline and the user's own log freely — every row
 * carries its own `source` and the down-weighting happens here, once, so no caller can forget it.
 */
export function estimate(
  rows: readonly ResistRow[],
  spells: SpellResistTable,
  opts: EstimateOpts
): ResistEstimate {
  const prep = prepare(rows, spells, opts)
  const mobLevel = opts.mobLevel ?? null
  const userTerms = prep.terms.filter((t) => t.source === 'user').map((t) => t.term)
  const baseTerms = prep.terms.filter((t) => t.source === 'baseline').map((t) => t.term)
  const fromYou = userTerms.reduce((a, t) => a + termN(t), 0)
  const fromBaseline = baseTerms.reduce((a, t) => a + termN(t), 0)

  const baselineWeight = fromYou >= USER_ONLY_AT ? 0 : BASELINE_K / (BASELINE_K + fromYou)
  // TWO WEIGHTINGS, MULTIPLIED (JOS-397). The term already carries its own decay; this MULTIPLIES
  // the baseline's down-weighting onto it rather than overwriting it, which is the difference
  // between "the shipped file counts less because you have your own data" and "the shipped file
  // counts less because it is old". Both are true, they are different statements, and a shipped
  // observation that is both should pay for both.
  const weighted: Term[] = [
    ...userTerms,
    ...baseTerms.map((t) => ({ ...t, weight: t.weight * baselineWeight })),
  ]
  const merged = fitTerms(weighted, priorLog(opts.axis, mobLevel))
  const userFit = fromYou > 0 ? fitFrom(userTerms, opts.axis, mobLevel) : null
  const baselineFit = fromBaseline > 0 ? fitFrom(baseTerms, opts.axis, mobLevel) : null
  const evidence = verdicts(prep)

  return {
    R: merged.R,
    lo: merged.lo,
    hi: merged.hi,
    pinned: merged.pinned,
    empirical: evidence.empirical,
    resistsAlmostEverything: evidence.resistsAlmostEverything,
    npcOnly: evidence.npcOnly,
    n: fromYou + fromBaseline,
    nInformative: prep.nInformative,
    fromBaseline,
    fromYou,
    droppedNoLevel: prep.droppedNoLevel,
    droppedUnobservable: prep.droppedUnobservable,
    droppedUnknownInvocation: prep.droppedUnknownInvocation,
    byFamily: prep.byFamily,
    byCaster: prep.byCaster,
    npcIncluded: opts.includeNpcCasters !== false,
    // INFORMATIVE SPELLS FIRST, then by volume (JOS-385). The list is read as "what does this app
    // know about this axis", and a -250 proc with 87 unresisted casts headed it while the eight
    // casts that actually tested the mob's resistance sat underneath. Sorting is the whole fix
    // for that: nothing is hidden, and the line that answers the question is the line at the top.
    perSpell: [...prep.evidence.values()].sort(
      (a, b) => Number(b.informative) - Number(a.informative) || b.casts - a.casts
    ),
    baselineWeight,
    userOnly: fromYou >= USER_ONLY_AT,
    baselineFit,
    userFit,
    differsFromShipped: differs(userFit, baselineFit),
    nearlyImmune: merged.R >= 200,
  }
}

/** Re-exported so a caller needs one import for "read this histogram" and "fit it". */
export { damageKind, damageRefKey, fullDamageRefs, splitDamage } from './resistDamage'

/**
 * Is there ANY answer to give? (owner ruling, 2026-08-16 — see `LOW_SAMPLE_BELOW`.)
 *
 * One observation is an answer: the estimator is a likelihood over a prior, so a single resist
 * moves R and widens the interval rather than producing nonsense. The only cell with nothing to
 * say is the empty one.
 */
export function hasAnswer(n: number): boolean {
  return n > 0
}

/**
 * Does this cell's answer need the quieter caveat beside it? A cell in this band is REPORTED in
 * full — tag, number, interval, count — and merely says, in words, that it is standing on very
 * little. It is a caveat and never a substitute: the ruling that created this function is exactly
 * that the app stopped withholding the answer.
 *
 * IT TAKES THE INFORMATIVE COUNT (JOS-385), and that is the whole of the defect the owner found on
 * a thunder spirit princess: the cell read `resistant` with no caveat off `n=83`, and 75 of the 83
 * were casts of procs that could not have been resisted at any R. Counting them here made a cell
 * standing on eight observations look like one standing on eighty. Callers pass
 * `estimate().nInformative`; a cell with none at all is as thin as a cell can be and says so.
 */
export function lowSamples(nInformative: number): boolean {
  return nInformative < LOW_SAMPLE_BELOW
}
