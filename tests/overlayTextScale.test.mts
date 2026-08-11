// PER-OVERLAY TEXT SIZE (owner feedback, 2026-08-05: "text size scaling for overlays. we are old
// folks now.").
//
// Two halves, both cheap and neither skippable:
//
//   1. `clampTextScale` — the pure normalizer the store runs on the way IN and on the way OUT.
//      It is the whole contract for a field that is optional in the store (every install
//      predates it), renderer-writable, and hand-editable.
//   2. SOURCE PINS for the rendering rule, which cannot be observed without a real transparent
//      always-on-top window: the scale is a CSS `zoom` applied in exactly ONE place — the CONTENT
//      pane — and the two things a zoomed subtree breaks (viewport units, and measure-then-place
//      coordinates) are answered everywhere they occur. The same idiom (and reason) as
//      `overlayLockedSelector.test.mts`.
//
// WHY THE CONTENT PANE AND NOT THE WINDOW ROOT (owner feedback, second round: "currently it just
// pushes the content out of the window which is undesirable"). The first cut zoomed
// #overlay-root, so the header and footer grew with the bars and at 2.0 on a narrow overlay the
// A− that would undo it was off the right edge. Chrome now lays out at scale 1 against the real
// window and wraps; only the reading matter scales, and what does not fit scrolls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TEXT_SCALE_DEFAULT,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  clampTextScale
} from '../src/shared/types'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** The same file with its COMMENTS removed. Every rule pinned below is written out in prose
 *  directly above the line that obeys it — `100vw` in a comment saying not to use `100vw` must
 *  not read as a violation. */
const code = (rel: string): string =>
  src(rel)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every surface that mounts into #overlay-root: chrome plus the content pane the zoom goes on. */
const SURFACES = {
  'the damage meter': '../src/renderer/src/overlay/OverlayMeter.tsx',
  'the healing meter': '../src/renderer/src/overlay/HealMeter.tsx',
  'the event log': '../src/renderer/src/overlay/EventLogOverlay.tsx',
  'the celebration toast': '../src/renderer/src/overlay/ToastOverlay.tsx',
  'the buff timers': '../src/renderer/src/overlay/BuffsOverlay.tsx'
}

/** The one file that applies the scale. */
const SCALE = '../src/renderer/src/overlay/overlayScale.tsx'

/**
 * The two meters' shared body wrapper (JOS-121): the scrolling pane plus the scope watermark on
 * its floor. It is BETWEEN a meter and `OverlayContent` now, so it is the file that must forward
 * the scale rather than re-apply it — and the watermark it adds is chrome, deliberately outside
 * the zoom (a watermark that grew with the reading matter would be the loudest thing at 2.0).
 */
const FLOOR = '../src/renderer/src/overlay/scopeFloor.tsx'

// ---- the normalizer ---------------------------------------------------------------------

test('an absent or malformed scale is the default, not a broken window', () => {
  // The case every existing store is in: the key simply is not there.
  assert.equal(clampTextScale(undefined), TEXT_SCALE_DEFAULT)
  assert.equal(clampTextScale(null), TEXT_SCALE_DEFAULT)
  // …and the cases a hand-edited store or a bad patch can be in. NaN is the one that matters:
  // `zoom: NaN` is not an error anywhere, it is an invisible overlay.
  assert.equal(clampTextScale(NaN), TEXT_SCALE_DEFAULT)
  assert.equal(clampTextScale(Infinity), TEXT_SCALE_DEFAULT)
  assert.equal(clampTextScale('1.5'), TEXT_SCALE_DEFAULT)
  assert.equal(clampTextScale({}), TEXT_SCALE_DEFAULT)
})

test('out-of-range values are clamped at both ends', () => {
  assert.equal(clampTextScale(0), TEXT_SCALE_MIN)
  assert.equal(clampTextScale(0.5), TEXT_SCALE_MIN)
  assert.equal(clampTextScale(-3), TEXT_SCALE_MIN)
  assert.equal(clampTextScale(2.5), TEXT_SCALE_MAX)
  assert.equal(clampTextScale(1000), TEXT_SCALE_MAX)
  // The ends themselves are legal — a clamp that excluded them would make the stepper's last
  // press a no-op that still wrote to the store.
  assert.equal(clampTextScale(TEXT_SCALE_MIN), TEXT_SCALE_MIN)
  assert.equal(clampTextScale(TEXT_SCALE_MAX), TEXT_SCALE_MAX)
})

