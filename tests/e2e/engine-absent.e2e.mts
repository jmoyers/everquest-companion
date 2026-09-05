/**
 * NO ENGINE, NO LIES — the contract the deletion release creates (JOS-499 item 11).
 *
 * Until this release "no engine" was a MODE: `EQC_ENGINE=0` selected the app's own TypeScript fold
 * and everything worked, slowly. Owner ruling 12 deleted that fold, so the state has changed
 * character entirely — an app that cannot reach an engine cannot answer, and this spec exists to
 * pin what it does INSTEAD. It is the one behaviour in the program that did not exist before and
 * could not be tested before, which is why it gets a spec of its own rather than a step.
 *
 * ── HOW ABSENCE IS ARRANGED, AND WHY NOT WITH A FLAG ───────────────────────────────────────────
 *
 * There is no flag. `EQC_ENGINE` is deleted, and inventing a test-only one would be a product
 * change to suit a test — the thing `engineHost.ts` refuses for `EQ_E2E`. What a user can actually
 * have is a build with no engine BINARY: a checkout that never ran `cargo build`, a package that
 * shipped without it, a file quarantined by antivirus. `engineBinaryCandidates` derives its whole
 * list from `app.getAppPath()` and `process.cwd()`, so launching with a cwd that has no
 * `engine/target/**` under it leaves the resolver nothing to find. The app then narrates the
 * absence itself and never spawns, which is the real failure verbatim.
 *
 * ── THE FOUR CLAIMS ────────────────────────────────────────────────────────────────────────────
 *
 *   1. IT BOOTS. A window comes up and stays up. This is the floor and it is not rhetorical: the
 *      composition root now calls into a data layer whose every read can answer null, and a null
 *      dereference on the boot path would be a black window rather than an empty one.
 *   2. IT SAYS SO. The app's own dev log names the paths it looked in — `resolveEngineBinary`'s
 *      narration, which exists precisely so that "the feature is off" and "the feature is broken"
 *      are not the same observation.
 *   3. IT INVENTS NOTHING. A module-backed surface draws its EMPTY state, and the assertion that
 *      matters is the negative one: no rows. `module:getSnapshot` answers null with no fold behind
 *      it, `useModule` holds null, and a view that fabricated an empty dataset would be claiming
 *      the player has looted nothing rather than admitting it cannot say. Those two look identical
 *      in a screenshot and are opposite in meaning; what tells them apart is that the app must not
 *      also be reporting a healthy fold.
 *   4. IT DOES NOT CRASH. No uncaught exception, no renderer ErrorBoundary, across a window in
 *      which every one of those null reads has happened many times over.
 *
 *   5. IT SAYS SO ON SCREEN (JOS-503) — and this is the claim the header used to say it was NOT
 *      making. The paragraph it replaces read: "WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT: a
 *      specific 'engine unavailable' string on screen. No such surface was designed in this ticket
 *      … the day a real unavailable state is designed, this is the file it is pinned in." That day
 *      is JOS-503, so it is pinned here. Claims 1–4 remain exactly what they were; this one is
 *      strictly added, because "nothing is fabricated" and "the reason is only in errors.log" were
 *      both true at once and only the first of them was ever acceptable.
 *
 * WHY THE CARD REACHES A WINDOW AT ALL WITH NO ENGINE, since that is the interesting half: it does
 * not travel the engine's own wire (there is none), it travels main's `engine:launch` push — and on
 * this launch the push most likely happens before any window exists to hear it, which is precisely
 * why the renderer also READS the state once on mount. The state that matters here is one that has
 * stopped changing forever, so a push-only channel would have been a channel with nobody on it.
 *
 * Run: `npm run test:e2e -- engine-absent`
 */
