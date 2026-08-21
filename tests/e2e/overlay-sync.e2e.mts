/**
 * Headless Electron test for the two CROSS-WINDOW rulings of
 * docs/plans/combat-overlay-parity.md — P4/P5/P6 (fight selection is GLOBAL) and P3 (a LOCKED
 * overlay keeps its selector) — and, since JOS-40, for HOW THE OVERLAY WINDOWS ARE BUILT: the
 * opaque-overlay compatibility mode (an overlay reopened without transparency is still an
 * overlay, in both modes) and graphics safe mode (a third launch, because
 * `disableHardwareAcceleration` is decided before Electron is ready). Both live here because
 * both are claims about the window this spec already owns.
 *
 * SINCE JOS-121 it also owns the meter title bar's BUDGET. The scope word left that row for the
 * panel floor, and "the freed width went to the fight selector and to the drag surface" is a
 * geometry claim about a real window at a real width with a real mob name in its title — so
 * `stepTitleBarRoom` MEASURES it, reconstructing the old row in place to have something to
 * measure against.
 *
 * WHAT ONLY THE REAL APP CAN SHOW. The pure halves are pinned elsewhere: the value model and the
 * one-seam wiring in tests/fightSelection.test.mts, the locked-selector mechanism in
 * tests/overlayLockedSelector.test.mts. What no unit test can claim is that the PIECES ARE WIRED
 * ACROSS PROCESSES — that a pick in the Combat tab crosses main and lands in a floating overlay's
 * own renderer, that the reverse works, that a zone-session id offered to the same door is
 * REFUSED, and that a locked overlay still renders a working selector while its bars do not.
 *
 * NO WINDOW IS EVER SHOWN. `EQ_E2E=1` is the whole test mode (src/main/e2e.ts): the main window
 * never shows and overlays skip `showInactive`, so the fight overlay here is created, loaded and
 * driven entirely off-screen while the user plays.
 *
 * IT DRIVES THE BRIDGES, NOT A CURSOR. A hidden, always-on-top window has no pointer, so the
 * selection half goes through the REAL `window.eq` / `window.eqOverlay` calls the selectors
 * themselves make — the same channels, the same validation in main. For the LOCKED half the
 * honest limit is stated in the assertions: this harness cannot make Windows deliver a forwarded
 * mouse event to a hidden window, so it asserts the two things it CAN see — that the selector is
 * rendered and interactive while locked, and that the header's hover sensor really does flip the
 * window's capture state (the lock/close controls reveal only when it has) — and it asserts the
 * click-through half NEGATIVELY, by checking the meter's bars offer no pointer at all.
 *
 * Assertions are identities/floors against whatever the live log contains right now — never
 * today's numbers (AGENTS.md: frozen numbers rot).
 *
 * Run: `npm run test:e2e` (or `node --import tsx tests/e2e/overlay-sync.e2e.mts`).
 */
import type { ElectronApplication, Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleCount,
  settleStable,
  sleep,
  snapshot,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow, makeUserData, overlayWindow, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'
// The scope word's own two steps — where it lives (JOS-115/121) and what the title bar did with
// the room it gave back — in their own module, because this file is at the max-lines budget.
import { stepOverlayScope, stepTitleBarRoom } from './overlayScopeSteps.mjs'
// …and JOS-158's: the aggregate left that row too, for the panel's own header row, and what the
// fight NAME did with the pixels is measured in characters there.
import { stepTotalOnPanel } from './overlayTotalSteps.mjs'
// …and the pinned pane's scroll grip (JOS-138), in its own module for the same reason.
import { stepPinnedScroll } from './overlayScrollSteps.mjs'
// …and JOS-381's: the capture that has to end itself when the cursor walks off under the alt-tab
// switcher, plus the timer that may only exist while it is held.
import { stepPointerWatch } from './overlayPointerWatchSteps.mjs'
// THE FLOOR A WINDOW CAN BE DRAGGED DOWN TO (JOS-278) — its own module, beside the other steps,
// because the claim is about the window rather than about this spec's subject.
import { stepMinimumSize } from './overlayMinSizeSteps.mjs'
// …and JOS-187's: an overlay whose monitor went away, and the rule that the store keeps the
// rectangle the user chose while the screen gets the one that fits.
import { stepOverlayDisplay } from './overlayDisplaySteps.mjs'
// …and JOS-258's: the one-sentence nudge for a summoned pet nothing has bound, which lives on this
// same window's content background and takes itself off again.
import { stepPetNudge } from './overlayPetNudgeSteps.mjs'

/** The overlay open-state this spec's second launch runs against (`overlays.fight` in the store). */
interface OverlayBridge {
  getOverlayState: () => Promise<Record<string, boolean>>
  toggleOverlay: (k: string) => Promise<boolean>
}

function overlayState(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() =>
    (window as unknown as { eq: OverlayBridge }).eq.getOverlayState()
  )
}

