// buffAllowSteps — THE TRACKING ALLOW-LIST, IN THE REAL APP (JOS-168).
//
// Its own module for the reason `buffPermanentSteps.mts` and `buffDismissSteps.mts` are: the spec
// that uses it is at the repo's 400-code-line factoring ceiling, and this is a narrative of its own.
//
// THE OWNER'S ASK, END TO END: turn the mode on, find a spell by searching the buffs/debuffs list,
// check it there, and see only that spell on the overlay.
//
// WHAT ONLY THE REAL APP CAN SHOW. `tests/buffAllowList.test.mts` owns the model and the filter on
// committed fixture bytes — the tri-state, the mode, the normalizer, and which rows survive
// `filterAllowedRows`. What no unit test can claim is that the PIECES ARE WIRED, and this feature is
// almost entirely wiring:
//
//   1. TWO WINDOWS. The controls are on the Buffs tab in the MAIN window; the rows they filter are
//      in a separate BrowserWindow with its own renderer process and its own localStorage. A box
//      pressed in one has to reach the other over IPC — persist in main, broadcast, adopt — and
//      every one of those four steps passes its own unit test while the box does nothing.
//   2. THE DISPLAY-FILTER LAW (JOS-215, inherited). The tab must keep listing the buff you just
//      unchecked and its header chip must keep counting it, while the window stops drawing it. Both
//      halves are on screen at once, in two processes, and only a running app has both.
//   3. THE DROP FLASH MUST STAY QUIET. Unchecking removes rows, and this window's whole job is to
//      shout when a positive spell drops. "Valor dropped" at the instant the user unchecked Valor
//      would be the app arguing with them.
//
// WAIT FOR THE CONDITION, NEVER FOR THE CLOCK (wave E3): every read goes through settle /
// settleStable, and the ABSENCE claims use settleStable.

import type { Page } from 'playwright-core'
import { check, countOf, settle, settleStable } from './appHarness.mjs'
import type { FixtureLog } from './logFixture.mjs'
import { setShowPermanent, timerRows } from './buffTimerSteps.mjs'

/**
 * VALOR, and it is chosen rather than picked at random.
 *
 * It is the one self buff in this fixture whose landing sentence the model resolves to a single
 * NAME (the drop-flash step relies on the same property), so the row reads `Valor`, its line key is
 * `valor`, and the search below can name it. It also already has a mined stats row by the time this
 * step runs — the drop-flash step cast one and let it fade — which is exactly the situation the
 * search exists for: a spell you want to allow that is not currently up.
 */
const SPELL = 'Valor'
const LINE = 'valor'

const MODE = '[data-testid="buffs-allow-mode"]'
const SEARCH = '[data-testid="buff-stats-search"] input'
const STATS_ROW = '[data-testid="buff-stats-row"]'
const BOX = '[data-testid="buff-allow-check"]'

/** The real two-line shape: the cast that anchors it as yours, then the landing a second on. */
function castValor(log: FixtureLog): void {
  const at = new Date()
  log.appendAt(at, `You begin casting ${SPELL}.`)
  log.appendAt(new Date(at.getTime() + 1_000), 'You feel valorous.')
}

/** Every drop notice currently on the window. */
function dropNotices(overlay: Page): Promise<string[]> {
  return overlay.evaluate(() =>
    [...document.querySelectorAll('[data-testid="buff-timer-drop"]')].map((e) => e.textContent?.trim() ?? '')
  )
}

/** The mode switch's own state, read off the element rather than inferred from the label. */
function modeOn(page: Page): Promise<boolean> {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.getAttribute('data-opt-in') === 'true',
    MODE
  )
}

/** Every allow-list box on the page, as `line -> checked`. Cards and stats rows alike. */
function boxes(page: Page): Promise<{ line: string; checked: boolean }[]> {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((el) => ({
        line: el.getAttribute('data-line') ?? '',
        checked: el.getAttribute('data-checked') === 'true'
      })),
    BOX
  )
}

/** The spell names the DURATIONS tables are currently showing, across every class. */
function statsSpells(page: Page): Promise<string[]> {
  return page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].map((el) => el.getAttribute('data-spell') ?? ''),
    STATS_ROW
  )
}

/** The header chip's two figures — what the MODEL believes, which no filter may move. */
function headerCounts(page: Page): Promise<string> {
  return page.evaluate(() => /\d+ active · \d+ tracked/.exec(document.body.innerText)?.[0] ?? '')
}

