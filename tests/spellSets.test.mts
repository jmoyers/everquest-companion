// JOS-391 — WHAT IS IN YOUR GEMS, and which named set holds it.
//
// METHODOLOGY (AGENTS.md): the model is pinned against VERBATIM spans of the owner's real log
// (`tests/fixtures/ss1-load-burst.log`, `ss2-save-over.log`, cut by
// `tests/extract-spell-set-fixtures.mjs` and hand-read line by line below) replayed through the
// REAL `parseEvent` + `SpellSetsModule`. The rules that need a shape the log does not happen to
// contain — the epoch clear, a load that settles into silence — are driven over hand-built events
// so each has its own failure.
//
// ── WINDOW 1, HAND-READ (Sun Jul 19 21:46:20 → 21:47:35) ───────────────────────────────────────
//
//   21:46:20  `Spell set dam loaded.`  and, in the SAME SECOND, ten `You forget` lines
//   21:46:21-30  ten memorizes finish     ← the burst
//   21:46:31  forget Denon's                   ┐ the player keeps swapping BY HAND, never
//   21:46:40  memorize Selo's Accelerando      │ leaving a ten-second gap, so the burst window
//   21:46:43  forget Psalm of Warmth           │ never times out
//   21:46:46  memorize Hymn of Restoration     │
//   21:46:49  forget Guardian Rhythms          │
//   21:46:53  memorize Cassindra's Chant       ┘
//   21:46:57  `Spell set dam saved.`     ← the NEXT spell-set line closes the window
//   21:47:16  `Spell set trav saved.`
//   21:47:35  `Spell set trav saved.`     ← SAVED OVER, one gem different
//
// ── WINDOW 2, HAND-READ (Sun Jul 19 20:11:10 → 20:33:55) ───────────────────────────────────────
//
//   20:11:10  `dam saved` with a bar the log has seen NOTHING of yet  ← the unknown case
//   20:13:09  `buff saved`  (9 spells)
//   20:14:24  `buff saved`  (10 — Symbol of Transal added)            ← the owner's save-over
//   20:14:27  `dam loaded`, burst finishes 20:14:38
//   20:14:49  a hand forget, ELEVEN seconds later                     ← settle by TIMEOUT
//   20:31:46  `som saved`
//   20:31:56  `buff loaded`, burst finishes 20:32:08
//   20:33:50  `dam loaded` — settles `buff` on the way in, and is itself STILL OPEN when the
//             window ends, so `dam` must still read as its 20:14:49 definition
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { SETTLE_MS, SpellSetsModule } from '../src/main/modules/spellSets'
import {
  isMemorized,
  memorizedClause,
  memorizedPhrase,
  setsHolding,
  type SpellSetsSnap
} from '../src/shared/spellSets'
import type { LogEvent } from '../src/shared/logEvents'
import { readFixture } from './harness.mts'

const T = (stamp: string): number => Date.parse(stamp)

/** Replay real log lines through the real parser into a fresh module. */
function fold(lines: string[]): SpellSetsSnap {
  const mod = new SpellSetsModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev, false)
  }
  return mod.snapshot().state
}

test('R1 the parser reads all four gem shapes and nothing else', () => {
  const at = '[Sun Jul 19 21:46:20 2026] '
  const one = (text: string): LogEvent | null => parseEvent(at + text, 1)
  assert.deepEqual(
    { ...one('You have finished memorizing Heat Blood.'), seq: 0, ts: 0, raw: '' },
    { kind: 'spellMemorize', spell: 'Heat Blood', done: true, seq: 0, ts: 0, raw: '' }
  )
  assert.equal(one('Beginning to memorize Denon\'s Disruptive Discord...')?.kind, 'spellMemorize')
  assert.equal(
    (one('Beginning to memorize Denon\'s Disruptive Discord...') as { spell: string }).spell,
    "Denon's Disruptive Discord"
  )
  assert.equal((one('You forget Symbol of Transal.') as { spell: string }).spell, 'Symbol of Transal')
  const set = one('Spell set sham rang buff 2 loaded.') as { set: string; action: string }
  assert.equal(set.set, 'sham rang buff 2', 'a set name keeps its spaces and digits')
  assert.equal(set.action, 'loaded')
  assert.equal((one('Spell set trav deleted.') as { action: string }).action, 'deleted')
  // A verb this family does not know stays unknown rather than arriving as a mystery action.
  assert.equal(one('Spell set trav renamed.')?.kind, 'unknown')
  // And the neighbouring shapes are untouched.
  assert.equal(one('You assume a defensive stance.')?.kind, 'stanceChange')
})

