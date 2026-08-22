// The combat engine's AGGREGATION primitives — extracted verbatim from engine.ts.
//
// Everything here is pure accumulation over a segment (an encounter or a zone session):
// per-source / per-category / per-skill damage stats, the accuracy + resist counters, the
// melee-rounds heuristic, the proc ledger, and the `Agg` that binds them together with the
// healing ledger (healing.ts). No engine state, no world model, no time — the state machine
// that decides WHICH aggregate a line belongs to lives in routing.ts.

import { HealAccum } from './healing'
import { addSpellProc, type SpellProcFold, type SpellProcLane } from './procDetect'
import { WindowAccum } from './procWindows'
import { RoundAccum } from './rounds'
import type { MissType } from '../../shared/logEvents'
import type { DamageCategory, DamageType, MissBreakdown, SourceKind } from '../../shared/combat'

/**
 * The engine's internal damage record. Sourced from the canonical `damage`
 * LogEvent, but with a non-null attacker (caster-less other-player DoTs — which
 * carry attacker:null — are ignored by the engine before this is built).
 */
export interface DamageEvent {
  ts: number
  attacker: string
  target: string
  amount: number
  dtype: DamageType
  dclass?: string
  skill: string
  crit: boolean
  modifier?: string
  /** Taxonomy category (Task #51). Derived from dtype+modifiers if the event omits it
   *  (older events / synthesized miss probes), so aggregation always has a category. */
  category: DamageCategory
  /** Parsed paren-modifier tokens (Task #51), e.g. ["Riposte","Critical"]. */
  modifiers: string[]
  /** The un-conjugated melee verb ('strike', 'kick'), on melee/slay lines only. The join key
   *  between a swing and the active special attack (see combat/specialAttacks.ts). Read ONCE,
   *  by ingest's lane naming; no accumulator touches it. */
  verb?: string
}

/** The identity of a meter ROW (aggregate key + display name + kind). Bundled because the
 *  three always travel together — the outgoing routing paths resolve them once (outSource)
 *  and hand the same triple to every Agg method. */
export interface SourceRef {
  id: string
  name: string
  kind: SourceKind
}

export interface SkillStat {
  name: string
  total: number
  hits: number
  crits: number
  max: number
  /** Smallest LANDED amount on this lane; 0 = "no landed hit yet" (see accrueMin). */
  min: number
  misses: number
  /** Spell resists on this spell/dot lane (Task #51 v2). */
  resists: number
  /** Landings this lane recorded with NO damage line of its own — effect-proc emotes, joined
   *  in at view-build from the proc ledger (see SkillView.lands). Always 0 on the accumulator
   *  itself: nothing on the ingest path writes it, because the join needs the whole segment's
   *  strike map to know which lanes have damage rows and which do not. */
  lands: number
}

/** Per-category rollup within a source (Task #51 drill-down level 2). Holds the
 *  category total + its own per-skill/per-spell breakdown (level 3). */
export interface CategoryStat {
  category: DamageCategory
  total: number
  hits: number
  crits: number
  max: number
  /** Spell resists rolled into this category (spell/dot only; Task #51 v2). */
  resists: number
  bySkill: Map<string, SkillStat>
}

/** Multi-attack "rounds" heuristic accumulator (Task #51). A round = the set of a
 *  source's melee/slay hits sharing the same 1-second bucket (floor(ts/1000)) with the
 *  same skill; roundsByHits[k] counts rounds that landed exactly k hits. The log does
 *  NOT record double/triple attack, so this is an HONEST cluster heuristic, never a
 *  fabricated multi-attack flag. Off-hand vs main-hand is not distinguishable. */
