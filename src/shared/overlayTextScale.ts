// overlayTextScale.ts — the floating overlays' TEXT SIZE, as four numbers and one clamp.
//
// Owner feedback 2026-08-05: "text size scaling for overlays. we are old folks now." It scales an
// overlay's reading matter — bars, feed rows, toast cards — and NOT its control chrome, which lays
// out against the real window width so a scaled overlay can never push its own controls out of the
// window (renderer overlay/overlayScale.tsx).
//
// SPLIT OUT OF types.ts (JOS-140), which is at the 400-code-line factoring ceiling; every name
// here is still exported from `shared/types` (which re-exports this module), so no importer moved
// and no import path changed. It sits beside `OverlayConfig.textScale`, the field it governs, in
// the same sense that shared/buffTimers.ts owns the row arrangement that field's neighbour names.

/** Below this the bars stop being legible at all — a smaller number is not a smaller meter,
 *  it is an unreadable one. */
export const TEXT_SCALE_MIN = 0.8
/** Above this a default 380x320 overlay holds barely a row; make the WINDOW bigger instead. */
export const TEXT_SCALE_MAX = 2
/** One press of the stepper. Coarse on purpose: this is a reading-distance control, not a slider. */
export const TEXT_SCALE_STEP = 0.1
export const TEXT_SCALE_DEFAULT = 1

/**
 * Coerce a stored/patched text scale into range. Absent, malformed or non-finite ⇒ the default:
 * the field is renderer-writable and optional in the store, so it is clamped on the way IN and
 * on the way OUT (store.ts), like bgAlpha and the toast blob.
 *
 * The 2-decimal round is not cosmetic: the stepper walks in 0.1 from a float, and without it a
 * few presses persist 1.2000000000000002 and print it back as the tooltip's percentage.
 */
export function clampTextScale(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return TEXT_SCALE_DEFAULT
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Math.round(v * 100) / 100))
}
