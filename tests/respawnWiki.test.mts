// THE WIKI RESPAWN FLOOR (JOS-194) - the free-text grammar, and an audit of the committed file.
//
// `src/shared/respawnWiki.ts` carries the measurement this file pins: of 7,872 pages in the mob
// catalog, 522 state a `|respawn_time` at all and a hundred-odd spellings are used to do it. The
// grammar is therefore a WHITELIST - every shape in ACCEPTS was observed on a real page, every
// shape in REFUSES was too, and anything the grammar does not fully consume keeps its verbatim
// text instead of acquiring a made-up number.
//
// The fold that USES this floor is tests/respawnTimers.test.mts.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseWikiRespawn, type WikiRespawnData } from '../src/shared/respawnWiki'

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE WIKI GRAMMAR — every accepted shape below was OBSERVED in the sweep
// ─────────────────────────────────────────────────────────────────────────────

/** [field text, seconds] — each one a real `|respawn_time` value from a real page. */
const ACCEPTS: readonly (readonly [string, number])[] = [
  // The colon form, which is MINUTES:SECONDS — see respawnWiki.ts's readClock for the three-page
  // proof out of Lower Guk's ghoul camp.
  ['6:40', 400],
  ['4:27', 267],
  ['22:00', 1320],
  ['28:00', 1680],
  ['16:00 minutes', 960],
  ['6:40 min', 400],
  // Spelled units, every casing and abbreviation the pages use.
  ['22 Minutes', 1320],
  ['18 mins', 1080],
  ['9.5 min', 570],
  ['400 sec', 400],
  ['1 hour', 3600],
  ['8 Hours', 28800],
  ['24 hours', 86400],
  // Multi-term, descending, with and without whitespace or a conjunction.
  ['3 Hours 57 Minutes', 14220],
  ['6 min 40 sec', 400],
  ['10m 30s', 630],
  ['6m40s', 400],
  ['16min 30sec', 990],
  ['28 min 00 sec', 1680],
  ['21 minutes and 30 seconds', 1290],
  ['6 minutes, 40 seconds', 400],
  ['10M;40S', 640],
  // Prefixes.
  ['~17 min', 1020],
  ['Approximately 6 minutes', 360],
  ['Every 72 hours +- 8 hours', 259200],
  // Trailing decoration: placeholders, notes, variance clauses in every sign spelling seen.
  ['16.0 min (PH)', 960],
  ['28 min (or PH)', 1680],
  ['16min 30sec (see notes)', 990],
  ['7 days +/- 8 hours', 604800],
  ['7 days -/+ 8 hours', 604800],
  ['7 Days (+/- 8 Hours Variance)', 604800],
  ['3 days (+/- 8-hours variance)', 259200],
  ['7 days +/- 8(?) hours', 604800],
  ['24 Hours +/- (2 Hour Variance)', 86400],
  ['3 Days (2.5-3?)', 259200],
  // Wiki decoration that is not part of the value at all.
  ['[[15 minutes]]', 900],
  ['15 minutes}}', 900]
]

/** Values the field really carries that state NO duration. Each must refuse, not guess. */
const REFUSES: readonly string[] = [
  // The two biggest families: 49 pages say the spawn is triggered, 40 say they do not know.
  'Triggered',
  '[[Triggered]]',
  'Triggered by killing [[Chief Ry`Gorr]]',
  'Triggered, 14:45',
  '?',
  '??',
  'Unknown',
  '6 min?',
  '1 week?',
  // A RANGE is the page declining to state a number; picking an end would invent one.
  '6-8 hours',
  '17-18m',
  '84 - 86 hours',
  '2-7 days (random)',
  '6 to 8 minutes',
  // A number with no unit is not a duration, however confident the variance clause sounds.
  '12 (+/- 2 Hours Variance)',
  // Two answers, or an answer per zone.
  'Kaesora: 18:00, Temple of Droga: 20:30, Mines of Nurga: 20:30',
  '24 hours (+/- 8 hours) & 72 hours (+/- 8 hours)',
  '22:00 and 6? hours',
  '7 Days / 3 Days (No Variance)',
  'Skyshrine: 3hours',
  '4 min (South Karana) - 6 min 30 sec (West Karana)',
  // Prose, times of day, and things that are not durations at all.
  'Night',
  '12am',
  'Ultra Rare',
  'See Below',
  'See description',
  'Not sure but if the Ishva Lteth gnoll is the place holder the spawn is fast.',
  '27+ min',
  '2:45h',
  '',
  '   '
]

