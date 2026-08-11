// buffTimerSteps — reading a TIMER OVERLAY's rows out of the DOM, and setting its arrangement.
//
// Its own module for the reason `combatSteps.mts` and `overlayScopeSteps.mts` are: the spec that
// uses it is at the repo's 400-code-line factoring ceiling, and a reader with two arrangements to
// cope with is exactly the kind of thing that belongs beside the other readers rather than inside
// the narrative of a spec.
//
// TWO ARRANGEMENTS, ONE READER (JOS-140). The debuffs window opens FLAT — one list sorted soonest
// to expire, with the enemy as a chip ON the row — and can be switched to per-target BLOCKS, where
// the enemy is a heading above a group of rows. `targets()` answers "which enemy" from either, so
// a spec's claim about what the user can see does not have to restate the arrangement it is in.

import type { Page } from 'playwright-core'

export interface TimerRow {
  name: string
  time: string
  mode: string
  /** The enemy this row is on, whichever arrangement it is drawn in. Empty for a self row. */
  target: string
}

/**
 * The rows currently on the overlay: name + the time column + the mode + the enemy.
 *
 * THE NAME AND THE TARGET ARE READ FROM ATTRIBUTES, not from rendered text, and that is not a
 * shortcut: the name SPAN also carries the ~ family mark, an xN count chip and a caster chip, and
 * the target is a chip on the row in one arrangement and a block heading in the other. The bar
 * publishes both as `data-spell` / `data-target`, so this reader asks the model's answer.
 *
 * NO NAMED FUNCTIONS INSIDE `evaluate`. tsx compiles a named arrow into an esbuild `__name(...)`
 * call, which does not exist in the page — measured here: the first version of this reader threw
 * `ReferenceError: __name is not defined` from inside Playwright's evaluate wrapper.
 */
export async function timerRows(overlay: Page): Promise<TimerRow[]> {
  return overlay.evaluate(() =>
    [...document.querySelectorAll('[data-testid="buff-timer-row"]')].map((el) => ({
      name: el.getAttribute('data-spell') ?? '',
      time: (el.querySelector('[data-testid="buff-timer-time"]')?.textContent ?? '').trim(),
      mode: el.getAttribute('data-timer-mode') ?? '',
      target: el.getAttribute('data-target') ?? ''
    }))
  )
}

/**
 * The block headings currently on the overlay — one per entity when grouped, and NONE at all in
 * the flat arrangement, where the single block has no heading and its first child is a bar. The
 * filter is what makes "no headings" a readable answer rather than a list of bar text.
 */
export async function timerGroups(overlay: Page): Promise<string[]> {
  return overlay.evaluate(() =>
    [...document.querySelectorAll('[data-testid="buff-timer-group"]')]
      .map((el) => el.firstElementChild)
      .filter((n) => n !== null && n.getAttribute('data-testid') !== 'buff-timer-row')
      .map((n) => (n?.textContent ?? '').trim())
  )
}

/** Every enemy this window currently names, from the row chips AND the block headings. */
export async function timerTargets(overlay: Page): Promise<string[]> {
  const fromRows = (await timerRows(overlay)).map((r) => r.target).filter((t) => t !== '')
  return [...new Set([...fromRows, ...(await timerGroups(overlay))])]
}

/**
 * Flip a timer window between the flat soonest-first list and per-target blocks.
 *
 * Through the overlay's OWN config bridge — the same `overlay:setConfig` IPC the footer button
 * lands on, carrying the KIND the preload read from its own `?kind=` query. A hidden always-on-top
 * window has no pointer to press that button with.
 */
export async function setTimerGrouping(overlay: Page, grouping: 'none' | 'target'): Promise<void> {
  await overlay.evaluate(
    (g) =>
      (window as unknown as { eqOverlay: { setConfig: (p: unknown) => Promise<unknown> } }).eqOverlay.setConfig({
        grouping: g
      }),
    grouping
  )
}
