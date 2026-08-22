// ATTACK-ROUND STRUCTURE — the pure grouper behind the Rounds panel
// (docs/plans/attack-round-stats.md §3). Counts only: nothing in this file ever sees, stores
// or returns a damage amount as a STAT, so every damage total in the engine stays
// byte-identical (world-model law 8's tripwire). Amounts are read for exactly one purpose —
// the fan-out signature below — and discarded.
//
// ── WHAT A "ROUND" IS, AND WHY IT NEEDS A GROUPER AT ALL ────────────────────────────────────
//
// EQ Legends ANNOTATES riposte, flurry and rampage swings, and says NOTHING about double or
// triple attack: a full-log sweep (1.35M lines, 2026-08-05) finds zero annotations against
// thousands of measured multi-swing seconds. So a round is a proxy, and the honest one is:
//
//   one round = the swings ONE attacker made with ONE verb, at ONE target, in ONE second.
//
// The per-TARGET part is what the previous heuristic (aggregate.ts `RoundsAccum`, kept intact
// beside this) lacks, and it is not a refinement — it is the difference between a right answer
// and a wrong one:
//
// ── THE FAN-OUT HAZARD (measured, and the reason this module exists) ─────────────────────────
//
// Backstab has a ~10s reuse timer, so four backstabs in one second is mechanically impossible.
// The log contains exactly five such seconds, and ALL FIVE are the same shape:
//
//   [Tue Aug 04 21:24:38] You backstab Warlord Skarlon for 45 points of damage.
//   [Tue Aug 04 21:24:38] You backstab a fire giant wizard for 45 points of damage.
//   [Tue Aug 04 21:24:38] You backstab Warlord Skarlon for 31 points of damage.
//   [Tue Aug 04 21:24:38] You backstab a fire giant wizard for 31 points of damage.
//
// Two targets, the SAME ordered damage sequence on each: one double-attack round FANNED across
// two defenders, printed twice. Counting per-target alone would report two 2-swing rounds; not
// grouping by target at all would report one 4-swing round — a quadruple backstab, which the
// reuse timer forbids. Collapsing equal sequences reports what happened: one 2-swing round.
// (One of the five seconds carries a `(Critical)` on only one of the two copies, which is why
// the signature is over AMOUNTS and never over modifiers.)
//
// ── WHAT IS EXCLUDED FROM ROUND COUNTING, AND WHY ────────────────────────────────────────────
//
// A round is meant to answer "how many swings did one attack get me". Three annotated families
// are EXTRA swings by definition and would inflate that answer, so they are counted separately
// and never entered into a round:
//   Riposte  — a counter-swing granted by the defender's own attack, not by your attack round.
//   Flurry   — up to two extra primary swings AFTER a triple (Burst of Power AA); the log says
//              so on the swing itself.
//   Rampage  — an extra swing, annotated incoming/third-party only.
// Frenzy is excluded on the same logic without needing an annotation: it is a multi-hit skill
// BY DESIGN (`You frenzy on <mob> …` prints four times in one second routinely), so its
// swings-per-round distribution measures the skill, not multi-attack.
//
// ── WHAT THIS CANNOT SAY (law 6) ─────────────────────────────────────────────────────────────
//
// DUAL WIELD puts two weapons on ONE verb: a same-second 2x on `slash` may be two hands rather
// than a double attack, and no line distinguishes them. Reuse-timer skills (backstab, bash,
// kick, and the `strike` special lane) have no such confound — one timer, one hand. That split
// is the whole content of `roundConfidence()` below, and the renderer must carry it.

/** Confidence in a lane's multi-swing reading — the dual-wield confound, made explicit. */
export type RoundConfidence = 'perEvent' | 'aggregate'

/**
 * Verbs driven by a REUSE TIMER rather than by a weapon in a hand. HAND-AUTHORED and
 * evidence-verified (the shared/zones.ts precedent, law 12): a matcher would happily promote a
 * weapon verb into the confident tier.
 *   backstab — ~10s timer, in-log confirmed (the measured triple at Tue Aug 04 17:55:20).
 *   bash / kick — shield and kick lanes; wiki-stated timers, and `kick` additionally carries the
 *                 special-attack lane (Kick → Round Kick → Flying Kick).
 *   strike — the monk special lane (Tiger Claw → Eagle Strike → Dragon Punch); one ability, one
 *            timer, and the verb is exclusive to it (specialAttacks.ts holds the proof).
 * Everything else is a WEAPON verb and reads `aggregate`.
 */