/** The sentinel every fight-scoped surface starts on (shared/fightSelection.ts). */
const LIVE = '__live__'

interface FightBridge {
  getFightSelection: () => Promise<string>
  setFightSelection: (id: string) => void
}

/** Read the global selection through a window's own bridge — main app or overlay alike. */
function readSelection(page: Page, bridge: 'eq' | 'eqOverlay'): Promise<string> {
  return page.evaluate(
    (b) => (window as unknown as Record<string, FightBridge>)[b].getFightSelection(),
    bridge
  )
}

/** Write it through a window's own bridge, exactly as that window's selector does. */
function writeSelection(page: Page, bridge: 'eq' | 'eqOverlay', id: string): Promise<void> {
  return page.evaluate(
    ([b, v]) => {
      ;(window as unknown as Record<string, FightBridge>)[b].setFightSelection(v)
    },
    [bridge, id] as const
  )
}

/** The overlay page for one kind — `overlayWindow` in ./appWindow.mts, beside `mainWindow`,
 *  because "which window is the one I mean" is one question and it is answered there. */
const waitForOverlay = overlayWindow

/**
 * Write the global selection through a window's own bridge and WAIT for the other window to have
 * it — which is the whole claim this spec exists to make.
 *
 * Every one of the cross-window steps used to `sleep(600)` here and then read. That is a bet on
 * how long a renderer→main→renderer round trip takes on a machine already running four Electron
 * apps; this is the round trip's own completion.
 */
async function writeAndSync(
  from: readonly [Page, 'eq' | 'eqOverlay'],
  to: readonly [Page, 'eq' | 'eqOverlay'],
  id: string
): Promise<string> {
  await writeSelection(from[0], from[1], id)
  return settle(() => readSelection(to[0], to[1]), (v) => v === id, { timeoutMs: 10_000 })
}

/** A real finalized fight id from the live log, or null when the log holds none. */
async function someFinalizedFight(page: Page): Promise<string | null> {
  const snap = await snapshot(page)
  return snap.segments.find((s) => s.kind === 'fight')?.id ?? null
}

/**
 * The LONGEST fight name the staged fixture produced — the hardest title this window will ever be
 * asked to print, and the subject of JOS-158's measurement. A real name from a real replay rather
 * than a hand-authored one, so what is measured is a title bar doing its actual job.
 */
async function longestFightName(page: Page): Promise<string> {
  const snap = await snapshot(page)
  const names = snap.segments.filter((s) => s.kind === 'fight').map((s) => s.name)
  return names.sort((a, b) => b.length - a.length)[0] ?? ''
}

// ── P4/P5/P6: the selection crosses windows ─────────────────────────────────────────────

async function stepBothStartLive(app: Page, overlay: Page): Promise<void> {
  check('the app starts on the LIVE sentinel (ephemeral — a fresh launch pins nothing)',
    (await readSelection(app, 'eq')) === LIVE)
  check('…and an overlay opened afterwards HYDRATES to the same value',
    (await readSelection(overlay, 'eqOverlay')) === LIVE)
}

async function stepPanelMovesOverlay(app: Page, overlay: Page, fightId: string): Promise<void> {
  const landed = await writeAndSync([app, 'eq'], [overlay, 'eqOverlay'], fightId)
  check('picking a fight in the COMBAT PANEL moves the fight overlay (ruling 4)', landed === fightId, landed)
  // …and the overlay actually RENDERS that fight, not just knows about it: its header title is
  // the selected segment's own name, so a stuck header would mean the selection never reached
  // the meter. The name itself is fixture-dependent, so the claim is "not the empty state".
  const title = await settleStable(
    () => overlay.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim()),
    { timeoutMs: 8_000 }
  )
  check('…and the overlay renders a fight rather than its empty state', !title.includes('No fight'), title.slice(0, 120))
}

