// COMBAT VIEW PREFERENCES — the vocabulary behind two owner rulings.
//
// JOS-115 moved the You / Group / Everyone meter scope off every combat surface and into one
// persisted preference; JOS-116 made the DRILL a persisted preference too, so switching tabs stops
// throwing away where you were. Both live in `features/combat/combatPrefs.ts`, which is DOM-free
// on purpose — the hooks around it (useCombatPrefs.ts) only move strings in and out of
// localStorage, and everything that can silently go wrong is here: a default, a guard, a degrade.
//
// WHAT IS WORTH PINNING, and why each one is not obvious:
//   * the DEFAULT scope is Group, and an ABSENT key is that default rather than 'you'. A user who
//     has never opened Preferences has not chosen You (owner ruling: "fresh install and absent key
//     both resolve to Group").
//   * anything that is not one of the three degrades to the default. A meter is never blank
//     because a value was hand-edited or written by a future build.
//   * a stored drill is TOTAL: absent, empty, malformed JSON, an array, an unknown arm and a
//     missing id all land on level 1 — the JOS-105 degrade rule, one step earlier than usual.
//   * "level 1, nothing expanded" is written as an ABSENT KEY, so a fresh install and an explicit
//     un-drill leave the store in exactly the same state.
//   * changing the drilled SUBJECT drops the expanded abilities (they name bars in the old
//     subject's list); re-drilling the SAME subject keeps them.
//
// The OTHER half of the degrade — a drill this build can read but the current fight cannot
// RESOLVE — is `petRows.meterPanel`'s and is pinned in tests/combatPetNesting.test.mts. Nothing
// here duplicates it; this file's job is the shape that reaches the builder.
//
// No window, no React, no Electron — this suite can never skip.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_METER_SCOPE,
  METER_SCOPE_KEY,
  NO_DRILL,
  abilityKey,
  drillKey,
  parseDrillMemory,
  readMeterScope,
  serializeDrillMemory,
  withAbility,
  withDrill,
  type DrillMemory
} from '../src/renderer/src/features/combat/combatPrefs'
import { METER_SCOPES } from '../src/shared/roster'

// ── JOS-115: whose damage ────────────────────────────────────────────────────────────────

test('the meter scope defaults to Group — for a fresh install and an absent key alike', () => {
  assert.equal(DEFAULT_METER_SCOPE, 'group')
  assert.equal(readMeterScope(null), 'group')
  assert.equal(readMeterScope(''), 'group')
})

test('each of the three scopes round-trips, and nothing else does', () => {
  for (const s of METER_SCOPES) assert.equal(readMeterScope(s), s)
  // Hand-edited, capitalised, a future build's fourth state, or a whole JSON blob in the slot:
  // every one of them is the DEFAULT rather than an empty meter.
  for (const junk of ['You', 'GROUP', 'party', 'raid', '{"scope":"you"}', ' you', 'you ', '0', 'null']) {
    assert.equal(readMeterScope(junk), 'group', `${junk} must degrade to the default`)
  }
})

test('the scope is ONE key for every surface — no per-surface suffix survives', () => {
  // The suffixed keys JOS-115 retired (`eq.combat.meterScope.combat`, `.overlay.fight`, …) are
  // left inert; what matters here is that the live key is the bare one, so the Combat tab, the
  // Overview card and every floating overlay are reading and writing the same string.
  assert.equal(METER_SCOPE_KEY, 'eq.combat.meterScope')
  assert.ok(!METER_SCOPE_KEY.endsWith('.'), 'the key is complete, not a prefix a surface appends to')
})

// ── JOS-116: where you had drilled to ────────────────────────────────────────────────────

test('the drill key is per surface, under the combat prefs namespace', () => {
  assert.equal(drillKey('combat'), 'eq.combat.drill.combat')
  assert.equal(drillKey('overview'), 'eq.combat.drill.overview')
  // Two surfaces, two keys: the glance card may never move the Combat tab's drill.
  assert.notEqual(drillKey('combat'), drillKey('overview'))
})

test('an unreadable stored drill degrades to level 1 rather than to an error', () => {
  const bad = [
    null,
    '',
    'not json',
    '[]',
    '{',
    '"you"',
    '42',
    'null',
    '{"d":{"kind":"category","category":"melee"}}', // the level JOS-113 deleted
    '{"d":{"kind":"entity"}}', // an arm with no id
    '{"d":{"kind":"entity","entityId":""}}',
    '{"d":{"kind":"target","target":42}}',
    '{"d":"you"}'
  ]
  for (const raw of bad) {
    assert.deepEqual(parseDrillMemory(raw), NO_DRILL, `${String(raw)} must resolve to level 1`)
  }
})

