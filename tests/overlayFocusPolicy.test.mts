// WHO COUNTS AS EVERQUEST, AND WHO MAY MOVE THE FOREGROUND (JOS-199).
//
// Two v0.18.0 reports, one subsystem, and they pull the same lever from opposite ends.
//
// 1. THE COMPANION IS NOT EVERQUEST. "Overlays dont hide when EQ Companion is open and in the
//    foreground. They hide properly when any other app is up and above everquest… the overlays
//    cover a lot of the Companion unnecessarily when trying to navigate through the app."
//    (report 01KZPVWXZACDHVRNKTFGDW3E4M.) The own-windows rule was one bit — `pid === process.pid`
//    ⇒ EQ side — which is right for an overlay you are dragging and wrong for the app itself.
//    `foregroundSide` splits it, and the tests below are that matrix.
//
// 2. AUTO-HIDE MUST NEVER MOVE THE FOREGROUND WINDOW. "when the Overlay is set to Hide when you're
//    not in everquest, Alt tabbing from EQ will bring you back to EQ the first time but with
//    hidden overlay, then you can alt tab again to move to new windows. but if you click into EQ,
//    alt tab will continue to bring you back ANY TIME THE OVERLAYS ARE VISIBLE."
//    (report 01KZPTD3MHP3DFG7NJY5QF96VJ.)
//
//    THE MECHANISM is `BrowserWindow.setFocusable`, and it is documented rather than mysterious:
//    Electron spells it "changes whether the window can be focused" and notes "on macOS it does
//    not remove the focus from the window" — i.e. on WINDOWS it does. `setFocusable(false)`
//    deactivates the window, and Chromium's deactivate walks the Z-ORDER and hands the foreground
//    to the first VISIBLE window below it. Our overlays are always-on-top directly over the game,
//    so that window is EverQuest.
//
//    `setOverlaysHidden(true)` re-asserted each overlay's locked mode on the way DOWN, and the
//    locked mode IS `setFocusable(false)`. So: alt-tab away, the focus debounce commits ~300 ms
//    later, the hide pass deactivates five still-visible topmost windows, and the user is standing
//    back in EverQuest. The reporter's final clause is the confirmation — Chromium's deactivate
//    returns early on a window that is not visible, which is exactly why the alt-tab taken while
//    the overlays were already hidden worked and the next one did not.
//
// WHY HALF OF THIS IS A SOURCE PIN. The classifier is pure and is tested as one. The alt-tab half
// is a Win32 foreground transition inside a real always-on-top window stack: it needs a game to
// sit under it, a second app to alt-tab to, and windows the e2e mode (src/main/e2e.ts) never shows
// at all. Nor is there a predicate hiding in it — the fix is that a CALL is no longer made on a
// path, which is a property of the call graph. So the call graph is what gets asserted, the same
// bargain tests/cursorRingOff.test.mts strikes for the cursor gate's three assignments.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { focusCountsAsEq, foregroundSide } from '../src/main/presenceProtocol'
import type { ForegroundSide } from '../src/main/presenceProtocol'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const EQ_ROOT = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
/** The app's own process, as `foregroundSide` sees it. */
const OURS = 4242
const eqWindow = { pid: 9, exePath: `${EQ_ROOT}\\eqgame.exe`, title: 'EverQuest' }
const ownWindow = { pid: OURS, exePath: 'C:\\app\\companion.exe', title: 'anything at all' }

// ------------------------------------------------------- which side is the foreground window on?

test('THE GAME is EQ side, and ANOTHER APP is not — the two easy answers', () => {
  const self = { pid: OURS, appWindowFocused: false }
  assert.equal(foregroundSide(eqWindow, self, EQ_ROOT), 'eq')
  assert.equal(focusCountsAsEq('eq'), true)

  const chrome = { pid: 9, exePath: 'C:\\Chrome\\chrome.exe', title: 'EverQuest Wiki - Chrome' }
  assert.equal(foregroundSide(chrome, self, EQ_ROOT), 'other')
  assert.equal(focusCountsAsEq('other'), false)
})

