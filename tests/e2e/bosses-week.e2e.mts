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
 * …and since JOS-237, that the toolbar's "Defeated only" switch answers the question THE VIEW IS
 * ASKING. It filtered on the all-time killed flag in both modes, so the week view hid nothing a
 * coordinator wanted hidden; the assertion is an equality between two readings of one screen (the
 * cards left standing == the cards drawing a green rung), which is why it can live here beside a
 * real clock. `stepDefeatedOnlyIsThisWeek` carries the argument.
 *
 * …and since JOS-239, that the OTHER grouping mounts and that its headers are honest — the
 * by-loadout switch had never been flipped by anything in this suite, so a whole view of the roster
 * had zero app-level coverage. `loadoutSectionSteps.mts` carries that argument and the step, out of
 * this file because it is at the 400-code-line ceiling.
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
 * ── KNOWN FAILURE SINCE JOS-499, AND IT IS INFRASTRUCTURE RATHER THAN THIS SPEC ────────────────
 *
 * THE ROSTER IS SERVED NOW. `useBossKills` builds a status per target from the `kills` module
 * snapshot; a null snapshot yields no statuses and therefore NO CARDS, which is what every
 * assertion below reads as an empty roster. The snapshot is null until the ENGINE has folded the
 * log and gone live.
 *
 * AND THIS SPEC LAUNCHES ON THE REAL INSTALL — no staged fixture, deliberately, because the
 * portrait assertions need the game's own UI files. So what the engine must fold before the first
 * card can be drawn is the OWNER'S WHOLE LOG, twice (two launches against one userData, the second
 * proving the preference survived a restart).
 *
 * ── THE MEASUREMENT, AND WHAT IT ACTUALLY DIAGNOSED (JOS-501) ──────────────────────────────────
 *
 * This spec used to be quarantined in `run-all.mts` with a 900 s cap and a slot to itself, because
 * the harness built the engine in DEBUG:
 *
 *   debug    the go-live sentence had NOT arrived at 900 s. A timeout, not a duration.
 *   release  52.5 s per fold; green end to end in 145.5 s.
 *
 * JOS-501 made `buildEngineIfStale` build `--release` and had the harness hand the app that binary
 * outright, so both the cap and the quarantine are gone.
 *
 * BUT THE RELEASE ENGINE ONLY MADE THIS SPEC FINISHABLE — it did not make it pass. On the first
 * release run two roster assertions still read ZERO, and the reason is the trap this file's own
 * header describes: a step that settles on a card count is really settling on a WHOLE-LOG FOLD, and
 * it was doing so through a 30 s per-step cap that knew nothing about one. `launchOnRealInstall`
 * (engineSteps.mts) is the fix, and it belongs in a wait rather than in a cap — the suite's law is
 * to wait for the CONDITION, and the condition is the app saying it is serving from the engine. It
 * is the counterpart `launchOnFixture` has had since JOS-499; a real-install launch simply never
 * had a home to put the same wait in.
 *
 * IT WAS ALWAYS A DEV-HARNESS ARTIFACT, NOT A PRODUCT GAP: a user's app ships the release binary
 * and waits nothing like the debug numbers above. The deletion release did not make the product
 * slower — it moved the fold into a process the suite happened to build unoptimised.
 *
 * ── THE 400-LINE CEILING EXCEPTION (granted by the integrator, JOS-499) ────────────────────────
 *
 * This file is over `max-lines`, and the grant is recorded here rather than in the ratchet so the
 * next reader finds the reason beside the code. What earns it is the pair of constraints above: the
 * spec must launch on the REAL INSTALL (its portrait assertions read the game's own UI files, which
 * no staged fixture carries) and it must launch TWICE (the restart claim IS a userData dir
 * outliving a process). Neither can be shortened without deleting a claim, and the file is long
 * because those claims are many rather than because it is doing anything twice.
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
  note,
  reportRun,
  settle,
  settleGone,
  settleStable,
  waitHydrated
} from './appHarness.mjs'
import { launchOnRealInstall, mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { stepLoadoutSectionsAreHonest } from './loadoutSectionSteps.mjs'

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
/** The switch JOS-237 is about, and the label beside it (which the mode rewrites). */
const DEFEATED = '[data-testid="boss-defeated-only"]'
/** The toolbar's running count — the filter's yardstick, and unmoved by the filter itself. */
const TALLY = '[data-testid="boss-tally"]'
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

/** One card as this spec reads it: which target, and what the card itself says about it. */
interface CardFact {
  name: string
  /** THIS WEEK only: at least one rung under it is green (a lockout taken inside the window). */
  cleared: boolean
  /** OVERALL only: the corner chip reads `not defeated`, i.e. no kill is on the record. */
  undefeated: boolean
}

/**
 * ONE RENDER OF THE ROSTER: the switch, the tally, and the cards — read in a single evaluate so
 * they cannot describe different moments. See `readUnder` for why that matters here.
 */
interface FilterView {
  /** whether the Defeated switch is on; `null` when the control is not mounted */
  on: boolean | null
  /**
   * The toolbar's own count, `N / M` — the numerator is what the CURRENT MODE counts as defeated
   * (locked this week, or ever) and the denominator is the whole roster. It is derived from the
   * unfiltered statuses, so it is the filter's own yardstick from the same paint.
   */
  tally: { n: number; total: number }
  cards: CardFact[]
}

/**
 * Every card on screen, named by the target its own `title` attribute names, together with the
 * switch and the tally that produced them. Reading the NAME off each card (rather than counting)
 * is what lets a filtered view be compared to a SET — the difference between "the switch hid
 * something" and "the switch hid the right things".
 */
function filterView(page: Page): Promise<FilterView> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel.toggle)
    const input = root instanceof HTMLInputElement ? root : (root?.querySelector('input') ?? null)
    const counts = /^\s*(\d+)\s*\/\s*(\d+)/.exec(
      document.querySelector(sel.tally)?.textContent ?? ''
    )
    return {
      on: input instanceof HTMLInputElement ? input.checked : null,
      tally: { n: Number(counts?.[1] ?? -1), total: Number(counts?.[2] ?? -1) },
      cards: [...document.querySelectorAll(sel.card)].map((card) => ({
        name: (card.getAttribute('title') ?? '').split(' - ')[0],
        cleared: card.querySelector(`${sel.ladder} > [data-cleared="1"]`) !== null,
        undefeated: (card.textContent ?? '').includes('not defeated')
      }))
    }
  }, { card: CARD, ladder: LADDER, toggle: DEFEATED, tally: TALLY })
}

