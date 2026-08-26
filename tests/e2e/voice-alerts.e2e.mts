/**
 * Headless Electron integration test for VOICE ALERTS (docs/plans/voice-alerts.md, wave 2).
 *
 * THERE IS NO MASTER SWITCH ANY MORE, and this spec is where that is proven end to end. It used
 * to drive one: turn on "Speak alerts out loud", check it reached main's store, and only then
 * exercise the rest — which is exactly why the row's ▶ bug survived (owner, 2026-08-04). A user
 * who never found that toggle set a row's output to "Voice (spoken)", pressed play, and heard the
 * old pack sound, because the retired switch degraded every spoken alert to its sound while it was
 * off. The test agreed with the app and both were wrong about the product. So the first thing
 * asserted here now is the ABSENCE of that control, in the panel AND in the stored prefs.
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: every claim this wave makes is a SEAM, and the
 * pure halves are already pinned elsewhere (tests/voiceAlerts.test.mts for the plan/throttle/
 * voice-matching decisions, tests/alertPreview.test.mts for preview == firing,
 * tests/speechText.test.mts for the text). What only the real app can show is that the pieces are
 * actually WIRED:
 *   - the Preferences → Voice section mounts as pure configuration, with no enable switch in it
 *     and none in main's stored blob (electron-store is main-owned; the only honest proof is the
 *     round trip);
 *   - the editor's live preview resolves through `speechTextFor` with NO firing at all — the
 *     whole reason that function takes an optional firing;
 *   - a def saved with `audio:'speech'` makes the firing path reach the ENGINE SEAM, which
 *     crosses the dialog, the store, main, the player and lib/speech;
 *   - a tier with nothing to speak with SAYS SO on the alert row itself, rather than leaving the
 *     user to discover it by pressing play.
 *
 * IT ASSERTS THE SEAM, NEVER THE AUDIO. `lib/speech.ts` records every utterance on
 * `window.__eqSpeech` with an `uttered` flag and returns BEFORE touching any engine whenever
 * `window.eq.isE2E` is true. So this spec reads that ring — which gives it two independent
 * claims from one action: the seam was invoked (the record exists, with the right text) AND
 * the e2e channel stayed SILENT (`uttered === false`).
 *
 * THE SILENCE IS THE POINT, not a convenience. `npm run test:e2e` runs beside the user's live
 * game with no window ever shown (AGENTS.md); a headless test that spoke out loud would be the
 * most intrusive thing in this repo. That is asserted here explicitly, so it cannot regress
 * quietly.
 *
 * Run: `npm run test:e2e` (or `node --import tsx tests/e2e/voice-alerts.e2e.mts`).
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleGone
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
// The GLOBAL always-play preference and the per-alert box it takes over (JOS-222) — next door
// because this spec is at its line budget, and here because this is the spec that owns the
// throttle opt-out that preference overrides. See that file's header for why it is an e2e claim.
import { stepAlwaysPlayAll } from './alwaysPlayAllSteps.mjs'
// `{target}` from the PLAIN editor, on a live-tailed line (JOS-353) — next door for the same
// line-budget reason, and here because §5 below is the declared-capture half of the same claim.
import { stepTargetToken } from './targetTokenSteps.mjs'
// WRITING a custom phrase — from the alert ROW and from the editor (JOS-360). Next door for the
// same line-budget reason, and here because this is the spec that owns both surfaces: §4's row
// picker and §5's phrase resolution are the two halves it joins.
import { stepCustomPhrase } from './customPhraseSteps.mjs'
// The voice comes from PREFERENCES and nowhere else (JOS-362) — next door for the same line-budget
// reason, and here because this is the spec that owns the engine seam's utterance ring.
import { stepVoiceFollowsPrefs } from './voicePrefsSteps.mjs'

const VOICE_PANEL = '[data-testid="pref-voice"]'
/** The RETIRED master switch. Asserted to be absent — see the header. */
const ENABLE = '[data-testid="pref-voice-enabled"]'

/** One utterance as `lib/speech.ts` recorded it. `uttered` is what proves the channel is mute. */
interface Spoken {
  text: string
  engine: string
  voiceId: string | null
  uttered: boolean
}