test('OUR OVERLAY IS EQ SIDE — clicking a meter must never make it vanish under the cursor', () => {
  // The original own-windows rule, unchanged and still by PID: every window this app creates is
  // owned by the main process, so one comparison covers the overlays and the ring at once. The
  // window's own title is deliberately junk here — nothing about this answer reads it.
  const side = foregroundSide(ownWindow, { pid: OURS, appWindowFocused: false }, EQ_ROOT)
  assert.equal(side, 'own-accessory')
  assert.equal(focusCountsAsEq(side), true)
})

test('THE COMPANION WINDOW IS NOT EQ SIDE — the reported bug, as a test', () => {
  // Same pid and same image path as the overlay above; the ONLY thing that separates them is the
  // answer Electron gives about which of our windows is active.
  const side = foregroundSide(ownWindow, { pid: OURS, appWindowFocused: true }, EQ_ROOT)
  assert.equal(side, 'own-app')
  assert.equal(focusCountsAsEq(side), false)
})

test('the app-window answer only ever applies to OUR OWN pid', () => {
  // `mainWindowFocused()` is asked on every foreground record, including ones about other
  // processes, and a stale `true` there must not be able to reclassify somebody else's window.
  const self = { pid: OURS, appWindowFocused: true }
  assert.equal(foregroundSide(eqWindow, self, EQ_ROOT), 'eq')
  assert.equal(
    foregroundSide({ pid: 9, exePath: 'C:\\Chrome\\chrome.exe', title: '' }, self, EQ_ROOT),
    'other'
  )
})

test('ONLY the game moves the bounds — the ring must not jump onto one of our windows', () => {
  // presence.ts updates `eqBounds` on `side === 'eq'` alone, and three of the four sides are
  // EXACTLY the set that must not move it — including the one that is otherwise EQ-side.
  const notTheGame: ForegroundSide[] = ['own-accessory', 'own-app', 'other']
  // Explicit lambda: `map(focusCountsAsEq)` would pass the INDEX as the JOS-427 raise-grace
  // argument, and index 1 is exactly the own-app row.
  assert.deepEqual(notTheGame.map((s) => focusCountsAsEq(s)), [true, false, false])
})

// ------------------------------------------------------------------ nothing here moves the focus

/** Every .ts/.tsx under src/, recursively — the same sweep tests/noChildProcess.test.mts uses. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** The body of a named top-level function in a file, up to the next top-level `}`. */
function body(file: string, decl: string): string {
  const start = file.indexOf(decl)
  assert.notEqual(start, -1, `${decl} not found`)
  const end = file.indexOf('\n}', start)
  assert.notEqual(end, -1, `${decl} has no end`)
  return file.slice(start, end)
}

test('THE WHOLE APP HAS ONE setFocusable CALL, and it is the guarded one', () => {
  // A second call site anywhere would be a second opinion about a call that moves the foreground.
  // The sweep is over the tree rather than over windows.ts, because the pressure is to reach for
  // this from wherever a window is being tidied up.
  const hits: string[] = []
  for (const file of sourceFiles(SRC_ROOT)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      // Comments explain the rule; only real calls count.
      if (/^\s*(\/\/|\*)/.test(line)) continue
      if (line.includes('.setFocusable(')) hits.push(`${file}: ${line.trim()}`)
    }
  }
  assert.deepEqual(
    hits.map((h) => h.slice(h.indexOf(': ') + 2)),
    ['w.setFocusable(focusable)'],
    `expected exactly one call site; found:\n${hits.join('\n')}`
  )
})

test('THE CALL IS SKIPPED WHEN THE VALUE DID NOT CHANGE — the alt-tab fix itself', () => {
  const helper = body(src('../src/main/windows.ts'), 'function setOverlayFocusable(')
  // The window itself is asked, so there is no remembered copy to seed, clear or get wrong — and
  // the sameness guard comes FIRST, so an unchanged value never reaches Electron at all.
  assert.ok(
    helper.indexOf('w.isFocusable() === focusable) return') < helper.indexOf('w.setFocusable('),
    'the sameness guard precedes the call'
  )
})

