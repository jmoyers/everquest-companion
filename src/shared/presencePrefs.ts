// Presence-driven preferences: the CURSOR RING and OVERLAY AUTO-HIDE blobs.
//
// Both settings answer the same question — "what should the app do about the EQ window?" — and
// both are read by main (to gate the presence watcher), written by Preferences, and normalized
// by a store migration. That is exactly the `shared/speechText.ts` situation, so it gets the
// same shape: a PURE module with no Electron, no parser and no `types.ts` import, so
// `storeMigrations.ts` (which runs from store.ts's module scope, before electron-store exists)
// can reach the normalizers without dragging the LogEvent union in behind them.
//
// The types are re-exported from `shared/types.ts` like every other shared shape, so consumers
// keep one import site.
//
// EVERY reader defaults. A store written by a future build, a hand edit, or a downgrade can
// leave any value in any key (storeMigrations.ts's downgrade contract), so `normalize*` takes
// `unknown` and always answers with a complete, in-range blob.

/**
 * A screen rectangle in DIP (device-independent pixels) — the coordinate space Electron's
 * `screen.getCursorScreenPoint()` and `BrowserWindow.getBounds()` both speak, and the space a
 * page's CSS px maps onto 1:1. The presence watcher reports the EQ window in it.
 */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * What the presence watcher (src/main/presence.ts) knows about EverQuest right now.
 *
 * `eqBounds` is the last known rectangle of the EQ window — it SURVIVES EQ losing focus (the
 * cursor ring is sized to it and re-positions only when it CHANGES), and is null until the EQ
 * window has been foreground at least once this session.
 */
export interface PresenceState {
  /**
   * Has the watcher reported ANYTHING yet? False for the first moments of a launch (the watcher
   * thread has three system libraries to open before its first line) and again if it ever dies.
   *
   * This exists so the app never acts on a GUESS: before the first report every other field below
   * says "we have not looked", not "the game is closed / you are elsewhere" — and auto-hide would
   * otherwise blink every overlay off at startup and back on a second later, on a machine where
   * the game was running the whole time.
   *
   * IT IS ONE FLAG OVER FACTS LEARNED AT DIFFERENT MOMENTS, which is the trap JOS-425 fell into:
   * `applyRecord` raises it on the first record of ANY kind, so at that instant one lane is
   * measured and the others are still their defaults. That is why the defaults themselves have to
   * be the fail-open answer, and not merely this flag.
   */
  observed: boolean
  /**
   * Is an EverQuest process running at all? (5 s cadence — a coarse, cheap fact.)
   *
   * TRUE until the watcher says otherwise, on the same JOS-425 rule as `eqFocused` below — and
   * it also covers the case the watcher can leave permanently unmeasured: `presenceNative
   * eqRunning()` answers -1 when the process enumeration itself failed, and the worker then sends
   * no `R` at all rather than announcing a disappearance nobody observed. An unmeasured `false`
   * here would hide every overlay for the session on that machine.
   */
  eqRunning: boolean
  /**
   * Is the EQ window the FOREGROUND window?
   *
   * This app's ACCESSORY windows count as EQ-side (an overlay you are dragging, the cursor ring);
   * the COMPANION window does not, so bringing the app to the front reads as "not in EverQuest"
   * (JOS-199 — the whole matrix is `foregroundSide` in main/presenceProtocol.ts).
   *
   * TRUE until the watcher says otherwise (JOS-425 — see `INITIAL_PRESENCE`), for the same reason
   * `cursorVisible` is: a signal that can only ever take something away from the user must never
   * take it away on a value nobody has measured.
   */
  eqFocused: boolean
  /** Last known EQ window rectangle, or null if we have never seen it foreground. */
  eqBounds: ScreenRect | null
  /**
   * Is the system cursor being drawn? False while EverQuest holds mouselook (right button down),
   * which hides the cursor AND re-centers it every frame — an absolute cursor sample dances
   * around a pointer nobody can see.
   *
   * TRUE by default, so the ring behaves exactly as before until the watcher says otherwise. A
   * feature that only ever REMOVES the ring must not remove it on a state we have not measured.
   */
  cursorVisible: boolean
}

