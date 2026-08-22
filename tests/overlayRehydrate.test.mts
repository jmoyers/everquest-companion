// A REBUILT WORLD REACHES AN OVERLAY THAT WAS ALREADY OPEN (JOS-172).
//
// The defect the owner saw: restart the app with the buffs/debuffs overlay already open and a long
// debuff running (a charm, an Ensnare), and the row never appears — while the main window shows it
// correctly. The fold rebuilt the model; the DELIVERY was the bug, and it had three parts:
//
//   1. an overlay window is created in the same `whenReady` turn that started the historical fold
//      (index.ts), so it hydrates from a snapshot taken at a random instant PART-WAY through it;
//   2. `endReplay()` DISCARDS what that fold accumulated (main/modules/registry.ts — deliberately,
//      so a character switch cannot fire the celebration detectors), so no delta ever describes
//      the rest of it; and
//   3. `log:character` — "the world was rebuilt, ask again", which the MAIN window has always
//      re-hydrated on (`useModule`) — was sent to the main window alone.
//
// Only (3) is fixed, and that is the owner's ruling: re-hydration, not a tail-first prime, not
// disk persistence, not a change to the reaper. The registry's discard stays exactly as JOS-60
// left it — exempting two modules from it would ship a module's whole history as an INCREMENT
// again, which is the shape that discard exists to prevent.
//
// TWO HALVES ARE PINNED HERE. The WIRING is pinned as source text (there is no unit-testable seam
// between three processes; tests/e2e/buffs-overlay.e2e.mts drives the real restart end to end),
// and the one piece of new LOGIC — what a drop notice is allowed to say once a row set can change
// because we re-asked rather than because a spell fell off — is a pure function over rows read out
// of real fixture bytes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFixture, replayBuffTimers, tsOf } from './harness.mts'
import { rowsForSurface, timerDropLabel, timerDrops } from '../src/shared/buffTimers.ts'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** The same file with its comments removed — every rule below is written out in prose directly
 *  above the line that obeys it, and a channel named in a comment must not read as a wiring. */
const code = (rel: string): string =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

// ---- the delivery, end to end through the source ------------------------------------------