test('R2 the load burst settles on the NEXT spell-set line, and a save-over replaces', () => {
  const snap = fold(readFixture('ss1-load-burst.log'))

  // The bar at the end of the window: ten gems, hand-read above.
  assert.deepEqual(snap.memorized, [
    'Heat Blood',
    'Healing',
    'Anthem de Arms',
    'Desist',
    'Cease',
    'Negation of Life',
    "Selo's Accelerando",
    "Cassindra's Chant of Clarity",
    "Shauri's Sonorous Clouding",
    'Invisibility Versus Undead'
  ])
  // The three spells the player dropped on the way are NOT in it, and the ten the LOAD forgot
  // at 21:46:20 were never claimed as memorized in the first place (rule 1: they were never seen
  // going in, so the module has nothing to remove and nothing to assert about them).
  assert.equal(isMemorized(snap, 'Psalm of Warmth'), false)
  assert.equal(isMemorized(snap, 'Guardian Rhythms'), false)
  assert.equal(isMemorized(snap, 'Hymn of Restoration'), false)

  // `dam` closed at 21:46:57 — the loaded settle and the save land on the same line, and the
  // SAVE is the definition that survives.
  const dam = snap.sets.dam
  assert.equal(dam.source, 'saved')
  assert.equal(dam.observedAt, T('Sun Jul 19 21:46:57 2026'))
  assert.equal(dam.spells.length, 10)
  assert.ok(dam.spells.includes("Cassindra's Chant of Clarity"))
  assert.ok(dam.spells.includes("Largo's Melodic Binding"), 'still in the bar when dam was saved')

  // `trav` was saved TWICE, one gem apart. The second definition is the set.
  const trav = snap.sets.trav
  assert.equal(trav.observedAt, T('Sun Jul 19 21:47:35 2026'))
  assert.ok(trav.spells.includes('Invisibility Versus Undead'), 'memorized between the two saves')
  assert.ok(!trav.spells.includes('Hymn of Restoration'), 'forgotten between the two saves')
  assert.ok(!trav.spells.includes("Largo's Melodic Binding"), 'forgotten before the first save')
  assert.equal(Object.keys(snap.sets).sort().join(','), 'dam,trav', 'two sets, no history')
})

test('R3 a load settles by TIMEOUT, and stays its previous definition until it does', () => {
  const snap = fold(readFixture('ss2-save-over.log'))

  // `dam` was loaded at 20:14:27; its burst finished at 20:14:38 and the next gem line came
  // eleven seconds later, so the definition is stamped at that line and sourced `loaded`.
  const dam = snap.sets.dam
  assert.equal(dam.source, 'loaded')
  assert.equal(dam.observedAt, T('Sun Jul 19 20:14:49 2026'))
  assert.ok(dam.spells.includes("Denon's Disruptive Discord"), 'still in the bar at the settle')

  // The SECOND `dam loaded` (20:33:50) is still open when the window ends, so `dam` reads as the
  // definition above rather than as a bar the game is in the middle of rewriting.
  assert.equal(snap.sets.dam.observedAt, T('Sun Jul 19 20:14:49 2026'))
  assert.equal(snap.memorized.length, 6, 'the bar mid-rewrite: one survivor plus five refilled')
  assert.ok(isMemorized(snap, 'Siphon Life'), 'the gem the load never forgot')

  // `buff` was saved at 20:13:09 and SAVED OVER at 20:14:24 one gem later, then LOADED at
  // 20:31:56 — and that load's settle (triggered by the next spell-set line at 20:33:50)
  // replaced the saved definition again. Three definitions, one survivor.
  assert.equal(snap.sets.buff.source, 'loaded')
  assert.equal(snap.sets.buff.observedAt, T('Sun Jul 19 20:33:50 2026'))

  assert.equal(snap.sets.som.source, 'saved')
  assert.equal(snap.sets.som.observedAt, T('Sun Jul 19 20:31:46 2026'))
})

test('R4 a set saved before the log has seen a single gem claims nothing', () => {
  // `Spell set dam saved.` is the FIRST line of the second window. The module has watched no gem
  // go in, so it knows of no spell in that set — and says so by listing none, never by claiming
  // the set is empty or that a spell is absent from it.
  const first = fold([readFixture('ss2-save-over.log')[0]])
  assert.deepEqual(first.sets.dam.spells, [])
  assert.deepEqual(first.memorized, [])
  assert.equal(setsHolding(first, 'Center').length, 0)
  assert.equal(memorizedPhrase(first, 'Center'), null, 'no sentence at all, never a denial')
})

