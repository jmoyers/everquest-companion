// THE READOUT'S WHOLE-CATALOG SEARCH (JOS-450), asserted on screen.
//
// Its own file for the reason `bestSpellsSteps.mts` is its own file and `unlockRowSteps.mts` before
// it: the repo's max-lines budget is SPLIT, never ratcheted, and the readout's spec was already at
// it. `stepBestSpells` still owns the order and calls in here.
//
// WHAT THIS PROVES THAT NO UNIT TEST CAN. `tests/bestSpellsSearch.test.mts` pins the fold over the
// committed catalog: the whole-catalog corpus, the out-of-class row, the level reading, the tab
// membership, the era mark, the cap. Four things live only in the running app:
//   * the box EXISTS at all, in a 260px column that already carries five tabs and a slider;
//   * typing makes the ranked table GIVE WAY - not merely hidden, absent from the document;
//   * a spell NO CLASS IN THIS LOADOUT CAN LEARN is drawn as a row OF THIS READOUT, with figure
//     cells under it and the class-level chip that says whose it is - which is the owner's whole
//     ask ("i want to be able to search for things outside my class to compare");
//   * and clearing the box hands the ranked table back.
//
// THE SPELL IS DERIVED, NOT HARD-CODED. The loadout is whatever this machine's log inferred, so
// "outside my class" cannot be a constant: the step reads the resolved classes off the panel in the
// other column and picks a single-class, in-era spell from the committed catalog that none of them
// can reach. A machine whose log resolved nothing skips with a note, like every step in this suite.

