/**
 * Headless Electron spec for JOS-178 — A SEARCH BOX FINDS AN ALERT BY ANYTHING YOU REMEMBER ABOUT
 * IT, AND CLEARING IT HANDS THE WHOLE LIST BACK.
 *
 * WHAT A PLAYER ASKED FOR (0.16.0 report): a way to find one alert in a list that has grown past
 * what a person can scan. The wide match set is the answer — the name, the trigger, the sound, the
 * spoken phrase, the note — because what somebody remembers a month later is rarely the name.
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST. `tests/alertSearch.test.mts` owns the matcher facet by
 * facet and pins that a filtered list is the stored sequence with rows removed. It can see none of
 * the things this file exists for:
 *
 *   1. A REAL KEYSTROKE NARROWS THE REAL LIST. The box, the deferred query, the haystacks built off
 *      main's own defs and the rows React re-renders are four separate parts, and the seeded corpus
 *      arrives over IPC rather than from a fixture literal.
 *   2. THE LIST ON SCREEN IS THE LIST MAIN HAS STORED, in the same sequence — before the search,
 *      during it, and after. The order is simply the stored array (there is no ordering feature and
 *      no sort key), so "the search did not disturb it" is the whole claim, and it needs both ends.
 *   3. CLEARING RESTORES THE WHOLE LIST, in the order it left. An identity claim about arrays in a
 *      unit test is not the same statement as a list coming back on screen.
 *
 * (JOS-179 removed the drag-to-reorder experiment this spec used to share a file with — the
 * gesture, the grip, the insertion line and the `alerts:reorder` channel are all gone, unshipped.
 * The order is the stored array, exactly as it was before the experiment.)
 *
 * Run: `npm run test:e2e -- alerts-search`.
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  dumpArtifacts,
  failures,
  reportRun,
  settle,
  settleStable
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'

const ROW = '[data-testid="alert-row"]'
const SEARCH = '[data-testid="alerts-search"] input'
const SEARCH_CLEAR = '[data-testid="alerts-search-clear"]'

/** The ids of the alert rows, top to bottom, as the list is rendering them right now. */
function renderedOrder(page: Page): Promise<string[]> {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].map((el) => el.getAttribute('data-alert-id') ?? '?'), ROW)
}

/** The ids main has stored, in stored order — which IS the order, there being no other. */
function storedOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { eq: { listAlerts: () => Promise<{ id: string }[]> } }).eq
      .listAlerts()
      .then((defs) => defs.map((d) => d.id))
  ) as Promise<string[]>
}

/** Open the Alerts tab and wait for the list to have rows. */
async function openAlerts(page: Page): Promise<string[]> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector(ROW, { timeout: 30_000 })
  return settle(() => renderedOrder(page), (ids) => ids.length > 0, { timeoutMs: 20_000 })
}

/** The claim every step below rests on: what is on screen is what main has stored. */
async function checkScreenMatchesStore(page: Page, tag: string): Promise<string[]> {
  const shown = await renderedOrder(page)
  const stored = await settle(
    () => storedOrder(page),
    (ids) => ids.join('>') === shown.join('>'),
    { timeoutMs: 10_000 }
  )
  check(
    `[${tag}] the order on screen is the order main has stored`,
    shown.join('>') === stored.join('>'),
    `screen ${shown.join(' > ')} · store ${stored.join(' > ')}`
  )
  return shown
}

// ─────────────────────────────── the search box ──────────────────────────────────────────────
//
// THE SEEDED SET IS THE CORPUS (src/main/store.ts SEED_ALERTS), so the queries below are chosen
// against facets that are ALWAYS there — a def's own name, trigger and note. Deliberately NOT the
// sound pack's labels: the default pack self-provisions over the network on first run, so a query
// leaning on a label would pass or fail on whether this machine could reach GitHub.
//
//   'confetti'  appears in exactly ONE place in the whole seeded set — the NOTE of "Raid target
//               defeated". A name-only search finds nothing for it, which is the entire point of
//               the wide match set.
//   'app'       is the trigger badge's own shape word, and two of the three seeded alerts fire on
//               an app signal — so it narrows to MORE THAN ONE row, which is what makes "the rows
//               kept their relative order" a real reading rather than an arithmetic one.
//   'vorpal'    answers nowhere, so the list empties and says why.

