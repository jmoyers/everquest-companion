// planner/roleWeights.ts — WHAT IS THIS ITEM WORTH TO SOMEBODY PLAYING THIS WAY
// (docs/plans/gear-progression-planner.md §2.3; the fold that consumes it is `progressionPlan.ts`).
//
// SPLIT OUT OF `progressionPlan.ts` when that file crossed this tree's measured 400-code-line
// ceiling (eslint.config.mjs, p90). The seam is not arbitrary: the plan fold is about PLACES and
// LEVELS, and this is one weights table plus the arithmetic that reads it — a subject of its own,
// with its own honesty clause, and the file most likely to be edited by somebody tuning a number
// rather than changing a rule. `progressionPlan.ts` re-exports `GearRole` and `roleValue`, so no
// import site anywhere had to move.
//
// PURE, relative value imports (the shared/planner house rule) so the node test runner loads it.

import type { ClassAbbr } from '../classCombo'
import { GEAR_STAT_KEYS, type GearRow, type GearStatKey, type GearStats } from './gear'
import type { EquipSlot } from './types'
import { gearEffectiveHp, gearEffectiveRatio } from './gearScale'
// The skill vocabulary is NOT restated here — `weaponType.ts` measured it and folded it, and one
// fold is what keeps the Gear tab's weapon filter and this policy answering the same question.
import { WEAPON_CATEGORY_MEMBERS, weaponTypeOf } from './weaponType'
import { isShieldLike } from './shield'

// =================================================================================================
// ROLE WEIGHTS — two layers: what the FOCUS values, and what the CLASS can even use
// =================================================================================================
//
// REBUILT 2026-08-22 ON THE OWNER'S RULINGS, in the order they arrived: haste is an afterthought;
// a melee does not care about INT, CHA, WIS, AGI or mana; stats are weighted by the type of focus;
// and the standing request, *"if you know what stats help which types of classes or caster etc,
// build a grid so you can create better gear suggestions."* The single table became two:
//
//   LAYER 1, THE FOCUS (`ROLE_WEIGHTS`): how much a stat is worth to somebody playing THIS WAY —
//   a tank's AC, a nuker's mana, a two-hander's damage bonus. One column per `GearRole`.
//
//   LAYER 2, THE CLASS (`CLASS_FACTS`): which of those stats are LIVE for the classes picked. The
//   focus row says "mana stat: 1.7"; the class says "for you that is INT" — or "for you that is
//   nothing". Four things are class facts and not focus opinions: WHICH attribute is your mana
//   (INT, WIS, or none), whether CHARISMA does anything in a fight, whether BACKSTAB exists for you,
//   and whether ENDURANCE feeds anything.
//
// WHY TWO LAYERS RATHER THAN MORE COLUMNS: a Shadowknight and a Warrior on "2H DPS" want the same
// STR, ATK and haste off a glove, and differ only in that one of them has a mana bar. A column per
// class would restate the focus sixteen times to express one fact each. The gate expresses the fact
// once and the focus once, and the score is the product.
//
// SEVERAL CLASSES PICKED (the Gear area's trio) reads "live for ANY of them" — a stat is credited
// if somebody in the trio can use it. NO CLASS PICKED reads as UNKNOWN, which is law 1 (an empty
// class list is "not stated", never "nobody"): everything is live, both mana stats count, and the
// score is what it was before the gate existed.

/**
 * What the player is gearing FOR — widened 2026-08-15 on the owner's ask, verbatim: *"we should
 * probably have it be choseable also, 1h DPS, 2h DPS, dual weild, DD, DOT, Healer, Tank, etc"*.
 *
 * `dps` STAYS as the generic and is not renamed, because it is a value already sitting in a
 * `localStorage` key on the owner's machine (`eq.plan.role`) and `sanitizePlanRole` would have
 * quietly reset a stored `dps` to `balanced` the moment the union stopped naming it. A vocabulary
 * that has shipped is a vocabulary you extend, not one you re-spell.
 *
 * THE MELEE MEMBERS SHARE ONE PROFILE EXCEPT WHERE THE GAME ITSELF DIFFERS (owner ruling
 * 2026-08-22, *"stats need to be weighted based on the type of focus"*): the same 8 STR is the
 * same 8 STR in either hand, but a two-hander cannot backstab at all, so `dps2h` does not read
 * BACKSTAB. (The damage bonus stopped being a weights cell 2026-09-04 — it rides the ratio now,
 * `gearEffectiveRatio`.) Everything else the builds disagree on is WEAPON-SLOT POLICY
 * (`ROLE_WEAPON_POLICY` below), the SHAPE of a loadout, kept in its own table.
 *
 * `range` (owner, 2026-08-22: *"I don't see ranger/throwing ... like bows and rock and stuff"*):
 * the focus that fights from the RANGE slot. The corpus has 126 RANGE-slot weapons (Archery and
 * the three Throwing spellings, `weaponType.ts`) and they never reached a route, because no focus
 * weighed DEX as the ranged accuracy stat and no policy said what the RANGE slot takes. Now one
 * does: `range` takes only bows and throwing weapons there and leaves both hands open, because a
 * ranger still swings when the mob closes.
 */
