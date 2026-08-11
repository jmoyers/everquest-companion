// ============================================================================
// JOS-128 then JOS-141 — the dump's generation instant is RECORDED, and it is NOT a reset.
// ============================================================================
//
// THE REPORT (v0.14.0, P1EY74): a user deleted an item in game, hit Reload Inventory, and the
// Companion still said they had it. Their theory was that reload ADDS onto previous counts.
// It does not: `setInventory` replaces the persisted map wholesale, and re-reading the dump
// is idempotent. The real mechanism is that nothing ever RESET. The log-derived count is
// "everything this character has ever looted", it can only go up, and the count source that
// consults both takes `max(log, dump)` per item — so the all-time log outvotes the dump that
// no longer lists the item, no matter how many times you reload.
//
// JOS-128 fixed that by making a dump load the BASELINE: reset to the dump, accumulate from its
// generation instant forward. THE OWNER REVERTED IT THE SAME DAY (JOS-141, 2026-08-09) after
// field-testing Plane of Sky. A dump only covers WHAT WAS OPEN WHEN IT WAS GENERATED — the bank
// only if the bank window was up — and a reset reads that silence as zero, so a routine reload
// deleted banked Sky items the player still owned. Offered a storage-scoped reset instead, the
// owner ruled for FULLY ADDITIVE: the log accumulates, a dump only ever applies on top, and the
// deletion-invisibility above is an ACCEPTED tradeoff rather than a bug still open.
//
// WHAT THIS FILE PINS, in the order the feature is built:
//   1. the parser claims `Outputfile Complete: <file>` and nothing near it;
//   2. the outputFiles module folds those receipts, newest per file;
//   3. the generation instant resolves to the LOG's receipt when there is one, the file's mtime
//      when there is not, floored to the second — all of which JOS-141 KEPT;
//   4. THE COMBINATION, which JOS-141 made additive again: a dump adds and never subtracts, so
//      no reload can lower a count, including the two scenarios that decided the ruling;
//   5. which storages a dump actually covered (the JOS-132 spike's finding, and the evidence the
//      reset could not survive).
//
// EVERY LOG LINE HERE IS VERBATIM from the owner's real 116 MB log (both `Outputfile
// Complete:` lines and the `usage:` line are quoted exactly as they appear), and the dump is
// the committed `tests/fixtures/Primitive_freeport-Inventory.txt`. The loot LEDGER is
// synthetic, because a ledger is a list of (ts, item) pairs and the thing under test is the
// combination rule, not the parse — every real-line parse this feature depends on is pinned
// above it.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { OutputFilesModule } from '../src/main/modules/outputFiles'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import {
  floorToSecond,
  resolveInventoryBaseline,
  storagesCoveredBy
} from '../src/shared/outputs/baseline'
import { heldCountsFromDump } from '../src/shared/outputs/inventory'
import { computeHeldCounts } from '../src/renderer/src/features/posky/heldCounts'
import { reconcile } from '../src/renderer/src/features/inventory/reconcile'
import type { CountSource, LootEvent } from '../src/shared/types'

// ---------------------------------------------------------------------------
// 1. The line
// ---------------------------------------------------------------------------

/** Both receipts, verbatim — the only two lines of this shape in the owner's whole log. */
const RECEIPT_AUG_01 = '[Sat Aug 01 13:33:38 2026] Outputfile Complete: Primitive_freeport-Inventory.txt'
const RECEIPT_AUG_06 = '[Thu Aug 06 15:39:12 2026] Outputfile Complete: Primitive_freeport-Inventory.txt'
/** The line the game prints for a MALFORMED command, verbatim. It wrote no file. */
const USAGE_LINE =
  '[Sat Aug 01 13:33:38 2026] usage: /outputfile [achievements | faction | guild | guildbank | guildhall | inventory | missingspells | raid | realestate | recipes [argument] | spellbook ] [optional filename]'

