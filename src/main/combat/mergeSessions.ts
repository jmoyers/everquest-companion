// MERGING TWO ADJACENT SEGMENTS BACK INTO ONE — the API-level proof that a SESSION MARK is a
// boundary the engine can REMOVE (JOS-322, owner ruling 2026-08-21, verbatim: *we should have the
// capability to merge it back/undo split, but not put that in the app, just build it into the api
// and design philosophy*).
//
// NO UI SHIPS FOR THIS, and none is meant to. The capability is a property of the RECORD MODEL,
// tested at the API, so a future affordance — or a mistake-recovery path — costs a UI rather than a
// redesign. `CombatEngine.unsplit()` is the one caller inside the product, and it is deliberately
// reachable only from the facade, never from a control.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY IT IS POSSIBLE AT ALL: THE ENGINE STORES NO RATES AND NO MEANS ANYWHERE.
//
// A full audit of every frozen field puts each into exactly one of five MERGEABLE CLASSES, and the
// design smell the ruling named — "any derived value baked in at split time that cannot be
// reconstructed after a merge" — has no member:
//
//   1. SUMS — every total / hits / crits / misses / resists counter across SourceStat, SkillStat,
//      CategoryStat and ModifierTally, plus targets, enemyHeal, incHeal, the HealAccum counters,
//      the ProcAccum counters, every SpellProcLane side, and the timing pair
//      finalizedMs / activeMs. Merge = re-add.
//   2. EXTREMA — `max` everywhere, `min` under the 0-sentinel rule (`mergeMin`, which already
//      existed for the combine-pets fold), runeMin / runeMax.
//   3. FIRSTS AND LASTS — `firstSlowTs` (the earlier non-zero), the display `name` and the `kind`
//      relabel (the later one wins, exactly as `Agg.reid` decides it inside one segment).
//   4. ABSOLUTE-TIME-KEYED MAPS — the rounds heuristic's (skill, floor(ts/1000)) buckets and the
//      wall-clock-minute `WindowAccum`. A split mid-bucket leaves two partials under the SAME key,
//      so summing them reproduces the unsplit bucket EXACTLY — the key is absolute time, not an
//      offset from a segment start, which is what makes this class merge at all.
//   5. RECOMPUTED-AT-READ — every summary is a memoized pure projection and `dps` re-derives as
//      total / (finalizedMs / 1000). Nothing to merge; it is rebuilt from the merged sums.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE HONEST EDGES, stated rather than papered over (the ticket's two-tier test obligation).
//
// A mark that falls BETWEEN pulls — the actual instance-reset use case — glues back BYTE-IDENTICAL:
// the fold that produced the two records and the fold that would have produced one are the same
// arithmetic in a different order, and every class above is order-free.
//
// A mark that falls MID-PULL cuts an ENCOUNTER in two, and merge-back reconstructs the RECORDS, not
// the counterfactual never-split run. Σ-equality holds on every accumulator class; what differs is
// enumerated and only this:
//   - the two fights stay TWO fights (the fight history is not a thing this merges);
//   - the inter-hit gap straddling the mark is absent from finalizedMs / activeMs, because the
//     closure windows once per mark (bounded, and it is the same instant twice, not a drift);
//   - fight-scoped close-time stamps on the severed pull: open `stanceSpans` ends, one possible
//     `null` in `slowSamples`, and boundary-second round grouping (see `RoundAccum.absorb`).
//
// PURE. Neither argument is mutated and the result aliases neither of them — a merge is a
// question, and asking it must never be able to move a number in a record somebody is reading.

import { Agg, MISS_KEYS, ProcAccum, mergeMin, sumMap } from './aggregate'
import { WINDOW_CAP, WindowAccum, type ProcWindow } from './procWindows'
import type { CategoryStat, ModifierTally, RoundsAccum, SkillStat, SourceStat } from './aggregate'
import type { LaneSides, SpellProcLane } from './procDetect'
import type { ZoneSession } from './encounter'
import type { DamageCategory } from '../../shared/combat'

