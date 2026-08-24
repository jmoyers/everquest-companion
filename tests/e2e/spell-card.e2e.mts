/**
 * Headless Electron spec for JOS-293 — HOVER A SPELL'S NAME AND THE APP TELLS YOU WHETHER IT IS
 * WORTH MEMORIZING.
 *
 * WHAT THE OWNER ASKED FOR: the spell tooltip was "quite bad" — a name and nothing behind it —
 * while `spells.json` has held the whole record since the JOS-251 scrape. The card is the fix, and
 * this spec is the claim that it reaches a real surface, over the real IPC, with the real committed
 * DB behind it: the suggested-alerts wizard, where a user is choosing which spells to care about.
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST. `tests/spellDetailFacts.test.mts` owns the fact
 * SELECTION facet by facet, over the same committed DB, and it can see none of this:
 *
 *   1. A REAL POINTER on a real row OPENS the card. The anchor, MUI's popper, the fetch-on-open
 *      body and the `spells:detail` handler are four separate parts, and only a running app has
 *      all four. A card that never opens passes every unit test ever written for it.
 *   2. THE NUMBERS ON SCREEN ARE THE COMMITTED DB'S. The values below are quoted out of
 *      `src/main/data/spells.json` — `Celestial Remedy`: 75 mana, 4.00s cast, `24 Sec`, one
 *      effect line — so this is an exact reading, not a "something rendered" smoke test.
 *   3. AN ABSENT FIELD IS ABSENT ON SCREEN (world-model law 1). The same card, drawn for two
 *      spells, must show the instrument row for the bard song whose page states one and NO row at
 *      all for the cleric heal whose page does not. Proving that needs two draws of one component,
 *      which is a thing only the running list can give.
 *
 * Run: `npm run test:e2e -- spell-card`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  dumpArtifacts,
  failures,
  hoverAt,
  note,
  reportRun,
  settle,
  settleGone
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'

const SUGGEST = '[data-testid="suggest-dialog"]'
const SEARCH = '[data-testid="suggest-search"] input'
const ROW = '[data-testid="suggest-row"]'
const NAME = '[data-testid="suggest-row-name"]'
const CARD = '[data-testid="spell-hover-card"]'

/**
 * THE TWO SPELLS, and they are a PAIR rather than two examples.
 *
 * Both are quoted verbatim from the committed `src/main/data/spells.json`, and each states exactly
 * what the other does not: the cleric heal has mana and a duration and NO bard instrument row; the
 * bard song states `mana = 0` (a stated zero, which must still draw its row) and DOES carry the
 * "Enhanced by instrument?" row. One card component, two records, opposite absences.
 */
const HEAL = {
  name: 'Celestial Remedy',
  // `recast` joined the block in JOS-444, from the same page and by the same rule as every row
  // beside it: schema 3 states `recast_time = 1.50 sec`, so the card states 1.5s.
  stats: { type: 'Beneficial', cast: '4.0s', recast: '1.5s', mana: '75', duration: '24 Sec' },
  effect: 'Increase Hitpoints by 35 per tick',
  classes: 'CLR 19'
}
const SONG = {
  name: 'Anthem De Arms',
  stats: { mana: '0' },
  instrument: true
}

/** Everything the open card is currently saying, as plain values a check can read. */
interface CardRead {
  present: boolean
  spell: string
  stats: Record<string, string>
  effects: string[]
  classes: string
  lineage: string
  members: string[]
  /** The figures line (JOS-391), or '' when the card states none. */
  figures: string
}

/**
 * Read the open card. NO NAMED FUNCTION BINDINGS inside `page.evaluate` (repo law — tsx/esbuild's
 * `keepNames` wraps `const f = …` in a `__name` helper that lives in the NODE bundle and the page
 * dies on `ReferenceError: __name is not defined`).
 */
