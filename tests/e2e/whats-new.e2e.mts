/**
 * WHAT'S NEW, driven through the real app (JOS-73).
 *
 * `tests/releaseNotes.test.mts` pins the derivation as pure logic, which is most of the feature.
 * What a unit test structurally cannot see is the part this spec exists for: the whole promise
 * rests on a STORE KEY that main owns, read once at launch, and the two most load-bearing claims
 * are about a launch rather than about a function.
 *
 *   1. A FRESH INSTALL IS NOT TOLD IT WAS UPDATED. The e2e channel gives every launch its own
 *      temp userData (src/main/channel.ts), so this run IS a fresh install — no stub, no seeded
 *      state, no flag. The teaser strip must be absent, and the panel must mark nothing new. If
 *      the absent-key case ever reads as "everything is new", this is where it shows up, and it
 *      would show up as the first sentence the app ever says to a new user.
 *   2. …AND AN UPGRADED INSTALL IS. The stamp is written through the same bridge method the
 *      panel and the teaser's dismiss use, the window is RELOADED (the state is read once per
 *      launch, on purpose — features/whatsnew/session.ts), and the strip has to come back naming
 *      the newest release with the right releases marked behind it.
 *
 * It also asserts the DEV variant control is ABSENT here, for the same reason the feedback spec
 * asserts `nav-triage` is: this build is production-shaped, and "compiled out" is a claim about
 * bytes that only a build can answer.
 *
 * Run: `npm run test:e2e -- whats-new`
 */
import type { ElectronApplication, Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  reportRun,
  settle,
  settleCount,
  settleStable
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
import { RELEASE_NOTES, variantLastSeen } from '../../src/shared/releaseNotes'

const TEASER = '[data-testid="whats-new-teaser"]'
const PANEL = '[data-testid="whats-new-panel"]'
const RAIL = '[data-testid="prefs-rail-whatsnew"]'
const DEV_ROW = '[data-testid="whats-new-dev"]'

const NEWEST = RELEASE_NOTES[0]!.version
/** Derived from the data, never typed twice: the spec asserts the panel drew what the module
 *  holds, and `tests/releaseNotes.test.mts` is what pins the module's own counts. */
const EXPECTED_BULLETS = RELEASE_NOTES.reduce((n, r) => n + r.entries.length, 0)
/**
 * The release whose notes spend extra bullets INTRODUCING two new surfaces (JOS-80) — the What's
 * new panel and the "This week" lockout view.
 *
 * Asserted separately from the panel-wide total because the total cannot tell a release that
 * grew from a release that shrank while another grew. An introduction is plain bullets in the
 * same list, with no marker of its own, so its own count in the RENDERED panel is the only place
 * "the extra bullets actually reached the screen" is observable.
 */
const INTRO_RELEASE = '0.9.0'
const INTRO_RELEASE_BULLETS =
  RELEASE_NOTES.find((r) => r.version === INTRO_RELEASE)?.entries.length ?? 0
const EXPECTED_TAGGED = RELEASE_NOTES.reduce(
  (n, r) => n + r.entries.filter((e) => e.fromReport === true).length,
  0
)
// The thanks line renders ONCE at the panel top (owner, 2026-08-07), gated on any release
// carrying a tagged entry — the check below asserts exactly one line panel-wide.
/** The state a one-release upgrade leaves behind — exactly what the DEV control's second button
 *  writes, so the hand test and this spec are driving the same configuration. */
const PREVIOUS = variantLastSeen('previous')

/** Write the last-seen stamp through the very bridge method the app's own surfaces call. */
function setSeen(page: Page, version: string | null): Promise<string | null> {
  return page.evaluate(
    (v) =>
      (
        window as unknown as {
          eq: { setReleaseNotesSeen: (x: string | null) => Promise<string | null> }
        }
      ).eq.setReleaseNotesSeen(v),
    version
  )
}

/** Open Preferences → What's new and read the panel back. */
async function openPanel(page: Page): Promise<{ releases: number; marked: string[] }> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.waitForSelector(RAIL, { timeout: 20_000 })
  await page.click(RAIL)
  await page.waitForSelector(PANEL, { timeout: 20_000 })
  return page.evaluate(() => ({
    releases: document.querySelectorAll('[data-testid^="whats-new-release-"]').length,
    marked: [...document.querySelectorAll('[data-testid^="whats-new-release-"][data-new="true"]')].map(
      (el) => el.getAttribute('data-testid')?.replace('whats-new-release-', '') ?? ''
    )
  }))
}