test('the export receipt parses, with the file name the game printed', () => {
  const ev = parseEvent(RECEIPT_AUG_06, 1)
  assert.equal(ev?.kind, 'outputFile')
  assert.equal(ev.kind === 'outputFile' ? ev.file : null, 'Primitive_freeport-Inventory.txt')
  // EQ's own clock, the same parse every loot row's ts goes through.
  assert.equal(ev.ts, new Date(2026, 7, 6, 15, 39, 12).getTime())
})

test('the usage line is not a receipt, and a chat line quoting one cannot become one', () => {
  assert.notEqual(parseEvent(USAGE_LINE, 1)?.kind, 'outputFile')
  // The classifier is anchored at the start of the MESSAGE, so a speaker's name is in the way.
  const chat =
    "[Thu Aug 06 15:39:12 2026] Someone tells you, 'Outputfile Complete: Primitive_freeport-Inventory.txt'"
  assert.notEqual(parseEvent(chat, 1)?.kind, 'outputFile')
})

// ---------------------------------------------------------------------------
// 2. The module that remembers them
// ---------------------------------------------------------------------------

function foldReceipts(lines: readonly string[]): OutputFilesModule {
  const mod = new OutputFilesModule()
  lines.forEach((line, i) => {
    const ev = parseEvent(line, i + 1)
    if (ev) mod.onEvent(ev, false)
  })
  return mod
}

test('the outputFiles module keeps the NEWEST write of each dump', () => {
  const mod = foldReceipts([RECEIPT_AUG_01, RECEIPT_AUG_06])
  assert.equal(
    mod.writtenAt('Primitive_freeport-Inventory.txt'),
    new Date(2026, 7, 6, 15, 39, 12).getTime()
  )
  // A superseded export must never answer for the file now on disk.
  assert.notEqual(mod.writtenAt('Primitive_freeport-Inventory.txt'), new Date(2026, 7, 1, 13, 33, 38).getTime())
  assert.equal(mod.writtenAt('SomeoneElse_freeport-Inventory.txt'), null)
})

test('the lookup takes a full path, and is case-insensitive like the filesystem', () => {
  const mod = foldReceipts([RECEIPT_AUG_06])
  const full = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends\\Primitive_freeport-Inventory.txt'
  assert.equal(mod.writtenAt(full), new Date(2026, 7, 6, 15, 39, 12).getTime())
  assert.equal(mod.writtenAt('primitive_FREEPORT-inventory.TXT'), new Date(2026, 7, 6, 15, 39, 12).getTime())
})

test('a character switch clears the receipts, so one log never answers for another', () => {
  const mod = foldReceipts([RECEIPT_AUG_06])
  mod.reset()
  assert.equal(mod.writtenAt('Primitive_freeport-Inventory.txt'), null)
})

// ---------------------------------------------------------------------------
// 3. Which source answers "when was this generated"
// ---------------------------------------------------------------------------

const DUMP_PATH = 'C:\\EQ\\Primitive_freeport-Inventory.txt'
/** The real dump's real mtime on the owner's machine: 767 ms after the log receipt. */
const REAL_MTIME_ISO = new Date(new Date(2026, 7, 6, 15, 39, 12).getTime() + 767).toISOString()

// KEPT BY JOS-141 in full. The instant is still resolved and still persisted as
// `inventorySource.generatedAt` / `generatedFrom`; what changed is that nothing subtracts on the
// strength of it any more.
test('the LOG receipt wins over mtime, and both floor to the second', () => {
  const mod = foldReceipts([RECEIPT_AUG_06])
  const b = resolveInventoryBaseline(DUMP_PATH, REAL_MTIME_ISO, (f) => mod.writtenAt(f))
  assert.deepEqual(b, { ts: new Date(2026, 7, 6, 15, 39, 12).getTime(), source: 'log' })
})

