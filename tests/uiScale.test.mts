// ============================================================================
// uiScale.test.mts — the MAIN window's text size (JOS-123; src/shared/uiScale.ts).
// ============================================================================
//
// Two halves, the same shape as `overlayTextScale.test.mts` one level up:
//
//   1. THE NORMALIZER, which is the whole contract for a value that is optional in the store
//      (every install predates it), renderer-writable, and hand-editable. The case that matters
//      most is the boring one: an ABSENT key must read as 1, because that is the only reason an
//      upgrade leaves every existing user's window exactly as they left it.
//   2. SOURCE PINS for the two claims a unit test structurally cannot observe without a real
//      BrowserWindow — that the scale is part of the main window's CONSTRUCTION (so a launch
//      paints at the chosen size rather than jumping to it), and that it reaches the main window
//      and ONLY the main window (the overlays scale their own content pane instead, and a
//      zoomed overlay window would fight that).
//
// The behaviour that needs a running app — the press changing the window, and the size surviving
// a restart — is `tests/e2e/text-size.e2e.mts`, which does it across two real launches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEPS,
  normalizeUiScale,
  stepUiScale,
  uiScalePercent
} from '../src/shared/uiScale'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// ---- the ladder -------------------------------------------------------------------------

test('the ladder is ascending, unique, and contains the size everyone is already running at', () => {
  assert.ok(UI_SCALE_STEPS.length >= 3, 'a ladder of two is a toggle')
  assert.deepEqual([...UI_SCALE_STEPS], [...UI_SCALE_STEPS].sort((a, b) => a - b), 'ascending')
  assert.equal(new Set(UI_SCALE_STEPS).size, UI_SCALE_STEPS.length, 'no duplicate stops')
  // Without 100% on the ladder there would be no way back to the size the app shipped at.
  assert.ok(UI_SCALE_STEPS.includes(UI_SCALE_DEFAULT), 'the default must be one of the stops')
  assert.equal(UI_SCALE_DEFAULT, 1, 'DEFAULT UNCHANGED: an upgrade must not resize anybody')
  assert.equal(UI_SCALE_MIN, UI_SCALE_STEPS[0])
  assert.equal(UI_SCALE_MAX, UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1])
  // The ticket's range, stated as the range rather than as five literals repeated here.
  assert.equal(UI_SCALE_MIN, 0.9)
  assert.equal(UI_SCALE_MAX, 1.5)
})

test('every stop says itself as a whole percentage', () => {
  // A stop that printed "112.5%" would be a stop that should not be on the ladder.
  for (const step of UI_SCALE_STEPS) {
    assert.match(uiScalePercent(step), /^\d+%$/, `${String(step)} does not read as a whole percent`)
  }
  assert.equal(uiScalePercent(1), '100%')
  assert.equal(uiScalePercent(0.9), '90%')
  assert.equal(uiScalePercent(1.25), '125%')
  assert.equal(uiScalePercent(1.5), '150%')
})

// ---- the normalizer ---------------------------------------------------------------------

test('an absent or malformed scale is the default, not an unreadable window', () => {
  // THE CASE EVERY EXISTING STORE IS IN: the key simply is not there.
  assert.equal(normalizeUiScale(undefined), UI_SCALE_DEFAULT)
  assert.equal(normalizeUiScale(null), UI_SCALE_DEFAULT)
  // …and the cases a hand-edited store or a bad patch can be in. NaN is the one that matters:
  // `zoomFactor: NaN` throws nowhere and is not a size.
  assert.equal(normalizeUiScale(NaN), UI_SCALE_DEFAULT)
  assert.equal(normalizeUiScale(Infinity), UI_SCALE_DEFAULT)
  assert.equal(normalizeUiScale(-Infinity), UI_SCALE_DEFAULT)
  assert.equal(normalizeUiScale('1.5'), UI_SCALE_DEFAULT, 'a string is not a number')
  assert.equal(normalizeUiScale({}), UI_SCALE_DEFAULT)
  assert.equal(normalizeUiScale([1.25]), UI_SCALE_DEFAULT)
})

test('out-of-range values land on the nearest end, never outside it', () => {
  assert.equal(normalizeUiScale(0), UI_SCALE_MIN)
  assert.equal(normalizeUiScale(-3), UI_SCALE_MIN)
  assert.equal(normalizeUiScale(0.5), UI_SCALE_MIN)
  assert.equal(normalizeUiScale(2), UI_SCALE_MAX)
  assert.equal(normalizeUiScale(1000), UI_SCALE_MAX)
})

test('a value between two stops SNAPS, so a button is always lit', () => {
  // The reason it snaps rather than clamps: the control is five buttons, and a stored 1.2 that
  // survived as 1.2 would leave none of them selected while the window sat at a size the card
  // could not name.
  assert.equal(normalizeUiScale(1.19), 1.25)
  assert.equal(normalizeUiScale(1.04), 1)
  assert.equal(normalizeUiScale(1.4), 1.5)
  // The two exact midpoints on this ladder, both resolved DOWNWARD. Stated as cases rather than
  // left to iteration order: "whichever the loop saw first" is a rule that changes when somebody
  // adds a stop.
  assert.equal(normalizeUiScale(0.95), 0.9, 'a tie goes to the smaller stop, deterministically')
  assert.equal(normalizeUiScale(1.175), 1.1, 'and so does the 1.1 / 1.25 midpoint')
})