/** The engine seam's own ring. `[]` when nothing has ever asked to speak. */
function spoken(page: Page): Promise<Spoken[]> {
  return page.evaluate(
    () => (window as unknown as { __eqSpeech?: { spoken: Spoken[] } }).__eqSpeech?.spoken ?? []
  ) as Promise<Spoken[]>
}

/** The voice prefs as MAIN has them — the only honest read of what is actually stored. */
function storedPrefs(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() =>
    (window as unknown as { eq: { getVoicePrefs: () => Promise<Record<string, unknown>> } }).eq.getVoicePrefs()
  )
}

function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector
  )
}

/** Pick a value out of a MUI Select (its popup renders `li[data-value=…]`). */
async function selectIn(page: Page, selector: string, value: string): Promise<void> {
  await page.click(selector)
  await page.waitForSelector(`li[data-value="${value}"]`, { timeout: 10_000 })
  await page.click(`li[data-value="${value}"]`)
  // MUI's menu animates out; clicking through it while it fades hits the backdrop. Its LEAVING is
  // the condition — waiting for the DOM to lose the listbox, not for 400ms to pass.
  await settleGone(page, '.MuiMenu-root', { timeoutMs: 8_000 })
}

/**
 * Fire something that should SPEAK, and wait for the seam's own ring to record it.
 *
 * `lib/speech.ts` pushes onto `window.__eqSpeech` before it would touch an engine, so a new entry
 * IS the observable this spec exists to assert — which makes it the right thing to wait for, and
 * the 500–800ms sleeps that used to stand in for it pure guesswork about IPC latency.
 */
async function spokeOnce(page: Page, act: () => Promise<void>): Promise<Spoken[]> {
  const before = (await spoken(page)).length
  await act()
  return settle(() => spoken(page), (all) => all.length > before, { timeoutMs: 10_000 })
}

function selectValue(page: Page, testid: string, value: string): Promise<void> {
  return selectIn(page, `[data-testid="${testid}"]`, value)
}

/** §2: the section exists and is pure CONFIGURATION — no master switch, in the UI or the store. */
async function stepPanel(page: Page): Promise<boolean> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="prefs-rail-voice"]', { timeout: 20_000 })
  await page.click('[data-testid="prefs-rail-voice"]')
  await page.waitForSelector(VOICE_PANEL, { timeout: 15_000 })
  if (!check('Preferences has a Voice section, reachable from the rail', (await countOf(page, VOICE_PANEL)) === 1)) {
    return false
  }

  check(
    'there is NO master switch — an alert’s own output is the whole of "does this speak"',
    (await countOf(page, ENABLE)) === 0
  )
  check(
    '…and the section says so, rather than leaving the user hunting for the toggle they remember',
    (await countOf(page, '[data-testid="pref-voice-intro"]')) === 1
  )

  const stored = await storedPrefs(page)
  check(
    'main agrees: the stored voice blob carries configuration and no permission',
    !('enabled' in stored),
    JSON.stringify(stored)
  )
  check('…and the engine tier defaults to the free, zero-download one', stored.engine === 'system', String(stored.engine))

  // The controls that configure the tier are all present.
  for (const id of ['pref-voice-engine', 'pref-voice-picker', 'pref-voice-preview', 'pref-voice-rate', 'pref-voice-volume']) {
    check(`the Voice section offers ${id.replace('pref-voice-', '')}`, (await countOf(page, `[data-testid="${id}"]`)) === 1)
  }
  return true
}

/** The ▶ preview speaks through the REAL seam — and, in this channel, silently. */
async function stepPreview(page: Page): Promise<void> {
  const before = (await spoken(page)).length
  const all = await spokeOnce(page, () => page.click('[data-testid="pref-voice-preview"]'))
  if (!check('the ▶ preview reaches the speech engine seam', all.length === before + 1, `${String(all.length - before)} utterance(s)`)) {
    return
  }
  const last = all[all.length - 1]
  check('…saying something, through the selected tier', last.text.length > 0 && last.engine === 'system', `${last.engine}: "${last.text}"`)
  check(
    'THE E2E CHANNEL NEVER UTTERS — the seam records and returns before any engine is touched',
    last.uttered === false,
    `uttered=${String(last.uttered)}`
  )
}

