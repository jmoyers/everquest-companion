/**
 * Headless Electron integration test for THE ERA FOLD ON MOB LOOT (JOS-377).
 *
 * THE BUG, in the owner's words: the Cazic Thule mob page lists Fear-revamp loot that is not in
 * the game. The wiki's own mob page transcludes `{{:Item}}` per row and each row draws its OUT OF
 * ERA pill from the ITEM page; our mob-loot surfaces rendered the catalog's `dropsWiki` straight
 * through and never consulted the era layer, so seven items - Bile Etched Obsidian Choker, Brain
 * of Cazic Thule, Cloak of the Fearsome, Eye of Cazic Thule, Halo of the Enlightened, Pauldrons of
 * Ferocity, Robe of Inspiration - were offered as loot you could go and get.
 *
 * WHY ITS OWN FILE. There was no mobs spec: the mob page is reached inside `deep-link-back` (whose
 * subject is the NAVIGATION SEAM and which is at its own factoring ceiling) and nowhere else. This
 * one's subject is a DATA LAW rendered on two surfaces, so it drives both in one launch - the
 * Overview's current-mob card and the Mobs tab's creature page - which is also what keeps the
 * suite from paying for a second Electron.
 *
 * WHY IT CAN STATE EXACT NUMBERS where a live-log spec must state floors: nothing here is read off
 * the player's log. The drop table is the COMMITTED catalog (`data/eqlegends/mobs.json`) and the
 * era evidence is the COMMITTED item corpus (`main/data/items.json`), so 18 = 11 + 7 is a fact
 * about bytes in the repo. `tests/mobDropEra.test.mts` pins the same split without a browser; this
 * spec is about what a READER sees, which is the half a unit test cannot reach.
 *
 * THE ONE THING IT READS FROM A LOG is the current-mob card's SUBJECT: the card follows
 * `currentTarget`, so the spec scripts a pull at Cazic Thule through the append driver, the same
 * path a real `You crush …` takes.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir minted per launch.
 *
 * Run: `npm run test:e2e -- mob-drops-era`.
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
  waitHydrated
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'

const GRID = '[data-testid="overview-grid"]'
const MOB_CARD = '[data-testid="overview-mob"]'
const MOB_NAME = '[data-testid="overview-mob-name"]'
const CARD_ERA_TOGGLE = '[data-testid="overview-mob-era-toggle"]'
const NAV_MOBS = '[data-testid="nav-mobs"]'
const SEARCH = '[data-testid="mobs-search"]'
const RESULT_ROW = '[data-testid="mobs-result-row"]'
/**
 * The BROWSE view's zone roster — "the mobs in the zone you are standing in".
 *
 * It is here because it draws `mobs-result-row` too, exactly as the search results do, so "a result
 * row exists" does NOT mean "the search has been applied". Waiting for this to go is what tells the
 * two modes apart. See `openMobPage`.
 */
const ZONE_ROSTER = '[data-testid="mobs-zone-roster"]'
const DROP_ROW = '[data-testid="mob-drop-row"]'
const PAGE_ERA_TOGGLE = '[data-testid="mob-drops-era-toggle"]'
/** The planner's chip, on a mob page's rows — the identity IS the point (one chip, one verdict). */
const ERA_CHIP = '[data-testid="planner-era-chip"]'
const DROPS_STAT = '[data-testid="mob-stat-drops"]'

/** The mob the report was about, spelled as the catalog spells it. */
const MOB = 'Cazic Thule'
/** What the committed data says about it: 18 listed, 7 of them out of era. */
const LISTED = 18
const OUT_OF_ERA = 7
const IN_ERA = LISTED - OUT_OF_ERA
/** One of the seven, chosen because its name cannot collide with an in-era row's. */
const FOLDED_ITEM = 'Brain of Cazic Thule'

/** Wait for a selector to be mounted; false rather than a throw, so a step can report instead. */
function appears(page: Page, sel: string, ms = 20_000): Promise<boolean> {
  return page.waitForSelector(sel, { timeout: ms }).then(
    () => true,
    () => false
  )
}

