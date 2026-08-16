// planner/progressionPlan.ts — WHERE SHOULD I BE, AND WHAT AM I THERE FOR, ONE LEVEL BRACKET AT A
// TIME (docs/plans/gear-progression-planner.md §1, §2.4, §3).
//
// THE ASK THIS FILE ANSWERS, in the fork user's own words: *when finding the best gear for me I need
// a progression tree — Crushbone for the first N levels, Mistmoore, Splitpaw… based on the 3 classes
// someone wants and the target (dps, tank, healer) — and when to grind +0 for exp vs +4 areas for
// gear, because +4 is harder so we need the creatures to be blue and white solo.*
//
// IT IS A PLANNER, NOT AN OPTIMIZER, and the distinction is forced by the data rather than chosen:
// NO DROP RATES EXIST ANYWHERE IN THIS REPO (the item census's standing caveat), so there is nothing
// to optimize over. What the corpus does state is a mob's level, the zones it lives in, and which
// mobs an item page names as droppers — so a bracket ranks ZONES by what their mobs' stated levels
// read against the injected con model, and ITEMS by a role-weighted worth score. Both derivations
// are labeled, here and on every surface that draws them.
//
// EVERYTHING IS INJECTED (`PlanCorpora`) AND THE FOLD IS PURE. No data import, no `Date.now`, no
// `localStorage`, no renderer. The con function in particular is a PARAMETER and not a call into
// `shared/conBands.ts`: the plan is only as good as the band table it is handed, that table is
// LEARNED from one machine's consider history, and a fold that reached for it directly could not be
// tested against a band table whose shape the test controls. The renderer passes `conBand`.
//
// SIX RULES THE FOLD REFUSES TO BEND:
//
//   1. AN EMPTY CLASS LIST IS UNKNOWN, NEVER "NOBODY" (`GearRow.classes`, law 1). An item whose page
//      stated no classes — or stated them unreadably — is KEPT for every trio. Excluding it would
//      quietly delete real gear on the strength of a wiki omission.
//   2. A +N TARGET CARRIES NO BAND. Plan §3: the game spells a tiered zone `<base> <N> (<TierWord>)`
//      and the wiki spells the same thing `<base> +N`, but the CATALOG states no level for any +N
//      mob (plan §0.2, re-verified 2026-08-15) — so nothing on this machine states how hard a +4
//      creature is. Printing "blue at 19" for one would be a fabricated number. `band: null` is the
//      honest answer and the renderer draws it as "difficulty unstated".
//   3. THE ROLE WEIGHTS ARE A HEURISTIC AND SAY SO. See `roleValue`.
//   4. THE HORIZON IS DATA-DRIVEN, not a level cap this file claims to know. See
//      `buildProgressionPlan`.
//   5. THE TARGET GATE IS A CEILING, NOT A WINDOW. CORRECTED 2026-08-15, from the owner playing the
//      first cut: the plan was hiding good items because their drop mob conned GREY. "Blue and white
//      solo" was always an upper bound on how hard a fight the route may send you to, and a trivial
//      mob is the EASIEST farm in the game — so `trivial` is inside the gate for TARGETS (solo:
//      trivial|safe|even, group: +risky). EXP ZONES ARE UNCHANGED and still want safe/even, because
//      that half is about experience and a grey mob pays none.
//      THE CONSEQUENCE, stated rather than discovered: a grey-source item now qualifies from the
//      FIRST bracket, which is the correct advice ("go and grab this now") and does mean the opening
//      bracket sees the most competition. Nothing else was needed to keep that bounded — the role
//      score orders it, `TARGET_CAP` bounds it, and the consume-on-emission dedupe in `targetsFor`
//      lets anything the cap cut resurface later.
//   6. NO CAMP TIMERS, NO DROP-RATE CLAIMS, NO COSTING, NO SECOND WISH LIST (plan §8). The plan
//      SEEDS the wish list; it does not become one.
//
// TWO PLACES THIS DIVERGES FROM THE PLAN DOC, both reported rather than smuggled:
//   * §2.4 says exp zones are "era-legal zones". `PlanCorpora` carries no zone-era witness, so the
//     gate here reads `era.ts layeredVerdict` on the zone name alone and drops only a POSITIVE
//     out-of-era. `unknown` is KEPT for a zone, where the gear rule hides it — see `expZonesFor`.
//   * The era verdict for an ITEM reads layers 1-2 (`layeredVerdict`). LAYER 3 — `GearRow.eraDerived`
//     — is NOT consulted, because the fold that weighs it against the other layers lives in the
//     renderer (`features/planner/plannerData.ts donorEra`) and re-implementing it here would create
//     the second opinion `era.ts` exists to prevent.