import type { Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'
// The committed catalog, read HERE rather than through the app. This is a DATA lookup (which spell
// exactly one class learns), never a second copy of the model: what the ROW then says is the app's
// own answer, asserted on screen.
import { buildLevelUnlocks } from '../../src/main/data/levelUnlocks'

const TAB = '[data-testid="best-spells-tab"]'
const SECTION = '[data-testid="best-spells-section"]'
const SEARCH = '[data-testid="best-spells-search"]'
const SEARCH_CLEAR = '[data-testid="best-spells-search-clear"]'
const RESULTS = '[data-testid="best-spells-results"]'
/** The loadout chips, which the panel in the OTHER column draws — one loadout, two readouts. */
const COMBO_CHIP = '[data-testid="new-at-level-combo-chip"]'

/** The five tabs, in the order the owner named them. `stepBestSpells` pins that they are these. */
const TABS = ['dd', 'dot', 'aoe', 'heal', 'hot'] as const

/** How many result rows and how many ranked tables are in the document, as one reading. */
function bodies(page: Page): Promise<number[]> {
  return page.evaluate(
    (sels) => [document.querySelectorAll(sels[0]).length, document.querySelectorAll(sels[1]).length],
    [RESULTS, SECTION]
  )
}

/** One spell of the committed catalog that exactly one class learns, and that class is not yours. */
function outsideClassSpell(loadout: readonly string[]): { name: string; cls: string; level: number } | null {
  for (const spell of buildLevelUnlocks().spells) {
    // Single class, in era, with hitpoint lines - so the readout has a figure to print for it and
    // exactly one chip, whose class is unambiguously not one of yours. A name carrying an
    // apostrophe is skipped rather than escaped: the matcher FOLDS apostrophes (JOS-342) and this
    // step is not the place that pins the fold.
    if (spell.at.length !== 1 || spell.outOfEra === true) continue
    if ((spell.hpLines ?? []).length === 0 || /['`]/.test(spell.name)) continue
    const pair = spell.at[0]
    if (loadout.includes(pair.cls)) continue
    return { name: spell.name, cls: pair.cls, level: pair.level }
  }
  return null
}

/** How many figure cells the named result row draws - a result is a readout row or it is nothing. */
function resultCells(page: Page, name: string): Promise<number> {
  return countOf(
    page,
    `${RESULTS} [data-testid="best-spells-row"][data-name="${name}"] [data-testid="best-spells-cell"]`
  )
}

/** The class-level chips on the named result row, as the DOM spells them (`DRU 40`). */
function resultChips(page: Page, name: string): Promise<string[]> {
  return page.evaluate(
    (sel) => Array.from(document.querySelectorAll(sel)).map((c) => (c as HTMLElement).innerText.trim()),
    `${RESULTS} [data-testid="best-spells-name-row"][data-name="${name}"] [data-testid="best-spells-result-class"]`
  )
}

/** Which tab draws a result for this spell, or null when none of the five can read it. */
async function findResult(page: Page, name: string): Promise<string | null> {
  for (const tab of TABS) {
    await page.click(`${TAB}[data-tab="${tab}"]`, { timeout: 10_000 })
    const drawn = await settle(() => resultCells(page, name), (n) => n > 0, { timeoutMs: 3_000 })
    if (drawn > 0) return tab
  }
  return null
}

/**
 * PUT AN OUT-OF-CLASS QUERY IN THE BOX and wait for the results, for the CAMERA (JOS-450).
 *
 * `shootBestSpells` takes two PNGs of one panel because it has two states now, and "does this read
 * in a 260px column" is an owner's question about BOTH — the unlock panel's own arrangement. It
 * lives here so the derivation of "a spell outside your class" exists once; the camera runs after
 * every measurement, for the compositing reason `shootBestSpells` states.
 */
export async function fillOutsideClassQuery(page: Page): Promise<boolean> {
  const loadout = await page.evaluate(
    (s) => Array.from(document.querySelectorAll(s)).map((el) => (el as HTMLElement).innerText.trim()),
    COMBO_CHIP
  )
  const target = loadout.length === 0 ? null : outsideClassSpell(loadout)
  if (!target) return false
  await page.fill(SEARCH, target.name, { timeout: 10_000 })
  const drawn = await settle(() => countOf(page, RESULTS), (n) => n === 1, { timeoutMs: 8_000 })
  return drawn === 1
}

/** Empty the box through its own clear button, the way a reader does. */
export async function clearBestSpellsSearch(page: Page): Promise<void> {
  if ((await countOf(page, SEARCH_CLEAR)) > 0) await page.click(SEARCH_CLEAR, { timeout: 10_000 })
  else await page.fill(SEARCH, '', { timeout: 10_000 })
}

/** The three claims about the row itself: it is a readout row, and its chip names a class not yours. */
async function checkResultRow(page: Page, target: { name: string; cls: string; level: number }, loadout: readonly string[]): Promise<void> {
  check(
    `…drawn as a row of THIS readout, with its own figure cells under the name`,
    (await resultCells(page, target.name)) > 0
  )
  const chips = await resultChips(page, target.name)
  check(
    `…wearing the class-level chip that says whose it is`,
    chips.includes(`${target.cls} ${String(target.level)}`),
    chips.join(' | ')
  )
  check(
    '…and no chip on it names a class this loadout could be running',
    chips.length > 0 && chips.every((c) => !loadout.includes(c.split(' ')[0])),
    `${chips.join(' | ')} vs ${loadout.join('/')}`
  )
}

/**
 * THE STEP. It LEAVES THE BOX EMPTY, like every other step in this suite leaves what it found —
 * the checks after it in `stepBestSpells` are claims about the ranked table.
 */
export async function stepBestSpellsSearch(page: Page): Promise<void> {
  if (!check('the readout offers a whole-catalog search box', (await countOf(page, SEARCH)) === 1)) return
  const loadout = await page.evaluate(
    (s) => Array.from(document.querySelectorAll(s)).map((el) => (el as HTMLElement).innerText.trim()),
    COMBO_CHIP
  )
  if (loadout.length === 0) {
    note('no loadout chips on the panel opposite, so there is no "outside my class" to search for')
    return
  }
  const target = outsideClassSpell(loadout)
  if (!target) {
    note(`every single-class spell in the catalog belongs to ${loadout.join('/')} - nothing to compare`)
    return
  }

  await page.fill(SEARCH, target.name, { timeout: 10_000 })
  const swapped = await settle(() => bodies(page), (n) => n[0] === 1 && n[1] === 0, { timeoutMs: 8_000 })
  check(
    'typing swaps the ranked table for results - the table is GONE, not merely hidden',
    swapped[0] === 1 && swapped[1] === 0,
    `${String(swapped[0])} results / ${String(swapped[1])} tables`
  )

  // THE ROW IS ON WHICHEVER TAB CAN READ IT, and which of the five that is depends on the spell -
  // so the step walks them the way a reader would rather than pinning a tab the catalog might
  // re-file a spell out of.
  const found = await findResult(page, target.name)
  const claim = `the ${target.cls} spell "${target.name}" is found by a loadout that cannot learn it`
  if (check(claim, found !== null, `walked ${TABS.join('/')}`)) {
    note(`it reads on the ${String(found)} tab`)
    await checkResultRow(page, target, loadout)
  }

  await clearBestSpellsSearch(page)
  const restored = await settle(() => bodies(page), (n) => n[0] === 0 && n[1] === 1, { timeoutMs: 8_000 })
  check(
    'clearing the box hands the ranked table back',
    restored[0] === 0 && restored[1] === 1,
    `${String(restored[0])} results / ${String(restored[1])} tables`
  )
}
