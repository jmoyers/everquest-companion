/**
 * THE OVERLAYS' TEXT SIZE, ACROSS PROCESSES (JOS-405) — steps for tests/e2e/text-size.e2e.mts.
 *
 * WHY THESE CANNOT BE UNIT TESTS. `tests/overlayTextScale.test.mts` pins the rule
 * (`independent ? per-kind : shared`), the normalizer, the migration and the handler's routing as
 * source. Every claim below is about SEPARATE RENDERER PROCESSES agreeing:
 *
 *   1. Pressing a control in the MAIN window resizes a floating overlay that is not it. That
 *      spans a React tree, a preload bridge, an IPC handler, main's store, a broadcast, a second
 *      preload and a second React tree. Nothing short of two real windows can claim it.
 *   2. A press on ONE overlay moves the OTHER one — the 2026-08-05 ruling, which used to be
 *      implemented as a fan-out that wrote all twelve kinds and is now a routed preference. The
 *      user-visible behaviour must be identical, which is exactly what a source pin cannot say.
 *   3. With independent sizes ON, that stops being true — and only for the window that was
 *        pressed. "The others hold" is an ABSENCE, so it is asserted by measuring them.
 *   4. The per-kind values SURVIVE the switch going off and on. This is a claim about a store
 *      across two modes, observed the way a user would: unsync, and the meter is the size you
 *      left it.
 *
 * WHAT IS MEASURED IS THE ZOOM ITSELF, not the store. The scale is applied as a CSS `zoom` on the
 * content pane (overlay/overlayScale.tsx), so reading that inline style is reading what the window
 * is actually drawing at — a spec that asked `getTextSize()` instead would pass on a build where
 * the value arrived and nothing painted it.
 *
 * NO WINDOW IS EVER SHOWN (`EQ_E2E=1`). The overlays are created, loaded and driven off-screen.
 * A window's own A− / A+ is pressed through `eqOverlay.setConfig({ textScale })` — the very call
 * the footer button makes (TextScaleStepper's `patch`) — because a hidden, always-on-top window
 * has no pointer to click with; the con-card spec drives the same door for the same reason.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'
import { overlayWindow } from './appWindow.mjs'

const PANE = '[data-testid="pref-overlay-text-size"]'
const SHARED_PLUS = '[data-testid="pref-overlay-text-size-plus"]'
const SHARED_VALUE = '[data-testid="pref-overlay-text-size-value"]'
const SWITCH = '[data-testid="pref-overlay-text-independent"] input'
/** A row's testids are built from the kind, never by appending to another SELECTOR — `[x]-plus`
 *  is not a selector at all, and Chromium says so at the moment the step runs. */
const rowTestId = (kind: string, part = ''): string => `[data-testid="pref-overlay-text-size-${kind}${part}"]`
const row = (kind: string): string => rowTestId(kind)
const rowPlus = (kind: string): string => rowTestId(kind, '-plus')
const rowValue = (kind: string): string => rowTestId(kind, '-value')

/** Every kind that gets a row — the whole union, which is the list's own claim. */
const ALL_KINDS = [
  'fight',
  'overall',
  'heal-fight',
  'heal-overall',
  'events',
  'buffs',
  'debuffs',
  'xp',
  'respawn',
  'toast',
  'alertBanner',
  'conCard'
]

/** A float through a percentage and a CSS string; 0.1 is a detent, so this tells them apart by an
 *  order of magnitude. */
const EPS = 0.001

/**
 * WHAT THE WINDOW IS DRAWING AT: the inline `zoom` on the content pane.
 *
 * Found by scanning for the one element that carries one rather than by a testid, because the
 * placement is the thing under test — a build that moved the zoom onto the chrome (the mistake the
 * first cut of this feature made) would still satisfy a testid and would be wrong.
 */
