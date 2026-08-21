// THE OVERLAYS BLINKED ON EVERY REFOCUS — the whole story, ending in JOS-427.
//
// THE REPORT, verbatim in intent: with hide-overlays-when-EQ-not-focused on, alt-tabbing back INTO
// EverQuest made the overlays flicker — on, off, on again quickly — and only then stay. Three fixes
// landed beside this path first (355da1e6 the ring's z-order, c650f811/JOS-199 the hide pass
// grabbing the foreground, 53eed1ab/JOS-368 five SetWindowPos per refocus), then two more in the
// signal itself (JOS-424 an asymmetric debounce, JOS-425 born-true state) — and the narration those
// tickets added finally produced the discriminating test: four alt-tab round trips, eight committed
// flips, every one a single truthful edge… and the owner still SAW the flicker.
//
// SO THE STROBE WAS NEVER THE SIGNAL. It was `hide()` itself: a hidden window stops compositing,
// and its re-show presents a STALE surface which Windows then clears and repaints — measured on the
// ring back in JOS-120, finally applied to the overlays as `windows.ts parkOverlays` (opacity 0,
// never hidden). OWNER RULING 2026-08-19, both barrels: park instead of hide, and "remove all the
// debounce bullshit, since its clearly not that" — the observed foreground IS the focus state.
// What replaces time is EVIDENCE: a no-window sample (pid 0) is not a departure, and an
// overlay-initiated raise of the Companion window is "effectively everquest still being the focus
// spiritually" (the con-card oscillation the narration caught).
//
// This file is one defect's whole story, separate from tests/presence.test.mts for the reason
// cursorRingOff.test.mts is — and that file is a page from its 400-line ceiling.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TRANSITION_TITLE_MAX,
  describeFocusTransition,
  describeOverlayPark,
  describeOverlayVisibility,
  focusCountsAsEq,
  overlaysShouldHide,
  type ForegroundSide
} from '../src/main/presenceProtocol'
import * as protocol from '../src/main/presenceProtocol'
import { INITIAL_PRESENCE } from '../src/shared/presencePrefs'
import type { OverlayAutoHidePrefs, PresenceState } from '../src/shared/presencePrefs'

// ------------------------------------------------------------------------- the doctrine

test('THERE IS NO DEBOUNCE LEFT TO REGROW — the protocol exports nothing by that name', () => {
  // A tripwire, not a taste test: three generations of smoothing were removed by an explicit owner
  // ruling, and a fourth must arrive as a re-argued decision, not a refactor.
  const names = Object.keys(protocol).filter((k) => /debounce/i.test(k))
  assert.deepEqual(names, [], 'a debounce export came back without a ruling')
})

test('THE FOCUS MATRIX, including the raise grace', () => {
  const cases: readonly (readonly [ForegroundSide, boolean, boolean])[] = [
    // side, ownRaise, counts as EQ
    ['eq', false, true],
    ['eq', true, true],
    ['own-accessory', false, true],
    ['own-accessory', true, true],
    // The Companion window has TWO answers (JOS-427): an alt-tab into the app is the user leaving
    // the game (JOS-199); a raise the app performed FOR an overlay click is the overlays' own
    // feature working, and parking them for using it was the oscillation.
    ['own-app', false, false],
    ['own-app', true, true],
    ['other', false, false],
    ['other', true, false]
  ]
  for (const [side, raise, expect] of cases) {
    assert.equal(focusCountsAsEq(side, raise), expect, `${side} raise=${String(raise)}`)
  }
  // The one-argument form is the pre-JOS-427 reading, unchanged — every old call site means what
  // it always meant.
  assert.equal(focusCountsAsEq('own-app'), false)
})

// ------------------------------------------------- the fold, driven the way presence.ts drives it
//
// No clocks anywhere: with the debounce gone, the fold's output is a pure function of the record
// sequence. This driver mirrors `applyRecord`/`applyFocus` — the pid-0 return, the raise grace's
// lifetime, the lane order — and the source audits at the bottom pin presence.ts to the same shape,
// so this cannot quietly describe a file that has drifted.

type Rec =
  | { readonly t: 'cursor'; readonly visible: boolean }
  | { readonly t: 'run'; readonly running: boolean }
  | { readonly t: 'fg'; readonly side: ForegroundSide; readonly pid: number }
  | { readonly t: 'raise' } // windowControls.ts focusView → noteOwnWindowRaise()

