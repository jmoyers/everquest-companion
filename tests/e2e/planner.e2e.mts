/**
 * Headless Electron integration test for the EXALTATIONS tab (docs/plans/exaltation-planner.md §9,
 * wave 3). The tab is LABELLED Exaltations since JOS-42; every id, route, store key and testid in
 * here still says `planner`, because the rename was a label and not a refactor.
 *
 * WHY ITS OWN FILE: one spec per surface, all of them sharing `appHarness.mts` and running back
 * to back from `npm run test:e2e`. `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock and points `userData` at a throwaway temp dir, so this runs invisibly
 * beside the user's game and dev app.
 *
 * WHY `userData` IS WIPED FIRST: the first assertion is the EMPTY STATE — a character with no
 * saved sets is invited to create one. The sets live in the store and the selected set/mode live
 * in `localStorage`, both inside `userData`, so a dir left behind by an earlier run would make
 * that assertion vacuous (and would land the pane in whichever mode the last run left open).
 *
 * WHAT IT ASSERTS, against the REAL committed item DB: the nav row mounts the pane on its empty
 * state; creating a set from the UI produces a set chip and a toolbar; the effect browser lists
 * at least one effect row and expands it into at least one donor (the corpus is committed data,
 * so this is deterministic — but it is asserted as a FLOOR, never as today's count); adding that
 * donor to the set writes a socket that BOTH other modes can see — the Board draws it in a cell
 * with a state chip, and the Farm rollup lists it under some heading; the two growing lists are
 * BOUNDED scroll boxes (the Task-#56 law); the era filter is ON by default and actually
 * removes rows when it is switched off (the corpus is majority Kunark/Velious, so "off shows
 * more" is an identity, not a number); the Focus tab opens on FAMILIES with the best tier of
 * each crowned, which is the per-socket grouping default (V4/V5) rather than a global one; a
 * majority of the donor rows on screen state what their effect DOES, in one line joined from the
 * committed spell DB (V6 — a count, never today's wording); the
 * Inventory tab either fills its hosts from a real `/outputfile inventory` dump or teaches the
 * command, never both (V7 — whether this machine has a dump is not something a spec may assume);
 * the board draws both any-slot cells, named in the client's own words, and a planned exaltation
 * says what it DOES when you hover it (JOS-104, both halves of one player's report);
 * clicking one of a host's sockets lands in the effect browser filtered to that socket, that slot
 * and that host, with a chip that can be cleared (V8); and the exaltation rules card is NOT up on a
 * first visit, comes up only from the toolbar's `?`, and closes for good when dismissed (V10 as
 * JOS-51 revised it — the rules are there when asked for, never by default).
 *
 * The one thing it deliberately does NOT assert is which effects or donors are on screen: a
 * rescrape may re-word an effect, and a spec that pins today's proc names would rot (AGENTS.md:
 * frozen numbers rot).
 *
 * Run: `npm run test:e2e`.
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  pageOverflow,
  rectOf,
  reportRun,
  settleCount,
  settleGone,
  settleStable
} from './appHarness.mjs'

import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
// The cell list itself, so the board's own count is never restated here (JOS-67 moved it 18 → 21,
// JOS-104 moved it 21 → 23).
import { PLAN_SLOTS } from '../../src/shared/planner/types'
// Every `planner-*` selector, the DOM measurements, and the four steps that measure the EFFECT
// LIST live next door — this spec sits at the repo's max-lines budget and the rule is to split,
// never ratchet (drill.mts, combatSteps.mts). The ORDER is still owned here.
import {
  ADD_BUTTON,
  BOARD,
  BOARD_CELL,
  DONOR_NAME,
  DONOR_ROW,
  EFFECT_LIST,
  EFFECT_ROW,
  EFFECT_SAYS,
  EXPLAINER,
  EXPLAINER_OPEN,
  FARM_ALSO_ERA,
  FARM_GROUP_OUT_OF_ERA,
  FARM_LIST,
  FARM_ROW,
  HOST_HIT,
  HOST_NAME,
  HOST_SEARCH,
  HOST_WORN,
  INVENTORY_FRESH,
  INVENTORY_HELP,
  MODE_BOARD,
  MODE_EFFECTS,
  MODE_FARM,
  NAV,
  NEW_SET_EMPTY,
  PRESET_CHIP,
  SET_CHIP,
  SOCKET_BROWSE,
  SOCKET_LINE,
  STATE_CHIP,
  VIEW,
  boxOf,
  checkReportedPairs,
  stepEra,
  stepFocusFamilies,
  stepNonEquip,
  stepOutputsRegistry,
  stepSocketEffect,
  textOf,
  until
} from './plannerSteps.mjs'

/** The Loot tab's drill-down, where a donor name deep-links to. */
const LOOT_DETAIL = '[data-testid="loot-detail"]'
const LOOT_TITLE = '[data-testid="loot-detail-title"]'
const LOOT_DB_SOURCES = '[data-testid="loot-db-sources"]'
/** The drill's back ARROW — origin-aware since JOS-43, and the return leg of this spec. */
const LOOT_BACK = '[data-testid="loot-back"]'

