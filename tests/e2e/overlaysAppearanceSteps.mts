/**
 * THE OVERLAYS CARD, ACROSS PROCESSES (JOS-408) — steps for tests/e2e/text-size.e2e.mts.
 *
 * ONE MODULE, because there is now ONE CARD. This is `overlayTextSizeSteps.mts` (JOS-405) and
 * `overlayBgAlphaSteps.mts` (JOS-407) folded together, exactly as the two Preferences cards and
 * their two Independent switches were folded into one by the owner's 2026-08-17 review. Keeping two
 * step files would have kept two selectors for one switch, which is the shape of bug this ticket is
 * about.
 *
 * WHY NONE OF THIS CAN BE A UNIT TEST. `tests/overlayTextScale.test.mts`,
 * `tests/overlayBgAlpha.test.mts` and `tests/overlayIndependent.test.mts` pin the rules, the
 * normalizers, the migrations, the 5% grid, the reconcile and the routing as source. Every claim
 * below is about SEPARATE RENDERER PROCESSES agreeing:
 *
 *   1. A control in the MAIN window resizes or repaints a floating overlay that is not it — a React
 *      tree, a preload bridge, an IPC handler, main's store, a broadcast, a second preload, a
 *      second React tree.
 *   2. A press on ONE overlay moves the OTHER, and the Preferences readout follows the press it did
 *      not make.
 *   3. With the switch on, that stops being true, and only for the window that was pressed. "The
 *      others hold" is an ABSENCE, so it is measured rather than waited for.
 *   4. The per-kind values SURVIVE the switch going off and on — a claim about a store across two
 *      modes, watched the way a user would watch it.
 *
 * AND FOUR CLAIMS THIS TICKET ADDED, all of which are about what is ON SCREEN rather than what is
 * stored: exactly two shared steppers and NO list while synced; the twelve rows and NO shared
 * steppers while independent; a `closed` tag on a row whose window is not open; and no disabled
 * control anywhere in the section except a stepper at a clamp.
 *
 * WHAT IS MEASURED IS THE PAINT ITSELF. The size is a CSS `zoom` on the content pane
 * (overlay/overlayScale.tsx) and the transparency is the body's own `rgba(14,17,21,a)`; both are
 * read back off the real document, so a build where the value arrived and nothing painted it fails
 * here rather than passing.
 *
 * NO WINDOW IS EVER SHOWN (`EQ_E2E=1`). A window's own A− / A+ and `bg` slider are driven through
 * `eqOverlay.setConfig(...)` — the very call those controls make — because a hidden, always-on-top
 * window has no pointer. The PREFERENCES controls are all real clicks on real buttons, which is
 * what the page being all steppers now buys: JOS-407's slider had to be driven by keyboard.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'
import { overlayWindow } from './appWindow.mjs'

const SWITCH = '[data-testid="pref-overlay-independent"] input'
const SIZE = '[data-testid="pref-overlay-text-size"]'
const SIZE_PLUS = '[data-testid="pref-overlay-text-size-plus"]'
const SIZE_VALUE = '[data-testid="pref-overlay-text-size-value"]'
const ALPHA = '[data-testid="pref-overlay-bg-alpha"]'
const ALPHA_MINUS = '[data-testid="pref-overlay-bg-alpha-minus"]'
const ALPHA_VALUE = '[data-testid="pref-overlay-bg-alpha-value"]'
const ROWS = '[data-testid^="pref-overlay-row-"]'

/** A row's testids are built from the kind, never by appending to another SELECTOR — `[x]-plus`
 *  is not a selector at all, and Chromium says so at the moment the step runs. */
const sizeRow = (kind: string, part = ''): string => `[data-testid="pref-overlay-text-size-${kind}${part}"]`
const alphaRow = (kind: string, part = ''): string => `[data-testid="pref-overlay-bg-alpha-${kind}${part}"]`

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

/** `TEXT_SCALE_STEP` and `BG_ALPHA_PREF_STEP` from src/shared, spelled out rather than imported: an
 *  e2e file loads no `src` module (tests/e2e/overlayMinSizeSteps.mts states that rule). */
const SIZE_STEP = 0.1
const ALPHA_GRID = 0.05
/** A float through a percentage, a CSS string and an rgba(); the smaller detent is 0.05, so this
 *  tells two neighbouring values apart by an order of magnitude. */
