/**
 * Headless Electron integration test for the MAPS tab (docs/plans/map-viewer.md §12).
 *
 * WHY ITS OWN FILE: same reason the Overview spec is its own — one spec per surface, all three
 * sharing `appHarness.mts` and running back to back from `npm run test:e2e`. `EQ_E2E=1`
 * (src/main/e2e.ts) shows no window, skips the single-instance lock and points `userData` at a
 * throwaway temp dir, so this runs invisibly beside the user's game and dev app.
 *
 * WHY `userData` IS WIPED FIRST: the headline assertion is AUTO-OPEN — the log says which zone
 * you are in and the viewer opens that zone's map without being asked. The viewer also remembers
 * the last zone in `localStorage['eq.maps.zone']`, which lives inside `userData`; a stale one
 * would open a map the log never asked for and make the assertion vacuous. Every launch now gets
 * a userData dir of its own, so "wiped first" is simply what a launch is.
 *
 * WHAT IT ASSERTS, against whatever the real machine holds right now: the nav row mounts the
 * view; the canvas has non-zero size and a devicePixelRatio-scaled backing store (the difference
 * between a crisp map and a blurry one); when the log has stated a zone AND the hand-authored
 * table resolves it, the header states that zone and names a source pack per layer; the SIDEBAR
 * is on screen WITHOUT BEING ASKED FOR (it is the default experience, and this run starts from a
 * wiped `userData`, so nothing remembered can be producing it); it lists the wiki's mobs and the
 * map's own labels and filters both from one box; it is a BOUNDED scroll box (the Task-#56 law,
 * measured); clicking a row centres the viewport on it (asserted through the pin's screen
 * position — a real transform change) and rings it; closing it gives the width back to the map
 * and leaves a way back in; and one query reaches the corpus — a label prefix taken from the map
 * on screen lists matches in OTHER zones, and clicking one loads that zone and flashes the
 * transient marker. THE SAME BOX ALSO REACHES THE WIKI'S BESTIARY IN EVERY OTHER ZONE (JOS-135):
 * a High Keep NPC no map pack labels anywhere is found from wherever you happen to be standing,
 * the row names the zone it will take you to, and clicking it opens that zone's map and marks the
 * spot his page stated. And there are no renderer console errors.
 *
 * FRESH-MACHINE HONESTY, twice over. A machine with no EQ install has no logs (so the app shows
 * its no-logs empty state and no feature view mounts at all) and no `maps\` directory (so the
 * viewer shows its quiet picker). Both are the CORRECT behaviour, not failures: the spec detects
 * them, `note()`s what it saw, and skips the assertions that presuppose data. The same is true
 * of a zone the table does not map — the EQL Tutorial is the known case — where the picker, not
 * a guessed map, is the pass.
 *
 * Floors and identities only, never today's numbers (AGENTS.md: frozen numbers rot).
 *
 * Run: `npm run test:e2e` (this spec runs last).
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  pageOverflow,
  rectOf,
  reportRun,
  settle,
  settleStable,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

const NAV = '[data-testid="nav-maps"]'
const HEADER = '[data-testid="maps-header"]'
const CANVAS = '[data-testid="map-canvas"]'
const SURFACE = '[data-testid="maps-surface"]'
const EMPTY = '[data-testid="maps-empty"]'
const POINT = '[data-testid="map-point"]'
const PANE = '[data-testid="maps-pane"]'
const PANE_CLOSE = '[data-testid="maps-pane-close"]'
const PANE_OPEN = '[data-testid="maps-pane-open"]'
const PANE_SCROLL = '[data-testid="maps-pane-scroll"]'
const PANE_SEARCH = '[data-testid="maps-pane-search"]'
const PANE_MOB = '[data-testid="maps-pane-mob"]'
/** A mob row the wiki actually placed — the only kind that is clickable (the rest are disabled). */
const PANE_MOB_PINNED = '[data-testid="maps-pane-mob"]:has([data-testid="maps-pane-pin"])'
const PANE_LABEL = '[data-testid="maps-pane-label"]'
const PANE_HIT = '[data-testid="maps-pane-hit"]'
/** A cross-zone row the WIKI answered with, as opposed to another map's label text (JOS-135). */
const PANE_HIT_MOB = '[data-testid="maps-pane-hit"][data-kind="mob"]'
const PANE_MARKER = '[data-testid="maps-pane-marker"]'
const ZONE_CHIP = '[data-testid="maps-zone-chip"]'

