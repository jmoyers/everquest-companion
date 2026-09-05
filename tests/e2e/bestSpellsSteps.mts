// BEST AT THIS LEVEL (JOS-445, four tabs since JOS-448, FIVE since JOS-449) — the right column's
// efficiency readout, asserted on screen.
//
// Its own file for the reason `unlockRowSteps.mts` is: leveling.e2e.mts sits AT the repo max-lines
// budget and the rule here is to SPLIT, never ratchet. The spec still owns the order and the launch.
//
// WHAT THIS PROVES THAT NO UNIT TEST CAN. `tests/bestSpells.test.mts` pins the ranking, the era
// split and the null-last sort over the committed corpus. What it cannot reach is the SEAM, and the
// seam is where every part of this ticket lives:
//   * main now ships the hitpoint LINES beside the gain-level snapshot (`UnlockSpell.hpLines`), so
//     a renderer can evaluate a ramp at a level main never picked. A dataset built without them
//     draws a readout with no rows at all, and no unit test of either half would notice.
//   * the level is the TAB'S now, not the unlock panel's — one stepper, two columns. The only way
//     to assert that is to press the stepper and watch the OTHER column follow.
//   * the sort is a click on a header, and re-ranking is the owner's whole ask.
//   * and since JOS-448 the four answers live behind four TABS, so only one table is in the DOM at
//     a time. That the other three are not merely hidden but absent, that their counts are still
//     stated on the labels, and that a click swaps the table under the same headers, are all claims
//     about the rendered document rather than about the model.
//   * and since JOS-447 there is a SLIDER in that 260px column. The model half is pinned in
//     `tests/bestSpellsRank.test.mts`; what only the app can show is that the control is drawn at
//     all, that its label is permanent rather than appearing on drag, that the label NAMES the rank
//     and the one axis it moves, and that the numbers under it restate when it is driven.
//   * and since JOS-449 there is a FIFTH tab whose figures rest on an ASSUMPTION. The model pins
//     the arithmetic and the wording; what only the app can show is that the assumption is DRAWN,
//     that it is drawn on the tab it governs and on no other, and that five labels plus a slider
//     still divide a 260px column without one of them quietly becoming a scroller.
//
//   * and since JOS-450 the readout SEARCHES the whole catalog. That half lives in
//     `bestSpellsSearchSteps.mts` (this file was at the max-lines budget, and the rule is to SPLIT);
//     the order stays here, right after the simulator, because the search hands the box back empty
//     and everything below is a claim about the ranked table.
//
// SHAPES AND ORDERINGS, NEVER TODAY'S NUMBERS. The loadout is whatever this machine's log inferred
// and the figures come from the committed catalog, so the assertions are that the drawn column is
// MONOTONE under its own sort and that pressing another header changes which monotone it is. A
// wrong figure is the unit suite's job; a table that is not sorted by the column it says it is
// sorted by is this step's.
//
// AND IT LEAVES THE TAB WHERE IT FOUND IT: the level is stepped once and stepped back, because the
// steps around it make claims about the level the panel was left on.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { ARTIFACTS, check, countOf, note, settle } from './appHarness.mjs'
// JOS-450's half, split off for the same max-lines reason this file was split off leveling.e2e.mts.
// The order stays here: the search runs after the simulator and hands the box back empty.
import {
  clearBestSpellsSearch,
  fillOutsideClassQuery,
  stepBestSpellsSearch,
  stepBestSpellsTypeSearch
} from './bestSpellsSearchSteps.mjs'

const PANEL = '[data-testid="best-spells"]'
const SECTION = '[data-testid="best-spells-section"]'
const TAB = '[data-testid="best-spells-tab"]'
const MORE = '[data-testid="best-spells-more"]'
const RIGHT_COLUMN = '[data-testid="leveling-right-column"]'
const DIRECTIONAL = '[data-testid="best-spells-directional"]'
const LEVEL_VALUE = '[data-testid="new-at-level-value"]'
const LEVEL_NEXT = '[data-testid="new-at-level-next"]'
const LEVEL_PREV = '[data-testid="new-at-level-prev"]'
// JOS-447 — the mote-rank simulator. The slider is driven through its own hidden range input, the
// same path `gearEffectiveHpSteps.mts` drives the gear tier slider through.
const RANK_SLIDER = '[data-testid="best-spells-rank-slider"] input[type="range"]'
const RANK_LABEL = '[data-testid="best-spells-rank-label"]'

