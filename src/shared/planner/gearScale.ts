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
import type { ClassAbbr } from '../classCombo'
import { damageRatio } from '../itemStats'
import { GEAR_STAT_KEYS, type GearRow, type GearStatKey, type GearStats } from './gear'
// A CYCLE, ON PURPOSE AND SAFE: roleWeights.ts reads `gearRatio`/`gearEffectiveHp` from this file
// and this file reads `roleValue` from it. Neither touches the other's bindings while a module is
// evaluating — every cross-call is inside a function, and `focusInputs` below is lazy for exactly
// that reason — so whichever side the graph loads first, both are initialised before either runs.
import { roleStatKeys, roleValue, type GearRole, type RoleContext } from './roleWeights'

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
 * What one point of flat DMG_BONUS is worth in points of DMG at endgame. DMG is multiplied by the
 * whole attack roll; the bonus is added once, flat, after it. Measured, not invented (fork
 * measurement, kaltinril 2026-09-04): 85 plain mainhand hits with a 19-DMG blade at level 50
 * averaged 341, so a bonus point buys about a seventeenth of what a DMG point does.
 */
export const AVG_HIT_MULTIPLIER = 17

/**
 * The ratio a ROLE scores by: `gearRatio` with the weapon's own flat DMG_BONUS folded in at its
 * measured worth (fork decision, kaltinril 2026-09-04). The fix this carries: a flat 17 scored as
 * `DMG_BONUS × 3` outranked eight points of multiplied DMG, and the route sent a level-50 to
 * Unrest for a downgrade. The Gear tab's Ratio column stays `gearRatio` — the game's own spelling.
 */
export function gearEffectiveRatio(stats: GearStats): number | undefined {
  if (stats.DMG === undefined || stats.DMG_BONUS === undefined) return gearRatio(stats)
  return damageRatio(stats.DMG + stats.DMG_BONUS / AVG_HIT_MULTIPLIER, stats.DELAY)
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

/**
 * The knobs a derived score takes, and since 2026-08-25 they are the ROLE MODEL'S (fork decision,
 * kaltinril — one scale for the whole fork, so the Gear tab and the progression plan can never rank
 * one item two ways). `roleWeights.ts` owns the coefficients, the class gate and the haste rule;
 * the two functions below are thin shims that name the focus each column reads.
 *
 * `ownedHaste` is the haste percentage this character ALREADY WEARS — worn haste does not STACK in
 * this game, so an item's haste is credited only ABOVE it (`roleValue`'s rule). The view reads it
 * off the ownership join's EQUIPPED rows and nothing else (fork decision, kaltinril: *haste should
 * only be EQUIPPED items* — a haste sword in the bank is worn by nobody). 0 or absent is "none
 * worn", so the first haste item is a real upgrade and the score says so.
 *
 * `ignoreHaste` is the chip's EXPLICIT override (fork decision, kaltinril 2026-08-15): drop the
 * haste credit entirely, whatever is worn or not — a player with no dump on this machine who
 * knows they wear a haste item has no other way to say so. It is implemented as an INFINITE owned
 * haste rather than a second flag through the role model, because that is exactly what it means
 * (nothing can be credited above it) and because `roleWeights.ts` stays byte-identical to the plan
 * branch's copy. One consequence worth naming: a stated haste PENALTY still scores under the chip,
 * where the 2026-08-15 shim dropped the whole term — a stated negative is a stated number (law 1).
 *
 * `classes` is the table's class trio, and it is what keeps BEST honest about WHO is asking (the
 * fork example: *1000 INT means nothing to me as a warrior monk shaman*): a casting stat counts
 * only when a class that USES it is in the picks. Absent means no picks — class-blind, the only
 * honest reading when nobody has said who they are.
 */
export interface GearDerivedOpts {
  ignoreHaste?: boolean
  ownedHaste?: number
  classes?: readonly ClassAbbr[]
}

/** The role model's context for these knobs — the chip is an infinite owned haste, see above. */
function roleContext(opts: GearDerivedOpts): RoleContext {
  return {
    ownedHaste: opts.ignoreHaste === true ? Number.POSITIVE_INFINITY : opts.ownedHaste,
    classes: opts.classes
  }
}

/**
 * A score, or ABSENT when the item states none of the inputs the focus reads (law 1, both
 * directions — the same rule `gearEffectiveHp` and `gearRatio` follow). `roleValue` answers `0`
 * for "nothing stated" AND for stats that net to zero (a +5 and a -5), so absence is decided
 * here, off the vector: does the item state ANY key the focus weighs, or a weapon block, or a
 * pool the effective-HP term reads?
 */
function roleScore(stats: GearStats, role: GearRole, opts: GearDerivedOpts): number | undefined {
  if (!focusInputs(role).some((k) => stats[k] !== undefined)) return undefined
  return roleValue(stats, role, roleContext(opts))
}

/**
 * What a focus reads off the vector, for the absent-vs-zero decision above: its own stat row, the
 * mana stats the class layer may land on, the weapon block behind the ratio term, the two pools
 * behind effective HP and the saves. LAZY, and memoized on first ask, because of the import cycle
 * stated at the top: `roleStatKeys` must not be called while this module is still evaluating.
 */
const INPUTS = new Map<GearRole, readonly GearStatKey[]>()
function focusInputs(role: GearRole): readonly GearStatKey[] {
  let keys = INPUTS.get(role)
  if (keys === undefined) {
    keys = ['DMG', 'DELAY', 'HP', 'STA', 'INT', 'WIS', ...roleStatKeys(role), ...GEAR_STAT_KEYS.filter((k) => k.startsWith('SV_'))]
    INPUTS.set(role, keys)
  }
  return keys
}

/**
 * EFFECTIVE DAMAGE — the role model's `dps` focus (fork decision, kaltinril 2026-08-15: *the
 * combined total effective increase to damage an item would give*). Heuristic, and it says so in
 * `roleWeights.ts`: the weapon's own output enters ONCE, as the ratio, never as raw DMG beside it.
 */
export function gearEffectiveDamage(stats: GearStats, opts: GearDerivedOpts = {}): number | undefined {
  return roleScore(stats, 'dps', opts)
}

/**
 * BEST-IN-SLOT VALUE — the role model's `balanced` focus, the one that reads everything smally so
 * an item strong on several axes outscores one tall on a single stat (fork decision, kaltinril
 * 2026-08-15: *2 AC 10 STR against 30 AC 2 STA 5 STA 10 MANA — figure out some way to calculate
 * best in slot*). The gesture is unchanged: filter to a slot, sort BEST descending, weigh the top
 * rows by eye.
 */
export function gearBisValue(stats: GearStats, opts: GearDerivedOpts = {}): number | undefined {
  return roleScore(stats, 'balanced', opts)
}