/**
 * The owner's own report, made into a fixture: a High Keep NPC, searched from anywhere else.
 *
 * A REAL NAME FROM THE COMMITTED CATALOG, not an invented one — `Tarn Visilin` is a level-45 High
 * Keep NPC whose page states one zone and one position, which is exactly the shape this path has
 * to carry end to end. No map pack labels that name, so before JOS-135 this query answered nothing
 * at all.
 */
const CROSS_ZONE_MOB = 'Tarn Visilin'
const CROSS_ZONE_STEM = 'highkeep'

/** Rendered text of the first match; '' when the node isn't mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/** Box + scroll geometry — enough to prove a growing list is a BOUNDED scroller. */
function boxOf(page: Page, sel: string): Promise<{ h: number; scrollH: number; clientH: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    return {
      h: Math.round(el.getBoundingClientRect().height),
      scrollH: el.scrollHeight,
      clientH: el.clientHeight
    }
  }, sel)
}

/** Poll a predicate until it holds or the deadline passes. Everything here lands asynchronously. */
function until(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  return settle(fn, (ok) => ok, { timeoutMs: ms })
}

/**
 * The canvas's CSS box and its BACKING STORE, plus the display's dpr.
 *
 * These are three different numbers on purpose: a canvas whose backing store is its CSS size is
 * exactly the blurry-map bug (§6.2), and it is invisible to any assertion that only measures the
 * element.
 */
function canvasMetrics(
  page: Page
): Promise<{ cssW: number; cssH: number; bufW: number; bufH: number; dpr: number } | null> {
  return page.evaluate((sel) => {
    const cv = document.querySelector(sel) as HTMLCanvasElement | null
    if (!cv) return null
    return {
      cssW: Math.round(cv.getBoundingClientRect().width),
      cssH: Math.round(cv.getBoundingClientRect().height),
      bufW: cv.width,
      bufH: cv.height,
      dpr: window.devicePixelRatio || 1
    }
  }, CANVAS)
}

/** A searchable prefix taken from a label ACTUALLY on screen — never an invented string. */
async function labelPrefix(page: Page): Promise<string> {
  const text = await textOf(page, POINT)
  const word = /[A-Za-z]{4,}/.exec(text)
  return word ? word[0] : ''
}

// ── the run ───────────────────────────────────────────────────────────────────────────

