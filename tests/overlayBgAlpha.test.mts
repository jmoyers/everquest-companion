// THE OVERLAYS' BACKGROUND TRANSPARENCY (JOS-407) — the preference, the one rule, and the
// LEAST-HARM upgrade.
//
// `tests/overlayTextScale.test.mts` is this file's twin one field over, and the two are deliberately
// shaped alike: a pure normalizer, a two-mode rule, a migration, and SOURCE PINS for the things
// that need a real transparent always-on-top window to observe. What is NOT shared is the answer
// the migration gives, and that is the whole reason this ticket existed:
//
//   TEXT SIZE was fanned out — one press wrote all twelve kinds — so every store held twelve EQUAL
//   values and coming up synced changed nothing on anybody's screen.
//   TRANSPARENCY never was. `overlay:setConfig` wrote the kind that asked and nothing else, so the
//   twelve values in a real store are whatever twelve separate decisions left behind. The rule
//   above all (owner, 2026-08-17) is DO THE LEAST HARM: if their overlays are separately set today,
//   they stay separate.
//
// Both branches are tested below, plus the tie, plus the empty store — because "nothing changes on
// upgrade" is the acceptance criterion and each of those is a different way to fail it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BG_ALPHA_DEFAULT,
  BG_ALPHA_MAX,
  BG_ALPHA_MIN,
  BG_ALPHA_PREF_STEP,
  BG_ALPHA_STEP,
  DEFAULT_OVERLAY_BG_ALPHA,
  clampBgAlpha,
  deriveBgAlphaPrefs,
  effectiveOverlayBgAlpha,
  mergeOverlayBgAlpha,
  normalizeOverlayBgAlpha,
  stepBgAlpha,
  storedSharedBgAlpha
} from '../src/shared/overlayBgAlpha'
// The SHARE half lives here rather than in tests/shareProfiles.test.mts, which is at the
// 400-code-line factoring ceiling: this is the file about what this preference is, and how it
// crosses a machine boundary is part of that.
import {
  buildSettingsBody,
  makeEnvelope,
  planScalarChanges,
  type SettingsBundleBody
} from '../src/shared/profiles'
import { decodeShareString, encodeShareString } from '../src/main/shareCodec'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// ---- the normalizer ---------------------------------------------------------------------

test('an absent or malformed alpha is the default, not an invisible window', () => {
  // The case a store written before the floor moved can be in, and the cases a hand-edited one can.
  assert.equal(clampBgAlpha(undefined), BG_ALPHA_DEFAULT)
  assert.equal(clampBgAlpha(null), BG_ALPHA_DEFAULT)
  // NaN is the one that matters: `rgba(14,17,21,NaN)` is not an error anywhere, it is a card that
  // does not paint at all.
  assert.equal(clampBgAlpha(NaN), BG_ALPHA_DEFAULT)
  assert.equal(clampBgAlpha(Infinity), BG_ALPHA_DEFAULT)
  assert.equal(clampBgAlpha('0.5'), BG_ALPHA_DEFAULT)
  assert.equal(clampBgAlpha({}), BG_ALPHA_DEFAULT)
})

test('THE FLOOR MOVED, and that is a migration: a stored 0 comes back as 0.1', () => {
  // `setOverlayConfig` clamped this to 0-1 while every slider in the app stopped at 0.1, so a
  // hand-edited store — or a share import's `clamp01` — could hold a value no control could get
  // back off the floor: an invisible window that still eats its own pixels.
  assert.equal(clampBgAlpha(0), BG_ALPHA_MIN)
  assert.equal(clampBgAlpha(0.05), BG_ALPHA_MIN)
  assert.equal(clampBgAlpha(-3), BG_ALPHA_MIN)
  assert.equal(clampBgAlpha(1.4), BG_ALPHA_MAX)
  // The ends themselves are legal — a clamp that excluded them would make the slider's last notch
  // a no-op that still wrote to the store.
  assert.equal(clampBgAlpha(BG_ALPHA_MIN), BG_ALPHA_MIN)
  assert.equal(clampBgAlpha(BG_ALPHA_MAX), BG_ALPHA_MAX)
})

