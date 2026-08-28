/**
 * Headless Electron integration test for PERFORMANCE PROFILING (docs/plans/perf-profiling.md, P7).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: every claim this feature makes is a SEAM.
 *   - "the chip is absent by default" is a claim about a fresh install's store, an IPC handler,
 *     a push channel that stays silent, and a component that renders null. Only the real app
 *     can show that nothing appears.
 *   - "it appears once you enable it" crosses the Preferences pane, a store write, a sampler
 *     that must START in the same call (not on the next launch), `app.getAppMetrics()`, and a
 *     push. A mocked version of that would be asserting the mock.
 *   - "the popover renders NUMBERS" is the whole point of a HUD, and the numbers come from
 *     Electron's own metrics — there is nowhere else to get them.
 *   - "every launch leaves a startup profile with monotonic phases" is a claim about a FILE
 *     written by a real boot, so it is read off disk, from the userData dir this run used.
 *
 * Identities only, never today's numbers: memory is asserted to be positive and phases to be
 * ordered, never to equal a figure that depends on the machine this ran on.
 *
 * Run: `node --import tsx tests/e2e/perf.e2e.mts` (it is also in tests/e2e/run-all.mts).
 */
import type { ElectronApplication, Page } from 'playwright-core'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MAIN_ENTRY,
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleGone,
  settleStable
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'
// The file half of this spec lives beside it (see that module's header).
import { stepProfileFile } from './perfProfileSteps.mjs'

const CHIP = '[data-testid="perf-chip"]'
const POPOVER = '[data-testid="perf-popover"]'
const PANE = '[data-testid="pref-perf"]'
const SWITCH = '[data-testid="pref-perf-enabled"] input'
const BREAKDOWN = '[data-testid="perf-startup"]'
const YIELD_SWITCH = '[data-testid="pref-yield-enabled"] input'
/** The sampler pushes every 2 s and emits one immediately on start; be generous anyway. */
const SAMPLE_WAIT_MS = 6_000
/** A full historical scan of a months-old live log takes seconds; be generous, fail loudly. */
const REPLAY_WAIT_MS = 300_000
/** Tags the two console messages this spec prints on purpose (JOS-99), so they can be found in
 *  errors.log and told apart from the run's own noise. */
const CONSOLE_MARK = 'JOS99-PROBE'


function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector
  )
}

/**
 * Answer the analytics first-run notice, which a FRESH userData always shows (usage-analytics
 * T1) and which sits over the whole window until it is answered. "Turn it off" keeps this run
 * quiet — nothing about performance depends on analytics, and a spec should not leave a second
 * feature collecting in the background while it measures a third.
 */
async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  check('the analytics first-run notice can be answered out of the way', await settleGone(page, notice, { timeoutMs: 8_000 }))
}

/** THE DEFAULT-OFF ASSERTION. The HUD costs a metrics poll and a 500 ms probe; a user who never
 *  asked for one must not be paying for it, and must not see it either. */
async function stepAbsentByDefault(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
  // AN ABSENCE ASSERTION NEEDS A POSITIVE SIGNAL FIRST. The chip is pushed by a sampler that
  // starts on a store read, so "it is not there" only means something once the title bar has
  // stopped changing — a settled count of 0 says that, where a flat 1500ms only hoped it.
  const chips = await settleStable(() => countOf(page, CHIP), { timeoutMs: 8_000, stable: 6, pollMs: 150 })
  check('the performance chip is absent on a fresh install — the HUD is opt-in', chips === 0, `${String(chips)} chip(s)`)
  const prefs = await page.evaluate(() =>
    (window as unknown as { eq: { getPerfPrefs: () => Promise<{ enabled: boolean }> } }).eq.getPerfPrefs()
  )
  check('…and the stored switch says so', prefs.enabled === false, JSON.stringify(prefs))
}