/**
 * 1. THE NAV ROW MOUNTS THE PANE. False on the no-logs machine, where no feature view mounts.
 *
 * The row's testid is `nav-planner` and always will be — the view id, the route and the store keys
 * are internal (JOS-42 renamed the LABEL, not the feature). So the label is asserted as TEXT: that
 * is the only place the rename is visible, and a spec that only clicked the testid would have let
 * it silently revert.
 */

async function stepMount(page: Page): Promise<boolean> {
  const hasRow = await page.waitForSelector(NAV, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the nav drawer has an Exaltations row', hasRow)) return false
  const label = (await textOf(page, NAV)).replace(/\s+/g, ' ').trim()
  check('…and it is called Exaltations, the name the game uses', label.includes('Exaltations'), `reads "${label}"`)
  await page.click(NAV, { timeout: 15_000 })

  // A character with no sets gets the invitation; one with sets gets the toolbar. Either is a
  // mounted pane — on a wiped userData it is always the first.
  const mounted = await until(
    async () => (await countOf(page, NEW_SET_EMPTY)) > 0 || (await countOf(page, VIEW)) > 0,
    30_000
  )
  if (!mounted) {
    const noLogs = (await textOf(page, 'main')).includes('No EverQuest logs found')
    check('clicking Exaltations mounts the pane (or the no-logs empty state explains why not)', noLogs)
    if (noLogs) note('no character logs on this machine — the app shows its fresh-machine empty state')
    return false
  }
  check(
    'clicking the Exaltations nav row mounts the pane on its create-a-set empty state',
    (await countOf(page, NEW_SET_EMPTY)) > 0,
    `${String(await countOf(page, SET_CHIP))} sets already stored`
  )
  return true
}

/** 2. CREATING A SET FROM THE UI GIVES THE PANE ITS TOOLBAR. */
async function stepCreateSet(page: Page): Promise<boolean> {
  if ((await countOf(page, NEW_SET_EMPTY)) > 0) await page.click(NEW_SET_EMPTY, { timeout: 15_000 })
  const made = await until(async () => (await countOf(page, SET_CHIP)) > 0, 15_000)
  check('creating a set from the empty state produces a set chip and the toolbar', made)
  return made
}

/**
 * 2b. THE RULES CARD WAITS TO BE ASKED, AND DISMISSING IT STICKS (V10, revised by JOS-51).
 *
 * The one collaborative explainer this app allows — but the owner overturned the "meet the rules on
 * your first visit" argument it used to open on (2026-08-06): the card is CLOSED on a fresh install
 * and the toolbar's `?` is the only door in. So the first assertion here is an ABSENCE, taken the
 * settle way: wait for the toolbar's own reading to STOP CHANGING (the pane legitimately remounts
 * while the app is still reading the log) and only then assert nothing is up. Never a sleep.
 *
 * The three facts after it are unchanged in substance: asking puts it up, dismissing puts it away,
 * and asking again brings it back. It ends dismissed so every measurement below sees the pane at
 * the height a returning player sees.
 */
async function stepExplainer(page: Page): Promise<void> {
  const first = await settleStable(
    async () => ({ card: await countOf(page, EXPLAINER), ask: await countOf(page, EXPLAINER_OPEN) }),
    { timeoutMs: 20_000 }
  )
  check(
    'the planner does NOT teach unasked — no rules card on a first visit',
    first.card === 0,
    `${String(first.card)} cards up before anyone asked`
  )
  if (!check('…and the toolbar carries the ? that is now the only way in', first.ask > 0)) return

  await page.click(EXPLAINER_OPEN, { timeout: 15_000 })
  if (!check('asking with the ? puts the exaltation rules card up', (await settleCount(page, EXPLAINER, 1, { timeoutMs: 8_000 })) > 0)) {
    return
  }
  // The numbers are read from the rules, never written here — so the unlock tiers must be on it.
  const text = (await textOf(page, EXPLAINER)).replace(/\s+/g, ' ')
  check('…and it states the unlock tiers it reads out of the rules', /Focus at \+\d/.test(text), text.slice(0, 90))

  await page.click(`${EXPLAINER} .MuiAlert-action button`, { timeout: 15_000 })
  check('dismissing the card puts it away', await settleGone(page, EXPLAINER, { timeoutMs: 8_000 }))

  await page.click(EXPLAINER_OPEN, { timeout: 15_000 })
  check('the ? brings it back after a dismissal', (await settleCount(page, EXPLAINER, 1, { timeoutMs: 8_000 })) > 0)
  await page.click(`${EXPLAINER} .MuiAlert-action button`, { timeout: 15_000 })
  await settleGone(page, EXPLAINER, { timeoutMs: 8_000 })
}

/** 3. THE EFFECT BROWSER LISTS THE COMMITTED CORPUS, in a bounded box. */
async function stepEffects(page: Page): Promise<boolean> {
  const listed = await until(async () => (await countOf(page, EFFECT_ROW)) > 0, 60_000)
  const box = await boxOf(page, EFFECT_LIST)
  check('the effect browser renders rows from the committed item DB', listed, `${String(await countOf(page, EFFECT_ROW))} rows`)
  check(
    'the effect list is its own scroller (a growing list never grows the page)',
    box !== null && box.h > 0 && box.scrollH >= box.clientH,
    box ? `${String(box.h)}px tall · scrollHeight ${String(box.scrollH)} vs clientHeight ${String(box.clientH)}` : 'absent'
  )
  return listed
}

/**
 * Expand an effect group so its donors are on screen. Retried once: the view remounts while the
 * app is still reading the log (App keys it on the character), and a remount collapses the tree —
 * which is correct behaviour for a fresh mount, and must not be read as "effects have no donors".
 */
async function ensureDonorRow(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await countOf(page, ADD_BUTTON)) > 0) return true
    await page.click(EFFECT_ROW, { timeout: 15_000 })
    if (await until(async () => (await countOf(page, ADD_BUTTON)) > 0, 8000)) return true
  }
  return false
}

