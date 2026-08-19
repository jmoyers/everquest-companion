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
// The JOS-405 half — the preference, the one rule, and the upgrade. Imported from its own module
// rather than through `shared/types`: that file is at its factoring ceiling and does not re-export
// these (the four numbers and the clamp above are grandfathered).
import {
  DEFAULT_OVERLAY_TEXT_SIZE,
  deriveSharedTextScale,
  effectiveOverlayTextScale,
  mergeOverlayTextSize,
  normalizeOverlayTextSize,
  storedSharedTextScale
} from '../src/shared/overlayTextScale'

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

test('ONE SCALE FOR EVERY OVERLAY IS NOW A ROUTE, NOT A FAN-OUT (JOS-405)', () => {
  // The 2026-08-05 rule (scaling the fight meter and watching the overall meter not move reads as
  // broken) was implemented by WRITING all twelve per-kind fields on every press. That flattens
  // the twelve values, so the moment somebody asks for them apart there is nothing to go back to.
  // The rule is now the DEFAULT of a switch: while synced the press moves the SHARED preference
  // and touches no kind, and every open window is pushed the new prefs.
  const ipc = src('../src/main/ipc/windowControls.ts')
  // JOS-407 gave `bgAlpha` the same two modes, so the routing moved into one function that lifts
  // whichever shared field the patch names out of it. The CLAIM is unchanged and is still spelled
  // here as source: the test, the setter and the broadcast, in that order.
  assert.match(
    ipc,
    /if \(p\.textScale !== undefined && !getOverlayTextSize\(\)\.independent\) \{[\s\S]*?broadcastOverlayTextSize\(setOverlayTextSize\(\{ shared: p\.textScale \}\)\)/,
    'a synced textScale write routes to the shared preference and broadcasts it'
  )
  // THE FAN-OUT IS GONE, and its absence is the claim: a loop that still wrote every kind would
  // keep destroying the per-kind values this feature exists to preserve.
  assert.doesNotMatch(ipc, /setOverlayConfig\(k, k === kind/, 'the fan-out write is gone')
  // …and the only remaining loop over the kinds SENDS: it tells twelve windows about one value
  // rather than writing one value into twelve places. (`setOverlayConfig(k` would also match
  // `setOverlayConfig(kind`, which is why this is spelled as what the loop body IS.)
  const loops = ipc.match(/for \(const k of OVERLAY_KINDS\) \{[\s\S]*?\n {2}\}/g) ?? []
  assert.ok(loops.length > 0, 'the broadcast loop is there to check')
  for (const body of loops) {
    assert.doesNotMatch(body, /setOverlayConfig\(/, 'a per-kind loop may read and send, never write')
  }
  // …and the independent path is the ordinary per-kind write the field's own shape always said
  // it was: this kind stored, this window echoed. `rest` is the patch minus whatever was routed
  // away above, which for an independent press is the whole of it.
  assert.match(ipc, /const next = setOverlayConfig\(kind, rest\)/)
})

test('THE BROADCAST REACHES A PINNED WINDOW, which has no control of its own to press', () => {
  const ipc = src('../src/main/ipc/windowControls.ts')
  // Every OPEN overlay window plus the app window. A locked overlay draws no chrome, so every
  // size change it obeys was made somewhere else — this send is the only way it hears about one.
  assert.match(
    ipc,
    /function broadcastOverlayTextSize[\s\S]*?for \(const k of OVERLAY_KINDS\) \{[\s\S]*?send\(IPC\.onOverlayTextSize, prefs\)[\s\S]*?getMainWindow\(\)/,
    'the prefs go to every open overlay window and to the app window'
  )
  // The WRITE handler always broadcasts, including the `independent` flip that carries no number:
  // turning the switch off is what puts every window back on the shared size.
  assert.match(
    ipc,
    /overlayTextSizeSet[\s\S]*?const prefs = setOverlayTextSize\(patch\)\s*\n\s*broadcastOverlayTextSize\(prefs\)/
  )
})

// ---- the preference: one size, or twelve (JOS-405) ---------------------------------------

test('the prefs normalizer defaults every field, from any garbage', () => {
  // The store key is absent on every install that predates the feature, and hand-editable after.
  assert.deepEqual(normalizeOverlayTextSize(undefined), DEFAULT_OVERLAY_TEXT_SIZE)
  assert.deepEqual(normalizeOverlayTextSize(null), DEFAULT_OVERLAY_TEXT_SIZE)
  assert.deepEqual(normalizeOverlayTextSize('nonsense'), DEFAULT_OVERLAY_TEXT_SIZE)
  assert.deepEqual(normalizeOverlayTextSize({}), DEFAULT_OVERLAY_TEXT_SIZE)
  // OFF SHIPS, and only a literal `true` is on — a truthy string from a hand-edited file is not
  // an opt-in to a mode that changes what twelve windows do.
  assert.equal(normalizeOverlayTextSize({ independent: 'yes' }).independent, false)
  assert.equal(normalizeOverlayTextSize({ independent: true }).independent, true)
  // The shared size is clamped by the same function every other scale in this file is.
  assert.equal(normalizeOverlayTextSize({ shared: 99 }).shared, TEXT_SCALE_MAX)
  assert.equal(normalizeOverlayTextSize({ shared: 1.35 }).shared, 1.35)
})

test('a patch that names one field keeps the other — a switch flip cannot reset the size', () => {
  const base = { shared: 1.5, independent: false, seeded: false }
  assert.deepEqual(mergeOverlayTextSize({ independent: true }, base), { ...base, independent: true })
  assert.deepEqual(mergeOverlayTextSize({ shared: 1.2 }, base), { ...base, shared: 1.2 })
  assert.deepEqual(mergeOverlayTextSize({}, base), base)
  // A wrong-typed field is the same as an absent one: it names nothing this base should give up.
  assert.deepEqual(mergeOverlayTextSize({ shared: 'big', independent: 1 }, base), base)
  // With no base at all it is a normalize, which is what makes it one door for a renderer, a
  // hand-edited file and the store reader.
  assert.deepEqual(mergeOverlayTextSize({ shared: 1.4 }), { shared: 1.4, independent: false, seeded: false })
})

test('the once-ever seed flag is ONE-WAY — a renderer cannot ask to be re-seeded', () => {
  // It is bookkeeping, not a setting: nothing on the bridge sends it and nothing in Preferences
  // reads it. A hand-edited `false` over a stored `true` would re-seed twelve windows from a value
  // their owner had already moved away from — i.e. it would break the one rule the flag protects.
  const seeded = { shared: 1.2, independent: true, seeded: true }
  assert.equal(mergeOverlayTextSize({ seeded: false }, seeded).seeded, true)
  assert.equal(mergeOverlayTextSize({ independent: false }, seeded).seeded, true, 'and it outlives syncing again')
  assert.equal(mergeOverlayTextSize({ seeded: true }, { shared: 1, independent: false, seeded: false }).seeded, true)
})

test('OPTING IN RESIZES NOTHING, once ever — and the flag is what makes it once', () => {
  // The measurement behind this is in tests/e2e/text-size.e2e.mts: on a store written entirely
  // under sync, nothing has ever written a per-kind value, so the first flip to independent found
  // twelve defaults and snapped every window back to 100%. The seed is keyed on the FLAG rather
  // than on a value being absent, because `setOverlayConfig` merges over `getOverlayConfig` and
  // therefore stamps a `textScale` onto any kind that has ever been dragged or locked.
  const store = src('../src/main/storeOverlayTextSize.ts')
  assert.match(
    store,
    /if \(next\.independent && cur\.seeded !== true\) \{\s*\n\s*seedOnFirstOptIn\(cur\.shared\)\s*\n\s*next\.seeded = true/,
    'the first opt-in seeds from the shared size and records that it happened'
  )
  assert.match(store, /for \(const kind of OVERLAY_KINDS\) setOverlayConfig\(kind, \{ textScale: shared \}\)/)
  // AND IT IS NOT THE FAN-OUT COMING BACK: the retired one wrote twelve kinds on every PRESS,
  // which is what flattened the values and left nothing to unsync to. This is one opt-in.
  assert.doesNotMatch(store, /textScale: p\.textScale/, 'no press path writes a per-kind value here')
})

test('THE EFFECTIVE SCALE IS THE WHOLE RULE: independent ? per-kind : shared', () => {
  const synced = { shared: 1.5, independent: false }
  const apart = { shared: 1.5, independent: true }
  // Synced: the per-kind value is not consulted AT ALL — which is the same sentence as "the
  // per-kind values survive being synced", written as code rather than promised in a comment.
  assert.equal(effectiveOverlayTextScale(synced, 0.8), 1.5)
  assert.equal(effectiveOverlayTextScale(synced, undefined), 1.5)
  assert.equal(effectiveOverlayTextScale(synced, NaN), 1.5)
  // Independent: this kind's own value, and the shared one is what is now ignored.
  assert.equal(effectiveOverlayTextScale(apart, 0.8), 0.8)
  assert.equal(effectiveOverlayTextScale(apart, 1.9), 1.9)
  // A kind that never had one is the ordinary default, not the shared size: it is a window with
  // no opinion, and the switch says opinions are what count now.
  assert.equal(effectiveOverlayTextScale(apart, undefined), TEXT_SCALE_DEFAULT)
  // Out of range from either mode is still clamped — the value reaches a CSS `zoom`.
  assert.equal(effectiveOverlayTextScale({ shared: 9, independent: false }, 1), TEXT_SCALE_MAX)
  assert.equal(effectiveOverlayTextScale(apart, 9), TEXT_SCALE_MAX)
})

test('SURVIVING THE SWITCH is a property of the rule, not of a code path', () => {
  // The JOS-168 precedent, checked the only way a pure function can express it: a kind's stored
  // value is untouched by anything this module does, so the SAME number is what independent mode
  // reads back after any amount of time spent synced.
  const remembered = 1.5
  const synced = { shared: 1, independent: false }
  assert.equal(effectiveOverlayTextScale(synced, remembered), 1, 'synced draws the shared size')
  assert.equal(
    effectiveOverlayTextScale({ ...synced, independent: true }, remembered),
    remembered,
    'and unsyncing finds 150% exactly where its owner left it'
  )
})

// ---- the migration: what one size should be, read off the twelve that exist ----------------

test('an absent shared size is TOLD APART from a stored 100%', () => {
  // This is the whole migration signal, and 1.0 is also a perfectly ordinary answer — so the
  // absence has to survive the read rather than being normalized into a default.
  assert.equal(storedSharedTextScale(undefined), null)
  assert.equal(storedSharedTextScale({}), null)
  assert.equal(storedSharedTextScale({ independent: true }), null)
  assert.equal(storedSharedTextScale({ shared: 'big' }), null)
  assert.equal(storedSharedTextScale({ shared: NaN }), null)
  assert.equal(storedSharedTextScale({ shared: 1 }), 1, 'a stored 100% is an ANSWER, not an absence')
  assert.equal(storedSharedTextScale({ shared: 1.3 }), 1.3)
})

test('the upgrade derives the shared size from the twelve equal per-kind values', () => {
  // EVERY install through 1.4.0 is this case, because the old setter wrote all twelve on every
  // press. So the acceptance criterion — nothing changes size on the first launch after the
  // update — is exact rather than approximate.
  assert.equal(deriveSharedTextScale(Array<number>(12).fill(1.3)), 1.3)
  assert.equal(deriveSharedTextScale(Array<number>(12).fill(1)), 1)
})

test('…the MOST COMMON value wins, and a TIE goes to the LARGER', () => {
  // A store that is not so tidy (hand-edited, or a downgrade-then-upgrade). Most common:
  assert.equal(deriveSharedTextScale([1, 1, 1, 1.5]), 1)
  assert.equal(deriveSharedTextScale([1.5, 1.5, 1.5, 1]), 1.5)
  // Ties to the larger, in both orders, because the whole ask behind this feature is bigger text
  // and a coin-flip that lands small is the one outcome nobody wanted.
  assert.equal(deriveSharedTextScale([1.2, 1.2, 1.5, 1.5]), 1.5)
  assert.equal(deriveSharedTextScale([1.5, 1.5, 1.2, 1.2]), 1.5)
  // Anything that is not a finite number is not a vote — a kind whose config predates the field.
  assert.equal(deriveSharedTextScale([undefined, null, 'x', 1.4, 1.4]), 1.4)
  assert.equal(deriveSharedTextScale([9, 9]), TEXT_SCALE_MAX, 'and a vote is clamped before it counts')
})

test('…and an EMPTY store derives NOTHING: a fresh install is the default', () => {
  // Deriving from an empty list is how a fresh install would come up at somebody else's size.
  assert.equal(deriveSharedTextScale([]), TEXT_SCALE_DEFAULT)
  assert.equal(deriveSharedTextScale([undefined, undefined]), TEXT_SCALE_DEFAULT)
})

test('the derivation is WRITTEN BACK, so it happens once', () => {
  // A migration rather than a computation: the derived answer becomes the stored one on the first
  // read after the update, and every later launch takes the short path.
  const store = src('../src/main/storeOverlayTextSize.ts')
  assert.match(
    store,
    /if \(storedSharedTextScale\(raw\) !== null\) return normalizeOverlayTextSize\(raw\)[\s\S]*?settingsStore\.set\('overlayTextSize', next\)/,
    'an absent shared size derives and persists; a present one is read straight back'
  )
  assert.match(store, /deriveSharedTextScale\(Object\.values\(all\)\.map\(\(cfg\) => cfg\?\.textScale\)\)/,
    'and it derives from the per-kind values, which is the only place the answer exists')
})

// ---- who reads the rule -------------------------------------------------------------------

test('EXACTLY ONE function decides what a window draws at, and every surface asks it', () => {
  // The chrome hook resolves it for all twelve windows (its callers are unchanged by the switch
  // existing), and Preferences' rows resolve it the same way so a disabled row cannot state a
  // different number from the window beside it.
  const chrome = code('../src/renderer/src/overlay/useOverlayChrome.ts')
  assert.match(chrome, /effectiveOverlayTextScale\(textSize, cfg\?\.textScale\)/)
  // The twelve-row list moved to its own file in JOS-407 (each row carries a size AND a
  // transparency, so it belongs to neither setting alone) and then INTO the one Overlays card in
  // JOS-408, which also owns the single switch both halves now read.
  const rows = code('../src/renderer/src/features/preferences/OverlaysAppearanceSetting.tsx')
  assert.match(rows, /effectiveOverlayTextScale\(size, scales\[kind\]\)/)
  // …and nobody re-derives it with a ternary of their own.
  for (const path of [...Object.values(SURFACES), FLOOR, SCALE]) {
    assert.doesNotMatch(code(path), /independent\s*\?/, `${path} decides the rule for itself`)
  }
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
