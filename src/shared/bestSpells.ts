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
//   * the CAVEATS — these are base figures with no crits, AA or resist in them (spellMetrics.ts's
//     header states them; FOCUS came off that list in JOS-452 and is applied here when a reader has
//     a dump loaded). The per-second figures ARE recast-aware sustained ones (JOS-444):
//     `UnlockSpell.recastMs` rides the wire resolved, so a re-evaluation here divides by the same
//     casting cycle main's own snapshot did. The panel says `directional` once, like its neighbour.
//
// AND AN ABSENT FIGURE IS NEVER A ZERO. A spell with no healing line has no `hps`, which is not the
// same claim as `hps 0`; it is absent from the healing side entirely, and a null column value sorts
// LAST in both directions rather than being read as the worst answer.
//
// ── FOUR TABLES, NOT TWO (JOS-448, owner ask 2026-08-22) ───────────────────────────────────────
//
// "a section for dots / section for dd / section for heal / section for hot". The split is a
// PARTITION OF EACH SIDE ON A FLAG THE METRICS ALREADY STATE — `dot` for damage that arrives per
// tick, `hot` for healing that does, both written by `spellMetricsAt` and neither re-derived here.
// Nothing about the ranking changes: a table is still `{shown, outOfEra}` sorted on one column, and
// the two damage tables rank on `dps` while the two healing ones rank on `hps`.
//
// It is a real question rather than a filter for tidiness. A DoT's `dps` is its whole total spread
// over the duration it runs for, so it competes with a nuke on a measure neither spell is played on:
// you cast the nuke again and you do not re-cast the DoT until it drops. Ranking them apart lets
// each list be read the way it is actually used.
//
// A SPELL WITH BOTH A DAMAGE AND A HEALING SIDE IS IN TWO OF THE FOUR, exactly as it was in both
// sections before — one damage table and one healing table, never two of the same colour. A lifetap
// is damage-only before it ever reaches this file (`spellMetricsAt` owns that rule).
//
// ── AND EVERY ROW IS READ AT ITS MOTE RANK (JOS-447, owner ask 2026-08-23) ─────────────────────
//
// "in the table its showing 333 damage rather than the upgraded damage. to decide whether im going
// to use a different spell, i want to compare upgraded damage to the max i have of a different
// spell. then it would be nice to simulate upgrade of a separate spell to understand."
//
// So a row's figures are taken at `max(observed rank, simulated rank)`. The OBSERVED half is
// JOS-446's map, joined by spell LINE (`observedRankRow` strips the numeral, which is the only join
// that works against a catalog that spells ~1,800 of its ~1,900 lines without one). The SIMULATED
// half is the panel's slider, and MAX is what keeps the two honest together: a slider at IV must not
// pull a spell the log has watched you cast at VIII back down to IV.
//
// The arithmetic itself is not here and is not the item engine's either - `shared/spellScale.ts`
// holds it, fitted to the owner's own log, and its header carries the measurement and the two
// places the numbers this file prints will read LOW for a levelled spell.
//
// Pure, node-tested (tests/bestSpells.test.mts), RELATIVE value imports — the mobSearch precedent.

import { aeHits, aeMaxTargets, aoeAssumptionLabel, isAeTargetType } from './aoeSpells'
import type { ClassAbbr } from './classCombo'
import { comboClassSet, type ComboClasses, type LevelUnlockData, type UnlockSpell } from './levelUnlocks'
import { spellMetricsAt, type SpellMetrics } from './spellMetrics'
import { observedRankRow, type ObservedSpellRanksSnap } from './spellRanks'
import { effectiveSpellRank, normalizeSpellRank } from './spellScale'
import { bestWornFocus, wornFocusLabel, type FocusKind, type WornFocus } from './wornFocus'

