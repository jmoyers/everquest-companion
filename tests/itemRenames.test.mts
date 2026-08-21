// ITEM RENAMES — the audit for `src/shared/itemRenames.ts`.
//
// The overlay's own header carries the argument; this suite is the tripwire, and it is built like
// the spell-corrections audit for the same reason: an entry that has quietly stopped describing
// anything is worse than no entry, because it looks like coverage. So it checks BOTH ends —
//
//   * the committed scrapes still spell the item the OLD way (otherwise a re-scrape has landed the
//     rename upstream and the row should be deleted, not left to look like work);
//   * they do NOT already carry the new spelling anywhere, which is the same statement read the
//     other way and catches a half-landed re-scrape;
//   * every seam that keys or displays an item name from a scrape answers with the NEW name —
//     the item DB index, the gear/planner indices, the quest item index and the Sky dataset.
//     "Half a rename is worse than none" is a law here, and this is what enforces it.
//
// Node-only, no Electron, real committed bytes. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ITEM_RENAMES,
  isRenamedItem,
  renameItemName,
  renamedItems
} from '../src/shared/itemRenames'
import { buildItemDbIndex, itemKey, type ItemDbFile } from '../src/main/itemsDb'
import { buildQuestItemIndex, questItemKey } from '../src/main/questItemIndex'
import itemsJson from '../src/main/data/items.json' with { type: 'json' }
import questsJson from '../src/renderer/src/data/eqlegends/quests.json' with { type: 'json' }
import poskyJson from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyData, QuestData } from '../src/shared/types'

const ITEMS = itemsJson as unknown as ItemDbFile
const QUESTS = questsJson as unknown as QuestData
const POSKY = poskyJson as unknown as PoskyData

/** The three scraped files this overlay speaks for, read as raw text for the spelling sweep. */
const SCRAPES = [
  'src/main/data/items.json',
  'src/renderer/src/data/eqlegends/posky.json',
  'src/renderer/src/data/eqlegends/quests.json'
].map((rel) => ({
  rel,
  text: readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
}))

// =============================================================================
// 1. The table
// =============================================================================

test('every entry is well formed and renames one name to a different one', () => {
  assert.ok(ITEM_RENAMES.length > 0, 'an empty table means the seams below are untested')
  const froms = new Set<string>()
  for (const r of ITEM_RENAMES) {
    assert.notEqual(r.from, r.to, `${r.from}: renames to itself`)
    assert.ok(!froms.has(itemKey(r.from)), `${r.from}: listed twice`)
    froms.add(itemKey(r.from))
    assert.match(r.verified, /^\d{4}-\d{2}-\d{2}$/, `${r.from}: verified must be an ISO date`)
    assert.ok(r.evidence.length > 40, `${r.from}: evidence must say what was checked`)
    // A rename may not itself be renamed — a chain would make the answer depend on pass order.
    assert.ok(!isRenamedItem(r.to), `${r.from}: its target is itself renamed`)
  }
})

test('the +N item-level suffix rides along, and an unlisted name is identity', () => {
  const r = ITEM_RENAMES[0]
  assert.equal(renameItemName(r.from), r.to)
  assert.equal(renameItemName(`${r.from} +2`), `${r.to} +2`)
  // Case is folded on the way in, never on the way out: the answer is the wiki's own casing.
  assert.equal(renameItemName(r.from.toLowerCase()), r.to)
  assert.equal(renameItemName('Cloak of Flames'), 'Cloak of Flames')
  assert.equal(renameItemName('Cloak of Flames +4'), 'Cloak of Flames +4')
  assert.equal(isRenamedItem('Cloak of Flames'), false)
})

// =============================================================================
// 2. The entry still describes something — and only the old thing
// =============================================================================

test('the committed scrapes still spell every renamed item the OLD way', () => {
  for (const r of ITEM_RENAMES) {
    const carriers = SCRAPES.filter((s) => s.text.includes(r.from))
    assert.ok(
      carriers.length > 0,
      `${r.from}: no committed scrape carries this name any more — a re-scrape landed the rename, so delete the row`
    )
  }
})

test('no committed scrape has picked up the NEW spelling yet', () => {
  // The mirror of the check above: if a re-scrape half-lands a rename, one file says each name and
  // the join silently splits. This suite is the place that notices.
  for (const r of ITEM_RENAMES) {
    for (const s of SCRAPES) {
      assert.ok(
        !s.text.includes(r.to),
        `${s.rel} now carries "${r.to}" — re-scrape landed; re-check every seam and drop the row`
      )
    }
  }
})

// =============================================================================
// 3. Every seam answers with the new name
// =============================================================================

test('the item DB index serves the new name, and BOTH spellings still resolve', () => {
  const index = buildItemDbIndex(ITEMS)
  for (const r of ITEM_RENAMES) {
    const viaOld = index.get(itemKey(r.from))
    const viaNew = index.get(itemKey(r.to))
    assert.ok(viaOld, `${r.from}: the old key must stay addressable (logs and share bundles have it)`)
    assert.ok(viaNew, `${r.to}: the new key must resolve`)
    assert.equal(viaOld.page, r.to, 'the old key must answer with the CURRENT name')
    assert.equal(viaNew.page, r.to)
    assert.equal(viaOld, viaNew, 'both keys must be the same record, not two copies')
  }
})

test('renamedItems is non-mutating and hands back the same object when nothing matched', () => {
  const untouched = { 'cloak of flames': { page: 'Cloak of Flames' } }
  assert.equal(renamedItems(untouched), untouched)
  // The source record map is never written through.
  const before = JSON.stringify(ITEMS.items[itemKey(ITEM_RENAMES[0].from)])
  buildItemDbIndex(ITEMS)
  assert.equal(JSON.stringify(ITEMS.items[itemKey(ITEM_RENAMES[0].from)]), before)
})

test('the quest item index answers for BOTH spellings of a renamed item', () => {
  const index = buildQuestItemIndex(QUESTS)
  for (const r of ITEM_RENAMES) {
    const viaOld = index.get(questItemKey(r.from))
    const viaNew = index.get(questItemKey(r.to))
    assert.ok(viaOld, `${r.from}: the quest catalog no longer indexes it`)
    assert.equal(viaOld, viaNew, 'one key, one answer — a renamed item must not split the index')
  }
})

test('the Sky dataset shows the new name on the reward, its page link and its item rows', async () => {
  // The renderer seam is `getPoskyData`, which cannot be imported here (it reaches localStorage),
  // so the fold is re-derived over the same committed bytes with the same overlay. What this pins
  // is that the scrape really does carry the old name on all three fields, and what the overlay
  // says about each of them.
  const rogue = POSKY.quests.find((q) => q.name === 'Rogue Test of Stealth')
  assert.ok(rogue, 'Rogue Test of Stealth is not in the committed scrape')
  assert.equal(rogue.reward, 'Scintillating Bracer of Protection')
  assert.equal(rogue.rewardPage, 'Scintillating Bracer of Protection')
  assert.equal(renameItemName(rogue.reward), 'Shimmering Bracer of Protection')
  assert.equal(renameItemName(rogue.rewardPage), 'Shimmering Bracer of Protection')
  // No other quest in the dataset is touched by the table.
  const touched = POSKY.quests.filter(
    (q) => (q.reward !== undefined && isRenamedItem(q.reward)) || q.items.some((it) => isRenamedItem(it.name))
  )
  assert.deepEqual(touched.map((q) => q.name), ['Rogue Test of Stealth'])
  await Promise.resolve()
})
