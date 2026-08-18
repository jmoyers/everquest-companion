/**
 * The Gear tab's CLASS filter and its WEAPON TYPE filter (JOS-302, the owner's first and third
 * asks). A module rather than more of `gear.e2e.mts`, the `gearSetSteps.mts` / `gearColumnSteps.mts`
 * precedent: everything these steps need is already standing in the host spec, and that file is at
 * the repo's 400-code-line factoring ceiling. The SLOT half of the ticket stayed in the host spec,
 * because it is that spec's own slot step growing multi-select semantics rather than a new subject.
 *
 * WHAT NEEDS A REAL APP HERE, given `tests/gearFilter.test.mts` owns both predicates without a DOM:
 *
 *   * THE CLASS PICKER IS FILLED BY DETECTION, not by the test. `useGearClasses` reads the combo
 *     module's live inference, so what is in that control at mount is a fact about the log the app
 *     is tailing — and since JOS-302 it NARROWS. No unit test can see that chain (log → parser →
 *     combo module → IPC → the picker → `filterGearRows`), and it is exactly the chain that decides
 *     what a user sees the first time they open the tab.
 *   * THE CHIP IS GONE FROM THE ROWS. `planner-mismatch-chip` is a shared component still drawn by
 *     two OTHER surfaces, so "we deleted it here" is a claim about a rendered table rather than
 *     about a module, and the only honest way to state it is to look at the table.
 *   * A CATEGORY IS A UNION, ON SCREEN. The identity is asserted over the corpus in
 *     `tests/gearIndex.test.mts`; what this adds is that the CONTROL produces it — picking
 *     "Two-handed" and picking its three member types by hand must leave the same count in the
 *     readout, through the real autocomplete, the real filter memo and the real windowed list.
 *
 * IT ALSO LEAVES THE TAB CLEAN, on purpose and load-bearingly: the class step CLEARS the picker
 * before it returns. Every step after it in the host spec was written against an unfiltered corpus
 * (Thelvorn is PAL-only, and the ownership steps hunt for it by key), so a detected trio left in
 * place would make the rest of the spec depend on what the fixture log happens to infer.
 */
import type { Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'

const ROW = '[data-testid="gear-row"]'
const COUNT = '[data-testid="gear-count"]'
const SEARCH = '[data-testid="gear-search"] input'
const CLASSES = '[data-testid="gear-classes"]'
const WEAPON = '[data-testid="gear-weapon"]'
const SLOT = '[data-testid="gear-slot"]'
const MISMATCH = '[data-testid="planner-mismatch-chip"]'

/** Thelvorn, Blade of Light — PAL-only, PRIMARY, `Skill: 1H Slashing`. The whole fixture, in one row. */
const THELVORN_KEY = 'thelvorn, blade of light'

const until = (fn: () => Promise<boolean>, ms: number): Promise<boolean> => settle(fn, (ok) => ok, { timeoutMs: ms })

/** `"212 of 6,814 items"` → 212. The readout is the only place the filtered total is stated. */
async function shownCount(page: Page): Promise<number> {
  const text = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '',
    COUNT
  )
  return Number((/[\d,]+/.exec(text)?.[0] ?? '0').replace(/,/g, ''))
}

/** Let the DEFERRED filter land — the count going still IS the condition (never a clock). */
async function settled(page: Page): Promise<number> {
  let last = -1
  await settle(
    async () => {
      const shown = await shownCount(page)
      const stable = shown === last
      last = shown
      return stable
    },
    (ok) => ok,
    { timeoutMs: 15_000 }
  )
  return last
}

async function search(page: Page, value: string): Promise<number> {
  await page.fill(SEARCH, value, { timeout: 15_000 })
  return settled(page)
}

/** The chips a picker is showing, in order — what the user SEES their filter to be. */
function chipsIn(page: Page, picker: string): Promise<string[]> {
  return page.evaluate(
    (sel) => [...document.querySelectorAll(`${sel} .MuiChip-label`)].map((n) => n.textContent ?? ''),
    picker
  )
}

/**
 * Pick one option out of a ChipMultiSelect by TYPING it and taking the highlighted hit — the
 * sky-filters helper, verbatim in behaviour and for the same reason: the listbox is a portal with
 * its own geometry, and clicking into it is a bet about layout that has nothing to do with the
 * filter under test. Escape closes the popup so it is not an overlay the next click has to fight.
 */
