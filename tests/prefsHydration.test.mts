// ============================================================================
// prefsHydration.test.mts — a control never paints a value it does not know (JOS-340).
// ============================================================================
//
// The Preferences pane reads a store that lives in MAIN, over a bridge on which every method is a
// promise. Every card used to mount on its compiled-in default and correct itself from an effect,
// so the first painted frame of a switch was always the default and the user's own value arrived
// a hop later. The fix is one hydration gate for the whole pane plus a snapshot the renderer keeps
// warm — src/renderer/src/features/preferences/prefsSnapshot.ts, whose header carries the design.
//
// TWO HALVES, AND THIS FILE IS THE ONE A NODE TEST CAN SEE.
//
//   1. HERE: the snapshot mechanics. That the batch is ONE batch (a gate that fired eighteen reads
//      per mount would be a different bug), that concurrent mounts share it, that a failure does
//      not become permanent, and — the load-bearing one — that a WRITE updates the cache, because
//      that is what makes the SECOND mount of a card correct after the user has changed something.
//      A frozen-at-load snapshot would pass every other test in this file and fail that one, which
//      is precisely why the fix is a live cache rather than a preload injection.
//
//   2. NOT HERE: whether a real MUI Switch is born with the right `checked`. That is a claim about
//      a FRAME, and no assertion in this process can see one. `tests/e2e/prefs-first-paint.e2e.mts`
//      makes it against the running app with a MutationObserver, because a settled read of this
//      defect is green on the broken build — the settle is exactly what hides the flash.
//
// The reader is a STUB, and it counts its own calls. Nothing here touches Electron, `window`, or
// the store: `prefsSnapshot.ts` takes the bridge as an argument for this reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  loadPrefsSnapshot,
  peekPrefsSnapshot,
  readPrefsSnapshot,
  recordPref,
  resetPrefsSnapshotForTests,
  type PrefsReader
} from '../src/renderer/src/features/preferences/prefsSnapshot'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** A bridge stub that answers every read with a recognisable value and counts the calls. */
function stubReader(over: Partial<Record<keyof PrefsReader, unknown>> = {}): {
  reader: PrefsReader
  calls: () => number
} {
  let calls = 0
  const answer = <T,>(key: keyof PrefsReader, fallback: T): (() => Promise<T>) => {
    return () => {
      calls++
      return Promise.resolve((over[key] ?? fallback) as T)
    }
  }
  const reader = {
    getEqConfig: answer('getEqConfig', { root: 'C:/eq', logsDir: 'C:/eq/Logs', source: 'detected', characterCount: 2, readable: 'ok' }),
    getUiScale: answer('getUiScale', 1.1),
    getGraphicsPrefs: answer('getGraphicsPrefs', { safeMode: 'auto', opaqueOverlays: 'auto' }),
    getGraphicsEnvironment: answer('getGraphicsEnvironment', { wine: false, auto: { safeMode: false, opaqueOverlays: false } }),
    getOverlayAutoHide: answer('getOverlayAutoHide', { hideWhenNotRunning: false, hideWhenUnfocused: true }),
    getOverlaySnap: answer('getOverlaySnap', { enabled: true }),
    // Stored ON against a compiled-in default of OFF (JOS-139; OFF since the owner's 2026-08-16
    // reversal) — and the one with TWO other controls (the tray menu's checkbox and the title bar's
    // overlay-menu row) that can move it while this pane is closed.
    getCloseToTray: answer('getCloseToTray', { enabled: true, noticeAcknowledged: true }),
    getOverlayState: answer('getOverlayState', { toast: true, alertBanner: true, conCard: false }),
    getToastConfig: answer('getToastConfig', { locked: false }),
    // The banner ships OFF and its first card mounted on that default; stored ON here, with an
    // off-default hold, so the seed has to carry both (owner, hands-on, 2026-08-16).
    getAlertBannerConfig: answer('getAlertBannerConfig', { locked: false, alertBanner: { holdMs: 8000, maxLines: 4, introduced: true } }),
    // The con card ships ON (JOS-383) — so the value that can be WRONG for somebody is a stored
    // OFF, which is what this stub carries. Its auto-hide is stored off-default too, and out of
    // range, so the seed has to normalize rather than pass it through.
    getConCardConfig: answer('getConCardConfig', { locked: true, conCard: { autoHideMs: 999_999 } }),
    getBuffTrust: answer('getBuffTrust', { externals: ['Faelin'] }),
    getCursorRing: answer('getCursorRing', { enabled: true, sizePx: 60, thicknessPx: 5, color: 'white' }),
    getVoicePrefs: answer('getVoicePrefs', { engine: 'system', voice: 'x', rate: 1, volume: 1 }),
    getTelemetryPayload: answer('getTelemetryPayload', { prefs: { enabled: false }, buffered: [], lastBatch: null, endpointConfigured: false }),
    getPerfPrefs: answer('getPerfPrefs', { enabled: true }),
    getStartupProfile: answer('getStartupProfile', { phases: [] }),
    // A switch whose compiled-in default is TRUE (JOS-366), stored FALSE — the flash this gate
    // exists to prevent, in the direction the other switches cannot express.
    getProcessPriority: answer('getProcessPriority', { yieldToGame: false }),
    // The second of those (JOS-385), and stored FALSE for the same reason: the only person whose
    // resist-evidence value differs from the shipped one is the person who switched it off.
    getResistPrefs: answer('getResistPrefs', { includeNpcCasters: false }),
    getAppVersion: answer('getAppVersion', '9.9.9'),
    getUpdateStatus: answer('getUpdateStatus', { state: 'ready' }),
    listAlerts: answer('listAlerts', [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  } as unknown as PrefsReader
  return { reader, calls: () => calls }
}

// ---- the batch ----------------------------------------------------------------------------

test('one read answers every card in the pane, and it snaps the text size to the ladder', async () => {
  const { reader, calls } = stubReader()
  const snap = await readPrefsSnapshot(reader)

  // TWENTY-TWO reads, one batch. The number is not the claim; the claim is that the gate asks each
  // question exactly once, so a pane that mounts does not stampede the store.
  assert.equal(calls(), 22, 'every read fires exactly once')

  // The resist-evidence switch (JOS-385), stored against its shipped ON. It is in the batch for
  // the `processPriority` reason, and it is asserted here for the same one.
  assert.equal(snap.resists.includeNpcCasters, false)

  // A sample across the KINDS of value, because the defect was never boolean-only: two switches
  // that disagree with their defaults, a ladder stop, a slider pair, and two counts.
  assert.equal(snap.overlayAutoHide.hideWhenNotRunning, false)
  assert.equal(snap.overlayAutoHide.hideWhenUnfocused, true)
  // Another switch whose stored value disagrees with its compiled-in default (JOS-217 ships OFF).
  assert.equal(snap.overlaySnap.enabled, true)
  // …and the tray switch, stored ON against its shipped OFF (JOS-139).
  assert.equal(snap.closeToTray.enabled, true)
  assert.equal(snap.uiScale, 1.1, 'the ladder value arrives snapped, so the cache cannot hold an off-rung number')
  assert.equal(snap.cursorRing.sizePx, 60)
  assert.equal(snap.alertCount, 3, 'a count, not the list - the Profiles caption is the only reader')
  assert.equal(snap.version, '9.9.9')

  // The toast's two facts come from two different reads and are one control pair.
  assert.deepEqual(snap.toast, { open: true, locked: false })
  // The banner's three, likewise — and its knobs arrive normalized, so an off-range hold could
  // never sit in the cache.
  assert.deepEqual(snap.alertBanner, {
    open: true,
    locked: false,
    cfg: { holdMs: 8000, maxLines: 4, introduced: true }
  })
  // And the con card's three (JOS-383). The switch is the one that ships ON, so a stored OFF is the
  // flash this gate exists to prevent; the out-of-range auto-hide arrives clamped.
  assert.deepEqual(snap.conCard, { open: false, locked: true, cfg: { autoHideMs: 120_000 } })
})

test('an off-ladder text size is snapped rather than stored as it was found', async () => {
  const { reader } = stubReader({ getUiScale: 1.37 })
  const snap = await readPrefsSnapshot(reader)
  assert.equal(snap.uiScale, 1.25, 'nearest rung')
})

// ---- the cache ----------------------------------------------------------------------------

test('the snapshot is cold exactly once: a second mount reads memory, not the bridge', async () => {
  resetPrefsSnapshotForTests()
  const { reader, calls } = stubReader()
  assert.equal(peekPrefsSnapshot(), null, 'nothing is known before the first load')

  const first = await loadPrefsSnapshot(reader)
  const after = calls()
  const second = await loadPrefsSnapshot(reader)

  assert.equal(calls(), after, 'the second load asks main nothing at all')
  assert.equal(second, first, 'and hands back the very same object')
  assert.notEqual(peekPrefsSnapshot(), null, 'so a later mount can seed synchronously')
  resetPrefsSnapshotForTests()
})

test('two mounts in one frame share ONE batch', async () => {
  resetPrefsSnapshotForTests()
  const { reader, calls } = stubReader()
  const [a, b] = await Promise.all([loadPrefsSnapshot(reader), loadPrefsSnapshot(reader)])
  assert.equal(calls(), 22, 'not forty-four')
  assert.equal(a, b)
  resetPrefsSnapshotForTests()
})

test('a failed read is not cached: the next mount gets to try again', async () => {
  resetPrefsSnapshotForTests()
  let attempt = 0
  const bad: PrefsReader = {
    ...stubReader().reader,
    getEqConfig: () => {
      attempt++
      return attempt === 1 ? Promise.reject(new Error('main is asleep')) : stubReader().reader.getEqConfig()
    }
  }
  await assert.rejects(() => loadPrefsSnapshot(bad), /main is asleep/)
  assert.equal(peekPrefsSnapshot(), null, 'a failure leaves the cache empty rather than poisoned')

  const recovered = await loadPrefsSnapshot(bad)
  assert.equal(recovered.version, '9.9.9', 'the retry succeeds instead of replaying the rejection')
  resetPrefsSnapshotForTests()
})

// ---- writes keep it warm ---------------------------------------------------------------------

test('a write updates the cache, so the NEXT mount of a card seeds from the change', async () => {
  resetPrefsSnapshotForTests()
  const { reader } = stubReader()
  const before = await loadPrefsSnapshot(reader)
  assert.equal(before.overlayAutoHide.hideWhenUnfocused, true)

  // What a card does with main's authoritative reply after the user flips the switch.
  recordPref('overlayAutoHide', { hideWhenNotRunning: false, hideWhenUnfocused: false })

  const seed = peekPrefsSnapshot()
  assert.equal(seed?.overlayAutoHide.hideWhenUnfocused, false, 'the next mount paints the new value')
  assert.equal(seed?.version, '9.9.9', 'and nothing else moved')
  assert.equal(
    before.overlayAutoHide.hideWhenUnfocused,
    true,
    'the previous object is untouched - a seed already handed to a mounted card must not mutate under it'
  )
  resetPrefsSnapshotForTests()
})

test('recording before the first load is a no-op, never a half-built snapshot', () => {
  resetPrefsSnapshotForTests()
  recordPref('uiScale', 1.5)
  assert.equal(peekPrefsSnapshot(), null, 'the gate is never handed a snapshot that was never read')
})

// ---- source pins ------------------------------------------------------------------------------

test('every Preferences card seeds from the gate, and none of them re-reads main on mount', () => {
  // THE REGRESSION THIS PINS is a new card written in the old shape, or an old one quietly
  // growing its effect back. The whole defect was one line of boilerplate copied thirteen times,
  // and the comment on each copy recommended it to the next author.
  const dir = new URL('../src/renderer/src/features/preferences/', import.meta.url)
  const cards = [
    'OverlayAutoHideSetting.tsx',
    'OverlaySnapSetting.tsx',
    'CloseToTraySetting.tsx',
    'GraphicsSetting.tsx',
    'CursorRingSetting.tsx',
    'PerfSetting.tsx',
    'BuffTrustSetting.tsx',
    'ResistEvidenceSetting.tsx',
    'TextSizeSetting.tsx',
    'ToastSetting.tsx',
    'VoiceSetting.tsx',
    'TelemetrySetting.tsx',
    'EqFolderSetting.tsx',
    'UpdateSetting.tsx'
  ]
  for (const card of cards) {
    const text = readFileSync(new URL(card, dir), 'utf8')
    assert.match(text, /usePrefsSeed\(\)/, `${card} seeds from the hydration snapshot`)
  }
})

test('the pane is wrapped in the gate, and the gate paints nothing while it is cold', () => {
  const view = src('../src/renderer/src/features/preferences/PreferencesView.tsx')
  assert.match(view, /<PrefsGate>/, 'the exported view is the gated one')

  const gate = src('../src/renderer/src/features/preferences/prefsHydration.tsx')
  // Not a spinner and not a skeleton: ONE gate for the pane is the ticket's own wording, and a
  // per-control loading state is the shape it rules out.
  assert.match(gate, /if \(!failed\) return null/, 'cold renders nothing at all')
  assert.match(gate, /data-testid="prefs-unreadable"/, 'a read that cannot happen says so')
})

test('the fix is READ-ONLY: the snapshot module never writes the store', () => {
  // AGENTS.md's store-file law. This ticket is a read-path fix and the module that batches the
  // reads must stay one, so a future edit cannot turn the hydration path into a writer.
  const snap = src('../src/renderer/src/features/preferences/prefsSnapshot.ts')
  assert.doesNotMatch(snap, /\bset[A-Z]\w*\(/, 'no setter is called from the snapshot module')
  assert.doesNotMatch(snap, /writeFile|Out-File/, 'and it touches no file')
})
