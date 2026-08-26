/**
 * Headless Electron integration test for the GEAR tab (JOS-284, phase 3 of the gear planner).
 *
 * WHY ITS OWN FILE: one spec per surface, all of them sharing `appHarness.mts` and running back to
 * back from `npm run test:e2e`. `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock and points `userData` at a throwaway temp dir, so this runs invisibly
 * beside the user's game and dev app.
 *
 * WHAT IT ASSERTS, against the REAL committed item corpus and through the REAL IPC: the nav row
 * mounts a table with no plan and no selection first (search is the WHOLE surface since JOS-325 —
 * owner ruling); the list is its own bounded scroller; the search box narrows it and finds a named
 * item; the era toggle actually holds rows back; a MULTI-SELECT slot filter and a weapon type
 * COMBINE; a header click sorts by ratio and the order is monotone; and — the one this phase exists
 * for — moving the GLOBAL plus-state selector makes the table state the numbers `scaleGearRow`
 * states at that state.
 *
 * AND SINCE JOS-302 IT ASSERTS THE THREE NARROWINGS THE OWNER ASKED FOR. The class picks REMOVE
 * rows rather than chipping them (and a search row no longer wears `planner-mismatch-chip` at all),
 * a second slot is a UNION rather than a replacement, and the weapon-type picker's categories are
 * exactly the union of their member types — measured as an identity between two counts, never as a
 * number. The class and weapon steps live in `gearFilterSteps.mts`; the slot half is this file's
 * own slot step, grown.
 *
 * WHAT IT NO LONGER ASSERTS, because the code is gone: the stat-threshold chip flow, the
 * threshold-derives-its-own-column rule, and the min-ratio box (JOS-302's fourth owner ask). Those
 * three steps were REMOVED rather than weakened; what replaced them is the slot/weapon combination
 * above, and an upgrade step that names its three columns in the picker instead of conjuring two of
 * them out of a filter it never actually wanted.
 *
 * THE FIXTURE IS THELVORN, and its numbers are not written here. The spec imports phase 0's own
 * scaler and asks it, so this file can never drift from the arithmetic it is checking: what it
 * pins is that the SCREEN agrees with `scaleGearRow`, at base and at the owner's checkpoint. The
 * base vector is copied from `tests/gearIndex.test.mts`, which asserts it against the corpus — so
 * a rescrape that changes Thelvorn turns THAT file red first, naming the corpus rather than the UI.
 *
 * AND SINCE JOS-285 (phase 4) IT ASSERTS THE OWNERSHIP JOIN, which is the half no unit test can
 * see. `tests/gearOwnership.test.mts` owns every WORD the join produces, without a DOM; what needs
 * a real app is the CHAIN — a `/outputfile inventory` dump staged into the install root → main's
 * outputs registry finding and stating it → the fold → one IPC payload → a map keyed by `row.key`
 * → a cell on a windowed row — plus the second witness, the LIVE log, arriving by a completely
 * different route (an appended loot line → the tailer → the loot module → a delta) and landing on
 * the same key. Two processes, two transports, one join key: that is what this spec is for.
 *
 * The dump is the committed `Primitive_freeport-Inventory.txt`, and the two rows it is read for
 * were chosen because they are the join's two interesting cases in the OWNER'S OWN file:
 * Thelvorn is equipped at +5 (with its own exaltation socketed beside it, which must NOT read as
 * a second copy), and `Guise of the Deceiver` sits on the `Activated` key ring the fold does not
 * count — the exclusion the header of the Owned column has to admit to.
 *
 * WHAT IT NO LONGER ASSERTS, TAKE TWO: THE SETS (JOS-325). JOS-286 added three steps and a whole
 * step module (`gearSetSteps.mts`) for a chain three transports deep — a `+` on a windowed search
 * row → a cell in a pane → the `sumGear` totals → a debounced write over IPC → main's validator →
 * electron-store → a second launch that read it back. The owner retired the sets surface, so those
 * claims are RETIRED WITH IT rather than weakened: a removal legitimately removes its own
 * assertions, and a spec that kept asserting a `+` nobody can click would be pinning a bug.
 *
 * What did NOT go with them is anything about search, and that is the constraint this ticket was
 * written under: every step below — mount, rows, era, ownership cells, the owned filter, search,
 * class picks, slot union, weapon types, ratio sort, the global plus-state, the columns picker and
 * its relaunch — is exactly the spec JOS-302/JOS-324 left. The SECOND LAUNCH survives too, for the
 * column choice rather than for the sets: `ProgressState.gearSets` is kept on disk (progressState.
 * ts) and no longer has a surface to prove itself through, so `tests/gearSetStore.test.mts` is now
 * the only thing that speaks for it — which is the right level, because the store round trip is
 * all that is left of the feature.
 *
 * AND SINCE JOS-338 IT ASSERTS THE COMPARISON CARD, which is the first popper this tab has ever
 * mounted and therefore the first place the JOS-143 defect could come back. The step
 * (`gearCompareSteps.mts`) opens the card on a real row, reads the equipped half against the same
 * staged dump the ownership steps read, and then — with the card OPEN — hit-tests the toolbar, the
 * row's wish control and the item name's Loot link. That last part is the regression, stated the way
 * the owner met it twice: not "is a popper on screen" but "does the click still land".
 *
 * …AND SINCE JOS-344 IT ASSERTS THAT A HUMAN CAN SEE IT. The version above shipped a card drawn
 * three pixels inside the right edge of the window: present, correct, and invisible. So the step
 * takes the WINDOW now (it narrows it past the app's own minimum and puts it back) and measures the
 * two cards' boxes against the viewport at both sizes. Its header carries the measurement and the
 * two traps in taking it.
 *
 * AND SINCE JOS-329 IT ASSERTS THAT THE FORM COMES HOME. The owner's report was that the whole gear
 * area lost its state on every module switch, so the two round trips he described are steps here:
 * set six controls to values nothing defaults to, leave for the Loot MODULE and come back; then
 * drill into the Loot detail from a row and press BACK. Both compare a fingerprint read off the
 * SCREEN — including the count line, which moves if any narrowing was silently dropped — and both
 * assert the view UNMOUNTED first, because a spec that skipped that would pass on the one build
 * where the bug cannot happen (AGENTS.md, JOS-90/97/116). The second launch then proves the
 * RESTART SPLIT in both directions: the slot pick and the era toggle survive the process, the typed
 * search does not.
 *
 * The one thing it deliberately does NOT assert is a row count: the corpus grows (AGENTS.md,
 * "frozen numbers rot"), so every count here is a floor or an identity.
 *
 * Run: `npm run test:e2e -- gear`.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  pageOverflow,
  reportRun,
  settle,
  settleCount
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'
// JOS-297's steps are a MODULE (the plannerSteps.mts precedent): everything they need is standing
// here, and this file is at the repo's 400-code-line factoring ceiling. `pickColumns`/`resetColumns`
// come from it too: since JOS-302 deleted the stat thresholds, naming a column in the picker is the
// only way to put one on the table, and the upgrade step below needs three of them.
import {
  cellText,
  pickColumns,
  resetColumns,
  stepGearColumns,
  stepGearColumnsRelaunched,
  type GearColumnFixture
} from './gearColumnSteps.mjs'
// JOS-302's class, slot-union and weapon-type steps, likewise.
import { clearPicks, pickIn, stepGearClassFilter, stepGearSlotPicks, stepGearWeaponTypes } from './gearFilterSteps.mjs'
// JOS-336's EFFECTIVE HP step: pick the derived column, sort it, and move the slider under it.
import { stepGearEffectiveHp } from './gearEffectiveHpSteps.mjs'
// JOS-335's wish gesture — a module for the same reason, and it spans two tabs (its header argues
// why the chain, rather than the fold, is what needs a real app).
import { stepGearWish } from './gearWishSteps.mjs'
// JOS-338's comparison card, likewise — and it is the step that hit-tests the JOS-143 regression
// with a popper open over this tab for the first time since the table shipped.
import { stepGearCompare } from './gearCompareSteps.mjs'
// JOS-329's away-and-back steps, shared with the planner and character specs — one module because
// the claim is identical on every tab of the area and only the fingerprint differs.
import { stepGearMemory, stepGearMemoryRelaunched } from './areaMemorySteps.mjs'
// The 2026-08-25 review round: a numeric token, the Drop columns chip, and the fit that must not drift.
import { stepGearColumnFit, stepGearDropsToggle, stepGearThreshold } from './gearReviewSteps.mjs'
// Phase 0's scaler and phase 2's ratio, so the EXPECTED numbers are computed rather than typed.
import { gearRatio, scaleGearRow } from '../../src/shared/planner/gearScale'
import type { GearRow } from '../../src/shared/planner/gear'
import type { ItemUpgradeState } from '../../src/shared/itemUpgrade'

const NAV = '[data-testid="nav-gear"]'
/**
 * The area's own tab, and why the entry clicks it as well as the row (JOS-324).
 *
 * `nav-gear` is now the door to FOUR tabs and it opens the one you last used, which is exactly
 * what a person wants and exactly what a spec must not depend on — this file's second launch
 * reuses the first's `userData`, so "whatever was last open" is a value one earlier step could
 * change. Clicking the tab after the row costs nothing and pins the entry.
 */