/**
 * 4b. EVERY DONOR ROW SAYS WHAT ITS EFFECT DOES (V6).
 *
 * The index-build join is pinned in `tests/plannerEffectIndex.test.mts`; what only a launched app
 * can show is that the row DRAWS it. A count rather than a text match: the wording is the spell
 * DB's, and a spec that pinned "Beneficial · Single Friendly · 27 minutes" would rot on the next
 * rescrape. A MAJORITY is the assertion, because a miss is deliberately silent (law 1) and the
 * measured hit rate is 94% — a collapse to nothing means the join broke, not that the wiki moved.
 */
async function stepEffectSays(page: Page): Promise<void> {
  const rows = await countOf(page, DONOR_ROW)
  const says = await countOf(page, EFFECT_SAYS)
  check(
    'a donor row states what its effect DOES, in one line from the spell DB',
    says * 2 > rows && rows > 0,
    `${String(says)} of ${String(rows)} visible rows — e.g. ${await textOf(page, EFFECT_SAYS)}`
  )
}

/**
 * 5. ADDING A DONOR WRITES A SOCKET THE INVENTORY TAB DRAWS.
 *
 * The tab is called Inventory since V7 — it fills its cells from the character's own
 * `/outputfile inventory` dump — but what is asserted here is unchanged in kind: every cell
 * `PLAN_SLOTS` names whatever the dump says (twenty-three of them, since JOS-67 added the second
 * ring and JOS-104 the two any-slots), and the socket the browser just wrote drawn in one of them.
 * The two player-reported pairs are checked BY NAME, because both were reported as missing and a
 * count alone would not notice one being swapped for the other. Nothing here can
 * assume a dump exists (a fresh e2e userData has no gear knowledge at all), so the auto-fill is
 * checked by `stepInventoryFill` as an identity: either it filled cells or it says how to.
 */
