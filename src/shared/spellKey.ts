// ============================================================================
// spellKey.ts — THE FOUR PURE FUNCTIONS THAT OUTLIVE THE PARSER (JOS-499 item 2).
// ============================================================================
//
// Every one of these was written inside the TypeScript parse cascade and lived there because that
// is where it was first needed. None of them is ABOUT parsing. They are vocabulary — how a name
// folds into a join key, what rank a display name carries, how EQ spells an instant — and the
// deletion release is what makes the distinction load-bearing: `log/parseCommon.ts` and
// `log/parser.ts` are deleted with the fold, and thirteen surviving consumers still need this
// vocabulary. A key is a JOIN KEY, and both sides of every join here survive.
//
// WHO SURVIVES AND STILL NEEDS THEM (measured, not assumed — this is why the file exists):
//
//   spellCanonKey — data/clientSpellHp.ts, data/rainSpells.ts, data/spellClasses.ts,
//                   data/spellEffectClass.ts, itemClickies.ts, resist/castState.ts,
//                   resist/fold.ts, resist/songFold.ts, resist/songIdentity.ts,
//                   resist/spellsUsParse.ts, resist/world.ts
//   idKey         — ipc/roster.ts, resist/fold.ts, resist/world.ts
//   spellRank     — resist/fold.ts
//   parseEqTimestamp — feedback/slice.ts
//
// The resist tree is the reason this is not a one-line move: `src/main/resist/` is NOT doomed (only
// `resist/module.ts`, the fold plug, is), and six of its files key by canonical spell name. Deleting
// `parseCommon.ts` without this extraction would take the resist model down with the fold, which is
// the failure the read-only inventory found and the reason this lands as a PREP commit ahead of any
// deletion.
//
// NOTHING IS REWRITTEN HERE. Every body below is the original verbatim, comments included, moved
// rather than reimplemented — a "tidy" on the way past would be a silent semantic change to a join
// key, which is the one class of edit this file must never carry. The originals re-export from here
// until they are deleted, so the doomed files need no edit and the tree stays buildable throughout.

/**
 * Canonical identity key for an entity name. EQ writes the same mob with
 * different casing (charm lines lowercase the article, damage lines capitalize
 * it); keying state by this lowercased form makes lookups case-stable. 'You'
 * stays special.
 */
export function idKey(name: string): string {
  const n = name.trim().toLowerCase()
  if (n === 'you' || n === 'yourself' || n === 'your') return 'you'
  return n
}

/**
 * Canonical SPELL key (Task #33): lowercase, trimmed, with a trailing rank token
 * stripped. EQ Legends suffixes current-session casts with a Roman-numeral RANK —
 * "You begin casting Swift Like the Wind I." / "Shiftless Deeds IV" / "Allure VI" —
 * but EVERY fade/fizzle/interrupt line DROPS the rank ("Your Swift Like the Wind spell
 * has worn off …", "Your Shiftless Deeds spell fizzles!"). Keying the buffs model by
 * the raw name breaks cast↔fade pairing (2,507/12,442 casts carry a rank tail).
 *
 * The stripped token is a trailing I–X Roman numeral at the END of the name only,
 * word-bounded. VERIFIED SAFE against the real log (2026-08-01): NO fade/fizzle/
 * interrupt line ever ends in a Roman numeral, and every one of the 16 distinct
 * rank-tailed base spells (Swift Like the Wind, Shiftless Deeds, Allure, Clarity,
 * Superior Healing, Lay on Hands, …) is a real spell whose identity does not include a
 * Roman-numeral word — so stripping the tail can never merge two genuinely-different
 * spells. The DISPLAY name keeps its suffix (callers pass the raw spell for display);
 * only the KEY is canonicalized.
 */