const TAB = '[data-testid="tab-gear"]'
const VIEW = '[data-testid="gear-view"]'
const LIST = '[data-testid="gear-list"]'
const ROW = '[data-testid="gear-row"]'
const COUNT = '[data-testid="gear-count"]'
const EMPTY = '[data-testid="gear-empty"]'
const SEARCH = '[data-testid="gear-search"] input'
const ERA_TOGGLE = '[data-testid="gear-era-toggle"]'
// The slot picker's own selector moved to `gearFilterSteps.mts` with the step that drives it. It is
// still `gear-slot` — a ChipMultiSelect wearing a single-select's testid, on purpose (JOS-302).
const WEAPON_PICKER = '[data-testid="gear-weapon"]'
const SORT_RATIO = '[data-testid="gear-sort-RATIO"]'
const TIER_SLIDER = '[data-testid="gear-tier-slider"] input[type="range"]'
const FRACTION_SLIDER = '[data-testid="gear-fraction-slider"] input[type="range"]'
const UPGRADE_LABEL = '[data-testid="gear-upgrade-label"]'
// ---- phase 4 (JOS-285) ----
const OWNED_TOGGLE = '[data-testid="gear-owned-toggle"]'
const OWNED_HEADER = '[data-testid="gear-owned-header"]'
const OWNED_CELL = '[data-testid="gear-cell-owned"]'
const DUMP_LINE = '[data-testid="gear-dump-line"]'
/** The row key every index in this app joins on — and, from phase 4, the ownership join key. */
const THELVORN_KEY = 'thelvorn, blade of light'