// ── AND EVERY FIGURE WEARS YOUR GEAR SINCE JOS-452 (owner ask 2026-08-23) ──────────────────────
//
// "research focus effects and see if we can simulate - based on what you're wearing. pay attention
// to level range etc."
//
// The fourth overlay, and the same shape as the three before it: the resolution happens elsewhere
// (`shared/wornFocus.ts` owns the qualification test and the level-range decay; main resolves WHICH
// effects are worn off the character's dump) and this file only asks for a number and passes it
// down. Absent means no focus and a byte-identical table.
//
// TWO THINGS ARE DECIDED HERE AND NOWHERE ELSE, both because only this file knows them:
//
//   * THE SPELL'S LEVEL IS ITS GAIN LEVEL, never the level being viewed. `Limit Max Level: 44` is a
//     statement about the spell, so a wizard reading his L18 nuke at 50 still gets the full focus —
//     what decays is a spell GAINED above the cap, not a spell CAST above it. Where a loadout could
//     be more than one class the lowest gain level answers, which is the number every other join in
//     this app already uses for a spell.
//   * THE MARKER IS PER TAB. A damage focus says nothing about the Heal table, so each table carries
//     its own `wornFocus` computed from the rows IN it, and a tab where nothing was focused says
//     nothing at all rather than borrowing the tab next door's percentage.

// ── AND A FIFTH TAB THAT POINTS AT A PACK (JOS-449, owner ask 2026-08-23) ──────────────────────
//
// "lets include rain spells in DD by default. lets also have a separate AOE tab that assumes max
// target count."
//
// TWO TABS BECAUSE THERE ARE TWO QUESTIONS, and one table has never been able to answer both. The
// DD tab is what a spell does to the mob in front of you; AOE is what it does to the pull you just
// gathered. Every other tab here is a PARTITION of the corpus on a flag the metrics already state —
// this one is the same corpus READ AGAIN, at a different hit count, which is why it is the one tab
// whose rows are built by a second fold rather than filtered out of the first.
//
// THE RAINS ARE WHAT MADE IT NECESSARY. The wiki's effect line for a rain states ONE WAVE, so
// `Frost Storm` read 512 damage and ranked ~30th in a wizard's DD table at 50 when it is really
// three waves of 512 and one of the best nukes he can buy. `src/main/data/rainSpells.ts` carries
// the roster and the three instruments behind it; `shared/aoeSpells.ts` carries the arithmetic and
// the target-cap assumption. Neither is re-decided here: a row arrives with `waves` and
// `aeMaxTargets` already resolved main-side, exactly like `recastMs`.
//
// AND THE ASSUMPTION IS VISIBLE (owner ruling). `BestSpells.aoeTargets` is the marker the panel
// prints — computed from the rows actually in force, not from the constant, so a reader whose
// client states a spell its own cap sees the count that was really used.
//
// A SPELL CAN THEREFORE BE IN THREE TABS: `Frost Storm` is a DD row at 1,536 and an AOE row at
// 2,048, and a hypothetical area DoT would be a DoT row and an AOE row. That is not double-counting
// — it is the same spell answering two different questions, the way a spell that damages and heals
// has always been in one tab of each side.

/** Which of the eight numbers a table is ranked on. `hits` draws on the AOE tab alone. */
export type BestSpellColumn =
  | 'dps'
  | 'damage'
  | 'damagePerMana'
  | 'hps'
  | 'heal'
  | 'healPerMana'
  | 'mana'
  | 'hits'

/** The four answers the owner asked for in JOS-448, plus JOS-449's area reading. */
export type BestSpellTab = 'dd' | 'dot' | 'aoe' | 'heal' | 'hot'

/**
 * The tabs, in draw order. The one vocabulary: sorts, columns and `bestSpellsAt` all key on it.
 *
 * AOE SITS BETWEEN DoT AND Heal, with the other damage tabs rather than at the end: the reader
 * comparing a nuke against a rain against a pack pull is doing one job, and the healing pair is a
 * different one. It is last of the three so the two single-target answers stay adjacent.
 */
export const TAB_ORDER: readonly BestSpellTab[] = ['dd', 'dot', 'aoe', 'heal', 'hot']