async function stepAddAndInventory(page: Page): Promise<boolean> {
  if (!check('an effect row expands into at least one donor', await ensureDonorRow(page), `${String(await countOf(page, ADD_BUTTON))} donors`)) {
    return false
  }
  await stepEffectSays(page)
  await page.click(ADD_BUTTON, { timeout: 15_000 })
  // A donor that occupies more than one slot opens a slot menu instead of writing directly. Which
  // of the two happened is the CONDITION: wait briefly for a menu, and if one came, choose from
  // it and wait for it to go. Neither branch is a failure; guessing at 400ms twice was.
  const menu = '.MuiMenu-root .MuiMenuItem-root'
  if ((await settleCount(page, menu, 1, { timeoutMs: 3_000 })) > 0) {
    await page.click(menu, { timeout: 15_000 })
    await settleGone(page, menu, { timeoutMs: 8_000 })
  }

  await page.click(MODE_BOARD, { timeout: 15_000 })
  const drawn = await until(async () => (await countOf(page, SOCKET_LINE)) > 0, 15_000)
  const cells = await countOf(page, BOARD_CELL)
  check('the Inventory tab draws every equipment cell, planned or not', cells >= PLAN_SLOTS.length, `${String(cells)} cells`)
  await checkReportedPairs(page)
  check('adding a donor from the browser writes a socket the Inventory tab draws', drawn, `${String(await countOf(page, SOCKET_LINE))} socket lines`)
  check(
    'each planned socket carries exactly one state chip',
    (await countOf(page, STATE_CHIP)) === (await countOf(page, SOCKET_LINE)),
    `${String(await countOf(page, STATE_CHIP))} chips for ${String(await countOf(page, SOCKET_LINE))} sockets`
  )
  const rect = await rectOf(page, BOARD)
  check('the board has real height', !!rect && rect.h > 0, rect ? `${String(rect.w)}×${String(rect.h)}px` : 'absent')
  return drawn
}

/**
 * 6. THE HOST PICKER SEARCHES MAIN'S ITEM INDEX AND NARROWS IT TO THE CELL.
 *
 * Both outcomes are correct: a query that yields a slot- and class-compatible item picks it, and
 * one that does not says so in a sentence. Only a picker that opens onto nothing is a failure.
 */
async function stepHostPicker(page: Page): Promise<void> {
  const cell = `${BOARD_CELL}[data-slot="PRIMARY"] [data-testid="planner-host-pick"]`
  if ((await countOf(page, cell)) === 0) {
    note('the PRIMARY cell already has a host — the picker step is skipped this run')
    return
  }
  await page.click(cell, { timeout: 15_000 })
  const opened = await until(async () => (await countOf(page, HOST_SEARCH)) > 0, 10_000)
  if (!check('the host line opens a search popover', opened)) return

  await page.fill(HOST_SEARCH, 'sword', { timeout: 15_000 })
  await until(async () => (await countOf(page, HOST_HIT)) > 0, 8000)
  const hits = await countOf(page, HOST_HIT)
  if (hits === 0) {
    note('no item matching "sword" can go in PRIMARY for this set — the picker states that, which is the correct answer')
    await page.keyboard.press('Escape')
    return
  }
  await page.click(HOST_HIT, { timeout: 15_000 })
  const named = await until(async () => (await countOf(page, HOST_NAME)) > 0, 8000)
  check('picking a hit sets that cell’s host item', named, `${String(hits)} compatible hits`)
}

/**
 * 6b. THE INVENTORY TAB EITHER FILLS ITSELF OR TEACHES THE COMMAND (V7).
 *
 * An identity, because the machine running this may or may not have a dump: a character whose
 * `/outputfile inventory` exists gets `worn` hosts in its cells, and one whose does not gets the
 * instructions card. Exactly one of those must be on screen — neither is the failure, and BOTH
 * would mean the card is lying to someone who already ran it.
 */
