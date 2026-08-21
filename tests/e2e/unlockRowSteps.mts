// WHAT AN UNLOCK ROW IS WORTH (JOS-391) — the second line under a spell's name, asserted on
// screen. It lives next door because leveling.e2e.mts sits AT the repo max-lines budget and the
// rule here is to SPLIT, never ratchet (drill.mts set the precedent; dropSteps.mts, curveSteps.mts
// and levelingLayoutSteps.mts followed it). The spec still owns the ORDER and the launch.
//
// WHAT THIS PROVES THAT NO UNIT TEST CAN. `tests/spellMetrics.test.mts` pins the numbers,
// `tests/spellLineLookup.test.mts` the ladders and `tests/levelUnlocks.test.mts` the wording. What
// none of them reaches is the SEAM: that main computes the figures at fold time, attaches them to
// `UnlockSpell`, ships them across the `spells:catalog` IPC, and that the panel draws all four
// statements on a row for a loadout the combo module inferred from this machine's real log.
//
// FLOORS AND SHAPES, NEVER TODAY'S NUMBERS. The figures come from the committed catalog and the
// loadout from whatever the log said, so the assertions are about GRAMMAR — a damage row states
// `dmg N` and something per mana, a replaces row names a spell and a three-letter class, an
// `already yours` row names a level strictly BELOW the one on screen. A wrong number is the unit
// suite's job; a row that says nothing, or says it about the wrong side of the level, is this
// step's.
//
// AND THE CAVEAT IS COUNTED. AGENTS.md's tooltip and caveat diet is the reason `directional` is
// one word in the panel header instead of a footnote per row, and the failure it guards against
// is exactly the kind that creeps back: this asserts the word appears EXACTLY ONCE on the panel.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { ARTIFACTS, check, countOf, hoverAt, note, settle, settleCount, settleGone } from './appHarness.mjs'
import { playWho } from './gameplay.mjs'
import type { FixtureLog } from './logFixture.mjs'

const NEW_AT_LEVEL = '[data-testid="new-at-level"]'
const LEVEL_VALUE = '[data-testid="new-at-level-value"]'
const LEVEL_NEXT = '[data-testid="new-at-level-next"]'
const COMBO_CHIP = '[data-testid="new-at-level-combo-chip"]'
const UNKNOWN_COMBO = '[data-testid="new-at-level-unknown"]'
const UNLOCK_ROW = '[data-testid="unlock-row"]'
const FIGURES = '[data-testid="unlock-figures"]'
const OWNED = '[data-testid="unlock-already-yours"]'
const REPLACES = '[data-testid="unlock-replaces"]'
const DIRECTIONAL = '[data-testid="new-at-level-directional"]'
// JOS-392: the search box, the body it swaps in, and the greying stepper behind it.
const SEARCH = '[data-testid="new-at-level-search"]'
const RESULTS = '[data-testid="new-at-level-results"]'
const STEPPER = '[data-testid="new-at-level-stepper"]'
const CLASS_CHIP = '[data-testid="unlock-class-chip"]'
// …and the spell NAME inside a note (the owner's addition), with the card it opens.
const NOTE_SPELL = '[data-testid="unlock-note-spell"]'
const SPELL_CARD = '[data-testid="spell-hover-card"]'
const CARD_FIGURES = '[data-testid="spell-card-figures"]'
// JOS-393: the era verdict, on a search row and on the card that row opens.
const SPELL_NAME = '[data-testid="unlock-spell-name"]'
const ERA_CHIP = '[data-testid="unlock-out-of-era"]'
const CARD_ERA = '[data-testid="spell-card-out-of-era"]'

/** How far up the stepper to walk looking for a row that carries figures. */
const WALK_LEVELS = 40

/** Rendered text of the first match; '' when the node is not mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/** One step of the level stepper, waiting on the stepper's OWN label rather than a sleep. */
async function stepUp(page: Page): Promise<void> {
  const label = await textOf(page, LEVEL_VALUE)
  await page.click(LEVEL_NEXT, { timeout: 10_000 })
  // Reading the rows before the new level lands would be reading the level we just left.
  await settle(() => textOf(page, LEVEL_VALUE), (t) => t !== label, { timeoutMs: 8_000 })
}