import type { ClassAbbr } from '../classCombo'
import type { ConBand } from '../conBands'
import { GEAR_STAT_KEYS, type GearRow, type GearStatKey, type GearStats } from './gear'
import { layeredVerdict } from './era'
import { gearEffectiveHp, gearRatio } from './gearScale'
import { plusSuffix, zoneLevelKey, type PlusName, type ZoneLevels } from './zoneLevels'

// =================================================================================================
// ROLE WEIGHTS — one table, openly heuristic
// =================================================================================================

/** What the player is gearing FOR. `balanced` is the default and sits between the other three. */
export type GearRole = 'balanced' | 'tank' | 'dps' | 'healer'

/** One role's coefficients. Absent key = that stat contributes NOTHING to this role. */
interface RoleWeights {
  /** per-stat coefficients, applied to the STATED value */
  stats: Partial<Record<GearStatKey, number>>
  /** coefficient on `gearEffectiveHp` (HP + STA); why HP/STA are not in `stats` is below */
  ehp: number
  /** coefficient on `gearRatio` (weapons only — a non-weapon contributes nothing) */
  ratio: number
  /** coefficient applied to EVERY stated save, one number for all ten */
  saves: number
}

/** The ten `SV_*` keys, read off the closed vocabulary rather than restated (`gear.ts`). */
const SAVE_KEYS: readonly GearStatKey[] = GEAR_STAT_KEYS.filter((k) => k.startsWith('SV_'))

/**
 * THE WEIGHTS. THESE COEFFICIENTS ARE INVENTED RANKINGS, NOT GAME FACTS — the honesty clause, and it
 * is the same one `gearEffectiveHp` carries about its missing soft cap. EverQuest states nowhere how
 * much a point of AC is worth against a point of stamina, this repo has measured no such exchange
 * rate, and no amount of table-tuning would turn one into a measurement. What the table IS: a
 * defensible, one-place, role-differentiated ORDERING so that a tank's list is not a dps's list.
 * Change a number here and every surface moves together; there is no second table.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each absence is a decision:
 *   * HP and STA. They ride through `ehp` (`gearEffectiveHp`), so listing them in `stats` too would
 *     count them twice — and the derived key is the one that already answers "what if only one of
 *     them is stated".
 *   * DMG and DELAY. They ride through `ratio` (`gearRatio` → `damageRatio`), which is undefined for
 *     anything that is not a weapon. A raw DMG weight would rank 6,000 non-weapons at zero on a key
 *     they never state.
 *   * WEIGHT, CHARGES-like per-item facts, and RANGE. Weight is a COST, not worth, and this repo has
 *     no measured strength-to-encumbrance model to price it with; the other two are facts about an
 *     item, not comparisons between items (`gear.ts`'s own census reasoning).
 *
 * The role shapes, in one line each: TANK up-weights AC and effective HP and barely reads a weapon;
 * DPS reads the damage ratio big plus STR/DEX/ATTACK/HASTE and the damage bonus; HEALER reads
 * mana, WIS, CHA and both regens with a moderate EHP; BALANCED reads everything smally. Every role
 * reads AC, effective HP and saves at some weight, because staying alive is not a role.
 */
