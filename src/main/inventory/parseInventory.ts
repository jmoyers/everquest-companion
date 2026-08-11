// ============================================================================
// inventory/parseInventory.ts — the FLAT held-counts view, now a facade over the engine.
// ============================================================================
//
// This module used to be the whole inventory story: a line-at-a-time reader that threw
// away everything except "name → how many". The general `/outputfile` engine
// (`src/main/outputs/`) now parses the dump into the deep model, and this file derives the
// same flat map from it.
//
// `parseInventoryText` returns the `HeldCounts` map the old reader returned — the derivation
// rule is written out on `heldCountsFromDump` (shared/outputs/inventory.ts) and pinned against
// the real 295-line dump in tests/outputsInventory.test.mts, which replays the OLD algorithm
// and diffs it key-for-key. The refactor that created this facade changed nothing; JOS-66 then
// made ONE deliberate change, and the test states it as a measured difference rather than
// regenerating the oracle: a `KeyRing` row in a held category (today: `Equipment`) now counts,
// because that table is a storage location holding real copies and a reporter's Plane of Sky
// quest items live there and nowhere else. Everything about the `Location` table is unchanged.
//
// A caller that wants the deep model (sockets, bags, bank, keyring, tiers) imports
// `loadInventoryDump` from `../outputs` instead. This flat view is not the substrate; it is
// one derived projection of it.

import { findOutputFile, inventoryHeldCounts, loadInventoryDump } from '../outputs'
import { heldCountsFromDump } from '../../shared/outputs/inventory'
import { resolveInventoryBaseline, storagesCoveredBy } from '../../shared/outputs/baseline'
import type { InventorySource } from '../../shared/outputs/baseline'
import type { HeldCounts } from '../../shared/types'

/**
 * EQ's `/outputfile inventory` writes a tab-separated `<Character>_<server>-Inventory.txt`
 * whose first table is `Location \t Name \t ID \t Count \t Slots` (equipped, bag contents,
 * bank, depot, and every item's slots), followed by a `KeyRing` table.
 *
 * Held counts fold the ITEM table only, keyed by the raw lowercased name; `+N` variants are
 * folded onto the counting key downstream by `reconcile`.
 */
export function parseInventoryText(text: string): HeldCounts {
  return inventoryHeldCounts(text)
}

export interface InventoryLoadResult {
  path: string
  counts: HeldCounts
  loadedAt: string
  /** Exactly what gets persisted as `ProgressState.inventorySource` — path, mtime, baseline. */
  source: InventorySource
}

/** Find the newest `*-Inventory.txt` for the given character (or any). */
export function findInventoryFile(characterName?: string, server?: string): string | null {
  return findOutputFile('inventory', characterName, server)
}

/**
 * The active character's newest dump, as held counts, WITH the instant it was generated.
 *
 * ONE READ PATH (JOS-44). This used to do its own find + readFile + stat beside the engine's;
 * now it is `loadInventoryDump` (the registry's find + mtime + parse) with the compatibility
 * derivation applied on top, so "which file" and "how old" can never disagree with what the
 * Exaltations tab and the freshness line are saying. Byte-identical by construction:
 * `heldCountsFromDump` is exactly what `inventoryHeldCounts` applies to the same parsed dump.
 *
 * THE GENERATION INSTANT (JOS-128) is resolved here, at the one place a dump becomes the model,
 * and persisted beside the counts. `writtenAt` is INJECTED rather than imported: the log's export
 * receipts live in a module behind the pipeline, and this file is the fs/parse layer that tests
 * drive without one. Omit it and it falls back to mtime, which is the same answer a log with no
 * receipt gives.
 *
 * IT IS A RECORD, NOT A RESET (JOS-141). The instant used to be the point the held-count model
 * reset to and accumulated from; the owner reverted that on 2026-08-09, because a dump only
 * covers what was open when it was written and the reset was eating banked Sky items. Nothing in
 * the counting path reads `generatedAt` or `storagesCovered` any more (the combination rule is
 * renderer/features/inventory/reconcile.ts, and it is fully additive). They are still written
 * because they are true, cheap, and the honest answer to how old this dump is.
 */
export function loadInventory(
  characterName?: string,
  server?: string,
  writtenAt: (file: string) => number | null = () => null
): InventoryLoadResult | null {
  const loaded = loadInventoryDump(characterName, server)
  if (!loaded) return null
  const baseline = resolveInventoryBaseline(loaded.path, loaded.loadedAt, writtenAt)
  const source: InventorySource = {
    path: loaded.path,
    loadedAt: loaded.loadedAt,
    ...(baseline ? { generatedAt: baseline.ts, generatedFrom: baseline.source } : {}),
    // A dump is an instant AND a scope: which storages it actually spoke about (JOS-128, on the
    // JOS-132 spike's finding that some are written only conditionally — which is the evidence
    // that later sank the reset, JOS-141).
    storagesCovered: storagesCoveredBy(loaded.dump)
  }
  return {
    path: loaded.path,
    counts: heldCountsFromDump(loaded.dump),
    loadedAt: loaded.loadedAt,
    source
  }
}
