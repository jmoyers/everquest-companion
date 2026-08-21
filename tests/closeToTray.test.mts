// ============================================================================
// closeToTray.test.mts — what the X on the main window means (JOS-139).
// ============================================================================
//
// THE FEATURE'S WHOLE RISK IS A DECISION MADE ONCE PER CLOSE, and it has two failure modes that
// are worse than the bug it fixes: a window that will not close (a quit swallowed by a hide), and
// a window that closes into nothing (a hide with no icon to bring it back). Both are pure
// questions, so both are answered here — `src/shared/closeToTray.ts` imports nothing, which is
// what lets this file state the whole close policy as a table.
//
// SEVEN CLAIMS:
//
//   1. THE DEFAULT IS ON, and an absent / garbage / partial store reads as the shipped behaviour.
//      This is the one preference in the additive-optional carve-out whose default is `true`, so
//      "what does an upgrading store do" is a claim rather than a formality.
//   2. A PATCH KEEPS WHAT IT DOES NOT NAME. The tray checkbox writes `{enabled}` alone and the
//      popover writes both fields; one merge serves them.
//   3. QUITTING ALWAYS CLOSES. The updater's `quitAndInstall`, an OS logoff, the tray's own Quit —
//      every one of them reaches the window through `before-quit`, and a hide there would leave a
//      process nobody can see or stop.
//   4. NO ICON ⇒ NO HIDE. The E2E harness and any session where the Tray could not be created.
//   5. THE NOTICE IS ONCE PER INSTALL, UNTIL ACKNOWLEDGED — and only two of the three buttons
//      acknowledge, which is a claim about main and is pinned as a source read below.
//   6. THE CARD IS PLACED AGAINST THE ICON, wherever the notification area is, and is ALWAYS
//      wholly inside the work area.
//   7. THE HIDE PATH RETURNS BEFORE THE OVERLAY TEARDOWN. That is the entire feature — a hidden
//      main window that destroyed the overlays would be the opposite of it — and it is a claim
//      about the ORDER of two statements in an Electron listener, so it is a source pin.
//
// The Electron halves (src/main/tray.ts, the one guard in src/main/windows.ts) carry no arithmetic
// of their own; claims 5 and 7 read them as text for the same reason overlaySnap.test.mts reads
// the drag listener.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_CLOSE_TO_TRAY,
  TRAY_NOTICE_MS,
  TRAY_NOTICE_SIZE,
  closeIntent,
  mergeCloseToTray,
  normalizeCloseToTray,
  shouldShowTrayNotice,
  trayNoticeBounds,
  type NoticeRect
} from '../src/shared/closeToTray'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// ---- 1 + 2. the preference ---------------------------------------------------------------------

test('THE DEFAULT IS OFF (owner reversal, 2026-08-16), and every unreadable store lands on it', () => {
  assert.deepEqual(DEFAULT_CLOSE_TO_TRAY, { enabled: false, noticeAcknowledged: false })
  for (const junk of [undefined, null, 'yes', 42, [true], { enabled: 'yes' }]) {
    assert.deepEqual(
      normalizeCloseToTray(junk),
      { enabled: false, noticeAcknowledged: false },
      `${JSON.stringify(junk)} reads as the shipped behaviour`
    )
  }
})

test('a stored answer is kept, in both directions and field by field', () => {
  assert.deepEqual(normalizeCloseToTray({ enabled: true, noticeAcknowledged: true }), {
    enabled: true,
    noticeAcknowledged: true
  })
  // The half-written store an older build (or a hand edit) can leave behind.
  assert.deepEqual(normalizeCloseToTray({ enabled: true }), {
    enabled: true,
    noticeAcknowledged: false
  })
  // …and a missing switch falls to the shipped OFF, whatever the notice flag says.
  assert.deepEqual(normalizeCloseToTray({ noticeAcknowledged: true }), {
    enabled: false,
    noticeAcknowledged: true
  })
})