async function stepOverlayMovesPanel(app: Page, overlay: Page): Promise<void> {
  const landed = await writeAndSync([overlay, 'eqOverlay'], [app, 'eq'], LIVE)
  check('and the reverse: picking in the OVERLAY moves the combat panel', landed === LIVE, landed)
}

/**
 * THE CARVE-OUT, at the seam. "Overall (zone-session) selection stays per-overlay" is only true
 * if a zone id physically cannot become the global — main validates rather than trusting the
 * renderer, so offering one here must change nothing at all.
 */
async function stepZoneIdRefused(app: Page, overlay: Page, fightId: string): Promise<void> {
  await writeAndSync([app, 'eq'], [overlay, 'eqOverlay'], fightId)
  for (const bogus of ['zone', 'zs1', '', 'not-a-fight']) {
    await writeSelection(overlay, 'eqOverlay', bogus)
  }
  // NOTHING is supposed to move, so the positive signal is the pair of readings holding still —
  // which is also proof the four refusals have been round-tripped and dropped.
  const pair = await settleStable(
    async () => `${await readSelection(app, 'eq')} / ${await readSelection(overlay, 'eqOverlay')}`,
    { timeoutMs: 8_000, stable: 5, pollMs: 150 }
  )
  check(
    'a ZONE-SESSION id offered to the global selection is refused — the fight stays put',
    pair === `${fightId} / ${fightId}`,
    pair
  )
}

/** P6: a well-formed id the engine has never heard of must degrade, not blank the surface. */
async function stepStaleId(app: Page, overlay: Page): Promise<void> {
  const landed = await writeAndSync([app, 'eq'], [overlay, 'eqOverlay'], 'e999999')
  check('a STALE fight id is kept (P6 — the global is never cleared by a surface)', landed === 'e999999', landed)
  const title = await settleStable(
    () => overlay.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim()),
    { timeoutMs: 8_000 }
  )
  check(
    '…and the overlay degrades to the engine’s default rather than going blank',
    title.length > 0 && !title.includes('No fight'),
    title.slice(0, 120)
  )
}

// ── P3: a locked overlay keeps its selector ─────────────────────────────────────────────

/** The selector trigger, by the ARIA contract OverlayHeader renders. */
const TRIGGER = '[aria-haspopup="listbox"]'

/**
 * The footer's background-opacity slider — the piece of chrome that is present IFF the overlay is
 * interactive, and therefore the observable of the lock flip.
 *
 * It used to be the header's scope readout, which JOS-121 moved to the panel floor and (unlike a
 * lock/close button) deliberately does NOT hide while locked: it is a watermark you read, not
 * chrome you reach for, and a pinned meter is exactly the one with nothing else left to explain a
 * missing name. So the lock needed a different tell, and the footer is the honest one — it holds
 * the controls that only an interactive window can use.
 */
const FOOTER_SLIDER = 'input[type="range"]'

/** Set the lock and wait for the overlay's own chrome to reflect it — the observable of the flip. */
async function setLocked(overlay: Page, locked: boolean): Promise<void> {
  await overlay.evaluate((v) => {
    ;(window as unknown as { eqOverlay: { setLocked: (b: boolean) => void } }).eqOverlay.setLocked(v)
  }, locked)
  await settle(() => countOf(overlay, FOOTER_SLIDER), (n) => (locked ? n === 0 : n === 1), {
    timeoutMs: 10_000
  })
}