/** Whether the Defeated switch is on. `null` when the control is not mounted. */
async function defeatedOn(page: Page): Promise<boolean | null> {
  return (await filterView(page)).on
}

/** Names on screen, sorted — the comparable form of a card set. */
const names = (cards: CardFact[]): string[] => cards.map((c) => c.name).sort()

/**
 * The roster as it stands with the switch in a given position — with the switch PROVED to be in
 * that position, and the tally read, at the moment the cards were read.
 *
 * EVERY ASSERTION THIS SPEC MAKES ABOUT THE FILTER IS WITHIN ONE READING, and that is not
 * fussiness. This spec drives the app against the owner's LIVE log, which moves under it in two
 * ways that both produced a FALSE FAILURE while this step was being written — a red saying the fix
 * does not work, with the fix correct in the tree:
 *
 *   • THE FOLD LANDS MID-STEP. The roster's cards exist before any kill does (a target draws a
 *     card whether or not you have killed it), so a reading taken while months of log are still
 *     folding sees 32 cards and 0 defeated, and one taken a second later sees 31 defeated.
 *     Comparing the first to the second is comparing two different worlds. Hence `waitHydrated`
 *     before the step, AND the tally — which comes from the same paint as the cards, so
 *     "the switch left exactly what the tally counts" is true of either world.
 *   • A LIVE RE-RENDER CAN REMOUNT THE VIEW (the `viewKey` remount the sky-filters spec argues
 *     with at length), and `defeatedOnly` is plain component state that a remount resets — it is
 *     deliberately not persisted. A remount between "the switch reads on" and "here are the cards"
 *     reports the UNFILTERED roster as the switch's answer. Hence the switch is read in the same
 *     evaluate, and a reading whose switch is not where we put it is re-taken rather than believed.
 *
 * An emptied roster is an ABSENCE, so it is settled by the reading STOPPING rather than by a count
 * arriving (wave E3): on a week with no lock at all the right answer is zero cards, and no
 * `settle` predicate would ever fire.
 */
