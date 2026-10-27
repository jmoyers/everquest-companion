// The wiki's file list, for mob pages with no image (owner ask, 2026-10-18: Marda's page named
// npc_marda.png and no such file existed). Fixtures only, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileKey, markNoImage } from '../scripts/scrape-wiki-files'
import { parseMobPage } from '../scripts/sources/mobPage'
import { stripFormatChars } from '../src/shared/wikiTitle'
import { parseItemWikitext, parseQuestLinks } from '../src/main/itemLookupParse'

test('a file name keys the way the wiki keys it', () => {
  assert.equal(fileKey('npc_marda.png'), 'Npc_marda.png')
  assert.equal(fileKey('File:Npc marda.png'), 'Npc_marda.png')
})

test('a mob page names its image; a missing or unnamed one is marked', () => {
  assert.equal(parseMobPage('Marda', '{{Namedmobpage\n| imagefilename     = npc_marda.png\n| name = Marda\n}}')?.image, 'npc_marda.png')
  assert.equal(parseMobPage('X', '{{Namedmobpage\n| imagefilename = \n| name = X\n}}')?.image, undefined)
  const mobs: { image?: string; noImage?: true }[] = [{ image: 'npc_marda.png' }, { image: 'npc_drizda_tunesinger.png', noImage: true }, {}]
  assert.equal(markNoImage(mobs, new Set(['Npc_drizda_tunesinger.png'])), 2)
  assert.deepEqual(mobs.map((m) => m.noImage === true), [true, false, true])
})

// The wiki drops invisible format characters from a title; two real pages paste a left-to-right
// mark after the file name (owner, 2026-10-21: Gaps called an alligator's picture missing).
const LRM = '\u200E'

test('a pasted bidi mark is not part of a file name or a link', () => {
  assert.equal(stripFormatChars(`npc_an_alligator.png${LRM}`), 'npc_an_alligator.png')
  assert.equal(stripFormatChars('\u200Bx\u202Ay\u2060z\uFEFF'), 'xyz')
  assert.equal(fileKey(`npc_an_alligator.png${LRM}`), 'Npc_an_alligator.png')
  assert.equal(fileKey(`Npc_vessel_spirit_companion.jpg${LRM}`), 'Npc_vessel_spirit_companion.jpg')
  assert.equal(fileKey(' File: npc  an__alligator.png '), 'Npc_an_alligator.png')
  const gator = parseMobPage('An alligator', `{{Namedmobpage\n| imagefilename     = npc_an_alligator.png${LRM}\n| name = an alligator\n}}`)
  assert.equal(gator?.image, 'npc_an_alligator.png')
  const mobs = [{ image: `npc_an_alligator.png${LRM}` }, { image: `Npc_vessel_spirit_companion.jpg${LRM}` }]
  assert.equal(markNoImage(mobs, new Set(['Npc_an_alligator.png', 'Npc_vessel_spirit_companion.jpg'])), 0)
  assert.deepEqual(parseQuestLinks(`* [[Captain Nealith's Brother${LRM}]]`), [{ quest: "Captain Nealith's Brother", page: "Captain Nealith's Brother", source: 'wiki' }])
  assert.equal(parseItemWikitext('X', `{{Itempage\n|itemname = X\n|lucy_img_ID = 1918${LRM}\n}}`).iconId, 1918)
})