/** Type into the box and let the list settle at whatever it narrowed to. */
async function typeSearch(page: Page, q: string): Promise<string[]> {
  await page.fill(SEARCH, q)
  return settleStable(() => renderedOrder(page), { timeoutMs: 10_000 })
}

/** A word that lives in ONE alert's note finds that alert — the wide match set, end to end. */
async function checkSearchFindsANote(page: Page, start: string[]): Promise<void> {
  const shown = await typeSearch(page, 'confetti')
  check(
    'a word that appears only in one alert’s NOTE finds that alert, and narrows the list to it',
    shown.length < start.length && shown.includes('boss-defeat') && !shown.includes('charm-break'),
    `${String(start.length)} rows before · now ${shown.join(' > ') || '(none)'}`
  )
}

/**
 * A trigger word narrows to several rows — and they are those rows IN THE ORDER THEY WERE IN.
 * Filter, never rank: the filtered view is the stored sequence with rows removed, so a row may
 * never overtake another because it matched better.
 */
async function checkFilterKeepsTheOrder(page: Page, start: string[]): Promise<void> {
  const shown = await typeSearch(page, 'app')
  if (
    !check(
      'a trigger word narrows the list to the alerts whose trigger says it',
      shown.length >= 2 && shown.length < start.length && !shown.includes('charm-break'),
      `now ${shown.join(' > ') || '(none)'}`
    )
  ) {
    return
  }
  check(
    'the rows that survive a search are in the order the list already had them in',
    shown.join('>') === start.filter((id) => shown.includes(id)).join('>'),
    `list ${start.join(' > ')} · filtered ${shown.join(' > ')}`
  )
  // The narrowing is a VIEW, so main's own list is untouched by it.
  const stored = await storedOrder(page)
  check(
    'the search narrows what you are looking at and nothing else — main still has every alert',
    stored.join('>') === start.join('>'),
    `store ${stored.join(' > ')} · list was ${start.join(' > ')}`
  )
}

/** A query nothing answers empties the list and says which kind of empty it is. */
async function checkNoMatchesSaysSo(page: Page): Promise<void> {
  const shown = await typeSearch(page, 'vorpal')
  if (!check('a query nothing answers leaves no rows at all', shown.length === 0, shown.join(' > '))) {
    return
  }
  const empty = await page.textContent('[data-testid="alerts-empty"]')
  check(
    '…and the empty list says it is the SEARCH that emptied it, not that you have no alerts',
    (empty ?? '').includes('No alerts match'),
    `the empty state reads: ${empty ?? '(absent)'}`
  )
}

/** Clearing the box hands back the whole list, in the order it left. */
async function checkClearRestores(page: Page, start: string[]): Promise<void> {
  await page.click(SEARCH_CLEAR)
  const shown = await settle(
    () => renderedOrder(page),
    (ids) => ids.join('>') === start.join('>'),
    { timeoutMs: 10_000 }
  )
  check(
    'clearing the search brings the whole list back, in the order it left',
    shown.join('>') === start.join('>'),
    `left ${start.join(' > ')} · back ${shown.join(' > ')}`
  )
  await checkScreenMatchesStore(page, 'after clearing the search')
}

async function main(): Promise<void> {
  buildIfStale()

  const log = stageFixture('e2e-voice.log')
  const userData = makeUserData()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-voice.log…')
  const { app, close } = await launchOnFixture(log, { userData })
  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    const start = await openAlerts(page)
    if (
      check(
        'the alerts list renders the seeded alerts',
        start.length >= 3,
        `${String(start.length)} rows: ${start.join(' > ')}`
      )
    ) {
      await checkScreenMatchesStore(page, 'at rest')
      await checkSearchFindsANote(page, start)
      await checkFilterKeepsTheOrder(page, start)
      await checkNoMatchesSaysSo(page)
      await checkClearRestores(page, start)
    }
    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'alerts-search-FAIL')
  } finally {
    await close()
  }

  await removeUserData(userData)
  await log.dispose()
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