export interface RoundsAccum {
  /**
   * skillLower → (floor(ts/1000) → hit count in that bucket). THE ONLY state: the hits-per-round
   * histogram is derived from it at view time (`finalizeRounds`) and deliberately not cached back
   * here — a view build may not write to the aggregate (tests/combatCombinePetsPurity.test.mts).
   *
   * NESTED rather than keyed on `${skillLower}|${second}` (JOS-59). Nothing has ever read the key
   * — `finalizeRounds` only counts the VALUES — so the composite string was pure per-swing
   * allocation on the hottest line in the fold: one template literal per landed melee swing, in
   * BOTH the encounter aggregate and the zone aggregate. The bucketing is unchanged, because
   * (skill, second) still identifies exactly one counter.
   */
  bucket: Map<string, Map<number, number>>
}
function newMissBreakdown(): MissBreakdown {
  return { miss: 0, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 }
}

/**
 * ONE BASE MODIFIER'S TALLY on a source (docs/plans/attack-round-stats.md §2 — a STATED stat).
 * COUNTS ONLY, never amounts: this is the miss/resist precedent applied to the paren
 * annotations, so it moves no damage total (law 8's tripwire).
 *
 * The 14 compound forms the log actually prints decompose over 8 BASES (measured, full-log
 * 2026-08-05: Critical 31,653 · Riposte 16,841 · Slay Undead 1,980 · Finishing Blow 1,107 ·
 * Flurry 241 · Rampage 208 · Crippling Blow 9 · Strikethrough 1, plus the compounds
 * Riposte Critical 203, Riposte Slay Undead 12, Riposte Rampage 9, Critical Flurry 9,
 * Riposte Flurry 3, Riposte Finishing Blow 2). `parseModifiers` does the decomposition; this
 * tallies the COMPONENTS, and the raw compound stays on the event for the ring/timeline.
 */
export interface ModifierTally {
  name: string
  /** annotated swings/casts — landed AND avoided. */
  count: number
  /** of those, how many carried no amount (an avoided swing). */
  avoided: number
  /**
   * Damage the LANDED annotated lines carried (JOS-354 — "riposte damage broken out inside my
   * melee damage"). An INDEX over damage `addToSource` has already booked into the source, the
   * category and the lane: it is read back out here, never accumulated a second time, so law 8's
   * tripwire holds exactly as it did when this whole block was counts-only. Avoided swings
   * contribute 0 by construction (they carry no amount at all).
   */
  total: number
}

/**
 * ONE AVOIDED SWING as the aggregate folds it. `verb`/`modifiers` are additive
 * (docs/plans/attack-round-stats.md): a miss line names its verb and can carry an annotation
 * (`… but miss! (Flurry)`), and 123 of the log's 253 flurry annotations are on miss lines —
 * counting only landed ones would halve the stat. They feed the round grouper and the modifier
 * tallies ONLY; `skill` is unchanged and still lanes the miss exactly where it always did.
 */
export interface MissFold {
  mtype: MissType
  /** the lane the miss counts against — 'Melee' for every avoided swing, as shipped. */
  skill: string
  /** un-conjugated verb off the miss line, when it named one. */
  verb?: string
  /** the ROUND lane's display name for that verb (special-attack renamed) — never the
   *  aggregation lane above, which stays 'Melee' for every avoided swing. */
  laneSkill?: string
  /** decomposed base modifiers on the miss line ([] when it carried none). */
  modifiers?: readonly string[]
  /** the defender — round identity (see rounds.ts's fan-out collapse). */
  target?: string
  /** epoch ms — round identity. */
  ts?: number
}

export interface SourceStat {
  name: string
  kind: SourceKind
  total: number
  hits: number
  crits: number
  ambiguousHits: number
  ambiguousTotal: number
  /** Avoided swings by this source, all outcomes. */
  misses: number
  miss: MissBreakdown
  /** Spell resists against this source's detrimental spells (Task #51 v2). */
  resists: number
  bySkill: Map<string, SkillStat>
  /** Per-category rollup (Task #51 drill-down level 2 + 3). */
  byCategory: Map<DamageCategory, CategoryStat>
  /** Melee-rounds heuristic accumulator (Task #51). */
  rounds: RoundsAccum
  /** Base-modifier tallies (attack-round stats). Counts only — see ModifierTally. */
  mods: Map<string, ModifierTally>
  /**
   * ATTACK-ROUND STRUCTURE (attack-round stats §3) — per (verb, swings-per-round) counters,
   * built by the pure grouper in rounds.ts. Additive and amount-free: it reads a swing's
   * amount for the fan-out signature and stores none of it.
   */
  roundAcc: RoundAccum
}

