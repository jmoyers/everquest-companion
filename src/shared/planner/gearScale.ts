// planner/gearScale.ts — a gear row's numbers AT A PLUS-STATE, as a PURE MAP (JOS-283, phase 2).
//
// THE LOAD-BEARING RULE. The gear table sorts and filters on numbers that change with the upgrade
// slider, so the renderer needs `rows.map((r) => scaleGearRow(r, state))` to be the whole cost of
// moving that slider — no index rebuild, no corpus walk, no re-parse. Measured over the shipped
// index (tests/gearIndex.test.mts prints it every run): all 6,814 rows at one state in a couple of
// milliseconds, which is well inside a frame.
//
// EVERY RULE HERE IS PHASE 0'S (src/shared/itemUpgrade.ts), CALLED — none is restated. This file
// is a dispatch: `upgradeStatClass` says which of the five rules a key takes, the rule computes the
// value, and the only thing this file adds is the shape of the answer (a vector instead of an
// `ItemStatBlock`). `tests/gearIndex.test.mts` proves the equivalence the hard way, over the real
// corpus: for every indexed key of every equippable item, the vector's scaled value equals
// `scaleStatBlock(parsedBlock, state)`'s. If phase 0's arithmetic changes, both move together or
// that test goes red.
//
// THE ONE FACT THE VECTOR CANNOT RE-DERIVE is the synthetic `SV VOID` line: `synthesizesVoidSave`
// reads the item's whole stat block, including stat values the numeric vector could not parse. So
// it is answered ONCE at build (`GearRow.voidSynth`) and this file only applies it — which is why
// the equivalence above holds exactly rather than nearly.

import {
  normalizeUpgradeState,
  scaleDamage,
  scaleFlat,
  scalePrimary,
  scaleWeight,
  upgradeStatClass,
  type ItemUpgradeState
} from '../itemUpgrade'
import { damageRatio } from '../itemStats'
import { GEAR_STAT_KEYS, type GearRow, type GearStatKey, type GearStats } from './gear'

/**
 * One base value at `state`, by the rule its key takes.
 *
 * `delay` and `unchanged` are the SAME answer and are kept as separate arms on purpose: DELAY not
 * scaling is a game fact with a consequence (it is the whole reason a weapon's damage RATIO
 * improves — see `scaleStatBlock`'s header), where `unchanged` is the default for everything phase
 * 0's reference leaves alone.
 */
export function scaleGearStat(key: GearStatKey, base: number, state: ItemUpgradeState): number {
  switch (upgradeStatClass(key)) {
    case 'primary':
      return scalePrimary(base, state)
    case 'flat':
      return scaleFlat(base, state)
    case 'damage':
      return scaleDamage(base, state)
    case 'weight':
      return scaleWeight(base, state)
    case 'delay':
      return base
    default:
      return base
  }
}

/**
 * The whole vector at `state`. Returns a NEW object; the input is never mutated.
 *
 * `voidSynth` is the row's cached answer to "does an upgrade grant this item the synthetic
 * SV VOID line" (see `GearRow.voidSynth`). At tier 0 nothing is synthesized, matching phase 0.
 */
export function scaleGearStats(
  stats: GearStats,
  state: ItemUpgradeState,
  voidSynth = false
): GearStats {
  const s = normalizeUpgradeState(state)
  const out: GearStats = {}
  // Iterated over the CLOSED key list rather than the object's own keys, so a scaled vector always
  // draws its columns in table order regardless of what order the corpus stated them in.
  for (const key of GEAR_STAT_KEYS) {
    const base = stats[key]
    if (base === undefined) continue
    out[key] = scaleGearStat(key, base, s)
  }
  if (voidSynth && s.full > 0) out.SV_VOID = s.full
  return out
}

/** The same row at `state` — the map the gear table runs on every slider move. */
export function scaleGearRow(row: GearRow, state: ItemUpgradeState): GearRow {
  return { ...row, stats: scaleGearStats(row.stats, state, row.voidSynth === true) }
}

/**
 * A weapon's damage ratio from a (base or scaled) vector — `damageRatio`, not a second opinion.
 * Undefined for anything that is not a weapon, which is what keeps a ratio sort from ranking
 * 6,000 non-weapons at zero.
 */
export function gearRatio(stats: GearStats): number | undefined {
  return damageRatio(stats.DMG, stats.DELAY)
}

/**
 * EFFECTIVE HP (JOS-336) — raw HP plus raw STA, from a (base or scaled) vector.
 *
 * WHY IT IS A DERIVED KEY RATHER THAN A COLUMN THAT ADDS TWO CELLS UP. It is `gearRatio`'s twin in
 * every structural respect: a number the corpus never states, made of two numbers it does, and
 * therefore the one shape the table can carry that the SLIDER MOVES for a reason a reader has to be
 * shown. Both halves are `primary`-class stats (itemUpgrade.ts), so an upgrade grows them at
 * different rates depending on where each one sits against the ≤10 rule — which means a plus-state
 * can genuinely re-rank two items that tie at base. Living here, on the SCALED vector, is what makes
 * that automatic: the caller hands in `scaleGearRow(row, state).stats` and the sum is already at
 * that plus, exactly as the ratio is.
 *
 * NO SOFT CAP IS MODELLED — owner ruling, 2026-08-13, verbatim in the ticket: compute it *as if
 * there were NO soft cap*, taking the stated values raw. EverQuest discounts stamina above a
 * level-dependent cap and converts it to hitpoints at a ratio this repo has no measurement for;
 * inventing either number would be exactly the fuzzy join law 12 refuses. So the arithmetic is the
 * plainest sum there is, and its honesty is that it does not pretend to be the game's answer.
 *
 * ABSENT IS NOT ZERO, AND A STATED VALUE IS A VALUE (law 1, both directions). An item that states
 * NEITHER has no effective HP at all — `undefined`, which sorts LAST in both directions and renders
 * BLANK, the same treatment a non-weapon gets from `gearRatio`. An item that states exactly ONE of
 * them has an effective HP equal to that one: the silence of the other key is not a claim that the
 * item carries zero stamina, it is the wiki declining to say, and folding a stated 40 HP into
 * `undefined` because no STA line sits beside it would delete a number the corpus DID print.
 */
export function gearEffectiveHp(stats: GearStats): number | undefined {
  const { HP, STA } = stats
  if (HP === undefined && STA === undefined) return undefined
  return (HP ?? 0) + (STA ?? 0)
}