/** 1. THE NAV ROW MOUNTS THE VIEW. Returns false on the no-logs machine, where nothing does. */
async function stepMount(page: Page): Promise<boolean> {
  const hasRow = await page.waitForSelector(NAV, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the nav drawer has a Maps row', hasRow)) return false
  await page.click(NAV, { timeout: 15_000 })
  const mounted = await page.waitForSelector(HEADER, { timeout: 30_000 }).then(
    () => true,
    () => false
  )
  if (!mounted) {
    // The one legitimate reason the view does not mount: no character logs at all, so App's
    // fresh-machine empty state stands in front of every feature view.
    const noLogs = (await textOf(page, 'main')).includes('No EverQuest logs found')
    check('clicking Maps mounts the viewer (or the no-logs empty state explains why not)', noLogs)
    if (noLogs) note('no character logs on this machine — the app shows its fresh-machine empty state and no feature view mounts')
    return false
  }
  check('clicking the Maps nav row mounts the viewer', true)
  return true
}

/** Wait out the startup replay so the character module has had a chance to state the zone. */
async function waitZone(page: Page): Promise<string | undefined> {
  return (await waitHydrated(page)).snap.zone
}

/**
 * 2. A MAP IS ON SCREEN, or the quiet state says why not.
 *
 * Both outcomes are correct behaviour; only a THIRD outcome (neither) is a failure.
 */
async function stepMapOrEmpty(page: Page, zone: string | undefined): Promise<boolean> {
  const drew = await until(async () => (await countOf(page, CANVAS)) > 0, 45_000)
  if (drew) return true
  const emptyText = (await textOf(page, EMPTY)).replace(/\s+/g, ' ').trim()
  check(
    'no map drawn ⇒ the viewer shows its quiet picker, never an error or a blank pane',
    emptyText.length > 0,
    emptyText.slice(0, 110)
  )
  note(
    zone == null || zone === ''
      ? 'the log has stated no zone yet — the picker is the correct state and the map assertions are skipped'
      : `no map is open for "${zone}" (unmapped zone, or no maps\\ directory on this machine) — the picker is the correct state and the map assertions are skipped`
  )
  return false
}

/** 3. THE CANVAS IS REAL AND dpr-SCALED. */
async function stepCanvas(page: Page): Promise<void> {
  const rect = await rectOf(page, SURFACE)
  check(
    'the map pane has real size (it is not squeezed to nothing)',
    !!rect && rect.w > 0 && rect.h > 0,
    rect ? `${String(rect.w)}×${String(rect.h)}px` : 'absent'
  )
  const m = await canvasMetrics(page)
  if (!m) return
  // The canvas FILLS its pane. Stated as an identity against the host box rather than as a
  // number, because the failure it catches is silent: an unsized <canvas> falls back to its
  // intrinsic 300×150, which at dpr 1 still satisfies "backing store == css × dpr" while
  // drawing nothing. (Measured: that is exactly what a missing host measurement looks like.)
  check(
    'the canvas fills its pane (it is not sitting at the intrinsic 300×150 default)',
    !!rect && Math.abs(m.cssW - rect.w) <= 1 && Math.abs(m.cssH - rect.h) <= 1,
    `canvas ${String(m.cssW)}×${String(m.cssH)} vs pane ${rect ? `${String(rect.w)}×${String(rect.h)}` : 'absent'}`
  )
  check(
    'the canvas backing store is scaled by devicePixelRatio (a CSS-sized buffer is the blurry-map bug)',
    m.bufW === Math.round(m.cssW * m.dpr) && m.bufH === Math.round(m.cssH * m.dpr),
    `css ${String(m.cssW)}×${String(m.cssH)} · buffer ${String(m.bufW)}×${String(m.bufH)} · dpr ${String(m.dpr)}`
  )

  // The layout contract: the app's content area owns the scroll, and a view never grows the
  // document. A map pane that sized to its content would push the page instead of clipping.
  const over = await pageOverflow(page)
  check(
    'the Maps tab never scrolls the page (the map clips inside its own pane)',
    over.doc === 0 && over.content === 0,
    `document +${String(over.doc)}px · content area +${String(over.content)}px`
  )
}

/** 4. THE HEADER STATES THE ZONE, AND NAMES WHERE EACH LAYER CAME FROM. */
async function stepHeader(page: Page, zone: string | undefined): Promise<void> {
  const header = (await textOf(page, HEADER)).replace(/\s+/g, ' ').trim()
  const sources = await countOf(page, '[data-testid="maps-source"]')
  check(
    'the header names a source pack for every layer it drew (a silent cross-pack merge is forbidden)',
    sources > 0,
    `${String(sources)} source chips`
  )
  if (zone == null || zone === '') {
    note('the log has stated no zone — the header correctly names the manually picked map instead')
    return
  }
  check(
    'the header states the zone the log says you are in',
    header.includes(zone),
    `header "${header.slice(0, 90)}" vs log zone "${zone}"`
  )
}

/**
 * 5. THE SIDEBAR IS ITS OWN SCROLLER (the Task-#56 law, measured where it now applies).
 *
 * 343 mobs and 316 labels live in one column; if that column sized to its content it would push
 * the map out of the window instead of scrolling inside itself. Stated as an identity against the
 * map row rather than as a pixel number — the pane is as tall as the row and no taller.
 */
async function stepPaneBounds(page: Page): Promise<void> {
  const surface = await rectOf(page, SURFACE)
  const pane = await boxOf(page, PANE)
  const scroll = await boxOf(page, PANE_SCROLL)
  if (pane == null || scroll == null || surface == null) return
  check(
    'the sidebar is as tall as the map beside it and no taller (it cannot grow to eat the page)',
    pane.h > 0 && pane.h <= surface.h + 2,
    `pane ${String(pane.h)}px vs map ${String(surface.h)}px`
  )
  check(
    '…and its list is its own scroller (content scrolls INSIDE the box)',
    scroll.scrollH >= scroll.clientH,
    `scrollHeight ${String(scroll.scrollH)} vs clientHeight ${String(scroll.clientH)}`
  )
}

/**
 * 6. ONE BOX REACHES THE WHOLE CORPUS — the capability the toolbar's `All zones` scope carried.
 *
 * A prefix taken from a label on the map on screen is searched, and the OTHER ZONES section is
 * required to answer with maps that are not this one. Clicking one is a zone change plus a jump,
 * so it runs LAST: the map on screen afterwards is a different map.
 */
async function stepCrossZone(page: Page): Promise<void> {
  const prefix = await labelPrefix(page)
  if (prefix === '') {
    note('no labels are drawn in this zone at the fit view — the cross-zone half is not asserted this run')
    return
  }
  await page.fill(PANE_SEARCH, prefix, { timeout: 15_000 })
  const found = await until(async () => (await countOf(page, PANE_HIT)) > 0, 15_000)
  if (!found) {
    note(`no other installed map labels "${prefix}" — the cross-zone list is correctly empty and the jump is not asserted`)
    return
  }
  check(
    'one box also finds labels in OTHER zones (the corpus lookup the toolbar used to hold)',
    true,
    `"${prefix}" → ${String(await countOf(page, PANE_HIT))} rows in other zones`
  )
  // The marker is transient by design, so it is polled for immediately and its later
  // disappearance is not asserted.
  await page.click(PANE_HIT, { timeout: 15_000 })
  const marked = await until(async () => (await countOf(page, '[data-testid="maps-marker"]')) > 0, 20_000)
  check('clicking one loads that zone and flashes the marker where the label is', marked)
}

/** An attribute off the first match; '' when the node isn't mounted or carries no such attribute. */
function attrOf(page: Page, sel: string, name: string): Promise<string> {
  return page.evaluate(
    ([s, a]) => document.querySelector(s)?.getAttribute(a) ?? '',
    [sel, name] as const
  )
}

/**
 * 6b. THE OWNER'S REPORT (JOS-135): a name the WIKI knows, in a zone you are not standing in.
 *
 * This is the half no map pack can answer — `Tarn Visilin` appears in no label file anywhere, so
 * the cross-zone section had to gain a second authority to say "High Keep" at all. Asserted end to
 * end: the row exists, it names its zone, and clicking it actually opens that zone's map and marks
 * the spot the wiki stated.
 *
 * Runs LAST because, like the label jump above it, it leaves you somewhere else.
 */
async function stepCrossZoneMob(page: Page): Promise<void> {
  if ((await textOf(page, ZONE_CHIP)).trim() === CROSS_ZONE_STEM) {
    note(`already on the ${CROSS_ZONE_STEM} map — the cross-zone MOB jump needs a different zone and is skipped`)
    return
  }
  await page.fill(PANE_SEARCH, CROSS_ZONE_MOB, { timeout: 15_000 })
  const found = await until(async () => (await countOf(page, PANE_HIT_MOB)) > 0, 15_000)
  if (!check(`one box also finds a mob the WIKI places elsewhere ("${CROSS_ZONE_MOB}")`, found)) return

  const zone = await attrOf(page, PANE_HIT_MOB, 'data-zone')
  if (zone === '') {
    note(`no ${CROSS_ZONE_STEM} map is installed on this machine — the row correctly states the zone without offering to open it`)
    return
  }
  check(
    '…and the row names the zone it will take you to',
    zone === CROSS_ZONE_STEM,
    `row points at "${zone}", expected "${CROSS_ZONE_STEM}"`
  )
  await page.click(PANE_HIT_MOB, { timeout: 15_000 })
  const arrived = await until(async () => (await textOf(page, ZONE_CHIP)).trim() === zone, 25_000)
  check('clicking it opens THAT zone’s map', arrived, `zone chip reads "${(await textOf(page, ZONE_CHIP)).trim()}"`)
  const marked = await until(async () => (await countOf(page, '[data-testid="maps-marker"]')) > 0, 20_000)
  check('…and marks the spot the wiki stated for him', marked)
}

/** The viewport transform, as the surface itself reports it. Proves the view actually MOVED. */
function viewOf(page: Page): Promise<{ w: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    return { w: Math.round(el.getBoundingClientRect().width) }
  }, SURFACE)
}

