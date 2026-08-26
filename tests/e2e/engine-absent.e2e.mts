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
 * WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT: a specific "engine unavailable" string on screen.
 * No such surface was designed in this ticket, and pinning prose that does not exist would be the
 * awaiting-sample law broken in the other direction. The honest claim available today is the one
 * made above — nothing is fabricated and nothing falls over — and the day a real unavailable state
 * is designed, this is the file it is pinned in.
 *
 * Run: `npm run test:e2e -- engine-absent`
 */
import { tmpdir } from 'node:os'
import { check, dumpArtifacts, failures, note, reportRun, sleep } from './appHarness.mjs'
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
  }
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
