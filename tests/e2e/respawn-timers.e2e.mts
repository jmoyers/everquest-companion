/**
 * Headless Electron smoke test for RESPAWN CLOCKS (JOS-194).
 *
 * WHAT ONLY THE REAL APP CAN SHOW. The ladder, the gap rules and the fold are pinned over the
 * committed `wl40-farm-run.log` in tests/respawnTimers.test.mts, and the wiki grammar over its own
 * verbatim table in tests/respawnWiki.test.mts. None of those can claim THE PIECES ARE WIRED — that
 * a death message arriving in the LIVE log travels the entire real path (chokidar → Tailer →
 * parseEvent → RespawnModule → registry flush → `module:delta` → React) and comes out as a
 * countdown; that clicking Watch on a mob you just killed writes the store, reaches the running
 * module and produces a row from the kill ALREADY FOLDED rather than arming the next one; or that
 * the floating window receives the same fold in a second renderer.
 *
 * THE PLAYED LINES ARE THE SUBJECT, and they are played rather than borrowed because
 * e2e-leveling.log's own kills are days old — every clock they would start has been due for days
 * and `RESPAWN_LINGER_MS` has correctly swept it away. So a row appearing here can only have come
 * down the live path. Both names and the sentence shape are real: `a frenzied ghoul` and
 * `a wan ghoul knight` both appear in committed fixtures, and the first is one of the 394 mobs the
 * committed wiki floor states a duration for (9.5 min) while the second is one of the thousands it
 * says nothing about — which is exactly the two arms this feature has.
 *
 * DEFAULT OFF for the window, and every launch here gets a fresh userData dir — so this spec is
 * always a first run, which makes it the one place that can prove what a new install gets.
 *
 * NO WINDOW IS EVER SHOWN (`EQ_E2E=1`, src/main/e2e.ts). The MAIN window is a real page and is
 * clicked; the OVERLAY is always-on-top and hidden, so it is read rather than clicked.
 *
 * WAIT FOR THE CONDITION, NEVER FOR THE CLOCK (wave E3): every read below goes through `settle`.
 *
 * Run: `npm run test:e2e -- respawn`.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import { buildIfStale, check, countOf, dumpArtifacts, failures, reportRun, settle } from './appHarness.mjs'
import { mainWindow, overlayWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'

/** A mob the committed wiki floor states a duration for: `9.5 min` → 570 s. */
const WIKI_MOB = 'a frenzied ghoul'
/** A mob it says nothing about — the 85 % case in the dungeons this ticket targets. */
const OWN_MOB = 'a wan ghoul knight'

/** The main window's overlay bridge — the same one the title-bar menu calls. */
interface OverlayBridge {
  getOverlayState: () => Promise<Record<string, boolean>>
  toggleOverlay: (k: string) => Promise<boolean>
}
function overlayState(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => (window as unknown as { eq: OverlayBridge }).eq.getOverlayState())
}
function toggleOverlay(page: Page, kind: string): Promise<boolean> {
  return page.evaluate((k) => (window as unknown as { eq: OverlayBridge }).eq.toggleOverlay(k), kind)
}

/** One clock as a surface draws it, from either the tab or the floating window. */
interface Clock {
  mob: string
  source: string
  due: string
  text: string
}

function clocks(page: Page, testid: string): Promise<Clock[]> {
  return page.evaluate(
    (id) =>
      [...document.querySelectorAll(`[data-testid="${id}"]`)].map((e) => ({
        mob: e.getAttribute('data-respawn-mob') ?? '',
        source: e.getAttribute('data-respawn-source') ?? '',
        due: e.getAttribute('data-respawn-due') ?? '',
        text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
      })),
    testid
  )
}

const find = (rows: Clock[], mob: string): Clock | undefined => rows.find((r) => r.mob === mob)

/** The watch-list bridge, i.e. what the tab's Watch button lands on. Used only to READ here. */
function readWatches(page: Page): Promise<{ autoWiki: boolean; watches: { key: string }[] }> {
  return page.evaluate(() =>
    (
      window as unknown as { eq: { getRespawn: () => Promise<{ autoWiki: boolean; watches: { key: string }[] }> } }
    ).eq.getRespawn()
  )
}