/** The names the timer window is drawing right now. */
async function drawn(overlay: Page): Promise<string[]> {
  return (await timerRows(overlay)).map((r) => r.name)
}

/**
 * THE WHOLE FEATURE, in the order a user meets it.
 *
 * `page` is the main window (the Buffs tab), `overlay` the BUFFS timer window. Both are live at the
 * same instant throughout, which is the point.
 */
export async function stepAllowList(page: Page, overlay: Page, log: FixtureLog): Promise<void> {
  // A row of our own to filter. The fixture's own long-dead Valor reads `0s`; a fresh cast is the
  // one with time left, exactly as the drop-flash step tells them apart.
  castValor(log)
  // MORE THAN ONE ROW, OR "only that buff" IS NOT A CLAIM. The permanent roster is what this window
  // has standing beside the fresh cast (the step before this one put `Instrument of Nife` up), so
  // revealing it is the cheapest honest way to make the filter choose between rows rather than
  // agree with an already-single list. Put back at the end.
  await setShowPermanent(overlay, true)
  const fresh = (n: string): boolean => n === SPELL
  const before = await settle(() => drawn(overlay), (r) => r.some(fresh) && r.length > 1, { timeoutMs: 30_000 })
  if (
    !check(
      'the buffs window is drawing the spell we cast AND at least one other, so a filter has a choice to make',
      before.some(fresh) && before.length > 1,
      JSON.stringify(before)
    )
  ) {
    return
  }
  const noticesBefore = await dropNotices(overlay)

  // ---- 1. THE TAB, AND THE SHIPPED ANSWER -------------------------------------------------
  await page.click('[data-testid="nav-buffs"]', { timeout: 15_000 })
  const mounted = await settle(() => countOf(page, MODE), (n) => n === 1, { timeoutMs: 20_000 })
  if (!check('the Buffs tab carries the tracking-mode switch', mounted === 1)) return
  check('…and it is OFF on an install that has never touched it', (await modeOn(page)) === false)

  // OPT-IN OR NO CHOICE (owner ruling 2026-08-17): with the mode off there are NO boxes anywhere -
  // not on a card, not on a durations row - and the window draws everything.
  const boxesAtRest = await settleStable(() => boxes(page), { timeoutMs: 10_000 })
  check(
    'with the mode OFF there is no checkbox on any card or durations row - off means no choice',
    boxesAtRest.length === 0,
    JSON.stringify(boxesAtRest.map((b) => b.line).slice(0, 12))
  )
  const modelCounts = await headerCounts(page)
  check('…and the header states what the model believes', modelCounts !== '', modelCounts)

  // ---- 2. OPT-IN, WITH NOTHING CHECKED ----------------------------------------------------
  await page.click(MODE, { timeout: 15_000 })
  const emptied = await settle(() => drawn(overlay), (r) => r.length === 0, { timeoutMs: 20_000 })
  check(
    'turning the mode ON empties the overlay — an unset spell is OFF in opt-in mode',
    emptied.length === 0,
    JSON.stringify(emptied)
  )
  const boxesOn = await settle(() => boxes(page), (b) => b.length > 0, { timeoutMs: 20_000 })
  check(
    '…and the boxes APPEAR - the switch is what enables them',
    boxesOn.length > 0 && boxesOn.some((b) => b.line === LINE),
    JSON.stringify(boxesOn.map((b) => b.line).slice(0, 12))
  )
  // …AND THE TAB IS UNTOUCHED. This is JOS-215's law for the second preference: a display filter
  // over one window may not take a row off another surface or move a count.
  check(
    'the Buffs tab still lists the buff the overlay stopped drawing',
    (await countOf(page, `${BOX}[data-line="${LINE}"]`)) > 0
  )
  check('…and the header count did not move with the window', (await headerCounts(page)) === modelCounts, modelCounts)

  // ---- 3. THE SEARCH, AND CHECKING FROM IT ------------------------------------------------
  const allRows = await statsSpells(page)
  await page.fill(SEARCH, SPELL, { timeout: 15_000 })
  const narrowed = await settle(
    () => statsSpells(page),
    (rows) => rows.length > 0 && rows.every((s) => s.toLowerCase().includes(LINE)),
    { timeoutMs: 20_000 }
  )
  check(
    'searching the durations list narrows it across every class',
    narrowed.length > 0 && narrowed.length < allRows.length && narrowed.every((s) => s.toLowerCase().includes(LINE)),
    `${String(allRows.length)} rows → ${JSON.stringify(narrowed)}`
  )
  const row = `${STATS_ROW}[data-spell="${SPELL}"] ${BOX}`
  if (!check(`…and the ${SPELL} row is one of them`, (await countOf(page, row)) === 1)) return
  check('…with its box UNCHECKED, because opt-in mode means nothing is on yet', (await boxes(page)).every((b) => !b.checked))

  await page.click(row, { timeout: 15_000 })
  const only = await settle(() => drawn(overlay), (r) => r.length > 0, { timeoutMs: 20_000 })
  check(
    `checking ${SPELL} from the search draws it on the overlay within one delta`,
    only.includes(SPELL),
    JSON.stringify(only)
  )
  check(
    '…and NOTHING else — the window draws only what was checked, out of the rows it had',
    only.every(fresh) && only.length < before.length,
    `${JSON.stringify(before)} → ${JSON.stringify(only)}`
  )

  // ---- 4. A PREFERENCE IS NOT A SPELL WEARING OFF ------------------------------------------
  const noticesAfter = await settleStable(() => dropNotices(overlay), { timeoutMs: 10_000 })
  check(
    'no drop notice was raised by any of this — a box the user pressed is not a buff dropping',
    noticesAfter.every((t) => noticesBefore.includes(t)),
    JSON.stringify(noticesAfter)
  )

  // ---- 5. FLIPPING BACK RESTORES EVERYTHING, AND LOSES NO CHOICE ---------------------------
  await page.click(MODE, { timeout: 15_000 })
  const restored = await settle(() => drawn(overlay), (r) => r.length > only.length, { timeoutMs: 20_000 })
  check(
    'turning the mode back OFF restores every row it was hiding',
    restored.length >= before.length,
    `${String(before.length)} before → ${String(only.length)} in opt-in → ${String(restored.length)} after`
  )
  check('…and the mode switch says so', (await modeOn(page)) === false)
  const gone = await settleStable(() => boxes(page), { timeoutMs: 10_000 })
  check('…and the boxes are gone again with it', gone.length === 0, JSON.stringify(gone.slice(0, 5)))
  // The tick must SURVIVE the round trip: on again, and the one spell we checked is still the
  // one that draws - the switch hides the boxes, it does not forget them.
  await page.click(MODE, { timeout: 15_000 })
  const kept = await settle(() => boxes(page), (b) => b.length > 0, { timeoutMs: 20_000 })
  check(
    `…while the explicit ${SPELL} verdict SURVIVED the flip — a mode change loses no choice`,
    kept.some((b) => b.line === LINE && b.checked),
    JSON.stringify(kept.filter((b) => b.line === LINE))
  )
  await page.click(MODE, { timeout: 15_000 })
  await settle(() => modeOn(page), (on) => !on, { timeoutMs: 15_000 })
  // Put the roster back where the step before this one left it, so nothing downstream inherits a
  // window preference this step only borrowed.
  await setShowPermanent(overlay, false)
  // The run ends in the shipped mode with ONE explicit allow, which is what the restart step below
  // reads back — and which filters nothing, so the launch-2 assertions about a snare are unaffected.
}

