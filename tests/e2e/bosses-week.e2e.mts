/**
 * Headless Electron integration test for THE BOSSES TAB'S WEEK VIEW (JOS-152).
 *
 * TWO ASKS FROM ONE RAID COORDINATOR, and this spec is the half neither can be proved without a
 * real app:
 *
 *   1. (01KZM0T1YNREY466752BQZVFBR) "the Bosses view forgets which tab you were on." The
 *      unit-testable part of the fix is a `useState` initialiser reading localStorage, and a test
 *      of THAT would pass while the feature stayed broken, because the bug was never in the read.
 *      It is the LIFECYCLE: `App`'s `ViewContent` mounts exactly one feature view at a time, so
 *      leaving the tab destroys `BossView` and everything it was holding. Every assertion below
 *      is therefore bracketed by a NAVIGATION, and the trip out asserts the toolbar is GONE first
 *      - an unmount that never happened would make the rest of this spec a tautology. The
 *      sky-filters spec makes the same argument at length for the same reason.
 *
 *   2. (01KZM0WD1DWQAXBB6EA0BZHE4A) the per-difficulty ladder. What is asserted here is that the
 *      rungs EXIST, that there are five of them per card in base-first order, and that they
 *      belong to the WEEK view and to no other - i.e. that the derivation reaches the screen.
 *
 * …and since JOS-171, that the ladder is where the card ENDS: the `Locked · <date>` / `open`
 * caption that used to sit under the rungs is gone, and a rung's hover is a bare date (a cleared
 * one) or no `title` attribute at all (an open one). That last half is the reason it is asserted
 * HERE rather than only in tests/bossLockouts.test.mts: an absent attribute and an empty one are
 * the same value in a unit assertion and are two different tooltips in a real browser.
 *
 * WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT: which rungs are GREEN. "Cleared this week" is a
 * comparison against the real clock, and the committed e2e fixture's kills sit at fixed dates, so
 * any expected colour here would be true only until the next Tuesday 08:00 Pacific and would then
 * rot silently (AGENTS.md: frozen numbers rot). The colours are pinned where the clock is an
 * ARGUMENT rather than an ambient fact - tests/bossLockouts.test.mts replays the same fixtures at
 * three named instants either side of one reset. So the rung's `data-cleared` is read only to
 * prove every rung STATES an answer, never to say which.
 *
 * TWO LAUNCHES, ONE userData DIR. The tab round trip and the RESTART are different promises;
 * `makeUserData()` hands both launches the same dir, so launch 2 reads the localStorage launch 1
 * wrote through a real process exit.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir per launch.
 *
 * Run: `npm run test:e2e -- bosses-week` (or node --import tsx this file).
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  reportRun,
  settle,
  settleGone
} from './appHarness.mjs'
import { launchApp, mainWindow, makeUserData, removeUserData } from './appWindow.mjs'

const NAV_BOSSES = '[data-testid="nav-bosses"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
/** The toggle group under test, and its two buttons. */
const MODE = '[data-testid="boss-mode"]'
const MODE_OVERALL = '[data-testid="boss-mode-overall"]'
const MODE_WEEK = '[data-testid="boss-mode-week"]'
/** The preference itself, as BossView stores it. Read back so the spec pins the KEY too: a
 *  rename that kept the round trip working would still break an existing user's saved choice. */
const KEY = 'eq.bosses.mode'
const CARD = '[data-testid="boss-card"]'
const LADDER = '[data-testid="boss-difficulty-ladder"]'

/** Which mode the toggle group is showing as selected. `null` when it is not mounted. */
function modeState(page: Page): Promise<string | null> {
  return page.evaluate((sel) => {
    const on = document.querySelector(`${sel} .Mui-selected`)
    return on?.getAttribute('data-testid')?.replace('boss-mode-', '') ?? null
  }, MODE)
}

/** What the renderer has actually stored, verbatim. `null` when the key was never written. */
function storedMode(page: Page): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), KEY)
}