function paneZoom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const zoomed = Array.from(document.querySelectorAll('div')).filter((d) => d.style.zoom !== '')
    if (zoomed.length !== 1) return NaN
    return Number(zoomed[0].style.zoom)
  })
}

/** …settled, because it arrives over IPC from another process. */
function zoomSettles(page: Page, want: number): Promise<number> {
  return settle(() => paneZoom(page), (z) => Math.abs(z - want) < EPS, { timeoutMs: 15_000 })
}

/** The percentage Preferences is printing for the shared size. */
function sharedPercent(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    SHARED_VALUE
  )
}

/** Press a window's own A− / A+ — the door `TextScaleStepper` writes through. */
function pressWindowStepper(win: Page, textScale: number): Promise<unknown> {
  return win.evaluate(
    (s) =>
      (
        window as unknown as { eqOverlay: { setConfig: (p: { textScale: number }) => Promise<unknown> } }
      ).eqOverlay.setConfig({ textScale: s }),
    textScale
  )
}

/** Open a kind's window and hand back its page, or null if it never arrived. */
async function openOverlay(app: ElectronApplication, page: Page, kind: string): Promise<Page | null> {
  await page.evaluate(
    (k) => (window as unknown as { eq: { toggleOverlay: (k: string) => Promise<boolean> } }).eq.toggleOverlay(k),
    kind
  )
  return overlayWindow(app, kind)
}

/**
 * THE CARD ITSELF: the shared stepper, the switch OFF, and all twelve rows disabled with the
 * tooltip that says why.
 *
 * THE ROWS ARE THE POINT OF THIS STEP. A list that appeared only once the switch was on would make
 * the switch a navigation step — you would have to turn something on to find out what it offers —
 * so "always rendered" is a claim worth a count, and "disabled while synced" is what makes the
 * rendered-but-not-in-force state honest rather than confusing.
 */
