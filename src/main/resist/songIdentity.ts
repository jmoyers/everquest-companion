// WHICH SPELLS ARE SONGS, AND WHICH SONG A LANDING SENTENCE BELONGS TO (JOS-382, round 2).
//
// Pure over an injected spell catalog. `tests/resistSongs.test.mts` drives it directly.
//
// ── WHY THIS FILE EXISTS: THE BUG IT IS THE FIX FOR ─────────────────────────────────────────────
//
// The first cut decided "is this a song" from the log's own `You begin singing` line. That is a
// perfectly good signal and it is almost never printed: EQ Legends bards run their songs under the
// SYMPHONIC AURA, which re-pulses every six seconds with NO cast line at all. The owner's
// 2,013,829-line log contains FIVE `You begin singing` lines and 4,152 pulses of one song's
// landing emote. So nothing was ever flagged as a song, no cast was ever armed for the emote to
// join to, and every one of the 400 Largo's resists in the shipped baseline was filed as an
// ordinary cast with ZERO landings beside it. A spell that is 100% resisted by construction drags
// magic toward "nearly immune" on every mob a bard ever sang at.
//
// THE FIX IS TO DECIDE IT FROM SPELL IDENTITY. A spell only the Bard can learn is a song, always,
// whether or not the log announced it — and `spells.json` states the class outright
// (`"* Bard - Level 20"`). The parser's `sung` flag stays as a corroborating signal for the rare
// song a bard actually starts by hand.
//
// ── AND WHERE THE WIKI IS WRONG, THIS FILE NO LONGER SAYS SO (JOS-384) ──────────────────────────
//
// Round 2 shipped a `SONG_FAMILY_OVERRIDES` table here, one row wide: it pooled Largo's Assonant
// Binding (bard 51) into Largo's Melodic Binding (bard 20), because the catalog files the sentence
// EQ Legends prints for the level-20 song under the level-51 one. The measurement was right and
// the PLACE was wrong. Owner ruling 2026-08-16: a correction to wiki data is APP-WIDE or it is
// nothing — a module-local one leaves the buff overlay, the alerts and the timers reading a catalog
// the resist page has already decided is wrong, which is two different answers to one question.
//
// So the row moved, with its evidence, to `src/main/data/spellCorrectionsList.ts` (search Largo),
// where it is applied at load in `spellDb.ts` and every consumer sees it. This file consumes the
// corrected catalog like any other, and carries no sentence and no spell name of its own —
// `tests/largoBinding.test.mts` is the guard that keeps it that way for every feature module.
//
// WHAT THAT COSTS HERE, stated because it is a real behaviour change and not a refactor: the
// corrected sentence now has TWO owners, so the emote arrives with two candidates and
// `resolveSongEmote` has to separate them from the log instead of from a table. It does that the
// way it already did for `<mob> winces.` — against the songs a resist line has NAMED — which is
// evidence rather than a claim, and which is silent until the log has named one.

import { parseSpellClassLevels } from '../../shared/spellLines'
import type { SpellDb } from '../data/spellDb'
import { spellCanonKey } from '../../shared/spellKey'

/**
 * MEMOISED, per catalog, and the reason is a measurement. Both answers below are constant for the
 * life of a catalog, and the fold asks them on EVERY resist, EVERY spell-damage line and EVERY
 * landing sentence in a two-million-line replay — and `parseSpellClassLevels` is a regex pass over
 * a free-text class column ("* Bard - Level 20"). Answering it fresh each time cost 1.6 seconds of
 * fold on the owner's log (`npm run bench:replay`: 2,671 ms with the naive call, 1,088 ms with
 * this cache, on identical input and byte-identical output). A WeakMap so a catalog that goes away
 * takes its cache with it.
 */
interface SongFacts {
  song: boolean
  landing: boolean
  /** The level the catalog says a bard learns this song at, or null when it names none. */
  learnedAt: number | null
}

const songCache = new WeakMap<SpellDb, Map<string, SongFacts>>()