/** Tab labels, single-sourced so a test can pin the words. Game spellings, no em dashes. */
export const TAB_LABEL: Record<BestSpellTab, string> = {
  dd: 'DD',
  dot: 'DoT',
  aoe: 'AOE',
  heal: 'Heal',
  hot: 'HoT'
}

/** Which SIDE of the metrics a tab reads. AOE is a damage tab; there is no area healing reading. */
export const TAB_SIDE: Record<BestSpellTab, 'damage' | 'heal'> = {
  dd: 'damage',
  dot: 'damage',
  aoe: 'damage',
  heal: 'heal',
  hot: 'heal'
}

/**
 * THE COLUMNS EACH TAB DRAWS, and why there are two lists rather than one seven-wide table.
 *
 * The readout lives in the Leveling tab's RIGHT column, which is a third of the row at `lg` and has
 * a 260px floor at the app's own minimum width. Seven numeric columns there is ~30px each, which is
 * not a table anybody can read. Every one of the seven is still present and still sortable — split
 * across the two SIDES, each holding the four that mean something for it. `mana` appears in both
 * because "what does this cost" is the same question either way.
 *
 * The four tabs are two per side, so the column set is the SIDE's: DD and DoT draw the damage four,
 * Heal and HoT the healing four. Splitting the columns further per tab would make the DoT table a
 * different shape from the DD table for no gain, and the tabs are already the thing that separates
 * them.
 *
 * The RANK column is the side's headline (`dps` / `hps`) and is the default sort, which is the
 * owner's ask read literally: best damage spells by dps, best healing by hps.
 */
export const SIDE_COLUMNS: Record<'damage' | 'heal', readonly BestSpellColumn[]> = {
  damage: ['dps', 'damage', 'mana', 'damagePerMana'],
  heal: ['hps', 'heal', 'mana', 'healPerMana']
}

/**
 * THE AOE TAB'S FIVE (owner ask 2026-08-23: "we need another column that talks about hits
 * simulated - so 8 for supernova, 4 for rain"). `hits` sits beside `dmg` because it is the number
 * `dmg` was multiplied by, and only THIS tab draws it: on the single-target tabs the count is 3
 * for a rain and 1 for everything else, which the wave arithmetic already says without a column.
 */
const AOE_COLUMNS: readonly BestSpellColumn[] = ['dps', 'damage', 'hits', 'mana', 'damagePerMana']

/** The columns one tab draws: its side's — plus the hit count on the area reading alone. */
export function tabColumns(tab: BestSpellTab): readonly BestSpellColumn[] {
  return tab === 'aoe' ? AOE_COLUMNS : SIDE_COLUMNS[TAB_SIDE[tab]]
}

/** The column a tab opens on. */
export const TAB_RANK_COLUMN: Record<BestSpellTab, BestSpellColumn> = {
  dd: 'dps',
  dot: 'dps',
  aoe: 'dps',
  heal: 'hps',
  hot: 'hps'
}

/** Header text, single-sourced so a test can pin the words. No em dashes anywhere near a player. */
export const COLUMN_LABEL: Record<BestSpellColumn, string> = {
  dps: 'dps',
  damage: 'dmg',
  damagePerMana: 'dmg/mana',
  hps: 'hps',
  heal: 'heal',
  healPerMana: 'heal/mana',
  mana: 'mana',
  hits: 'hits'
}

