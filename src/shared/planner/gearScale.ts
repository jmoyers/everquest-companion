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

/** A weighted term: the stated value times its weight, or absent when the item stated none. */
function term(value: number | undefined, weight: number): number | undefined {
  return value === undefined ? undefined : value * weight
}

/** Sum the stated terms, to one decimal — or ABSENT when the item stated none of them (law 1). */
function weightedSum(components: readonly (number | undefined)[]): number | undefined {
  const stated = components.filter((v): v is number => v !== undefined)
  if (stated.length === 0) return undefined
  return Math.round(stated.reduce((a, b) => a + b, 0) * 10) / 10
}

/**
 * The knobs a derived score takes (user asks, 2026-08-15): `ignoreHaste` drops the HASTE term from
 * the damage score — worn haste does not STACK in this game, so a player who already wears a haste
 * item gains nothing from a second one, and a score that kept crediting it would rank every haste
 * weapon over genuinely stronger swaps (measured on the live table: a 41% haste sword led EFF DMG
 * at 39.0, ~33 of it the haste term). An OPTION rather than a removal, because the FIRST haste
 * item is a real upgrade and the score should be able to say so.
 *
 * `classes` is the table's class trio, and it is what keeps BEST honest about WHO is asking (the
 * user's own example: *1000 INT means nothing to me as a warrior monk shaman*): a casting stat
 * counts only when a class that USES it is in the picks. Absent means no picks — class-blind, the
 * only honest reading when nobody has said who they are.
 */
export interface GearDerivedOpts {
  ignoreHaste?: boolean
  classes?: readonly ClassAbbr[]
}

// WHO USES WHAT, stated once. The vocabulary is `classCombo.ts`'s sixteen; the split is the game's
// own: INT casters, WIS casters (hybrids included on both sides), everyone who has a mana pool at
// all, and the two classes whose CHA is a mechanic (charm and lull) rather than a shop discount.
const INT_USERS: readonly ClassAbbr[] = ['ENC', 'MAG', 'NEC', 'WIZ', 'SHD']
const WIS_USERS: readonly ClassAbbr[] = ['CLR', 'DRU', 'SHM', 'PAL', 'RNG', 'BST']
const MANA_USERS: readonly ClassAbbr[] = [...INT_USERS, ...WIS_USERS, 'BRD']
const CHA_USERS: readonly ClassAbbr[] = ['ENC', 'BRD']

/** Does anyone in the picks use this stat? No picks = everyone might — the class-blind default. */
function anyUses(picks: readonly ClassAbbr[] | undefined, users: readonly ClassAbbr[]): boolean {
  if (picks === undefined || picks.length === 0) return true
  return picks.some((c) => users.includes(c))
}

/**
 * EFFECTIVE DAMAGE — a compact offense score over the fields the corpus states (user ask,
 * 2026-08-15: *the combined total effective increase to damage an item would give*).
 *
 * DELIBERATELY HEURISTIC, and it says so rather than pretending otherwise: the game exposes no
 * canonical offense value across melee/ranged/caster, so this is one opinionated weighting of the
 * stated numbers, useful for RANKING and meaningless as an absolute. The weapon's own output enters
 * ONCE, as the ratio (DMG/DELAY, the per-tick number) — never as raw DMG beside it, which would
 * count the same swing twice. Undefined means the item states none of the contributing fields —
 * absent is not zero, exactly as every vector key reads.
 */
export function gearEffectiveDamage(stats: GearStats, opts: GearDerivedOpts = {}): number | undefined {
  return weightedSum([
    term(gearRatio(stats), 10),
    term(stats.DMG_BONUS, 0.6),
    term(stats.STR, 0.35),
    term(stats.DEX, 0.3),
    term(stats.ATTACK, 0.45),
    opts.ignoreHaste === true ? undefined : term(stats.HASTE, 0.8),
    term(stats.BACKSTAB, 0.5)
  ])
}

/**
 * BEST-IN-SLOT VALUE — one unified worth-score, so items can be compared ACROSS stats (user ask,
 * 2026-08-15: *2 AC 10 STR against 30 AC 2 STA 5 STA 10 MANA — figure out some way to calculate
 * best in slot*).
 *
 * The intended gesture is: filter to a slot, sort BIS descending, and the top rows are the
 * candidates worth weighing by eye. The weights mix survivability (AC leads, then effective HP),
 * offense (the EFF-damage score above), the pools, the regens (scarce, so heavy per point) and the
 * saves — an item strong on several axes outscores one tall on a single stat, which is the whole
 * point. Same honesty clause as the damage score: a heuristic for ranking, not a stat the game
 * states, and absent when the item states none of the inputs.
 */
export function gearBisValue(stats: GearStats, opts: GearDerivedOpts = {}): number | undefined {
  const saves =
    (stats.SV_FIRE ?? 0) +
    (stats.SV_COLD ?? 0) +
    (stats.SV_MAGIC ?? 0) +
    (stats.SV_DISEASE ?? 0) +
    (stats.SV_POISON ?? 0) +
    (stats.SV_VOID ?? 0)
  // THE CLASS GATE (user ask, 2026-08-15): a stat nobody in the picks can use contributes NOTHING
  // — not a discounted something. 1000 INT on a warrior/monk/shaman trio is bank filler, and a
  // score that gave it even a sliver would still float pure-caster gear up their list.
  const gated = (users: readonly ClassAbbr[], value: number | undefined, weight: number): number | undefined =>
    anyUses(opts.classes, users) ? term(value, weight) : undefined
  return weightedSum([
    term(stats.AC, 1.4),
    term(gearEffectiveHp(stats), 0.55),
    term(gearEffectiveDamage(stats, opts), 1.2),
    gated(MANA_USERS, stats.MP, 0.18),
    term(stats.END, 0.12),
    term(stats.AGI, 0.2),
    gated(WIS_USERS, stats.WIS, 0.2),
    gated(INT_USERS, stats.INT, 0.2),
    gated(CHA_USERS, stats.CHA, 0.05),
    saves !== 0 ? saves * 0.08 : undefined,
    term(stats.HP_REGEN, 0.9),
    gated(MANA_USERS, stats.MANA_REGEN, 0.8)
  ])
}
