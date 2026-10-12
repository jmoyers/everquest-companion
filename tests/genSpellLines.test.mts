// gen-spell-lines set-vs-ladder classification, built in memory from the committed research
// (nothing is written).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from '../scripts/gen-spell-lines'

const line = (cls: string, id: string): { ladder: boolean } | undefined =>
  (build().file.classes as Record<string, { id: string; ladder: boolean }[]>)[cls]?.find((l) => l.id === id)

test('summon and utility lines whose members are different things are sets, not ladders', () => {
  for (const [cls, id] of [
    ['MAG', 'mag-summon-food-drink'],
    ['MAG', 'mag-summon-ammo'],
    ['MAG', 'mag-summon-stones'],
    ['DRU', 'food-line'],
    ['SHM', 'summon-sustenance'],
    ['NEC', 'nec-travel'],
    ['WIZ', 'wiz-shadowstep']
  ]) assert.equal(line(cls, id)?.ladder, false, `${cls} ${id}`)
})

test('real upgrade ladders in the same categories stay ladders', () => {
  for (const [cls, id] of [
    ['CLR', 'summon-drink-line'],
    ['CLR', 'hammer-line'],
    ['MAG', 'mag-summon-phantom-armor-sets'],
    ['SHM', 'cannibalize']
  ]) assert.equal(line(cls, id)?.ladder, true, `${cls} ${id}`)
})