/**
 * The dump the app is handed, and the two rows read out of it.
 *
 * `Thelvorn, Blade of Light +5` is on Primary and `Thelvorn, Blade of Light (Exaltation)` is in
 * one of its sockets — so `Equipped +5` is also the assertion that the exaltation row did NOT
 * become a second copy (gearOwnership.ts, rule 2).
 */
const DUMP_FIXTURE = 'Primitive_freeport-Inventory.txt'
const THELVORN_OWNED = 'Equipped +5'
/** The one key ring the fold does not count, and the word its exclusion has to be stated in. */
const UNCOUNTED_RING = 'Activated'

/**
 * THE SECOND WITNESS: an item the corpus has, the dump does NOT name, and the LOG will. Secondary
 * slot and Classic era, so neither the era toggle nor a slot filter can hide it from this spec.
 */
const LOOTED_ITEM = 'Shiny Brass Shield'
const LOOTED_KEY = 'shiny brass shield'

/**
 * Thelvorn's BASE vector, exactly as `tests/gearIndex.test.mts` asserts the corpus states it. Only
 * the fields the scaler reads are filled in; everything else is what a `GearRow` requires.
 */
const THELVORN_BASE: GearRow = {
  key: THELVORN_KEY,
  name: 'Thelvorn, Blade of Light',
  searchKey: THELVORN_KEY,
  slots: ['PRIMARY'],
  classes: ['PAL'],
  races: ['ALL'],
  flags: [],
  quest: false,
  playerCrafted: false,
  stats: { WIS: 15, DMG: 20, DELAY: 26, WEIGHT: 3 },
  effects: []
}

/** "Tier 2   3 / 4" — the owner screenshot every phase-0 number in this repo is verified against. */
const CHECKPOINT: ItemUpgradeState = { full: 2, fraction: 3 }

/**
 * WHAT JOS-297's STEPS ARE TOLD (gearColumnSteps.mts) — the same row again, plus the plus-state the
 * upgrade step leaves the global selector at, so the picker's own numbers assertion can compute its
 * expectation from `scaleGearRow` exactly as `expectedAt` does below.
 */
const COLUMNS: GearColumnFixture = { row: THELVORN_BASE, state: CHECKPOINT }

const until = (fn: () => Promise<boolean>, ms: number): Promise<boolean> => settle(fn, (ok) => ok, { timeoutMs: ms })

const textOf = (page: Page, sel: string): Promise<string> =>
  page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)

/** Box + scroll geometry — enough to prove a growing list is a BOUNDED scroller. */
function boxOf(page: Page, sel: string): Promise<{ h: number; scrollH: number; clientH: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    return { h: Math.round(el.getBoundingClientRect().height), scrollH: el.scrollHeight, clientH: el.clientHeight }
  }, sel)
}

/** `"212 of 6,814 items"` → `[212, 6766]`. The readout is the only place the total is stated. */
async function counts(page: Page): Promise<{ shown: number; total: number }> {
  const text = await textOf(page, COUNT)
  const nums = [...text.matchAll(/[\d,]+/g)].map((m) => Number(m[0].replace(/,/g, '')))
  return { shown: nums[0] ?? 0, total: nums[1] ?? 0 }
}

// `cellText` — one numeric cell of one row, as text, where `''` covers both "the row is not on
// screen" and "the item states none" — now comes from gearColumnSteps.mjs (imported above). It
// lived here AND there, byte for byte, until JOS-324 needed four lines of budget in this file.

