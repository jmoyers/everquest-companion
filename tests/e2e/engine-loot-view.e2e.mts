/**
 * THE TWO WORLDS, DRAWN SIDE BY SIDE, WITH THE DOM AS THE ORACLE (JOS-484, phase 3).
 *
 * `engine-parity.e2e.mts` proves the two FOLDS agree by comparing published module state inside
 * main. This spec asks the question one layer up, and it is the question the cutover actually turns
 * on: does the PRODUCT draw the same thing? A ledger can be built from an identical fold and still
 * differ on screen — a cell formatted in the wrong language, a stack size composed into a name, an
 * absent source rendered as the string "-" instead of as absence, an order that is not total. None
 * of those are fold defects and none of them are visible to a snapshot comparison. All of them are
 * visible here, because the assertion is the rendered table.
 *
 * WHAT IT DOES, in order:
 *
 *   1. Launches on a staged fixture with `EQC_ENGINE=1`, lands on the Loot tab.
 *   2. Turns "Group by item" OFF. That is not incidental: `loot.ledger` serves the FLAT
 *      chronological ledger — `FlatLootTable`'s four columns, newest first — so the flat table is
 *      the shape the two modes have in common. The grouped table is a different view and a
 *      different (unbuilt) source.
 *   3. Waits for the data-source toggle to EXIST. Its existence is the whole brokering claim: the
 *      renderer only draws it when `EngineClientContext` holds a live client, and a live client
 *      means this window opened a MessagePort to main, main opened a loopback socket to the engine,
 *      and a real `hello` crossed both — with main never parsing a frame in between.
 *   4. Reads every rendered row's cells in app mode, flips to engine, reads them again, and asserts
 *      the two are EQUAL cell for cell. Then flips back and asserts the app ledger returns, because
 *      a toggle that only goes one way is a toggle that has not been proven.
 *
 * WHY THE COMPARISON IS SOUND RATHER THAN VACUOUS, which is the thing to check first in a spec
 * shaped like this:
 *
 *   * It refuses to pass on an empty table. Both readings must hold at least `MIN_ROWS` rows, so
 *     "no rows either way" cannot read as agreement — the failure mode `engine-parity` guards with
 *     its `skipped: 0` check, in this spec's own terms.
 *   * The two tables are SEPARATE COMPONENTS (`FlatLootTable` and `EngineLootTable`) drawing from
 *     separate sources, so an equality here is two implementations agreeing rather than one
 *     implementation agreeing with itself. They share only the geometry — same row height, same
 *     windowing hook, same fixed layout — which is what makes "what is on screen" comparable at all.
 *   * The row COUNT is asserted equal as its own claim before the cells are compared, so a run
 *     where one mode happened to mount fewer rows says so instead of silently comparing a prefix.
 *
 * WHY THIS FIXTURE. `wl40-farm-run.log` is the committed fixture with the deepest loot ledger (250
 * loot lines over three days of play) and it exercises every cell the source serves: plain
 * `--You have looted--` rows, `and sold it for …` rows (a `sold` disposition chip), `to create a …`
 * rows (a `combined` chip AND the `→ created` caption), stack sizes, and rows with and without a
 * source. A fixture with five kept loots would compare five identical strings and prove very little.
 * The spec never appends to it, so both folds read the same finite bytes and stop.
 *
 * Run: `npm run test:e2e -- engine-loot-view`
 */
