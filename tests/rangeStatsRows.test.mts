// Pure unit tests for the range-stats panel's shaping layer
// (src/renderer/src/features/leveling/rangeStatsRows.ts) and the two small-rate formatters it
// depends on (src/renderer/src/lib/formatRate.ts).
//
// No log, no fixture, no DOM — so this file never skips. `rangeStats` itself is pinned
// elsewhere (tests/rangeStats.test.mts synthetic, tests/progressionWindows.test.mts golden);
// what is pinned HERE is everything that turns those numbers into words, because every
// honesty rule the feature has is ultimately a formatting decision:
//
//   1. a null rate prints an em-dash, NEVER '0.0' — "the log declined to report" and "you
//      made no progress" are different facts and must not render identically;
//   2. `formatLevelRate` / `formatKillRate` must NOT route through `formatNum`, which rounds
//      anything under 1000 to an integer (formatNum(1.42) === '1') and would silently flatten
//      every levels/hr in the app to '1';
//   3. the per-zone table sorts by farming efficiency with unknown rates LAST, and its time
//      toggle is a real reorder;
//   4. a range whose experience lines stated no percentage says so, and never claims 0.00.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` / `@renderer` aliases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AA_RATE_TITLE,
  AA_RESPEC_CAPTION,
  ACTIVE_TIME_TITLE,
  MEMBERSHIP_TITLE,
  NONE,
  OFFLINE_CAPTION,
  OFFLINE_TITLE,
  aaText,
  activeIdleText,
  comboInferred,
  comboText,
  idleGapsText,
  idleRuleCaption,
  membershipText,
  offlineGapsText,
  offlineText,
  rangeHeroes,
  unstatedCaption,
  withActiveTime,
  witnessedText,
  zoneStatRows
} from '../src/renderer/src/features/leveling/rangeStatsRows'
import { fmtDuration } from '../src/renderer/src/features/leveling/levelChartGeometry'
import { zoneColor } from '../src/renderer/src/features/leveling/zoneBands'
import { formatKillRate, formatLevelRate, formatNum } from '../src/renderer/src/lib/formatRate'
import { IDLE_GAP_MS, type RangeStats, type ZoneRangeRow } from '../src/shared/progressionStats'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse('Sat Aug 01 12:00:00 2026')

/** A zone row with every field defaulted, so each test states only what it is about. */
function zone(over: Partial<ZoneRangeRow> & { zone: string }): ZoneRangeRow {
  const spanMs = over.spanMs ?? HOUR
  const idleMs = over.idleMs ?? 0
  // The Σ identity the query guarantees (active + idle + offline == span), so a row built here
  // is a row `rangeStats` could actually have produced.
  const offlineMs = over.offlineMs ?? 0
  const activeMs = over.activeMs ?? spanMs - idleMs - offlineMs
  const base: ZoneRangeRow = {
    zone: over.zone,
    spanMs,
    activeMs,
    idleMs,
    offlineMs,
    visits: 1,
    kills: 0,
    killsSelf: 0,
    killsPet: 0,
    levelEquiv: 0,
    expUnstated: 0,
    expSamples: 0,
    levelsPerHourActive: null,
    levelsPerHourWall: null,
    killsPerHourActive: null
  }
  return { ...base, ...over, spanMs, activeMs, idleMs, offlineMs }
}

function stats(over: Partial<RangeStats> = {}): RangeStats {
  const base: RangeStats = {
    t0: T0,
    t1: T0 + 3 * HOUR,
    durationMs: 3 * HOUR,
    activeMs: 3 * HOUR,
    idleMs: 0,
    idleGaps: 0,
    idleThresholdMs: IDLE_GAP_MS,
    offlineMs: 0,
    offlineGaps: 0,
    kills: 0,
    killsSelf: 0,
    killsPet: 0,
    killsWitnessed: 0,
    expSamples: 0,
    expParty: 0,
    expUnstated: 0,
    levelEquiv: 0,
    levelsPerHourActive: null,
    levelsPerHourWall: null,
    killsPerHourActive: null,
    levelUps: [],
    levelRuns: [],
    aaGained: 0,
    aaGainEvents: 0,
    zones: [],
    combos: [],
    clipped: false
  }
  return { ...base, ...over }
}

// ---------------------------------------------------------------- the rate formatters