/** Type into a filter box and let the DEFERRED filter land — the count settling IS the condition. */
async function typeAndSettle(page: Page, sel: string, value: string): Promise<number> {
  await page.fill(sel, value, { timeout: 15_000 })
  let last = -1
  await settle(
    async () => {
      const { shown } = await counts(page)
      const stable = shown === last
      last = shown
      return stable
    },
    (ok) => ok,
    { timeoutMs: 15_000 }
  )
  return last
}

/** 1. THE NAV ROW MOUNTS THE TABLE — with nothing selected first. That is the owner's ruling. */
async function stepMount(page: Page): Promise<boolean> {
  const hasRow = await page.waitForSelector(NAV, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the nav drawer has a Gear row', hasRow)) return false
  const label = (await textOf(page, NAV)).replace(/\s+/g, ' ').trim()
  check('…and it is called Gear', label.includes('Gear'), `reads "${label}"`)
  await page.click(NAV, { timeout: 15_000 })

  // …and the area it opens offers Gear as its FIRST tab (JOS-324). See TAB above for why the spec
  // clicks it rather than trusting the row's last-used memory.
  const hasTab = await until(async () => (await countOf(page, TAB)) > 0, 30_000)
  if (!check('…and the row opens an area whose first tab is Gear', hasTab)) return false
  await page.click(TAB, { timeout: 15_000 })

  const mounted = await until(async () => (await countOf(page, VIEW)) > 0, 30_000)
  if (!mounted) {
    const noLogs = (await textOf(page, 'main')).includes('No EverQuest logs found')
    check('clicking Gear mounts the table (or the no-logs empty state explains why not)', noLogs)
    if (noLogs) note('no character logs on this machine — the app shows its fresh-machine empty state')
    return false
  }
  check('clicking the Gear nav row mounts the table with no plan and no selection first', mounted)
  return true
}

/** 2. THE TABLE IS THE COMMITTED CORPUS, IN A BOUNDED SCROLLER. */
async function stepRows(page: Page): Promise<boolean> {
  const listed = (await settleCount(page, ROW, 1, { timeoutMs: 60_000 })) > 0
  if (!check('the gear table renders rows from the committed item index', listed, await textOf(page, EMPTY))) {
    return false
  }
  const { shown, total } = await counts(page)
  check(
    'the table states how much of the index it is showing',
    total >= 6000 && shown > 0 && shown <= total,
    `${String(shown)} of ${String(total)}`
  )
  // WINDOWED: the mounted rows are a screenful, not the answer — the count readout is the answer.
  const mounted = await countOf(page, ROW)
  check(
    'the list is windowed — the DOM holds a screenful, never the whole result',
    mounted < shown || shown < 60,
    `${String(mounted)} rows mounted for ${String(shown)} matches`
  )
  const box = await boxOf(page, LIST)
  check(
    'the gear list is its own scroller (a growing list never grows the page)',
    box !== null && box.h > 0 && box.scrollH >= box.clientH,
    box ? `${String(box.h)}px tall · scrollHeight ${String(box.scrollH)} vs clientHeight ${String(box.clientH)}` : 'absent'
  )
  return true
}

/**
 * 3. THE ERA TOGGLE HOLDS ROWS BACK — asserted as an IDENTITY, never as a number.
 *
 * The committed corpus documents every expansion, so "off shows more" is a fact about the wiki
 * rather than about today's scrape. It is turned OFF and LEFT off: Thelvorn's era is the corpus's
 * business, and a later step reading its numbers must not depend on that verdict.
 */
async function stepEra(page: Page): Promise<void> {
  const before = (await counts(page)).shown
  await page.click(ERA_TOGGLE, { timeout: 15_000 })
  const grew = await until(async () => (await counts(page)).shown > before, 15_000)
  const after = (await counts(page)).shown
  check(
    'the Current era filter is ON by default and switching it off reveals more of the corpus',
    grew,
    `${String(before)} in era → ${String(after)} in total`
  )
}

/**
 * 3b. THE OWNERSHIP JOIN — the phase this ticket exists for, read off two different transports.
 *
 * The dump half is already on disk when the app launches, so its assertion is simply what the cell
 * says. The LOG half is written here, while the app is up, and travels chokidar → Tailer → parser
 * → loot module → delta → the join's memo: an item the dump does not name reads `Looted`, which is
 * the answer JOS-285 asked for and the one a wiki tab can never give.
 */
async function stepOwnedCells(page: Page, log: FixtureLog): Promise<void> {
  // The `/outputfile` freshness line, RE-USED rather than restated: this tab renders JOS-253/268's
  // own component, so the dump's two instants have exactly one author on this screen.
  check('the Gear tab carries the /outputfile freshness line rather than its own age', (await countOf(page, DUMP_LINE)) === 1)

  await typeAndSettle(page, SEARCH, 'thelvorn')
  const owned = await cellText(page, THELVORN_KEY, 'owned')
  check(
    'a row the staged dump names says WHERE it is and at what +N',
    owned === THELVORN_OWNED,
    `reads "${owned}", wanted "${THELVORN_OWNED}"`
  )
  // The same row has a `(Exaltation)` child in the dump. One copy, not two — rule 2 of the join.
  check('…and the item`s own (Exaltation) row did not become a second copy', !owned.includes(' · '), owned)

  const hint = await page.getAttribute(OWNED_HEADER, 'title', { timeout: 15_000 })
  check(
    'the Owned header admits which key rings the fold does not count - "not counted" is not "not owned"',
    (hint ?? '').includes(UNCOUNTED_RING),
    (hint ?? '').slice(-160)
  )

  // THE SECOND WITNESS, written into the very log the app is tailing.
  log.append(`--You have looted a ${LOOTED_ITEM} from a decaying skeleton corpse.--`)
  await typeAndSettle(page, SEARCH, LOOTED_ITEM)
  const looted = await until(async () => (await cellText(page, LOOTED_KEY, 'owned')) === 'Looted', 30_000)
  check(
    'an item the LOG saw looted and the dump does not name reads Looted, live',
    looted,
    `reads "${await cellText(page, LOOTED_KEY, 'owned')}"`
  )
}

/**
 * 3c. THE OWNER'S CHECKBOX. Asserted as an IDENTITY and an INVARIANT, never as a number: the
 * corpus grows, so what is pinned is that the filter removes rows, keeps only rows the join can
 * say something about, and is fully reversible.
 */
async function stepOwnedFilter(page: Page): Promise<void> {
  const all = await typeAndSettle(page, SEARCH, '')
  await page.click(OWNED_TOGGLE, { timeout: 15_000 })
  const narrowed = await until(async () => (await counts(page)).shown < all, 15_000)
  const shown = (await counts(page)).shown
  check(
    'Owned or looted narrows the corpus to what this character has actually handled',
    narrowed && shown > 0,
    `${String(all)} in era → ${String(shown)} owned or looted`
  )

  // THE INVARIANT: every surviving row has something to say. A blank Owned cell under this filter
  // would mean a row got through that the join knows nothing about.
  const blanks = await page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].filter((c) => (c as HTMLElement).innerText.trim() === '').length,
    OWNED_CELL
  )
  check('every row the filter keeps states where it is or that it was looted', blanks === 0, `${String(blanks)} blank`)

  // The looted-but-not-in-the-dump arm — the one the checkbox exists for, and the one an ownership
  // index alone cannot answer.
  await typeAndSettle(page, SEARCH, LOOTED_ITEM)
  check(
    'a looted item the dump never named survives the filter on the log`s word alone',
    (await countOf(page, `${ROW}[data-item-key="${LOOTED_KEY}"]`)) === 1
  )

  // …and something neither witness has ever seen is gone, and comes back when the filter is off.
  await typeAndSettle(page, SEARCH, 'fungus covered scale tunic')
  const hiddenWhenOn = await countOf(page, ROW)
  await page.click(OWNED_TOGGLE, { timeout: 15_000 })
  const backWhenOff = await until(async () => (await countOf(page, ROW)) > 0, 15_000)
  check(
    'an item neither the dump nor the log has seen is hidden by the filter and returns without it',
    hiddenWhenOn === 0 && backWhenOff,
    `${String(hiddenWhenOn)} rows with the filter on`
  )
  await typeAndSettle(page, SEARCH, '')
  check('…and turning it off restores the whole corpus', (await counts(page)).shown === all)
}

