// The proc gate's app half (upstream issue #69): the preference's shape through the one normalizer,
// and the held-proc catalog the push derives from the inventory dump. The engine half — the swing,
// the window, the one-candidate rule — is proven in engine/crates/fold/tests/proc_debuff.rs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addExternalCaster,
  DEFAULT_BUFF_TRUST_PREFS,
  normalizeBuffTrustPrefs,
  removeExternalCaster,
  setProcDebuffs
} from '../src/shared/buffTrust'
import { heldClickySpells, heldProcSpells, type ItemDb } from '../src/main/itemClickies'

test('the gate is off unless the store says exactly true, and an older store reads as off', () => {
  assert.deepEqual(normalizeBuffTrustPrefs(undefined), DEFAULT_BUFF_TRUST_PREFS)
  assert.deepEqual(normalizeBuffTrustPrefs({ externals: ['Faelin'] }), { externals: ['Faelin'], procDebuffs: false })
  assert.deepEqual(normalizeBuffTrustPrefs({ externals: [], procDebuffs: 'yes' }), { externals: [], procDebuffs: false })
  assert.deepEqual(normalizeBuffTrustPrefs({ externals: [], procDebuffs: true }), { externals: [], procDebuffs: true })
  // A broken list keeps the flag: the two halves are independent answers.
  assert.deepEqual(normalizeBuffTrustPrefs({ externals: 'Faelin', procDebuffs: true }), { externals: [], procDebuffs: true })
})

test('editing the allowlist never flips the gate, and the setter is identity when nothing changes', () => {
  const on = setProcDebuffs(DEFAULT_BUFF_TRUST_PREFS, true)
  assert.equal(on.procDebuffs, true)
  assert.equal(setProcDebuffs(on, true), on)
  assert.equal(addExternalCaster(on, 'Faelin').procDebuffs, true)
  assert.equal(removeExternalCaster(addExternalCaster(on, 'Faelin'), 'faelin').procDebuffs, true)
  assert.equal(setProcDebuffs(on, false).procDebuffs, false)
})

/** A catalog of three: a proc weapon, an instant clicky, and a weapon that both procs and clicks. */
const CATALOG: ItemDb = {
  'orb of tishan': {
    page: 'Orb of Tishan',
    stats: { effects: [{ kind: 'combat', name: 'Tashania', detail: 'Combat, Casting Time: Instant' }] }
  } as unknown as ItemDb[string],
  'wand of allure': {
    page: 'Wand of Allure',
    stats: { effects: [{ kind: 'click', name: 'Allure', detail: 'Casting Time: Instant' }] }
  } as unknown as ItemDb[string],
  'pestilence scythe': {
    page: 'Pestilence Scythe',
    stats: {
      effects: [
        { kind: 'proc', name: 'Vampiric Curse', detail: 'Combat' },
        { kind: 'click', name: 'Vampiric Curse', detail: 'Casting Time: Instant' }
      ]
    }
  } as unknown as ItemDb[string]
}

test('the held-proc catalog names the combat effects of what the dump holds, as display names', () => {
  assert.deepEqual([...heldProcSpells(CATALOG, {})], [])
  assert.deepEqual([...heldProcSpells(CATALOG, { 'orb of tishan': 1 })], ['Tashania'])
  // A count of zero is not held, and a clicky is not a proc.
  assert.deepEqual([...heldProcSpells(CATALOG, { 'orb of tishan': 0, 'wand of allure': 1 })], [])
  // The client's exaltation spelling folds to the catalog's item, as it does for clickies.
  assert.deepEqual([...heldProcSpells(CATALOG, { 'orb of tishan +2* (exaltation)': 1 })], ['Tashania'])
  // One spelling per spell, however many held items proc it.
  assert.deepEqual(
    [...heldProcSpells(CATALOG, { 'orb of tishan': 1, 'pestilence scythe': 2 })],
    ['Tashania', 'Vampiric Curse']
  )
})

test("the wiki's level tail on an effect name is not part of the spell", () => {
  const tailed: ItemDb = {
    'club of the ice ocean': {
      page: 'Club of the Ice Ocean',
      stats: { effects: [{ kind: 'combat', name: 'Frost Strike  Level 51', detail: 'Combat' }] }
    } as unknown as ItemDb[string],
    'dirk of the dain': {
      page: 'Dirk of the Dain',
      stats: { effects: [{ kind: 'combat', name: 'Frost Strike  at lvl 5', detail: 'Combat' }] }
    } as unknown as ItemDb[string]
  }
  assert.deepEqual([...heldProcSpells(tailed, { 'club of the ice ocean': 1, 'dirk of the dain': 1 })], ['Frost Strike'])
})

test('a spell that both procs and clicks is a proc here and never a click there', () => {
  const held = { 'pestilence scythe': 1 }
  assert.deepEqual([...heldProcSpells(CATALOG, held)], ['Vampiric Curse'])
  assert.deepEqual([...heldClickySpells(CATALOG, held)], [])
})