/** Rendered text of the first match, whitespace collapsed; '' when the node isn't mounted. */
async function textOf(page: Page, sel: string): Promise<string> {
  const raw = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '',
    sel
  )
  return raw.replace(/\s+/g, ' ').trim()
}

/** Land, and let the startup replay finish — the card below fills from the live engine. */
async function stepReady(page: Page): Promise<void> {
  if (!check('the app lands on the Overview', await appears(page, GRID, 60_000))) {
    throw new Error('never landed on Overview — nothing below can be asserted')
  }
  const { snap } = await waitHydrated(page)
  if (!check('hydration completes (the replay has finished)', !snap.hydrating)) {
    throw new Error('still hydrating — nothing below can be asserted')
  }
}

/**
 * 1. THE CURRENT-MOB CARD, mid-pull.
 *
 * The card a player actually reads while swinging. It has room for eight rows and hands the rest
 * to the page, so the claim is not about a count — it is that the seven are NOT among the rows it
 * shows, and that one line offers them.
 */
async function stepCurrentMobCard(page: Page, log: FixtureLog): Promise<void> {
  const now = Date.now()
  log.appendAt(new Date(now - 3000), `You crush ${MOB} for 41 points of damage.`)
  log.appendAt(new Date(now - 1000), `You slash ${MOB} for 37 points of damage.`)
  const name = await settle(() => textOf(page, MOB_NAME), (t) => t === MOB, { timeoutMs: 20_000 })
  if (!check('a swing makes Cazic Thule the current target', name === MOB, name)) {
    note('the card never took the scripted target — the rest of this step cannot be asserted')
    return
  }
  // The drop list arrives an IPC round trip after the card mounts, so wait for the fold's own
  // affordance rather than for the clock. Its ABSENCE would be the bug, not a timing artifact.
  if (!check('the card offers the folded rows as a disclosure', await appears(page, CARD_ERA_TOGGLE, 20_000))) return
  check(
    `…which names how many there are ("+${String(OUT_OF_ERA)} out of era")`,
    (await textOf(page, CARD_ERA_TOGGLE)) === `+${String(OUT_OF_ERA)} out of era`,
    await textOf(page, CARD_ERA_TOGGLE)
  )
  const collapsed = await textOf(page, MOB_CARD)
  check(
    'the rows it shows do NOT include the revamp table (the owner report)',
    !collapsed.includes(FOLDED_ITEM),
    collapsed.slice(0, 160)
  )
  await page.click(CARD_ERA_TOGGLE, { timeout: 15_000 })
  const expanded = await settle(
    () => textOf(page, MOB_CARD),
    (t) => t.includes(FOLDED_ITEM),
    { timeoutMs: 10_000 }
  )
  check(
    '…and one click still says what the wiki lists (a disclosure, not a deletion)',
    expanded.includes(FOLDED_ITEM)
  )
}

/** Reach the Mobs tab's creature page for the mob by name, through the catalog search. */
async function openMobPage(page: Page): Promise<boolean> {
  await page.click(NAV_MOBS, { timeout: 15_000 })
  if (!(await appears(page, SEARCH))) return check('the Mobs tab offers its catalog search', false)
  await page.fill(SEARCH, MOB, { timeout: 15_000 })
  // WAIT FOR THE MODE, NOT FOR "A ROW" (JOS-510). The Mobs tab draws `mobs-result-row` in BOTH of
  // its modes — the browse view's zone roster and the search results — so a bare "a row appeared"
  // can be satisfied by the roster that was already on screen before a key was pressed, and the
  // read below then takes the first mob of the CURRENT ZONE instead of the top search hit.
  //
  // It is a real race and it was always here; what exposed it was the served-data store landing the
  // `character` module (and so the zone) on the tab's FIRST render instead of a round trip later,
  // which is the improvement that ticket is for. Before it, the roster was still empty at this
  // instant and waiting for "a row" accidentally meant the right thing. The ranking is separately
  // low-priority work (`useDeferredValue`), so the browse view legitimately survives a frame or two
  // past the keystroke either way.
  //
  // The roster's disappearance is the honest signal — it is the mode switching, and it says nothing
  // about WHICH mob ranks first, so the assertion below still has something to prove.
  await settle(() => countOf(page, ZONE_ROSTER), (n) => n === 0, { timeoutMs: 10_000 })
  if (!(await appears(page, RESULT_ROW))) return check(`the catalog finds ${MOB}`, false)
  // The catalog's own ranking puts the God page first (score ties break on drop count, and 18 is
  // the most of any Cazic-Thule row) — asserted rather than assumed, because the whole spec is
  // about THAT page's table.
  const first = await textOf(page, RESULT_ROW)
  if (!check('the top hit is the creature itself, not something in its temple', first.startsWith(MOB), first)) {
    return false
  }
  await page.click(RESULT_ROW, { timeout: 15_000 })
  return check('its page opens', await appears(page, DROP_ROW, 20_000))
}

