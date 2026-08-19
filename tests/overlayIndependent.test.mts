// ============================================================================
// overlayIndependent.test.mts — ONE SWITCH OVER TWO STORED FLAGS (JOS-408).
// ============================================================================
//
// WHAT THIS IS ABOUT. JOS-405 gave the overlays' text size a shared/independent switch and JOS-407
// gave their transparency one of its own. The owner's 2026-08-17 review collapsed the two controls
// into ONE — they are about the same twelve windows — while deliberately keeping both stored flags,
// both stores and both migrations, which are how the values actually travel.
//
// SO THE FLAGS CAN DISAGREE, AND ON MOST REAL INSTALLS THEY DO. JOS-407's least-harm migration came
// up INDEPENDENT wherever the twelve stored `bgAlpha` values differed — which is the ordinary shape
// of a used store, because nothing ever fanned that field out — while the text size's migration
// found twelve equal values and came up SYNCED. `{ text: false, bg: true }` is a state one switch
// cannot draw, so main reconciles it once, at startup, before any window has read either flag.
//
// WHY THE IO IS INJECTED. The rule has to be watched END TO END — including the SEED that a
// `false -> true` write triggers, which is the entire reason the reconcile is harmless — and the
// real setters live behind electron-store. `shared/overlayIndependent.ts` therefore takes three
// operations rather than importing two modules, and the fake below models the one thing that
// matters about the real setters: `setOverlayTextSize({ independent: true })` seeds every kind from
// the in-force shared size the first time, so nothing on screen changes.
//
// The seed's own mechanism (`seedOnFirstOptIn`, once-ever, every kind) is pinned as source in
// tests/overlayTextScale.test.mts and tests/overlayBgAlpha.test.mts; what is pinned HERE is that
// the reconcile goes through the door that runs it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  overlayIndependent,
  reconcileOverlayIndependent,
  setOverlayIndependent,
  type IndependentIo
} from '../src/shared/overlayIndependent'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** The same file with its COMMENTS stripped — `tests/overlayTextScale.test.mts`'s helper, needed
 *  here for its reason: every absence pinned below is stated in prose directly above the code that
 *  obeys it, and a comment saying "never a raw settingsStore write" must not read as one. */
const code = (rel: string): string =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * The two stores, faked — with the one behaviour that makes the reconcile safe.
 *
 * `seededText` / `seededBg` flip the first time that feature is turned ON, exactly as
 * `storeOverlayTextSize.ts` / `storeOverlayBgAlpha.ts` do, and `writes` records the order so a test
 * can say which door was opened as well as what ended up stored.
 */
function fakeStores(text: boolean, bg: boolean, alreadySeeded = { text: false, bg: false }): {
  io: IndependentIo
  state: () => { text: boolean; bg: boolean; seededText: boolean; seededBg: boolean }
  writes: string[]
} {
  let t = text
  let b = bg
  let seededText = alreadySeeded.text
  let seededBg = alreadySeeded.bg
  const writes: string[] = []
  const io: IndependentIo = {
    read: () => ({ text: t, bg: b }),
    setText: (on) => {
      writes.push(`text=${String(on)}`)
      // The real setter's rule: opting in seeds every kind from the in-force shared value, ONCE.
      if (on && !seededText) seededText = true
      t = on
    },
    setBg: (on) => {
      writes.push(`bg=${String(on)}`)
      if (on && !seededBg) seededBg = true
      b = on
    }
  }
  return { io, state: () => ({ text: t, bg: b, seededText, seededBg }), writes }
}

// ---- the derived boolean the page draws ----------------------------------------------------

test('the page reads ONE boolean, and either flag being on is enough', () => {
  assert.equal(overlayIndependent({ text: false, bg: false }), false)
  assert.equal(overlayIndependent({ text: true, bg: true }), true)
  // The pre-reconcile states. It answers TRUE, which is the honest reading: something per-kind IS
  // being obeyed, and the page has to show the values that are in force rather than hide them.
  assert.equal(overlayIndependent({ text: true, bg: false }), true)
  assert.equal(overlayIndependent({ text: false, bg: true }), true)
})

// ---- the reconcile, all four states --------------------------------------------------------

test('(false, false) STAYS — a tidy install is not touched at all', () => {
  const { io, state, writes } = fakeStores(false, false)
  assert.equal(reconcileOverlayIndependent(io), false, 'it must not report a write it did not make')
  assert.deepEqual(writes, [], 'and it must not write')
  assert.deepEqual(state(), { text: false, bg: false, seededText: false, seededBg: false })
})

test('(true, true) STAYS — an install that already opted into both is not touched either', () => {
  const { io, state, writes } = fakeStores(true, true, { text: true, bg: true })
  assert.equal(reconcileOverlayIndependent(io), false)
  assert.deepEqual(writes, [])
  assert.deepEqual(state(), { text: true, bg: true, seededText: true, seededBg: true })
})