import type { Page } from 'playwright-core'
import {
  buildEngineIfStale,
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleCount,
  settleStable,
  waitHydrated
} from './appHarness.mjs'
import { closeWindows, mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
import { stepEnginePerfPanel } from './enginePerfSteps.mjs'

const FIXTURE = 'wl40-farm-run.log'

const GRID = '[data-testid="overview-grid"]'
const LOOT_LIST = '[data-testid="loot-list"]'
const LOOT_ROW = '[data-testid="loot-row"]'
const LOOT_SORT = '[data-testid="loot-sort"]'
const GROUP_SWITCH = '[data-testid="loot-group"] input'
const SOURCE = '[data-testid="loot-source"]'
const SOURCE_APP = '[data-testid="loot-source-app"]'
const SOURCE_ENGINE = '[data-testid="loot-source-engine"]'

/** Fewer than this either way and the comparison is not worth making — see the header. */
const MIN_ROWS = 8

/** How long the engine gets to spawn, fold and answer a renderer's hello. Generous: the runner puts
 *  four Electron apps and a Rust child on one machine, and the renderer's own retry is on a 4 s
 *  cadence, so this is several attempts rather than one. */
const CONNECT_BUDGET_MS = 90_000

/** One rendered ledger: every row's cells, in the order the table drew them. */
type Ledger = string[][]

/**
 * Read what is actually on screen.
 *
 * `innerText` with whitespace collapsed, because the Item cell is a flex row of several nodes (the
 * name, a PoSky chip, a knowledge badge, a disposition chip, a `→ created` caption) and the gaps
 * between them are layout rather than content. Both modes are read through this same function, so
 * whatever it normalizes it normalizes identically — the comparison is between two readings, never
 * between a reading and a literal.
 */
function readLedger(page: Page): Promise<Ledger> {
  return page.evaluate((sel) => {
    const rows: string[][] = []
    for (const row of Array.from(document.querySelectorAll(sel))) {
      const cells: string[] = []
      for (const cell of Array.from(row.querySelectorAll('td'))) {
        cells.push(((cell as HTMLElement).innerText || cell.textContent || '').replace(/\s+/g, ' ').trim())
      }
      rows.push(cells)
    }
    return rows
  }, LOOT_ROW)
}

/** The table's own column headings — the other half of "the same table". */
function readHeadings(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const table = document.querySelector(`${sel} table`)
    if (!table) return []
    return Array.from(table.querySelectorAll('th')).map((th) =>
      ((th as HTMLElement).innerText || th.textContent || '').trim()
    )
  }, LOOT_LIST)
}

/** Wait for the ledger to stop moving. A fold that is still landing changes the row set under the
 *  reader, and an engine that has just been attached re-cuts its window on the epoch bump. */
function settledLedger(page: Page): Promise<Ledger> {
  return settleStable(() => readLedger(page), { timeoutMs: 40_000, pollMs: 200, stable: 4 })
}

function appears(page: Page, sel: string, ms = 20_000): Promise<boolean> {
  return page.waitForSelector(sel, { timeout: ms }).then(
    () => true,
    () => false
  )
}

/** Land, let the replay finish, open the Loot tab, and put it on the FLAT ledger. */
async function stepFlatLedger(page: Page): Promise<boolean> {
  if (!check('the app lands on the Overview', await appears(page, GRID, 60_000))) return false
  const { snap } = await waitHydrated(page)
  if (!check('hydration completes (the replay has filled the loot ledger)', !snap.hydrating)) return false
  await page.click('[data-testid="nav-loot"]', { timeout: 15_000 })
  if (!check('the Loot tab opens on its ledger', await appears(page, LOOT_LIST))) return false
  await page.click(GROUP_SWITCH, { timeout: 15_000 })
  // The order picker belongs to the GROUPED table only ("ungrouped, the ledger is already a
  // chronological one" — LootChrome), so its disappearance is the flat ledger's own signal.
  const flat = await settle(() => countOf(page, LOOT_SORT), (n) => n === 0, { timeoutMs: 10_000 })
  return check(
    '"Group by item" off puts the tab on the FLAT chronological ledger — the shape loot.ledger serves',
    flat === 0,
    `sort controls still mounted: ${String(flat)}`
  )
}

/**
 * THE BROKERING CLAIM, asserted by the only thing that can carry it: the toggle exists.
 *
 * It is rendered on exactly one condition — the renderer holds a live `EngineClient` — and that
 * client cannot exist without the whole path: `engine:connect` → main opens a loopback socket →
 * `MessageChannelMain` → the port and the launch token to this window → the preload's byte channel
 * → NDJSON → `hello` → the engine's reply back across the same relay. Main parsed none of it.
 */
async function stepBrokered(page: Page): Promise<boolean> {
  const there = await appears(page, SOURCE, CONNECT_BUDGET_MS)
  return check(
    'this WINDOW is a client of the engine: main brokered it a port and the handshake landed',
    there,
    there ? 'the dev data-source toggle is mounted' : 'no toggle — the renderer never held a live client'
  )
}

/** Flip the source and wait for the ledger that comes back to stop moving. */
async function switchTo(page: Page, button: string): Promise<Ledger> {
  await page.click(button, { timeout: 15_000 })
  await settleCount(page, LOOT_ROW, 1, { timeoutMs: 40_000 })
  return settledLedger(page)
}