/** The longer sentence behind a header, for the tooltip. Stated once, beside the label. */
export const COLUMN_TITLE: Record<BestSpellColumn, string> = {
  dps: 'sustained damage per second over one casting cycle: the cast plus the longer of the duration and the re-use timer',
  damage: 'total base damage at this level, every tick included',
  damagePerMana: 'total damage divided by the mana it costs',
  hps: 'sustained healing per second over one casting cycle: the cast plus the longer of the duration and the re-use timer',
  heal: 'total base healing at this level, every tick included',
  healPerMana: 'total healing divided by the mana it costs',
  mana: 'what the spell costs to cast',
  hits: 'how many times one cast lands at the assumed target count: the number the damage total was multiplied by'
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
  /**
   * The mote rank `metrics` was evaluated at, 0..10 - `max(observed, simulated)` (JOS-447). 0 is the
   * base spell, and it is what every row reads before anybody touches the slider.
   */
  rank: number
  /** The rank the LOG has actually seen this line at, when it has seen one above base. 0 otherwise. */
  observedRank: number
  /**
   * THE TARGET COUNT THIS ROW'S FIGURES ASSUME (JOS-449). 1 on every tab but AOE, where it is the
   * spell's own cap or `DEFAULT_AE_MAX_TARGETS`.
   *
   * On the row rather than on the table because the table is allowed to be MIXED: a reader with a
   * client install gets 4 for a targeted AE and 8 for a PB AE in the same list, and the marker over
   * it (`BestSpells.aoeTargets`) is computed from these.
   */
  targets: number
  /**
   * HOW MANY TIMES ONE CAST LANDS in this reading — the number the damage total was multiplied by,
   * and the `hits` column's cell (owner ask 2026-08-23). Differs from `targets` exactly where the
   * mechanics are odd: a rain over a 4-target pack is 4 hits (the cap), the same rain on one mob is
   * 3 (its waves), Supernova over its 8 is 8. Computed by `spellHitsFor`, the same call the metrics
   * divide by, so the printed count can never drift from the arithmetic.
   */
  hits: number
  /**
   * THE WORN FOCUS THAT ANSWERED (JOS-452) — one entry per SIDE that had one, absent when nothing
   * the player is wearing qualifies for this spell.
   *
   * Both sides can be present at once (a spell that damages and heals is in one tab of each), and
   * an entry names the ITEM as well as the effect, which is the owner's ask read literally: the
   * card has to be able to say which piece of gear did this.
   */
  focus?: BestSpellFocus[]
}

/** One side of one row's figures, and what lifted it. */
export interface BestSpellFocus {
  side: FocusKind
  /** the resolved percent: the middle of the focus's band, after the level rule. Always positive. */
  pct: number
  /** the effect's own name, verbatim ("Improved Damage II") */
  effect: string
  /** the item wearing it, as the dump named it ("Polished Mithril Mask (Exaltation)") */
  item: string
}

/**
 * THE QUESTION THE READOUT IS BEING ASKED, beyond the level: how to sort each of the four tables,
 * and what to assume about mote ranks.
 *
 * One object rather than three parameters because the repo's factoring rule caps a function at
 * four and `bestSpellsAt` already spends three on the data, the loadout and the level. They belong
 * together anyway: all three are the READER's question, where the first three arguments are the
 * world. Only `sorts` is required; a view with no rank fields is the base reading this file gave
 * before JOS-447 existed, byte for byte.
 */
export interface BestSpellsView {
  sorts: Record<BestSpellTab, BestSpellSort>
  /** JOS-446's observed-rank map, joined by spell line key. Null before hydration, which is base. */
  observed?: ObservedSpellRanksSnap | null
  /**
   * The panel's simulate slider, 0..10. Every row is lifted to AT LEAST this rank; a row already
   * above it keeps its own (`effectiveSpellRank`), which is the owner's ask read literally.
   */
  simulate?: number
  /**
   * THE FOCUS EFFECTS THE CHARACTER IS WEARING (JOS-452), resolved main-side off their newest
   * `/outputfile inventory` dump and handed in whole. Absent or empty is the base reading this file
   * gave before JOS-452 existed, figure for figure.
   */
  focus?: readonly WornFocus[]
}