async function stepInventoryFill(page: Page): Promise<void> {
  // POLLED, because the dump is read over IPC when the tab mounts: sampling the instant after the
  // switch reads "neither", which is the pre-answer state and not a third outcome.
  await until(async () => (await countOf(page, INVENTORY_HELP)) > 0 || (await countOf(page, HOST_WORN)) > 0, 20_000)
  const help = await countOf(page, INVENTORY_HELP)
  const worn = await countOf(page, HOST_WORN)
  check(
    'the Inventory tab either fills its hosts from the dump, or says how to make one',
    (help > 0) !== (worn > 0),
    help > 0 ? 'no dump on this machine — the instructions card is up' : `${String(worn)} hosts filled from the dump`
  )

  // JOS-42 refinement 5 — and when a dump DOES exist, the freshness line is up instead: the same
  // command, one clause of why, and how old the file is. Exactly one of the two, always: the card
  // teaches a command to someone who has never run it, the line tells someone who has when they
  // last did. A tab rendering gear with no age on it is the failure this closes.
  const fresh = await countOf(page, INVENTORY_FRESH)
  check(
    'a filled Inventory tab states the command and how old the dump is; an empty one teaches it',
    (help > 0) !== (fresh > 0),
    `${String(help)} instruction cards · ${String(fresh)} freshness lines`
  )
  if (fresh > 0) {
    const line = (await textOf(page, INVENTORY_FRESH)).replace(/\s+/g, ' ').trim()
    check(
      '…and that line names the command and dates the FILE, not the read',
      line.includes('/outputfile inventory') && /updated (just now|\d+[mhd] ago)/.test(line),
      line.slice(0, 120)
    )

  }

  // …and the same facts, live over the registry's own channel (JOS-44). Next door, with the rest
  // of the measurements this spec only orders.
  await stepOutputsRegistry(page, fresh > 0)
}

/**
 * 6c-i. ADD SAYS REPLACE WHEN IT WOULD REPLACE (JOS-42 refinement 3).
 *
 * Asserted UNDER A PRESET, because that is the only place the target socket is unambiguous: you
 * clicked one socket of one item, so every row on screen would write to exactly that socket, and
 * the button can therefore be checked against the socket's own state.
 *
 * The direction that matters is the FALSE REPLACE — a button warning about an overwrite that
 * would not happen teaches the user to ignore the warning — so "empty socket ⇒ nothing says
 * Replace" is asserted flat. The other direction allows one honest exception: a row whose donor
 * and effect are ALREADY what sits there replaces nothing (it is chipped "in set"), so a preset
 * showing only that row legitimately offers no Replace at all.
 */
async function checkReplaceLabels(page: Page, occupied: boolean): Promise<void> {
  const labels = await page.evaluate(
    (s) => Array.from(document.querySelectorAll(s)).map((b) => (b as HTMLElement).innerText.trim()),
    ADD_BUTTON
  )
  if (labels.length === 0) {
    note('the preset matched no addable donor — the replace-label step is skipped this run')
    return
  }
  const replace = labels.filter((l) => l.toLowerCase() === 'replace').length
  if (!occupied) {
    check(
      'an empty socket is never offered as a Replace — the add button only warns about a real overwrite',
      replace === 0,
      `${String(replace)} of ${String(labels.length)} buttons said Replace over an empty socket`
    )
    return
  }
  const inSet = await page.evaluate(
    () => Array.from(document.querySelectorAll('.MuiChip-label')).filter((e) => e.textContent === 'in set').length
  )
  if (replace === 0 && inSet >= labels.length) {
    note('every donor the preset offers is already the one in this socket — nothing here would replace anything')
    return
  }
  check(
    'browsing an OCCUPIED socket, the add button says Replace instead of Add to set',
    replace > 0,
    `${String(replace)} of ${String(labels.length)} buttons said Replace (${String(inSet)} already in set)`
  )
}

/**
 * 6c. A HOST'S SOCKETS ARE BROWSABLE ONE AT A TIME (V8).
 *
 * The item-focused way in: a cell with a host draws all four of its sockets, and clicking one
 * takes you to the effect browser already narrowed to that socket, that slot and that host. What
 * is asserted is the trip and the narrowing — the preset chip is on screen, and the socket tab it
 * forced is the socket that was clicked. Which effects come back is the corpus's business.
 */
