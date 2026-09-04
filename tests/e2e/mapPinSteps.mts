/**
 * mapPinSteps.mts — THE MAP'S THREE CLICKS (PR 35): a mob pin, a `to <Zone>` connection label,
 * and the pane row's door to the mob's page.
 *
 * Next door to maps.e2e.mts for the reason every *Steps file in this directory exists: the spec
 * sits at the repo's `max-lines 400` factoring ceiling, and the rule is SPLIT, never ratchet
 * (conCardLinkSteps.mts, gearWishSteps.mts). The spec keeps the launch, the fixture and the order;
 * this file is the three gestures the branch added to a map that already drew.
 *
 * WHAT NEEDS A REAL APP, given tests/mapMobPane.test.mts owns the selection split and
 * tests/mapZoneLinks.test.mts owns which labels resolve:
 *
 *   THE PIN. Its click rings the pin WITHOUT moving the map — the pane row's click centres, the
 *   pin's does not (mobPins.ts `paneGestures`), because centring moved the pin out from under the
 *   second click of the double-click that opens the mob's page. "Did the projection move" is a
 *   transform question only a rendered viewport can answer, so the pin's screen position is read
 *   before and after, exactly as the spec's own pane-row step reads it to prove the OPPOSITE.
 *   And the click has to reach the pin at all: the surface now takes pointer capture on the first
 *   MOVE rather than on the press (useMapViewport.ts), which is a Chromium click-targeting fact
 *   no unit test can see.
 *
 *   THE CONNECTION LABEL. A `to_…` label the zone table resolves is a `role="button"` that opens
 *   that map; the assertion is the zone chip CHANGING, which is a fetch, a parse in main and a
 *   remount of the surface. It leaves you in another zone, so the spec runs it last.
 *
 *   THE PAGE DOOR. The row's open-mob button is a cross-tab deep link (Maps → Mobs) whose Back
 *   returns to Maps; that is App-level routing, and only the built app has it.
 *
 * FRESH-MACHINE HONESTY, as the host spec: a zone whose catalog states no coordinates draws no
 * pin, a fit view may declutter every connection label to a dot the layout did not link, and a
 * pane with no mob rows has no door. Each is `note()`d and skipped, never failed.
 */
import type { Page } from 'playwright-core'
import { check, countOf, note } from './appHarness.mjs'

const PIN = '[data-testid="maps-mob-pin"]'
const PANE_MARKER = '[data-testid="maps-pane-marker"]'
const PANE_MOB_SELECTED = '[data-testid="maps-pane-mob"].Mui-selected'
/** Only the labels and dots the layer LINKED — an inert label carries no role (MapPointsLayer). */
const POINT_LINK = '[data-testid="map-point"][role="button"]'
const POINT_DOT_LINK = '[data-testid="map-point-dot"][role="button"]'
const ZONE_CHIP = '[data-testid="maps-zone-chip"]'
const PANE_OPEN_MOB = '[data-testid="maps-pane-open-mob"]'
const MAPS_HEADER = '[data-testid="maps-header"]'
/** The app's mob page, identified by its Back button — deep-link-back.e2e.mts's own handle on it. */
const MOBS_BACK = '[data-testid="mobs-back"]'

/** Rendered text of the first match, whitespace folded; '' when nothing is mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '',
    sel
  )
}

/** Poll `fn` until it holds or `ms` elapses. The host spec's own shape. */
async function until(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return fn()
}

/** Where the FIRST mob pin sits on screen — the spec's transform probe, repeated here. */
function pinAt(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top) }
  }, PIN)
}

/**
 * CLICK A PIN ⇒ RING, ROW HIGHLIGHT, AND THE MAP DOES NOT MOVE.
 *
 * The "does not move" half is the whole finding: a pin click that recentred put the second click
 * of a double-click on empty map. Read the pin's position before and after, and require equality
 * — the exact inverse of the pane-row step's claim, on purpose.
 */
export async function stepPinClick(page: Page): Promise<void> {
  if ((await countOf(page, PIN)) === 0) {
    note('no wiki pin is drawn for this zone (its catalog rows state no coordinates) — the pin click is not asserted this run')
    return
  }
  const before = await pinAt(page)
  await page.click(PIN, { timeout: 15_000 })
  const ringed = await until(async () => (await countOf(page, PANE_MARKER)) > 0, 4000)
  check('clicking a mob pin rings it on the map', ringed)
  check(
    '…and highlights its row in the sidebar (one selection, two readers)',
    (await countOf(page, PANE_MOB_SELECTED)) > 0
  )
  const after = await pinAt(page)
  check(
    '…and does NOT move the map — the pin stays under the cursor so a double-click can land',
    before != null && after != null && after.x === before.x && after.y === before.y,
    before && after ? `pin ${String(before.x)},${String(before.y)} → ${String(after.x)},${String(after.y)}` : 'pin gone'
  )
}

/**
 * THE ROW'S PAGE DOOR, THERE AND BACK. Runs before anything that changes zone, because the trip
 * back has to land on the map that was open.
 */
export async function stepOpenMobDoor(page: Page): Promise<void> {
  if ((await countOf(page, PANE_OPEN_MOB)) === 0) {
    note('the sidebar lists no mob rows for this zone — the page door is not asserted this run')
    return
  }
  await page.click(PANE_OPEN_MOB, { timeout: 15_000 })
  const opened = await until(async () => (await countOf(page, MOBS_BACK)) > 0, 15_000)
  if (!check('the row’s page door opens the mob’s page on the Mobs tab', opened)) return
  await page.click(MOBS_BACK, { timeout: 15_000 })
  const back = await until(async () => (await countOf(page, MAPS_HEADER)) > 0, 15_000)
  check('…and Back returns to Maps', back)
}

/**
 * CLICK A `to <Zone>` LABEL ⇒ THAT MAP OPENS. Asserted through the zone chip, which only changes
 * once the new map has actually arrived. Leaves you elsewhere: the spec runs it LAST.
 */
export async function stepConnectionLabel(page: Page): Promise<void> {
  const link = (await countOf(page, POINT_LINK)) > 0 ? POINT_LINK : POINT_DOT_LINK
  if ((await countOf(page, link)) === 0) {
    note('no connection label on this map resolves to an installed zone at this view — the label click is not asserted this run')
    return
  }
  const from = await textOf(page, ZONE_CHIP)
  const title = await page.getAttribute(link, 'title', { timeout: 15_000 })
  check(
    'a linked connection label SAYS it opens a map (a cursor change alone is not a promise)',
    (title ?? '').includes('click to open this map'),
    title ?? ''
  )
  await page.click(link, { timeout: 15_000 })
  const arrived = await until(async () => {
    const now = await textOf(page, ZONE_CHIP)
    return now !== '' && now !== from
  }, 25_000)
  check(
    'clicking a `to <Zone>` label opens that zone’s map (the zone chip changes)',
    arrived,
    `zone chip "${from}" → "${await textOf(page, ZONE_CHIP)}"`
  )
}