test('A PATCH KEEPS WHAT IT DOES NOT NAME — one merge for both writers', () => {
  const stored = { enabled: true, noticeAcknowledged: true }
  // The tray menu's checkbox: one field, and the acknowledgement must survive it.
  assert.deepEqual(mergeCloseToTray({ enabled: false }, stored), {
    enabled: false,
    noticeAcknowledged: true
  })
  // The popover's `Always quit instead`: both fields at once.
  assert.deepEqual(
    mergeCloseToTray({ enabled: false, noticeAcknowledged: true }, { enabled: true, noticeAcknowledged: false }),
    { enabled: false, noticeAcknowledged: true }
  )
  // A patch of the wrong shape changes nothing at all rather than resetting to the defaults.
  assert.deepEqual(mergeCloseToTray('nonsense', stored), stored)
  assert.deepEqual(mergeCloseToTray({ enabled: 1 }, stored), stored)
})

// ---- 3 + 4. the close decision ------------------------------------------------------------------

test('THE WHOLE CLOSE POLICY, as a table', () => {
  const table: { enabled: boolean; quitting: boolean; trayAvailable: boolean; want: string; why: string }[] = [
    { enabled: true, quitting: false, trayAvailable: true, want: 'hide', why: 'the feature, once opted into' },
    { enabled: false, quitting: false, trayAvailable: true, want: 'close', why: 'the user asked for the X to quit' },
    { enabled: true, quitting: true, trayAvailable: true, want: 'close', why: 'the app is already quitting' },
    { enabled: true, quitting: false, trayAvailable: false, want: 'close', why: 'nothing could bring it back' },
    { enabled: false, quitting: true, trayAvailable: true, want: 'close', why: '' },
    { enabled: false, quitting: false, trayAvailable: false, want: 'close', why: '' },
    { enabled: true, quitting: true, trayAvailable: false, want: 'close', why: '' },
    { enabled: false, quitting: true, trayAvailable: false, want: 'close', why: '' }
  ]
  for (const row of table) {
    assert.equal(
      closeIntent(row),
      row.want,
      `${JSON.stringify({ enabled: row.enabled, quitting: row.quitting, tray: row.trayAvailable })} ${row.why}`
    )
  }
  // Exactly ONE of the eight hides. Stated as a count as well as a table, because the risk here is
  // a future fourth input quietly widening the hide.
  assert.equal(table.filter((r) => closeIntent(r) === 'hide').length, 1)
})

test('QUITTING OUTRANKS THE PREFERENCE, so every quit path is terminal', () => {
  // The three that reach `before-quit` without any window being closed first: the auto-updater's
  // quitAndInstall(true, true), an OS logoff, and `app.quit()` from anywhere.
  assert.equal(closeIntent({ enabled: true, quitting: true, trayAvailable: true }), 'close')
  // And the latch is armed unconditionally, ahead of the icon: a tray that failed to be created
  // must not also cost us the latch.
  const tray = read('../src/main/tray.ts')
  const latch = tray.indexOf("app.once('before-quit'")
  const guard = tray.indexOf('if (E2E) return')
  const created = tray.indexOf('new Tray(')
  assert.ok(latch > 0 && guard > latch, 'the latch is armed before the E2E early return')
  assert.ok(created > guard, 'and the icon is created after it')
})

// ---- 5. the notice ------------------------------------------------------------------------------

