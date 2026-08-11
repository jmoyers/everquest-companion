// ============================================================================
// JOS-160 — the Loot page can find what you OWN, not only what you looted.
// ============================================================================
//
// THE REPORT (v0.15.0): the Loot page cannot see `Ivory Sky Diamond` at all — search returns
// nothing, and the item page says it has never been looted — while the Plane of Sky tab shows the
// item held and the Paladin Test of Spirit ready to hand in, with `/finditem` and `/outputfile
// inventory` both saying three copies.
//
// THE MECHANISM, and it is none of the three things the report looks like:
//
//   * NOT a name. There is exactly one spelling of the item anywhere in the tree — items.json,
//     posky.json, quests.json, mobs.json all say `Ivory Sky Diamond` — with no alias and no `+N`
//     variant. `itemCountKey` is a no-op on it. (Pinned below, the way JOS-66 pinned the same
//     question for the Woolen items.)
//   * NOT a parser gap. Nothing else could be: the loot module folds `kind === 'loot'` and nothing
//     else by design, and these copies were acquired before this log exists, so no loot line for
//     them will ever appear.
//   * NOT the keyring. JOS-66's rule already counts `Equipment` keyring rows, which is precisely
//     WHY the Sky tab reads three and is right to.
//
// The Loot page's corpus is the LOOT LEDGER; the Sky tab's is what you HOLD. Both come out of the
// same `reconcile` call, and the divergence is one expression in it: `buildRows` used to skip a row
// whose ACTIVE-source base was 0, which under the default count source `log` deleted every item
// known only to the dump. `net` — the map the quest counting reads — is written BEFORE that skip,
// so the Sky tab kept its answer while the Loot page went blind. That asymmetry is the first thing
// this file pins, because it is both the bug and the regression gate for the fix.
//
// THE FIXTURE IS THE OWNER'S REAL DUMP, and the reporter's three copies are INJECTED as parsed
// counts rather than fabricated into a file (the reporter-slice rule, AGENTS.md). His bytes are
// not in this repo and inventing a dump shape to stand in for them would be inventing evidence;
// `heldCountsFromDump` is already pinned against real files by tests/outputsInventory.test.mts and
// tests/skyKeyringHeld.test.mts, so the parse is not what needs proving here — the reconciliation
// downstream of it is.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import { heldCountsFromDump } from '../src/shared/outputs/inventory'
import { reconcile, type InventoryRow } from '../src/renderer/src/features/inventory/reconcile'
import { buildOwnedRows, selectInvOnly, showsInvOnly } from '../src/renderer/src/features/loot/ownedItems'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { CountSource, HeldCounts, PoskyQuest } from '../src/shared/types'

const OWNER_DUMP = readFileSync(
  join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Inventory.txt'),
  'utf8'
)

const quests = (poskyRaw as { quests: PoskyQuest[] }).quests
const SOURCES: readonly CountSource[] = ['log', 'inventory', 'both']

const ITEM = 'Ivory Sky Diamond'
const KEY = itemCountKey(ITEM)
/** The reporter's count, from his `/finditem` and his `/outputfile inventory` alike. */
const REPORTED = 3

/** The owner's real dump, with the reporter's three copies injected (see the header). */
function reportedInventory(): HeldCounts {
  const counts = heldCountsFromDump(parseInventoryDump(OWNER_DUMP))
  assert.equal(counts[KEY], undefined, "the owner's own dump does not contain the reported item")
  return { ...counts, [KEY]: REPORTED }
}

function rowsFor(countSource: CountSource, log: Record<string, number> = {}): {
  rows: InventoryRow[]
  net: Record<string, number>
} {
  return reconcile({
    log,
    inv: reportedInventory(),
    lootNames: {},
    countSource,
    turnIns: {},
    quests
  })
}

// ---------------------------------------------------------------------------
// THE DATA IS NOT THE GAP (the suspects, ruled out)
// ---------------------------------------------------------------------------

test('one spelling, one quest cell, nothing for a normalizer to fix', () => {
  const cells = quests.flatMap((q) => q.items.map((it) => [q.name, it.name] as const))
  assert.deepEqual(
    cells.filter(([, n]) => n === ITEM),
    [['Paladin Test of Spirit', ITEM]]
  )
  // No ` +N` to strip and no case difference to chase — the counting key is the name, lowercased.
  assert.equal(KEY, 'ivory sky diamond')
  assert.equal(itemCountKey(ITEM), ITEM.toLowerCase())
})

// ---------------------------------------------------------------------------
// THE DIVERGENCE, AND THE GATE THAT KEEPS THE FIX FROM MOVING THE SKY TAB
// ---------------------------------------------------------------------------

