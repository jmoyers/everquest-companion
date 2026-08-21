// ============================================================================
// shared/characterSheet.ts — the ARMORY LAYOUT and the GEAR SUM (JOS-45).
// ============================================================================
//
// Two pure things a character sheet needs and nothing else has: WHERE each equipped item goes
// on a slot grid, and WHAT the worn items add up to. Types + folds only — no fs, no Electron,
// no React — so both tsconfigs see it and the node runner drives it against the committed
// dump (`tests/characterSheet.test.mts`).
//
// ---------------------------------------------------------------------------
// THE GRID IS A HAND-AUTHORED TABLE (law 12), and it reads the CLIENT's tokens
// ---------------------------------------------------------------------------
// `shared/planner/inventorySlots.ts` already joins the client's `EQUIP_LOCATIONS` to the
// planner's WIKI-derived `EquipSlot`, and it deliberately maps `Any Slot` and `Held` to
// `null` — there is no wiki slot to name. That is right for the planner and WRONG for a
// character sheet: the real dump has TWO `Any Slot` items equipped, and a sheet that renders
// only the eighteen wiki slots would silently stop drawing two things the player is wearing.
//
// So this grid is keyed on the CLIENT token directly. All twenty tokens appear, and the two
// the planner cannot name appear under the client's own spelling.
//
// PAIRED SLOTS ARE ORDINAL, AND THAT IS ALL THEY ARE. `Ear`, `Wrist`, `Fingers` and
// `Any Slot` each occur twice at top level and the file has NO column saying which is left
// (shared/outputs/inventory.ts states this). So a cell claims an OCCURRENCE — "the first
// `Ear` row the client wrote" — and both cells of a pair carry the SAME label. The sheet
// never prints "left"/"right"/"1"/"2", because the file never said.
//
// The column split is the game's own inventory window: eight down the left, eight down the
// right, and the hands/rings/ammo row along the bottom — which is also, conveniently, the
// armory shape. `Held` and the two `Any Slot` cells join the bottom row because they are
// what is left over, not because the client grouped them.
//
// ---------------------------------------------------------------------------
// THE SUM STATES WHAT THE ITEM PAGES STATE, AND NOTHING ELSE
// ---------------------------------------------------------------------------
// Confirmed by the JOS-45 spike (2026-08-06, read out of the shipped client's own string
// table): NO `/outputfile` variant exports character stats, and no AA export exists at all.
// The only honest total is therefore a sum over the WORN items' wiki stat blocks — which is
// why every number this file produces is labelled "from gear" at the surface, and why
// `GearTotals` counts the items it could NOT find rather than quietly totalling 21 of 22.
//
// AND IT READS EACH ITEM AT THE ` +N` THE DUMP SPELLED (JOS-416, owner ruling 2026-08-19 —
// verbatim: *we're not using our algorithm that scales the items based on levels. I think we
// should fix that on our Character tab*). This reverses JOS-327's "keep character totals base
// initially", and the reversal is GENERAL rather than about the stat that reported it: a player
// wearing `Cloak of Flames +5` read `Haste +36%` here while the Gear tab's comparison, the wish
// list and every hover-card delta already read `+41%` off the SAME suffix — and haste was merely
// the visible one, because DEX, AGI, HP and SV FIRE were understated on that one cloak too.
//
// ONE ALGORITHM, NO PER-STAT FORKS. Nothing about upgrade arithmetic is written in this file. Each
// worn item's block goes through `shared/itemUpgrade.ts scaleStatBlock` — the exact port of the
// wiki's own ItemLevelSlider calculator, the same function the gear paths call — at the state
// `upgradeStateForTier` reads off its name, and the sum then folds whatever comes back. A stat this
// repo has never classified is left alone by the SCALER (`upgradeStatClass` defaults to
// `unchanged`), which is one decision in one table rather than a fork per row here. So the
// synthetic `SV VOID` line an upgraded item gains appears in these totals too — it is part of what
// the item reads, not a decoration of the item window.
//
// WHAT THE TIER IS, AND WHAT IT IS NOT: the dump prints ` +5` and stops, so the state is
// `{full: 5, fraction: 0}` and every number here is a FLOOR on what the player actually wears
// (`upgradeStateForTier` argues it, in one place). A name with NO suffix is the base block
// unchanged — not tier 0 arriving by another road, and byte-identically the numbers this panel
// printed before this ticket.
//
// ONE THING IT STILL REFUSES TO DO:
//   * It does not SUM percentage values. Two worn items in the real dump carry Haste (+36%
//     and +21%) and whether worn haste stacks is a game rule no source in this repo states —
//     so percent-valued stats are reported as the individual values the items state, joined,
//     and never added together (law 6: say what the sources cannot say). Those stated values are
//     the SCALED ones now; what is refused is the addition, which no ruling has touched.