test('in-range values survive, and float dust does not accumulate', () => {
  assert.equal(clampBgAlpha(0.72), 0.72)
  assert.equal(clampBgAlpha(0.34), 0.34)
  // 0.02 steps off a float: without the round, a few notches persist 0.7400000000000001 and the
  // row prints the dust back at the user as a percentage.
  let v = BG_ALPHA_DEFAULT
  for (let i = 0; i < 4; i++) v = clampBgAlpha(v + BG_ALPHA_STEP)
  assert.equal(v, 0.8)
  for (let i = 0; i < 50; i++) v = clampBgAlpha(v - BG_ALPHA_STEP)
  assert.equal(v, BG_ALPHA_MIN, 'walking down past the floor stops AT the floor')
})

// ---- the 5% GRID the Preferences stepper walks (JOS-408) -----------------------------------
//
// The slider in Preferences became a − / + stepper when the whole Appearance page did, and a
// stepper needs a bigger notch than a slider: twenty presses to cross the range, printing 72, 74,
// 76, is not a control anyone reads. The grid is what makes 5% possible on a store full of numbers
// a 0.02 slider left behind — the shipped default is 0.72, which is on no multiple of five.

test('the grid is coarser than the slider, and a whole number of percent', () => {
  assert.equal(BG_ALPHA_PREF_STEP, 0.05)
  assert.ok(BG_ALPHA_PREF_STEP > BG_ALPHA_STEP, 'a stepper notch must be bigger than a slider notch')
  // The overlays' own sliders are untouched: this is a second, coarser way to move the same value.
  assert.equal(BG_ALPHA_STEP, 0.02)
})

test('AN OFF-GRID VALUE SNAPS TO THE GRID, in the direction pressed — the ticket’s own example', () => {
  // 72 -> 75 -> 80 going up …
  assert.equal(stepBgAlpha(0.72, 1), 0.75)
  assert.equal(stepBgAlpha(0.75, 1), 0.8)
  // … and 72 -> 70 -> 65 going down. NOT 0.77 and 0.67: an increment would carry the offset
  // forever, which is the whole reason this is a grid walk rather than an addition.
  assert.equal(stepBgAlpha(0.72, -1), 0.7)
  assert.equal(stepBgAlpha(0.7, -1), 0.65)
})

test('a value ALREADY on the grid moves a whole step, in both directions', () => {
  // The failure a `round` would produce: one of the two buttons becomes a no-op for every on-grid
  // value, i.e. a live control that does nothing — the exact pattern this ticket removes.
  for (const v of [0.15, 0.3, 0.5, 0.65, 0.9]) {
    assert.equal(stepBgAlpha(v, 1), Math.round((v + 0.05) * 100) / 100, `${String(v)} up`)
    assert.equal(stepBgAlpha(v, -1), Math.round((v - 0.05) * 100) / 100, `${String(v)} down`)
  }
  // 0.7 is the float trap this is written against: `0.7 / 0.05` is 13.999999999999998, so without
  // the epsilon stepping up from 70% would land back on 70%.
  assert.equal(stepBgAlpha(0.7, 1), 0.75)
})

test('both ends CLAMP, so the stepper and the range agree about where the road stops', () => {
  assert.equal(stepBgAlpha(BG_ALPHA_MAX, 1), BG_ALPHA_MAX)
  assert.equal(stepBgAlpha(0.98, 1), BG_ALPHA_MAX, 'the last step up is short, not over')
  assert.equal(stepBgAlpha(BG_ALPHA_MIN, -1), BG_ALPHA_MIN)
  assert.equal(stepBgAlpha(0.12, -1), BG_ALPHA_MIN, 'and the last step down likewise')
  // Garbage in is the default, stepped — never NaN reaching an `rgba()`.
  assert.equal(stepBgAlpha(undefined, 1), 0.75)
  assert.equal(stepBgAlpha(NaN, -1), 0.7)
  // Walking either way from anywhere stays inside the range, forever.
  let v = 0.72
  for (let i = 0; i < 40; i++) v = stepBgAlpha(v, 1)
  assert.equal(v, BG_ALPHA_MAX)
  for (let i = 0; i < 40; i++) v = stepBgAlpha(v, -1)
  assert.equal(v, BG_ALPHA_MIN)
})