/** One tab's table, split the way `UnlockList` splits a level list. */
export interface BestSpellsTable {
  /** in-era and unknown, already sorted - what the table draws. */
  shown: BestSpellRow[]
  /** positively out of era, same sort - what the disclosure holds. */
  outOfEra: BestSpellRow[]
  /**
   * THIS TAB'S VISIBLE FOCUS MARKER (JOS-452), already worded: `worn +11%`, or the range where the
   * rows in it were focused by different amounts. Null when nothing in this table was focused at
   * all, which is what keeps the marker off a tab it has nothing to say about.
   */
  wornFocus: string | null
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
  /** One table per tab, always all five - an empty tab is an honest answer, never a missing one. */
  tabs: Record<BestSpellTab, BestSpellsTable>
  /**
   * THE AOE TAB'S VISIBLE ASSUMPTION (JOS-449), already worded: `x4 targets`, or the range where a
   * client install gave two different caps to two rows. The panel prints it and decides nothing.
   */
  aoeTargets: string
}

const emptyTable = (): BestSpellsTable => ({ shown: [], outOfEra: [], wornFocus: null })

const emptyTables = (): Record<BestSpellTab, BestSpellsTable> => ({
  dd: emptyTable(),
  dot: emptyTable(),
  aoe: emptyTable(),
  heal: emptyTable(),
  hot: emptyTable()
})

/** The default sort for a tab: its own rank column, best first. */
export function defaultSort(tab: BestSpellTab): BestSpellSort {
  return { column: TAB_RANK_COLUMN[tab], desc: true }
}

/** All five defaults at once - the state a freshly mounted panel opens with. */
export function defaultSorts(): Record<BestSpellTab, BestSpellSort> {
  return {
    dd: defaultSort('dd'),
    dot: defaultSort('dot'),
    aoe: defaultSort('aoe'),
    heal: defaultSort('heal'),
    hot: defaultSort('hot')
  }
}

/**
 * ONE ROW'S VALUE IN ONE COLUMN, or null when the spell states no such figure.
 *
 * Null and zero are different claims and the sort keeps them different (see `compareRows`): a heal
 * with no mana cost is not a heal that costs nothing to a ranking that would then crown it.
 */
