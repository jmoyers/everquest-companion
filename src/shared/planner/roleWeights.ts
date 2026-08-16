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

import { GEAR_STAT_KEYS, type GearRow, type GearStatKey, type GearStats } from './gear'
import type { EquipSlot } from './types'
import { gearEffectiveHp, gearRatio } from './gearScale'
// The skill vocabulary is NOT restated here — `weaponType.ts` measured it and folded it, and one
// fold is what keeps the Gear tab's weapon filter and this policy answering the same question.
import { WEAPON_CATEGORY_MEMBERS, weaponTypeOf } from './weaponType'

// =================================================================================================
// ROLE WEIGHTS — one table, openly heuristic
// =================================================================================================

/**
 * What the player is gearing FOR — widened 2026-08-15 on the owner's ask, verbatim: *"we should
 * probably have it be choseable also, 1h DPS, 2h DPS, dual weild, DD, DOT, Healer, Tank, etc"*.
 *
 * `dps` STAYS as the generic and is not renamed, because it is a value already sitting in a
 * `localStorage` key on the owner's machine (`eq.plan.role`) and `sanitizePlanRole` would have
 * quietly reset a stored `dps` to `balanced` the moment the union stopped naming it. A vocabulary
 * that has shipped is a vocabulary you extend, not one you re-spell.
 *
 * THREE OF THE NEW MEMBERS SHARE THE DPS WEIGHTS EXACTLY (`dps1h`, `dps2h`, `dualwield`). They are
 * not three opinions about what a stat is worth — the same 8 STR is the same 8 STR in either hand.
 * They differ in WEAPON-SLOT POLICY (`ROLE_WEAPON_POLICY` below), which is a question about the
 * SHAPE of a loadout rather than the value of a stat, and keeping the two questions in two tables is
 * what stops "dual wield" from becoming a third set of coefficients nobody can justify.
 */
export type GearRole =
  | 'balanced'
  | 'tank'
  | 'healer'
  | 'dps'
  | 'dps1h'
  | 'dps2h'
  | 'dualwield'
  | 'dd'
  | 'dot'

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
/**
 * THE MELEE DPS PROFILE, shared by `dps`, `dps1h`, `dps2h` and `dualwield` (see `GearRole`).
 */
const MELEE_DPS: RoleWeights = {
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
}

/**
 * THE CASTER PROFILE the two nuker roles share, and the honesty clause that comes with it.
 *
 * DD AND DOT ARE VERY NEARLY THE SAME RANKING, ON PURPOSE. The corpus states AC, attributes, pools
 * and regens; it states NOTHING about spell damage, cast time, resist rate or duration, so nothing
 * in a stat block distinguishes a burst caster's gear from a damage-over-time caster's. Inventing a
 * spread would be inventing a fact, so the two tables differ in exactly one axis and are otherwise
 * identical:
 *   * DD leans RAW POOL — INT 1.7, MP 0.45, MANA_REGEN 8. Burst is paid for up front, out of the
 *     bar you walked in with, so what you can spend in ten seconds is what you brought.
 *   * DOT leans REGEN — INT 1.5, MP 0.35, MANA_REGEN 14. A dot fight is long by definition, and a
 *     bar that refills DURING it is worth more than a bar that was bigger at the start.
 * That is the whole difference, it is a lean and not a claim, and anybody expecting two visibly
 * different lists should expect two nearly identical ones instead.
 */
