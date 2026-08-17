// alertBanner.ts — the ALERT BANNER overlay (JOS-378): its per-kind knobs, the payload one
// firing sends it, the validator main re-runs on that payload, and THE ONE DERIVATION of what a
// banner line says.
//
// THE ASK, three times over: "alerts place large text in a positionable area of the screen,
// outside the event log" (2026-08-06), "an overlay in addition to audio alerts" (2026-08-12),
// "a popup with a message for alerts - I don't always hear it over Discord" (2026-08-15). The
// last one is the whole design in one sentence: a player on voice chat has the app's audio
// turned down or drowned out, so the alert needs a channel that is not a sound.
//
// IT IS A SEPARATE OVERLAY KIND, NOT A LANE IN THE CELEBRATION TOAST. The toast is a strip you
// glance at when something is worth cheering; this is text you need where your eyes already are,
// mid-pull. Position, size, lock, hold and text scale are therefore independently persisted per
// kind, exactly as the ten kinds before it are — and the queue machinery is SHARED rather than
// copied (renderer/overlay/cardQueue.ts).
//
// OFF BY DEFAULT (owner ruling 1, 2026-08-15). Every other notifier this app has shipped either
// costs nothing when idle and defaults on (the toast) or ships off pending validation; this one
// ships OFF because it is text over the game that the player did not ask for. `DEFAULT_OVERLAY_
// CONFIG.alertBanner.open` is false, no migration exists, and a store that has never heard of
// this key reads that default — see main/store.ts, which says the same thing about four kinds.
//
// WHAT A LINE SAYS IS THE ALERT'S NAME (owner ruling, 2026-08-15, JOS-380). `alertBannerText`
// resolves the def's optional `bannerText` override and otherwise prints `def.name`. It does NOT
// call the speech resolver: the eye and the ear want different sentences, and the name is the one
// the player wrote and already recognises from the alert list.
//
// Pure + dependency-free (types only), so `npm test` exercises every rule here with no Electron.

import type { AlertDef, AlertTriggerPrimitive, AppSignal } from './alertTypes'

// ---- the kind's own config knobs -------------------------------------------------------
//
// They ride `overlays.alertBanner` (OverlayConfig.alertBanner) rather than a second store key,
// for the reason `ToastOverlayConfig` rides `overlays.toast`: this is an overlay KIND in every
// sense, so it gets one open-state, one persisted bounds and one per-kind config read. `open` IS
// the design's "enabled" — two switches for one state is how they drift.

/**
 * Timing + capacity for the alert banner. Everything else it needs is standard OverlayConfig.
 */
export interface AlertBannerOverlayConfig {
  /** How long one line holds before it leaves, when the payload names no hold of its own. */
  holdMs: number
  /** Most lines on screen at once; a further arrival evicts the OLDEST. */
  maxLines: number
  /**
   * Has this install ever been TOLD what this overlay is (the toast's JOS-83 rule, applied)?
   *
   * False (and what an absent key reads as) means the overlay owes the user one self-identifying
   * card the first time it comes up. It flips true the moment that card is queued, so the
   * introduction is once per install. Unlike the toast this kind is only ever reached by someone
   * who just switched it on — but the card is what tells them WHERE it landed and how to move it,
   * which is the one thing an empty transparent strip cannot say.
   */
  introduced: boolean
}

/** Four seconds: long enough to read a raid call, short enough to be gone before the next one. */
export const DEFAULT_BANNER_HOLD_MS = 4000
export const BANNER_MIN_HOLD_MS = 1_000
/** The cap the owner set. A banner that held longer than this would be a window, not an alert. */
export const BANNER_MAX_HOLD_MS = 15_000

export const DEFAULT_BANNER_MAX_LINES = 4
export const BANNER_MIN_LINES = 1
export const BANNER_MAX_LINES = 8