/** The grammar of the figures line, on whatever row is on screen. */
async function checkFigures(page: Page): Promise<void> {
  const text = await textOf(page, FIGURES)
  check(
    '…figures read as a compact damage or heal line',
    /(dmg|heal) \d+/.test(text) && /(dmg|heal)\/mana/.test(text),
    text
  )
  check('…with no em dash anywhere in it', !/[—–]/.test(text), text)
}

/**
 * `already yours` is loadout-dependent — a trio that shares no spell across two of its classes in
 * the walked band legitimately never prints it — so its ABSENCE is a note and its PRESENCE is an
 * assertion about the claim: the level it names must be strictly below the level on screen, which
 * is the whole meaning of "you bought this earlier". A join reading the wrong side of the
 * comparison would print a level equal to or above it, and that is the failure worth catching.
 */
async function checkOwned(page: Page, at: string): Promise<void> {
  if ((await countOf(page, OWNED)) === 0) {
    note(`no "already yours" row up to ${at} - this trio shares no spell across two classes that low`)
    return
  }
  const text = await textOf(page, OWNED)
  const m = /already yours \(([A-Z]{3}) (\d+)\)/.exec(text)
  check('…`already yours` names a class and a level', m !== null, text)
  if (!m) return
  const viewed = Number(/Level (\d+)/.exec(at)?.[1] ?? '0')
  check('…and that level is BELOW the one on screen', Number(m[2]) < viewed, `${text} at ${at}`)
}

/**
 * 6. "NEW AT THIS LEVEL" (docs/plans/levelup-whats-new.md) — the panel the level-up toast links
 * to, and the one surface on this tab that does NOT depend on the log having any dings in it: it
 * is computed from the committed spells.json + classes.json against the inferred loadout.
 *
 * FLOORS, and the honest branch. With a resolved loadout the panel must draw class chips and
 * find SOME level with an unlock (stepping up to 10 always crosses one — every class in the game
 * gains skills at 1 and again by 10). With no loadout inferred yet it must say so in words
 * instead of drawing empty lists, which is the same claim from the other side.
 *
 * It moved here beside 6a (JOS-391) when the spec crossed its line budget again; the spec still
 * owns the order and the launch, and this pair is one question about one panel.
 */
export async function stepNewAtLevel(page: Page, log: FixtureLog): Promise<void> {
  const mounted = await page.waitForSelector(NEW_AT_LEVEL, { timeout: 20_000 }).then(
    () => true,
    () => false
  )
  if (!check('the "New at this level" panel is mounted on the Leveling tab', mounted)) return
  const label = await textOf(page, LEVEL_VALUE)
  check('…with a level stepper that states the level it is showing', /Level \d+/.test(label), label)

  // The loadout comes from a `/who`, and a fixture cut for the CHART carries one from five days
  // before its last event. So the harness types `/who` — the append driver plays the row live and
  // the combo module folds it like any other evidence. This is the difference between asserting
  // the unlock join and noting that it could not be asserted.
  playWho(log)
  await settleGone(page, UNKNOWN_COMBO, { timeoutMs: 15_000 })
  if ((await countOf(page, UNKNOWN_COMBO)) > 0) {
    note('the combo module resolved no classes even after a live /who — the panel states that instead of drawing empty lists, which is the honest surface')
    return
  }
  check('…and chips naming the loadout it computed against', (await countOf(page, COMBO_CHIP)) > 0)

  // Walk up to level 10 and take the best reading: SOME level in 1..10 unlocks something for
  // every class in the game, so a walk that finds nothing means the join is broken — not that
  // this character is unusual. The exact level and count are deliberately not asserted.
  let rows = await countOf(page, UNLOCK_ROW)
  for (let i = 0; i < 10 && rows === 0; i++) {
    await stepUp(page)
    rows = await countOf(page, UNLOCK_ROW)
  }
  check('…and at least one unlock row across the first ten levels', rows > 0, `${String(rows)} rows at ${await textOf(page, LEVEL_VALUE)}`)
  await stepUnlockRowWorth(page)
}