/** Every ladder's rung labels, one string per card, e.g. "D0,D1,D2,D3,D4". */
function ladderLabels(page: Page): Promise<string[]> {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((row) =>
        [...row.children].map((n) => n.textContent ?? '').join(',')
      ),
    LADDER
  )
}

/** Every rung's `data-cleared` bit across the whole view. A rung with none would read ''. */
function rungAnswers(page: Page): Promise<string[]> {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} > *`)].map((n) => n.getAttribute('data-cleared') ?? ''),
    LADDER
  )
}

/** What JOS-171 left of the card's bottom: per card, whether the ladder ENDS it, and whether any
 *  lock caption survives under it. `null` for `title` is the absence of the attribute — which is
 *  the shape an open rung is contracted to have, and is NOT the same as an empty string. */
interface CardTail {
  cards: number
  /** cards whose ladder is the last element in its caption box (nothing written beneath it) */
  ladderLast: number
  /** cards whose text still contains the old `Locked · <date>` caption */
  lockedCaption: number
  /** `[data-cleared, title]` for every rung on the view */
  rungTitles: [string, string | null][]
}

function cardTails(page: Page): Promise<CardTail> {
  return page.evaluate((sel) => {
    const cards = [...document.querySelectorAll(sel.card)]
    let ladderLast = 0
    let lockedCaption = 0
    for (const card of cards) {
      const ladder = card.querySelector(sel.ladder)
      if (ladder && ladder.parentElement?.lastElementChild === ladder) ladderLast++
      // Only the CAPTION word is hunted. "open" still appears on the corner tier chip of a card
      // with no lock at all (JOS-169), which this ticket did not touch.
      if ((card.textContent ?? '').includes('Locked')) lockedCaption++
    }
    const rungTitles = [...document.querySelectorAll(`${sel.ladder} > *`)].map(
      (n): [string, string | null] => [n.getAttribute('data-cleared') ?? '', n.getAttribute('title')]
    )
    return { cards: cards.length, ladderLast, lockedCaption, rungTitles }
  }, { card: CARD, ladder: LADDER })
}

/** Open the Bosses tab and wait for its toolbar. Safe when the tab is already the open one. */
async function openBosses(page: Page, timeoutMs = 60_000): Promise<boolean> {
  await page.click(NAV_BOSSES, { timeout: 30_000 })
  return page.waitForSelector(MODE, { timeout: timeoutMs }).then(
    () => true,
    () => false
  )
}

/**
 * Leave for another tab, and confirm the Bosses view is really gone. This is the step the bug
 * lived in: the assertion after it means nothing unless `BossView` was actually unmounted here.
 */
async function leaveBosses(page: Page): Promise<boolean> {
  await page.click(NAV_OVERVIEW, { timeout: 30_000 })
  return settleGone(page, MODE, { timeoutMs: 15_000 })
}

/** Away to the Overview and back to Bosses, with the unmount actually asserted in between. */
async function awayAndBack(page: Page): Promise<boolean> {
  if (!check('leaving the Bosses tab unmounts it (the mode toggle is gone)', await leaveBosses(page))) {
    return false
  }
  return check('…and the Bosses tab comes back', await openBosses(page))
}

/** Click a mode button and wait for the group to report the mode we asked for. */
async function setMode(page: Page, button: string, want: string): Promise<string | null> {
  await page.click(button, { timeout: 15_000 })
  return settle(() => modeState(page), (v) => v === want, { timeoutMs: 8_000 })
}

/** A fresh install opens on OVERALL - the key is absent, and absence is the default. */
async function stepDefault(page: Page): Promise<void> {
  check('a fresh install opens the Bosses tab on OVERALL', (await modeState(page)) === 'overall')
  check('…and has written no preference yet', (await storedMode(page)) === null)
  const cards = await settle(() => countOf(page, CARD), (n) => n > 0, { timeoutMs: 30_000 })
  check('…and the roster has cards on it', cards > 0, String(cards))
  check(
    'THE LADDER BELONGS TO THE WEEK VIEW - the overall roster draws none',
    (await countOf(page, LADDER)) === 0
  )
  // The OVERALL roster is where every target is on screen at once, so it is the widest sample of
  // portraits this spec ever has — which is why the JOS-198 check is made here rather than in the
  // week view.
  await stepPortraitsShipped(page)
}

/**
 * THE PORTRAITS COME OUT OF THE INSTALL, NOT OFF A WIKI (JOS-198).
 *
 * This is the one assertion in the suite that a unit test provably cannot make, and the reason
 * it lives in THIS spec: the boss cards are the only surface that draws the `url` route, and the
 * claim is about bytes arriving through `protocol.handle` into a real Chromium image decoder.
 *
 * WHY `naturalWidth > 1` IS THE WHOLE PROOF. `EQ_E2E=1` puts the app on a cold temp `userData`
 * and cuts the network: a cache MISS under that flag is answered with `E2E_BLANK_PNG`, a 1x1
 * transparent pixel (src/main/imageCache.ts). So before this ticket every portrait in this run
 * decoded to exactly 1x1. A portrait that now decodes WIDER than one pixel cannot have come from
 * the empty runtime cache and cannot have come from the network — the only remaining source is
 * `resources/wiki-images/`, which is the thing being proved. Height is read too so a
 * hypothetical 1xN answer could not sneak past.
 *
 * It is deliberately NOT an exact size. The bundled portraits are whatever the wiki serves
 * (200px and 300px thumbnails today) and the card scales them with CSS; pinning a number here
 * would rot the next time somebody re-scrapes bosses.json, and would be asserting the wiki's
 * choices rather than this app's behaviour. `> 1` is the entire content of the claim.
 */
async function stepPortraitsShipped(page: Page): Promise<void> {
  const readPortraits = (): Promise<{ total: number; loaded: number; tiny: number; sample: string }> =>
    page.evaluate((sel) => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>(`${sel} img`)]
      const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0)
      const tiny = loaded.filter((i) => i.naturalWidth <= 1 || i.naturalHeight <= 1)
      const first = loaded[0]
      return {
        total: imgs.length,
        loaded: loaded.length,
        tiny: tiny.length,
        sample: first ? `${first.naturalWidth}x${first.naturalHeight} ${first.currentSrc.slice(0, 60)}` : 'none'
      }
    }, CARD)

  // Decoding is asynchronous even for a local protocol response, so wait for the READING to
  // stop moving rather than for a clock (AGENTS.md wave E3) — `loaded` climbing to `total`.
  const seen = await settle(readPortraits, (r) => r.total > 0 && r.loaded === r.total, {
    timeoutMs: 30_000
  })
  check(
    'EVERY BOSS CARD DRAWS A PORTRAIT, and every one of them decoded',
    seen.total > 0 && seen.loaded === seen.total,
    `${String(seen.loaded)} / ${String(seen.total)} decoded`
  )
  check(
    'THE PORTRAITS ARE REAL PIXELS FROM THE INSTALL - not the 1x1 blank a cache miss serves',
    seen.loaded > 0 && seen.tiny === 0,
    `${String(seen.tiny)} blank of ${String(seen.loaded)}; first: ${seen.sample}`
  )
  // …and they arrived over the app's own scheme, never as an https URL the CSP would have had
  // to allow. A regression that "fixed" a missing image by un-wrapping `cachedImageUrl` would
  // pass both checks above on a machine with a network and fail every user without one.
  check(
    '…and they came over eqimg://, so nothing reached out to a wiki to draw them',
    seen.sample.includes('eqimg://'),
    seen.sample
  )
}

/** THE LADDER: five rungs a card, base first, on every card the week view draws. */
async function stepLadder(page: Page): Promise<void> {
  const cards = await countOf(page, CARD)
  const ladders = await settle(() => countOf(page, LADDER), (n) => n === cards, { timeoutMs: 15_000 })
  check(
    'EVERY WEEK-VIEW CARD CARRIES A LADDER, not only the ones with a lock',
    ladders === cards && cards > 0,
    `${String(ladders)} ladders / ${String(cards)} cards`
  )

  const labels = await ladderLabels(page)
  const wrong = labels.filter((row) => row !== 'D0,D1,D2,D3,D4')
  check(
    'EVERY LADDER IS THE FIVE DIFFICULTIES, BASE FIRST',
    labels.length > 0 && wrong.length === 0,
    wrong.length ? `first offender: ${wrong[0]}` : `${String(labels.length)} ladders`
  )

  // Not WHICH answer - see the header. Only that no rung is drawn without one, which is what
  // would happen if the derivation stopped reaching the component.
  const answers = await rungAnswers(page)
  const silent = answers.filter((a) => a !== '0' && a !== '1')
  check(
    'every rung states an answer (cleared or open), and none is drawn without one',
    answers.length === labels.length * 5 && silent.length === 0,
    `${String(answers.length)} rungs, ${String(silent.length)} silent`
  )

  await stepChipsAreTheEnd(page)
}

/**
 * JOS-171: THE CARD ENDS IN THE CHIPS, AND A CHIP ANSWERS WITH ITS LAST KILL.
 *
 * Three claims, and every one of them is clock-independent — which is why they can live here at
 * all (see the header: this spec never says WHICH rung is green, because the fixture's kills are
 * fixed dates and the reset is real time). "The ladder is the last thing in its box", "no card
 * writes Locked", and "a cleared rung carries a bare date while an open one carries no `title`
 * attribute" are all true on any Tuesday.
 *
 * A unit test can pin what `rungTitle` RETURNS; only the app can show that the value reaches the
 * DOM as an attribute at all — and that the open case reaches it as an ABSENCE. `''` and `null`
 * are the same string in a unit assertion and completely different tooltips in a browser.
 */
async function stepChipsAreTheEnd(page: Page): Promise<void> {
  const tail = await cardTails(page)
  check(
    'THE LADDER IS THE LAST THING ON A WEEK CARD - nothing is written beneath the chips',
    tail.cards > 0 && tail.ladderLast === tail.cards,
    `${String(tail.ladderLast)} / ${String(tail.cards)} cards end in their ladder`
  )
  check(
    '…and the Locked caption line is gone from every card',
    tail.lockedCaption === 0,
    `${String(tail.lockedCaption)} cards still write it`
  )

  const cleared = tail.rungTitles.filter(([bit]) => bit === '1')
  const open = tail.rungTitles.filter(([bit]) => bit === '0')
  // A date and NOTHING else: the sentence this ticket deleted carried "cleared"/"open" and the
  // "D2 · Adaptive" spelling, so those three are what a regression would put back.
  const chatty = cleared.filter(([, t]) => !t || /cleared|open|·/.test(t))
  check(
    'A CLEARED RUNG HOVERS ITS LAST KILL AND SAYS NOTHING ELSE',
    chatty.length === 0,
    cleared.length ? `${String(cleared.length)} cleared, offender: ${String(chatty[0]?.[1])}` : 'none cleared this week'
  )
  const noisy = open.filter(([, t]) => t !== null)
  check(
    '…and an open rung carries no title attribute at all, not an empty one',
    open.length > 0 && noisy.length === 0,
    `${String(open.length)} open, ${String(noisy.length)} with a title`
  )
}

/** THE HEADLINE: pick This week, leave the tab, come back - it is still This week. */
async function stepWeekSticksAcrossTabs(page: Page): Promise<void> {
  const picked = await setMode(page, MODE_WEEK, 'week')
  if (!check('the This week button selects when clicked', picked === 'week', String(picked))) return
  const stored = await settle(() => storedMode(page), (v) => v === 'week', { timeoutMs: 8_000 })
  check(`the choice is stored under ${KEY}`, stored === 'week', `stored ${String(stored)}`)

  await stepLadder(page)

  if (!(await awayAndBack(page))) return
  const after = await settle(() => modeState(page), (v) => v !== null, { timeoutMs: 8_000 })
  check('THIS WEEK SURVIVES LEAVING AND RETURNING TO THE BOSSES TAB', after === 'week', String(after))
  const ladders = await settle(() => countOf(page, LADDER), (n) => n > 0, { timeoutMs: 15_000 })
  check('…and the ladders come back with it', ladders > 0, String(ladders))
}

/**
 * The other direction, and the reason this is a PREFERENCE rather than a latch: going BACK to
 * Overall has to survive the same round trip. An implementation that only ever remembered the
 * week (a write that skipped the default) would pass the step above and strand a user who
 * changed their mind on the far side of one tab switch.
 */
async function stepOverallSticksToo(page: Page): Promise<void> {
  const picked = await setMode(page, MODE_OVERALL, 'overall')
  if (!check('the Overall button selects again', picked === 'overall', String(picked))) return
  const stored = await settle(() => storedMode(page), (v) => v === 'overall', { timeoutMs: 8_000 })
  check('…and OVERALL is stored too, not merely un-remembered', stored === 'overall', String(stored))

  if (!(await awayAndBack(page))) return
  const after = await settle(() => modeState(page), (v) => v !== null, { timeoutMs: 8_000 })
  check('…so the tab comes back on OVERALL, the way it was left', after === 'overall', String(after))
  check('…with no ladder on it', (await countOf(page, LADDER)) === 0)
}

/** Leave it on This week for launch 2. */
async function stepArmRestart(page: Page): Promise<void> {
  const picked = await setMode(page, MODE_WEEK, 'week')
  check('the tab is left on This week for the restart check', picked === 'week', String(picked))
}

/** THE RESTART: a second process, the same userData dir, the same tab. */
async function stepSurvivesRestart(page: Page): Promise<void> {
  if (!check('the Bosses tab opens after a restart', await openBosses(page))) return
  const after = await settle(() => modeState(page), (v) => v !== null, { timeoutMs: 8_000 })
  check('THIS WEEK SURVIVES A FULL RESTART', after === 'week', String(after))
  check('…and the stored choice crossed the process boundary intact', (await storedMode(page)) === 'week')
  const ladders = await settle(() => countOf(page, LADDER), (n) => n > 0, { timeoutMs: 30_000 })
  check('…and the difficulty ladders are drawn on the tab it opened on', ladders > 0, String(ladders))
}

async function main(): Promise<void> {
  buildIfStale()

  // OWNED BY THIS SPEC, not by either launch: the restart assertion IS the dir outliving a
  // process, so `launchApp` must not delete what it did not create.
  const userData = makeUserData()
  try {
    console.log('launch 1: a fresh install - the default, the ladder, and both round trips…')
    const first = await launchApp({ userData })
    let page: Page | null = null
    try {
      page = await mainWindow(first.app)
      await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
      if (!check('the Bosses tab opens', await openBosses(page))) {
        throw new Error('never reached the Bosses tab - nothing below can be asserted')
      }
      await stepDefault(page)
      await stepWeekSticksAcrossTabs(page)
      await stepOverallSticksToo(page)
      await stepArmRestart(page)
      if (failures.length) await dumpArtifacts(page, 'bosses-week-FAIL')
    } finally {
      await first.close()
    }

    console.log('launch 2: the SAME userData dir, a new process - This week must still be there…')
    const second = await launchApp({ userData })
    let restarted: Page | null = null
    try {
      restarted = await mainWindow(second.app)
      await restarted.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
      await stepSurvivesRestart(restarted)
      if (failures.length) await dumpArtifacts(restarted, 'bosses-week-restart-FAIL')
    } finally {
      await second.close()
    }
  } finally {
    await removeUserData(userData)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error -', err)
  process.exitCode = 1
})