// ---- the preference: one transparency, or twelve -----------------------------------------

test('the prefs normalizer defaults every field, from any garbage', () => {
  assert.deepEqual(normalizeOverlayBgAlpha(undefined), DEFAULT_OVERLAY_BG_ALPHA)
  assert.deepEqual(normalizeOverlayBgAlpha(null), DEFAULT_OVERLAY_BG_ALPHA)
  assert.deepEqual(normalizeOverlayBgAlpha('nonsense'), DEFAULT_OVERLAY_BG_ALPHA)
  assert.deepEqual(normalizeOverlayBgAlpha({}), DEFAULT_OVERLAY_BG_ALPHA)
  // Only a literal `true` is on — a truthy string from a hand-edited file is not an opt-in to a
  // mode that changes what twelve windows do.
  assert.equal(normalizeOverlayBgAlpha({ independent: 'yes' }).independent, false)
  assert.equal(normalizeOverlayBgAlpha({ independent: true }).independent, true)
  assert.equal(normalizeOverlayBgAlpha({ shared: 9 }).shared, BG_ALPHA_MAX)
  assert.equal(normalizeOverlayBgAlpha({ shared: 0.34 }).shared, 0.34)
})

test('a patch that names one field keeps the other — a switch flip cannot reset the alpha', () => {
  const base = { shared: 0.4, independent: false, seeded: false }
  assert.deepEqual(mergeOverlayBgAlpha({ independent: true }, base), { ...base, independent: true })
  assert.deepEqual(mergeOverlayBgAlpha({ shared: 0.9 }, base), { ...base, shared: 0.9 })
  assert.deepEqual(mergeOverlayBgAlpha({}, base), base)
  // A wrong-typed field is the same as an absent one: it names nothing this base should give up.
  assert.deepEqual(mergeOverlayBgAlpha({ shared: 'faint', independent: 1 }, base), base)
  // With no base at all it is a normalize, which is what makes it one door for a renderer, a
  // hand-edited file and the store reader.
  assert.deepEqual(mergeOverlayBgAlpha({ shared: 0.5 }), { shared: 0.5, independent: false, seeded: false })
})

test('the once-ever seed flag is ONE-WAY — a renderer cannot ask to be re-seeded', () => {
  const seeded = { shared: 0.4, independent: true, seeded: true }
  assert.equal(mergeOverlayBgAlpha({ seeded: false }, seeded).seeded, true)
  assert.equal(mergeOverlayBgAlpha({ independent: false }, seeded).seeded, true)
  // …and it can be SET by a patch, which is how the migration hands its own answer forward.
  assert.equal(mergeOverlayBgAlpha({ seeded: true }, { ...seeded, seeded: false }).seeded, true)
})

test('THE EFFECTIVE ALPHA IS THE WHOLE RULE: independent ? per-kind : shared', () => {
  const synced = { shared: 0.4, independent: false, seeded: false }
  const apart = { shared: 0.4, independent: true, seeded: true }
  assert.equal(effectiveOverlayBgAlpha(synced, 0.9), 0.4, 'a per-kind value is not consulted while synced')
  assert.equal(effectiveOverlayBgAlpha(apart, 0.9), 0.9, '…and is the answer while independent')
  // An absent per-kind value under independent mode is the default, never the shared alpha: the
  // window has never been given one of its own and 0.72 is what it is painting.
  assert.equal(effectiveOverlayBgAlpha(apart, undefined), BG_ALPHA_DEFAULT)
  // Both ends go through the clamp, so no mode can hand a surface a value it cannot paint.
  assert.equal(effectiveOverlayBgAlpha(apart, 0), BG_ALPHA_MIN)
  assert.equal(effectiveOverlayBgAlpha({ ...synced, shared: 5 }, 0.9), BG_ALPHA_MAX)
})