/**
 * THE CAMERA (the con-card precedent, JOS-339's on this tab). A PNG of the panel with the new row
 * lines on it, into the run's artifacts, because "does this read well" is an owner's question and
 * a check name cannot answer it.
 *
 * IT HAS TO SHOW THE WINDOW FIRST: `EQ_E2E=1` skips every `show`, and a hidden BrowserWindow
 * produces no frames, so a screenshot of one never resolves (which is exactly what the harness's
 * best-effort 3 s page shot hits). This asks MAIN to show the main window for the moment it takes
 * to capture and puts it straight back. Best-effort throughout and reported through `note`, never
 * a check — a machine with no display owes this spec nothing.
 *
 * AND IT RUNS LAST IN THE SPEC, which was MEASURED rather than assumed: called in place after
 * step 6a it broke three later layout checks outright — showing and re-hiding the window moves
 * the scroll position and stalls compositing, and `stepPageScroll` and `stepNarrowLayout` are
 * assertions about exactly those. A camera earns no right to disturb the thing it photographs.
 */
export async function shootUnlockPanel(app: ElectronApplication, page: Page): Promise<void> {
  const setShown = (show: boolean): Promise<void> =>
    app.evaluate(({ BrowserWindow }, on) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('kind='))
      if (on) w?.showInactive()
      else w?.hide()
    }, show)
  try {
    mkdirSync(ARTIFACTS, { recursive: true })
    await setShown(true)
    await page.locator(NEW_AT_LEVEL).first().scrollIntoViewIfNeeded({ timeout: 5_000 })
    await shoot(page, 'new-at-level.png')
    // …AND THE SAME PANEL SEARCHING (JOS-392). Two PNGs of one panel because it has two states now,
    // and "does this read well" is an owner's question about BOTH. The query is the owner's own.
    // It runs here rather than inside the search step for the reason stated above: the camera moves
    // the scroll position and stalls compositing, and this is after everything that measures.
    await page.fill(SEARCH, '27-28 cleric shaman')
    await settleCount(page, RESULTS, 1, { timeoutMs: 8_000 })
    await shoot(page, 'new-at-level-search.png')
    await page.fill(SEARCH, '')
  } catch (err: unknown) {
    note(`new-at-level panel screenshot unavailable — ${String(err)}`)
  } finally {
    await setShown(false).catch(() => undefined)
  }
}

/** One PNG of the panel into the run's artifacts, reported through `note`. */
async function shoot(page: Page, file: string): Promise<void> {
  const path = join(ARTIFACTS, file)
  await page.locator(NEW_AT_LEVEL).first().screenshot({ path, timeout: 20_000 })
  note(`new-at-level panel screenshot: ${path}`)
}

/**
 * 6a. The row's four statements. Runs straight after the walk above, which has already resolved
 * the loadout and found a level with rows on it.
 */
async function stepUnlockRowWorth(page: Page): Promise<void> {
  const said = await countOf(page, DIRECTIONAL)
  check('the panel says `directional` exactly once, and never per row', said === 1, `${String(said)} instances`)

  let figures = await countOf(page, FIGURES)
  let replaces = await countOf(page, REPLACES)
  for (let i = 0; i < WALK_LEVELS && (figures === 0 || replaces === 0); i++) {
    await stepUp(page)
    figures = await countOf(page, FIGURES)
    replaces = await countOf(page, REPLACES)
  }
  const at = await textOf(page, LEVEL_VALUE)
  if (figures === 0 && (await countOf(page, UNLOCK_ROW)) === 0) {
    note('this loadout gains no spells in the walked band - a skills-only trio has no figures to draw')
    return
  }
  check('…a spell row states what the spell is worth', figures > 0, `${String(figures)} row(s) with figures at ${at}`)
  check('…and at least one row names the spell it replaces', replaces > 0, `${String(replaces)} row(s) at ${at}`)
  await checkFigures(page)
  const replacesText = await textOf(page, REPLACES)
  check(
    '…and `replaces` names a spell and the class whose line it sits in',
    /^replaces .+ \([A-Z]{3}\)/.test(replacesText),
    replacesText
  )
  await checkOwned(page, at)
  await checkReplacedCard(page)
}

/**
 * 6c. THE REPLACED NAME IS A THING YOU CAN LOOK AT (JOS-392, owner addition).
 *
 * The whole point of `replaces Greater Healing (CLR)` is a comparison, and a comparison needs the
 * other spell's numbers. So the NAME in that sentence opens its own card — and the card carries the
 * figures now, which is the half no unit test can see: `SpellDetail.metrics` is computed in main,
 * crosses the `spells:detail` IPC and is drawn by a component that had nowhere to get them from
 * before. Asserted on the card's `data-spell`, so it is the RIGHT spell's card and not the row's.
 *
 * The card is closed and WAITED FOR afterwards, for `stepSpellCard`'s measured reason: a MUI popper
 * is portalled to `document.body`, and one left open grows the document's scrollHeight and fails
 * `stepPageScroll`'s never-scrolls claim two steps later.
 */