async function stepSocketView(page: Page): Promise<void> {
  if ((await countOf(page, SOCKET_BROWSE)) === 0) {
    note('no cell has a host yet — the socket view step is skipped this run')
    return
  }
  // The socket's own row says whether it is FILLED: `planner-socket-line` is a planned socket,
  // `planner-socket-open` is an empty one. That is the fact the ADD control has to reflect.
  const target = await page.evaluate((s) => {
    const line = document.querySelector(s)?.closest('[data-socket]')
    return {
      socket: line?.getAttribute('data-socket') ?? '',
      occupied: line?.getAttribute('data-testid') === 'planner-socket-line'
    }
  }, SOCKET_BROWSE)
  await page.click(SOCKET_BROWSE, { timeout: 15_000 })

  const filtered = await until(async () => (await countOf(page, PRESET_CHIP)) > 0, 15_000)
  if (!check('clicking a socket on a host opens the effect browser filtered to it', filtered)) return
  const label = (await textOf(page, PRESET_CHIP)).replace(/\s+/g, ' ').trim()
  check(
    '…and the browser is on that socket, for that slot and that host',
    label.toLowerCase().includes(target.socket.toLowerCase()),
    `preset "${label}" for socket ${target.socket}`
  )
  await checkReplaceLabels(page, target.occupied)

  // Under a preset, haste-locked donors are OUT, not chipped (owner verdict 2026-08-05): the
  // preset promises only-legal-fits and R3 says haste never moves. The chip only exists in the
  // free browser, where it teaches the rule.
  const hasteChips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.MuiChip-label')).filter((el) =>
      (el.textContent ?? '').includes('haste — can')
    ).length
  )
  check('…and no haste-locked donor is offered under the preset', hasteChips === 0, `${String(hasteChips)} haste chips`)

  // Clearing hands the browser back — the preset is a filter, never a mode you get stuck in.
  await page.click(`${PRESET_CHIP} .MuiChip-deleteIcon`, { timeout: 15_000 })
  check('clearing the preset gives the browser back', await until(async () => (await countOf(page, PRESET_CHIP)) === 0, 10_000))
}

/** 7. THE FARM ROLLUP LISTS WHAT IS LEFT — or says, honestly, that nothing is. */
async function stepFarm(page: Page): Promise<void> {
  await page.click(MODE_FARM, { timeout: 15_000 })
  const mounted = await until(async () => (await countOf(page, FARM_LIST)) > 0, 15_000)
  if (!check('the Farm mode mounts its rollup', mounted)) return

  const rows = await countOf(page, FARM_ROW)
  const text = (await textOf(page, FARM_LIST)).replace(/\s+/g, ' ').trim()
  check(
    'the rollup either lists the planned donor under a heading, or states why it lists nothing',
    rows > 0 || text.length > 0,
    rows > 0 ? `${String(rows)} rows` : text.slice(0, 120)
  )
  if (rows === 0) {
    note('the planned donor is out of era (or already merged to its extraction tier), so the rollup is legitimately empty')
    return
  }
  const box = await boxOf(page, FARM_LIST)
  check(
    'the farm list is its own scroller',
    box !== null && box.h > 0 && box.scrollH >= box.clientH,
    box ? `${String(box.h)}px tall` : 'absent'
  )
  // JOS-42 refinement 4, THE TRUST INVARIANT, measured on the real corpus in the real app: with
  // the era filter on (its default, and where this run is), no heading may name a zone from an
  // expansion the server has not opened. A route that sends you to Dragon Necropolis is not a
  // partial answer, it is a wrong one — and it is the bug the owner reported.
  const unreachable = await countOf(page, FARM_GROUP_OUT_OF_ERA)
  check(
    'no farm heading sends you to a zone this era cannot reach',
    unreachable === 0,
    `${String(unreachable)} out-of-era headings`
  )
  // Those zones are not deleted — they drop into the row's "also:" tail, each naming its own
  // expansion. Present or not depends on what is planned, so this only checks the WORDING.
  const alsoEras = await page.evaluate(
    (s) => Array.from(document.querySelectorAll(s)).map((e) => (e as HTMLElement).innerText.trim()),
    FARM_ALSO_ERA
  )
  if (alsoEras.length > 0) {
    check(
      'an out-of-era camp survives in the "also:" tail, naming the expansion it belongs to',
      alsoEras.every((t) => /^\((Classic|Kunark|Velious|Luclin)\)$/.test(t)),
      alsoEras.slice(0, 3).join(' ')
    )
  }
  check(
    'every farm row states the merge cost in the shared vocabulary ("needs +N - ≈X D0 merges")',
    /needs \+\d+ - ≈\d+ D0 merges/.test(text),
    text.slice(0, 140)
  )
}

