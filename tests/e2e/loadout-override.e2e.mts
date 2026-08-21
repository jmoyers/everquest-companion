/**
 * THE MANUAL LOADOUT OVERRIDE, DRIVEN THROUGH THE REAL APP (JOS-87).
 *
 * The report: a user who plays SHD/ROG/DRU had the app deciding SHD/NEC, and said there was no
 * way to correct it. A correction surface was already shipping at the time — reachable only by
 * finding the right row in a history list and pressing Edit — which is why the two things this
 * spec measures are the two things a unit test structurally cannot see:
 *
 *   1. THE CONTROL IS REACHABLE. Preferences → Profiles mounts a control that states what is in
 *      effect and offers to change it, without the user first having to understand that the app
 *      models their loadout as a sequence of time intervals. `tests/comboOverride.test.mts`
 *      pins what the override MEANS; only a launched app can say whether anyone can find it.
 *   2. IT SURVIVES A RESTART. This is the ticket's acceptance criterion and it spans two
 *      processes, so it is asserted the way telemetry's restart is: ONE `userData` dir and ONE
 *      staged log, handed to two launches. The unit suite proves a fresh module rebuilds the
 *      override from the store's provider; this proves the store really wrote it, from a click.
 *
 * The round trip is closed at the end — "Back to autodetect" must actually give the loadout back
 * to detection, or the override is a trap rather than a correction.
 *
 * WHY THE PICK IS SHD/ROG/DRU: it is the reporter's own loadout, and this fixture's evidence
 * cannot produce it — so every assertion below fails if the write silently did nothing and the
 * panel is merely showing what it always showed.
 *
 * Run: `npm run test:e2e -- loadout-override`
 */
import type { Page } from 'playwright-core'
import { buildIfStale, check, countOf, dumpArtifacts, failures, note, reportRun, settle } from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'

const CONTROL = '[data-testid="loadout-override"]'
const SOURCE = '[data-testid="loadout-override-source"]'
const OPEN = '[data-testid="loadout-override-open"]'
const SAVE = '[data-testid="loadout-override-save"]'
const CLEAR = '[data-testid="loadout-override-clear"]'

/** The reporter's loadout. Nothing in this fixture's evidence can name it. */
const MINE = ['SHD', 'ROG', 'DRU'] as const

/** Open Preferences → Profiles and wait for the loadout control to mount. */
async function openLoadoutSetting(page: Page): Promise<void> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="prefs-rail-profiles"]', { timeout: 20_000 })
  await page.click('[data-testid="prefs-rail-profiles"]')
  await page.waitForSelector(CONTROL, { timeout: 20_000 })
}

/** The control's whole visible text — chips, source line and any notice, as a user reads it. */
function controlText(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.textContent?.trim() ?? '',
    CONTROL
  )
}

/** True once the control shows exactly the classes the user set, as their own setting. */
function showsOverride(text: string): boolean {
  return MINE.every((c) => text.includes(c)) && /Set by you/.test(text)
}

async function main(): Promise<void> {
  buildIfStale()

  // ONE dir and ONE log across both launches — the restart is the assertion, so neither may be
  // re-staged in between (a fresh store would make the second launch prove nothing).
  const userData = makeUserData()
  const log = stageFixture('e2e-overview.log')

  try {
    // ------------------------------------------------------------- launch 1: set it
    const first = await launchOnFixture(log, { userData })
    let page: Page | null = null
    try {
      page = await mainWindow(first.app)
      await page.waitForSelector('[data-testid="nav-overview"]', { timeout: 60_000 })
      await openLoadoutSetting(page)

      const before = await settle(
        () => controlText(page as Page),
        (t) => t.length > 0 && !/No loadout read yet/.test(t)
      )
      if (
        !check(
          'Preferences → Profiles states the loadout in effect and where it came from',
          /Autodetected/.test(before),
          `control=${before.slice(0, 160)}`
        )
      ) {
        // Everything below drives that control; there is nothing honest to report past here.
        await dumpArtifacts(page, 'loadout-override-FAIL')
        return
      }
      check(
        '…and offers to set the classes by hand, without opening a history row first',
        (await countOf(page, OPEN)) === 1
      )
      check(
        '…with no "back to autodetect" yet, because nothing has been overridden',
        (await countOf(page, CLEAR)) === 0
      )

      // The whole user journey, in the clicks a person makes.
      await page.click(OPEN)
      await page.waitForSelector('[data-testid="combo-class-picker"]', { timeout: 20_000 })
      // THE PICKER SPEAKS IN CLASS NAMES (JOS-402), while its testid — and everything it writes —
      // stays the /who code. Asked before the clicks because it is the words a user picks BY.
      const shdChip = await page.evaluate(
        () => document.querySelector('[data-testid="combo-class-SHD"]')?.textContent?.trim() ?? ''
      )
      check(
        'the class picker offers whole class names, not /who codes',
        shdChip === 'Shadow Knight',
        `the SHD chip reads ${shdChip}`
      )
      for (const cls of MINE) await page.click(`[data-testid="combo-class-${cls}"]`)
      const count = await page.evaluate(
        () => document.querySelector('[data-testid="loadout-override-count"]')?.textContent ?? ''
      )
      check(
        'the picker states the pick back before it is saved',
        /Shadow Knight \/ Rogue \/ Druid/.test(count) && /3 of 3/.test(count),
        `count=${count}`
      )
      await page.click(SAVE)

      const after = await settle(() => controlText(page as Page), showsOverride)
      check(
        'THE REPORTED SYMPTOM IS FIXABLE — the loadout is what the user said it is',
        showsOverride(after),
        `control=${after.slice(0, 200)}`
      )
      check(
        '…and the app says the setting is theirs, not a detection that happened to agree',
        /will not change it/.test(after),
        `control=${after.slice(0, 200)}`
      )
      check(
        '…with a way back to autodetection offered beside it',
        (await countOf(page, CLEAR)) === 1
      )
      if (failures.length) await dumpArtifacts(page, 'loadout-override-FAIL')
    } finally {
      await first.close()
    }

    // ------------------------------------------------- launch 2: it is still there, then undone
    const second = await launchOnFixture(log, { userData })
    let back: Page | null = null
    try {
      back = await mainWindow(second.app)
      await back.waitForSelector('[data-testid="nav-overview"]', { timeout: 60_000 })
      await openLoadoutSetting(back)

      const restarted = await settle(() => controlText(back as Page), showsOverride)
      check(
        'ACCEPTANCE: the override survives a restart — a second process, the same store',
        showsOverride(restarted),
        `control=${restarted.slice(0, 200)}`
      )
      note('the whole log was replayed again on this launch, and re-inference did not reclaim it')

      // Back to auto. An override you cannot undo is a trap, not a correction.
      await back.click(CLEAR)
      const cleared = await settle(
        () => controlText(back as Page),
        (t) => /Autodetected/.test(t)
      )
      check(
        '"Back to autodetect" really hands the loadout back',
        /Autodetected/.test(cleared) && !/Set by you/.test(cleared),
        `control=${cleared.slice(0, 200)}`
      )
      check(
        '…and the undo button goes with it',
        (await countOf(back, CLEAR)) === 0
      )
      check('…while the source line is still stated at all', (await countOf(back, SOURCE)) === 1)

      if (failures.length) await dumpArtifacts(back, 'loadout-override-FAIL')
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