/**
 * §2 (W3): the DOWNLOADED tier states its price and its refusal, in the panel.
 *
 * The e2e channel declines to download (a throwaway userData would re-fetch ~120 MB every run),
 * which is exactly what makes this cheap AND worth asserting: clicking Download proves the button
 * reaches main, and the refusal proves the reason lands INLINE instead of vanishing into a
 * promise. The tier is put back to 'system' afterwards so the later steps see the default.
 */
async function stepKokoroInstall(page: Page): Promise<void> {
  await selectValue(page, 'pref-voice-engine', 'kokoro')
  check(
    'choosing the downloaded tier says plainly that it is not installed',
    (await countOf(page, '[data-testid="pref-voice-not-installed"]')) === 1
  )
  // `innerText` is the RENDERED text, and MUI Buttons uppercase it — match case-insensitively
  // rather than pinning a theme decision this spec has no opinion about.
  const label = (await textOf(page, '[data-testid="pref-voice-install"]')).replace(/\s+/g, ' ').trim()
  check(
    '…and offers the download, stating what it costs BEFORE the user pays it',
    /^download natural voice \(~\d+ MB\)$/i.test(label),
    label
  )

  await page.click('[data-testid="pref-voice-install"]')
  await page.waitForSelector('[data-testid="pref-voice-install-error"]', { timeout: 20_000 })
  const failure = (await textOf(page, '[data-testid="pref-voice-install-error"]')).replace(/\s+/g, ' ')
  check(
    'clicking it reaches main, and main’s refusal is rendered inline with its reason',
    failure.includes('disabled in e2e'),
    failure
  )
  await selectValue(page, 'pref-voice-engine', 'system')
}

/**
 * THE ROW'S OWN DROPDOWNS (owner: "the voice vs sound should be integrated into this dropdown
 * instead of having to drill into edit").
 *
 * This is the one claim the pure tests cannot make. audioChoice.ts pins what the selects WRITE;
 * what only the real app can show is that the first select actually offers the voice outputs
 * beside the packs, that choosing one persists through main and comes back as the displayed
 * value, that the SECOND select swaps from sounds to speak-what modes, and that the row's ▶ then
 * SPEAKS — through `playAlertNow`'s existing plan, with no second preview path.
 *
 * THE ▶ ASSERTION IS THE BUG'S TRIPWIRE, and it asserts the RESOLVED ACTION, never audible sound
 * (this channel is mute by construction): the seam's ring must gain exactly one utterance carrying
 * the def's resolved text. Before the master switch was retired this row previewed the PACK SOUND
 * — no utterance at all — so a regression shows up here as `0 utterance(s)`, which is precisely
 * what the user experienced.
 *
 * It runs BEFORE the editor step, while the seeded alert is still sound-only, so the write it
 * makes is a real change rather than a no-op.
 */
const FIRST_ROW = '[data-testid="alert-row"]:first-of-type'

/** The first alert's name, as the row renders it — what a preview of it must say. */
function firstRowName(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    `${FIRST_ROW} .MuiTypography-body2`
  )
}

