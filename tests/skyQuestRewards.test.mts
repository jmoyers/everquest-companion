// SKY QUEST REWARDS — the audit for `src/shared/skyQuestRewards.ts` (JOS-428).
//
// The overlay's own header carries the argument; this suite is the tripwire, built like the
// skyMobIslands and itemRenames audits and for the same reason: a correction that has quietly
// stopped describing anything is worse than none, because it looks like coverage. So it checks
// BOTH ends against the committed bytes —
//
//   * posky.json still names the WRONG item on that quest (otherwise a re-scrape landed the fix
//     upstream and the row should be deleted, not left looking like work);
//   * items.json really carries the corrected page, and every number in the transcribed stat block
//     is that record's own — the block is a transcription, so it is derived here rather than
//     eyeballed;
//   * the block still reads as untradeable, which is the whole gate `rewardInference.ts` opens on:
//     a transcription that lost "NO DROP" would silently un-fix the report this row exists for;
//   * the two overlays stay disjoint — no row here may name an item `itemRenames.ts` also renames.
//
// Node-only, no Electron, real committed bytes. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SKY_QUEST_REWARDS,
  correctSkyQuestReward,
  needsRewardCorrection,
  skyQuestRewardFor
} from '../src/shared/skyQuestRewards'
import { isRenamedItem } from '../src/shared/itemRenames'
import { rewardInferredQuests } from '../src/renderer/src/features/posky/rewardInference'
import { itemKey, type ItemDbFile } from '../src/main/itemsDb'
import itemsJson from '../src/main/data/items.json' with { type: 'json' }
import poskyJson from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyData } from '../src/shared/types'

const ITEMS = (itemsJson as unknown as ItemDbFile).items
const POSKY = poskyJson as unknown as PoskyData

const questOf = (r: (typeof SKY_QUEST_REWARDS)[number]): PoskyData['quests'][number] => {
  const q = POSKY.quests.find((x) => x.className === r.className && x.name === r.questName)
  assert.ok(q, `${r.questName}: not in the committed posky scrape`)
  return q
}

// =============================================================================
// 1. The table
// =============================================================================

test('every entry is well formed and corrects one item to a different one', () => {
  assert.ok(SKY_QUEST_REWARDS.length > 0, 'an empty table means the seam below is untested')
  const seen = new Set<string>()
  for (const r of SKY_QUEST_REWARDS) {
    assert.notEqual(r.from, r.to, `${r.questName}: corrects to itself`)
    const id = `${r.className}/${r.questName}`
    assert.ok(!seen.has(id), `${id}: listed twice`)
    seen.add(id)
    assert.match(r.verified, /^\d{4}-\d{2}-\d{2}$/, `${id}: verified must be an ISO date`)
    assert.ok(r.evidence.length > 40, `${id}: evidence must say what was checked`)
  }
})

test('the two overlays stay disjoint - neither end of a row is also a RENAME', () => {
  // Both tables rewrite an item name at the same seam. A name in both would make the answer depend
  // on fold order, which is exactly the chain `itemRenames` refuses for itself.
  for (const r of SKY_QUEST_REWARDS) {
    assert.equal(isRenamedItem(r.from), false, `${r.from}: also renamed`)
    assert.equal(isRenamedItem(r.to), false, `${r.to}: also renamed`)
  }
})

// =============================================================================
// 2. The entry still describes something
// =============================================================================

test('the committed scrape still names the WRONG reward on every corrected quest', () => {
  for (const r of SKY_QUEST_REWARDS) {
    const q = questOf(r)
    assert.equal(
      q.reward,
      r.from,
      `${r.questName}: posky no longer says "${r.from}" - a re-scrape landed the fix, so delete the row`
    )
    assert.ok(needsRewardCorrection(q), `${r.questName}: the guard disagrees with the scrape`)
  }
})

test('the corrected item is a real committed page, and the stale one is a DIFFERENT record', () => {
  for (const r of SKY_QUEST_REWARDS) {
    const to = ITEMS[itemKey(r.to)]
    const from = ITEMS[itemKey(r.from)]
    assert.ok(to, `${r.to}: the corrected name is in no committed item page`)
    assert.ok(from, `${r.from}: the stale name has left items.json - re-check the row`)
    assert.equal(to.page, r.to)
    // The premise of the whole file: these are TWO scraped pages, not one retitled page. If they
    // ever collapse into one record this is a rename and belongs in itemRenames.ts instead.
    assert.notEqual(to, from, `${r.to}: now the same record as ${r.from} - this is a rename now`)
  }
})

// =============================================================================
// 3. The transcribed stat block is the corrected page's own
// =============================================================================

