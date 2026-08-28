/**
 * appWindow.mts — THE APP UNDER TEST: which window is it, and a userData dir to start it from.
 *
 * Two helpers, their own file, because appHarness.mts is at the repo's 400-code-line factoring
 * ceiling and the answer to that is a split, not a widened threshold (the storeMigrations tests'
 * precedent). Both exist for the same reason: the app now opens a SECOND window at startup.
 *
 * WHY IT EXISTS (2026-08-05). `app.firstWindow()` resolves to whichever window Playwright
 * happened to attach to first, and for as long as this harness has existed that was trivially the
 * app: nothing else was open at startup. Then the celebration toast began defaulting to ON, so a
 * fresh launch creates a SECOND window — the transparent toast strip — moments after the first,
 * and the race is real. Specs began failing in a rotating cast of four or five per run, every one
 * of them with the same artifact DOM: `<div id="overlay-root"><div data-testid="toast-overlay">`.
 * Nothing was wrong with the app; the harness was asserting against the wrong window.
 *
 * The fix is to IDENTIFY the window instead of counting on ordering, and to identify it
 * POSITIVELY. `window.eq` is the main window's bridge alone — the overlays get `eqOverlay`, the
 * cursor ring `eqCursor`; three preloads, three worlds — so a page that answers to
 * `eq.getCombatSnapshot` is the app and nothing else can be. Polling covers the other half of the
 * race: at the instant a window appears its preload may not have run yet.
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { ENGINE_BIN, MAIN_ENTRY, ROOT, electronBinary, sleep } from './appHarness.mjs'
import { settleRealLogFold } from './engineSteps.mjs'

/** The MAIN application window. Never `app.firstWindow()` — see the header. */
export async function mainWindow(app: ElectronApplication, timeoutMs = 60_000): Promise<Page> {
  // Still wait on firstWindow first: it is the cheapest "the app started at all" signal, and its
  // timeout is the one that reports a launch failure honestly.
  await app.firstWindow({ timeout: timeoutMs })
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    for (const w of app.windows()) {
      const isMain = await w
        .evaluate(
          () =>
            typeof (window as unknown as { eq?: { getCombatSnapshot?: unknown } }).eq
              ?.getCombatSnapshot === 'function'
        )
        // A window mid-navigation throws on evaluate; it is simply not the answer yet.
        .catch(() => false)
      if (isMain) return w
    }
    await sleep(200)
  }
  throw new Error('e2e: the MAIN window never appeared (no page exposes window.eq)')
}

/**
 * ONE KIND'S OVERLAY WINDOW, identified by the `?kind=` query it was opened with.
 *
 * It lives here for the same reason `mainWindow` does: "which of these windows is the one I mean"
 * is one question, and answering it POSITIVELY — by what the window IS rather than by what order
 * Playwright attached to it — is the rule that stopped this suite asserting against the toast
 * strip. Polling covers the other half of the race: at the instant a window appears its preload
 * may not have run yet, so the BRIDGE is the readiness signal, never the window's existence.
 * `getFightSelection` is on every kind's overlay bridge (the cross-window selection trio), so it
 * is the cheapest such probe and works for a meter, the event log and the toast alike.
 *
 * THE MATCH IS EXACT, NOT A SUBSTRING (JOS-119). It used to be `search.includes('kind=' + kind)`,
 * which was unambiguous only while no kind's id was a suffix of another's. Splitting the timer
 * overlay produced 'buffs' and 'debuffs', and `'?kind=debuffs'.includes('kind=buffs')` is TRUE —
 * so a caller asking for the buffs window could be handed the debuffs one, and every "these two
 * windows are independent" assertion would have passed against a single window. Parse the query.
 */
