// buffAllow.ts — WHICH BUFFS AND DEBUFFS THE TWO TIMER WINDOWS ARE ALLOWED TO DRAW (JOS-168).
//
// The owner's ask, verbatim (2026-08-16): "we need a way to allow-list buffs/debuffs for the
// overlay. this would be a setting in the buff tab - when on, you have to enable individual buffs
// and debuffs for tracking instead of all of them showing up in the overlay. you would check a box
// on the card for each buff/debuff after casting. you should also be able to search in the
// buffs/debuffs list and check them from there. when in the other mode (the default mode),
// everything is on by default."
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THREE FACTS, AND THE THIRD IS THE ONE THAT IS EASY TO GET WRONG.
//
// 1. A MODE. `optIn` off is the shipped answer and means every spell draws, exactly as it always
//    has — AND THERE ARE NO CHECKBOXES (owner ruling 2026-08-17: "'only track' should enable the
//    checkboxes, when its disabled there shouldn't be any checkboxes. so its opt-in, or no
//    choice."). On means the boxes appear and the windows draw ONLY what you have checked. It is
//    one boolean, stored beside the choices, because it is the thing that decides whether they
//    are consulted at all.
//
// 2. A VERDICT PER SPELL LINE. `lines[key]` is `true` (checked), `false` (unchecked) or ABSENT
//    (never touched). In opt-in mode only `true` draws; with the mode off the map is not read at
//    all. `false` and absent read the same; the record keeps the distinction only because a
//    written answer is cheaper to keep than to collapse, and `null` in a patch still withdraws one.
//
// 3. FLIPPING THE MODE MUST NEVER LOSE A CHOICE. Turning opt-in off does not clear the map, and
//    turning it back on reads the same set of ticks the user left — the switch hides the boxes,
//    it does not forget them. (The first cut of this module had a default mode whose boxes could
//    DENY; the owner struck that the day after it shipped, so a stored `false` from that day is
//    inert now rather than a deny.)
//
// THE KEY IS THE SPELL LINE, NOT THE INSTANCE AND NOT THE RANK (the 2026-08-14 amendment): a haste
// is a haste across characters, and a rank upgrade must not silently reset a user's answer. The
// fold is `timerNameKey` (shared/buffTimers.ts) — the same rank-stripped, case-folded key that
// file already builds every timer row id from, and the same fold `spellLineKey` performs in
// shared/spellLines.ts. This module never computes one: it takes a key, so there is exactly one
// place in the tree that decides what a line IS and every caller reaches it.
//
// IT IS A DISPLAY FILTER OVER TWO WINDOWS AND STRUCTURALLY NOTHING ELSE (JOS-215's law, restated
// for a second preference). Nothing here reaches the model: an unchecked buff is still admitted,
// still folded, still learned from, still on the Buffs tab, and still counted by that tab's header
// chip. The only consumer is `filterAllowedRows`, which runs in the overlay renderer over the rows
// it is about to draw.
//
// Pure: no React, no DOM, no Electron, no clock. It is imported by main (the store accessor and
// the IPC handler), by the app renderer (the Buffs tab's controls) and by the overlay renderer
// (the filter), so all three read one normalizer — the `graphicsPrefs` / `buffTrust` rule.

/**
 * The whole preference: the mode, and the per-line answers.
 *
 * `lines` is a plain record rather than two arrays because the tri-state is one fact per key and a
 * pair of lists can hold a key twice. Absent is a real answer and is never spelled out.
 */
export interface BuffAllowPrefs {
  /**
   * OPT-IN MODE. `false` (the shipped answer) means an unset spell DRAWS; `true` means an unset
   * spell does not, and checking one is what turns it on.
   */
  optIn: boolean
  /** Per spell-line verdicts: `true` allowed, `false` denied, absent unset. */
  lines: Record<string, boolean>
}

/** Everything shows, nothing has been said. What a store with no `buffAllow` key reads as. */
export const DEFAULT_BUFF_ALLOW_PREFS: BuffAllowPrefs = { optIn: false, lines: {} }

/**
 * How many explicit verdicts are kept. A BOUND, not a policy: the mined spell list of a long-lived
 * character is a few hundred lines and a user cannot press more boxes than they have spells, so
 * this only stops a hand-edited or imported file from carrying an unbounded map into every window.
 */
export const MAX_BUFF_ALLOW_LINES = 2000

/** The longest key stored. A spell line key is a spell name; this only bounds abuse. */
export const MAX_BUFF_ALLOW_KEY_CHARS = 64

/** A patch: the mode, some verdicts, or both. Each control sets what it touches and no more. */
export interface BuffAllowPatch {
  optIn?: boolean
  /** Verdicts to MERGE in. A key set to `null` is a verdict being withdrawn (back to unset). */
  lines?: Record<string, boolean | null>
}

/** A storable key: non-empty, short, and already folded (no leading/trailing space, lowercase). */
function storableKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const k = raw.trim().toLowerCase()
  if (k.length === 0 || k.length > MAX_BUFF_ALLOW_KEY_CHARS) return null
  return k
}

