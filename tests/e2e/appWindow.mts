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
import { MAIN_ENTRY, ROOT, electronBinary, sleep } from './appHarness.mjs'

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
  opts: { userData?: string; installDir?: string; env?: Record<string, string> } = {}
): Promise<LaunchedApp> {
  const owned = opts.userData === undefined
  const userData = opts.userData ?? makeUserData()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EQ_E2E: '1',
    EQ_E2E_USER_DATA: userData,
    NODE_ENV: 'production'
  }
  if (opts.installDir !== undefined) env.EQ_INSTALL_DIR = opts.installDir
  else delete env.EQ_INSTALL_DIR
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
    args: [MAIN_ENTRY],
    cwd: ROOT,
    env,
    timeout: 60_000
  })
  return {
    app,
    userData,
    close: async (): Promise<void> => {
      await app.close().catch(() => undefined)
      if (owned) await removeUserData(userData)
    }
  }
}
