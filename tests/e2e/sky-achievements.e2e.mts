/**
 * Headless Electron integration test for THE ACHIEVEMENTS DUMP MARKING SKY QUESTS (JOS-429).
 *
 * THE REPORTS, four wordings of one question: 01M0GH44G2F0EB1CH83RR7NT5Z ("There doesn't seem to be
 * a way to import what Plane of Sky achievements I've already completed"), 01M00NET9PEG9MEB1J5BT7KBJQ
 * ("sky quests -- process /outputfile achievements to close completed quests"),
 * 01M0BF54C4159KG7S19QNBQ4VZ, and Fountsy on Reddit ("if i forgot to turn logs on and did a bunch
 * of sky raids... how would I import that data?"). The turn-in ledger knows log-detected trades,
 * hand statements and the legacy key — and a player who did Sky on another PC, before installing,
 * or with logging off has none of them.
 *
 * THE ANSWER, argued in full in shared/outputs/achievements.ts and
 * renderer/features/posky/achievementInference.ts: `/outputfile achievements` carries one
 * `Obtain <Item>` row per Sky quest reward with a status the SERVER decided. That is not an
 * inference from a bag; it is the answer, and it outranks the reward inference it composes with.
 *
 * WHY THIS NEEDS A REAL APP. The parse and the join are pure and pinned without a browser
 * (tests/outputsAchievements.test.mts, tests/achievementInference.test.mts). What no unit test can
 * see is the CHAIN, and it is longer than issue #27's: an achievements file in the EQ install root
 * → the outputs registry finds and stats it → `parseAchievementsDump` → `classUnlockClaims` →
 * main's store → the `progress:changed` push → `useProgress` → the join → the ladder → the badge,
 * the disabled undo, and the freshness line on the row a user is actually looking at. JOS-87 is
 * this repo's standing reminder that a chain like that breaks at a seam every unit test is happy
 * with — and TWO of these seams are new (a second graduated kind, and a second derived source).
 *
 * THE FIXTURE PAIR IS WHAT MAKES THE CLAIM CLEAN, and both halves are committed:
 *   * `e2e-copy.log` carries ZERO loot lines and ZERO completed trades, so the turn-in ledger is
 *     empty on this launch and no inventory export is staged. Every badge below therefore has
 *     exactly one possible source.
 *   * `Primitive_freeport-Achievements.txt` is the owner's own real dump, and it marks 48 of the 95
 *     Sky quests `C` — of which 44 COUNT and four do not, because they sit under the one class the
 *     owner confirmed and the server cascaded the grant into their rows (JOS-441). MEASURED over the
 *     committed pair (tests/achievementInference.test.mts asserts the same 44 and names the same
 *     four from the other side), so both numbers are assertions about the join rather than numbers
 *     to trust.
 *
 * THIS IS THE TICKET'S ACCEPTANCE CRITERION RUN END TO END: the owner's own achievements file,
 * loaded by the real app, marks their completed Sky quests — and the second launch proves the other
 * half, that a file with no sky rows changes nothing.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir per launch.
 *
 * Run: `npm run test:e2e -- sky-achievements`.
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  reportRun,
  settle
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
const SEARCH = '[data-testid="posky-search"]'
const COUNTS = '[data-testid="posky-counts"]'
const ROW = '[data-testid="posky-quest-row"]'
const SUMMARY = `${ROW} .MuiAccordionSummary-root`
const BADGE = '[data-testid="posky-turned-in"]'
/** The JOS-441 chip: evidence that speaks without counting. Its OWN testid, never the one above. */
const CLASS_UNLOCK = '[data-testid="posky-class-unlock"]'
const UNDO = '[data-testid="posky-undo-turnin"]'
const TURNIN_COUNT = '[data-testid="posky-turnin-count"]'
/** JOS-145's box: the has-EVER-turned-in reading of done, which a derived count has to satisfy. */
const HIDE_TURNED_IN = '[data-testid="posky-hide-turned-in"]'
/** The kind's own freshness line (JOS-429), the SAME component the inventory dump gets. */
const FRESH = '[data-testid="posky-achievements-fresh"]'