async function stepRowPicker(page: Page): Promise<void> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="alert-row"]', { timeout: 30_000 })
  check(
    'an alert row shows its sound, not a drill-down: two selects, output and sound',
    (await countOf(page, `${FIRST_ROW} [data-testid="alert-output"]`)) === 1 &&
      (await countOf(page, `${FIRST_ROW} [data-testid="alert-sound"]`)) === 1
  )

  await selectIn(page, `${FIRST_ROW} [data-testid="alert-output"]`, 'output:speech')
  // MUI pads a Select's rendered value with a zero-width space (its empty-value placeholder), so
  // it has to come out before this compares text.
  const shown = (await textOf(page, `${FIRST_ROW} [data-testid="alert-output"]`))
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  check('the output select states the channel the def is actually in', shown === 'Voice (spoken)', shown)
  check(
    '…and the second select becomes what to SAY, not which sound to play',
    (await countOf(page, `${FIRST_ROW} [data-testid="alert-say"]`)) === 1 &&
      (await countOf(page, `${FIRST_ROW} [data-testid="alert-sound"]`)) === 0
  )

  const stored = await page.evaluate(() =>
    (window as unknown as { eq: { listAlerts: () => Promise<{ audio?: string }[]> } }).eq.listAlerts()
  )
  check(
    'the row wrote the audio channel onto the stored def (no editor was opened)',
    stored[0]?.audio === 'speech',
    JSON.stringify(stored[0]?.audio)
  )

  // Nothing is wrong with the system tier's voices, so the row wears no setup annotation.
  check(
    'a row whose voice is fine carries no chrome about voices',
    (await countOf(page, `${FIRST_ROW} [data-testid="alert-row-voice-setup"]`)) === 0
  )

  const name = await firstRowName(page)
  const before = (await spoken(page)).length
  const all = await spokeOnce(page, () => page.click(`${FIRST_ROW} [data-testid="alert-test"]`))
  if (
    !check(
      'and the row’s ▶ SPEAKS it — the same firing path, no new preview seam',
      all.length === before + 1,
      `${String(all.length - before)} utterance(s) — 0 means it played the pack sound again`
    )
  ) {
    return
  }
  const last = all[all.length - 1]
  check(
    '…saying the text the def resolves to, not a sound: the RESOLVED ACTION, never audible noise',
    last.text === name,
    `spoke "${last.text}", expected "${name}"`
  )
  check('…and this channel stayed mute while proving it', last.uttered === false, `uttered=${String(last.uttered)}`)
}

/**
 * A TIER WITH NOTHING TO SPEAK WITH SAYS SO, ON THE ROW.
 *
 * The retired master switch used to be annotated in the output dropdown ("voice is off —
 * Preferences → Voice"): a sentence naming a place, about a switch that overruled the row. What is
 * left is a real, checkable condition — the natural voice is not downloaded — and the row states
 * it where the choice was made. In the app proper it carries a "Set up in Preferences" LINK
 * (AlertsView's optional `onOpenVoicePrefs`, wired by App.tsx); the NOTE is this file's to assert,
 * since it renders with or without a router.
 *
 * The e2e channel never downloads the Kokoro pack, so selecting that tier is a genuine
 * not-installed state rather than a simulated one. The tier is put back afterwards.
 */
async function stepRowSetupNote(page: Page): Promise<void> {
  const gotoVoicePrefs = async (): Promise<void> => {
    await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
    await page.waitForSelector('[data-testid="prefs-rail-voice"]', { timeout: 20_000 })
    await page.click('[data-testid="prefs-rail-voice"]')
    await page.waitForSelector(VOICE_PANEL, { timeout: 15_000 })
  }
  const gotoAlerts = async (): Promise<void> => {
    await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
    await page.waitForSelector('[data-testid="alert-row"]', { timeout: 30_000 })
    // The annotation this step is about is derived from the stored voice tier, which the row
    // reads over IPC — so the settled ROW is what has to be waited for, not a fixed beat.
    await settle(() => countOf(page, `${FIRST_ROW} [data-testid="alert-output"]`), (n) => n === 1, {
      timeoutMs: 10_000
    })
  }

  await gotoVoicePrefs()
  await selectValue(page, 'pref-voice-engine', 'kokoro')
  await gotoAlerts()
  check(
    'a speaking row whose tier is not installed says so, on the row itself',
    (await countOf(page, `${FIRST_ROW} [data-testid="alert-row-voice-setup"]`)) === 1
  )
  const note = (await textOf(page, `${FIRST_ROW} [data-testid="alert-row-voice-setup"]`)).replace(/\s+/g, ' ')
  check('…naming what is missing, not naming a switch that no longer exists', /downloaded/i.test(note), note)
  noteLink(await countOf(page, `${FIRST_ROW} [data-testid="voice-setup-link"]`))

  await gotoVoicePrefs()
  await selectValue(page, 'pref-voice-engine', 'system')
  await gotoAlerts()
  check(
    '…and the annotation disappears the moment the tier can speak again',
    (await countOf(page, `${FIRST_ROW} [data-testid="alert-row-voice-setup"]`)) === 0
  )
}

/** The link half needs App.tsx's `onOpenVoicePrefs`; report what was found without gating on it. */
function noteLink(count: number): void {
  note(
    count === 1
      ? 'the annotation carries the "Set up in Preferences" link (App passes onOpenVoicePrefs)'
      : 'the annotation renders without its link — App is not passing onOpenVoicePrefs yet'
  )
}