const ROLE_WEIGHTS: Readonly<Record<GearRole, RoleWeights>> = {
  balanced: {
    stats: {
      AC: 2,
      STR: 0.6,
      AGI: 0.2,
      DEX: 0.5,
      WIS: 0.5,
      INT: 0.5,
      CHA: 0.2,
      MP: 0.15,
      HP_REGEN: 6,
      MANA_REGEN: 6,
      END_REGEN: 1,
      ATTACK: 0.6,
      HASTE: 2,
      DMG_BONUS: 1.5,
      BACKSTAB: 0.5
    },
    ehp: 0.5,
    ratio: 8,
    saves: 0.3
  },
  tank: {
    stats: {
      AC: 6,
      STR: 0.5,
      AGI: 0.4,
      DEX: 0.2,
      WIS: 0.1,
      INT: 0.1,
      CHA: 0.1,
      MP: 0.05,
      HP_REGEN: 10,
      MANA_REGEN: 1,
      END_REGEN: 1,
      ATTACK: 0.3,
      HASTE: 1,
      DMG_BONUS: 0.5
    },
    ehp: 1.2,
    ratio: 3,
    saves: 0.5
  },
  dps: {
    stats: {
      AC: 0.5,
      STR: 1.5,
      AGI: 0.2,
      DEX: 1.2,
      WIS: 0.1,
      INT: 0.8,
      CHA: 0.1,
      MP: 0.1,
      HP_REGEN: 3,
      MANA_REGEN: 3,
      END_REGEN: 1,
      ATTACK: 1.5,
      HASTE: 4,
      DMG_BONUS: 3,
      BACKSTAB: 2
    },
    ehp: 0.2,
    ratio: 20,
    saves: 0.15
  },
  healer: {
    stats: {
      AC: 1,
      STR: 0.2,
      AGI: 0.1,
      DEX: 0.1,
      WIS: 1.5,
      INT: 0.9,
      CHA: 0.4,
      MP: 0.35,
      HP_REGEN: 6,
      MANA_REGEN: 12,
      END_REGEN: 0.5,
      ATTACK: 0.1,
      HASTE: 0.5,
      DMG_BONUS: 0.2
    },
    ehp: 0.4,
    ratio: 3,
    saves: 0.35
  }
}

/**
 * ONE ITEM'S WORTH TO ONE ROLE. Heuristic — see `ROLE_WEIGHTS`.
 *
 * ABSENT STATS CONTRIBUTE NOTHING (law 1, and it is what keeps the arithmetic total): an item that
 * states no relevant stat scores exactly `0`, never `NaN`, and an item that states a PENALTY
 * (`STR: -5`) scores that penalty, because a stated negative is a stated number.
 *
 * Rounded to three decimals so a score is a stable sort key and a stable test expectation rather
 * than an accumulation of float dust — the ranking, not the value, is the answer this returns.
 */
export function roleValue(stats: GearStats, role: GearRole): number {
  const weights = ROLE_WEIGHTS[role]
  let total = 0
  for (const key of Object.keys(weights.stats) as GearStatKey[]) {
    const value = stats[key]
    const coefficient = weights.stats[key]
    if (value !== undefined && coefficient !== undefined) total += value * coefficient
  }
  for (const key of SAVE_KEYS) {
    const value = stats[key]
    if (value !== undefined) total += value * weights.saves
  }
  const ehp = gearEffectiveHp(stats)
  if (ehp !== undefined) total += ehp * weights.ehp
  const ratio = gearRatio(stats)
  if (ratio !== undefined) total += ratio * weights.ratio
  return Math.round(total * 1000) / 1000
}

// =================================================================================================
// THE PLAN'S SHAPE
// =================================================================================================

/** What the player told the surface. Everything else the fold needs arrives in `PlanCorpora`. */
export interface PlanInputs {
  /** the character's CURRENT level — the first bracket opens here */
  level: number
  /** the class trio (detected or pinned). EMPTY means "no trio stated", which gates nothing. */
  classes: readonly ClassAbbr[]
  role: GearRole
  /**
   * THE CEILING on how hard a target's fight may be: solo tops out at even ("blue and white" in the
   * ask), group at risky. Anything EASIER always qualifies — see `SOLO_GATE`.
   */
  reach: 'solo' | 'group'
  eraOnly: boolean
  /** plan §8 calls 6 a first guess, so it is an input and not a constant. Default 6. */
  bracketSize?: number
}

/** One item worth going and getting, at one bracket, off one stated witness. */
export interface GearTarget {
  /** `itemKey(name)` — the key ownership, the wish list and the loot index all join on */
  key: string
  name: string
  iconId?: number
  /** the BASE zone (tier suffix stripped); `''` when the page listed the mob under no heading */
  zone: string
  /** the tier this witness names, or `null` for a base-zone witness */
  plus: number | null
  /** the BASE mob spelling, so a caller can look it up; the renderer composes `mob +plus` */
  mob: string
  /** the level the CATALOG states for that mob, or `null`. See `witnessesOf` for the +N split. */
  mobLevel: number | null
  /** the con verdict at the earliest level in the bracket where it qualifies — `null` for a +N */
  band: ConBand | null
  /** `roleValue(row.stats, role)` — heuristic, and the only thing targets are ranked by */
  score: number
}