/** Enabling from Preferences must take effect NOW: the sampler starts in the same call. */
async function stepEnable(page: Page): Promise<boolean> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 30_000 })
  await page.click('[data-testid="prefs-rail-performance"]', { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
  check('Preferences has a Performance section', (await countOf(page, PANE)) === 1)

  const before = await page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked,
    SWITCH
  )
  check('the switch reflects the stored answer (off)', before === false, String(before))

  await page.click(SWITCH)
  try {
    await page.waitForSelector(CHIP, { timeout: SAMPLE_WAIT_MS })
  } catch {
    // fall through to the check below, which reports it as a failure with the DOM dumped
  }
  return check(
    'enabling it puts the live chip in the title bar, without a relaunch',
    (await countOf(page, CHIP)) === 1
  )
}

/** The chip's own text is the compact contract: `CPU 12% · 480 MB`. */
async function stepChipReadsNumbers(page: Page): Promise<void> {
  const text = (await textOf(page, CHIP)).replace(/\s+/g, ' ').trim()
  check(
    'the chip states CPU% and memory in the app’s own vocabulary',
    /CPU\s+\d+%/.test(text) && /\d+(\.\d+)?\s*(MB|GB)/.test(text),
    text || 'no chip text'
  )
}

/** The popover: the per-process table, the lag figures the colour came from, and the sparkline. */
async function stepPopover(page: Page): Promise<void> {
  await page.click(CHIP)
  await page.waitForSelector(POPOVER, { timeout: 15_000 })
  const text = (await textOf(page, POPOVER)).replace(/\s+/g, ' ').trim()

  check(
    'the popover breaks the total down by process type, with real numbers',
    /\bmain\b/.test(text) && /\brenderer\b/.test(text) && /\d+%/.test(text) && /\d+\s*(MB|GB)/.test(text),
    text.slice(0, 160)
  )
  check(
    '…states how far behind the event loop is running (the figure the colour comes from)',
    /event loop/i.test(text) && /(\d+\s*(ms|s)|not measured yet)/.test(text),
    text.slice(0, 160)
  )
  check('…counts the renderer’s own long tasks', /long tasks/i.test(text))
  // THE DEV-ONLY HALF, PROVEN BY ITS ABSENCE (JOS-513). This spec runs a production-shaped build
  // (`buildIfStale` → `electron-vite build`, where `import.meta.env.DEV` is a literal `false`), so
  // the render meter's whole story — no Profiler in the tree, no ring, no poll, no row — is exactly
  // what an installed app does. In a dev window this section is present and reads commits/second;
  // here it must not exist at all, and only a real build can say that.
  check(
    '…and the dev-only render-commit rows are ABSENT from a production build of the same popover',
    (await countOf(page, '[data-testid="perf-render"]')) === 0
  )
  check(
    '…and draws the last two minutes as a sparkline with a real path',
    (await page.evaluate(
      () =>
        (document.querySelector('[data-testid="perf-sparkline"] polyline') as SVGPolylineElement | null)
          ?.getAttribute('points')?.length ?? 0
    )) > 0
  )
  await page.keyboard.press('Escape')
  await settleGone(page, POPOVER, { timeoutMs: 8_000 })
}

/**
 * THE RENDER METER IS NOT IN THE BYTES (JOS-513) — the strip, proven by grep rather than by intent.
 *
 * The step above shows the section is not on screen; this one shows there is nothing to show. They
 * are different claims and the difference is the one this repo has been burned by before: a
 * dev-only feature can be perfectly hidden and still be compiled into every installer (the triage
 * tab's first build shipped 917 kB of AWS SDK behind a boolean — AGENTS.md's "a dynamic import() is
 * BUNDLED, not externalized"). It cost this ticket one measurement to learn the same lesson in a
 * smaller way: gating on an IMPORTED constant left the whole meter in `index-*.js`, because rollup
 * does not fold a cross-module constant. `import.meta.env.DEV`, substituted per module at transform
 * time, does.
 *
 * `.js` only, deliberately: a sourcemap is a copy of the SOURCE and carries every string in it, so
 * asserting over `.map` files would assert that the build ships no sourcemaps — a different claim,
 * and not this one's business.
 */