export type GearRole =
  | 'balanced'
  | 'tank'
  | 'healer'
  | 'dps'
  | 'dps1h'
  | 'dps2h'
  | 'dualwield'
  | 'range'
  | 'dd'
  | 'dot'

// ---- LAYER 2: the class facts -------------------------------------------------------------------

/** The attribute a class draws its mana from. `null` is the four pure melee: no bar at all. */
export type ManaStat = 'INT' | 'WIS'

/**
 * WHAT IS LIVE FOR ONE CLASS — game facts, not opinions, and the only per-class input the score
 * takes. Each is a fact about the class's mechanics in this era of the game; if Legends changes a
 * mechanic the row changes, not the focus table.
 */
export interface ClassFacts {
  /** INT casters and INT hybrids, WIS casters and WIS hybrids, or none for WAR/ROG/MNK/BER */
  manaStat: ManaStat | null
  /** charisma resolves charm, mez and lull for ENC and BRD; it is merchant prices for everyone else */
  charisma: boolean
  /** backstab is a rogue skill; the stat is dead on anyone else */
  backstab: boolean
  /** endurance feeds disciplines, which the melee and hybrids have and the pure casters do not */
  endurance: boolean
}

const MELEE: ClassFacts = { manaStat: null, charisma: false, backstab: false, endurance: true }
const INT_HYBRID: ClassFacts = { manaStat: 'INT', charisma: false, backstab: false, endurance: true }
const WIS_HYBRID: ClassFacts = { manaStat: 'WIS', charisma: false, backstab: false, endurance: true }
const INT_CASTER: ClassFacts = { manaStat: 'INT', charisma: false, backstab: false, endurance: false }
const WIS_CASTER: ClassFacts = { manaStat: 'WIS', charisma: false, backstab: false, endurance: false }

/** Every class the combo vocabulary names, stated explicitly — `roleWeightsClassGate.test.mts` pins the census. */
export const CLASS_FACTS: Readonly<Record<ClassAbbr, ClassFacts>> = {
  WAR: MELEE,
  MNK: MELEE,
  BER: MELEE,
  ROG: { ...MELEE, backstab: true },
  SHD: INT_HYBRID,
  BRD: { ...INT_HYBRID, charisma: true },
  PAL: WIS_HYBRID,
  RNG: WIS_HYBRID,
  BST: WIS_HYBRID,
  ENC: { ...INT_CASTER, charisma: true },
  MAG: INT_CASTER,
  NEC: INT_CASTER,
  WIZ: INT_CASTER,
  CLR: WIS_CASTER,
  DRU: WIS_CASTER,
  SHM: WIS_CASTER
}

/** The union of what is live across a picked trio — or EVERYTHING when nothing is picked (law 1). */
interface LiveGate {
  manaStats: ReadonlySet<ManaStat>
  charisma: boolean
  backstab: boolean
  endurance: boolean
}

const UNKNOWN_GATE: LiveGate = { manaStats: new Set<ManaStat>(['INT', 'WIS']), charisma: true, backstab: true, endurance: true }

function liveGate(classes: readonly ClassAbbr[]): LiveGate {
  if (classes.length === 0) return UNKNOWN_GATE
  const manaStats = new Set<ManaStat>()
  let charisma = false
  let backstab = false
  let endurance = false
  for (const abbr of classes) {
    const facts = CLASS_FACTS[abbr]
    if (facts.manaStat !== null) manaStats.add(facts.manaStat)
    charisma ||= facts.charisma
    backstab ||= facts.backstab
    endurance ||= facts.endurance
  }
  return { manaStats, charisma, backstab, endurance }
}

