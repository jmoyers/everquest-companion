// Item/mob template reader edge cases found on the cached wiki corpus. Fixtures are trimmed
// copies of the real page shapes they are named after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSummary, parseItemWikitext, parseQuestLinks, templateField } from '../src/main/itemLookupParse'

const LARGE_SKY_LAPIS = `<onlyinclude>{{Itempage
|itemname = Large Sky Lapis
|relatedquests =

* [[Wizard Test of Preparation]]

|statblock=|statsblock=No Trade, Quest<br>
WT: 0.1  Size: MEDIUM<br>
Class: WIZ<br>
Race: ALL<br>}}</onlyinclude>

[[Category:Quest Item]]`

const ANTS_POTION = `<onlyinclude>{{Itempage
|itemname    = Ant's Potion
|statsblock  =
EXPENDABLE  Charges: 1<br>
|playercrafted =

* [[Alchemy]] (Trivial: 70)
** '''Yield: Ant's Potion''' x1
** In [[Medicine Bag]]:
:: {{SmIcon|1200}} 1 x [[Sumbul]] - Approx. 6p 7g 7s 3c

* [[Alchemy]]
** [[5 Dose Ant's Potion]]}}</onlyinclude>`

const LUSTROUS_GREAVES = `<onlyinclude>{{Itempage
|itemname    = Lustrous Russet Greaves
|statsblock  =
MAGIC ITEM  NO DROP<br>
|dropsfrom=[[Plane of Hate]]

* [[an elite dragoon]]}}</onlyinclude>

[[Category:Legs]]`

test('a field whose value ends on the same line as the template close is read, not lost', () => {
  assert.equal(templateField(LARGE_SKY_LAPIS, 'statsblock'), 'No Trade, Quest<br>\nWT: 0.1  Size: MEDIUM<br>\nClass: WIZ<br>\nRace: ALL<br>')
  assert.equal(templateField(LUSTROUS_GREAVES, 'dropsfrom'), '[[Plane of Hate]]\n\n* [[an elite dragoon]]')
  const crafted = templateField(ANTS_POTION, 'playercrafted') ?? ''
  assert.ok(crafted.endsWith('** [[5 Dose Ant\'s Potion]]'), crafted)
  assert.equal(parseItemWikitext("Ant's Potion", ANTS_POTION).playerCrafted, true)
  assert.ok(parseItemWikitext('Large Sky Lapis', LARGE_SKY_LAPIS).stats)
})

test('several fields on one line each end at the next top-level |name =', () => {
  const mob = '{{Namedmobpage\n| level             = 22-25 | respawn time = 6:40min\n| zone = [[Kithicor Forest]]\n}}'
  assert.equal(templateField(mob, 'level'), '22-25')
  assert.equal(templateField(mob, 'respawn time'), '6:40min')
  // A pipe inside a nested link or template is not a field boundary.
  const piped = '{{Itempage\n|notes = See [[Page|label = x]] and {{T|a = b}} here | itemname = X\n}}'
  assert.equal(templateField(piped, 'notes'), 'See [[Page|label = x]] and {{T|a = b}} here')
})

test('a doubled pipe ends the field before it, and a duplicated field reads its non-empty copy', () => {
  const mob = '{{Namedmobpage\n| known_loot =\n* None\n\n|| factions =\n* [[Heretics]]\n}}'
  assert.equal(templateField(mob, 'known_loot'), '* None')
  const dup = '{{Itempage\n|notes       = |notes = Starter weapon for all priests.\n|itemname = Club*\n}}'
  assert.equal(templateField(dup, 'notes'), 'Starter weapon for all priests.')
})

test('a line-start |name = or }} still ends a field even inside an unbalanced nested template', () => {
  const wt = '{{Itempage\n|dropsfrom = [[Najena]]\n\n{{VeliousGray|[[Western Wastes]]\n\n* [[Makil Rargon]]\n}}\n|itemname = Robe\n}}'
  assert.equal(templateField(wt, 'dropsfrom'), '[[Najena]]\n\n{{VeliousGray|[[Western Wastes]]\n\n* [[Makil Rargon]]')
})

test('summaries unwrap lore/transclusion/loc templates and drop the rest instead of showing markup', () => {
  assert.equal(cleanSummary('{{Item Lore|Blood Spirit Wine}} This is Stackable.'), 'Blood Spirit Wine This is Stackable.')
  assert.equal(cleanSummary('{{Lore|Headband of the Chosen}}'), 'Headband of the Chosen')
  assert.equal(cleanSummary('{{Item Lore Missing}}'), undefined)
  // A lore line's own period does not end the summary before the prose after it (Gnome Sandwich).
  assert.equal(
    cleanSummary('{{Item Lore|Made by gnomes, not of gnomes.}} GM item occasionally handed out. More.'),
    'Made by gnomes, not of gnomes. GM item occasionally handed out.'
  )
  assert.equal(cleanSummary('namely {{:Shattering Hammer}}s.'), 'namely Shattering Hammers.')
  assert.equal(cleanSummary('Ground spawn at {{Loc|Dalnir|-20, 50|(-20, 50)}}.'), 'Ground spawn at -20, 50.')
  assert.equal(cleanSummary("{{{Item Lore | 'Runed Bokken'}}"), "'Runed Bokken'")
  assert.equal(cleanSummary('Icon {{SmIcon|1211}} here'), 'Icon here')
})

test('the short Quest and Lore flag forms (and a Lore Equpped typo) set quest and lore', () => {
  const page = (flags: string): string => `{{Itempage\n|statsblock = ${flags}<br>\nWT: 0.1  Size: SMALL<br>\n}}`
  assert.equal(parseItemWikitext('X', page('No Trade, Quest')).quest, true)
  assert.equal(parseItemWikitext('X', page('MAGIC ITEM  LORE EQUPPED')).lore, true)
  assert.equal(parseItemWikitext('X', page('MAGIC ITEM  Lore')).lore, true)
  assert.equal(parseItemWikitext('X', page('MAGIC ITEM  PENDING LORE')).lore, false)
  assert.equal(parseItemWikitext('X', page('MAGIC ITEM  NO DROP')).quest, false)
})

test('Category:/File:/Special: links are not read as quests or recipes', () => {
  const uses = parseQuestLinks("* [[Icestar's Eve Snowdrift Feast]]\n[[Category:Inventory Items]]\n[[File:x.png|thumb]]")
  assert.deepEqual(uses.map((u) => u.quest), ["Icestar's Eve Snowdrift Feast"])
  const wt = '{{Itempage\n|recipes =\n* [[Blacksmithing]]\n** Various recipes (see [[Special:WhatLinksHere/{{PAGENAME}}]])\n}}'
  assert.equal(parseItemWikitext('High Quality Folded Sheet Metal', wt).recipes, undefined)
})