function stepMeterStrippedFromBuild(): void {
  const assets = join(dirname(MAIN_ENTRY), '..', 'renderer', 'assets')
  const bundles = readdirSync(assets).filter((f) => f.endsWith('.js'))
  const carrying = bundles.filter((f) => readFileSync(join(assets, f), 'utf8').includes('perf-render'))
  check(
    'the dev-only render meter is not merely hidden in a build — it is not in the bytes',
    bundles.length > 0 && carrying.length === 0,
    `${String(bundles.length)} renderer bundle(s); carrying the meter: ${carrying.join(', ') || 'none'}`
  )
}

/** How this spec reads the stored "yield CPU to the game" answer, from inside the running app. */
function storedYield(page: Page): Promise<{ yieldToGame: boolean }> {
  return page.evaluate(() =>
    (
      window as unknown as { eq: { getProcessPriority: () => Promise<{ yieldToGame: boolean }> } }
    ).eq.getProcessPriority()
  )
}

/**
 * "Yield CPU to the game" (JOS-366) — the ONE targeted step this feature earns here.
 *
 * WHAT IT CAN AND CANNOT ASSERT. The mechanism itself is a deliberate no-op under EQ_E2E (an
 * integration test must not reprioritise the machine running it), so this step is about the SEAM
 * the setting lives on and nothing else: the toggle exists, it paints the shipped default without
 * a flash, and a change survives into the next launch. The priority classes themselves are unit
 * work over a stubbed `os` (tests/processPriority.test.mts) and, in the end, Task Manager.
 *
 * IT TURNS THE SETTING OFF, which is the direction that proves something: `false` is the value a
 * default cannot produce, so a second launch reading `false` can only have read the file.
 */
async function stepYieldToGame(page: Page): Promise<void> {
  await page.waitForSelector(YIELD_SWITCH, { timeout: 15_000 })
  const shown = await page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked,
    YIELD_SWITCH
  )
  check('Performance offers the game-priority switch, ON as shipped', shown === true, String(shown))
  check('…and the stored answer agrees', (await storedYield(page)).yieldToGame === true)

  await page.click(YIELD_SWITCH)
  const stored = await settle(() => storedYield(page), (p) => !p.yieldToGame, { timeoutMs: 8_000 })
  check('turning it off is stored immediately, not at the next launch', stored.yieldToGame === false)
}

/**
 * Wait for the historical replay to finish. `hydrating` is the combat engine's own answer to
 * exactly that question (it stays true until `setLive()`, which is the statement immediately after
 * the scan returns), so this asks the app rather than sleeping at it.
 */
async function waitForReplay(page: Page): Promise<boolean> {
  const read = (): Promise<{ hydrating: boolean } | null> =>
    page
      .evaluate(() =>
        (
          window as unknown as { eq: { getCombatSnapshot: (o: unknown) => Promise<{ hydrating: boolean }> } }
        ).eq.getCombatSnapshot({})
      )
      .catch(() => null)
  const snap = await settle(read, (s) => s !== null && !s.hydrating, { timeoutMs: REPLAY_WAIT_MS })
  return snap !== null && !snap.hydrating
}