export async function pickIn(page: Page, picker: string, typed: string): Promise<void> {
  await page.click(`${picker} input`, { timeout: 15_000 })
  await page.fill(`${picker} input`, typed)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
}

/** Empty a picker the way a user does: focus its input and backspace every chip off. */
export async function clearPicks(page: Page, picker: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await chipsIn(page, picker)).length === 0) break
    await page.click(`${picker} input`, { timeout: 15_000 })
    await page.keyboard.press('Backspace')
  }
  await page.keyboard.press('Escape')
}

/** Is the fixture row on screen right now? Asked with the search box already narrowed to it. */
async function thelvornShown(page: Page): Promise<boolean> {
  return (await countOf(page, `${ROW}[data-item-key="${THELVORN_KEY}"]`)) === 1
}

/**
 * THE OWNER'S FIRST ASK, and the one that overruled a stated law: picking classes REMOVES the rows
 * that do not fit instead of chipping them.
 *
 * It runs EARLY in the host spec and leaves the picker EMPTY — see the file header on why every
 * later step depends on that.
 */
export async function stepGearClassFilter(page: Page): Promise<void> {
  const detected = await chipsIn(page, CLASSES)
  note(`the class picker mounted holding ${detected.length === 0 ? 'nothing' : detected.join(' ')} — whatever the log inferred`)

  await search(page, '')
  await clearPicks(page, CLASSES)
  const all = await settled(page)
  check('clearing the Classes picker returns the whole corpus', all > 0, `${String(all)} items`)

  // A CLASS THE FIXTURE ROW CANNOT BE: Thelvorn's page states PAL and nothing else.
  //
  // TYPED AS A WHOLE CLASS NAME since JOS-402: the control's options are still the /who codes and
  // still what the filter stores, but the words it offers and matches on are `Rogue` and `Paladin`
  // now, so a spec that typed `ROG` would filter the listbox to nothing and pick whatever was
  // highlighted. Typing what the user sees is also the only way this step proves the relabel.
  await pickIn(page, CLASSES, 'Rogue')
  const narrowed = await until(async () => (await shownCount(page)) < all, 15_000)
  const shown = await shownCount(page)
  check(
    'picking a class REMOVES the gear that class cannot use - it is not chipped and left on screen',
    narrowed && shown > 0,
    `${String(all)} items → ${String(shown)} a rogue can use`
  )

  await search(page, 'thelvorn')
  check(
    'a PAL-only weapon is GONE from a rogue`s table (the owner`s report, as an assertion)',
    !(await thelvornShown(page)),
    'the row is still listed while the class filter says Rogue'
  )
  // THE DELETED CHIP. `planner-mismatch-chip` still exists and two other surfaces still draw it;
  // what must never happen again is a gear SEARCH row wearing one.
  check('…and no search row wears an off-filter chip any more', (await countOf(page, MISMATCH)) === 0)

  // The class it CAN be, on the same search — so the narrowing is a filter and not a lost row.
  await clearPicks(page, CLASSES)
  await pickIn(page, CLASSES, 'Paladin')
  const back = await until(() => thelvornShown(page), 15_000)
  check('…and it comes straight back for the class whose page names it', back)
  // THE WORDS ON THE CONTROL (JOS-402). The pick above went in as `Paladin`, so the chip the user is
  // left holding must be the class, not the code — the same claim the Sky filter has always made.
  check(
    'the picked class wears its whole name, never the /who code',
    (await chipsIn(page, CLASSES)).join() === 'Paladin',
    (await chipsIn(page, CLASSES)).join()
  )

  await clearPicks(page, CLASSES)
  await search(page, '')
  const restored = await until(async () => (await shownCount(page)) === all, 15_000)
  check('clearing the picker restores every row it was holding back', restored, `${String(await shownCount(page))} of ${String(all)}`)
  if (!restored) note('the steps below were written against an unfiltered corpus and may now be reading a narrowed one')
}

/**
 * THE OWNER'S SECOND ASK: the slot filter is a multi-select, and several slots are a UNION.
 *
 * One slot narrows; a SECOND slot WIDENS the result rather than replacing the first (*the table
 * shows rows matching ANY chosen slot*); clearing returns the full corpus. It then leaves exactly
 * PRIMARY picked and returns that count, because the host spec's threshold, sort and upgrade steps
 * were all written against a PRIMARY-narrowed table.
 *
 * THE CONTROL KEPT ITS `gear-slot` TESTID through the change from single-select to multi-select,
 * which is why JOS-297's control-visibility step needed no edit at all — it only ever asked whether
 * the control was on screen, and that question survives the shape change.
 */
