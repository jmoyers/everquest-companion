// IPC: the CHARACTER SHEET's door (JOS-45) — the armory grid, the gear sum, and the carry-all.
//
// IT WAS GATED, AND SINCE JOS-327 IT IS NOT. This handler used to be registered only when
// `UNRELEASED` said so (src/main/unreleased.ts) — dev builds, or an explicit `EQ_UNRELEASED=1` —
// because the surface had not passed the owner's review gate; in a packaged build the channel did
// not exist and `window.eq.characterSheet()` rejected with Electron's own "No handler registered".
// The owner released the tab (2026-08-13) as the gear area's last face, so the registration is
// unconditional now and the promise the gate protected is simply no longer being made. What did
// NOT change is the file boundary below, or the shape of the answer.
//
// It lives in its own file rather than in `character.ts` because that domain is the ACTIVE
// CHARACTER (log tail, EQ dir, progress). It stayed its own file after the gate came off because
// the reason had always been two reasons: a gate wants its own registration site, and a handler
// that inlines an 8.6 MB item corpus wants to be readable on its own.
//
// WHY MAIN DOES THE JOIN. `items.json` is 8.6 MB and already inlined in this bundle (itemLookup.ts
// owns the import; ipc/planner.ts imports the same module so it is inlined exactly once). Shipping
// the corpus to the renderer to sum twenty-two items would be absurd, so main reads the dump,
// looks each worn item up, sums the blocks and answers with one small object — the same division
// of labour `planner:inventory` already uses.
//
// NOT CACHED, for the same reason `planner:inventory` is not: the dump is a file the player
// rewrites mid-session on purpose, and a cache would hand the renderer the answer from before
// they typed the command. No dump ⇒ `null`, which is the instructions card, never an error.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { carryAll } from '../../shared/carryAll'
import {
  sheetCells,
  sumGear,
  type CharacterSheet,
  type SheetCell,
  type SheetCellView,
  type SheetItemView,
  type WornItemBlock
} from '../../shared/characterSheet'
import { loadInventoryDump } from '../outputs'
import { getActiveCharacter } from '../session'
import { buildItemDbIndex, itemKey, type ItemDbEntry, type ItemDbFile } from '../itemsDb'
// The COMMITTED wiki item database — the same module itemLookup.ts imports, so the JSON is
// inlined into the main bundle exactly once.
import itemsJson from '../data/items.json'

let index: Map<string, ItemDbEntry> | null = null

/** The name→record index, built on first use and kept for the process's life (planner precedent). */
function itemIndex(): Map<string, ItemDbEntry> {
  index ??= buildItemDbIndex(itemsJson as unknown as ItemDbFile)
  return index
}

/** One cell's item, joined to the committed DB. A miss is RECORDED, never smoothed over (law 12). */
function joinCell(cell: SheetCell): SheetCellView {
  if (!cell.item) return { ...cell, item: null }
  const record = itemIndex().get(itemKey(cell.item.baseName))
  const item: SheetItemView = { ...cell.item, known: record !== undefined }
  if (record?.iconId !== undefined) item.iconId = record.iconId
  return { ...cell, item }
}

/**
 * A joined cell, as the gear sum reads it: the DB's block and the ` +N` the dump's name stated.
 *
 * BOTH HALVES, ALWAYS (JOS-416). The tier travels with the block because `sumGear` scales by it —
 * this handler states what is worn and at what level, and the shared fold owns the arithmetic. An
 * empty cell or an item the corpus does not know contributes no block; the sum counts it.
 */
function wornOf(cell: SheetCellView): WornItemBlock {
  if (!cell.item) return {}
  return { tier: cell.item.tier, block: itemIndex().get(itemKey(cell.item.baseName))?.stats }
}

export function registerCharacterSheetIpc(): void {
  ipcMain.handle(IPC.characterSheet, (): CharacterSheet | null => {
    const character = getActiveCharacter()
    const loaded = loadInventoryDump(character?.name, character?.server)
    if (!loaded) return null

    const { cells, unplaced } = sheetCells(loaded.dump)
    const joined = cells.map(joinCell)
    const joinedUnplaced = unplaced.map(joinCell)
    // Only the cells that hold something feed the sum — an empty slot is not an unknown item.
    const worn = [...joined, ...joinedUnplaced].filter((c) => c.item !== null)

    return {
      path: loaded.path,
      loadedAt: loaded.loadedAt,
      cells: joined,
      unplaced: joinedUnplaced,
      totals: sumGear(worn.map(wornOf)),
      // …and the SAME parse, flattened (JOS-327). No DB join and no second read of the file: the
      // ledger the carry-all table draws is by construction the same bytes the grid above it drew.
      carry: carryAll(loaded.dump)
    }
  })
}
