// Respawn scraper field reader and name collisions (scripts/scrape-respawns.ts). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupe, respawnField, respawnKey, rowsFromBatch, type RevPage } from '../scripts/scrape-respawns'
import type { WikiRespawn } from '../src/shared/respawnWiki'

test('the respawn field is read in either spelling and a piped link inside it stays whole', () => {
  assert.equal(respawnField('{{Namedmobpage\n| level = 22-25 | respawn time = 6:40min\n}}'), '6:40min')
  assert.equal(respawnField('{{Namedmobpage\n| Respawn Time      = 6.5 minutes - 11.9 minutes\n}}'), '6.5 minutes - 11.9 minutes')
  assert.equal(respawnField('{{Namedmobpage\n|respawn_time = 18 hours([[variance|+/-1]])\n|zone = x\n}}'), '18 hours([[variance|+/-1]])')
  assert.equal(respawnField('{{Namedmobpage\n|respawn_time = 15 minutes}}'), '15 minutes')
  assert.equal(respawnField('{{Namedmobpage\n|respawn_time = 16:00 minutes\n| Respawn Time = 6min\n}}'), '16:00 minutes')
})

test('same-named mobs keep the first parsed row and every disagreement is reported', () => {
  const { rows, conflicts } = dedupe([
    { key: 'a bandit', page: 'A bandit (Eastern Karana)', text: '6:40', seconds: 400 },
    { key: 'a bandit', page: 'A bandit (Lake Rathe)', text: 'Unknown' },
    { key: 'a bandit', page: 'A bandit (Western Karana)', text: '6:40', seconds: 400 }
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].page, 'A bandit (Eastern Karana)')
  assert.deepEqual(conflicts, ["a bandit: 'A bandit (Eastern Karana)' says 6:40; 'A bandit (Lake Rathe)' says Unknown"])
})

test('a trailing parenthetical on the in-game name is dropped from the key, and never displaces a page already named that', () => {
  assert.equal(respawnKey('the ghoul lord (Hoptor Thaggelum)'), 'the ghoul lord')
  assert.equal(respawnKey('Lord Grimrot (undead)'), 'lord grimrot')
  assert.equal(respawnKey('Gynok Moltor'), 'gynok moltor')
  const page = (title: string, field: string): RevPage => ({ title, revisions: [{ slots: { main: { content: `{{Namedmobpage\n|respawn_time = ${field}\n}}` } } }] })
  const byTitle = new Map([['The Ghoul Lord', 'the ghoul lord (Hoptor Thaggelum)'], ['A kobold (Warrens)', 'a kobold (Warrens)'], ['A kobold', 'a kobold']])
  const stripped = new Set<WikiRespawn>()
  const built = rowsFromBatch([page('The Ghoul Lord', '9 min'), page('A kobold (Warrens)', '5 min'), page('A kobold', '?')], byTitle, stripped)
  assert.deepEqual(built.map((r) => r.key), ['the ghoul lord', 'a kobold', 'a kobold'])
  const { rows, conflicts } = dedupe(built, stripped)
  assert.deepEqual(rows.map((r) => [r.key, r.page, r.seconds]), [['a kobold', 'A kobold', undefined], ['the ghoul lord', 'The Ghoul Lord', 540]])
  assert.deepEqual(conflicts, ["a kobold: 'A kobold' kept over 'A kobold (Warrens)' (key from a stripped parenthetical)"])
})