async function stepLockedSelector(overlay: Page): Promise<void> {
  // The lock is PERSISTED per kind, so start from a known mode rather than from whatever the
  // last run (or the user's own dev app) left behind.
  await setLocked(overlay, false)
  check('an INTERACTIVE overlay offers its selector', (await countOf(overlay, TRIGGER)) === 1)

  await setLocked(overlay, true)

  // THE RULING: locked, and the top selector row is still there. Before P3 this was 0.
  check('a LOCKED overlay STILL offers its selector (ruling 3)', (await countOf(overlay, TRIGGER)) === 1)

  // …and the rest is click-through: with no drill setter the BARS render no pointer at all, which
  // is the DOM-visible half of "everything else stays click-through". Measured on the bars box
  // alone, because the selector row above it is SUPPOSED to be a pointer — that is the ruling.
  // The window-level half (setIgnoreMouseEvents) cannot be observed from a hidden window; the
  // next assertion is the closest proxy this harness can honestly get to it.
  const pointers = await overlay.evaluate(() =>
    [...document.querySelectorAll('[data-testid="overlay-bars"] *')].filter(
      (el) => getComputedStyle(el).cursor === 'pointer'
    ).length
  )
  check('…while its BARS offer no click target at all (locked stays click-through)', pointers === 0, `${pointers} pointer element(s)`)

  // The hover sensor: entering the HEADER ROW is what asks main to stop ignoring mouse events,
  // and the lock/close controls reveal only once that capture has been taken. So their appearance
  // is the observable proof the P3 path ran — on the header, and only there.
  //
  // It is dispatched as a BUBBLING `mouseover` from outside, not as `mouseenter`: React 17+
  // synthesises enter/leave at the root from mouseover/mouseout, so a directly-dispatched
  // non-bubbling `mouseenter` reaches no handler at all (it silently did nothing here first).
  const countButtons = (): Promise<number> => overlay.evaluate(() => document.querySelectorAll('button').length)
  const before = await countButtons()
  await overlay.evaluate(() => {
    const row = document.querySelector('[aria-haspopup="listbox"]')?.parentElement
    row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
  })
  // The reveal is what the hover is FOR — the controls appearing is the condition, and it crosses
  // into main (setIgnoreMouseEvents) and back before it can happen.
  const after = await settle(countButtons, (n) => n > 0, { timeoutMs: 8_000 })
  check(
    '…and hovering the selector ROW captures the mouse (its controls reveal)',
    before === 0 && after > 0,
    `${before} → ${after} control(s)`
  )

  // AND IT GIVES THE MOUSE BACK. The release is half the sensor — a reason left behind would keep
  // this window capturing for every step below it, which is exactly what a `mouseover` with no
  // matching `mouseout` used to do here (JOS-138 found it: the scroll step read a captured window
  // and blamed its own grip).
  await overlay.evaluate(() => {
    const row = document.querySelector('[aria-haspopup="listbox"]')?.parentElement
    row?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  })
  const released = await settle(countButtons, (n) => n === 0, { timeoutMs: 8_000 })
  check('…and moving off the row gives it back', released === 0, `${released} control(s)`)

  await setLocked(overlay, false)
}



// ── JOS-35: the overlay meter's levels, driven for real ────────────────────────────────
//
// The model is pinned in tests/combatPetNesting.test.mts, and it is pinned as ONE call the tab
// and the overlay both make. What only the real app can show is that this window can be NAVIGATED
// — that it opens zoomed out, that a bar drills, and that there is a chevron back. The damage
// overlay had no way out at all until this ticket: it opened inside your own breakdown and
// withheld Back on exactly that view, so with the pet preference on (the default) level 1 was
// unreachable in a floating meter.

const CRUMB = '[data-testid="overlay-crumb"]'
const BAR = '[data-testid="overlay-bar"]'
/** The rejected JOS-105 damage-type strip — asserted ABSENT now (JOS-113: one bar per ability). */
const CATEGORY_CHIP = '[data-testid="overlay-category"]'

/** The crumb row's text — the drill subject, if any, and the fight clock. */
async function crumbText(overlay: Page): Promise<string> {
  return ((await overlay.textContent(CRUMB)) ?? '').replace(/\s+/g, ' ').trim()
}

