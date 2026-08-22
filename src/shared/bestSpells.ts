// WHAT IS MY BEST SPELL RIGHT NOW — the per-level efficiency ranking behind the Leveling tab's
// right-hand readout (JOS-445, owner ask 2026-08-22).
//
// "New at this level" answers what a level GAVE you. This answers the question a player actually has
// in front of a spell bar: of everything I already own, which one should I be casting? Same corpus,
// same joins, one different rule — and that rule is the whole of this file:
//
//   THE FIGURES ARE READ AT THE LEVEL BEING VIEWED, NOT AT THE LEVEL THE SPELL WAS GAINED.
//
// `UnlockSpell.metrics` is a snapshot at the gain level, which is the right number for an unlock
// card and the wrong one here: the wiki states `Garrison's Mighty Mana Shock` as
// `Decrease Hitpoints by 272 (L18) to 333 (L34)`, so a wizard reading his L18 nuke at 35 is holding
// 333 damage, not 272, and a table that ranked him on 272 would sell him the wrong spell. So the
// unlock dataset carries the LINES as well as the snapshot (`UnlockSpell.hpLines` / `clientHp`,
// JOS-445) and this file re-evaluates them through the same `spellMetricsAt` main used.
//
// THE CORPUS IS THE UNLOCK FOLD'S, DELIBERATELY. Rows are every spell any class in the loadout has
// gained AT OR BELOW the viewed level, taken from the same `(class, level)` pairs `unlocksAtLevel`
// reads (`shared/spellLevels.ts` parsed them once, main-side). Re-deriving class placement from the
// wiki's `classes` prose would be a second parser for a sentence this repo already parses, and the
// two would drift the first time a correction landed on one of them.
//
// WHAT IT INHERITS WITHOUT RE-DECIDING:
//   * the ERA FOLD — `UnlockSpell.outOfEra` is `true` or absent, and a positive verdict goes to the
//     side's `outOfEra` list for the caller to put behind a disclosure. Silence is not a verdict
//     (law 1): a spell the sidecar never answered for is shown plainly, exactly as UnlockList does.
//   * the LOADOUT RULES — `comboClassSet` is the queried set, an unresolved slot only widens it, and
//     an unknown loadout answers empty rather than ranking the whole game.
//   * the CAVEATS — these are base figures with no crits, focus, AA or resist in them
//     (spellMetrics.ts's header states them). The per-second figures ARE recast-aware sustained
//     ones (JOS-444): `UnlockSpell.recastMs` rides the wire resolved, so a re-evaluation here
//     divides by the same casting cycle main's own snapshot did. The panel says `directional`
//     once, like its neighbour.
//
// AND AN ABSENT FIGURE IS NEVER A ZERO. A spell with no healing line has no `hps`, which is not the
// same claim as `hps 0`; it is absent from the healing side entirely, and a null column value sorts
// LAST in both directions rather than being read as the worst answer.
//
// Pure, node-tested (tests/bestSpells.test.mts), RELATIVE value imports — the mobSearch precedent.

import type { ClassAbbr } from './classCombo'
import { comboClassSet, type ComboClasses, type LevelUnlockData, type UnlockSpell } from './levelUnlocks'
import { spellMetricsAt, type SpellMetrics } from './spellMetrics'

/** Which of the seven numbers a table is ranked on. */
export type BestSpellColumn =
  | 'dps'
  | 'damage'
  | 'damagePerMana'
  | 'hps'
  | 'heal'
  | 'healPerMana'
  | 'mana'

/** The two answers the owner asked for: best damage spells, best healing spells. */
export type BestSpellSide = 'damage' | 'heal'

/**
 * THE COLUMNS EACH SIDE DRAWS, and why there are two lists rather than one seven-wide table.
 *
 * The readout lives in the Leveling tab's RIGHT column, which is a third of the row at `lg` and has
 * a 260px floor at the app's own minimum width. Seven numeric columns there is ~30px each, which is
 * not a table anybody can read. Every one of the seven is still present and still sortable — split
 * across the two sides, each holding the four that mean something for it. `mana` appears in both
 * because "what does this cost" is the same question on either side.
 *
 * The RANK column is the side's headline (`dps` / `hps`) and is the default sort, which is the
 * owner's ask read literally: best damage spells by dps, best healing by hps.
 */
export const SIDE_COLUMNS: Record<BestSpellSide, readonly BestSpellColumn[]> = {
  damage: ['dps', 'damage', 'mana', 'damagePerMana'],
  heal: ['hps', 'heal', 'mana', 'healPerMana']
}

/** The column a side opens on. */
export const SIDE_RANK_COLUMN: Record<BestSpellSide, BestSpellColumn> = { damage: 'dps', heal: 'hps' }

