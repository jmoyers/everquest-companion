// HOW LONG THE WIKI SAYS A SPELL LASTS — the one reader of `SpellEntry.durationText` (JOS-189).
//
// It lived in `scripts/scrape-spells.ts` and was only ever run at SCRAPE time, which is why a form
// it could not read became a permanent null in the committed catalog. It is here now because two
// callers need the same answer and a second copy would drift:
//
//   * `scripts/scrape-spells.ts` fills `durationMs` when it writes the file, and
//   * `src/main/data/spellDb.ts` fills the ones a PREVIOUS scrape left null when it loads it.
//
// The second caller is the whole point and it is idempotent in both directions, the same property
// `spellCorrections.ts` is built around: a re-scrape through the fixed reader supplies the number
// itself and the load-time fill becomes a no-op, while today's committed file — scraped before the
// reader could read these forms — is understood without being hand-edited. `durationText` is the
// wiki's own text either way; nothing here invents a duration the wiki did not state.
//
// WHY IT MATTERS AT ALL. `BuffInstances.applyMessageBuff` returns early for a landing with no
// duration and no illusion flag, so a spell whose duration string this file cannot read is a spell
// the buffs window can never draw — however correct its three messages are. A shaman reported
// exactly that for Spirit of the Puma, whose wiki duration is the three characters `60s`; 89 rows
// of the committed scrape were in that state.

/**
 * ms for one "<num> <unit>" component. Unit forms: sec/second(s), min/minute(s), hr/hour(s),
 * tick(s), and the bare single letters the wiki also writes (`2h 24m`, `1m 36s`, `60s`).
 * Returns null for an unknown unit.
 */
function unitMs(n: number, unitRaw: string): number | null {
  const u = unitRaw.toLowerCase()
  if (/^h$|^h(ou)?rs?$|^hr$/.test(u)) return Math.round(n * 3_600_000)
  if (/^m(in(ute)?s?)?$/.test(u)) return Math.round(n * 60_000)
  if (/^s(ec(ond)?s?)?$/.test(u)) return Math.round(n * 1000)
  if (/^ticks?$/.test(u)) return Math.round(n * 6000) // EQ tick = 6s
  return null
}

/**
 * The wiki's CLOCK form, which carries no unit words at all: `H:MM:SS` or `M:SS`.
 *
 * WHY IT IS READ BY COUNTING COLONS, and why that is a reading rather than a guess. Three fields
 * are hours:minutes:seconds and two are minutes:seconds — the ordinary clock convention, and the
 * DB is its own witness for it: `Form of the Bear` states `2h 24m` while its two siblings
 * `Form of the Great Bear` and `Form of the Howler` state `2 hours 24 minutes`, and the 56 focus
 * rows state `2:24:00` for the same span. Read as H:MM:SS all three agree on 8,640,000 ms; read
 * any other way they contradict one another. `Laceration` (`0:00:24`) and `Promised Renewal`
 * (`0:00:12`) write the leading zero-hours field out in full, which is what fixes the three-field
 * reading, and the two-field one falls out of it.
 *
 * THE FIRST GROUP WINS. `2:24:00 (3:36:00)` states a base and a parenthesized extended figure; the
 * base is what the model wants, because `SpellStats.estimateFor` treats the DB number as a FLOOR an
 * observed cycle may raise and never as a ceiling — so taking the larger one would put a number in
 * front of the player that no cast of theirs can reach.
 */
function parseClockMs(t: string): number | null {
  const m = /(\d+):(\d{2})(?::(\d{2}))?/.exec(t)
  if (!m) return null
  const [h, min, s] =
    m[3] !== undefined ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, Number(m[1]), Number(m[2])]
  const ms = ((h * 60 + min) * 60 + s) * 1000
  return ms > 0 ? ms : null
}

/**
 * Parse an EQ Legends duration string to ms, or null when unparseable/instant. The wiki
 * uses several forms (validated against real pages):
 *   "27 minutes"                          → 1_620_000
 *   "16 Min" / "11 Min"                   → abbreviated unit
 *   "2 Min 30 Sec"                        → COMPOUND (summed)
 *   "1.5 hours"                           → 5_400_000
 *   "2h 24m" / "1m 36s" / "60s"           → the SINGLE-LETTER units (JOS-189)
 *   "6:00:00" / "0:00:24" / "0:30"        → the CLOCK form, see `parseClockMs` (JOS-189)
 *   "4.4 minutes @L44 to 6.0 minutes @L60"→ a LEVEL FORMULA: take the MAX component
 *      (per the user directive — DB duration is the prior, "more or less the max seen").
 *   "instant" / "permanent" / "unlimited" / "" / a pure per-tick effect → null (retain the text).
 * A per-tick regen line ("4 per tick") is NOT a duration and yields null.
 */
export function parseDurationMs(text: string | undefined): number | null {
  if (!text) return null
  const t = text.toLowerCase().trim()
  if (!t || /instant|permanent|unlimited|until\b|special|varies|n\/a|per tick|per level/.test(t)) {
    return null
  }

  // Collect every "<num> <unit>" component. A plain compound ("2 Min 30 Sec") sums; a
  // level formula ("4.4 minutes … to 6.0 minutes …") takes the max — we distinguish by
  // the presence of a range separator ("to"/"@L"/"@ L"). The single letters come LAST in the
  // alternation so "2 min 30 sec" still matches "min"/"sec" rather than "m"/"s".
  const comps: number[] = []
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec|ticks?|h|m|s)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) !== null) {
    const ms = unitMs(parseFloat(m[1]), m[2])
    if (ms != null) comps.push(ms)
  }
  // No unit words anywhere: the wiki wrote a clock instead. Tried SECOND so an explicit unit is
  // never overruled by a colon somewhere else in the string.
  if (comps.length === 0) return parseClockMs(t)
  const isFormula = /\bto\b|@\s*l\d|@l\d/.test(t)
  if (isFormula) return Math.max(...comps)
  // Compound sum (e.g. "2 Min 30 Sec") — but a single component is just itself.
  return comps.reduce((a, b) => a + b, 0)
}