function facts(db: SpellDb | undefined, spellKey: string): SongFacts {
  if (!db) return { song: false, landing: false, learnedAt: null }
  let byKey = songCache.get(db)
  if (!byKey) {
    byKey = new Map()
    songCache.set(db, byKey)
  }
  const hit = byKey.get(spellKey)
  if (hit) return hit
  const entry = db.byKey.get(spellKey)
  const levels = parseSpellClassLevels(entry?.classes)
  const msg = entry?.msgCastOnOther
  const computed = {
    song: levels.length > 0 && levels.every((l) => l.cls === 'BRD'),
    landing: typeof msg === 'string' && msg.length > 0,
    // `parseSpellClassLevels` already keeps the LOWEST level per class and sorts ascending, so the
    // first row is the level a bard gets the line at.
    learnedAt: levels.length > 0 ? levels[0].level : null,
  }
  byKey.set(spellKey, computed)
  return computed
}

/**
 * Is this a song? True when the Bard is the ONLY class the catalog says can learn it. "Only" is
 * load-bearing: a handful of lines are shared with other classes and those roll once per cast like
 * anything else.
 */
export function isSongSpell(db: SpellDb | undefined, spellKey: string): boolean {
  return facts(db, spellKey).song
}

/**
 * Does the catalog know a landing sentence for this song? When it does, every pulse that LANDS
 * prints one and the denominator is exact — lands plus resists, no reconstruction at all. When it
 * does not, songs.ts has to rebuild the pulses.
 */
export function songLandingObservable(db: SpellDb | undefined, spellKey: string): boolean {
  return facts(db, spellKey).landing
}

/**
 * A song you have not learned yet is not the song you are singing (JOS-384).
 *
 * The narrowing this replaces was a hard-coded pair of spell names inside this module. This one is
 * a FACT the catalog already states — `"* Bard - Level 51"` — read against the level the log states
 * for the character, and it is the same argument the correction's evidence line makes: the owner's
 * `bound by strands` pulses are at level 20-25 and Largo's Assonant Binding is a level-51 song, so
 * it cannot be the song those pulses came from.
 *
 * Two guards keep it from ever deciding more than it knows. An UNKNOWN level (no `/who` read yet)
 * narrows nothing, and a narrowing that would empty the list is discarded whole — a character
 * singing a song the catalog says is above them means the level is wrong or the catalog is, and
 * neither is grounds for throwing the observation away.
 */
function learnable(
  db: SpellDb | undefined,
  keys: readonly string[],
  casterLevel: number | null
): readonly string[] {
  if (casterLevel === null) return keys
  const kept = keys.filter((k) => {
    const at = facts(db, k).learnedAt
    return at === null || at <= casterLevel
  })
  return kept.length > 0 ? kept : keys
}

/**
 * WHICH song a landing sentence belongs to. EQ prints ONE sentence per spell FAMILY (world-model
 * law 3), so the parser hands over a candidate LIST and the model resolves it — here against what
 * the CHARACTER could have learned, then against what the log has NAMED, which for a song is its
 * resist lines.
 *
 * `named` is every song key a resist line has spelled out, best first (this mob, then anywhere in
 * the session). A single candidate needs no resolving; several with nothing to separate them are
 * REFUSED rather than guessed at, because pooling two songs would smear their resist adjusts
 * together and a -100 proc adjust is exactly the thing this model exists to take out.
 *
 * THE ORDER OF THE TWO NARROWINGS IS NOT ARBITRARY. `named` is the stronger evidence and would be
 * first if it were always THERE — but it is a running tally, so it says nothing about the pulses
 * before the log first spelled the song out, and on the owner's log that is 35 landings (measured:
 * the first `bound by strands` emote is line 27,355 and the first `resisted your Largo's Melodic
 * Binding!` is line 30,098). The level is known from the first `/who` and does not move, so it is
 * what covers the opening of a session; `named` then decides everything the level cannot.
 */
export function resolveSongEmote(
  db: SpellDb | undefined,
  candidates: readonly string[],
  named: readonly string[],
  casterLevel: number | null = null
): string | null {
  const songs: string[] = []
  for (const name of candidates) {
    const key = spellCanonKey(name)
    if (isSongSpell(db, key)) songs.push(key)
  }
  if (songs.length === 0) return null
  const unique = learnable(db, [...new Set(songs)], casterLevel)
  if (unique.length === 1) return unique[0]
  for (const key of named) {
    if (unique.includes(key)) return key
  }
  return null
}