async function checkReplacedCard(page: Page): Promise<void> {
  if ((await countOf(page, NOTE_SPELL)) === 0) {
    note('no row on this level names a spell it replaces, so there is no name inside a note to hover')
    return
  }
  const name = await page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', NOTE_SPELL)
  if (!check('the replaced spell name is reachable to hover', await hoverAt(page, NOTE_SPELL, 0.5, 0.5))) return
  const cards = await settleCount(page, SPELL_CARD, 1, { timeoutMs: 8_000 })
  const opened = await page.evaluate((s) => document.querySelector(s)?.getAttribute('data-spell') ?? '', SPELL_CARD)
  check('…and hovering it opens THAT spell’s card, not this row’s', cards > 0 && opened === name, `hovered "${name}", card says "${opened}"`)
  // The figures the owner asked the card to carry. A spell with no hitpoint line legitimately has
  // none (most of the catalog), so an absence is a note and a PRESENCE is asserted for its grammar.
  const figures = await page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', CARD_FIGURES)
  if (figures === '') note(`the card for "${name}" states no figures - its page prints no hitpoint line`)
  else {
    check('…and the card states what that spell is worth, in the row’s own words', /(dmg|heal) \d+/.test(figures), figures)
    check('…with no em dash in it', !/[—–]/.test(figures), figures)
  }
  await page.mouse.move(2, 2)
  await settleGone(page, SPELL_CARD, { timeoutMs: 5_000 })
}

/** Every result row's class chips, as `CLR 27` strings, one array per row. */
function rowChips(page: Page): Promise<string[][]> {
  return page.evaluate(
    ([rowSel, chipSel]) =>
      Array.from(document.querySelectorAll(rowSel)).map((r) =>
        Array.from(r.querySelectorAll(chipSel)).map((c) => (c as HTMLElement).innerText.trim())
      ),
    [UNLOCK_ROW, CLASS_CHIP]
  )
}

/** Type a query and wait for the panel body to be the results (or for them to go away). */
async function typeQuery(page: Page, query: string): Promise<number> {
  await page.fill(SEARCH, query)
  return query === ''
    ? settleGone(page, RESULTS, { timeoutMs: 8_000 }).then(() => 0)
    : settleCount(page, RESULTS, 1, { timeoutMs: 8_000 })
}

/**
 * 6d. THE SEARCH (JOS-392) — the owner's own query, typed into the real panel.
 *
 * WHAT THIS PROVES THAT tests/unlockSearch.test.mts CANNOT: that the dataset the renderer already
 * holds carries the search surface across the IPC, that the box swaps the panel's BODY rather than
 * a list inside it, that a result row draws its class chips WITH the level each class gets the
 * spell at, and that clearing the box gives the level view back exactly as it was.
 *
 * GRAMMAR AND IDENTITIES, never today's rows: the chips are asserted to be CLR or SHM at 27 or 28
 * because that is what the query MEANS, and the permutation is asserted to return the same names
 * because order-free is the claim. The count is a floor.
 */