export const DEFAULT_ALERT_BANNER_CONFIG: AlertBannerOverlayConfig = {
  holdMs: DEFAULT_BANNER_HOLD_MS,
  maxLines: DEFAULT_BANNER_MAX_LINES,
  introduced: false
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(v)))

/**
 * Coerce a stored/patched banner config into the valid shape (the store's clamp lives here).
 * The result carries ONLY the fields above, so a hand-edited key is dropped the next time this
 * blob is written rather than honoured.
 */
export function normalizeAlertBannerConfig(v: unknown): AlertBannerOverlayConfig {
  const o = asRecord(v)
  return {
    holdMs: clampInt(asNumber(o.holdMs, DEFAULT_BANNER_HOLD_MS), BANNER_MIN_HOLD_MS, BANNER_MAX_HOLD_MS),
    maxLines: clampInt(asNumber(o.maxLines, DEFAULT_BANNER_MAX_LINES), BANNER_MIN_LINES, BANNER_MAX_LINES),
    // Only a literal `true` counts, for `normalizeToastConfig`'s reason: showing one extra
    // introduction is a smaller failure than never explaining the window at all.
    introduced: o.introduced === true
  }
}

// ---- the per-alert colour swatch --------------------------------------------------------

/**
 * The colour a line is drawn in. ONE SWATCH ROW, closed union — the 2026-08-06 report asks for
 * "controllable size and color", and size is already the overlay's own text scale, so this is the
 * whole of the colour answer. It is deliberately not a hex picker: a free colour on text over a
 * game is how you end up with an unreadable banner, and six named swatches are a row the eye can
 * scan in the editor.
 *
 * 'default' is ABSENT rather than a value on the def — see `AlertDef.bannerColor`.
 */
export type AlertBannerColor = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'blue'

export const ALERT_BANNER_COLORS: AlertBannerColor[] = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'blue'
]

/**
 * What each swatch draws as. Here rather than in the overlay component because the EDITOR draws
 * the same six chips, and two tables of six colours is two answers to one question.
 *
 * Chosen bright against dark glass, not saturated primaries: this is text read at a glance over
 * a lit game scene, so every value is a light tint rather than a pure hue.
 */
export const ALERT_BANNER_COLOR_HEX: Record<AlertBannerColor, string> = {
  default: '#e6ebf5',
  red: '#ff6b6b',
  orange: '#ffa94d',
  yellow: '#ffd43b',
  green: '#69db7c',
  blue: '#74c0fc'
}

/** A stored/imported colour this build will act on, or undefined for "the overlay's default". */
export function normalizeBannerColor(v: unknown): AlertBannerColor | undefined {
  if (typeof v !== 'string') return undefined
  const found = ALERT_BANNER_COLORS.find((c) => c === v)
  return found === undefined || found === 'default' ? undefined : found
}

// ---- what a line SAYS -------------------------------------------------------------------

/**
 * Longest a banner line may be. The same 120 as the speech cap, arrived at independently: it is
 * about as much text as stays ONE glance at this size over a game scene.
 */
export const MAX_BANNER_CHARS = 120

/** The def fields the banner text resolver reads. Any AlertDef satisfies it. */
export type BannerDef = Pick<AlertDef, 'name' | 'bannerText'>

/**
 * THE ONE DERIVATION. What this alert's banner line says:
 *
 *   1. `bannerText`, when the user filled the "On-screen text" field. An override is the only
 *      reason that field exists, so a non-empty one wins outright.
 *   2. otherwise the alert's own NAME (owner ruling, 2026-08-15).
 *
 * IT NO LONGER ASKS THE SPEECH RESOLVER, and that is the ruling's whole point: a spoken phrase is
 * written for the EAR and reads long on screen ("Mez has dropped on a ghoul"), while the name is
 * the short thing the player typed themselves and already recognises from the alert list — which
 * is exactly what a glance mid-pull can resolve. The two channels are free to differ, and the
 * override field is how you make them differ deliberately.
 *
 * No firing is needed to answer this, so none is taken: the name is the same on every landing, and
 * a parameter that is never read is a claim that it might be.
 *
 * Returns null only when there is nothing truthful to print (a def with a blank name and no
 * override), in which case no banner is sent at all.
 */
