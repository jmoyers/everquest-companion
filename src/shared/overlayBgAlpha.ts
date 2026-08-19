// overlayBgAlpha.ts — the floating overlays' BACKGROUND TRANSPARENCY, as four numbers and one clamp.
//
// Owner ask 2026-08-17, the day JOS-405 shipped the overlays' text size into Preferences: do the
// same for transparency. It is the `bg` slider every meter has carried in its footer since the
// overlays existed — the alpha its body is painted with — and it is now a PREFERENCE with the same
// shared/independent shape the text size has, plus a control in Preferences and one in each of the
// three strips' drag frames.
//
// ITS OWN FILE, BESIDE overlayTextScale.ts, for that file's reason: `shared/types.ts` owns
// `OverlayConfig.bgAlpha` and is at the 400-code-line factoring ceiling (JOS-140's ruling), and a
// slider's range plus a two-mode rule is not a type. It imports nothing at all, so a node test, the
// MUI-free overlay bundle and main can each read it.

/** The slider's floor. A body below this is not a fainter overlay, it is one nobody can see —
 *  which is why the store's old 0-1 clamp tightens to it (`clampBgAlpha`). */
export const BG_ALPHA_MIN = 0.1
/** Fully opaque: a solid card over the game. The top of every `bg` slider in the app. */
export const BG_ALPHA_MAX = 1
/** One notch of the slider. Fine on purpose: this is an aiming-at-a-shade control, not a ladder. */
export const BG_ALPHA_STEP = 0.02
/**
 * ONE PRESS OF THE PREFERENCES STEPPER — a 5% grid, and deliberately COARSER than the slider's
 * notch (JOS-408).
 *
 * The overlays' own `bg` sliders keep their 0.02, because a slider is an aiming control and you
 * are choosing a shade against the game behind it. Preferences no longer has a slider: the whole
 * page is steppers now, and a stepper that moved 2% a press would need twenty presses to cross the
 * range and would print percentages nobody can hold in their head (72, 74, 76…). Five is a number
 * a person reads as a step.
 *
 * IT IS A GRID, NOT AN INCREMENT, and `stepBgAlpha` is why that distinction is written down.
 */
export const BG_ALPHA_PREF_STEP = 0.05
/** What every overlay has painted itself with since the first one existed. */
export const BG_ALPHA_DEFAULT = 0.72

/**
 * Coerce a stored/patched alpha into range. Absent, malformed or non-finite ⇒ the default: the
 * field is renderer-writable and optional in the store, so it is clamped on the way IN and on the
 * way OUT (store.ts), exactly like `textScale` and the toast blob.
 *
 * THE FLOOR MOVED, AND THAT IS A MIGRATION (JOS-407). `setOverlayConfig` clamped this to 0-1 while
 * every slider in the app stopped at 0.1, so a hand-edited store — or the share import's `clamp01`
 * — could hold a 0 that no control could ever get back off the floor: an invisible window that
 * still eats its own pixels. Anything below 0.1 now reads as 0.1 on its first pass through here,
 * which is the smallest change that makes every stored value one a slider can express.
 *
 * The 2-decimal round is the `clampTextScale` argument on a 0.02 step: a slider walking in 0.02
 * from a float otherwise persists 0.7400000000000001 and prints it back as a percentage.
 */
export function clampBgAlpha(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return BG_ALPHA_DEFAULT
  return Math.min(BG_ALPHA_MAX, Math.max(BG_ALPHA_MIN, Math.round(v * 100) / 100))
}

/**
 * WALK TO THE NEXT POINT ON THE 5% GRID IN THAT DIRECTION (JOS-408).
 *
 * NOT `value + 0.05`. Every overlay in this app has carried a 0.02 slider since the first one
 * existed, so a real store is full of numbers that are not multiples of five — the shipped default
 * is 0.72 — and an increment would carry that offset forever (72 → 77 → 82). The grid instead
 * SNAPS: 72 → 75 → 80 going up, 72 → 70 → 65 going down. The value shown is still the exact
 * in-force one, so a stepper reads 72% and steps cleanly, which is the whole ask.
 *
 * ALREADY ON THE GRID MOVES A WHOLE STEP: from 0.70, up is 0.75 and not 0.70. That is what the
 * floor/ceil pair buys over a round — a round would make one of the two directions a no-op for
 * every on-grid value, which is a button that does nothing.
 *
 * The epsilon is float hygiene, not a fudge: `0.7 / 0.05` is 13.999999999999998 in IEEE-754, and
 * without it stepping up from 70% would land back on 70%. Both ends clamp to the slider's range,
 * so the control's disabled ends and this function agree about where the road stops.
 */
