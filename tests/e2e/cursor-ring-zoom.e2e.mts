/**
 * Headless Electron integration test for the CURSOR RING's ZOOM PIN (JOS-154).
 *
 * THE DEFECT. Changing the app's text size (`uiScale`, JOS-123) moved the cursor ring off the
 * pointer. The ring's CSS pixels are a COORDINATE SYSTEM — main sends a DIP offset from the ring
 * window's own origin and the renderer uses it as a CSS translation — so a zoomed ring window
 * draws a point p at p*z, drifting further the further the pointer is from the window's top-left.
 * The zoom got there through CHROMIUM rather than through this app's wiring: `setZoomFactor`
 * stores a zoom PER HOST, and in development every page comes from the one dev-server host. The
 * fix is `webFrame.setZoomLevel(0)` in `src/preload/cursor.ts` (a per-view TEMPORARY zoom, the one
 * zoom API that is not the shared entry) — the full argument is that file's header.
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST. `tests/cursorRingZoom.test.mts` pins the wiring as
 * source: the pin exists, it uses webFrame rather than the host-level setter, and no window
 * factory has grown a second opinion about which window carries the text size. Neither of the
 * claims that matter is decidable there, because both are claims about a running Chromium:
 *
 *   1. THE PIN ACTUALLY REFUSES AN INHERITED ZOOM. A window built on the app's real cursor
 *      preload is put in the same shared zoom entry as a bare twin, the twin is zoomed, and the
 *      pinned one has to stay at 1.0 — while the twin moves, so the pressure was real.
 *   2. A PINNED WINDOW CENTRES THE HALO ON THE POINT IT WAS SENT, at more than one ring size and
 *      at a point far from the window's origin (where the error was largest). Measured off the
 *      real `#ring` element's box, converted back to DIP through the window's own zoom factor.
 *   3. …AND THE MEASUREMENT CAN SEE THE DEFECT. The last step forces that same window to the zoom
 *      it used to inherit and re-reads it: the halo lands 25% of its distance from the corner
 *      away from the pointer. Without that step every centring check above could be passing
 *      against a ring that never moved at all.
 *
 * TWO MECHANICS WORTH KNOWING BEFORE READING THE CODE, both measured here. A never-shown window
 * that has pinned its zoom produces NO animation frames until something asks for one, so the ring
 * never paints and `capturePage()` is what borrows the frame (the same fact JOS-120 rests on:
 * a hidden window does not composite, which is why every park happens while it is still visible).
 * And `evaluate` bodies carry no local named functions, because tsx rewrites those into a helper
 * that does not exist in the process the callback is shipped to.
 *
 * WHAT IT CANNOT SEE, stated rather than implied. There is no EverQuest in a headless test, so
 * `presenceEffects.ts` never creates the REAL ring window (the cursor-ring-color spec names the
 * same gap). These are windows this spec builds itself — but on the app's OWN built preload and
 * its OWN cursor.html, driven over the app's OWN IPC channels, so everything under test is the
 * shipped code. And the e2e build loads over `file:`, where each page's whole spec is its zoom
 * key, so the dev server's host sharing cannot be reproduced directly; the shared entry is
 * reached the way THIS build can reach it, by putting both windows on the same URL. That is the
 * same mechanism, entered through a different door.
 *
 * Run: `npm run test:e2e -- cursor-ring-zoom`
 */