test('with no receipt for this file, mtime answers and says so', () => {
  const b = resolveInventoryBaseline(DUMP_PATH, REAL_MTIME_ISO, () => null)
  // Floored: the 767 ms of mtime precision EQ log timestamps do not have is dropped, so both
  // sources land on the same instant for the same dump (measured, owner machine 2026-08-09).
  assert.deepEqual(b, { ts: new Date(2026, 7, 6, 15, 39, 12).getTime(), source: 'mtime' })
})

test('an unparseable mtime with no receipt yields no baseline, rather than a guessed one', () => {
  assert.equal(resolveInventoryBaseline(DUMP_PATH, 'not a date', () => null), null)
})

// ---------------------------------------------------------------------------
// 4. THE COMBINATION — a dump ADDS, it never subtracts (JOS-141)
// ---------------------------------------------------------------------------

const DUMP_AT = floorToSecond(new Date(2026, 7, 6, 15, 39, 12).getTime())

function loot(item: string, ts: number, count = 1): LootEvent {
  return { ts, item, source: 'a mob', count }
}

test('the held-count fold is ALL TIME, with no window in it at all', () => {
  // JOS-128 gave this fold a `since` parameter. JOS-141 took it away: a fold narrowed by the dump
  // is the reset wearing a different hat, and the type no longer admits one.
  const ledger: LootEvent[] = [
    loot('Sphinx Claw', DUMP_AT - 3600_000),
    loot('Bone Chips', DUMP_AT + 10_000, 2),
    loot('Sphinx Claw', DUMP_AT + 20_000)
  ]
  assert.deepEqual(computeHeldCounts(ledger), { 'sphinx claw': 2, 'bone chips': 2 })
  assert.equal(computeHeldCounts.length, 1, 'one parameter: the ledger, and nothing to window it by')
})

/** The reconcile the views run, with no quests consuming anything. */
function netFor(
  ledger: LootEvent[],
  inv: Record<string, number>,
  countSource: CountSource
): Record<string, number> {
  return reconcile({
    log: computeHeldCounts(ledger),
    inv,
    lootNames: {},
    countSource,
    turnIns: {},
    quests: []
  }).net
}

test('THE RULING: a dump that does not mention your banked items cannot delete them', () => {
  // The field test that overturned JOS-128, as a case. Two Sphinx Claws sitting in the bank, and
  // a dump generated with the bank window closed: the file lists the one thing that was open. A
  // reset reads the silence as zero and the claws vanish; additive leaves them exactly where the
  // log says they are, and adds the dump's row on top.
  const ledger = [loot('Sphinx Claw', DUMP_AT - 86_400_000, 2)]
  const dumpWithBankClosed = { 'shield of the stalwart seas': 1 }

  for (const source of ['log', 'both'] as const) {
    const net = netFor(ledger, dumpWithBankClosed, source)
    assert.equal(net['sphinx claw'], 2, `${source}: the banked claws survive a reload`)
  }
  assert.equal(
    netFor(ledger, dumpWithBankClosed, 'both')['shield of the stalwart seas'],
    1,
    'and the dump still contributes what it DID see'
  )
})

test('THE ACCEPTED TRADEOFF (P1EY74): an item destroyed in game stays counted', () => {
  // Stated as a pinned expectation rather than left as a surprise. The log records the loot and
  // there is no line for the destruction (world-model law 6), and a dump that omits the item
  // cannot be told apart from a dump that never looked at the storage holding it. The owner chose
  // this over the alternative, whose failure is the test above.
  const ledger = [loot('Sphinx Claw', DUMP_AT - 86_400_000)]
  assert.equal(netFor(ledger, {}, 'both')['sphinx claw'], 1, 'no reload can lower it')
  assert.equal(netFor(ledger, {}, 'log')['sphinx claw'], 1)
  // The one source that CAN show a deletion is the one that reads nothing but the dump, and it
  // shows it by ignoring the log entirely rather than by resetting anything.
  assert.equal(netFor(ledger, {}, 'inventory')['sphinx claw'] ?? 0, 0)
})

