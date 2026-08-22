// ONE CLICK SPLITS EVERYTHING — the e2e half of JOS-322, living next door to sliceSteps.mts
// because the rule here is to SPLIT a step module rather than ratchet one (drill.mts set the
// precedent; dropSteps.mts, combatSteps.mts and plannerSteps.mts followed it).
//
// THE CLAIM THIS STEP EXISTS FOR, and no unit test can reach it: the owner's third law is that
// "New session" is ONE concept with ONE button, and after this ticket that one press has to move
// TWO surfaces in TWO different subsystems — the loot ledger's session picker (a renderer-side
// pick over `shared/sessionSegments`) and the DPS meter's Overall picker (the combat ENGINE's own
// frozen zone records, in main). tests/sessionMarks.test.mts pins that main stamps one instant and
// hands it to both; tests/combatSessionMark.test.mts pins what the engine does with it. Neither can
// see that the real app, wired end to end through real IPC, grows a row in both pickers from one
// click on one button.
//
// IT PRESSES THE LEDGER'S BUTTON, deliberately, and asserts the METER moved. The overlay's own
// title-bar button is the same call on the same bridge member (`tests/sessionMarks.test.mts` pins
// the identity), and launching a floating window to press it would prove the bridge twice and the
// SEAM not at all.
//
// IT SCRIPTS ITS OWN DAMAGE FIRST, which is not decoration: by the time this runs the ledger step
// has already pressed once, so the engine's live stay is empty — and an empty stay mints nothing
// (the drop rule that makes a double-click harmless). A hit through the real tailed file is what
// gives the click something to close.

import type { Page } from 'playwright-core'
import { check, closePicker, countOf, note, openPicker, settle, snapshot } from './appHarness.mjs'
import { clickScope } from './combatSteps.mjs'
import type { FixtureLog } from './logFixture.mjs'

const NEW_SESSION = '[data-testid="loot-slice-new-session"]'
const SESSION_LIST = '[data-testid="loot-slice-session-list"]'
const SESSION_OPT = '[data-testid^="loot-slice-session-opt-"]'
const SESSION_BUTTON = `${SESSION_LIST} [role="combobox"]`

/** The mob this step invents. Distinctive enough that a stray match in the fixture is not possible. */
const SCRIPTED_MOB = 'a session-split test dummy'

/** One picker row, id AND the words the user reads — the label is what carries the vocabulary
 *  ruling (a mark-closed stay is that zone's `session`, not its `overall`). */
interface PickerRow {
  value: string
  label: string
}

function pickerRows(page: Page): Promise<PickerRow[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('li[data-value]')].map((el) => ({
      value: el.getAttribute('data-value') ?? '',
      label: (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    }))
  )
}

/** The Overall scope's rows: the live stay first, then the finalized ones. Leaves the picker shut. */
async function overallRows(page: Page): Promise<PickerRow[]> {
  await page.click('[data-testid="nav-combat"]', { timeout: 15_000 })
  // The scope toggle is a stored preference, so this is usually a no-op re-press; asserting it
  // would make the step fail on a state it does not care about.
  await clickScope(page, 2)
  await openPicker(page)
  const rows = await pickerRows(page)
  await closePicker(page)
  return rows.filter((r) => r.value !== '')
}

/** How many segments the ledger's session picker is offering (0 when it is not drawn at all). */
async function lootSegments(page: Page): Promise<number> {
  await page.click('[data-testid="nav-loot"]', { timeout: 15_000 })
  if ((await countOf(page, SESSION_LIST)) === 0) return 0
  await page.click(SESSION_BUTTON, { timeout: 10_000 })
  const n = await countOf(page, SESSION_OPT)
  await page.keyboard.press('Escape')
  return n
}

/**
 * Put attributed damage in the LIVE stay, through the real tailed file, and wait for the engine to
 * have folded it. The wait is on the CONDITION (the live zone session carries a total) rather than
 * on a clock — wave E3's law, and here it is also the precondition the whole step rests on.
 */
async function scriptOneHit(page: Page, log: FixtureLog): Promise<boolean> {
  const at = new Date(Math.ceil((Date.now() + 1000) / 1000) * 1000)
  log.appendAt(at, `You slash ${SCRIPTED_MOB} for 137 points of damage.`)
  const total = await settle(
    async () => (await snapshot(page)).zoneSessions.find((z) => z.id === 'zone')?.total ?? 0,
    (t) => t > 0,
    { timeoutMs: 25_000 }
  )
  return check(
    'a scripted hit reaches the meter’s live Overall, so the click has a stay to close',
    total > 0,
    `live zone total ${String(total)}`
  )
}

/**
 * THE STEP. Read both pickers, press ONE button, read both again.
 *
 * Assertions are on the DELTA rather than on absolute counts, because this spec runs after the
 * ledger step has already pressed once and after a fixture whose own zone lines have minted stays
 * of their own. What the ticket promises is that ONE press adds ONE segment to each — not that
 * either picker holds any particular number.
 */
export async function stepOneClickSplitsBoth(page: Page, log: FixtureLog): Promise<void> {
  if (!(await scriptOneHit(page, log))) return

  const beforeMeter = await overallRows(page)
  const beforeLoot = await lootSegments(page)
  if (!check('the ledger offers the one-click "New session"', (await countOf(page, NEW_SESSION)) === 1)) return

  await page.click(NEW_SESSION, { timeout: 10_000 })

  const afterLoot = await settle(() => lootSegments(page), (n) => n > beforeLoot, { timeoutMs: 10_000 })
  check(
    'one press opens one more session in the LOOT picker',
    afterLoot === beforeLoot + 1,
    `${String(beforeLoot)} -> ${String(afterLoot)}`
  )

  const afterMeter = await overallRows(page)
  const known = new Set(beforeMeter.map((r) => r.value))
  const gained = afterMeter.filter((r) => !known.has(r.value))
  if (
    !check(
      '…and THE SAME press opens one more stay in the METER’s Overall picker — one instant, both subsystems',
      gained.length === 1,
      `${String(beforeMeter.length)} -> ${String(afterMeter.length)} rows; new: ${gained.map((r) => r.value).join(', ') || 'none'}`
    )
  ) {
    return
  }
  check(
    '…and the meter calls it a SESSION, the word loot and leveling already print for this click',
    /-\s*session\b/i.test(gained[0].label),
    gained[0].label
  )
  check(
    '…while the live stay it opened is back to zero — the Details! reset feel, without losing the old record',
    ((await snapshot(page)).zoneSessions.find((z) => z.id === 'zone')?.total ?? -1) === 0
  )

  // Leave the ledger where the next step expects it: the whole record, nothing hidden.
  await page.click('[data-testid="nav-loot"]', { timeout: 15_000 })
  await page.click('[data-testid="loot-slice-all"]', { timeout: 10_000 })
  note('the ledger is back on All for whatever runs next')
}
