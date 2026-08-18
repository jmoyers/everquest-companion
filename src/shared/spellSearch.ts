// spellSearch — ONE search box that finds everything, as a pure tokenizer + matcher.
//
// docs/plans/suggest-dialog-redesign.md §1. The owner's ask was "search should be
// comprehensive (level, type, name, spell text)", and the design rule that answers it without
// inventing knowledge the app does not have:
//
//   BARE TEXT MATCHES THE SPELL'S OWN WORDS. `SpellCatalogEntry.searchText` is name + rank
//   names + the three message texts, prejoined and lowercased in main. So "slower" finds every
//   spell whose landing emote says it and "dispelled" finds the dispel family — from the game's
//   own strings, never from a hand-built effect taxonomy that would rot (world-model law 1).
//
// AND THE APOSTROPHE IS NOT PART OF THE WORD (JOS-342). Both sides are folded through
// `foldApostrophes` below — the surface once in main, the query once per keystroke — so a
// possessive the user types finds a name the wiki spells without one, and the other way round.
//
// FOUR TOKEN FORMS, whitespace-split, AND-composed (every token must match):
//   `slow`        text     — substring of searchText
//   `25`          number   — a class entry level OR a substring of searchText (rank numerals)
//   `level:25`    level    — a class entry level; `level:20-30` is the inclusive range
//   `class:shm`   class    — the line's classLevels contain that class (abbr or full name)
//   `type:buff`   facet    — buff | debuff | illusion | poison | seen, and NOTHING else
//
// …AND SINCE JOS-392 THE SAME THINGS CAN BE SAID WITHOUT THE PREFIXES, IN ANY ORDER. The owner's
// ask was `27-28 cleric shaman`, typed however it comes out of your head — so a bare word that IS
// a class name (`cleric`, `clr`, and the two-word `shadow knight`, which arrives as two tokens and
// is JOINED when the pair names a class and neither half does) is a class token, and a bare `27-28`
// (`27–28`, `27..28`) is a level range. Composition: AND across the KINDS, OR within one — several
// classes mean ANY of them, several ranges mean ANY of them — and a level is SCOPED to the classes
// when the query names any, because `cleric 27-28` asks what a CLERIC gets at 27..28 and not what
// anybody gets there while a cleric gets it eventually.
//
// A BARE CLASS WORD KEEPS ITS TEXT HALF, exactly as a bare number does, and that is not a
// hedge — it is what keeps the box able to find a spell by its own name. `Drums of War` and
// `Bristlebane's Bardic Bombardment` carry class words inside their names, and the DB's message
// texts carry more; a rule that read `war` as ONLY a class facet would make those rows unreachable
// by the name printed on them. So a bare class word matches "the row is a spell of that class" OR
// "the row's own words contain that word", and the explicit `class:war` spelling is there for a
// user who means only the first. An explicit `class:jedi` still matches NOTHING (a typo narrows to
// zero, never widens) — that rule is about the PREFIX, which is a declaration.
//
// THE FACETS ARE EXACTLY WHAT THE DATA CAN ANSWER. Beneficial/Detrimental and the illusion
// flag are DB fields; `poison` reads the shared/poisons.ts roster + its Strike emotes (imported,
// never copied); `seen` is the buffs model's own usage count. There is deliberately no
// `type:slow` / `type:heal` — those go through the message text, which is ground truth. A token
// that names an unknown class or facet matches NOTHING: a typo must narrow to zero rather than
// silently widen to everything.
//
// Lives in shared/ (pure, no imports beyond types + poisons/spellLines) so the dialog and the
// node test suite compile against ONE implementation.

import type { ClassAbbr } from './classCombo'
import type { SpellCatalogEntry } from './buffTypes'
import { classAbbrFor } from './spellLines'
import { POISONS, POISON_PROCS } from './poisons'

/**
 * THE APOSTROPHE CLASS — every character this data and its users write where a possessive belongs.
 *
 * Measured over the committed `src/main/data/spells.json` (1,928 rows): the DB itself only ever
 * writes two of them, the ASCII `'` (149 names, 344 message fields) and the BACKTICK the wiki uses
 * as a typographic stand-in (22 names — `Atol\`s Spectral Shackles`, `Bristlebane\`s Bundle`,
 * `Tigir\`s Insects`; 8 message fields). The other three are what a KEYBOARD produces and the DB
 * never contains: `’` is what macOS, iOS and Word substitute while you type, and `‘` /
 * `ʼ` arrive by paste. Folding all five on both sides is what makes the two vocabularies meet.
 *
 * The acute accent `´` is deliberately NOT here: it is a letter's diacritic, and nothing in
 * this data uses it as punctuation.
 */
