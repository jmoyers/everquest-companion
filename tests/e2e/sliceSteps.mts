// THE ZONE HALF of the app-wide timeslice, on the Leveling tab (JOS-130) — living next door
// because leveling.e2e.mts sits AT the repo max-lines budget and the rule here is to SPLIT, never
// ratchet (drill.mts set the precedent; dropSteps.mts, combatSteps.mts and plannerSteps.mts
// followed it). The spec still owns the ORDER, the launch and the dashboard readout it hands in.
//
// WHY THIS IS ITS OWN STEP AND NOT ANOTHER RUNG OF THE TIMESCALE ONE. Every other slice replaces
// the drawn WINDOW, and the timescale step is built on exactly that: the strip re-cuts, a stale
// selection is dropped, the hover re-maps. `Zone` does the opposite — it is the whole record
// restricted to the zone the log last named, so the curve keeps its domain and only the
// arithmetic under it moves. Asserting that asymmetry as a PAIR is the point: a refactor that
// flattened the zone filter into a time window would still pass every check over there.
//
// WHAT NO UNIT TEST CAN REACH: `tests/timeslice.test.mts` pins the definitions and the partition
// identity over a hand-built snapshot. It cannot see that the button in the real app resolves the
// real progression module's last zone line, hands one `zoneKey` down through `scopedStats` into
// `rangeStats`, and comes back to `All` with every rendered number byte for byte.

import type { Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'

const TS_WINDOW = '[data-testid="leveling-slice-window"]'
const LOOT_SLICE = '[data-testid="loot-slice"]'
const LOOT_SUMMARY = '[data-testid="loot-summary"]'
/** Narrowest first. Any of these is a real cut of the ledger; `custom` is not one until somebody
 *  types two instants into it, so it is deliberately never a candidate. */
const NARROW_ORDER = ['h1', 'h6', 'h24', 'd7', 'session', 'zone'] as const

/** Rendered text of the first match; '' when the node isn't mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/** The slice ids one surface's control is offering. No SliceId carries a hyphen, which is what
 *  lets this drop the caption (`-window`) and the custom range's two inputs from the same prefix. */
function offeredSlices(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate((p) =>
    Array.from(document.querySelectorAll(`[data-testid^="${p}-"]`))
      .map((e) => (e.getAttribute('data-testid') ?? '').replace(`${p}-`, ''))
      .filter((id) => id.length > 0 && id !== 'window' && !id.includes('-')), prefix)
}

/**
 * 5c. Pick `Zone`, prove the window stayed and the numbers moved, then come back to `All`.
 *
 * `readDashboard` is the spec's own readout of every scoped number on the tab — passed in rather
 * than re-implemented, so "byte for byte" means the same bytes here as it does over there.
 */
export async function stepZoneSlice(page: Page, readDashboard: () => Promise<string>): Promise<void> {
  if (!(await offeredSlices(page, 'leveling-slice')).includes('zone')) {
    note('this log has no zone line, so there is no current zone and the Zone preset is not offered')
    return
  }
  const allReadout = await readDashboard()
  const before = await textOf(page, TS_WINDOW)

  await page.click('[data-testid="leveling-slice-zone"]', { timeout: 10_000 })
  const after = await settle(() => textOf(page, TS_WINDOW), (t) => t !== before, { timeoutMs: 8000 })
  check('picking "Zone" names the zone in the caption', after.includes('·'), after.replace(/\s+/g, ' '))
  check(
    '…and leaves the drawn window where it was — a zone is a place, not a stretch of time',
    after.startsWith(before.trim()),
    `${before} → ${after}`.replace(/\s+/g, ' ')
  )
  check(
    '…while the numbers under it are re-derived for that zone alone',
    (await settle(() => readDashboard(), (t) => t !== allReadout, { timeoutMs: 8000 })) !== allReadout
  )

  await page.click('[data-testid="leveling-slice-all"]', { timeout: 10_000 })
  const restored = await settle(() => readDashboard(), (t) => t === allReadout, { timeoutMs: 8000 })
  check('returning to All restores every number, byte for byte', restored === allReadout)
}

/**
 * THE SAME CONTROL ON THE LOOT LEDGER (JOS-130) — where it was asked for.
 *
 * Two claims, and the first is the owner's standing direction rather than a nicety: the ledger
 * comes up on ALL TIME, so a reader who never touches this sees their whole history and the
 * summary makes no claim about a slice. The second is the report itself — "what did I gain in
 * totality vs this session" — which is why the sliced count is stated BESIDE the all-time one
 * rather than replacing it, and why coming back to `All` has to restore the caption exactly.
 */
export async function stepLootSlice(page: Page): Promise<void> {
  if (!check('the timeslice control is mounted on the Loot tab', (await countOf(page, LOOT_SLICE)) === 1)) return
  const all = await textOf(page, LOOT_SUMMARY)
  check('…and the ledger comes up on ALL TIME, hiding nothing', !all.includes('all time'), all.replace(/\s+/g, ' '))

  const offered = await offeredSlices(page, 'loot-slice')
  const narrow = NARROW_ORDER.find((id) => offered.includes(id))
  if (!narrow) {
    note(`this log defines no slice narrower than All — the ledger offers only [${offered.join(', ')}]`)
    return
  }
  await page.click(`[data-testid="loot-slice-${narrow}"]`, { timeout: 10_000 })
  const cut = await settle(() => textOf(page, LOOT_SUMMARY), (t) => t !== all, { timeoutMs: 8000 })
  check(
    `picking "${narrow}" states the sliced count BESIDE the all-time one`,
    cut.includes('all time'),
    cut.replace(/\s+/g, ' ')
  )

  await page.click('[data-testid="loot-slice-all"]', { timeout: 10_000 })
  const back = await settle(() => textOf(page, LOOT_SUMMARY), (t) => t === all, { timeoutMs: 8000 })
  check('…and All restores the whole ledger, caption and all', back === all, back.replace(/\s+/g, ' '))
}