/**
 * 8. A DONOR NAME DEEP-LINKS INTO THE LOOT DRILL-DOWN — and the drill is worth the trip.
 *
 * The click is the app's standing link idiom (`openLoot`, appRouting.ts): it takes the Loot pane
 * over with that item's detail. The second half of the check is the one that matters — the drill
 * used to build "Dropped by / Zones" from OBSERVED loot events alone, so a donor you have never
 * looted answered "No source recorded" one click after the planner told you which mob drops it.
 * `loot-db-sources` is the section that closes that contradiction, so its presence is the actual
 * contract this link depends on.
 *
 * AND IT IS A ROUND TRIP (JOS-43). The reported bug was the return leg: Back on that drill meant
 * the top of the loot ledger, so reading one donor cost you your place in the plan. The arrow now
 * names the tab that sent you and goes there, which is asserted both by its accessible name
 * (before the click) and by the Exaltations tab being on screen after it.
 *
 * Runs LAST: it leaves the app on Exaltations having passed through the Loot tab, so every
 * planner-scoped measurement above it must already have been taken.
 */
async function stepDeepLink(page: Page): Promise<void> {
  await page.click(MODE_EFFECTS, { timeout: 15_000 })
  if (!(await ensureDonorRow(page))) {
    note('no donor row on screen to click through — the deep-link step is skipped this run')
    return
  }
  const name = (await textOf(page, DONOR_NAME)).trim()
  await page.click(DONOR_NAME, { timeout: 15_000 })

  const landed = await until(async () => (await countOf(page, LOOT_DETAIL)) > 0, 20_000)
  if (!check('clicking a donor name opens the Loot tab’s item drill-down', landed, `donor "${name}"`)) return
  const title = (await textOf(page, LOOT_TITLE)).replace(/\s+/g, ' ').trim()
  check('…on the item that was clicked, not on the ledger', title === name, `"${title}" vs "${name}"`)
  check(
    'the drill states what the committed DBs know about where it drops (never-looted items included)',
    (await countOf(page, LOOT_DB_SOURCES)) > 0
  )

  // THE RETURN LEG (JOS-43). The arrow says where it goes before you press it — one string feeds
  // the tooltip and the accessible name — and then it goes there. "Back to the loot list" here
  // would be the exact bug this ticket was filed for.
  const label = await page.getAttribute(LOOT_BACK, 'aria-label')
  check('the drill’s back arrow names Exaltations, not the loot list', label === 'Back to Exaltations', String(label))
  await page.click(LOOT_BACK, { timeout: 15_000 })
  const home = await until(async () => (await countOf(page, VIEW)) > 0, 20_000)
  check('…and pressing Back returns to the Exaltations tab you were reading', home)
  check('…with the plan still on screen, not the loot ledger', (await countOf(page, LOOT_DETAIL)) === 0)
  check(
    '…and the nav agreeing about where we are',
    (await countOf(page, `${NAV}.Mui-selected`)) === 1
  )
}

/** Everything downstream of "there is a set to plan into", in order. */
async function steps(page: Page): Promise<void> {
  await stepExplainer(page)
  if (await stepEffects(page)) {
    await stepEra(page)
    await stepNonEquip(page)
    await stepFocusFamilies(page)
    if (await stepAddAndInventory(page)) {
      await stepSocketEffect(page)
      await stepInventoryFill(page)
      await stepHostPicker(page)
      await stepSocketView(page)
      await stepFarm(page)
    }
  }
  const over = await pageOverflow(page)
  check(
    'Exaltations never scrolls the page (its lists clip inside their own boxes)',
    over.doc === 0 && over.content === 0,
    `document +${String(over.doc)}px · content area +${String(over.content)}px`
  )
  await stepDeepLink(page)
}

async function main(): Promise<void> {
  buildIfStale()

  // See the header: a stored set (or a remembered mode) would make the empty-state assertion
  // vacuous — this launch's userData dir has never held either.

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-planner.log…')
  // …and a real `/outputfile inventory` dump in the install root beside it (JOS-185). Without one,
  // every dump-fed surface takes its never-run branch, which is how the freshness line, the filled
  // hosts and the capture steps went unmeasured for the whole life of this suite.
  const { app, close } = await launchOnFixture('e2e-planner.log', { inventory: 'Primitive_freeport-Inventory.txt' })

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    if ((await stepMount(page)) && (await stepCreateSet(page))) await steps(page)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'planner-FAIL')
    else await dumpArtifacts(page, 'planner-pass')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
