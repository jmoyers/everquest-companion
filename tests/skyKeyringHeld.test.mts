// ============================================================================
// JOS-66 — the Sky reconcile sees the Equipment keyring.
// ============================================================================
//
// THE REPORT (v0.6.3): `Light Woolen Mask` and `Light Woolen Mantle` missing from the Plane
// of Sky quest-item view despite a fresh `/outputfile inventory` and a Reload that said
// "updated just now". The reporter pasted the dump lines proving both present in his file.
//
// THE FIXTURE. `tests/fixtures/jos66-sky-keyring-Inventory.txt` is his SIX pasted lines
// verbatim, under the two table headers and two item rows taken verbatim from the owner's
// own committed dump (`Primitive_freeport-Inventory.txt`) so the file is a genuine two-table
// dump rather than a hand-authored shape. This follows the committed-inventory-fixture
// convention, not the log-slice ban: an inventory dump row is an item name and an item id
// and nothing else — no chat, no third party, nothing to scrub — which is the same reason
// the owner's 295-line dump ships whole (see tests/outputsInventory.test.mts's header).
//
// THE MECHANISM, and it is not the one the report looks like. Both items are in the
// `KeyRing` table under category `Equipment` — a THREE-column table (category, Name, ID) —
// and `heldCountsFromDump` dropped that whole table on the stated theory that "a keyring
// entry is a claimed appearance, not an item sitting in a slot". That theory was never
// measured, and this dump refutes it: NO DROP LORE Bard quest items do not live in an
// appearance registry.
//
// It is NOT the ` +N` suffix. `Light Woolen Mask` carries no suffix at all and missed just as
// hard, and `itemCountKey` strips `Light Woolen Mantle +1` correctly (pinned below and in
// tests/variantNormalization.test.mts). One cause, both items — which is exactly what "the
// unsuffixed one is missing too" was telling us.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import { heldCountsFromDump, walkEntries } from '../src/shared/outputs/inventory'
import { reconcile } from '../src/renderer/src/features/inventory/reconcile'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { CountSource, PoskyQuest } from '../src/shared/types'

const REPORT_DUMP = readFileSync(
  join(import.meta.dirname, 'fixtures', 'jos66-sky-keyring-Inventory.txt'),
  'utf8'
)

const quests = (poskyRaw as { quests: PoskyQuest[] }).quests

/** Mirror of computeQuestProgress's per-item clamp, kept off the renderer-heavy useProgress
 *  module exactly as tests/variantNormalization.test.mts does. */
function have(questName: string, itemName: string, net: Record<string, number>): number {
  const q = quests.find((x) => x.name === questName)
  assert.ok(q, `posky.json has a quest named ${questName}`)
  const it = q.items.find((i) => itemCountKey(i.name) === itemCountKey(itemName))
  assert.ok(it, `${questName} requires ${itemName}`)
  return Math.min(it.count > 0 ? it.count : 1, net[itemCountKey(it.name)] ?? 0)
}

function netFor(text: string, countSource: CountSource): Record<string, number> {
  const inv = heldCountsFromDump(parseInventoryDump(text))
  return reconcile({ log: {}, inv, lootNames: {}, countSource, turnIns: {}, quests }).net
}

// ---------------------------------------------------------------------------
// THE DATA IS NOT THE GAP
// ---------------------------------------------------------------------------

test('both reported items ARE in the committed posky quest-item cells', () => {
  const cells = quests.flatMap((q) => q.items.map((it) => [q.name, it.name] as const))
  assert.deepEqual(
    cells.filter(([, n]) => n === 'Light Woolen Mask'),
    [['Bard Test of Tone', 'Light Woolen Mask']]
  )
  assert.deepEqual(
    cells.filter(([, n]) => n === 'Light Woolen Mantle'),
    [['Bard Test of Voice', 'Light Woolen Mantle']]
  )
  // The scrape spells them exactly as the dump does — no case or whitespace difference to
  // chase, which is the other thing the report could have been.
  assert.equal(itemCountKey('Light Woolen Mask'), 'light woolen mask')
  assert.equal(itemCountKey('Light Woolen Mantle +1'), 'light woolen mantle')
})

