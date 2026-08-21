// Presence watcher + the two features it drives (src/main/presence.ts,
// src/shared/presencePrefs.ts).
//
// Everything asserted here is PURE: the line protocol, the "is this window EverQuest"
// predicate, the alt-tab debounce, and the gating matrix that decides whether the overlays hide
// and whether the 8 ms cursor stream runs. No Electron, no thread, no game — so this suite is as
// cheap and as unskippable as overlayLayout/storeMigrations. (The guard that no shipped code can
// still spawn PowerShell is the one presence assertion that reads a disk, so it lives in
// tests/noChildProcess.test.mts rather than here.)
//
// THE GATING MATRIX IS THE PERFORMANCE CONTRACT, in test form. "Nothing runs when nothing is
// on" and "the stream stops when EQ is unfocused" are the owner's explicit requirements; they
// are decided by two exported predicates, so they are pinned here rather than measured by hand
// on every change. The THIRD rule — "with the ring off we never touch the cursor at all"
// (JOS-193) — spans a predicate, a worker init and three assignments, so it lives together in
// tests/cursorRingOff.test.mts rather than being scattered through this one. The FOURTH — the
// asymmetric focus debounce and the transition logging that earns the next fix (JOS-424) — is in
// tests/presenceRefocusFlicker.test.mts for the same reason: it is one defect's whole story, and
// this file is a page from its line ceiling.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WATCHER_RESTART_BACKOFF_MS,
  WATCHER_STALE_MS,
  cursorRingActive,
  eqRootPrefix,
  isEqWindow,
  overlaysShouldHide,
  parsePresenceLine,
  watcherIsStale,
  watcherRestartDelayMs
} from '../src/main/presenceProtocol'
import {
  DEFAULT_CURSOR_RING,
  DEFAULT_OVERLAY_AUTO_HIDE,
  INITIAL_PRESENCE,
  normalizeCursorRing,
  normalizeOverlayAutoHide,
  presenceNeeded
} from '../src/shared/presencePrefs'
// PresenceState is NOT re-exported from shared/types.ts — see the note at its foot.
import type { PresenceState } from '../src/shared/presencePrefs'

const EQ_ROOT = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'

// ------------------------------------------------------------------ the line protocol

test('a foreground record decodes into a pid, a rectangle, an image path and a title', () => {
  const rec = parsePresenceLine(`F|4321|100|50|1920|1080|${EQ_ROOT}\\eqgame.exe|EverQuest`)
  assert.deepEqual(rec, {
    t: 'fg',
    pid: 4321,
    rect: { x: 100, y: 50, width: 1920, height: 1080 },
    exePath: `${EQ_ROOT}\\eqgame.exe`,
    title: 'EverQuest'
  })
})

test('a title may contain the field separator — it is last for exactly that reason', () => {
  // A Windows path cannot contain `|`, so every field BEFORE the title is unambiguous and the
  // title is simply "the rest". A browser tab or a chat client will absolutely produce this.
  const rec = parsePresenceLine('F|7|0|0|800|600|C:\\x\\y.exe|Notes | Draft | 3')
  assert.equal(rec?.t, 'fg')
  assert.equal(rec.t === 'fg' ? rec.title : '', 'Notes | Draft | 3')
})

test('an empty image path and an empty title are ordinary — many windows have neither', () => {
  const rec = parsePresenceLine('F|9|0|0|10|10||')
  assert.deepEqual(rec, {
    t: 'fg',
    pid: 9,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    exePath: '',
    title: ''
  })
})

test('negative coordinates survive — a window on a left/upper secondary monitor has them', () => {
  const rec = parsePresenceLine('F|9|-1920|-200|1920|1080|C:\\x.exe|EverQuest')
  assert.deepEqual(rec?.t === 'fg' ? rec.rect : null, {
    x: -1920,
    y: -200,
    width: 1920,
    height: 1080
  })
})

test('a running record decodes to a boolean, both ways', () => {
  assert.deepEqual(parsePresenceLine('R|1'), { t: 'run', running: true })
  assert.deepEqual(parsePresenceLine('R|0'), { t: 'run', running: false })
})