/** 4. SEARCH NARROWS THE TABLE, and it finds an item by name. */
async function stepSearch(page: Page): Promise<boolean> {
  const total = (await counts(page)).shown
  const shown = await typeAndSettle(page, SEARCH, 'thelvorn')
  check('typing narrows the table', shown > 0 && shown < total, `${String(shown)} of ${String(total)}`)
  const found = await countOf(page, `${ROW}[data-item-key="${THELVORN_KEY}"]`)
  check('…to the item that was typed, keyed by the corpus join key', found === 1, `${String(found)} matching rows`)
  return found === 1
}

/**
 * 5. THE SLOT PICKER, AND A SECOND FILTER ON TOP OF IT.
 *
 * IT USED TO BE "a stat threshold and a slot filter combine", and the fourth owner ask (JOS-302)
 * deleted the threshold half outright — the typed-chip step, the "every surviving row states the
 * stat" step and the "the stat asked about gets a column" step with it. The replacement is the same
 * claim over controls that still exist: the slot picks AND with the weapon type, and the picker
 * (not a threshold) is what puts a stat on the table.
 *
 * The union half of the slot picker lives in `gearFilterSteps.stepGearSlotPicks` — a module for the
 * line budget, not because it is a different subject. It leaves exactly one slot picked, which is
 * the state the steps below were written against, and returns the count that narrowing produced.
 */
