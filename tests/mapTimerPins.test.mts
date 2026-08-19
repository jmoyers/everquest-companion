// MAPS — the respawn-timer pin lane (user ask, 2026-08-17). respawnPins.ts joins the respawn
// module's watched rows to the wiki catalog's spawn points for the map on screen. What this
// file pins is the join's three refusals and the clock text's honesty:
//
//   1. ZONE: a row whose raw zone folds to another map — or to none — is not returned at all.
//   2. NAME: the join runs `mobKey` on both sides (quote fold), and it does NOT inherit the
//      pane's articled-commons filter — a watch on `a froglok knight` is an explicit clock.
//   3. POSITION: no stated coordinates ⇒ a row with NO pins (returned, so a surface can count
//      it honestly); a multi-zone page ⇒ the same, mobRows' ambiguity rule restated.
//   4. TEXT: an elapsed estimate reads "due", never "up"; no estimate admits it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MobEntry } from '../src/shared/types'
import type { RespawnRow } from '../src/shared/respawn'
import {
  placeableTimerPins,
  timerPinClock,
  timerPinRows,
  timerPinText
} from '../src/renderer/src/features/maps/respawnPins'

const CATALOG: MobEntry[] = [
  {
    page: 'Fippy Darkpaw',
    name: 'Fippy Darkpaw',
    zones: ['Qeynos Hills'],
    loc: [{ ns: 100, ew: -200 }]
  },
  {
    page: 'A froglok knight (Qeynos Hills)',
    name: 'a froglok knight',
    zones: ['Qeynos Hills'],
    loc: [{ ns: 50, ew: 60 }]
  },
  { page: 'Rephas', name: 'Rephas', zones: ['Qeynos Hills'] },
  {
    page: 'A wandering thing',
    name: 'a wandering thing',
    zones: ['Qeynos Hills', 'West Karana'],
    loc: [{ ns: 1, ew: 2 }]
  }
]

function row(display: string, over: Partial<RespawnRow> = {}): RespawnRow {
  return {
    id: `qeynos hills::${display.toLowerCase()}`,
    key: display.toLowerCase(),
    display,
    zone: 'Qeynos Hills',
    baseTs: 1_000_000,
    basis: 'death',
    source: 'none',
    samples: 0,
    kills: 1,
    ...over
  }
}

test('a timed mob in the drawn zone gets its catalog spawn points, negated into map axes', () => {
  const out = timerPinRows([row('Fippy Darkpaw')], 'qeytoqrg', 'Qeynos Hills', CATALOG)
  assert.equal(out.length, 1)
  // mapFromLoc: mapX = -ew, mapY = -ns (the one /loc→map seam, JOS-65).
  assert.deepEqual(out[0].pins, [{ x: 200, y: -100 }])
})

test('an articled common joins too — the pane filter is the map list’s, not this lane’s', () => {
  const out = timerPinRows([row('a froglok knight')], 'qeytoqrg', 'Qeynos Hills', CATALOG)
  assert.equal(out[0]?.pins.length, 1)
})

test('a row from another zone is not this map’s business', () => {
  const elsewhere = row('Fippy Darkpaw', { zone: 'West Commonlands' })
  assert.deepEqual(timerPinRows([elsewhere], 'qeytoqrg', 'Qeynos Hills', CATALOG), [])
})

test('no stated position, an unknown name, and a multi-zone page all yield a PINLESS row', () => {
  const out = timerPinRows(
    [row('Rephas'), row('somebody the catalog never met'), row('a wandering thing')],
    'qeytoqrg',
    'Qeynos Hills',
    CATALOG
  )
  assert.equal(out.length, 3)
  assert.ok(out.every((t) => t.pins.length === 0))
  assert.deepEqual(placeableTimerPins(out), [])
})

test('the clock text: counting down, due, and the honest no-estimate form', () => {
  const base = 1_000_000
  const timed = { ...timerPinRows([row('Fippy Darkpaw', { estimateMs: 60_000 })], 'qeytoqrg', 'Qeynos Hills', CATALOG)[0] }
  assert.equal(timerPinText(timed, base + 15_000), 'Fippy Darkpaw - respawns in 45s')
  assert.equal(timerPinText(timed, base + 90_000), 'Fippy Darkpaw - respawn due (30s ago)')
  const untimed = { ...timerPinRows([row('Fippy Darkpaw')], 'qeytoqrg', 'Qeynos Hills', CATALOG)[0] }
  assert.equal(
    timerPinText(untimed, base + 120_000),
    'Fippy Darkpaw - killed 2m ago, no respawn estimate'
  )
})

test('the always-on clock label: the duration alone, "due", and "?" when nothing is estimated', () => {
  const base = 1_000_000
  const timed = { ...timerPinRows([row('Fippy Darkpaw', { estimateMs: 60_000 })], 'qeytoqrg', 'Qeynos Hills', CATALOG)[0] }
  assert.equal(timerPinClock(timed, base + 15_000), '45s')
  assert.equal(timerPinClock(timed, base + 90_000), 'due')
  const untimed = { ...timerPinRows([row('Fippy Darkpaw')], 'qeytoqrg', 'Qeynos Hills', CATALOG)[0] }
  // No estimate ⇒ no invented duration; the hover's full sentence says why.
  assert.equal(timerPinClock(untimed, base + 120_000), '?')
})
