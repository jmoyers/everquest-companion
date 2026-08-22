// Public combat model shared between the engine (main) and the UI (renderer).
// All types here are plain/serializable so snapshots can cross the IPC boundary.

import type {
  AttributionReport,
  ProcLaneView,
  ProcRateView,
  ProcSkillTag,
  StateSpan
} from './procAnalytics'
import type { RosterSnap } from './roster'

/**
 * WHOSE ROW THIS IS. `'member'` (docs/plans/group-model.md) is a player currently or formerly on
 * your group roster — the widening the reported "my group-mate is missing from the meter" bug
 * needed. It is a SOURCE kind only: a mob hitting a group member stays out of the model
 * entirely, so the incoming meter is still exactly "what is hitting You".
 *
 * `'allyPet'` (JOS-250) is SOMEBODY ELSE'S charm pet, bound to the person who charmed it. A FIFTH
 * kind rather than a flavour of `'pet'`, because the two answer opposite questions: a `'pet'` row
 * is yours and nests inside your breakdown, while this one belongs to a named third party and must
 * never be added to your total, your curve or your drill. Its row reads
 * `Pet (<mob>) - <Charmer>` and its damage is only ever the mob-vs-mob damage the admission gate
 * lets through while that bind is live and unambiguous (src/main/combat/allyCharms.ts).
 *
 * `'other'` (JOS-430) is A COMBATANT THE LOG NAMED and no stronger model claimed — the
 * record-everything widening the owner's 2026-08-20 ruling asked for ("Everyone means ANY fight the
 * log can see"). It is deliberately NOT called a player: EQ spells a summoned pet's name with the
 * same one-word proper-name grammar it gives people, so a row of this kind says the log named this
 * combatant dealing this damage and nothing more (src/main/combat/otherCombatants.ts carries the
 * ladder and the measurement). It shares the `member:<key>` id namespace with `'member'` ON
 * PURPOSE: the same person recorded before your group learns their name and after must be ONE row,
 * so the kind UPGRADES to `'member'` the moment the roster admits them and never moves back.
 */
export type SourceKind = 'you' | 'pet' | 'member' | 'enemy' | 'allyPet' | 'other'
export type DamageType = 'melee' | 'spell' | 'dot' | 'ds'

/**
 * Damage TAXONOMY category (Task #51), a superset dimension over DamageType: the
 * Slay Undead melee proc is split into its own 'slay' category per the user; every
 * other dtype maps 1:1. Computed at parse time (src/main/combat/taxonomy.ts) and
 * rolled into per-source category aggregates by the engine for the drill-down UI.
 */
export type DamageCategory = 'melee' | 'slay' | 'spell' | 'dot' | 'ds'

/** Display label + fixed ordering for each taxonomy category (UI + tests). */
export const CATEGORY_LABEL: Record<DamageCategory, string> = {
  melee: 'Melee',
  slay: 'Slay Undead',
  spell: 'Direct spells',
  dot: 'DoTs',
  ds: 'Damage shield'
}
export const CATEGORY_ORDER: DamageCategory[] = ['melee', 'slay', 'spell', 'dot', 'ds']

export interface SkillView {
  name: string
  total: number
  pct: number
  hits: number
  crits: number
  max: number
  /**
   * Smallest LANDED hit amount on this lane. Tracked over damage amounts ONLY — a miss or a
   * resist carries no amount, so an all-avoided lane must never report `min 0`. Absent when
   * the lane never landed a hit (resist-only lanes), and equal to `max` for a single-hit or
   * fixed-damage lane (the UI collapses that case to just the max).
   */
  min?: number
  /** Avoided swings for this skill (miss/dodge/parry/riposte/block/absorb). */
  misses?: number
  /** Spell resists for this spell/dot lane (Task #51 v2). resist rate = resists/(hits+lands+resists). */
  resists?: number
  /**
   * LANDINGS THIS LANE RECORDED WITH NO DAMAGE LINE OF ITS OWN (2026-08-04).
   *
   * An effect proc — a rogue slow, stun, dispel or mana drain — lands by printing a per-spell
   * EMOTE (`<mob>'s limbs move slower!`) and never a damage line, while its RESISTS print the
   * spell name like any other (`A wanderer resisted your Weakening Strike!`). So the lane
   * existed in the drill built entirely out of resists and read `0 landed · 34 resisted` — a
   * 100% resist rate for a proc that landed 562 times in the same log.
   *
   * This is the count of those emote landings, joined in at view-build from the proc ledger's
   * own strike map (the count the Procs tab already shows), and it is populated ONLY for lanes
   * with no damage rows at all — where a lane DOES carry damage (Asp Venom Strike prints an
   * emote AND a damage line for one firing) the damage rows already represent those firings
   * and adding the emotes would count each of them twice.
   *
   * Absent ⇒ no landing evidence exists for this lane, which is NOT the same as zero: a
   * hand-cast stun (Divine Stun) prints nothing at all when it lands, so its resist RATE has
   * no denominator and the UI must decline to state one rather than print 100%.
   */
  lands?: number
}

/** Breakdown of avoided swings by outcome (for hit% + defensive tooltip). */
export interface MissBreakdown {
  miss: number
  dodge: number
  parry: number
  riposte: number
  block: number
  absorb: number
}

// ---------------------------------------------------------------------------
// DEFENSIVE STATS (JOS-354) — "how often am I blocking, dodging, parrying, riposting?"
//
// EVERY NUMBER HERE IS A COUNT OR A RATIO OF COUNTS, exactly like the attack-round block
// below it: an avoided swing carries no amount, so nothing in `DefenseView` can move a damage
// total. The ONE amount in the neighbourhood is `RiposteView.damage`, and it is an INDEX over
// damage the melee lanes already counted — never a second accumulation of it (law 8).
//
// WHAT THE LOG SUPPORTS, MEASURED (whole-log sweep of eqlog_Primitive_freeport.txt, 2026-08-14):
//   `<mob> tries to <verb> YOU, but YOU block!`    10,553   ← your block
//   `… but YOU dodge!`                              8,070   ← your dodge
//   `… but YOU parry!`                              5,773   ← your parry
//   `… but YOU riposte!`                            4,171   ← your riposte (the AVOIDANCE half)
//   `… but misses!`                                        ← the mob's own to-hit failure, NOT a
//                                                            defensive skill of yours — its own row
//   `… but YOUR magical skin absorbs the blow!`            ← a rune ate it; likewise not a skill
//   `You <verb> <mob> for N points of damage. (Riposte)`   ← your riposte COUNTER-swing, 1,847
//                                                            plain + the `(Riposte …)` compounds
// All of these already reach the engine (parseCombat.MISS_RE / the melee battery's paren
// modifiers); this view is the READING of them, not new parsing.
//
// WHAT THE LOG DOES *NOT* SUPPORT, and is therefore absent rather than guessed:
//   - Shield block vs staff/weapon block, or which hand parried: the line names no equipment.
//   - "How often COULD I have blocked": there is no swing-eligibility signal, so every rate here
//     is over the swings that were actually aimed at you and nothing else.
//   - A defensive rate per MOB-skill (was I better against a kick than a bash): the avoidance
//     line names the attacker's verb, but the engine lanes every avoided swing under 'Melee' by
//     construction (routing.missFold) — a per-verb defensive split is a separate change.
//   - Riposte counters that were themselves avoided are counted (`RiposteView.swings`) but the
//     mob's own riposte AVOIDANCE (`but <mob> ripostes!`) does not exist in 1.35M lines — the
//     annotated counter is the only evidence there is, which is the asymmetry
//     `SourceRoundsView.ripostesTaken` already documents.
// ---------------------------------------------------------------------------