/** The alert name the dialog is editing, read off its own title ("Edit alert — <name>"). */
async function editingName(page: Page): Promise<string> {
  const title = (await textOf(page, '[data-testid="alert-dialog"] .MuiDialogTitle-root')).replace(/\s+/g, ' ').trim()
  // `Edit alert - <name>` (JOS-106 took the em dash out of the copy). The FIRST ` - ` is the
  // separator, so an alert whose own name carries a hyphen still resolves.
  const dash = title.indexOf(' - ')
  return dash === -1 ? '' : title.slice(dash + 3).trim()
}

/**
 * §4: the editor's Speech block, on a REAL stored def — and the live preview, which resolves
 * with no firing at all (that is what `speechTextFor`'s optional firing exists for).
 */
async function stepEditor(page: Page): Promise<string> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="alert-row"]', { timeout: 30_000 })
  await page.click('[data-testid="alert-row"]:first-of-type [data-testid="alert-edit"]')
  await page.waitForSelector('[data-testid="alert-dialog"]', { timeout: 15_000 })
  const name = await editingName(page)
  check('the alert editor carries a Speech block', (await countOf(page, '[data-testid="alert-speech-block"]')) === 1)
  check(
    'the audio channel is a sound/speech choice, and the throttle opt-out is beside it',
    (await countOf(page, '[data-testid="alert-audio-action"]')) === 1 &&
      (await countOf(page, '[data-testid="alert-always-play"]')) === 1
  )

  await selectValue(page, 'alert-audio-action', 'speech')
  const preview = (await textOf(page, '[data-testid="alert-speech-preview"]')).replace(/\s+/g, ' ')
  check(
    'the mode preview resolves LIVE, before anything has fired — and defaults to the alert’s name',
    !!name && preview.includes(name),
    `${preview.slice(0, 80)} (editing “${name}”)`
  )
  // The mode picker is offered; the per-alert VOICE picker is not, and its absence is the claim
  // (JOS-362 — the voice lives in Preferences now, see voicePrefsSteps.mts).
  check(
    'the mode picker is offered, and no per-alert voice override is',
    (await countOf(page, '[data-testid="alert-speech-mode"]')) === 1 &&
      (await countOf(page, '[data-testid="alert-speech-voice"]')) === 0
  )

  await page.click('[data-testid="alert-save"]')
  await page.waitForSelector('[data-testid="alert-dialog"]', { state: 'detached', timeout: 15_000 })
  // The save writes through main; the row that will be test-fired next has to be back on screen
  // before it can be clicked, which is a condition the list itself answers.
  await settle(() => countOf(page, '[data-testid="alert-row"]'), (n) => n > 0, { timeoutMs: 10_000 })
  return name
}

/**
 * THE WIRING, end to end: a def stored with `audio:'speech'`, fired through the player's own
 * path (the list's Test button), reaches the engine seam saying the resolved text.
 */
async function stepFire(page: Page, name: string): Promise<void> {
  const before = (await spoken(page)).length
  const all = await spokeOnce(page, () =>
    page.click('[data-testid="alert-row"]:first-of-type [data-testid="alert-test"]')
  )
  if (!check('test-firing a speech alert invokes the engine seam', all.length === before + 1, `${String(all.length - before)} utterance(s)`)) {
    return
  }
  const last = all[all.length - 1]
  check(
    '…saying exactly what `speechTextFor` resolved for that def',
    last.text === name,
    `spoke "${last.text}", expected "${name}"`
  )
  check('…and still without uttering a sound in this channel', last.uttered === false, `uttered=${String(last.uttered)}`)
}