const REUSE_TIMER_VERBS: ReadonlySet<string> = new Set(['backstab', 'bash', 'kick', 'strike'])

/** Why a swing was kept out of round counting — reported so the denominator is never silent. */
export type RoundExclusion = 'frenzy' | 'riposte' | 'flurry' | 'rampage'

/**
 * Verbs that never enter round counting: multi-hit by design (see the header). `flurry` is
 * here as a VERB too — the parser recognizes `You flurry …` as its own melee verb, and a swing
 * that prints under it is the same extra swing the `(Flurry)` annotation marks.
 */
const EXCLUDED_VERBS: ReadonlyMap<string, RoundExclusion> = new Map([
  ['frenzy', 'frenzy'],
  ['flurry', 'flurry']
])

/**
 * Base modifiers that mark a swing as an EXTRA swing rather than part of an attack round.
 * Keyed lowercase; `parseModifiers` has already decomposed every compound form
 * ("Riposte Critical" → ["Riposte","Critical"]) before anything here sees it.
 */
const EXTRA_SWING_MODS: ReadonlyMap<string, RoundExclusion> = new Map([
  ['riposte', 'riposte'],
  ['flurry', 'flurry'],
  ['rampage', 'rampage']
])

/** One logged swing ATTEMPT, reduced to what round structure needs. Landed and avoided swings
 *  both arrive here: a round is swings ATTEMPTED, and a double attack whose second swing missed
 *  is still a double attack. */
export interface SwingRecord {
  ts: number
  /** un-conjugated melee verb ('slash', 'backstab') — the ROUND identity. */
  verb: string
  /** display lane name (special-attack renamed, e.g. 'Flying Kick'); labels the row only. */
  skill: string
  /** the defender, as the line named it. Case-folded by the accumulator (law 2). */
  target: string
  /** landed amount, or 0 for an avoided swing. Used ONLY for the fan-out signature. */
  amount: number
  /** true when the swing was avoided (miss/dodge/parry/riposte/block/absorb). */
  avoided: boolean
  /** decomposed base modifiers on the line ([] when it carried none). */
  modifiers: readonly string[]
}

/**
 * Why a swing is not part of an attack round, or null when it is one. PURE.
 *
 * `verbLower` is the caller's already-lowercased verb when it has one (JOS-59 — `RoundAccum.add`
 * needs the same string a statement later, and lowercasing it twice per swing on a 1.4M-event
 * fold is a measurable cost for no meaning). Absent, this lowercases it itself, exactly as before.
 */
export function roundExclusion(
  rec: {
    verb: string
    modifiers: readonly string[]
  },
  verbLower?: string
): RoundExclusion | null {
  const byVerb = EXCLUDED_VERBS.get(verbLower ?? rec.verb.toLowerCase())
  if (byVerb !== undefined) return byVerb
  for (const m of rec.modifiers) {
    const byMod = EXTRA_SWING_MODS.get(m.toLowerCase())
    if (byMod !== undefined) return byMod
  }
  return null
}

/** The confidence tier for a verb's multi-swing reading. PURE. */
export function roundConfidence(verb: string): RoundConfidence {
  return REUSE_TIMER_VERBS.has(verb.toLowerCase()) ? 'perEvent' : 'aggregate'
}

/** How many swing buckets a lane reports: 1, 2, 3, and a 4+ tail. */
export const ROUND_BUCKETS = 4

/** The bucket index (0-based) for a round of `swings` swings; the last bucket is 4+. */
export function roundBucket(swings: number): number {
  return Math.min(ROUND_BUCKETS, Math.max(1, swings)) - 1
}

/** One (verb, second) round after the per-target lanes were collapsed. */
interface CollapsedRound {
  verb: string
  skill: string
  seq: number[]
  targets: number
}