export function newSkill(name: string): SkillStat {
  return { name, total: 0, hits: 0, crits: 0, max: 0, min: 0, misses: 0, resists: 0, lands: 0 }
}

/**
 * Fold a LANDED amount into a per-skill running minimum. 0 is the "nothing landed yet"
 * sentinel: route() drops amount <= 0, so every value reaching here is > 0 and a lane that
 * only ever missed/resisted keeps min 0 (never a fabricated "min 3 → min 0" from a whiff).
 */
function accrueMin(prev: number, amount: number): number {
  return prev === 0 ? amount : Math.min(prev, amount)
}

/** Merge two per-skill minima under the same sentinel rule (used by the combine-pets fold). */
export function mergeMin(a: number, b: number): number {
  if (a === 0) return b
  if (b === 0) return a
  return Math.min(a, b)
}

export function newCategory(category: DamageCategory): CategoryStat {
  return { category, total: 0, hits: 0, crits: 0, max: 0, resists: 0, bySkill: new Map() }
}

function newRounds(): RoundsAccum {
  return { bucket: new Map<string, Map<number, number>>() }
}

/** Fold a melee/slay hit into the rounds heuristic: bump the (skill, second) bucket. */
function accrueRound(r: RoundsAccum, skill: string, ts: number): void {
  const lane = skill.toLowerCase()
  let seconds = r.bucket.get(lane)
  if (seconds === undefined) {
    seconds = new Map<number, number>()
    r.bucket.set(lane, seconds)
  }
  const sec = Math.floor(ts / 1000)
  seconds.set(sec, (seconds.get(sec) ?? 0) + 1)
}

/** Collapse the in-progress buckets into the hits-per-round histogram. PURE: the buckets are
 *  the source of truth and this only reads them, so calling it at snapshot/finalize is safe,
 *  repeatable and cheap (buckets ≈ #seconds). */
export function finalizeRounds(r: RoundsAccum): number[] {
  const hist: number[] = []
  for (const seconds of r.bucket.values()) {
    for (const hits of seconds.values()) {
      const idx = Math.max(0, hits - 1)
      hist[idx] = (hist[idx] ?? 0) + 1
    }
  }
  for (let i = 0; i < hist.length; i++) hist[i] ??= 0
  return hist
}

function addToSource(src: SourceStat, ev: DamageEvent, ambiguous: boolean): void {
  src.total += ev.amount
  src.hits += 1
  if (ev.crit) src.crits += 1
  if (ambiguous) {
    src.ambiguousHits += 1
    src.ambiguousTotal += ev.amount
  }
  const s = src.bySkill.get(ev.skill) ?? newSkill(ev.skill)
  s.total += ev.amount
  s.hits += 1
  if (ev.crit) s.crits += 1
  s.max = Math.max(s.max, ev.amount)
  s.min = accrueMin(s.min, ev.amount)
  src.bySkill.set(ev.skill, s)

  addToCategory(src, ev)
  addSwingCounters(src, ev)
}

/** Category rollup (drill-down level 2/3): the same skill breakdown, partitioned by taxonomy
 *  category so a source can be opened into melee/slay/spell/dot/ds. */
function addToCategory(src: SourceStat, ev: DamageEvent): void {
  const c = src.byCategory.get(ev.category) ?? newCategory(ev.category)
  c.total += ev.amount
  c.hits += 1
  if (ev.crit) c.crits += 1
  c.max = Math.max(c.max, ev.amount)
  const cs = c.bySkill.get(ev.skill) ?? newSkill(ev.skill)
  cs.total += ev.amount
  cs.hits += 1
  if (ev.crit) cs.crits += 1
  cs.max = Math.max(cs.max, ev.amount)
  cs.min = accrueMin(cs.min, ev.amount)
  c.bySkill.set(ev.skill, cs)
  src.byCategory.set(ev.category, c)
}