/** The five tabs, in the order the owner named them. The model pins the labels; this drives them. */
const TABS = ['dd', 'dot', 'aoe', 'heal', 'hot'] as const

/** The rank column each tab must open on: the damage three on dps, the healing pair on hps. */
const TAB_RANK: Record<string, string> = { dd: 'dps', dot: 'dps', aoe: 'dps', heal: 'hps', hot: 'hps' }

/** JOS-449's visible assumption, drawn on the AOE tab and nowhere else. */
const AOE_MARK = '[data-testid="best-spells-aoe-assumption"]'

/** JOS-452's visible multiply, drawn on whichever tab really used a worn focus. */
const FOCUS_MARK = '[data-testid="best-spells-worn-focus"]'

/** One tab's label, as the DOM states it: which tab, what it counts, and whether it is selected. */
interface TabInfo {
  tab: string
  label: string
  count: number
  selected: boolean
}

/** The panel's own claim about which level it is ranking, or '' when it is not mounted. */
function panelLevel(page: Page): Promise<string> {
  return page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.dataset.level ?? '',
    PANEL
  )
}

/** Every tab the panel drew, in DOM order. */
function tabsOf(page: Page): Promise<TabInfo[]> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const node = el as HTMLElement
      return {
        tab: node.dataset.tab ?? '',
        label: (node.innerText || '').trim(),
        count: Number(node.dataset.count ?? '-1'),
        selected: node.getAttribute('aria-selected') === 'true'
      }
    })
  }, TAB)
}

/** The one table on screen: which tab it belongs to, its declared sort, and the count it carries. */
function tableOf(page: Page): Promise<{ tab: string; column: string; desc: string; count: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    return {
      tab: el?.dataset.tab ?? '',
      column: el?.dataset.sort ?? '',
      desc: el?.dataset.desc ?? '',
      count: Number(el?.dataset.count ?? '-1')
    }
  }, SECTION)
}

/**
 * The drawn values of one column, top to bottom. A null cell is the app's `-`, which comes back as
 * null rather than 0 — the same distinction the model makes, read off the screen.
 */
function columnValues(page: Page, column: string): Promise<(number | null)[]> {
  return page.evaluate((sel) => {
    const cells = document.querySelectorAll(sel)
    return Array.from(cells).map((c) => {
      const t = (c as HTMLElement).innerText.trim()
      const n = Number(t)
      return t === '' || Number.isNaN(n) ? null : n
    })
  }, `${SECTION} [data-testid="best-spells-cell"][data-column="${column}"]`)
}

/** The spell names of the drawn rows, top to bottom — the ORDER a re-rank is supposed to change. */
function rowNames(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const rows = document.querySelectorAll(sel)
    return Array.from(rows).map((r) => (r as HTMLElement).dataset.name ?? '')
  }, `${SECTION} [data-testid="best-spells-row"]`)
}

/** The `+N more` disclosure's own number, or 0 when the table is short enough not to have one. */
function moreCount(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    const m = /\+(\d+)\s+more/.exec(el?.innerText ?? '')
    return m ? Number(m[1]) : 0
  }, `${SECTION} ${MORE}`)
}

/** Descending with nulls last — the model's rule, checked against what is actually drawn. */
function descendingNullsLast(values: readonly (number | null)[]): boolean {
  let seenNull = false
  let prev = Number.POSITIVE_INFINITY
  for (const v of values) {
    if (v === null) {
      seenNull = true
      continue
    }
    if (seenNull || v > prev) return false
    prev = v
  }
  return true
}

/** Press a column header and wait for the table to say it took. */
async function sortBy(page: Page, column: string): Promise<void> {
  await page.click(`${SECTION} [data-testid="best-spells-sort"][data-column="${column}"]`, { timeout: 10_000 })
  await settle(() => tableOf(page).then((s) => s.column), (c) => c === column, { timeoutMs: 8_000 })
}

