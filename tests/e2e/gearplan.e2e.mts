/**
 * THE PLAN TAB, DRIVEN THROUGH THE REAL APP — the gear plan board (view id `gearplan`).
 *
 * `tests/gear plan.test.mts` and `tests/gearPlanTotals.test.mts` pin the model and the arithmetic, and
 * `tests/gearPlanStore.test.mts` pins the store round trip. What none of them can see is an app:
 *
 *   1. THE TAB IS REACHABLE, by the gear NAV ROW and then by the TAB, which is how a user gets
 *      there — and it draws every `PLAN_SLOTS` cell rather than the handful a fold happened to fill.
 *   2. THE PLANNED TIER DRIVES THE SOCKETS. The seeded cell is at +2, so its click socket offers
 *      itself as empty while its worn and proc sockets state what would unlock them. That chain
 *      runs from the store file through `sanitizeGearPlan`, the IPC pair, `useGearPlan`,
 *      `unlockedSockets` and the card, and it is the reason the item and its exaltations are one
 *      document at all.
 *   3. THE COMPARISON REACHES THE DUMP. A real `/outputfile inventory` is staged into the install
 *      root, so `plannerInventory` → `equippedHosts` → `equippedRead` → `sumGear` → the diff runs
 *      end to end against the same twenty-four worn rows the Character tab reads.
 *   4. THE PANES ARE BOUNDED. This app's content area is already `overflow:auto`, so a pane that
 *      forgot `minHeight: 0` grows the page. Only a laid-out window can say.
 *
 * AND THE SECOND LAUNCH IS THE POINT OF THE WHOLE FILE. One `userData` dir, two processes: the
 * board seeded into the store file must come back — item, tier and socket — having crossed
 * `sanitizeGearPlan` in both directions and a process boundary in between. That is the direct
 * analogue of the claim `gearSetSteps.mts` used to make for `ProgressState.gearSets`, made again
 * here for a DIFFERENT document under a DIFFERENT key.
 *
 * Run: `npm run test:e2e -- gearplan-board`
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { buildIfStale, check, countOf, dumpArtifacts, failures, reportRun } from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/storeMigrations'
import {
  CELL,
  openPlanTab,
  stepAssignItem,
  stepBounded,
  stepClearAll,
  stepClearCell,
  stepDonorInlineEffects,
  stepDiff,
  stepCellDelta,
  stepLoadEquipped,
  stepLoadedSocketReturns,
  stepMount,
  stepPoolFilter,
  stepSeededCell,
  stepSocketHover,
  stepSocketPick,
  stepSocketsListed,
  stepTierUnlocks,
  stepUnlockLadder
} from './gearPlanSteps.mjs'

/**
 * THE SEEDED BOARD. Nothing in the product can put an item in a cell yet (the pickers are the next
 * commit), so the board arrives the way the store would have written it — which is also the only
 * way to exercise the READ path in isolation, before an edit path exists to confound it.
 *
 * `+2` is chosen: it unlocks focus and click and leaves worn and proc locked, so one cell states
 * every one of the three socket readings the card can draw.
 */
const SEEDED = { key: 'crown of narandi', name: 'Crown of Narandi', tier: 2 }

function seedStore(userData: string): void {
  const store = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    byCharacter: {
      primitive_freeport: {
        inventory: {},
        completedQuests: [],
        gearPlan: {
          updatedAt: Date.now(),
          cells: {
            HEAD: {
              key: SEEDED.key,
              name: SEEDED.name,
              state: { full: SEEDED.tier, fraction: 0 },
              sockets: {
                focus: {
                  effect: 'Extended Enhancement II',
                  donorKey: 'robe of the lost circle',
                  donorName: 'Robe of the Lost Circle'
                }
              }
            }
          }
        }
      }
    }
  }
  writeFileSync(
    join(userData, 'everquest-companion-progress.json'),
    `${JSON.stringify(store, null, 2)}\n`,
    'utf8'
  )
}

async function firstLaunch(page: Page): Promise<void> {
  await stepMount(page)
  await stepSeededCell(page, SEEDED.name, SEEDED.tier)
  await stepUnlockLadder(page)
  await stepSocketHover(page)
  await stepCellDelta(page)
  await stepSocketsListed(page)
  await stepDiff(page)
  await stepBounded(page)

  // THE EDIT PATH. It runs after every READ claim above, because it changes the document those
  // claims are about — and it ends by clearing the cell it filled, so the relaunch below is
  // asserting the SEEDED board rather than whatever this run happened to pick.
  await stepAssignItem(page, 'thelvorn')
  await stepTierUnlocks(page)
  await stepSocketPick(page)
  await stepDonorInlineEffects(page)
  await stepClearCell(page)

  // Before the load, because the load fills PRIMARY's neighbours and this step wants an empty one.
  await stepPoolFilter(page)

  // LAST, because it writes into every empty cell on the board. Running it earlier would leave the
  // steps above asserting against a board they did not describe.
  await stepLoadEquipped(page)
}

async function main(): Promise<void> {
  buildIfStale()

  // A userData dir this spec OWNS, so the same store file feeds both launches. `launchApp` only
  // deletes a dir it created, which is why the teardown below is ours to run.
  const userData = makeUserData()
  seedStore(userData)

  // ONE staged install for both launches too — the dump the comparison reads lives in it, and a
  // second stage would be a second body.
  const log = stageFixture('e2e-planner.log', { inventory: 'Primitive_freeport-Inventory.txt' })

  try {
    console.log('launch 1: hidden Electron (EQ_E2E=1) on the seeded board…')
    const first = await launchOnFixture(log, { userData })
    try {
      const page = await mainWindow(first.app)
      const consoleErrors: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text())
      })
      page.on('pageerror', (e) => consoleErrors.push(String(e)))

      await firstLaunch(page)
      check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
      if (failures.length) await dumpArtifacts(page, 'gearplan-board-FAIL')
    } finally {
      await first.close()
    }

    console.log('launch 2: the same userData, a new process — the board must come back…')
    const second = await launchOnFixture(log, { userData })
    try {
      const back = await mainWindow(second.app)
      await openPlanTab(back)
      // THE ROUND TRIP, END TO END: the document crossed `sanitizeGearPlan` on the way out of the
      // first process and again on the way into this one, and it must read identically.
      await stepSeededCell(back, SEEDED.name, SEEDED.tier)
      await stepUnlockLadder(back)
      await stepLoadedSocketReturns(back)
      check('…and the board is still the whole board on the second launch', true)
      // LAST, and only here: it destroys the document every assertion above depends on. The board
      // at this point holds the seeded HEAD plus whatever the `fill` load put down.
      await stepClearAll(back, await countOf(back, `${CELL} [data-testid="gearplan-item-name"]`))
      if (failures.length) await dumpArtifacts(back, 'gearplan-board-relaunch-FAIL')
    } finally {
      await second.close()
    }
  } finally {
    await log.dispose()
    await removeUserData(userData)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