import type { CarryAll } from './carryAll'
import type { ItemStat, ItemStatBlock } from './itemStats'
import { statLabel } from './itemStats'
import { scaleStatBlock, upgradeStateForTier } from './itemUpgrade'
import {
  parseItemName,
  PRIMARY_ITEM_SECTION,
  type EquipLocationToken,
  type InventoryDump,
  type InventoryEntry
} from './outputs/inventory'

// ---- the grid ------------------------------------------------------------------------

/** Which of the three columns a cell sits in. */
export type SheetColumn = 'left' | 'right' | 'bottom'

export interface SheetSlotDef {
  /** stable cell id — `ear1`/`ear2` disambiguate the OCCURRENCE, never a side */
  id: string
  /** the client Location token this cell reads */
  token: EquipLocationToken
  /** which occurrence of that token, 0-based, in the order the client wrote them */
  nth: number
  /** what the cell is called on screen — identical for both cells of a pair */
  label: string
  column: SheetColumn
}

/**
 * The twenty-four equipment cells, in render order per column. Measured against the real dump:
 * its twenty-four top-level equipment rows fill these exactly, with nothing left over.
 */
export const SHEET_SLOTS: readonly SheetSlotDef[] = [
  { id: 'ear1', token: 'Ear', nth: 0, label: 'Ear', column: 'left' },
  { id: 'head', token: 'Head', nth: 0, label: 'Head', column: 'left' },
  { id: 'face', token: 'Face', nth: 0, label: 'Face', column: 'left' },
  { id: 'ear2', token: 'Ear', nth: 1, label: 'Ear', column: 'left' },
  { id: 'neck', token: 'Neck', nth: 0, label: 'Neck', column: 'left' },
  { id: 'shoulders', token: 'Shoulders', nth: 0, label: 'Shoulders', column: 'left' },
  { id: 'arms', token: 'Arms', nth: 0, label: 'Arms', column: 'left' },
  { id: 'back', token: 'Back', nth: 0, label: 'Back', column: 'left' },

  { id: 'wrist1', token: 'Wrist', nth: 0, label: 'Wrist', column: 'right' },
  { id: 'wrist2', token: 'Wrist', nth: 1, label: 'Wrist', column: 'right' },
  { id: 'range', token: 'Range', nth: 0, label: 'Range', column: 'right' },
  { id: 'hands', token: 'Hands', nth: 0, label: 'Hands', column: 'right' },
  { id: 'chest', token: 'Chest', nth: 0, label: 'Chest', column: 'right' },
  { id: 'legs', token: 'Legs', nth: 0, label: 'Legs', column: 'right' },
  { id: 'feet', token: 'Feet', nth: 0, label: 'Feet', column: 'right' },
  { id: 'waist', token: 'Waist', nth: 0, label: 'Waist', column: 'right' },

  { id: 'primary', token: 'Primary', nth: 0, label: 'Primary', column: 'bottom' },
  { id: 'secondary', token: 'Secondary', nth: 0, label: 'Secondary', column: 'bottom' },
  { id: 'finger1', token: 'Fingers', nth: 0, label: 'Fingers', column: 'bottom' },
  { id: 'finger2', token: 'Fingers', nth: 1, label: 'Fingers', column: 'bottom' },
  { id: 'ammo', token: 'Ammo', nth: 0, label: 'Ammo', column: 'bottom' },
  { id: 'held', token: 'Held', nth: 0, label: 'Held', column: 'bottom' },
  { id: 'any1', token: 'Any Slot', nth: 0, label: 'Any Slot', column: 'bottom' },
  { id: 'any2', token: 'Any Slot', nth: 1, label: 'Any Slot', column: 'bottom' }
]

