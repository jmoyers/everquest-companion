// GEAR TAB — the drop trio's doors (user ask, 2026-08-17). dropLinks.ts turns a drop cell's
// names into the app's existing destinations: a zone spelling into the map stem the Maps tab
// opens, a mob name + witness page into the `MobTarget` the mob page takes. What this file pins
// is the REFUSE-OVER-GUESS structure, not any particular zone table row:
//
//   1. A zone the table refuses (`Various`, the ambiguous city names) yields NO link — the cell
//      stays plain text (world-model law 1: never a nearest guess).
//   2. A catalog spelling the log-side fold cannot reach (`EC`) still resolves — the whole reason
//      `zoneShortNameFromCatalog` is the function under the cell.
//   3. A witness that carried a catalog page pins the target's `entry` to exactly that row; one
//      that carried none degrades to the bare-name target rather than guessing an entry.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MobEntry } from '../src/shared/types'
import {
  dropMobTarget,
  dropZoneTarget,
  resetDropLinkIndex
} from '../src/renderer/src/features/gear/dropLinks'

test('a resolvable zone spelling becomes the map stem the Maps tab opens', () => {
  // The catalog-only spelling is the case the function exists for; the plain name is the common one.
  assert.equal(dropZoneTarget('East Commonlands'), 'ecommons')
  assert.equal(dropZoneTarget('EC'), 'ecommons')
})

test('a refused spelling yields no link — plain text, never a nearest guess', () => {
  assert.equal(dropZoneTarget('Various'), null)
  assert.equal(dropZoneTarget(''), null)
})

const CATALOG: MobEntry[] = [
  { page: 'A bandit (Qeynos Hills)', name: 'a bandit' },
  { page: 'Fippy Darkpaw', name: 'Fippy Darkpaw' }
]

test('a witness page pins the target to exactly that catalog row', () => {
  resetDropLinkIndex()
  const t = dropMobTarget('a bandit', 'A bandit (Qeynos Hills)', CATALOG)
  assert.equal(t.mob, 'a bandit')
  assert.equal(t.entry?.page, 'A bandit (Qeynos Hills)')
})

test('no page means the bare-name target — an entry is pinned, never guessed', () => {
  resetDropLinkIndex()
  const t = dropMobTarget('a bandit', '', CATALOG)
  assert.equal(t.mob, 'a bandit')
  assert.equal(t.entry, undefined)
})

test('a page the catalog does not hold degrades to the bare name too', () => {
  resetDropLinkIndex()
  const t = dropMobTarget('somebody', 'A page that rotted away', CATALOG)
  assert.equal(t.entry, undefined)
})