async function stepOverlayDrill(overlay: Page): Promise<void> {
  await setLocked(overlay, false)
  // Start from level 1 however the persisted drill left this window — the drill outlives a run,
  // by design (it is remembered state, like window position). Backing out with the chevron is
  // also the only way to reach level 1, so this loop is the affordance proving itself: bounded at
  // two, because a nested pet (a level-2 subject inside your level-2 row) is the deepest the model
  // goes now (JOS-113 removed the level-3 damage type) — pet → your row → sources.
  for (let i = 0; i < 2 && (await crumbText(overlay)).includes('‹'); i++) {
    const was = await crumbText(overlay)
    await overlay.click(CRUMB)
    await settle(() => crumbText(overlay), (t) => t !== was, { timeoutMs: 8_000 })
  }

  const bars = await settleCount(overlay, BAR, 1, { timeoutMs: 10_000 })
  if (bars === 0) {
    note('the overlay’s selected fight has no bars right now — the drill steps need one')
    return
  }
  check('the overlay meter opens ZOOMED OUT — one bar per combatant', (await countOf(overlay, CRUMB)) === 1)
  const level1 = await crumbText(overlay)
  // THE HEADER GAVE UP THE CLOCK, and this row took it: the header states the fight and the rate,
  // and the timer sits on the line that has room for it.
  check('…and the fight timer lives on that row, not in the header', /\d+:\d\d/.test(level1), level1 || 'empty')
  check('…with no back chevron, because there is nowhere further out', !level1.includes('‹'), level1)

  // Clicking a bar drills it — including the top one, which on this fixture is yours.
  await overlay.click(BAR)
  const level2 = await settle(() => crumbText(overlay), (t) => t !== level1, { timeoutMs: 8_000 })
  check('clicking a bar opens that entity’s breakdown', (await countOf(overlay, BAR)) > 0 && level2 !== level1, level2)
  check('…and the zoom-out chevron is offered on it (it was not, before JOS-35)', level2.includes('‹'), level2)
  check('…and the fight timer is still on the row', /\d+:\d\d/.test(level2), level2)

  // NO CATEGORY CHIP (JOS-113). JOS-105 put a damage-type strip here and a third drill level; the
  // owner rejected the grouping, so the drilled overlay is ONE BAR PER ABILITY with no strip. What
  // is asserted here is that the rejected chip is gone rather than a new level opening.
  check('the drilled overlay shows NO damage-type chip — one bar per ability, flat', (await countOf(overlay, CATEGORY_CHIP)) === 0)

  // …AND NO HOVER ON ANY OF THEM (JOS-358, owner ruling from hands-on testing). The per-ability
  // stats used to ride each bar's native `title`; the overlay windows keep tooltips only in the
  // title bar now, and the fully-labeled figures are on the Combat tab. Asserted on the DRILLED
  // level because that is where the longest of those strings lived.
  const barTitles = await overlay.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="overlay-bar"]')].map((e) => e.title)
  )
  check(
    '…and no bar hovers a stat run over the game any more',
    barTitles.length > 0 && barTitles.every((t) => t === ''),
    JSON.stringify(barTitles.slice(0, 3))
  )

  await overlay.click(CRUMB)
  const back = await settle(() => crumbText(overlay), (t) => t !== level2, { timeoutMs: 8_000 })
  check('…and the chevron really goes back out to the source list', back === level1, back)
}

// ── JOS-40: the opaque-overlay compatibility mode ───────────────────────────────────────
//
// A player on an RTX 5080 reported the transparent overlays producing black-screen artifacting.
// The mitigation is a switch that builds those windows WITHOUT transparency, and the only
// process that can see how a window was constructed is MAIN — so this is one of the few
// assertions in this suite that reads through `app.evaluate` rather than a page.
//
// WHAT THIS PROVES, and it is the whole reason the step exists: an overlay reopened in the new
// mode is still an OVERLAY. It opens, its bridge is live, its selector is there, it locks and
// unlocks, and its open-state persists — in BOTH modes. A compatibility switch that quietly
// broke the window it was compensating for would be worse than the artifacting.

// JOS-31 made each switch THREE-STATE ('auto' | 'on' | 'off'), because the app now detects a Wine
// prefix and takes the compatibility path by itself — and "the user refused" had to become
// sayable. On this Windows CI box the detection must answer NO, so `auto` resolves exactly the way
// `false` used to: that is the no-regression half, and it is asserted here rather than assumed.
interface GraphicsPrefsBridge {
  getGraphicsPrefs: () => Promise<{ safeMode: string; opaqueOverlays: string }>
  setGraphicsPrefs: (patch: Record<string, string>) => Promise<{
    safeMode: string
    opaqueOverlays: string
  }>
  getGraphicsEnvironment: () => Promise<{
    wine: boolean
    signals: string[]
    auto: { safeMode: boolean; opaqueOverlays: boolean }
  }>
}

/** How the fight overlay window was actually built, read in the main process. Identified by its
 *  `?kind=fight` URL rather than its title — the loaded page owns the title. */
function overlayBackground(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('kind=fight')
    )
    return w ? w.getBackgroundColor() : ''
  })
}

/** Close the fight overlay and open it again, returning its new page. The setting applies at
 *  CONSTRUCTION, so a reopen is the whole ceremony — exactly what the label promises. */