/** The startup breakdown in Preferences — the half that is recorded whether the HUD is on or not. */
async function stepStartupPane(page: Page): Promise<void> {
  // The pane reads the profile SO FAR, ONCE, when it mounts — and on a real log the historical
  // replay is still folding ten seconds into a launch. So "names every phase" is a claim about the
  // pane's VOCABULARY that can only be made after the last phase has landed AND the pane has been
  // mounted since. Wait for the replay, then remount by leaving the tab and coming back. Before
  // this the assertion passed on the strength of the replay beating the spec's own click sequence,
  // which is luck rather than a test — and chunked replay's ~7% throughput cost was enough to run
  // it out (measured: the pane showed 7 of 8 phases, twice in a row).
  check('the historical replay finishes within the spec’s patience', await waitForReplay(page))
  await page.click('[data-testid="nav-overview"]', { timeout: 30_000 })
  // The REMOUNT is the point of the round trip, so the condition is the Performance pane actually
  // leaving before we come back to it.
  await settleGone(page, PANE, { timeoutMs: 15_000 })
  await page.click('[data-testid="nav-preferences"]', { timeout: 30_000 })
  await page.click('[data-testid="prefs-rail-performance"]', { timeout: 15_000 })
  await page.waitForSelector(BREAKDOWN, { timeout: 15_000 })
  const text = (await textOf(page, BREAKDOWN)).replace(/\s+/g, ' ').trim()
  check(
    'Preferences shows the last startup as a per-phase breakdown with a total',
    /Last startup:/.test(text) && /(\d+(\.\d+)?\s*(ms|s))/.test(text),
    text.slice(0, 140)
  )
  check(
    '…names every phase of the boot it describes',
    /Settings loaded/.test(text) && /Log history replayed/.test(text) && /Interface drawn/.test(text),
    text.slice(0, 200)
  )
}

/**
 * WHAT A RELOAD AND A WARNING COST IN errors.log — JOS-99, asserted against the bytes a real
 * launch wrote.
 *
 * This is the half no unit test can reach. Both mechanisms are seams: one is an IPC handler
 * answering a message that only a re-mounted renderer sends, the other is a `webContents`
 * listener reading `app.isPackaged`. The fleet reading that produced the ticket — 3,859
 * `mainErrorLogLines` over 3,728 reports with zero renderer crashes — was made of exactly these
 * two, and only a real window reloading and a real `console.warn` can show they are gone.
 *
 * ORDERING IS WHAT MAKES THE ABSENCES SOUND, not a sleep: the reload happens first, then the
 * warning, then the error — all on the same ordered console channel — so once the ERROR line has
 * appeared in the file, everything before it has already been through the same code. A settle on
 * the error line is therefore also the wait for the two absences.
 */
async function stepReloadIsNotAnError(page: Page, userData: string): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
  check('the window survives a reload (the crash-recovery / dev-watch path)', true)

  // A warning, then an error, from the real renderer console.
  await page.evaluate(
    (m) => {
      console.warn(`${m}-WARNING a component grumbled`)
      console.error(`${m}-ERROR something actually broke`)
    },
    CONSOLE_MARK
  )

  const path = join(userData, 'errors.log')
  const readLog = (): Promise<string> => {
    try {
      return Promise.resolve(readFileSync(path, 'utf8'))
    } catch {
      return Promise.resolve('')
    }
  }
  const log = await settle(readLog, (t) => t.includes(`${CONSOLE_MARK}-ERROR`), { timeoutMs: 20_000 })

  check(
    'a renderer console.error still reaches errors.log — the file has not gone quiet',
    log.includes(`${CONSOLE_MARK}-ERROR`),
    `${String(log.length)} bytes of log`
  )
  check(
    '…but a console.warn does NOT: a warning is not an error and is not counted as one',
    !log.includes(`${CONSOLE_MARK}-WARNING`),
    log.split(/\r?\n/).filter((l) => l.includes(CONSOLE_MARK)).join(' | ')
  )
  check(
    'and the reload costs NO error line — a re-sent rendererHydrated mark is expected, not a bug',
    !/was marked twice/.test(log),
    log.split(/\r?\n/).filter((l) => /marked twice/.test(l)).slice(0, 2).join(' | ')
  )
}

/**
 * QUIT THE WAY A USER QUITS, which is not the way Playwright does — the argument (and the
 * measurement behind it) is `tests/e2e/telemetry.e2e.mts closeWindows`, restated in one sentence:
 * `ElectronApplication.close()` calls `app.quit()`, Electron does not emit `window-all-closed` on
 * that path, and every teardown this app hangs off that event therefore never runs.
 *
 * This spec needs the real path because the SECOND launch below measures itself against a mark the
 * first one writes on its way out (JOS-57 scope addition).
 */