/**
 * YOUR RIPOSTE, both halves, because the log prints them as two different facts and they need
 * not be 1:1 (Double Riposte fires more counters than events).
 *
 * `events` is the DEFENSIVE half — a swing at you that your riposte turned aside (`but YOU
 * riposte!`). `swings`/`hits`/`damage` are the OFFENSIVE half — the free counter-swing that
 * follows, which the game annotates `(Riposte)` on an ordinary weapon damage line.
 */
export interface RiposteView {
  /** `but YOU riposte!` — swings your riposte avoided. */
  events: number
  /** `(Riposte)`-annotated swings of YOURS: landed AND avoided. */
  swings: number
  /** …of those, the ones that landed damage. */
  hits: number
  /**
   * Damage those landed counters dealt. ALREADY INSIDE your melee/slay totals — this is an index
   * over damage already counted, so surfacing it moves nothing and it must never be added to a
   * total beside them.
   */
  damage: number
  /** `damage` as a percentage of your melee + slay damage; 0 when you swung no weapon. */
  pctOfSwingDamage: number
  /** `(Riposte)` counter-swings mobs made AT you — the other end of the same annotation. */
  taken: number
}

/**
 * WHAT HAPPENED TO THE SWINGS AIMED AT YOU in one segment (JOS-354).
 *
 * The denominator is MELEE swing attempts at You and nothing else: landed melee/slay hits on you
 * plus every avoided swing. Spells, DoTs and damage shields are not swings and are excluded, so
 * a caster mob nuking you can never dilute your block rate.
 */
export interface DefenseView {
  /** melee swing attempts aimed at You: `hits + avoidedTotal`. The denominator of every rate. */
  swings: number
  /** …of those, the ones that landed damage on you. */
  hits: number
  /** avoided swings by outcome — the same six buckets a source's `missBreakdown` uses. */
  avoided: MissBreakdown
  /** Σ `avoided`. */
  avoidedTotal: number
  /** `avoidedTotal / swings * 100`; 0 when nothing swung at you. */
  avoidedPct: number
  /**
   * The four ACTIVE defenses — block + parry + dodge + riposte. Separated from the total because
   * a mob's own miss and your rune are not skills of yours, and folding them in would flatter
   * every one of these rates.
   */
  defended: number
  /** `defended / swings * 100`. */
  defendedPct: number
  /** per-outcome rate over `swings`, same keys as `avoided` (so a renderer never re-divides). */
  rates: MissBreakdown
  /** your riposte, both halves. */
  riposte: RiposteView
}

/** A taxonomy-category rollup within a source (Task #51 drill-down level 2). Carries
 *  its own per-skill/per-spell breakdown (level 3). */
export interface CategoryView {
  category: DamageCategory
  total: number
  /** pct of the source's largest category (for the level-2 bar fill). */
  pct: number
  hits: number
  crits: number
  critPct: number
  max: number
  /** Spell resists within this category (spell/dot only; Task #51 v2). 0 for melee/slay/ds. */
  resists: number
  /** resists / (hits + resists) as a percentage; 0 when nothing was cast. */
  resistPct: number
  /** per-skill/per-spell breakdown within this category (capped at 12). */
  skills: SkillView[]
}

/**
 * The melee-"rounds" heuristic (Task #51). The log does NOT record double/triple
 * attack, so a "round" is the HONEST proxy: a source's melee/slay hits sharing the same
 * whole second (and skill). This is a cluster distribution, NOT a fabricated multi-attack
 * flag; main-hand vs off-hand is also not distinguishable in the log. Present only for
 * sources that landed melee/slay hits.
 */
export interface RoundsView {
  /** number of (skill, second) buckets observed. */
  totalRounds: number
  avgHitsPerRound: number
  maxHitsInRound: number
  /** rounds that landed 2+ hits in the same second (multi-attack candidates). */
  multiHitRounds: number
  /** histogram[k-1] = count of rounds that landed exactly k hits. */
  histogram: number[]
}

// ---------------------------------------------------------------------------
// ATTACK-ROUND STATS (docs/plans/attack-round-stats.md) — riposte, flurry and the
// double/triple-attack question, orthogonal to damage.
//
// EVERY NUMBER BELOW IS A COUNT. Not one of them carries or derives from an amount, which is
// what keeps the whole feature inside world-model law 8's tripwire: adding it moved no damage
// total by a single point (proved by a full-log before/after diff, and by the byte-identity
// test in tests/combatRoundStats.test.mts).
// ---------------------------------------------------------------------------

/** One base modifier's tally on a source. `avoided` is the share that landed on nothing. */
export interface ModifierTallyView {
  name: string
  count: number
  avoided: number
}

/**
 * How confidently a lane's multi-swing rate may be read (docs/plans/attack-round-stats.md §2).
 *   'perEvent'  — a REUSE-TIMER skill (backstab, bash, kick, the monk strike lane). One timer,
 *                 one hand: a second swing in the same second cannot be an off-hand, so the
 *                 2x/3x split is per-event meaningful. Still INFERRED — the log never says
 *                 "double attack" — but with no competing explanation.
 *   'aggregate' — a WEAPON verb. Dual wield puts two weapons on one verb, so a same-second 2x
 *                 may be two hands rather than a double attack. The RATE is worth stating;
 *                 a per-event "that was a double attack" label is not, and is never shown.
 */
export type RoundConfidenceView = 'perEvent' | 'aggregate'

/** One verb's round-structure row. */
export interface RoundLaneView {
  /** the un-conjugated verb the lane is keyed on ('slash', 'backstab'). */
  verb: string
  /** display label — the special-attack lane name when the log named one, else the verb. */
  label: string
  rounds: number
  /** buckets[i] = rounds with exactly i+1 swings; the LAST bucket is 4-or-more. */
  buckets: number[]
  /** rounds with 2+ swings. */
  multiRounds: number
  /** multiRounds ÷ rounds as a percentage. */
  multiPct: number
  /** rounds printed against more than one defender — ONE swing fanned, collapsed by the
   *  grouper. Surfaced so the collapse is visible rather than a silent adjustment. */
  fannedRounds: number
  confidence: RoundConfidenceView
}

