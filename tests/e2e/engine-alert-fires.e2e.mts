/**
 * THE ALERTS AUDIO CUTOVER, PROVEN END TO END (JOS-491, phase 3).
 *
 * Owner ruling 22 made the ENGINE the thing that evaluates the user's alert definitions; owner
 * ruling 9 kept the SPEAKER app-side. JOS-482 wired everything between them and then deliberately
 * stopped one inch short: the fire frames arrived and were logged, never played, because the app's
 * own evaluator was still making the noise and two evaluators means two sounds. This spec is the
 * inch. With `EQC_ENGINE_ALERTS=1` beside `EQC_ENGINE=1` and `EQC_ENGINE_SERVE=1`:
 *
 *   1. A MATCHING LIVE LINE MAKES EXACTLY ONE SOUND. The bar of the ticket, and the reason it is an
 *      e2e claim: a doubled alert is invisible to every unit test in the tree.
 *   2. …AND THAT SOUND IS THE ENGINE'S. The fire frame reached the app, was placed against a real
 *      def, and was PLAYED — narrated as such, with the app's own evaluator silent behind it.
 *
 * THE SECOND CLAIM IS THE ONE THAT SEPARATES THIS FEATURE FROM ITS ABSENCE, and it deserves saying
 * why it is made where it is. The obvious evidence would be the ARM LINE — the sentence
 * `alertsAudioRules.ts armVerdict` writes when the swap is thrown — but that line is unreachable
 * from a spec: arming happens inside `startEngineSupervisor`, which runs during boot, and Playwright
 * is already draining the app's stdio when `electron.launch()` resolves, so every line printed
 * before that moment is consumed and gone (`engineSteps.mts`'s header measures exactly this, and
 * `engine-boots.e2e.mts` is shaped around it). Waiting for a fire is better evidence anyway: the arm
 * line is a statement of intent, while `PLAYED from the engine` is the app reporting, at the one
 * moment it matters, that a frame off the socket is what reached the speaker. An app that armed
 * nothing prints `logged, not played` on the same line and fails this check while still making its
 * one sound — which is precisely the discrimination claim 1 alone cannot make. Both halves of that
 * sentence, and the gate that can refuse to arm at all, are pinned in
 * `tests/engineAlertsAudio.test.mts`.
 *
 * AND THAT DISCRIMINATION IS MEASURED, not argued. Run once on this ticket with the third flag
 * dropped and the other two left in place: the sound-count checks stayed green (this process's own
 * evaluator made the one sound, exactly as it always has) and both attribution checks went red —
 * `0 played · 1 logged-not-played`. So the ENGINE matched the same line in the same instant, and
 * the only thing the flag changes is which of the two publishes. That is the cutover, stated as a
 * difference rather than as an assertion.
 *
 * ── WHY THE COALESCING WINDOW HAD TO BE TAKEN OFF THE PROBE DEF ────────────────────────────────
 *
 * THIS IS THE WHOLE METHODOLOGY OF THE SPEC, and it is JOS-380's lesson applied before the fact.
 * The renderer folds firings with the same audible identity inside 1.5 s into ONE sound
 * (`audioThrottle.ts coalesceAudio`, JOS-347) — which is exactly what a doubled alert looks like.
 * That throttle hid the app-signal double-fire for the entire life of that feature: two firings,
 * one sound, every test green, and only the banner (which is outside the gate by ruling) ever
 * showed it. A spec that counted utterances against a coalescing def would therefore report ONE
 * whether the cutover worked or not, which is the most expensive kind of green there is.
 *
 * So the probe def carries `alwaysPlay: true` — the per-alert opt-out the throttle already honours
 * (`coalesceAudio`'s first line) — and nothing else about it is unusual. With the window off, the
 * TS evaluator and the engine both publishing would produce TWO entries on the speech ring, and the
 * assertion "exactly one" becomes a real measurement instead of a restatement of the throttle.
 *
 * ── WHY IT ASSERTS THROUGH THE SPEECH SEAM ─────────────────────────────────────────────────────
 *
 * `lib/speech.ts` records every utterance on `window.__eqSpeech` with an `uttered` flag and returns
 * BEFORE touching any engine whenever `window.eq.isE2E` — the suite's existing audio observation
 * seam (voice-alerts.e2e.mts owns it). So the probe alert speaks rather than playing a pack sound:
 * the ring is countable, the text identifies the firing, and `uttered === false` proves this run
 * made no noise on a machine the owner may be playing on. A pack sound has no such ring — it is a
 * fresh `<audio>` element and a blob URL — which is why the seam is the speech one.
 *
 * THE PHRASE CARRIES NO `{token}`. A fire frame has four fields and captures are not among them
 * (alertsAudioRules.ts names the gap), so a def whose phrase asked for one would be asserting the
 * gap rather than the cutover.
 *
 * ── WHY IT WAITS FOR THE PARITY LINE ───────────────────────────────────────────────────────────
 *
 * The engine fires on LIVE events only — "replay must never make a sound" is the same boundary law
 * on both sides — so a line appended while its fold is still historical is a line that correctly
 * makes no sound. The parity sentence is the app's own statement that both worlds landed on the
 * same log AND the engine's ingest went live, which is precisely the precondition, and it is the
 * signal `engine-shim.e2e.mts` already waits on rather than a second readiness invented here.
 *
 * Run: `npm run test:e2e -- engine-alert-fires`
 */