async function readUnder(page: Page, on: boolean, attempts = 3): Promise<FilterView | null> {
  for (let i = 0; i < attempts; i++) {
    if (!(await setDefeatedOnly(page, on))) continue
    const seen = await settleStable(() => filterView(page), { timeoutMs: 15_000 })
    if (seen.on === on) return seen
  }
  return null
}

/** What the switch CALLS itself right now — the mode rewrites it (JOS-237). */
function defeatedLabel(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    const label = root?.closest('.MuiFormControlLabel-root')?.querySelector('.MuiFormControlLabel-label')
    return label?.textContent?.trim() ?? ''
  }, DEFEATED)
}

/** Flip the switch and wait for the control itself to report the new state. */
async function setDefeatedOnly(page: Page, on: boolean): Promise<boolean> {
  if ((await defeatedOn(page)) === on) return true
  await page.click(DEFEATED, { timeout: 15_000 })
  return (await settle(() => defeatedOn(page), (v) => v === on, { timeoutMs: 8_000 })) === on
}

/**
 * JOS-237: "DEFEATED ONLY" ANSWERS THE QUESTION THE VIEW IS ASKING.
 *
 * Owner-reported while release-testing: the switch filtered on the ALL-TIME killed flag in BOTH
 * modes, so on THIS WEEK it kept every target ever defeated — cards whose five rungs were grey,
 * under a switch a raid coordinator flips to see what the week has taken.
 *
 * WHY THIS IS CLOCK-INDEPENDENT (the header's rule: this spec never says WHICH rung is green,
 * because the committed fixture's kills are fixed dates and the reset is real time). Nothing below
 * asserts a count. The claim is an EQUALITY BETWEEN TWO READINGS OF THE SAME SCREEN: the cards the
 * switch leaves behind are exactly the cards that were drawing a green rung a moment earlier. That
 * is true on any Tuesday, and it is false under the old code on every week in which the fixture's
 * ever-defeated set is larger than its locked-this-week set — which is the defect, stated as a
 * disagreement between the switch and the rungs rather than as a date.
 */
async function stepDefeatedOnlyIsThisWeek(page: Page): Promise<void> {
  // The fold has to be OVER before two readings of this roster describe the same world.
  await waitHydrated(page)
  const label = await defeatedLabel(page)
  check('THE SWITCH SAYS WHICH WEEK IT MEANS on the week view', label === 'Defeated this week', label)
  if (!check('the switch is off to begin with', (await defeatedOn(page)) === false)) return

  const before = await readUnder(page, false)
  const shown = await readUnder(page, true)
  if (!check('the week roster reads cleanly with the switch off and on', before !== null && shown !== null)) return
  const roster = before as FilterView
  const kept = shown as FilterView
  check(
    'the unfiltered week view is the whole roster',
    roster.cards.length === roster.tally.total,
    `${String(roster.cards.length)} cards / ${String(roster.tally.total)} targets`
  )

  check(
    'DEFEATED ONLY, ON THIS WEEK, IS THIS WEEK - it leaves exactly what the tally calls locked',
    kept.cards.length === kept.tally.n,
    `${String(kept.cards.length)} shown / ${String(kept.tally.n)} locked of ${String(kept.tally.total)}`
  )
  check(
    'every card that survived the filter is showing a green rung',
    kept.cards.every((c) => c.cleared),
    `${String(kept.cards.length)} cards`
  )
  // …and they are the same cards the UNFILTERED view drew green. Only comparable when the two
  // readings agree about the week; the live log is allowed to move between them, and a kill
  // landing mid-step is a different world, not a broken filter.
  const green = names(roster.cards.filter((c) => c.cleared))
  if (roster.tally.n === kept.tally.n) {
    check(
      '…and they are the cards the unfiltered view drew green, one for one',
      names(kept.cards).join('|') === green.join('|'),
      `${String(kept.cards.length)} shown / ${String(green.length)} green`
    )
  } else {
    note(`bosses-week: the week moved between readings (${String(roster.tally.n)} then ${String(kept.tally.n)} locked) - set comparison skipped`)
  }

  // The other mode measures the set this switch USED to show here, so the two can be compared.
  const everDefeated = await stepDefeatedOnlyIsAllTime(page)
  if (everDefeated === kept.tally.n) {
    note(
      `bosses-week: this week's locks and the whole kill history are the same size (${String(everDefeated)}), so the all-time/this-week split is not separable on this run`
    )
  } else {
    check(
      '…and the week view showed THIS WEEK rather than the all-time roster it used to',
      kept.cards.length !== everDefeated,
      `${String(kept.cards.length)} shown this week vs ${String(everDefeated)} ever defeated`
    )
  }

  const back = await settle(() => countOf(page, CARD), (n) => n === roster.tally.total, { timeoutMs: 15_000 })
  check('…and with the switch off the whole roster is back', back === roster.tally.total, `${String(back)} / ${String(roster.tally.total)}`)
}