/**
 * "Nothing seen yet" — the state before the watcher's first line, and the state it is reset to
 * if the watcher ever dies. Every fact is the one that makes the app do NOTHING on it: no
 * hiding, no ring (no bounds) — and `cursorVisible:true`, because a signal that can only ever
 * REMOVE the ring must never remove it unmeasured.
 *
 * `eqFocused` IS BORN TRUE, AND THAT IS THE SAME RULE `observed:false` ALREADY STATES (JOS-425).
 * It read `false` for a year and the two disagreed at exactly one seam — the instant `observed`
 * flips. `overlaysShouldHide` fails OPEN while nothing has been looked at, and then the FIRST
 * watcher record sets `observed:true`; if `eqFocused` is still the unmeasured `false` at that
 * moment, `hideWhenUnfocused` hides every overlay on a fact nobody measured, and the focus
 * debounce shows them again 200 ms later. That is the reported startup blink, and it fires on
 * every watcher restart too. (The watcher's very first tick emits `C`, `F`, `R` in that order —
 * presence.ts `applyRecord` — so the cursor line raises `observed` BEFORE any foreground record
 * exists. There is no ordering in which the old default was safe.)
 *
 * "Assume EQ-side until observed otherwise" costs nothing anywhere else: the ring needs
 * `eqBounds` as well (`cursorRingActive`) and there are none here, so a reset still parks it;
 * and a hide now requires `FOCUS_HIDE_DEBOUNCE_MS` of OBSERVED non-EQ evidence, which is the
 * whole point. It is paired with `newFocusDebounce`'s born-true committed state
 * (main/presenceProtocol.ts) — the two must agree, or one of them is a seam again.
 *
 * `eqRunning` IS BORN TRUE FOR THE SAME REASON, and it is the SECOND seam the JOS-425 audit
 * found rather than a separate idea. `observed` is ONE flag over facts that are learned at
 * DIFFERENT moments: `applyRecord` raises it on the first record of any kind, and the `F` record
 * arrives before the `R` record on the watcher's first tick. So with `hideWhenNotRunning` on, an
 * `F` naming EverQuest itself used to hide every overlay on an `eqRunning` nobody had measured
 * yet, and the `R` a moment later showed them again. Born true, the same tick hides only when
 * the `R` actually says the game is gone — identical behavior when it is, no blink when it is
 * not. Neither default is ever the app's LAST word: the watcher's first tick always sends an
 * `R` when the enumeration works at all.
 */
export const INITIAL_PRESENCE: PresenceState = {
  observed: false,
  eqRunning: true,
  eqFocused: true,
  eqBounds: null,
  cursorVisible: true
}

/** One cursor sample pushed to the ring window, in that window's own CSS px. */
export interface CursorPoint {
  x: number
  y: number
}

/**
 * The "ultimate mouse cursor" ring (owner request: "I lose my mouse on EQ screens"). A thick
 * circle that follows the pointer, drawn ONLY over the EverQuest window — white, until the
 * player picks another colour (JOS-125).
 *
 * OFF BY DEFAULT and it stays that way: it costs a window, a watcher and an 8 ms poll, and a
 * user who has never lost their cursor should pay none of it.
 */
export interface CursorRingPrefs {
  /** Master switch. False ⇒ no ring window, no cursor poll, no presence watcher on its behalf. */
  enabled: boolean
  /** Outer diameter of the ring, in CSS px (= DIP — the ring window is pinned at zoom 1 so that
   *  identity holds; src/preload/cursor.ts, JOS-154). */
  sizePx: number
  /** Stroke width of the ring, in CSS px. Drawn INSIDE the diameter (border-box). */
  thicknessPx: number
  /**
   * The stroke's colour, as the `#rrggbb` an `<input type="color">` speaks (JOS-125).
   *
   * WHITE by default, which is the colour the ring has always been drawn in — so an upgrade
   * moves nobody's ring. `ringStrokeColor()` is the ONE place it becomes a CSS value.
   */
  colorHex: string
}

