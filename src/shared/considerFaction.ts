// ============================================================================
// considerFaction.ts — the /consider ladder: rungs, labels, palette, difficulty shorthand.
// ============================================================================
//
// LIFTED VERBATIM out of shared/logEvents.ts (JOS-128), which had reached its 400-line
// factoring ceiling and needed room for one more event shape. Nothing here changed: the same
// rungs in the same order, the same labels, the same palette, the same difficulty table and the
// same fold, byte for byte. logEvents.ts RE-EXPORTS every symbol, so not one import site moved
// and `@shared/logEvents` still answers for all of them — this is a new home, not a new API.
//
// It earns its own file on the merits too. Three of these four exports are PRESENTATION (a chip
// label, an app-chosen palette, a short row label) and the fourth is the parser's phrase table.
// None of them is an event SHAPE, which is what logEvents.ts is for.

/**
 * The faction (con-message) ladder, friendliest → most hostile. These are the rungs EQ prints
 * between the mob name and the ` -- `; the key is a 1:1 rename of the phrase, not an inference.
 *
 * FULL-LOG SWEEP (2026-08-03, 357 consider lines — every line accounted for, no residue):
 *   regards you indifferently        128
 *   scowls at you, ready to attack   102
 *   judges you amiably                60
 *   glowers at you dubiously          34
 *   glares at you threateningly       17
 *   looks your way apprehensively     14
 *   looks upon you warmly              2
 * The two remaining rungs of the classic ladder — `regards you as an ally` and `kindly considers
 * you` — do NOT occur in this log (this character has no maxed faction). They are matched anyway,
 * for the same reason the stance regex is name-permissive: covering a rung we haven't stood on
 * costs nothing and refusing it would silently drop the whole line. Nothing infers a rung that
 * wasn't printed.
 */
export type ConsiderFaction =
  | 'ally'
  | 'warmly'
  | 'kindly'
  | 'amiably'
  | 'indifferent'
  | 'apprehensive'
  | 'dubious'
  | 'threatening'
  | 'scowls'

/** phrase → rung, friendliest first. The parser builds its alternation from this list. */
export const CONSIDER_FACTION_RUNGS: readonly { phrase: string; faction: ConsiderFaction }[] = [
  { phrase: 'regards you as an ally', faction: 'ally' },
  { phrase: 'looks upon you warmly', faction: 'warmly' },
  { phrase: 'kindly considers you', faction: 'kindly' },
  { phrase: 'judges you amiably', faction: 'amiably' },
  { phrase: 'regards you indifferently', faction: 'indifferent' },
  { phrase: 'looks your way apprehensively', faction: 'apprehensive' },
  { phrase: 'glowers at you dubiously', faction: 'dubious' },
  { phrase: 'glares at you threateningly', faction: 'threatening' },
  { phrase: 'scowls at you, ready to attack', faction: 'scowls' }
]

/** Short, glanceable rung label for a chip/badge. */
export const CONSIDER_FACTION_LABEL: Record<ConsiderFaction, string> = {
  ally: 'ally',
  warmly: 'warmly',
  kindly: 'kindly',
  amiably: 'amiable',
  indifferent: 'indifferent',
  apprehensive: 'apprehensive',
  dubious: 'dubious',
  threatening: 'threatening',
  scowls: 'KOS'
}

/**
 * The APP's faction palette (friendly cool → hostile warm). This is our presentation choice,
 * not a color the game states — EQ's own con COLOR encodes relative LEVEL, not faction, and the
 * log never carries a color at all. Kept beside the ladder so the overlay and the main window
 * can't drift apart.
 */
export const CONSIDER_FACTION_COLOR: Record<ConsiderFaction, string> = {
  ally: '#5fe08a',
  warmly: '#7fd8a0',
  kindly: '#6fa8f0',
  amiably: '#7fc4e8',
  indifferent: '#c8ccd8',
  apprehensive: '#c9c65a',
  dubious: '#d6a94a',
  threatening: '#e08b45',
  scowls: '#e05c5c'
}

/**
 * The difficulty clause → a short label for a dense row. Keys are the VERBATIM phrases observed
 * in the full-log sweep, with the gendered pronoun folded to a regex-free `he|she|it` lookup
 * below; a phrase we've never seen returns undefined and the caller shows the verbatim clause
 * (never a guessed tier — and deliberately NO numeric ordering, which the log does not state).
 */
const CONSIDER_DIFFICULTY_SHORT: Record<string, string> = {
  'what would you like your tombstone to say?': 'suicide',
  'looks like it would wipe the floor with you!': 'wipes the floor',
  'it appears to be quite formidable.': 'formidable',
  'looks like quite a gamble.': 'a gamble',
  'looks kind of dangerous.': 'dangerous',
  "you would probably win this fight... it's not certain though.": 'probably win',
  'looks quite risky, but might be worth a try.': 'worth a try',
  'looks kind of risky, but you might win.': 'might win',
  'looks kind of risky... you might win.': 'might win',
  'you could probably win this fight.': 'likely win',
  'looks like a reasonably safe opponent.': 'safe'
}

/**
 * Short label for a difficulty clause, or undefined when we've never seen the phrase.
 * Folds the gendered variants EQ emits for two of the clauses ("looks like HE/SHE/IT would wipe
 * the floor with you!", "HE/SHE/IT appears to be quite formidable.") onto the neuter key.
 */
export function considerDifficultyShort(difficulty: string): string | undefined {
  const key = difficulty
    .trim()
    .toLowerCase()
    .replace(/\b(?:he|she)\b/g, 'it')
    .replace(/\s+/g, ' ')
  return CONSIDER_DIFFICULTY_SHORT[key]
}