// ── the small shapes ─────────────────────────────────────────────────────────────────────

/** One `{ name, amount }` ledger (targets, enemyHeal) — a SUM keyed by instance, latest name. */
function absorbAmounts(
  into: Map<string, { name: string; amount: number }>,
  from: ReadonlyMap<string, { name: string; amount: number }>
): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, { ...v })
      continue
    }
    cur.name = v.name
    cur.amount += v.amount
  }
}

/** The incoming-heal ledger: the same sum with a count beside it. */
function absorbIncHeal(
  into: Map<string, { name: string; amount: number; count: number }>,
  from: ReadonlyMap<string, { name: string; amount: number; count: number }>
): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, { ...v })
      continue
    }
    cur.name = v.name
    cur.amount += v.amount
    cur.count += v.count
  }
}

// ── damage: SkillStat / CategoryStat / SourceStat ────────────────────────────────────────

function cloneSkill(s: SkillStat): SkillStat {
  return { ...s }
}

function absorbSkill(into: SkillStat, from: SkillStat): void {
  into.total += from.total
  into.hits += from.hits
  into.crits += from.crits
  into.max = Math.max(into.max, from.max)
  // The 0 SENTINEL is "no landed hit on this lane yet", never a measured minimum — the same rule
  // `accrueMin` folds under and the same helper the combine-pets fold already shares.
  into.min = mergeMin(into.min, from.min)
  into.misses += from.misses
  into.resists += from.resists
  // `lands` is 0 on every accumulator by construction (it is joined in at view build), so this sum
  // is 0 + 0 — carried anyway, because a field the merge silently skipped is how one drifts.
  into.lands += from.lands
}

function absorbSkills(into: Map<string, SkillStat>, from: ReadonlyMap<string, SkillStat>): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, cloneSkill(v))
      continue
    }
    absorbSkill(cur, v)
  }
}

function cloneCategory(c: CategoryStat): CategoryStat {
  const bySkill = new Map<string, SkillStat>()
  for (const [k, v] of c.bySkill) bySkill.set(k, cloneSkill(v))
  return { ...c, bySkill }
}

function absorbCategories(
  into: Map<DamageCategory, CategoryStat>,
  from: ReadonlyMap<DamageCategory, CategoryStat>
): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, cloneCategory(v))
      continue
    }
    cur.total += v.total
    cur.hits += v.hits
    cur.crits += v.crits
    cur.max = Math.max(cur.max, v.max)
    cur.resists += v.resists
    absorbSkills(cur.bySkill, v.bySkill)
  }
}

/** The (skill, whole-second) buckets. Keyed on ABSOLUTE time, so a boundary second present on both
 *  sides sums back into the one counter the unsplit fold would have held. */
function cloneRounds(r: RoundsAccum): RoundsAccum {
  const bucket = new Map<string, Map<number, number>>()
  for (const [lane, seconds] of r.bucket) bucket.set(lane, new Map(seconds))
  return { bucket }
}

function absorbRounds(into: RoundsAccum, from: RoundsAccum): void {
  for (const [lane, seconds] of from.bucket) {
    const cur = into.bucket.get(lane)
    if (!cur) {
      into.bucket.set(lane, new Map(seconds))
      continue
    }
    for (const [sec, hits] of seconds) cur.set(sec, (cur.get(sec) ?? 0) + hits)
  }
}

function absorbMods(into: Map<string, ModifierTally>, from: ReadonlyMap<string, ModifierTally>): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, { ...v })
      continue
    }
    cur.count += v.count
    cur.avoided += v.avoided
    cur.total += v.total
  }
}