test('a cursor-visibility record decodes to a boolean, both ways', () => {
  assert.deepEqual(parsePresenceLine('C|1'), { t: 'cursor', visible: true })
  assert.deepEqual(parsePresenceLine('C|0'), { t: 'cursor', visible: false })
})

test('a trailing CR is stripped — the child writes Windows line endings', () => {
  assert.deepEqual(parsePresenceLine('R|1\r'), { t: 'run', running: true })
})

test('the HEARTBEAT is a bare line — the one record the child prints unconditionally', () => {
  // Every other record is change-driven, so a healthy idle watcher says nothing at all and is
  // indistinguishable from a wedged one. This line is what makes the difference observable.
  assert.deepEqual(parsePresenceLine('H'), { t: 'beat' })
  assert.deepEqual(parsePresenceLine('H\r'), { t: 'beat' })
  assert.deepEqual(parsePresenceLine('  H  '), { t: 'beat' })
  // It carries no payload, so anything after the H is not a heartbeat.
  assert.equal(parsePresenceLine('H|1'), null)
  assert.equal(parsePresenceLine('Hello'), null)
})

test('anything malformed decodes to null and can never move the state', () => {
  // The channel can also carry a blank line, or a message from a build that does not agree
  // with this one about the protocol.
  for (const junk of [
    '',
    '   ',
    'R',
    'R|',
    'R|yes',
    'C',
    'C|',
    'C|shown',
    'F',
    'F|1|2|3',
    'F|1|2|3|4|5',
    'F|x|0|0|10|10|C:\\a.exe|T',
    'F|1|0|0|10|1.5|C:\\a.exe|T',
    'At line:1 char:1',
    'X|1|2'
  ]) {
    assert.equal(parsePresenceLine(junk), null, `${JSON.stringify(junk)} must not decode`)
  }
})

// --------------------------------------------------------- is this window EverQuest?

test('the install root is matched with a trailing separator, so a sibling dir cannot match', () => {
  assert.equal(eqRootPrefix('C:\\Games\\EQ'), 'C:\\Games\\EQ\\')
  assert.equal(eqRootPrefix('C:\\Games\\EQ\\'), 'C:\\Games\\EQ\\')
  assert.equal(eqRootPrefix('   '), '', 'an unresolvable root disables path matching entirely')

  assert.equal(isEqWindow({ exePath: 'C:\\Games\\EQ\\eqgame.exe', title: 'x' }, 'C:\\Games\\EQ'), true)
  assert.equal(
    isEqWindow({ exePath: 'C:\\Games\\EQ2\\eq2.exe', title: 'x' }, 'C:\\Games\\EQ'),
    false,
    'EQ2 is a different game and a different directory'
  )
})

test('the path match is case-insensitive — Windows paths are, and the log is not the source', () => {
  assert.equal(isEqWindow({ exePath: 'c:\\games\\eq\\EQGAME.EXE', title: '' }, 'C:\\Games\\EQ'), true)
})

test('the TITLE is a LAST RESORT: it fires only when the image path is UNREADABLE', () => {
  // A process image path is not always readable (elevation/protection); the watcher reports an
  // empty path and the title is genuinely all there is.
  assert.equal(isEqWindow({ exePath: '', title: 'EverQuest' }, EQ_ROOT), true)
  assert.equal(isEqWindow({ exePath: '   ', title: 'EverQuest: Firiona Vie' }, EQ_ROOT), true)
  assert.equal(isEqWindow({ exePath: '', title: 'EverQuestly Speaking' }, EQ_ROOT), false)
  assert.equal(isEqWindow({ exePath: '', title: 'Everything about EverQuest' }, EQ_ROOT), false)
})