export async function overlayWindow(
  app: ElectronApplication,
  kind: string,
  timeoutMs = 30_000
): Promise<Page | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    for (const w of app.windows()) {
      const search = await w.evaluate(() => window.location.search).catch(() => '')
      if (new URLSearchParams(search).get('kind') !== kind) continue
      const ready = await w
        .evaluate(
          () =>
            typeof (window as unknown as { eqOverlay?: { getFightSelection?: unknown } }).eqOverlay
              ?.getFightSelection === 'function'
        )
        .catch(() => false)
      if (ready) return w
    }
    await sleep(400)
  }
  return null
}

/**
 * QUIT THE WAY A USER QUITS, which is not the way Playwright does.
 *
 * MEASURED (JOS-57, and it cost a red run to find): `ElectronApplication.close()` calls
 * `app.quit()`, and Electron does NOT emit `window-all-closed` on that path — it closes the windows
 * itself as part of the quit sequence. Every teardown this app hangs off that event (`stopSession`,
 * `stopTelemetry`, `stopPerf`) therefore never runs under the default harness exit, which is why no
 * `sessionEnd` had ever appeared in an e2e ring. Closing the windows and letting the app quit itself
 * is the real user path — clicking the X — and it is the only one under which the last record of a
 * session is written.
 *
 * IT LIVES HERE, beside `launchApp`, rather than in the one spec that first needed it: a lesson
 * this expensive should have exactly one copy, and any spec that asserts about what a session
 * WROTE ON THE WAY OUT needs this exit rather than Playwright's. (It was
 * tests/e2e/telemetry.e2e.mts's private helper first; that spec now imports this one, unchanged.)
 *
 * Best effort on both halves: a launch that has already gone is not an error here, and the caller's
 * own `close()` still runs afterwards (it swallows "already closed").
 */
export async function closeWindows(app: ElectronApplication): Promise<void> {
  const exited = app.waitForEvent('close').catch(() => undefined)
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close()
    })
    .catch(() => undefined)
  await exited
}

/**
 * THE ISOLATION UNIT IS ONE LAUNCH.
 *
 * It used to be one CHECKOUT: a single `userData` dir keyed by a hash of the repo root, shared by
 * every spec, every launch and every rerun — and every spec began by `rmSync`-ing it. That is not
 * a slow suite, it is a WRONG one. Two specs (or two runs) overlapping meant one deleting the
 * store the other was mid-way through asserting about, and on Windows the delete itself EPERMs
 * against a neighbour's still-closing window, taking the specs after it down as well.
 *
 * A dir per launch removes the reason for both. Nothing is ever wiped out from under a live
 * process, because nothing is ever shared with one: `mkdtempSync` hands out a name no other
 * launch has, "fresh install" is what a new dir already means, and cleanup is a delete of a dir
 * whose only user has just exited.
 */
const USER_DATA_PREFIX = 'everquest-companion-e2e-'

/** A userData dir the CALLER owns — for the specs whose assertion spans two launches. */
export function makeUserData(): string {
  return mkdtempSync(join(tmpdir(), USER_DATA_PREFIX))
}

/**
 * Best-effort delete, never fatal. `app.close()` resolves when Electron says the app is gone, but
 * Windows releases the handles a beat later (and a second window is a second set of them), so a
 * few short retries turn the common case into a clean delete. A dir that outlives them all is
 * litter in the OS temp dir, not a test result — the runner's reaper collects it later, and
 * failing a green spec over it would be reporting the harness's own timing as the app's bug.
 */
export async function removeUserData(dir: string, attempts = 8, waitMs = 250): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (i >= attempts) {
        console.log(`note: could not remove ${dir} — ${String(err)} (reaped on a later run)`)
        return
      }
      await sleep(waitMs)
    }
  }
}

/**
 * Collect e2e userData dirs left behind by runs that were killed before they could clean up.
 * By AGE only, and by a name no other tool writes: a dir younger than the cutoff may belong to a
 * spec running right now in another process, and this must never be the thing that deletes it.
 */