function cloneSource(s: SourceStat): SourceStat {
  const bySkill = new Map<string, SkillStat>()
  for (const [k, v] of s.bySkill) bySkill.set(k, cloneSkill(v))
  const byCategory = new Map<DamageCategory, CategoryStat>()
  for (const [k, v] of s.byCategory) byCategory.set(k, cloneCategory(v))
  const mods = new Map<string, ModifierTally>()
  for (const [k, v] of s.mods) mods.set(k, { ...v })
  return {
    ...s,
    miss: { ...s.miss },
    bySkill,
    byCategory,
    rounds: cloneRounds(s.rounds),
    mods,
    roundAcc: s.roundAcc.clone()
  }
}

/**
 * THE KIND RELABEL SURVIVES THE SEAM (JOS-430's one-way `'other'` → `'member'` rule, applied across
 * two records instead of inside one). A combatant recorded before your group learned their name is
 * `'other'`; once the roster admits them the same row arrives as `'member'`. A merged row is
 * `'member'` if EITHER half ever saw them admitted — which is exactly the state the unsplit fold
 * would have been left in, since inside one segment the promotion never reverses.
 *
 * Every other kind is a constant for a given row id (`you`, `pet:<instance>`, `allypet:…`,
 * `enemy`), so both halves already agree and this returns it unchanged.
 */
function mergedKind(a: SourceStat['kind'], b: SourceStat['kind']): SourceStat['kind'] {
  if (a === 'member' || b === 'member') return 'member'
  return b
}

function absorbSource(into: SourceStat, from: SourceStat): void {
  into.name = from.name
  into.kind = mergedKind(into.kind, from.kind)
  into.total += from.total
  into.hits += from.hits
  into.crits += from.crits
  into.ambiguousHits += from.ambiguousHits
  into.ambiguousTotal += from.ambiguousTotal
  into.misses += from.misses
  for (const key of MISS_KEYS) into.miss[key] += from.miss[key]
  into.resists += from.resists
  absorbSkills(into.bySkill, from.bySkill)
  absorbCategories(into.byCategory, from.byCategory)
  absorbRounds(into.rounds, from.rounds)
  absorbMods(into.mods, from.mods)
  into.roundAcc.absorb(from.roundAcc)
}

function mergeSourceMaps(
  a: ReadonlyMap<string, SourceStat>,
  b: ReadonlyMap<string, SourceStat>
): Map<string, SourceStat> {
  const out = new Map<string, SourceStat>()
  for (const [k, v] of a) out.set(k, cloneSource(v))
  for (const [k, v] of b) {
    const cur = out.get(k)
    if (!cur) {
      out.set(k, cloneSource(v))
      continue
    }
    absorbSource(cur, v)
  }
  return out
}

// ── the proc ledger ──────────────────────────────────────────────────────────────────────

function absorbSides(into: LaneSides, from: LaneSides): void {
  into.damage += from.damage
  into.heal += from.heal
  into.landing += from.landing
}

function cloneSides(s: LaneSides): LaneSides {
  return { ...s }
}

function cloneLane(l: SpellProcLane): SpellProcLane {
  const byState = new Map<string, LaneSides>()
  for (const [k, v] of l.byState) byState.set(k, cloneSides(v))
  return { ...l, hits: cloneSides(l.hits), byState }
}

function absorbLanes(into: Map<string, SpellProcLane>, from: ReadonlyMap<string, SpellProcLane>): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, cloneLane(v))
      continue
    }
    // A lane that EVER saw a held-clicky fold is a click lane (JOS-438 — a property of the lane, not
    // of the fold), so the flag survives a merge from either side.
    if (v.click) cur.click = true
    absorbSides(cur.hits, v.hits)
    cur.damage += v.damage
    cur.heal += v.heal
    for (const [sk, sv] of v.byState) {
      const sides = cur.byState.get(sk)
      if (!sides) {
        cur.byState.set(sk, cloneSides(sv))
        continue
      }
      absorbSides(sides, sv)
    }
  }
}

/** The strike ledger: a count per display name, ambiguity carried from whichever half first saw it
 *  (a lane's ambiguity is a property of the MESSAGE, identical in both halves). */