test('THE RING FOLLOWED THE CURSOR OVER THE BROWSER — a readable path is the answer', () => {
  // THE BUG, as a test. `isEqWindow` used to fall back to "the title contains everquest" for
  // every window the install-root check declined, so ANY process could be classified as the
  // game by what its window happened to say. For the owner of an EverQuest companion app — who
  // is on an EQ wiki, or in an #everquest channel, all day — that is not an edge case, it is
  // Tuesday: the browser took `eqFocused`, handed `eqBounds` its own rectangle, and
  // `cursorRingActive` drew a halo chasing the pointer around a web page.
  //
  // A readable image path is a positive answer to "whose window is this?", so nothing else gets
  // to overrule it.
  for (const [exePath, title] of [
    ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'EverQuest Wiki - Google Chrome'],
    ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'EverQuest — Wikipedia — Mozilla Firefox'],
    ['C:\\Users\\me\\AppData\\Local\\Discord\\Discord.exe', '#everquest | Raid Guild - Discord'],
    ['C:\\Windows\\explorer.exe', 'EverQuest — File Explorer'],
    ['C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', 'EverQuest stream - OBS']
  ] as const) {
    assert.equal(isEqWindow({ exePath, title }, EQ_ROOT), false, title)
  }
})

test('a SECOND INSTALL still counts — by the client’s image NAME, not by its window text', () => {
  // The case the old title fallback was actually written for: a client the app was never
  // pointed at. `eqgame.exe` is the EverQuest client on every build, and it is the same name
  // the watcher's own "is the game running" scan keys on — so the narrowed predicate keeps this
  // working without letting chrome.exe in behind it.
  assert.equal(isEqWindow({ exePath: 'D:\\Games\\P99\\eqgame.exe', title: 'EverQuest' }, EQ_ROOT), true)
  assert.equal(
    isEqWindow({ exePath: 'D:\\Games\\P99\\EQGAME.EXE', title: '' }, EQ_ROOT),
    true,
    'the image name is matched case-insensitively, like the path'
  )
  assert.equal(
    isEqWindow({ exePath: 'D:\\Games\\P99\\eqgame.exe', title: '' }, ''),
    true,
    'and it holds even with no install root at all, which is when it matters most'
  )
  assert.equal(
    isEqWindow({ exePath: 'D:\\Games\\EQ2\\eqgame2.exe', title: 'EverQuest II' }, EQ_ROOT),
    false,
    'a different game with a similar name is still a different game'
  )
})

test("this app's own windows never look like EverQuest", () => {
  // The pid check in presence.ts is what actually classifies them, but the predicate must not
  // claim them either — the ring is positioned from an EQ match, and it must not jump onto an
  // overlay.
  for (const title of [
    'EQ Legends Companion',
    'Fight Overlay',
    'Zone Overlay',
    'Event Log Overlay',
    'Cursor Ring'
  ]) {
    assert.equal(isEqWindow({ exePath: 'C:\\app\\companion.exe', title }, EQ_ROOT), false, title)
  }
})

// The FOUR-WAY split of that same question — which side of "are you in EverQuest?" the foreground
// window falls on, including the two answers our OWN pid can give — lives in
// tests/overlayFocusPolicy.test.mts, beside the alt-tab half of the same ticket (JOS-199).

// ------------------------------------------------------------------- no focus debounce

// JOS-427 removed the debounce outright (owner ruling; the protocol section header carries the
// story). The fold's remaining focus rules — instant flips, the no-window sample, the raise
// grace — are pinned in tests/presenceRefocusFlicker.test.mts.

// -------------------------------------------------------------------- the gating matrix

/** A presence snapshot the watcher HAS reported (`observed`), unless a test says otherwise. */
const presence = (p: Partial<PresenceState> = {}): PresenceState => ({
  observed: true,
  eqRunning: false,
  eqFocused: false,
  eqBounds: null,
  cursorVisible: true,
  ...p
})

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 }

test('with BOTH auto-hide switches off, overlays are never hidden — whatever EQ is doing', () => {
  const off = { hideWhenNotRunning: false, hideWhenUnfocused: false }
  for (const eqRunning of [false, true]) {
    for (const eqFocused of [false, true]) {
      assert.equal(overlaysShouldHide(presence({ eqRunning, eqFocused }), off), false)
    }
  }
})

test('each auto-hide switch hides on its own — they are independent, not a mode', () => {
  const notRunning = { hideWhenNotRunning: true, hideWhenUnfocused: false }
  assert.equal(overlaysShouldHide(presence({ eqRunning: false }), notRunning), true)
  assert.equal(
    overlaysShouldHide(presence({ eqRunning: true, eqFocused: false }), notRunning),
    false,
    'running but unfocused is NOT this switch’s business'
  )

  const unfocused = { hideWhenNotRunning: false, hideWhenUnfocused: true }
  assert.equal(overlaysShouldHide(presence({ eqRunning: true, eqFocused: false }), unfocused), true)
  assert.equal(overlaysShouldHide(presence({ eqRunning: true, eqFocused: true }), unfocused), false)
})

