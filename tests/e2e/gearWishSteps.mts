/**
 * THE GEAR TAB'S WISH GESTURE (JOS-335) — a search row goes on the wish list, exactly as an
 * Exaltations donor row has since JOS-326 — AND COMES BACK OFF IT (JOS-343, owner ruling
 * 2026-08-13, revising JOS-335 the day after it shipped).
 *
 * WHAT THE REVISION REVISED, because a spec that quietly re-words its own claims is worse than one
 * that never made them. JOS-335 shipped a HEART that LIT and, lit, did nothing; this file asserted
 * exactly that, in the sentence "a second click leaves it lit rather than toggling the wish away".
 * The owner overruled both halves. The control is now the donor row's text control (one component,
 * `features/wishlist/WishToggle.tsx`, in its compact wording) and the second click REMOVES the
 * wish. So the old claim is not softened here — it is REPLACED by its opposite, and the removal is
 * proven where the add was: on the OTHER tab, in the route.
 *
 * A MODULE RATHER THAN MORE OF `gear.e2e.mts`, the `gearColumnSteps.mts` / `gearFilterSteps.mts`
 * precedent: everything this needs is already standing in the host spec, and that file sits at the
 * repo's 400-code-line factoring ceiling.
 *
 * WHAT NEEDS A REAL APP HERE, given `tests/wishlist.test.mts` owns every fold and
 * `tests/wishSearch.test.mts` owns `wishFromGear` without a DOM: the CHAIN, and nothing else. A
 * click on a windowed table row → `useWishlist.add`/`.remove` → the pure `addWish`/`removeWish` →
 * an IPC write → main's validator → electron-store → a SECOND VIEW, on a sibling tab, that
 * unmounted the first one and re-read the document from disk to draw its route. Four of those five
 * links are invisible to a unit test, and the fifth — that the REMOVE half is the same entry delete
 * the Wish list's own remove button calls — is only interesting once the document is real.
 *
 * THE WIDTH ASSERTION IS GONE (JOS-346), AND SAYING SO IS THE POINT. This file used to measure the
 * control's box against the Item column and fail if it took more than a third — the honest handling
 * of JOS-335's width argument, when the answer to that argument was a SHORTER pair of words on this
 * surface (`compact`: Wish / Remove). The owner overruled the short wording on 2026-08-13: the gear
 * row says "Add to wish list" / "Remove from wish list" exactly as the donor row does, and the width
 * cost is ACCEPTED. A ceiling that only the deleted wording could clear is not a test of the
 * shipped app, so it is deleted rather than loosened to a number the new label happens to fit.
 * What survives is the `note`: the run reports the wording and the boxes, so a reader can see the
 * cost the ruling accepted without a spec pretending to have a limit it does not have.
 *
 * THE REMOVAL IS PROVEN FROM THE OTHER TAB TOO (JOS-346). Step 5 removes from the gear row itself,
 * which only ever asked whether ONE mount can undo its own edit. The owner's bug was the other
 * direction — take the wish off on the Wish list tab, come back to Gear, and the control still read
 * ADDED — so step 4b does exactly that: the wish list's own per-row remove, then the trip back, then
 * the reading. It is the same claim the whole hook is about, made across two views instead of one.
 *
 * THE ROW IS CHOSEN OFF THE SCREEN, NEVER TYPED IN (AGENTS.md, "frozen numbers rot" — and a frozen
 * ITEM NAME rots the same way when the corpus is rescraped). Two properties are wanted and both are
 * read from the table itself:
 *
 *   * IN ERA, so the wish lands in the ROUTE rather than behind the wish list's own era filter.
 *     Guaranteed by WHERE this step runs — before `stepEra` turns the toggle off — so every row on
 *     screen is one the app's own `eraHides` admits, which is the same predicate the wish list uses.
 *   * NEITHER OWNED NOR LOOTED, so the wish is still WANTED. `wishFulfilled` sends a gear wish whose
 *     progress join reports a copy straight to the done strip, which is correct behaviour and the
 *     wrong half of the tab to be asserting a route entry in. An EMPTY Owned cell is the table's own
 *     statement that neither witness has seen the item, so the pick reads it and moves on.
 *
 * THE ADDED STATE IS ASSERTED IN BOTH DIRECTIONS, which is the half a "does the add work" spec
 * would skip: it comes ON at the click, SURVIVES a trip to the other tab and back (so it is a fact
 * about the store rather than about React state), and goes OFF at the second click. A control that
 * could only ever light up would pass a build where the join is a one-way latch.
 */