/** The cells of one column, in render order. */
export function slotsInColumn(column: SheetColumn): SheetSlotDef[] {
  return SHEET_SLOTS.filter((s) => s.column === column)
}

// ---- what is in a cell ---------------------------------------------------------------

/** One worn item, as the dump states it. */
export interface SheetItem {
  /** the Name column verbatim — keeps ` +N`, `*` and ` (Exaltation)` */
  name: string
  /** the ` +N`/`*`-stripped base name: the join key for the committed item DB */
  baseName: string
  /** the ` +N` item level the name stated; absent means the name carried none, NOT level 0 */
  tier?: number
  /** the dump's ID column */
  itemId: number
  /** the names of the exaltations socketed into this item, as the client spelled them */
  exaltations: string[]
}

/** One cell of the grid: a place, and what is in it. */
export interface SheetCell {
  id: string
  label: string
  column: SheetColumn
  /** the client Location token, verbatim — what the file called this place */
  location: string
  /** null when the row said `Empty`, or when the dump had no row for this cell at all */
  item: SheetItem | null
}

/**
 * A top-level equipment row of the Location table: the thing being worn, not its sockets.
 *
 * The SECTION test is not decoration (JOS-185). The dump can carry more than one item-shaped
 * table, and every one of them feeds held counts — but only `Location` states what is on the
 * character's body. Without this, a row filed in some other table under a slot-shaped token would
 * be drawn as the hat.
 */
function isEquipRow(entry: InventoryEntry): boolean {
  return (
    entry.section === PRIMARY_ITEM_SECTION && entry.path.length === 0 && entry.place.kind === 'equip'
  )
}

/** The `<Item> (Exaltation)` children of a row, in the order the client wrote them. */
function exaltationsOf(entry: InventoryEntry): string[] {
  return entry.children.filter((c) => !c.empty && c.parsedName.exaltation).map((c) => c.parsedName.base)
}

function sheetItem(entry: InventoryEntry): SheetItem {
  const parsed = parseItemName(entry.name)
  const item: SheetItem = {
    name: entry.name,
    baseName: parsed.base,
    itemId: entry.itemId,
    exaltations: exaltationsOf(entry)
  }
  if (parsed.tier !== undefined) item.tier = parsed.tier
  return item
}

/**
 * The dump → the grid, plus anything equipped that the grid has no cell for.
 *
 * `unplaced` exists so a THIRD `Ear` row (or a client token this table has not met) is
 * surfaced instead of dropped — law 1 applies to our own layout too. It is empty for the real
 * dump, and the surface renders it only when it is not.
 */
export function sheetCells(dump: InventoryDump): { cells: SheetCell[]; unplaced: SheetCell[] } {
  const seen = new Map<string, number>()
  const byKey = new Map<string, InventoryEntry>()
  const unplaced: SheetCell[] = []

  // Top level only, and in FILE ORDER — the occurrence index is the only signal the file gives.
  for (const entry of dump.items) {
    if (!isEquipRow(entry)) continue
    const token = entry.place.raw
    const nth = seen.get(token) ?? 0
    seen.set(token, nth + 1)
    const key = `${token}#${String(nth)}`
    if (SHEET_SLOTS.some((s) => s.token === token && s.nth === nth)) byKey.set(key, entry)
    else if (!entry.empty) {
      unplaced.push({ id: key, label: token, column: 'bottom', location: token, item: sheetItem(entry) })
    }
  }

  const cells = SHEET_SLOTS.map((slot): SheetCell => {
    const entry = byKey.get(`${slot.token}#${String(slot.nth)}`)
    return {
      id: slot.id,
      label: slot.label,
      column: slot.column,
      location: slot.token,
      item: entry && !entry.empty ? sheetItem(entry) : null
    }
  })
  return { cells, unplaced }
}