test('formatNum would destroy a levels/hr rate — which is why these exist', () => {
  // The trap, stated as a test so nobody "simplifies" the two formatters back onto formatNum.
  assert.equal(formatNum(1.42), '1', 'formatNum rounds anything under 1000 to an integer')
  assert.equal(formatLevelRate(1.42), '1.42 lvl/hr')
})

test('formatLevelRate / formatKillRate keep the precision the number deserves', () => {
  assert.equal(formatKillRate(38.5), '38.5 kills/hr')
  assert.equal(formatLevelRate(0.35), '0.35 lvl/hr', 'a sub-1 rate keeps two decimals')
  assert.equal(formatKillRate(0.07), '0.07 kills/hr')
  assert.equal(formatLevelRate(0), '0.00 lvl/hr', 'a REAL zero is a stated fact and prints')
  assert.equal(formatLevelRate(9.999), '10.00 lvl/hr', 'rounding across the band boundary')
  assert.equal(formatKillRate(99.94), '99.9 kills/hr', 'one decimal from 10 up')
  assert.equal(formatKillRate(240.4), '240 kills/hr', 'three digits need no fraction')
  assert.equal(formatKillRate(1800), '1800 kills/hr', 'never k-scaled — this is a count per hour')
})

test('fmtDuration is the SPAN shape, not the compact delta shape', () => {
  assert.equal(fmtDuration(2 * HOUR + 41 * MIN), '2h 41m')
  assert.equal(fmtDuration(38 * MIN), '38m')
  assert.equal(fmtDuration(45_000), '45s')
  assert.equal(fmtDuration(0), '0s')
  assert.equal(fmtDuration(-5), '0s', 'a negative span is clamped, never printed')
  assert.equal(fmtDuration(72 * HOUR), '3d 0h', 'multi-day drags roll over instead of reading 72h')
})

// ---------------------------------------------------------------- the per-zone table

test('zone rows sort by levels/hr desc, with UNKNOWN rates last', () => {
  const rows = zoneStatRows([
    zone({ zone: 'Befallen', levelsPerHourActive: 1.2 }),
    zone({ zone: 'Najena', levelsPerHourActive: null, spanMs: 5 * HOUR }),
    zone({ zone: "Nagafen's Lair", levelsPerHourActive: 3.4 })
  ])
  assert.deepEqual(
    rows.map((r) => r.zone),
    ["Nagafen's Lair", 'Befallen', 'Najena'],
    'a zone whose rate is unknown never outranks one that has a number'
  )
})

test('the time toggle is a real reorder, and ties fall back to span', () => {
  const zones = [
    zone({ zone: 'Befallen', levelsPerHourActive: 1.2, spanMs: 20 * MIN }),
    zone({ zone: 'Najena', levelsPerHourActive: null, spanMs: 5 * HOUR }),
    zone({ zone: "Nagafen's Lair", levelsPerHourActive: 3.4, spanMs: HOUR })
  ]
  assert.deepEqual(
    zoneStatRows(zones, 'time').map((r) => r.zone),
    ['Najena', "Nagafen's Lair", 'Befallen']
  )
  const ties = zoneStatRows([
    zone({ zone: 'A', levelsPerHourActive: 2, spanMs: HOUR }),
    zone({ zone: 'B', levelsPerHourActive: 2, spanMs: 3 * HOUR })
  ])
  assert.deepEqual(ties.map((r) => r.zone), ['B', 'A'], 'equal rates: the longer stay leads')
})

test('sorting never mutates the caller’s array', () => {
  const zones = [zone({ zone: 'Befallen', levelsPerHourActive: 1 }), zone({ zone: 'Najena', levelsPerHourActive: 9 })]
  zoneStatRows(zones, 'levels')
  assert.deepEqual(zones.map((z) => z.zone), ['Befallen', 'Najena'], 'the snapshot query owns that array')
})

test('a null rate renders as an em-dash, never as 0.0', () => {
  const [row] = zoneStatRows([zone({ zone: 'Befallen', spanMs: HOUR, idleMs: HOUR })])
  assert.equal(row.levelsPerHour, NONE)
  assert.equal(row.killsPerHour, NONE)
  assert.equal(row.time, '1h 0m')
  assert.equal(row.active, '0s', 'an hour of pure silence has no active time')
  assert.equal(row.idle, '1h 0m')
})