export function reapOrphanUserData(maxAgeMs = 86_400_000): number {
  const now = Date.now()
  let reaped = 0
  let entries: string[] = []
  try {
    entries = readdirSync(tmpdir())
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!name.startsWith(USER_DATA_PREFIX)) continue
    const dir = join(tmpdir(), name)
    try {
      if (now - statSync(dir).mtimeMs < maxAgeMs) continue
      rmSync(dir, { recursive: true, force: true })
      reaped += 1
    } catch {
      // Locked or already gone; the next run tries again.
    }
  }
  return reaped
}

/**
 * THE SUITE MAKES NO NOISE (JOS-443, reported live: e2e runs were audibly playing alert tones on
 * the owner's desktop while he worked).
 *
 * `--mute-audio` is Chromium's own switch and it silences the OUTPUT, not the code: every
 * `new Audio()` is still constructed, `play()` still resolves or rejects exactly as it would, the
 * element still advances, and speech still travels its seam — so every spec that asserts about
 * audio BEHAVIOUR (voice-alerts' spoken lines, the preview steps in alert-banner and voice-alerts)
 * asserts precisely what it did before. Nothing in this suite has ever asserted that a sound was
 * AUDIBLE; it cannot, on a hidden window on a CI box.
 *
 * IT IS A LAUNCH ARGUMENT RATHER THAN AN EQ_E2E BRANCH IN MAIN on purpose. Muting is a property of
 * the harness's own launches, not of the product — a `commandLine.appendSwitch` under the test flag
 * would put a behaviour change inside the thing under test, and `EQ_E2E` is deliberately a mode
 * that changes as little as possible (src/main/e2e.ts lists what it changes and why). Passing it
 * here also covers every window this launch ever opens, overlays included, because the switch is
 * process-wide.
 *
 * The mixer slider it protects is the owner's: this must hold whatever state that slider is in,
 * which is exactly why it is not "the machine happens to be quiet".
 */
const MUTE_ARGS = ['--mute-audio']

/**
 * The second half of the same promise, belt and braces: mute every window's WebContents too.
 *
 * WHY BOTH. The switch is process-wide and is the one that cannot be missed, but it is a Chromium
 * command-line flag — invisible from the app, and nothing in a test can read back that it took.
 * `webContents.setAudioMuted(true)` is the half that ANSWERS: `isAudioMuted()` is a fact a spec (or
 * a person debugging this) can read. Installed on `browser-window-created` as well as over the
 * windows that already exist, because the overlays, the toast strip and the cursor ring are all
 * opened after the launch resolves and every one of them is a renderer that could play something.
 *
 * Best effort by design: a launch that dies before this lands is a launch whose spec is about to
 * fail on its own terms, and silencing that failure behind a mute error would be the worse report.
 */
async function muteEveryWindow(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp, BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.setAudioMuted(true)
      electronApp.on('browser-window-created', (_e, w) => {
        w.webContents.setAudioMuted(true)
      })
    })
    .catch(() => undefined)
}

/**
 * THE SUITE RUNS ENGINE-ON, AND THAT IS THE DEFAULT (JOS-490).
 *
 * `EQC_ENGINE=1` spawns the real Rust engine beside the app; `EQC_ENGINE_SERVE=1` lets it ANSWER
 * three of the app's own read IPCs (`src/main/dataServer/serveShim.ts` — `module:getSnapshot`,
 * `combat:snapshot`, `combat:searchFights`). Every spec in this suite asserts through `window.eq`,
 * so with both flags on every one of them is now a regression proof for the cutover: the same
 * assertions, against answers that came out of the engine.
 *
 * IT IS THE HARNESS'S DEFAULT RATHER THAN A PER-SPEC OPT-IN because an opt-in proves the specs that
 * remembered. The deletion release rests on the claim that the engine's answers are the app's
 * answers EVERYWHERE, and a claim of that shape is only worth what its least-remembered surface is
 * worth. A spec added tomorrow gets the engine without its author having to know this file exists.
 *
 * AND THE ABSENCE CONTRACT SURVIVES, INVERTED. `engine-absent.e2e.mts` asserts what a launch with
 * no engine looks like, and it says so with `cwd` below rather than with a flag — which is a better
 * instrument than the flag it replaced, because it asks the PRODUCT'S own question.
 *
 * THE PRODUCT IS UNCHANGED BY ANY OF THIS. `EQ_E2E` is deliberately not a gate on the engine; the
 * harness only says WHICH binary to run (`EQ_ENGINE_BIN`, JOS-501), never whether one runs.
 */
