// ONE CLICK, ONE INSTANT, EVERYTHING SPLITS — the mark-to-engine seam (JOS-322).
//
// The owner's third law for this ticket, verbatim: *new session should split everything at once.*
// The existing "New session" mark (JOS-436) is the single trigger, and after this ticket it drives
// BOTH halves: the loot ledger's segments and the combat engine's own zone records.
//
// The engine half is proved in tests/combatSessionMark.test.mts (the split, and the merge-back).
// THIS file pins the SEAM, and every claim below fails silently if it regresses:
//
//   1. MAIN STAMPS THE INSTANT, ONCE, and hands that same number to the engine. Two clocks — a
//      renderer's for the loot mark and main's for the engine — would put the two halves of one
//      click a round trip apart, and everything looted in between would fall on the wrong side of
//      one of them. This is the pin the whole ticket rests on.
//   2. MAIN OWNS IT EPHEMERALLY. No store, no migration, empty at every launch — which is also half
//      of replay determinism: a mark is stored NOWHERE, so a relaunch replays the log into the
//      records the log alone describes (the other half is the engine's `hydrating` refusal).
//   3. THE BRIDGE IDENTITY: the SAME three members under the SAME names in BOTH preloads, so ONE
//      renderer hook drives the ledger's slice bar and the zone meter's title-bar button. A rename
//      on one side alone would compile, ship, and quietly give the overlay its own list back.
//   4. THE RENDERER NO LONGER HOLDS THE LIST. `useTimeslice` kept it in a module variable, which was
//      a per-PROCESS copy — the exact defect JOS-332 had already had to fix once.
//   5. THE OVERLAY BUTTON is where the owner put it and looks like the chrome around it.
//
// Pins 2–5 are SOURCE pins in tests/fightSelection.test.mts' technique: comments are stripped first,
// because this repo explains itself in prose that would otherwise satisfy its own greps.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IPC } from '../src/shared/ipc'
import { MAX_SESSION_MARKS, addSessionMark } from '../src/shared/sessionSegments'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** The same file with its COMMENTS removed — see the header. */
const code = (rel: string): string =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

// ── the channels ───────────────────────────────────────────────────────────────────────

test('the three channels exist and are distinct', () => {
  const names = [IPC.sessionMarksGet, IPC.sessionMarkAdd, IPC.onSessionMarks]
  assert.equal(new Set(names).size, 3)
  for (const n of names) assert.match(n, /^sessionMarks:/)
})

// ── 1. one instant, stamped in main, shared by both halves ─────────────────────────────

test('MAIN STAMPS Date.now() EXACTLY ONCE, and the engine gets that very number', () => {
  const mod = code('../src/main/sessionMarks.ts')
  const stamps = mod.match(/Date\.now\(\)/g) ?? []
  assert.equal(stamps.length, 1, 'a second clock read is a second boundary')
  assert.match(mod, /const at = Date\.now\(\)/)
  // The SAME identifier reaches the engine and the mark list. Anything else — a fresh read, an
  // argument off the wire, a rounded copy — would be two instants wearing one name.
  assert.match(mod, /combat\.sessionMark\(at\)/, 'the engine split must use the stamped instant')
  assert.match(mod, /addSessionMark\(marks, at\)/, 'and so must the loot split')
})

test('the engine is asked FIRST, so a refusal leaves no mark claiming a split that never happened', () => {
  const mod = code('../src/main/sessionMarks.ts')
  const engineAt = mod.indexOf('combat.sessionMark(at)')
  const markAt = mod.indexOf('addSessionMark(marks, at)')
  assert.ok(engineAt >= 0 && markAt >= 0)
  assert.ok(engineAt < markAt, 'the mark was recorded before the engine had agreed to split')
  assert.match(mod, /if \(!combat\.sessionMark\(at\)\) return marks/, 'both halves or neither')
})

test('THE PRESS CARRIES NO PAYLOAD — a renderer cannot supply an instant, so it cannot supply a bad one', () => {
  const handlers = src('../src/main/ipc/windowControls.ts')
  assert.match(handlers, /ipcMain\.handle\(IPC\.sessionMarksGet, \(\) => getSessionMarks\(\)\)/)
  assert.match(handlers, /ipcMain\.handle\(IPC\.sessionMarkAdd, \(\) => pressNewSession\(\)\)/)
  for (const bridge of ['../src/preload/windows.ts', '../src/preload/overlay.ts']) {
    assert.match(
      code(bridge),
      /addSessionMark: \(\): Promise<number\[\]> => ipcRenderer\.invoke\(IPC\.sessionMarkAdd\)/,
      `${bridge} lets a renderer name the instant`
    )
  }
})

// ── 2. ephemeral, in main ──────────────────────────────────────────────────────────────

test('MAIN OWNS IT, EPHEMERALLY: no store, no migration, no persisted key', () => {
  const mod = code('../src/main/sessionMarks.ts')
  assert.doesNotMatch(mod, /from '\.\/store'/, 'the marks grew a persisted home')
  assert.doesNotMatch(mod, /electron-store|storeMigrations|storeFile/, 'the marks reached the store')
  // The initializer IS the reset: module scope, empty, every launch.
  assert.match(mod, /let marks: number\[] = \[]/)
})