function absorbStrikes(into: ProcAccum['strikes'], from: ProcAccum['strikes']): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, { ...v })
      continue
    }
    cur.count += v.count
  }
}

function absorbPoison(into: ProcAccum['poisonDamage'], from: ProcAccum['poisonDamage']): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, { ...v })
      continue
    }
    cur.count += v.count
    cur.total += v.total
  }
}

function absorbDispels(into: ProcAccum['dispels'], from: ProcAccum['dispels']): void {
  for (const [k, v] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, { ...v })
      continue
    }
    cur.count += v.count
  }
}

function cloneProcs(p: ProcAccum): ProcAccum {
  const copy = new ProcAccum()
  copy.strikes = new Map([...p.strikes].map(([k, v]) => [k, { ...v }]))
  copy.slowLands = p.slowLands
  copy.firstSlowTs = p.firstSlowTs
  copy.poisonDamage = new Map([...p.poisonDamage].map(([k, v]) => [k, { ...v }]))
  copy.dispels = new Map([...p.dispels].map(([k, v]) => [k, { ...v }]))
  copy.coats = p.coats.map((c) => ({ ...c }))
  copy.stanceSwitches = p.stanceSwitches
  copy.invocationSwitches = p.invocationSwitches
  copy.swings = p.swings
  copy.swingsByState = new Map(p.swingsByState)
  copy.activeMsByState = new Map(p.activeMsByState)
  copy.spellProcs = new Map([...p.spellProcs].map(([k, v]) => [k, cloneLane(v)]))
  return copy
}

function absorbProcs(into: ProcAccum, from: ProcAccum): void {
  absorbStrikes(into.strikes, from.strikes)
  into.slowLands += from.slowLands
  // A FIRST is the EARLIER non-zero, and 0 means "no slow landed in this half" — never an instant.
  if (into.firstSlowTs === 0) into.firstSlowTs = from.firstSlowTs
  absorbPoison(into.poisonDamage, from.poisonDamage)
  absorbDispels(into.dispels, from.dispels)
  // Chronological: the later record's coats simply follow ours, which is the order they were
  // applied in and the order the unsplit fold would have appended them.
  into.coats = [...into.coats, ...from.coats.map((c) => ({ ...c }))]
  into.stanceSwitches += from.stanceSwitches
  into.invocationSwitches += from.invocationSwitches
  into.swings += from.swings
  for (const [k, v] of from.swingsByState) into.swingsByState.set(k, (into.swingsByState.get(k) ?? 0) + v)
  for (const [k, v] of from.activeMsByState) into.activeMsByState.set(k, (into.activeMsByState.get(k) ?? 0) + v)
  absorbLanes(into.spellProcs, from.spellProcs)
}

// ── the minute-window ledger ─────────────────────────────────────────────────────────────

function cloneWindow(w: ProcWindow): ProcWindow {
  return {
    ...w,
    transitionGroups: new Set(w.transitionGroups),
    stateKeys: new Set(w.stateKeys)
  }
}

/**
 * The wall-clock-minute ledger. A mark inside a minute leaves two PARTIAL windows under the same
 * `floor(ts / WINDOW_MS)` key, so summing them reproduces the unsplit minute exactly — the key is
 * absolute time. The sets UNION, which is `WindowAccum.ensure`'s own rule for a state that turns on
 * part-way through a minute.
 *
 * The insertion order is ascending-minute (all of `a`'s minutes precede all of `b`'s, save the one
 * they may share), so the drop-oldest cap trims the same end the live ledger trims.
 */
