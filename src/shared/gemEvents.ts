// gemEvents.ts — WHAT IS IN YOUR GEMS (JOS-391): the three log-event shapes that state which
// spells are loaded and which named set the player just saved or loaded.
//
// Split out of logEvents.ts for the same reason `acquireEvents.ts` and `considerFaction.ts` were:
// that file is past its factoring ceiling. Every name here is RE-EXPORTED from `@shared/logEvents`
// and carried in its union, so no consumer moved and no import path changed.
//
// ── WHY THESE EXIST (characterize-first, the JOS-144 posture) ──────────────────────────────────
//
// A full-log sweep of the owner's live log (eqlog_Primitive_freeport.txt, 2,048,450 lines,
// read-only 2026-08-16) asked what the parser made of every line about the spell bar. Four
// shapes, 13,312 lines, and EVERY ONE of them parsed to `{kind:'unknown'}`:
//
//     4,321  Beginning to memorize <spell>...             the gem is loading
//     4,285  You have finished memorizing <spell>.        the gem IS loaded
//     4,232  You forget <spell>.                          the gem is empty
//       474  Spell set <name> saved. / loaded. / deleted. 21 distinct set names
//
// So the classifier that claims them (`classifySpellGems`) can neither shadow nor be shadowed,
// and the histogram of the pre-existing kinds is unchanged across the addition.
//
// The consumer is `src/main/modules/spellSets.ts`, which turns them into "is the spell this new
// one replaces in your bar right now, and which of your saved sets would put it back".

import type { LogEventBase } from './logEvents'

/**
 * A GEM CHANGED — `Beginning to memorize <spell>...` and, one to three seconds later,
 * `You have finished memorizing <spell>.`
 *
 * BOTH PHASES, ONE KIND, and `done` is what a consumer reads. The finished line is the one that
 * changes the world; the begin line is the one that says the player is STILL WORKING, which is
 * what the spell-set module needs to know a load has not settled yet. A memorize that is
 * interrupted prints a begin and no finish, so the two cannot be collapsed.
 *
 * Note the punctuation the shapes hang on: the begin line ends in `...` and the finished line in
 * a single `.`, and the spell name is what sits between the prefix and that punctuation.
 */
export interface SpellMemorizeEvent extends LogEventBase {
  kind: 'spellMemorize'
  spell: string
  /** True for `You have finished memorizing X.` — the line that loaded the gem. */
  done: boolean
}

/**
 * A GEM EMPTIED — `You forget <spell>.` Printed both when the player drops a gem by hand and, in
 * a burst, when a spell set is loaded over the current bar.
 */
export interface SpellForgetEvent extends LogEventBase {
  kind: 'spellForget'
  spell: string
}

/**
 * A NAMED SPELL SET WAS SAVED, LOADED OR DELETED — `Spell set <name> saved.`
 *
 * The name is free text with spaces and digits in it (`sham rang buff 2`, `pal primary`), so it is
 * taken whole between the prefix and the verb rather than tokenized. The measured split over the
 * owner's log is 297 loaded / 172 saved / 5 deleted — `deleted` is real and is why this is an
 * action rather than a boolean.
 */
export interface SpellSetEvent extends LogEventBase {
  kind: 'spellSet'
  /** The set's name, verbatim. */
  set: string
  action: 'saved' | 'loaded' | 'deleted'
}