test('(false, true) -> (true, true), AND THE SEED RUNS — the common upgrade, harmless', () => {
  // The state JOS-407's least-harm migration left on most real installs: transparency independent
  // because its twelve values differed, text size synced because its twelve agreed.
  const { io, state, writes } = fakeStores(false, true, { text: false, bg: true })
  assert.equal(reconcileOverlayIndependent(io), true)
  assert.deepEqual(writes, ['text=true'], 'only the flag that disagreed is written')
  const after = state()
  assert.deepEqual({ text: after.text, bg: after.bg }, { text: true, bg: true })
  // THE WHOLE REASON THIS DIRECTION IS SAFE: turning text size on seeds every kind from what all
  // twelve windows are currently drawing, so nothing changes size. Turning transparency OFF
  // instead would have repainted every window the least-harm rule had just decided to leave alone.
  assert.equal(after.seededText, true, 'the opt-in must go through the setter that seeds')
})

test('(true, false) -> (true, true), the mirror, and the seed runs on the OTHER feature', () => {
  const { io, state, writes } = fakeStores(true, false, { text: true, bg: false })
  assert.equal(reconcileOverlayIndependent(io), true)
  assert.deepEqual(writes, ['bg=true'])
  const after = state()
  assert.deepEqual({ text: after.text, bg: after.bg }, { text: true, bg: true })
  assert.equal(after.seededBg, true)
})

test('the reconcile is IDEMPOTENT: running it again does nothing at all', () => {
  const { io, writes } = fakeStores(false, true, { text: false, bg: true })
  reconcileOverlayIndependent(io)
  assert.equal(reconcileOverlayIndependent(io), false, 'the second pass finds them agreeing')
  assert.deepEqual(writes, ['text=true'], 'and writes nothing a second time')
})

// ---- the one switch ------------------------------------------------------------------------

test('the switch moves BOTH flags, and writes only the ones that have to move', () => {
  const off = fakeStores(false, false)
  setOverlayIndependent(off.io, true)
  assert.deepEqual(off.writes, ['text=true', 'bg=true'])
  assert.deepEqual(off.state(), { text: true, bg: true, seededText: true, seededBg: true })

  setOverlayIndependent(off.io, false)
  assert.deepEqual(off.writes.slice(2), ['text=false', 'bg=false'])
  const back = off.state()
  assert.deepEqual({ text: back.text, bg: back.bg }, { text: false, bg: false })
  // THE JOS-168 RULE, INTACT: the seed happened once, so turning it on again does not re-flatten
  // the per-kind values somebody has since moved.
  assert.deepEqual({ t: back.seededText, b: back.seededBg }, { t: true, b: true })
  setOverlayIndependent(off.io, true)
  assert.deepEqual(off.writes.slice(4), ['text=true', 'bg=true'])
})

test('flipping to the value it already has is not a write, so it is not a broadcast either', () => {
  const on = fakeStores(true, true, { text: true, bg: true })
  setOverlayIndependent(on.io, true)
  assert.deepEqual(on.writes, [], 'a no-op flip must stay a no-op')
  // …and from a disagreeing pair, only the half that has to move does.
  const half = fakeStores(true, false, { text: true, bg: false })
  setOverlayIndependent(half.io, true)
  assert.deepEqual(half.writes, ['bg=true'])
})

// ---- the seams (source pins) ----------------------------------------------------------------