/**
 * The owner's own dump, and how many of the 95 quests it COUNTS (measured, and asserted below).
 *
 * 48 rows read `C`; four of them are the confirmed Paladin's, where the server cascaded the grant
 * into every component and the row stopped being about the quest (JOS-441). So 44 is the number of
 * quests this file can floor, and the four it cannot are asserted separately below rather than being
 * quietly missing from a total.
 */
const DUMP = 'Primitive_freeport-Achievements.txt'
const MARKED = 44
/** A quest the dump marks `C` under an EARNED class — Dark Cloak of the Sky. */
const VOUCHED = 'Ranger Test of Defense'
/** A quest the same dump marks `I` — Cudgel of the Fool. The control. */
const UNVOUCHED = 'Berserker Test of Fools Errand'
/**
 * A quest under the class the owner CONFIRMED — Truvinan, marked `C` by the cascade and by nothing
 * else. No inventory export is staged on this launch, so the reward inference cannot speak for it
 * either and what is left on screen is the class-unlock chip alone.
 */
const CASCADED = 'Paladin Test of Compassion'

/** How many quests the filters leave, off the counts line. `null` when it is not mounted. */
function filteredCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const m = /(\d+) of (\d+) quests/.exec(document.querySelector(sel)?.textContent ?? '')
    return m ? Number(m[1]) : null
  }, COUNTS)
}

/** The badge as the DOM states it: the count, whether it is derived, and WHICH source said so. */
function chip(
  page: Page,
  sel: string
): Promise<{
  count: number | null
  inferred: string | null
  evidence: string | null
  title: string
  label: string
}> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return { count: null, inferred: null, evidence: null, title: '', label: '' }
    const n = el.getAttribute('data-count')
    return {
      count: n === null ? null : Number(n),
      inferred: el.getAttribute('data-inferred'),
      evidence: el.getAttribute('data-evidence'),
      title: el.getAttribute('title') ?? '',
      label: el.textContent ?? ''
    }
  }, sel)
}

const badge = (page: Page): ReturnType<typeof chip> => chip(page, BADGE)

/** The undo control's state and the one thing it has to say for itself when it cannot act. */
function undo(page: Page): Promise<{ disabled: boolean | null; title: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { disabled: null, title: '' }
    // The title lives on the SPAN the tooltip needed, because a disabled button swallows no events.
    return {
      disabled: (el as HTMLButtonElement).disabled,
      title: el.closest('span')?.getAttribute('title') ?? ''
    }
  }, UNDO)
}

/** Narrow the list to one quest by name, and expand it so its detail toolbar exists. */
async function openQuest(page: Page, name: string): Promise<boolean> {
  await page.fill(`${SEARCH} input`, name)
  const only = await settle(() => filteredCount(page), (n) => n === 1, { timeoutMs: 30_000 })
  if (!check(`the search narrows to ${name} alone`, only === 1, `filtered=${String(only)}`)) {
    return false
  }
  await page.click(SUMMARY, { timeout: 15_000 })
  const drawn = await settle(() => countOf(page, TURNIN_COUNT), (n) => n === 1, { timeoutMs: 20_000 })
  return check(`…and expanding ${name} draws its turn-in controls`, drawn === 1, String(drawn))
}