interface Edge {
  readonly i: number
  readonly hidden: boolean
}

/** Overlays start UN-PARKED — where the replay gate's end-of-fold restore leaves them, with the
 *  unobserved state failing open. Edges are indexed by record, not by clock: there is no clock. */
function driveWatcher(
  events: readonly Rec[],
  prefs: OverlayAutoHidePrefs
): { readonly edges: readonly Edge[]; readonly hidden: boolean } {
  let state: PresenceState = INITIAL_PRESENCE
  let ownRaise = false
  let hidden = overlaysShouldHide(state, prefs)
  const edges: Edge[] = []
  events.forEach((rec, i) => {
    if (rec.t === 'raise') {
      ownRaise = true
      return
    }
    if (rec.t === 'cursor') state = { ...state, observed: true, cursorVisible: rec.visible }
    else if (rec.t === 'run') state = { ...state, observed: true, eqRunning: rec.running }
    else if (rec.pid === 0) {
      // A NO-WINDOW SAMPLE IS NOT A DEPARTURE (JOS-427): nothing gained the foreground, so nothing
      // was left. Observed rises; the focus answer stands.
      state = { ...state, observed: true }
    } else {
      if (rec.side !== 'own-app') ownRaise = false
      state = { ...state, observed: true, eqFocused: focusCountsAsEq(rec.side, ownRaise) }
    }
    const next = overlaysShouldHide(state, prefs)
    if (next !== hidden) {
      hidden = next
      edges.push({ i, hidden: next })
    }
  })
  return { edges, hidden }
}

const BOTH_ON: OverlayAutoHidePrefs = { hideWhenNotRunning: true, hideWhenUnfocused: true }
const FOCUS_ONLY: OverlayAutoHidePrefs = { hideWhenNotRunning: false, hideWhenUnfocused: true }

/** The watcher's first tick, in its own order: cursor, foreground, running — three separate
 *  `postMessage`s, folded one at a time with the effects pass between them (presenceWorker.ts). */
function firstTick(side: ForegroundSide, running: boolean): readonly Rec[] {
  return [
    { t: 'cursor', visible: true },
    { t: 'fg', side, pid: side === 'eq' ? 4321 : 777 },
    { t: 'run', running }
  ]
}

const FG = (side: ForegroundSide): Rec => ({ t: 'fg', side, pid: side === 'eq' ? 4321 : 777 })

test('BIRTH IS AGREEMENT: gate restore, watcher start, first sample IS EverQuest ⇒ no edge at all', () => {
  const run = driveWatcher(firstTick('eq', true), BOTH_ON)
  assert.deepEqual(run.edges, [], 'the machine that never left the game never blinks')
  assert.equal(run.hidden, false)
})

test('A GENUINELY ELSEWHERE MACHINE HIDES ON THE RECORD THAT SAYS SO — once, instantly', () => {
  const away = driveWatcher(firstTick('other', true), BOTH_ON)
  assert.deepEqual(away.edges, [{ i: 1, hidden: true }], 'the foreground record itself is the edge')
})

test('THE GAME BEING CLOSED IS A MEASUREMENT TOO, and hides on its own lane', () => {
  const closed = driveWatcher(firstTick('eq', false), BOTH_ON)
  assert.deepEqual(closed.edges, [{ i: 2, hidden: true }], 'the run record is the edge')
  // …and only under the pref that asks for it.
  const focusOnly = driveWatcher(firstTick('eq', false), FOCUS_ONLY)
  assert.deepEqual(focusOnly.edges, [])
})

test('ALT-TAB IS TWO EDGES, INSTANT BOTH WAYS — the latency the debounce used to add is gone', () => {
  const session = driveWatcher([...firstTick('eq', true), FG('other'), FG('eq')], BOTH_ON)
  assert.deepEqual(session.edges, [
    { i: 3, hidden: true },
    { i: 4, hidden: false }
  ])
})

test('THE TRANSITION FLAP IS ABSORBED BY EVIDENCE, NOT TIME: a pid-0 sample moves nothing', () => {
  // Windows hands the foreground to NO window during transitions — the flap the old debounce
  // existed to wait out. Nothing gained focus, so nothing was left.
  const flap = driveWatcher([...firstTick('eq', true), { t: 'fg', side: 'other', pid: 0 }, FG('eq')], BOTH_ON)
  assert.deepEqual(flap.edges, [], 'no window ≠ not EverQuest')
  // And the mirror: parked (user elsewhere), a pid-0 sample does not un-park either.
  const parked = driveWatcher(
    [...firstTick('other', true), { t: 'fg', side: 'other', pid: 0 }],
    BOTH_ON
  )
  assert.deepEqual(parked.edges, [{ i: 1, hidden: true }], 'the empty moment keeps the last answer')
})

