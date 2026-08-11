// THE YOU LINE ANSWERS THE PET PREFERENCE (JOS-170), walked with a mouse.
//
// Owner report 2026-08-09: "with a fight drilled into the You row, changing the pet preference
// does not recalculate the You line - the pet was moved out, and the title line for the You drill
// kept the old combined total (321 in the observed case)."
//
// WHY A UNIT TEST IS NOT ENOUGH, and why this one is not merely belt-and-braces. The derivation is
// pinned purely in tests/combatPetNesting.test.mts and would have passed the whole time the defect
// was on screen: nothing was ever WRONG with a function. The headline read the segment, the rows
// read the panel, and the two agreed by coincidence for as long as the pet was folded into your
// row. What can only be shown here is that the OWNER'S ROUTE produces a new number: flip a switch
// in Preferences (which unmounts the Combat tab), come back to a tab that re-hydrates its drill
// from localStorage, and read the line above the rows. Three lifecycles, one localStorage key, one
// cross-window notification — and the assertion is the pixels, not a return value.
//
// IT RUNS LAST, after the pet steps, because it needs what only they leave behind: a live fight
// with YOUR damage and a BOUND pet's in it. It asserts nothing about who bound what — that is
// combatSteps' subject — only that the two totals are different numbers, which is the whole of
// what makes the headline's answer observable.
//
// EVERY NUMBER IS READ FROM THE APP, never hard-coded. The expectations come out of the snapshot
// the renderer is showing (you, and each pet the engine attributed), so this stays true when the
// fixture or the scripted pull changes — AGENTS.md: frozen numbers rot.
//
// Its own module because combatSteps.mts and combat-dashboard.e2e.mts both sit at the repo's
// max-lines budget: split, never ratchet (drill.mts and combatPrefsSteps.mts set the precedent).

import type { Page } from 'playwright-core'
import { check, note, settle, settleStable, snapshot, type Snap } from './appHarness.mjs'
import { drilled, meterRows } from './drill.mjs'
import { setCombinePet } from './combatPrefsSteps.mjs'

/** The bare total on the panel's header line — the number the ticket is about. */
const TOTAL = '[data-testid="meter-total"]'
const ROW = '[data-testid="meter-row"]'

/**
 * The header total as a NUMBER. `lib/formatRate.formatNum` prints totals k/M-scaled with no unit
 * word, so '229' is exact and '21.7k' is exact to its own printed precision — which is why the
 * comparison below is a tolerance derived from that precision rather than an equality.
 */
function parseTotal(text: string): number | null {
  const m = /^([\d.]+)([kM]?)$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return n * (m[2] === 'k' ? 1_000 : m[2] === 'M' ? 1_000_000 : 1)
}

/** …read off the live DOM, once it has stopped moving. */
async function headlineTotal(page: Page): Promise<number | null> {
  const text = await settleStable(() => page.textContent(TOTAL).then((t) => t ?? ''), { timeoutMs: 10_000 })
  return parseTotal(text)
}

/** How close two totals have to be to count as the same printed number, given k/M rounding. */
function near(got: number, want: number): boolean {
  return Math.abs(got - want) <= Math.max(0.5, want * 0.005)
}

/** Your row and every pet row the engine attributed in the selected fight. */
function ownAndPets(snap: Snap): { you: number; pets: number } | null {
  const entities = snap.selected?.entities ?? []
  const you = entities.find((e) => e.kind === 'you')
  const pets = entities.filter((e) => e.kind === 'pet')
  if (!you || pets.length === 0) return null
  return { you: you.total, pets: pets.reduce((n, p) => n + p.total, 0) }
}

/**
 * Which level-1 bar is YOURS — matched on the NAME SPAN, never on the row's text.
 *
 * A row's `textContent` runs its spans together ('1You229 · 10 dps'), so a word-boundary test for
 * 'You' cannot match: the rank digit and the Y are both word characters. Reading the spans is the
 * exact question anyway — one of them IS the entity's name, straight off its source row.
 */
function youRowIndex(page: Page): Promise<number> {
  return page.$$eval(ROW, (rows) =>
    rows.findIndex((r) => [...r.querySelectorAll('span')].some((s) => (s.textContent ?? '').trim() === 'You'))
  )
}