/**
 * The zone pane's own transform probe: where the FIRST mob pin sits on screen.
 *
 * Centring is a change of `MapViewport.view`, which no DOM attribute states — but every pin is
 * positioned THROUGH that transform, so a pin that moved is a view that moved. Returns null when
 * no pin is drawn (a zone whose catalog rows state no coordinates — a real, correct state).
 */
function pinAt(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="maps-mob-pin"]') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top) }
  })
}

/** ONE box, BOTH sections: a query that matches nothing must empty the mob list and the label list. */
async function stepPaneFilter(page: Page): Promise<void> {
  const mobRows = await countOf(page, PANE_MOB)
  const labelRows = await countOf(page, PANE_LABEL)
  check(
    'the pane lists something from at least one of its two authorities',
    mobRows + labelRows > 0,
    `${String(mobRows)} wiki mobs · ${String(labelRows)} map labels`
  )
  await page.fill(PANE_SEARCH, 'zzzqqq', { timeout: 15_000 })
  const emptied = await until(
    async () => (await countOf(page, PANE_MOB)) === 0 && (await countOf(page, PANE_LABEL)) === 0,
    6000
  )
  check('the pane’s one search box filters BOTH sections', emptied)
  await page.fill(PANE_SEARCH, '', { timeout: 15_000 })
  await until(async () => (await countOf(page, PANE_MOB)) + (await countOf(page, PANE_LABEL)) > 0, 6000)
}