test('THE RAISE GRACE: an overlay-initiated raise of the app window parks nothing', () => {
  // The con-card oscillation, as a sequence: card click → focusView raises the app → the app IS
  // the foreground. Owner ruling: still EverQuest, spiritually.
  const graced = driveWatcher(
    [...firstTick('eq', true), { t: 'raise' }, FG('own-app'), FG('eq')],
    BOTH_ON
  )
  assert.deepEqual(graced.edges, [], 'using an overlay is not leaving the game')

  // The grace ends at the first foreign foreground: after the user lands anywhere else, the app
  // window in front means what it always meant (JOS-199).
  const ended = driveWatcher(
    [...firstTick('eq', true), { t: 'raise' }, FG('own-app'), FG('other'), FG('own-app')],
    BOTH_ON
  )
  assert.deepEqual(ended.edges, [{ i: 5, hidden: true }], 'one grace per raise, ended by evidence')

  // And a deliberate alt-tab INTO the Companion — no raise — parks instantly, as it always has.
  const deliberate = driveWatcher([...firstTick('eq', true), FG('own-app')], BOTH_ON)
  assert.deepEqual(deliberate.edges, [{ i: 3, hidden: true }])
})

test('FAIL-OPEN IS UNTOUCHED: before the first record nothing hides, whatever the prefs say', () => {
  for (const prefs of [BOTH_ON, FOCUS_ONLY]) {
    assert.equal(overlaysShouldHide(INITIAL_PRESENCE, prefs), false)
  }
})

// ------------------------------------------------------------------------- the narration
//
// The logging is what cracked this case — it proved the strobe had no committed flip behind it —
// and it stays, under the same bright line: `logInfo` (console only), never the error store,
// because the record carries a third-party window title.

const EQ_ROOT = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
const EQ_FG = {
  pid: 4321,
  exePath: `${EQ_ROOT}\\eqgame.exe`,
  title: 'EverQuest',
  side: 'eq' as const
}
const AT = Date.parse('2026-08-19T18:30:00.000Z')

/** The body of a named top-level function in a source file, up to the next top-level `}` — the
 *  same reader tests/overlayFocusPolicy.test.mts uses for the other half of this mechanism. */
function body(path: string, decl: string): string {
  const src = readFileSync(new URL(path, import.meta.url), 'utf8')
  const start = src.indexOf(decl)
  assert.notEqual(start, -1, `${decl} not found`)
  const end = src.indexOf('\n}', start)
  assert.notEqual(end, -1, `${decl} has no end`)
  return src.slice(start, end)
}

test('A FLIP SAYS WHAT DROVE IT: the value, the clock, the pid and the image', () => {
  const line = describeFocusTransition({ committed: true, at: AT, driver: EQ_FG })
  assert.equal(
    line,
    'presence: eqFocused -> true at 2026-08-19T18:30:00.000Z; foreground pid 4321 eqgame.exe [eq] "EverQuest"'
  )
})

test('a flip with no foreground record yet says so rather than inventing one', () => {
  const line = describeFocusTransition({ committed: false, at: AT, driver: null })
  assert.equal(line, 'presence: eqFocused -> false at 2026-08-19T18:30:00.000Z; no foreground record yet')
})

test('THE LINE IS ONE LINE, AND A WINDOW TITLE CANNOT FORGE A SECOND', () => {
  const hostile = describeFocusTransition({
    committed: false,
    at: AT,
    driver: {
      pid: 9,
      exePath: 'C:\\x\\evil.exe',
      title: 'line one\r\nline "two"\tand a very long tail '.repeat(8),
      side: 'other'
    }
  })
  assert.equal(hostile.includes('\n'), false)
  assert.equal(hostile.includes('\r'), false)
  const quoted = hostile.slice(hostile.indexOf('"') + 1, hostile.lastIndexOf('"'))
  assert.equal(quoted.includes('"'), false, 'the wrapping quotes cannot be closed early')
  assert.ok(quoted.length <= TRANSITION_TITLE_MAX + 1, 'bounded (plus the ellipsis)')
})