/** Land, and open the Sky tab on its filter bar. */
async function openSky(page: Page): Promise<boolean> {
  await page.click(NAV_SKY, { timeout: 30_000 })
  const bar = await page.waitForSelector(SEARCH, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the Sky tab opens on its filter bar', bar)) return false
  return check('…with the counts line under it', (await filteredCount(page)) !== null)
}

/**
 * THE COUNT, FIRST — because the claim is that the dump marks the quests it marks and NOT the whole
 * Plane, and because 44 is a big enough number that a blanket bug would look like success on any
 * single row.
 *
 * COUNTED OFF THE COUNTS LINE, NOT OFF THE BADGES ON SCREEN — the JOS-191 paging argument, exactly
 * as issue #27's spec makes it: rendered badges answer "how many are on the first page". The tab's
 * own "hide quests I have turned in" box is `everTurnedIn` over the whole visible set, so the
 * difference it makes IS the number of quests this launch reads as turned in. The ledger is empty
 * and no inventory export is staged, so that difference is the achievements dump and nothing else.
 */
async function stepTheDumpMarksExactlyWhatItMarks(page: Page): Promise<void> {
  const all = await settle(() => filteredCount(page), (n) => n !== null && n > 1, {
    timeoutMs: 45_000
  })
  if (!check('the tab opens on the whole Plane', all !== null && all > 1, `quests=${String(all)}`)) {
    return
  }
  await page.click(HIDE_TURNED_IN, { timeout: 15_000 })
  const kept = await settle(() => filteredCount(page), (n) => n !== null && n < (all ?? 0), {
    timeoutMs: 20_000
  })
  check(
    `THE OWNER'S OWN ACHIEVEMENTS FILE MARKS THEIR ${String(MARKED)} COMPLETED SKY QUESTS`,
    all !== null && kept === all - MARKED,
    `of ${String(all)} quests, ${String((all ?? 0) - (kept ?? 0))} read as turned in`
  )
  await page.click(HIDE_TURNED_IN, { timeout: 15_000 })
  const back = await settle(() => filteredCount(page), (n) => n === all, { timeoutMs: 20_000 })
  check('…and unticking the box leaves the tab exactly as it was found', back === all, String(back))
}

/**
 * THE ROW: the reports' own sentence, on screen. A quest the dump marks `C` reads turned in, the
 * badge says the reading is derived, and it names WHICH source — the thing that separates this from
 * issue #27's floor on a tab where both can be true at once.
 */
async function stepAMarkedQuestReadsAsATurnIn(page: Page): Promise<void> {
  if (!(await openQuest(page, VOUCHED))) return
  const b = await badge(page)
  check(`${VOUCHED} reads TURNED IN off the achievements dump alone`, b.count === 1, `count=${String(b.count)}`)
  check(
    '…and the badge SAYS the reading is derived rather than read out of the log',
    b.inferred === 'true',
    `data-inferred=${String(b.inferred)}`
  )
  check(
    '…and NAMES the achievements dump as the source, not the inventory export',
    b.evidence === 'achievement',
    `data-evidence=${String(b.evidence)}`
  )
  check(
    'THE BADGE ITSELF READS DIFFERENT FROM AN OBSERVED TURN-IN, not only its hover (JOS-441)',
    b.label.includes('Turned in') && b.label.includes('achievements'),
    b.label
  )
  check(
    '…in words, on hover, naming the export as the evidence',
    b.title.includes('achievements export'),
    b.title
  )
  const u = await undo(page)
  check(
    'THE UNDO IS HONESTLY DEAD: the achievement is still earned, so a take-back would not survive',
    u.disabled === true,
    `disabled=${String(u.disabled)}`
  )
  check(
    '…and says exactly that instead of looking broken',
    u.title.includes('achievements export'),
    u.title
  )
}

/**
 * ONE-DIRECTIONAL, on the surface. An `I` row is NOT evidence the quest was never turned in — it is
 * the same "a dump adds, it never subtracts" promise the inventory export already makes — so the
 * control row is untouched rather than un-completed.
 */
async function stepAnUnearnedQuestIsUntouched(page: Page): Promise<void> {
  if (!(await openQuest(page, UNVOUCHED))) return
  const b = await badge(page)
  check(
    `${UNVOUCHED} has no badge at all — an unearned row proves nothing either way`,
    b.count === null,
    String(b.count)
  )
  const u = await undo(page)
  check(
    '…and its undo is dead for the OLD reason, with the old words',
    u.title === 'Nothing to take back',
    u.title
  )
}

/**
 * THE DEFECT ITSELF, ON SCREEN (JOS-441). Three v1.7.0 reporters watched Sky quests they had never
 * run come back "Turned in" after `/outputfile achievements`, because the class unlock they were
 * granted cascaded `C` into every component. This is that row: it does NOT read as a turn-in, it
 * carries its own chip under its own testid, and the chip says what the file claims and why the tab
 * is not counting it — so nobody has to guess whether the app is broken or the evidence is.
 */
async function stepACascadedQuestIsTrackedButNotCounted(page: Page): Promise<void> {
  if (!(await openQuest(page, CASCADED))) return
  const b = await badge(page)
  check(
    `${CASCADED} does NOT read as turned in — the reports' own sentence, refused`,
    b.count === null,
    `data-count=${String(b.count)}`
  )
  const u = await chip(page, CLASS_UNLOCK)
  check(
    '…yet the evidence is still tracked and drawn, under its own testid',
    u.evidence === 'class-unlock',
    `data-evidence=${String(u.evidence)}`
  )
  check('…with a count of zero on the chip', u.count === 0, `data-count=${String(u.count)}`)
  check('…labelled as what it is rather than as a turn-in', u.label.includes('Class unlock'), u.label)
  check(
    '…and saying, on hover, that the class unlock was granted',
    u.title.includes('NOT counted') && u.title.includes('Primary Class Unlock Token'),
    u.title
  )
  const un = await undo(page)
  check(
    'the undo is dead because there is nothing to take back, not because we refuse',
    un.disabled === true && un.title.includes('Nothing to take back'),
    `disabled=${String(un.disabled)} title=${un.title}`
  )
}

/**
 * THE FRESHNESS LINE, which is the SAME component the inventory dump gets (the ticket's one
 * explicit UX constraint: do not invent a second one). It has to name the command verbatim out of
 * the registry, so a player who has never typed it learns it from the tab.
 */
async function stepTheFreshnessLineSpeaksForTheKind(page: Page): Promise<void> {
  await page.fill(`${SEARCH} input`, '')
  const text = await settle(
    () => page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', FRESH),
    (t) => t.length > 0,
    { timeoutMs: 30_000 }
  )
  check('the Sky tab draws the achievements freshness line', text.length > 0, text)
  check(
    '…naming the command verbatim, out of the registry rather than a hand-typed string',
    text.includes('/outputfile achievements'),
    text
  )
}

/**
 * THE OTHER HALF OF THE ACCEPTANCE CRITERION, and it needs its own launch because it is a claim
 * about a DIFFERENT file: staged with no achievements dump at all, the tab reads exactly as it did
 * before this ticket. Nothing is marked, and the line says the command has not been run.
 *
 * A SECOND LAUNCH RATHER THAN A SECOND ASSERTION, deliberately: the store is per-userData and a
 * launch that had already loaded a dump would be asserting about its own memory rather than about
 * the file. `launchOnFixture` gives each launch its own staged install and its own userData.
 */
async function stepNoDumpChangesNothing(): Promise<void> {
  const launched = await launchOnFixture('e2e-copy.log')
  let page: Page | null = null
  try {
    page = await mainWindow(launched.app)
    await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
    if (!(await openSky(page))) return
    const all = await settle(() => filteredCount(page), (n) => n !== null && n > 1, {
      timeoutMs: 45_000
    })
    await page.click(HIDE_TURNED_IN, { timeout: 15_000 })
    // An ABSENCE, so it is settled rather than sampled once (the settleStable discipline): the box
    // has to be given every chance to remove a row before "it removed none" is a claim.
    const kept = await settle(() => filteredCount(page), (n) => n === all, { timeoutMs: 20_000 })
    check(
      'WITH NO ACHIEVEMENTS DUMP STAGED, not one quest reads as turned in',
      kept === all && all !== null,
      `of ${String(all)} quests, ${String((all ?? 0) - (kept ?? 0))} read as turned in`
    )
    const text = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', FRESH)
    check(
      '…and the freshness line says the command has never been run, rather than saying nothing',
      text.includes('/outputfile achievements') && /not yet run/i.test(text),
      text
    )
    if (failures.length) await dumpArtifacts(page, 'sky-achievements-none-FAIL')
  } finally {
    await launched.close()
  }
}

async function main(): Promise<void> {
  buildIfStale()

  const launched = await launchOnFixture('e2e-copy.log', { achievements: DUMP })
  let page: Page | null = null
  try {
    page = await mainWindow(launched.app)
    await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
    if (!(await openSky(page))) {
      throw new Error('never reached the Sky tab — nothing below can be asserted')
    }
    await stepTheDumpMarksExactlyWhatItMarks(page)
    await stepAMarkedQuestReadsAsATurnIn(page)
    await stepAnUnearnedQuestIsUntouched(page)
    await stepACascadedQuestIsTrackedButNotCounted(page)
    await stepTheFreshnessLineSpeaksForTheKind(page)
    if (failures.length) await dumpArtifacts(page, 'sky-achievements-FAIL')
  } finally {
    await launched.close()
  }

  await stepNoDumpChangesNothing()

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