async function stepFreshInstall(page: Page, app: ElectronApplication): Promise<void> {
  await page.click('[data-testid="nav-timers"]', { timeout: 30_000 })
  const mounted = await settle(() => countOf(page, '[data-testid="timers-view"]'), (n) => n === 1, {
    timeoutMs: 30_000
  })
  check('the Timers tab mounts', mounted === 1)

  // A log whose kills are all days old starts NO clocks — the sweep, in the real app.
  const empty = await settle(() => countOf(page, '[data-testid="respawn-empty"]'), (n) => n === 1, {
    timeoutMs: 20_000
  })
  check('a log with only long-elapsed kills shows no clocks, and says why', empty === 1)

  const prefs = await readWatches(page)
  check('a fresh install watches nothing explicitly', prefs.watches.length === 0, JSON.stringify(prefs))
  check('…and has the wiki auto-rule ON, so the first kill does something', prefs.autoWiki === true)

  const state = await overlayState(page)
  check('…and the floating window is OFF until asked for', state.respawn === false, JSON.stringify(state))
  check('…with no window spawned at startup', (await windowsOfKind(app, 'respawn')) === 0)
}

/** How many windows the app has open on a given `?kind=` (exact, never a substring). */
async function windowsOfKind(app: ElectronApplication, kind: string): Promise<number> {
  let hit = 0
  for (const w of app.windows()) {
    const search = await w.evaluate(() => window.location.search).catch(() => '')
    if (new URLSearchParams(search).get('kind') === kind) hit++
  }
  return hit
}

/**
 * A KILL IN THE LIVE LOG STARTS A CLOCK, with no configuration at all.
 *
 * This is the auto-wiki arm: the mob is one of the 394 the committed floor gives a duration for, so
 * the first death of it produces a row whose number is the wiki's and whose label says so. The
 * whole live path is in the assertion — nothing in the app knew this mob existed a second ago.
 */
async function stepLiveKillStartsAClock(page: Page, log: FixtureLog): Promise<void> {
  log.append(`You have slain ${WIKI_MOB}!`)
  const rows = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, WIKI_MOB) !== undefined, {
    timeoutMs: 30_000
  })
  const row = find(rows, WIKI_MOB)
  if (!check('a death message in the LIVE log starts a clock', row !== undefined, JSON.stringify(rows))) return
  check('…numbered from the wiki, because you have no gap of your own yet', row.source === 'wiki', JSON.stringify(row))
  check('…and it says so rather than presenting the number bare', row.text.includes('wiki default'), row.text)
  check('…counting down, not already due', row.due === 'false', JSON.stringify(row))
  // The ESTIMATE, printed beside the countdown: 570 s, which is what the committed floor reads out
  // of the page's "9.5 min". The number the wiki actually states, on screen, in the real app.
  check('…for the duration the wiki actually states', row.text.includes('9m 30s'), row.text)
}

/**
 * WATCH A MOB THE WIKI HAS NEVER HEARD OF, AND THE CLOCK STARTS FROM THE KILL YOU ALREADY MADE.
 *
 * The discoverability story, clicked rather than described. Two deaths are played three minutes
 * apart so the fold has a real same-stay gap to learn from BEFORE anything is watched; then the
 * Watch button in the Recently killed panel is clicked, and a row has to appear immediately —
 * carrying that learned gap. A build whose IPC setter forgot `flushNow`, or whose module reported
 * a log seq instead of its own revision, passes every unit test and fails right here.
 */