test('THE PARK HAS ITS OWN WORD, so dev.log tells it from a real gate hide at a glance', () => {
  assert.equal(describeOverlayPark(true, AT), 'presence: overlays parked at 2026-08-19T18:30:00.000Z')
  assert.equal(describeOverlayPark(false, AT), 'presence: overlays unparked at 2026-08-19T18:30:00.000Z')
  // The gate's copy is unchanged — a "hidden" line now always means the gate (or teardown).
  assert.equal(describeOverlayVisibility(true, AT), 'presence: overlays hidden at 2026-08-19T18:30:00.000Z')
})

test('NOTHING BUT logInfo TOUCHES THE FLIP LINE — the telemetry bright line, at the sink', () => {
  const fold = body('../src/main/presence.ts', 'function applyFocus')
  assert.ok(fold.includes('describeFocusTransition'), 'the flip narrates')
  assert.ok(fold.includes('logInfo'), 'console only')
  assert.equal(fold.includes('logError'), false, 'never the error store')
  assert.equal(fold.includes('setTimeout'), false, 'and no timers — there is no debounce')
})

// ------------------------------------------------------------------- the wiring, pinned at source
//
// These are reached-assertions over the exact seams the fold driver above mirrors. If one of them
// moves, the driver is describing a file that no longer exists — fail here, loudly, first.

test('presence.ts: the pid-0 return, the grace lifetime, and the two-argument fold', () => {
  const src = readFileSync(new URL('../src/main/presence.ts', import.meta.url), 'utf8')
  const record = body('../src/main/presence.ts', 'function applyRecord')
  assert.ok(record.includes('rec.pid === 0'), 'the no-window sample is answered before the fold')
  assert.ok(record.indexOf('rec.pid === 0') < record.indexOf('foregroundSide('), 'and before the side is read')
  assert.ok(record.includes("if (side !== 'own-app') ownWindowRaise = false"), 'the grace ends at the first foreign foreground')
  assert.ok(record.includes('focusCountsAsEq(side, ownWindowRaise)'), 'the fold reads the grace')
  // Both reset paths retire the grace with the generation.
  const resets = src.split('ownWindowRaise = false').length - 1
  assert.ok(resets >= 3, 'cleared in applyRecord and at both reset paths')
})

test('windowControls.ts: the raise is graced BEFORE the focus moves, and narrated', () => {
  const src = readFileSync(new URL('../src/main/ipc/windowControls.ts', import.meta.url), 'utf8')
  const raise = src.indexOf('noteOwnWindowRaise()')
  const focus = src.indexOf('w.focus()')
  assert.notEqual(raise, -1)
  assert.ok(raise < focus, 'grace first — the record can arrive on the very next watcher tick')
  assert.ok(src.includes('focusView raise ->'), 'one of exactly two deliberate foreground moves, narrated')
})

test('presenceEffects.ts parks; windows.ts parkOverlays never hides', () => {
  const effects = readFileSync(new URL('../src/main/presenceEffects.ts', import.meta.url), 'utf8')
  assert.ok(effects.includes('parkOverlays(overlaysShouldHide('), 'presence drives the park')
  assert.equal(effects.includes('setOverlaysHidden('), false, 'presence no longer hides windows')
  const park = body('../src/main/windows.ts', 'export function parkOverlays')
  assert.ok(park.includes('setOpacity'), 'the park is an opacity flip')
  assert.equal(park.includes('.hide('), false, 'a parked window never stops compositing (JOS-120)')
  assert.ok(park.includes('overlaysParkedNow === parked'), 'edge-narrated, idempotent otherwise')
})

test('THE GATE UN-HIDES WHAT THE GATE HID — real visibility has exactly one owner', () => {
  // The regression the owner caught live ("overlay is not coming up - lol"): the end-of-replay
  // re-show was secretly a side effect of presence's old hide pass. With presence parking,
  // session.ts must restore its own gate, or the overlays stay hidden forever after every boot.
  const gate = body('../src/main/session.ts', 'function setReplayGate')
  assert.ok(gate.includes('setOverlaysHidden(true)'), 'the gate hides going in')
  assert.ok(gate.includes('setOverlaysHidden(false)'), 'and un-hides coming out')
  assert.ok(
    gate.indexOf('setOverlaysHidden(false)') < gate.indexOf('refreshPresenceEffects()'),
    'shown first (at park opacity), then the presence pass parks or not'
  )
})