async function stepFilters(page: Page): Promise<void> {
  await typeAndSettle(page, SEARCH, '')
  const all = (await counts(page)).shown
  const afterSlot = await stepGearSlotPicks(page, all)

  await pickIn(page, WEAPON_PICKER, 'One-handed')
  const combined = await until(async () => (await counts(page)).shown < afterSlot, 15_000)
  const afterBoth = (await counts(page)).shown
  check(
    'two filters COMBINE — slot AND weapon type, never one replacing the other',
    combined && afterBoth > 0,
    `${String(afterSlot)} primaries → ${String(afterBoth)} that are also one-handers, of ${String(all)}`
  )
  // …and the second one comes back off, leaving the PRIMARY narrowing the steps below expect.
  await clearPicks(page, WEAPON_PICKER)
  check(
    '…and dropping the second leaves the first exactly as it was',
    await until(async () => (await counts(page)).shown === afterSlot, 15_000),
    `${String((await counts(page)).shown)} of ${String(afterSlot)}`
  )
}

/** 6. SORTING BY RATIO IS MONOTONE, and it reads `gearRatio` rather than a second opinion. */
async function stepSort(page: Page): Promise<void> {
  await page.click(SORT_RATIO, { timeout: 15_000 })
  const ratios = await until(async () => {
    const values = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="gear-cell-RATIO"]')]
        .map((c) => (c as HTMLElement).innerText.trim())
        .filter((t) => t !== '')
    )
    return values.length > 1
  }, 15_000)
  if (!check('sorting by ratio leaves weapons on screen with ratios to compare', ratios)) return

  const values = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="gear-cell-RATIO"]')].map((c) => (c as HTMLElement).innerText.trim())
  )
  const numbers = values.filter((t) => t !== '').map(Number)
  const descending = numbers.every((n, i) => i === 0 || numbers[i - 1] >= n)
  check(
    'a ratio sort ranks the visible rows highest first',
    descending,
    numbers.slice(0, 5).map((n) => n.toFixed(2)).join(' ')
  )
  // …and NOTHING that lacks a ratio is ranked among them: an absent value sorts last, never as 0.
  const firstBlank = values.indexOf('')
  check(
    'a row with no ratio never outranks one that has a ratio',
    firstBlank === -1 || values.slice(firstBlank).every((t) => t === ''),
    `first blank at ${String(firstBlank)} of ${String(values.length)}`
  )
}

/** Focus a slider and drive it with the keyboard — the same path the control gives a user. */
async function driveSlider(page: Page, sel: string, keys: readonly string[]): Promise<void> {
  await page.focus(sel, { timeout: 15_000 })
  for (const key of keys) await page.press(sel, key, { timeout: 15_000 })
}

/** What `scaleGearRow` says this row reads at one state — the expectation, computed not typed. */
function expectedAt(state: ItemUpgradeState): { dmg: string; wis: string; ratio: string } {
  const s = scaleGearRow(THELVORN_BASE, state).stats
  return { dmg: String(s.DMG), wis: String(s.WIS), ratio: gearRatio(s)?.toFixed(2) ?? '' }
}

/** The three cells this step is about, read off the screen. */
async function screenAt(page: Page): Promise<{ dmg: string; wis: string; ratio: string }> {
  return {
    dmg: await cellText(page, THELVORN_KEY, 'DMG'),
    wis: await cellText(page, THELVORN_KEY, 'WIS'),
    ratio: await cellText(page, THELVORN_KEY, 'RATIO')
  }
}

/**
 * Tier 0 → 2 (Home, then two steps), then every banked point of that tier (End on the fraction
 * slider, whose maximum IS 2^full - 1). Keyboard rather than a drag: same control, same handler,
 * no pixel arithmetic to get wrong.
 */
async function setCheckpoint(page: Page): Promise<void> {
  await driveSlider(page, TIER_SLIDER, ['Home', 'ArrowRight', 'ArrowRight'])
  const fractionAppeared = await until(async () => (await countOf(page, FRACTION_SLIDER)) > 0, 10_000)
  check('a tier with exp to bank offers the fraction slider beside it', fractionAppeared)
  if (fractionAppeared) await driveSlider(page, FRACTION_SLIDER, ['End'])

  const label = (await textOf(page, UPGRADE_LABEL)).replace(/\s+/g, ' ').trim()
  const says = label.includes('Tier 2') && label.includes('3/4') && label.includes('+27.5%')
  check('the selector says what it is simulating, in the item window’s own words', says, label)
}