test('every number in the stat block is derived from the corrected page record', () => {
  for (const r of SKY_QUEST_REWARDS) {
    const entry = ITEMS[itemKey(r.to)]
    assert.ok(entry?.stats, `${r.to}: the committed record carries no stat model to check against`)
    const s = entry.stats
    // The KEY's casing is the wiki's display choice and differs between the two spellings of the
    // same fact (`CHARGES` in the parsed model, `Charges:` on the page); the VALUE is the fact, and
    // it is what this derivation is checking. So the haystack is folded, never the numbers.
    const block = r.stats.toLowerCase()
    const carries = (key: string, value: string): boolean =>
      block.includes(`${key.toLowerCase()}: ${value.toLowerCase()}`)
    assert.ok(s.ac !== undefined, `${r.to}: no AC on the record`)
    assert.ok(carries('AC', String(s.ac)), `${r.to}: stat block disagrees on AC`)
    assert.ok(carries('Slot', s.slot ?? ''), `${r.to}: stat block disagrees on slot`)
    for (const st of s.stats) {
      assert.ok(carries(st.key, st.value), `${r.to}: stat block drops ${st.key}`)
    }
    for (const sv of s.saves) {
      assert.ok(carries(sv.key, sv.value), `${r.to}: stat block drops ${sv.key}`)
    }
    for (const ef of s.effects) {
      assert.ok(r.stats.includes(ef.name), `${r.to}: stat block drops the ${ef.name} effect`)
    }
    for (const cls of s.classes) {
      assert.ok(r.stats.includes(cls), `${r.to}: stat block drops class ${cls}`)
    }
  }
})

test('the stat block still reads as untradeable - the reward inference gate', () => {
  // rewardInference.ts opens on exactly this pattern. A transcription that lost the flag would
  // un-fix the report the row exists for, silently and with every test above still green.
  for (const r of SKY_QUEST_REWARDS) {
    assert.match(r.stats, /no[ -]?(drop|trade)/i, `${r.questName}: no longer reads untradeable`)
  }
})

test('the stat block carries nothing of the stale page', () => {
  for (const r of SKY_QUEST_REWARDS) {
    assert.ok(!r.stats.includes(r.from), `${r.questName}: the block still names ${r.from}`)
  }
})

// =============================================================================
// 4. The fold
// =============================================================================

test('the fold rewrites name, page and stats together, and is idempotent', () => {
  const r = SKY_QUEST_REWARDS[0]
  const q = questOf(r)
  const out = correctSkyQuestReward(q)
  assert.equal(out.reward, r.to)
  assert.equal(out.rewardPage, r.to)
  assert.equal(out.rewardStats, r.stats)
  // A second pass finds a reward that is no longer the stale name and changes nothing — the same
  // no-op a landed re-scrape would get.
  assert.equal(correctSkyQuestReward(out), out)
  assert.equal(needsRewardCorrection(out), false)
})

test('a quest the table does not name keeps object identity', () => {
  const untouched = POSKY.quests.find((q) => skyQuestRewardFor(q.className, q.name) === undefined)
  assert.ok(untouched, 'the table names every quest in the scrape, which cannot be right')
  assert.equal(correctSkyQuestReward(untouched), untouched)
  assert.equal(needsRewardCorrection(untouched), false)
})

test('THE WHOLE POINT: the corrected quest infers from a held reward, the stale one cannot', () => {
  // The join this ticket closes, end to end over the committed scrape: a Bard holding the reward
  // reads turned-in. The inventory is spelled the way `heldCountsFromDump` stores it (raw name,
  // lowercased) — one synthetic row rather than the reporter's file, which never enters git.
  for (const r of SKY_QUEST_REWARDS) {
    const q = questOf(r)
    const inv = { [r.to.toLowerCase()]: 1 }
    assert.equal(
      rewardInferredQuests([q], inv).size,
      0,
      `${r.questName}: the UNcorrected quest must not match - that is the reported defect`
    )
    assert.equal(
      rewardInferredQuests([correctSkyQuestReward(q)], inv).size,
      1,
      `${r.questName}: corrected, a held reward must vouch for it`
    )
  }
})

test('the corrected reward is what an inventory export actually spells (the report)', () => {
  // The join this row exists to close: the export's raw name, lowercased the way
  // `heldCountsFromDump` stores it, must equal the corrected reward's counting key. Item id 27723,
  // "Amulet of the Fae", Bank7-Slot1 of the export attached to 01M0FH3XC4ST5Q3XXPJ0H3X75J.
  const bard = SKY_QUEST_REWARDS.find((r) => r.questName === 'Bard Test of Wind')
  assert.ok(bard, 'the reported row has left the table')
  assert.equal(itemKey('Amulet of the Fae'), itemKey(bard.to))
  assert.notEqual(itemKey('Amulet of the Fae'), itemKey(bard.from))
})