function readCard(page: Page): Promise<CardRead> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) {
      return { present: false, spell: '', stats: {}, effects: [], classes: '', lineage: '', members: [], figures: '' }
    }
    const stats: Record<string, string> = {}
    for (const r of Array.from(el.querySelectorAll('[data-testid="spell-card-stat"]'))) {
      const id = r.getAttribute('data-stat') ?? '?'
      // "Mana: 75" → "75"; the label is drawn as its own span inside the row.
      stats[id] = (r.textContent ?? '').replace(/^[^:]*:\s*/, '').trim()
    }
    return {
      present: true,
      spell: el.getAttribute('data-spell') ?? '',
      stats,
      effects: Array.from(el.querySelectorAll('[data-testid="spell-card-effect"]')).map((n) =>
        (n.textContent ?? '').trim()
      ),
      classes: (el.querySelector('[data-testid="spell-card-classes-levels"]')?.textContent ?? '').trim(),
      lineage: (el.querySelector('[data-testid="spell-card-lineage"]')?.textContent ?? '').trim(),
      members: Array.from(el.querySelectorAll('[data-testid="spell-card-rank-member"]')).map((n) =>
        (n.textContent ?? '').trim()
      ),
      figures: (el.querySelector('[data-testid="spell-card-figures"]')?.textContent ?? '').trim()
    }
  }, CARD)
}

/** Narrow the picker to one spell, point at its name, and wait for the card to have LOADED. */
async function openCardFor(page: Page, spell: string): Promise<CardRead> {
  await page.fill(SEARCH, spell)
  await settle(
    () =>
      page.evaluate(
        (s) => (document.querySelector(s.n)?.textContent ?? '').trim(),
        { n: NAME }
      ),
    (t) => t === spell,
    { timeoutMs: 15_000 }
  )
  const pointed = await hoverAt(page, NAME, 0.4, 0.5)
  if (!pointed) {
    return { present: false, spell: '', stats: {}, effects: [], classes: '', lineage: '', members: [], figures: '' }
  }
  // The popper opens behind an enterDelay and the body then fetches over IPC, so "the card is in
  // the DOM" is not the condition — "the card has an answer in it" is (wave E3: wait for the
  // condition, never for the clock).
  return settle(() => readCard(page), (c) => c.present && Object.keys(c.stats).length > 0, {
    timeoutMs: 20_000
  })
}

/** Move the pointer off the row so the next hover starts from closed. */
async function closeCard(page: Page): Promise<void> {
  await page.mouse.move(4, 4)
  await settleGone(page, CARD, { timeoutMs: 10_000 })
}

/** The heal: every number on the card is the committed DB's, and the absent row is absent. */
async function checkTheHeal(page: Page): Promise<void> {
  const card = await openCardFor(page, HEAL.name)
  if (!check(`pointing at ${HEAL.name} opens its card`, card.present, JSON.stringify(card))) return
  check(
    'the card is about the spell the pointer is on',
    card.spell === HEAL.name,
    `card says ${card.spell || '(nothing)'}`
  )
  for (const [id, want] of Object.entries(HEAL.stats)) {
    check(
      `…and its ${id} is the committed DB's own value`,
      card.stats[id] === want,
      `${id}: ${card.stats[id] ?? '(no row)'} · spells.json says ${want}`
    )
  }
  check(
    'the effect list is the wiki’s numbered line, verbatim',
    card.effects.length === 1 && card.effects[0] === HEAL.effect,
    card.effects.join(' | ') || '(none)'
  )
  check(
    'the class level is the LINE’s, as the DB states it',
    card.classes === HEAL.classes,
    card.classes || '(none)'
  )
  // THE ABSENCE, which is half the ticket: this page states no bard instrument row, so the card
  // draws none — not an empty one, not a dash.
  check(
    'a field the wiki page omits draws NO row at all',
    card.stats.instrument === undefined,
    `instrument row: ${card.stats.instrument ?? '(absent, correct)'}`
  )
  await closeCard(page)
}