/** Click that bar and wait for the level it opens. Reports which row it found, for the log. */
async function drillYou(page: Page): Promise<{ ok: boolean; where: string }> {
  const rows = await page.locator(ROW).count()
  const i = await settle(() => youRowIndex(page), (n) => n >= 0, { timeoutMs: 15_000 })
  const where = `row ${String(i)} of ${String(rows)}`
  if (i < 0) return { ok: false, where }
  await page.locator(ROW).nth(i).click({ timeout: 15_000 })
  return { ok: (await settle(() => drilled(page), (d) => d, { timeoutMs: 10_000 })) === true, where }
}

/**
 * Come back to the Combat tab's drilled You line and read what it says now.
 *
 * The drill is asserted STILL OPEN before the number is read: a preference flip that silently
 * un-drilled would make every total below a level-1 reading and the comparison meaningless, and
 * "the drill you left stays drilled" is JOS-116's promise that this ticket must not break.
 */
async function totalUnderDrill(page: Page, what: string): Promise<number | null> {
  const still = await settle(() => drilled(page), (d) => d, { timeoutMs: 15_000 })
  if (!check(`the You drill survives ${what} (JOS-116)`, still)) return null
  return headlineTotal(page)
}

export async function stepPetPreferenceMovesTheYouLine(page: Page): Promise<void> {
  // Level 1 first, whatever the pet steps left behind, and the preference in its shipped state.
  await meterRows(page)
  if (!check('the pet preference can be set to ON', await setCombinePet(page, true, 'nav-combat'))) return
  await page.waitForSelector('[data-testid="combat-dashboard"]', { timeout: 30_000 })
  await meterRows(page)

  const snap = await snapshot(page)
  const totals = ownAndPets(snap)
  if (!totals) {
    note('the selected fight has no You row and pet row together — there is no fold to flip')
    return
  }
  const combined = totals.you + totals.pets
  check(
    'the live fight carries YOUR damage and a bound pet’s, so the two answers differ',
    totals.pets > 0 && totals.you > 0,
    `you ${String(Math.round(totals.you))} + pets ${String(Math.round(totals.pets))} = ${String(Math.round(combined))}`
  )

  // 1. DRILL INTO YOU — the state the owner reported from.
  const opened = await drillYou(page)
  if (!check('the You bar drills', opened.ok, opened.where)) return
  const folded = await headlineTotal(page)
  if (!check('the drilled You line states a total', folded !== null)) return
  check(
    'pet folded in ⇒ the You line covers you AND your pet',
    near(folded as number, combined),
    `${String(folded)} of ${String(Math.round(combined))}`
  )

  // 2. MOVE THE PET OUT, from Preferences, exactly as a user does — the Combat tab unmounts on the
  //    way there and re-hydrates its stored drill on the way back.
  if (!check('the pet preference can be set to OFF', await setCombinePet(page, false, 'nav-combat'))) return
  await page.waitForSelector('[data-testid="combat-dashboard"]', { timeout: 30_000 })
  const separate = await totalUnderDrill(page, 'moving the pet out')
  if (separate === null) return
  check(
    'THE DEFECT: moving the pet out RECALCULATES the You line — it is yours alone now',
    near(separate, totals.you),
    `${String(separate)} of ${String(Math.round(totals.you))} (it used to keep ${String(Math.round(combined))})`
  )
  check('…and it is a different number from the folded one, without re-selecting the fight', separate !== folded)

  // 3. AND BACK. The other direction is a claim of its own: a headline that only ever shrinks
  //    would pass step 2 while still being wrong.
  if (!check('the pet preference can be set back ON', await setCombinePet(page, true, 'nav-combat'))) return
  await page.waitForSelector('[data-testid="combat-dashboard"]', { timeout: 30_000 })
  const again = await totalUnderDrill(page, 'folding the pet back in')
  if (again === null) return
  check(
    '…and folding it back in restores the combined total, in the same render',
    near(again, combined),
    `${String(again)} of ${String(Math.round(combined))}`
  )

  // 4. The way out still works from here — a headline that follows the drill must not have made
  //    the drill itself sticky.
  const back = await meterRows(page)
  check('…and the crumb still walks back out to the source list', back >= 1, `${String(back)} rows`)
}