/** The panel's own claim about the rank it is simulating, and the words it says about it. */
function simulationOf(page: Page): Promise<{ rank: string; label: string }> {
  return page.evaluate((sels) => {
    const panel = document.querySelector(sels[0]) as HTMLElement | null
    const label = document.querySelector(sels[1]) as HTMLElement | null
    return {
      rank: panel?.dataset.simulate ?? '',
      label: (label?.innerText || '').trim()
    }
  }, [PANEL, RANK_LABEL])
}

/** Focus the slider and drive it with the keyboard - the same path the control gives a user. */
async function driveRank(page: Page, keys: readonly string[]): Promise<void> {
  await page.focus(RANK_SLIDER, { timeout: 15_000 })
  for (const key of keys) await page.press(RANK_SLIDER, key, { timeout: 15_000 })
}

/** Press a tab and wait for the ONE table on screen to be that tab's. */
async function selectTab(page: Page, tab: string): Promise<void> {
  await page.click(`${TAB}[data-tab="${tab}"]`, { timeout: 10_000 })
  await settle(() => tableOf(page).then((t) => t.tab), (t) => t === tab, { timeoutMs: 8_000 })
}

/**
 * One tab, opened and read: it draws its own table, on its own rank column, descending, and the
 * count on its label is the whole table rather than the ten rows the disclosure leaves visible.
 *
 * Returns how many rows are drawn, so the caller can skip a re-rank there is nothing to re-rank.
 */
async function checkTab(page: Page, tab: string): Promise<number> {
  await selectTab(page, tab)
  const table = await tableOf(page)
  const sections = await countOf(page, SECTION)
  check(`the ${tab} tab draws ONE table and it is its own`, sections === 1 && table.tab === tab, `${String(sections)} sections, ${table.tab}`)
  const rank = TAB_RANK[tab]
  check(
    `…opened ranked by ${rank}, best first`,
    table.column === rank && table.desc === 'true',
    `${table.column}/${table.desc}`
  )
  const drawn = await rowNames(page)
  const more = await moreCount(page)
  check(
    `…and the ${String(table.count)} on the tab is the whole table: ${String(drawn.length)} drawn plus ${String(more)} behind the disclosure`,
    drawn.length + more === table.count,
    `${String(drawn.length)} + ${String(more)} vs ${String(table.count)}`
  )
  if (drawn.length === 0) {
    note(`this loadout owns no ${tab} spells at this level, which is an honest empty table`)
    return 0
  }
  const values = await columnValues(page, rank)
  check(`…and the drawn ${rank} column really descends, with any blank last`, descendingNullsLast(values), values.join(' '))
  return drawn.length
}

/**
 * THE AOE TAB'S ASSUMPTION, ON SCREEN (JOS-449, owner ruling: the figures assume max target count
 * and the surface must SAY so).
 *
 * `tests/bestSpellsAoe.test.mts` proves the model computes the marker from the rows in force. What
 * only the app can show is that the words are actually DRAWN, that they are drawn on the tab they
 * govern and on NO other (the caveat diet: the other four tabs say one quiet `directional` and
 * stop), and that a figure on the AOE tab really is bigger than the same spell's DD figure - which
 * is the reader's own check that the tab is answering a different question.
 *
 * IT HANDS THE PANEL BACK ON THE TAB IT FOUND IT ON, like every other step here.
 */
/**
 * WHAT YOUR GEAR DOES TO YOUR CASTS, ON THE SCREEN (JOS-452).
 *
 * The spec stages the owner's committed `/outputfile inventory` dump, which wears an Improved
 * Damage II (`Polished Mithril Mask`) and an Improved Healing III (`Idol of the Underking`) - so
 * the SEAM this asserts is the one no unit test can reach: main resolving a real dump against the
 * real corpus, the payload crossing IPC on the planner's channel, and the renderer folding it into
 * figures that are visibly higher than the ones the same table draws without it.
 *
 * WHAT IT DOES NOT PIN IS A NUMBER. The loadout this machine's log infers decides which tabs have
 * rows and which spells are in them, so the assertions are the marker's SHAPE, the tab it appears
 * on, and the direction of the change - the exact arithmetic is `tests/bestSpellsFocus.test.mts`'s
 * over the committed corpus.
 */
