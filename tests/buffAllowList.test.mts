// THE BUFF/DEBUFF TRACKING ALLOW-LIST, pinned (JOS-168).
//
// Two halves, both pure, both here:
//
//   1. THE MODEL (src/shared/buffAllow.ts) — the mode, the tri-state, the normalizer that a
//      hand-edited settings file has to survive, and the patch seam main's handler and the
//      renderer's optimistic echo BOTH merge through (they must never merge differently).
//   2. THE FILTER (src/shared/buffTimers.ts `filterAllowedRows`) — driven over REAL rows built
//      from committed fixture bytes by the real parser and the real modules, not over authored
//      row literals. The ticket asks for the filter to be pinned by a node test, and a pin that
//      hand-wrote its own rows would prove nothing about the keys real rows carry.
//
// THE LAW UNDER TEST, and it is the one the whole feature rests on: this is a DISPLAY filter over
// two overlay surfaces. It removes rows the model still believes in, it never removes an instance,
// and the mode only ever changes what an UNSET line means. So the pins below are about which rows
// are drawn, plus one that holds `buffs.active` byte-identical across every mode and every verdict.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffTimers, tsOf } from './harness.mts'
import {
  DEFAULT_BUFF_ALLOW_PREFS,
  applyBuffAllowPatch,
  buffAllowAllowed,
  buffAllowCheck,
  buffAllowIsDefault,
  normalizeBuffAllowPrefs,
  sameBuffAllowPrefs,
  MAX_BUFF_ALLOW_LINES,
  type BuffAllowPrefs
} from '../src/shared/buffAllow.ts'
import { filterAllowedRows, rowsForSurface, timerNameKey, type BuffTimerRow } from '../src/shared/buffTimers.ts'

// ---------------------------------------------------------------------------------------------
// THE MODEL
// ---------------------------------------------------------------------------------------------

test('the shipped default says nothing and allows everything', () => {
  const p = DEFAULT_BUFF_ALLOW_PREFS
  assert.equal(p.optIn, false)
  assert.deepEqual(p.lines, {})
  assert.equal(buffAllowIsDefault(p), true)
  assert.equal(buffAllowAllowed(p, 'clarity'), true)
  assert.equal(buffAllowAllowed(p, 'anything at all'), true)
})

test('OPT-IN OR NO CHOICE (owner ruling 2026-08-17): off draws everything, on draws only what is checked', () => {
  // With the mode off there are no boxes, so nothing in the map can matter — a stored `false`
  // (the first cut's deny) is inert, not a deny.
  const off: BuffAllowPrefs = { optIn: false, lines: { clarity: false, valor: true } }
  assert.equal(buffAllowAllowed(off, 'clarity'), true, 'a stored false does not deny with the mode off')
  assert.equal(buffAllowAllowed(off, 'valor'), true)
  assert.equal(buffAllowAllowed(off, 'yaulp'), true, 'unset draws with the mode off')
  assert.equal(buffAllowIsDefault(off), true, 'off IS the default, whatever the map holds')

  const optIn: BuffAllowPrefs = { ...off, optIn: true }
  assert.equal(buffAllowAllowed(optIn, 'clarity'), false, 'unchecked is off in opt-in mode')
  assert.equal(buffAllowAllowed(optIn, 'valor'), true, 'checked is what opt-in mode draws')
  assert.equal(buffAllowAllowed(optIn, 'yaulp'), false, 'unset is OFF in opt-in mode')
  assert.equal(buffAllowIsDefault(optIn), false)
})