test('the wiki grammar reads every duration shape the pages actually print', () => {
  for (const [text, secs] of ACCEPTS) {
    assert.equal(parseWikiRespawn(text), secs, `"${text}" should read as ${String(secs)}s`)
  }
})

test('the wiki grammar refuses everything that is not a duration', () => {
  for (const text of REFUSES) {
    assert.equal(parseWikiRespawn(text), null, `"${text}" must refuse rather than guess`)
  }
})

test('the grammar refuses durations outside the sane band', () => {
  // A respawn of zero, and one of a year. Neither is a shape the sweep produced; both would put a
  // nonsense number on a countdown if the bounds were not enforced.
  assert.equal(parseWikiRespawn('0 min'), null)
  assert.equal(parseWikiRespawn('400 days'), null)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE COMMITTED FLOOR — an audit, and a rot tripwire on the four target dungeons
// ─────────────────────────────────────────────────────────────────────────────

const FLOOR = JSON.parse(
  readFileSync(join(import.meta.dirname, '../src/main/data/respawns.json'), 'utf8')
) as WikiRespawnData

test('the committed wiki floor is well formed', () => {
  const keys = new Set<string>()
  for (const row of FLOOR.rows) {
    assert.equal(row.key, row.key.toLowerCase(), `${row.key} must be canonical`)
    assert.ok(row.text.trim().length > 0, `${row.key} must keep its verbatim text`)
    assert.ok(!keys.has(row.key), `${row.key} appears twice`)
    keys.add(row.key)
    if (row.seconds !== undefined) {
      assert.ok(row.seconds >= 1 && row.seconds <= 30 * 24 * 3600, `${row.key} = ${String(row.seconds)}s`)
    }
  }
  const sorted = [...FLOOR.rows].sort((a, b) => a.key.localeCompare(b.key))
  assert.deepEqual(
    FLOOR.rows.map((r) => r.key),
    sorted.map((r) => r.key),
    'rows are sorted by key so a re-scrape diffs cleanly'
  )
})

test('every committed `seconds` is what the grammar reads from its own `text`', () => {
  // This is the whole reason the verbatim text is committed beside the number: the file can be
  // re-derived with no network (`npm run scrape:respawns -- --reparse`), and this pins that the
  // committed pair has not drifted from the grammar that produced it.
  for (const row of FLOOR.rows) {
    assert.equal(row.seconds ?? null, parseWikiRespawn(row.text), `${row.key}: "${row.text}"`)
  }
})

test('the floor is THIN, and the numbers that say so are the reason this feature exists', () => {
  // Floors, not equalities (frozen numbers rot): a re-scrape may add pages. What must not happen
  // silently is the file emptying out or the parse rate collapsing.
  assert.ok(FLOOR.rows.length >= 500, `only ${String(FLOOR.rows.length)} pages state a respawn`)
  const parsed = FLOOR.rows.filter((r) => r.seconds !== undefined).length
  assert.ok(parsed >= 380, `only ${String(parsed)} parse`)
  // …and the honest half: a large minority of what the wiki DOES state is not a duration at all.
  assert.ok(FLOOR.rows.length - parsed >= 50, 'the non-duration rows are a real and kept category')
})

test('the four dungeons the report named still resolve to the values the wiki states', () => {
  // The corroborating report (01KZQ4X16MPDKQ2CF4SY35P5ED) named Befallen, Najena and Upper/Lower
  // Guk. These are hand-checked against the live pages; if a re-scrape moves one, this fails and
  // somebody reads the page rather than shipping a silently different number.
  const expect: readonly (readonly [string, number])[] = [
    ['gynok moltor', 960], // Befallen's named — "16.0 min (PH)"
    ['korven nisere', 270], // Befallen — "4:30"
    ['unbound flame', 266], // Najena — "4:26"
    ['the froglok warden', 990], // Upper Guk — "16min 30sec"
    ['the ghoul lord', 540], // Lower Guk — "9 min"
    ['the froglok king', 1680] // Lower Guk — "28 min (or PH)"
  ]
  const byKey = new Map(FLOOR.rows.map((r) => [r.key, r]))
  for (const [key, secs] of expect) {
    assert.equal(byKey.get(key)?.seconds, secs, `${key} should floor at ${String(secs)}s`)
  }
})