test('NOTHING IS HIDDEN BEFORE THE WATCHER HAS REPORTED — never act on a guess', () => {
  // The watcher opens three system libraries before its first line. Nothing in `INITIAL_PRESENCE`
  // is a fact in that gap, and hiding on it would blink every overlay off at launch and back on a
  // second later on a machine where the game was running the whole time. The same flag resets if
  // the watcher dies, so a dead watcher fails OPEN rather than hiding everything.
  const unobserved = INITIAL_PRESENCE
  for (const prefs of [
    DEFAULT_OVERLAY_AUTO_HIDE,
    { hideWhenNotRunning: true, hideWhenUnfocused: true }
  ]) {
    assert.equal(overlaysShouldHide(unobserved, prefs), false)
  }
  // AND THE FLAG IS ONLY HALF THE PROMISE (JOS-425): it is raised by the first record of ANY kind,
  // so the birth values have to survive that instant on their own. The seam, and the whole of
  // JOS-425's fix, is pinned in tests/presenceRefocusFlicker.test.mts.
  assert.equal(overlaysShouldHide({ ...INITIAL_PRESENCE, observed: true }, DEFAULT_OVERLAY_AUTO_HIDE), false)
})

test('the DEFAULT auto-hide posture: hidden with no game, visible the moment one exists', () => {
  const d = DEFAULT_OVERLAY_AUTO_HIDE
  assert.equal(overlaysShouldHide(presence(), d), true)
  assert.equal(overlaysShouldHide(presence({ eqRunning: true, eqFocused: false }), d), false)
  assert.equal(overlaysShouldHide(presence({ eqRunning: true, eqFocused: true }), d), false)
})

test('THE CURSOR STREAM RUNS ONLY WHEN ENABLED **AND** FOCUSED **AND** POSITIONED', () => {
  // The performance gate, stated as a truth table. Every false row is a row in which main runs
  // no 8 ms interval and sends nothing at all.
  const on = { ...DEFAULT_CURSOR_RING, enabled: true }
  assert.equal(cursorRingActive(presence({ eqFocused: true, eqBounds: BOUNDS }), on), true)

  assert.equal(
    cursorRingActive(presence({ eqRunning: true, eqFocused: true, eqBounds: BOUNDS }), DEFAULT_CURSOR_RING),
    false,
    'disabled ⇒ nothing, even with the game in front'
  )
  assert.equal(
    cursorRingActive(presence({ eqRunning: true, eqFocused: false, eqBounds: BOUNDS }), on),
    false,
    'ALT-TABBED AWAY ⇒ the stream stops'
  )
  assert.equal(
    cursorRingActive(presence({ eqFocused: true, eqBounds: null }), on),
    false,
    'no known EQ window ⇒ nowhere to draw, so nothing is drawn or streamed'
  )
})

test('MOUSELOOK: a hidden system cursor deactivates the ring, and showing it brings it back', () => {
  // EverQuest hides the pointer while the right button is held AND re-centers it every frame, so
  // an absolute sample oscillates around a cursor that is not on screen — the ring danced by
  // itself. There is nothing to halo, so there is nothing to draw and nothing to poll.
  const on = { ...DEFAULT_CURSOR_RING, enabled: true }
  const live = { eqRunning: true, eqFocused: true, eqBounds: BOUNDS }

  assert.equal(cursorRingActive(presence({ ...live, cursorVisible: false }), on), false)
  assert.equal(
    cursorRingActive(presence({ ...live, cursorVisible: true }), on),
    true,
    'releasing the button shows the cursor again, and the ring comes straight back'
  )
})