test('FLIPPING THE MODE LOSES NO CHOICE — the same verdicts, read the other way', () => {
  // The owner's ask is that the two modes are two readings of ONE set of choices, so the
  // round trip has to be byte-identical in the map and differ only in the mode.
  let prefs = DEFAULT_BUFF_ALLOW_PREFS
  prefs = applyBuffAllowPatch(prefs, buffAllowCheck('clarity', false))
  prefs = applyBuffAllowPatch(prefs, buffAllowCheck('valor', true))
  const before = prefs.lines
  prefs = applyBuffAllowPatch(prefs, { optIn: true })
  assert.deepEqual(prefs.lines, before, 'turning opt-in ON kept every verdict')
  prefs = applyBuffAllowPatch(prefs, { optIn: false })
  assert.deepEqual(prefs.lines, before, '…and turning it back OFF kept them too')
  assert.equal(prefs.optIn, false)
})

test('a checkbox writes an EXPLICIT verdict in both directions, in either mode', () => {
  // The half that makes the law above true: unchecking in the DEFAULT mode must store `false`
  // rather than forget the line, or every deny would evaporate the moment opt-in was tried.
  const off = applyBuffAllowPatch(DEFAULT_BUFF_ALLOW_PREFS, buffAllowCheck('clarity', false))
  assert.equal(off.lines.clarity, false)
  const on = applyBuffAllowPatch({ optIn: true, lines: {} }, buffAllowCheck('clarity', true))
  assert.equal(on.lines.clarity, true)
})

test('a WITHDRAWAL (null) is the only thing that takes a line back to unset', () => {
  const stated = applyBuffAllowPatch(DEFAULT_BUFF_ALLOW_PREFS, buffAllowCheck('clarity', false))
  const withdrawn = applyBuffAllowPatch(stated, { lines: { clarity: null } })
  assert.equal('clarity' in withdrawn.lines, false)
  assert.equal(buffAllowAllowed(withdrawn, 'clarity'), true, 'unset with the mode off draws')
  assert.equal(buffAllowAllowed({ ...withdrawn, optIn: true }, 'clarity'), false, '…and is off in opt-in')
})

test('a PARTIAL moves only what it names', () => {
  const start: BuffAllowPrefs = { optIn: true, lines: { clarity: true } }
  assert.deepEqual(applyBuffAllowPatch(start, { optIn: false }), { optIn: false, lines: { clarity: true } })
  assert.deepEqual(applyBuffAllowPatch(start, buffAllowCheck('valor', true)), {
    optIn: true,
    lines: { clarity: true, valor: true }
  })
})

test('THE NORMALIZER DEFAULTS RATHER THAN THROWS — a hand-edited file cannot stop a window drawing', () => {
  assert.deepEqual(normalizeBuffAllowPrefs(undefined), DEFAULT_BUFF_ALLOW_PREFS)
  assert.deepEqual(normalizeBuffAllowPrefs(null), DEFAULT_BUFF_ALLOW_PREFS)
  assert.deepEqual(normalizeBuffAllowPrefs('nonsense'), DEFAULT_BUFF_ALLOW_PREFS)
  assert.deepEqual(normalizeBuffAllowPrefs([1, 2, 3]), DEFAULT_BUFF_ALLOW_PREFS)
  assert.deepEqual(normalizeBuffAllowPrefs({ lines: ['clarity'] }), DEFAULT_BUFF_ALLOW_PREFS)
  // `=== true` on both halves, so a stringly-typed hand edit is not a verdict and not a mode.
  const hand = normalizeBuffAllowPrefs({ optIn: 'true', lines: { clarity: 'false', valor: 1, yaulp: true } })
  assert.equal(hand.optIn, false)
  assert.deepEqual(hand.lines, { yaulp: true })
  // Keys are folded on the way in, so a key stored with stray case or space still answers.
  assert.deepEqual(normalizeBuffAllowPrefs({ lines: { '  Clarity  ': false } }).lines, { clarity: false })
  // …and an unusable key is dropped rather than stored.
  assert.deepEqual(normalizeBuffAllowPrefs({ lines: { '   ': false, [`${'x'.repeat(65)}`]: true } }).lines, {})
})

