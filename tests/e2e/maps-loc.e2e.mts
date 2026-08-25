/**
 * Headless Electron integration test for the TYPED-/loc MARKER (JOS-98).
 *
 * THE ASK, in the reporter's words: "Would also be nice if there was a marker on the map for my
 * current positon. I realize I would need to feed the map a /loc but would gladly do so."
 *
 * WHY THIS HAS TO BE A REAL APP, and it is two separate reasons:
 *
 *   1. THE LIFECYCLE, exactly as maps-pin.e2e.mts found it. `App` mounts ONE feature view at a
 *      time, so leaving the Maps tab destroys the hook that holds the marker and returning rebuilds
 *      it from localStorage. "Sticks around" is a claim about that destruction and about a process
 *      boundary, and neither exists in a unit test — tests/mapLocMarker.test.mts drives every RULE
 *      here and would pass happily while the marker vanished on the way to the Loot tab.
 *   2. THE PIXEL. The transform is pinned against a landmark in the unit suite (the wiki's /loc for
 *      Transan and Isslana against Brewall's own labels for the same two NPCs, to the unit). What
 *      that cannot see is the rest of the chain — the field, the hook, `mapFromLoc`, `project`, the
 *      viewport's clamp and the absolutely-positioned div. So this spec does the landmark check
 *      AGAIN, in the app, against the map that is actually on screen: it reads a real label point
 *      out of the loaded map, computes the /loc a player STANDING THERE would read, types that
 *      sentence into the box, and requires the crosshair to land on that label's own glyph.
 *      Nothing in that loop is hard-coded to a zone, so it runs against whatever this machine has.
 *
 * THE REFUSAL IS ASSERTED AS AN ABSENCE, which means it is asserted the only honest way: type
 * something that is not a loc, wait for the prose, and then require that NO marker exists — a
 * feature that guessed would place one, and a feature that silently ignored bad input would leave
 * the user staring at a box that did nothing.
 *
 * TWO LAUNCHES, ONE userData DIR AND ONE STAGED LOG — "sticks around" has to outlive the process
 * too. Launch 2 replays the same log, so it opens the same zone, and the marker launch 1 typed is
 * still on it.
 *
 * FRESH-MACHINE HONESTY: the map PACKS are a 200 MB game install, junctioned in when this machine
 * has one. With no packs no map draws, the `/loc` field is gated on `hasMap` and correctly absent,
 * and this spec says so and skips — the same branch maps.e2e.mts and maps-pin.e2e.mts have always
 * had.
 *
 * Run: `npm run test:e2e -- maps-loc`.
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleGone,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'

const NAV_MAPS = '[data-testid="nav-maps"]'
const NAV_LOOT = '[data-testid="nav-loot"]'
const TOOLBAR = '[data-testid="maps-toolbar"]'
const SURFACE = '[data-testid="maps-surface"]'
const ZONE_CHIP = '[data-testid="maps-zone-chip"]'
/** The box a loc goes into, the button beside it, what the app believes, and its refusal. */
const LOC_INPUT = '[data-testid="maps-loc-input"]'
const LOC_CHIP = '[data-testid="maps-loc-chip"]'
/** The chip's ✕. Named, because the chip's OTHER icon centres on the marker instead of removing it. */
const LOC_CLEAR = '[data-testid="maps-loc-clear"]'
const LOC_ERROR = '[data-testid="maps-loc-error"]'
/** The crosshair itself. `data-loc` is the reading it was placed from, in the game's own words. */
const LOC_MARKER = '[data-testid="maps-loc-marker"]'

/** The key the marker is remembered under, read back so this spec pins the NAME as well as the
 *  round trip: a rename that kept this spec green would still drop every existing user's marker. */
const LOC_KEY = 'eq.maps.loc'

/** A real label point off the map that is actually loaded, and the /loc a player there would read. */
interface Anchor {
  x: number
  y: number
  z: number
  label: string
}

/** Open the Maps tab and wait for its toolbar. Safe when Maps is already the open view. */
async function openMaps(page: Page, timeoutMs = 60_000): Promise<boolean> {
  await page.click(NAV_MAPS, { timeout: 30_000 })
  return page.waitForSelector(TOOLBAR, { timeout: timeoutMs }).then(
    () => true,
    () => false
  )
}