// ---- the transport shape -------------------------------------------------------------
//
// What MAIN serves over `character:sheet`. The committed item DB is inlined in the MAIN
// bundle (8.6 MB), so the join happens there and the renderer receives one small object —
// the same division of labour `planner:inventory` already uses.

/** A worn item with the committed DB's contribution joined in. */
export interface SheetItemView extends SheetItem {
  /** the wiki icon id, when the DB had a record carrying one */
  iconId?: number
  /**
   * False when the committed DB had no record under this name. MEASURED on the real dump:
   * one of twenty-two worn items (`Djarn's Amethyst Ring`, whose wiki page is titled
   * `Djarns Amethyst Ring`) — a genuine cross-source name difference, and law 12 forbids
   * closing it with a matcher. It is surfaced instead: the cell still draws, and the totals
   * count it as unknown.
   */
  known: boolean
}

/** A grid cell, with its item joined. */
export interface SheetCellView extends Omit<SheetCell, 'item'> {
  item: SheetItemView | null
}

/** The whole sheet, as one IPC answer. Null on the wire means "this character has no dump". */
export interface CharacterSheet {
  /** the dump file that was read */
  path: string
  /** the file's mtime: WHEN THE PLAYER dumped, never when we read it */
  loadedAt: string
  cells: SheetCellView[]
  /** equipped rows the grid has no cell for — empty for every dump seen so far */
  unplaced: SheetCellView[]
  totals: GearTotals
  /**
   * EVERYTHING YOU CARRY (JOS-327) — the same dump, flattened: every non-empty row of every
   * table, with its location path and count. See shared/carryAll.ts.
   *
   * IT RIDES THIS ANSWER RATHER THAN A CHANNEL OF ITS OWN, on purpose. Main already has the
   * parsed dump in hand at exactly this moment, the whole ledger is 123 small rows on the
   * owner's real 295-line file, and the sheet and the ledger must never describe two different
   * reads of a file the player rewrites mid-session — one invoke makes that impossible rather
   * than merely unlikely. It needs no item-DB join, so nothing about it costs what the cells cost.
   */
  carry: CarryAll
}

// ---- the gear sum --------------------------------------------------------------------

/** One summed stat: an integer total over the items that stated an integer for it. */
export interface GearStat {
  /** display label ("Strength", "SV Fire") — `statLabel` folds END/ENDURANCE into one row */
  label: string
  total: number
  /** how many worn items contributed */
  from: number
}

/** A stat whose values are NOT addable (percentages): the individual values, never a total. */
export interface GearUnsummed {
  label: string
  values: string[]
}

export interface GearTotals {
  /** summed `AC:` — the one attribute the wiki block stores as a number of its own */
  ac: number
  /** attributes, HP/Mana/Endurance and friends, in the canonical order below */
  stats: GearStat[]
  /** the `SV *` subset, split out the way the game's item window splits it */
  saves: GearStat[]
  /** percent-valued stats, stated not added — see the header */
  unsummed: GearUnsummed[]
  /** worn items whose stat block we had */
  counted: number
  /** worn items the committed DB knew nothing about; their stats are in NO total above */
  unknown: number
}

/**
 * A stat value → an integer, or null when it is not one.
 *
 * The real dump's worn items produce `+9`, `+36%` and a bare `10` (Endurance), so the sign is
 * optional and a trailing `%` DISQUALIFIES the value rather than being stripped — a percentage
 * that fell into an integer total would be the exact lie this function exists to prevent.
 */