/** One zone worth grinding in, at one bracket. Every field is DERIVED — `sampled` says how much. */
export interface ZonePick {
  zone: string
  median: number
  low: number
  sampled: number
  /** what the zone's MEDIAN mob cons at the bracket midpoint */
  band: ConBand
}

/** One six-level (by default) step of the route. */
export interface PlanBracket {
  from: number
  to: number
  expZones: ZonePick[]
  targets: GearTarget[]
}

/** Everything the fold reads, handed in — see the header on why the con model is a parameter. */
export interface PlanCorpora {
  gear: readonly GearRow[]
  /** `zoneLevelProfile(catalog)`, keyed by `zoneLevelKey` */
  profiles: ReadonlyMap<string, ZoneLevels>
  /** a catalog lookup: mob name → its stated level, or `null` when it states none */
  mobLevel: (mobName: string) => number | null
  /** `(myLevel, mobLevel) → band`. `conBands.conBand` in production, synthetic in the tests. */
  con: (myLevel: number, mobLevel: number) => ConBand
  /** item keys the character already owns — deduped out of the route */
  owned: ReadonlySet<string>
  /** item keys already on the wish list — likewise; the plan SEEDS that document, never duplicates it */
  wished: ReadonlySet<string>
}

// ---- the constants, each with the reason it is that number ------------------------------------

/** Plan §8: "a first guess", and the fold takes it as an input so tuning it is a constant. */
const DEFAULT_BRACKET_SIZE = 6
/**
 * FOUR EXP ZONES PER BRACKET. A route is a recommendation, not a gazetteer: the real corpus profiles
 * ~190 zones and a bracket that listed every zone whose median reads even would be a list nobody
 * reads. Four fits one card without scrolling. The cap is stated here and on the surface.
 */
const EXP_ZONE_CAP = 4
/** EIGHT TARGETS PER BRACKET, for the same reason and with the same disclosure. */
const TARGET_CAP = 8
/**
 * THE HARD BACKSTOP: six default brackets past the current level. The horizon is meant to be
 * DATA-driven (see `buildProgressionPlan`), and this exists only so a corpus that keeps answering
 * cannot loop forever. It is NOT a level cap claim — this file states no level cap, because the
 * server's is not in any data this repo holds.
 */
const HORIZON_LEVELS = 36
/** How many consecutive silent brackets end the route. Two, so one gap does not truncate a plan. */
const QUIET_BRACKETS = 2

/**
 * THE TARGET GATE IS A CEILING, NOT A WINDOW — corrected 2026-08-15 from live testing, and the
 * correction is rule 6 in the header. "Blue and white solo" (plan §2.1) is the hardest fight the
 * route may send you to, so `trivial` rides INSIDE the gate: a grey mob is the easiest farm there
 * is, and a route that refused to mention the tunic off a level-4 rat because you have outlevelled
 * the rat is answering a question nobody asked.
 */
const SOLO_GATE: readonly ConBand[] = ['trivial', 'safe', 'even']
/** A group loosens the CEILING by exactly one band. An OPTION, not a guess (plan §8). */
const GROUP_GATE: readonly ConBand[] = ['trivial', 'safe', 'even', 'risky']

// =================================================================================================
// THE FOLD
// =================================================================================================

/** A bracket's bounds, before it has any content. */
interface Bracket {
  from: number
  to: number
}

/** One stated drop witness off an item page, with the tier suffix already split off. */
interface Witness {
  zone: string
  plus: number | null
  mob: string
  mobLevel: number | null
}

/** A gear row that survived the filters, with its witnesses resolved and its score computed once. */
interface Candidate {
  row: GearRow
  witnesses: Witness[]
  score: number
}

/** What `targetsFor` needs, bundled — four positional arguments is the ceiling and this is clearer. */
interface PlanCtx {
  corpora: PlanCorpora
  /** the reach CEILING — every band a target's fight may read (rule 5), not a window */
  gate: readonly ConBand[]
  candidates: Candidate[]
}

/** The base spelling of a possibly-tiered name. */
function baseName(name: string): string {
  return plusSuffix(name)?.base ?? name
}

/**
 * CAN THE TRIO WEAR IT? Two ways to answer yes, and both are law 1.
 *
 * An EMPTY `row.classes` is the wiki declining to say, not a claim that nobody can wear the item
 * (`gear.ts`: "UNKNOWN, never 'nobody'"), so it is KEPT. And an empty INPUT trio means the surface
 * has no class detection to gate with, which gates nothing rather than everything.
 */