export function stepBgAlpha(value: unknown, dir: 1 | -1): number {
  const cur = clampBgAlpha(value)
  const cells = cur / BG_ALPHA_PREF_STEP
  const eps = 1e-9
  const next =
    dir > 0
      ? (Math.floor(cells + eps) + 1) * BG_ALPHA_PREF_STEP
      : (Math.ceil(cells - eps) - 1) * BG_ALPHA_PREF_STEP
  return clampBgAlpha(next)
}

// ---------------------------------------------------------------------------------------------
// ONE TRANSPARENCY, OR TWELVE — THE SWITCH, AND WHY ITS DEFAULT IS THE OTHER WAY UP
// ---------------------------------------------------------------------------------------------
//
// This is JOS-405's shape a second time, with the migration INVERTED, and the inversion is the
// whole point of the ticket. Text size was FANNED OUT: one press wrote all twelve kinds, so every
// install through 1.4.0 held twelve equal values and coming up synced changed nothing on anybody's
// screen. Transparency never was — `overlay:setConfig` wrote the kind that asked and nothing else —
// so the twelve values in a real store are whatever twelve separate decisions left there.
//
// THE ONE RULE ABOVE ALL (owner, 2026-08-17): do the least harm, match what people have. An install
// whose overlays are separately set today STAYS separate; one whose overlays all agree comes up
// synced at that value. Either way the first launch after the update looks exactly like the last
// launch before it — see `deriveBgAlphaPrefs`.
//
// WHY A SECOND VALUE RATHER THAN TWELVE, restated because it is the same argument one field over:
// the SHARED alpha gets a home of its own, the per-kind fields stop being written while the switch
// is off, and turning it back on finds each window's own number where its owner left it (the
// JOS-168 rule — an opt-in never destroys the values it is not currently reading).

/** The two facts behind every overlay's background: the one alpha, and whether it is the one used. */
export interface OverlayBgAlphaPrefs {
  /** The alpha every overlay paints with while `independent` is off. Clamped like any other. */
  shared: number
  /**
   * ON after an upgrade whose stored per-kind values DISAGREED, off otherwise — which is the
   * opposite default to the text size's switch, and deliberately so: nothing ever fanned this
   * field out, so differing values are the normal shape of a store that has been used.
   */
  independent: boolean
  /**
   * HAS THIS INSTALL EVER OPTED IN? Bookkeeping, not a setting — nothing in Preferences reads it.
   *
   * The argument is `OverlayTextSizePrefs.seeded`'s, unchanged: opting in must not change what
   * anything looks like, and on a store written entirely under sync it would have, because nothing
   * writes the per-kind fields while synced. So the FIRST opt-in makes every kind adopt what it is
   * currently drawing (`storeOverlayBgAlpha.ts seedAbsentKinds`), and this flag is what makes that
   * once-ever rather than every-time — a remembered 40% is never overwritten by a later flip.
   *
   * THE MIGRATION SETS IT TOO, and that is the one thing this flag does that the text size's does
   * not: an upgrading store that comes up INDEPENDENT is already in the opted-in state, and its
   * twelve values are the very thing being preserved. Seeding them from the shared alpha would
   * flatten exactly what the least-harm rule just decided to keep.
   */
  seeded?: boolean
}

/** What an install with no opinion does — and what every overlay has done since the first one. */
export const DEFAULT_OVERLAY_BG_ALPHA: OverlayBgAlphaPrefs = {
  shared: BG_ALPHA_DEFAULT,
  independent: false,
  seeded: false
}

/**
 * Coerce a stored/patched blob into the full shape. Absent, malformed or half-written ⇒ the
 * defaults, field by field — `normalizeOverlayTextSize`'s contract, on a blob with an alpha in it.
 */
export function normalizeOverlayBgAlpha(v: unknown): OverlayBgAlphaPrefs {
  const raw = (v ?? {}) as Partial<OverlayBgAlphaPrefs>
  return {
    shared: clampBgAlpha(raw.shared),
    independent: raw.independent === true,
    seeded: raw.seeded === true
  }
}

/**
 * Merge-patch it: fields the patch does not name (or names with the wrong type) keep what the base
 * holds. The base defaults to the shipped values, so `mergeOverlayBgAlpha(patch)` alone is a
 * normalize — the same two-argument door `mergeOverlayTextSize` opens, for the same three callers
 * (a renderer, a hand-edited file, and the store reader).
 */