/**
 * The geometry that says "it fills the pane" (JOS-76): where the scroll box's bottom sits, versus
 * where the content area it lives in ends.
 *
 * MEASURED, NOT INFERRED FROM CSS. `flexGrow:1` is easy to write and easy to have swallowed by
 * one missing `minHeight: 0` somewhere up the chain — the symptom of which is that the box grows
 * past the pane and the PAGE scrolls instead of the list. So the reading is the rendered box
 * against the rendered pane, plus whether the page itself acquired a scrollbar.
 */
function paneFit(page: Page): Promise<{ gap: number; boxHeight: number; pageOverflow: number }> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="whats-new-history"]')?.getBoundingClientRect()
    const pane = document.querySelector('main')?.getBoundingClientRect()
    const scroller = document.querySelector('main > div')
    return {
      gap: box && pane ? pane.bottom - box.bottom : Number.NaN,
      boxHeight: box ? box.height : 0,
      // How far the pane's own scroller can travel. The list scrolls; the page must not.
      pageOverflow: scroller ? scroller.scrollHeight - scroller.clientHeight : Number.NaN
    }
  })
}

/**
 * Resize the (never-shown) main window from the MAIN process — the only place that can — and
 * WAIT FOR THE RENDERER TO HAVE SEEN IT.
 *
 * The wait is the whole point and it cost this spec a red run: `settleStable` is the wrong
 * instrument here, because the measurement is stable BEFORE the resize as well as after, so it
 * returned the pre-resize geometry immediately and both window sizes measured identically. The
 * condition is `window.innerHeight`, which is the renderer's own answer to "how big am I now" —
 * so this waits for the positive signal rather than for a settling that had already happened.
 *
 * The main window is identified POSITIVELY, by the page whose bounds we are about to read, not by
 * "the one that isn't an overlay" — the toast overlay is open by default and window order is not
 * a promise (appWindow.mts's rule).
 */
async function setWindowHeight(page: Page, app: ElectronApplication, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, h) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isAlwaysOnTop())
    win?.setContentSize(1280, h)
  }, height)
  const got = await settle(
    () => page.evaluate(() => window.innerHeight),
    (h) => h === height
  )
  check(`the window really resized to ${String(height)}px`, got === height, `innerHeight=${String(got)}`)
}

/** The one line the strip says, or '' when there is no strip. */
function teaserText(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('[data-testid="whats-new-teaser-text"]')?.textContent?.trim() ?? ''
  )
}

/**
 * THE PANEL FILLS THE PANE (JOS-76), measured at TWO window heights.
 *
 * Two, because "fills" is a claim about a RELATIONSHIP and a single measurement cannot tell it
 * apart from a fixed height that happens to look right at this window size — which is exactly the
 * thing being replaced. So the box must end near the pane's bottom at both, must never hand its
 * scrolling to the page, and must GROW between them.
 */
async function checkFillsPane(page: Page, app: ElectronApplication): Promise<void> {
  const heights: number[] = []
  for (const [label, height] of [['tall', 1000] as const, ['short', 620] as const]) {
    await setWindowHeight(page, app, height)
    // The resize has landed by now (setWindowHeight waited for it); THIS settle is for the
    // reflow that follows it, where "stopped changing" really is the right condition.
    const fit = await settleStable(() => paneFit(page))
    check(
      `${label} window: the history box reaches the bottom of the pane`,
      fit.gap >= 0 && fit.gap < 48,
      `gap=${fit.gap.toFixed(1)}px boxHeight=${fit.boxHeight.toFixed(1)}px`
    )
    check(
      `${label} window: the LIST scrolls, never the page`,
      fit.pageOverflow <= 1,
      `pageOverflow=${fit.pageOverflow.toFixed(1)}px`
    )
    heights.push(fit.boxHeight)
  }
  const [tall = 0, short = 0] = heights
  check(
    'the box GREW with the window — it is filling, not a fixed height that happened to fit',
    tall > short + 200,
    `tall=${tall.toFixed(1)}px short=${short.toFixed(1)}px`
  )
  await setWindowHeight(page, app, 900)
}