test('main applies it through the FEATURES’ OWN setters, never a raw store write', () => {
  const store = src('../src/main/storeOverlayIndependent.ts')
  // The seed lives inside those setters; a `settingsStore.set` here would flip the flag and skip
  // it, which is exactly how "opting in changes nothing on screen" would stop being true.
  assert.match(store, /setText: \(independent\) => \{\s*\n\s*setOverlayTextSize\(\{ independent \}\)/)
  assert.match(store, /setBg: \(independent\) => \{\s*\n\s*setOverlayBgAlpha\(\{ independent \}\)/)
  assert.doesNotMatch(code('../src/main/storeOverlayIndependent.ts'), /settingsStore/,
    'this module owns no store access of its own')
  // ONCE. A migration that runs twice is a bug waiting for a hand-edited store between reads.
  assert.match(store, /if \(reconciled\) return false\s*\n\s*reconciled = true/)
})

test('the reconcile runs at STARTUP, before any window exists — so it needs no broadcast', () => {
  const index = src('../src/main/index.ts')
  assert.match(
    index,
    /reconcileOverlayIndependentOnce\(\)[\s\S]{0,400}?createMainWindow\(\)/,
    'it must run before the first window is created'
  )
})

test('ONE CHANNEL carries the pair, and the handler broadcasts only after BOTH writes land', () => {
  const ipc = src('../src/main/ipc/windowControls.ts')
  // Two calls from the renderer could not promise this: an overlay window would be told about the
  // size flip and re-resolve against a transparency flag that had not moved yet.
  assert.match(
    ipc,
    /overlayIndependentSet[\s\S]*?applyOverlayIndependent\(on === true\)[\s\S]*?broadcastOverlayTextSize\(text\)[\s\S]*?broadcastOverlayBgAlpha\(bg\)/
  )
  // …and it tells the per-kind lists too, because the seed just wrote all twelve of each.
  assert.match(ipc, /overlayIndependentSet[\s\S]*?broadcastOverlayTextScales\(\)[\s\S]*?broadcastOverlayBgAlphas\(\)/)
  // The eight existing channels are untouched; this is a ninth, not a replacement.
  const chan = src('../src/shared/ipc.ts')
  assert.match(chan, /overlayIndependentSet: 'overlayIndependent:set'/)
  for (const keep of ['overlayTextSizeSet', 'overlayBgAlphaSet', 'overlayTextScalesGet', 'overlayBgAlphasGet']) {
    assert.match(chan, new RegExp(`${keep}:`), `${keep} must survive the collapse`)
  }
})

test('the CARD reads the derived boolean and writes through the one call', () => {
  const card = src('../src/renderer/src/features/preferences/OverlaysAppearanceSetting.tsx')
  assert.match(card, /overlayIndependent\(\{ text: size\.prefs\.independent, bg: alpha\.prefs\.independent \}\)/)
  assert.match(card, /window\.eq\.setOverlayIndependent\(on\)/)
  // ONE switch on the page, and the two the review objected to are gone.
  assert.match(card, /data-testid="pref-overlay-independent"/)
  assert.doesNotMatch(card, /pref-overlay-text-independent|pref-overlay-bg-independent/)
  // NEVER BOTH SHAPES. The ternary is the whole of the owner's rule: two shared steppers, or the
  // twelve rows. Not one mounted and hidden — a hidden row keeps its stale value.
  assert.match(card, /\{independent \? \(\s*\n\s*<PerOverlayRows/)
  assert.match(card, /\) : \(\s*\n\s*<SharedRows/)
  assert.doesNotMatch(card, /display: 'none'|visibility:/, 'a hidden control is still a control')
})

test('WHERE A PRESS CANNOT MOVE ANYTHING YET, THE CARD SAYS SO — both shapes', () => {
  // The JOS-408 confusion audit's rule, applied to the two places a live control's effect is
  // DEFERRED rather than absent. Hiding either would be worse than explaining it: the value being
  // set is what that window will open at, which is a real reason to be on this page.
  const card = code('../src/renderer/src/features/preferences/OverlaysAppearanceSetting.tsx')
  // Per ROW, when that one window is closed.
  assert.match(card, /tag=\{open \? undefined : 'closed'\}/)
  // …and for the two SHARED steppers, whose equivalent is every window being closed. Only in that
  // shape: with the switch on, twelve rows already carry their own tag.
  assert.match(card, /const nothingOpen = OVERLAY_LABEL_ORDER\.every\(\(kind\) => !open\[kind\]\)/)
  assert.match(card, /!independent && nothingOpen &&/)
  // The open-state is LIVE, not a snapshot: overlays are opened from the title bar's menu while
  // this pane is on screen, and App.tsx keeps the warm snapshot right for the next mount.
  assert.match(card, /window\.eq\.onOverlayState/)
  assert.match(code('../src/renderer/src/App.tsx'), /recordPref\('overlayOpen'/)
})

test('the transparency stepper’s accessible names are whole sentences', () => {
  // WHAT THE AUDIT CAUGHT. Reading every aria-label in the section out of the real DOM found
  // "More see-through the overlays" — a screen reader announces exactly that string, so the
  // missing preposition is the entire sentence a blind user gets. Both kinds end in `for`.
  const stepper = src('../src/renderer/src/features/preferences/PrefStepper.tsx')
  for (const name of ['Smaller text for', 'Larger text for', 'More see-through for', 'More solid for']) {
    assert.ok(stepper.includes(`'${name}'`), `${name} is not the label`)
  }
  assert.match(stepper, /aria-label=\{`\$\{words\.lessName\} \$\{name\}`\}/)
  assert.match(stepper, /aria-label=\{`\$\{words\.moreName\} \$\{name\}`\}/)
})

test('NOTHING IN THE SECTION IS DISABLED EXCEPT A STEPPER AT A CLAMP', () => {
  // The owner's review, in one assertion: "our first pass had enabled controls when they didn't do
  // anything." The answer was to stop rendering them, so the `disabled` prop and its explanatory
  // tooltip both leave the card entirely — `PrefStepper` owns the only two, and they are the ends.
  const card = code('../src/renderer/src/features/preferences/OverlaysAppearanceSetting.tsx')
  // `disabled=`, the PROP — not the word: the `closed` tag is painted `text.disabled`, which is a
  // colour for a live control's label rather than a control nobody may press.
  assert.doesNotMatch(card, /disabled=/, 'the Overlays card renders no disabled control')
  assert.doesNotMatch(card, /Tooltip/, 'and explains no dead control, because it has none')
  const stepper = src('../src/renderer/src/features/preferences/PrefStepper.tsx')
  assert.match(stepper, /disabled=\{atMin\}/)
  assert.match(stepper, /disabled=\{atMax\}/)
  // The three cards the fold replaced are gone rather than left orphaned in the tree.
  for (const dead of ['OverlayTextSizeSetting', 'OverlayBgAlphaSetting', 'PerOverlaySetting']) {
    assert.throws(
      () => src(`../src/renderer/src/features/preferences/${dead}.tsx`),
      `${dead}.tsx survived the fold`
    )
  }
})
