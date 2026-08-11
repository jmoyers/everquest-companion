// ============================================================================
// outputs/baseline.ts — WHEN a dump was generated, and WHAT it covered. RECORDED, NOT A RESET.
// ============================================================================
//
// JOS-128 built this file to answer "since when", because that ticket made a dump load the
// BASELINE: it reset the model to exactly what the dump said and let log-derived loot accumulate
// from the generation instant forward.
//
// JOS-141 TOOK THE RESET BACK, and it is the owner's explicit ruling after field-testing Plane of
// Sky on 2026-08-09. A dump only covers WHAT WAS OPEN WHEN IT WAS GENERATED — the bank only if the
// bank window was up, the hoard likewise — and the file never says which. So resetting to the dump
// deleted banked Sky items the player still owned, every reload, which is a worse and quieter
// failure than the one JOS-128 set out to fix. The combination rule is FULLY ADDITIVE again
// (features/inventory/reconcile.ts owns it): the log accumulates, a dump only ever applies ON TOP,
// and nothing a reload does can lower a count. The accepted cost is stated there, not hidden.
//
// SO WHAT IS THIS FILE FOR NOW? Everything except the reset. The generation instant and the
// coverage set are still RECORDED on `ProgressState.inventorySource` and still worth knowing: they
// are what a freshness line reads, what a storage-scoped rule would need if the owner ever revives
// one, and the honest answer to "how old is this dump". What is GONE is the `isSinceBaseline`
// predicate and every windowed fold that consumed it — an instant nobody compares against is not a
// reset. Still pure (no fs, no Electron), so tests/inventoryBaseline.test.mts drives it under
// plain node.
//
// WHERE THE GENERATION INSTANT COMES FROM — two sources, measured, in this order:
//
//   1. THE LOG, and it is the authoritative one. EQ prints `Outputfile Complete: <file>` when
//      the dump finishes writing; the parser claims it as an `outputFile` event
//      (parseSession.ts). Its timestamp is EQ's own, parsed by the same `parseTs` that stamps
//      every loot row, so a baseline-versus-loot comparison happens inside ONE time base
//      instead of across two clocks. Matching is on the FILE NAME, because
//      `/outputfile inventory [optional filename]` lets the player choose it and the only
//      honest join is against the file we actually read.
//
//   2. THE FILE'S MTIME, as fallback — already carried end to end as `inventorySource.loadedAt`.
//      Measured on the owner's machine (2026-08-09) against the log line for the SAME dump:
//      mtime lands 767 ms after the log stamp, same second, same wall clock. Its failure modes
//      are stated rather than hidden, because a recorded instant that is wrong is silent:
//        * A dump COPIED between machines, restored from a backup, or touched by cloud sync
//          carries the copy time, so the recorded instant is too LATE.
//        * A hand-edited dump gets the same treatment.
//        * mtime is an OS wall clock; a loot `ts` is parsed from a log timestamp that carries
//          no zone, so a DST boundary can slide the two an hour apart in either direction.
//      Under JOS-141 none of these can cost the user an item, because nothing subtracts on the
//      strength of this instant any more. They are the reason it is reported WITH its source
//      (`generatedFrom`) rather than presented as a fact.
//
//   3. THE FILE'S CONTENT: there is no third source. The dump is a header row (Location, Name,
//      ID, Count, Slots), then rows, then the KeyRing table. It carries no date anywhere,
//      verified against the real 295-row dump.
//
// SECOND RESOLUTION. EQ log timestamps have one-second resolution, so both sources are floored to
// the second: an instant carried at higher precision than either clock has would be a false claim,
// and it lets the two sources land on the same number for the same dump (measured above).

import type { ContainerKind, InventoryDump } from './inventory'
import { PRIMARY_ITEM_SECTION } from './inventory'

/** Where a dump's generation instant came from — the log's own receipt, or the file's mtime. */
export type InventoryBaselineSource = 'log' | 'mtime'

/**
 * A STORAGE the dump can speak about. Named here rather than beside `ContainerKind` because it
 * is what gets PERSISTED, and because `storagesCoveredBy` pins the two together with a total
 * map: a container kind added over there is a compile error until it is added here.
 */
export type InventoryStorage = 'equip' | 'general' | 'bank' | 'sharedBank' | 'personalDepot' | 'keyRing'

/** A dump's generation instant, and which of the two sources answered. */
export interface InventoryBaseline {
  /** Epoch ms, floored to the second (see the header). */
  ts: number
  source: InventoryBaselineSource
}

/**
 * What we know about the dump the persisted held counts came from — `ProgressState.inventorySource`.
 *
 * Everything past `loadedAt` is ADDITIVE and OPTIONAL (the `exaltPlans` precedent): a store
 * written before JOS-128 has none of it and every reader defaults. No schema bump and no
 * migration step. Since JOS-141 nothing in the counting path READS these fields — they are a
 * record of the dump we loaded, kept because they are true and cheap, not because a rule needs
 * them.
 */
