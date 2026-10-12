// Quest-page parser cases taken from shapes in the committed wiki cache
// (scripts/sources/cache/quests). Wiki text, not game log.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupe, linkTargets, parseQuestPage, splitSections, titleKey, transclusionTargets } from '../scripts/sources/questPage'

const ITEMS = new Set(['harvester', 'rusty scythe', 'shadowbound gloves'])
const isItem = (t: string): boolean => ITEMS.has(t.toLowerCase())

test('a heading followed by a template on the same line still starts a section', () => {
  const wt = `== Reward ==
{{:Harvester}}

== Checklist =={{CheckboxList}}
* [[Rusty Scythe]]
== ShadowBound Gloves =={{CheckboxList}}
`
  const { sections } = splitSections(wt)
  assert.deepEqual(
    sections.map((s) => s.heading),
    ['Reward', 'Checklist', 'ShadowBound Gloves']
  )
  const q = parseQuestPage('Harvester Quest', wt, isItem)
  assert.deepEqual(q.rewards, ['Harvester'])
  assert.deepEqual(q.requiredItems, ['Rusty Scythe'])
})

test('Additional and Possible Rewards headings are reward sections; a mixed Rewards and Walkthrough is not', () => {
  const wt = `== Possible Rewards ==
{{:Harvester}}
== Walkthrough ==
Kill things.
==== Additional Rewards ====
You receive the {{:ShadowBound Gloves}}.
== Rewards and Walkthrough ==
| 1 [[Rusty Scythe]] makes one piece.
`
  const q = parseQuestPage('Mixed', wt, isItem)
  assert.deepEqual(q.rewards, ['Harvester', 'ShadowBound Gloves'])
  assert.deepEqual(q.requiredItems, ['Rusty Scythe'])
})

test('a {{Gear Set|...}} list gives its item pieces as rewards, even under a nested heading', () => {
  const wt = `== Rewards ==
==== Sirtha Scarscale ====
{{Gear Set
|ShadowBound Gloves
|Not An Item
}}
== Walkthrough ==
Bring a [[Rusty Scythe]] and the [[ShadowBound Gloves]] pattern.
`
  const q = parseQuestPage('Gear', wt, isItem)
  assert.deepEqual(q.rewards, ['ShadowBound Gloves'])
  assert.deepEqual(q.requiredItems, ['Rusty Scythe'])
})

test('underscored page names fold to spaces the way MediaWiki reads them', () => {
  assert.deepEqual(transclusionTargets('{{:Rusty_Scythe}} {{:Harvester}}'), ['Rusty Scythe', 'Harvester'])
  assert.deepEqual(linkTargets('[[Rusty_Scythe|a scythe]]'), ['Rusty Scythe'])
  assert.deepEqual(dedupe(['Rusty Scythe', 'rusty_scythe']), ['Rusty Scythe'])
  assert.equal(titleKey(' Rusty__Scythe '), 'rusty scythe')
  const q = parseQuestPage('Underscores', '== Reward ==\n{{:Harvester}}\n== Walkthrough ==\n[[Rusty_Scythe]]\n', isItem)
  assert.deepEqual(q.requiredItems, ['Rusty Scythe'])
})

test('{{Experience}} marks an experience reward like {{exp}} does', () => {
  assert.equal(parseQuestPage('Brain Bite (Evil)', '== Reward ==\n{{Experience}}\n', isItem).expReward, true)
  assert.equal(parseQuestPage('No exp', '== Reward ==\n{{Expand}}\n', isItem).expReward, false)
})

test('an {{:UNKNOWN}} or {{:None}} placeholder box is not a reward', () => {
  const q = parseQuestPage('Placeholder', '== Reward ==\n{{:UNKNOWN}}\n{{:none}}\n{{:Harvester}}\n', isItem)
  assert.deepEqual(q.rewards, ['Harvester'])
})

test('a Recommended Level is not read as the Minimum Level', () => {
  const top = `{| class="questTopTable"
! ''' Quest Giver: '''
| [[Vrynn]]
|-
! ''' Recommended Level: '''
| 15+
|}
`
  const q = parseQuestPage('Totemic Armor Quests', top, isItem)
  assert.equal(q.giver, 'Vrynn')
  assert.equal(q.minLevel, undefined)
})
