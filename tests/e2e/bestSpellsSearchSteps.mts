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

const TYPE = '[data-testid="best-spells-type"]'
/**
 * THE VISIBLE HALF of the type control. A MUI `select` TextField renders a hidden native `input`
 * (which is what `slotProps.htmlInput` decorates, and which cannot be clicked) beside the div a
 * person actually presses. That div carries `role="combobox"`, so the role is the durable handle
 * here — a testid on the input would find an element with no size.
 */
const TYPE_INPUT = '[data-testid="best-spells-type"] [role="combobox"]'
const TYPE_OPTION = '[data-testid="best-spells-type-option"]'
const CATALOGUE = '[data-testid="best-spells-catalogue"]'
const CATALOGUE_ROW = '[data-testid="best-spells-catalogue-row"]'
/**
 * THE APP-WIDE SPELL DRILL SEAM (JOS-508). `SpellTooltip` clones its anchor with `role="link"` when
 * — and only when — an app published an opener, so the ROLE is the honest handle: a name that is
 * plain text has no role at all, which is exactly the state this claim must be able to fail on.
 */
const SPELL_LINK = '[role="link"]'

/**
 * Every catalogue row the body is drawing: its name, and the Category chip it wears.
 *
 * THE CATEGORY COMES BACK WITH THE NAME because the step has to be able to wait for the FILTER to
 * have landed, not merely for rows to exist. Opening the control fetches the unfiltered list, so a
 * step that settled on "any rows at all" reads the answer to the previous question — which is what
 * this one did on its first green run, passing its central claim off a list the filter had not
 * touched. That version would have gone on passing if the category filter had done nothing at all.
 */
function catalogueRows(page: Page): Promise<{ name: string; category: string }[]> {
  return page.evaluate(
    (sels) =>
      Array.from(document.querySelectorAll(sels[0])).map((r) => ({
        name: (r as HTMLElement).dataset.name ?? '',
        category:
          (r.querySelector(sels[1]) as HTMLElement | null)?.dataset.category ?? ''
      })),
    [CATALOGUE_ROW, '[data-testid="best-spells-catalogue-category"]']
  )
}

/**
 * SEARCH BY TYPE, ASSERTED ON SCREEN (JOS-507).
 *
 * WHAT THIS PROVES THAT NO UNIT TEST CAN. `spell_search.rs`'s suite pins the query in Rust and
 * `ops.rs`'s pins the op; both are hand-authored rows inside one process. Only the running app can
 * show that the whole path holds end to end — a renderer with its OWN engine connection, a request
 * over the wire, the player's client files read beside the staged install, and rows drawn in a
 * 260px column that already carries a box, five tabs, a slider and now a type control.
 *
 * AND THE ONE CLAIM THE TICKET IS ABOUT: `Leech` and `Siphon Strength` are in a `Taps` list while
 * containing no `tap` in their NAMES. That is what searching by TYPE means, and it is the assertion
 * that failed when the engine's filter was first written the obvious name-only way.
 *
 * The staged tables are HAND-AUTHORED (`logFixture.mts stageClientTables`) so this holds on any
 * machine rather than only on one with EverQuest installed — and every row is learnable by every
 * class, so the step never has to guess what loadout the fixture log inferred.
 */