/**
 * Overlay auto-hide (owner request). TWO INDEPENDENT settings, deliberately not one tri-state:
 * "hide when the game isn't running" is housekeeping almost everyone wants, while "hide when
 * the game isn't focused" is a preference about alt-tabbing that many people actively don't.
 */
export interface OverlayAutoHidePrefs {
  /** Hide every open overlay while no EverQuest process is running. Default ON. */
  hideWhenNotRunning: boolean
  /** Hide every open overlay while EverQuest is not the foreground window. Default OFF. */
  hideWhenUnfocused: boolean
}

/** Ring size bounds. 20px is barely a dot; 200px stops being a cursor aid and starts being a
 *  window. The default is measured against the WoW addon look: a 44px halo reads at a glance
 *  without covering the thing you are clicking. */
export const MIN_RING_SIZE_PX = 20
export const MAX_RING_SIZE_PX = 200
export const DEFAULT_RING_SIZE_PX = 44

/** Stroke bounds. 1px vanishes over a busy scene; past 12px the ring fills its own hole. */
export const MIN_RING_THICKNESS_PX = 1
export const MAX_RING_THICKNESS_PX = 12
export const DEFAULT_RING_THICKNESS_PX = 4

/**
 * The default stroke colour: WHITE, because that is the colour every ring drawn before JOS-125
 * was. The picker exists so somebody who plays in a snowy zone can move off it, not to change
 * what anybody already has — an upgrading user must see exactly the ring they saw yesterday, and
 * `tests/cursorRingColor.test.mts` pins that against the CSS in cursor.html.
 */
export const DEFAULT_RING_COLOR = '#ffffff'

/**
 * The alpha the stroke has ALWAYS been drawn at, and it is not a setting.
 *
 * Readability comes from three shadows around ONE slightly-transparent stroke (cursor.html says
 * why): a dark contour outside, a dark contour inside, and a wide soft glow. Those are tuned
 * against 0.9, so the colour picker changes the hue and leaves the tuning alone. A user asking
 * for a colour is not asking for a different amount of contrast.
 */
export const RING_STROKE_ALPHA = 0.9

/** `#rgb` or `#rrggbb`, and nothing else. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * A ring colour, as a lower-case `#rrggbb`, or `fallback` if the value is not a hex colour.
 *
 * STRICT ON PURPOSE, and it is the only reason this value may be assigned to a style property.
 * The string arrives from a renderer, from the store file, or from a share import, and it ends
 * up in `element.style.borderColor` in the ring window; a normalizer that passed CSS through
 * would make that a place where somebody else's text becomes a declaration. Named colours
 * (`red`), `rgb()` and `var(--x)` are all refused for that reason, not for a spelling one —
 * `<input type="color">` cannot produce any of them.
 *
 * The short form is expanded here so every consumer sees ONE shape: the picker only ever emits
 * six digits, but a hand-edited store file may carry three.
 */
export function normalizeRingColor(value: unknown, fallback = DEFAULT_RING_COLOR): string {
  if (typeof value !== 'string') return fallback
  const hex = value.trim().toLowerCase()
  if (!HEX_COLOR.test(hex)) return fallback
  return hex.length === 7 ? hex : `#${hex.slice(1).replace(/./g, (d) => d + d)}`
}

/**
 * The ring's stroke as a CSS colour: the chosen hue at the fixed stroke alpha.
 *
 * ONE seam, three drawings — the ring window (renderer/src/overlay/cursorRing.ts), the live
 * sample in Preferences, and the static rule cursor.html paints with before its config arrives.
 * Two copies of this arithmetic is how the preview and the real ring come to disagree.
 */