/**
 * The Rounds panel's whole payload for ONE source. Present only when the source actually swung
 * (or was annotated); absent otherwise, so a spell-only source shows nothing rather than zeroes.
 */
export interface SourceRoundsView {
  /** per-verb rows, ranked by rounds desc. */
  lanes: RoundLaneView[]
  /** Σ lanes[].rounds — the DENOMINATOR every rate here is over, carried so it can be shown
   *  (law 11's spirit: a rate without its exposure is a lie). Rounds, never swings. */
  primaryRounds: number
  /** swings deliberately kept OUT of round counting, by reason (see rounds.ts). */
  excluded: { frenzy: number; riposte: number; flurry: number; rampage: number }
  /** every base modifier this source's lines carried, ranked by count desc. */
  modifiers: ModifierTallyView[]
  /**
   * `(Riposte)` counter-swings THIS SOURCE made — i.e. how often it riposted someone.
   * Equals the source's own Riposte modifier tally.
   */
  ripostesGiven: number
  /** …of those, how many LANDED (the rest were avoided). `ripostesGiven - riposteLanded` is the
   *  count that whiffed, which is why neither is derivable from the other alone. */
  riposteLanded: number
  /**
   * Damage those landed counter-swings dealt (JOS-354). An INDEX over damage the source's melee
   * and slay lanes have already counted — it is inside `SourceView.total`, never beside it — so
   * it moves no total and must never be summed with one. Amount-free everywhere else in this
   * block; this is the single exception and it is a re-reading, not a measurement.
   */
  riposteDamage: number
  /**
   * `(Riposte)` counter-swings made AT you — the mobs' annotated counters, summed over the
   * segment's incoming rows. Present on the 'you' row only, and 0 elsewhere: an incoming line's
   * defender is You by construction of the engine's attribution.
   *
   * THE ASYMMETRY IS REAL AND THE UI MUST STATE IT. A mob riposting YOUR swing prints NO
   * avoidance line — `You try to hit <mob>, but <mob> ripostes!` occurs ZERO times in 1.35M
   * lines — so the mob's annotated counter-swing is the only evidence there is. And Double
   * Riposte means counters need not be 1:1 with riposte EVENTS.
   */
  ripostesTaken: number
  /** `(Rampage)` swings taken. Outgoing rampage is UNKNOWABLE, not omitted: the player's own
   *  Rampage AA swings log unannotated (law 6), so there is deliberately no "given" twin. */
  rampagesTaken: number
  /** `(Flurry)` annotated swings by this source — landed AND avoided. */
  flurries: number
  /** flurries ÷ primaryRounds as a percentage; 0 when there were no rounds. */
  flurryPct: number
}

export interface SourceView {
  id: string
  name: string
  kind: SourceKind
  total: number
  dps: number
  pct: number
  hits: number
  crits: number
  critPct: number
  /** Hits attributed to this pet that were name-ambiguous (charmed twin vs its
   *  same-named hostile twin). Surfaced as a "~" badge in the UI. */
  ambiguousHits: number
  /** Damage total from those ambiguous hits. */
  ambiguousTotal: number
  /** Avoided swings attributed to this source (all outcomes). */
  misses: number
  /** hits / (hits + misses) as a percentage; 100 when no swings avoided. */
  hitPct: number
  /** Avoided-swing breakdown by outcome (for tooltip / expanded row). */
  missBreakdown: MissBreakdown
  /** Total spell resists against this source's detrimental spells (Task #51 v2). */
  resists: number
  /** resists / (spell+dot hits + resists) as a percentage; 0 when no spells cast. */
  resistPct: number
  skills: SkillView[]
  /** Per-category rollup (Task #51 drill-down level 2 → 3). Ordered by CATEGORY_ORDER. */
  categories: CategoryView[]
  /** Melee-rounds heuristic (Task #51); undefined for sources with no melee/slay hits. */
  rounds?: RoundsView
  /**
   * ATTACK-ROUND STATS — the Rounds panel's payload (see SourceRoundsView). Absent for a
   * source that never swung and was never annotated. Deliberately BESIDE `rounds` rather than
   * replacing it: the old field is a same-second cluster over LANDED hits with no target
   * grouping and no exclusions, it is on the wire, and other surfaces still read it.
   */
  roundStats?: SourceRoundsView
}

export interface SegmentView {
  id: string
  kind: 'fight' | 'zone'
  name: string
  zone?: string
  durationSec: number
  active: boolean
  /** Sum of active combat time (gaps between consecutive attributed damage hits
   *  capped at 3s each — standard meter convention), in seconds. ≤ durationSec. */
  activeSec: number
  outTotal: number
  outDps: number
  /** Outgoing damage ÷ activeSec — DPS while actually swinging (excludes idle gaps). */
  activeDps: number
  entities: SourceView[]
  inTotal: number
  inDps: number
  incoming: SourceView[]
  /**
   * YOUR DEFENSE against everything in `incoming` (JOS-354). On the SEGMENT rather than on a
   * source row because it is one fact about YOU read off many mobs' rows: the engine books an
   * avoided swing on the mob that swung it, and "how often did I block" is that same evidence
   * summed from the other end — exactly the shape `SourceRoundsView.ripostesTaken` already has.
   */
  defense: DefenseView
  /** Total healing received by engaged HOSTILE instances in this segment
   *  (self-heals + heals cast on them) — "effective DPS" context. */
  enemyHealTotal: number
  /** Total healing received by You (and your pets) in this segment. */
  incomingHealTotal: number
  /** Top healers of You/your pets, sorted desc by amount. */
  incomingHealers: HealerView[]
  /**
   * The HEALING meter for this segment (Task #59) — the full per-healer / per-spell breakdown
   * plus the absorption lanes, built from the SAME aggregate as the damage bars so the healing
   * overlays inherit fight/zone-session selection for free.
   */
  healing: HealingView
  /**
   * ROGUE-POISON / PROC ledger for this segment (Task #64). Folded on ingest into the same
   * `Agg` the damage bars come from, so it is exact for zone sessions too (no event ring
   * involved) — the timeline MARKERS are the only ring-derived half of this feature, and they
   * are for drawing, never for counting.
   */
  procs: ProcsView
}

// ---------------------------------------------------------------------------
// ROGUE POISONS (Task #64). The catalog + the message tables live in shared/logEvents.ts;
// these are the SHAPES the engine hands the UI.
// ---------------------------------------------------------------------------

/**
 * One counted lane in the Procs tab. `total` is present only for lanes that carry damage
 * (the poison-damage lanes); a proc emote has no amount and must never be given one.
 * `ambiguous` marks a lane whose NAME the log could not pin down — two Strikes share an emote
 * ("screams as poison burns their veins!" is Asp Venom Strike OR Cobra Venom Strike), and a
 * dispel landing is shared across the whole Cancel Magic family. The count is exact either
 * way; only the label is uncertain, and the UI says so with the app's `~` treatment.
 */