async function reopenFightOverlay(app: ElectronApplication, page: Page): Promise<Page | null> {
  await page.evaluate(async () => {
    const eq = (window as unknown as { eq: OverlayBridge }).eq
    if ((await eq.getOverlayState()).fight) await eq.toggleOverlay('fight')
  })
  // The window has to be GONE before it can be built differently, and main is the only side that
  // knows: the open-state it reports back is the close completing (wave E3 — condition, not clock).
  await settle(() => overlayState(page), (s) => s.fight === false, { timeoutMs: 10_000 })
  await page.evaluate(async () => {
    const eq = (window as unknown as { eq: OverlayBridge }).eq
    if (!(await eq.getOverlayState()).fight) await eq.toggleOverlay('fight')
  })
  return waitForOverlay(app, 'fight')
}

/** The overlay still behaves like one: selector, lock round trip, persisted open-state. */
async function checkOverlayStillWorks(page: Page, overlay: Page, mode: string): Promise<void> {
  check(`${mode}: the reopened overlay's bridge is live and its open-state persisted`,
    (await overlayState(page)).fight === true)
  await setLocked(overlay, false)
  check(`${mode}: it renders its selector`, (await countOf(overlay, TRIGGER)) === 1)
  await setLocked(overlay, true)
  check(`${mode}: it locks, and the locked selector survives (ruling 3 holds in this mode too)`,
    (await countOf(overlay, TRIGGER)) === 1)
  await setLocked(overlay, false)
}

async function stepOpaqueOverlays(app: ElectronApplication, page: Page): Promise<void> {
  const prefs = await page.evaluate(() =>
    (window as unknown as { eq: GraphicsPrefsBridge }).eq.getGraphicsPrefs()
  )
  check('a fresh install carries both graphics switches on AUTO', prefs.safeMode === 'auto' && prefs.opaqueOverlays === 'auto',
    JSON.stringify(prefs))

  // THE NO-REGRESSION ASSERTION FOR EVERY WINDOWS USER (JOS-31). The detection runs on this real
  // Windows machine, through the real filesystem and the real environment, and it must find
  // NOTHING — so `auto` means off, the overlay below is transparent, and the whole ticket is
  // invisible here. A false positive would turn every Windows install's overlays opaque and its
  // renderer to software, and this is the line that would go red first.
  const environment = await page.evaluate(() =>
    (window as unknown as { eq: GraphicsPrefsBridge }).eq.getGraphicsEnvironment()
  )
  check('this Windows machine is NOT detected as Wine, and recommends no compatibility path',
    environment.wine === false && environment.signals.length === 0 &&
      environment.auto.safeMode === false && environment.auto.opaqueOverlays === false,
    JSON.stringify(environment))

  const transparentBg = await overlayBackground(app)
  note(`transparent overlay background: ${transparentBg || '(none)'}`)

  const written = await page.evaluate(() =>
    (window as unknown as { eq: GraphicsPrefsBridge }).eq.setGraphicsPrefs({ opaqueOverlays: 'on' })
  )
  check('flipping the opaque-overlay switch persists it (main answers with what it stored)',
    written.opaqueOverlays === 'on' && written.safeMode === 'auto', JSON.stringify(written))

  const opaque = await reopenFightOverlay(app, page)
  if (!check('the fight overlay reopens in opaque mode', opaque !== null)) return
  const opaqueBg = await overlayBackground(app)
  note(`opaque overlay background: ${opaqueBg || '(none)'}`)
  // MEASURED: a transparent window reports `#000000` here, an opaque one the colour it was given.
  // The expected value is spelled out rather than imported (the telemetry spec's precedent — an
  // e2e file loads no src module): it is `OPAQUE_OVERLAY_BG` in src/shared/graphicsPrefs.ts, the
  // same RGB the overlay page paints, which is what makes the mode a compatibility switch rather
  // than a second palette.
  check('…and it really was built differently — the window carries the solid overlay colour now',
    opaqueBg.toLowerCase() === '#0e1115' && opaqueBg !== transparentBg, `${transparentBg} → ${opaqueBg}`)
  await checkOverlayStillWorks(page, opaque as Page, 'opaque')

  // …and back. The switch is a switch, not a one-way door — and since JOS-31 the way back is an
  // EXPLICIT 'off' rather than a return to 'auto', which is the same round trip a Wine user makes
  // when they want their see-through overlays despite the detection. This machine cannot exercise
  // the detected half, but it exercises the override that has to beat it.
  await page.evaluate(() =>
    (window as unknown as { eq: GraphicsPrefsBridge }).eq.setGraphicsPrefs({ opaqueOverlays: 'off' })
  )
  const clear = await reopenFightOverlay(app, page)
  if (!check('the fight overlay reopens transparent again', clear !== null)) return
  check('…and the window is back to the transparent background it started with',
    (await overlayBackground(app)) === transparentBg, await overlayBackground(app))
  await checkOverlayStillWorks(page, clear as Page, 'transparent')
}