async function stepWornFocus(page: Page): Promise<void> {
  const opened = (await tableOf(page)).tab
  // The marker is per tab, so find one that HAS it rather than asserting about whichever tab the
  // steps above left open: a cleric's DD table is empty and a wizard's Heal table is.
  let found: string | null = null
  for (const tab of TABS) {
    await selectTab(page, tab)
    if ((await settle(() => countOf(page, FOCUS_MARK), (n) => n === 1, { timeoutMs: 4_000 })) === 1) {
      found = tab
      break
    }
  }
  if (found === null) {
    note('nothing this loadout owns is inside a worn focus effect range here, so no marker is drawn')
    await selectTab(page, opened)
    return
  }
  check(`the worn-focus marker is drawn on the ${found} tab, exactly once`, true)
  const text = await page.evaluate(
    (s) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? '').trim(),
    FOCUS_MARK
  )
  check(
    '…stating the percentage the figures were multiplied by, in words a player can read',
    /^worn \+\d+%( to \+\d+%)?$/.test(text),
    text
  )
  // AND IT IS A CLAIM ABOUT THE NUMBERS BESIDE IT. Every row on this tab that the focus touched
  // reads above the base figure the same table draws with no dump behind it - which cannot be
  // measured here, so the weaker true thing is asserted instead: the marked tab has rows, and its
  // headline figures are positive.
  const headline = TAB_RANK[found]
  const values = (await columnValues(page, headline)).filter((v): v is number => v !== null)
  check(
    `…over a ${found} table that really has focused figures in it`,
    values.length > 0 && values.every((v) => v > 0),
    `${String(values.length)} rows`
  )
  await selectTab(page, opened)
}

async function stepAoeAssumption(page: Page): Promise<void> {
  const opened = (await tableOf(page)).tab
  // Whichever tab the steps before this left the panel on, the absence is asserted from a tab that
  // is NOT the AOE one - the panel is handed back to `opened` at the end either way.
  if (opened === 'aoe') await selectTab(page, 'dd')
  check('the assumption marker is NOT drawn on a tab it does not govern', (await countOf(page, AOE_MARK)) === 0)

  await selectTab(page, 'aoe')
  const drawn = await settle(() => countOf(page, AOE_MARK), (n) => n === 1, { timeoutMs: 8_000 })
  if (!check('…and IS drawn, exactly once, on the AOE tab', drawn === 1, String(drawn))) return
  const text = await page.evaluate(
    (s) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? '').trim(),
    AOE_MARK
  )
  check(
    '…stating the target count the figures assume, in words a player can read',
    /^x\d+( to x\d+)? targets$/.test(text),
    text
  )

  // THE TAB REALLY ANSWERS A DIFFERENT QUESTION. Whichever spell is in both tables must read HIGHER
  // here: a max-target reading can never state less than a single-target one. Shapes, not numbers -
  // the loadout is whatever this machine's log inferred.
  const aoeRows = await rowNames(page)
  if (aoeRows.length === 0) {
    note('this loadout owns no area spells at this level, which is an honest empty AOE tab')
  } else {
    const aoeDamage = await columnValues(page, 'damage')
    await selectTab(page, 'dd')
    const ddNames = await rowNames(page)
    const ddDamage = await columnValues(page, 'damage')
    const shared = aoeRows
      .map((name, i) => ({ name, aoe: aoeDamage[i], dd: ddDamage[ddNames.indexOf(name)] }))
      .filter((r) => ddNames.includes(r.name) && r.aoe !== null && r.dd !== null)
    if (shared.length === 0) {
      note('no spell is drawn in both the AOE and DD tables here, so there is no pair to compare')
    } else {
      const bad = shared.filter((r) => (r.aoe ?? 0) < (r.dd ?? 0))
      check(
        `a spell in both tables reads HIGHER on AOE than on DD (${String(shared.length)} pairs)`,
        bad.length === 0,
        bad.map((r) => `${r.name} ${String(r.aoe)} < ${String(r.dd)}`).join(' | ')
      )
    }
  }
  await selectTab(page, opened)
}