test('SURVIVING THE SWITCH is a property of the rule, not of a code path', () => {
  // The JOS-168 promise: sync for a week, unsync, and your faint respawn window is faint again.
  const own = 0.24
  const apart = { shared: 0.72, independent: true, seeded: true }
  assert.equal(effectiveOverlayBgAlpha(apart, own), own)
  assert.equal(effectiveOverlayBgAlpha({ ...apart, independent: false }, own), 0.72)
  assert.equal(effectiveOverlayBgAlpha(apart, own), own, 'and it is still there afterwards')
})

test('an absent shared alpha is TOLD APART from a stored 72%', () => {
  // The difference between "never asked" and "asked for the default" is the whole of the upgrade.
  assert.equal(storedSharedBgAlpha(undefined), null)
  assert.equal(storedSharedBgAlpha({}), null)
  assert.equal(storedSharedBgAlpha({ independent: true }), null)
  assert.equal(storedSharedBgAlpha({ shared: 'faint' }), null)
  assert.equal(storedSharedBgAlpha({ shared: NaN }), null)
  assert.equal(storedSharedBgAlpha({ shared: BG_ALPHA_DEFAULT }), BG_ALPHA_DEFAULT)
  assert.equal(storedSharedBgAlpha({ shared: 0 }), BG_ALPHA_MIN, 'and it arrives clamped')
})

// ---- THE LEAST-HARM UPGRADE ---------------------------------------------------------------

test('ALL TWELVE EQUAL ⇒ synced at that value, and nothing on screen moves', () => {
  const twelve = (v: number): number[] => new Array(12).fill(v) as number[]
  assert.deepEqual(deriveBgAlphaPrefs(twelve(BG_ALPHA_DEFAULT)), {
    shared: BG_ALPHA_DEFAULT,
    independent: false,
    seeded: false
  })
  // The tidy store that has been moved wholesale: one transparency, twelve times.
  assert.deepEqual(deriveBgAlphaPrefs(twelve(0.4)), { shared: 0.4, independent: false, seeded: false })
  // …and the fresh install, whose twelve slots are all absent and therefore all 0.72.
  assert.deepEqual(deriveBgAlphaPrefs(new Array(12).fill(undefined) as unknown[]), {
    shared: BG_ALPHA_DEFAULT,
    independent: false,
    seeded: false
  })
})

test('ANY VALUE DIFFERENT ⇒ INDEPENDENT, which is what leaves every window as it was', () => {
  // The ordinary shape of a used store: one deliberately faint meter and eleven untouched windows.
  const mixed = [0.3, ...(new Array(11).fill(undefined) as unknown[])]
  const prefs = deriveBgAlphaPrefs(mixed)
  assert.equal(prefs.independent, true, 'they differ, so they stay apart')
  assert.equal(prefs.shared, BG_ALPHA_DEFAULT, 'and the value nobody is using is the most common one')
  // SEEDED comes up TRUE on this branch, and it has to: the twelve values are the very thing the
  // rule just decided to keep, and a later first-opt-in seed would flatten them to the shared one.
  assert.equal(prefs.seeded, true)
  // The claim that matters, stated as the acceptance criterion: every window paints what it
  // painted yesterday, because independent mode reads the per-kind values.
  assert.equal(effectiveOverlayBgAlpha(prefs, 0.3), 0.3)
  assert.equal(effectiveOverlayBgAlpha(prefs, undefined), BG_ALPHA_DEFAULT)
})

test('…the MOST COMMON value wins, and a TIE goes to the MORE OPAQUE', () => {
  assert.equal(deriveBgAlphaPrefs([0.3, 0.3, 0.3, 0.9]).shared, 0.3)
  // A tie is settled toward readability rather than toward see-through: the failure that gets
  // reported is text you cannot read over a bright game, never a card that is too solid.
  assert.equal(deriveBgAlphaPrefs([0.3, 0.9]).shared, 0.9)
  assert.equal(deriveBgAlphaPrefs([0.9, 0.3]).shared, 0.9, 'and the answer does not depend on order')
  // Values below the floor are votes for the floor, because that is what they will be painted at.
  assert.equal(deriveBgAlphaPrefs([0, 0.05, 0.9]).shared, BG_ALPHA_MIN)
})