async function stepWatchFromRecentKills(page: Page, log: FixtureLog): Promise<void> {
  const earlier = new Date(Date.now() - 3 * 60_000)
  log.appendAt(earlier, `You have slain ${OWN_MOB}!`)
  log.append(`You have slain ${OWN_MOB}!`)

  const offered = await settle(
    () => clocks(page, 'respawn-candidate'),
    (r) => find(r, OWN_MOB) !== undefined,
    { timeoutMs: 30_000 }
  )
  const cand = find(offered, OWN_MOB)
  if (!check('a mob nobody watches is still OFFERED, having died', cand !== undefined, JSON.stringify(offered))) {
    return
  }
  check('…and is not clocked until asked for', find(await clocks(page, 'respawn-row'), OWN_MOB) === undefined)

  await page.click(`[data-testid="respawn-candidate"][data-respawn-mob="${OWN_MOB}"] [data-testid="respawn-watch"]`, {
    timeout: 15_000
  })

  const rows = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, OWN_MOB) !== undefined, {
    timeoutMs: 30_000
  })
  const row = find(rows, OWN_MOB)
  if (!check('clicking Watch produces a clock at once', row !== undefined, JSON.stringify(rows))) return
  // FROM THE KILL ALREADY FOLDED, and numbered by the gap already learned — not from the next death.
  check('…numbered from YOUR kills, not from the wiki', row.source === 'observed', JSON.stringify(row))
  check('…stating how thin that evidence is', row.text.includes('your kills (1 gap)'), row.text)
  // The two deaths were played three minutes apart, so the learned bound is 3m — printed with the
  // "<=" that says it is a bound and not a measurement.
  check('…and the gap it learned is the one that was played', row.text.includes('<= 3m 00s'), row.text)

  const prefs = await readWatches(page)
  check(
    '…and the choice was PERSISTED, not held in the component',
    prefs.watches.some((w) => w.key === OWN_MOB),
    JSON.stringify(prefs)
  )
}

/**
 * THE FOLD REACHES THE SECOND RENDERER — the claim `MODULE_READING_OVERLAYS` exists for.
 *
 * The window is created in the same `whenReady` turn that starts the historical fold, so a window
 * riding only `module:delta` would sit at an empty snapshot on a quiet log. Both clocks are already
 * in the model by the time it opens, so both have to be in the window (JOS-172).
 */
async function stepOverlay(page: Page, app: ElectronApplication): Promise<void> {
  const open = await toggleOverlay(page, 'respawn')
  if (!check('toggling Respawn from the overlay menu reports it OPEN', open === true)) return

  const overlay = await overlayWindow(app, 'respawn')
  if (!check('…and a window for kind=respawn really exists', overlay !== null)) return
  const o = overlay

  const mounted = await settle(() => countOf(o, '[data-testid="respawn-overlay"]'), (n) => n === 1, {
    timeoutMs: 20_000
  })
  check('the respawn surface mounts', mounted === 1)
  check('…with a visible close control', (await countOf(o, 'button[aria-label="Close overlay"]')) === 1)
  check('…and the lock (click-through) control beside it', (await countOf(o, 'button[aria-label^="Lock"]')) === 1)

  const rows = await settle(
    () => clocks(o, 'respawn-overlay-row'),
    (r) => find(r, WIKI_MOB) !== undefined && find(r, OWN_MOB) !== undefined,
    { timeoutMs: 30_000 }
  )
  check(
    'a window opened AFTER the fold shows the clocks the fold already holds',
    find(rows, WIKI_MOB) !== undefined && find(rows, OWN_MOB) !== undefined,
    JSON.stringify(rows)
  )
  const text = await o.evaluate(() => document.body.innerText)
  check(
    '…and never claims the mob is standing there',
    text.includes('estimate elapsed, not a sighting'),
    text.slice(0, 200)
  )
}

async function main(): Promise<void> {
  buildIfStale()
  const launched = await launchOnFixture('e2e-leveling.log')
  const fixture = launched.log
  const page = await mainWindow(launched.app)
  await page.waitForSelector('[data-testid="nav-overview"]', { timeout: 60_000 })

  await stepFreshInstall(page, launched.app)
  await stepLiveKillStartsAClock(page, fixture)
  await stepWatchFromRecentKills(page, fixture)
  await stepOverlay(page, launched.app)

  if (failures.length) await dumpArtifacts(page, 'respawn-timers-FAIL')
  await launched.close()
  await fixture.dispose()
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error -', err)
  process.exitCode = 1
})