// ---------------------------------------------------------------------------------------------
// §5 — CAPTURE GROUPS IN ALERT SPEECH (JOS-103), on a LIVE-TAILED line.
//
// Everything else in this spec test-FIRES an alert from the row's ▶. This step is the only one
// that makes the game say something: the harness appends a real log line to the tailed file and
// the utterance has to come out the far end of the whole chain — chokidar → Tailer → parser →
// AlertsModule (where the named group is harvested, sanitized and capped) → IPC → the player →
// `speechTextFor` → the engine seam. A unit test can pin each link; only this can pin that the
// captured text actually survives the IPC hop and reaches the resolver as a firing.
//
// THE LINE IS THE OWNER'S OWN, verbatim from eqlog_Primitive_freeport.txt:890467 (a shaman named
// Fail casting Spirit of the Puma in Freeport, 2026-08-01) — with only its timestamp restamped to
// now, because the module fires on LIVE events and the harness owns the clock.
//
// THE DEF IS STORED THROUGH THE APP'S OWN IPC, not typed into the dialog: `window.eq.saveAlert`
// is the exact call AlertDialog makes on save, so this exercises the real store path without
// driving a five-control form. The dialog's own half — that it TELLS you which tokens the pattern
// declares — is asserted separately below, on this same def.
// ---------------------------------------------------------------------------------------------

const CAPTURE_ALERT_ID = 'e2e:capture-puma'
const CAPTURE_PHRASE = 'Puma on {player}'
/** What the alert must SAY once the line lands. The whole point of the feature. */
const CAPTURE_EXPECTED = 'Puma on Fail'

async function stepCaptureAlert(page: Page, log: { appendAt: (at: Date, ...m: readonly string[]) => number }): Promise<void> {
  // Author the def exactly as the `landsOnOther` suggestion template does (suggestions.ts).
  const saved = await page.evaluate(
    async ({ id, phrase }) => {
      const eq = (window as unknown as { eq: { saveAlert: (d: unknown) => Promise<unknown[]> } }).eq
      const defs = await eq.saveAlert({
        id,
        name: 'Puma landed',
        enabled: true,
        trigger: {
          type: 'raw',
          regex: "^\\[[^\\]]*\\] (?<player>[A-Za-z' `]{1,48}) growls with the spirit of the puma\\."
        },
        sound: { packId: 'alan-rickman', soundId: 'task-acknowledge-task-acknowledge-05' },
        cooldownMs: 0,
        audio: 'speech',
        speech: { mode: 'custom', phrase }
      })
      return defs.length
    },
    { id: CAPTURE_ALERT_ID, phrase: CAPTURE_PHRASE }
  )
  if (!check('a capture alert saves through the app’s own IPC', saved > 0, `${String(saved)} defs stored`)) return

  // THE PLAYER HOLDS ITS OWN COPY OF THE DEFS. `refreshAlertStore` (player.tsx) re-reads them on
  // mount and on window FOCUS — and a hidden e2e window is never focused, so a def stored straight
  // through the IPC would fire in main and find no def renderer-side. Dispatching the app's own
  // focus event is the honest way to say "re-read now": it is the same listener a returning user
  // trips, not a test-only back door.
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await settle(
    () => page.evaluate(
      (id) => (window as unknown as { eq: { listAlerts: () => Promise<{ id: string }[]> } }).eq
        .listAlerts().then((d) => d.some((a) => a.id === id)),
      CAPTURE_ALERT_ID
    ),
    (present) => present,
    { timeoutMs: 15_000 }
  )

  // ── RESTORED BY JOS-500 (owner ruling 27) — THE FIRE FRAME CARRIES THE WORDS ──────────────
  //
  // RETIRED FOR ONE RELEASE AND BACK UNCHANGED. JOS-499 left this assertion standing behind a
  // `RETIRED_5a` early-return rather than deleting it, because the reason it could not be claimed
  // was a missing FIELD and not a changed product: a `FireMessage` carried exactly four fields and
  // had nowhere to put the JOS-103 captures, so the alert still fired and still spoke, but spoke
  // its phrase with the tokens unsubstituted. `alertsAudioRules.ts` had named that cost since
  // JOS-491 ("costs a firing some of its WORDS and never its existence"), and the deletion release
  // made it the only path — which is what the owner ruled release-gating.
  //
  // THE FRAME GREW `captures`, `spell` AND `dueAt`, so the gate is gone and the claim below is the
  // one this spec always made, word for word. It is the END-TO-END half of the parity: the engine
  // produces the capture (proven in `fold`'s own suite), `fireToFiring` copies it (proven in
  // `tests/engineAlertsAudio.test.mts`), and what is asserted HERE is that a real app, driven by a
  // real live-tailed log line, reaches the speech seam with the substitution actually done.
  //
  // WHY THAT NEEDS AN E2E AND NOT A THIRD UNIT TEST: everything between the engine's match and the
  // utterance is wiring — the connection, the IPC hop, the renderer's player, the def lookup by id
  // — and wiring is exactly what a pure test cannot see.

  // Wait for the utterance THIS step caused, by its text — the ring is app-wide and a step that
  // asserted "the newest entry" would be asserting against whatever spoke last.
  const before = (await spoken(page)).length
  log.appendAt(new Date(), 'Fail growls with the spirit of the puma.')
  const all = await settle(
    () => spoken(page),
    (list) => list.slice(before).some((s) => s.text === CAPTURE_EXPECTED),
    { timeoutMs: 20_000 }
  ).catch(() => null)
  const hit = all?.slice(before).find((s) => s.text === CAPTURE_EXPECTED)
  if (
    !check(
      'a capture group reaches the speech seam SUBSTITUTED, from a live-tailed log line',
      hit !== undefined,
      hit ? `spoke "${hit.text}"` : `never spoke "${CAPTURE_EXPECTED}"`
    )
  ) {
    return
  }
  check('…and this channel stayed mute doing it', hit.uttered === false, `uttered=${String(hit.uttered)}`)
}

