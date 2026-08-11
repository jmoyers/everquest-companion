// THE WIKI RESPAWN FLOOR — reading `|respawn_time` off a mob page, and the honest account of
// how little that field is worth (JOS-194).
//
// The ticket exists because the owner rejected a wiki-sourced respawn timer outright: "the wiki
// is a bad primary source — build CUSTOM TIMERS TRIGGERED ON DEATH MESSAGES, with the wiki
// respawn value as a floor/default only." This file is the FLOOR half, and the measurement below
// is why it is only a floor.
//
// MEASURED 2026-08-10 over all 7,872 pages in the committed mob catalog
// (`src/renderer/src/data/eqlegends/mobs.json`), one `action=query&prop=revisions` sweep of
// eqlwiki.com:
//
//     7,872  catalog pages
//       522  state a `|respawn_time` field at all          (6.6%)
//       411  state something this file can read as a duration
//       111  state something that is NOT a duration        — 49 "Triggered", 40 "?"/"??",
//            4 "Unknown", and one-offs: "Night", "12am", "See Below", "See description",
//            "Ultra Rare", "1 week?", "6-8 hours", "17-18m", "84 - 86 hours",
//            "2-7 days (random)", "Not sure but if the Ishva Lteth gnoll is the place holder…"
//
// And in the four dungeons the corroborating report named (01KZQ4X16MPDKQ2CF4SY35P5ED, an
// EQBuddy switcher who misses named respawn timers), the coverage is thinner still:
//
//     Befallen    15 of 36 catalog mobs state one
//     Najena       2 of 34
//     Upper Guk    4 of 51
//     Lower Guk    7 of 63
//                 ── 28 of 184 (15%)
//
// So for 85% of what you kill in the target dungeons the wiki says NOTHING, and the field is
// free text in over a hundred spellings ("6:40", "9.5 min", "16min 30sec (see notes)",
// "3 Hours 57 Minutes", "Every 72 hours +- 8 hours", "7 days -/+ 8 hours"). A feature resting on
// this would be empty most of the time and wrong some of the time. Your own kills are the
// primary source; this is the default before you have any, and the floor underneath them.
//
// THE GRAMMAR IS A WHITELIST, NOT A BEST EFFORT. Every shape below was observed in the sweep;
// anything the grammar does not fully consume is REFUSED and the row keeps its verbatim text so
// the UI can show what the wiki actually said. That is deliberate: a half-read "6-8 hours" or
// "22:00 and 6? hours" would put a fabricated number on a countdown, and world-model law 1 says
// an estimate must come from something explicit or be labelled as absent. There is no fuzzy
// fallback here and there should never be one.

/** Upper sanity bound. The longest duration the sweep produced is 10 days (`864000s`). */
const MAX_RESPAWN_SEC = 30 * 24 * 3600

/** Lower sanity bound — a respawn of under a second is a typo, not a spawn cycle. */
const MIN_RESPAWN_SEC = 1

/**
 * Unit tokens, LONGEST FIRST so `minutes` is never read as `m` with `inutes` left over. The
 * multiplier table and this alternation are written once, together, for that reason.
 */
const UNITS: readonly (readonly [RegExp, number])[] = [
  [/^(?:days?|d)/i, 86400],
  [/^(?:hours?|hrs?|h)/i, 3600],
  [/^(?:minutes?|mins?|m)/i, 60],
  [/^(?:seconds?|secs?|s)/i, 1]
]

/**
 * Words that may PRECEDE the number without changing it. "Every 72 hours", "~17 min",
 * "approximately 6 min" — all observed. Anything else in front is a refusal.
 */
const PREFIX_RE = /^(?:every|approximately|approx\.?|about|around|roughly|~)\s*/i

/**
 * A RANGE is a refusal: "6-8 hours", "17-18m", "84 - 86 hours", "2-7 days (random)". The wiki is
 * stating that it does not know the number, and picking an end of the range would be inventing
 * one.
 *
 * CHECKED AFTER THE DECORATION IS STRIPPED, NOT BEFORE — strip first, then judge the value. A
 * range that lives inside a variance parenthetical is decoration about a number the page DID
 * state ("3 Days (2.5-3?)" states three days), while a range in the value itself is the page
 * declining to state one. Testing the raw string conflates them and refuses the first.
 *
 * It requires a DIGIT on both sides of the dash, which is what keeps it away from the variance
 * clauses that also carry a dash — "7 days -/+ 8 hours" and "3 days (+/- 8-hours variance)" have
 * a letter or a slash where this needs a digit.
 */
const RANGE_RE = /\d\s*-\s*\d/

/** A trailing parenthetical: "(PH)", "(or PH)", "(see notes)", "(+/- 8 Hours Variance)". */
const TRAILING_PAREN_RE = /\s*\([^()]*\)\s*$/

/**
 * An unparenthesized variance tail: "+/- 8 hours", "+- 8 hours", "-/+ 8 hours", "+/- 8(?) hours".
 * The sign cluster is what anchors it, so a bare " 8 hours" second term is never eaten.
 */
const VARIANCE_RE = /\s*[+-]\s*\/?\s*[+-]?\s*\d.*$/