test('the Sky tab was never wrong: `net` is what the count source says, under every source', () => {
  // This is the REGRESSION GATE. The fix widens which rows the Loot table can see; if it ever
  // moved a number the quest counting reads, these are the assertions that would fall over.
  assert.equal(rowsFor('log').net[KEY], 0, 'the log never saw it, and `log` consults nothing else')
  assert.equal(rowsFor('inventory').net[KEY], REPORTED)
  assert.equal(rowsFor('both').net[KEY], REPORTED, 'max of the two witnesses')
})

test('JOS-160: a row exists for an item only the export vouches for — under every count source', () => {
  for (const source of SOURCES) {
    const row = rowsFor(source).rows.find((r) => r.key === KEY)
    assert.ok(row, `the reported item has a row, source=${source}`)
    // Every number honest to its own witness: the log says nothing, the dump says three.
    assert.equal(row.log, 0, `looted count is the log's answer, source=${source}`)
    assert.equal(row.inv, REPORTED, `owned count is the dump's answer, source=${source}`)
    assert.equal(row.consumed, 0, 'no turn-ins, so nothing was taken off it')
    assert.equal(row.net, row.base - row.consumed, 'the row identity holds')
  }
  // THE SYMPTOM, reproduced against the old rule: skipping when the ACTIVE source's base is 0
  // deletes the row entirely under `log`, which is the default and the reporter's.
  const underOldRule = rowsFor('log').rows.filter((r) => r.base !== 0 || r.consumed !== 0)
  assert.equal(
    underOldRule.find((r) => r.key === KEY),
    undefined,
    'the report, exactly: no row at all for a dump-only item under the default source'
  )
})

test('a row nobody vouches for is still not invented', () => {
  const { rows } = rowsFor('log')
  for (const r of rows) {
    assert.ok(r.log > 0 || r.inv > 0 || r.consumed > 0, `${r.key} has a witness`)
  }
  assert.equal(rows.find((r) => r.key === 'large sky diamond'), undefined, 'an unheld Sky item stays absent')
})

// ---------------------------------------------------------------------------
// THE SEARCH REACHES IT
// ---------------------------------------------------------------------------

test('the owned-but-never-looted selection keys off the export, not the active source', () => {
  for (const source of SOURCES) {
    const owned = selectInvOnly(rowsFor(source).rows, new Set<string>())
    assert.ok(
      owned.some((r) => r.key === KEY),
      `selected under source=${source}`
    )
  }
  // Loot it once and it stops being inventory-only: it is a loot row now, with its own history.
  const looted = selectInvOnly(rowsFor('both', { [KEY]: 1 }).rows, new Set([KEY]))
  assert.equal(looted.find((r) => r.key === KEY), undefined)
})

test('a SEARCH shows the tail whatever the chip says; an empty box still obeys it', () => {
  assert.equal(showsInvOnly(false, ''), false, 'browsing stays opt-in — the ledger is a loot table')
  assert.equal(showsInvOnly(true, ''), true, 'the chip still works')
  assert.equal(showsInvOnly(false, 'ivory sky diamond'), true, 'a search asks a different question')
  assert.equal(showsInvOnly(true, 'ivory'), true)
})

test('JOS-160 acceptance: searching the item name returns it, spelled the way the game spells it', () => {
  const isQuestItem = (k: string): boolean =>
    quests.some((q) => q.items.some((it) => itemCountKey(it.name) === k))
  for (const source of SOURCES) {
    const owned = selectInvOnly(rowsFor(source).rows, new Set<string>())
    for (const q of ['ivory sky diamond', 'ivory', 'sky diamond']) {
      const hits = buildOwnedRows({ source: owned, questOnly: false, q, isFavorite: () => false, isQuestItem })
      const row = hits.find((r) => r.countKey === KEY)
      assert.ok(row, `query "${q}" finds it, source=${source}`)
      // The export's key is LOWERCASED by `heldCountsFromDump`, so without reconcile's quest-name
      // seeding this row would read `ivory sky diamond` on the page and in the breadcrumb.
      assert.equal(row.item, ITEM, 'the game spelling, not the lookup key')
      assert.equal(row.owned, REPORTED, 'the row states what the export vouched for')
      assert.equal(row.count, 0, 'and claims no loot it cannot show')
      assert.equal(row.last, 0)
      assert.equal(row.invOnly, true)
    }
    // The Sky filter admits it too — it is a quest item, which is the whole reason it matters.
    const questFiltered = buildOwnedRows({
      source: owned,
      questOnly: true,
      q: 'ivory sky diamond',
      isFavorite: () => false,
      isQuestItem
    })
    assert.equal(questFiltered.length, 1)
  }
})

test('the search does not go fishing: a name nobody holds still returns nothing', () => {
  const isQuestItem = (): boolean => true
  const owned = selectInvOnly(rowsFor('both').rows, new Set<string>())
  const hits = buildOwnedRows({
    source: owned,
    questOnly: false,
    q: 'large sky diamond',
    isFavorite: () => false,
    isQuestItem
  })
  assert.deepEqual(hits, [], 'an item the player does not have is absent, not a zero row')
})
