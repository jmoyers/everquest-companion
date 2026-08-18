// The con card's arrival in a store that has never heard of it (JOS-383).
//
// A companion to `storeMigrations.test.mts` and its siblings (`…Toast` 9, `…Presence` 5,
// `…Telemetry` 6, `…Perf` 7, `…Voice` 4+8, `…EqNote` 13), for the same reason those are separate
// files: the first is at the repo's 400-code-line factoring ceiling, and the answer to that is a
// split rather than a widened threshold.
//
// WHY THERE IS NO MIGRATION HERE, AND WHY THAT DESERVES A TEST OF ITS OWN.
//
// This is the first overlay kind ever to ship ON that was not already stored somewhere, and "ships
// ON" is exactly the shape that has needed a migration once before: the celebration toast's 8 -> 9
// step exists because `overlays.toast` was ALREADY WRITTEN as `false` in every store that had run
// the previous day's build, so changing the default alone would have left it off forever.
//
// `overlays.conCard` has never been written by any build. A DEFAULT decides the value of an ABSENT
// key, so every store on earth — a fresh install, a v1 file from the first commit, and the fully
// populated current-schema fixture below — reads `DEFAULT_OVERLAY_CONFIG.conCard` and gets the card, with
// nothing rewritten and no stored value reinterpreted. The claims below are that the chain stays
// out of it entirely, and that the shipped default is the ON the owner asked for.
//
// The store's own reader (`getOverlayConfig`) is not importable here — it is `electron-store` —
// so the default is asserted from the DECLARATION in main/store.ts, read as text. That is the same
// instrument `overlayLockedSelector.test.mts` uses on the click-through gate, and for the same
// reason: the fact under test is a one-line policy statement, and the alternative is an e2e launch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURRENT_SCHEMA_VERSION, migrateStoreData, type StoreData } from '../src/main/storeMigrations'
import { DEFAULT_CON_CARD_CONFIG, normalizeConCardConfig } from '../src/shared/conCard'
import { OVERLAY_KINDS } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const fixture = (name: string): StoreData => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const src = (rel: string): string => readFileSync(join(HERE, rel), 'utf8')

/**
 * `store-v14-con-card.json` — a store at TODAY's schema: three overlay kinds configured (a meter,
 * the toast and the alert banner, each with its own blob) and no `conCard` key anywhere, because
 * no build has one to write.
 *
 * IT IS RE-PINNED WHENEVER THE SCHEMA MOVES, and the pinning is the point. The first claim below
 * is that a CURRENT store does not run the chain at all — which is what makes "a new overlay kind
 * is not a schema change" a fact about this build rather than about the day it was written. When
 * JOS-385 added the `resists` blob at v14, the v13 copy of this fixture stopped being current and
 * became what it should be: the input to THAT step's own test (storeMigrationsResists.test.mts).
 */
const CURRENT = 'store-v14-con-card.json'

const overlaysOf = (d: StoreData): Record<string, StoreData> => d['overlays'] as Record<string, StoreData>

test('a store at today’s schema needs nothing: the chain does not run', () => {
  const before = fixture(CURRENT)
  const out = migrateStoreData(before)
  assert.equal(out.status, 'up-to-date', 'a new kind is not a schema change')
  assert.equal(out.changed, false)
  assert.deepEqual(out.applied, [])
  assert.deepEqual(out.data, before, 'the file comes back byte-identical')
  assert.equal(before['schemaVersion'], CURRENT_SCHEMA_VERSION, 'the fixture is pinned to today’s version')
})

test('nothing invents an `overlays.conCard` block — the absent key IS the answer', () => {
  const { data } = migrateStoreData(fixture(CURRENT))
  assert.equal('conCard' in overlaysOf(data), false)
  // …and every kind the user HAS configured survives untouched, including the two blobs.
  const before = fixture(CURRENT)
  for (const kind of ['fight', 'toast', 'alertBanner']) {
    assert.deepEqual(overlaysOf(data)[kind], overlaysOf(before)[kind], `${kind} must survive untouched`)
  }
  for (const key of ['byCharacter', 'alerts', 'alertPrefs', 'voice', 'telemetry', 'perfHud', 'processPriority']) {
    assert.deepEqual(data[key], before[key], `${key} must survive untouched`)
  }
})

test('an OLD store reaches today with no con-card key either, however far back it starts', () => {
  // The oldest files this repo can be handed. None of them can carry the key, and none of them
  // grows one on the way through the chain: the whole point of a default is that it needs no step.
  for (const name of ['store-v1-first-build.json', 'store-v1-pre-framework.json', 'store-v8-toast-off.json']) {
    const out = migrateStoreData(fixture(name))
    assert.equal(out.data['schemaVersion'], CURRENT_SCHEMA_VERSION, name)
    const overlays = out.data['overlays'] as Record<string, unknown> | undefined
    assert.equal(overlays === undefined || !('conCard' in overlays), true, `${name}: no key invented`)
  }
})

test('THE SHIPPED DEFAULT IS ON, and it is the only one of the strips that is', () => {
  const store = src('../src/main/store.ts')
  // The declaration itself, because that line is the whole feature's "ships on" claim.
  assert.match(store, /conCard: \{ open: true, locked: true,/)
  assert.match(store, /alertBanner: \{ open: false, locked: true,/, 'the banner still ships off')
  // And the reason is written down beside it rather than left to be rediscovered.
  assert.match(store, /DEFAULT \*\*ON\*\*, AND STILL NO MIGRATION/)
})

test('the knob is normalized on both sides of the store, so a hand-edited file cannot widen it', () => {
  const store = src('../src/main/store.ts')
  // getOverlayConfig (the read) and setOverlayConfig (the write) both run it — two call sites,
  // exactly as the toast and banner blobs have.
  assert.equal((store.match(/applyConCardKnob\(/g) ?? []).length, 2)
  // …and the applier itself is what deletes the blob everywhere else, so no meter may grow one
  // from a malformed patch.
  assert.match(src('../src/shared/conCard.ts'), /else delete cfg\.conCard/)
  // The normalizer's own contract is pinned in tests/conCard.test.mts; this is the wiring claim.
  assert.deepEqual(normalizeConCardConfig(DEFAULT_CON_CARD_CONFIG), DEFAULT_CON_CARD_CONFIG)
  assert.ok(OVERLAY_KINDS.includes('conCard'))
})