/** The stem on screen; `''` when no map is open. */
function zoneOf(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    ZONE_CHIP
  )
}

/** The reading the FIRST drawn crosshair was placed from, or `null` when nothing is drawn. */
function markerLocOf(page: Page): Promise<string | null> {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.getAttribute('data-loc') ?? null,
    LOC_MARKER
  )
}

/** Every typed crosshair's reading, in DOM (add) order — the subject of the multi-marker steps. */
function markerLocsOf(page: Page): Promise<string[]> {
  return page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].map((el) => el.getAttribute('data-loc') ?? ''),
    LOC_MARKER
  )
}

/** What the toolbar chip states, or `''` when there is no marker to state. */
function chipTextOf(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    LOC_CHIP
  )
}

/** The whole stored blob, verbatim — so a shape change is visible, not just a missing marker. */
function storedOf(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LOC_KEY)
}

/** Type a loc into the box and commit it with Enter, the way a paste is finished. */
async function typeLoc(page: Page, text: string): Promise<void> {
  await page.fill(LOC_INPUT, text, { timeout: 15_000 })
  await page.press(LOC_INPUT, 'Enter', { timeout: 15_000 })
}

/**
 * A LABEL POINT OFF THE MAP THAT IS ON SCREEN, asked for through the app's own bridge.
 *
 * The legend layer is excluded (it is drawn at fixed OFF-map coordinates, §2.3) and so is anything
 * on the bounds themselves — the viewport clamps its centre to the zone's extent, so a point ON an
 * edge would be centred and clamped at once and the pixel assertion would be measuring the clamp.
 */
function anchorOf(page: Page, stem: string): Promise<Anchor | null> {
  return page.evaluate(async (zone) => {
    const eq = (window as unknown as {
      eq: {
        getMapData: (
          z: string,
          p: Record<string, string>
        ) => Promise<{
          ok: boolean
          data?: {
            points: { x: number; y: number; z: number; layer: number; display: string }[]
            bounds: { minX: number; maxX: number; minY: number; maxY: number }
          }
        }>
      }
    }).eq
    const res = await eq.getMapData(zone, {})
    const data = res.ok ? res.data : undefined
    if (!data) return null
    const b = data.bounds
    const inX = b.maxX - b.minX
    const inY = b.maxY - b.minY
    // A tenth of the extent in from every edge: comfortably inside the pan clamp, and comfortably
    // away from the legend's off-map coordinates whatever pack drew this zone.
    const usable = data.points.filter(
      (p) =>
        p.layer !== 2 &&
        p.x > b.minX + inX / 10 &&
        p.x < b.maxX - inX / 10 &&
        p.y > b.minY + inY / 10 &&
        p.y < b.maxY - inY / 10 &&
        p.display.trim() !== ''
    )
    const p = usable[0]
    return p ? { x: p.x, y: p.y, z: p.z, label: p.display } : null
  }, stem)
}

/** A coordinate as the chip STATES it — two decimals, like /loc itself (`locMarker.formatLoc`). */
function twoDp(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** The centre of an element's box, in page pixels. `null` when it is not mounted. */
function centreOf(page: Page, sel: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, sel)
}

/**
 * The centre of the GLYPH the map file drew for `label` — text or decluttered dot, both of which
 * carry the display text as their `title` and both of which are centred on the point.
 */
