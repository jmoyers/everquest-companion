/**
 * prefsFirstPaintSteps.mts — THE INSTRUMENT THAT CAN SEE A FLICKER (JOS-340).
 *
 * Every other assertion this repo makes about a control reads it AFTER it settles, because
 * settling is what makes a claim deterministic (`settle`, `settleStable` — the wait-for-the-
 * condition law). That is exactly the wrong instrument here. The defect under test is a control
 * that ends up RIGHT and was WRONG on its first painted frame, so a settled read is guaranteed to
 * report green on the broken build and on the fixed one alike. The settle is what hides the flash.
 *
 * SO THIS RECORDS INSTEAD OF READING. A `MutationObserver` is installed through
 * `page.addInitScript` — which Playwright runs before ANY page script, on every navigation
 * including a reload, so there is no window in which the app could paint before the recorder
 * exists. Every DOM change samples the watched controls, and each control keeps the ORDERED LIST
 * of distinct values it has shown. A control that was always right reports one entry. A control
 * that flashed reports two, and the test prints the sequence, which names the bug: `off -> on` is
 * a stored ON that mounted on a `false` default.
 *
 * WHY A MUTATION OBSERVER AND NOT `requestAnimationFrame`. rAF can be throttled to nothing in a
 * never-composited window (AGENTS.md, wave E3 — the measured trap `nextFrames` exists for), and
 * this whole suite runs windows that are never shown. A MutationObserver callback is a microtask
 * checkpoint after the DOM changes, so it fires whether or not a frame is ever produced, and it
 * fires on the INSERTION of the control as well as on its later class changes. That covers both
 * halves: the value a control is born with, and every value it takes afterwards.
 *
 * WHAT IT SAMPLES, per kind:
 *   'switch' — the MUI `Switch`'s own `<input type=checkbox>`, read as the `checked` PROPERTY.
 *              React has already set it before the node is inserted, so the insertion sample is
 *              the first painted state. (The observer is armed on `class` too, because MUI
 *              expresses a later flip as a `Mui-checked` class swap, which a property write alone
 *              would not announce.)
 *   'toggle' — a `ToggleButtonGroup`'s lit member, by the `data-testid` of whatever carries
 *              `aria-pressed="true"`. The ladder in Text size is the non-boolean half of the
 *              ticket: a five-stop selector flashes exactly the same way a switch does.
 */
import type { Page } from 'playwright-core'
import { check, settle, settleStable } from './appHarness.mjs'

/** One control the recorder watches, named by its testid and by how to read its value. */
export interface Watch {
  id: string
  kind: 'switch' | 'toggle'
}

/**
 * THE CONTROLS THIS SPEC WATCHES, and why these three.
 *
 * The two Overlays switches are the ticket's own claim and they point OPPOSITE WAYS, which is the
 * only way to prove the fix is not just "default to true and hope": `hideWhenNotRunning` ships
 * `true` and is stored `false` here, `hideWhenUnfocused` ships `false` and is stored `true`. A
 * build that flashes would flash them in opposite directions, and a fix that only cured one
 * direction would leave exactly one of them red.
 *
 * The Text size ladder is the non-boolean, because "a control never paints a value it does not
 * know" is not a rule about checkboxes.
 *
 * The Alert banner switch is the REGRESSION (owner, hands-on, 2026-08-16): a card written after
 * JOS-340 that mounted on its default anyway, on the argument that the banner ships OFF so OFF is
 * the honest first guess. Stored ON here, so a card that guesses is caught in the same section as
 * the two originals — and its switch is not a plain preference but an overlay's OPEN-STATE, which
 * is the one shape of control the first three do not cover.
 */
export const WATCHED: Watch[] = [
  { id: 'pref-hide-when-not-running', kind: 'switch' },
  { id: 'pref-hide-when-unfocused', kind: 'switch' },
  { id: 'pref-banner-enabled', kind: 'switch' },
  { id: 'pref-text-size', kind: 'toggle' }
]

/** What the page exposes once the recorder is armed. Declared for the in-page casts below. */
interface Recorder {
  seen: Record<string, string[]>
  reset: () => void
  sample: () => void
}

interface Recorded {
  __jos340?: Recorder
}

/**
 * The recorder, as SOURCE TEXT rather than as a function.
 *
 * It has to be a string, and that is a measured constraint rather than a style choice: this suite
 * runs through `tsx`, whose esbuild pass has `keepNames` on, so it rewrites every named inner
 * function into `__name(fn, "fn")`. Playwright serializes a function argument by taking its
 * SOURCE, and `__name` does not exist inside the page — the first cut of this file died with
 * `ReferenceError: __name is not defined` on every document load. `{ content }` is handed to the
 * page verbatim, so nothing a bundler did to this file can reach it.
 *
 * The watch list is interpolated in rather than passed as an argument for the same reason the
 * script is registered before anything is driven: the observer that watches a RELOADED document is
 * created by this same text, already knowing what to look for, so a reload cannot land in a gap
 * where the app has painted and the instrument has not been armed.
 */