const RANK_TAIL_RE = / (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/

/**
 * MEMOIZED, and the measurement is why (JOS-59). This is a PURE function of its argument — a
 * trim, a regex, a trim and a lowercase — and it was called from the parser on every cast-shaped
 * line AND from the buffs module's per-event hygiene sweep, once per live buff instance. On the
 * owner's log the sweep alone asked it tens of millions of times, and it was 1.8% of the whole
 * fold's self time.
 *
 * THE MEMO SURVIVES THE FOLD THAT JUSTIFIED IT, deliberately. Both of those callers are deleted in
 * this release and the surviving callers ask far less often — but the cache is a pure win with a
 * bounded footprint, and removing it would be an unmeasured performance change smuggled into a
 * deletion. `resist/spellsUsParse.ts` still keys the whole client spell table through here on
 * load, which is the largest single burst left and exactly the shape a memo is for.
 *
 * The domain is the set of SPELL AND SKILL NAMES a log prints, which is closed and small (the
 * shipped DB carries ~1.9k). The cap is a guard against a pathological input stream rather than
 * an expectation: past it the cache stops GROWING and every further call simply computes the
 * answer, so behaviour is identical either way and memory cannot run away.
 */
const CANON_CACHE = new Map<string, string>()
const CANON_CACHE_MAX = 20_000
export function spellCanonKey(spell: string): string {
  const hit = CANON_CACHE.get(spell)
  if (hit !== undefined) return hit
  const key = spell.trim().replace(RANK_TAIL_RE, '').trim().toLowerCase()
  if (CANON_CACHE.size < CANON_CACHE_MAX) CANON_CACHE.set(spell, key)
  return key
}

/**
 * THE RANK THE KEY THROWS AWAY (JOS-387): `Scorching Arrow IV` -> 4, `Frost Shard VI` -> 6, a name
 * with no numeral -> 0.
 *
 * It reads the SAME trailing token `spellCanonKey` strips, off the same raw display name, and it is
 * deliberately a second function rather than a change to that one: every consumer of the canonical
 * key — the buffs model's cast/fade pairing, the ledger's pooling, the proc analytics — depends on
 * a rank-IV and a rank-0 cast of a spell being ONE spell, and only the resist model needs to know
 * that they carry different resist adjusts (-15 a rank). So the rank is parsed BEFORE canonising,
 * beside the strip, and the key is untouched.
 *
 * The numerals are the same closed I-X ladder `RANK_TAIL_RE` accepts, which is what EQ Legends
 * prints; anything else answers 0 rather than guessing.
 */
const RANK_VALUES: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
}

export function spellRank(spell: string): number {
  const m = RANK_TAIL_RE.exec(spell.trim())
  if (!m) return 0
  return RANK_VALUES[m[0].trim()] ?? 0
}

/**
 * EQ'S OWN TIMESTAMP, TO A LOCAL EPOCH. `"Sat Aug 01 13:00:28 2026"` — the bracketed prefix every
 * log line carries — parsed by rearranging into a form `Date.parse` accepts unambiguously.
 *
 * LOCAL TIME IS THE POINT AND IS NOT A BUG. The game writes the player's wall clock with no zone,
 * so the only reading that puts an event where the player experienced it is the host's own zone.
 * `renderer/src/lib/formatDate.ts` documents the same seam from the display end. Do not "fix" this
 * to UTC (memory: analytics days stay UTC is about DAY BUCKETING, a separate decision).
 *
 * A SHAPE IT DOES NOT RECOGNISE FALLS BACK TO `Date.parse` AND THEN TO 0, never to `NaN` — a NaN
 * instant propagates into arithmetic silently and turns every comparison false, which is how a
 * malformed line would have become an invisible hole rather than a visible zero.
 */
export function parseEqTimestamp(stamp: string): number {
  // "Sat Aug 01 13:00:28 2026" -> "Aug 01 2026 13:00:28"
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/.exec(stamp.trim())
  if (!m) {
    const t = Date.parse(stamp)
    return Number.isNaN(t) ? 0 : t
  }
  const [, mon, day, time, year] = m
  const t = Date.parse(`${mon} ${day} ${year} ${time}`)
  return Number.isNaN(t) ? 0 : t
}
