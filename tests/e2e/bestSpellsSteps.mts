// BEST AT THIS LEVEL (JOS-445) — the right column's efficiency readout, asserted on screen.
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

const PANEL = '[data-testid="best-spells"]'
const SECTION = '[data-testid="best-spells-section"]'
const RIGHT_COLUMN = '[data-testid="leveling-right-column"]'
const DIRECTIONAL = '[data-testid="best-spells-directional"]'
const LEVEL_VALUE = '[data-testid="new-at-level-value"]'
const LEVEL_NEXT = '[data-testid="new-at-level-next"]'
const LEVEL_PREV = '[data-testid="new-at-level-prev"]'

/** The panel's own claim about which level it is ranking, or '' when it is not mounted. */
function panelLevel(page: Page): Promise<string> {
  return page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.dataset.level ?? '',
    PANEL
  )
}

/** One section's declared sort, as the DOM states it. */
function sortOf(page: Page, side: string): Promise<{ column: string; desc: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    return { column: el?.dataset.sort ?? '', desc: el?.dataset.desc ?? '' }
  }, `${SECTION}[data-side="${side}"]`)
}

/**
 * The drawn values of one column, top to bottom. A null cell is the app's `-`, which comes back as
 * null rather than 0 — the same distinction the model makes, read off the screen.
 */
function columnValues(page: Page, side: string, column: string): Promise<(number | null)[]> {
  return page.evaluate((sel) => {
    const cells = document.querySelectorAll(sel)
    return Array.from(cells).map((c) => {
      const t = (c as HTMLElement).innerText.trim()
      const n = Number(t)
      return t === '' || Number.isNaN(n) ? null : n
    })
  }, `${SECTION}[data-side="${side}"] [data-testid="best-spells-cell"][data-column="${column}"]`)
}

/** The spell names of the drawn rows, top to bottom — the ORDER a re-rank is supposed to change. */
function rowNames(page: Page, side: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const rows = document.querySelectorAll(sel)
    return Array.from(rows).map((r) => (r as HTMLElement).dataset.name ?? '')
  }, `${SECTION}[data-side="${side}"] [data-testid="best-spells-row"]`)
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

/** Press a column header and wait for the section to say it took. */
async function sortBy(page: Page, side: string, column: string): Promise<void> {
  await page.click(
    `${SECTION}[data-side="${side}"] [data-testid="best-spells-sort"][data-column="${column}"]`,
    { timeout: 10_000 }
  )
  await settle(() => sortOf(page, side).then((s) => s.column), (c) => c === column, { timeoutMs: 8_000 })
}

/** The default state of one side: its own rank column, descending, and the rows drawn that way. */
async function checkDefaultRank(page: Page, side: string, rank: string): Promise<number> {
  const sort = await sortOf(page, side)
  check(`the ${side} section opens ranked by ${rank}, best first`, sort.column === rank && sort.desc === 'true', `${sort.column}/${sort.desc}`)
  const values = await columnValues(page, side, rank)
  if (values.length === 0) {
    note(`this loadout owns nothing on the ${side} side at this level, which is an honest table`)
    return 0
  }
  check(`…and the drawn ${rank} column really descends, with any blank last`, descendingNullsLast(values), values.join(' '))
  return values.length
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

  const sides = await page.evaluate(
    (s) => Array.from(document.querySelectorAll(s)).map((e) => (e as HTMLElement).dataset.side ?? ''),
    SECTION
  )
  check('it draws BOTH answers at once - best damage and best healing', sides.join(',') === 'damage,heal', sides.join(','))

  // THE LEVEL IS THE TAB'S. The unlock stepper lives in the OTHER column; this is the claim that
  // there is one viewed level rather than two.
  const stepper = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '',
    LEVEL_VALUE
  )
  const shown = await panelLevel(page)
  check('the readout ranks the level the stepper is showing', stepper === `Level ${shown}`, `${stepper} vs ${shown}`)

  const damageRows = await checkDefaultRank(page, 'damage', 'dps')
  await checkDefaultRank(page, 'heal', 'hps')

  // RE-RANKING, which is the owner's ask read literally: the same rows, a different question.
  if (damageRows >= 2) {
    const byDps = await rowNames(page, 'damage')
    await sortBy(page, 'damage', 'damagePerMana')
    const byEff = await rowNames(page, 'damage')
    check(
      'clicking `dmg/mana` re-ranks the damage table on that column',
      descendingNullsLast(await columnValues(page, 'damage', 'damagePerMana')),
      byEff.slice(0, 3).join(' | ')
    )
    // The two answers are allowed to agree (a small loadout really can have one best spell by both
    // measures), so a difference is a NOTE and the monotone above is the assertion.
    if (byDps.join() === byEff.join()) note('the fastest and the most mana-efficient spell are the same here')
    await sortBy(page, 'damage', 'dps')
  } else {
    note(`only ${String(damageRows)} damage row(s) at this level - nothing to re-rank`)
  }

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
    const path = join(ARTIFACTS, 'best-spells.png')
    await page.locator(PANEL).first().screenshot({ path, timeout: 20_000 })
    note(`best-spells readout screenshot: ${path}`)
  } catch (err: unknown) {
    note(`best-spells screenshot unavailable - ${String(err)}`)
  } finally {
    await setShown(false).catch(() => undefined)
  }
}