/** One grouped attack round. */
export interface RoundGroup {
  verb: string
  skill: string
  /** whole-second bucket (floor(ts/1000)). */
  second: number
  /** swings in the round, AFTER the fan-out collapse. */
  swings: number
  /** how many defenders this one round was printed against (>1 ⇒ a collapsed fan-out). */
  targets: number
}

/**
 * A per-target swing sequence being assembled for one (verb, second).
 *
 * `seq` holds NUMBERS (JOS-59): a landed swing contributes its amount, an avoided one contributes
 * -1. It used to hold the string forms ('145' / 'x'), which meant a `String(amount)` allocation
 * per swing purely to be joined into a signature that most seconds never need — the overwhelming
 * majority hold ONE lane, and a single lane cannot be a fan-out. Amounts reaching a round are
 * always > 0 (route() drops anything else) so -1 can never collide with one, and joining numbers
 * produces exactly the grouping the string tokens produced.
 */
interface PendingLane {
  verb: string
  skill: string
  /** ordered per-swing signature tokens (the amount, or -1 for an avoided swing). */
  seq: number[]
}

/**
 * THE GROUPER, as a pure function over a whole swing list. Round identity is
 * (verb, second, target); groups within one (verb, second) whose ordered signature is IDENTICAL
 * are ONE round fanned across those defenders (see the header's measurement).
 *
 * Exclusions are the CALLER's job — `roundExclusion` above is the predicate, so a caller that
 * folds incrementally and a caller that groups a whole list agree by construction.
 */
export function groupRounds(swings: readonly SwingRecord[]): RoundGroup[] {
  const bySecond = new Map<string, Map<string, PendingLane>>()
  const order: string[] = []
  for (const s of swings) {
    const sec = Math.floor(s.ts / 1000)
    const verb = s.verb.toLowerCase()
    const key = `${verb}|${sec}`
    let lanes = bySecond.get(key)
    if (!lanes) {
      lanes = new Map()
      bySecond.set(key, lanes)
      order.push(key)
    }
    const tKey = s.target.trim().toLowerCase()
    const lane = lanes.get(tKey) ?? { verb, skill: s.skill, seq: [] }
    lane.skill = s.skill
    lane.seq.push(signatureToken(s))
    lanes.set(tKey, lane)
  }
  const out: RoundGroup[] = []
  for (const key of order) {
    const lanes = bySecond.get(key)
    if (!lanes) continue
    const second = Number(key.slice(key.indexOf('|') + 1))
    for (const g of collapseFanOut([...lanes.values()])) {
      out.push({ verb: g.verb, skill: g.skill, second, swings: g.seq.length, targets: g.targets })
    }
  }
  return out
}

/** One swing's contribution to a fan-out signature: its amount, or -1 when it was avoided. */
function signatureToken(s: { amount: number; avoided: boolean }): number {
  return s.avoided ? -1 : s.amount
}

/**
 * Collapse per-target lanes whose ordered signature is identical into ONE round, carrying the
 * number of defenders it was printed against. Order-stable: the first lane with a signature
 * keeps its position, later duplicates only bump `targets`.
 *
 * THE SIGNATURE IS KEYED BY VERB. It has to be: `RoundAccum` holds one second's worth of EVERY
 * verb open at once, so a signature-only key merged a 163-damage backstab with a 163-damage
 * slash in the same second into one "fanned" round — two real rounds silently becoming one.
 * (`groupRounds` partitions by verb before calling this, so the key costs it nothing.)
 *
 * ONE LANE IS NEVER A FAN-OUT, so `RoundAccum.flush` short-circuits that case without calling
 * this at all — it is the case almost every second of a real log is (JOS-59).
 */
function collapseFanOut(lanes: Iterable<PendingLane>): CollapsedRound[] {
  const bySig = new Map<string, CollapsedRound>()
  const out: CollapsedRound[] = []
  for (const lane of lanes) {
    const sig = `${lane.verb}|${lane.seq.join(',')}`
    const seen = bySig.get(sig)
    if (seen) {
      seen.targets += 1
      continue
    }
    const g = { verb: lane.verb, skill: lane.skill, seq: lane.seq, targets: 1 }
    bySig.set(sig, g)
    out.push(g)
  }
  return out
}