test("'log' never consults a dump, and 'inventory' never consults the log", () => {
  const ledger = [loot('Sphinx Claw', DUMP_AT - 86_400_000), loot('Wind Rune', DUMP_AT + 30_000)]
  const dump = { 'shield of the stalwart seas': 1 }

  const fromLog = netFor(ledger, dump, 'log')
  assert.equal(fromLog['sphinx claw'], 1)
  assert.equal(fromLog['wind rune'], 1)
  assert.equal(fromLog['shield of the stalwart seas'] ?? 0, 0)

  const fromDump = netFor(ledger, dump, 'inventory')
  assert.equal(fromDump['shield of the stalwart seas'], 1)
  assert.equal(fromDump['wind rune'] ?? 0, 0)
})

test("'both' takes the higher witness per item, so neither source can lower the other", () => {
  // Three in the dump, two looted (and the dump was written before one of them, which the rule
  // deliberately no longer asks about): the answer is the larger number either source can vouch
  // for. Never a sum — an item you looted and still hold is in BOTH, and adding would double it.
  const ledger = [loot('Bone Chips', DUMP_AT + 5_000, 2)]
  assert.equal(netFor(ledger, { 'bone chips': 3 }, 'both')['bone chips'], 3)
  assert.equal(netFor(ledger, { 'bone chips': 1 }, 'both')['bone chips'], 2)
})

// ---------------------------------------------------------------------------
// 5. What the dump COVERED (JOS-132 spike: absence is unknown, not empty — and the measured
//    reason JOS-141 could not keep the reset)
// ---------------------------------------------------------------------------

const REAL_DUMP = readFileSync(
  join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Inventory.txt'),
  'utf8'
)

test('the committed dump evidences all six storages', () => {
  const covered = storagesCoveredBy(parseInventoryDump(REAL_DUMP))
  assert.deepEqual(covered, ['equip', 'general', 'bank', 'sharedBank', 'personalDepot', 'keyRing'])
  // Coverage and counts describe ONE file: the same parse feeds both.
  assert.ok(Object.keys(heldCountsFromDump(parseInventoryDump(REAL_DUMP))).length > 50)
})

test('A STORAGE MISSING FROM A DUMP IS UNKNOWN, NOT EMPTY', () => {
  // The spike's finding, and it is MEASURED here rather than argued: two captures of the SAME
  // character's inventory disagree about whether the depot exists at all. The committed
  // fixture carries one `Personal-Depot` row; the owner's current on-disk dump (Thu Aug 06
  // 15:39:12 2026, the receipt above) carries ZERO, with the same parser reading both. Nothing
  // in either file says which is a real "no depot" and which is a window that was not open.
  //
  // Only the fixture can be asserted (the live dump is not committed), so the second half of
  // the pair is a REAL reporter dump that omits far more: jos66's is equipment and keyring
  // only, with no general, bank, shared bank or depot anywhere. Counting its silence as zeros
  // would say a Bard with a full bank owns nothing.
  const reporter = parseInventoryDump(
    readFileSync(join(import.meta.dirname, 'fixtures', 'jos66-sky-keyring-Inventory.txt'), 'utf8')
  )
  const covered = storagesCoveredBy(reporter)
  assert.equal(covered.includes('bank'), false)
  assert.equal(covered.includes('general'), false)
  assert.equal(covered.includes('personalDepot'), false)
  assert.ok(covered.includes('keyRing'))
})

test('an empty ROW still evidences its storage; an item is not required', () => {
  const dump = parseInventoryDump(
    ['Location\tName\tID\tCount\tSlots', 'Bank1\tEmpty\t0\t0\t0'].join('\n')
  )
  assert.deepEqual(storagesCoveredBy(dump), ['bank'])
})

test('a KeyRing header alone evidences the keyring, even with no rows under it', () => {
  const dump = parseInventoryDump(['KeyRing\tName\tID\t'].join('\n'))
  assert.deepEqual(storagesCoveredBy(dump), ['keyRing'])
})