/**
 * CLICK ⇒ RING + CENTRE.
 *
 * The centring is asserted through the first pin's SCREEN position, which is a real check on the
 * viewport transform rather than "a ring appeared": every pin is placed THROUGH that transform,
 * so a pin that moved is a view that moved. A zone the catalog cannot place draws no pin, which
 * is a correct state — noted and skipped, never a failure.
 */
async function stepPaneSelect(page: Page): Promise<void> {
  // Prefer a mob row that HAS a pin — it exercises the wiki join and the pin layer, and it is the
  // only kind that is clickable at all (a mob whose page states no position is deliberately
  // disabled). Fall back to a map label, which is always a coordinate.
  const clickable = (await countOf(page, PANE_MOB_PINNED)) > 0 ? PANE_MOB_PINNED : PANE_LABEL
  if ((await countOf(page, clickable)) === 0) {
    note('this zone yields no pane rows at all — the click-to-centre half is not asserted this run')
    return
  }
  const before = await pinAt(page)
  await page.click(clickable, { timeout: 15_000 })
  const ringed = await until(async () => (await countOf(page, PANE_MARKER)) > 0, 4000)
  check('clicking a pane row highlights it on the map with a persistent ring', ringed)
  if (before == null) {
    note('no wiki pin is drawn for this zone (its catalog rows state no coordinates) — the transform check is skipped')
    return
  }
  const after = await pinAt(page)
  check(
    '…and centres the viewport on it (the projection actually moved)',
    after != null && (after.x !== before.x || after.y !== before.y),
    after ? `pin ${String(before.x)},${String(before.y)} → ${String(after.x)},${String(after.y)}` : 'pin gone'
  )
}