/**
 * The COUNT-ONLY counters a landed swing feeds: the legacy melee-rounds heuristic, the base
 * modifier tallies, and the attack-round grouper. Not one of them touches `src.total`, a
 * category total or a lane total — which is exactly why adding the last two moved no damage
 * number anywhere in the engine (law 8's tripwire).
 */
function addSwingCounters(src: SourceStat, ev: DamageEvent): void {
  const isSwing = ev.category === 'melee' || ev.category === 'slay'
  // Melee-rounds heuristic (Task #51): only melee/slay hits cluster into "rounds" (spells and
  // DoTs are single applications). Bucket by (skill, whole-second).
  if (isSwing) accrueRound(src.rounds, ev.skill, ev.ts)
  tallyModifiers(src, ev.modifiers, false, ev.amount)
  // A SWING is a melee/slay line that named its VERB — the join key the round grouper is keyed
  // on. Spells, DoTs and damage shields name no verb and are not swings.
  if (isSwing && ev.verb !== undefined) {
    src.roundAcc.add({
      ts: ev.ts, verb: ev.verb, skill: ev.skill, target: ev.target,
      amount: ev.amount, avoided: false, modifiers: ev.modifiers
    })
  }
}

/**
 * Fold the decomposed base modifiers of one line into a source's tallies. COUNTS, plus the
 * landed line's own amount re-read into `total` (see ModifierTally.total — an index, not a
 * second accumulation). An avoided swing passes 0 and is the only caller that may.
 */
function tallyModifiers(src: SourceStat, mods: readonly string[], avoided: boolean, amount: number): void {
  for (const name of mods) {
    const t = src.mods.get(name) ?? { name, count: 0, avoided: 0, total: 0 }
    t.count += 1
    if (avoided) t.avoided += 1
    else t.total += amount
    src.mods.set(name, t)
  }
}

/** Fold a miss (avoided swing) into a source's accuracy stats. */
function addMissToSource(src: SourceStat, m: MissFold): void {
  src.misses += 1
  src.miss[m.mtype] += 1
  const s = src.bySkill.get(m.skill) ?? newSkill(m.skill)
  s.misses += 1
  src.bySkill.set(m.skill, s)

  // ── ADDITIVE, AMOUNT-FREE (attack-round stats). An avoided swing carries no amount, so
  // none of this can move a total; it is the same first-class-but-damage-free treatment
  // misses already get (law 8).
  tallyModifiers(src, m.modifiers ?? [], true, 0)
  if (m.verb !== undefined && m.ts !== undefined) {
    src.roundAcc.add({
      ts: m.ts, verb: m.verb, skill: m.laneSkill ?? m.skill, target: m.target ?? '',
      amount: 0, avoided: true, modifiers: m.modifiers ?? []
    })
  }
}

/**
 * Fold a spell RESIST into a source's stats (Task #51 v2). A resist is the caster-side
 * analogue of a miss: it attaches to the resisted spell's lane (`spell`, display name) in
 * the given taxonomy category (spell/dot). It carries no damage, so only the resist
 * COUNTERS move — the source's damage total is byte-for-byte unchanged (the tripwire).
 * The lane is created lazily if the source hasn't landed that spell yet, so a spell that
 * was ALWAYS resisted still shows a row (0 hits / N resists → 0% land).
 */
function addResistToSource(src: SourceStat, spell: string, category: DamageCategory): void {
  src.resists += 1
  const s = src.bySkill.get(spell) ?? newSkill(spell)
  s.resists += 1
  src.bySkill.set(spell, s)
  const c = src.byCategory.get(category) ?? newCategory(category)
  c.resists += 1
  const cs = c.bySkill.get(spell) ?? newSkill(spell)
  cs.resists += 1
  c.bySkill.set(spell, cs)
  src.byCategory.set(category, c)
}