function mergeWindows(a: WindowAccum, b: WindowAccum): WindowAccum {
  const out = new WindowAccum()
  for (const w of a.list()) out.windows.set(w.minute, cloneWindow(w))
  for (const w of b.list()) {
    const cur = out.windows.get(w.minute)
    if (!cur) {
      out.windows.set(w.minute, cloneWindow(w))
      continue
    }
    cur.activeMs += w.activeMs
    cur.swings += w.swings
    cur.outDamage += w.outDamage
    cur.procDamage += w.procDamage
    cur.transitions += w.transitions
    for (const g of w.transitionGroups) cur.transitionGroups.add(g)
    for (const k of w.stateKeys) cur.stateKeys.add(k)
  }
  while (out.windows.size > WINDOW_CAP) {
    const oldest = out.windows.keys().next()
    if (oldest.done) break
    out.windows.delete(oldest.value)
  }
  return out
}

// ── the whole aggregate, and the record around it ────────────────────────────────────────

/**
 * GLUE TWO ADJACENT AGGREGATES BACK INTO ONE. `a` is the EARLIER half, `b` the later — the order
 * matters for exactly three things and they are all stated where they happen: the display name and
 * the row kind (the later wins), `firstSlowTs` (the earlier wins), and the coat list (concatenated
 * in time order).
 *
 * PURE: a fresh `Agg`, sharing no map, no array and no accumulator with either argument.
 */
export function mergeAgg(a: Agg, b: Agg): Agg {
  const out = new Agg()
  out.out = mergeSourceMaps(a.out, b.out)
  out.inc = mergeSourceMaps(a.inc, b.inc)
  absorbAmounts(out.targets, a.targets)
  absorbAmounts(out.targets, b.targets)
  absorbAmounts(out.enemyHeal, a.enemyHeal)
  absorbAmounts(out.enemyHeal, b.enemyHeal)
  absorbIncHeal(out.incHeal, a.incHeal)
  absorbIncHeal(out.incHeal, b.incHeal)
  out.heal = a.heal.clone()
  out.heal.absorb(b.heal)
  out.procs = cloneProcs(a.procs)
  absorbProcs(out.procs, b.procs)
  out.windows = mergeWindows(a.windows, b.windows)
  return out
}

/**
 * REMOVE THE BOUNDARY BETWEEN TWO ADJACENT ZONE SESSIONS — the public, pure form of the ruling's
 * reversibility law. `a` is the earlier record, `b` the later one.
 *
 * ELIGIBILITY IS DECIDABLE FROM THE RECORDS ALONE, which is the whole point of `closedBy` living on
 * them: `b`'s stay may be merged into `a`'s only if `a` was closed by a MARK (a boundary the user
 * made inside one uninterrupted stay) and the two name the same zone. Two records separated by a
 * real zone line can never qualify — the mobs were retired, the charm broke, the room changed —
 * and neither can two stays in different rooms. `null` is the honest answer for an ineligible pair;
 * a merge that quietly did it anyway would manufacture a stay that never happened.
 *
 * The merged record takes `a`'s identity (its id and its start), `b`'s end, and `b`'s `closedBy` —
 * because what ended the JOINED stay is what ended the later half of it. The summary is REBUILT
 * from the merged sums rather than combined: `dps` is a projection, never a stored number, so there
 * is nothing there to average.
 */
export function mergeZoneSessions(a: ZoneSession, b: ZoneSession): ZoneSession | null {
  if (a.closedBy !== 'mark') return null
  if (a.zone !== b.zone) return null
  const agg = mergeAgg(a.agg, b.agg)
  const finalizedMs = a.finalizedMs + b.finalizedMs
  const startTs = a.startTs !== 0 ? a.startTs : b.startTs
  const lastTs = b.lastTs !== 0 ? b.lastTs : a.lastTs
  const total = sumMap(agg.out)
  const durSec = Math.max(1, finalizedMs / 1000)
  return {
    id: a.id,
    zone: a.zone,
    agg,
    closedBy: b.closedBy,
    startTs,
    lastTs,
    finalizedMs,
    activeMs: a.activeMs + b.activeMs,
    summary: {
      id: a.id,
      zone: a.zone,
      closedBy: b.closedBy,
      startTs,
      endTs: lastTs,
      total,
      dps: total / durSec,
      live: false
    }
  }
}