/**
 * GRAPHICS SAFE MODE, AND THE ONE THING ONLY A REAL LAUNCH CAN SAY (JOS-40).
 *
 * `app.disableHardwareAcceleration()` is accepted ONLY before Electron's `ready` event, which is
 * why the composition root calls it from module scope. Get that placement wrong — move it into
 * `whenReady`, import it a line too late — and NOTHING fails: the call silently does nothing, the
 * app looks fine here, and the only person who finds out is the user who turned the switch on
 * because their screen was black. So this launch asserts the OUTCOME in Chromium's own terms:
 * with `EQ_DISABLE_GPU=1` in the environment, the process really is running with `--disable-gpu`,
 * and it still starts all the way to a hydrated window.
 *
 * The ENV door is what is tested rather than the stored switch, because they meet in one function
 * (src/main/graphics.ts) and the env half needs no second launch to write a setting first — and
 * because it is the door a user with an unusable window is told to use, and the one JOS-31 will
 * reuse for Wine.
 */
/**
 * Ask MAIN whether Chromium got the switch, RETRYING a few times.
 *
 * Not flake-hiding: `app.evaluate` reaches into a main process that spends the first seconds of
 * every launch blocked on the historical replay, and Playwright answers a call that lands in that
 * window with "Resulting promise was garbage collected" — observed here, on a launch whose app was
 * otherwise perfectly healthy. The FACT under test is a launch-time constant that cannot change
 * between attempts, so asking again once the loop is free is asking the same question, not a
 * different one.
 */
async function hasCommandLineSwitch(app: ElectronApplication, name: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    try {
      return await app.evaluate(({ app: a }, sw) => a.commandLine.hasSwitch(sw), name)
    } catch {
      await sleep(2_000)
    }
  }
  return false
}

async function checkSafeModeLaunch(log: FixtureLog): Promise<void> {
  console.log('launch 3: EQ_DISABLE_GPU=1 — does safe mode actually reach Chromium…')
  const { app, close } = await launchOnFixture(log, { env: { EQ_DISABLE_GPU: '1' } })
  try {
    const page = await mainWindow(app)
    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    check('EQ_DISABLE_GPU=1 still starts the app all the way to a drawn window', true)
    // Hydration first: the evaluate below has to reach a main loop that is not mid-replay.
    await waitHydrated(page)
    check(
      '…and the launch really is in software rendering (Chromium has --disable-gpu)',
      await hasCommandLineSwitch(app, 'disable-gpu')
    )
    // JOS-352, and the only machine that can make this statement is this one: the two Wine flags
    // are gated on the DETECTION, so a real Windows launch must append neither — not even the
    // launch that has every other compatibility path engaged. `--in-process-gpu` in particular
    // trades away GPU crash containment for every user it reaches, so "reaches nobody here" is
    // the claim worth proving in Chromium's own terms rather than in a unit test's. (A negative
    // read is only as good as the channel it came over, which is why it follows the positive one
    // above: that check having passed is what says `hasCommandLineSwitch` is answering at all.)
    for (const flag of ['disable-direct-composition', 'in-process-gpu']) {
      check(
        `…and this Windows machine appends none of the Wine flags (--${flag})`,
        !(await hasCommandLineSwitch(app, flag))
      )
    }
  } finally {
    await close()
  }
}

/**
 * LAUNCH 1 EXISTS TO LEAVE STATE BEHIND. This spec is written against an install that already
 * has an overlay open — its ask-first toggle below is exactly that assumption — and it used to
 * get one by inheriting whatever the previous spec left in the shared userData dir. That is not
 * inheritance, it is luck. So the spec now MAKES its own history: open the fight overlay through
 * the app's own door, quit, and hand launch 2 the same dir.
 */