test('in-range values survive, and float dust does not accumulate', () => {
  assert.equal(clampTextScale(1), 1)
  assert.equal(clampTextScale(1.35), 1.35)
  // 0.1 steps off a float: without the round, a few presses persist 1.2000000000000002 and the
  // stepper's tooltip prints the dust back at the user.
  let v = TEXT_SCALE_DEFAULT
  for (let i = 0; i < 4; i++) v = clampTextScale(v + TEXT_SCALE_STEP)
  assert.equal(v, 1.4)
  for (let i = 0; i < 8; i++) v = clampTextScale(v - TEXT_SCALE_STEP)
  assert.equal(v, TEXT_SCALE_MIN, 'walking down past the floor stops AT the floor')
})

test('stepping cannot walk out of range from either end', () => {
  let up = TEXT_SCALE_DEFAULT
  for (let i = 0; i < 50; i++) up = clampTextScale(up + TEXT_SCALE_STEP)
  assert.equal(up, TEXT_SCALE_MAX)
  let down = TEXT_SCALE_DEFAULT
  for (let i = 0; i < 50; i++) down = clampTextScale(down - TEXT_SCALE_STEP)
  assert.equal(down, TEXT_SCALE_MIN)
})

// ---- the store seam ---------------------------------------------------------------------

test('the store clamps the scale on the way OUT as well as in', () => {
  const store = src('../src/main/store.ts')
  // Read side: `getOverlayConfig` fills the default for the stores (all of them) written before
  // this field existed.
  assert.match(store, /cfg\.textScale = clampTextScale\(cfg\.textScale\)/)
  // Write side: the value comes from a renderer, like the bgAlpha beside it.
  assert.match(store, /next\.textScale = clampTextScale\(next\.textScale\)/)
})