export function statInteger(value: string): number | null {
  const m = /^([+-]?\d+)$/.exec(value.trim())
  return m ? Number.parseInt(m[1], 10) : null
}

/** Display order for the summed rows. Anything unlisted keeps source order, after these. */
const STAT_ORDER = [
  'Strength', 'Stamina', 'Agility', 'Dexterity', 'Wisdom', 'Intelligence', 'Charisma',
  'HP', 'Mana', 'Endurance', 'Attack', 'Regen', 'Mana Regen'
]

function orderKey(label: string): number {
  const i = STAT_ORDER.indexOf(label)
  return i === -1 ? STAT_ORDER.length : i
}

/** Fold one item's `{key, value}` rows into the running totals. */
function foldStats(
  rows: readonly ItemStat[],
  sums: Map<string, GearStat>,
  unsummed: Map<string, GearUnsummed>
): void {
  for (const row of rows) {
    const label = statLabel(row.key)
    const n = statInteger(row.value)
    if (n === null) {
      const held = unsummed.get(label) ?? { label, values: [] }
      held.values.push(row.value)
      unsummed.set(label, held)
      continue
    }
    const held = sums.get(label) ?? { label, total: 0, from: 0 }
    held.total += n
    held.from += 1
    sums.set(label, held)
  }
}

function ordered(sums: Map<string, GearStat>): GearStat[] {
  return [...sums.values()].sort((a, b) => orderKey(a.label) - orderKey(b.label) || a.label.localeCompare(b.label))
}

/**
 * One worn item, as the sum needs to read it: the item level its NAME stated, and the committed
 * DB's block behind it.
 *
 * THE TIER IS PART OF THE ARGUMENT ON PURPOSE (JOS-416). This used to be a bare list of blocks, so
 * a caller could sum an upgraded character's gear without ever mentioning the ` +N` — which is
 * exactly the defect the ticket reports. Now a caller cannot state a worn item without stating what
 * state it is worn at, and the scaling happens in here, once.
 */
export interface WornItemBlock {
  /** the ` +N` the dump's name spelled; `undefined` means the name carried none, NOT tier 0 */
  tier?: number | undefined
  /** the committed DB's stat block; `undefined` is an item the DB had nothing for */
  block?: ItemStatBlock | undefined
}

/**
 * What one worn item reads at its own ` +N` — the ONE call into the upgrade algorithm on this path.
 *
 * A DB miss stays a miss (`undefined`), and an item with no suffix goes through the scaler at the
 * base state, which `scaleStatBlock` answers with an equal block (a copy, never a rewrite).
 */
export function wornBlock(worn: WornItemBlock): ItemStatBlock | undefined {
  return worn.block ? scaleStatBlock(worn.block, upgradeStateForTier(worn.tier)) : undefined
}

/**
 * Sum the worn items' stat blocks, each read at its own ` +N` (see the header, and `wornBlock`).
 * A `block` of `undefined` is an item the committed DB had nothing for — counted as `unknown` and
 * contributing to nothing, so the panel can say so out loud.
 */
export function sumGear(worn: readonly WornItemBlock[]): GearTotals {
  const stats = new Map<string, GearStat>()
  const saves = new Map<string, GearStat>()
  const unsummed = new Map<string, GearUnsummed>()
  let ac = 0
  let counted = 0
  let unknown = 0

  for (const item of worn) {
    const block = wornBlock(item)
    if (!block) {
      unknown += 1
      continue
    }
    counted += 1
    ac += block.ac ?? 0
    foldStats(block.stats, stats, unsummed)
    foldStats(block.saves, saves, unsummed)
  }

  return {
    ac,
    stats: ordered(stats),
    saves: [...saves.values()].sort((a, b) => a.label.localeCompare(b.label)),
    unsummed: [...unsummed.values()].sort((a, b) => a.label.localeCompare(b.label)),
    counted,
    unknown
  }
}
