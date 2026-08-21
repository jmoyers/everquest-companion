// WHAT IS IN YOUR GEMS, AND WHICH NAMED SET HOLDS IT (JOS-391) — the wire shape.
//
// Shared so the renderer can read it without reaching into src/main, and so `npm test` can pin
// the fold with no Electron. `src/main/modules/spellSets.ts` is the fold; this file is the shape
// and the two rules a reader must not get wrong.
//
// ── RULE 1: PRESENCE ONLY. THIS MODEL NEVER CLAIMS A GEM IS EMPTY ──────────────────────────────
//
// A log starts mid-life. The character already has eight gems loaded and the client prints
// nothing about them, so at the first line of any log the memorized set is not "empty" — it is
// UNKNOWN, and it stays unknown for every gem the log has not touched since. `memorized` is
// therefore a list of spells we have WATCHED go in and not watched come out, and a UI reads it
// one way only: a name in the list is memorized, a name absent from it is nothing at all. There
// is deliberately no `notMemorized` and no count; "you have 3 of 8 gems" would be a claim about
// five gems nobody observed.
//
// The same rule governs the SET contents: `Spell set primary saved.` is recorded as the memorized
// state at that instant, which is the state the LOG knows. A set saved ten minutes into a log may
// legitimately list three spells when the bar held eight. So a set says which spells it is known
// to contain, never which it lacks.
//
// ── RULE 2: A SET IS ITS LATEST DEFINITION, AND OLDER ONES ARE GONE ────────────────────────────
//
// The owner's ask, verbatim: a user swaps one gem and saves over. The set the app refers to is
// the one that exists NOW. So there is no history here — one definition per name, replaced
// wholesale by the next `saved` or `loaded`, and dropped entirely by `deleted`. A surface built
// on this can only ever name a current set.

/** Bumped when the shape changes, so a renderer holding an old baseline re-hydrates. */
export const SPELL_SETS_SHAPE_VERSION = 1

/** One named set, as it stands right now. */
export interface SpellSetDef {
  /** The spells the set is KNOWN to hold (rule 1), in the order they were observed. */
  spells: string[]
  /** The log timestamp of the line that defined it. */
  observedAt: number
  /** Which line defined it: an explicit save, or the state a load settled into. */
  source: 'saved' | 'loaded'
}

/** The whole state, small enough to cross the wire whole (see the delta note below). */
export interface SpellSetsSnap {
  v: number
  /** Spells observed memorized and not since forgotten. Presence only — see rule 1. */
  memorized: string[]
  /** Every CURRENT named set, keyed by its name verbatim (`sham rang buff 2`). */
  sets: Record<string, SpellSetDef>
}

/**
 * THE DELTA IS THE WHOLE STATE, and that is a measurement rather than laziness.
 *
 * A character has at most a dozen gems and the owner's four-week log names 21 distinct spell sets
 * across its whole life, of which a handful are live at once. The entire snapshot is a few hundred
 * bytes; a per-key diff would be more code than the payload it saves, and every one of the module's
 * mutations touches the whole memorized list anyway (a set load rewrites the bar). So the delta
 * carries the state and the renderer replaces rather than merges.
 */
export type SpellSetsDelta = SpellSetsSnap

export const EMPTY_SPELL_SETS: SpellSetsSnap = { v: SPELL_SETS_SHAPE_VERSION, memorized: [], sets: {} }

/** Case- and whitespace-stable key for "the same spell", matching spellLineLookup.ts's fold. */
export function memoKey(spell: string): string {
  return spell.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** True when the log has watched this spell go into a gem and not come out. */
export function isMemorized(snap: SpellSetsSnap, spell: string): boolean {
  const key = memoKey(spell)
  return snap.memorized.some((s) => memoKey(s) === key)
}

/**
 * The CURRENT sets whose latest definition holds this spell, in name order.
 *
 * Empty is the answer for "no set is known to hold it", which covers both "it is in no set" and
 * "the sets were saved before the log could see this gem" — rule 1 again, and the reason the UI
 * prints this only when it is non-empty.
 */
export function setsHolding(snap: SpellSetsSnap, spell: string): string[] {
  const key = memoKey(spell)
  return Object.entries(snap.sets)
    .filter(([, def]) => def.spells.some((s) => memoKey(s) === key))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The one sentence a row prints about a spell it is about to replace, or null.
 *
 * `Minor Healing is memorized now` / `Minor Healing is memorized now, in set primary`. Nothing at
 * all when the log has never seen the spell memorized — never "not memorized", never "in no set".
 * No em dashes; the comma is the join, per the copy rule.
 */
export function memorizedPhrase(snap: SpellSetsSnap, spell: string): string | null {
  const rest = memorizedClause(snap, spell)
  return rest === null ? null : `${spell}${rest}`
}

/**
 * The same sentence with the spell's OWN NAME lifted off the front — ` is memorized now, in set
 * primary` — or null when there is nothing to say.
 *
 * IT EXISTS SO THE NAME CAN BE A HOVER TARGET (JOS-392, owner addition): the unlock row hangs the
 * spell card off the spell this sentence is about, and a surface that had to slice the joined
 * phrase by `spell.length` would be depending on how this function happens to build its string.
 * `memorizedPhrase` is now composed FROM this, so the two can never drift.
 */
export function memorizedClause(snap: SpellSetsSnap, spell: string): string | null {
  if (!isMemorized(snap, spell)) return null
  const sets = setsHolding(snap, spell)
  return sets.length === 0 ? ' is memorized now' : ` is memorized now, in set ${sets.join(', ')}`
}