function wearable(row: GearRow, classes: readonly ClassAbbr[]): boolean {
  if (row.classes.length === 0 || classes.length === 0) return true
  return row.classes.some((c) => classes.includes(c))
}

/**
 * IS IT REACHABLE ON THE SERVER AS IT SHIPS TODAY?
 *
 * ONLY `in-era` SURVIVES — `unknown` hides too, which mirrors the gear surfaces exactly (the JOS-333
 * ruling in `plannerData.eraHides`: a question mark under a filter called "Current era" is a leak,
 * because the filter's promise is "what you can get" and "we cannot say" fails that promise the same
 * way "no" does).
 *
 * THE TIER SUFFIX IS STRIPPED BEFORE THE VERDICT (plan §3): `Timorous Deep +4` is Timorous Deep for
 * era purposes, and the zone table has never heard of the tiered spelling, so an unstripped name
 * would resolve to nothing and turn every tiered witness into an `unknown` the filter then hides.
 */
function eraLegal(row: GearRow, eraOnly: boolean): boolean {
  if (!eraOnly) return true
  const zones: string[] = []
  for (const source of row.wikiSources ?? []) {
    const zone = baseName(source.zone ?? '').trim()
    if (zone !== '') zones.push(zone)
  }
  return layeredVerdict(zones, row.eraTag) === 'in-era'
}

/**
 * The page's `|dropsfrom` witnesses, with the tier split off either side of the edge.
 *
 * THE TIER CAN RIDE ON EITHER NAME and the two cases are NOT the same fact, which is the whole
 * reason `mobLevel` is resolved here rather than at use:
 *   * the ZONE carries it (`Timorous Deep +4`, mob spelled plainly) — the mob is a mob the catalog
 *     knows, so its STATED level is carried. It is still ungated by con (`band: null`): what the
 *     catalog states is the base creature's level and nobody states what a tier does to it.
 *   * the MOB carries it (`Ixiblat Fer +5`) — that is a creature the catalog has no row for at all
 *     (plan §0.2: zero `MobEntry` names carry `+N`), and handing back the base mob's level would be
 *     stating a number about a different creature. `null`.
 */
function witnessesOf(row: GearRow, mobLevel: (name: string) => number | null): Witness[] {
  return (row.wikiSources ?? []).map((source) => witnessOf(source, mobLevel))
}

/** THE TIER, from whichever side of the edge spelled it. The zone wins when both do. */
function tierOf(zonePlus: PlusName | null, mobPlus: PlusName | null): number | null {
  return zonePlus?.plus ?? mobPlus?.plus ?? null
}

/** One `|dropsfrom` edge, resolved. Split out of `witnessesOf` for the complexity ceiling. */
function witnessOf(
  source: { mob: string; zone?: string },
  mobLevel: (name: string) => number | null
): Witness {
  const zoneRaw = source.zone ?? ''
  const zonePlus = zoneRaw === '' ? null : plusSuffix(zoneRaw)
  const mobPlus = plusSuffix(source.mob)
  const mob = mobPlus === null ? source.mob : mobPlus.base
  return {
    zone: (zonePlus === null ? zoneRaw : zonePlus.base).trim(),
    plus: tierOf(zonePlus, mobPlus),
    mob,
    mobLevel: mobPlus === null ? mobLevel(mob) : null
  }
}

/**
 * THE CON GATE, read across the WHOLE bracket: the band at the LOWEST level in `[from..to]` where a
 * mob of `mobLevel` falls inside `gate`, or `null` if it never does.
 *
 * Lowest rather than the midpoint because the bracket is advice about WHEN TO GO, and the earliest
 * level at which the fight is inside the gate is the answer to that question. A mob that only comes
 * into reach at the top of the bracket reports the band it has there — and one that is already grey
 * at the bottom reports `trivial` from the bottom, which is rule 5's whole point.
 */
function bandInBracket(
  mobLevel: number,
  bracket: Bracket,
  con: (my: number, mob: number) => ConBand,
  gate: readonly ConBand[]
): ConBand | null {
  for (let my = bracket.from; my <= bracket.to; my++) {
    const band = con(my, mobLevel)
    if (gate.includes(band)) return band
  }
  return null
}

