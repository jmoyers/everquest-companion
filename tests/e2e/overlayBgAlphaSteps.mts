/**
 * THE OVERLAYS' TRANSPARENCY, ACROSS PROCESSES (JOS-407) — steps for tests/e2e/text-size.e2e.mts.
 *
 * ./overlayTextSizeSteps.mts one field over, and here for the same four reasons: every claim below
 * is about SEPARATE RENDERER PROCESSES agreeing, which no assertion inside one of them can make.
 * `tests/overlayBgAlpha.test.mts` pins the rule (`independent ? per-kind : shared`), the
 * normalizer, the least-harm migration and the handler's routing as source; what it cannot say is
 * that a slider in the app window repaints a floating window that is not it.
 *
 * AND ONE REASON OF ITS OWN: the TWO SWITCHES. Transparency and text size are linked and unlinked
 * separately by design (owner, 2026-08-17), so the interesting state is the one where a row's text
 * stepper is live and its `bg` slider is not — which is exactly the state this spec is in when it
 * starts, because the text-size steps run first and leave their switch ON.
 *
 * WHAT IS MEASURED IS THE PAINT ITSELF, not the store: the meters paint their body
 * `rgba(14,17,21,<alpha>)` and this reads that back off the real document. A spec that asked
 * `getBgAlpha()` instead would pass on a build where the value arrived and nothing painted it.
 *
 * NO WINDOW IS EVER SHOWN (`EQ_E2E=1`). A window's own `bg` slider is driven through
 * `eqOverlay.setConfig({ bgAlpha })` — the very call the slider makes (BgAlphaSlider's `patch`) —
 * because a hidden, always-on-top window has no pointer to drag with. The PREFERENCES slider is
 * driven by KEYBOARD, which is a real user gesture on a real control: MUI's Slider moves one
 * `step` per arrow key, so the expected value is arithmetic rather than a guess about where in a
 * track a click landed.
 */
import type { Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'

const PANE = '[data-testid="pref-overlay-bg-alpha"]'
const SHARED_INPUT = '[data-testid="pref-overlay-bg-alpha-slider"] input'
const SHARED_VALUE = '[data-testid="pref-overlay-bg-alpha-value"]'
const SWITCH = '[data-testid="pref-overlay-bg-independent"] input'
const TEXT_SWITCH = '[data-testid="pref-overlay-text-independent"] input'

/** A row's testids are built from the kind, never by appending to another SELECTOR. */
const rowTestId = (kind: string, part = ''): string => `[data-testid="pref-overlay-bg-alpha-${kind}${part}"]`
const rowInput = (kind: string): string => `${rowTestId(kind, '-slider')} input`
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

/** `BG_ALPHA_STEP` from src/shared/overlayBgAlpha.ts, spelled out rather than imported: an e2e file
 *  loads no `src` module (tests/e2e/overlayMinSizeSteps.mts states that rule). */
const STEP = 0.02
/** A float through a CSS rgba string and a percentage; one step is 0.02, so this tells two
 *  neighbouring values apart by an order of magnitude. */
const EPS = 0.001

/**
 * WHAT THE WINDOW IS PAINTING: the alpha of the one body background it draws.
 *
 * Found by scanning the computed styles for `rgba(14, 17, 21, a)` — the meters' body colour —
 * rather than by a testid, because the placement is part of the claim: a build that put the alpha
 * somewhere other than the body would still satisfy a testid and would be wrong. `NaN` when no
 * element paints it, which reads as a failure rather than as a pass.
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

/** …settled, because it arrives over IPC from another process. */
function alphaSettles(page: Page, want: number): Promise<number> {
  return settle(() => bodyAlpha(page), (a) => Math.abs(a - want) < EPS, { timeoutMs: 15_000 })
}

/** The percentage Preferences is printing for the shared transparency. */
function sharedPercent(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    SHARED_VALUE
  )
}

const pct = (alpha: number): string => `${String(Math.round(alpha * 100))}%`

/**
 * Move a Preferences slider by N notches, with the keyboard.
 *
 * MUI's Slider moves exactly one `step` per arrow key on its own input, so this is a real gesture
 * with an arithmetic outcome — a CLICK on the track would land wherever the track's geometry put
 * it, which is not a value a spec can predict.
 */
