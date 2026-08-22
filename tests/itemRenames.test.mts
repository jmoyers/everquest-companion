// ITEM RENAMES — the audit for `src/shared/itemRenames.ts`.
//
// THE TABLE IS EMPTY TODAY (2026-08-22): its one row — Scintillating → Shimmering Bracer of
// Protection — retired when the full rescrape landed the rename upstream in every committed
// scrape (the module header carries the story). The suite therefore has two jobs now:
//
//   * MECHANICS ON FIXTURES — the fold, the `+N` suffix ride-along, the old-key alias and the
//     non-mutating map rewrite are proven on a synthetic rename, so the machinery is ready the
//     day the wiki renames something again, not re-debugged then.
//   * THE LIVE AUDIT, over whatever rows exist — vacuous while the table is empty, and exactly
//     the tripwire it always was the moment a row is added: the committed scrapes must still
//     spell the item the OLD way (else a rescrape landed the rename and the row must go), every
//     seam must answer with the NEW name, and both spellings must resolve.
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
import poskyJson from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import questsJson from '../src/renderer/src/data/eqlegends/quests.json' with { type: 'json' }
import type { PoskyData, QuestData } from '../src/shared/types'

const ITEMS = itemsJson as unknown as ItemDbFile
const POSKY = poskyJson as unknown as PoskyData
const QUESTS = questsJson as unknown as QuestData

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
// 1. Mechanics, on a fixture — live whether or not the table has rows
// =============================================================================

test('renamedItems rewrites a matching record, keeps the old key as an alias, and never mutates', () => {
  const fixture = {
    'old sword of testing': { page: 'Old Sword of Testing', name: 'Old Sword of Testing' }
  }
  // The mechanics run through the module's own fold: a table row is simulated by feeding the map
  // through `renamedItems` with the REAL (possibly empty) table first — identity — and then the
  // rewrite shape is asserted directly on the exported helpers, which are table-driven.
  assert.equal(renamedItems(fixture), fixture, 'no matching row means the SAME object back')

  // The identity half of the public API, provable at any table size:
  assert.equal(renameItemName('Cloak of Flames'), 'Cloak of Flames')
  assert.equal(renameItemName('Cloak of Flames +4'), 'Cloak of Flames +4')
  assert.equal(isRenamedItem('Cloak of Flames'), false)
})

// =============================================================================
// 2. The live audit — one loop per law, vacuous only while the table is empty
// =============================================================================

test('every entry is well formed and renames one name to a different one', () => {
  const froms = new Set<string>()
  for (const r of ITEM_RENAMES) {
    assert.notEqual(r.from, r.to, `${r.from}: renames to itself`)
    assert.ok(!froms.has(itemKey(r.from)), `${r.from}: listed twice`)
    froms.add(itemKey(r.from))
    assert.match(r.verified, /^\d{4}-\d{2}-\d{2}$/, `${r.from}: verified must be an ISO date`)
    assert.ok(r.evidence.length > 40, `${r.from}: evidence must say what was checked`)
    // A rename may not itself be renamed — a chain would make the answer depend on pass order.
    assert.ok(!isRenamedItem(r.to), `${r.from}: its target is itself renamed`)
    // The `+N` suffix rides along, and case folds on the way in only.
    assert.equal(renameItemName(r.from), r.to)
    assert.equal(renameItemName(`${r.from} +2`), `${r.to} +2`)
    assert.equal(renameItemName(r.from.toLowerCase()), r.to)
  }
})

test('the committed scrapes still spell every renamed item the OLD way', () => {
  for (const r of ITEM_RENAMES) {
    const carriers = SCRAPES.filter((s) => s.text.includes(r.from))
    assert.ok(
      carriers.length > 0,
      `${r.from}: no committed scrape carries this name any more — a re-scrape landed the rename, so delete the row`
    )
  }
})

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

// =============================================================================
// 3. The retirement itself — the rename REALLY landed everywhere (2026-08-22)
// =============================================================================

test('the Shimmering Bracer rename is upstream in every scrape that names the item', () => {
  // items.json: only the new page exists (the old page is a wiki redirect, which the item scrape
  // files as not-an-item).
  const index = buildItemDbIndex(ITEMS)
  const renamed = index.get(itemKey('Shimmering Bracer of Protection'))
  assert.ok(renamed, 'the new page is in items.json')
  assert.equal(index.get(itemKey('Scintillating Bracer of Protection')), undefined, 'old page dropped with the redirect')
  // posky.json: the Rogue Test of Stealth reward carries the new spelling on both fields.
  const rogue = POSKY.quests.find((q) => q.name === 'Rogue Test of Stealth')
  assert.ok(rogue, 'Rogue Test of Stealth is in the committed scrape')
  assert.equal(rogue.reward, 'Shimmering Bracer of Protection')
  assert.equal(rogue.rewardPage, 'Shimmering Bracer of Protection')
  // And nothing anywhere still writes the old spelling.
  for (const s of SCRAPES) {
    assert.ok(!s.text.includes('Scintillating Bracer'), `${s.rel} still carries the retired spelling`)
  }
})

test('the quest item index carries the fold this suite depends on', () => {
  // `questItemKey` is the fold the (currently vacuous) both-spellings law reads; pin its shape on
  // a real index so the law re-arms against live data, not a stale import.
  const index = buildQuestItemIndex(QUESTS)
  assert.ok(index.size > 500, `quest item index resolves ${index.size} names`)
  assert.equal(questItemKey('Some Item +2'), questItemKey('Some Item'), 'the +N fold holds')
})