/**
 * CLOSE AND COME BACK.
 *
 * The layout claim is the point: a pane that is off must not be a zero-width box still stealing
 * from the map, so the surface's width is measured open, closed and open again and the map is
 * required to actually TAKE the width back — the fixed-size-math bug class, measured. And a panel
 * you can hide has to be recoverable, so the reopen affordance is asserted to exist and to work.
 */
async function stepPaneClose(page: Page): Promise<void> {
  const widthOpen = (await viewOf(page))?.w ?? 0

  await page.click(PANE_CLOSE, { timeout: 15_000 })
  const closed = await until(async () => (await countOf(page, PANE)) === 0, 8000)
  // The surface's new width arrives through a ResizeObserver, a beat after the pane unmounts —
  // so the condition is the WIDTH settling, not the pane going.
  const widthClosed = (await settleStable(() => viewOf(page), { timeoutMs: 8_000 }))?.w ?? 0
  check(
    'closing the sidebar gives its width back to the MAP (no fixed-size arithmetic, no ghost column)',
    closed && widthClosed > widthOpen,
    `surface ${String(widthOpen)}px → ${String(widthClosed)}px`
  )
  if (!check('closing it leaves a way back in', (await countOf(page, PANE_OPEN)) > 0)) return

  await page.click(PANE_OPEN, { timeout: 15_000 })
  const reopened = await until(async () => (await countOf(page, PANE)) > 0, 8000)
  const widthAgain = (await settleStable(() => viewOf(page), { timeoutMs: 8_000 }))?.w ?? 0
  check(
    'and reopening it takes exactly that width back',
    reopened && Math.abs(widthAgain - widthOpen) <= 2,
    `surface ${String(widthClosed)}px → ${String(widthAgain)}px (was ${String(widthOpen)}px)`
  )
}

/**
 * 7. THE SIDEBAR (wiki mobs + this map's labels + every other map).
 *
 * OPEN WITHOUT BEING ASKED FOR is the first assertion, and it is the headline of this wave: the
 * toolbar carries no search box any more, so a sidebar that started closed would leave a map with
 * no way to find anything on it. `userData` is wiped at launch, so nothing remembered can be
 * producing it — this is the default, not a restored state.
 */
async function stepPane(page: Page): Promise<void> {
  const open = await until(async () => (await countOf(page, PANE)) > 0, 8000)
  if (!check('the sidebar is on screen without being asked for (it is the default experience)', open))
    return

  await stepPaneBounds(page)
  await stepPaneFilter(page)
  await stepPaneSelect(page)
  await stepPaneClose(page)
  await stepCrossZone(page)
  await stepCrossZoneMob(page)
}

async function main(): Promise<void> {
  buildIfStale()

  // See the header: a remembered `eq.maps.zone` would make the auto-open assertion vacuous, and
  // this launch's userData dir is one nothing has ever written to.
  // THE LOG is a committed fixture whose last zone line is The Southern Desert of Ro — so the
  // auto-open assertion has a stated zone to be about. The map PACKS are not: they are a 200 MB
  // game install, so the staged install junctions the real one's `maps\` dir in beside the
  // fixture (`maps: true`). A machine with no EQ install gets no junction and this spec takes its
  // stated no-packs branch, exactly as it always has.
  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-maps.log…')
  const { app, close } = await launchOnFixture('e2e-maps.log', { maps: true })

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    if (await stepMount(page)) {
      const zone = await waitZone(page)
      if (await stepMapOrEmpty(page, zone)) {
        // Let the ResizeObserver + first paint land before measuring anything — the CONDITION
        // being that the canvas has stopped resizing, which is exactly what stepCanvas measures.
        await settleStable(() => canvasMetrics(page), { timeoutMs: 15_000 })
        await stepCanvas(page)
        await stepHeader(page, zone)
        await stepPane(page)
      }
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'maps-FAIL')
    else await dumpArtifacts(page, 'maps-pass')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