// ── The incremental accumulator the engine folds into ───────────────────────────────────────

/** The finalized per-verb round counters for one source. */
export interface RoundLaneTally {
  verb: string
  /** display label — the special-attack lane name when the log named one, else the verb. */
  skill: string
  /** buckets[i] = rounds with exactly i+1 swings; the last bucket is 4-or-more. */
  buckets: number[]
  /** total rounds counted on this verb. */
  rounds: number
  /** rounds with 2+ swings. */
  multiRounds: number
  /** rounds that were printed against more than one defender (a collapsed fan-out). */
  fannedRounds: number
}

function newLane(verb: string, skill: string): RoundLaneTally {
  return { verb, skill, buckets: new Array<number>(ROUND_BUCKETS).fill(0), rounds: 0, multiRounds: 0, fannedRounds: 0 }
}

/**
 * ROUND COUNTERS FOR ONE SOURCE, folded on ingest and BOUNDED: only the second currently being
 * assembled is held open, so memory is (verbs × targets in one second), not (seconds × targets).
 * A swing whose second is different from the open one FLUSHES the open second into the counters
 * first. That is what lets a zone session spanning hours carry exact round structure for the
 * price of ~26 small objects.
 *
 * `snapshot()` is PURE — a view build may not write to an aggregate
 * (tests/combatSourceViewsPurity.test.mts pins the invariant repo-wide), so the still-open
 * second is folded into a COPY and the accumulator is left exactly as it was.
 */
export class RoundAccum {
  private readonly lanes = new Map<string, RoundLaneTally>()
  /** the second currently open, or -1 when nothing is pending. */
  private openSecond = -1
  /** `verb|target` → the sequence being assembled inside `openSecond`. */
  private pending = new Map<string, PendingLane>()
  /** swings kept out of round counting, by reason — the denominator's honesty. */
  readonly excluded: Record<RoundExclusion, number> = { frenzy: 0, riposte: 0, flurry: 0, rampage: 0 }

  /** Fold one logged swing attempt. Excluded swings are TALLIED, never dropped silently. */
  add(rec: SwingRecord): void {
    const verb = rec.verb.toLowerCase()
    const why = roundExclusion(rec, verb)
    if (why !== null) {
      this.excluded[why] += 1
      return
    }
    const sec = Math.floor(rec.ts / 1000)
    if (sec !== this.openSecond) {
      this.flush()
      this.openSecond = sec
    }
    const key = `${verb}|${rec.target.trim().toLowerCase()}`
    const lane = this.pending.get(key)
    if (lane === undefined) {
      this.pending.set(key, { verb, skill: rec.skill, seq: [signatureToken(rec)] })
      return
    }
    lane.skill = rec.skill
    lane.seq.push(signatureToken(rec))
  }

  /**
   * Close the open second into the counters. Idempotent on an empty pending map.
   *
   * THE ONE-LANE FAST PATH (JOS-59) is the case, not an edge: one attacker swinging one verb at
   * one defender inside one second is what a log is overwhelmingly made of, and a single lane
   * cannot be a fan-out of anything. It skips the signature map and the `seq.join(',')` that
   * `collapseFanOut` would build only to look it up once. The map is CLEARED rather than replaced
   * — `count()` reads `seq.length` and keeps no reference to the lane.
   */
  private flush(): void {
    const n = this.pending.size
    if (n === 0) return
    if (n === 1) {
      for (const lane of this.pending.values()) {
        this.count(this.lanes, { verb: lane.verb, skill: lane.skill, seq: lane.seq, targets: 1 })
      }
    } else {
      for (const g of collapseFanOut(this.pending.values())) this.count(this.lanes, g)
    }
    this.pending.clear()
  }

  /** Fold ONE collapsed round into a lane tally (shared by flush and the pure snapshot). */
  private count(into: Map<string, RoundLaneTally>, g: CollapsedRound): void {
    const lane = into.get(g.verb) ?? newLane(g.verb, g.skill)
    lane.skill = g.skill
    lane.buckets[roundBucket(g.seq.length)] += 1
    lane.rounds += 1
    if (g.seq.length >= 2) lane.multiRounds += 1
    if (g.targets > 1) lane.fannedRounds += 1
    into.set(g.verb, lane)
  }