/**
 * The sign cluster with nothing after it, which is what the paren strip leaves behind on
 * "24 Hours +/- (2 Hour Variance)". Same refusal-of-decoration argument as VARIANCE_RE, applied
 * to the residue rather than the clause.
 */
const DANGLING_SIGN_RE = /\s*[+-]\s*\/?\s*[+-]?\s*$/

/**
 * An unclosed template tail. `|respawn_time = 15 minutes}}` is one page's broken wikitext — the
 * braces belong to the template call, never to the value, exactly as `[[…]]` does.
 */
const TEMPLATE_TAIL_RE = /\}+\s*$/

/**
 * Read a `|respawn_time` field into seconds, or null when it does not state a duration.
 *
 * Null is a real answer and the caller must keep it: `WikiRespawn.seconds` is absent for all 111
 * pages whose field says "Triggered" / "?" / "Unknown", and those rows still carry their `text`
 * so the app can say what the wiki said instead of pretending it said a number.
 */
export function parseWikiRespawn(field: string): number | null {
  let s = field.replace(/\[\[|\]\]/g, '').replace(TEMPLATE_TAIL_RE, '').trim()
  if (s.length === 0) return null
  s = s.replace(TRAILING_PAREN_RE, '').trim()
  s = s.replace(VARIANCE_RE, '').replace(DANGLING_SIGN_RE, '').trim()
  s = s.replace(PREFIX_RE, '').trim()
  if (s.length === 0) return null
  if (RANGE_RE.test(s)) return null
  const secs = readClock(s) ?? readUnitSequence(s)
  if (secs === null) return null
  if (secs < MIN_RESPAWN_SEC || secs > MAX_RESPAWN_SEC) return null
  return secs
}

/**
 * `M:SS` — 21 pages say "6:40", 9 say "4:27", and the form also appears with a unit suffix
 * ("6:40 min", "16:00 minutes").
 *
 * IT IS MINUTES:SECONDS, AND THE CATALOG PROVES IT RATHER THAN CONVENTION ASSUMING IT. Lower
 * Guk's ghoul camp states the same cycle three ways on three pages: `a ghoul ritualist` says
 * "28 min 00 sec", `a minotaur patriarch` says "28:00", `a froglok guk shaman` says "28 min".
 * Reading the colon form as hours:minutes would make one member of a single camp 28 hours while
 * its neighbours are 28 minutes. Every colon value in the sweep falls between 4:26 and 28:00,
 * which is a dungeon respawn spread in minutes and nothing at all in hours.
 */
function readClock(s: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)(?:\s*(?:minutes?|mins?|m))?$/i.exec(s)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * `N UNIT` one or more times, units STRICTLY DESCENDING: "22 Minutes", "9.5 min", "400 sec",
 * "3 Hours 57 Minutes", "6m 40s", "6m40s", "16min 30sec".
 *
 * The whole string must be consumed. That is the entire refusal mechanism — "12am" runs out of
 * units at `am`, "27+ min" runs out at `+`, "22:00 and 6? hours" runs out at `and`, and
 * "Kaesora: 18:00, Temple of Droga: 20:30" runs out at the first letter. Descending order refuses
 * a repeated or reordered unit, which is a shape no page produced and would mean something this
 * function cannot know.
 *
 * The one thing allowed BETWEEN terms is a conjunction the pages actually use — "21 minutes and
 * 30 seconds", "6 minutes, 40 seconds", "10M;40S". It is permitted only between two terms, never
 * before the first or after the last, so "22:00 and 6? hours" is still refused: the separator
 * buys the second term nothing when the second term is not a term.
 */
const SEPARATOR_RE = /^(?:\s*(?:and|,|;)\s*)/i

function readUnitSequence(s: string): number | null {
  let rest = s
  let total = 0
  let lastUnit = Number.POSITIVE_INFINITY
  let terms = 0
  while (rest.length > 0) {
    if (terms > 0) rest = rest.replace(SEPARATOR_RE, '')
    const num = /^(\d+(?:\.\d+)?)\s*/.exec(rest)
    if (!num) return null
    rest = rest.slice(num[0].length)
    const unit = UNITS.find(([re]) => re.test(rest))
    if (!unit) return null
    const [re, mult] = unit
    if (mult >= lastUnit) return null
    lastUnit = mult
    rest = rest.replace(re, '').replace(/^\s*/, '')
    total += Number(num[1]) * mult
    terms++
  }
  return terms > 0 ? total : null
}

/**
 * One catalog page's respawn statement. Committed as `src/main/data/respawns.json` by
 * `scripts/scrape-respawns.ts`; joined to a death line by `key`.
 */
export interface WikiRespawn {
  /** The in-game name the catalog states, lowercased — the join key a death line canonicalizes to. */
  key: string
  /** The wiki page title, for provenance and for the external link. */
  page: string
  /** The field's VERBATIM text. Shown to the user; never paraphrased, never regenerated. */
  text: string
  /** Seconds, present only when `text` parsed. Absent = the wiki said something that is not a duration. */
  seconds?: number
}

/** The committed file's shape (`src/main/data/respawns.json`). */
export interface WikiRespawnData {
  source: string
  scrapedAt: string
  rows: WikiRespawn[]
}