const APOSTROPHES = /['‘’ʼ`]/g

/**
 * Remove every apostrophe — THE FOLD (JOS-342), applied to the search surface and to the query.
 *
 * THE REPORT (owner, 2026-08-13). `Snails Healing`, the shaman heal-over-time at 14, could not be
 * found in suggested alerts. Nothing was missing: the row is in the DB, it is catalog-eligible, and
 * the game log spells it exactly as the DB does — with no apostrophe. The owner typed the
 * possessive he SAYS, `snail's`, the matcher is a substring test, and `snails healing` does not
 * contain `snail's`. The spell was on the screen behind an unreachable query the whole time.
 *
 * IT RUNS BOTH WAYS, and the census says the other direction is the larger population: 167 of the
 * 1,928 committed names carry an apostrophe (136 of them a `'s` possessive) and 349 message fields
 * do — every one of them a string a user may reasonably type WITHOUT the punctuation. After the
 * fold neither spelling can miss the other, in either direction.
 *
 * DELETED, NEVER REPLACED BY A SPACE. `aanya's` and `aanyas` have to land on the same characters;
 * a space would make one of them two words and the substring test would fail again, quietly.
 *
 * Folding LOSES the ability to search for a literal apostrophe. That is the intended trade: no
 * player is looking for punctuation, and four DB names already prove the wiki cannot keep its own
 * spelling straight (`O\`Keil's Flickering Flame` and `O\`Keils Flickering Flame` are two rows).
 */
export function foldApostrophes(text: string): string {
  return text.replace(APOSTROPHES, '')
}

/** The five facets `type:` can name — the ones the catalog can answer honestly. */
export type SpellFacet = 'buff' | 'debuff' | 'illusion' | 'poison' | 'seen'

const FACETS: ReadonlySet<string> = new Set<SpellFacet>([
  'buff',
  'debuff',
  'illusion',
  'poison',
  'seen'
])

/**
 * One parsed token. `raw` is kept for the UI (chips/echo) and for debugging a truth table.
 *
 * A class token carries `text` when the user typed the class as a BARE word — that is the OR half
 * described in the header, and its absence is what makes `class:war` the narrow spelling.
 */
export type SpellSearchToken =
  | { kind: 'text'; raw: string; text: string }
  | { kind: 'number'; raw: string; text: string; n: number }
  | { kind: 'level'; raw: string; lo: number; hi: number }
  | { kind: 'class'; raw: string; cls: ClassAbbr | null; text?: string }
  | { kind: 'facet'; raw: string; facet: SpellFacet | null }

/**
 * The subset of a catalog row the matcher reads (so tests can state one inline).
 *
 * STRUCTURAL RATHER THAN A `Pick` SINCE JOS-392: the level-unlock dataset is searched by the same
 * matcher and holds no usage counts (the buffs model is the only thing that counts casts, and it is
 * not part of a compile-time unlock fold), so the two fields only the alerts catalog can answer are
 * optional here. `SpellCatalogEntry` still satisfies it — the widening is one-way.
 */
export interface SearchableSpell {
  name: string
  searchText: string
  spellType?: string
  illusion?: boolean
  usageCount?: number
  classLevels?: SpellCatalogEntry['classLevels']
}

/** One (class, level) statement — the pairs the class/level facets are matched against. */
export interface SearchClassLevel {
  cls: ClassAbbr
  level: number
}

/**
 * `20-30` → the inclusive span, in any of the three spellings a player reaches for.
 *
 * The EN DASH is here because it is what a phone, Word and macOS substitute for a hyphen typed
 * between two numbers; `..` because it is how a range is written in half the tools a player has
 * open beside the game. A BACKWARDS range is the same span — the user meant the stretch.
 */
function parseRange(value: string): { lo: number; hi: number } | null {
  const m = /^(\d{1,3})\s*(?:-|–|—|\.\.)\s*(\d{1,3})$/.exec(value)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  return { lo: Math.min(a, b), hi: Math.max(a, b) }
}

/** `level:20-30` / `level:25`. Returns null for anything else (the caller falls back to text). */
function parseLevelToken(raw: string, value: string): SpellSearchToken | null {
  const range = parseRange(value)
  if (range) return { kind: 'level', raw, lo: range.lo, hi: range.hi }
  const one = /^(\d{1,3})$/.exec(value)
  if (!one) return null
  const n = Number(one[1])
  return { kind: 'level', raw, lo: n, hi: n }
}

/**
 * SPELLINGS OF A CLASS THE WIKI'S OWN TABLE DOES NOT CARRY, and the whole list of them.
 *
 * `classAbbrFor` (spellLines.ts) reads the table the DB's `classes` field is parsed with: the
 * three-letter /who codes and the wiki's display names, including both of its spellings of Shadow
 * Knight. That table mirrors a SCRAPE and must keep doing so, so a spelling a user types and the
 * wiki never prints belongs here instead of widening it.
 *
 * `beast lord` is the one entry: the wiki writes `Beastlord`, the class is said as two words, and
 * the two-word join below hands this function exactly that string. `sk` is deliberately NOT here —
 * this box filters as you type, and two letters that are also the start of `skin`, `skeleton` and
 * two hundred spell names would flip a half-typed word into a whole-class filter under the reader.
 */
const TYPED_CLASS_WORDS: Record<string, ClassAbbr> = { 'beast lord': 'BST' }

/** A user-typed word (or joined pair) → the class it names, or null. */
function classWordFor(text: string): ClassAbbr | null {
  return classAbbrFor(text) ?? TYPED_CLASS_WORDS[text.trim().toLowerCase()] ?? null
}

/**
 * A `<prefix>:<value>` token, or null when the prefix is not one of ours / the value is
 * unusable — the caller then treats the whole word as text.
 *
 * An EMPTY value ("level:", "class:") is a HALF-TYPED token, not a filter: falling back to text
 * lets the row set stay put while the user finishes the word instead of blanking mid-keystroke.
 */
function parsePrefixedToken(prefix: string, value: string, raw: string): SpellSearchToken | null {
  if (value === '') return null
  if (prefix === 'level' || prefix === 'lvl') return parseLevelToken(raw, value)
  if (prefix === 'class') return { kind: 'class', raw, cls: classAbbrFor(value) }
  if (prefix === 'type') {
    return { kind: 'facet', raw, facet: FACETS.has(value) ? (value as SpellFacet) : null }
  }
  return null
}

/**
 * A single whitespace-delimited word → its token. Prefixes win; everything else is text.
 *
 * THE FOLD IS APPLIED ONCE, HERE (JOS-342), to the matching text and never to `raw` — the UI echoes
 * `raw` back as the user typed it, and a chip that silently re-spelled somebody's query would be
 * lying about what it searched for. It is applied BEFORE the `:` split, which is safe because no
 * prefix, class name or facet contains an apostrophe and none can grow one: they are all closed
 * vocabularies stated in this file and in `classCombo`.
 */
function parseToken(word: string): SpellSearchToken {
  const lower = foldApostrophes(word.toLowerCase())
  const colon = lower.indexOf(':')
  const prefixed =
    colon > 0 ? parsePrefixedToken(lower.slice(0, colon), lower.slice(colon + 1), word) : null
  if (prefixed) return prefixed
  const range = parseRange(lower)
  if (range) return { kind: 'level', raw: word, lo: range.lo, hi: range.hi }
  const bare = /^(\d{1,3})$/.exec(lower)
  if (bare) return { kind: 'number', raw: word, text: lower, n: Number(bare[1]) }
  const cls = classWordFor(lower)
  if (cls) return { kind: 'class', raw: word, cls, text: lower }
  return { kind: 'text', raw: word, text: lower }
}

/**
 * Two adjacent words that name a class together and neither of which names one alone, as one class
 * token — or null, which is every other pair in every other query.
 */
function joinedClassToken(first: string, second: string | undefined): SpellSearchToken | null {
  if (second === undefined) return null
  const a = foldApostrophes(first.toLowerCase())
  const b = foldApostrophes(second.toLowerCase())
  const cls = classWordFor(`${a} ${b}`)
  if (!cls || classWordFor(a) !== null || classWordFor(b) !== null) return null
  return { kind: 'class', raw: `${first} ${second}`, cls, text: `${a} ${b}` }
}

/**
 * Split a query into tokens. Whitespace-delimited; an empty query yields no tokens.
 *
 * THE ONE PLACE A TOKEN IS WIDER THAN A WORD (JOS-392): `shadow knight` and `beast lord` are class
 * names a user types as two words, and the split has already separated them. A pair is joined only
 * when the PAIR names a class and NEITHER HALF DOES — so `clr shm` stays two class tokens and
 * `shadow step` stays two text tokens, and no query can lose a word to a greedy join.
 */
export function tokenizeSpellQuery(query: string): SpellSearchToken[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
  const out: SpellSearchToken[] = []
  for (let i = 0; i < words.length; i++) {
    const joined = joinedClassToken(words[i], words[i + 1])
    out.push(joined ?? parseToken(words[i]))
    if (joined) i += 1
  }
  return out
}

/** Roster names + Strike names, lowercased — the `type:poison` membership test's first half. */
const POISON_NAMES: ReadonlySet<string> = new Set(
  POISONS.flatMap((p) => [p.name.toLowerCase(), ...p.strikes.map((s) => s.toLowerCase())])
)

/**
 * The Strike landing emotes, lowercased — the second half (a Strike the roster doesn't name).
 *
 * FOLDED LIKE THE SURFACE THEY ARE TESTED AGAINST (JOS-342), and this one is not cosmetic: four of
 * the ten Strike emotes carry an apostrophe (`'s limbs move slower!`, `'s fingers slow down.`,
 * `'s blessings wither!`, `'s feet won't budge!`) and `searchText` no longer does. Left unfolded,
 * every rogue Strike would silently drop out of `type:poison` and out of the Poisons section.
 */
const POISON_EMOTES: readonly string[] = POISON_PROCS.map((p) => foldApostrophes(p.suffix.toLowerCase()))

/**
 * Is this row a rogue poison? The roster IS the answer (shared/poisons.ts — imported, never
 * copied): a coatable poison, one of its Strikes, or a row whose own emote is a Strike emote.
 *
 * The NAME half compares two RAW strings and is deliberately left unfolded: both sides are spelled
 * by us (the roster) and by the DB, no roster name contains an apostrophe, and an exact-name test
 * between two unfolded strings cannot drift. Only the half that reads the folded `searchText` folds.
 */
export function isPoisonSpell(entry: SearchableSpell): boolean {
  if (POISON_NAMES.has(entry.name.trim().toLowerCase())) return true
  return POISON_EMOTES.some((e) => entry.searchText.includes(e))
}

/** Does the row satisfy one facet? */
function matchesFacet(entry: SearchableSpell, facet: SpellFacet | null): boolean {
  switch (facet) {
    case 'buff':
      return entry.spellType === 'Beneficial'
    case 'debuff':
      return entry.spellType === 'Detrimental'
    case 'illusion':
      return entry.illusion === true
    case 'poison':
      return isPoisonSpell(entry)
    // A row from a dataset that counts nothing (the level-unlock fold) has never been "seen" by
    // this facet's own definition — the usage count is the buffs model's, and it is not in there.
    case 'seen':
      return (entry.usageCount ?? 0) > 0
    default:
      // An unknown facet names nothing the catalog holds — narrow to zero, never widen.
      return false
  }
}

/**
 * A token list folded into the four questions a row is actually asked (JOS-392).
 *
 * The tokens are AND-composed ACROSS kinds and OR-composed WITHIN one, and the level questions are
 * SCOPED to the classes — none of which a per-token `every()` can express, because "does this token
 * match" is the wrong question once two tokens talk about the same (class, level) pair. Compiled
 * once per query rather than once per row: the panel filters 1,450 rows on a keystroke.
 */
export interface CompiledSpellQuery {
  /** substrings of `searchText`, every one required */
  texts: string[]
  /** `type:` facets, every one required */
  facets: (SpellFacet | null)[]
  /** the classes named, in any spelling — ANY of them satisfies the class question */
  classes: ClassAbbr[]
  /** the words the BARE class tokens were typed as — the OR half (see the header) */
  classTexts: string[]
  /** a `class:` prefix named nothing we know: the whole query matches nothing */
  unknownClass: boolean
  /** `level:` spans and bare `N-M` ranges — ANY of them satisfies the level question */
  ranges: { lo: number; hi: number }[]
  /** bare numbers: each is level-OR-text, and each is required */
  numbers: { n: number; text: string }[]
}

/** Fold a token list into the compiled form. */
export function compileSpellQuery(tokens: readonly SpellSearchToken[]): CompiledSpellQuery {
  const q: CompiledSpellQuery = {
    texts: [],
    facets: [],
    classes: [],
    classTexts: [],
    unknownClass: false,
    ranges: [],
    numbers: []
  }
  for (const t of tokens) {
    if (t.kind === 'text') q.texts.push(t.text)
    else if (t.kind === 'facet') q.facets.push(t.facet)
    else if (t.kind === 'number') q.numbers.push({ n: t.n, text: t.text })
    else if (t.kind === 'level') q.ranges.push({ lo: t.lo, hi: t.hi })
    else if (t.cls === null) q.unknownClass = true
    else {
      if (!q.classes.includes(t.cls)) q.classes.push(t.cls)
      if (t.text !== undefined) q.classTexts.push(t.text)
    }
  }
  return q
}

/**
 * The (class, level) pairs THIS query is about — the class scope first, then the level questions.
 *
 * It is the matcher's own working set and the results view's sort key ("the lowest MATCHING
 * level"), so both read one implementation: a row listed for `27-28 cleric shaman` is sorted by the
 * cleric/shaman level in the band, never by a wizard's level at 12.
 */
export function matchedClassLevels(
  levels: readonly SearchClassLevel[] | undefined,
  q: CompiledSpellQuery
): SearchClassLevel[] {
  const scoped = (levels ?? []).filter((c) => q.classes.length === 0 || q.classes.includes(c.cls))
  if (q.ranges.length === 0 && q.numbers.length === 0) return scoped
  return scoped.filter(
    (c) =>
      q.ranges.some((r) => c.level >= r.lo && c.level <= r.hi) ||
      q.numbers.some((n) => c.level === n.n)
  )
}

/** Does the row satisfy a compiled query? AND across kinds, OR within one. */
export function matchesCompiledQuery(entry: SearchableSpell, q: CompiledSpellQuery): boolean {
  if (q.unknownClass) return false
  if (!q.texts.every((t) => entry.searchText.includes(t))) return false
  if (!q.facets.every((f) => matchesFacet(entry, f))) return false
  const scoped = (entry.classLevels ?? []).filter(
    (c) => q.classes.length === 0 || q.classes.includes(c.cls)
  )
  // The class question, with the text half a BARE class word keeps (see the header).
  if (q.classes.length > 0 && scoped.length === 0) {
    if (!q.classTexts.some((t) => entry.searchText.includes(t))) return false
  }
  if (q.ranges.length > 0 && !q.ranges.some((r) => scoped.some((c) => c.level >= r.lo && c.level <= r.hi))) {
    return false
  }
  // A bare number is genuinely two questions ("level 25" and "Rune 2"), and the user has not
  // said which — so it is OR, and the explicit `level:` spelling is there when they mean one.
  return q.numbers.every((n) => scoped.some((c) => c.level === n.n) || entry.searchText.includes(n.text))
}

/** AND across every token — an empty token list matches everything. */
export function matchesSpellQuery(
  entry: SearchableSpell,
  tokens: readonly SpellSearchToken[]
): boolean {
  return matchesCompiledQuery(entry, compileSpellQuery(tokens))
}

/** Tokenize + filter in one call (the renderer memoizes the token list separately). */
export function filterSpells<T extends SearchableSpell>(
  entries: readonly T[],
  tokens: readonly SpellSearchToken[]
): T[] {
  if (tokens.length === 0) return [...entries]
  const q = compileSpellQuery(tokens)
  return entries.filter((e) => matchesCompiledQuery(e, q))
}

// ---- sections ------------------------------------------------------------------------
//
// The spell list is sectioned by what the DATA STATES, in the order the redesign lists them
// (§2.3). Poison wins over the buff/debuff split because a coat's spellType ('Beneficial' — it
// lands on your own blades) is technically true and completely unhelpful; illusion wins over
// buff for the same reason. Everything left is the DB's own Beneficial/Detrimental.

/** Which spell section a row belongs to. A row appears in exactly one. */
export type SpellSection = 'buffs' | 'debuffs' | 'illusions' | 'poisons'

/** Section ids in display order. */
export const SPELL_SECTIONS: readonly SpellSection[] = ['buffs', 'debuffs', 'illusions', 'poisons']

/** Human label per section (one spelling, shared by header and count). */
export const SPELL_SECTION_LABEL: Record<SpellSection, string> = {
  buffs: 'Buffs',
  debuffs: 'Debuffs',
  illusions: 'Illusions',
  poisons: 'Poisons'
}

/**
 * The section for one row. Detrimental → Debuffs; a poison or an illusion is named as such;
 * everything else is a buff — which the catalog guarantees is honest, since a row earns its
 * place only by a Beneficial template or the illusion flag (spellDb.ts buildSpellCatalog).
 */
export function sectionFor(entry: SearchableSpell): SpellSection {
  if (isPoisonSpell(entry)) return 'poisons'
  if (entry.illusion) return 'illusions'
  if (entry.spellType === 'Detrimental') return 'debuffs'
  return 'buffs'
}

/**
 * Partition rows into the four sections, PRESERVING the caller's order inside each (the
 * catalog is already sorted recency-then-alphabetical, and a section must not re-sort it).
 * Every input row lands in exactly one bucket, so the four counts sum to the input length.
 */
export function groupSpellSections<T extends SearchableSpell>(
  entries: readonly T[]
): Record<SpellSection, T[]> {
  const out: Record<SpellSection, T[]> = { buffs: [], debuffs: [], illusions: [], poisons: [] }
  for (const e of entries) out[sectionFor(e)].push(e)
  return out
}