/**
 * The other mode, and the half that must NOT have changed: on OVERALL the switch is still the
 * all-time filter it has always been, and still calls itself that. It is entered from the week
 * view with the switch already ON, because a mode change that silently dropped the filter would
 * pass every assertion made one mode at a time.
 *
 * Returns how many targets are defeated ALL-TIME — measured here, with the filter off, because
 * `not defeated` is a thing only the overall chip ever says (the week chip says `open`, which is
 * a different sentence). It leaves the view back on This week with the switch off.
 */
async function stepDefeatedOnlyIsAllTime(page: Page): Promise<number> {
  const picked = await setMode(page, MODE_OVERALL, 'overall')
  if (!check('switching to Overall with the filter still on', picked === 'overall', String(picked))) return -1
  const label = await defeatedLabel(page)
  check('THE LABEL GOES BACK to the all-time wording', label === 'Defeated only', label)

  const filtered = await readUnder(page, true)
  const all = await readUnder(page, false)
  if (!check('the overall roster reads cleanly with the switch on and off', filtered !== null && all !== null)) {
    return -1
  }
  const kept = filtered as FilterView
  const roster = all as FilterView
  const everDefeated = kept.tally.n
  check(
    'DEFEATED ONLY, ON OVERALL, IS STILL EVER-DEFEATED - the tally its own view states',
    kept.cards.length === everDefeated,
    `${String(kept.cards.length)} shown / ${String(everDefeated)} defeated of ${String(kept.tally.total)} targets`
  )
  check(
    '…so no `not defeated` card survives it',
    kept.cards.every((c) => !c.undefeated),
    `${String(kept.cards.filter((c) => c.undefeated).length)} undefeated of ${String(kept.cards.length)}`
  )
  check(
    '…and switching it off puts every target back',
    roster.cards.length === roster.tally.total,
    `${String(roster.cards.length)} cards / ${String(roster.tally.total)} targets`
  )

  const week = await setMode(page, MODE_WEEK, 'week')
  check('…and This week comes back for the rest of the spec', week === 'week', String(week))
  return everDefeated
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
  await stepDefeatedOnlyIsThisWeek(page)

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
  // process, so the launch helper must not delete what it did not create.
  const userData = makeUserData()
  try {
    console.log('launch 1: a fresh install - the default, the ladder, and both round trips…')
    const first = await launchOnRealInstall({ userData }, 'launch 1')
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
      await stepLoadoutSectionsAreHonest(page)
      await stepArmRestart(page)
      if (failures.length) await dumpArtifacts(page, 'bosses-week-FAIL')
    } finally {
      await first.close()
    }

    console.log('launch 2: the SAME userData dir, a new process - This week must still be there…')
    const second = await launchOnRealInstall({ userData }, 'launch 2')
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