/** Header text, single-sourced so a test can pin the words. No em dashes anywhere near a player. */
export const COLUMN_LABEL: Record<BestSpellColumn, string> = {
  dps: 'dps',
  damage: 'dmg',
  damagePerMana: 'dmg/mana',
  hps: 'hps',
  heal: 'heal',
  healPerMana: 'heal/mana',
  mana: 'mana'
}

/** The longer sentence behind a header, for the tooltip. Stated once, beside the label. */
export const COLUMN_TITLE: Record<BestSpellColumn, string> = {
  dps: 'sustained damage per second over one casting cycle: the cast plus the longer of the duration and the re-use timer',
  damage: 'total base damage at this level, every tick included',
  damagePerMana: 'total damage divided by the mana it costs',
  hps: 'sustained healing per second over one casting cycle: the cast plus the longer of the duration and the re-use timer',
  heal: 'total base healing at this level, every tick included',
  healPerMana: 'total healing divided by the mana it costs',
  mana: 'what the spell costs to cast'
}

/** One ranked spell. `metrics` is read AT THE VIEWED LEVEL - the whole point of the file. */
export interface BestSpellRow {
  name: string
  /** The LOWEST level a class in the loadout gained it at - when it became yours. */
  gainedAt: number
  /** The loadout classes that have it at or below the viewed level, sorted. */
  classes: ClassAbbr[]
  /** The catalog's mana cost, or null when the page states none. Never 0 as a stand-in. */
  mana: number | null
  metrics: SpellMetrics
  /** The wiki badges this spell's page out of era. `false` is a real answer here; absent is not. */
  outOfEra: boolean
}

/** One side of the readout, split the way `UnlockList` splits a level list. */
export interface BestSpellsSide {
  /** in-era and unknown, already sorted - what the table draws. */
  shown: BestSpellRow[]
  /** positively out of era, same sort - what the disclosure holds. */
  outOfEra: BestSpellRow[]
}

/** Which column a side is ranked on, and which way. */
export interface BestSpellSort {
  column: BestSpellColumn
  /** Descending is "best first" for six of the seven; `mana` is the one a reader may flip. */
  desc: boolean
}

/** The whole readout for one level and one loadout. */
export interface BestSpells {
  level: number
  /** the set the ranking ran over (may be empty) */
  classes: ClassAbbr[]
  /** true when the loadout was only narrowed: the rows are an UPPER BOUND, like every other join */
  ambiguous: boolean
  damage: BestSpellsSide
  heal: BestSpellsSide
}

const EMPTY_SIDE: BestSpellsSide = { shown: [], outOfEra: [] }

/** The default sort for a side: its own rank column, best first. */
export function defaultSort(side: BestSpellSide): BestSpellSort {
  return { column: SIDE_RANK_COLUMN[side], desc: true }
}

/**
 * ONE ROW'S VALUE IN ONE COLUMN, or null when the spell states no such figure.
 *
 * Null and zero are different claims and the sort keeps them different (see `compareRows`): a heal
 * with no mana cost is not a heal that costs nothing to a ranking that would then crown it.
 */
export function columnValue(row: BestSpellRow, column: BestSpellColumn): number | null {
  if (column === 'mana') return row.mana
  return row.metrics[column] ?? null
}

/**
 * THE FIGURES FOR ONE CATALOG SPELL AT AN ARBITRARY LEVEL.
 *
 * It calls the SAME `spellMetricsAt` main called, with the SAME two sources in the same order (the
 * wiki's hitpoint lines, then the client's slots as a fallback), which is what makes a row here and
 * an unlock row at the gain level the same arithmetic rather than two derivations that agree today.
 * A spell whose lines never crossed the wire simply has no figures and no row.
 */
export function spellMetricsForLevel(spell: UnlockSpell, level: number): SpellMetrics | undefined {
  const input = {
    effects: spell.hpLines,
    mana: spell.mana,
    castTimeMs: spell.castTimeMs,
    // Already RESOLVED main-side (page over client, a stated 0 blocking the fallback) — see
    // `writeFigures`. Passing it as the input field means `withRecast` never re-asks the client.
    recastMs: spell.recastMs,
    durationMs: spell.durationMs,
    targetType: spell.targetType
  }
  return spellMetricsAt(input, level, spell.clientHp)
}

/**
 * The loadout classes that have this spell at or below `level`, and the level it first became
 * theirs. Null when nobody in the loadout owns it yet - the row does not exist at this level.
 */
function ownedBy(
  spell: UnlockSpell,
  want: ReadonlySet<string>,
  level: number
): { classes: ClassAbbr[]; gainedAt: number } | null {
  const lowest = new Map<ClassAbbr, number>()
  for (const p of spell.at) {
    if (p.level > level || !want.has(p.cls)) continue
    const seen = lowest.get(p.cls)
    if (seen === undefined || p.level < seen) lowest.set(p.cls, p.level)
  }
  if (lowest.size === 0) return null
  return {
    classes: [...lowest.keys()].sort((a, b) => a.localeCompare(b)),
    gainedAt: Math.min(...lowest.values())
  }
}