import type { Page } from 'playwright-core'
import { buildEngineIfStale, buildIfStale, check, failures, note, reportRun } from './appHarness.mjs'
import { closeWindows, mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
import { settleServing, tapOutput, type AppOutput } from './engineSteps.mjs'
import { settle, sleep } from './settle.mjs'

/** The same staged fixture the other two engine specs fold — a committed log, privately copied,
 *  which this spec then APPENDS to (they do not). Every fight in it is dated Aug 2026, so the
 *  historical fold is finite and the line this spec writes is unambiguously the live one. */
const FIXTURE = 'e2e-overlay.log'

const PROBE_ID = 'e2e:engine-fire-probe'
/** The def's LABEL, which is what a fire frame names it by (`FireMessage.rule`). */
const PROBE_NAME = 'Engine fire probe'
/** What the alert says. No `{token}`: a fire frame carries no captures — see the header. */
const PHRASE = 'Engine fire probe heard it'

/**
 * THE LINE, and it is the owner's own — verbatim from eqlog_Primitive_freeport.txt (a shaman named
 * Fail casting Spirit of the Puma in Freeport, 2026-08-01), the same one voice-alerts.e2e.mts
 * drives its live-tail step with. Restamped to now by the append driver, because both evaluators
 * fire on LIVE events and the harness owns the clock.
 *
 * REUSED RATHER THAN INVENTED so this spec is not also a bet on whether two independent parsers
 * agree about a sentence nobody has measured: this one is already proven to reach the TypeScript
 * alerts module through the whole chain, and the engine's parser is held byte-identical to it by
 * the equivalence oracle.
 */
const LINE = 'Fail growls with the spirit of the puma.'
/** `ev.raw` carries EQ's own `[timestamp] ` prefix, so the pattern is written unanchored — the
 *  same shape the shipped suggestion templates use. */
const REGEX = 'growls with the spirit of the puma'

interface Spoken {
  text: string
  uttered: boolean
}

/** The speech seam's own ring. `[]` when nothing has ever asked to speak. */
function spoken(page: Page): Promise<Spoken[]> {
  return page.evaluate(
    () => (window as unknown as { __eqSpeech?: { spoken: Spoken[] } }).__eqSpeech?.spoken ?? []
  ) as Promise<Spoken[]>
}

/**
 * The app's own narration of the fires it heard for one rule, split by what it did with each
 * (engineClientHost.ts `noteFire`). Both halves are counted because the two failures they
 * distinguish are opposite: `played` short of one means the frame never became a sound, and
 * `logged` above zero means the flag did not arm and this process made the noise itself.
 */
function fireLines(out: AppOutput, rule: string): { played: number; logged: number } {
  const mine = out
    .text()
    .split('\n')
    .filter((l) => l.includes('data-server fire:') && l.includes(rule))
  return {
    played: mine.filter((l) => l.includes('PLAYED from the engine')).length,
    logged: mine.filter((l) => l.includes('logged, not played')).length
  }
}

/**
 * Store the probe def through the app's OWN IPC — the exact call `AlertDialog` makes on save, so
 * this exercises the real store path (and, with it, `pushAppKnowledge('alerts.define')`, which is
 * what hands the engine this def) without driving a five-control form.
 */
async function saveProbe(page: Page): Promise<number> {
  return page.evaluate(
    async ({ id, name, phrase, regex }) => {
      const eq = (window as unknown as { eq: { saveAlert: (d: unknown) => Promise<unknown[]> } }).eq
      const defs = await eq.saveAlert({
        id,
        name,
        enabled: true,
        trigger: { type: 'raw', regex },
        sound: { packId: 'alan-rickman', soundId: 'task-acknowledge-task-acknowledge-05' },
        cooldownMs: 0,
        // THE THROTTLE, OFF FOR THIS DEF ONLY — the header's whole argument. A coalescing def would
        // report one sound whether the cutover worked or not.
        alwaysPlay: true,
        audio: 'speech',
        speech: { mode: 'custom', phrase }
      })
      return defs.length
    },
    { id: PROBE_ID, name: PROBE_NAME, phrase: PHRASE, regex: REGEX }
  )
}

/**
 * Make the renderer's player re-read the defs.
 *
 * It holds its own copy, refreshed on mount and on window FOCUS — and a hidden e2e window is never
 * focused, so a def stored straight through the IPC would be evaluated in main and find no def on
 * the other side. Dispatching the app's own focus event is the honest way to say "re-read now": it
 * is the listener a returning user trips, not a test-only back door. (voice-alerts.e2e.mts does
 * exactly this, for exactly this reason.)
 */
async function refreshPlayer(page: Page): Promise<boolean> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  return settle(
    () =>
      page.evaluate(
        (id) =>
          (window as unknown as { eq: { listAlerts: () => Promise<{ id: string }[]> } }).eq
            .listAlerts()
            .then((d) => d.some((a) => a.id === id)),
        PROBE_ID
      ),
    (present) => present,
    { timeoutMs: 15_000 }
  ).catch(() => false)
}