export interface ProcLane {
  name: string
  count: number
  total?: number
  ambiguous?: boolean
}

/** One coated poison and when it went on. */
export interface CoatSlot {
  /** DB spell name, or 'unknown' when the line refused to name it. */
  poison: string
  /** epoch ms of the coat line. */
  sinceTs: number
}

/**
 * The player's blade coats (Task #64). FOUR concurrent coats — three combat venoms plus one
 * utility poison — because that is what the game has (wiki, Rogue page): combat venoms stack
 * across their three mutually-exclusive LINES, utility poisons all share one slot. Modeling it
 * as one "current poison" would have made four of the five procs in the user's own log
 * impossible — see the block comment in shared/poisons.ts.
 *
 * EVERY consumer must render ALL of them. The header pill showed only `utility` until
 * 2026-08-04, which meant a rogue running the usual asp + siphoning + stunning with no utility
 * poison on saw NOTHING at all in the passive readout.
 */
export interface BladeCoatState {
  /** The ONE active utility poison, if any. */
  utility?: CoatSlot
  /** Active combat venoms, in the order they were coated. At most one per venom line (3). */
  combat: CoatSlot[]
}

/**
 * ROLLING TIME-TO-SLOW (Task #64) — "how long does it take to land slow when I have the right
 * poison on".
 *
 * THE DENOMINATOR IS THE WHOLE POINT (law 5). A pull only enters this rollup when a
 * SLOW-CAPABLE utility poison was already coated at the moment the pull opened; those are the
 * only pulls where "time to slow" is a question the game was even being asked. Of those,
 * `landed` are averaged and `noLand` are NOT — a fight that never slowed is reported as its
 * own number, never folded in as a zero (which would drag the mean toward a lie) and never
 * dropped (which would flatter it).
 */
export interface SlowRollup {
  /** Pulls that opened with a slow-capable coat active — the honest denominator. */
  pulls: number
  /** Of those, the ones where a slow actually landed. Only these feed the statistics. */
  landed: number
  /** `pulls - landed`: qualifying pulls that ended with no slow. Reported, never averaged. */
  noLand: number
  /** Mean ms from engage to the FIRST slow landing, over `landed` only. Absent when none. */
  avgMs?: number
  /** Median of the same samples — a single 8-minute grind shouldn't set the headline. */
  medianMs?: number
  minMs?: number
  maxMs?: number
  /** How many recent qualifying pulls the ring keeps; `pulls` saturates here. */
  window: number
}

/** Blade coats + the rolling slow measurement, for the header and the aggregate line. */
export interface PoisonState {
  coat: BladeCoatState
  slow: SlowRollup
}

/**
 * The per-segment proc ledger (Task #64). Everything here is folded on ingest from the
 * authoritative event stream — nothing reads the timeline ring — so a downsampled or
 * truncated fight still reports exact counts.
 */
export interface ProcsView {
  /** The utility coat that was already on when this segment opened. */
  coatAtEngage?: CoatSlot
  /** Combat venoms already on when this segment opened. */
  combatAtEngage: CoatSlot[]
  /** True when `coatAtEngage` grants Weakening Strike — i.e. a slow was actually possible. */
  slowExpected: boolean
  /** Coats applied DURING the segment (yours only), as ms since segment start. */
  coats: { poison: string; tMs: number }[]
  /** Rogue-poison Strike procs that landed, by Strike name. */
  strikes: ProcLane[]
  strikeCount: number
  /** Weakening-Strike landings (the slow) in this segment. */
  slowLands: number
  /**
   * ms from the segment's start to the FIRST slow landing. Absent when none landed — which,
   * combined with `slowExpected`, is the difference between "not landed yet" and "no slow
   * poison was on". The UI must not collapse those two.
   */
  slowLandMs?: number
  /** Outgoing damage lanes whose damage TYPE was poison (`dclass === 'poison'`). */
  poisonDamage: ProcLane[]
  poisonDamageTotal: number
  /**
   * DISPEL LANDINGS on the mobs engaged in this segment, one lane per message tier — the
   * "counts of spells (like the dispel variants and such)" ask. Sourced from the
   * message-driven landing stream (so a lane exists only because the game printed that
   * spell's own landing line) and gated to DISPEL_FAMILY.
   *
   * IT NAMES NO CASTER, and every lane is `ambiguous`: `<mob> feels a bit dispelled.` is the
   * Cancel Magic family's message, available to eleven classes plus NPCs. It is emphatically
   * NOT evidence of your rogue dispel — that proc prints `'s blessings wither!` and lands in
   * `strikes` instead. The UI labels this section accordingly.
   */
  dispels: ProcLane[]
  dispelCount: number
  /** Stance / invocation commits inside this segment. */
  stanceSwitches: number
  invocationSwitches: number

  // ---- PROC ANALYTICS (docs/plans/proc-analytics.md). ADDITIVE ONLY. -------------------
  // The shipped `strikes` / `poisonDamage` / `dispels` arrays above are UNCHANGED and stay the
  // poison tab's source; everything below is a SUPERSET view over the same ingest-folded
  // counters. Optional while the serialization wave lands, so the tree stays buildable and no
  // existing consumer (ProcsBody, formatProcsText, the overlays, the golden tests) has to
  // change to keep compiling.

  /** Every proc lane — poison Strikes, cast-less spell effects, Slay Undead — with the three
   *  rate denominators and Tier-A (measured) attribution. */
  lanes?: ProcLaneView[]
  /** All lanes together: the "procs per minute" headline. */
  overall?: ProcRateView
  /** Active-state spans overlapping this segment, for the ledger and the link joins. Each
   *  carries evidence on BOTH edges — a span end is almost never printed by the game. */
  states?: StateSpan[]
  /**
   * WHICH DAMAGE ROWS ARE PROCS (docs/plans/proc-visibility.md §2). One entry per (skill row,
   * lane) pair, so the drill can annotate a row with the rate the ledger already counted.
   *
   * A row is here because a LANE covers it — the join runs in main against the poison roster
   * and the cast-less detector (see `ProcSkillTag`). A skill with no lane is simply absent, and
   * the drill shows nothing rather than a guess. Note the asymmetry that follows from the log:
   * a lane whose Strike deals no damage (Weakening Strike — a slow) has no damage row to
   * annotate, so it appears in the ledger and NOT here. That is the honest answer, not a gap.
   */
  procSkills?: ProcSkillTag[]
  /** TIER B, the counterfactual. Present only for a ZONE-session selection: a single fight has
   *  no inactive sample, and offering a per-fight counterfactual would be an invitation to read
   *  noise as an effect. */
  attribution?: AttributionReport
}

/** A source of incoming healing (to You / your pet), for the incoming section. */
export interface HealerView {
  name: string
  total: number
  count: number
}