export function ringStrokeColor(colorHex: string): string {
  const n = parseInt(normalizeRingColor(colorHex).slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${RING_STROKE_ALPHA})`
}

export const DEFAULT_CURSOR_RING: CursorRingPrefs = {
  enabled: false,
  sizePx: DEFAULT_RING_SIZE_PX,
  thicknessPx: DEFAULT_RING_THICKNESS_PX,
  colorHex: DEFAULT_RING_COLOR
}

export const DEFAULT_OVERLAY_AUTO_HIDE: OverlayAutoHidePrefs = {
  hideWhenNotRunning: true,
  hideWhenUnfocused: false
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A finite number clamped into [lo, hi] and rounded to whole px, or `fallback` if it isn't one. */
function clampPx(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(value)))
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

/**
 * The cursor-ring prefs, defaulted + clamped field by field. Takes `unknown` on purpose — the
 * same value flows in from the store file, from a renderer slider, and from a share import.
 *
 * The thickness is additionally capped at HALF the diameter: a 4px stroke on a 6px ring is a
 * filled dot, and a stroke wider than the radius is not a ring at all.
 */
export function normalizeCursorRing(value: unknown): CursorRingPrefs {
  const v = isPlainObject(value) ? value : {}
  const sizePx = clampPx(v.sizePx, MIN_RING_SIZE_PX, MAX_RING_SIZE_PX, DEFAULT_RING_SIZE_PX)
  const thickness = clampPx(
    v.thicknessPx,
    MIN_RING_THICKNESS_PX,
    MAX_RING_THICKNESS_PX,
    DEFAULT_RING_THICKNESS_PX
  )
  return {
    enabled: bool(v.enabled, DEFAULT_CURSOR_RING.enabled),
    sizePx,
    thicknessPx: Math.max(MIN_RING_THICKNESS_PX, Math.min(thickness, Math.floor(sizePx / 2))),
    colorHex: normalizeRingColor(v.colorHex)
  }
}

/** The overlay auto-hide prefs, defaulted field by field. */
export function normalizeOverlayAutoHide(value: unknown): OverlayAutoHidePrefs {
  const v = isPlainObject(value) ? value : {}
  return {
    hideWhenNotRunning: bool(v.hideWhenNotRunning, DEFAULT_OVERLAY_AUTO_HIDE.hideWhenNotRunning),
    hideWhenUnfocused: bool(v.hideWhenUnfocused, DEFAULT_OVERLAY_AUTO_HIDE.hideWhenUnfocused)
  }
}

/**
 * Does anything need the presence watcher running? The watcher is a worker thread; it starts
 * ONLY when a feature is switched on and stops the moment the last one goes off.
 *
 * Pure + exported because it is the exact predicate the gating tests pin: a user with every
 * one of these off must pay nothing at all.
 */
export function presenceNeeded(ring: CursorRingPrefs, autoHide: OverlayAutoHidePrefs): boolean {
  return ring.enabled || autoHide.hideWhenNotRunning || autoHide.hideWhenUnfocused
}

/**
 * Does anything need the CURSOR looked at? (JOS-193 — owner ruling 2026-08-10.)
 *
 * `presenceNeeded` is about the watcher's existence; this is about ONE of the four facts it can
 * report. The distinction exists because they are not the same question and the app was answering
 * as though they were: overlay auto-hide ships ON, so the DEFAULT install starts the watcher — and
 * the watcher then read `GetCursorInfo` ~69 times a second for `cursorVisible`, whose only
 * consumer in the entire app is `cursorRingActive`, for a ring that is OFF by default. A user who
 * never asked for a ring got a cursor polled 250,000 times an hour and nothing that read the
 * answer.
 *
 * The rule the owner asked for is the plain one: WITH THE RING OFF, THE APP DOES NOT TOUCH THE
 * CURSOR. Not the watcher's `GetCursorInfo`, not main's `screen.getCursorScreenPoint()`, and not a
 * ring window that exists to be sampled into — so a cursor tool like Yolomouse is working against
 * an app that is not in the room. The reason it is a named predicate rather than an inlined
 * `ring.enabled` is that it is a CLAIM about the rest of the tree — that `cursorVisible` has
 * exactly one consumer — and a claim wants somewhere to be written down and tested.
 *
 * Pure + exported for `tests/presence.test.mts`, like `presenceNeeded` beside it.
 */
export function cursorWatchNeeded(ring: CursorRingPrefs): boolean {
  return ring.enabled
}