function glyphCentreOf(page: Page, label: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((want) => {
    const all = [...document.querySelectorAll('[data-testid="map-point"], [data-testid="map-point-dot"]')]
    const hit = all.filter((el) => el.getAttribute('title') === want)[0]
    if (!hit) return null
    const r = hit.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, label)
}

/** Leave for the Loot tab and confirm the Maps view is really gone — see maps-pin.e2e.mts. */
async function leaveMaps(page: Page): Promise<boolean> {
  await page.click(NAV_LOOT, { timeout: 30_000 })
  return settleGone(page, TOOLBAR, { timeoutMs: 15_000 })
}

/** 1. A FRESH MAP HAS NO MARKER, and the box that would make one is on screen. */
async function stepEmpty(page: Page): Promise<void> {
  check('a map with no marker draws none', (await countOf(page, LOC_MARKER)) === 0)
  check('…and states none', (await countOf(page, LOC_CHIP)) === 0)
  check('the /loc box is on screen without being asked for', (await countOf(page, LOC_INPUT)) === 1)
}

/** 2. A MALFORMED ENTRY IS REFUSED IN PROSE, AND PLACES NOTHING. */
async function stepRefusal(page: Page): Promise<void> {
  await typeLoc(page, 'somewhere near the docks')
  const said = await settle(
    () => page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? '', LOC_ERROR),
    (t) => t !== '',
    { timeoutMs: 8000 }
  )
  check('a malformed entry is refused IN PROSE', said !== '', said)
  check('…and the refusal names what it choked on', said.includes('somewhere'), said)
  // THE ABSENCE, which is the whole point: a feature that guessed would have placed something.
  check('…AND NO MARKER IS PLACED FROM IT', (await countOf(page, LOC_MARKER)) === 0)
  check('…and nothing is stored', (await storedOf(page)) !== null ? !(await storedOf(page))?.includes('ns') : true)
}

/**
 * 3. THE LANDMARK, IN THE APP: type the /loc a player standing at a labelled place would read, and
 * the crosshair must land on that label's own glyph.
 *
 * `/loc` prints (north/south, west/east, elevation) and the map file stores (-ew, -ns, z), so the
 * reading at a point the file puts at `(x, y)` is `(-y, -x, z)`. That inversion is computed HERE,
 * from the map's own bytes, and typed in as a sentence — so a wrong order or a flipped sign in the
 * app shows up as a crosshair sitting somewhere else entirely.
 */
async function stepLandmark(page: Page, anchor: Anchor): Promise<void> {
  const typed = `Your Location is ${String(-anchor.y)}, ${String(-anchor.x)}, ${String(anchor.z)}`
  note(`standing at “${anchor.label}” the game would print: ${typed}`)
  await typeLoc(page, typed)

  const placed = await settle(() => markerLocOf(page), (l) => l != null, { timeoutMs: 10_000 })
  if (!check('a well-formed /loc places a marker', placed != null, String(placed))) return
  check('…exactly one of them', (await countOf(page, LOC_MARKER)) === 1)
  check('…and the refusal from the bad entry is gone', (await countOf(page, LOC_ERROR)) === 0)

  const glyph = await glyphCentreOf(page, anchor.label)
  const mark = await centreOf(page, LOC_MARKER)
  if (glyph == null || mark == null) {
    note(`“${anchor.label}” is not drawn as a glyph right now — the pixel check is skipped this run`)
    return
  }
  const off = Math.hypot(mark.x - glyph.x, mark.y - glyph.y)
  check(
    'THE MARKER LANDS ON THE LANDMARK ITS /loc WAS READ FROM',
    off <= 2,
    `${String(Math.round(off))}px from “${anchor.label}” (marker ${String(Math.round(mark.x))},${String(Math.round(mark.y))} vs glyph ${String(Math.round(glyph.x))},${String(Math.round(glyph.y))})`
  )
  // Placing also GOES there — a marker you cannot see answers nothing. The centring is the
  // viewport's own clamped `centerOn`, so this is a second, independent read on the transform.
  const surface = await centreOf(page, SURFACE)
  if (surface == null) return
  check(
    '…and placing it centres the map on it',
    Math.hypot(mark.x - surface.x, mark.y - surface.y) <= 2,
    `${String(Math.round(Math.hypot(mark.x - surface.x, mark.y - surface.y)))}px off centre`
  )
}

