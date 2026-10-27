// MAPS — the respawn-timer pin lane (the fork's ask, kaltinril, 2026-08-17). respawnPins.ts
// joins the respawn module's watched rows to the wiki catalog's spawn points for the map on
// screen. What this file pins is the join's three refusals and the clock text's honesty:
//
//   1. ZONE: a row whose raw zone folds to another map — or to none — comes back with NO pins
//      (never filtered out: ruling 4, the served rows are not the renderer's to prune).
//   2. NAME: the join runs `mobKey` on both sides (quote fold), and it does NOT inherit the
//      pane's articled-commons filter — a watch on `a froglok knight` is an explicit clock.
//   3. POSITION: no stated coordinates ⇒ a row with NO pins (returned, so a surface can count
//      it honestly); a multi-zone page ⇒ the same, mobRows' ambiguity rule restated.
//   4. TEXT: an elapsed estimate reads "due", never "up"; no estimate admits it.
//   5. THE CATALOG SIDE IS KEYED ON THE STEM ALONE. The join used to take the stem AND a long
//      zone name, and the surface paired the drawn map with the zone being opened — two places
//      for the length of a fetch. `timerZone` derives the name from the stem, so the pair
//      cannot be written, and is a value a hook can memoize on the stem.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MobEntry } from '../src/shared/types'
import type { RespawnRow } from '../src/shared/respawn'
import {
  placeableTimerPins,
  timerPinLabels,
  timerPinRows,
  timerZone
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

/** The drawn map's catalog side, built once — exactly what the hook memoizes on the stem. */
const QH = timerZone('qeytoqrg', CATALOG)

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
  const out = timerPinRows([row('Fippy Darkpaw')], QH)
  assert.equal(out.length, 1)
  // mapFromLoc: mapX = -ew, mapY = -ns (the one /loc→map seam, JOS-65).
  assert.deepEqual(out[0].pins, [{ x: 200, y: -100 }])
})

test('an articled common joins too — the pane filter is the map list’s, not this lane’s', () => {
  const out = timerPinRows([row('a froglok knight')], QH)
  assert.equal(out[0]?.pins.length, 1)
})

test('a row from another zone is not this map’s business - it comes back PINLESS, never filtered (ruling 4)', () => {
  const elsewhere = row('Fippy Darkpaw', { zone: 'West Commonlands' })
  const out = timerPinRows([elsewhere], QH)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].pins, [])
  assert.deepEqual(placeableTimerPins(out), [])
})

test('no stated position, an unknown name, and a multi-zone page all yield a PINLESS row', () => {
  const out = timerPinRows(
    [row('Rephas'), row('somebody the catalog never met'), row('a wandering thing')],
    QH
  )
  assert.equal(out.length, 3)
  assert.ok(out.every((t) => t.pins.length === 0))
  assert.deepEqual(placeableTimerPins(out), [])
})

test('the clock text: counting down, due, and the honest no-estimate form', () => {
  const base = 1_000_000
  const timed = { ...timerPinRows([row('Fippy Darkpaw', { estimateMs: 60_000 })], QH)[0] }
  assert.equal(timerPinLabels(timed, base + 15_000).text, 'Fippy Darkpaw - respawns in 45s')
  assert.equal(timerPinLabels(timed, base + 90_000).text, 'Fippy Darkpaw - respawn due (30s ago)')
  const untimed = { ...timerPinRows([row('Fippy Darkpaw')], QH)[0] }
  assert.equal(
    timerPinLabels(untimed, base + 120_000).text,
    'Fippy Darkpaw - killed 2m ago, no respawn estimate'
  )
})

test('the always-on clock label: the duration alone, "due", and "?" when nothing is estimated', () => {
  const base = 1_000_000
  const timed = { ...timerPinRows([row('Fippy Darkpaw', { estimateMs: 60_000 })], QH)[0] }
  assert.equal(timerPinLabels(timed, base + 15_000).clock, '45s')
  assert.equal(timerPinLabels(timed, base + 90_000).clock, 'due')
  const untimed = { ...timerPinRows([row('Fippy Darkpaw')], QH)[0] }
  // No estimate ⇒ no invented duration; the hover's full sentence says why.
  assert.equal(timerPinLabels(untimed, base + 120_000).clock, '?')
})

test('the catalog side is keyed on the stem alone — the zone table names the bestiary, not a caller', () => {
  // The bug this pins: the DRAWN map is Qeynos Hills, the zone being opened is elsewhere. The
  // old two-argument join could be handed that pair; this one cannot, and the rows of the drawn
  // map join against the drawn map's own catalog.
  assert.ok(QH, 'a stem the table carries builds a zone')
  assert.equal(QH.stem, 'qeytoqrg')
  assert.equal(timerPinRows([row('Fippy Darkpaw')], QH)[0]?.pins.length, 1)
  // No map on screen ⇒ no zone ⇒ no lane. A stem the table refuses ⇒ a zone with nothing to join.
  assert.equal(timerZone(null, CATALOG), null)
  assert.deepEqual(timerPinRows([row('Fippy Darkpaw')], null), [])
  const unknown = timerZone('notazone' as never, CATALOG)
  assert.equal(unknown?.byKey.size, 0)
})
