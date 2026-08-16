// GEAR TAB — the DRAGGED COLUMN WIDTHS (user ask, 2026-08-15: *resize and have the sizes stick*).
//
// The model is deliberately small: a `Record<column id, px>` in localStorage, `null` meaning "never
// dragged" so the automatic layout answers. What is worth pinning is the degradation contract every
// stored gear preference keeps (JOS-105): a value somebody else's build wrote can be garbage, name
// columns this build does not draw, or carry numbers no table can state — and every one of those
// DEGRADES (drops, clamps, or falls back to `null`) instead of reaching a render.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GEAR_WIDTH_MAX,
  GEAR_WIDTH_MIN,
  sanitizeWidths
} from '../src/renderer/src/features/gear/gearPrefs'
import { defaultColumnPx, PICKABLE_COLUMNS } from '../src/renderer/src/features/gear/gearColumns'

test('sanitizeWidths keeps known ids, clamps the numbers, and degrades garbage to null', () => {
  // The happy path: identity ids and numeric keys both store, rounded.
  assert.deepEqual(sanitizeWidths({ name: 300.6, AC: 60, mob: 120 }), { name: 301, AC: 60, mob: 120 })

  // CLAMPED both ways — a 4px column is invisible and a 40000px one is a corrupted write.
  assert.deepEqual(sanitizeWidths({ name: 4 }), { name: GEAR_WIDTH_MIN })
  assert.deepEqual(sanitizeWidths({ name: 40000 }), { name: GEAR_WIDTH_MAX })

  // Unknown ids and non-numbers DROP; a map with nothing left is null, never {}.
  assert.deepEqual(sanitizeWidths({ name: 300, bogus: 200, AC: 'wide', HP: NaN }), { name: 300 })
  assert.equal(sanitizeWidths({ bogus: 200 }), null)
  assert.equal(sanitizeWidths({}), null)

  // Not-a-map degrades to "never dragged".
  assert.equal(sanitizeWidths(null), null)
  assert.equal(sanitizeWidths('300'), null)
  assert.equal(sanitizeWidths([300]), null)
  assert.equal(sanitizeWidths(undefined), null)
})

test('every column the table can draw has a pixel default to start a drag from', () => {
  for (const id of ['name', 'wish', 'slot', 'classes', 'zone', 'zoneLevel', 'mob', 'owned', ...PICKABLE_COLUMNS]) {
    const px = defaultColumnPx(id)
    assert.ok(px >= GEAR_WIDTH_MIN && px <= GEAR_WIDTH_MAX, `${id} defaults to ${String(px)}px`)
  }
})