export async function stepBestSpellsTypeSearch(page: Page): Promise<void> {
  if (!check('the readout offers a spell-TYPE filter beside its search box', (await countOf(page, TYPE)) === 1)) {
    return
  }
  // THE CONTROL ASKS THE ENGINE WHEN IT IS OPENED, and the vocabulary it offers is the player's own
  // file's — there is no list this app could ship, so an unopened control has no options by design.
  await page.click(TYPE_INPUT, { timeout: 10_000 })
  const options = await settle(
    () =>
      page.evaluate(
        (sel) => Array.from(document.querySelectorAll(sel)).map((o) => (o as HTMLElement).dataset.value ?? ''),
        TYPE_OPTION
      ),
    (v) => v.length > 1,
    { timeoutMs: 10_000 }
  )
  const types = options.filter((v) => v !== '')
  if (types.length === 0) {
    // THE CONTROL SAYS WHY IT IS EMPTY, and the distinction is load-bearing rather than tidy: while
    // this step was first written the harness was silently dropping the staged client tables, and a
    // note that could only say "no engine connection, or no table" reported the wrong cause for two
    // full runs. The two states now read straight off the control.
    const why = await page.evaluate(
      (sel) => {
        const el = document.querySelector(sel) as HTMLElement | null
        return `offline=${el?.dataset.offline ?? '?'} table=${el?.dataset.table ?? '?'}`
      },
      TYPE
    )
    note(`the type control offered nothing - ${why}`)
    await page.keyboard.press('Escape')
    return
  }
  check(`the control offers the client table's own categories (${types.join('/')})`, types.includes('Taps'))

  await page.click(`${TYPE_OPTION}[data-value="Taps"]`, { timeout: 10_000 })
  const swapped = await settle(
    () => bodies(page).then(async (b) => [...b, await countOf(page, CATALOGUE)]),
    (n) => n[2] === 1 && n[1] === 0,
    { timeoutMs: 10_000 }
  )
  check(
    'picking a type swaps in the catalogue body - the ranked table is GONE, not merely hidden',
    swapped[2] === 1 && swapped[1] === 0,
    `${String(swapped[0])} results / ${String(swapped[1])} tables / ${String(swapped[2])} catalogues`
  )

  // WAIT FOR THE FILTER, NOT FOR ROWS. See `catalogueRows` — settling on "any rows" reads the
  // unfiltered answer the control's own opening fetched.
  const rows = await settle(
    () => catalogueRows(page),
    (rs) => rs.length > 0 && rs.every((r) => r.category === 'Taps'),
    { timeoutMs: 10_000 }
  )
  const names = rows.map((r) => r.name)
  const filtered = rows.length > 0 && rows.every((r) => r.category === 'Taps')
  check(
    'the picked type actually FILTERS - every row drawn is one of that category',
    filtered,
    rows.map((r) => `${r.name} [${r.category}]`).join(' | ')
  )
  if (check('…and it draws rows out of the client table', names.length > 0, names.join(' | '))) {
    // THE TICKET'S OWN CLAIM, and it only means anything above the filter check: a name-only filter
    // would return NONE of these, because none of these names contains the word.
    const byType = names.filter((n) => !n.toLowerCase().includes('tap'))
    check(
      'a TYPE search finds spells whose NAME does not contain the word - the whole capability',
      byType.length > 0 && filtered,
      `by type: ${byType.join(' | ')} — of ${names.join(' | ')}`
    )
    // Every row wears the two words the game prints in those columns.
    const chips = await countOf(page, `${CATALOGUE_ROW} [data-testid="best-spells-catalogue-category"]`)
    check('…and every row carries its Category chip', chips === names.length, `${String(chips)} of ${String(names.length)}`)
    const level = await countOf(page, `${CATALOGUE_ROW} [data-testid="best-spells-catalogue-level"]`)
    check('…and its Level, which is what the list is sorted by', level === names.length)
    // THE DRILL SEAM (JOS-508), VERIFIED RATHER THAN ASSUMED. Every spell name in the main window is
    // a link because `SpellTooltip` publishes one from a context; a row that wrapped its name in
    // plain text instead would look identical here and drill nowhere. So the claim is that the
    // catalogue's names are inside the same seam every other spell name uses.
    const links = await countOf(page, `${CATALOGUE_ROW} ${SPELL_LINK}`)
    check(
      'a spell found by TYPE drills like any other - its name is inside the app-wide link seam',
      links === names.length,
      `${String(links)} of ${String(names.length)} rows`
    )
  }

  // BACK TO ALL TYPES, so the steps after this one are looking at what they were written against.
  await page.click(TYPE_INPUT, { timeout: 10_000 })
  await page.click(`${TYPE_OPTION}[data-value=""]`, { timeout: 10_000 })
  const restored = await settle(
    () => bodies(page).then(async (b) => [...b, await countOf(page, CATALOGUE)]),
    (n) => n[2] === 0 && n[1] === 1,
    { timeoutMs: 10_000 }
  )
  check(
    'clearing the type filter hands the ranked table back',
    restored[2] === 0 && restored[1] === 1,
    `${String(restored[1])} tables / ${String(restored[2])} catalogues`
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