import { dirname, join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import {
  MAIN_ENTRY,
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleGone
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
import { IPC } from '../../src/shared/ipc'
import { DEFAULT_RING_THICKNESS_PX } from '../../src/shared/presencePrefs'

/** The built ring page and its preload, out of the same out-e2e/ tree the app under test is
 *  running from — never a source path, or this would be testing something nobody ships. */
const OUT = dirname(dirname(MAIN_ENTRY))
const RING_PAGE = join(OUT, 'renderer', 'cursor.html')
const RING_PRELOAD = join(OUT, 'preload', 'cursor.js')

/** The probe windows' size. Big enough that a far point is genuinely far from the origin. */
const PROBE_W = 1000
const PROBE_H = 700

/** The zoom a poisoned twin writes into the shared entry. A stop on the real text-size ladder. */
const POISON = 1.25
/** The text size the main window is driven to at the end, through the app's own IPC. */
const CHOSEN = 1.25

/** A point near the origin and a point far from it: the error was proportional to the distance,
 *  so a spec that only ever looked near the corner would have passed while the ring was wrong. */
const NEAR = { x: 60, y: 40 }
const FAR = { x: 912, y: 604 }

/** Two ring sizes, both even so the radius is a whole pixel and the expected centre is exact. */
const SIZES = [40, 96]

/** What one probe window reports about the halo it just drew. */
interface RingReading {
  /** The window's own zoom factor, as Chromium reports it. */
  zoom: number
  /** Centre of the `#ring` box, in the page's CSS pixels. */
  cx: number
  /** Same, vertically. */
  cy: number
  /** The box's width in CSS px — the ring's size as drawn. */
  w: number
}

/**
 * Build the two probe windows and stash them on the main process's globalThis so later calls can
 * find them again. Returns each one's starting zoom.
 *
 * The bare twin exists to make every assertion here falsifiable: it is the same page with the
 * same page script and no pin, so whatever it does is what the ring did before this ticket.
 */
function createProbes(app: ElectronApplication): Promise<Record<'pinned' | 'bare', number>> {
  return app.evaluate(
    async ({ BrowserWindow }, o) => {
      // NO LOCAL HELPER FUNCTIONS IN ANY `evaluate` BODY IN THIS FILE. Playwright ships the
      // callback to the other process as SOURCE, and the tsx/esbuild transform that runs this
      // spec rewrites `const f = () => {}` into `__name(...)` — a helper that exists only in this
      // process. The measured symptom is `ReferenceError: __name is not defined` at the first
      // evaluate. Arrow functions passed as ARGUMENTS are untouched, which is why the setTimeout
      // promises below are fine. So: flat loops, no named locals that hold a function.
      type W = InstanceType<typeof BrowserWindow>
      const built: W[] = []
      for (const preload of [o.preload, '']) {
        const w = new BrowserWindow({
          show: false,
          width: o.width,
          height: o.height,
          frame: false,
          transparent: true,
          webPreferences: {
            contextIsolation: true,
            sandbox: false,
            ...(preload === '' ? {} : { preload })
          }
        })
        await w.loadFile(o.page)
        built.push(w)
      }
      // The page applies its stored config on mount, which is the first thing that gives #ring a
      // width. Waiting for it here means a later config push cannot be overtaken by it.
      for (const w of built) {
        for (let i = 0; i < 100; i++) {
          const ok = (await w.webContents.executeJavaScript(
            `document.getElementById('ring').style.width !== ''`
          )) as boolean
          if (ok) break
          await new Promise((r) => setTimeout(r, 150))
        }
      }
      const pinned = built[0] as W
      const bare = built[1] as W
      ;(globalThis as unknown as { __jos154?: { pinned: W; bare: W } }).__jos154 = { pinned, bare }
      return { pinned: pinned.webContents.getZoomFactor(), bare: bare.webContents.getZoomFactor() }
    },
    { page: RING_PAGE, preload: RING_PRELOAD, width: PROBE_W, height: PROBE_H }
  )
}

/**
 * Push a ring config and a cursor point over the app's real IPC channels to THE PINNED WINDOW,
 * then read back where the halo landed.
 *
 * ONLY THE PINNED ONE, because only it has a bridge: the bare twin is built without a preload on
 * purpose (that is the single variable between them), so `window.eqCursor` is undefined there and
 * the page it loads subscribes to nothing. The twin's whole job is the zoom question. The
 * DEFECT is demonstrated at the end of the spec instead, by forcing the pinned window itself to
 * the zoom it used to inherit — same window, same bridge, one property different.
 */
function readRing(
  app: ElectronApplication,
  cfg: { sizePx: number; thicknessPx: number },
  point: { x: number; y: number }
): Promise<RingReading> {
  return app.evaluate(
    async (_electron, o) => {
      // Flat loops, no named local functions — see the note in `createProbes`.
      type W = Electron.BrowserWindow
      interface Box {
        cx: number
        cy: number
        w: number
      }
      const held = (globalThis as unknown as { __jos154: { pinned: W; bare: W } }).__jos154
      const READ = `(() => { const r = document.getElementById('ring').getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width } })()`
      {
        const w = held.pinned
        w.webContents.send(o.configChannel, {
          enabled: true,
          sizePx: o.sizePx,
          thicknessPx: o.thicknessPx,
          colorHex: '#ffffff'
        })
        w.webContents.send(o.pointChannel, { x: o.x, y: o.y })
        // THE PAINT is what this waits for, and its signal is the page's OWN units: whatever the
        // window's zoom, `cursorRing.ts` translates by the number it was handed, so the CSS centre
        // lands on it. The DIP conversion — the thing this spec is actually asserting — is
        // deliberately NOT part of the wait, or the wait would be the assertion.
        //
        // `capturePage()` IS THE FRAME. The ring paints in a `requestAnimationFrame`, and a
        // never-shown window that has pinned its zoom gets no frames at all until something asks
        // for one (measured: without the capture the transform sat at its parked -9999 for 21 s;
        // one capture and it lands). That is the same fact JOS-120 is built on — a hidden window
        // does not composite, which is why every park in presenceEffects.ts happens while the
        // window is still visible — so this is the harness borrowing a frame, not a workaround for
        // anything a player can reach.
        let last = (await w.webContents.executeJavaScript(READ)) as Box
        for (let i = 0; i < 20; i++) {
          if (
            Math.abs(last.w - o.sizePx) < 0.75 &&
            Math.abs(last.cx - o.x) < 0.75 &&
            Math.abs(last.cy - o.y) < 0.75
          ) {
            break
          }
          await w.webContents.capturePage()
          await new Promise((r) => setTimeout(r, 150))
          last = (await w.webContents.executeJavaScript(READ)) as Box
        }
        return { zoom: w.webContents.getZoomFactor(), ...last }
      }
    },
    {
      configChannel: IPC.onCursorRingConfig,
      pointChannel: IPC.onCursorPoint,
      sizePx: cfg.sizePx,
      thicknessPx: cfg.thicknessPx,
      x: point.x,
      y: point.y
    }
  )
}

/**
 * Zoom ONE of the probe windows with the host-level setter and answer with both zooms.
 *
 * Against the BARE twin this poisons the entry the two windows share, which is the pressure the
 * pin has to refuse. Against the PINNED one it is the opposite errand: the host setter finds a
 * temporary level already registered for that view and updates THAT instead of the shared entry,
 * so it zooms exactly one window and gives the spec a live ring at the wrong scale to measure.
 */
function forceZoom(
  app: ElectronApplication,
  which: 'pinned' | 'bare',
  factor: number
): Promise<Record<'pinned' | 'bare', number>> {
  return app.evaluate(
    async (_electron, o) => {
      type W = Electron.BrowserWindow
      const held = (globalThis as unknown as { __jos154: { pinned: W; bare: W } }).__jos154
      const target = held[o.which]
      target.webContents.setZoomFactor(o.factor)
      for (let i = 0; i < 60; i++) {
        if (Math.abs(target.webContents.getZoomFactor() - o.factor) < 0.001) break
        await new Promise((r) => setTimeout(r, 100))
      }
      return {
        pinned: held.pinned.webContents.getZoomFactor(),
        bare: held.bare.webContents.getZoomFactor()
      }
    },
    { which, factor }
  )
}

/** The MAIN window's zoom and the pinned probe's, read together after a text-size write. */
interface ZoomPair {
  main: number
  pinned: number
}

function zoomsAfterTextSize(app: ElectronApplication): Promise<ZoomPair> {
  return app.evaluate(({ BrowserWindow }) => {
    type W = InstanceType<typeof BrowserWindow>
    const held = (globalThis as unknown as { __jos154: { pinned: W; bare: W } }).__jos154
    // The app window is the one showing index.html; the probes are on cursor.html and every
    // overlay carries a `?kind=` query on overlay.html.
    const app0 = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('index.html')
    )
    return {
      main: app0 ? app0.webContents.getZoomFactor() : -1,
      pinned: held.pinned.webContents.getZoomFactor()
    }
  })
}

function destroyProbes(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    type W = Electron.BrowserWindow
    const g = globalThis as unknown as { __jos154?: { pinned: W; bare: W } }
    for (const w of [g.__jos154?.pinned, g.__jos154?.bare]) if (w && !w.isDestroyed()) w.destroy()
    delete g.__jos154
  })
}

