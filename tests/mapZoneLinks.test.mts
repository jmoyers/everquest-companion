// The map's CONNECTION LINKS (src/renderer/src/features/maps/zoneLinks.ts) — the boundary
// between "the map file wrote `to_East_Commonlands`" and "clicking that label opens that map".
//
// WHY THIS BOUNDARY EXISTS. The resolution is one regex strip and a table lookup, but what it
// REFUSES is the whole feature: a `to_…` name the hand-authored zone table does not carry
// (later-era zones, in-city sub-labels, multi-zone prose — measured 55 of 274 labels in the
// default map set) must stay a plain label, because a confident click that opens the WRONG map
// is worse than an inert one (world-model law 1: never silently guess). String and table
// arithmetic only — no React, no DOM — so this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionTarget } from '../src/renderer/src/features/maps/zoneLinks'
import type { ZoneShort } from '../src/shared/maps'

/** crossZone.ts's convention, tested below: empty means "not known yet", and gates nothing. */
const NONE: ReadonlySet<ZoneShort> = new Set()

test('a connection label resolves through the zone table, prefix stripped', () => {
  assert.equal(connectionTarget('to East Commonlands', NONE), 'ecommons')
  assert.equal(connectionTarget('to Everfrost Peaks', NONE), 'everfrost')
})

test('the table’s aliases and its leading-article fold both reach the stem', () => {
  // `North Ro` is an alias of `The Northern Desert of Ro` — the mapmaker's spelling, not the log's.
  assert.equal(connectionTarget('to North Ro', NONE), 'nro')
  assert.equal(connectionTarget('to The Feerrott', NONE), 'feerrott')
  assert.equal(connectionTarget('to Feerrott', NONE), 'feerrott')
})

test('a trailing parenthetical is the mapmaker’s prose for the traveller, not part of the name', () => {
  assert.equal(connectionTarget('to Everfrost Peaks (via tunnel)', NONE), 'everfrost')
})

test('a non-connection label is never a link, even when it happens to name a zone', () => {
  assert.equal(connectionTarget('East Commonlands', NONE), null)
  // 'Torto' merely CONTAINS 'to' — the same anchored-prefix guard labelKind is pinned on.
  assert.equal(connectionTarget('Tortoise Pond', NONE), null)
})

test('a name the table refuses stays a plain label — no fuzzy guess, no nearest stem', () => {
  assert.equal(connectionTarget('to Enchanter Guild', NONE), null)
  assert.equal(connectionTarget('to Butcherblock/Ocean of Tears/Qeynos', NONE), null)
})

test('the installed-pack gate: a known stem with no map stays inert; an empty set gates nothing', () => {
  const installed: ReadonlySet<ZoneShort> = new Set(['everfrost'])
  assert.equal(connectionTarget('to Everfrost Peaks', installed), 'everfrost')
  assert.equal(connectionTarget('to East Commonlands', installed), null)
  assert.equal(connectionTarget('to East Commonlands', NONE), 'ecommons')
})