export async function stepUnlockSearch(page: Page): Promise<void> {
  if (!check('the "New at this level" panel carries a search box', (await countOf(page, SEARCH)) === 1)) return
  const levelBefore = await textOf(page, LEVEL_VALUE)
  const rowsBefore = await countOf(page, UNLOCK_ROW)

  const results = await typeQuery(page, '27-28 cleric shaman')
  if (!check('typing a query turns the panel into the matching spells', results === 1)) return
  const dimmed = await page.evaluate((s) => document.querySelector(s)?.getAttribute('data-dimmed') ?? '', STEPPER)
  check('…and the level stepper greys out, because no level on screen governs these rows', dimmed === 'true', dimmed)

  const chips = await rowChips(page)
  check('…with real result rows', chips.length > 0, `${String(chips.length)} rows`)
  const wanted = /^(CLR|SHM) (27|28)$/
  const offenders = chips.filter((row) => !row.some((c) => wanted.test(c)))
  check(
    '…and every row is a cleric or shaman row at 27 or 28, stated ON the chip',
    chips.length > 0 && offenders.length === 0,
    offenders.length ? `${String(offenders.length)} rows without a CLR/SHM 27-28 chip: ${offenders[0].join(' ')}` : chips[0]?.join(' ')
  )

  // ORDER-FREE, on screen: the same words in a different order are the same answer.
  const names = await page.evaluate((s) => Array.from(document.querySelectorAll(s)).map((e) => (e as HTMLElement).innerText), UNLOCK_ROW)
  await typeQuery(page, 'shaman 27-28 cleric')
  const flipped = await page.evaluate((s) => Array.from(document.querySelectorAll(s)).map((e) => (e as HTMLElement).innerText), UNLOCK_ROW)
  check('…and the same words in any order are the same answer', flipped.join('|') === names.join('|'), `${String(names.length)} vs ${String(flipped.length)} rows`)

  // CLEARING GIVES THE LEVEL VIEW BACK — the same level, the same rows, the stepper live again.
  await typeQuery(page, '')
  const back = await settleCount(page, UNLOCK_ROW, rowsBefore, { timeoutMs: 8_000 })
  check('clearing the box restores the level view exactly', (await countOf(page, RESULTS)) === 0 && back === rowsBefore, `${String(back)} rows vs ${String(rowsBefore)} before`)
  check('…on the level it was left on', (await textOf(page, LEVEL_VALUE)) === levelBefore, `${levelBefore} → ${await textOf(page, LEVEL_VALUE)}`)
  const live = await page.evaluate((s) => document.querySelector(s)?.getAttribute('data-dimmed') ?? '', STEPPER)
  check('…and the stepper is live again', live === 'false', live)
}

/**
 * 6e. THE ERA VERDICT ON A SPELL (JOS-393) — the owner's own report, typed into the real panel.
 *
 * WHY THE SEARCH AND NOT THE LEVEL LIST. The fold is asserted over the committed data by
 * `tests/spellEra.test.mts` at every level of a CLR/DRU/SHM trio; what no unit test can see is the
 * seam — that main joins the era sidecar onto the catalog at load, ships the flag across the
 * `spells:catalog` IPC on the unlock dataset, and that the panel draws it. The level list cannot
 * carry that assertion here because the loadout comes from whatever `/who` this machine's real log
 * produced, and a shaman is not guaranteed; the SEARCH answers whether or not a loadout is known,
 * which makes this the one deterministic route to the same flag.
 *
 * TWO SPELLS, ONE LINE APART, and that is the whole point of the pair: `Sloths Healing` and
 * `Snails Healing` are the same shaman heal-over-time ladder and differ only in era. A chip on both
 * would mean the join is marking everything; a chip on neither would mean it is marking nothing.
 */
export async function stepUnlockEra(page: Page): Promise<void> {
  if ((await typeQuery(page, 'sloths healing')) !== 1) {
    check('a search for an out-of-era spell returns the results body', false)
    return
  }
  const named = await page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', SPELL_NAME)
  check('the search finds a spell the wiki badges out of era rather than hiding it', named === 'Sloths Healing', named)
  check('…and the row says so', (await countOf(page, ERA_CHIP)) === 1, `${String(await countOf(page, ERA_CHIP))} chips`)

  // The card behind the same name carries the same verdict — the surface that has no row to chip.
  if (check('the badged spell name is reachable to hover', await hoverAt(page, SPELL_NAME, 0.5, 0.5))) {
    await settleCount(page, SPELL_CARD, 1, { timeoutMs: 8_000 })
    check('…and its card wears the same words', (await countOf(page, CARD_ERA)) === 1)
    // Closed and WAITED FOR: a MUI popper left open grows the document and fails `stepPageScroll`.
    await page.mouse.move(2, 2)
    await settleGone(page, SPELL_CARD, { timeoutMs: 5_000 })
  }

  await typeQuery(page, 'snails healing')
  const inEra = await page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', SPELL_NAME)
  check('its in-era sibling is found the same way', inEra === 'Snails Healing', inEra)
  check('…and wears nothing at all, because the wiki says nothing about it', (await countOf(page, ERA_CHIP)) === 0)
  await typeQuery(page, '')
}