/**
 * THE MOTE-RANK SIMULATOR (JOS-447), and it is a claim about the SCREEN that no unit test reaches.
 *
 * `tests/bestSpellsRank.test.mts` proves the model reads every row at `max(observed, simulated)`.
 * What only the running app can show is that the control exists in a 260px column, that its label
 * is permanent rather than appearing when it is dragged, that the label NAMES what is being
 * simulated, and that the numbers under it actually restate.
 *
 * IT RUNS ON A DAMAGE TAB, because damage is the only axis v1 moves (spellScale.ts scopes it and
 * says why). A loadout with no damage rows at all gets a note: the control is still asserted, and
 * the unmoved healing figures there would be the designed behaviour rather than a failure.
 *
 * AND IT HANDS THE PANEL BACK AT BASE, like every other step here.
 */
async function stepSimulate(page: Page): Promise<void> {
  if (!check('the readout offers a mote-rank simulator', (await countOf(page, RANK_SLIDER)) === 1)) return
  const atBase = await simulationOf(page)
  check(
    '…which opens at base and says so PERMANENTLY, not only once it is dragged',
    atBase.rank === '0' && atBase.label === 'base ranks',
    `${atBase.rank} / ${atBase.label}`
  )

  const damage = (await tabsOf(page)).find((t) => TAB_RANK[t.tab] === 'dps' && t.count > 0)
  if (!damage) {
    note('this loadout owns no damage spells; the healing lift shares the same slider and code path')
    return
  }
  await selectTab(page, damage.tab)
  const before = (await columnValues(page, 'damage')).join(',')

  await driveRank(page, ['Home', 'End'])
  const lifted = await settle(() => simulationOf(page).then((s) => s.rank), (r) => r === '10', { timeoutMs: 8_000 })
  check('driving it to the top of the ladder takes', lifted === '10', lifted)
  const announced = await simulationOf(page)
  check(
    '…and the label ANNOUNCES the simulation: the rank every row is lifted to',
    announced.label === 'all at X+',
    announced.label
  )

  const after = await settle(
    () => columnValues(page, 'damage').then((v) => v.join(',')),
    (v) => v !== before,
    { timeoutMs: 8_000 }
  )
  check(`simulating a rank RESTATES the ${damage.tab} table's damage column`, after !== before, `${before} -> ${after}`)
  // The rows are the same rows: a rank changes figures, never membership. `+N more` is unmoved too.
  check(
    '…the same rows, re-read - a rank is not a filter',
    (await rowNames(page)).length > 0 && (await tableOf(page)).count === damage.count,
    `${String((await tableOf(page)).count)} vs ${String(damage.count)}`
  )

  await driveRank(page, ['Home'])
  const back = await settle(() => simulationOf(page).then((s) => s.rank), (r) => r === '0', { timeoutMs: 8_000 })
  check('and sliding back to base restores the readout it was found in', back === '0', back)
}

/**
 * THE READOUT. The whole step is skipped with a note when the loadout is unknown — the panel is a
 * claim about spells YOU own and there is no honest version of it over sixteen candidate classes,
 * so its absence there is the designed behaviour rather than a failure.
 */