export function alertBannerText(def: BannerDef): string | null {
  return cappedText(def.bannerText, MAX_BANNER_CHARS) ?? cappedText(def.name, MAX_BANNER_CHARS) ?? null
}

/**
 * Which app signals ALREADY SAY SOMETHING ON SCREEN — each has a celebration card of its own
 * (shared/toast.ts: 'bossKill' for a defeat, 'skyQuestComplete' for a quest).
 *
 * A Record rather than a list so a third `AppSignal` cannot be added without this file failing to
 * compile. "Does this event already draw a card?" is a question the new signal's author is the
 * only one who can answer, and silence would default it to exactly the double below.
 */
const CELEBRATED_SIGNAL: Record<AppSignal, boolean> = {
  bossDefeat: true,
  questComplete: true
}

const isCelebrated = (t: AlertTriggerPrimitive): boolean => t.type === 'app' && CELEBRATED_SIGNAL[t.signal]

/**
 * What an alert that has never said means by saying nothing (owner ruling, 2026-08-15, JOS-380).
 *
 * ON for everything, EXCEPT an alert that fires on an app signal the app already CELEBRATES. A
 * raid target going down drew both the celebration card and a banner line saying the same news,
 * and the card is the better of the two: it is the surface built for that event, with the mob, the
 * time and the deep link on it. A banner beside it is the same sentence twice on one screen.
 *
 * It is a DEFAULT, not a ban: an explicit `showOnScreen: true` still wins, which is what the row
 * toggle and the editor switch write. And because it is computed rather than stored, every install
 * that already has the built-in "raid target defeated" alert gets the fix with no migration.
 *
 * A composite defaults off only when EVERY condition is such a signal — one raw-line condition in
 * an 'any' means the alert can fire on something nothing celebrates, and that firing has earned a
 * line.
 */
export function defaultShowOnScreen(def: Pick<AlertDef, 'trigger'>): boolean {
  const t = def.trigger
  if ('conditions' in t) return !(t.conditions.length > 0 && t.conditions.every(isCelebrated))
  return !isCelebrated(t)
}

/**
 * Does this alert put a line on screen at all?
 *
 * ABSENT MEANS `defaultShowOnScreen` (owner ruling 2, narrowed by JOS-380). Every alert a user
 * already has was written before this existed and none of them carry the key, so the absent case
 * is what makes the overlay useful the moment it is switched on — for every trigger but the ones
 * that already have a card. The per-alert switch is then how you TAME it, which is the ruling's
 * own word. The overlay being off is the other half of the gate and is checked in main.
 */
export function alertShowsOnScreen(def: Pick<AlertDef, 'showOnScreen' | 'trigger'>): boolean {
  return def.showOnScreen ?? defaultShowOnScreen(def)
}

// ---- the wire ---------------------------------------------------------------------------

/**
 * ONE FIRING, as the banner overlay receives it.
 *
 * The renderer builds this (features/alerts/player.tsx) because that is where a firing becomes a
 * thing the user experiences; main relays it to the overlay window after re-validating, because
 * the overlay window is a different renderer process and only main can reach it.
 *
 * NO LOG CONTENT BEYOND THE ALERT'S OWN TEXT crosses this wire. `text` is the resolved sentence —
 * which may contain a `{target}`/capture value, already sanitized and capped by
 * shared/alertCaptures.ts at harvest time — and there is deliberately no `matchedText`, no raw
 * line and no event payload: a banner says what the alert says, and nothing about the log.
 */