/**
 * THE MEASUREMENT — one appended line, and everything that must and must not follow it.
 *
 * `append` is passed in rather than the whole launch because this step's only power over the world
 * should be to write ONE line into the tailed log; a step holding the launch could restart things
 * between the two readings of the ring and quietly change what "exactly one" was counting.
 */
async function stepOneSound(page: Page, out: AppOutput, append: (at: Date) => void): Promise<void> {
  const before = (await spoken(page)).length
  const fireBefore = fireLines(out, PROBE_NAME)
  append(new Date())

  const ring = await settle(
    () => spoken(page),
    (list) => list.slice(before).some((s) => s.text === PHRASE),
    { timeoutMs: 30_000 }
  ).catch(() => null)
  const heard = ring === null ? [] : ring.slice(before).filter((s) => s.text === PHRASE)
  if (
    !check(
      'a matching LIVE line reaches the speaker — one append, one alert',
      heard.length > 0,
      heard.length === 0 ? `never spoke "${PHRASE}"` : `${String(heard.length)} utterance(s)`
    )
  ) {
    return
  }
  check('…and this channel stayed mute doing it', heard.every((s) => !s.uttered))

  // THE SINGLE-AUDIO BAR. A second publisher's firing lands within milliseconds of the first — the
  // two worlds are reading the same file — but "milliseconds" is not a claim worth resting a
  // regression test on, so the ring is re-read after a real pause. With `alwaysPlay` on this def
  // nothing folds a second sound away, so a count of one is a count of one PUBLISHER.
  await sleep(3_000)
  const after = (await spoken(page)).slice(before).filter((s) => s.text === PHRASE)
  check(
    'EXACTLY ONE SOUND for one matching line — the TS evaluator is silent, not merely coalesced',
    after.length === 1,
    `${String(after.length)} utterance(s) with the throttle off for this def`
  )

  const now = fireLines(out, PROBE_NAME)
  const played = now.played - fireBefore.played
  const logged = now.logged - fireBefore.logged
  check(
    '…and the sound is ENGINE-ATTRIBUTED: the app placed the fire frame and PLAYED it',
    played === 1,
    `${String(played)} played · ${String(logged)} logged-not-played, for "${PROBE_NAME}"`
  )
  // THE DISCRIMINATOR, STATED AS ITS OWN CHECK. `logged, not played` is what an unarmed launch
  // prints — the flag off, the gate refused, or the frame unplaceable against any def — and every
  // one of those worlds still makes exactly one sound, from THIS process's evaluator. Without this
  // line the spec above would be green against the feature being absent.
  check(
    '…and this process made none of it: no fire for this rule was merely logged',
    logged === 0,
    `${String(logged)} fire(s) the app heard and did not play`
  )
}