export function columnValue(row: BestSpellRow, column: BestSpellColumn): number | null {
  if (column === 'mana') return row.mana
  if (column === 'hits') return row.hits
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
/**
 * HOW MANY TIMES ONE CAST LANDS at a target count: the waves main resolved, against however many
 * targets the reading asks about, under the spell's cap. ONE function because two readers need the
 * same number — the metrics divide by it and the `hits` COLUMN prints it (owner ask 2026-08-23:
 * "we need another column that talks about hits simulated - so 8 for supernova, 4 for rain") — and
 * two expressions would let the printed count drift from the one the figures used.
 */
export function spellHitsFor(spell: UnlockSpell, targets: number): number {
  return aeHits(spell.waves ?? 1, targets, aeMaxTargets(spell.aeMaxTargets))
}

/**
 * THE READING ONE ROW IS TAKEN AT: the mote rank, the target count, and the worn focus percentages
 * already resolved for this spell.
 *
 * One object rather than three trailing arguments, for the repo's four-parameter cap and because it
 * grew a fourth member the day JOS-452 landed. Every field defaults to "the base reading", so
 * `spellMetricsForLevel(spell, level)` is the catalog's own figures with nothing on them.
 */
export interface MetricsReading {
  rank?: number
  targets?: number
  /** the worn DAMAGE focus percent for this spell; absent or 0 is no focus */
  focusDamagePct?: number
  /** the worn HEALING focus percent for this spell; absent or 0 is no focus */
  focusHealPct?: number
}

export function spellMetricsForLevel(
  spell: UnlockSpell,
  level: number,
  reading: MetricsReading = {}
): SpellMetrics | undefined {
  const { rank = 0, targets = 1 } = reading
  const input = {
    effects: spell.hpLines,
    mana: spell.mana,
    castTimeMs: spell.castTimeMs,
    // Already RESOLVED main-side (page over client, a stated 0 blocking the fallback) — see
    // `writeFigures`. Passing it as the input field means `withRecast` never re-asks the client.
    recastMs: spell.recastMs,
    durationMs: spell.durationMs,
    targetType: spell.targetType,
    // The mote rank rides the same input for the same reason: `spellMetricsAt` resolves it once and
    // both of its folds scale by that one number (JOS-447).
    rank,
    // AND HOW MANY TIMES THE CAST LANDS (JOS-449): `targets` 1 gives a rain its three waves and
    // every other spell the single hit it has always had.
    hits: spellHitsFor(spell, targets),
    // AND WHAT YOUR GEAR ADDS (JOS-452), resolved by `rowFocus` below against this same spell so the
    // percentage the figures used and the percentage the marker prints are one number.
    focusDamagePct: reading.focusDamagePct,
    focusHealPct: reading.focusHealPct
  }
  return spellMetricsAt(input, level, spell.clientHp)
}

/**
 * THE FOCUS ENTRIES FOR ONE SPELL, one per side that had a qualifying effect on.
 *
 * The spell's LEVEL here is its gain level, not the level being viewed — see this file's JOS-452
 * note. Everything else the qualification test needs (`spellType`, `durationMs`, `targetType`) is
 * already on the unlock row verbatim, so nothing is re-derived.
 */
export function rowFocus(
  spell: UnlockSpell,
  worn: readonly WornFocus[],
  gainedAt: number
): BestSpellFocus[] {
  if (worn.length === 0) return []
  const facts = {
    name: spell.name,
    level: gainedAt,
    spellType: spell.spellType,
    durationMs: spell.durationMs,
    targetType: spell.targetType
  }
  const out: BestSpellFocus[] = []
  for (const side of ['damage', 'heal'] as const) {
    const hit = bestWornFocus(worn, side, facts)
    if (hit) out.push({ side, pct: hit.pct, effect: hit.focus.effect, item: hit.focus.item })
  }
  return out
}

/** One side's resolved percent out of the row's entries, or undefined when that side had none. */
export function pctOfSide(focus: readonly BestSpellFocus[], side: FocusKind): number | undefined {
  return focus.find((f) => f.side === side)?.pct
}

/**
 * The target count one AOE row's figures assume: the spell's own client cap, or the default.
 *
 * EXPORTED for the search fold next door (JOS-450), which reads the same corpus at the same
 * assumption when the AOE tab is the one asking.
 */
export function targetsFor(spell: UnlockSpell): number {
  return aeMaxTargets(spell.aeMaxTargets)
}

/**
 * The loadout classes that have this spell at or below `level`, and the level it first became
 * theirs. Null when nobody in the loadout owns it yet - the row does not exist at this level.
 *
 * EXPORTED since JOS-450: a search result asks the same question of a spell nobody in the loadout
 * owns, and "is this one of mine yet" must have exactly one answer on this tab.
 */
export function ownedBy(
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

/**
 * THE MANA A ROW PRINTS: the catalog's figure, or null where the page states none.
 *
 * NEVER 0 AS A STAND-IN, and that is the whole of the rule - a `dmg/mana` ranking handed a zero
 * cost would crown a spell whose price the wiki simply did not record. One function since JOS-450,
 * because the search fold builds rows of the same shape and a second ternary is a second answer.
 */
export function catalogMana(spell: UnlockSpell): number | null {
  return typeof spell.mana === 'number' && spell.mana > 0 ? spell.mana : null
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
function ownedRows(
  data: LevelUnlockData,
  want: ReadonlySet<string>,
  level: number,
  fold: RowFold
): BestSpellRow[] {
  const view = fold.view
  const simulate = normalizeSpellRank(view.simulate)
  const byName = new Map<string, BestSpellRow>()
  for (const spell of data.spells) {
    // THE AREA READING IS A DIFFERENT CORPUS, not a filter applied later: a spell that hits one
    // creature has no max-target figure at all, and giving it one would put every nuke in the game
    // in a tab about pulls.
    if (fold.area && !isAeTargetType(spell.targetType)) continue
    const owned = ownedBy(spell, want, level)
    if (!owned) continue
    const key = spell.name.toLowerCase()
    const seen = byName.get(key)
    if (seen) {
      mergeOwned(seen, owned)
      continue
    }
    const row = buildRow(spell, { level, simulate, fold }, owned)
    if (row) byName.set(key, row)
  }
  return [...byName.values()]
}

/** What the fold has already decided by the time one row is built. */
interface RowContext {
  level: number
  simulate: number
  fold: RowFold
}

/**
 * ONE ROW, at every multiplier this readout knows about: the mote rank, the target count and the
 * worn focus. Null when the spell has no figures at this level, which is when it has no row.
 *
 * Split out of `ownedRows` when JOS-452's focus resolution took that loop past the lint config's
 * complexity ceiling — the loop decides WHICH spells are rows and this decides what one row SAYS.
 */
function buildRow(
  spell: UnlockSpell,
  ctx: RowContext,
  owned: { classes: ClassAbbr[]; gainedAt: number }
): BestSpellRow | null {
  const view = ctx.fold.view
  // JOS-446's map is keyed by spell LINE, so the join is the display name and `observedRankRow`
  // strips the numeral - the catalog spells ~1,800 of its rows with no numeral at all.
  const observedRank = normalizeSpellRank(observedRankRow(view.observed, spell.name)?.rank)
  const rank = effectiveSpellRank(observedRank, ctx.simulate)
  const targets = ctx.fold.area ? targetsFor(spell) : 1
  const focus = rowFocus(spell, view.focus ?? [], owned.gainedAt)
  const metrics = spellMetricsForLevel(spell, ctx.level, {
    rank,
    targets,
    focusDamagePct: pctOfSide(focus, 'damage'),
    focusHealPct: pctOfSide(focus, 'heal')
  })
  if (!metrics) return null
  return {
    name: spell.name,
    gainedAt: owned.gainedAt,
    classes: owned.classes,
    mana: catalogMana(spell),
    metrics,
    outOfEra: spell.outOfEra === true,
    rank,
    observedRank,
    targets,
    hits: spellHitsFor(spell, targets),
    ...(focus.length > 0 ? { focus } : {})
  }
}

/**
 * WHICH READING A FOLD IS TAKING. One object rather than a fifth parameter, for the repo's
 * four-argument cap and because the two fields really are one thought: what question is being asked
 * of the corpus.
 */
interface RowFold {
  view: BestSpellsView
  /** True for the AOE reading: AE-shaped spells only, each figured at its own max target count. */
  area: boolean
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

/**
 * The same sort the table applies, exported so a caller can re-rank without rebuilding the rows.
 *
 * GENERIC since JOS-450 so a WIDER row keeps its own type through the sort: a search result is a
 * `BestSpellRow` plus its class-level chips, and a sort that handed back the narrow row would make
 * the caller cast the chips back on.
 */
export function sortBestSpells<T extends BestSpellRow>(rows: readonly T[], sort: BestSpellSort): T[] {
  return [...rows].sort((a, b) => compareRows(a, b, sort))
}

/**
 * WHICH TAB A SPELL BELONGS IN, asked once per tab per row.
 *
 * The presence of the SIDE's total decides whether the row exists at all, and the side's over-time
 * flag decides which of that side's two tabs holds it. The flag is read POSITIVELY on the tick
 * tables and as "not true" on the instant ones, so a metrics record that states nothing lands in DD
 * or Heal rather than vanishing between the two - the same reading `outOfEra` gets everywhere in
 * this app (silence is not a verdict, law 1).
 */
const TAB_MEMBER: Record<BestSpellTab, (m: SpellMetrics) => boolean> = {
  dd: (m) => m.damage !== undefined && m.dot !== true,
  dot: (m) => m.damage !== undefined && m.dot === true,
  // AOE IS NOT SPLIT ON THE OVER-TIME FLAG, and that is deliberate rather than an oversight: the
  // shape test that puts a row in this tab has already happened (`ownedRows` builds a different
  // corpus for it), and splitting eleven area spells into two tabs of five would spend a tab to
  // separate lists nobody reads apart. The row still marks itself `over Ns` in its tooltip.
  aoe: (m) => m.damage !== undefined,
  heal: (m) => m.heal !== undefined && m.hot !== true,
  hot: (m) => m.heal !== undefined && m.hot === true
}

/**
 * Does one metrics record belong in one tab? The membership table above, as the one function two
 * folds ask (JOS-450 added the second: the whole-catalog search answers on the tab in front of the
 * reader, and it must place a row exactly where the ranked table would have).
 */
export function spellInTab(tab: BestSpellTab, metrics: SpellMetrics): boolean {
  return TAB_MEMBER[tab](metrics)
}

/**
 * One tab's rows, split by the era rule and sorted, with the tab's own focus marker.
 *
 * The marker reads only THIS TAB'S SIDE and only the rows that ended up here — the `aoeTargets`
 * arrangement one function over, and for the same reason: a caption computed from anything but the
 * rows in force is a caption that can state a number the table did not use. Rows behind the era
 * disclosure count, because they are still in the table.
 */
function tableOf(
  rows: readonly BestSpellRow[],
  tab: BestSpellTab,
  sort: BestSpellSort
): BestSpellsTable {
  const has = TAB_MEMBER[tab]
  const side = TAB_SIDE[tab]
  const shown: BestSpellRow[] = []
  const outOfEra: BestSpellRow[] = []
  const pcts: number[] = []
  for (const row of rows) {
    if (!has(row.metrics)) continue
    ;(row.outOfEra ? outOfEra : shown).push(row)
    const pct = pctOfSide(row.focus ?? [], side)
    if (pct !== undefined) pcts.push(pct)
  }
  return {
    shown: sortBestSpells(shown, sort),
    outOfEra: sortBestSpells(outOfEra, sort),
    wornFocus: wornFocusLabel(pcts)
  }
}

/**
 * THE WHOLE READOUT. Pure over the dataset, the loadout, the level and the four sorts - so the panel
 * re-ranks by calling this again and nothing is cached that could disagree with what is drawn.
 *
 * A spell that both damages and heals appears in one DAMAGE tab AND one HEALING tab, which is the
 * honest answer: it really is a candidate for either job. It can never be in both tabs of one side,
 * because a side's over-time flag is one boolean. A lifetap reaches only the damage tabs, because
 * `spellMetricsAt` already refuses to read the caster's own recovery as healing (its header says
 * why).
 */
export function bestSpellsAt(
  data: LevelUnlockData,
  combo: ComboClasses,
  level: number,
  view: BestSpellsView
): BestSpells {
  const classes = comboClassSet(combo)
  const base = { level, classes, ambiguous: combo.ambiguous }
  if (classes.length === 0 || !Number.isFinite(level)) {
    return { ...base, classes: [], tabs: emptyTables(), aoeTargets: aoeAssumptionLabel([]) }
  }
  const want = new Set<string>(classes)
  const rows = ownedRows(data, want, level, { view, area: false })
  // THE SECOND FOLD (JOS-449), over the AE-shaped spells only. It costs what the first costs on
  // ~11% of the corpus, and it is a second fold rather than a second metrics field on one row
  // because everything downstream - `columnValue`, `compareRows`, the panel's cells - then reads a
  // row's figures the same way whichever tab drew it.
  const areaRows = ownedRows(data, want, level, { view, area: true })
  const tabs = emptyTables()
  for (const tab of TAB_ORDER) {
    tabs[tab] = tableOf(tab === 'aoe' ? areaRows : rows, tab, view.sorts[tab])
  }
  const aoeTargets = aoeAssumptionLabel(
    [...tabs.aoe.shown, ...tabs.aoe.outOfEra].map((r) => r.targets)
  )
  return { ...base, tabs, aoeTargets }
}