/** 4. IT IS STATED AND IT IS STORED — under the key the app ships, keyed by the zone on screen. */
async function stepStated(page: Page, zone: string, anchor: Anchor): Promise<void> {
  const chip = await settle(() => chipTextOf(page), (t) => t !== '', { timeoutMs: 8000 })
  check('the toolbar states the marker in the game’s own words', chip !== '', chip)
  // The chip states the reading to TWO PLACES, which is what /loc itself prints; the STORE keeps
  // the full precision, and the assertion below is what pins that difference as deliberate.
  check(
    '…and states the reading that was typed, to the two places /loc prints',
    chip.startsWith(twoDp(-anchor.y)),
    `${chip} vs ns ${twoDp(-anchor.y)}`
  )

  const stored = await settle(() => storedOf(page), (s) => s != null && s.includes(zone), { timeoutMs: 8000 })
  check(
    `the marker is stored under ${LOC_KEY}, keyed by the zone it belongs to`,
    stored != null && stored.includes(zone),
    String(stored)
  )
  // ROUNDING IS A DISPLAY, NOT A LOSS: the chip says two places, the store keeps what was typed.
  check(
    '…at the full precision that was entered, not the rounded form on the chip',
    stored != null && stored.includes(String(-anchor.y)),
    `${String(stored)} should carry ns ${String(-anchor.y)}`
  )
}

/** 5. THE HEADLINE: leave the tab, come back — the marker is still there and still says the same. */
async function stepSurvivesTabs(page: Page): Promise<void> {
  const before = await markerLocOf(page)
  if (!check('leaving the Maps tab for Loot unmounts it (the toolbar is gone)', await leaveMaps(page))) return
  if (!check('…and the Maps tab comes back', await openMaps(page))) return
  const after = await settle(() => markerLocOf(page), (l) => l != null, { timeoutMs: 20_000 })
  check('THE MARKER SURVIVES LEAVING AND RETURNING TO THE TAB', after === before, `${String(after)} vs ${String(before)}`)
  check('…and the toolbar still states it', (await chipTextOf(page)) !== '')
}

/** 6. ENTERING MORE LOCS ADDS MARKERS — up to four, then the colour cycle evicts the oldest. */
async function stepAddMore(page: Page, anchor: Anchor): Promise<void> {
  const start = await markerLocsOf(page)
  check('one marker is on the map to begin with', start.length === 1, String(start.length))
  // Three more real, distinct positions on the same map — four markers, four colours.
  for (const [dy, dx] of [[40, -40], [-60, 60], [90, 80]] as const) {
    await typeLoc(page, `${String(-anchor.y + dy)}, ${String(-anchor.x + dx)}, ${String(anchor.z)}`)
  }
  const four = await settle(() => countOf(page, LOC_MARKER), (c) => c === 4, { timeoutMs: 12_000 })
  check('typing more /locs ADDS markers rather than replacing', four === 4, String(four))
  check('…and each is stated by its own chip', (await countOf(page, LOC_CHIP)) === 4)
  const stored4 = await storedOf(page)
  check('…stored as four coloured entries for this zone', (stored4?.match(/"color"/g) ?? []).length === 4, String(stored4))

  // A FIFTH add cannot make a fifth marker: the oldest is evicted, its colour cycles to the new one.
  const oldest = (await markerLocsOf(page))[0]
  await typeLoc(page, `${String(-anchor.y + 200)}, ${String(-anchor.x + 10)}, ${String(anchor.z)}`)
  const after = await settle(
    () => markerLocsOf(page),
    (ls) => ls.length === 4 && !ls.includes(oldest),
    { timeoutMs: 12_000 }
  )
  check('a fifth /loc never makes a fifth marker — the cap holds at four', after.length === 4, String(after.length))
  check('…and it evicts the OLDEST, cycling the colour', !after.includes(oldest), `${oldest} should be gone`)
}

/** 7. CLEARING REMOVES THEM — every marker, from the map, the toolbar and the store. */
async function stepClear(page: Page, zone: string): Promise<void> {
  // Several markers are down; clear each in turn (the ✕ always removes the first chip).
  for (let guard = 8; guard > 0 && (await countOf(page, LOC_MARKER)) > 0; guard--) {
    const n = await countOf(page, LOC_MARKER)
    await page.click(LOC_CLEAR, { timeout: 15_000 })
    await settle(() => countOf(page, LOC_MARKER), (c) => c < n, { timeoutMs: 8000 })
  }
  check('clearing the chips removes every marker from the map', await settleGone(page, LOC_MARKER, { timeoutMs: 8000 }))
  check('…and the chips with them', (await countOf(page, LOC_CHIP)) === 0)
  const stored = await settle(() => storedOf(page), (s) => s == null || !s.includes(`"${zone}"`), { timeoutMs: 8000 })
  check('…and they are gone from the store, not merely off the screen', stored == null || !stored.includes(`"${zone}"`), String(stored))
}