test('every stop survives itself, and normalizing twice changes nothing', () => {
  for (const step of UI_SCALE_STEPS) {
    assert.equal(normalizeUiScale(step), step, `${String(step)} is not a fixed point`)
    assert.equal(normalizeUiScale(normalizeUiScale(step)), step)
  }
})

// ---- stepping the ladder (JOS-408) --------------------------------------------------------

test('A+ / A− move ONE RUNG, and the rungs are the ladder — not a fixed increment', () => {
  // THE CLAIM THE TICKET MAKES BY NAME: A+ from 110% goes to 125%. A stepper that added a fixed
  // amount would land between two stops, and `normalizeUiScale` would drag it back to one — which
  // reads as a button that sometimes does nothing.
  assert.equal(stepUiScale(1.1, 1), 1.25)
  assert.equal(stepUiScale(1.25, 1), 1.5)
  assert.equal(stepUiScale(1, 1), 1.1)
  assert.equal(stepUiScale(0.9, 1), 1)
  assert.equal(stepUiScale(1.5, -1), 1.25)
  assert.equal(stepUiScale(1.25, -1), 1.1)
  assert.equal(stepUiScale(1, -1), 0.9)
  // Every rung is one press from its neighbours, stated over the whole ladder rather than as the
  // seven cases above — so adding a stop cannot leave this rule half-checked.
  for (let i = 0; i < UI_SCALE_STEPS.length - 1; i++) {
    const here = UI_SCALE_STEPS[i] as number
    const next = UI_SCALE_STEPS[i + 1] as number
    assert.equal(stepUiScale(here, 1), next, `${String(here)} does not step up to ${String(next)}`)
    assert.equal(stepUiScale(next, -1), here, `${String(next)} does not step down to ${String(here)}`)
  }
})

test('the ends are FIXED POINTS, which is the only disabled button on the page', () => {
  // The control disables the button rather than relying on this, but a press that arrived anyway
  // (a keyboard repeat, a test) must not walk out of range or throw.
  assert.equal(stepUiScale(UI_SCALE_MAX, 1), UI_SCALE_MAX)
  assert.equal(stepUiScale(UI_SCALE_MIN, -1), UI_SCALE_MIN)
})

test('an off-ladder or malformed value is SNAPPED before it is stepped', () => {
  // A hand-edited 1.19 snaps to 1.25 and then steps from there, so the answer is always a rung.
  assert.equal(stepUiScale(1.19, 1), 1.5)
  assert.equal(stepUiScale(1.19, -1), 1.1)
  // Not a number at all is the default rung — never a throw, never NaN reaching `zoomFactor`.
  assert.equal(stepUiScale(NaN, 1), 1.1)
  assert.equal(stepUiScale(Number.POSITIVE_INFINITY, -1), 0.9)
  // …and every answer is on the ladder, whatever went in.
  for (const v of [-5, 0, 0.83, 1.07, 3, 1000]) {
    for (const dir of [1, -1] as const) {
      assert.ok(UI_SCALE_STEPS.includes(stepUiScale(v, dir)), `${String(v)} ${String(dir)} left the ladder`)
    }
  }
})

// ---- the store seam ---------------------------------------------------------------------

test('the store normalizes the scale on the way OUT as well as in', () => {
  // The accessors live in their own module because store.ts is AT the 400-code-line ceiling; the
  // key itself still has to be declared in `StoreShape`, or nothing would type it.
  const accessors = src('../src/main/uiScale.ts')
  // Read side: fills the default for the stores (all of them) written before this key existed.
  assert.match(accessors, /return normalizeUiScale\(settingsStore\.get\('uiScale'\)\)/)
  // Write side: the value comes from a renderer, so the handler is not where it is decided.
  assert.match(
    accessors,
    /const next = normalizeUiScale\(value\)\s*\n\s*settingsStore\.set\('uiScale', next\)/
  )
  // Multiline-anchored rather than newline-wrapped: this tree is checked out with CRLF endings.
  // `StoreShape` moved to its own module in JOS-140 (store.ts hit the 400-code-line ceiling); the
  // claim is unchanged — the key has to be DECLARED somewhere, or nothing would type it.
  assert.match(src('../src/main/storeShape.ts'), /^ {2}uiScale\?: number$/m, 'the key must be in StoreShape')
})

test('NO SCHEMA BUMP: an additive optional key needs no migration, and must not get one', () => {
  // The law is "any commit that changes a persisted SHAPE ships a migration in the same commit",
  // and the carve-out this key takes is the one store.ts already documents for
  // `lastSeenNotesVersion` / `eqDiscoveredRoot`: every reader defaults on a missing key and
  // electron-store rewrites the whole parsed object, so a store written by an older build loads
  // here unchanged and one written here still opens in a build that predates the feature. A
  // migration step touching `uiScale` would be claiming a conversion that has nothing to convert.
  assert.doesNotMatch(src('../src/main/storeMigrations.ts'), /uiScale/)
})