/** A duplicate wiki page for a spell already in the fold: it can only widen the row, never add one. */
function mergeOwned(row: BestSpellRow, owned: { classes: ClassAbbr[]; gainedAt: number }): void {
  const classes = new Set([...row.classes, ...owned.classes])
  row.classes = [...classes].sort((a, b) => a.localeCompare(b))
  row.gainedAt = Math.min(row.gainedAt, owned.gainedAt)
}

/**
 * Every owned spell that has ANY figure at this level, folded BY NAME.
 *
 * By name for `spellRows`'s reason, unchanged: the wiki genuinely carries a few spells twice, and a
 * duplicate page would put the same spell in the table two rows apart. The first record wins, and
 * a later record of the same name only widens the class list - it is the same spell.
 */
function ownedRows(data: LevelUnlockData, want: ReadonlySet<string>, level: number): BestSpellRow[] {
  const byName = new Map<string, BestSpellRow>()
  for (const spell of data.spells) {
    const owned = ownedBy(spell, want, level)
    if (!owned) continue
    const key = spell.name.toLowerCase()
    const seen = byName.get(key)
    if (seen) {
      mergeOwned(seen, owned)
      continue
    }
    const metrics = spellMetricsForLevel(spell, level)
    if (!metrics) continue
    byName.set(key, {
      name: spell.name,
      gainedAt: owned.gainedAt,
      classes: owned.classes,
      mana: typeof spell.mana === 'number' && spell.mana > 0 ? spell.mana : null,
      metrics,
      outOfEra: spell.outOfEra === true
    })
  }
  return [...byName.values()]
}

/**
 * Two rows compared on one column. NULLS LAST IN BOTH DIRECTIONS, then name ascending.
 *
 * Nulls last is the honest reading of an absent figure and it is also what keeps a flip usable: a
 * reader sorting ascending by `dmg/mana` wants the cheapest spell that HAS a ratio at the top, not
 * a run of spells the catalog states no mana for. Name is the tie-break so the order is total - two
 * spells with the same dps must not swap places when the level ticks.
 */
function compareRows(a: BestSpellRow, b: BestSpellRow, sort: BestSpellSort): number {
  const av = columnValue(a, sort.column)
  const bv = columnValue(b, sort.column)
  if (av === null || bv === null) {
    if (av !== bv) return av === null ? 1 : -1
  } else if (av !== bv) {
    return sort.desc ? bv - av : av - bv
  }
  return a.name.localeCompare(b.name)
}

/** The same sort the table applies, exported so a caller can re-rank without rebuilding the rows. */
export function sortBestSpells(rows: readonly BestSpellRow[], sort: BestSpellSort): BestSpellRow[] {
  return [...rows].sort((a, b) => compareRows(a, b, sort))
}

/** One side's rows, split by the era rule and sorted. `has` says which figure puts a row here. */
function sideOf(
  rows: readonly BestSpellRow[],
  has: (m: SpellMetrics) => boolean,
  sort: BestSpellSort
): BestSpellsSide {
  const shown: BestSpellRow[] = []
  const outOfEra: BestSpellRow[] = []
  for (const row of rows) {
    if (!has(row.metrics)) continue
    ;(row.outOfEra ? outOfEra : shown).push(row)
  }
  return { shown: sortBestSpells(shown, sort), outOfEra: sortBestSpells(outOfEra, sort) }
}

/**
 * THE WHOLE READOUT. Pure over the dataset, the loadout, the level and the two sorts - so the panel
 * re-ranks by calling this again and nothing is cached that could disagree with what is drawn.
 *
 * A spell that both damages and heals appears on BOTH sides, which is the honest answer: it really
 * is a candidate for either job. A lifetap appears on the damage side only, because `spellMetricsAt`
 * already refuses to read the caster's own recovery as healing (its own header states why).
 */
export function bestSpellsAt(
  data: LevelUnlockData,
  combo: ComboClasses,
  level: number,
  sorts: Record<BestSpellSide, BestSpellSort>
): BestSpells {
  const classes = comboClassSet(combo)
  const base = { level, classes, ambiguous: combo.ambiguous }
  if (classes.length === 0 || !Number.isFinite(level)) {
    return { ...base, classes: [], damage: EMPTY_SIDE, heal: EMPTY_SIDE }
  }
  const rows = ownedRows(data, new Set<string>(classes), level)
  return {
    ...base,
    damage: sideOf(rows, (m) => m.damage !== undefined, sorts.damage),
    heal: sideOf(rows, (m) => m.heal !== undefined, sorts.heal)
  }
}