/**
 * DOES THIS WITNESS PUT THE ITEM IN THIS BRACKET? `null` = no; `{ band }` = yes, with the band to
 * print (and `band: null` is a real answer — see rule 2 in the header).
 *
 * BASE WITNESS: the mob's stated level has to con at or under the reach CEILING somewhere in the
 * bracket (rule 5 — a grey mob passes, a deadly one does not). No stated level means no target: an
 * unlevelled mob cannot be conned and will not be guessed at.
 *
 * +N WITNESS: the con gate CANNOT be applied, so the only gate left is the one that can actually be
 * stated — the BASE zone's profile median has to sit inside the reach gate somewhere in the bracket.
 * That is a claim about the place, not about the tiered creature, and it is deliberately the weaker
 * claim: it keeps a +4 run out of a bracket forty levels below the zone without pretending to know
 * what the +4 mob itself cons at. A +N witness naming no zone at all has nothing left to gate on and
 * is dropped.
 */
function qualify(witness: Witness, bracket: Bracket, ctx: PlanCtx): { band: ConBand | null } | null {
  const { con, profiles } = ctx.corpora
  if (witness.plus === null) {
    if (witness.mobLevel === null) return null
    const band = bandInBracket(witness.mobLevel, bracket, con, ctx.gate)
    return band === null ? null : { band }
  }
  const profile = witness.zone === '' ? undefined : profiles.get(zoneLevelKey(witness.zone))
  if (profile === undefined) return null
  return bandInBracket(profile.median, bracket, con, ctx.gate) === null ? null : { band: null }
}

/** The first witness of a candidate that qualifies for this bracket, as a target — or `null`. */
function targetOf(candidate: Candidate, bracket: Bracket, ctx: PlanCtx): GearTarget | null {
  for (const witness of candidate.witnesses) {
    const verdict = qualify(witness, bracket, ctx)
    if (verdict === null) continue
    return {
      key: candidate.row.key,
      name: candidate.row.name,
      iconId: candidate.row.iconId,
      zone: witness.zone,
      plus: witness.plus,
      mob: witness.mob,
      mobLevel: witness.mobLevel,
      band: verdict.band,
      score: candidate.score
    }
  }
  return null
}

/**
 * This bracket's targets, ranked by the role score and capped.
 *
 * DEDUPE IS BY EMISSION, NOT BY QUALIFICATION, and the difference matters: an item is consumed
 * (`used`) when it actually LANDS in a bracket, so a row that qualified early but lost the cap-8 cut
 * can still surface later, where it has fewer competitors. Consuming on qualification would delete
 * such a row from the whole plan on the strength of a display limit — which is the one thing a cap
 * must never do. Each key still appears AT MOST ONCE, in the earliest bracket that had room for it.
 *
 * Name breaks a score tie, so a windowed list is stable under the scrollbar (the total-order law).
 */
function targetsFor(ctx: PlanCtx, bracket: Bracket, used: Set<string>): GearTarget[] {
  const found: GearTarget[] = []
  for (const candidate of ctx.candidates) {
    if (used.has(candidate.row.key)) continue
    const target = targetOf(candidate, bracket, ctx)
    if (target !== null) found.push(target)
  }
  found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  const kept = found.slice(0, TARGET_CAP)
  for (const target of kept) used.add(target.key)
  return kept
}

/**
 * This bracket's exp zones: the ones whose profile MEDIAN cons `safe` or `even` at the bracket
 * midpoint. `trivial` is DELIBERATELY OUT HERE, which is the one place this fold and the target gate
 * disagree on purpose (rule 5): a grey mob is a fine thing to farm an item off and a useless thing to
 * grind experience on, so the ceiling that admits it for TARGETS would be a lie for EXP ZONES.
 *
 * Ranked by how close the median sits to the midpoint, then by `sampled` descending (a
 * profile folded from 60 stated levels is worth more than one folded from 2), then by name so the
 * order is total. Capped at `EXP_ZONE_CAP`, which the surface states.
 *
 * THE MEDIAN IS THE ZONE'S STAND-IN, and it is a coarse one: a zone with a level-6 entrance and a
 * level-40 basement has a median that describes neither. `low` rides along on every pick so the
 * surface can show the spread instead of the fold pretending to be a range.
 *
 * THE ERA GATE HERE DROPS ONLY A POSITIVE `out-of-era`, where the item gate hides `unknown` too.
 * The asymmetry is deliberate and is about what the two silences MEAN. For an ITEM, `unknown` is
 * usually the wiki badging a page our corpus does not hold (JOS-333's measured remainder), so it is
 * a leak. For a ZONE, the only witness is the hand-authored `zones.ts` table, whose unresolved
 * names are dirt, prose and EQL-new places — hiding every zone that table has not heard of would
 * delete the route's exp half wholesale rather than tighten it.
 */