const CASTER_STATS: Partial<Record<GearStatKey, number>> = {
  AC: 0.8,
  STR: 0.1,
  AGI: 0.1,
  DEX: 0.1,
  WIS: 0.9,
  INT: 1.6,
  CHA: 0.2,
  MP: 0.4,
  HP_REGEN: 3,
  MANA_REGEN: 10,
  END_REGEN: 0.2,
  ATTACK: 0.1,
  HASTE: 0.3,
  DMG_BONUS: 0.1
}

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
  dps: MELEE_DPS,
  // THE SAME OBJECT, not a copy — see the `GearRole` header. A 1H build, a 2H build and a dual-wield
  // build value an identical stat identically; what differs is which SLOTS they will take a
  // suggestion for, and that is `ROLE_WEAPON_POLICY`'s question, not this table's. Sharing the
  // reference is the compile-time version of that claim: they cannot drift apart.
  dps1h: MELEE_DPS,
  dps2h: MELEE_DPS,
  dualwield: MELEE_DPS,
  dd: { stats: { ...CASTER_STATS, INT: 1.7, MP: 0.45, MANA_REGEN: 8 }, ehp: 0.3, ratio: 2, saves: 0.3 },
  dot: { stats: { ...CASTER_STATS, INT: 1.5, MP: 0.35, MANA_REGEN: 14 }, ehp: 0.3, ratio: 2, saves: 0.3 },
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
// one of each — which is what lets `dps1h`, `dps2h` and `dualwield` share ONE weights profile
// (`MELEE_DPS`) and still produce three different plans.
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
// Fetish, SECONDARY, AC 8) — so the predicate is a SHAPE: a row whose only slot is SECONDARY, that
// states no weapon skill, and that states an AC. That is 147 rows; 130 of them carry a shield word
// in the name (Shield, Aegis, Barrier, Buckler, Bulwark, Targ…) and the other 17 are offhand curios
// with an AC on them — a lute, a giant's sandal, a parrying dagger, a stein. Those 17 are FALSE
// POSITIVES and are stated as such rather than filtered by a name regex, which would be exactly the
// fuzzy join law 12 refuses. The bucket it excludes is the one that matters: the 64 SECONDARY-only
// rows with NO AC (horns, dolls, books, candles) and the 198 multi-slot SECONDARY non-weapons
// (140 of them PRIMARY+SECONDARY), none of which a tank wants suggested as an offhand.

/** What a slot may be filled with, when a role constrains it at all. */
export type SlotKind = 'weapon-1h' | 'weapon-2h' | 'shield-like'

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
 * RANGE IS DELIBERATELY UNTOUCHED by every row. A bow or a thrown stack is a third weapon that
 * neither hand competes with, and no ask has ever been about it; constraining it would be inventing
 * a rule out of symmetry.
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
  dd: {},
  dot: {}
}

const ONE_HAND: ReadonlySet<string> = new Set<string>(WEAPON_CATEGORY_MEMBERS.ONE_HAND)
const TWO_HAND: ReadonlySet<string> = new Set<string>(WEAPON_CATEGORY_MEMBERS.TWO_HAND)

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

/**
 * THE SHAPE OF A SHIELD, and no more than that — see the census above for the 147 rows it matches
 * and the 17 of those that are honestly curios rather than shields.
 */
export function isShieldLike(row: Pick<GearRow, 'slots' | 'skill' | 'stats'>): boolean {
  if (row.slots.length !== 1 || row.slots[0] !== 'SECONDARY') return false
  if (weaponTypeOf(row.skill) !== null) return false
  return row.stats.AC !== undefined
}

/** Does this row satisfy a slot's stated kind? One dispatch, so the three arms cannot disagree. */
export function rowIsKind(row: Pick<GearRow, 'slots' | 'skill' | 'stats'>, kind: SlotKind): boolean {
  if (kind === 'shield-like') return isShieldLike(row)
  return gearHandedness(row.skill) === (kind === 'weapon-1h' ? '1h' : '2h')
}

/**
 * WOULD THIS ROLE TAKE A SUGGESTION FOR THIS SLOT, FILLED WITH THIS ROW? The one predicate the
 * admission fold asks, so the closed-list and the kind-list are never read separately.
 */
export function policyAdmits(
  policy: WeaponSlotPolicy,
  slot: EquipSlot,
  row: Pick<GearRow, 'slots' | 'skill' | 'stats'>
): boolean {
  if (policy.closed?.includes(slot) === true) return false
  const kind = policy.only?.[slot]
  return kind === undefined || rowIsKind(row, kind)
}