test('a zone with no idle at all carries no idle string', () => {
  // ROWS ARE SHAPED OVER THE HOUR IN FORCE SINCE JOS-288, and the default is `elapsed`. This row
  // states its ACTIVE rates, so the arm names that basis: what it is about is the idle string and
  // the two rate spellings beside it, not which denominator produced them.
  const [row] = zoneStatRows(
    [zone({ zone: 'Befallen', spanMs: 2 * HOUR + 41 * MIN, killsPerHourActive: 38.5, levelsPerHourActive: 1.42 })],
    'levels',
    'active'
  )
  assert.equal(row.idle, null, 'null, so the panel prints nothing rather than "0s idle"')
  assert.equal(row.time, '2h 41m')
  assert.equal(row.levelsPerHour, '1.42 lvl/hr')
  assert.equal(row.killsPerHour, '38.5 kills/hr')
})

test('a zone splits its span into active and idle', () => {
  const [row] = zoneStatRows([zone({ zone: 'Guk', spanMs: 3 * HOUR, idleMs: 38 * MIN })])
  assert.equal(row.time, '3h 0m')
  assert.equal(row.active, '2h 22m')
  assert.equal(row.idle, '38m')
})

test('the swatch is the SAME hue the chart band uses', () => {
  const [row] = zoneStatRows([zone({ zone: 'The Plane of Hate - Solo' })])
  assert.equal(row.color, zoneColor('The Plane of Hate'), 'instance noise folds to one color')
  assert.equal(row.zone, 'The Plane of Hate - Solo', 'but the RAW name is what displays')
})

test('levels: a stated zero prints, an UNSTATED one does not', () => {
  const [stated] = zoneStatRows([zone({ zone: 'Befallen', expSamples: 12, levelEquiv: 0.4213 })])
  assert.equal(stated.levels, '0.42')
  assert.equal(stated.unstated, 0)

  const [none] = zoneStatRows([zone({ zone: 'Befallen', expSamples: 0 })])
  assert.equal(none.levels, '0.00', 'no experience at all is a fact the log DID state')

  const [capped] = zoneStatRows([zone({ zone: 'Befallen', expSamples: 9, expUnstated: 9 })])
  assert.equal(capped.levels, NONE, 'every line refused a percentage — unknown is not zero')
  assert.equal(capped.unstated, 9)

  const [partial] = zoneStatRows([zone({ zone: 'Befallen', expSamples: 9, expUnstated: 4, levelEquiv: 1.5 })])
  assert.equal(partial.levels, '1.50', 'the stated half still counts')
  assert.equal(partial.unstated, 4, 'and the row admits the other half')
})

// ---------------------------------------------------------------- the hero cards

test('the hero cards report the four headline numbers', () => {
  const heroes = rangeHeroes(
    stats({
      activeMs: 2 * HOUR + 41 * MIN,
      levelsPerHourActive: 1.42,
      kills: 214,
      killsSelf: 180,
      killsPet: 34,
      expSamples: 210,
      levelEquiv: 3.8,
      levelUps: [
        { ts: T0, level: 18 },
        { ts: T0 + HOUR, level: 19 }
      ],
      levelRuns: [{ fromLevel: 18, toLevel: 19, startTs: T0, endTs: T0 + HOUR }]
    }),
    // The ACTIVE basis, named: this fixture states an active rate, and what the arm is about is the
    // four cards rather than which hour they divide by (the pair below pins that).
    'active'
  )
  assert.deepEqual(heroes.map((h) => h.id), ['rate', 'kills', 'levels', 'range'])
  assert.equal(heroes[0].value, '1.42 lvl/hr')
  assert.equal(heroes[0].sub, 'over 2h 41m active')
  assert.equal(heroes[1].value, '214')
  assert.equal(heroes[1].sub, '180 your killing blows · 34 pet (inferred)', 'pet credit is INFERRED, and says so')
  assert.equal(heroes[2].value, '3.80')
  assert.equal(heroes[2].label, 'Levels of progress', 'never "xp" — the log states a level-bar percentage')
  assert.equal(heroes[3].value, '18 → 19')
  assert.equal(heroes[3].sub, '2 dings')
})