test('NO NEW CHANNEL: the scale rides the existing per-kind overlay config', () => {
  const stepper = src('../src/renderer/src/overlay/TextScaleStepper.tsx')
  assert.match(stepper, /patch\(\{ textScale:/, 'the stepper writes through the config patch')
  assert.doesNotMatch(stepper, /ipcRenderer|window\.eqOverlay\./, 'and reaches for no channel of its own')
})

test('ONE SCALE FOR EVERY OVERLAY: a textScale patch fans out to all kinds (owner, 2026-08-05)', () => {
  // Scaling the fight meter and watching the overall meter not move reads as broken. The field
  // still lives per kind; the ONE setter every patch walks through is where the value becomes
  // shared — each kind written, each open window echoed.
  const ipc = src('../src/main/ipc/windowControls.ts')
  const fanout = /if \(p\.textScale !== undefined\) \{[\s\S]*?for \(const k of OVERLAY_KINDS\) \{[\s\S]*?setOverlayConfig\(k, k === kind \? p : \{ textScale: p\.textScale \}\)[\s\S]*?send\(IPC\.onOverlayConfig/
  assert.match(ipc, fanout, 'the overlaySetConfig handler fans a textScale write out to every kind and echoes every window')
})

// ---- the rendering rule -----------------------------------------------------------------

test('the zoom is applied in exactly ONE place: the content pane', () => {
  const scale = code(SCALE)
  assert.match(scale, /zoom: textScale/, 'overlayScale must be the file that applies it')
  // `zoom` participates in layout; `transform: scale()` would magnify a bitmap over the pane's
  // own edges and leave the scroll box measuring the old size.
  assert.doesNotMatch(scale, /transform:\s*`?scale/)
  // Nowhere else — including the hook, which used to set it imperatively on #overlay-root and is
  // exactly the placement this round moved.
  const chrome = code('../src/renderer/src/overlay/useOverlayChrome.ts')
  assert.doesNotMatch(chrome, /zoom/, 'the chrome hook remembers the scale and applies none of it')
  for (const [name, path] of Object.entries(SURFACES)) {
    assert.doesNotMatch(code(path), /zoom:/, `${name} must not grow a second copy of the zoom`)
  }
  // …including the meters' shared body wrapper, which forwards the scale and applies none of it.
  const floor = code(FLOOR)
  assert.doesNotMatch(floor, /zoom:/, 'the meter pane must not grow a second copy of the zoom')
  assert.match(floor, /<OverlayContent textScale=\{textScale\}/, 'the meter pane must forward the scale')
})

test('THE CHROME IS NEVER SCALED, and cannot be pushed out of a narrow window', () => {
  // The scale reaches the rows through the content component and nothing else, so the header and
  // footer keep laying out against the real window width at every scale.
  // `MeterPane` (JOS-121) is the damage/heal pair's wrapper around OverlayContent — one more name
  // for the same seam, and the assertion above pins that it forwards rather than re-applies.
  for (const [name, path] of Object.entries(SURFACES)) {
    assert.match(
      code(path),
      /<(OverlayContent|ScaledContent|MeterPane)\s+textScale=/,
      `${name} scales no content`
    )
  }
  // …and the footers themselves fit a genuinely narrow window, zoom or no zoom. ONE ROW: the
  // range input is the give (`flexBasis: 0` + a small floor), the buttons never shrink — the
  // owner's report was an A+ clipped mid-glyph, i.e. the control that fixes it, unpressable.
  for (const path of [
    SURFACES['the damage meter'],
    SURFACES['the healing meter'],
    SURFACES['the event log'],
    SURFACES['the buff timers']
  ]) {
    const text = code(path)
    assert.match(
      text,
      /flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 24/,
      `${path} has a slider that does not give up its width`
    )
    assert.doesNotMatch(text, /flexWrap/, `${path} folds its compact chrome onto a second row`)
  }
  const stepper = code('../src/renderer/src/overlay/TextScaleStepper.tsx')
  assert.match(stepper, /flexShrink: 0/, 'A− / A+ must never be the thing that shrinks')
})

test('the content pane scrolls, and no surface hides rows to avoid it', () => {
  // The retired top-5/top-10 budget (owner feedback 2026-08-05: "we should just allow as many as
  // needed and scroll"). Every row renders; the pane is what deals with not fitting.
  assert.match(code(SCALE), /overflowY: 'auto'/, 'the content pane must scroll')
  for (const path of [
    ...Object.values(SURFACES),
    '../src/renderer/src/overlay/meterBars.tsx',
    '../src/renderer/src/overlay/healBars.tsx'
  ]) {
    assert.doesNotMatch(code(path), /topN/, `${path} still carries a row budget`)
  }
  // The level-1 damage list is the one that used to be sliced.
  assert.doesNotMatch(code('../src/renderer/src/overlay/meterBars.tsx'), /sources\.slice\(/)
})

test('nothing under the zoom sizes itself in viewport units', () => {
  // A viewport unit resolves against the window and is THEN scaled, so `100vw` at 1.5 is half a
  // screen wider than the pane it is supposed to fill. Percentages resolve against the parent and
  // fill it at any scale — which is why overlay.html sizes html/body too.
  for (const [name, path] of Object.entries({ ...SURFACES, 'the meter pane': FLOOR })) {
    assert.doesNotMatch(code(path), /100vw|100vh/, `${name} still sizes itself in viewport units`)
  }
  const html = code('../src/renderer/overlay.html')
  assert.doesNotMatch(html, /100vw|100vh/)
  assert.match(html, /#overlay-root \{\s*width: 100%;\s*height: 100%;/)
})

test('ONE fixed layer converts between visual and zoomed pixels — the one inside the pane', () => {
  // getBoundingClientRect reports visual pixels; a pixel written back into top/left inside the
  // zoomed pane is multiplied again. The feed's hover card is anchored to a CONTENT row, so it
  // divides exactly once.
  const card = code('../src/renderer/src/overlay/hoverCardLayer.tsx')
  assert.match(card, /overlayCssZoom\(/, 'the hover card must ask what scale it is drawn at')
  assert.doesNotMatch(card, /calc\(100v[wh]/, 'and must not clamp itself with viewport units')
  // The selector popup hangs off the HEADER, which is unscaled chrome: one coordinate space, so
  // a conversion there would now be the bug.
  const popup = code('../src/renderer/src/overlay/OverlaySelect.tsx')
  assert.doesNotMatch(popup, /overlayCssZoom|\/ z\b/, 'the popup measures and places in one space')
  assert.doesNotMatch(popup, /calc\(100v[wh]/)
})

test('every overlay kind can reach the control', () => {
  // The meters and the event log put it in their footer; the toast has neither header nor footer,
  // so it lives in the drag frame that IS its interactive chrome.
  for (const [name, path] of Object.entries(SURFACES)) {
    assert.match(src(path), /<TextScaleStepper/, `${name} offers no text size control`)
  }
})
