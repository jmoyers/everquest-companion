// Mob page reader (src/main/mobLookupParse.ts, scripts/sources/mobPage.ts) on shapes found in the
// cached wiki corpus. Fixtures are trimmed copies of the pages they are named after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMobLoot, parseMobWikitext } from '../src/main/mobLookupParse'
import { factionAmountList, parseMobPage } from '../scripts/sources/mobPage'

test('known_loot written as [[Item]] links is read as drops (A Blood Wolf, Gnawfang)', () => {
  const wolf = '* [[Chunk of Meat]]\n* [[Mist Wolf Pelt]]\n* [[Ruined Wolf Pelt]]\n* [[Wolf Meat]]'
  assert.deepEqual(parseMobLoot(wolf).map((d) => d.item), ['Chunk of Meat', 'Mist Wolf Pelt', 'Ruined Wolf Pelt', 'Wolf Meat'])
  const gnawfang = "<ul>\n<li>  {{:Gnawfang's Pelt}}  </li>\n<li> {{:Gnawfang's Tooth}}  </li>\n<li> [[High Quality Cat Pelt]] </li>\n</ul>"
  assert.deepEqual(parseMobLoot(gnawfang).map((d) => d.item), ["Gnawfang's Pelt", "Gnawfang's Tooth", 'High Quality Cat Pelt'])
})

test('a spell link reads its Spell: label, a piped transclusion its target, underscores fold, and dupes collapse', () => {
  const block = [
    "* [[Improved Invisibility|Spell: Improved Invisibility]] <span class='drare'>(Rare)</span>",
    '* {{:A Mandible|Mandible}} (Common)',
    '* {{:Brass_Knuckles}}',
    '* [[Brass Knuckles]]',
    '* [[Category:Loot]]'
  ].join('\n')
  assert.deepEqual(parseMobLoot(block), [
    { item: 'Spell: Improved Invisibility', rarity: 'Rare' },
    { item: 'A Mandible', rarity: 'Common' },
    { item: 'Brass Knuckles' }
  ])
})

test('a link inside a note is not a drop, and a quoted scroll name is not a rarity', () => {
  const block = '* {{:Cloak of Leaves}} (Rare, [[Lesser Faydark]])\n* {{:Illegible Scroll}} ("Vok Na Zov V")'
  const drops = parseMobLoot(block)
  assert.deepEqual(drops.map((d) => d.item), ['Cloak of Leaves', 'Illegible Scroll'])
  assert.equal(drops[1].rarity, undefined)
})

test('zones separated by <br>, newlines or side-by-side links stay separate (A Tottering Gorilla, A Treant)', () => {
  const page = (zone: string): string => `{{Namedmobpage\n| name = x\n| zone = ${zone}\n| level = 10\n}}`
  assert.deepEqual(parseMobPage('A Tottering Gorilla', page('[[Burning Woods]]<br>[[Emerald Jungle]]'))?.zones, ['Burning Woods', 'Emerald Jungle'])
  assert.deepEqual(parseMobPage('A Treant', page('[[Eastern Plains of Karana]] [[Western Plains of Karana]]'))?.zones, [
    'Eastern Plains of Karana',
    'Western Plains of Karana'
  ])
  assert.deepEqual(parseMobPage('A Black Wolf', page('[[East Commonlands]]\n[[East Karana]]\n[[The Feerrott]]'))?.zones, [
    'East Commonlands',
    'East Karana',
    'The Feerrott'
  ])
  assert.equal(parseMobWikitext(page('[[Burning Woods]]<br>[[Emerald Jungle]]')).zone, 'Burning Woods, Emerald Jungle')
})

test('a |name typed with underscores reads as the spaced name the game prints', () => {
  assert.equal(parseMobWikitext('{{Namedmobpage\n| name = a_minnow\n| level = 1\n}}').pageName, 'a minnow')
})

test('the page era banner is kept as eraTag, right after page, and absent when the page states none', () => {
  const body = '{{Namedmobpage\n| name = A Hatebone Drake\n| zone = [[Plane of Hate]]\n| level = 52\n}}'
  const drake = parseMobPage('A Hatebone Drake', `{{FearHateRevamp Era}}${body}`)
  assert.equal(drake?.eraTag, 'FearHateRevamp')
  assert.deepEqual(Object.keys(drake ?? {}).slice(0, 3), ['page', 'eraTag', 'name'])
  const bare = parseMobPage('A Hatebone Drake', body)
  assert.equal(bare?.eraTag, undefined)
  assert.equal(bare !== null && 'eraTag' in bare, false)
})

test('the wiki era rule: the page banner decides, whatever zone the page names', () => {
  const page = (era: string, zone: string): string => `{{${era} Era}}{{Namedmobpage\n| name = x\n| zone = [[${zone}]]\n| level = 10\n}}`
  assert.equal(parseMobPage('A Hatebone Drake', page('FearHateRevamp', 'Plane of Hate'))?.outOfEra, true)
  // A Kunark addition to a classic zone is out: the classic zone does not rescue it.
  assert.equal(parseMobPage('Eejag', page('Kunark', 'Lavastorm Mountains'))?.outOfEra, true)
  assert.equal(parseMobPage('A Kael Drakkel guard', page('Velious', 'Kael Drakkel'))?.outOfEra, true)
  // In-era and unbannered mobs carry no flag at all.
  assert.equal(parseMobPage('A rat', page('Classic', 'Befallen'))?.outOfEra, undefined)
})