test('the stored map is BOUNDED', () => {
  const lines: Record<string, boolean> = {}
  for (let i = 0; i < MAX_BUFF_ALLOW_LINES + 50; i++) lines[`spell ${String(i)}`] = true
  assert.equal(Object.keys(normalizeBuffAllowPrefs({ lines }).lines).length, MAX_BUFF_ALLOW_LINES)
})

test('sameBuffAllowPrefs is what makes an echo free', () => {
  const a: BuffAllowPrefs = { optIn: true, lines: { clarity: true, valor: false } }
  assert.equal(sameBuffAllowPrefs(a, { optIn: true, lines: { valor: false, clarity: true } }), true)
  assert.equal(sameBuffAllowPrefs(a, { optIn: false, lines: { clarity: true, valor: false } }), false)
  assert.equal(sameBuffAllowPrefs(a, { optIn: true, lines: { clarity: true } }), false)
  assert.equal(sameBuffAllowPrefs(a, { optIn: true, lines: { clarity: true, valor: true } }), false)
})

// ---------------------------------------------------------------------------------------------
// THE FILTER, over real rows
//
// w10-cazic-slow.log is the owner's own Plane of Fear pull: a chain-mez plus the slow and the
// self buffs standing beside it. Its rows come out of the real parser, the real BuffsModule and
// the real BuffTimersModule, so the keys below are the keys production computes.
// ---------------------------------------------------------------------------------------------

const W10 = readFixture('w10-cazic-slow.log')

/** One second after `You begin casting Mesmerization III.` — the instant both mez rows exist. */
const MEZ_LANDED = tsOf('[Sat Aug 01 20:50:33 2026] You begin casting Mesmerization III.') + 1_000

/** The rows of both surfaces, and the model snapshot they were projected from. */
function replay(): { rows: BuffTimerRow[]; active: number } {
  const { rows, buffs } = replayBuffTimers(W10)
  return { rows, active: buffs.active.length }
}

/** The line key of a row, the way the filter computes it. */
function keyOf(row: BuffTimerRow): string {
  return timerNameKey(row.name)
}

test('the shipped default draws every row of both surfaces', () => {
  const { rows } = replay()
  assert.ok(rows.length > 0, 'the fixture produced rows to filter')
  assert.deepEqual(filterAllowedRows(rows, DEFAULT_BUFF_ALLOW_PREFS), rows)
  for (const kind of ['buffs', 'debuffs'] as const) {
    const mine = rowsForSurface(rows, kind)
    assert.deepEqual(filterAllowedRows(mine, DEFAULT_BUFF_ALLOW_PREFS), mine, kind)
  }
})

test('WITH THE MODE OFF the map is not consulted — a stored false removes nothing', () => {
  const { rows } = replay()
  const victim = keyOf(rows[0])
  const kept = filterAllowedRows(rows, { optIn: false, lines: { [victim]: false } })
  assert.deepEqual(kept, rows, 'every row drawn, in the same order: off means no choice')
})

test('IN OPT-IN MODE unchecking one line removes exactly its rows', () => {
  const { rows } = replay()
  // Everything checked — including every candidate of a family row, which draws on any of them.
  const all: Record<string, boolean> = {}
  for (const r of rows) {
    all[keyOf(r)] = true
    for (const c of r.candidates ?? []) all[timerNameKey(c)] = true
  }
  const victim = keyOf(rows[0])
  const kept = filterAllowedRows(rows, { optIn: true, lines: { ...all, [victim]: false } })
  assert.deepEqual(
    kept,
    rows.filter((r) => keyOf(r) !== victim),
    'every other row is untouched, in the same order'
  )
  assert.ok(kept.length < rows.length, 'and at least one row really left')
})

test('OPT-IN DRAWS NOTHING until something is checked, and then exactly that', () => {
  const { rows } = replay()
  assert.deepEqual(filterAllowedRows(rows, { optIn: true, lines: {} }), [], 'nothing checked, nothing drawn')
  const wanted = keyOf(rows[0])
  const kept = filterAllowedRows(rows, { optIn: true, lines: { [wanted]: true } })
  assert.ok(kept.length > 0)
  assert.ok(
    kept.every((r) => keyOf(r) === wanted),
    `opt-in drew a row nobody checked: ${JSON.stringify(kept.map((r) => r.name))}`
  )
})

