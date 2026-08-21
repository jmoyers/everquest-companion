// shared/resistPrefs.ts — THE PURE HALF of "does NPC-on-NPC evidence count?" (JOS-385).
//
// WHY THERE IS A SETTING AT ALL. JOS-382 shipped resist profiles from PLAYER casters only, on the
// owner's ruling that an NPC's spell "rolls against a different table". JOS-385 revisits that with
// a specific worry attached: a player casting fire gets resisted where a charmed pet casting fire
// does not, because pets are tuned differently — and if that is real, folding pet casts into a
// mob's fire number would silently drag it DOWN and tell the player to nuke fire on something that
// eats fire. So NPC casters became a FAMILY THE USER CAN SWITCH OFF rather than a decision taken
// once for everybody, and the shipped default was set by measuring the two populations against
// each other on the owner's log (the `--compare` mode of scripts/gen-resist-baseline.ts).
//
// THE SWITCH IS READ AT ESTIMATE TIME, NEVER AT FOLD TIME, and that is the whole design:
//
//   * The LEDGER always folds npc rows. They are OBSERVATIONS — things the log printed — and the
//     file that stores them is not allowed to hold a verdict about whether they are useful
//     (resistTypes.ts's one design rule). A switch that gated the fold would mean flipping it
//     re-reads every log the user has ever tailed, and would mean a shipped baseline that could
//     never be re-decided.
//   * `estimate()` decides whether they WEIGH. Flipping the switch therefore changes every number
//     on the next draw, costs nothing, and is reversible — which is exactly what a setting whose
//     right value is an empirical question needs to be.
//
// ONE FIELD, DEFAULT ON. See the ticket's decision rule: NPC casters go OFF by default only if
// they read as SYSTEMATICALLY less resisted than players on the axes the worry names. They do not,
// so they ship on.
//
// A ZERO-IMPORT module, for the same reason `shared/processPriority.ts` and `shared/perf.ts` are:
// `storeMigrations.ts` runs from store.ts's module scope before electron-store exists, and it
// needs this normalizer without dragging the resist type graph in behind it.

/**
 * The persisted resist-evidence prefs. A blob rather than a bare key so the feature has somewhere
 * to grow (a per-axis exclusion, a "your log only" switch) without a second schema shape — the
 * `perfHud` / `processPriority` precedent exactly.
 */
export interface ResistPrefs {
  /**
   * Count charmed pets and NPC casters resisting or landing on other NPCs as evidence about the
   * target's resists. ON: they are ordinary observations under the same model. OFF: their rows
   * stay in the ledger and in the evidence lines, and no number is computed from them.
   */
  includeNpcCasters: boolean
}

/** ON. The measured comparison on the owner's log did not find the pet-tuning skew (JOS-385). */
export const DEFAULT_RESIST_PREFS: ResistPrefs = { includeNpcCasters: true }

/**
 * Defaulted field by field, from `unknown`: the same value arrives from the store file, from a
 * renderer toggle and from the v13 → v14 migration. A malformed value is replaced by the
 * documented default, never coerced.
 */
export function normalizeResistPrefs(value: unknown): ResistPrefs {
  const v: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    includeNpcCasters:
      typeof v.includeNpcCasters === 'boolean'
        ? v.includeNpcCasters
        : DEFAULT_RESIST_PREFS.includeNpcCasters
  }
}