// ── the run ────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  buildIfStale()
  buildEngineIfStale()

  const launch = await launchOnFixture(FIXTURE)
  const out = tapOutput(launch.app)
  try {
    const page = await mainWindow(launch.app)

    // ── the precondition: both worlds on the same log, the engine's ingest live ────────────────
    // THE READINESS SIGNAL IS THE GO-LIVE SENTENCE NOW (JOS-499). It used to be the parity line,
    // which this spec read for its PRECONDITION rather than for its verdict — and the verdict went
    // with the second world. What it needed is what the new line states: the engine is live on this
    // log and is answering the app’s reads, which is exactly when a fire can happen.
    const serving = await settleServing(out)
    if (
      !check(
        'the engine went live on this log — the fire path’s readiness',
        serving !== null,
        serving?.line ?? 'the app never reported the engine serving'
      )
    ) {
      return
    }

    // ── the probe def, through the app's own door ──────────────────────────────────────────────
    const stored = await saveProbe(page)
    if (!check('the probe alert saves through the app’s own IPC', stored > 0, `${String(stored)} defs stored`)) {
      return
    }
    if (!check('…and the renderer’s player has re-read the def set', await refreshPlayer(page))) return

    // THE DEFINE IS A ROUND TRIP THE SAVE DOES NOT WAIT ON. `pushAppKnowledge` is voided by design
    // (a preference write is answered by the app's own state, never by the engine), so the ack is
    // what says the engine is now holding this def — and appending before it lands would be a race
    // this spec would lose intermittently rather than a claim it could make.
    const defined = await settle(
      () => Promise.resolve(out.text().includes('data-server define: alerts.define')),
      (seen) => seen,
      { timeoutMs: 20_000 }
    ).catch(() => false)
    if (!check('the engine acknowledged the def push', defined)) return

    // ── the two claims: one line in, exactly one sound out, and it is the engine's ─────────────
    await stepOneSound(page, out, (at) => launch.log.appendAt(at, LINE))

    await closeWindows(launch.app)
  } finally {
    await launch.close()
  }

  if (failures.length === 0) {
    note('one live line under EQC_ENGINE_ALERTS=1 produced exactly one sound, and the engine made it')
    note('the app-side evaluator still matched and still spent its cooldown clock — it simply published nothing')
  }
}

await main()
reportRun()