/** Everything launch 1 asserts. Returns the reading left placed for launch 2, or null when skipped. */
async function firstLaunch(page: Page): Promise<{ zone: string; loc: string } | null> {
  if (!check('the Maps tab opens', await openMaps(page))) return null
  await waitHydrated(page)
  const zone = await settle(() => zoneOf(page), (z) => z !== '', { timeoutMs: 30_000 })
  if (zone === '') {
    note('no map drew on this machine (no EQ map packs) — the /loc marker assertions are skipped')
    return null
  }
  const anchor = await anchorOf(page, zone)
  if (anchor == null) {
    note(`the map for "${zone}" states no usable label point — the landmark assertions are skipped`)
    return null
  }

  await stepEmpty(page)
  await stepRefusal(page)
  await stepLandmark(page, anchor)
  await stepStated(page, zone, anchor)
  await stepSurvivesTabs(page)
  await stepAddMore(page, anchor)
  await stepClear(page, zone)

  // Arm the restart: place one last marker and hand its reading to launch 2.
  await typeLoc(page, `Your Location is ${String(-anchor.y)}, ${String(-anchor.x)}, ${String(anchor.z)}`)
  const armed = await settle(() => markerLocOf(page), (l) => l != null, { timeoutMs: 10_000 })
  if (armed == null) return null
  check('a marker is placed for the restart check', true, armed)
  return { zone, loc: armed }
}

/** 8. THE RESTART: a second process, the same userData dir and the same log. */
async function stepSurvivesRestart(page: Page, placed: { zone: string; loc: string }): Promise<void> {
  if (!check('the Maps tab opens after a restart', await openMaps(page))) return
  const zone = await settle(() => zoneOf(page), (z) => z !== '', { timeoutMs: 30_000 })
  if (zone !== placed.zone) {
    note(`launch 2 opened "${zone}" rather than "${placed.zone}" — the marker belongs to another map, so the restart check is skipped`)
    return
  }
  const loc = await settle(() => markerLocOf(page), (l) => l != null, { timeoutMs: 20_000 })
  check('THE MARKER SURVIVES A FULL RESTART', loc === placed.loc, `${String(loc)} vs ${placed.loc}`)
  check('…and the toolbar states it again', (await chipTextOf(page)) !== '')
  const stored = await storedOf(page)
  check(
    '…and the stored reading crossed the process boundary intact',
    stored != null && stored.includes(placed.zone),
    String(stored)
  )
}

/** Launch 2: a new process on the dir and the log launch 1 left behind. */
async function secondLaunch(log: FixtureLog, userData: string, placed: { zone: string; loc: string }): Promise<void> {
  console.log('launch 2: the SAME userData dir and the SAME log, a new process…')
  const second = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(second.app)
    await page.waitForSelector(NAV_MAPS, { timeout: 60_000 })
    await stepSurvivesRestart(page, placed)
    if (failures.length) await dumpArtifacts(page, 'maps-loc-restart-FAIL')
  } finally {
    await second.close()
  }
}

async function main(): Promise<void> {
  buildIfStale()

  // OWNED BY THIS SPEC, both of them: the restart assertion IS the dir outliving a process.
  const userData = makeUserData()
  const log = stageFixture('e2e-maps.log', { maps: true })
  try {
    console.log('launch 1: refuse a bad loc, place one on a landmark, tab round trip, add up to four + cycle, clear…')
    const first = await launchOnFixture(log, { userData })
    let placed: { zone: string; loc: string } | null = null
    try {
      const page = await mainWindow(first.app)
      const consoleErrors: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text())
      })
      page.on('pageerror', (e) => consoleErrors.push(String(e)))
      await page.waitForSelector(NAV_MAPS, { timeout: 60_000 })
      placed = await firstLaunch(page)
      check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
      if (failures.length) await dumpArtifacts(page, 'maps-loc-FAIL')
    } finally {
      await first.close()
    }

    if (placed == null) note('nothing was placed in launch 1 — the restart half has no subject and is skipped')
    else await secondLaunch(log, userData, placed)
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