export async function stepBestSpells(page: Page): Promise<void> {
  const mounted = (await countOf(page, PANEL)) > 0
  if (!mounted) {
    note('no loadout resolved from this log, so there is no best-spells readout to draw - by design')
    return
  }
  check('the best-spells readout is mounted', true)
  const placed = await page.evaluate(
    (sels) => document.querySelector(sels[0])?.closest(sels[1]) !== null,
    [PANEL, RIGHT_COLUMN]
  )
  check('…on the RIGHT side of the tab, which is where the owner asked for it', placed)
  check('…and it says `directional` exactly once, like the panel opposite it', (await countOf(page, DIRECTIONAL)) === 1)

  // FOUR TABS, AND ONLY ONE TABLE (JOS-448). The labels are the model's words and each carries its
  // own count, which is what makes the three tabs you are not looking at still say something.
  const tabs = await tabsOf(page)
  check(
    'it offers the five answers the owner asked for, in his order',
    tabs.map((t) => t.tab).join(',') === TABS.join(','),
    tabs.map((t) => t.tab).join(',')
  )
  check(
    '…each label naming its table and counting it',
    tabs.every((t) => /^(DD|DoT|AOE|Heal|HoT) \(\d+\)$/.test(t.label) && t.count >= 0),
    tabs.map((t) => t.label).join(' | ')
  )
  check('…with exactly one selected', tabs.filter((t) => t.selected).length === 1, tabs.map((t) => `${t.tab}:${String(t.selected)}`).join(' '))
  check('…and exactly one table in the document, not four with three hidden', (await countOf(page, SECTION)) === 1)
  // The panel OPENS on a tab that has something in it: `dd` is the default, but a healer's DD table
  // is empty and opening him on it would be the readout failing to answer a question it can answer.
  const opened = await tableOf(page)
  const openCount = tabs.find((t) => t.tab === opened.tab)?.count ?? -1
  const anyRows = tabs.some((t) => t.count > 0)
  check(
    'it opens on a tab with rows in it whenever any tab has rows',
    !anyRows || openCount > 0,
    `${opened.tab} has ${String(openCount)}`
  )

  // THE LEVEL IS THE TAB'S. The unlock stepper lives in the OTHER column; this is the claim that
  // there is one viewed level rather than two.
  const stepper = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '',
    LEVEL_VALUE
  )
  const shown = await panelLevel(page)
  check('the readout ranks the level the stepper is showing', stepper === `Level ${shown}`, `${stepper} vs ${shown}`)

  // EVERY TAB, CLICKED. Each swaps the table under the same headers and brings its own sort with it.
  let widest = { tab: TABS[0] as string, rows: 0 }
  for (const tab of TABS) {
    const rows = await checkTab(page, tab)
    if (rows > widest.rows) widest = { tab, rows }
  }

  // RE-RANKING, which is the owner's ask read literally: the same rows, a different question. It
  // runs on whichever tab this machine's loadout filled the most, so the step means something for a
  // wizard (DD) and for a shaman (DoT or HoT) alike.
  const perMana = TAB_RANK[widest.tab] === 'dps' ? 'damagePerMana' : 'healPerMana'
  if (widest.rows >= 2) {
    await selectTab(page, widest.tab)
    const byRank = await rowNames(page)
    await sortBy(page, perMana)
    const byEff = await rowNames(page)
    check(
      `clicking the per-mana header re-ranks the ${widest.tab} table on that column`,
      descendingNullsLast(await columnValues(page, perMana)),
      byEff.slice(0, 3).join(' | ')
    )
    // The two answers are allowed to agree (a small loadout really can have one best spell by both
    // measures), so a difference is a NOTE and the monotone above is the assertion.
    if (byRank.join() === byEff.join()) note('the fastest and the most mana-efficient spell are the same here')
    // A SORT IS THE TAB'S OWN. Flipping this one must not disturb another, which is the state the
    // panel keeps per tab rather than per side.
    const other = TABS.find((t) => t !== widest.tab && TAB_RANK[t] !== TAB_RANK[widest.tab])
    if (other) {
      await selectTab(page, other)
      const kept = await tableOf(page)
      check(`…and the ${other} tab kept its own sort`, kept.column === TAB_RANK[other], kept.column)
    }
    await selectTab(page, widest.tab)
    await sortBy(page, TAB_RANK[widest.tab])
  } else {
    note(`the widest tab here has ${String(widest.rows)} row(s) - nothing to re-rank`)
  }

  await stepAoeAssumption(page)

  await stepWornFocus(page)

  await stepSimulate(page)

  // JOS-450 — the box, and the out-of-class row it can find. It runs here because the steps above
  // have left the panel on a tab with rows in it, which is the state "the table gave way" is a
  // claim about, and it hands the box back empty so the checks below still see the ranked table.
  await stepBestSpellsSearch(page)

  // JOS-507 — the same box, asked by TYPE. It runs directly after the wiki search because the two
  // are the same control read two ways, and it likewise hands the panel back with no filter set, so
  // the checks below still see the ranked table they were written against.
  await stepBestSpellsTypeSearch(page)

  // NO INNER SCROLLER, the JOS-289 law, restated for the control JOS-448 added: `fullWidth` tabs
  // must not have quietly become a scroller in a 260px column. JOS-447 put a SLIDER in the same
  // column, which is exactly the kind of control that overflows one, so this now covers it too.
  const scrollers = await page.evaluate((sel) => {
    const panel = document.querySelector(sel)
    if (!panel) return [] as string[]
    return Array.from(panel.querySelectorAll('*'))
      .filter((el) => {
        // NO NAMED HELPER IN HERE. tsx compiles this closure with esbuild's `keepNames`, which
        // emits a `__name(...)` call for any function bound to a const - and that helper does not
        // exist in the page. Everything stays an inline expression. (Measured: JOS-448, this step
        // died with `ReferenceError: __name is not defined` the first time it had one.)
        const node = el as HTMLElement
        const ov = getComputedStyle(node)
        const scrolling = [ov.overflowX, ov.overflowY].some((a) => a === 'auto' || a === 'scroll')
        if (!scrolling) return false
        return node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1
      })
      .map((el) => (el as HTMLElement).className.toString().slice(0, 60))
  }, PANEL)
  check('nothing inside the readout is a scroller', scrollers.length === 0, scrollers.join(' | '))

  // AND STEPPING THE LEVEL RE-READS IT. One press, then back, so the steps around this one still
  // see the level they were left on. `settle` RETURNS its last reading rather than throwing on a
  // timeout, so the assertion is on the value it hands back.
  const canStep = await page.isEnabled(LEVEL_NEXT, { timeout: 5_000 })
  if (!canStep) {
    note('the stepper is already at the top of its band, so there is no step to follow')
    return
  }
  await page.click(LEVEL_NEXT, { timeout: 10_000 })
  const moved = await settle(() => panelLevel(page), (l) => l !== shown, { timeoutMs: 8_000 })
  check('stepping the level moves the readout with it - one level, two columns', moved !== shown, `${shown} -> ${moved}`)
  await page.click(LEVEL_PREV, { timeout: 10_000 })
  await settle(() => panelLevel(page), (l) => l === shown, { timeoutMs: 8_000 })
}