// ---- the window seam --------------------------------------------------------------------

test('the scale is part of the main window CONSTRUCTION, so a launch never jumps', () => {
  const win = src('../src/main/windows.ts')
  // `webPreferences.zoomFactor` is applied before the first paint. Calling setZoomFactor after
  // the page loads would show the user a window resizing its own contents on every launch.
  assert.match(win, /zoomFactor: getUiScale\(\)/, 'the main window must be built at the stored size')
  const prefs = /webPreferences: \{\s*\n\s*\.\.\.WEB_PREFERENCES\(join\(__dirname, '\.\.\/preload\/index\.js'\)\)/
  assert.match(win, prefs, 'and the shared security posture must be spread in whole, not re-typed')
})

test('ONLY the main window is zoomed — the overlays scale their own content pane', () => {
  const win = src('../src/main/windows.ts')
  // Everything from the overlay factory onward: the overlay windows and the cursor ring. A
  // zoomFactor there would double up with the per-kind `textScale` CSS zoom (overlayScale.tsx)
  // and grow the chrome the overlay deliberately leaves alone.
  const accessories = win.slice(win.indexOf('export function createOverlayWindow'))
  assert.ok(accessories.length > 0, 'the overlay factory moved; this pin needs re-aiming')
  assert.doesNotMatch(accessories, /zoomFactor/, 'no accessory window may carry a zoom factor')
})

test('the setter changes the window in the SAME call that stores it', () => {
  // A size control you have to relaunch to evaluate cannot be evaluated. The handler stores,
  // then applies what was stored (not what was requested — the normalizer may have snapped it).
  const ipc = src('../src/main/ipc/uiScale.ts')
  const applyNow = /const next = setUiScale\(value\)\s*\n\s*applyMainWindowScale\(next\)/
  assert.match(ipc, applyNow, 'the uiScale:set handler must apply the stored value immediately')
  const win = src('../src/main/windows.ts')
  assert.match(
    win,
    /export function applyMainWindowScale\(scale: number\): void \{\s*\n\s*getMainWindow\(\)\?\.webContents\.setZoomFactor\(scale\)/,
    'and the BrowserWindow call stays inside windows.ts, like every other push'
  )
})

test('the renderer neither zooms nor clamps on its own', () => {
  const card = src('../src/renderer/src/features/preferences/TextSizeSetting.tsx')
  // ONE thing decides how big this window is, and it is main. A renderer-side zoom would paint at
  // 100% first on every launch and then correct itself.
  assert.doesNotMatch(card, /webFrame|document\.body\.style\.zoom/)
  // …and the card steps the shared ladder rather than carrying a second copy of it. The five
  // buttons became one A− / A+ in JOS-408; what did not change is where the rungs come from.
  assert.match(card, /stepUiScale\(scale, dir\)/, 'the press must walk the shared ladder')
  assert.doesNotMatch(card, /scale [-+] |\* 0\.1/, 'and never by an increment of its own')
  assert.match(card, /window\.eq\.setUiScale/, 'and the press must go through the bridge')
})

test('the in-app card is ONE STEPPER, and its ends are the ladder’s own (JOS-408)', () => {
  const card = src('../src/renderer/src/features/preferences/TextSizeSetting.tsx')
  // The uniform control the owner asked for: the same component the overlays' rows use, so the
  // whole Appearance page is one interaction model rather than three.
  assert.match(card, /<PrefStepper/, 'the in-app size is the page’s one stepper')
  assert.doesNotMatch(card, /ToggleButtonGroup|ToggleButton/, 'the five-button ladder is gone')
  // Disabled ONLY at the clamps, and named from the shared ladder rather than typed here.
  assert.match(card, /atMin=\{scale <= UI_SCALE_MIN\}/)
  assert.match(card, /atMax=\{scale >= UI_SCALE_MAX\}/)
  // The testid the deep links and the e2e steps address, kept across the control swap.
  assert.match(card, /testid="pref-text-size"/)
})

test('the section is called Appearance, and its id is NOT renamed with it', () => {
  const card = src('../src/renderer/src/features/preferences/TextSizeSetting.tsx')
  // The label is the owner's (2026-08-17). The id is what the rail testid, the deep link and every
  // e2e step address the section by — renaming an id to match a label is how a working route
  // breaks for a cosmetic reason.
  assert.match(card, /id: 'textsize'/, 'the section id must not move')
  assert.match(card, /label: 'Appearance'/)
  assert.match(card, /label: 'In-app text size'/, 'the first item is about the app window only')
  // …and the overlays are ONE item, not three.
  const items = card.match(/^ {6}\{$/gm) ?? []
  assert.equal(items.length, 2, 'the section carries exactly two items')
  assert.match(card, /<OverlaysAppearanceSetting \/>/)
  const view = src('../src/renderer/src/features/preferences/PreferencesView.tsx')
  assert.match(view, /appearanceSection\(\)/, 'and the pane builds it under that name')
})
