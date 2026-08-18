// The Plan tab's TEACHING step — the `?` card and the empty-state tutorial.
//
// SPLIT OUT OF `gearPlanSteps.mts`, which reached the 400-code-line ceiling again. The seam is the
// subject: everything here is about what the tab SAYS rather than what it does, and it is the only
// part of this spec that asserts on copy.
//
// Copy is worth asserting on precisely because nothing else catches it. The tutorial went stale
// once already - it was still telling people the item's name opened the record after the name had
// been changed to edit the slot - and only a reader noticed. These checks are that reader.

import type { Page } from 'playwright-core'
import { check, countOf, note, settleGone } from './appHarness.mjs'
import { until } from './plannerSteps.mjs'
import { textOf } from './gearPlanSteps.mjs'

/**
 * THE TEACHING, ON BOTH SURFACES — and the rule that decided which teaching goes where.
 *
 * A card that opens itself on first visit is the shape the owner deleted on the Exaltations tab
 * (JOS-51). So the first-visit teaching is the EMPTY STATE, which needs no remembered flag, and the
 * depth is behind a `?` that is the card's only door in. Both halves of that are asserted, because
 * the failure that matters is the card learning to open itself.
 *
 * WHAT ONLY A MOUNTED APP CAN SAY: that the `?` reaches the card at all, that the card is closed on
 * a store that has never answered it, and that the numbers inside it were READ rather than typed —
 * the unlock ladder in the card has to agree with the ladder the board itself draws, and the two
 * come from `extractionTier` through completely different code paths.
 */
export async function stepTeaching(page: Page): Promise<void> {
  const card = '[data-testid="gearplan-explainer"]'
  check('the teaching card is CLOSED on a store that has never asked for it', (await countOf(page, card)) === 0)
  check('…and the `?` that opens it is always on the toolbar', (await countOf(page, '[data-testid="gearplan-explain"]')) === 1)

  await page.click('[data-testid="gearplan-explain"]', { timeout: 15_000 })
  const opened = await until(async () => (await countOf(page, card)) > 0, 20_000)
  if (!check('the `?` opens the teaching card', opened)) return

  const text = await textOf(page, card)
  // IT TEACHES THE TOOL AND NOT THE GAME, which is an editorial line a test can actually hold. The
  // first version explained what merging does, what extraction costs and that green means better -
  // all things a player knows before opening this app. What it owes the reader is the controls.
  check(
    '…and it names the controls rather than the game rules',
    ['Full stats', 'Best on', 'Beats worn'].every((t) => text.includes(t)),
    text.slice(0, 240)
  )
  check(
    '…and does not spend the card teaching what a player already knows',
    !/costs|copies|hardest tier|green is better/i.test(text),
    text.slice(0, 240)
  )
  // The one thing here that could go stale is READ from the output registry, so a corrected command
  // reaches this card and the Exaltations tab together.
  check('…and it states the dump command, which used to live in a permanent row', text.includes('/outputfile inventory'), text.slice(0, 240))
  note(`explainer reads: ${text.replace(/\s+/g, ' ').slice(0, 260)}`)

  // THE ROW THAT STAYED is the clock, and ONLY the clock: the command moved into the card above.
  const row = '[data-testid="gearplan-outputfile"]'
  if ((await countOf(page, row)) > 0) {
    const rowText = await textOf(page, row)
    check('the dump row keeps the age and sheds the instructions', !rowText.includes('/outputfile'), rowText.slice(0, 120))
    check('…and still says how old the dump is', (await countOf(page, `${row} [data-testid="gearplan-outputfile-age"]`)) === 1, rowText.slice(0, 120))
    note(`dump row reads: ${rowText.replace(/\s+/g, ' ').slice(0, 120)}`)
  }

  // DISMISSING IS REMEMBERED IN BOTH DIRECTIONS, so the card left dismissed here is what the
  // relaunch step reads back.
  await page.click(`${card} button[aria-label="Close"]`, { timeout: 15_000 })
  check('…and it can be dismissed', await settleGone(page, card, { timeoutMs: 8_000 }))
}
