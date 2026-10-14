// The client spell file's column layout (fix-spells-us-column-shift): the 2026-10-13 game patch
// inserted one column in 52..75, moving the effect slots 172 -> 173. Read from the file, both ways.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INSERTED_COLUMN, spellsUsShifted, unshiftRow } from '../src/main/resist/spellsUsLayout'
import { parseSpellsUs } from '../src/main/resist/spellsUsParse'

const SLOTS = '1|0|-30|0|103|125'

/** A hand-made row (no slice of Daybreak's file enters this repo): a fire nuke, wizard level 1. */
function row(len: number, slotsAt: number, shiftFrom = 999): string {
  const f = Array.from({ length: len }, () => '0')
  for (let i = 36; i < 52; i++) f[i] = '255'
  f[0] = '6'
  f[1] = 'Test Bolt'
  f[29] = '2'
  f[47] = '1'
  f[slotsAt] = SLOTS
  // A patched row: the resist adjustment one column later.
  f[shiftFrom === 999 ? 78 : 79] = '-100'
  return f.join('^')
}

test('an unpatched file is read as before', () => {
  const text = [row(173, 172), row(173, 172)].join('\n')
  assert.equal(spellsUsShifted(text), false)
  const t = parseSpellsUs(text)['test bolt']
  assert.equal(t?.resistAdj, -100)
  assert.ok(t?.hpSlot, 'the damage slot is read')
})

test('a patched file is detected and read with the extra column dropped', () => {
  const text = [row(174, 173, 52), row(174, 173, 52)].join('\n')
  assert.equal(spellsUsShifted(text), true)
  const t = parseSpellsUs(text)['test bolt']
  assert.equal(t?.resistAdj, -100, 'the resist adjustment is back at 78')
  assert.ok(t?.hpSlot, 'the damage slot is back at 172')
})

test('unshift drops exactly one column, at the inserted index, and only from a patched row', () => {
  const f = Array.from({ length: 174 }, (_, i) => String(i))
  assert.equal(unshiftRow([...f], false).length, 174)
  const g = unshiftRow([...f], true)
  assert.equal(g.length, 173)
  assert.equal(g[INSERTED_COLUMN], String(INSERTED_COLUMN + 1))
  assert.equal(g[INSERTED_COLUMN - 1], String(INSERTED_COLUMN - 1))
})