// `ENGINE_ON` STOOD HERE AND IS GONE (JOS-499). It set `EQC_ENGINE=1` and `EQC_ENGINE_SERVE=1`
// on every launch so the whole suite ran against the engine. Both flags are deleted from the
// product — there is no other world to select — so setting them would be the harness naming
// variables nothing reads, which is worse than naming nothing at all.
//
// `ENGINE_OFF` STOOD BESIDE IT AND WENT WITH IT, and its contract did NOT — it moved to `cwd`
// below. `EQC_ENGINE=0` tested a gate; there is no gate. What a user can actually have is a build
// with no engine BINARY (a checkout that never ran `cargo build`, a package that shipped without
// it, a file quarantined by AV), and that is what `tests/e2e/engine-absent.e2e.mts` arranges.
//
// JOS-501 removed the last two paragraphs that stood here, which still told a reader that
// `ENGINE_OFF` was NAMED below and that both flag lines STAY. Neither had been true since JOS-499,
// and a tombstone that contradicts the tombstone above it is worse than no tombstone at all.

/** A launched app, its userData dir, and the teardown that matches how the dir was obtained. */
export interface LaunchedApp {
  readonly app: ElectronApplication
  /** Where this launch's store, image cache and perf profile live — read it after `close()`. */
  readonly userData: string
  /** Quit the app, then delete the dir IF this launch created it. */
  close(): Promise<void>
}

/**
 * Launch the app under test on a userData dir of its own.
 *
 * Pass `userData` only when the assertion is ABOUT the dir surviving the process — telemetry's
 * restart, overlay-sync's persisted overlay state. Such a caller owns the dir's lifetime
 * (`makeUserData()` / `removeUserData()`); `close()` here will not delete what it did not create.
 *
 * Pass `installDir` to point the app at a STAGED EQ install instead of the machine's own — the
 * per-spec fixture logs (tests/e2e/logFixture.mts, wave E2). It is set as `EQ_INSTALL_DIR`, which
 * `src/main/log/config.ts` consults FIRST, ahead of the registry and the drive sweep; when it is
 * absent the variable is DELETED from the child's environment rather than inherited, so a shell
 * that happens to export one can never silently redirect a spec that did not ask for it.
 *
 * Pass `env` only when the assertion is ABOUT a launch-time environment the app reads before it
 * can be driven — `EQ_DISABLE_GPU`, whose whole point is that it is decided before Electron is
 * ready and therefore cannot be flipped through any bridge (JOS-40). It is merged LAST, so a
 * spec can override the harness's own variables deliberately rather than by accident.
 */