export function newSource(name: string, kind: SourceKind): SourceStat {
  return {
    name, kind, total: 0, hits: 0, crits: 0, ambiguousHits: 0, ambiguousTotal: 0,
    misses: 0, miss: newMissBreakdown(), resists: 0, bySkill: new Map(), byCategory: new Map(), rounds: newRounds(),
    mods: new Map(), roundAcc: new RoundAccum()
  }
}

/**
 * The per-segment proc accumulator (Task #64). Pure counters — every one of them is
 * incremented on ingest from a line the game actually printed, so a downsampled or truncated
 * timeline can never move a number here (the timeline MARKERS are a separate, draw-only
 * concern; see TimelineMarker).
 */
export class ProcAccum {
  /** Strike name → landings. Keyed by the DISPLAY name we show, ambiguity included. */
  strikes = new Map<string, { name: string; count: number; ambiguous: boolean }>()
  /** Weakening-Strike landings — broken out because it is the one we time. */
  slowLands = 0
  /** Absolute ts of the FIRST slow landing in this segment (0 = none). */
  firstSlowTs = 0
  /** Outgoing lanes whose damage type was poison: skill → hits + total. */
  poisonDamage = new Map<string, { name: string; count: number; total: number }>()
  /** Dispel landings on engaged mobs (DISPEL_FAMILY only): tier label → count. Every lane is
   *  ambiguous by construction — each message tier is shared by 2–3 spells. */
  dispels = new Map<string, { name: string; count: number }>()
  /** YOUR coats applied inside this segment, in order. */
  coats: { poison: string; ts: number }[] = []
  stanceSwitches = 0
  invocationSwitches = 0
  /**
   * YOUR logged swing attempts in this segment: melee + slay hits, plus your misses. The
   * MECHANICAL denominator for a chance-on-hit proc rate, and the only one of the three with
   * no active-time ambiguity. Main-hand vs off-hand and double/triple attack are
   * undistinguishable in this log (law 6), so this is swings-AS-LOGGED.
   *
   * A COUNT, not an amount: it moves no damage total, which is what keeps this whole feature
   * inside law 8's tripwire.
   */
  swings = 0
  /**
   * THE SWING EXPOSURE PER STATE (proc-analytics §2.1, `ProcLink`): `<kind>:<key>` → how many
   * of the swings above were logged while that state was open. The other half of a link — "it
   * never fired without it" is evidence only in proportion to how many swings there WERE without it,
   * and that denominator, like the firings themselves, can only be counted on ingest.
   *
   * Bounded by the number of distinct states a segment ever saw (a couple of dozen at the very
   * most), and each entry is one integer.
   */
  swingsByState = new Map<string, number>()
  /**
   * THE ACTIVE-TIME EXPOSURE PER STATE: `<kind>:<key>` → ms of the meter's own active time that
   * elapsed while that state was open. The PPM denominator for any lane whose SOURCE window is
   * known (2026-08-04) — a poison Strike can only fire while its coat is on the blades, and an
   * aura-granted proc only while the aura is up, so dividing either by the whole segment
   * understates it by exactly the time the source was absent.
   *
   * Folded on ingest from the SAME per-hit delta `WindowAccum` receives (routing.ts's capped-gap
   * accrual, handed down by the caller and never recomputed), so it can no more drift from
   * `activeSec` than the window ledger can. Bounded like `swingsByState`: one integer per state
   * the segment ever saw.
   */
  activeMsByState = new Map<string, number>()
  /**
   * SPELL-PROC lanes (proc-analytics §4.1): spell effects with no own cast behind them, keyed
   * by `spellCanonKey`. The damage they carry is ALREADY inside this segment's outgoing total
   * — this is an INDEX over damage already counted, never a second accumulation of it.
   */
  spellProcs = new Map<string, SpellProcLane>()