test('THE KEY IS THE SPELL LINE, so a rank does not need its own verdict', () => {
  // The chain-mez row is `Mesmerization III` — the ranked name off the cast line — and its key is
  // the rank-stripped line. Checking `mesmerization` therefore covers every rank the player will
  // ever upgrade into, which is the whole reason the key is the line.
  // Stopped just after the landings, exactly as tests/buffTimers.test.mts does: by the end of the
  // fixture both break lines have printed and the holds are gone.
  const { rows } = replayBuffTimers(W10, { until: MEZ_LANDED })
  const mez = rows.find((r) => r.name.startsWith('Mesmerization'))
  assert.ok(mez, 'the fixture carries the chain-mez rows')
  assert.equal(keyOf(mez), 'mesmerization')
  const kept = filterAllowedRows(rows, { optIn: true, lines: { mesmerization: true } })
  assert.ok(kept.length > 0 && kept.every((r) => r.name.startsWith('Mesmerization')))
})

test('a FAMILY row is kept when any candidate may draw, and dropped only when none may', () => {
  // A shared landing sentence is several spells (JOS-84) and the row stands for the sentence, not
  // for one of them — so denying one member has not denied the thing on screen. w10 carries two of
  // these by the end of its fold: `Boon of the Clear Mind / Clarity / Flowing Thought I` (the
  // shared self-buff landing) and `Dazzle / Mesmerization` (an unresolved hold).
  const { rows } = replay()
  const family = rows.find((r) => r.candidates != null && r.candidates.length > 1)
  assert.ok(family?.candidates != null, 'the fixture carries an ambiguous FAMILY row')
  const keys = family.candidates.map(timerNameKey)
  assert.ok(keys.length > 1)
  const oneAllowed = filterAllowedRows(rows, { optIn: true, lines: { [keys[0]]: true } })
  assert.ok(oneAllowed.includes(family), 'one allowed candidate keeps the family row')
  const noneChecked: Record<string, boolean> = {}
  for (const k of keys) noneChecked[k] = false
  assert.ok(!filterAllowedRows(rows, { optIn: true, lines: noneChecked }).includes(family), 'none checked drops it')
})

test('IT IS A DISPLAY FILTER: the MODEL is byte-identical under every setting', () => {
  // The law JOS-215 states and this feature inherits. The filter runs over ROWS; nothing it can do
  // may change what the model believes, which is what keeps the Buffs tab list and its header count
  // honest while the overlay draws a subset.
  const { rows, active } = replay()
  const settings: BuffAllowPrefs[] = [
    DEFAULT_BUFF_ALLOW_PREFS,
    { optIn: true, lines: {} },
    { optIn: false, lines: Object.fromEntries(rows.map((r) => [keyOf(r), false])) },
    { optIn: true, lines: Object.fromEntries(rows.map((r) => [keyOf(r), true])) }
  ]
  const snapshot = JSON.stringify(rows)
  for (const prefs of settings) {
    filterAllowedRows(rows, prefs)
    assert.equal(JSON.stringify(rows), snapshot, 'the filter mutated the rows it was given')
  }
  assert.equal(replay().active, active, 'a re-fold produces the same model regardless')
})

test('the filter never re-orders and never invents', () => {
  const { rows } = replay()
  const some: Record<string, boolean> = {}
  for (const r of rows.slice(1)) some[keyOf(r)] = true
  const kept = filterAllowedRows(rows, { optIn: true, lines: some })
  const order = rows.filter((r) => kept.includes(r))
  assert.deepEqual(kept, order, 'order is the caller’s, filtered')
  assert.equal(new Set(kept.map((r) => r.id)).size, kept.length, 'no row was duplicated')
})