test('THE CARD IS SHOWN UNTIL IT IS ACKNOWLEDGED, and fifteen seconds is not an acknowledgement', () => {
  assert.equal(shouldShowTrayNotice({ acknowledged: false }), true)
  assert.equal(shouldShowTrayNotice({ acknowledged: true }), false)
  assert.equal(TRAY_NOTICE_MS, 15_000)

  const tray = read('../src/main/tray.ts')
  // The three endings that are NOT an answer all go through one function, and that function never
  // writes the flag — which is what makes "somebody who did not read it sees it again" true.
  const dismiss = tray.slice(tray.indexOf('function dismissTrayNotice('))
  assert.ok(!dismiss.slice(0, dismiss.indexOf('\n}')).includes('noticeAcknowledged'))
  assert.match(tray, /w\.on\('blur', dismissTrayNotice\)/, 'a click elsewhere takes it away')
  assert.match(tray, /setTimeout\(dismissTrayNotice, TRAY_NOTICE_MS\)/, 'and so does the clock')

  // `Quit now` deliberately does NOT acknowledge; the other two do.
  const quitHandler = tray.slice(tray.indexOf('IPC.trayNoticeQuit'), tray.indexOf('IPC.trayNoticeAlwaysQuit'))
  assert.ok(!quitHandler.includes('noticeAcknowledged'), 'quitting is not reading')
  assert.match(tray, /applyCloseToTray\(\{ enabled: false, noticeAcknowledged: true \}\)/)
  assert.match(tray, /applyCloseToTray\(\{ noticeAcknowledged: true \}\)/)
})

// ---- 6. where the card goes ---------------------------------------------------------------------

/** A 1920x1080 primary whose work area stops 40px short of the bottom (a taskbar). */
const WORK: NoticeRect = { x: 0, y: 0, width: 1920, height: 1040 }
/** The notification area's usual place: a small icon at the right-hand end of that taskbar. */
const BOTTOM_TRAY: NoticeRect = { x: 1840, y: 1046, width: 24, height: 24 }

const inside = (r: NoticeRect, area: NoticeRect): boolean =>
  r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height

test('THE CARD SITS ABOVE THE ICON, centred on it, and inside the work area', () => {
  const b = trayNoticeBounds(BOTTOM_TRAY, WORK)
  assert.deepEqual({ width: b.width, height: b.height }, { ...TRAY_NOTICE_SIZE })
  assert.ok(b.y + b.height <= BOTTOM_TRAY.y, 'above the icon')
  assert.ok(inside(b, WORK), 'and wholly on the work area')
  // Centred, then clamped: this icon is 80px from the right edge, so the clamp is what decides x.
  assert.equal(b.x, WORK.width - TRAY_NOTICE_SIZE.width)
})

test('…AND BELOW IT when the notification area is at the TOP of the screen', () => {
  // A taskbar at the top: the work area starts below it, and there is no room above the icon.
  const topWork: NoticeRect = { x: 0, y: 40, width: 1920, height: 1040 }
  const topTray: NoticeRect = { x: 1840, y: 8, width: 24, height: 24 }
  const b = trayNoticeBounds(topTray, topWork)
  assert.ok(b.y >= topTray.y + topTray.height, 'below the icon, because above it is off the screen')
  assert.ok(inside(b, topWork))
})

test('a side taskbar and a second monitor both land on their own work area', () => {
  // Taskbar down the LEFT of a second display: the icon is at x ~ 1930, and the card must not
  // spill back onto the primary.
  const rightWork: NoticeRect = { x: 1920 + 60, y: 0, width: 1860, height: 1080 }
  const sideTray: NoticeRect = { x: 1930, y: 900, width: 24, height: 24 }
  const b = trayNoticeBounds(sideTray, rightWork)
  assert.ok(inside(b, rightWork), 'clamped into the display it belongs to')
})

test('an icon that will not say where it is falls back to the corner it usually lives in', () => {
  const b = trayNoticeBounds({ x: 0, y: 0, width: 0, height: 0 }, WORK)
  assert.ok(inside(b, WORK))
  assert.ok(b.x + b.width > WORK.width - 40 && b.y + b.height > WORK.height - 40, 'bottom right')
})

test('a work area smaller than the card still leaves its top-left on screen', () => {
  const tiny: NoticeRect = { x: 100, y: 100, width: 200, height: 100 }
  const b = trayNoticeBounds(BOTTOM_TRAY, tiny)
  assert.deepEqual({ x: b.x, y: b.y }, { x: tiny.x, y: tiny.y })
})

// ---- 7. the order the close handler asks in ------------------------------------------------------