import type { Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'

const ROW = '[data-testid="gear-row"]'
const OWNED_HEADER = '[data-testid="gear-owned-header"]'
const GEAR_VIEW = '[data-testid="gear-view"]'
const GEAR_TAB = '[data-testid="tab-gear"]'
const WISH_TAB = '[data-testid="tab-wishlist"]'
const WISH_VIEW = '[data-testid="wishlist-view"]'

/** The wish control on one row, and the same control once it reads ADDED. `row.key` is the join key. */
const wishOf = (key: string): string => `${ROW}[data-item-key="${key}"] [data-testid="gear-wish"]`
const addedOf = (key: string): string => `${wishOf(key)}[data-wished="true"]`
/** The wish, on the OTHER tab, inside a route group — never merely somewhere on the page. */
const groupRowOf = (key: string): string =>
  `[data-testid="wishlist-group"] [data-testid="wishlist-row"][data-item="${key}"]`

const until = (fn: () => Promise<boolean>, ms: number): Promise<boolean> => settle(fn, (ok) => ok, { timeoutMs: ms })

interface Pick {
  key: string
  name: string
}

/**
 * The first mounted row the ownership join says nothing about — see the header for why that is the
 * property this step needs. `null` when every row on screen is owned or looted, which on the
 * committed corpus means something has gone wrong with the filters rather than with this step.
 */
function pickUnowned(page: Page): Promise<Pick | null> {
  return page.evaluate((sel) => {
    for (const row of document.querySelectorAll(sel)) {
      const owned = row.querySelector('[data-testid="gear-cell-owned"]')
      if (owned !== null && (owned as HTMLElement).innerText.trim() !== '') continue
      const key = row.getAttribute('data-item-key')
      // THE NAME ELEMENT, NOT THE CELL'S FIRST LINE (JOS-343). The Item cell holds the wish control
      // as well as the name, and the control now has WORDS — reading the cell's `innerText` reported
      // the donor "WISH" for one run of this spec before this line was corrected.
      const named = row.querySelector('[data-testid="planner-donor-name"]')
      if (key === null || named === null) continue
      return { key, name: (named as HTMLElement).innerText.trim() }
    }
    return null
  }, ROW)
}

interface CellWidths {
  /** the WL column's own width, whatever layout decided it is this run */
  cell: number
  /** the wish control's box */
  control: number
  /** the item name's box, in ITS cell — whole again since the control moved out (2026-08-15) */
  name: number
  /** the words on it right now, so the report says which wording was measured */
  label: string
}

function measureWishCell(page: Page, key: string): Promise<CellWidths | null> {
  return page.evaluate((sel) => {
    const control = document.querySelector(sel)
    const cell = control?.closest('td') ?? null
    const name = cell?.parentElement?.querySelector('[data-testid="planner-donor-name"]') ?? null
    if (control === null || cell === null || name === null) return null
    return {
      cell: Math.round(cell.getBoundingClientRect().width),
      control: Math.round(control.getBoundingClientRect().width),
      name: Math.round(name.getBoundingClientRect().width),
      label: (control as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    }
  }, wishOf(key))
}

/**
 * THE CONTROL HAS ITS OWN COLUMN NOW (user ruling, 2026-08-15, revising JOS-346's shared cell):
 * the `WL` column carries the compact Add/Remove pair and the Item cell holds the name alone. So
 * the placement check is that BOTH boxes exist in their own homes — a run where the control fell
 * back into the Item cell, or the name lost its element, is a run where the ruling broke. The
 * numbers still go in the report as a `note`, visible on every run and failing none.
 */
function stepGearWishWidth(w: CellWidths | null): void {
  if (!check('the wish control sits in its own WL column and the name keeps its cell', w !== null) || w === null) {
    return
  }
  note(`wish control "${w.label}" — ${String(w.control)}px of a ${String(w.cell)}px WL column · name ${String(w.name)}px`)
}

/**
 * ADD FROM A SEARCH ROW → THE ROUTE → CLICK AGAIN → OFF THE ROUTE.
 *
 * Runs on a table narrowed by NOTHING: the class picker has just been cleared by
 * `stepGearClassFilter`, the era toggle is still at its default ON, and the search box is empty.
 * It hands the tab back in exactly that state, and with the wish list as it found it — the toggle
 * is its own cleanup, which is a property the one-way version did not have.
 */
export async function stepGearWish(page: Page): Promise<void> {
  // The Owned column is the instrument the pick reads, so wait for the join rather than racing it.
  // It is a staged dump on disk at launch (the host spec's `/outputfile` carve-out), so it arrives.
  if (!check('the gear table has its ownership column before the wish step reads it', await until(async () => (await countOf(page, OWNED_HEADER)) > 0, 30_000))) {
    return
  }
  const pick = await pickUnowned(page)
  check('an in-era row that neither the dump nor the log has seen is on screen to want', pick !== null)
  if (pick === null) return
  const { key, name } = pick
  note(`wishing "${name}" (${key})`)

  // 1. THE CONTROL EXISTS AT ALL — the parity JOS-335 was, now in the shape JOS-343 made it: the
  //    Exaltations donor rows have had this control since JOS-326 and the 6,766 rows of the corpus
  //    had none.
  const present = await until(async () => (await countOf(page, wishOf(key))) === 1, 20_000)
  if (!check('every gear search row carries an add-to-wish-list control', present)) return
  check('…and it reads UNADDED, because nothing is wished yet', (await countOf(page, addedOf(key))) === 0)
  stepGearWishWidth(await measureWishCell(page, key))

  // 2. ONE CLICK, NO DIALOG. The control's own state is the whole acknowledgement.
  await page.click(wishOf(key), { timeout: 15_000 })
  check('clicking it adds the wish and the control says so on the spot', await until(async () => (await countOf(page, addedOf(key))) === 1, 15_000))

  // 3. THE OTHER TAB. A sibling of this one, so the trip is a click — and it unmounts this view,
  //    which is what makes the row it draws a fact about the STORE rather than about React state.
  await page.click(WISH_TAB, { timeout: 15_000 })
  if (!check('the Wish list tab mounts', await until(async () => (await countOf(page, WISH_VIEW)) > 0, 30_000))) return
  const routed = await until(async () => (await countOf(page, groupRowOf(key))) === 1, 20_000)
  check(
    'the wish written from a gear row arrives in the wish list`s zone groups',
    routed,
    `${String(await countOf(page, groupRowOf(key)))} route rows for ${key}`
  )
  check('…exactly once — the document dedupes by item key', (await countOf(page, `[data-testid="wishlist-row"][data-item="${key}"]`)) === 1)

  // 4. BACK, AND THE CONTROL STILL READS ADDED. The view was destroyed and rebuilt in between, so
  //    this is the store answering, not a component remembering.
  await page.click(GEAR_TAB, { timeout: 15_000 })
  if (!check('the Gear tab comes back', await until(async () => (await countOf(page, GEAR_VIEW)) > 0, 30_000))) return
  const back = await until(async () => (await countOf(page, addedOf(key))) === 1, 20_000)
  if (!check('…with the row it was left on, still reading ADDED after the remount', back, `looking for ${key}`)) return
  note(`added-state wording: "${(await measureWishCell(page, key))?.label ?? '(gone)'}"`)

  // 5. THE SECOND CLICK REMOVES IT (JOS-343). This is the claim that replaced JOS-335's "a second
  //    click leaves it lit rather than toggling the wish away" — the owner overruled the lit no-op.
  await page.click(wishOf(key), { timeout: 15_000 })
  check(
    'a second click takes the wish off, and the control reads UNADDED again',
    await until(async () => (await countOf(page, addedOf(key))) === 0, 15_000)
  )

  // 6. …AND IT REALLY LEFT THE DOCUMENT, proven where the add was proven: the route no longer has
  //    a row for it. `removeWish` is the Wish list tab's own delete, so this is one deletion shape.
  if (!routed) return
  await page.click(WISH_TAB, { timeout: 15_000 })
  if (!check('the Wish list tab mounts again', await until(async () => (await countOf(page, WISH_VIEW)) > 0, 30_000))) return
  check(
    'the row the second click removed is gone from the route entirely',
    await until(async () => (await countOf(page, `[data-testid="wishlist-row"][data-item="${key}"]`)) === 0, 20_000),
    `${String(await countOf(page, groupRowOf(key)))} route rows left for ${key}`
  )

  // Hand the Gear tab back the way the host spec expects to find it.
  await page.click(GEAR_TAB, { timeout: 15_000 })
  if (!(await until(async () => (await countOf(page, GEAR_VIEW)) > 0, 30_000))) return

  await stepRemovedOnTheOtherTab(page, key)
}

/**
 * THE OWNER'S BUG (JOS-346): REMOVE IT OVER THERE, AND THE CONTROL OVER HERE MUST KNOW.
 *
 * Every claim above removes the wish through the SAME control that added it, so all of them pass on
 * a build where each view holds its own copy of the document and only ever re-reads its own edits.
 * This one cannot: the deletion is the Wish list tab's own per-row remove, and the reading is taken
 * on the Gear tab afterwards. The two are different mounts of `useWishlist`, which is the seam.
 *
 * IT RE-ADDS FIRST, because the step it follows deliberately hands the list back empty. The add is
 * setup rather than a claim — the claim above already proved it — but it is still checked, since a
 * setup that silently did nothing would make the assertion below pass for the wrong reason.
 *
 * Runs LAST and leaves the Gear tab up with the wish list as it found it, exactly as its caller did.
 */
async function stepRemovedOnTheOtherTab(page: Page, key: string): Promise<void> {
  await page.click(wishOf(key), { timeout: 15_000 })
  if (!check('the row goes back on the wish list, so there is something to remove from the other tab', await until(async () => (await countOf(page, addedOf(key))) === 1, 15_000))) {
    return
  }

  await page.click(WISH_TAB, { timeout: 15_000 })
  if (!check('the Wish list tab mounts for the cross-tab removal', await until(async () => (await countOf(page, groupRowOf(key))) === 1, 30_000))) return
  await page.click(`[data-testid="wishlist-row"][data-item="${key}"] [data-testid="wishlist-remove"]`, { timeout: 15_000 })
  if (!check("the wish list's own remove takes the row off the route", await until(async () => (await countOf(page, `[data-testid="wishlist-row"][data-item="${key}"]`)) === 0, 15_000))) {
    return
  }

  await page.click(GEAR_TAB, { timeout: 15_000 })
  if (!check('the Gear tab comes back after the cross-tab removal', await until(async () => (await countOf(page, GEAR_VIEW)) > 0, 30_000))) return
  check(
    '…and the gear row reads UNADDED — a wish removed on the other tab is removed on this one',
    await until(async () => (await countOf(page, wishOf(key))) === 1 && (await countOf(page, addedOf(key))) === 0, 20_000),
    `${String(await countOf(page, addedOf(key)))} added-state controls left for ${key}`
  )
}