test('R5 a load that settles into silence closes on the clock', () => {
  const mod = new SpellSetsModule()
  mod.reset()
  const base = T('Sun Jul 19 21:00:00 2026')
  const ev = (n: number, e: Partial<LogEvent> & { kind: string }): LogEvent =>
    ({ seq: n, ts: base + n * 1000, raw: '', ...e }) as LogEvent
  mod.onEvent(ev(0, { kind: 'spellMemorize', spell: 'Healing', done: true }), false)
  mod.onEvent(ev(1, { kind: 'spellSet', set: 'primary', action: 'loaded' }), false)
  mod.onEvent(ev(2, { kind: 'spellForget', spell: 'Healing' }), false)
  mod.onEvent(ev(3, { kind: 'spellMemorize', spell: 'Heat Blood', done: true }), false)
  // Still open one second short of the settle window.
  mod.onTick(base + 3000 + SETTLE_MS - 1000)
  assert.equal(mod.snapshot().state.sets.primary, undefined, 'nothing recorded mid-burst')
  // And closed the moment the window passes, with no further log line at all.
  mod.onTick(base + 3000 + SETTLE_MS)
  const set = mod.snapshot().state.sets.primary
  assert.deepEqual(set.spells, ['Heat Blood'])
  assert.equal(set.source, 'loaded')

  // A `deleted` line drops the set outright: we refer to CURRENT sets and that one is gone.
  mod.onEvent(ev(30, { kind: 'spellSet', set: 'primary', action: 'deleted' }), false)
  assert.equal(mod.snapshot().state.sets.primary, undefined)
})

test('R6 an epoch clears the bar and every set', () => {
  const mod = new SpellSetsModule()
  mod.reset()
  const base = T('Sun Jul 19 21:00:00 2026')
  const ev = (n: number, e: Partial<LogEvent> & { kind: string }): LogEvent =>
    ({ seq: n, ts: base + n * 1000, raw: '', ...e }) as LogEvent
  mod.onEvent(ev(0, { kind: 'spellMemorize', spell: 'Healing', done: true }), false)
  mod.onEvent(ev(1, { kind: 'spellSet', set: 'primary', action: 'saved' }), false)
  assert.equal(mod.snapshot().state.memorized.length, 1)
  mod.onEvent(ev(2, { kind: 'epoch' }), false)
  assert.deepEqual(mod.snapshot().state, { v: 1, memorized: [], sets: {} })
})

test('R7 the sentence a row prints, and the one it refuses to print', () => {
  const snap = fold(readFixture('ss1-load-burst.log'))
  // Memorized AND in a current set.
  assert.equal(
    memorizedPhrase(snap, 'Heat Blood'),
    'Heat Blood is memorized now, in set dam, trav'
  )
  // Memorized, in no set the log has a current definition for → the short form.
  assert.equal(memorizedPhrase(snap, 'Invisibility Versus Undead')?.startsWith('Invisibility Versus Undead is memorized now'), true)
  // Never seen memorized → NOTHING. Not "not memorized", not "in no set".
  assert.equal(memorizedPhrase(snap, 'Complete Heal'), null)
  assert.equal(memorizedPhrase(snap, 'Guardian Rhythms'), null, 'forgotten is not a denial, it is silence')
  // Case and spacing do not matter to the lookup.
  assert.equal(isMemorized(snap, '  heat   blood '), true)
  // No em dashes in anything a player reads.
  for (const name of snap.memorized) assert.ok(!/[—–]/.test(String(memorizedPhrase(snap, name))))

  // THE SAME SENTENCE WITH THE NAME LIFTED OUT (JOS-392): the panel makes that name a hover target
  // for the spell card, so the clause is exported rather than sliced off the phrase by a renderer.
  // Composition is the pin — the two can never state different sentences.
  assert.equal(memorizedClause(snap, 'Heat Blood'), ' is memorized now, in set dam, trav')
  assert.equal(memorizedClause(snap, 'Complete Heal'), null)
  for (const name of snap.memorized) {
    assert.equal(`${name}${String(memorizedClause(snap, name))}`, memorizedPhrase(snap, name))
  }
})

test('R8 the delta is the whole state, and only when something changed', () => {
  const mod = new SpellSetsModule()
  mod.reset()
  const base = T('Sun Jul 19 21:00:00 2026')
  assert.equal(mod.flushDelta(), null, 'a module that folded nothing pushes nothing')
  mod.onEvent({ kind: 'spellMemorize', spell: 'Healing', done: true, seq: 1, ts: base, raw: '' }, true)
  const out = mod.flushDelta()
  assert.deepEqual(out?.delta.memorized, ['Healing'])
  assert.equal(mod.flushDelta(), null, 'and nothing again until the next change')
  // A begin line is not a change to the bar.
  mod.onEvent({ kind: 'spellMemorize', spell: 'Yaulp', done: false, seq: 2, ts: base + 1000, raw: '' }, true)
  assert.equal(mod.flushDelta(), null)
})