// ---------------------------------------------------------------------------
// HEALING model (Task #59)
//
// What the log actually supports (verified sweep of eqlog_Primitive_freeport.txt, 2026-08-02):
//   - 16,680 `<healer> healed <target> for N[ (M)] hit points[ by <Spell>].` lines. 16,198 name a
//     spell; the rest are spell-less. 233 additionally carry a trailing `(Critical)`.
//   - The `(M)` form IS the overheal record: M is the RAW heal, N the EFFECTIVE one, and EQ omits
//     the parens whenever nothing was wasted (3,016 paren lines, N < M on every single one). So
//     `overheal = M − N` is DERIVED, never guessed, and it is 0 by construction on a plain line.
//     1,857 of those landed on a full health bar (N = 0) — a fully-wasted cast.
//   - HoTs are NOT distinguishable. There is no `healed over time` / `regeneration` line family
//     anywhere in the log; a regen tick (e.g. Blessing of the Squire, 706 lines of "healed
//     himself for 2") is byte-identical in shape to a direct heal. So this model does NOT split
//     direct vs HoT — it would be an invention (AGENTS.md world-model law 6).
//   - Overheal is only knowable per-line. A healer's `overheal` therefore sums only the ticks
//     whose line carried the raw amount; it is a FLOOR, never a rate over unknown ticks.
// ---------------------------------------------------------------------------

/** Who a heal came from. Deliberately its own union — a healing meter has an ALLY lane that the
 *  damage model's SourceKind ('you'|'pet'|'enemy') has no room for. */
export type HealSourceKind = 'you' | 'pet' | 'other' | 'enemy'

/**
 * What a number in the healing ledger MEANS. Both live in the same ledger, the same ranked drill
 * list and the same total, but they are never the same claim — so every LANE carries this and
 * the UI must label it:
 *   - 'restored' — hit points actually put back on a health bar. A heal line said so.
 *   - 'absorbed' — absorption GRANTED by a rune. Counted as effective sustain on the assumption
 *     that the shield gets consumed; the log records the grant, never the consumption. That
 *     assumption is why this classification exists and why it is never silently merged away.
 *   - 'unstated' — a heal the log ANNOUNCED and never VALUED (JOS-86; the monk's Mend, whose
 *     whole sentence is `You mend your wounds and heal some damage.`). Hit points really went
 *     back on the bar; the game does not say how many. So the lane's `total` is 0 and that 0 is
 *     NOT a measurement — it is the absence of one, which is precisely why the lane needs a
 *     classification of its own rather than a `restored` row reading zero. An 'unstated' lane
 *     contributes nothing to any sum anywhere (row total, view total, hps, overheal) and its
 *     `count` is the only real figure it carries. The UI must say "amount not stated"; it must
 *     never print "0 healing", and no average may be derived from it.
 * Keeping it on the wire is deliberate: a future UI can split the meter apart again — and a
 * future model could split ABSORPTION ITSELF by source — without any change here.
 */
export type HealClassification = 'restored' | 'absorbed' | 'unstated'

/**
 * One lane inside a healer's drill-down — a heal spell, or the absorption lane. They share one
 * FLAT ranked list on purpose: a grouping level (heals here, absorption there) is exactly what
 * hid the flat breakdown in the damage drill-down, so the drill is
 * `Lay on Hands VI · Lay on Hands V · Center · Rune` ranked by amount, with `classification`
 * (not position) telling the two kinds apart.
 */
export interface HealSpellView {
  /** Display spell name, 'Unspecified' when the line named no spell, 'Rune' for absorption, or
   *  the SKILL name ('Mend') on an 'unstated' lane. */
  name: string
  /** Effective healing (what actually landed on a health bar). Always 0 on an 'unstated' lane,
   *  where it means "no amount exists", not "no healing happened" — see HealClassification. */
  total: number
  /** pct of the healer's largest spell lane (drives the bar fill). */
  pct: number
  /** Number of heal lines on this lane (HoT ticks included — the log cannot separate them). */
  count: number
  /** Critical heals on this lane. */
  crits: number
  /** Largest single EFFECTIVE heal. */
  max: number
  /** Smallest EFFECTIVE heal. Absent when every tick landed for the same amount. */
  min?: number
  /**
   * Wasted healing summed from the `(M)` lines only: Σ(raw − effective). A plain line contributes
   * 0 because EQ omits the parens exactly when nothing was wasted. A FLOOR, not an estimate.
   */
  overheal: number
  /** Ticks that landed entirely on a full health bar (effective 0). */
  fullOverheal: number
  /** 'restored' on every valued heal lane; 'absorbed' on the rune lane; 'unstated' on a lane
   *  whose lines announced a heal without an amount (Mend). Neither of the latter two has an
   *  overheal by construction — a rune that is never consumed simply expires, and a heal with no
   *  amount cannot have a waste — and the log does not say, so none is invented. */
  classification: HealClassification
}

/**
 * One healer row on the meter (level 1), with its flat lane breakdown (level 2).
 *
 * A row can be MIXED (the self row carries both your heals and your rune absorption), so the row
 * has no single classification — it has a split total instead. Its other headline stats (count,
 * crits, max, min, overheal, overhealPct) describe RESTORED healing ONLY: folding rune grants
 * into "6 heals · max 428" would be an aggregate that lies (AGENTS.md law 5).
 */
export interface HealSourceView {
  /** Stable row id: 'you' | 'heal:<healerKey>'. */
  id: string
  name: string
  kind: HealSourceKind
  /** The row's ranking figure: restored healing + granted absorption. */
  total: number
  /** How much of `total` is absorption (0 on a pure healer). `total − absorbedTotal` is the
   *  restored half. Never fabricated: only rune grants have amounts. */
  absorbedTotal: number
  /** total ÷ segment duration — sustain per second. */
  hps: number
  /** pct of the largest row's total (bar fill). */
  pct: number
  /** VALUED heal lines only — a rune grant is not a heal, and an amount-less heal has no figure
   *  to average or bound, so neither is counted here (see `unstatedCount`). Every other headline
   *  stat on this row (crits, max, min, overheal) shares this denominator, which is the whole
   *  reason the split exists: folding a Mend in would deflate critPct against a line that could
   *  not have been a crit. */
  count: number
  /** Lines on this row's 'unstated' lanes — heals the log announced without an amount (Mend).
   *  A COUNT and nothing more: it enters `total`, `hps`, `max`, `min` and `overheal` nowhere.
   *  0 on every row that has none, which today is every row but your own. */
  unstatedCount: number
  crits: number
  critPct: number
  /** Largest / smallest single EFFECTIVE heal. Absorption never enters these. */
  max: number
  min?: number
  overheal: number
  /** overheal ÷ (restored + overheal) as a percentage — absorption is deliberately NOT in the
   *  denominator, which would silently deflate a healer's overheal rate. */
  overhealPct: number
  fullOverheal: number
  /** ONE flat list, ranked by amount desc: heal lanes and the absorption lane together. */
  spells: HealSpellView[]
}