test('THE HIDE PATH RETURNS BEFORE THE OVERLAYS ARE DESTROYED — the feature itself', () => {
  // A SOURCE PIN, because the claim is about the order of two statements inside an Electron
  // listener that no node test can fire. Electron runs `close` listeners in registration order and
  // a `preventDefault` from one does NOT stop the others from running, so this must be ONE handler
  // with an early return — not a second listener that merely cancels the close.
  const windows = read('../src/main/windows.ts')
  const handler = windows.slice(windows.indexOf("mainWindow.on('close'"))
  const asked = handler.indexOf('if (hideMainWindowToTray(e)) return')
  const overlays = handler.indexOf('w.destroy()')
  const ring = handler.indexOf('destroyCursorRingWindow()')
  assert.ok(asked > 0, 'the close handler asks the interceptor')
  assert.ok(asked < overlays && asked < ring, 'and it asks BEFORE any accessory is torn down')

  // Exactly one `close` listener on the main window: a second one would run whatever the first
  // decided, which is the trap this arrangement exists to avoid.
  const listeners = windows.match(/mainWindow\.on\('close'/g) ?? []
  assert.equal(listeners.length, 1, 'one close handler, asked in one order')

  // The geometry is still written on BOTH paths (JOS-248): a window that was left somewhere and
  // then hidden was still left there.
  assert.ok(handler.indexOf('flushMainWindowState()') < asked, 'the state flush precedes the question')

  // And the hide itself is never a block: the interceptor hides in the same breath as it prevents.
  const tray = read('../src/main/tray.ts')
  const intercept = tray.slice(tray.indexOf('export function hideMainWindowToTray'))
  assert.ok(
    intercept.indexOf('e.preventDefault()') < intercept.indexOf('w.hide()'),
    'preventDefault always comes with a hide'
  )
})

test('THE TRAY QUIT RUNS THE SAME TEARDOWN THE X ALWAYS DID', () => {
  // `app.quit()` does not emit `window-all-closed`, and index.ts hangs the session stop, the
  // telemetry sessionEnd, the perf profile and the learned message-overlay flush off exactly that
  // event. So the tray's Quit latches and CLOSES THE WINDOW, which is the path those steps live on.
  const tray = read('../src/main/tray.ts')
  const quit = tray.slice(tray.indexOf('function requestQuit('), tray.indexOf('// -----', tray.indexOf('function requestQuit(')))
  assert.match(quit, /quitting = true/, 'the latch first, so the close is a real one')
  assert.match(quit, /w\.close\(\)/, 'then the window closes, which is what runs window-all-closed')
  assert.match(quit, /app\.quit\(\)/, 'and a window that is already gone still quits')

  // The popover is a window too, and `window-all-closed` does not fire while one is up.
  assert.match(quit, /destroyTrayNotice\(\)/)
})

test('A REAL CLOSE TAKES THE CARD WITH IT — a hidden window is still an open one', () => {
  // The zombie this prevents: the popover is reused rather than re-created, so after one hide it
  // exists (hidden) for the rest of the session — and `window-all-closed` does not fire while any
  // window exists. Hide to the tray, restore, turn the preference OFF, press X: without this the
  // process would sit there with no windows, having run none of index.ts's teardown.
  const tray = read('../src/main/tray.ts')
  const intercept = tray.slice(
    tray.indexOf('export function hideMainWindowToTray'),
    tray.indexOf('function restoreMainWindow(')
  )
  const closes = intercept.indexOf("if (intent === 'close')")
  assert.ok(closes > 0)
  assert.ok(
    intercept.indexOf('destroyTrayNotice()', closes) < intercept.indexOf('return false', closes),
    'the close branch destroys the card before it hands the close on'
  )
})

test('THE POPOVER TAKES THE ONE SHARED SECURITY POSTURE, never a second opinion', () => {
  const tray = read('../src/main/tray.ts')
  assert.match(tray, /webPreferences: WEB_PREFERENCES\(join\(__dirname, '\.\.\/preload\/tray\.js'\)\)/)
  // Nothing in this app re-states focusability outside windows.ts's one guarded helper (JOS-199).
  assert.ok(!tray.includes('setFocusable('), 'a tray window must not move the foreground by hand')
})