/**
 * The concrete stat keys the class layer gates, and the fact each answers to. MP and mana regen
 * ride on "has a mana bar at all": a warrior's +50 mana is dead weight exactly like his INT.
 */
function statIsLive(key: GearStatKey, gate: LiveGate): boolean {
  switch (key) {
    case 'MP':
    case 'MANA_REGEN':
      return gate.manaStats.size > 0
    case 'CHA':
      return gate.charisma
    case 'BACKSTAB':
      return gate.backstab
    case 'END':
    case 'END_REGEN':
      return gate.endurance
    default:
      return true
  }
}

// ---- LAYER 1: the focus weights -----------------------------------------------------------------

/**
 * One focus's coefficients. Absent key = that stat contributes NOTHING to this focus.
 *
 * INT AND WIS ARE NEVER NAMED HERE. A focus states ONE `manaStat` weight and the class layer says
 * which attribute it lands on — the test pins that no row spells either key, because a row that
 * did would be a focus pretending to know what class is reading it.
 */
interface RoleWeights {
  /** per-stat coefficients, applied to the STATED value (class-independent, see above) */
  stats: Partial<Record<GearStatKey, number>>
  /** coefficient on whichever of INT/WIS the picked classes cast from; 0 on a pure melee */
  manaStat: number
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
 * WHAT EACH ROW MEANS IN THE GAME, so a number can be argued with rather than guessed at:
 *   * `ratio` (weapons only) — effective DMG over DELAY, the foundation of melee damage; nothing
 *     on a glove competes with it, hence 30 on the melee focuses. (20 until 2026-09-04, tuned when
 *     the flat bonus rode beside it at ×3: with the bonus folded in, 20 let ten points of DEX
 *     outrank a third of a real blade's white damage, and the measured field case — a +7 11/24
 *     against a 12/36 wearing 10 DEX — ranked upside down.)
 *   * HASTE — a straight multiplier on swings, and WORN HASTE DOES NOT STACK, so `roleValue`
 *     credits it only above what the player already owns (the 2026-08-22 ruling, below).
 *   * DMG_BONUS — a flat add per hit, applied AFTER the multiplied roll. It rides through the
 *     ratio (`gearEffectiveRatio`, at its measured 1/17th-of-a-DMG-point worth) and appears in NO
 *     `stats` row (fork decision, kaltinril 2026-09-04): weighted flat at 3 it outranked eight
 *     points of multiplied DMG, and the route sent a level-50 to Unrest for a downgrade.
 *   * ATTACK — the number the hit and damage rolls actually read; STR feeds it by proxy, so ATTACK
 *     outweighs STR per point.
 *   * DEX — proc rate, and the accuracy stat for archery and throwing. It does NOT raise melee hit
 *     chance in this era, so it is moderate for every melee and special for none of them: a dual
 *     wielder with two proc weapons gets twice the value, but the table cannot see procs.
 *   * AGI — a sliver of AC above 75 and a little avoidance; "basically useless" at item
 *     magnitudes (owner) and weighted like it.
 *   * AC and `ehp` (HP + STA) — staying alive; every focus reads them, the tank reads them big.
 *   * HP_REGEN — downtime between fights, which is a solo concern and a tank's.
 *   * `manaStat`, MP, MANA_REGEN — the caster's damage budget; a hybrid's small one; nothing at
 *     all for a class with no bar (the class layer zeroes all three together).
 *   * CHA — charm, mez and lull resolution for ENC and BRD; gated to them, absent from the melee
 *     and healing focuses because no class that takes those focuses fights with it.
 *   * BACKSTAB — a rogue skill; gated to ROG and absent from `dps2h` (no backstab with a 2H).
 *   * END_REGEN — disciplines; gated to classes that have them, absent from the caster focuses.
 *   * saves — resisting a mob's roots, snares, dots and nukes; situational for everyone.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each absence is a decision:
 *   * HP and STA. They ride through `ehp` (`gearEffectiveHp`), so listing them in `stats` too would
 *     count them twice — and the derived key is the one that already answers "what if only one of
 *     them is stated".
 *   * DMG and DELAY. They ride through `ratio` (`gearEffectiveRatio` → `damageRatio`), which is
 *     undefined for anything that is not a weapon. A raw DMG weight would rank 6,000 non-weapons at
 *     zero on a key they never state.
 *   * WEIGHT, CHARGES-like per-item facts, and RANGE. Weight is a COST, not worth, and this repo has
 *     no measured strength-to-encumbrance model to price it with; the other two are facts about an
 *     item, not comparisons between items (`gear.ts`'s own census reasoning).
 *
 * The focus shapes, in one line each: TANK up-weights AC and effective HP and barely reads a
 * weapon; the MELEE focuses read the damage ratio big plus STR/DEX/ATTACK/HASTE and the damage
 * bonus; DD and DOT read mana and their mana stat where the melee read a weapon; HEALER reads mana,
 * its mana stat and both regens with a moderate EHP; BALANCED reads everything smally. Every focus
 * reads AC, effective HP and saves at some weight, because staying alive is not a role.
 */

/**
 * THE MELEE PROFILE, shared by `dps`, `dps1h` and `dualwield` exactly and by `dps2h` except for
 * the damage bonus and backstab (see `GearRole`).
 *
 * NO CASTER STAT IS NAMED (owner ruling, 2026-08-22: *"a DPS class doesn't care about INT, CHA, WIS
 * ... and MP, my melee doesn't care about that"*). INT and WIS cannot appear in any row; MP and
 * mana regen are here at the hybrid's small weight and the CLASS LAYER zeroes them for a class with
 * no bar, so a warrior's glove with `INT: 10` on it is worth exactly what the same glove without
 * it is worth. (The 0.8 INT this table carried before that ruling out-weighed AC, which is how a
 * caster bracer could outrank plate.)
 */
const MELEE_STATS: Partial<Record<GearStatKey, number>> = {
  AC: 0.5,
  STR: 1.5,
  AGI: 0.1,
  DEX: 1,
  MP: 0.05,
  HP_REGEN: 3,
  MANA_REGEN: 1,
  END_REGEN: 1,
  ATTACK: 2,
  HASTE: 4
}
const ONE_HAND_DPS: RoleWeights = {
  stats: { ...MELEE_STATS, BACKSTAB: 2 },
  manaStat: 0.3,
  ehp: 0.2,
  ratio: 30,
  saves: 0.15
}
/** A two-hander cannot backstab. The rest — damage bonus included, via the ratio — is the melee profile. */
const TWO_HAND_DPS: RoleWeights = { ...ONE_HAND_DPS, stats: { ...MELEE_STATS } }

/**
 * THE RANGED PROFILE. DEX is the accuracy and damage stat for archery and throwing in this era,
 * so it is the one attribute a ranged focus weighs ABOVE the melee's (2 to their 1), and STR falls
 * to 0.8 because a bow does not read it the way a sword does. ATTACK still counts (the ranged
 * rolls read it too), haste applies to ranged delay (2, below the melee's 4 — a ranged fight is
 * rarely a sustained swing). Everything else is the
 * melee profile: a ranger takes hits, drinks, and has a bar. The weapon RATIO is the same 20 and
 * reads DMG/DELAY off a bow exactly as off an axe — the corpus states both for every bow and
 * throwing weapon, so nothing here is a ranged-only invention.
 */
const RANGED: RoleWeights = {
  stats: { ...MELEE_STATS, STR: 0.8, DEX: 2, HASTE: 2 },
  manaStat: 0.3,
  ehp: 0.2,
  ratio: 30,
  saves: 0.15
}

/**
 * THE CASTER PROFILE the two nuker roles share, and the honesty clause that comes with it.
 *
 * DD AND DOT ARE VERY NEARLY THE SAME RANKING, ON PURPOSE. The corpus states AC, attributes, pools
 * and regens; it states NOTHING about spell damage, cast time, resist rate or duration, so nothing
 * in a stat block distinguishes a burst caster's gear from a damage-over-time caster's. Inventing a
 * spread would be inventing a fact, so the two tables differ in exactly one axis and are otherwise
 * identical:
 *   * DD leans RAW POOL — mana stat 1.7, MP 0.45, MANA_REGEN 8. Burst is paid for up front, out
 *     of the bar you walked in with, so what you can spend in ten seconds is what you brought.
 *   * DOT leans REGEN — mana stat 1.5, MP 0.35, MANA_REGEN 14. A dot fight is long by definition,
 *     and a bar that refills DURING it is worth more than a bar that was bigger at the start.
 * That is the whole difference, it is a lean and not a claim, and anybody expecting two visibly
 * different lists should expect two nearly identical ones instead.
 *
 * CHA is here at 0.5 and the class layer hands it to ENC and BRD only — the two classes whose
 * spells resolve on it. No END: the pure casters have no disciplines.
 */
const CASTER_STATS: Partial<Record<GearStatKey, number>> = {
  AC: 0.8,
  STR: 0.1,
  AGI: 0.1,
  DEX: 0.1,
  CHA: 0.5,
  HP_REGEN: 3,
  ATTACK: 0.1,
  HASTE: 0.3
}

const ROLE_WEIGHTS: Readonly<Record<GearRole, RoleWeights>> = {
  balanced: {
    stats: {
      AC: 2,
      STR: 0.6,
      AGI: 0.2,
      DEX: 0.5,
      CHA: 0.2,
      MP: 0.15,
      HP_REGEN: 6,
      MANA_REGEN: 6,
      END_REGEN: 1,
      ATTACK: 0.6,
      HASTE: 2,
      BACKSTAB: 0.5
    },
    manaStat: 0.5,
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
      MP: 0.05,
      HP_REGEN: 10,
      MANA_REGEN: 1,
      END_REGEN: 1,
      ATTACK: 0.5,
      HASTE: 1
    },
    manaStat: 0.3,
    ehp: 1.2,
    ratio: 3,
    saves: 0.5
  },
  dps: ONE_HAND_DPS,
  dps1h: ONE_HAND_DPS,
  dps2h: TWO_HAND_DPS,
  dualwield: ONE_HAND_DPS,
  range: RANGED,
  dd: { stats: { ...CASTER_STATS, MP: 0.45, MANA_REGEN: 8 }, manaStat: 1.7, ehp: 0.3, ratio: 2, saves: 0.3 },
  dot: { stats: { ...CASTER_STATS, MP: 0.35, MANA_REGEN: 14 }, manaStat: 1.5, ehp: 0.3, ratio: 2, saves: 0.3 },
  healer: {
    stats: {
      AC: 1,
      STR: 0.2,
      AGI: 0.1,
      DEX: 0.1,
      MP: 0.35,
      HP_REGEN: 6,
      MANA_REGEN: 12,
      ATTACK: 0.1,
      HASTE: 0.5
    },
    manaStat: 1.5,
    ehp: 0.4,
    ratio: 3,
    saves: 0.35
  }
}

/** Every focus's `stats` row, for the test that pins INT and WIS out of all of them. */
export function roleStatKeys(role: GearRole): readonly GearStatKey[] {
  return Object.keys(ROLE_WEIGHTS[role].stats) as GearStatKey[]
}

/** The two inputs the class layer and the haste rule need beside the item and the focus. */
export interface RoleContext {
  /**
   * THE HASTE PERCENTAGE THE PLAYER WOULD STILL OWN WITH THIS ITEM WORN. Worn haste does not
   * stack, so an item's haste is credited only ABOVE this; 0 (the default) is "none owned" and the
   * full percentage counts, because the first haste item is a real upgrade. The plan fold hands in
   * the best haste owned OUTSIDE the slot being scored (`progressionPlan.ts ownedHasteOutside`), so
   * a haste weapon and its own replacement are read under one number.
   */
  ownedHaste?: number
  /** the picked classes; EMPTY is unknown and gates nothing (law 1), not "nobody" */
  classes?: readonly ClassAbbr[]
}

/**
 * ONE ITEM'S WORTH TO ONE FOCUS, THROUGH THE CLASS GATE. Heuristic — see `ROLE_WEIGHTS`.
 *
 * ABSENT STATS CONTRIBUTE NOTHING (law 1, and it is what keeps the arithmetic total): an item that
 * states no relevant stat scores exactly `0`, never `NaN`, and an item that states a PENALTY
 * (`STR: -5`) scores that penalty, because a stated negative is a stated number.
 *
 * HASTE IS CREDITED ONLY ABOVE WHAT YOU ALREADY OWN (owner ruling, 2026-08-22: *"haste should be
 * an afterthought, only added in if haste doesn't exist"*). Worn haste does not stack in this game —
 * one item's percentage applies, the rest are dead weight — so a 9% glove is worth nothing to a
 * player swinging a 36% sword, and a score that kept crediting it routed exactly that player to
 * Sporali Gloves over his Gargoyle Grips (36 of the gloves' 36.4 points were haste). The term
 * counts only the part of the item's haste ABOVE `ctx.ownedHaste`, which is 0 for anything at or
 * below — the same line `gearScale.ts ignoreHaste` draws, made automatic here instead of a toggle.
 * The same weight table reads it, so "afterthought" is the credit rule, not a quieter coefficient.
 * A NEGATIVE stated haste is a penalty and scores as one, whatever is owned (`hasteCredit`).
 *
 * THE CLASS GATE (the file header): INT and WIS count at the focus's `manaStat` weight only for the
 * attribute the picked classes actually cast from; MP, mana regen, CHA, BACKSTAB and endurance
 * count only when some picked class can use them. No class picked gates nothing.
 *
 * Rounded to three decimals so a score is a stable sort key and a stable test expectation rather
 * than an accumulation of float dust — the ranking, not the value, is the answer this returns.
 */
export function roleValue(stats: GearStats, role: GearRole, ctx: RoleContext = {}): number {
  const weights = ROLE_WEIGHTS[role]
  const gate = liveGate(ctx.classes ?? [])
  const total =
    statedTotal(stats, weights, gate, ctx.ownedHaste ?? 0) +
    manaTotal(stats, weights, gate) +
    derivedTotal(stats, weights)
  return Math.round(total * 1000) / 1000
}

/** The focus row, through the class gate and the haste rule — LAYER 1 × LAYER 2. */
function statedTotal(stats: GearStats, weights: RoleWeights, gate: LiveGate, ownedHaste: number): number {
  let total = 0
  for (const key of Object.keys(weights.stats) as GearStatKey[]) {
    const stated = stats[key]
    const coefficient = weights.stats[key]
    if (stated === undefined || coefficient === undefined || !statIsLive(key, gate)) continue
    const value = key === 'HASTE' ? hasteCredit(stated, ownedHaste) : stated
    total += value * coefficient
  }
  return total
}

/**
 * THE HASTE TERM: only the part ABOVE what you already own counts, and a stated PENALTY counts in
 * full. The clamp is on the positive margin alone — `-5` haste beside a 36% sword is still a stated
 * negative number, and rounding it up to 0 would be the one place `roleValue` quietly improved on
 * what the page said (the "a stated penalty scores that penalty" clause above).
 */
function hasteCredit(stated: number, ownedHaste: number): number {
  return stated < 0 ? stated : Math.max(0, stated - ownedHaste)
}

/** The mana-stat row, landed on whichever attribute(s) the trio casts from. */
function manaTotal(stats: GearStats, weights: RoleWeights, gate: LiveGate): number {
  let total = 0
  for (const manaStat of gate.manaStats) {
    const stated = stats[manaStat]
    if (stated !== undefined) total += stated * weights.manaStat
  }
  return total
}

/** Saves, effective HP and the weapon ratio — the three terms no class gates. */
function derivedTotal(stats: GearStats, weights: RoleWeights): number {
  let total = 0
  for (const key of SAVE_KEYS) {
    const value = stats[key]
    if (value !== undefined) total += value * weights.saves
  }
  const ehp = gearEffectiveHp(stats)
  if (ehp !== undefined) total += ehp * weights.ehp
  const ratio = gearEffectiveRatio(stats)
  if (ratio !== undefined) total += ratio * weights.ratio
  return total
}

// =================================================================================================
// WEAPON-SLOT POLICY — the SHAPE of a loadout, which weights cannot express
// =================================================================================================
//
// THE BUG THIS EXISTS FOR, reported 2026-08-15: the owner wields a Verishe Mal Greataxe, a TWO-
// HANDER, so his Secondary/Held is empty ON PURPOSE. The upgrade-gap rule reads an empty slot as a
// GAP and a gap admits anything wearable — so the route cheerfully offered him shields. An empty
// offhand under a two-hander is not a hole in his gear; it IS his gear, and no score can say so
// because the difference is not in any stat.
//
// SO POLICY IS A SECOND, SEPARATE TABLE. Weights answer "what is this item worth"; policy answers
// "would I ever put something there at all, and what". Two questions, two tables, and a role picks
// one of each — which is what lets `dps1h` and `dualwield` share ONE weights profile
// (`ONE_HAND_DPS`, and `dps2h` differs from it by one stat) and still produce three different plans.
//
// THE KINDNESS PREDICATES ARE READ OFF THE CORPUS, NEVER INVENTED, and the skill vocabulary is not
// restated here: `weaponType.ts` already folded the wiki's fifteen `Skill:` spellings into nine
// types and `WEAPON_CATEGORY_MEMBERS` already says which are one-handed and which are two.
// RE-MEASURED 2026-08-15 against the committed corpus (`src/main/data/items.json`, 6,814 equippable
// rows), and it had not drifted from that file's 2026-08-13 census — same fifteen spellings, same
// counts, `SHIELD` still the only one `weaponTypeOf` declines to map:
//
//     1H Slashing 413 · Piercing 322 · 1H Blunt 321 · 2H Slashing 223 · 2H Blunt 195 · Archery 63 ·
//     2H Piercing 24 · Throwingv2 22 · Hand to Hand 11 · Throwingv1 8 · Throwing 7 ·
//     1H Piercing 2 · SHIELD 1 · "1H Slashing /" 1 · 1H Slash 1        (1,614 rows state one)
//
// WHAT THAT CENSUS SETTLED, measured the same day:
//   * 442 rows are two-handers and ALL 442 list PRIMARY. Three of them ALSO list SECONDARY (Rantho
//     Rapier, Runed Velium Claidhmore, Thunder Staff) — corpus dirt rather than a rule, and it is
//     named here rather than smoothed over, because it is why `dps2h` CLOSES the secondary outright
//     instead of trusting the slot list to be honest.
//   * 1,071 rows are one-handers: 1,044 list PRIMARY and 757 list SECONDARY. Dual wield has plenty
//     to offer in both hands.
//   * 217 PRIMARY rows state NO skill at all — brooms, torches, fishing poles, dolls. A row that
//     states no skill is NOT A WEAPON for policy purposes (law 1: the wiki did not say, so we do
//     not know), which means a weapon-only constraint EXCLUDES it. That is the honest direction:
//     "1H DPS" asked for a one-hander, and a torch has not been shown to be one.
//
// AND THE OFFHAND PREDICATE IS CALLED `shieldLike` BECAUSE THAT IS ALL IT CAN HONESTLY CLAIM. No
// field in the corpus says "this is a shield" — exactly ONE page states `Skill: SHIELD` (Crushbone
// Fetish, SECONDARY, AC 8) — so the answer is a heuristic, and it is `planner/shield.ts`'s: a
// SECONDARY-slot row whose name speaks a shield word or whose skill reads SHIELD. ONE RULE FOR THE
// WHOLE FORK (2026-08-25): this module used to carry its own shape (only-slot SECONDARY, no weapon
// skill, an AC stated — 147 rows) and the gear index carried the word rule (130 rows); measured
// against each other they agreed on 120, and the ten only the word rule keeps are real shields the
// shape misses — seven the corpus places in BACK+SECONDARY (Lodizal Shell Shield, Aegis of Life,
// Shield of the Immaculate…), a buckler stating no AC, a shield stating a Piercing skill — while the
// 27 only the shape keeps are ten "Guard"/"Barrier" shields and seventeen curios with an AC (a
// lute, a stein, a sandal). A tank's offhand slot and the Gear tab's Shield pick must not disagree
// about what a shield is, so the word rule won and lives beside the index that folds it in.

/** What a slot may be filled with, when a role constrains it at all. */
export type SlotKind = 'weapon-1h' | 'weapon-2h' | 'weapon-ranged' | 'shield-like'

/** One role's answer to "where would I take a suggestion, and what". Absent field = no constraint. */
export interface WeaponSlotPolicy {
  /**
   * Slots this role NEVER takes a suggestion for, even when the character sheet leaves them empty.
   * The empty offhand of a two-hander is the only member today, and it is the whole reason the
   * field exists: a closed slot is a STATEMENT, not a gap.
   */
  closed?: readonly EquipSlot[]
  /** What may be suggested in a slot. A slot named here admits nothing else. */
  only?: Partial<Record<EquipSlot, SlotKind>>
}

/**
 * THE POLICY TABLE — the one place a role's loadout shape is stated.
 *
 * RANGE IS UNTOUCHED BY EVERY ROW BUT `range`'S OWN. A bow or a thrown stack is a third weapon that
 * neither hand competes with, and for the hand-fighting builds constraining it would be inventing a
 * rule out of symmetry; the one focus that fights FROM that slot is the one row that names it.
 *
 * THE FIVE ROLES WITH NO ENTRY BEHAVE EXACTLY AS THEY DID BEFORE THIS TABLE EXISTED (`balanced`,
 * `dps`, `dd`, `dot`, `healer`) — an empty policy is not a new default, it is today's behaviour
 * spelled out. `dps` in particular stays unconstrained ON PURPOSE: it is the generic the owner's
 * stored pick already holds, and quietly giving it a weapon rule would change a plan he did not ask
 * to change. The player who wants a weapon rule picks a weapon role.
 */
export const ROLE_WEAPON_POLICY: Readonly<Record<GearRole, WeaponSlotPolicy>> = {
  balanced: {},
  tank: { only: { SECONDARY: 'shield-like' } },
  healer: {},
  dps: {},
  dps1h: { only: { PRIMARY: 'weapon-1h' } },
  // CLOSED, not merely constrained: there is nothing a two-hander build wants told about its
  // offhand, so the answer is silence rather than a narrower list.
  dps2h: { closed: ['SECONDARY'], only: { PRIMARY: 'weapon-2h' } },
  dualwield: { only: { PRIMARY: 'weapon-1h', SECONDARY: 'weapon-1h' } },
  // The RANGE slot takes a bow or a throwing weapon and nothing else; both hands stay OPEN, because
  // the ranged player melees when the mob closes and a constraint there would be an invention.
  range: { only: { RANGE: 'weapon-ranged' } },
  dd: {},
  dot: {}
}

const ONE_HAND: ReadonlySet<string> = new Set<string>(WEAPON_CATEGORY_MEMBERS.ONE_HAND)
const TWO_HAND: ReadonlySet<string> = new Set<string>(WEAPON_CATEGORY_MEMBERS.TWO_HAND)
const RANGED_TYPES: ReadonlySet<string> = new Set<string>(WEAPON_CATEGORY_MEMBERS.RANGED)

/** A bow or a throwing weapon, by the folded skill — `weaponType.ts` owns the three Throwing spellings. */
export function isRangedWeapon(skill: string | undefined): boolean {
  const type = weaponTypeOf(skill)
  return type !== null && RANGED_TYPES.has(type)
}

/**
 * `'1h'` / `'2h'` / `null` — the handedness of a row, from the skill the wiki stated and the fold
 * `weaponType.ts` already measured. `null` covers "states no skill" and "states a skill that is not
 * a melee weapon" (Archery, Throwing, the one `SHIELD`) with the same answer, because for a
 * weapon-slot constraint neither has been shown to be the thing that was asked for.
 */
export function gearHandedness(skill: string | undefined): '1h' | '2h' | null {
  const type = weaponTypeOf(skill)
  if (type === null) return null
  if (ONE_HAND.has(type)) return '1h'
  return TWO_HAND.has(type) ? '2h' : null
}

/** The one shield rule, re-exported so a policy reader has one door — see the census above. */
export { isShieldLike }

/** Does this row satisfy a slot's stated kind? One dispatch, so the three arms cannot disagree. */
export function rowIsKind(row: Pick<GearRow, 'slots' | 'skill' | 'name'>, kind: SlotKind): boolean {
  if (kind === 'shield-like') return isShieldLike(row)
  if (kind === 'weapon-ranged') return isRangedWeapon(row.skill)
  return gearHandedness(row.skill) === (kind === 'weapon-1h' ? '1h' : '2h')
}

/**
 * WOULD THIS ROLE TAKE A SUGGESTION FOR THIS SLOT, FILLED WITH THIS ROW? The one predicate the
 * admission fold asks, so the closed-list and the kind-list are never read separately.
 */
export function policyAdmits(
  policy: WeaponSlotPolicy,
  slot: EquipSlot,
  row: Pick<GearRow, 'slots' | 'skill' | 'name'>
): boolean {
  if (policy.closed?.includes(slot) === true) return false
  const kind = policy.only?.[slot]
  return kind === undefined || rowIsKind(row, kind)
}