const EPS = 0.001

const pct = (v: number): string => `${String(Math.round(v * 100))}%`

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

/**
 * …and WHAT IT IS PAINTED WITH: the alpha of the one body background it draws.
 *
 * Scanned for the meters' body colour rather than a testid, for `paneZoom`'s reason: a build that
 * put the alpha somewhere other than the body would satisfy a testid and be wrong. `NaN` when
 * nothing paints it, which reads as a failure rather than as a pass.
 */
function bodyAlpha(page: Page): Promise<number> {
  return page.evaluate(() => {
    const found = new Set<number>()
    for (const el of Array.from(document.querySelectorAll('div'))) {
      const m = /^rgba\(14, ?17, ?21, ?([\d.]+)\)$/.exec(getComputedStyle(el).backgroundColor)
      if (m) found.add(Number(m[1]))
    }
    return found.size === 1 ? [...found][0] : NaN
  })
}

/** …both settled, because they arrive over IPC from another process. */
function zoomSettles(page: Page, want: number): Promise<number> {
  return settle(() => paneZoom(page), (z) => Math.abs(z - want) < EPS, { timeoutMs: 15_000 })
}
function alphaSettles(page: Page, want: number): Promise<number> {
  return settle(() => bodyAlpha(page), (a) => Math.abs(a - want) < EPS, { timeoutMs: 15_000 })
}

/** The text of one readout in Preferences. */
function readout(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    selector
  )
}

/** …settled, for a value that reaches this React tree the long way round (main's broadcast). */
function readoutSettles(page: Page, selector: string, want: string): Promise<string> {
  return settle(() => readout(page, selector), (v) => v === want, { timeoutMs: 15_000 })
}

/** Whether a control is disabled, as the DOM states it. */
function isDisabled(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLButtonElement | null)?.disabled === true,
    selector
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