async function seedOverlayOpen(log: FixtureLog, userData: string): Promise<void> {
  console.log('launch 1: opening the fight overlay, so launch 2 starts from an install that has one…')
  const { app, close } = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(app)
    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    await page.evaluate(async () => {
      const eq = (window as unknown as { eq: OverlayBridge }).eq
      const state = await eq.getOverlayState()
      if (!state.fight) await eq.toggleOverlay('fight')
    })
    // The open-state is written by MAIN when the window is created, so the condition is main
    // reporting it back — asked of the app rather than waited out.
    const opened = await settle(() => overlayState(page), (s) => s.fight === true, { timeoutMs: 15_000 })
    check('launch 1 leaves the fight overlay open in the store', opened.fight === true, JSON.stringify(opened))
  } finally {
    await close()
  }
}

async function main(): Promise<void> {
  buildIfStale()
  // A dir shared by this spec's TWO launches and nothing else: the overlay's open-state is
  // PERSISTED, and running against an install that already carries one is the point (see
  // seedOverlayOpen). The fight SELECTION is ephemeral by design and needs nothing from disk.
  const userData = makeUserData()
  // ONE staged log for both launches, so launch 2 replays exactly what launch 1 did.
  const log = stageFixture('e2e-overlay.log')
  await seedOverlayOpen(log, userData)

  console.log('launch 2: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-overlay.log…')
  const { app, close } = await launchOnFixture(log, { userData })

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    if (!check('hydration completes (replay hands off to the live tail)', !(await waitHydrated(page)).snap.hydrating)) {
      throw new Error('still hydrating — nothing below can be asserted')
    }

    // ASK, NEVER TOGGLE BLIND. `overlay:toggle` is a toggle and the open-state is PERSISTED, so a
    // spec that toggled unconditionally would close the very window launch 1 opened for it.
    check(
      'the overlay launch 1 opened is still open in launch 2 — the open-state persists',
      (await overlayState(page)).fight === true
    )
    await page.evaluate(async () => {
      const eq = (window as unknown as { eq: OverlayBridge }).eq
      const state = await eq.getOverlayState()
      if (!state.fight) await eq.toggleOverlay('fight')
    })
    const overlay = await waitForOverlay(app, 'fight')
    if (!check('the fight overlay window opens and its bridge is live', overlay !== null)) {
      throw new Error('no fight overlay window')
    }
    const ov = overlay as Page

    await stepBothStartLive(page, ov)

    const fightId = await someFinalizedFight(page)
    if (fightId) {
      await stepPanelMovesOverlay(page, ov, fightId)
      await stepOverlayMovesPanel(page, ov)
      await stepZoneIdRefused(page, ov, fightId)
    } else {
      note('the fixture holds no finalized fight — the cross-window selection steps were skipped')
    }
    await stepStaleId(page, ov)
    await stepOverlayDrill(ov)
    await stepLockedSelector(ov)
    await stepPinnedScroll(app, ov, setLocked)
    await stepPointerWatch(app, ov, setLocked)
    await stepOverlayScope(page, ov, setLocked)
    // Unlocked is a precondition of the measurement (a locked window has no drag region at all),
    // and stepOverlayScope leaves it that way.
    await setLocked(ov, false)
    await stepTitleBarRoom(ov)
    // …and the same header, at the smallest window the app allows. UNLOCKED is the demanding case
    // and the one this must run in: a locked meter draws no lock/close pair at all, so a floor
    // measured pinned would be measuring an empty row.
    await stepMinimumSize(app, ov, 'fight', 'the fight meter')
    await stepTotalOnPanel(ov, await longestFightName(page))
    // LAST of the steps that APPEND to the tailed log, deliberately: every measurement above is
    // taken against the staged fixture exactly as committed, and this one writes a line into it.
    await stepPetNudge(log, ov)
    // Everything below closes and reopens the very window every step above holds `ov` for, so `ov`
    // is dead from here on — both of these find their own overlay page.
    await stepOverlayDisplay(app, page)
    await stepOpaqueOverlays(app, page)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'overlay-sync-FAIL')
  } finally {
    await close()
    await removeUserData(userData)
  }

  // Its own launch, on its own throwaway dir: safe mode is decided before Electron is ready, so
  // it cannot be asserted about a process that is already running. It reads the SAME staged log,
  // which is why the fixture is disposed only after it.
  await checkSafeModeLaunch(log)
  await log.dispose()

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  note('the overlay-sync spec did not complete')
  process.exitCode = 1
})
