// Item/mob template reader edge cases found on the cached wiki corpus. Fixtures are trimmed
// copies of the real page shapes they are named after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSummary, parseItemWikitext, parseQuestLinks, templateField } from '../src/main/itemLookupParse'
import { isUnfilledItemBlueprint } from '../src/main/itemBlueprint'

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

// Trimmed from the cached Fruit and Pod of Water pages (2026-10-21).
const FRUIT = `<onlyinclude>{{Itempage
|itemname    = Fruit
|foraged        = 

* Various
* [[Misty Thicket]]
* [[Freeport|East Freeport]]
* [[Dagnor's Cauldron]], possibly [[Kedge Keep]]
* [[Misty Thicket]] ?
}}</onlyinclude>

[[Category:Foraged]]
[[Category:Misty Thicket]]`

test('|foraged reads every zone a line links, piped labels kept, and the lines naming none as prose', () => {
  const k = parseItemWikitext('Fruit', FRUIT)
  assert.deepEqual(k.foraged, ['Misty Thicket', 'East Freeport', "Dagnor's Cauldron", 'Kedge Keep'])
  assert.equal(k.foragedNote, 'Various')
  assert.equal(k.foragedCategory, true)
})

test('an empty |foraged and a page without the Foraged category state nothing', () => {
  const k = parseItemWikitext('Fresh Fish', '<onlyinclude>{{Itempage\n|itemname = Fresh Fish\n|foraged = \n\n}}</onlyinclude>\n[[Category:Foraged Items]]')
  assert.equal(k.foraged, undefined)
  assert.equal(k.foragedNote, undefined)
  assert.equal(k.foragedCategory, undefined)
  assert.equal(parseItemWikitext('Lettuce', '{{Itempage\n|foraged = \n\n* ?\n}}').foragedNote, '?')
})

test('|foraged: only a bullet opening with a link names zones, comments are never read, links fold as the wiki does', () => {
  const wt = `{{Itempage
|foraged =
<!-- list zones like * [[Zone Name]] -->
* Can be foraged anywhere with the [[Forage]] skill
* [[Misty_Thicket#Foraging]]
* [[misty thicket]]
* [[Kedge Keep|]]
* {{Zone|Lake Rathetear}}
}}
<!-- [[Category:Foraged]] -->`
  const k = parseItemWikitext('Forage Fixture', wt)
  assert.deepEqual(k.foraged, ['Misty Thicket', 'Kedge Keep'])
  assert.equal(k.foragedNote, 'Can be foraged anywhere with the Forage skill; {{Zone|Lake Rathetear}}')
  assert.equal(k.foragedCategory, undefined)
})

// Cloak of Treason as the wiki held it on 2026-10-24: the Item Page Blueprint, saved unfilled.
const BLUEPRINT = `{{Classic Era}}
<onlyinclude>{{Itempage
|itemname = Cloak of Treason
|lucy_img_ID = 1234
|statsblock =
Attunable, Lore Equipped, Lore Item, No Trade, Placeable, Quest, Heirloom, Free Storage, No Destroy<br>
Slot: PRIMARY / SECONDARY / RANGE / AMMO / ANY / ARMS / BACK / CHEST/ EAR / FACE / FEET / FINGER / HANDS / HEAD / LEGS / NECK / SHOULDERS / WAIST/ WRIST<br>
STR: +?  STA: +?<br>
|dropsfrom =
[[Zone_Name]]
* [[Mob_Name]]
|relatedquests =
* [[Quest_Name]]
}}</onlyinclude>`

test('AN UNFILLED ITEM BLUEPRINT STATES NOTHING: NO SLOTS, STATS, DROPS, QUESTS, ERA OR ICON', () => {
  assert.equal(isUnfilledItemBlueprint(BLUEPRINT), true)
  const r = parseItemWikitext('Cloak of Treason', BLUEPRINT)
  assert.deepEqual(r, { lore: false, quest: false, questUses: [], dropsFrom: [] })
  // A real page that names a mob is no blueprint.
  assert.equal(isUnfilledItemBlueprint(BLUEPRINT.replace(/Mob_Name/, 'Lord Rikantus Everling').replace(/Zone_Name/, 'Nektropos Castle').replace(/Quest_Name/, 'The Betrayer').replace(/Slot: PRIMARY[^<]*/, 'Slot: BACK')), false)
})