import { tmpdir } from 'node:os'
import type { Page } from 'playwright-core'
import { check, dumpArtifacts, failures, note, reportRun, settle, sleep } from './appHarness.mjs'
import { closeWindows, mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
import { engineDescendantsOf, engineTable, tapOutput } from './engineSteps.mjs'

/** The smallest committed log the suite has: nothing here is about what the log SAYS. */
const FIXTURE = 'e2e-telemetry.log'

/** See the header: a cwd with no `engine/target/**` under it is how the resolver finds nothing. */
const NO_ENGINE_CWD = tmpdir()

/**
 * Long enough for every null read to have happened repeatedly.
 *
 * The window hydrates a dozen modules at once and re-asks on every cursor it never receives, so the
 * interesting paths are exercised within the first second; the rest of this is the supervisor's own
 * announce window elapsing without a spawn, which is what claim 1 needs to have survived.
 */
const SETTLE_MS = 8_000

/** The one component the shell owns for this state (JOS-503) and the three controls on it. */
const CARD = '[data-testid="engine-launch-failure"]'
const RETRY = '[data-testid="engine-launch-retry"]'
const REPORT = '[data-testid="engine-launch-report"]'
const LOOKED_IN = '[data-testid="engine-launch-lookedin-toggle"]'

/** Rendered text of the first match; '' when the node is not mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/**
 * CLAIM 5 — the failure is a VISIBLE, GRACEFUL STATE with options, and the words are the product's.
 *
 * BY DOM, NEVER BY A LOG LINE. Claim 2 above exists only because the narration this spec wanted is
 * printed before any tap can attach; that argument does not reach this claim at all, because the
 * card is a thing on a screen and a screen can be read whenever we like.
 *
 * THE SENTENCES ARE THE ONES `tests/engineLaunch.test.mts` PINS, read here from the other end. That
 * suite drives `failureWords` directly and this one reads what the user sees, so prose that drifted
 * in only one of the two places fails in the other rather than passing in both.
 */
async function stepFailureCard(page: Page): Promise<void> {
  const card = await settle(() => textOf(page, CARD), (t) => t !== '')
  if (!check('the app SAYS the engine is missing, on screen, in its own words', card !== '', card || '(no card)')) {
    return
  }
  // The no-binary words. Not a paraphrase: the resolver exhausted its candidate list, so the card
  // must say the program is MISSING rather than that it failed — those are different next moves.
  check(
    '…and names the right failure: it could not FIND the engine, not that it crashed',
    /cannot find its data engine/i.test(card) && /missing from this installation/i.test(card),
    card.replace(/\s+/g, ' ').slice(0, 160)
  )
  // The remedy that matters for this class. A quarantined binary is what "missing from a shipped
  // install" almost always is, and a card that did not say the word would leave the commonest
  // cause of a permanently empty app undiagnosable by its owner.
  check(
    '…and points at antivirus quarantine, which is what a missing shipped binary usually is',
    /antivirus/i.test(card) && /quarantine/i.test(card),
    /antivirus/i.test(card) ? 'named' : 'no remedy offered'
  )
  // AND IT NEVER LIES ABOUT DEGRADED FUNCTION. There is no TypeScript fold behind this any more, so
  // "some features are unavailable" would describe a product that does not exist.
  check(
    '…and admits there is NO data at all, rather than implying a degraded app',
    /cannot read your log at all/i.test(card) && /every panel will stay empty/i.test(card),
    card.replace(/\s+/g, ' ').slice(0, 160)
  )
  // THE OPTIONS. A dead end with an explanation is still a dead end.
  const retry = await textOf(page, RETRY)
  const report = await textOf(page, REPORT)
  check('…and offers a RETRY, because a restored file deserves a button and not a relaunch', retry !== '', retry || 'absent')
  check('…and a way to REPORT it, pre-tagged so triage can find the class', report !== '', report || 'absent')
  // WHERE IT LOOKED. `resolveEngineBinary` has always narrated this to a dev log nobody but a
  // developer reads; the paths are the actionable half of an absence, so they are offered to the
  // person in front of the empty window too — behind a disclosure, because a list of paths is not
  // what a card opens with.
  const paths = await textOf(page, LOOKED_IN)
  check('…and can show WHERE it looked, which is how somebody finds the quarantined file', paths !== '', paths || 'absent')
}

async function main(): Promise<void> {
  const before = engineTable().pids
  const launch = await launchOnFixture(FIXTURE, { cwd: NO_ENGINE_CWD, waitForEngine: false })
  const out = tapOutput(launch.app)
  try {
    // CLAIM 1 — it boots.
    const page = await mainWindow(launch.app)
    await sleep(SETTLE_MS)
    check('the app boots with no engine binary anywhere, and the window is still up', !page.isClosed())

    // …and nothing was spawned, which is what makes every claim below about the absent case.
    const table = engineTable()
    const appPid = launch.app.process().pid ?? -1
    const kin =
      engineDescendantsOf(table, appPid) ?? table.pids.filter((pid) => !before.includes(pid))
    check(
      'no engine process exists — the resolver found nothing, so nothing was spawned',
      kin.length === 0,
      kin.length === 0 ? 'none' : kin.join(', ')
    )

    // CLAIM 2 — it never pretends an engine is there.
    //
    // THIS IS NOT THE CLAIM THE HEADER WANTED, and the difference is a measured property of the
    // pipe rather than a weakening. `resolveEngineBinary` DOES narrate — "engine binary not found;
    // looked in: …" — but it prints through `logInfo`, which is stdout only (`errorLog.ts`: no
    // errors.log record), at supervisor start, which is BEFORE any tap this harness can attach.
    // `engine-boots.e2e.mts`'s header carries the measurement: a tap attached the instant
    // `electron.launch()` resolves has already missed the first line, every time. That spec buys a
    // second line by KILLING the engine; there is no engine here to kill, and making the line
    // durable under EQ_E2E would be a product change to suit a test.
    //
    // SO THE OBSERVABLE HALF IS ASSERTED INSTEAD, and it is the one that would catch a real defect:
    // an app that had somehow got an engine — or thought it had — narrates it constantly
    // (connected, attached, defines, health). Total silence on that channel is what "there is no
    // engine and the app knows it" looks like from here, and it is the same inverted-absence
    // technique step 5 of engine-boots uses at quit.
    check(
      'the app never claims an engine — no connect, no attach, no health, nothing',
      !out.said('data-server engine') && !out.said('data-server client: connected'),
      out.said('data-server engine') ? 'it narrated an engine' : 'silent about any engine'
    )

    // CLAIM 3 — it invents nothing. The renderer mounted and holds no fabricated rows.
    const mounted = await page.evaluate(() => document.querySelector('#root')?.childElementCount ?? 0)
    check('the renderer mounted rather than blanking', mounted > 0, `${String(mounted)} root children`)
    // The one thing a fabricating app would do: report a fold it never made. `replayDone` still
    // marks (the phase is real) but nothing may claim events were folded here.
    check(
      'nothing claims to have folded a log — an app with no engine reports no fold',
      !out.said('This process’s own fold loaded'),
      out.said('This process’s own fold loaded') ? 'it claimed a fold' : 'silent about folding'
    )

    // CLAIM 5 — and it says so, on screen, with something to do about it.
    await stepFailureCard(page)

    // CLAIM 4 — it does not fall over.
    for (const bad of ['main:uncaughtException', 'renderer:ErrorBoundary', 'main:unhandledRejection']) {
      check(`no ${bad} in a window full of unanswerable reads`, !out.said(bad), out.said(bad) ? 'present' : 'clean')
    }

    if (failures.length > 0) await dumpArtifacts(page, 'engine-absent')
    await closeWindows(launch.app)
  } finally {
    await launch.close()
  }

  if (failures.length === 0) {
    note('engine-absent is an HONEST state now, not a fallback: no TS fold answers behind it')
    note('the reads that could not be served are counted and named in the dev log — readShim.ts')
    note('…and since JOS-503 the WINDOW says so too, with a retry, a report path and where it looked')
  }
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
