// The Ready tab's class pick (owner, 2026-10-11): "my class, or whatever class I chose". The pick
// narrows the ready list to the named classes; no pick is every class, as the tab always showed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { filterReadyByClass } from '../src/renderer/src/features/posky/readyClasses.ts'

const READY = [
  { className: 'Bard', name: 'Bard Test of Voice' },
  { className: 'Beastlord', name: 'Beastlord Test of Azarack' },
  { className: 'Cleric', name: 'Cleric Test of Courage' },
  { className: 'Bard', name: 'Bard Test of Song' }
]

test('no pick keeps every ready quest, in order', () => {
  assert.deepEqual(filterReadyByClass(READY, []), READY)
})

test('a pick keeps the named classes only, and any number of them', () => {
  assert.deepEqual(
    filterReadyByClass(READY, ['Bard']).map((q) => q.name),
    ['Bard Test of Voice', 'Bard Test of Song']
  )
  assert.deepEqual(
    filterReadyByClass(READY, ['Cleric', 'Beastlord']).map((q) => q.name),
    ['Beastlord Test of Azarack', 'Cleric Test of Courage']
  )
  assert.deepEqual(filterReadyByClass(READY, ['Wizard']), [])
})