/**
 * JOS-451 — THE FIGURES ON THE CARD READ THE CLIENT'S CURVE, in a running app, over the real IPC.
 *
 * `Celestial Remedy` is already the heal this spec draws, and it is one of the four spells whose
 * wiki page transcribed the BASE of a level curve and dropped the curve: the page says
 * `Increase Hitpoints by 35 per tick` and the client's row says base 35, one more a level, capped
 * at 65 — so at the cleric's own 19 it is 54 a tick over four ticks, 216 rather than 140.
 *
 * WHAT ONLY A RUNNING APP CAN SHOW, and the reason this is not left to the unit pins: the client
 * table is parsed on a WORKER, cached to `<userData>/spell-resist-cache.json` under a version this
 * ticket bumped, and reaches the `spells:detail` handler through an await that JOS-449 had to
 * repair. Every one of those is between the parse and the number, and none of them is visible to a
 * test that calls `buildSpellDetail` directly.
 *
 * AND IT DEGRADES HONESTLY. `spells_us.txt` is Daybreak's file and this repo may carry neither it
 * nor a derivative, so the harness LINKS the real install's copy in (`{ spells: true }`, the
 * JOS-382 carve-out). A machine with no EverQuest install gets no link, and the step says so and
 * asserts the wiki-only number instead — which is the same supported state the mob-resists spec
 * has always branched on.
 */
async function checkTheClientCurve(page: Page, staged: boolean): Promise<void> {
  const card = await openCardFor(page, HEAL.name)
  if (!check(`pointing at ${HEAL.name} opens its card again`, card.present)) return
  if (!staged) {
    note('no client spells_us.txt on this machine - asserting the wiki-only reading instead')
    check(
      'with no client file the card states the page’s own flat number',
      card.figures.includes('heal 140'),
      card.figures || '(no figures line)'
    )
  } else {
    check(
      'THE TICKET: the card reads the client’s curve, not the base the page transcribed',
      card.figures.includes('heal 216'),
      `${card.figures || '(no figures line)'} · the page alone would say heal 140`
    )
  }
  // The EFFECT LIST is untouched either way: it is what the wiki says, and this ticket changed
  // which number the figures are computed from, never what the page is quoted as saying.
  check(
    'and the quoted effect line is still the wiki’s, verbatim',
    card.effects.length === 1 && card.effects[0] === HEAL.effect,
    card.effects.join(' | ') || '(none)'
  )
  await closeCard(page)
}

/** The song: the same card, the same component, the opposite absence — and a STATED zero. */
async function checkTheSong(page: Page): Promise<void> {
  const card = await openCardFor(page, SONG.name)
  if (!check(`pointing at ${SONG.name} opens its card`, card.present, JSON.stringify(card))) return
  check(
    'a bard page’s instrument row IS drawn, by the same card that omitted it for the heal',
    typeof card.stats.instrument === 'string' && card.stats.instrument.length > 0,
    card.stats.instrument ?? '(no row)'
  )
  check(
    'a STATED zero is a fact and keeps its row (a song costs 0 mana)',
    card.stats.mana === SONG.stats.mana,
    `mana: ${card.stats.mana ?? '(no row)'}`
  )
  await closeCard(page)
}

/**
 * THE RANK STATEMENT, as the picker shows it — the plain rank and NOTHING more.
 *
 * OWNER RULING 2026-08-13: ranks (the upgrade mechanic) are orthogonal to spell LINES, and the
 * card must not conflate them — so the member list and the "replaces" phrase came off the card
 * (the derivation survives in shared/spellDetail.ts for any future power-user surface). What the
 * card states is the bare rank of the name it was asked about.
 */
async function checkTheLineRanks(page: Page): Promise<void> {
  const card = await openCardFor(page, 'Rune III')
  if (!check('pointing at the Rune line opens its card', card.present, JSON.stringify(card))) return
  check(
    'the card lists NO rank members (owner ruling: ranks are not lines)',
    card.members.length === 0,
    card.members.join(' | ') || '(none)'
  )
  check(
    '…and states the bare rank with no replaces phrase',
    card.lineage === 'Rank I',
    card.lineage || '(no lineage line)'
  )
  await closeCard(page)
}