/**
 * The RAW absorption counters, kept intact as their own object even though the rune lane is now
 * also folded into the healing ledger as an 'absorbed' drill lane. This is the un-aggregated
 * truth — a future UI can split absorption back out with no model change — and it is the ONLY
 * home of the two count-only families, which have no amount to sum and so appear in no total.
 */
export interface MitigationView {
  /** Σ of `You gain a rune for N points of absorption.` — absorption GRANTED. The log never
   *  records how much of a rune was actually consumed, so this is not "damage prevented".
   *  Mirrored by the 'Rune' lane on the self row (same numbers, classified 'absorbed').
   *  ONE lane, not two: the gain line names no source and the enchanter-rune landing message
   *  never appears in this log — see the verified sweep in src/main/combat/healing.ts. */
  runeTotal: number
  runeCount: number
  runeMax: number
  /** Smallest rune grant; absent when none were seen. */
  runeMin?: number
  /** `… but YOUR magical skin absorbs the blow!` — swings fully absorbed. COUNT ONLY: the log
   *  carries no amount for these, so the UI must show a count and never a fabricated total. */
  absorbedSwings: number
  /** `YOUR magical skin absorbs the damage of <mob>'s thorns.` — incoming damage-shield ticks
   *  absorbed. COUNT ONLY, same rule. */
  absorbedDamageShields: number
}

/**
 * The healing meter for one segment.
 *
 * ABSORPTION IS IN THE LEDGER. Rune grants are a lane on the SELF row and count toward `total` /
 * `hps`, because a shield is sustain the same way a heal is — but it is an ASSUMPTION (the log
 * records absorption granted, never consumed), so the classification travels with the number and
 * the UI labels it. The two count-only absorption families (absorbed swings, absorbed
 * damage-shield ticks) carry no amount in the log and are therefore in NO total — they stay
 * counts under `mitigation`.
 */
export interface HealingView {
  /** Healers of You / your pets, ranked by total desc. The self row also carries absorption. */
  healers: HealSourceView[]
  /** Σ healers[].total — restored hit points AND granted absorption. */
  total: number
  /** total ÷ segment duration. */
  hps: number
  /** Σ of the 'restored' rows: hit points actually put back. */
  restoredTotal: number
  /** Σ of the 'absorbed' rows: absorption granted. `restoredTotal + absorbedTotal == total`. */
  absorbedTotal: number
  /** Σ healers[].overheal (a floor — see HealSpellView.overheal). Absorption contributes 0:
   *  a rune has no overheal and one is never fabricated for it. */
  overheal: number
  /** Healers of engaged HOSTILE instances (counter-healing that undid your damage). */
  enemyHealers: HealSourceView[]
  /** Σ enemyHealers[].total. Matches SegmentView.enemyHealTotal. */
  enemyTotal: number
  mitigation: MitigationView
}

export interface SegmentSummary {
  id: string
  kind: 'fight' | 'zone' | 'current'
  name: string
  /**
   * The zone this segment happened in (raw display name, Task #61). Stamped from the
   * engine's current zone when the encounter OPENS — the same source the zone sessions use
   * — and frozen into the memoized summary at finalize. Absent when no `You have entered X.`
   * line had been seen yet (a session that starts mid-zone), which the log genuinely cannot
   * answer. It is what makes fight search reach zone names ("freprot" → fights in Freeport).
   */
  zone?: string
  durationSec: number
  total: number
  dps: number
  /** Active combat time (capped-gap sum) in seconds; ≤ durationSec. */
  activeSec: number
  /** total ÷ activeSec — active-time DPS. */
  activeDps: number
  startTs: number
  active: boolean
  /** Healing received by hostile instances during this segment (annotation). */
  enemyHealTotal: number
}

/**
 * One ranked fight-search result (Task #61). Carries the WHOLE summary, not just an id: the
 * result list has to render (name, zone, duration, dps, when) without a second round trip,
 * and a hit may be a fight far outside the snapshot's `maxSegments` window — so the summary
 * would otherwise be unreachable from the renderer.
 */
export interface FightSearchHit {
  summary: SegmentSummary
  /** 0..1 relevance. Exact token matches outrank prefix, prefix substring, substring typo. */
  score: number
}

/** The result of one fight-history search (Task #61). */
export interface FightSearchResult {
  /** Ranked hits, best first; ties broken by recency (newer first). Capped by the request's
   *  `limit`. Empty for an empty/whitespace query — the UI shows its browse list instead. */
  hits: FightSearchHit[]
  /** How many fights were SEARCHED (the whole uncapped history + the live fight). Lets the
   *  UI say "12 of 1,428" honestly instead of implying the corpus is the result set. */
  corpus: number
}

/** One line as the engine classified it, for the live processing log. */
export interface ClassifiedLine {
  ts: number
  /** melee | spell | dot | ds | charm | pet | uncharm | death | zone | unparsed
   *  ('charm' = a `<mob> has been charmed.` line; 'pet' = a SUMMONED pet's
   *  owner-only "… Master." claim tell — the two are never conflated). */
  cat: string
  /** Who it was attributed to. The four SOURCE kinds plus the two commentary roles: 'info' for
   *  a state transition the engine narrates and 'dropped' for a line it deliberately refused. */
  role: SourceKind | 'info' | 'dropped'
  text: string
}

/** The player's current combat-modifier pair (Task #51). Two mutually-exclusive groups
 *  the parser tracks: a melee/general STANCE and a caster INVOCATION. Either may be
 *  undefined if never observed this session. Shown as two chips near the meter header. */
export interface StanceState {
  /** current stance name (lowercased canonical), or undefined if none seen yet. */
  stance?: string
  /** ts of the last stance change. */
  stanceTs?: number
  /** current invocation name, or undefined. */
  invocation?: string
  /** ts of the last invocation change. */
  invocationTs?: number
}

/**
 * One event on the selected-encounter TIMELINE (Task #51). A timestamped, categorized
 * instant used to render the WarcraftLogs-style timeline (skills on the Y axis, time on
 * X). Kept small + capped (the engine downsamples an encounter's ring when it exceeds a
 * budget). `t` is ms since the encounter start (so the renderer needn't know absolute ts).
 */
export interface TimelineEvent {
  /** ms since encounter start. */
  t: number
  /** row label = the skill/spell/element name (the Y-axis lane). */
  lane: string
  /** taxonomy category (drives color + which section the lane sorts into). */
  category: DamageCategory
  /** damage amount (0 for a miss/resist tick). */
  amount: number
  /** true when this instant was a crit. */
  crit: boolean
  /** parsed modifiers (Riposte/Finishing Blow/…) for the tooltip. */
  modifiers?: string[]
  /** 'you' | 'pet' | 'enemy' — who produced it (color/opacity hint). */
  kind: SourceKind
  /**
   * Event flavor (Task #51 v2). 'hit' = landed damage (default). 'miss' = an avoided
   * melee swing (dodge/parry/riposte/block/absorb/miss). 'resist' = a fully-resisted
   * spell. Miss/resist ticks render as hollow/red-tinted marks in the ability's lane.
   */
  outcome?: 'hit' | 'miss' | 'resist'
  /** the specific miss outcome (dodge/parry/…) or resist detail, for the tooltip. */
  detail?: string
  /** the target / defender name, for the tooltip. */
  target?: string
}