/** Answer the analytics first-run notice — the text-size / cursor-ring-colour helper. It is the
 *  ONLY click this spec makes, and it happens before anything touches a zoom (see `main`). */
async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  await settleGone(page, notice, { timeoutMs: 8_000 })
}

/** DIP is what main measured the pointer in; CSS px is what the page drew in. One multiply. */
const toDip = (cssValue: number, zoom: number): number => cssValue * zoom

/** The centring assertion, for one window at one size and one point. */
function checkCentred(
  label: string,
  r: RingReading,
  point: { x: number; y: number },
  sizePx: number
): void {
  const dx = toDip(r.cx, r.zoom) - point.x
  const dy = toDip(r.cy, r.zoom) - point.y
  check(
    `${label}: the halo's centre IS the point main sent (${String(point.x)}, ${String(point.y)}) at ${String(sizePx)}px`,
    Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75,
    `off by (${dx.toFixed(2)}, ${dy.toFixed(2)}) DIP at zoom ${r.zoom.toFixed(3)}`
  )
}

async function stepCentredAtEverySize(app: ElectronApplication, when: string): Promise<void> {
  for (const sizePx of SIZES) {
    for (const point of [NEAR, FAR]) {
      const r = await readRing(app, { sizePx, thicknessPx: DEFAULT_RING_THICKNESS_PX }, point)
      checkCentred(when, r, point, sizePx)
      check(
        `…and it is drawn at the ${String(sizePx)}px it was asked for`,
        Math.abs(r.w - sizePx) < 0.75,
        `${r.w.toFixed(2)} CSS px`
      )
    }
  }
}