/**
 * THE ONE NORMALIZER, run by the store reader, the IPC handler and both renderers alike (the
 * `buffTrust` rule). Anything it cannot read becomes the shipped default rather than an error: a
 * hand-edited settings file must not be able to stop a timer window drawing.
 *
 * `=== true` rather than a cast on both halves, so a hand-written `"true"` or `1` is not a verdict.
 */
export function normalizeBuffAllowPrefs(raw: unknown): BuffAllowPrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { optIn: false, lines: {} }
  const src = raw as { optIn?: unknown; lines?: unknown }
  const optIn = src.optIn === true
  const lines: Record<string, boolean> = {}
  const rawLines = src.lines
  if (typeof rawLines === 'object' && rawLines !== null && !Array.isArray(rawLines)) {
    for (const [rawKey, rawValue] of Object.entries(rawLines as Record<string, unknown>)) {
      if (typeof rawValue !== 'boolean') continue
      const key = storableKey(rawKey)
      if (key === null || key in lines) continue
      lines[key] = rawValue
      if (Object.keys(lines).length >= MAX_BUFF_ALLOW_LINES) break
    }
  }
  return { optIn, lines }
}

/**
 * `current` with a patch applied, rebuilt through the normalizer — the one place a patch becomes a
 * preference, so main's authority and a renderer's optimistic echo of it can never merge
 * differently (the `applyScopePatch` seam).
 *
 * A `null` verdict DELETES the key. That is how "let the mode decide again" is spelled, and it is
 * deliberately not what unchecking a box does: unchecking is a statement, and only a caller that
 * means to withdraw one sends null.
 */
/**
 * A patch's `lines` half, read into the two things it can say: verdicts to STATE, and verdicts to
 * WITHDRAW. Its own function because the whole point of a patch is that anything it cannot name is
 * dropped without touching the current answer, and that is a lot of refusals for one branch.
 */
function readLinePatch(raw: unknown): { withdrawn: Set<string>; stated: Record<string, boolean> } {
  const withdrawn = new Set<string>()
  const stated: Record<string, boolean> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { withdrawn, stated }
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = storableKey(rawKey)
    if (key === null) continue
    if (rawValue === null) withdrawn.add(key)
    else if (typeof rawValue === 'boolean') stated[key] = rawValue
  }
  return { withdrawn, stated }
}

export function applyBuffAllowPatch(current: BuffAllowPrefs, patch: unknown): BuffAllowPrefs {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return current
  const src = patch as BuffAllowPatch
  // The map is REBUILT rather than a copy mutated: a `delete` on a computed key is the one
  // operation that can leave a record in a shape neither side declared, and this reads as what it
  // is — the old answers minus the withdrawn ones, plus the new ones.
  const { withdrawn, stated } = readLinePatch(src.lines)
  const kept: Record<string, boolean> = {}
  for (const [key, verdict] of Object.entries(current.lines)) {
    if (!withdrawn.has(key)) kept[key] = verdict
  }
  return normalizeBuffAllowPrefs({
    optIn: typeof src.optIn === 'boolean' ? src.optIn : current.optIn,
    lines: { ...kept, ...stated }
  })
}

/** The two agree, field for field. A no-op write must broadcast nothing and re-render nothing. */
export function sameBuffAllowPrefs(a: BuffAllowPrefs, b: BuffAllowPrefs): boolean {
  if (a.optIn !== b.optIn) return false
  const ka = Object.keys(a.lines)
  const kb = Object.keys(b.lines)
  return ka.length === kb.length && ka.every((k) => k in b.lines && a.lines[k] === b.lines[k])
}

/**
 * MAY THIS SPELL LINE DRAW ON A TIMER WINDOW — the whole rule, and the mode is the whole of it.
 *
 *   mode off — everything draws; the map is not consulted (there are no boxes to have set it).
 *   opt-in   — only a line explicitly CHECKED (`lines[key] === true`) draws.
 *
 * Which is also exactly what the checkbox on the Buffs tab shows when it is on screen: checked
 * means "this one draws". One function, no second definition anywhere.
 */
export function buffAllowAllowed(prefs: BuffAllowPrefs, key: string): boolean {
  if (!prefs.optIn) return true
  // ABSENT IS TESTED AS ABSENT, with `in`: the record is typed `Record<string, boolean>`, so an
  // index read is `boolean` to the compiler and the third state is invisible to it.
  return key in prefs.lines && prefs.lines[key]
}

/**
 * The patch a checkbox sends. Always an EXPLICIT verdict — see fact 3 in the header: a box the user
 * pressed is a statement, and a statement survives a change of mode.
 */
export function buffAllowCheck(key: string, checked: boolean): BuffAllowPatch {
  return { lines: { [key]: checked } }
}

/** True when the mode is off — everything draws and the filter has nothing to do. */
export function buffAllowIsDefault(prefs: BuffAllowPrefs): boolean {
  return !prefs.optIn
}