/**
 * A point-in-time ANNOTATION on the fight's clock (Task #64) — a stance/invocation commit, a
 * blade coat, a slow landing. Markers are NOT damage: they carry no amount, they are not
 * lanes, and they live in their own array precisely so nothing that walks `events` (the DPS
 * curve, per-mob grouping, lane totals, the downsampler) has to learn about them.
 *
 * THEY ARE NEVER DOWNSAMPLED. `events` is uniform-strided when a fight outgrows the render
 * budget, which for a sparse series would mean silently dropping most of it — a chart that
 * shows 1 of 5 coats is worse than one that shows none. Markers are sparse by construction
 * (the densest fight in the user's whole log carries three), so they are all carried, with a
 * generous drop-oldest cap purely as a memory bound. No COUNT is ever derived from them:
 * every number in `ProcsView` is folded on ingest from the aggregate instead.
 */
export type TimelineMarkerKind = 'stance' | 'invocation' | 'coat' | 'slow'

export interface TimelineMarker {
  /** ms since encounter start. */
  t: number
  kind: TimelineMarkerKind
  /** the stance/invocation/poison name, or the slowed mob. */
  label: string
  /** secondary text for the tooltip (e.g. the mob a slow landed on). */
  detail?: string
}

/** A span during which a stance/invocation was active (Task #51 timeline pinned rows). */
export interface StanceSpan {
  /** 'stance' | 'invocation' — which pinned lane. */
  group: 'stance' | 'invocation'
  /** the stance/invocation name. */
  name: string
  /** ms since encounter start when it became active (clamped to ≥0). */
  start: number
  /** ms since encounter start when it ended (the encounter end if still active). */
  end: number
}

/**
 * The selected encounter's event timeline (Task #51). Returned only when
 * SnapshotOpts.timeline is set (payload is heavier than the bar view).
 *
 * TWO independent losses can stand between a fight and this view, and BOTH are declared
 * here (law 1 — anything inferred/partial is LABELED, never silently understated):
 *
 *   downsampled — the retained ring was over the serialization budget, so only every
 *                 Nth instant is carried. A uniform stride, so scaling by
 *                 `rawCount / events.length` is an unbiased estimate OF THE RING.
 *   truncated   — the per-encounter ring itself overflowed its drop-OLDEST cap, so the
 *                 ring is only the most recent slice of the fight. This is NOT a
 *                 uniform sample: everything derived from it is a LOWER BOUND on the
 *                 whole fight and must never be extrapolated (see `totalCount`).
 *
 * Neither loss ever touches the engine's aggregates: the meter/`SegmentView` totals are
 * folded on ingest, entirely independently of this ring.
 */
export interface TimelineView {
  /** the encounter id this timeline is for. */
  id: string
  name: string
  /**
   * Epoch ms of the encounter's start — the absolute clock `t: 0` stands for. DISPLAY ONLY:
   * every other time in this view stays relative (the renderer needn't know absolute ts), and
   * nothing derives from this. It exists so a hover readout can say what time of day an instant
   * happened without threading the segment's start through three components. Not persisted.
   */
  startTs: number
  /** encounter duration in ms (X-axis extent). */
  durationMs: number
  /** ordered lane labels (Y axis), grouped by category then by total desc. */
  lanes: { lane: string; category: DamageCategory; total: number; kind: SourceKind }[]
  /** timestamped instants (relative ms). */
  events: TimelineEvent[]
  /** pinned stance/invocation spans (rendered above the skill lanes). */
  stanceSpans: StanceSpan[]
  /** point annotations (stance/invocation commits, blade coats, slow landings) — see
   *  TimelineMarker: never downsampled, never counted from. */
  markers: TimelineMarker[]
  /** true when the raw event count exceeded the budget and was downsampled. */
  downsampled: boolean
  /**
   * How many instants the RING still held when this view was built — i.e. the population
   * `events` was sampled from, and therefore the ONLY honest denominator of the sampling
   * factor (`rawCount / events.length`). Deliberately NOT the fight's true instant count:
   * using `totalCount` there would silently extrapolate the dropped-oldest prefix from the
   * retained tail. Equals `totalCount` unless `truncated`.
   */
  rawCount: number
  /**
   * The TRUE number of instants this encounter ever recorded, independent of ring
   * occupancy (one counter per encounter, no per-event bookkeeping). This is the number a
   * "showing N of M events" note must quote — quoting `rawCount` once the ring has
   * overflowed understates the fight without saying so.
   */
  totalCount: number
  /**
   * true when the ring overflowed its drop-oldest cap and the fight's OLDEST instants were
   * discarded (`totalCount > rawCount`). Every event-derived number is then a lower bound
   * over the retained window, not an estimate of the whole fight; consumers label it with
   * the same `~` + explainer treatment as `downsampled`.
   */
  truncated: boolean
}

/**
 * One finalized-or-live ZONE SESSION (Task #54). Instead of discarding the zone aggregate on
 * every zone change, the engine FINALIZES it into a capped history so you can re-select a past
 * zone's overall meter. The live zone session is always index 0 (id 'zone'); finalized ones get
 * stable ids ('zs<n>'). Carries just the summary fields the selector needs; the full breakdown
 * is rebuilt on demand via buildSelected(id).
 */
export interface ZoneSessionSummary {
  /** 'zone' for the live session, else 'zs<n>' for a finalized one. */
  id: string
  /** zone display name (raw). */
  zone: string
  /** epoch ms of the first attributed damage in this zone session (0 if none / live-unstarted). */
  startTs: number
  /** epoch ms of the last attributed damage; 0 for the still-live session. */
  endTs: number
  /** total outgoing damage this zone session. */
  total: number
  /** wall-clock DPS over the session's combat span. */
  dps: number
  /** true for the currently-active (live) zone session. */
  live: boolean
  /**
   * WHAT ENDED IT (JOS-322): `'zone'` — you walked out of the room — or `'mark'` — you pressed the
   * app-wide "New session". ABSENT on the live entry, which has not ended at all.
   *
   * It decides ONE thing on this side of the wire: the WORD the picker calls the row by (`overall`
   * for a stay the world ended, `session` for one you did). The reversibility it also encodes is an
   * engine-side property and deliberately has no control here — see `CombatEngine.unsplit`.
   */
  closedBy?: 'zone' | 'mark'
}

/**
 * The mob you are presently swinging at — the LIVE half of world-model law 6's fight
 * naming rule, exposed as a FACT rather than as the composed encounter name.
 *
 * Present only while an encounter is OPEN and at least one outgoing hit has landed in it
 * (`Encounter.lastOutTarget` is undefined before the first one). It is deliberately not
 * derived from `SegmentSummary.name`: that string is `<target>+N`, and a mob lookup needs
 * the raw name (law 2 — canonicalize at boundaries, display raw).
 */