  /** Count one detected cast-less spell effect. */
  addSpellProc(f: SpellProcFold): void {
    addSpellProc(this.spellProcs, f)
  }

  /** Count one of YOUR logged swing attempts, against the states open when you made it. Both
   *  numbers move together on purpose: a total and a per-state split that could be updated
   *  independently would drift the moment one call site forgot the other. */
  addSwing(active: ReadonlySet<string>): void {
    this.swings++
    for (const key of active) this.swingsByState.set(key, (this.swingsByState.get(key) ?? 0) + 1)
  }

  /** Charge one hit's active-time delta to every state that was open for it. Called on EVERY
   *  folded damage line, incoming included, because that is precisely what the meter's own
   *  `activeMs` counts — the two denominators have to mean the same thing to be comparable. */
  addActiveMs(ms: number, active: ReadonlySet<string>): void {
    if (ms <= 0) return
    for (const key of active) this.activeMsByState.set(key, (this.activeMsByState.get(key) ?? 0) + ms)
  }

  addStrike(name: string, ambiguous: boolean, ts: number, isSlow: boolean): void {
    const s = this.strikes.get(name) ?? { name, count: 0, ambiguous }
    s.count++
    this.strikes.set(name, s)
    if (isSlow) {
      this.slowLands++
      if (this.firstSlowTs === 0) this.firstSlowTs = ts
    }
  }
  addPoisonDamage(skill: string, amount: number): void {
    const s = this.poisonDamage.get(skill) ?? { name: skill, count: 0, total: 0 }
    s.count++
    s.total += amount
    this.poisonDamage.set(skill, s)
  }
  addDispel(label: string): void {
    const s = this.dispels.get(label) ?? { name: label, count: 0 }
    s.count++
    this.dispels.set(label, s)
  }
}