export async function launchApp(
  opts: {
    userData?: string
    installDir?: string
    env?: Record<string, string>
    /**
     * THE WORKING DIRECTORY, AND THEREFORE WHETHER AN ENGINE BINARY CAN BE FOUND (JOS-499).
     *
     * `engineBinaryCandidates` builds its list from `app.getAppPath()` and `process.cwd()`, so a
     * launch whose cwd is a directory with no `engine/target/**` under it — and whose appPath is
     * the built `out/main`, which has none either — resolves NO binary. That is the app's own
     * resolution path answering honestly, rather than a flag telling it to pretend.
     *
     * Defaults to ROOT, which is every other spec in the suite.
     */
    cwd?: string
  } = {}
): Promise<LaunchedApp> {
  const owned = opts.userData === undefined
  const userData = opts.userData ?? makeUserData()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EQ_E2E: '1',
    EQ_E2E_USER_DATA: userData,
    NODE_ENV: 'production',
  }
  if (opts.installDir !== undefined) env.EQ_INSTALL_DIR = opts.installDir
  else delete env.EQ_INSTALL_DIR
  // THE ENGINE THE HARNESS BUILT, NAMED OUTRIGHT (JOS-501). `buildEngineIfStale` builds RELEASE,
  // and the suite must assert against the binary it paid for rather than against whatever the
  // resolver's default order happens to be. Same standing as EQ_INSTALL_DIR above: the harness owns
  // the artifact and hands it over, and `engineHost.ts` reads it only under EQ_E2E=1.
  //
  // THE ORDER IT USED TO DEFEND IS GONE (JOS-520): the app's resolver preferred DEBUG, so a machine
  // holding both binaries would answer this suite with the one it did not build — and answered the
  // OWNER'S DEV APP the same way after a `cargo test`, which is the incident that changed it. Debug
  // is now an explicit per-launch opt-in (`EQC_ENGINE_PROFILE`) that this harness never sets, so
  // naming the path is belt-and-braces rather than the only defence. It stays for the reason above.
  //
  // NOT WHEN THE SPEC MOVED `cwd`, and that exemption is the whole of `engine-absent.e2e.mts`: a
  // launch that relocates its working directory is deliberately asking the RESOLVER'S OWN question
  // ("is there a binary anywhere I look?"), and naming one outright would answer it for them with a
  // path that exists. A spec arranging absence must keep getting absence.
  if (opts.cwd === undefined) env.EQ_ENGINE_BIN = ENGINE_BIN
  else delete env.EQ_ENGINE_BIN
  // The other override `config.ts` honours: a bare log PATH. A staged install must not be
  // second-guessed by one left in the ambient environment.
  delete env.EQ_LOG_PATH
  // The owner's machine sets EQ_OWNER_TOOLS=1 user-wide (their installed copy's opt-in), which
  // made feedback.e2e's default-state assertions fail in every local full run. The suite tests
  // the DEFAULT; the one spec that wants the opt-in names it in opts.env below, which outranks
  // this delete.
  delete env.EQ_OWNER_TOOLS
  // LAST, deliberately: a spec that names a variable outranks the harness's own defaults.
  Object.assign(env, opts.env ?? {})
  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [MAIN_ENTRY, ...MUTE_ARGS],
    cwd: opts.cwd ?? ROOT,
    env,
    timeout: 60_000
  })
  await muteEveryWindow(app)
  return {
    app,
    userData,
    close: async (): Promise<void> => {
      await app.close().catch(() => undefined)
      if (owned) await removeUserData(userData)
    }
  }
}

/**
 * LAUNCH ON THE MACHINE'S REAL EQ INSTALL, and do not come back until the fold has landed.
 *
 * The counterpart of `logFixture.launchOnFixture`, which has waited for the engine since JOS-499
 * and states the reason there: every served surface shows a loading state until the fold is live,
 * so a harness that asserted through it would be testing a frame the product never means anybody to
 * act on. A REAL-INSTALL launch needs that wait MORE, not less — the fixture folds a few megabytes
 * and this folds the owner's entire log, measured at 52.5 s under the release engine (JOS-501).
 *
 * `bosses-week` was the one spec launching this way, and it did the wait by hand — which is to say
 * not at all: it settled on a card count through a 30 s per-step cap that knew nothing about a
 * whole-log fold, and read an empty roster. The asymmetry was never intentional; `launchOnFixture`
 * is simply where the staging lives, and a real-install launch had no such home. This is that home.
 */
export async function launchOnRealInstall(
  opts: Parameters<typeof launchApp>[0],
  label: string
): Promise<LaunchedApp> {
  const launched = await launchApp(opts)
  await settleRealLogFold(launched.app, label)
  return launched
}