  /**
   * The lanes as they stand, INCLUDING the still-open second — without touching the
   * accumulator. Copies every tally it has to modify, so a snapshot can be taken any number
   * of times, mid-fight, with byte-identical results.
   */
  snapshot(): RoundLaneTally[] {
    if (this.pending.size === 0) return [...this.lanes.values()].map(cloneLane)
    const copy = new Map<string, RoundLaneTally>()
    for (const [k, v] of this.lanes) copy.set(k, cloneLane(v))
    for (const g of collapseFanOut(this.pending.values())) this.count(copy, g)
    return [...copy.values()]
  }

  /** True when nothing has ever been folded (no lanes, no pending, no exclusions). */
  isEmpty(): boolean {
    return this.lanes.size === 0 && this.pending.size === 0
  }

  /** A DEEP COPY — every tally and the open second alike. The merge (combat/mergeSessions.ts) is
   *  pure, so it may not hand back a structure that aliases either input's counters. */
  clone(): RoundAccum {
    const copy = new RoundAccum()
    for (const [k, v] of this.lanes) copy.lanes.set(k, cloneLane(v))
    copy.openSecond = this.openSecond
    for (const [k, v] of this.pending) copy.pending.set(k, { verb: v.verb, skill: v.skill, seq: [...v.seq] })
    for (const key of ROUND_EXCLUSIONS) copy.excluded[key] = this.excluded[key]
    return copy
  }

  /**
   * FOLD A LATER ACCUMULATOR'S SWINGS INTO THIS ONE, as if they had simply followed ours — the
   * round half of the merge-back proof obligation (JOS-322, `mergeSessions.ts`).
   *
   * THE OPEN SECOND IS THE WHOLE SUBTLETY, and it is why this is a method rather than a field-wise
   * sum. An unsplit fold flushes the second WE left open at the moment `next`'s first swing
   * arrives; the split fold never flushed it, because nothing else was ever folded into us. So:
   *
   *   - `next` folded at least one countable swing ⇒ FLUSH ours (exactly what the unsplit fold did
   *     at that instant), add the lane tallies, and inherit `next`'s open second verbatim.
   *   - `next` folded none ⇒ nothing flushed ours in the reference either, so our open second is
   *     still the open second, untouched.
   *
   * THE ENUMERATED EDGE (stated, not papered over): if `next`'s first countable swing falls in the
   * SAME second we left open — which can only happen when the mark landed MID-ROUND — the unsplit
   * fold would have joined those swings into ONE round and this joins them as two. Excluded swings
   * are pure counters and always sum exactly.
   */
  absorb(next: RoundAccum): void {
    for (const key of ROUND_EXCLUSIONS) this.excluded[key] += next.excluded[key]
    if (next.lanes.size === 0 && next.pending.size === 0) return
    this.flush()
    for (const [k, v] of next.lanes) {
      const lane = this.lanes.get(k)
      if (!lane) {
        this.lanes.set(k, cloneLane(v))
        continue
      }
      lane.skill = v.skill
      for (let i = 0; i < lane.buckets.length; i++) lane.buckets[i] += v.buckets[i]
      lane.rounds += v.rounds
      lane.multiRounds += v.multiRounds
      lane.fannedRounds += v.fannedRounds
    }
    this.openSecond = next.openSecond
    this.pending = new Map()
    for (const [k, v] of next.pending) this.pending.set(k, { verb: v.verb, skill: v.skill, seq: [...v.seq] })
  }
}

/** The exclusion keys, as a list — so a merge iterates them instead of naming four fields twice
 *  and silently missing the fifth the day one is added. */
const ROUND_EXCLUSIONS: readonly RoundExclusion[] = ['frenzy', 'riposte', 'flurry', 'rampage']

function cloneLane(l: RoundLaneTally): RoundLaneTally {
  return { ...l, buckets: [...l.buckets] }
}