/**
 * THE SECOND HOST, AND THE ONE THE LINEAGE HALF OF JOS-293 IS ABOUT — the Buffs tab.
 *
 * A live buff row anchors the card on the RANK a cast line spelled (`ActiveBuff.castName`), which
 * is the only place in the app a suffixed name reaches the card. So this is the end-to-end reading
 * of the whole DATA-FIRST answer, in one card:
 *
 *   * `Clarity III` is a rank the committed DB has NO row for (it carries `Clarity` and
 *     `Clarity II` and stops), so the numbers on the card are the LINE's and the card says so;
 *   * `Clarity II` is a rank the DB DOES name, so "replaces" can be stated at all;
 *   * `Clarity III` itself is named by nobody but the log the app just watched, so it is listed
 *     with the tag that says which source states it.
 *
 * The cast + landing are the real sentences: `Clarity`'s own `msgCastOnYou` out of spells.json,
 * and a cast anchor one second ahead of it — which is also the ambiguity path (six spells share
 * that landing line; the anchor is what resolves it), so a green here is a green for the JOS-238
 * machinery this leans on.
 */
async function checkTheBuffRowCard(page: Page, log: FixtureLog): Promise<void> {
  const at = new Date()
  log.appendAt(at, 'You begin casting Clarity III.')
  log.appendAt(new Date(at.getTime() + 1_000), 'A cool breeze slips through your mind.')

  await page.click('[data-testid="nav-buffs"]', { timeout: 60_000 })
  const name = await settle(
    () =>
      page.evaluate(
        (s) => (document.querySelector(s)?.textContent ?? '').trim(),
        '[data-testid="active-buff-name"]'
      ),
    (t) => t === 'Clarity',
    { timeoutMs: 45_000 }
  )
  if (!check('the Clarity cast opened a live buff row', name === 'Clarity', `row reads ${name || '(none)'}`)) {
    return
  }
  const pointed = await hoverAt(page, '[data-testid="active-buff-name"]', 0.4, 0.5)
  if (!check('the buff row’s name is pointable', pointed)) return
  const card = await settle(() => readCard(page), (c) => c.present && c.lineage !== '', { timeoutMs: 20_000 })
  check(
    'the card is asked about the RANK the cast line spelled, not the identity the row prints',
    card.spell === 'Clarity III',
    `card says ${card.spell || '(nothing)'}`
  )
  check(
    'the card states the bare rank the cast line spelled - no replaces phrase (owner ruling)',
    card.lineage === 'Rank III',
    card.lineage || '(no lineage line)'
  )
  check(
    '…and lists no rank members (ranks are not lines)',
    card.members.length === 0,
    card.members.join(' | ') || '(none)'
  )
  const note = await page.evaluate(
    (s) => (document.querySelector(s)?.textContent ?? '').trim(),
    '[data-testid="spell-card-line-note"]'
  )
  check(
    'and the card says out loud that these numbers are the LINE’s, not rank III’s',
    note.includes('Clarity') && note.includes('line'),
    note || '(no note)'
  )
  await closeCard(page)
}

/** Open the Alerts tab, then the suggestion picker, and wait for its rows to arrive over IPC. */
async function openPicker(page: Page): Promise<number> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="alerts-add-suggestion"]', { timeout: 30_000 })
  await page.click('[data-testid="alerts-add-suggestion"]')
  await page.waitForSelector(SUGGEST, { timeout: 20_000 })
  return settle(() => page.evaluate((s) => document.querySelectorAll(s).length, ROW), (n) => n > 0, {
    timeoutMs: 20_000
  })
}

async function main(): Promise<void> {
  buildIfStale()

  // `{ spells: true }` links the real install's `spells_us.txt` in (JOS-451, the JOS-382
  // carve-out). It is what `checkTheClientCurve` needs, and it changes nothing for the other
  // steps: every value they assert is the committed catalog's.
  const log = stageFixture('e2e-voice.log', { spells: true })
  const staged = existsSync(join(log.installDir, 'spells_us.txt'))
  const userData = makeUserData()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-voice.log…')
  const { app, close } = await launchOnFixture(log, { userData })
  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    const rows = await openPicker(page)
    if (check('the suggestion picker is showing spell rows', rows > 0, `${String(rows)} rows`)) {
      await checkTheHeal(page)
      await checkTheClientCurve(page, staged)
      await checkTheSong(page)
      await checkTheLineRanks(page)
    }
    await page.keyboard.press('Escape')
    await checkTheBuffRowCard(page, log)
    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'spell-card-FAIL')
  } finally {
    await close()
  }

  await removeUserData(userData)
  await log.dispose()
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