/** Bullets, the player-report chip, and the collective thanks line (JOS-76). */
async function checkBulletsAndThanks(page: Page): Promise<void> {
  const seen = await page.evaluate((introRelease: string) => ({
    total: document.querySelectorAll('[data-testid="whats-new-bullet"]').length,
    intro: document.querySelectorAll(
      `[data-testid="whats-new-release-${introRelease}"] [data-testid="whats-new-bullet"]`
    ).length,
    tagged: document.querySelectorAll('[data-testid="whats-new-bullet"][data-from-report="true"]').length,
    chips: document.querySelectorAll('[data-testid="whats-new-report-chip"]').length,
    thanks: document.querySelectorAll('[data-testid="whats-new-thanks"]').length,
    firstThanks: document.querySelector('[data-testid="whats-new-thanks"]')?.textContent?.trim() ?? ''
  }), INTRO_RELEASE)
  check(
    'every entry renders as a BULLET, not a packed sentence',
    seen.total === EXPECTED_BULLETS,
    `bullets=${String(seen.total)} expected=${String(EXPECTED_BULLETS)}`
  )
  check(
    `a release that INTRODUCES a surface spends extra bullets on it, and they reach the screen`,
    seen.intro === INTRO_RELEASE_BULLETS && seen.intro > 5,
    `v${INTRO_RELEASE} bullets=${String(seen.intro)} expected=${String(INTRO_RELEASE_BULLETS)}`
  )
  check(
    'a player-reported bullet wears its chip, and only those bullets do',
    seen.tagged === EXPECTED_TAGGED && seen.chips === EXPECTED_TAGGED,
    `tagged=${String(seen.tagged)} chips=${String(seen.chips)} expected=${String(EXPECTED_TAGGED)}`
  )
  check(
    '…and the panel thanks the people who filed them ONCE, at the top (owner, 2026-08-07)',
    seen.thanks === 1,
    `thanksLines=${String(seen.thanks)} expected=1`
  )
  check(
    '…collectively, naming nobody',
    seen.firstThanks === 'Thanks to everyone who filed reports - many of these came from you.',
    `line="${seen.firstThanks}"`
  )
}

async function main(): Promise<void> {
  buildIfStale()

  const launched = await launchOnFixture('e2e-overview.log')
  let page: Page | null = null
  try {
    page = await mainWindow(launched.app)
    await page.waitForSelector('[data-testid="nav-overview"]', { timeout: 60_000 })

    // ---- 1. a fresh install ------------------------------------------------
    // The ABSENCE is asserted the lawful way: wait for the reading to STOP CHANGING, then assert
    // nothing is there. A bare check here would pass while the state was still in flight.
    const settled = await settleStable(() => countOf(page as Page, TEASER))
    check(
      'A FRESH INSTALL IS NEVER TOLD IT WAS UPDATED — no teaser strip at all',
      settled === 0,
      `teasers=${String(settled)}`
    )

    const fresh = await openPanel(page)
    check(
      'the full history is browsable anyway — every release renders',
      fresh.releases === RELEASE_NOTES.length,
      `rendered=${String(fresh.releases)} expected=${String(RELEASE_NOTES.length)}`
    )
    check(
      '…and NOTHING is marked new, because a new user has no changes',
      fresh.marked.length === 0,
      `marked=${fresh.marked.join(',') || 'none'}`
    )
    check(
      'the DEV variant control is compiled OUT of a production-shaped build',
      (await countOf(page, DEV_ROW)) === 0
    )

    await checkFillsPane(page, launched.app)
    await checkBulletsAndThanks(page)

    // ---- 2. an upgraded install -------------------------------------------
    // The state is read ONCE per launch, so the reload is not a shortcut around anything: it is
    // the second launch, which is exactly when a real upgrade's teaser appears.
    const stored = await setSeen(page, PREVIOUS)
    check('the stamp round-trips through main', stored === PREVIOUS, `stored=${stored ?? 'null'}`)

    await page.reload({ timeout: 60_000 })
    await page.waitForSelector('[data-testid="nav-overview"]', { timeout: 60_000 })

    const shown = await settleCount(page, TEASER, 1)
    check('…and the next launch says so, in one quiet line', shown === 1, `teasers=${String(shown)}`)
    const line = await teaserText(page)
    check(
      '…naming the NEWEST release and only it',
      line === `Updated to v${NEWEST}`,
      `line="${line}"`
    )

    const upgraded = await openPanel(page)
    check(
      'the panel marks every release since the one this install had seen',
      upgraded.marked.length > 0 && upgraded.marked[0] === NEWEST,
      `marked=${upgraded.marked.join(',') || 'none'}`
    )
    check(
      '…and nothing at or below the stamp',
      !upgraded.marked.includes(PREVIOUS ?? ''),
      `stamp=${PREVIOUS ?? 'null'} marked=${upgraded.marked.join(',')}`
    )

    if (failures.length) await dumpArtifacts(page, 'whats-new-FAIL')
  } finally {
    await launched.close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
