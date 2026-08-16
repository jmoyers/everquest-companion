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

import { GEAR_STAT_KEYS, type GearStatKey, type GearStats } from './gear'
import { gearEffectiveHp, gearRatio } from './gearScale'

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