test('an at-the-cap range em-dashes the rate and says WHY', () => {
  const heroes = rangeHeroes(stats({ expSamples: 22, expUnstated: 22, levelsPerHourActive: null }))
  assert.equal(heroes[0].value, NONE)
  assert.equal(heroes[0].sub, 'the log stated no percentage in this range')
  assert.equal(heroes[2].value, NONE, 'and the levels card refuses to print 0.00')
})

test('a range with no active time em-dashes the rate for the OTHER reason', () => {
  // Named basis: the reason under test is "no time of THIS kind", and the kind is the active one.
  const heroes = rangeHeroes(stats({ activeMs: 0, idleMs: 3 * HOUR, expSamples: 0 }), 'active')
  assert.equal(heroes[0].value, NONE)
  assert.equal(heroes[0].sub, 'no active time in this range')
  assert.equal(heroes[1].sub, 'no credited kills in this range')
  assert.equal(heroes[3].value, NONE)
  assert.equal(heroes[3].sub, 'no level-ups in this range')
})

test('a loadout swap shows two runs, never one fabricated span', () => {
  const heroes = rangeHeroes(
    stats({
      levelUps: [
        { ts: T0, level: 27 },
        { ts: T0 + HOUR, level: 28 },
        { ts: T0 + 2 * HOUR, level: 11 }
      ],
      levelRuns: [
        { fromLevel: 27, toLevel: 28, startTs: T0, endTs: T0 + HOUR },
        { fromLevel: 11, toLevel: 11, startTs: T0 + 2 * HOUR, endTs: T0 + 2 * HOUR }
      ]
    })
  )
  assert.equal(heroes[3].value, '27 → 28 · 11', 'the drop is a NEW run — never "27 → 11"')
  assert.equal(heroes[3].sub, '3 dings · 1 class swap')
})

// ---------------------------------------------------------------- the chip row

test('active/idle text, and the idle rule stated literally', () => {
  assert.equal(activeIdleText(stats({ activeMs: 2 * HOUR + 41 * MIN, idleMs: 38 * MIN })), '2h 41m active · 38m idle')
  assert.equal(activeIdleText(stats({ activeMs: HOUR, idleMs: 0 })), '1h 0m active', 'no idle, no idle clause')
  assert.equal(
    idleRuleCaption(IDLE_GAP_MS),
    'idle = no experience, kill, or loot event for over 5 minutes',
    'the threshold is read from the stats, never typed in'
  )
  assert.equal(idleRuleCaption(10 * MIN), 'idle = no experience, kill, or loot event for over 10 minutes')
  assert.ok(!/AFK|offline|away/i.test(idleRuleCaption(IDLE_GAP_MS)), 'the log records events, not presence')
  assert.equal(idleGapsText(stats({ idleGaps: 0 })), null)
  assert.equal(idleGapsText(stats({ idleGaps: 3 })), '3 gaps over 5m')
})

// JOS-454. `durationMs` under a zone slice is Σ of the ADMITTED VISITS, not `t1 - t0`, and the
// header prints both numbers side by side with nothing between them. The owner's report is what
// that costs: a drag over 1h51m of one afternoon read `15m`, because the slice's membership was
// the tier he had just walked OUT of, and no string on the panel named a zone or a tier. So the
// shortfall is stated — how much of the selected span the numbers cover, and what admitted it.
test('the membership line says how much of the range the numbers left out, and why', () => {
  const sliced = stats({ durationMs: 927_000, t0: T0, t1: T0 + 6_695_000 })
  assert.equal(
    membershipText(sliced, 'The Plane of Hate, this tier only'),
    'of 1h 51m selected · The Plane of Hate, this tier only',
    'the numbers cover 15m of it — the reader is told both, in the order they read them'
  )
  assert.ok(/tier/.test(MEMBERSHIP_TITLE), 'and the hover explains that a TIER can be what excluded the rest')
  assert.ok(/chart/.test(MEMBERSHIP_TITLE), 'including that the chart above may still be drawing it')
})

test('no zone in force means no membership line at all', () => {
  // The unrestricted read: `rangeStats` sets durationMs = t1 - t0, so there is nothing to explain
  // and this panel prints exactly what it printed before the line existed.
  const whole = stats({ durationMs: 3 * HOUR })
  assert.equal(membershipText(whole, null), null)
  assert.equal(membershipText(whole, undefined), null)
  assert.equal(membershipText(whole, 'Lower Guk, every tier'), null, 'a slice that admitted all of it says nothing')
})