export function mergeOverlayBgAlpha(
  patch: unknown,
  base: OverlayBgAlphaPrefs = DEFAULT_OVERLAY_BG_ALPHA
): OverlayBgAlphaPrefs {
  const p = (patch ?? {}) as Partial<OverlayBgAlphaPrefs>
  return {
    shared: typeof p.shared === 'number' ? clampBgAlpha(p.shared) : base.shared,
    independent: typeof p.independent === 'boolean' ? p.independent : base.independent,
    // ONE-WAY: bookkeeping a renderer must not be able to un-set. Nothing on the bridge sends it,
    // and a hand-edited `false` over a stored `true` would re-seed twelve windows from a value
    // their owner had already moved away from.
    seeded: base.seeded === true || p.seeded === true
  }
}

/**
 * THE EFFECTIVE ALPHA OF ONE KIND, and the only function that decides it.
 *
 * Every overlay window, the Preferences rows and the sliders read this and nothing else. The
 * per-kind field is consulted ONLY while the switch is on — which is the same sentence as "the
 * per-kind values survive being ignored", written as code rather than as a promise.
 */
export function effectiveOverlayBgAlpha(prefs: OverlayBgAlphaPrefs, kindBgAlpha: unknown): number {
  return prefs.independent ? clampBgAlpha(kindBgAlpha) : clampBgAlpha(prefs.shared)
}

/**
 * Has a shared alpha ever been WRITTEN? `null` means no, and no is the migration signal.
 *
 * Deliberately not `normalizeOverlayBgAlpha(...).shared`: that answers 0.72 for an absent key, and
 * 0.72 is also a perfectly ordinary stored answer. The difference between "never asked" and "asked
 * for 72%" is the whole of the upgrade below, so the absence has to survive the read.
 */
export function storedSharedBgAlpha(raw: unknown): number | null {
  const v = (raw ?? {}) as Partial<OverlayBgAlphaPrefs>
  return typeof v.shared === 'number' && Number.isFinite(v.shared) ? clampBgAlpha(v.shared) : null
}

/**
 * THE UPGRADE, AND THE LEAST-HARM RULE IT EXISTS TO KEEP (JOS-407).
 *
 * Read off the twelve values a store already holds, decide whether this install is one that has
 * been set separately or one that agrees with itself, and answer BOTH halves of the preference:
 *
 *   - EVERY VALUE EQUAL ⇒ `{ independent: false, shared: that value }`. Synced, at the number they
 *     all already were, so every window paints exactly what it painted yesterday. This is a fresh
 *     install (twelve absent values, all reading as the default) and it is also the tidy store.
 *   - ANY VALUE DIFFERENT ⇒ `{ independent: true, shared: the most common }`. Independent mode
 *     reads the per-kind values, so again every window paints what it painted yesterday — and the
 *     shared number, which is not in force, is seeded with the one that would surprise the fewest
 *     windows if the switch were ever turned off.
 *   - A TIE for most-common goes to the MORE OPAQUE value, because the failure that gets reported
 *     is text you cannot read over a bright game, never a card that is too solid.
 *   - NOTHING PASSED AT ALL (a caller with no kinds to offer) is the DEFAULT, synced. Deriving
 *     from an empty list is how a fresh install would come up at somebody else's transparency.
 *
 * THE CALLER PASSES ONE SLOT PER KIND, absent included: an absent config is a window drawing at
 * 0.72, so it is a vote for 0.72 and not a missing ballot. A store holding one deliberately faint
 * meter and eleven untouched windows is exactly the "any value different" case, and must come up
 * independent — counting only the stored one would call it unanimous and repaint eleven windows.
 */
export function deriveBgAlphaPrefs(kindAlphas: readonly unknown[]): OverlayBgAlphaPrefs {
  if (kindAlphas.length === 0) return { ...DEFAULT_OVERLAY_BG_ALPHA }
  const votes = new Map<number, number>()
  for (const v of kindAlphas) {
    const alpha = clampBgAlpha(v)
    votes.set(alpha, (votes.get(alpha) ?? 0) + 1)
  }
  let best = BG_ALPHA_DEFAULT
  let bestCount = 0
  for (const [alpha, count] of votes) {
    if (count > bestCount || (count === bestCount && alpha > best)) {
      best = alpha
      bestCount = count
    }
  }
  // The whole rule in one line: unanimous means one transparency, anything else means twelve.
  return { shared: best, independent: votes.size > 1, seeded: votes.size > 1 }
}