export async function stepOverlaySizeCard(page: Page): Promise<void> {
  check('Preferences → Text size carries the overlays’ size too', (await countOf(page, PANE)) === 1)
  const rows = await page.evaluate(
    (kinds) => kinds.filter((k) => document.querySelector(`[data-testid="pref-overlay-text-size-${k}"]`) !== null),
    ALL_KINDS
  )
  check(
    'every overlay kind has a row, including the three that are not in the Overlay menu',
    rows.length === ALL_KINDS.length,
    `${String(rows.length)} of ${String(ALL_KINDS.length)}: missing ${ALL_KINDS.filter((k) => !rows.includes(k)).join(', ') || 'none'}`
  )
  const on = await page.evaluate((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked, SWITCH)
  check('independent sizes ship OFF — one size for everything, as every install already had', on === false, String(on))

  // DISABLED, AND SHOWING THE SHARED VALUE. A row states what is TRUE NOW: while synced these
  // windows all genuinely draw at the shared size, so a row printing a remembered 150% beside a
  // meter drawing 100% would be a lie told twelve times.
  const disabled = await page.evaluate(
    (kinds) =>
      kinds.filter((k) => {
        const btn = document.querySelector(`[data-testid="pref-overlay-text-size-${k}-plus"]`)
        return (btn as HTMLButtonElement | null)?.disabled === true
      }),
    ALL_KINDS
  )
  check('…and while they share one size, every row is disabled', disabled.length === ALL_KINDS.length,
    `${String(disabled.length)} of ${String(ALL_KINDS.length)}`)

  // THE TOOLTIP IS THE OTHER HALF: a disabled control that does not say why is a dead end. MUI
  // renders it on hover, so what is asserted here is that the ANCHOR is wired — the wrapping span
  // a disabled button needs, carrying the sentence.
  const tip = await page.evaluate((sel) => {
    const stepper = document.querySelector(sel)
    const span = stepper?.parentElement
    return span?.getAttribute('aria-label') ?? span?.getAttribute('title') ?? ''
  }, row('fight'))
  check('…and hovering one explains itself rather than just refusing', /independent/i.test(tip), tip.slice(0, 120) || '(no tooltip on the wrapping span)')
}

/**
 * ACCEPTANCE 2: pressing Overlay text size in Preferences resizes every open overlay, live.
 *
 * TWO windows, because one would not separate "this overlay obeys Preferences" from "every overlay
 * obeys Preferences", and the second is the whole of the 2026-08-05 ruling.
 */
export async function stepSharedAppliesLive(page: Page, fight: Page, overall: Page): Promise<void> {
  const before = await paneZoom(fight)
  check('the fight meter reports a zoom to measure against', Number.isFinite(before), String(before))
  await page.click(SHARED_PLUS, { timeout: 15_000 })
  const want = Math.round((before + 0.1) * 100) / 100
  const f = await zoomSettles(fight, want)
  const o = await zoomSettles(overall, want)
  check('pressing A+ in Preferences resizes the fight meter, live', Math.abs(f - want) < EPS, `${String(before)} -> ${String(f)}`)
  check('…and the zone meter with it — one size for all of them, unless told otherwise', Math.abs(o - want) < EPS, String(o))
  const shown = await sharedPercent(page)
  check('…and Preferences prints what it just did', shown === `${String(Math.round(want * 100))}%`, shown)
}

/**
 * …AND THE SAME VALUE MOVES FROM A WINDOW'S OWN A− / A+.
 *
 * The 2026-08-05 ruling from the other end, and the one this ticket had to be careful with: it was
 * implemented by WRITING all twelve per-kind fields, and it is now a routed preference. The user
 * cannot tell the difference, and this step is what says so.
 */
export async function stepWindowMovesShared(page: Page, fight: Page, overall: Page): Promise<void> {
  const before = await paneZoom(fight)
  const want = Math.round((before + 0.1) * 100) / 100
  await pressWindowStepper(fight, want)
  const o = await zoomSettles(overall, want)
  check('a press on the fight meter’s own A+ moves the zone meter too', Math.abs(o - want) < EPS, `${String(before)} -> ${String(o)}`)
  const shown = await settle(() => sharedPercent(page), (p) => p === `${String(Math.round(want * 100))}%`, { timeoutMs: 15_000 })
  check('…and Preferences, left open, agrees with the press it did not make', shown === `${String(Math.round(want * 100))}%`, shown)
}

/**
 * THE PINNED METER — the player this whole ticket is for.
 *
 * Two 1.4.0 reports said the text was too small and that the text size options did not affect it.
 * They were right about where they looked: a LOCKED overlay is click-through and draws no chrome at
 * all, so it has no A− / A+ to press, and somebody who pinned their meters on day one has never
 * seen the control that was supposed to be the answer. A control in Preferences is only a fix if it
 * reaches THAT window, so this step pins the meter first and then presses.
 *
 * It is also the step that proves the push half of the design rather than the pull: a locked window
 * cannot be asked to re-read anything, so the new size has to arrive as a broadcast.
 */
export async function stepPinnedMeterFollows(page: Page, fight: Page): Promise<void> {
  await fight.evaluate(() =>
    (window as unknown as { eqOverlay: { setLocked: (v: boolean) => void } }).eqOverlay.setLocked(true)
  )
  const locked = await settle(
    () => fight.evaluate(() => document.querySelectorAll('button').length),
    (n) => n === 0,
    { timeoutMs: 15_000 }
  ).catch(() => -1)
  check('the fight meter is pinned — no chrome, so no stepper of its own to press', locked === 0, `${String(locked)} button(s) still drawn`)

  const before = await paneZoom(fight)
  await page.click(SHARED_PLUS, { timeout: 15_000 })
  const want = Math.round((before + 0.1) * 100) / 100
  const after = await zoomSettles(fight, want)
  check('…and Preferences resizes it anyway — the control the reports could not find', Math.abs(after - want) < EPS,
    `${String(before)} -> ${String(after)}`)

  await fight.evaluate(() =>
    (window as unknown as { eqOverlay: { setLocked: (v: boolean) => void } }).eqOverlay.setLocked(false)
  )
  await settle(() => fight.evaluate(() => document.querySelectorAll('button').length), (n) => n > 0, { timeoutMs: 15_000 }).catch(() => 0)
}

/**
 * ACCEPTANCE 3: with Independent on, a row moves ONLY that overlay.
 *
 * The holding half is the one that matters and it is an ABSENCE, so it is measured rather than
 * waited for: the zone meter's zoom is read AFTER the fight meter has already settled on its new
 * one, which is the moment a leaked write would have arrived.
 */
export async function stepIndependent(page: Page, fight: Page, overall: Page): Promise<number> {
  await page.click(SWITCH, { timeout: 15_000 })
  const live = await settle(
    () => page.evaluate((sel) => (document.querySelector(sel) as HTMLButtonElement | null)?.disabled !== true, rowPlus('fight')),
    (v) => v,
    { timeoutMs: 15_000 }
  )
  check('turning the switch on makes the rows live', live)

  const held = await paneZoom(overall)
  const before = await paneZoom(fight)
  await page.click(rowPlus('fight'), { timeout: 15_000 })
  const want = Math.round((before + 0.1) * 100) / 100
  const f = await zoomSettles(fight, want)
  check('the fight meter’s own row moves the fight meter', Math.abs(f - want) < EPS, `${String(before)} -> ${String(f)}`)
  check('…and the zone meter HOLDS — which is the whole of what was asked for', Math.abs((await paneZoom(overall)) - held) < EPS,
    `${String(held)} -> ${String(await paneZoom(overall))}`)
  const shown = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '', rowValue('fight'))
  check('…and the row states its own size now, not the shared one', shown === `${String(Math.round(want * 100))}%`, shown)
  return want
}