/**
 * §5b — the editor SAYS what the alert is able to say. The readable form of control 4 in
 * shared/alertCaptures.ts: for a def that came from somebody else's share string, the token list
 * is how you learn what it can speak without reading the regex.
 */
async function stepCaptureHint(page: Page): Promise<void> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  // Addressed by ID, never by list position: this def was appended to a list the earlier steps
  // also edit, so "first-of-type" would be a bet on ordering.
  const row = `[data-alert-id="${CAPTURE_ALERT_ID}"]`
  await settle(() => countOf(page, row), (n) => n === 1, { timeoutMs: 15_000 })
  await page.click(`${row} [data-testid="alert-edit"]`)
  await page.waitForSelector('[data-testid="alert-dialog"]', { timeout: 15_000 })
  // `innerText` is EMPTY for a node that is not laid out yet, and MUI's Dialog fades in — so the
  // selector existing is not the condition. The TEXT arriving is (settle.mts's whole argument).
  const hint = (
    await settle(
      () => textOf(page, '[data-testid="alert-speech-captures"]'),
      (t) => t.trim().length > 0,
      { timeoutMs: 10_000 }
    ).catch(() => '')
  ).replace(/\s+/g, ' ')
  check(
    'the editor names the capture groups this alert’s pattern declares',
    hint.includes('{player}'),
    hint.slice(0, 110) || '(no hint rendered)'
  )
  await page.keyboard.press('Escape')
  await settleGone(page, '[data-testid="alert-dialog"]', { timeoutMs: 10_000 })
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-voice.log…')
  // `log` is the staged copy of the fixture the app is tailing — §5 appends to it live.
  const { app, close, log } = await launchOnFixture('e2e-voice.log')

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    if (await stepPanel(page)) {
      await stepPreview(page)
      await stepKokoroInstall(page)
      await stepRowPicker(page)
      await stepRowSetupNote(page)
      const name = await stepEditor(page)
      // BEFORE the firing steps, and it puts the preference back off when it is done: everything
      // below counts utterances, and the audio throttle's state is an input to that.
      await stepAlwaysPlayAll(page)
      if (name) await stepFire(page, name)
      else note('no seeded alert to edit this run — the firing path is not asserted')
      // §5 LAST, because it appends to the tailed log and stores a def of its own — every step
      // above reads the seeded alert list, and a spec that mutated it first would be asserting
      // against a world it had already changed.
      await stepCaptureAlert(page, log)
      await stepCaptureHint(page)
      // §6 after §5, same reasoning one step further: it stores a def and appends to the tail too.
      await stepTargetToken(page, log)
      // §7 last: it stores a def, edits it from two surfaces and appends to the tail twice.
      await stepCustomPhrase(page, log)
      // §8 after it, because it CHANGES THE VOICE PREFERENCE and leaves it changed: every step
      // above reads the prefs blob, and one that had been rewritten under them would be asserting
      // against a world it had already moved.
      await stepVoiceFollowsPrefs(page)
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'voice-alerts-FAIL')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