async function nudge(page: Page, selector: string, notches: number): Promise<void> {
  await page.focus(selector, { timeout: 15_000 })
  for (let i = 0; i < Math.abs(notches); i++) {
    await page.keyboard.press(notches > 0 ? 'ArrowRight' : 'ArrowLeft')
  }
}

/** Whether a control is disabled, as the DOM states it. */
function isDisabled(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.disabled === true,
    selector
  )
}

/**
 * THE CARD ITSELF — and the TWO SWITCHES, which is the claim only this spec is placed to make.
 *
 * It runs after the text-size steps, which leave their own switch ON. So at this moment every row
 * carries a LIVE text stepper and a DISABLED `bg` slider, and that is not an accident of ordering:
 * it is the owner's ruling made visible. A build that had wired one switch to both controls would
 * pass every source pin and fail right here.
 */
export async function stepBgAlphaCard(page: Page): Promise<void> {
  check('Preferences → Text size & transparency carries the overlays’ transparency', (await countOf(page, PANE)) === 1)
  const rows = await page.evaluate(
    (kinds) => kinds.filter((k) => document.querySelector(`[data-testid="pref-overlay-bg-alpha-${k}"]`) !== null),
    ALL_KINDS
  )
  check(
    'every overlay kind has a transparency control, including the three strips that never had one',
    rows.length === ALL_KINDS.length,
    `${String(rows.length)} of ${String(ALL_KINDS.length)}: missing ${ALL_KINDS.filter((k) => !rows.includes(k)).join(', ') || 'none'}`
  )
  const on = await page.evaluate((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked, SWITCH)
  check(
    'independent transparency ships OFF on a fresh install — its twelve values all agree, so they stay one',
    on === false,
    String(on)
  )

  // THE TWO SWITCHES, in one measurement. The text-size steps left their switch ON.
  const textOn = await page.evaluate((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked, TEXT_SWITCH)
  check('…and the text size’s switch is a DIFFERENT switch, still on from the steps before this', textOn === true, String(textOn))
  // SETTLED, not read once. The switch is in one card and the rows are in another, so the row's
  // live-ness reaches it the long way round — through main's broadcast and back into this React
  // tree — and the step before this one only ever waited on the OVERLAY window agreeing.
  const textLive = await settle(
    () => isDisabled(page, '[data-testid="pref-overlay-text-size-fight-plus"]'),
    (d) => !d,
    { timeoutMs: 15_000 }
  ).catch(() => true)
  const alphaDead = await isDisabled(page, rowInput('fight'))
  check(
    'so one row can be half live: the fight meter’s size is settable and its transparency is not',
    textLive === false && alphaDead,
    `size disabled: ${String(textLive)}, transparency disabled: ${String(alphaDead)}`
  )

  const disabled: string[] = []
  for (const k of ALL_KINDS) if (await isDisabled(page, rowInput(k))) disabled.push(k)
  check('…and while they share one transparency, EVERY row’s slider is disabled', disabled.length === ALL_KINDS.length,
    `${String(disabled.length)} of ${String(ALL_KINDS.length)}`)

  // THE TOOLTIP IS THE OTHER HALF: a disabled control that does not say why is a dead end. MUI
  // renders it on hover, so what is asserted here is that the ANCHOR is wired — the wrapping span
  // a disabled control needs, carrying the sentence.
  const tip = await page.evaluate((sel) => {
    const control = document.querySelector(sel)
    const span = control?.parentElement
    return span?.getAttribute('aria-label') ?? span?.getAttribute('title') ?? ''
  }, rowTestId('fight'))
  check('…and hovering one explains itself rather than just refusing', /independent transparency/i.test(tip),
    tip.slice(0, 140) || '(no tooltip on the wrapping span)')
}

/**
 * ACCEPTANCE: moving Preferences' transparency repaints every open overlay, live.
 *
 * TWO windows, because one would not separate "this overlay obeys Preferences" from "every overlay
 * obeys Preferences", and the second is the whole of what the shared mode means.
 */
export async function stepSharedAlphaAppliesLive(page: Page, fight: Page, overall: Page): Promise<void> {
  const before = await bodyAlpha(fight)
  check('the fight meter paints a background to measure against', Number.isFinite(before), String(before))
  const want = Math.round((before - STEP * 4) * 100) / 100
  await nudge(page, SHARED_INPUT, -4)
  const f = await alphaSettles(fight, want)
  const o = await alphaSettles(overall, want)
  check('four notches down in Preferences makes the fight meter more see-through, live',
    Math.abs(f - want) < EPS, `${String(before)} -> ${String(f)}`)
  check('…and the zone meter with it — one transparency for all of them, unless told otherwise',
    Math.abs(o - want) < EPS, String(o))
  const shown = await sharedPercent(page)
  check('…and Preferences prints what it just did', shown === pct(want), shown)
}

/**
 * …AND THE SAME VALUE MOVES FROM A WINDOW'S OWN `bg` SLIDER.
 *
 * The other direction, and the one this ticket had to be careful with: that slider has ALWAYS
 * written this kind's own value, and now it moves a preference instead while synced. Nobody
 * dragging it can tell the difference, and this step is what says so.
 */
export async function stepWindowMovesSharedAlpha(page: Page, fight: Page, overall: Page): Promise<void> {
  const want = 0.5
  await fight.evaluate(
    (a) =>
      (window as unknown as { eqOverlay: { setConfig: (p: { bgAlpha: number }) => Promise<unknown> } })
        .eqOverlay.setConfig({ bgAlpha: a }),
    want
  )
  const o = await alphaSettles(overall, want)
  check('a drag on the fight meter’s own bg slider repaints the zone meter too', Math.abs(o - want) < EPS, String(o))
  const shown = await settle(() => sharedPercent(page), (p) => p === pct(want), { timeoutMs: 15_000 })
  check('…and Preferences, left open, agrees with the drag it did not make', shown === pct(want), shown)
}

/**
 * ACCEPTANCE: with Independent transparency on, a row moves ONLY that overlay.
 *
 * The holding half is the one that matters and it is an ABSENCE, so it is measured rather than
 * waited for: the zone meter is read AFTER the fight meter has already settled on its new value,
 * which is the moment a leaked write would have arrived.
 */
export async function stepIndependentAlpha(page: Page, fight: Page, overall: Page): Promise<number> {
  await page.click(SWITCH, { timeout: 15_000 })
  const live = await settle(() => isDisabled(page, rowInput('fight')), (d) => !d, { timeoutMs: 15_000 })
  check('turning the switch on makes the rows live', live === false)

  const held = await bodyAlpha(overall)
  const before = await bodyAlpha(fight)
  const want = Math.round((before - STEP * 5) * 100) / 100
  await nudge(page, rowInput('fight'), -5)
  const f = await alphaSettles(fight, want)
  check('the fight meter’s own row moves the fight meter', Math.abs(f - want) < EPS, `${String(before)} -> ${String(f)}`)
  check('…and the zone meter HOLDS — which is the whole of what independent means',
    Math.abs((await bodyAlpha(overall)) - held) < EPS, `${String(held)} -> ${String(await bodyAlpha(overall))}`)
  const shown = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '', rowValue('fight'))
  check('…and the row states its own transparency now, not the shared one', shown === pct(want), shown)
  return want
}

/**
 * ACCEPTANCE: the per-kind values SURVIVE the switch going off and on (the JOS-168 precedent).
 *
 * Off: both windows come back to the shared transparency — including the one that had its own. On
 * again: that one is exactly where its owner left it. Nothing writes a per-kind value while synced,
 * which is what makes the second half true.
 */
export async function stepAlphaSurvivesTheSwitch(page: Page, fight: Page, overall: Page, remembered: number): Promise<void> {
  const shared = await bodyAlpha(overall)
  await page.click(SWITCH, { timeout: 15_000 })
  const back = await alphaSettles(fight, shared)
  check('turning independent transparency off puts every overlay back on the one value',
    Math.abs(back - shared) < EPS, `${String(remembered)} -> ${String(back)} (shared ${String(shared)})`)
  // SETTLED, not read once: the switch lives in one card and the rows in another, so this value
  // reaches them the long way round — through main's broadcast and back into a second React tree.
  const rowShows = await settle(
    () => page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '', rowValue('fight')),
    (v) => v === pct(shared),
    { timeoutMs: 15_000 }
  )
  check('…and the disabled row states the value in force, never the one it remembers', rowShows === pct(shared), rowShows)

  await page.click(SWITCH, { timeout: 15_000 })
  const again = await alphaSettles(fight, remembered)
  check('…and turning it back on finds that meter exactly where its owner left it',
    Math.abs(again - remembered) < EPS, `${String(shared)} -> ${String(again)}, wanted ${String(remembered)}`)
  note('the per-kind transparency was never written while the overlays were synced — which is why there was something to come back to')
}