test('the cursor is presumed VISIBLE until the watcher says otherwise', () => {
  // The gap before the child's first line, and the reset after one that died. This signal can
  // only ever REMOVE the ring, so an unmeasured default must leave the prior behavior alone —
  // the ring then turns on the moment focus and bounds arrive, exactly as it did before.
  const on = { ...DEFAULT_CURSOR_RING, enabled: true }
  assert.equal(INITIAL_PRESENCE.cursorVisible, true)
  assert.equal(
    cursorRingActive({ ...INITIAL_PRESENCE, eqFocused: true, eqBounds: BOUNDS }, on),
    true
  )
})

// ------------------------------------------------------------------- watcher health
//
// The state is a CACHE of the last thing the watcher said, and every consumer reads it as
// current fact — so a stream that stops does not make the app cautious, it makes it confidently
// wrong. These pin the two answers: what a dead/wedged watcher must leave behind, and how hard
// we are allowed to try to get one back.

test('A DEAD OR WEDGED WATCHER PARKS THE RING AND GIVES THE OVERLAYS BACK', () => {
  // The safety property behind both `handleChildGone` and the staleness watchdog, stated where
  // it is actually decided. presence.ts's whole job on a failure is to put THIS value back.
  const on = { ...DEFAULT_CURSOR_RING, enabled: true }

  // Before: the game is focused, its window is known, the halo is live and the 8 ms stream runs.
  const live = presence({ eqRunning: true, eqFocused: true, eqBounds: BOUNDS })
  assert.equal(cursorRingActive(live, on), true)

  // The watcher dies here. Freezing `live` is the reported bug — `eqFocused`, `cursorVisible`
  // and `eqBounds` all outlive the pipe, so the ring keeps drawing over whatever the user
  // alt-tabs to. Resetting to INITIAL_PRESENCE is what makes that impossible.
  // NO KNOWN BOUNDS is what does the work here, and since JOS-425 it is the ONLY thing that does:
  // `eqFocused` is born TRUE (assume EQ-side until observed otherwise), so a reset that relied on
  // a born-false focus would have quietly stopped parking the ring. It does not — there is nowhere
  // to put a halo, and inventing a rectangle is exactly the bug this reset exists to prevent.
  assert.equal(
    cursorRingActive(INITIAL_PRESENCE, on),
    false,
    'no known bounds ⇒ the ring parks and the cursor stream stops'
  )
  assert.equal(INITIAL_PRESENCE.eqBounds, null, 'and that is the field carrying the property')
  for (const prefs of [
    DEFAULT_OVERLAY_AUTO_HIDE,
    { hideWhenNotRunning: true, hideWhenUnfocused: true }
  ]) {
    assert.equal(
      overlaysShouldHide(INITIAL_PRESENCE, prefs),
      false,
      'and `observed:false` fails OPEN: a dead watcher must not hide the overlays forever'
    )
  }
})

test('STALENESS: silence past the window is wedged; anything inside it is just quiet', () => {
  const t0 = 10_000_000
  // [ lastSignalAt, now, stale?, why ]
  const cases: [number, number, boolean, string][] = [
    [t0, t0, false, 'a child that just spoke'],
    [t0, t0 + 1, false, 'one tick of silence'],
    [t0, t0 + 5_000, false, 'one missed heartbeat is a busy machine, not a dead watcher'],
    [t0, t0 + WATCHER_STALE_MS - 1, false, 'just inside the window is still alive'],
    [t0, t0 + WATCHER_STALE_MS, true, 'the window is inclusive'],
    [t0, t0 + 10 * WATCHER_STALE_MS, true, 'and it stays stale'],
    // `lastSignalAt` is seeded at START, so a watcher that has never spoken gets the same window
    // — which is what makes opening three system libraries a non-event.
    [t0, t0 + 2_000, false, 'the library loading is inside the first window']
  ]
  for (const [last, now, expected, why] of cases) {
    assert.equal(watcherIsStale(last, now), expected, why)
  }
  // A caller-supplied window is honored (the seam the app itself does not use, but tests do).
  assert.equal(watcherIsStale(t0, t0 + 100, 50), true)
  assert.equal(watcherIsStale(t0, t0 + 100, 500), false)
})

