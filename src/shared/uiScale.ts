// shared/uiScale.ts — THE PURE HALF of the main window's text size (JOS-123).
//
// WHY THIS EXISTS. Two independent reports asked for bigger text. The first
// (01KZ9PNBYSKMS7CWX5GFC94CF0) asked for it on the floating OVERLAYS and shipped as the per-kind
// `textScale` (a CSS `zoom` on the overlay content pane — shared/types.ts, overlayScale.tsx). The
// second (01KZHT0K97F7TM8D2QZJ4YA2E7, v0.13.0) is about the app itself: "Please allow us to
// enlarge the text. I can barely read it." That is this module.
//
// IT IS A WINDOW ZOOM, NOT A FONT SIZE, and the distinction is the whole design. A font-size knob
// would grow the words and leave every hand-tuned gap, icon, chart axis and fixed-width column
// where it was, so the surfaces that are hardest to read (meter rows, the timeline, the planner
// board) would be exactly the ones that broke. Electron gives the honest version for free: a
// per-webContents ZOOM FACTOR, which is what Ctrl+ does in a browser — layout runs at the same
// proportions and everything on screen ends up bigger together. So the stored number is a factor
// (1.25), the label is a percentage ("125%"), and the ticket's word for it, "text size", is what
// the user reads because it is what they asked for.
//
// A LADDER, NOT A SLIDER (the ticket's own preference, and the TextScaleStepper argument one level
// up): this is a reading-distance decision with a handful of useful answers, and a detent you can
// hit beats a track you have to aim at. The five stops are Chromium's OWN zoom levels around 100%
// — 90 / 100 / 110 / 125 / 150 — so the factor the app asks for is a factor Blink already
// snaps to, and every step is a size some browser has already proven readable.
//
// THE DEFAULT IS 1 AND MUST STAY 1. The key is absent in every store written before this shipped
// and `normalizeUiScale` answers 1 for an absent value, so an existing user's window is
// byte-identical after the upgrade. Nothing here ever decides on the user's behalf: there is no
// `auto`, no DPI sniffing, no "we noticed your screen is large". Compare shared/graphicsPrefs.ts,
// which DOES have an auto tier — that one compensates for a machine that cannot draw correctly;
// this one is a preference about eyes, and the app has no way to have an opinion about those.
//
// ZERO-IMPORT, like shared/perf.ts, shared/telemetry.ts and shared/graphicsPrefs.ts: main reads it
// from `windows.ts` at window construction, the store reads it on every get and set, and the
// Preferences card reads it in the renderer. No Electron, no Node — so `tests/uiScale.test.mts`
// pins every rule without a running app.

/**
 * The ladder, ascending. EXPORTED AS THE ONE SOURCE: the Preferences card renders a button per
 * entry, the normalizer snaps to it, and the test asserts its shape — so adding a stop is a
 * one-line change that cannot leave a control and a validator disagreeing.
 *
 * The bounds are the ends of this array and are not stated separately for that reason. 150% is
 * the top because the main window's `minWidth` is 900 device-independent pixels: at 1.5 that is
 * 600 CSS pixels of layout, which the app's narrow-window behaviour already covers, and past it
 * the columns start losing to the chrome rather than getting easier to read.
 */
export const UI_SCALE_STEPS: readonly number[] = [0.9, 1, 1.1, 1.25, 1.5]

/** The size every existing install is already running at, and the one a fresh one starts at. */
export const UI_SCALE_DEFAULT = 1

/** The smallest and largest stops, derived rather than typed twice. */
export const UI_SCALE_MIN = UI_SCALE_STEPS[0] ?? UI_SCALE_DEFAULT
export const UI_SCALE_MAX = UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1] ?? UI_SCALE_DEFAULT

/**
 * Coerce anything into a legal scale.
 *
 * SNAPS TO THE NEAREST STOP rather than clamping to a range, and that is deliberate: the control
 * is a set of five buttons, so a value BETWEEN two of them would leave none of them selected and
 * the card would render as if the user had never chosen anything. A stored 1.2 (a hand-edited
 * file, or a future build's finer ladder read by an older one) therefore comes back as 1.25 and
 * the window agrees with the button that is lit. Ties go to the SMALLER stop, so the answer is
 * deterministic rather than dependent on iteration order.
 *
 * Absent, malformed or non-finite is the DEFAULT, never a throw. This runs on the way out of the
 * store as well as in: the value is renderer-writable and hand-editable, and `zoomFactor: NaN` is
 * not an error anywhere, it is a window nobody can read.
 */
export function normalizeUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_SCALE_DEFAULT
  let best = UI_SCALE_DEFAULT
  let bestGap = Infinity
  for (const step of UI_SCALE_STEPS) {
    const gap = Math.abs(step - value)
    if (gap < bestGap) {
      best = step
      bestGap = gap
    }
  }
  return best
}

/**
 * ONE RUNG UP OR DOWN THE LADDER (JOS-408).
 *
 * The five buttons became an A− / A+ stepper, and the LADDER DID NOT CHANGE: it is still the
 * detents, so A+ from 110% lands on 125% rather than on 115%. That is the whole reason this is a
 * function on the ladder rather than an addition in the card — a stepper that added a fixed amount
 * would walk off the stops and `normalizeUiScale` would drag it back to one, which reads as a
 * button that sometimes does nothing.
 *
 * THE ENDS ARE FIXED POINTS, not an error: the control disables its own button there
 * (`PrefStepper`'s `atMin` / `atMax`), and a caller that presses anyway gets the value it had. An
 * off-ladder input is snapped first, so a hand-edited 1.19 steps up from 1.25 like everything else.
 */
export function stepUiScale(scale: number, dir: 1 | -1): number {
  const cur = normalizeUiScale(scale)
  const at = UI_SCALE_STEPS.indexOf(cur)
  const want = Math.min(UI_SCALE_STEPS.length - 1, Math.max(0, at + dir))
  return UI_SCALE_STEPS[want] ?? cur
}

/**
 * How a scale is SAID: "125%". The factor is a number nobody asked for in those terms, and every
 * surface that names one (the buttons, the caption, a test's expectation) goes through here so
 * they cannot round it differently.
 */
export function uiScalePercent(scale: number): string {
  return `${String(Math.round(scale * 100))}%`
}