/**
 * 7. THE GLOBAL PLUS-STATE SELECTOR — the one this phase exists for.
 *
 * The table is narrowed to Thelvorn, its three columns are ASKED FOR BY NAME in the columns picker,
 * and the cells are read TWICE: at base, and at the owner's checkpoint (tier 2 + 3/4). Both
 * readings are compared against `scaleGearRow`'s own answer, computed here — so what is pinned is
 * that the screen and phase 0 agree, not a number somebody typed into a spec.
 *
 * THE COLUMNS USED TO ARRIVE BY THRESHOLD (`dmg 1`, `wis 10` derived them as a side effect), and
 * JOS-302 deleted the thresholds. Naming them in the picker is strictly better for this step: it
 * needed the COLUMNS and never the narrowing, and a floor of `dmg 1` was always a filter that had
 * to be proved harmless before the assertion could trust it.
 */
async function stepUpgrade(page: Page): Promise<void> {
  // ONLY THE TWO THAT ARE NOT ALREADY THERE. The picker's first click PROMOTES the derived seed
  // (`toggleColumn(base, key)` where base is what the checkboxes were showing), so picking DMG and
  // WIS adds them to the core four — and picking RATIO, which IS one of the core four, would toggle
  // it OFF and leave `screenAt` reading a blank ratio cell. Measured, not assumed: that is exactly
  // what the first run of this step did.
  await pickColumns(page, ['DMG', 'WIS'])
  await typeAndSettle(page, SEARCH, 'thelvorn')
  const onScreen = (await countOf(page, `${ROW}[data-item-key="${THELVORN_KEY}"]`)) === 1
  if (!check('the upgrade step has its row, with the three columns it asked the picker for', onScreen)) return

  const base = expectedAt({ full: 0, fraction: 0 })
  const atBase = await screenAt(page)
  check(
    'at base the table states the corpus’s own numbers',
    atBase.dmg === base.dmg && atBase.wis === base.wis,
    `screen DMG ${atBase.dmg} WIS ${atBase.wis} ratio ${atBase.ratio}`
  )

  await setCheckpoint(page)

  const want = expectedAt(CHECKPOINT)
  await until(async () => (await cellText(page, THELVORN_KEY, 'DMG')) === want.dmg, 15_000)
  const got = await screenAt(page)
  check(
    'moving the global selector restates every displayed number at that plus — scaleGearRow’s answer, exactly',
    got.dmg === want.dmg && got.wis === want.wis && got.ratio === want.ratio,
    `screen ${got.dmg}/${got.wis}/${got.ratio} · scaleGearRow ${want.dmg}/${want.wis}/${want.ratio}`
  )
  // DELAY never scales, which is the whole reason the ratio moved — 0.77 at base, 0.96 here.
  check(
    '…and the ratio moved because the damage did and the delay did not',
    want.ratio !== base.ratio,
    `${base.ratio} → ${want.ratio}`
  )
  // HAND THE COLUMNS BACK TO THE DERIVATION. `stepGearColumns` below starts from whatever choice it
  // is handed and TOGGLES, so a list left here would silently un-pick two of the keys it picks.
  await resetColumns(page)
}