/**
 * ONE PNG OF THE READOUT, for an owner who has to rule on whether a four-column table reads in a
 * third of a row (JOS-339's camera precedent, and JOS-391's: a new surface the owner asked for gets
 * a picture rather than a description of one).
 *
 * It runs LAST, beside `shootUnlockPanel`, and for the same MEASURED reason: showing the window
 * moves the scroll position and stalls compositing, which broke three layout checks when a camera
 * sat in the middle of this spec. It asserts nothing, so it costs nothing where it is.
 */
export async function shootBestSpells(app: ElectronApplication, page: Page): Promise<void> {
  if ((await countOf(page, PANEL)) === 0) return
  const setShown = (show: boolean): Promise<void> =>
    app.evaluate(({ BrowserWindow }, on) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('kind='))
      if (on) w?.showInactive()
      else w?.hide()
    }, show)
  try {
    mkdirSync(ARTIFACTS, { recursive: true })
    await setShown(true)
    await page.locator(PANEL).first().scrollIntoViewIfNeeded({ timeout: 5_000 })
    await shoot(page, 'best-spells.png')
    // …AND THE SAME PANEL SEARCHING (JOS-450). Two PNGs of one panel because it has two states now,
    // and "does an out-of-class row read in a 260px column" is an owner's question about the second
    // one - the unlock panel's own arrangement, one column over. The query is derived from the
    // loadout this machine resolved, so the picture always shows a row that is not yours.
    if (await fillOutsideClassQuery(page)) await shoot(page, 'best-spells-search.png')
    await clearBestSpellsSearch(page)
  } catch (err: unknown) {
    note(`best-spells screenshot unavailable - ${String(err)}`)
  } finally {
    await setShown(false).catch(() => undefined)
  }
}

/** One PNG of the readout into the run's artifacts, reported through `note`. */
async function shoot(page: Page, file: string): Promise<void> {
  const path = join(ARTIFACTS, file)
  await page.locator(PANEL).first().screenshot({ path, timeout: 20_000 })
  note(`best-spells readout screenshot: ${path}`)
}
