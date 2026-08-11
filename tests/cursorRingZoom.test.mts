// ============================================================================
// cursorRingZoom.test.mts — JOS-154: the cursor ring stays centred on the pointer at every text
// size.
// ============================================================================
//
// THE DEFECT, and where it actually entered. Changing the app's text size (`uiScale`, JOS-123)
// moved the ring off the pointer — further off the further the pointer was from the top-left of
// the EverQuest window, and with the halo drawn oversized as well. Nothing in this app ever asked
// for that: the zoom is applied to the MAIN window alone. It travelled through CHROMIUM, which
// stores a zoom PER HOST rather than per window, and in development every page this app serves
// comes from one host (the electron-vite dev server) — so `setZoomFactor` on the main window
// moved the ring window with it. MEASURED on Electron 43.2.0: two windows on
// `http://localhost:<port>`, a main-window `setZoomFactor(1.25)`, and the plain window goes from
// 1.0 to 1.25. A packaged build escapes it by accident only, because a `file:` URL is keyed by
// its whole spec and so index.html and cursor.html land in separate entries.
//
// WHY THE ZOOM IS FATAL HERE SPECIFICALLY, when it is harmless in the main window: the ring's CSS
// pixels are a COORDINATE SYSTEM. Main sends a DIP offset from the ring window's own origin
// (`screen.getCursorScreenPoint()` minus `getBounds()`, presenceEffects.ts) and the renderer uses
// it directly as a CSS translation. DIP and CSS px are the same number only at zoom 1.
//
// WHAT THIS FILE OWNS: the wiring, as source — the pin exists, it is the one API that does not
// write the shared host entry, and no window factory has quietly grown a second opinion about
// which window carries the text size. The claims about a RUNNING Chromium (that the pin actually
// refuses an inherited zoom, and that a pinned window centres the halo on the point it was sent)
// belong to `tests/e2e/cursor-ring-zoom.e2e.mts`, which measures both against real windows.
//
// Reading source is the same technique `cursorRingColor.test.mts` uses on cursor.html, and for
// the same reason: the rule lives in a file no unit test can otherwise reach, and a silent
// deletion of it would leave every other test in the repo green.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

/**
 * Source with its COMMENTS REMOVED, because half the assertions below are "this file does not
 * call X" and this repo argues in prose about the calls it deliberately does not make. Reading
 * the raw text would fail on its own explanation, which is the least useful red a test can be.
 */
const codeOf = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const CURSOR_PRELOAD = codeOf('src/preload/cursor.ts')
const WINDOWS = codeOf('src/main/windows.ts')
const RING = codeOf('src/renderer/src/overlay/cursorRing.ts')

test('the cursor-ring preload pins its own window at zoom 1', () => {
  assert.match(
    CURSOR_PRELOAD,
    /webFrame\.setZoomLevel\(0\)/,
    'the ring window has to hold zoom 1 or main is sending it coordinates in the wrong unit'
  )
  assert.match(CURSOR_PRELOAD, /import \{[^}]*\bwebFrame\b[^}]*\} from 'electron'/)
})

test('…with webFrame, which is the ONE zoom API that is not the shared host entry', () => {
  // `webContents.setZoomFactor` / `setZoomLevel` write the session's per-host zoom, so calling
  // either against the ring would un-zoom the MAIN window — the one window the setting is for.
  // Electron routes webFrame's setter to SetTemporaryZoomLevel, keyed by this render view.
  assert.doesNotMatch(
    CURSOR_PRELOAD,
    /webContents\.setZoom/,
    'the ring must never reach for the host-level setter'
  )
  // `webPreferences: { zoomFactor: 1 }` is inert against an existing host entry (measured), which
  // is exactly the case that matters — the ring window is created long after the setting is made.
  assert.doesNotMatch(
    ringWindowOptions(),
    /zoomFactor/,
    'a zoomFactor on the ring window would be a second, ineffective opinion'
  )
})

/** The BrowserWindow options block `createCursorRingWindow` builds, isolated from the rest of
 *  windows.ts so "the ring carries no zoomFactor" is a claim about the ring's own window. */
function ringWindowOptions(): string {
  const start = WINDOWS.indexOf('export function createCursorRingWindow')
  assert.ok(start > 0, 'createCursorRingWindow moved; this test is reading the wrong file')
  const open = WINDOWS.indexOf('new BrowserWindow({', start)
  assert.ok(open > start, 'createCursorRingWindow no longer constructs a BrowserWindow')
  const end = WINDOWS.indexOf('\n  })', open)
  assert.ok(end > open)
  return WINDOWS.slice(open, end)
}

test('the text size still applies to the MAIN window and to nothing else', () => {
  // One `zoomFactor:` in the whole file, and it is the main window's constructor (JOS-123).
  const constructed = WINDOWS.match(/zoomFactor:/g) ?? []
  assert.equal(constructed.length, 1, 'exactly one window may be built with a zoom factor')
  const mainStart = WINDOWS.indexOf('export function createMainWindow')
  const at = WINDOWS.indexOf('zoomFactor:')
  assert.ok(at > mainStart, 'the zoom factor belongs to createMainWindow')

  // One runtime setter, and it targets the main window by name. A `setZoomFactor` against any
  // other window would write the shared host entry and take every same-origin window with it.
  const setters = WINDOWS.match(/\.setZoomFactor\(/g) ?? []
  assert.equal(setters.length, 1, 'exactly one runtime setZoomFactor call')
  assert.match(WINDOWS, /getMainWindow\(\)\?\.webContents\.setZoomFactor\(scale\)/)
})

test('the ring centres on the point it is sent, by subtracting half its own width', () => {
  // The centring itself is one line, and it is only correct in a window whose CSS pixels are
  // DIPs — which is what the pin guarantees. Pinned here so a "simplification" that drops the
  // radius (or starts scaling it) has to be a deliberate edit.
  assert.match(RING, /radius = cfg\.sizePx \/ 2/)
  assert.match(RING, /translate3d\(\$\{Math\.round\(latest\.x - radius\)\}px, \$\{Math\.round\(latest\.y - radius\)\}px, 0\)/)
})