export class Agg {
  // Keyed by INSTANCE id (or 'you'/'pet:<instanceId>'); `name` holds display.
  out = new Map<string, SourceStat>()
  inc = new Map<string, SourceStat>()
  targets = new Map<string, { name: string; amount: number }>()
  /** Healing received by hostile instances engaged here (instanceId → total). */
  enemyHeal = new Map<string, { name: string; amount: number }>()
  /** Healing received by You / your pets: healerKey → { name, total, count }. */
  incHeal = new Map<string, { name: string; amount: number; count: number }>()
  /** The meter-grade HEALING + ABSORPTION ledger (Task #59). Lives on the SAME aggregate as the
   *  damage bars, so the healing overlays inherit fight / zone-session selection, the finalized
   *  zone-session freeze and the encounter history without any parallel machinery. Deliberately
   *  ADDITIVE: `enemyHeal`/`incHeal` above are untouched, so every existing damage/heal total
   *  (and the enemyHealTotal annotation) stays byte-identical. */
  heal = new HealAccum()
  /**
   * PROC LEDGER (Task #64) — rogue-poison Strikes, poison-typed damage lanes, non-damage spell
   * landings on engaged mobs, and the stance/coat bookkeeping. On the Agg for exactly the same
   * reason the healing ledger is: an encounter and a finalized zone session then get it for
   * free, and the numbers are folded on INGEST so they never depend on the event ring.
   */
  procs = new ProcAccum()
  /**
   * THE MINUTE-WINDOW LEDGER (proc-analytics §5.1) — the matched-window sample the Tier-B
   * counterfactual is computed from. On the `Agg` for the third time and for the third
   * identical reason: a finalized zone session inherits it FROZEN, so "how much DPS did X add
   * this session" survives the zone change that produced it, with no parallel machinery and no
   * dependence on any event ring.
   */
  windows = new WindowAccum()
  /**
   * RE-STATE a row's identity from the ref that just arrived. The display name has always been
   * refreshed this way (world-model law 2: the log's latest spelling wins).
   *
   * THE KIND MOVES TOO SINCE JOS-430, and ONE transition is allowed: `'other'` → `'member'`. A
   * combatant recorded before your group learned their name is `'other'`; the moment the roster
   * admits them the SAME row (`member:<key>` — one id, one aggregate, one bar) starts arriving as
   * `'member'` and the bar re-labels itself without splitting.
   *
   * IT IS ONE-WAY ON PURPOSE, and the G1 golden window is why: that fixture ends with a DISBAND,
   * and the roster's admission set is cleared by a self-leave. A free-running assignment would let
   * the last line of a session decide what a fight two minutes earlier was, so a group-mate's bar
   * would quietly stop saying `group` the moment you left the group. What this fight's damage WAS
   * does not change when the group ends. Every other kind is a constant for a given row id
   * (`you`, `pet:<instance>`, `allypet:…`), so nothing else can reach this line at all.
   */
  private reid(s: SourceStat, ref: SourceRef): void {
    if (s.name !== ref.name) s.name = ref.name
    if (s.kind === 'other' && ref.kind === 'member') s.kind = 'member'
  }
  /** DROP a recorded row (JOS-430). The one caller is `EngineState.retractOther`: a name a
   *  stronger model has just claimed as a pet must not keep a second bar beside the pet's own.
   *  Safe by construction — an `'other'` row is additive (it enters no `you`/`pet` total and no
   *  target/engaged set), so removing it can move nothing that existed before it did. */
  dropOut(id: string): boolean {
    return this.out.delete(id)
  }
  addOut(ref: SourceRef, ev: DamageEvent, ambiguous = false): void {
    const s = this.out.get(ref.id) ?? newSource(ref.name, ref.kind)
    this.reid(s, ref)
    addToSource(s, ev, ambiguous)
    this.out.set(ref.id, s)
  }
  addInc(id: string, name: string, ev: DamageEvent): void {
    const s = this.inc.get(id) ?? newSource(name, 'enemy')
    addToSource(s, ev, false)
    this.inc.set(id, s)
  }
  addOutMiss(ref: SourceRef, m: MissFold): void {
    const s = this.out.get(ref.id) ?? newSource(ref.name, ref.kind)
    this.reid(s, ref)
    addMissToSource(s, m)
    this.out.set(ref.id, s)
  }
  addIncMiss(id: string, name: string, m: MissFold): void {
    const s = this.inc.get(id) ?? newSource(name, 'enemy')
    addMissToSource(s, m)
    this.inc.set(id, s)
  }
  addOutResist(ref: SourceRef, spell: string, category: DamageCategory): void {
    const s = this.out.get(ref.id) ?? newSource(ref.name, ref.kind)
    this.reid(s, ref)
    addResistToSource(s, spell, category)
    this.out.set(ref.id, s)
  }
  addIncResist(id: string, name: string, spell: string, category: DamageCategory): void {
    const s = this.inc.get(id) ?? newSource(name, 'enemy')
    addResistToSource(s, spell, category)
    this.inc.set(id, s)
  }
  addEnemyHeal(id: string, name: string, amount: number): void {
    const t = this.enemyHeal.get(id) ?? { name, amount: 0 }
    t.amount += amount
    this.enemyHeal.set(id, t)
  }
  addIncHeal(healerKey: string, name: string, amount: number): void {
    const t = this.incHeal.get(healerKey) ?? { name, amount: 0, count: 0 }
    t.amount += amount
    t.count += 1
    this.incHeal.set(healerKey, t)
  }
  bumpTarget(id: string, name: string, amount: number): void {
    const t = this.targets.get(id) ?? { name, amount: 0 }
    t.amount += amount
    this.targets.set(id, t)
  }
}

export function sumHeal(m: Map<string, { amount: number }>): number {
  let t = 0
  for (const v of m.values()) t += v.amount
  return t
}

export function sumMap(m: Map<string, SourceStat>): number {
  let t = 0
  for (const s of m.values()) t += s.total
  return t
}

export const MISS_KEYS: MissType[] = ['miss', 'dodge', 'parry', 'riposte', 'block', 'absorb']