// ---------------------------------------------------------------------------
// THE REPORTER'S DUMP
// ---------------------------------------------------------------------------

test("the reporter's six lines parse as KeyRing rows — no Count column, no Location", () => {
  const dump = parseInventoryDump(REPORT_DUMP)
  assert.deepEqual(dump.sections, ['Location', 'KeyRing'])
  assert.deepEqual(dump.malformed, [], 'a 3-column keyring row is its section shape, not malformed')
  assert.deepEqual(
    dump.keyRing.map((k) => [k.category, k.name, k.itemId]),
    [
      ['Equipment', 'Symbol of Marr +2', 12800],
      ['Equipment', 'Light Woolen Mask', 20821],
      ['Equipment', 'Bracelet of Cessation +4', 12804],
      ['Equipment', 'Bracelet of Quiescence +2', 12806],
      ['Equipment', 'Light Woolen Mantle +1', 20823],
      ['Equipment', 'Black Silk Cape', 20783]
    ]
  )
  // Neither reported item is anywhere in the item table — the keyring is the only place they
  // are, which is why the tab could read zero off a file that plainly contains them.
  assert.deepEqual(
    [...walkEntries(dump.items)].map((e) => e.name),
    ['Brigandine Tunic +1', 'Empty']
  )
})

test('JOS-66: the Sky view finds both items — the suffixed one and the unsuffixed one', () => {
  // THE SYMPTOM, reproduced: with the keyring dropped (the pre-fix rule), both read zero.
  const dropped = heldCountsFromDump({ ...parseInventoryDump(REPORT_DUMP), keyRing: [] })
  const before = reconcile({
    log: {}, inv: dropped, lootNames: {}, countSource: 'inventory', turnIns: {}, quests
  }).net
  assert.equal(have('Bard Test of Tone', 'Light Woolen Mask', before), 0, 'the report, exactly')
  assert.equal(have('Bard Test of Voice', 'Light Woolen Mantle', before), 0)

  // THE FIX, under both count sources that read the export at all (`log` reads none of it).
  for (const source of ['inventory', 'both'] as const) {
    const net = netFor(REPORT_DUMP, source)
    assert.equal(have('Bard Test of Tone', 'Light Woolen Mask', net), 1, `mask, source=${source}`)
    assert.equal(
      have('Bard Test of Voice', 'Light Woolen Mantle', net),
      1,
      `mantle (+1 folded onto the base counting key), source=${source}`
    )
    // The third Sky item in his paste comes along for free.
    assert.equal(have('Necromancer Test of Power', 'Black Silk Cape', net), 1)
  }
})

test('the keyring never invents a count: one row is one copy, and the item table still rules', () => {
  const counts = heldCountsFromDump(parseInventoryDump(REPORT_DUMP))
  assert.deepEqual(counts, {
    'brigandine tunic +1': 1,
    'symbol of marr +2': 1,
    'light woolen mask': 1,
    'bracelet of cessation +4': 1,
    'bracelet of quiescence +2': 1,
    'light woolen mantle +1': 1,
    'black silk cape': 1
  })
  // Keys stay RAW here (law 2): `+N` folds downstream at the counting boundary, not before.
  const rows = reconcile({
    log: {}, inv: counts, lootNames: {}, countSource: 'inventory', turnIns: {}, quests
  }).rows
  const mantle = rows.find((r) => r.key === 'light woolen mantle')
  assert.ok(mantle)
  assert.equal(mantle.inv, 1)
  // DISPLAY FALLS BACK TO THE QUEST DATA'S SPELLING, not the export's key (changed by JOS-160).
  // This used to read `light woolen mantle +1` and was described as "the export spelling" — but
  // `heldCountsFromDump` LOWERCASES every name it folds, so that fallback was never a spelling at
  // all; it was a lookup key with the capitals rubbed off. Nobody noticed while inventory-only rows
  // were an opt-in tail; JOS-160 puts one in a search result and on the item page's breadcrumb,
  // where a lowercased name is simply wrong. The `+N` is gone with it because the counting key is
  // the base item, which is the row this is (`key === 'light woolen mantle'`).
  assert.equal(mantle.name, 'Light Woolen Mantle', 'the game spelling, from the quest data')
})