export async function stepGearSlotPicks(page: Page, all: number): Promise<number> {
  await pickIn(page, SLOT, 'PRIMARY')
  const narrowed = await until(async () => (await shownCount(page)) < all, 15_000)
  const primaries = await shownCount(page)
  check('the slot filter narrows the table to one equipment slot', narrowed, `${String(primaries)} primaries`)

  await pickIn(page, SLOT, 'SECONDARY')
  const union = await until(async () => (await shownCount(page)) > primaries, 15_000)
  const both = await shownCount(page)
  check(
    'a SECOND slot is a UNION - the table shows rows matching ANY chosen slot, never both at once',
    union && both < all,
    `${String(primaries)} primaries → ${String(both)} primaries or secondaries, of ${String(all)}`
  )

  await clearPicks(page, SLOT)
  const emptied = await until(async () => (await shownCount(page)) === all, 15_000)
  check('…and clearing the picker returns the full corpus', emptied, `${String(await shownCount(page))} of ${String(all)}`)

  await pickIn(page, SLOT, 'PRIMARY')
  await until(async () => (await shownCount(page)) === primaries, 15_000)
  return primaries
}

/**
 * THE OWNER'S THIRD ASK: weapon types, and categories that union several of them.
 *
 * THE UNION IS ASSERTED AS AN IDENTITY BETWEEN TWO COUNTS, never as a number — the corpus grows
 * (AGENTS.md, "frozen numbers rot"), and "Two-handed shows exactly what its three members show" is
 * true of any corpus while "Two-handed shows 442" is true of today's.
 */
export async function stepGearWeaponTypes(page: Page): Promise<void> {
  const all = await search(page, '')
  await clearPicks(page, WEAPON)

  await pickIn(page, WEAPON, '1H Slashing')
  const narrowed = await until(async () => (await shownCount(page)) < all, 15_000)
  const oneHandSlash = await shownCount(page)
  check(
    'picking a weapon type narrows the table to weapons of that skill',
    narrowed && oneHandSlash > 0,
    `${String(all)} items → ${String(oneHandSlash)} 1H slashers`
  )
  await search(page, 'thelvorn')
  check('…and the corpus`s own `Skill: 1H Slashing` row is one of them', await thelvornShown(page))
  await search(page, '')

  // THE CATEGORY, twice: once as itself, once as its three members typed in by hand.
  await clearPicks(page, WEAPON)
  await pickIn(page, WEAPON, 'Two-handed')
  await until(async () => (await shownCount(page)) < all, 15_000)
  const category = await shownCount(page)
  check('a category pick narrows the table too', category > 0 && category < all, `${String(category)} two-handers`)

  await search(page, 'thelvorn')
  check('…and a one-hander is not among them', !(await thelvornShown(page)))
  await search(page, '')

  await clearPicks(page, WEAPON)
  for (const type of ['2H Slashing', '2H Blunt', '2H Piercing']) await pickIn(page, WEAPON, type)
  const members = await settled(page)
  check(
    'A CATEGORY IS EXACTLY THE UNION OF ITS MEMBER TYPES - the same rows, picked two ways',
    members === category,
    `Two-handed showed ${String(category)}, its three types show ${String(members)}`
  )

  // IN ADDITION TO THE SLOT, which is the ticket's own words for how this composes.
  await clearPicks(page, WEAPON)
  await pickIn(page, WEAPON, 'One-handed')
  const oneHand = await settled(page)
  await pickIn(page, SLOT, 'SECONDARY')
  const withSlot = await until(async () => (await shownCount(page)) < oneHand, 15_000)
  check(
    'the weapon type ANDs with the slot rather than replacing it',
    withSlot && (await shownCount(page)) > 0,
    `${String(oneHand)} one-handers → ${String(await shownCount(page))} that can go in the off hand`
  )

  // Hand the tab back the way the steps below expect to find it.
  await clearPicks(page, SLOT)
  await clearPicks(page, WEAPON)
  const cleared = await until(async () => (await shownCount(page)) === all, 15_000)
  check('clearing both pickers returns the whole corpus', cleared, `${String(await shownCount(page))} of ${String(all)}`)
}