async function steps(app: ElectronApplication, page: Page, log: FixtureLog): Promise<void> {
  if (!(await stepRows(page))) return
  // JOS-302's class step runs FIRST of the filter steps, and it has to: the picker mounts holding
  // whatever the combo module inferred off the fixture log, that pick now NARROWS the corpus, and
  // every step below was written against an unfiltered one. It proves the narrowing and then
  // clears the picker (gearFilterSteps.mts states the whole argument).
  await stepGearClassFilter(page)
  // JOS-335 runs HERE, and the position is load-bearing in one direction: it needs the era toggle
  // still at its default ON, so the row it picks is one the app itself calls in-era and the wish it
  // writes lands in the wish list's ROUTE rather than behind that tab's own era filter. It leaves
  // the tab exactly as it found it — nothing narrowed, search empty — so the step below still
  // measures the era toggle against the whole corpus.
  await stepGearWish(page)
  await stepEra(page)
  // Phase 4 runs here, on a table narrowed by NOTHING but the era toggle the step above turned
  // off: the ownership steps put the search box back to empty and the checkbox back off, so the
  // phase-3 steps below start from the state they were written against.
  await stepOwnedCells(page, log)
  await stepOwnedFilter(page)
  // JOS-338 runs HERE, on the same staged dump the two ownership steps just read: it is the other
  // half of the same file — that one says whether you own a candidate, this one says what you are
  // wearing instead of it. It needs the GLOBAL SELECTOR STILL AT BASE (the card admits to a
  // simulation, and the step asserts it has nothing to admit to yet), which is true anywhere above
  // `stepUpgrade`. It hands the tab back with the box empty and both pickers clear.
  await stepGearCompare(app, page, THELVORN_BASE)
  // Phase 5's set steps used to run HERE, between the ownership steps and the phase-3 ones, and
  // JOS-325 removed them with the surface they drove. The clear-the-box line they were followed by
  // STAYS, even though `stepOwnedFilter` now leaves the box empty on its own: `stepSearch` measures
  // its narrowing against the whole corpus, and stating that precondition costs one settled read.
  await typeAndSettle(page, SEARCH, '')
  if (await stepSearch(page)) {
    // The FIT runs HERE, on the box `stepSearch` just narrowed to Thelvorn, with the columns still
    // derived and no width stored; it hands the widths back to automatic, which every picker step
    // below reads `data-layout` against.
    await stepGearColumnFit(page)
    // JOS-302's weapon-type step runs BEFORE the slot/threshold step, on a table nothing is
    // narrowing: its whole subject is what one picker does to the whole corpus, and it hands the
    // tab back with both of its pickers empty.
    await stepGearWeaponTypes(page)
    // The token and the chip run on the corpus the weapon step left unnarrowed, columns derived
    // (AC is a core column); both hand the tab back exactly as they found it.
    await stepGearThreshold(page)
    await stepGearDropsToggle(page)
    // JOS-336's EFFECTIVE HP step runs HERE, in the one seam that gives it what it needs: the
    // weapon-type step clears both of its pickers and empties the search box, and nothing has
    // touched the global selector yet — so the derived column is measured against the WHOLE corpus
    // at base and then again at a plus it moves itself. It hands all three back the way it found
    // them (selector at base, columns derived, box empty) for the steps below.
    await stepGearEffectiveHp(page)
    await stepFilters(page)
    await stepSort(page)
    await stepUpgrade(page)
    // JOS-297 runs LAST of the first launch, and deliberately: it needs the global selector already
    // at the checkpoint (so the picked columns can be re-read against `scaleGearRow` at a plus
    // nobody is about to move), and it parks a column choice for the second launch to find.
    await stepGearColumns(page, COLUMNS)
    // …and JOS-329 runs after IT, for two reasons. It MOVES the global selector (a Tier 1 label on
    // the far side of a module switch is the whole point of the overridden law), which every step
    // above reads; and the choice JOS-297 just parked is untouched by it, because the columns
    // picker and the filter form are different keys on the same tier. It parks a slot pick and an
    // era toggle of its own for `stepGearMemoryRelaunched` below.
    await stepGearMemory(page)
  }
  const over = await pageOverflow(page)
  check(
    'Gear never scrolls the page (its table clips inside its own box)',
    over.doc === 0 && over.content === 0,
    `document +${String(over.doc)}px · content area +${String(over.content)}px`
  )
}

/** Watch a page for the console errors this spec fails on. */
function watch(page: Page, into: string[]): void {
  page.on('console', (m) => {
    if (m.type() === 'error') into.push(m.text())
  })
  page.on('pageerror', (e) => into.push(String(e)))
}

async function main(): Promise<void> {
  buildIfStale()
  const consoleErrors: string[] = []

  // TWO LAUNCHES OVER ONE userData DIR (the default-sound-pack precedent). It was phase 5 that
  // needed the second one — a set had to OUTLIVE the process — and JOS-325 retired that claim with
  // the sets; the second launch stays because JOS-297's column choice makes the same promise on
  // the other storage tier, and the relaunch is the only place a `localStorage` preference can be
  // proved. The staged install is shared too, so the second launch tails the same log and reads
  // the same `/outputfile` dump.
  //
  // WITH A DUMP IN THE INSTALL ROOT (the `/outputfile` carve-out, logFixture.mts): every launch
  // this suite has ever made was a machine where the command had never been run, which is exactly
  // the half of phase 4 that would then never be measured.
  const userData = makeUserData()
  const log = stageFixture('e2e-planner.log', { inventory: DUMP_FIXTURE })

  console.log('launch 1: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-planner.log…')
  const first = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(first.app)
    watch(page, consoleErrors)
    if (await stepMount(page)) await steps(first.app, page, log)
    if (failures.length) await dumpArtifacts(page, 'gear-FAIL')
    else await dumpArtifacts(page, 'gear-pass')
  } finally {
    await first.close()
  }

  console.log('launch 2: the same userData — does the column choice come back?…')
  const second = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(second.app)
    watch(page, consoleErrors)
    const up = await stepMount(page)
    if (up) {
      await stepGearColumnsRelaunched(page)
      // THE RESTART HALF OF JOS-329's SPLIT, and the only place it can be proved: a structural pick
      // comes back across the process and a TYPED search does not. Both directions, because
      // "persisted everything" is as wrong as "persisted nothing".
      await stepGearMemoryRelaunched(page)
    }
    if (failures.length) await dumpArtifacts(page, 'gear-relaunch-FAIL')
  } finally {
    await second.close()
    await removeUserData(userData)
    await log.dispose()
  }

  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