export interface InventorySource {
  path: string
  /** The file's mtime, ISO. What the freshness line renders. */
  loadedAt: string
  /**
   * Epoch ms the dump was GENERATED, floored to the second. Absent on a pre-JOS-128 store.
   * RECORDED ONLY (JOS-141): no fold is narrowed by it.
   */
  generatedAt?: number
  /** Which of the two sources answered. Absent whenever `generatedAt` is. */
  generatedFrom?: InventoryBaselineSource
  /**
   * WHICH STORAGES THIS BASELINE ACTUALLY SAW (the JOS-132 spike's finding). The dump is an
   * everything-dump in principle, but some storages are written only under conditions the file
   * never states, so a storage MISSING from a dump means "this dump does not say", not "empty".
   */
  storagesCovered?: InventoryStorage[]
}

/** Floor an instant to whole seconds — the resolution EQ log timestamps actually have. */
export function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}

/**
 * Resolve a dump's generation instant: the log's own receipt when we have one for this file,
 * the file's mtime otherwise.
 *
 * `path` is the full path of the dump we read; the log prints only a BASE NAME (EQ writes dumps
 * into the install root), so the join compares base names, case-insensitively — Windows paths
 * are case-insensitive and a player who typed a name in a different case wrote the same file.
 *
 * Returns null only when neither source can answer, which today means an unparseable mtime.
 */
export function resolveInventoryBaseline(
  path: string,
  mtimeIso: string,
  writtenAt: (file: string) => number | null
): InventoryBaseline | null {
  const fromLog = writtenAt(baseName(path))
  if (fromLog !== null) return { ts: floorToSecond(fromLog), source: 'log' }
  const mtime = Date.parse(mtimeIso)
  if (Number.isNaN(mtime)) return null
  return { ts: floorToSecond(mtime), source: 'mtime' }
}

/** The last path segment, for either separator. Dumps live in the install root, so this is the
 *  name the log printed. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

// ----- WHAT the dump covers, AND WHY THE RESET HAD TO GO -----
//
// A dump is an instant AND a scope. The JOS-132 spike found that the inventory dump is an
// everything-dump only in principle: some storages are written only when the game happens to
// have them loaded (the depot when it has been opened, the hoard when its window is), and the
// file says nothing about the difference. So a storage absent from a dump is UNKNOWN, not
// empty, and a viewer that renders absence as "you have none there" is inventing an answer.
//
// THIS IS EXACTLY WHAT SANK THE RESET (JOS-141). A reset reads every absence as a zero, so a dump
// generated with the bank closed told the model the player's banked Sky items were gone. Coverage
// was recorded and could in principle have scoped the reset per storage; the owner was offered
// that and ruled against it, because a rule that resets some storages and not others still turns
// on a distinction the file never states. Additive needs no such distinction: a dump that says
// nothing about the bank simply adds nothing there.
//
// EVIDENCE IS THE ROW, NOT THE ITEM. A bank slot holding `Empty` still proves the bank was
// dumped; an item is not required and would be the wrong test (an empty bank is a real state
// this rule must be able to report). MEASURED against the owner's real dump (2026-08-09): it
// evidences equip, general, bank, sharedBank and keyRing, and carries NOT ONE
// `Personal-Depot<n>` row even though the parser has known that pattern since JOS-44 — which
// is the spike's claim, reproduced.
//
// UNCLASSIFIED BASE TOKENS ARE NOT COVERAGE. A storage whose token this build has never seen
// (the hoard is the open question) parses as `place.kind === 'unknown'`, and claiming coverage
// for a storage we cannot name would be worse than saying nothing. The awaiting-sample law
// applies: when a real dump shows the token, it graduates into `ContainerKind` and lands here
// through the total map below, with no change to this rule.

/** Container kind → the persisted storage name. TOTAL on purpose: a new `ContainerKind` is a
 *  compile error until `InventoryStorage` (shared/types.ts) grows to match. */
const CONTAINER_STORAGE: Record<ContainerKind, InventoryStorage> = {
  general: 'general',
  bank: 'bank',
  sharedBank: 'sharedBank',
  personalDepot: 'personalDepot'
}

/**
 * Which storages this dump actually evidenced, in a stable order.
 *
 * A CONTAINER token is evidence wherever it is filed (JOS-185): the dump can carry more than one
 * item-shaped table now, and a `Personal-Depot1` row proves the depot was dumped whichever table
 * the client put it in. `equip` is the exception and takes the `Location` table alone, for the
 * same reason the character sheet does — what you are WEARING is a claim only that table makes.
 */
export function storagesCoveredBy(dump: InventoryDump): InventoryStorage[] {
  const seen = new Set<InventoryStorage>()
  const walk = (rows: InventoryDump['items']): void => {
    for (const row of rows) {
      if (row.place.kind === 'equip') {
        if (row.section === PRIMARY_ITEM_SECTION) seen.add('equip')
      } else if (row.place.kind === 'container') seen.add(CONTAINER_STORAGE[row.place.container])
      walk(row.children)
    }
  }
  walk(dump.items)
  // A KeyRing SECTION is the evidence, not a keyring row: the header proves the game wrote that
  // table, and an empty keyring is a real state.
  if (dump.sections.includes('KeyRing') || dump.keyRing.length > 0) seen.add('keyRing')
  return STORAGE_ORDER.filter((s) => seen.has(s))
}

/** Reading order: what you are wearing, what you are carrying, then what you have stored. */
const STORAGE_ORDER: readonly InventoryStorage[] = [
  'equip',
  'general',
  'bank',
  'sharedBank',
  'personalDepot',
  'keyRing'
]
