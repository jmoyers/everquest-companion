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

// ---------------------------------------------------------------------------------------------
// ONE SIZE, OR TWELVE — THE OPT-IN (JOS-405)
// ---------------------------------------------------------------------------------------------
//
// Two reports on the 1.4.0 mob card said the text was too small and that "text size options dont
// effect it"; an older one asked to "individually set the text size of each overlay window instead
// of them all changing together". Owner ruling 2026-08-17: ship both, as a DEFAULT and a SWITCH.
//
// The 2026-08-05 rule — one text size across every overlay — was right and stays right for almost
// everybody, so it is what an install without an opinion does. It is no longer a LAW, though: it
// is the OFF position of `independent`, and a player who wants their fight meter large and their
// respawn clocks small turns it on.
//
// WHY A SECOND VALUE RATHER THAN TWELVE. `OverlayConfig.textScale` is per kind and always was; the
// old fan-out kept twelve copies of one number in step by writing all twelve on every press. That
// works until somebody wants them apart — and then the twelve copies have already been flattened
// and there is nothing to go back to. So the SHARED size gets a home of its own, the per-kind
// fields stop being written while the switch is off, and turning it back on finds each window's
// own number exactly where its owner left it (the JOS-168 precedent: an opt-in never destroys the
// values it is not currently reading).

/** The two facts behind every overlay's text size: the one size, and whether it is the one used. */
export interface OverlayTextSizePrefs {
  /** The size every overlay draws at while `independent` is off. Clamped like any other scale. */
  shared: number
  /** OFF ships: one size for everything, which is what every install before JOS-405 had. */
  independent: boolean
  /**
   * HAS THIS INSTALL EVER OPTED IN? Bookkeeping, not a setting — nothing in Preferences reads it.
   *
   * OPTING IN MUST NOT RESIZE ANYTHING, and on a store written entirely under sync it would have.
   * The ticket's design reasons from an UPGRADING install, where the retired fan-out left twelve
   * equal per-kind values, so switching to independent finds every window already at the shared
   * size. A store written on 1.5.0 has no such history — nothing writes the per-kind fields while
   * synced, which is the whole point — so a player who set the shared size to 150% and then asked
   * for independent sizes would watch all twelve windows snap back to 100%. That is the opposite
   * of what they asked for: they asked to start setting sizes SEPARATELY, from where things are.
   *
   * So the FIRST time independent is turned on, every kind adopts what it is currently drawing at
   * (`storeOverlayTextSize.ts seedAbsentKinds`), and this flag is what makes that once-ever rather
   * than every-time — which is what keeps the JOS-168 rule intact. A remembered 150% is never
   * overwritten by a later flip, because a later flip does nothing at all.
   *
   * WHY A FLAG AND NOT "IS THE VALUE ABSENT". MEASURED: `setOverlayConfig` merges over
   * `getOverlayConfig`, which clamps an absent `textScale` to the default — so ANY write to an
   * overlay's config (a drag, a lock) materializes a `textScale` of 1. Absence is therefore not a
   * fact this store can be asked about, and a seed keyed on it would skip exactly the windows
   * somebody had moved.
   */
  seeded?: boolean
}

/** What an install with no opinion does — and, deliberately, what 1.4.0 already did. */
export const DEFAULT_OVERLAY_TEXT_SIZE: OverlayTextSizePrefs = {
  shared: TEXT_SCALE_DEFAULT,
  independent: false,
  seeded: false
}

/**
 * Coerce a stored/patched blob into the full shape. Absent, malformed or half-written ⇒ the
 * defaults, field by field — the `normalizeOverlaySnap` contract, on a blob with a number in it.
 */
export function normalizeOverlayTextSize(v: unknown): OverlayTextSizePrefs {
  const raw = (v ?? {}) as Partial<OverlayTextSizePrefs>
  return {
    shared: clampTextScale(raw.shared),
    independent: raw.independent === true,
    seeded: raw.seeded === true
  }
}

/**
 * Merge-patch it: fields the patch does not name (or names with the wrong type) keep what the base
 * holds. The base defaults to today's shipped values, so `mergeOverlayTextSize(patch)` alone is a
 * normalize — same two-argument door `mergeOverlaySnap` opens, for the same three callers (a
 * renderer, a hand-edited file, and the store reader).
 */
export function mergeOverlayTextSize(
  patch: unknown,
  base: OverlayTextSizePrefs = DEFAULT_OVERLAY_TEXT_SIZE
): OverlayTextSizePrefs {
  const p = (patch ?? {}) as Partial<OverlayTextSizePrefs>
  return {
    shared: typeof p.shared === 'number' ? clampTextScale(p.shared) : base.shared,
    independent: typeof p.independent === 'boolean' ? p.independent : base.independent,
    // ONE-WAY: bookkeeping a renderer must not be able to un-set. Nothing on the bridge sends it,
    // and a hand-edited `false` over a stored `true` would re-seed twelve windows from a value
    // their owner had already moved away from.
    seeded: base.seeded === true || p.seeded === true
  }
}

/**
 * THE EFFECTIVE SCALE OF ONE KIND, and the only function that decides it.
 *
 * Every overlay window, the Preferences rows and the steppers' disabled ends read this and nothing
 * else. The per-kind field is consulted ONLY while the switch is on — which is the same sentence
 * as "the per-kind values survive being ignored", written as code rather than as a promise.
 */
export function effectiveOverlayTextScale(
  prefs: OverlayTextSizePrefs,
  kindTextScale: unknown
): number {
  return prefs.independent ? clampTextScale(kindTextScale) : clampTextScale(prefs.shared)
}

/**
 * Has a shared size ever been WRITTEN? `null` means no, and no is the migration signal.
 *
 * It is deliberately not `normalizeOverlayTextSize(...).shared`: that answers 1.0 for an absent
 * key, and 1.0 is also a perfectly ordinary stored answer. The difference between "never asked"
 * and "asked for 100%" is the whole of the upgrade below, so the absence has to survive the read.
 */
export function storedSharedTextScale(raw: unknown): number | null {
  const v = (raw ?? {}) as Partial<OverlayTextSizePrefs>
  return typeof v.shared === 'number' && Number.isFinite(v.shared) ? clampTextScale(v.shared) : null
}

/**
 * THE UPGRADE: what one size should be, read off the twelve that already exist.
 *
 * Every install through 1.4.0 holds twelve EQUAL per-kind values, because the old setter fanned
 * every press out to all of them — so for every real store this is exact and nobody's overlays
 * change size on the first launch after the update. The general rule is stated anyway, because a
 * store can be hand-edited and a downgrade-then-upgrade can leave any key in any state:
 *
 *   - the MOST COMMON of the stored values wins;
 *   - a TIE goes to the LARGER, because the entire ask behind this feature is bigger text;
 *   - NOTHING stored (a fresh install, or a store whose kinds carry no scale) is the DEFAULT,
 *     never a derived number — deriving from an empty list is how a fresh install would come up
 *     at somebody else's size.
 *
 * The caller passes the raw per-kind fields; anything that is not a finite number is not a vote.
 */
export function deriveSharedTextScale(kindScales: readonly unknown[]): number {
  const votes = new Map<number, number>()
  for (const v of kindScales) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const scale = clampTextScale(v)
    votes.set(scale, (votes.get(scale) ?? 0) + 1)
  }
  let best = TEXT_SCALE_DEFAULT
  let bestCount = 0
  for (const [scale, count] of votes) {
    if (count > bestCount || (count === bestCount && scale > best)) {
      best = scale
      bestCount = count
    }
  }
  return best
}