export interface CurrentTarget {
  /** RAW display name of the most recent outgoing-damage target. */
  name: string
  /**
   * How many OTHER distinct targets this encounter has engaged (the name's '+N'). Counted
   * over the encounter's OUTGOING damage targets, exactly as `encounterName()`'s suffix is —
   * so a mob that has only hit YOU is not among them until you swing back at it.
   */
  others: number
  /** epoch ms of the encounter's last attributed damage — freshness for the UI's wording. */
  lastTs: number
}

/**
 * THE PET NUDGE (JOS-258) — present ONLY while the meter wants to say one sentence about a pet it
 * cannot see, and absent in every other state.
 *
 * The engine arms this on the player's own pet-summon cast and clears it the moment any of the
 * three petClaims.ts routes binds a pet; if none does, it draws for a fixed span and then times
 * out on its own. The owner's ruling is that staleness and repetition are the failure modes here,
 * so ABSENCE is the normal value and the renderer has no dismiss state of its own to keep: it
 * renders exactly what the field says, poll by poll.
 */
export interface PetSummonNudge {
  /** epoch ms of the `You begin casting <a pet summon>.` line that armed it. */
  summonedTs: number
  /** epoch ms at which it stops being shown. Carried so the UI can say nothing about a nudge whose
   *  window closed between two polls, without re-deriving the engine's constants. */
  expiresTs: number
}

export interface CombatSnapshot {
  selectedId: string
  selected: SegmentView | null
  segments: SegmentSummary[]
  inCombat: boolean
  zone?: string
  // NOTE: there is deliberately NO pet/charm roster here. The engine's pet-name set is an
  // ATTRIBUTION set (charmed AND summoned pets both attribute as "your pet"), so exposing it
  // as "charmed" mislabelled every summoned class pet. Pets are already visible where they
  // matter — as `kind: 'pet'` source rows on the meter. If a genuinely-charmed roster is ever
  // needed, derive it from the world model (Instance.petKind === 'charmed'), never from the
  // attribution set.
  /** recent classified lines, oldest→newest */
  recent: ClassifiedLine[]
  /** current stance + invocation pair (Task #51). */
  stance: StanceState
  /**
   * The mob in front of you, while a fight is open. Absent between pulls (law 1) and absent
   * inside an open fight that has not yet landed an outgoing hit (a pull that opened on the
   * mob hitting YOU first) — never a guess, and never the FINALIZED largest-target rule.
   */
  currentTarget?: CurrentTarget
  /** blade coats + the rolling time-to-slow measurement (Task #64). */
  poison: PoisonState
  /** the selected encounter's timeline — present only when SnapshotOpts.timeline is set. */
  timeline?: TimelineView | null
  /** zone-session list (Task #54): the live zone + capped finalized-zone history, newest-first
   *  after the live one. Drives the ZONE selector in the main view + the 'overall' overlay. */
  zoneSessions: ZoneSessionSummary[]
  /**
   * HYDRATION (Task #56): true while the engine is still folding the historical scan
   * (`live:false` replay) and false once the Tailer's live handoff happens. Every snapshot
   * taken during the replay describes a HISTORICAL moment — an encounter from hours ago is
   * `current` and looks live. The UI must render a quiet loading state instead of that
   * churning fake-live meter; this is the only honest signal for it.
   */
  hydrating: boolean
  /**
   * WHO YOU ARE GROUPED WITH right now (docs/plans/group-model.md). Carried on the combat
   * snapshot rather than reached through the module transport because BOTH meter surfaces need
   * it — the Combat tab and every overlay — and the overlay windows already poll this. One
   * roster, read in one call, so the scope chip and the rows it filters can never disagree.
   *
   * `roster.seen: false` means NO GROUP SIGNAL HAS BEEN OBSERVED, which is not the same as
   * "you are solo": it is the state in which the Group scope falls back to Everyone rather than
   * silently hiding people (law 1 — unknown must not hide).
   */
  roster: RosterSnap
  /**
   * THE ONE-SENTENCE COACHING NUDGE for a summoned pet nothing has bound yet (JOS-258). Absent
   * almost always — see PetSummonNudge. It is deliberately NOT a revival of the deleted
   * `petClaims` field below: that one asked the user a QUESTION about an entity and acted on the
   * answer, which is the detector JOS-49 cut. This states a fact about the game's own log and asks
   * for nothing; the meter learns the pet only through the same three routes it always did.
   */
  petNudge?: PetSummonNudge
  // NOTE: there is deliberately NO `petClaims` here any more (JOS-49). The snapshot used to carry
  // "IS THIS THING YOURS?" — unbound pet-shaped entities for the meter to ask about, plus the
  // names the user had claimed. The owner cut the question: "if you just have to pet attack once,
  // this is a lot of work we can get wrong." A pet ordered once sends the private tell, the tell
  // binds it, and its rows are ordinary `kind: 'pet'` sources like any other pet's.
  // NOTE: there is deliberately NO `liveFallback` here any more. Fight vs Overall is an explicit
  // user-chosen SCOPE (renderer-side), not an automatic switch: the default selection resolves to
  // the open fight, else the most recent finalized fight, and NEVER to the zone aggregate. The
  // renderer tells "current" from "last" by looking for a `kind: 'current'` entry in `segments`
  // and labels the row accordingly, so no extra flag is needed.
}

export interface SnapshotOpts {
  // NOTE: there is deliberately NO `combinePets` here any more (owner ruling, 2026-08-04). The
  // engine used to offer a fold that merged pet damage into a synthetic "You +pets" source with
  // namespaced lanes; the floating overlay asked for it and the Combat tab didn't, so the two
  // surfaces showed different answers for the same fight. Pet LAYOUT is a presentation choice
  // (world-model law 4) and now lives in exactly one place, the renderer's
  // `features/combat/petRows.ts`, which every meter calls. The engine states its attribution —
  // you and each pet as their own authoritative row — and offers no second opinion.
  selectedId?: string
  /** include lines the engine couldn't classify (damage-shaped but unmatched) */
  showUnparsed?: boolean
  /**
   * Cap on how many finalized-fight summaries to serialize (newest-first). The
   * current encounter and the zone summary are ALWAYS included regardless of the
   * cap. Defaults to 100. A selected finalized fight outside the cap window is
   * still fully resolvable via `selected` (built separately). Raise to load more.
   */
  maxSegments?: number
  /**
   * When true (Task #51), include the SELECTED encounter's event timeline in the
   * snapshot (`timeline`). Off by default — the timeline payload is heavier than the bar
   * view, so it's only fetched when the CombatView is in Timeline mode. Only the current
   * live encounter and finalized encounters within the engine's per-encounter event ring
   * carry a timeline; older/evicted encounters return `timeline:null`.
   */
  timeline?: boolean
}