test('AUTO-HIDE TOUCHES FOCUSABILITY NOWHERE — not on the way down, not on the way back', () => {
  const windows = src('../src/main/windows.ts')
  const hide = body(windows, 'export function setOverlaysHidden(')
  assert.ok(!hide.includes('setFocusable'), 'setOverlaysHidden never calls it directly')
  assert.ok(!hide.includes('setOverlayFocusable'), 'nor through the helper')
  // It still re-applies the locked mode both ways — that is what drops a hidden window's
  // WH_MOUSE_LL hook (JOS-62) — so the fix has to live inside `applyOverlayLocked`, not by
  // deleting the call.
  assert.equal(
    (hide.match(/applyOverlayLocked\(kind, getOverlayConfig\(kind\)\.locked\)/g) ?? []).length,
    2,
    'the locked mode is still re-applied in both directions'
  )
  const locked = body(windows, 'export function applyOverlayLocked(')
  assert.match(locked, /setOverlayIgnoreMouse\(kind, locked\)/, 'the mouse half is unconditional')
  assert.match(locked, /setOverlayFocusable\(w, !locked\)/, 'the focus half is guarded')
})

test('AN OVERLAY IS BORN WITH ITS FOCUSABILITY, so the first apply has nothing to say', () => {
  // `ready-to-show` calls applyOverlayLocked, and before this the very first `setFocusable(false)`
  // of a window's life ran there — while whatever the user opened the overlay FROM was in front.
  const create = body(src('../src/main/windows.ts'), 'export function createOverlayWindow(')
  assert.match(create, /const locked = getOverlayConfig\(kind\)\.locked/)
  assert.match(create, /focusable: !locked/, 'the constructor carries it')
})

test('THE COMPANION WINDOW IS ASKED OF ELECTRON, and only ever read', () => {
  // `foregroundSide` needs to know which of OUR windows is in front, and no watcher line can say
  // (same pid, same image path, a page-supplied title). windows.ts answers it, and the answer must
  // stay a QUERY — a show/focus/raise in here would be an app that rearranges the user's desktop
  // every time it looks at it.
  const windows = src('../src/main/windows.ts')
  const q = body(windows, 'export function mainWindowFocused(')
  assert.match(q, /return getMainWindow\(\)\?\.isFocused\(\) === true/)
  for (const forbidden of ['.show(', '.focus(', '.hide(', 'setAlwaysOnTop']) {
    assert.ok(!q.includes(forbidden), `mainWindowFocused must not call ${forbidden}`)
  }

  const presence = src('../src/main/presence.ts')
  assert.match(presence, /import \{ mainWindowFocused \} from '\.\/windows'/)
  // ONE fold site, and it hands the query straight to the pure classifier. (Prose about it is
  // welcome and does not count — only lines that are not comments do.)
  const calls = presence
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && l.includes('mainWindowFocused()'))
    .map((l) => l.trim())
  assert.deepEqual(calls, ['{ pid: process.pid, appWindowFocused: mainWindowFocused() },'])
  // Two-argument since JOS-427: the second is the overlay-raise grace, whose lifetime presence.ts
  // owns; tests/presenceRefocusFlicker.test.mts pins the whole matrix.
  assert.match(presence, /applyFocus\(focusCountsAsEq\(side, ownWindowRaise\)\)/)
  // Bounds still come from the game alone — an overlay's rectangle must never become the ring's —
  // and they are converted to DIP on the way in (JOS-376; the conversion itself is driven with a
  // fake `screen` in tests/presenceDip.test.mts).
  assert.match(presence, /side === 'eq' \? \{ observed: true, eqBounds: toDip\(rec\.rect\) \}/)
})