test('…and an EMPTY list derives NOTHING: a caller with no kinds gets the default, synced', () => {
  // Deriving from nothing is how a fresh install would come up at somebody else's transparency.
  assert.deepEqual(deriveBgAlphaPrefs([]), DEFAULT_OVERLAY_BG_ALPHA)
  assert.equal(deriveBgAlphaPrefs([]).independent, false)
})

// ---- the store seam (source pins) ---------------------------------------------------------

test('the store clamps the alpha through the shared normalizer, not a local 0-1', () => {
  const store = src('../src/main/store.ts')
  assert.match(store, /next\.bgAlpha = clampBgAlpha\(next\.bgAlpha\)/)
  // The old inline clamp is gone: two copies of a range is how a slider and a store end up
  // disagreeing about what an overlay may look like.
  assert.doesNotMatch(store, /next\.bgAlpha = Math\.max\(0, Math\.min\(1/)
})

test('THE DERIVATION ASKS EVERY KIND, INCLUDING THE ABSENT ONES', () => {
  const store = src('../src/main/storeOverlayBgAlpha.ts')
  // `OVERLAY_KINDS` rather than `Object.keys(overlays)`: a kind with no stored config is a window
  // drawing at 0.72, so it is a vote and not a missing ballot. Asking only the kinds that happen
  // to have a row would call a one-faint-window store unanimous and repaint eleven windows.
  assert.match(store, /OVERLAY_KINDS\.map\(\(kind\) => all\[kind\]\?\.bgAlpha\)/)
  // …and it is WRITTEN BACK, which is what makes it a migration rather than a computation.
  assert.match(
    store,
    /if \(storedSharedBgAlpha\(raw\) !== null\) return normalizeOverlayBgAlpha\(raw\)[\s\S]*?settingsStore\.set\('overlayBgAlpha', next\)/
  )
})

test('OPTING IN RE-PAINTS NOTHING, once ever — and the flag is what makes it once', () => {
  const store = src('../src/main/storeOverlayBgAlpha.ts')
  assert.match(store, /if \(next\.independent && cur\.seeded !== true\) \{[\s\S]*?seedOnFirstOptIn\(cur\.shared\)/)
  // EVERY kind, not "the ones with no value": any drag or lock has already materialized a
  // `bgAlpha`, so a seed keyed on absence would skip exactly the windows somebody had moved.
  assert.match(store, /for \(const kind of OVERLAY_KINDS\) setOverlayConfig\(kind, \{ bgAlpha: shared \}\)/)
})

test('A SYNCED DRAG IS A ROUTE, NOT A FAN-OUT — and the per-kind value survives it', () => {
  const ipc = src('../src/main/ipc/windowControls.ts')
  assert.match(
    ipc,
    /if \(p\.bgAlpha !== undefined && !getOverlayBgAlpha\(\)\.independent\) \{[\s\S]*?broadcastOverlayBgAlpha\(setOverlayBgAlpha\(\{ shared: p\.bgAlpha \}\)\)/,
    'a synced bgAlpha write routes to the shared preference and broadcasts it'
  )
  // The broadcast reaches a PINNED window, which draws no chrome and has no slider of its own —
  // every change it obeys was made in Preferences or on another window.
  assert.match(
    ipc,
    /function broadcastOverlayBgAlpha[\s\S]*?for \(const k of OVERLAY_KINDS\) \{[\s\S]*?send\(IPC\.onOverlayBgAlpha, prefs\)[\s\S]*?getMainWindow\(\)/
  )
  // The WRITE handler always broadcasts, including the `independent` flip that carries no number.
  assert.match(
    ipc,
    /overlayBgAlphaSet[\s\S]*?const prefs = setOverlayBgAlpha\(patch\)\s*\n\s*broadcastOverlayBgAlpha\(prefs\)/
  )
})

test('EXACTLY ONE function decides what a window paints with, and every surface asks it', () => {
  const chrome = src('../src/renderer/src/overlay/useOverlayChrome.ts')
  assert.match(chrome, /effectiveOverlayBgAlpha\(bgPrefs, cfg\?\.bgAlpha\)/)
  // The twelve rows moved AGAIN in JOS-408, into the one Overlays card that now holds both
  // settings and the single switch over them. Same call, same rule, one file fewer.
  const rows = src('../src/renderer/src/features/preferences/OverlaysAppearanceSetting.tsx')
  assert.match(rows, /effectiveOverlayBgAlpha\(alpha, alphas\[kind\]\)/)
  // …and the surfaces that PAINT with it do not re-derive the rule with a ternary of their own.
  for (const path of [
    '../src/renderer/src/overlay/OverlayMeter.tsx',
    '../src/renderer/src/overlay/HealMeter.tsx',
    '../src/renderer/src/overlay/EventLogOverlay.tsx',
    '../src/renderer/src/overlay/ToastCard.tsx',
    '../src/renderer/src/overlay/ConCard.tsx',
    '../src/renderer/src/overlay/BannerLine.tsx'
  ]) {
    assert.doesNotMatch(src(path), /getOverlayBgAlpha|effectiveOverlayBgAlpha/, `${path} decides it for itself`)
  }
})

test('THE THREE STRIPS HAVE A SLIDER NOW, and it writes through the config patch', () => {
  const slider = src('../src/renderer/src/overlay/BgAlphaSlider.tsx')
  assert.match(slider, /patch\(\{ bgAlpha:/, 'the slider writes through the config patch')
  assert.doesNotMatch(slider, /ipcRenderer|window\.eqOverlay\./, 'and reaches for no channel of its own')
  // MUI-FREE: this is the overlay bundle, which has no theme and no component library.
  assert.doesNotMatch(slider, /@mui\//)
  // The range is stated ONCE, in the shared module — not re-typed beside the input.
  assert.match(slider, /min=\{BG_ALPHA_MIN\}[\s\S]*?max=\{BG_ALPHA_MAX\}[\s\S]*?step=\{BG_ALPHA_STEP\}/)
  for (const path of [
    '../src/renderer/src/overlay/ToastOverlay.tsx',
    '../src/renderer/src/overlay/AlertBannerOverlay.tsx',
    '../src/renderer/src/overlay/ConCardOverlay.tsx'
  ]) {
    assert.match(src(path), /<BgAlphaSlider bgAlpha=\{bgAlpha\}/, `${path} carries one in its drag frame`)
  }
})

// ---- crossing a machine boundary (profiles / share) ---------------------------------------

test('the transparency round-trips as a preference AND as per-kind values (JOS-407)', () => {
  const body = buildSettingsBody({
    alerts: [],
    alertPrefs: { globalVolume: 0.7, muted: false },
    overlays: { fight: { bgAlpha: 0.3 }, overall: { bgAlpha: 0.9 } },
    overlayBgAlpha: { shared: 0.4, independent: true, seeded: true }
  })
  // BOTH halves travel. The per-kind values are what an OLDER build reads and applies; the
  // preference is what a build that has the switch reads. Dropping either would make one of the
  // two versions import a bundle into a state its sender's screen was never in.
  assert.deepEqual(body.overlays, { fight: { bgAlpha: 0.3 }, overall: { bgAlpha: 0.9 } })
  assert.deepEqual(body.overlayBgAlpha, { shared: 0.4, independent: true })
  // `seeded` is bookkeeping about THIS install's history with the switch and never leaves it: a
  // stranger's answer would suppress the seed that keeps opting in from repainting anything.
  assert.equal(Object.prototype.hasOwnProperty.call(body.overlayBgAlpha ?? {}, 'seeded'), false)

  const decoded = decodeShareString(encodeShareString(makeEnvelope('settings', body, '1.5.0')))
  assert.ok(decoded.ok)
  if (!decoded.ok) return
  assert.deepEqual((decoded.envelope.body as SettingsBundleBody).overlayBgAlpha, {
    shared: 0.4,
    independent: true
  })
})

test('an OLD profile imports under the LEAST-HARM rule, read off its per-kind alphas', () => {
  const ctx = {
    alertPrefs: { globalVolume: 0.7, muted: false },
    overlays: { fight: { bgAlpha: 0.72 }, overall: { bgAlpha: 0.72 } },
    overlayBgAlpha: { shared: 0.72, independent: false, seeded: false },
    ui: {}
  }
  // A bundle from a build that predates the preference, whose sender had every overlay at one
  // transparency: they were synced at 40%, so that is the only preference row offered.
  const agreed: SettingsBundleBody = { overlays: { fight: { bgAlpha: 0.4 }, overall: { bgAlpha: 0.4 } } }
  const agreedRows = planScalarChanges(agreed, ctx)
  assert.deepEqual(
    agreedRows.map((c) => c.id).sort(),
    ['overlay.fight.bgAlpha', 'overlay.overall.bgAlpha', 'overlayBgAlpha.shared']
  )
  assert.equal(agreedRows.find((c) => c.id === 'overlayBgAlpha.shared')?.incoming, '40%')

  // …and one whose sender's overlays DIFFERED: they were not synced, and the mode row says so.
  const differed: SettingsBundleBody = { overlays: { fight: { bgAlpha: 0.3 }, overall: { bgAlpha: 0.9 } } }
  const rows = planScalarChanges(differed, ctx)
  const mode = rows.find((c) => c.id === 'overlayBgAlpha.independent')
  assert.deepEqual({ current: mode?.current, incoming: mode?.incoming }, { current: 'Off', incoming: 'On' })
  // A TIE goes to the more opaque, so the shared value the sender is credited with is 90%.
  assert.equal(rows.find((c) => c.id === 'overlayBgAlpha.shared')?.incoming, '90%')

  // A bundle that says NOTHING about overlays offers no transparency row at all — an absent
  // opinion is not an opinion that everything should be 72%.
  assert.deepEqual(planScalarChanges({ ui: {} }, ctx).map((c) => c.id), [])
})

test('a bundle that CARRIES the preference is believed over its own per-kind values', () => {
  // The two can legitimately disagree: independent mode means the per-kind values are in force and
  // the shared one is a remembered number nobody is using. Deriving from the values would
  // therefore overwrite a real answer with a guess.
  const body: SettingsBundleBody = {
    overlays: { fight: { bgAlpha: 0.3 }, overall: { bgAlpha: 0.3 } },
    overlayBgAlpha: { shared: 0.9, independent: true }
  }
  const rows = planScalarChanges(body, {
    alertPrefs: { globalVolume: 0.7, muted: false },
    overlays: {},
    overlayBgAlpha: { shared: 0.72, independent: false, seeded: false },
    ui: {}
  })
  assert.equal(rows.find((c) => c.id === 'overlayBgAlpha.shared')?.incoming, '90%')
  assert.equal(rows.find((c) => c.id === 'overlayBgAlpha.independent')?.incoming, 'On')
})

test('THE PREFERENCE ROWS COME FIRST, because the first opt-in SEEDS every kind', () => {
  // Order is load-bearing and `applySelectedScalars` walks this list in order: turning independent
  // transparency on for the first time writes the shared alpha into all twelve kinds, so a
  // per-kind value applied before it would be overwritten moments later by the same import.
  const body: SettingsBundleBody = {
    overlays: { fight: { bgAlpha: 0.3 } },
    overlayBgAlpha: { shared: 0.5, independent: true }
  }
  const ids = planScalarChanges(body, {
    alertPrefs: { globalVolume: 0.7, muted: false },
    overlays: { fight: { bgAlpha: 0.72 } },
    overlayBgAlpha: { shared: 0.72, independent: false, seeded: false },
    ui: {}
  }).map((c) => c.id)
  assert.ok(
    ids.indexOf('overlayBgAlpha.independent') < ids.indexOf('overlay.fight.bgAlpha'),
    `the mode row must precede the per-kind rows: ${ids.join(', ')}`
  )
})