test('a merchant page is marked, and a page names the factions a kill moves (Gaps tab, 2026-10-18)', () => {
  const merchant = parseMobPage('Murga', '{{MerchantPage\n| name = Murga\n| zone = [[The Feerrott]]\n| items_sold =\n}}')
  assert.equal(merchant?.merchant, true)
  const mob = parseMobPage(
    'A zol ghoul knight',
    '{{Namedmobpage\n| name = a zol ghoul knight\n| factions =\n* [[Undead Frogloks of Guk]] (-20)\n| opposing_factions =\n* [[Frogloks of Guk]] (+5)\n}}'
  )
  assert.equal(mob?.merchant, undefined)
  assert.deepEqual(mob?.factions, ['Undead Frogloks of Guk', 'Frogloks of Guk'])
})

test('a loot link with a leading colon is the page without it (2026-10-18: Gaps showed a group `:Raw-hide Armor`)', () => {
  const block = '<ul>\n<li> [[:Raw-hide Armor]] (Common)\n</li><li> [[:Rat Tooth|Rat Tooth]]\n</li></ul>'
  assert.deepEqual(parseMobLoot(block).map((d) => d.item), ['Raw-hide Armor', 'Rat Tooth'])
})

test('common_loot is read beside known_loot (owner, 2026-10-19: a drop listed there is listed)', () => {
  const wt = [
    '{{Namedmobpage',
    '| name = a froglok forager',
    '| known_loot = ',
    '',
    "<ul><li> {{:Froglok Meat}} <span class='drare'>(Common)</span>",
    '</li></ul>',
    '| common_loot = ',
    '',
    '<ul><li> [[Classic Raid Tier Treasures]] (Rare)',
    '</li><li> {{:Jade Ring}}',
    '</li></ul>',
    '| factions = ',
    '}}'
  ].join('\n')
  const entry = parseMobPage('A froglok forager', wt)
  assert.deepEqual(entry?.drops, ['Froglok Meat'])
  assert.deepEqual(entry?.commonDrops, ['Classic Raid Tier Treasures', 'Jade Ring'])
})

test('factionAmounts: each listed faction with the amount its bullet states (owner, 2026-10-20; A Troll Slayer)', () => {
  const wt = [
    '{{Namedmobpage',
    '| name              = a troll slayer',
    '| factions = ',
    '',
    "* [[DaBashers|Da Bashers]] <span class='profac'>(-10) to (-30) (unconfirmed)</span>",
    '',
    '| opposing_factions = ',
    '',
    "* [[Broken Skull Clan]] <span class='oppfac'>(10)</span>",
    '',
    '| related_quests = ',
    '}}'
  ].join('\n')
  const entry = parseMobPage('A Troll Slayer', wt)
  assert.deepEqual(entry?.factions, ['Da Bashers', 'Broken Skull Clan'])
  assert.deepEqual(entry?.factionAmounts, ['-30..-10?', '10'])
  assert.deepEqual(Object.keys(entry ?? {}).slice(-2), ['factions', 'factionAmounts'])
})

test('factionAmounts read the shapes the cached pages write, and state no amount they do not give', () => {
  const page = (factions: string[], opposing: string[]): string =>
    ['{{Namedmobpage', '| name = x', '| factions =', ...factions, '| opposing_factions =', ...opposing, '}}'].join('\n')
  const amounts = factionAmountList(
    page(
      [
        "* [[Merchants of Kaladim]] <span class='profac'>(-1)</span>",
        "* [[Emerald Warriors]] <span class='profac'>-15</span>",
        '* [[Inhabitants of Hate]] (-10?)',
        "* [[Velketor]] <span class='profac'>(-0)</span>",
        "* [[Clan Runnyeye]] <span class='profac'>(?)</span>",
        "* [[Clerics of Tunare]] <span class='profac'>(~-500)</span>",
        "* [[Heretics]] <!-- <span class='profac'>(-30)</span>",
        '* EmeraldWarriors (-30)',
        "* [[Dark Bargainers]] <span class='oppfac'>(10)</span>",
        '* None'
      ],
      ["* [[Guards of Qeynos]] <span class='oppfac'>(+)</span>", "* [[Allize Volew]] <span class='profac'>(-5)</span>", '* Meldrath', '* None']
    )
  )
  assert.deepEqual(amounts, [
    '-1',
    '-15',
    '-10?',
    // `(-0)` is a listed hit of unstated size (owner, 2026-10-10); so are `(?)`, `(~-500)` and a commented-out amount.
    '-',
    '-',
    '-',
    '-',
    '-30',
    // The stated sign outranks the field and the span class (Guard T`Aba, Mortificator Syythrak).
    '10',
    '+',
    '-5',
    '+'
  ])
  assert.equal(parseMobPage('x', page(['* None'], ['* None']))?.factionAmounts, undefined)
})