/** …and its own `bg` slider, the door `BgAlphaSlider` writes through. */
function dragWindowAlpha(win: Page, bgAlpha: number): Promise<unknown> {
  return win.evaluate(
    (a) =>
      (
        window as unknown as { eqOverlay: { setConfig: (p: { bgAlpha: number }) => Promise<unknown> } }
      ).eqOverlay.setConfig({ bgAlpha: a }),
    bgAlpha
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

/** Open the two meters this file drives, reporting honestly if either never arrived. */
export async function openTwoMeters(app: ElectronApplication, page: Page): Promise<[Page, Page] | null> {
  const fight = await openOverlay(app, page, 'fight')
  const overall = await openOverlay(app, page, 'overall')
  if (!check('both meter overlays came up to be measured', fight !== null && overall !== null)) return null
  return [fight as Page, overall as Page]
}

// ------------------------------------------------------------------- the card, in its two shapes

/**
 * SHAPE ONE: the switch is OFF, so the card is a switch and EXACTLY TWO STEPPERS.
 *
 * THE ABSENCE IS THE ASSERTION. The old page rendered all twelve rows here as well, disabled, each
 * with a tooltip explaining why it could not be pressed — twenty-four dead controls the reader had
 * to work out. The owner's review: "our first pass had enabled controls when they didn't do
 * anything. That's a bad pattern." So the list is not disabled, it is not there.
 */
export async function stepSyncedShape(page: Page): Promise<void> {
  check('the Appearance section carries ONE Overlays card', (await countOf(page, SIZE)) === 1)
  check('…with a single Independent per overlay switch', (await countOf(page, '[data-testid="pref-overlay-independent"]')) === 1)
  const on = await page.evaluate((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked, SWITCH)
  check('it ships OFF — one size and one transparency, as every fresh install has', on === false, String(on))

  check('shared: the text size stepper is here', (await countOf(page, SIZE)) === 1)
  check('shared: the transparency stepper is here', (await countOf(page, ALPHA)) === 1)
  const rows = await countOf(page, ROWS)
  check('…and there is NO per-overlay list at all while they share one of each', rows === 0, `${String(rows)} row(s)`)

  // THE OTHER HALF OF THE SAME RULE: nothing in the section is disabled except a stepper at a
  // clamp. At the shipped 100% / 72% neither end is reached, so every button here is live.
  const dead: string[] = []
  for (const sel of [
    '[data-testid="pref-text-size-minus"]',
    '[data-testid="pref-text-size-plus"]',
    '[data-testid="pref-overlay-text-size-minus"]',
    SIZE_PLUS,
    ALPHA_MINUS,
    '[data-testid="pref-overlay-bg-alpha-plus"]'
  ]) {
    if (await isDisabled(page, sel)) dead.push(sel)
  }
  check('every stepper button on the page is live — none is disabled by a switch', dead.length === 0, dead.join(' '))
}

/**
 * SHAPE TWO: the switch is ON, so the card is a switch and TWELVE ROWS — and the two shared
 * steppers are GONE.
 *
 * The shared steppers being gone is the claim that costs something to keep true: they hold the
 * shared value, and a build that merely hid them would leave that value mounted and stale, ready to
 * be revealed with whatever number it was showing before the flip.
 */
export async function stepIndependentShape(page: Page): Promise<void> {
  await page.click(SWITCH, { timeout: 15_000 })
  const rows = await settle(() => countOf(page, ROWS), (n) => n === ALL_KINDS.length, { timeoutMs: 15_000 })
  check(
    'turning it on shows every overlay kind, including the three that are not in the Overlay menu',
    rows === ALL_KINDS.length,
    `${String(rows)} of ${String(ALL_KINDS.length)}`
  )
  const missing = await page.evaluate(
    (kinds) => kinds.filter((k) => document.querySelector(`[data-testid="pref-overlay-row-${k}"]`) === null),
    ALL_KINDS
  )
  check('…each one named', missing.length === 0, missing.join(', ') || 'none missing')

  // The shared steppers are UNMOUNTED, not hidden. `SIZE` and `ALPHA` are the shared testids; the
  // rows carry `-<kind>` suffixes, so an exact-match count is exactly the right instrument.
  check('…and the two shared steppers are gone, not greyed out', (await countOf(page, SIZE)) === 0 && (await countOf(page, ALPHA)) === 0)

  const live = await page.evaluate(
    (kinds) =>
      kinds.filter((k) => {
        const btn = document.querySelector(`[data-testid="pref-overlay-text-size-${k}-plus"]`)
        return (btn as HTMLButtonElement | null)?.disabled !== true
      }),
    ALL_KINDS
  )
  check('every row is LIVE — nothing here is rendered and dead', live.length === ALL_KINDS.length,
    `${String(live.length)} of ${String(ALL_KINDS.length)}`)
}

/**
 * A ROW FOR A CLOSED WINDOW SAYS SO.
 *
 * The one control on this page whose honest answer to "what changes on screen when I press it" is
 * "nothing, right now" — it writes the value that window will OPEN at, which is a real thing to
 * want, so the control stays live and the row explains itself instead. Two meters are open in this
 * spec and ten kinds are not, which is the comparison.
 */
export async function stepClosedTag(page: Page): Promise<void> {
  // AGAINST MAIN'S OWN ANSWER, never a list written here. Which kinds are open in a fresh e2e
  // profile is a fact about what this app SHIPS on — the mob card is on by default and the toast
  // window exists from startup, so the two meters this spec opens are not the whole set — and a
  // hard-coded expectation would be a frozen number that rots the day a default changes
  // (AGENTS.md). What the tag has to be right about is the state, not the roster.
  const open = await page.evaluate(() =>
    (window as unknown as { eq: { getOverlayState: () => Promise<Record<string, boolean>> } }).eq.getOverlayState()
  )
  const openKinds = ALL_KINDS.filter((k) => open[k])
  const closedKinds = ALL_KINDS.filter((k) => !open[k])
  // …and the claim is not vacuous only if both sides exist. This spec opened two meters, so they
  // do; if a future default opened all twelve the tag would have nothing to say and this says so.
  check('there are open overlays AND closed ones to tell apart', openKinds.length > 0 && closedKinds.length > 0,
    `${String(openKinds.length)} open, ${String(closedKinds.length)} closed`)

  const tagged = await page.evaluate(
    (kinds) =>
      kinds.filter((k) =>
        /closed/i.test((document.querySelector(`[data-testid="pref-overlay-row-${k}"]`) as HTMLElement | null)?.innerText ?? '')
      ),
    ALL_KINDS
  )
  check(
    'a row whose window is closed says `closed`, so a press that moves nothing on screen explains itself',
    JSON.stringify([...tagged].sort()) === JSON.stringify([...closedKinds].sort()),
    `tagged: ${tagged.join(', ') || 'none'} · closed: ${closedKinds.join(', ') || 'none'}`
  )
  const wrong = openKinds.filter((k) => tagged.includes(k))
  check('…and the open ones do NOT, because pressing those moves something', wrong.length === 0, wrong.join(', '))
}

// ------------------------------------------------------------------------- the shared mode works

/**
 * Pressing the shared A+ resizes every open overlay, live.
 *
 * TWO windows, because one would not separate "this overlay obeys Preferences" from "every overlay
 * obeys Preferences", and the second is the whole of the 2026-08-05 ruling.
 */
export async function stepSharedSizeAppliesLive(page: Page, fight: Page, overall: Page): Promise<void> {
  const before = await paneZoom(fight)
  check('the fight meter reports a zoom to measure against', Number.isFinite(before), String(before))
  await page.click(SIZE_PLUS, { timeout: 15_000 })
  const want = Math.round((before + SIZE_STEP) * 100) / 100
  const f = await zoomSettles(fight, want)
  const o = await zoomSettles(overall, want)
  check('pressing A+ in Preferences resizes the fight meter, live', Math.abs(f - want) < EPS, `${String(before)} -> ${String(f)}`)
  check('…and the zone meter with it — one size for all of them, unless told otherwise', Math.abs(o - want) < EPS, String(o))
  check('…and Preferences prints what it just did', (await readout(page, SIZE_VALUE)) === pct(want), await readout(page, SIZE_VALUE))
}

/** …and pressing the shared − makes every open overlay more see-through, on the 5% grid. */
export async function stepSharedAlphaAppliesLive(page: Page, fight: Page, overall: Page): Promise<void> {
  const before = await bodyAlpha(fight)
  check('the fight meter paints a background to measure against', Number.isFinite(before), String(before))
  // THE GRID, WATCHED IN THE REAL APP: the shipped 0.72 is on no multiple of five, so the first
  // press SNAPS to 0.70 rather than stepping to 0.67. That is the whole reason `stepBgAlpha` is a
  // grid walk, and it is the number the readout has to show.
  await page.click(ALPHA_MINUS, { timeout: 15_000 })
  const want = Math.floor((before - 1e-9) / ALPHA_GRID) * ALPHA_GRID
  const rounded = Math.round(want * 100) / 100
  const f = await alphaSettles(fight, rounded)
  const o = await alphaSettles(overall, rounded)
  check('pressing − in Preferences makes the fight meter more see-through, live', Math.abs(f - rounded) < EPS,
    `${String(before)} -> ${String(f)}`)
  check('…and the zone meter with it — one transparency for all of them', Math.abs(o - rounded) < EPS, String(o))
  check('…and it lands on the 5% grid rather than carrying the old offset', Math.abs((rounded * 100) % 5) < 0.001,
    pct(rounded))
  check('…and Preferences prints what it just did', (await readout(page, ALPHA_VALUE)) === pct(rounded),
    await readout(page, ALPHA_VALUE))
}

/**
 * …AND THE SAME TWO VALUES MOVE FROM A WINDOW'S OWN CONTROLS, with the readouts following live.
 *
 * The 2026-08-05 ruling from the other end, plus the JOS-407 half: both were implemented as routed
 * preferences, and the person pressing cannot tell. The READOUT half is what the owner's review
 * asked to be checked — a shared row printing a stale percentage while a meter has already moved is
 * a control lying about the thing it governs.
 */
export async function stepWindowMovesShared(page: Page, fight: Page, overall: Page): Promise<void> {
  const before = await paneZoom(fight)
  const wantSize = Math.round((before + SIZE_STEP) * 100) / 100
  await pressWindowStepper(fight, wantSize)
  const o = await zoomSettles(overall, wantSize)
  check('a press on the fight meter’s own A+ moves the zone meter too', Math.abs(o - wantSize) < EPS,
    `${String(before)} -> ${String(o)}`)
  const shownSize = await readoutSettles(page, SIZE_VALUE, pct(wantSize))
  check('…and the shared readout, left open, agrees with the press it did not make', shownSize === pct(wantSize), shownSize)

  const wantAlpha = 0.5
  await dragWindowAlpha(fight, wantAlpha)
  const oa = await alphaSettles(overall, wantAlpha)
  check('a drag on the fight meter’s own bg slider repaints the zone meter too', Math.abs(oa - wantAlpha) < EPS, String(oa))
  const shownAlpha = await readoutSettles(page, ALPHA_VALUE, pct(wantAlpha))
  check('…and the shared readout agrees with the drag it did not make', shownAlpha === pct(wantAlpha), shownAlpha)
  // AND IT IS STILL A CLEAN STEP FROM THERE. 50% is on the grid, so − goes to 45%: the readout
  // shows the exact in-force value and the stepper walks from it, which is the ticket's rule.
  await page.click(ALPHA_MINUS, { timeout: 15_000 })
  const stepped = await alphaSettles(overall, 0.45)
  check('…and a press from there steps a clean 5%, off a value a slider chose', Math.abs(stepped - 0.45) < EPS, String(stepped))
}

/**
 * THE PINNED METER — the player this whole feature is for.
 *
 * Two 1.4.0 reports said the text was too small and that the text size options did not affect it.
 * They were right about where they looked: a LOCKED overlay is click-through and draws no chrome at
 * all, so it has no A− / A+ and no `bg` slider, and somebody who pinned their meters on day one has
 * never seen either. A control in Preferences is only a fix if it reaches THAT window.
 *
 * It is also the step that proves the PUSH half of the design rather than the pull: a locked window
 * cannot be asked to re-read anything.
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
  check('the fight meter is pinned — no chrome, so no controls of its own to press', locked === 0,
    `${String(locked)} button(s) still drawn`)

  const before = await paneZoom(fight)
  await page.click(SIZE_PLUS, { timeout: 15_000 })
  const want = Math.round((before + SIZE_STEP) * 100) / 100
  const after = await zoomSettles(fight, want)
  check('…and Preferences resizes it anyway — the control the reports could not find', Math.abs(after - want) < EPS,
    `${String(before)} -> ${String(after)}`)

  await fight.evaluate(() =>
    (window as unknown as { eqOverlay: { setLocked: (v: boolean) => void } }).eqOverlay.setLocked(false)
  )
  await settle(() => fight.evaluate(() => document.querySelectorAll('button').length), (n) => n > 0, { timeoutMs: 15_000 }).catch(() => 0)
}

// -------------------------------------------------------------------- the independent mode works

/**
 * WITH THE SWITCH ON, A ROW MOVES ONLY THAT OVERLAY — both halves of it, from ONE switch.
 *
 * That last clause is what this ticket changed: there used to be two switches, so the interesting
 * state was a row whose size was live and whose transparency was not. There is no such state now,
 * and this step is where that is observed rather than asserted about source.
 *
 * The holding half is an ABSENCE, so it is measured rather than waited for: the zone meter is read
 * AFTER the fight meter has already settled, which is the moment a leaked write would have arrived.
 */
export async function stepIndependentRow(page: Page, fight: Page, overall: Page): Promise<{ size: number; alpha: number }> {
  const heldZoom = await paneZoom(overall)
  const heldAlpha = await bodyAlpha(overall)
  const beforeZoom = await paneZoom(fight)
  const beforeAlpha = await bodyAlpha(fight)

  await page.click(sizeRow('fight', '-plus'), { timeout: 15_000 })
  const wantSize = Math.round((beforeZoom + SIZE_STEP) * 100) / 100
  const f = await zoomSettles(fight, wantSize)
  check('the fight meter’s own row moves the fight meter', Math.abs(f - wantSize) < EPS, `${String(beforeZoom)} -> ${String(f)}`)
  check('…and the zone meter HOLDS — which is the whole of what independent means',
    Math.abs((await paneZoom(overall)) - heldZoom) < EPS, `${String(heldZoom)} -> ${String(await paneZoom(overall))}`)
  check('…and the row states its own size now, not the shared one',
    (await readout(page, sizeRow('fight', '-value'))) === pct(wantSize), await readout(page, sizeRow('fight', '-value')))

  await page.click(alphaRow('fight', '-minus'), { timeout: 15_000 })
  const wantAlpha = Math.round(Math.floor((beforeAlpha - 1e-9) / ALPHA_GRID) * ALPHA_GRID * 100) / 100
  const fa = await alphaSettles(fight, wantAlpha)
  check('…and the SAME switch made its transparency live too — one switch, both halves',
    Math.abs(fa - wantAlpha) < EPS, `${String(beforeAlpha)} -> ${String(fa)}`)
  check('…with the zone meter holding that as well',
    Math.abs((await bodyAlpha(overall)) - heldAlpha) < EPS, `${String(heldAlpha)} -> ${String(await bodyAlpha(overall))}`)

  return { size: wantSize, alpha: wantAlpha }
}

/**
 * A ROW'S READOUT FOLLOWS THE WINDOW'S OWN CONTROL, LIVE — the independent half of the readout
 * claim the owner's review asked about.
 *
 * The synced half is in `stepWindowMovesShared`. This is the other mode: the press goes to the
 * kind's own stored value and reaches this React tree through a DIFFERENT push
 * (`onOverlayTextScales` / `onOverlayBgAlphas`), so the two are genuinely separate wiring.
 */
export async function stepRowFollowsWindow(page: Page, fight: Page): Promise<{ size: number; alpha: number }> {
  const size = Math.round(((await paneZoom(fight)) + SIZE_STEP) * 100) / 100
  await pressWindowStepper(fight, size)
  const shownSize = await readoutSettles(page, sizeRow('fight', '-value'), pct(size))
  check('the row follows the meter’s OWN A+, live', shownSize === pct(size), shownSize)

  const alpha = 0.35
  await dragWindowAlpha(fight, alpha)
  const shownAlpha = await readoutSettles(page, alphaRow('fight', '-value'), pct(alpha))
  check('…and its transparency readout follows that meter’s own bg slider', shownAlpha === pct(alpha), shownAlpha)
  return { size, alpha }
}

/**
 * THE PER-KIND VALUES SURVIVE THE SWITCH GOING OFF AND ON (the JOS-168 precedent), and the CARD
 * changes shape twice while they do.
 *
 * Off: both windows come back to the shared values — including the one that had its own — and the
 * list disappears. On again: the list is back and that meter is exactly where its owner left it.
 * Nothing writes a per-kind value while synced, which is what makes the second half true.
 */
export async function stepSurvivesTheSwitch(
  page: Page,
  fight: Page,
  overall: Page,
  remembered: { size: number; alpha: number }
): Promise<void> {
  const sharedZoom = await paneZoom(overall)
  const sharedAlpha = await bodyAlpha(overall)
  await page.click(SWITCH, { timeout: 15_000 })

  const backZoom = await zoomSettles(fight, sharedZoom)
  check('turning the switch off puts every overlay back on the one size', Math.abs(backZoom - sharedZoom) < EPS,
    `${String(remembered.size)} -> ${String(backZoom)} (shared ${String(sharedZoom)})`)
  const backAlpha = await alphaSettles(fight, sharedAlpha)
  check('…and on the one transparency, from the same press', Math.abs(backAlpha - sharedAlpha) < EPS,
    `${String(remembered.alpha)} -> ${String(backAlpha)} (shared ${String(sharedAlpha)})`)
  const gone = await settle(() => countOf(page, ROWS), (n) => n === 0, { timeoutMs: 15_000 })
  check('…and the list is GONE rather than sitting there disabled', gone === 0, `${String(gone)} row(s)`)
  const shown = await readoutSettles(page, SIZE_VALUE, pct(sharedZoom))
  check('…with the shared stepper back, stating the size in force', shown === pct(sharedZoom), shown)

  await page.click(SWITCH, { timeout: 15_000 })
  const againZoom = await zoomSettles(fight, remembered.size)
  check('…and turning it back on finds that meter exactly the size its owner left it',
    Math.abs(againZoom - remembered.size) < EPS, `${String(sharedZoom)} -> ${String(againZoom)}, wanted ${String(remembered.size)}`)
  const againAlpha = await alphaSettles(fight, remembered.alpha)
  check('…and exactly as faint', Math.abs(againAlpha - remembered.alpha) < EPS,
    `${String(sharedAlpha)} -> ${String(againAlpha)}, wanted ${String(remembered.alpha)}`)
  note('neither per-kind value was written while the overlays were synced — which is why there was something to come back to')
}