function expZonesFor(
  profiles: ReadonlyMap<string, ZoneLevels>,
  midpoint: number,
  con: (my: number, mob: number) => ConBand,
  eraOnly: boolean
): ZonePick[] {
  const picks: ZonePick[] = []
  for (const profile of profiles.values()) {
    if (eraOnly && layeredVerdict([profile.zone], undefined) === 'out-of-era') continue
    const band = con(midpoint, profile.median)
    if (band !== 'safe' && band !== 'even') continue
    picks.push({
      zone: profile.zone,
      median: profile.median,
      low: profile.low,
      sampled: profile.sampled,
      band
    })
  }
  picks.sort(
    (a, b) =>
      Math.abs(a.median - midpoint) - Math.abs(b.median - midpoint) ||
      b.sampled - a.sampled ||
      a.zone.localeCompare(b.zone)
  )
  return picks.slice(0, EXP_ZONE_CAP)
}

/** Every gear row that could ever be a target, filtered once and scored once (not per bracket). */
function candidatesOf(inputs: PlanInputs, corpora: PlanCorpora): Candidate[] {
  const out: Candidate[] = []
  for (const row of corpora.gear) {
    if (corpora.owned.has(row.key) || corpora.wished.has(row.key)) continue
    if (!wearable(row, inputs.classes)) continue
    if (!eraLegal(row, inputs.eraOnly)) continue
    const witnesses = witnessesOf(row, corpora.mobLevel)
    if (witnesses.length === 0) continue
    out.push({ row, witnesses, score: roleValue(row.stats, inputs.role) })
  }
  return out
}

/** Is this bracket silent — nowhere to grind and nothing to go and get? */
function isQuiet(bracket: PlanBracket): boolean {
  return bracket.expZones.length === 0 && bracket.targets.length === 0
}

/**
 * THE ROUTE: brackets of `bracketSize` levels, opening at the character's CURRENT level (44 → 44-49,
 * 50-55, …), each carrying where to grind and what to go and get while you are there.
 *
 * THE HORIZON IS DATA-DRIVEN, because this repo has no level cap to read. The route stops after
 * `QUIET_BRACKETS` consecutive brackets that carry neither an exp zone nor a target — that is the
 * corpus saying it has run out of things to state, which is a fact, where "stop at 50" would be a
 * number invented about a server whose cap is nowhere in this data. `HORIZON_LEVELS` is a hard
 * backstop so a strange corpus cannot loop, not a claim. Trailing silent brackets are trimmed before
 * the route is returned — a silent bracket in the MIDDLE is information ("nothing here, keep going"),
 * a silent one at the end is just the loop's own footprint.
 *
 * Bracket midpoint is `floor((from + to) / 2)`: the con model is stated in whole levels on both
 * sides, so asking it about level 46.5 would be asking a question the game never answers.
 */
export function buildProgressionPlan(inputs: PlanInputs, corpora: PlanCorpora): PlanBracket[] {
  const size = Math.max(1, Math.floor(inputs.bracketSize ?? DEFAULT_BRACKET_SIZE))
  const start = Math.max(1, Math.floor(inputs.level))
  const ctx: PlanCtx = {
    corpora,
    gate: inputs.reach === 'group' ? GROUP_GATE : SOLO_GATE,
    candidates: candidatesOf(inputs, corpora)
  }
  const used = new Set<string>()
  const route: PlanBracket[] = []
  let quiet = 0
  for (let from = start; from <= start + HORIZON_LEVELS; from += size) {
    const bracket: Bracket = { from, to: from + size - 1 }
    const midpoint = Math.floor((bracket.from + bracket.to) / 2)
    route.push({
      from: bracket.from,
      to: bracket.to,
      expZones: expZonesFor(corpora.profiles, midpoint, corpora.con, inputs.eraOnly),
      targets: targetsFor(ctx, bracket, used)
    })
    quiet = isQuiet(route[route.length - 1]) ? quiet + 1 : 0
    if (quiet >= QUIET_BRACKETS) break
  }
  while (route.length > 0 && isQuiet(route[route.length - 1])) route.pop()
  return route
}