test('a sub-second shortfall is not a shortfall — the line is not a permanent second clause', () => {
  // A bucket-snapped edge can leave a few hundred milliseconds unaccounted; `fmtDuration` prints
  // whole seconds, so announcing that would put an unreadable clause on every zone-sliced read.
  const rounding = stats({ durationMs: 3 * HOUR - 400, t0: T0, t1: T0 + 3 * HOUR })
  assert.equal(membershipText(rounding, 'Lower Guk, every tier'), null)
  const real = stats({ durationMs: 3 * HOUR - 90 * MIN, t0: T0, t1: T0 + 3 * HOUR })
  assert.equal(membershipText(real, 'Lower Guk, every tier'), 'of 3h 0m selected · Lower Guk, every tier')
})

test('the class combo is quoted verbatim, or admitted as unknown', () => {
  assert.equal(comboText([]), 'class combo: not stated in this range')
  assert.equal(comboInferred([]), false)
  const one = { startTs: T0, endTs: T0 + HOUR, classes: ['PAL', 'MNK', 'ENC'], inferred: false }
  assert.equal(comboText([one]), 'class combo: PAL/MNK/ENC')
  assert.equal(
    comboText([one, { ...one, startTs: T0 + HOUR, classes: ['PAL', 'MNK', 'WIZ'], inferred: true }]),
    'class combo: PAL/MNK/ENC → PAL/MNK/WIZ',
    'a swap inside the range shows both loadouts, in order'
  )
  assert.equal(comboText([one, { ...one, startTs: T0 + HOUR }]), 'class combo: PAL/MNK/ENC', 'one loadout, one label')
  assert.equal(comboInferred([one, { ...one, inferred: true }]), true)
})

test('witnessed kills and AA are context, and vanish when there are none', () => {
  assert.equal(witnessedText(stats({ killsWitnessed: 0 })), null)
  assert.equal(witnessedText(stats({ killsWitnessed: 1204 })), '1,204 kills by others seen')
  assert.equal(aaText(stats({ aaGained: 0, aaGainEvents: 0 })), null)
  assert.equal(aaText(stats({ aaGained: 7, aaGainEvents: 5 })), '+7 AA')
  // The caption names the source in one phrase; the respec reservation lives in the doc
  // comment, not on screen (AGENTS.md tooltip and caveat diet).
  assert.match(AA_RESPEC_CAPTION, /gain lines/)
  assert.ok(AA_RESPEC_CAPTION.split(/\s+/).length <= 6, AA_RESPEC_CAPTION)
})

// ---------------------------------------------------------------- offline (rule 4)

test('offline is SAID only where the log said it, and stays out of the idle wording', () => {
  assert.equal(offlineText(stats()), null, 'no derived logout ⇒ no offline word at all')
  assert.equal(offlineGapsText(stats()), null)
  assert.equal(offlineText(stats({ offlineMs: 8 * HOUR + 12 * MIN })), '8h 12m offline')
  assert.equal(offlineGapsText(stats({ offlineGaps: 1 })), '1 logout')
  assert.equal(offlineGapsText(stats({ offlineGaps: 3 })), '3 logouts')

  // The active/idle chip is untouched by offline: it reports the two things it always did, and
  // the offline number is its own chip beside it.
  const camped = stats({ activeMs: 40 * MIN, idleMs: 20 * MIN, offlineMs: 8 * HOUR, offlineGaps: 1 })
  assert.equal(activeIdleText(camped), '40m active · 20m idle')
  assert.ok(!/offline/i.test(activeIdleText(camped)), 'the active/idle chip never grows an offline clause')
})

test('the offline caption and tooltip name the state, not the method', () => {
  assert.equal(OFFLINE_CAPTION, 'logged out')
  // The tooltip diet (AGENTS.md UI conventions): one clause, no account of where the number
  // came from or how it might be wrong. The evidence rule itself lives in the doc comments.
  assert.match(OFFLINE_TITLE, /logged out/)
  assert.ok(OFFLINE_TITLE.split(/\s+/).length <= 10, OFFLINE_TITLE)
  assert.ok(!/camp\/login|only known|counted as idle/.test(OFFLINE_TITLE), OFFLINE_TITLE)
  // …and the idle caption stays exactly what it was: it covers every silence the app cannot
  // attribute, which is precisely the set that must not be called offline.
  assert.equal(idleRuleCaption(IDLE_GAP_MS), 'idle = no experience, kill, or loot event for over 5 minutes')
  assert.ok(!/AFK|offline|away/i.test(idleRuleCaption(IDLE_GAP_MS)))
})