function recorderSource(spec: Watch[]): string {
  return `
(() => {
  const spec = ${JSON.stringify(spec)};
  const seen = {};
  function read(w) {
    const root = document.querySelector('[data-testid="' + w.id + '"]');
    if (!root) return null;
    if (w.kind === 'switch') {
      const input = root.querySelector('input');
      return input === null ? 'no-input' : (input.checked ? 'on' : 'off');
    }
    const lit = root.querySelector('[aria-pressed="true"]');
    return lit === null ? 'none' : (lit.getAttribute('data-testid') || 'unnamed');
  }
  function sample() {
    for (const w of spec) {
      const value = read(w);
      // A control that is not mounted is not a state, it is an absence - recording it would turn
      // every ordinary section switch into a fake transition.
      if (value === null) continue;
      const log = seen[w.id] || (seen[w.id] = []);
      if (log[log.length - 1] !== value) log.push(value);
    }
  }
  new MutationObserver(sample).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-pressed']
  });
  window.__jos340 = {
    seen: seen,
    // Emptied in place rather than reassigned, because the observer closure holds THIS object.
    reset: function () { for (const k of Object.keys(seen)) seen[k] = []; },
    sample: sample
  };
})();
`
}

/**
 * Arm the recorder for this page and every navigation it makes from here on.
 *
 * Called ONCE, before the app is ever driven.
 */
export async function armFirstPaintRecorder(page: Page): Promise<void> {
  await page.addInitScript({ content: recorderSource(WATCHED) })
}

/** Forget everything recorded so far. Called immediately before the mount under test. */
export function resetRecorder(page: Page): Promise<void> {
  return page.evaluate(() => {
    ;(window as unknown as Recorded).__jos340?.reset()
  })
}

/**
 * What each watched control has shown since the last reset, oldest first.
 *
 * IT SETTLES FIRST, AND THAT IS NOT A CONTRADICTION OF THIS FILE'S WHOLE POINT. The flicker is a
 * LATE correction: mount wrong, then an IPC round trip later, flip. Reading the history the
 * instant the control appears would therefore miss the second half and report a broken build as a
 * single wrong value — true, but a much poorer error message, and one that would go green the day
 * someone "fixed" the flash by making it slower. So the page is given time for a correction to
 * arrive, and the claim is then made against the RECORDED HISTORY rather than against what is on
 * screen. Settling is only fatal when it is what you MEASURE; here it is what you wait through.
 *
 * `settleStable` over the live values is the wait: hold until nothing has moved for four polls.
 * Then one manual sample, because a control's final state can in principle be reached by a
 * property write that announces no attribute mutation.
 */
export async function recorded(page: Page): Promise<Record<string, string[]>> {
  await settleStable(
    () =>
      page.evaluate(() => {
        const rec = (window as unknown as Recorded).__jos340
        rec?.sample()
        return JSON.stringify(rec?.seen ?? {})
      }),
    { timeoutMs: 10_000, stable: 4, pollMs: 120 }
  )
  return page.evaluate(() => {
    const rec = (window as unknown as Recorded).__jos340
    rec?.sample()
    return rec ? { ...rec.seen } : {}
  })
}

/**
 * THE CLAIM: `id` painted `expected` and NOTHING ELSE, ever, since the reset.
 *
 * One entry means the control was born correct. Two or more is the flicker, and the failure
 * detail is the whole sequence, so a red build says which way it went rather than merely that it
 * went. An EMPTY sequence fails too: a control nobody ever saw cannot have been painted right,
 * and silently passing on an absent selector is how this kind of test rots into a tautology.
 */
export function checkFirstPaint(
  seen: Record<string, string[]>,
  id: string,
  expected: string,
  what: string
): boolean {
  const log = seen[id] ?? []
  const ok = log.length === 1 && log[0] === expected
  return check(what, ok, log.length === 0 ? 'never rendered' : log.join(' -> '))
}

// ------------------------------------------------------------------ driving the pane

const NAV = '[data-testid="nav-preferences"]'

/** Open Preferences from wherever the app is. */
export async function openPrefs(page: Page): Promise<void> {
  await page.waitForSelector(NAV, { timeout: 60_000 })
  await page.click(NAV, { timeout: 30_000 })
  await page.waitForSelector('[data-testid="prefs-rail-game"]', { timeout: 30_000 })
}

/** Switch the rail to `id` and wait for something in that section to exist. */
export async function openSection(page: Page, id: string, marker: string): Promise<void> {
  await page.click(`[data-testid="prefs-rail-${id}"]`, { timeout: 20_000 })
  await page.waitForSelector(marker, { timeout: 20_000 })
}

/** The stored auto-hide prefs, straight from main - the arrange step's proof, not the UI's. */
export function storedAutoHide(page: Page): Promise<{ hideWhenNotRunning: boolean; hideWhenUnfocused: boolean }> {
  return page.evaluate(() =>
    (
      window as unknown as {
        eq: { getOverlayAutoHide: () => Promise<{ hideWhenNotRunning: boolean; hideWhenUnfocused: boolean }> }
      }
    ).eq.getOverlayAutoHide()
  )
}

/** The stored text scale, likewise. */
export function storedScale(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { eq: { getUiScale: () => Promise<number> } }).eq.getUiScale()
  )
}

/** Is this switch on right now? Used only by the ARRANGE step, where a settled read is correct. */
function switchIsOn(page: Page, id: string): Promise<boolean> {
  return page.$eval(`[data-testid="${id}"] input`, (el) => (el as HTMLInputElement).checked)
}

/**
 * Put a switch into `on` and WAIT for the control to agree — the arrange half, where settling is
 * exactly the right instrument because nothing here is a claim about a first frame.
 *
 * Idempotent, so a caller states what it wants rather than tracking what it did.
 */
export async function setSwitch(page: Page, id: string, on: boolean): Promise<boolean> {
  const sel = `[data-testid="${id}"] input`
  await page.waitForSelector(sel, { timeout: 20_000 })
  if ((await switchIsOn(page, id)) !== on) await page.click(sel, { timeout: 15_000 })
  const settled = await settle(() => switchIsOn(page, id), (v) => v === on, { timeoutMs: 8_000 })
  return settled === on
}