/**
 * 2. THE MOB PAGE — the surface the report was filed against.
 *
 * Every number here is stated twice over: once as itself, and once as the sum that proves nothing
 * was deleted. That second reading is the honesty law made testable — hiding a row and losing a
 * row look identical from the outside unless the spec adds them up.
 */
async function stepMobPage(page: Page): Promise<void> {
  if (!(await openMobPage(page))) return
  const shown = await settle(() => countOf(page, DROP_ROW), (n) => n === IN_ERA, { timeoutMs: 15_000 })
  check(`the page shows ${String(IN_ERA)} drops by default (it showed ${String(LISTED)})`, shown === IN_ERA, String(shown))
  check(
    'none of the shown rows is chipped — they are all in era',
    (await countOf(page, ERA_CHIP)) === 0,
    String(await countOf(page, ERA_CHIP))
  )
  if (!check('the folded rows are offered as a disclosure', await appears(page, PAGE_ERA_TOGGLE))) return
  check(
    `…reading "+${String(OUT_OF_ERA)} out of era"`,
    (await textOf(page, PAGE_ERA_TOGGLE)) === `+${String(OUT_OF_ERA)} out of era`,
    await textOf(page, PAGE_ERA_TOGGLE)
  )

  // The tally strip must agree with the list it heads, or the page states two answers to one
  // question — which is how the old count read 18 over a list of 18 unreachable-in-part rows.
  const stat = await textOf(page, DROPS_STAT)
  check(
    'the Known drops card leads with what you can go and get',
    stat.startsWith(`${String(IN_ERA)} `) || stat.startsWith(`${String(IN_ERA)}\n`),
    stat
  )
  check('…and still states the folded ones beside it', stat.includes(`+${String(OUT_OF_ERA)} out of era`), stat)

  await page.click(PAGE_ERA_TOGGLE, { timeout: 15_000 })
  const all = await settle(() => countOf(page, DROP_ROW), (n) => n === LISTED, { timeoutMs: 10_000 })
  check(
    `expanding it restores the whole table (${String(IN_ERA)} + ${String(OUT_OF_ERA)} = ${String(LISTED)}, nothing deleted)`,
    all === LISTED,
    String(all)
  )
  check(
    'every restored row wears the era chip that says why it was folded',
    (await countOf(page, ERA_CHIP)) === OUT_OF_ERA,
    String(await countOf(page, ERA_CHIP))
  )
  const revamp = await textOf(page, PAGE_ERA_TOGGLE)
  check('the disclosure keeps its label while open', revamp === `+${String(OUT_OF_ERA)} out of era`, revamp)

  await page.click(PAGE_ERA_TOGGLE, { timeout: 15_000 })
  const back = await settle(() => countOf(page, DROP_ROW), (n) => n === IN_ERA, { timeoutMs: 10_000 })
  check('…and closing it folds them away again', back === IN_ERA, String(back))
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-deep-link.log…')
  const { app, close, log } = await launchOnFixture('e2e-deep-link.log')

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await stepReady(page)
    await stepCurrentMobCard(page, log)
    await stepMobPage(page)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'mob-drops-era-FAIL')
    else await dumpArtifacts(page, 'mob-drops-era-pass')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