/**
 * …AND IT IS STILL THERE AFTER A RESTART AND A WHOLE-WORLD REBUILD (launch 2).
 *
 * The value is in the real settings store, so it has to survive a quit; and it is NOT part of any
 * module snapshot, so the `log:character` rebuild that re-folds the log — the thing that re-hydrates
 * every overlay — must not be able to re-default it. Asked of BOTH windows, because they hold their
 * own copies: main's is where the boxes are drawn, the overlay's is what the filter reads.
 */
export async function stepAllowSurvivesRestart(page: Page, overlay: Page | null): Promise<void> {
  interface AllowBridge {
    getBuffAllow: () => Promise<{ optIn: boolean; lines: Record<string, boolean> }>
  }
  const stored = await page.evaluate(() =>
    (window as unknown as { eq: AllowBridge }).eq.getBuffAllow()
  )
  check(
    `the ${SPELL} verdict survived the restart and the whole-world rebuild`,
    stored.lines[LINE] === true,
    JSON.stringify(stored)
  )
  check('…and so did the mode the run ended in', stored.optIn === false, JSON.stringify(stored))
  if (!overlay) return
  const inWindow = await overlay.evaluate(() =>
    (window as unknown as { eqOverlay: AllowBridge }).eqOverlay.getBuffAllow()
  )
  check(
    '…and the overlay window hydrates the same answer on its own, without a module delta',
    inWindow.lines[LINE] === true && inWindow.optIn === false,
    JSON.stringify(inWindow)
  )
}