test('a zone row prints its logout beside its active time, and nothing when there was none', () => {
  const [plain] = zoneStatRows([zone({ zone: 'Befallen', spanMs: 3 * HOUR, idleMs: 38 * MIN })])
  assert.equal(plain.offline, null)
  assert.equal(plain.detail, '2h 22m active', 'unchanged: no offline, no offline clause')
  assert.equal(plain.offlineMs, 0)

  const [camp] = zoneStatRows([
    zone({ zone: 'Befallen', spanMs: 10 * HOUR, idleMs: 61 * MIN, offlineMs: 8 * HOUR + 59 * MIN })
  ])
  assert.equal(camp.time, '10h 0m')
  assert.equal(camp.active, '0s', 'the identity holds: 10h - 1h01m idle - 8h59m offline')
  assert.equal(camp.idle, '1h 1m')
  assert.equal(camp.offline, '8h 59m')
  assert.equal(camp.detail, '0s active · 8h 59m offline')

  const [busy] = zoneStatRows([zone({ zone: 'Guk', spanMs: 2 * HOUR })])
  assert.equal(busy.detail, null, 'pure activity needs no qualifier at all')
})

test('the unstated footnote appears only when it is true', () => {
  assert.equal(unstatedCaption(stats({ expSamples: 40, expUnstated: 0 })), null)
  const note = unstatedCaption(stats({ expSamples: 40, expUnstated: 1 }))
  assert.match(note ?? '', /^\* 1 experience line stated no percentage/, 'singular')
  assert.match(unstatedCaption(stats({ expUnstated: 22 })) ?? '', /22 experience lines stated no percentage/)
})

test('the active-time definition answers the question a user actually asked (JOS-249)', () => {
  // A 0.22.0 reporter asked whether "active time" was AFK removal or out-of-combat removal. It is
  // NEITHER, so the sentence has to (a) state what it IS and (b) close out both guesses by name —
  // otherwise the reader supplies the wrong one and every rate in the app reads as a claim it is
  // not making.
  assert.match(ACTIVE_TIME_TITLE, /^Active time = /)
  // The three streams `idleSpans` walks, in the same words `idleRuleCaption` already uses.
  assert.match(ACTIVE_TIME_TITLE, /experience, credited kill, or loot line/)
  // The logout half — `activeMs` subtracts offline as well as idle.
  assert.match(ACTIVE_TIME_TITLE, /logged out/)
  // Both wrong guesses, refused out loud.
  assert.match(ACTIVE_TIME_TITLE, /not an AFK check/)
  assert.match(ACTIVE_TIME_TITLE, /not out-of-combat time/)
  // The threshold is READ from the classifier's own constant, never typed in beside it: a second
  // copy of 5 would go on saying 5 the day the measurement moved it.
  assert.ok(
    ACTIVE_TIME_TITLE.includes(`over ${IDLE_GAP_MS / MIN} minutes`),
    `the sentence must quote IDLE_GAP_MS: ${ACTIVE_TIME_TITLE}`
  )
})

test('withActiveTime appends the definition rather than replacing what a surface already said', () => {
  assert.equal(withActiveTime('Motes per hour.'), `Motes per hour. ${ACTIVE_TIME_TITLE}`)
  // The one title in this file that already had a sentence keeps it, and gains the definition.
  assert.match(AA_RATE_TITLE, /^AA completions and ability points per hour of active time\. Active time = /)
})

test('the levels-per-hour hero card is the only one that hovers the definition', () => {
  const heroes = rangeHeroes(stats({ activeMs: 2 * HOUR, levelsPerHourActive: 1.42, expSamples: 12 }), 'active')
  const rateCard = heroes.find((h) => h.id === 'rate')
  assert.match(rateCard?.title ?? '', /Active time = /, 'the rate card divides by it, so it says what it is')
  for (const h of heroes.filter((c) => c.id !== 'rate')) {
    assert.equal(h.title, undefined, `${h.id} has no rate denominator and so carries no hover`)
  }
})