test('a real drill round-trips through the store, abilities and all', () => {
  const m: DrillMemory = {
    drill: { kind: 'entity', entityId: 'you' },
    abilities: [abilityKey('melee', 'Kick'), abilityKey('spell', 'Dragon Punch')]
  }
  const raw = serializeDrillMemory(m)
  assert.ok(raw !== null)
  assert.deepEqual(parseDrillMemory(raw), m)

  const mob: DrillMemory = { drill: { kind: 'target', target: 'a puma' }, abilities: [] }
  assert.deepEqual(parseDrillMemory(serializeDrillMemory(mob)), mob)
})

test('level 1 with nothing expanded is stored as an ABSENCE, so it matches a fresh install', () => {
  assert.equal(serializeDrillMemory(NO_DRILL), null)
  assert.equal(serializeDrillMemory({ drill: null, abilities: [] }), null)
})

test('expanded abilities with NO drill are legal — that is the Incoming direction', () => {
  // The Incoming meter has no drill at all: an enemy's flat skill list expands inline at level 1
  // (EntityRow), out of the same `SkillBar`. Those bars get the same memory, so the state is a
  // real one rather than a contradiction to collapse.
  const inline: DrillMemory = { drill: null, abilities: ['melee|Slash'] }
  assert.deepEqual(parseDrillMemory(serializeDrillMemory(inline)), inline)
})

test('junk inside the ability list is dropped, not carried', () => {
  const m = parseDrillMemory('{"d":{"kind":"entity","entityId":"you"},"a":["melee|Kick",7,null,"",{"x":1}]}')
  assert.deepEqual(m.drill, { kind: 'entity', entityId: 'you' })
  assert.deepEqual(m.abilities, ['melee|Kick'])
  // `a` missing entirely, or the wrong type, is simply nothing expanded.
  assert.deepEqual(parseDrillMemory('{"d":{"kind":"entity","entityId":"you"}}').abilities, [])
  assert.deepEqual(parseDrillMemory('{"d":{"kind":"entity","entityId":"you"},"a":"melee|Kick"}').abilities, [])
})

test('changing the drilled SUBJECT drops the expansions; re-drilling the same one keeps them', () => {
  const open: DrillMemory = { drill: { kind: 'entity', entityId: 'you' }, abilities: ['melee|Kick'] }

  // The same subject again is not a reset — a click that lands where you already are changes
  // nothing, and returns the SAME object so no write and no re-render is provoked.
  assert.equal(withDrill(open, { kind: 'entity', entityId: 'you' }), open)

  // A different entity: the abilities named bars in YOUR list, and carrying "Kick was open" into
  // the pet's would open whatever happened to share the name.
  assert.deepEqual(withDrill(open, { kind: 'entity', entityId: 'pet:Gorlag' }), {
    drill: { kind: 'entity', entityId: 'pet:Gorlag' },
    abilities: []
  })
  // A mob drill is a subject change too.
  assert.deepEqual(withDrill(open, { kind: 'target', target: 'a puma' }), {
    drill: { kind: 'target', target: 'a puma' },
    abilities: []
  })

  // UN-DRILLING IS ALWAYS A FULL RESET — `null` is not a subject you can already be on, and Back /
  // All / Esc / a fight change all mean "put this surface back the way it opens".
  assert.deepEqual(withDrill(open, null), NO_DRILL)
  assert.equal(withDrill(NO_DRILL, null), NO_DRILL, 'already at level 1 ⇒ no change and no write')
  assert.deepEqual(withDrill({ drill: null, abilities: ['melee|Slash'] }, null), NO_DRILL)
})

test('an ability opens and closes idempotently, and a no-op click writes nothing', () => {
  const base: DrillMemory = { drill: { kind: 'entity', entityId: 'you' }, abilities: [] }
  const opened = withAbility(base, 'melee|Kick', true)
  assert.deepEqual(opened.abilities, ['melee|Kick'])
  // Two at once is legal: the bars never took turns, and JOS-116 is not allowed to change that.
  const two = withAbility(opened, 'spell|Dragon Punch', true)
  assert.deepEqual(two.abilities, ['melee|Kick', 'spell|Dragon Punch'])

  assert.equal(withAbility(two, 'melee|Kick', true), two, 'opening an open ability changes nothing')
  assert.equal(withAbility(base, 'melee|Kick', false), base, 'closing a closed ability changes nothing')

  assert.deepEqual(withAbility(two, 'melee|Kick', false).abilities, ['spell|Dragon Punch'])
  // Closing the last one leaves the drill standing — collapsing stats is not backing out.
  const none = withAbility(withAbility(two, 'melee|Kick', false), 'spell|Dragon Punch', false)
  assert.deepEqual(none, { drill: { kind: 'entity', entityId: 'you' }, abilities: [] })
})

test('the ability key is the bars own key — category then name', () => {
  assert.equal(abilityKey('melee', 'Kick'), 'melee|Kick')
  assert.equal(abilityKey('slay', 'Slay Undead'), 'slay|Slay Undead')
})
