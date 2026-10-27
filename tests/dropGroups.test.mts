// The pages mob drop lists link that are not items (owner ask, 2026-10-18): a group's members, in
// the four shapes the wiki writes them. Fixtures only, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aliasedItem, groupMembers, groupTitles } from '../scripts/scrape-drop-groups'

const items = new Set(['rusty axe', 'rusty dagger', 'cloth shirt', 'cloth cap', 'amber', 'bronze axe', 'gloves of earthcrafting'])

test('a group page lists its items as bullets, list items, table cells or a Gear Set', () => {
  assert.deepEqual(groupMembers('Intro [[Fine Steel Weapons]].\n*[[Rusty Axe]]\n*[[Rusty Dagger]]\n*[[Not An Item]]', items), ['Rusty Axe', 'Rusty Dagger'])
  assert.deepEqual(groupMembers('<ul><li> {{:Amber}}\n</li></ul>', items), ['Amber'])
  assert.deepEqual(groupMembers('{| class="wikitable"\n|-\n|{{:Bronze Axe}}\n|5\n|}', items), ['Bronze Axe'])
  assert.deepEqual(groupMembers('*[[Rusty Axe]]\n{{Gear Set\n|Cloth Shirt\n|Cloth Cap\n}}', items), ['Cloth Cap', 'Cloth Shirt'])
})

test('an item, mob or spell page is no group, and scrolls and items are never asked for', () => {
  assert.deepEqual(groupMembers('{{Spellpage|\n| items_with_effect =\n* [[Gloves of Earthcrafting]]\n}}', items), [])
  assert.deepEqual(groupMembers('{{Itempage\n|itemname = X\n}}\n*[[Rusty Axe]]', items), [])
  assert.deepEqual(groupTitles([{ drops: ['Rusty Axe', 'Rusty Weapons', 'Spell: Translocate', 'Cloth Armor'] }], items), ['Cloth Armor', 'Rusty Weapons'])
})

test('a drop-list link that redirects to an item page is that item (review 2026-10-19: A Wooden Heart)', () => {
  const keys = new Set(['wooden heart'])
  assert.equal(aliasedItem('{{Classic Era}}\n<onlyinclude>{{Itempage\n|itemname = Wooden Heart\n}}</onlyinclude>', keys), 'Wooden Heart')
  assert.equal(aliasedItem('{{Itempage\n|itemname = Not Keyed\n}}', keys), null)
  assert.equal(aliasedItem('* [[Rusty Axe]]', keys), null)
})