export interface AlertBannerPayload {
  /** Queue identity — a repeat REFRESHES the line already on screen rather than stacking it. */
  id: string
  /** Which alert this line belongs to (diagnostics + the id above is derived from it). */
  alertId: string
  /** When the firing happened (ms epoch). */
  ts: number
  /** The resolved sentence (`alertBannerText`). */
  text: string
  /** The swatch, when the def named one; absent ⇒ the overlay's default colour. */
  color?: AlertBannerColor
  /** How long the line holds. Absent ⇒ the overlay config's `holdMs` (main fills it). */
  holdMs?: number
  /**
   * WHEN THE THING THIS WARNS ABOUT IS DUE (ms epoch) — the countdown half (JOS-378 slice 2).
   *
   * Present only on an EARLY-WARNING firing (`AlertDef.earlyWarnSec`, JOS-216/235), where main
   * knows the deadline it counted back from. The card then prints "… in 12s" and leaves when it
   * reaches zero instead of on a fixed hold. Absent on every ordinary firing, which is nearly all
   * of them — and absent, never guessed: a break that arrived EARLY has no deadline left, so it
   * gets an ordinary line rather than an invented clock (world-model law 1).
   */
  dueAt?: number
}

/** Rendering guarantees, not taste: a 40 kB "alert name" cannot push a line off the screen. */
const MAX_ID_CHARS = 120

function cappedText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : undefined
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
}

/**
 * Re-validate a renderer-supplied banner payload at main's handler.
 *
 * NOT A FORMALITY — the repo's rule (the `sounds:getData` packId precedent, restated in
 * shared/toast.ts) is that renderer input is re-checked at the handler rather than trusted
 * because today's only caller is the app's own UI. The result is REBUILT field by field, so an
 * unknown property never survives and everything that crosses into the window that DRAWS it is
 * capped or a closed union.
 *
 * Returns null when the payload cannot be honoured (no id, no alertId, no text).
 */
export function validateAlertBannerPayload(input: unknown): AlertBannerPayload | null {
  if (typeof input !== 'object' || input === null) return null
  const o = input as Record<string, unknown>
  const id = cappedText(o.id, MAX_ID_CHARS)
  const alertId = cappedText(o.alertId, MAX_ID_CHARS)
  const text = cappedText(o.text, MAX_BANNER_CHARS)
  if (!id || !alertId || !text) return null
  const out: AlertBannerPayload = { id, alertId, ts: positiveInt(o.ts) ?? Date.now(), text }
  const color = normalizeBannerColor(o.color)
  if (color) out.color = color
  const holdMs = positiveInt(o.holdMs)
  if (holdMs !== undefined) out.holdMs = clampInt(holdMs, BANNER_MIN_HOLD_MS, BANNER_MAX_HOLD_MS)
  const dueAt = positiveInt(o.dueAt)
  if (dueAt !== undefined) out.dueAt = dueAt
  return out
}

// ---- the introduction line ---------------------------------------------------------------

/** The introduction's queue identity. Stable, so a double-mount refreshes one line, not two. */
export const BANNER_INTRO_ID = 'alert-banner-intro'

/** The introduction holds for the longest a line ever may — long enough to read and act on. */
export const BANNER_INTRO_MS = BANNER_MAX_HOLD_MS

/**
 * The one line this overlay ever prints about ITSELF, the first time it comes up on an install.
 *
 * It says the three things an empty transparent strip cannot: what this window is, which alerts
 * reach it, and where the control that moves it lives. The words live here rather than in the
 * component so `npm test` can pin the promise they make — the same argument TOAST_INTRO_BODY
 * carries one file over.
 */
export const BANNER_INTRO_TEXT =
  'This is the alert banner - alerts marked Show on screen appear here. Move it from Preferences -> Overlays.'

export function introBannerPayload(now: number): AlertBannerPayload {
  return { id: BANNER_INTRO_ID, alertId: BANNER_INTRO_ID, ts: now, text: BANNER_INTRO_TEXT, holdMs: BANNER_INTRO_MS }
}