test('ONE list answers "which windows fold a module", and the rebuild signal uses it', () => {
  const pipeline = code('../src/main/pipeline.ts')
  // Who is on the list (JOS-89/119, JOS-195's XP window, and JOS-194's respawn clocks): the event
  // log, the two timer windows, the progress read, and the respawn window. Every one of them folds
  // a module in its own renderer, which is the whole membership rule — and the XP window folds TWO
  // (`progression` and `loot`), so an omission there would strand the same bug in two places at
  // once. The respawn window is the case the rule was WRITTEN for: it is nothing but a fold over
  // months of death lines, so a window open at launch that never got the rebuild signal would sit
  // there holding a random part-way-through slice of the history for as long as the log stayed
  // quiet — which, for a player parked at a camp, is exactly when they are looking at it.
  assert.match(pipeline, /MODULE_READING_OVERLAYS[^=]*=\s*\['events', 'buffs', 'debuffs', 'xp', 'respawn'\]/)
  // …and the delta fan-out now goes through the same function the rebuild signal does, so the two
  // can never drift into disagreeing about who reads modules.
  assert.match(pipeline, /export function sendToModuleOverlays\(/)
  assert.match(pipeline, /sendToModuleOverlays\(IPC\.onModuleDelta, delta\)/)
  assert.match(pipeline, /for \(const kind of MODULE_READING_OVERLAYS\)/)
  // The rebuild signal reaches BOTH populations, in one place.
  assert.match(pipeline, /export function sendWorldRebuilt\(/)
  assert.match(pipeline, /sendToMain\(IPC\.onCharacter, character\)/)
  assert.match(pipeline, /sendToModuleOverlays\(IPC\.onCharacter, character\)/)
})

test('NOBODY ELSE SENDS log:character — the main-window-only send is what the bug was', () => {
  for (const rel of ['../src/main/session.ts', '../src/main/index.ts']) {
    const text = code(rel)
    assert.doesNotMatch(
      text,
      /sendToMain\(\s*IPC\.onCharacter/,
      `${rel} still tells only the main window the world was rebuilt`
    )
    assert.match(text, /sendWorldRebuilt\(/, `${rel} never announces a rebuild at all`)
  }
  // session.ts has TWO: the post-replay one (the ticket's own line) and the no-character one.
  const session = code('../src/main/session.ts')
  assert.equal((session.match(/sendWorldRebuilt\(/g) ?? []).length, 2)
  assert.match(session, /sendWorldRebuilt\(character\)/)
  assert.match(session, /sendWorldRebuilt\(null\)/)
})

test('the overlay bridge exposes the SAME member, on the SAME channel, as the app bridge', () => {
  // THE MAIN APP'S HALF MOVED FILES, NOT SURFACES (JOS-432). `src/preload/index.ts` hit the
  // measured 400-code-line ceiling, so the three log-stream pushes — `onLine`, `onCharacter` and
  // the quiet-switch offer — split out to `preload/logStream.ts` and are spread back into the same
  // `window.eq` object, exactly as knowledge.ts and roster.ts are. So the wiring is read from the
  // file that now carries it, and the spread is asserted separately below: together those two say
  // the same thing the single file used to, which is that `window.eq.onCharacter` exists and rides
  // this channel.
  const bridges = {
    'the main app bridge': code('../src/preload/logStream.ts'),
    'the overlay bridge': code('../src/preload/overlay.ts')
  }
  assert.match(
    code('../src/preload/index.ts'),
    /\.\.\.logStreamBridge/,
    'the log-stream bridge is no longer spread into window.eq'
  )
  for (const [who, text] of Object.entries(bridges)) {
    assert.match(text, /\bonCharacter:/, `${who} is missing onCharacter`)
    assert.match(text, /ipcRenderer\.on\(IPC\.onCharacter/, `${who} does not subscribe to the channel`)
    assert.match(
      text,
      /removeListener\(IPC\.onCharacter/,
      `${who} subscribes without handing back an unsubscribe`
    )
  }
})

test('every overlay that folds a module re-hydrates on it', () => {
  const surfaces = {
    'the timer overlays': '../src/renderer/src/overlay/BuffsOverlay.tsx',
    'the event log': '../src/renderer/src/overlay/EventLogOverlay.tsx'
  }
  for (const [who, rel] of Object.entries(surfaces)) {
    const text = code(rel)
    assert.match(text, /window\.eqOverlay\.onCharacter\(/, `${who} never re-hydrates on a rebuild`)
    // …and it unsubscribes, like every other listener in these files: an overlay's effect is torn
    // down on a kind change and a leaked listener would hydrate a dead component.
    assert.match(text, /offChar\(\)/, `${who} leaks its rebuild subscription`)
  }
})

test('the drop flash asks the pure function, and tells it whether the rows were REBUILT', () => {
  const overlay = code('../src/renderer/src/overlay/BuffsOverlay.tsx')
  assert.match(overlay, /timerDrops\(prev, rows, \{ rebuilt \}\)/)
  // The signal itself: a hydrate is counted, and a change in that count is what `rebuilt` means.
  assert.match(overlay, /setHydrations\(\(n\) => n \+ 1\)/)
  assert.match(overlay, /epochRef\.current !== epoch/)
  // BOTH modules count — the two snapshots land as two separate promises, so either one arriving
  // is a rebuilt row set. Since JOS-203 the DISMISSALS count too: a bar the user cleared did not
  // drop, and the flash announcing it would be the window arguing with the user who cleared it.
  assert.match(overlay, /buffsHydrations \+ timersHydrations \+ dismissals\.size/)
})

// ---- what a drop notice may say, on real bytes ---------------------------------------------
//
// `w8-wears-off.log` is the owner's own log around `Your valor fades.` — a self buff that lands at
// 20:29:46 and wears off at 20:55:15, which is exactly the transition the flash exists to report.

const W8 = readFixture('w8-wears-off.log')
const VALOR_FADES = tsOf('[Sat Aug 01 20:55:15 2026] Your valor fades.')

const beforeFade = rowsForSurface(replayBuffTimers(W8, { until: VALOR_FADES - 1_000 }).rows, 'buffs')
const afterFade = rowsForSurface(replayBuffTimers(W8).rows, 'buffs')

test('a wears-off the MODEL believed is a drop, and it is the only one', () => {
  assert.ok(
    beforeFade.some((r) => r.name === 'Valor'),
    'the fixture should have Valor standing before its fade line'
  )
  assert.equal(
    afterFade.some((r) => r.name === 'Valor'),
    false,
    'the fade line should have taken it away'
  )
  assert.deepEqual(timerDrops(beforeFade, afterFade, { rebuilt: false }), [
    { id: 'self|self|valor', name: 'Valor' }
  ])
})

test('the FIRST reading announces nothing — an empty hydrate is not N drops', () => {
  assert.deepEqual(timerDrops(null, afterFade, { rebuilt: false }), [])
  assert.deepEqual(timerDrops(null, beforeFade, { rebuilt: false }), [])
})

test('A REBUILD IS NOT A DROP (JOS-172) — the same pair, announced only when the model moved', () => {
  // This is the phantom the fix would otherwise have created. On a cold start with the window
  // already open, the mid-fold hydrate and the post-fold one are two readings of the same log at
  // two different instants — precisely the pair above — and every buff that wore off in between
  // would have flashed as a fresh loss the first time the user ever looked at the window.
  assert.deepEqual(timerDrops(beforeFade, afterFade, { rebuilt: true }), [])
  // …and the guard is not a mute button: the very next removal still reports.
  assert.equal(timerDrops(beforeFade, afterFade, { rebuilt: false }).length, 1)
})

test('a debuff or a mez ending is never a drop — the flash is the buffs surface alone', () => {
  const { rows } = replayBuffTimers(readFixture('w10-cazic-slow.log'))
  const held = rowsForSurface(rows, 'debuffs')
  assert.ok(held.length > 0, 'the Cazic pull should leave debuff/cc rows standing')
  // Every one of them disappearing at once reports nothing: `kind` is the whole filter.
  assert.deepEqual(timerDrops(held, [], { rebuilt: false }), [])
})

test('THE LABEL CARRIES THE TARGET — two real Valors, two distinguishable notices', () => {
  // The e2e fixture has Valor up on the player AND on a fire giant warrior. A notice that named
  // only the spell printed the same sentence for two genuinely different drops (measured in
  // tests/e2e/buffs-overlay.e2e.mts before the label carried the target).
  const rows = rowsForSurface(replayBuffTimers(readFixture('e2e-overlay.log')).rows, 'buffs')
  const valors = rows.filter((r) => r.name === 'Valor')
  assert.equal(valors.length, 2, `expected a self Valor and a target one: ${JSON.stringify(valors.map((r) => r.id))}`)
  const labels = valors.map(timerDropLabel)
  assert.equal(new Set(labels).size, 2, JSON.stringify(labels))
  assert.ok(labels.includes('Valor'), JSON.stringify(labels))
  assert.ok(
    labels.some((l) => l.startsWith('Valor · ')),
    JSON.stringify(labels)
  )
})