async function main(): Promise<void> {
  buildIfStale()
  const consoleErrors: string[] = []

  const launch = await launchOnFixture('e2e-telemetry.log')
  try {
    const page = await mainWindow(launch.app)
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))
    // EVERY CLICK HAPPENS FIRST, ON PURPOSE. windows.ts's landmine: a `setZoomFactor` after page
    // load leaves a never-composited window in a state where Playwright's actionability check
    // ("visible, enabled and stable") does not complete. This spec zooms windows deliberately, so
    // it does its one click before any of that and drives the app by `evaluate` afterwards.
    await dismissFirstRunNotice(page)

    const born = await createProbes(launch.app)
    check(
      'both probe windows start at 100% — the pin is not a zoom of its own',
      Math.abs(born.pinned - 1) < 0.001 && Math.abs(born.bare - 1) < 0.001,
      `pinned ${String(born.pinned)} / bare ${String(born.bare)}`
    )

    await stepCentredAtEverySize(launch.app, 'at 100%')

    // ---- THE FIX, measured: the shared zoom entry is poisoned and the pin has to refuse it ----
    const after = await forceZoom(launch.app, 'bare', POISON)
    check(
      'a bare twin on the same URL takes the zoom — the entry really is shared, so the next check is not vacuous',
      Math.abs(after.bare - POISON) < 0.001,
      `bare ${String(after.bare)}`
    )
    check(
      "THE PIN HOLDS: the window built on the app's cursor preload stays at 100%",
      Math.abs(after.pinned - 1) < 0.001,
      `pinned ${String(after.pinned)}`
    )

    await stepCentredAtEverySize(launch.app, 'with the shared entry at 125%')

    // ---- and the user's own action: the real text-size handler, through the real IPC ----
    await page.evaluate(
      (scale) =>
        (window as unknown as { eq: { setUiScale: (s: number) => Promise<number> } }).eq.setUiScale(
          scale
        ),
      CHOSEN
    )
    const zooms = await settle(
      () => zoomsAfterTextSize(launch.app),
      (z) => Math.abs(z.main - CHOSEN) < 0.001,
      { timeoutMs: 15_000 }
    )
    check(
      'setting the app text size zooms the MAIN window',
      Math.abs(zooms.main - CHOSEN) < 0.001,
      `main ${String(zooms.main)}`
    )
    check(
      '…and leaves the ring window exactly where it was',
      Math.abs(zooms.pinned - 1) < 0.001,
      `ring ${String(zooms.pinned)}`
    )

    // ---- LAST, AND ONLY LAST: reproduce the defect in the very window that was just proved ----
    // The host-level setter aimed at a view that already holds a temporary level updates THAT
    // level, so this zooms one window and nothing else. Same page, same bridge, same point — the
    // one difference is the scale the halo is drawn at, and the halo goes where the pointer is
    // not. Without this the whole spec could pass against a ring that never moved at all.
    await forceZoom(launch.app, 'pinned', POISON)
    const wrong = await readRing(
      launch.app,
      { sizePx: SIZES[0] ?? 40, thicknessPx: DEFAULT_RING_THICKNESS_PX },
      FAR
    )
    const drift = toDip(wrong.cx, wrong.zoom) - FAR.x
    check(
      'forced to the zoom it used to inherit, the SAME ring lands well off the pointer — the defect, reproduced',
      Math.abs(wrong.zoom - POISON) < 0.001 && Math.abs(drift - FAR.x * (POISON - 1)) < 2,
      `${drift.toFixed(1)} DIP right of the pointer at zoom ${wrong.zoom.toFixed(3)}`
    )

    if (failures.length) await dumpArtifacts(page, 'cursor-ring-zoom-FAIL')
    await destroyProbes(launch.app)
  } finally {
    await launch.close()
  }

  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (consoleErrors.length === 0) {
    note('one page, one URL, one bridge — the only variables were the preload and the zoom')
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