test('RESTART BACKOFF: fast when it might be a hiccup, CAPPED when it is not', () => {
  // An uncapped retry against a failure that will never clear on this machine (a native surface
  // that will not load, an EDR product that refuses process enumeration) is a restart storm.
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(watcherRestartDelayMs),
    [...WATCHER_RESTART_BACKOFF_MS],
    'the schedule is walked in order, one step per consecutive failure'
  )
  const cap = WATCHER_RESTART_BACKOFF_MS[WATCHER_RESTART_BACKOFF_MS.length - 1]
  for (const n of [6, 7, 50, 10_000]) {
    assert.equal(watcherRestartDelayMs(n), cap, `failure #${n} sits on the ceiling`)
  }
  // Degenerate counters land on the first step rather than off the end of the array.
  for (const n of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(watcherRestartDelayMs(n), WATCHER_RESTART_BACKOFF_MS[0], String(n))
  }
  assert.ok(cap <= 30_000, 'the ceiling is a recovery interval, not a giving-up interval')
})

// ------------------------------------------------------------- prefs: defaults + clamps

test('the shipped defaults are the zero-cost posture', () => {
  // The colour is part of the posture too: white is what every ring drawn before JOS-125 was, so
  // the default cannot move without changing a screen somebody already has. The colour rules
  // themselves live in tests/cursorRingColor.test.mts.
  assert.deepEqual(DEFAULT_CURSOR_RING, {
    enabled: false,
    sizePx: 44,
    thicknessPx: 4,
    colorHex: '#ffffff'
  })
  assert.deepEqual(DEFAULT_OVERLAY_AUTO_HIDE, { hideWhenNotRunning: true, hideWhenUnfocused: false })
})

test('THE WATCHER IS NEEDED ONLY WHEN A FEATURE ASKS FOR IT', () => {
  const noHide = { hideWhenNotRunning: false, hideWhenUnfocused: false }
  assert.equal(
    presenceNeeded(DEFAULT_CURSOR_RING, noHide),
    false,
    'everything off ⇒ no watcher thread is ever started'
  )
  assert.equal(presenceNeeded({ ...DEFAULT_CURSOR_RING, enabled: true }, noHide), true)
  assert.equal(presenceNeeded(DEFAULT_CURSOR_RING, { ...noHide, hideWhenNotRunning: true }), true)
  assert.equal(presenceNeeded(DEFAULT_CURSOR_RING, { ...noHide, hideWhenUnfocused: true }), true)
  // The default install DOES need it — auto-hide-when-not-running ships on.
  assert.equal(presenceNeeded(DEFAULT_CURSOR_RING, DEFAULT_OVERLAY_AUTO_HIDE), true)
})

test('ring prefs are clamped, rounded, and never silently re-intended', () => {
  assert.deepEqual(normalizeCursorRing({ enabled: true, sizePx: 43.6, thicknessPx: 3.2 }), {
    enabled: true,
    sizePx: 44,
    thicknessPx: 3,
    colorHex: '#ffffff'
  })
  assert.equal(normalizeCursorRing({ sizePx: 5 }).sizePx, 20, 'below the floor clamps up')
  assert.equal(normalizeCursorRing({ sizePx: 5000 }).sizePx, 200, 'above the cap clamps down')
  assert.equal(normalizeCursorRing({ thicknessPx: 0 }).thicknessPx, 1)
  // A stroke wider than the radius is a filled dot, not a ring.
  assert.equal(normalizeCursorRing({ sizePx: 20, thicknessPx: 12 }).thicknessPx, 10)
  for (const junk of [undefined, null, 7, 'x', []]) {
    assert.deepEqual(normalizeCursorRing(junk), DEFAULT_CURSOR_RING)
  }
})

test('auto-hide prefs default per FIELD, so a half-written blob keeps the half it has', () => {
  assert.deepEqual(normalizeOverlayAutoHide({ hideWhenUnfocused: true }), {
    hideWhenNotRunning: true,
    hideWhenUnfocused: true
  })
  assert.deepEqual(normalizeOverlayAutoHide({ hideWhenNotRunning: false }), {
    hideWhenNotRunning: false,
    hideWhenUnfocused: false
  })
  for (const junk of [undefined, null, 0, 'x', []]) {
    assert.deepEqual(normalizeOverlayAutoHide(junk), DEFAULT_OVERLAY_AUTO_HIDE)
  }
})