/**
 * ACCEPTANCE 4: the per-kind values SURVIVE the switch going off and on (the JOS-168 precedent).
 *
 * Off: both windows come back to the shared size — including the one that had its own. On again:
 * that one is exactly where its owner left it. Nothing writes a per-kind value while synced, which
 * is what makes the second half true, and this is the only place that claim can be watched happen.
 */
export async function stepSurvivesTheSwitch(page: Page, fight: Page, overall: Page, remembered: number): Promise<void> {
  const shared = await paneZoom(overall)
  await page.click(SWITCH, { timeout: 15_000 })
  const back = await zoomSettles(fight, shared)
  check('turning independent sizes off puts every overlay back on the one size', Math.abs(back - shared) < EPS,
    `${String(remembered)} -> ${String(back)} (shared ${String(shared)})`)
  // SETTLED, not read once: the switch lives in one card and the rows in another, so this value
  // reaches them the long way round — through main's broadcast and back into a second React tree.
  const want = `${String(Math.round(shared * 100))}%`
  const rowShows = await settle(
    () => page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '', rowValue('fight')),
    (v) => v === want,
    { timeoutMs: 15_000 }
  )
  check('…and the disabled row states the size in force, never the one it remembers', rowShows === want, rowShows)

  await page.click(SWITCH, { timeout: 15_000 })
  const again = await zoomSettles(fight, remembered)
  check('…and turning it back on finds that meter exactly where its owner left it', Math.abs(again - remembered) < EPS,
    `${String(shared)} -> ${String(again)}, wanted ${String(remembered)}`)
  note('the per-kind value was never written while the overlays were synced — which is why there was something to come back to')
}

/** Open the two meters this file drives, reporting honestly if either never arrived. */
export async function openTwoMeters(app: ElectronApplication, page: Page): Promise<[Page, Page] | null> {
  const fight = await openOverlay(app, page, 'fight')
  const overall = await openOverlay(app, page, 'overall')
  if (!check('both meter overlays came up to be measured', fight !== null && overall !== null)) return null
  return [fight as Page, overall as Page]
}