async function closeWindows(app: ElectronApplication): Promise<void> {
  const exited = app.waitForEvent('close').catch(() => undefined)
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close()
    })
    .catch(() => undefined)
  await exited
}

/**
 * THE SECOND LAUNCH, on the SAME userData and the SAME staged log — the only way the cold-read
 * delta means anything, because the whole claim is that one process left something behind that the
 * next one could read. It does no UI work: it boots, folds, and quits by the window path again.
 */
async function stepSecondLaunch(log: FixtureLog, userData: string, errors: string[]): Promise<void> {
  console.log('launch 2: same userData, same log — does the cold-read delta appear…')
  const { app, close } = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(app)
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes(CONSOLE_MARK)) errors.push(m.text())
    })
    // The profile is written when the last phase lands, and `rendererHydrated` is that phase on a
    // fixture this small — so wait for the window to be usable before quitting, or the file this
    // asserts against would be the incomplete flush instead.
    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    // …and the other thing a second launch on the same userData is the only proof of: the
    // game-priority switch the first launch turned off is still off. `false` is not a value any
    // default can produce here (the setting ships ON), so this can only have come off disk.
    check(
      'the game-priority switch survives a relaunch, off as the last launch left it',
      (await storedYield(page)).yieldToGame === false
    )
    await closeWindows(app)
  } finally {
    await close()
  }
}

async function main(): Promise<void> {
  buildIfStale()
  // A dir this spec OWNS, because the last assertion reads a file out of it AFTER the app that
  // wrote it has exited — `launchApp()`'s own dir is deleted on close, which is exactly right for
  // every spec that has no such reading to do. (Brand-new either way: "absent by default" is only
  // meaningful on a genuinely fresh install.)
  const userData = makeUserData()
  // …and a staged log this spec owns too, so BOTH launches tail the same bytes. A fresh staging per
  // launch would still work by content, but the second launch's delta would then be a statement
  // about two copies rather than about one file that outlived a process.
  const log = stageFixture('e2e-perf.log')

  console.log('launch: hidden Electron (EQ_E2E=1), fresh userData — Performance spec…')
  const { app, close } = await launchOnFixture(log, { userData })
  let page: Page | null = null
  const consoleErrors: string[] = []
  try {
    page = await mainWindow(app)
    page.on('console', (m) => {
      // The one console.error this spec prints ON PURPOSE (JOS-99's positive control) is excluded
      // by its marker rather than by loosening the check — every other error still fails the run.
      if (m.type() === 'error' && !m.text().includes(CONSOLE_MARK)) consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await dismissFirstRunNotice(page)
    await stepAbsentByDefault(page)
    if (await stepEnable(page)) {
      await stepChipReadsNumbers(page)
      await stepPopover(page)
    }
    // A file check rather than a page one, and it reads the very build this launch is running.
    stepMeterStrippedFromBuild()
    // Same section, same pane, already open — so this costs a click rather than a navigation.
    await stepYieldToGame(page)
    await stepStartupPane(page)
    // LAST, because it reloads the window: everything above measures the launch that is already
    // running, and a reload would put those steps' subjects back through a fresh mount.
    await stepReloadIsNotAnError(page, userData)
    if (failures.length) await dumpArtifacts(page, 'perf-FAIL')
    // Quit by closing the windows, so the teardown that leaves the tail mark actually runs.
    await closeWindows(app)
  } finally {
    await close()
  }

  // Read the file AFTER the app has quit: the profile is written when the last phase lands, and
  // a quit-time flush covers a launch that never got there.
  stepProfileFile(userData, true)
  await stepSecondLaunch(log, userData, consoleErrors)
  stepProfileFile(userData, false)
  await log.dispose()
  await removeUserData(userData)

  // A missing IPC handler shows up here first (`invoke` rejects into an unhandled rejection).
  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (consoleErrors.length === 0) {
    note('the chip, the popover and the startup file all came from one real boot of the app')
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