test('the DEDUPE is the shared one, and length is deliberately not the test', () => {
  // At the cap an ACCEPTED mark also leaves the list the same length, so a length comparison would
  // silently stop broadcasting the moment a heavy session filled the ring.
  const full = Array.from({ length: MAX_SESSION_MARKS }, (_v, i) => i + 1)
  const grown = addSessionMark(full, 10_000)
  assert.equal(grown.length, full.length, 'the ring is full, so the length cannot say what happened')
  assert.equal(grown[grown.length - 1], 10_000, 'but the newest instant can')
  assert.deepEqual(addSessionMark(full, 1), full, 'a mark at or before the newest is dropped')

  const mod = code('../src/main/sessionMarks.ts')
  assert.match(mod, /next\[next\.length - 1] !== at/, 'the press must test the INSTANT, never the length')
})

// ── 3. one hook, both bundles ──────────────────────────────────────────────────────────

test('ONE HOOK, BOTH BUNDLES: both preload bridges expose the same three members', () => {
  for (const bridge of ['../src/preload/windows.ts', '../src/preload/overlay.ts']) {
    const mod = code(bridge)
    for (const member of ['getSessionMarks', 'addSessionMark', 'onSessionMarks']) {
      assert.match(mod, new RegExp(`\\b${member}:`), `${bridge} is missing ${member}`)
    }
  }
})

test('the broadcast reaches EVERY window, the way its two neighbours do', () => {
  const mod = code('../src/main/sessionMarks.ts')
  assert.match(mod, /getMainWindow\(\)/)
  assert.match(mod, /OVERLAY_KINDS\.map/)
  assert.match(mod, /IPC\.onSessionMarks/)
})

// ── 4. the renderer is a cache, not an owner ───────────────────────────────────────────

test('useTimeslice no longer keeps its OWN list — the per-process second copy is gone', () => {
  const mod = code('../src/renderer/src/features/timeslice/useTimeslice.ts')
  assert.doesNotMatch(mod, /^let marks/m, 'the marks went back into a renderer module variable')
  assert.doesNotMatch(mod, /Date\.now\(\)/, 'the renderer started stamping its own instant again')
  assert.match(mod, /useSessionMarks\(window\.eq\)/, 'the list must be read from main')
  assert.match(mod, /void press\(\)/, 'and the press must go through main')
})

test('the renderer store writes THROUGH and never guesses the instant', () => {
  const mod = code('../src/renderer/src/features/timeslice/useSessionMarks.ts')
  assert.doesNotMatch(mod, /Date\.now\(\)/, 'an optimistic instant is a DIFFERENT instant')
  assert.match(mod, /useSyncExternalStore/, 'one store per window, so every consumer moves together')
  assert.match(mod, /bridge\.onSessionMarks\(adopt\)/, 'a press in another window has to reach this one')
  assert.match(mod, /wiredTo === bridge/, 'the subscription is per bridge, not per consumer')
})

// ── 5. the overlay button ──────────────────────────────────────────────────────────────

test('the ZONE meter carries the button; the FIGHT meter carries nothing new', () => {
  const mod = code('../src/renderer/src/overlay/OverlayMeter.tsx')
  assert.match(mod, /useSessionMarks\(window\.eqOverlay\)/, 'the overlay presses the same app-wide mark')
  assert.match(mod, /if \(isFight\) return undefined/, 'a fight meter has no Overall to restart')
  assert.match(mod, /action=\{newSession\}/, 'and the zone meter hands it to the header')
})

test('the button is CHROME: aria-labelled, one glyph, and unlocked-only', () => {
  const header = code('../src/renderer/src/overlay/OverlayHeader.tsx')
  // It goes through the ONE overlay button primitive, which is what makes the name an ARIA label
  // and never a native tooltip (the 1111d8d9 ruling), and what makes it the same 20px box as the
  // lock and close it sits beside.
  assert.match(
    header,
    /<IconButton label=\{action\.label\} onClick=\{action\.onClick\}/,
    'the action must be an IconButton, not hand-rolled chrome'
  )
  const button = code('../src/renderer/src/overlay/IconButton.tsx')
  assert.match(button, /aria-label=\{label\}/)
  assert.doesNotMatch(button, /title=/, 'a native tooltip reached the overlay chrome')

  assert.match(header, /\{!locked && action &&/, 'a locked, click-through meter must not offer it')
  const meter = code('../src/renderer/src/overlay/OverlayMeter.tsx')
  assert.match(meter, /label: 'New session'/, 'the same three words the ledger prints')
})

test('the header action is a NARROW shape, not an open slot', () => {
  const header = src('../src/renderer/src/overlay/OverlayHeader.tsx')
  const decl = /export interface OverlayHeaderAction \{[\s\S]*?\n\}/.exec(header)
  assert.ok(decl, 'OverlayHeaderAction is gone')
  assert.doesNotMatch(decl[0], /ReactNode|JSX\.Element/, 'the title bar grew an arbitrary-chrome slot')
  assert.match(decl[0], /label: string/)
  assert.match(decl[0], /glyph: string/)
})