/**
 * The comparison itself, and the anti-vacuity guards around it.
 *
 * THE CLAIM IS OVER EVERY ROW THE APP LEDGER DREW, not over a shared prefix somebody picked. The
 * two modes do not mount the same NUMBER of rows and should not be expected to: both virtualize
 * over the same fixed row height, but the app-fed ledger carries the slice bar, the toolbar, the
 * caption, the notable strip and the notices above its scroll box while the served one carries a
 * toggle and a caption, so the served box is TALLER and shows more of the same list (measured 29 vs
 * 35). That is a chrome difference, not a data one — so what is asserted is that the engine's
 * window covers the app's and agrees with it row for row over the whole of it.
 */
function stepRowsAgree(app: Ledger, engine: Ledger): void {
  const deep = check(
    `both ledgers hold rows worth comparing (at least ${String(MIN_ROWS)})`,
    app.length >= MIN_ROWS && engine.length >= MIN_ROWS,
    `app ${String(app.length)} rows · engine ${String(engine.length)} rows`
  )
  check(
    'the served window covers every row the app-fed ledger drew — nothing is compared by halves',
    engine.length >= app.length,
    `app ${String(app.length)} · engine ${String(engine.length)} (the served box is taller — less chrome above it)`
  )
  if (!deep) return
  const n = Math.min(app.length, engine.length)
  let firstDiff = -1
  for (let i = 0; i < n && firstDiff < 0; i += 1) {
    if (JSON.stringify(app[i]) !== JSON.stringify(engine[i])) firstDiff = i
  }
  check(
    `every rendered loot row is IDENTICAL, cell for cell, from both worlds (${String(n)} rows × ${String(app[0]?.length ?? 0)} cells)`,
    firstDiff < 0,
    firstDiff < 0
      ? `first row: ${JSON.stringify(app[0])}`
      : `row ${String(firstDiff)} differs — app ${JSON.stringify(app[firstDiff])} vs engine ${JSON.stringify(engine[firstDiff])}`
  )
  if (firstDiff < 0) {
    // THE EVIDENCE, printed rather than merely asserted: the ticket asks for the row equality
    // verbatim, and a green tick is not a measurement anybody can read.
    note(`rows compared (${String(n)}), identical in both modes. First three, as drawn:`)
    for (const row of app.slice(0, 3)) note(`  ${JSON.stringify(row)}`)
    note(`  … last: ${JSON.stringify(app[n - 1])}`)
  }
}

async function main(): Promise<void> {
  buildIfStale()
  buildEngineIfStale()

  const launch = await launchOnFixture(FIXTURE, { env: { EQC_ENGINE: '1' } })
  try {
    const page = await mainWindow(launch.app)
    if (await stepFlatLedger(page)) {
      const appHeadings = await readHeadings(page)
      const app = await settledLedger(page)
      if (await stepBrokered(page)) {
        const engine = await switchTo(page, SOURCE_ENGINE)
        const engineHeadings = await readHeadings(page)
        check(
          'the served table draws the same four columns the app-fed one does',
          JSON.stringify(appHeadings) === JSON.stringify(engineHeadings),
          `app ${JSON.stringify(appHeadings)} · engine ${JSON.stringify(engineHeadings)}`
        )
        stepRowsAgree(app, engine)
        // BACK, because a one-way toggle is a toggle nobody proved. The app ledger has to return
        // whole — same rows, same order — from a component that was unmounted while the engine's
        // was up.
        const back = await switchTo(page, SOURCE_APP)
        check(
          'flipping back restores the app-fed ledger exactly as it was',
          JSON.stringify(back) === JSON.stringify(app),
          back.length === app.length ? 'same rows' : `app ${String(app.length)} · back ${String(back.length)}`
        )
      }
    }
    // THE PERFORMANCE PANEL'S ENGINE SECTION, ON THIS SPEC'S BACK (ruling 19 — JOS-483's rows and
    // JOS-502's budgets). It is a SECOND SUBJECT in this file and that is deliberate: the only
    // expensive thing it needs is an engine that has folded something and served a view, which is
    // exactly the state the ledger comparison above has just spent a whole scan and a subscription
    // reaching. Its own launch would double this spec's cost to re-reach a state already standing.
    //
    // It reads its host's engine, so it runs AFTER the toggle has been put back — the section must
    // report a real generation, not one mid-switch.
    await stepEnginePerfPanel(page)
    if (failures.length > 0) await dumpArtifacts(page, 'engine-loot-view')
    await closeWindows(launch.app)
  } finally {
    await launch.close()
  }

  if (failures.length === 0) {
    note('the toggle is DEV-ONLY and gated on a live connection: no engine, no control, no engine ledger')
    note('main relayed every one of those bytes without parsing a frame — src/main/dataServer/byteRelay.ts')
  }
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
