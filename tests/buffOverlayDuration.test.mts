// THE ONE ESTIMATOR (JOS-117): max(DB baseline, recent-window observed max), used by BOTH the
// overlay countdown AND the Buffs-tab estimate column.
//
// This refines JOS-114 after owner validation. JOS-114 fed the overlay the MOST-RECENT clean
// sample, so a buff CLICKED OFF / dispelled / overwritten early minted a short "worn off" sample —
// indistinguishable from a natural expiry (EQ prints the same line) — and became the overlay's
// too-short number (the owner saw Swift Like the Wind at ~28m for a 33:36 buff). And the Buffs tab
// pinned its estimate to the DB, ignoring the log entirely. JOS-117 unifies both on:
//
//   estimate = max( DB baseline , max-over-recent-window of CLEAN observed samples )
//
// The DB base is a FLOOR (AA/focus only EXTEND a beneficial buff, so a below-base sample is an
// early termination and is discarded); a sample ABOVE the base is a real extension and wins; the
// window (not all-time) lets a removed focus age out. Source = 'db' when the floor held, 'observed'
// when a logged cast beat it (the UI labels that "log").
//
// These drive the REAL modules — parser-free, constructing the typed LogEvents the parser would
// emit — because the whole point is the buffs model's sample minting + censoring + projection, not
// the message grammar (pinned elsewhere). The pure estimator cases (Invisibility floor, the Swift
// distribution, the window) drive SpellStats directly with a fabricated DB. Every duration below is
// the committed spells.json's own number for the named spell where the real module is used.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb, buildSpellDb } from '../src/main/data/spellDb.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { SpellStats } from '../src/main/modules/buffsStats.ts'
import { PetEntities } from '../src/main/modules/buffsEntities.ts'
import { buildActive } from '../src/main/modules/buffsView.ts'
import { SELF_KEY, spellKey } from '../src/main/modules/buffsShapes.ts'
// The learner is keyed on (spell LINE, CASTER) since JOS-140, so a test that drives SpellStats
// directly has to say whose durations it is talking about. These cases are all about the player.
import { SELF_CASTER } from '../src/shared/buffTrust.ts'
import { buildTimerRows, type BuffTimerRow } from '../src/shared/buffTimers.ts'
import type { LogEvent } from '../src/shared/logEvents.ts'
import type { BuffsSnap, BuffStat, SpellEntry } from '../src/shared/types.ts'

const SWIFT = 'Swift Like the Wind'
const SWIFT_DB_MS = 960_000 // 16m — the DB base (floor)
const SWIFT_OBSERVED_MS = 1_980_000 // 33m — this character's AA/focus-extended truth
const SWIFT_CLICKOFF_MS = 1_680_000 // 28m — a cast clicked off / dispelled early (a SHORT sample)

const SD = 'Shiftless Deeds'
const SD_DB_MS = 150_000 // 2m30s — the DB base
const SD_OBSERVED_MS = 180_000 // 3m — an AA/focus-extended slow

/** A fresh DB-backed buffs module, plus a monotonic event feeder. */
function makeModule(): { mod: BuffsModule; feed: (ev: Omit<LogEvent, 'seq'>) => void } {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  const feed = (ev: Omit<LogEvent, 'seq'>): void => {
    mod.onEvent({ ...ev, seq: seq++ } as LogEvent)
  }
  return { mod, feed }
}

/** A SpellStats with a one-spell fabricated DB (for the pure-estimator cases). */
function statsWithDb(name: string, durationMs: number | null): { stats: SpellStats; key: string } {
  const entry: SpellEntry = { name, durationMs, illusion: false, spellType: 'Beneficial' }
  return { stats: new SpellStats(buildSpellDb([entry])), key: spellKey(name) }
}

/** `You begin casting <spell>.` */
function castBegin(spell: string, ts: number): Omit<LogEvent, 'seq'> {
  return { kind: 'castBegin', ts, raw: `[x] You begin casting ${spell}.`, spell }
}
/** A message-driven landing (own cast already in history), on self or a named target. */
function buffApply(spell: string, target: string, durationMs: number, ts: number): Omit<LogEvent, 'seq'> {
  return {
    kind: 'buffApply',
    ts,
    raw: `[x] ${spell} landed on ${target}.`,
    spell,
    target,
    illusion: false,
    durationMs,
    candidates: [{ name: spell, durationMs, illusion: false }]
  }
}
/** A genuine wear-off — the ONLY thing that mints a duration sample. Targetless ⇒ self. */
function buffFade(spell: string, ts: number, target?: string): Omit<LogEvent, 'seq'> {
  return { kind: 'buffFade', ts, raw: `[x] ${spell} wore off.`, spell, ...(target != null ? { target } : {}) }
}
/**
 * An inert event that only advances the module's event clock — an activated AA that is NOT Quick
 * Buff touches no buff instance. Needed because a buff genuinely up for many minutes has real
 * combat in between; without a keep-alive a long jump between two synthetic events would trip the
 * module's SESSION_GAP_MS logout clear and wipe the open cast before its wear-off.
 */
function keepAlive(ts: number): Omit<LogEvent, 'seq'> {
  return { kind: 'aaActivate', ts, raw: '[x] You activate Mend.', name: 'Mend' }
}

/**
 * Feed a fresh cast that LANDS, and return the landing ts. Since JOS-118 a cast displays
 * nothing on its own — an instance opens only from the landing line — so a test that wants a
 * live row to read the estimator off must land the buff, exactly as the game does. These cases
 * are about the ESTIMATOR, and the cast+land pair is the shortest honest way to get a row.
 */
function castAndLand(feed: (ev: Omit<LogEvent, 'seq'>) => void, spell: string, ts: number): number {
  feed(castBegin(spell, ts))
  const land = ts + 1_000
  feed(buffApply(spell, 'self', SWIFT_DB_MS, land))
  return land
}

/** Feed one clean self cast→wear-off cycle of `spell`, lasting `durationMs`. Returns the fade ts. */
function selfCycle(feed: (ev: Omit<LogEvent, 'seq'>) => void, spell: string, startTs: number, durationMs: number): number {
  feed(castBegin(spell, startTs))
  const land = startTs + 1_000
  feed(buffApply(spell, 'self', SWIFT_DB_MS, land))
  feed(keepAlive(land + Math.floor(durationMs / 2)))
  const fade = land + durationMs
  feed(buffFade(spell, fade))
  return fade
}

/** The overlay's active row for a spell, by name. */
function rowFor(snap: BuffsSnap, spell: string): BuffTimerRow | undefined {
  return buildTimerRows(snap, { holds: [], ends: [] }).find((r) => r.name === spell)
}
/** The Buffs-tab stat row for a spell, by name. */
function statFor(snap: BuffsSnap, spell: string): BuffStat | undefined {
  return Object.values(snap.stats).find((s) => s.spell === spell)
}

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE — CLICK-OFF IGNORED. [33m full, then 28m click-off] ⇒ estimate 33m, not 28m.
// This is the headline defect: JOS-114 trusted the 28m as "most recent"; the MAX ignores it.
// ---------------------------------------------------------------------------------------------

test('a click-off after a full cycle does NOT drag the estimate down — max(DB, window) ⇒ 33m, not 28m', () => {
  const { mod, feed } = makeModule()
  const t0 = 1_000_000_000_000
  const afterFull = selfCycle(feed, SWIFT, t0, SWIFT_OBSERVED_MS) // 33m clean
  const afterClickoff = selfCycle(feed, SWIFT, afterFull + 5_000, SWIFT_CLICKOFF_MS) // 28m early click-off

  // The next cast LANDS — what the overlay counts down from and what the tab estimates.
  castAndLand(feed, SWIFT, afterClickoff + 5_000)
  const snap = mod.snapshot().state

  const active = snap.active.find((a) => a.spell === SWIFT)
  assert.ok(active, 'Swift should be active after the recast')
  assert.equal(active.overlayDurationMs, SWIFT_OBSERVED_MS, 'the overlay uses the 33m full cycle, NOT the 28m click-off')
  assert.equal(active.overlaySource, 'observed')
  // The tab now agrees — the log is what makes it accurate (owner).
  assert.equal(active.estimatedMs, SWIFT_OBSERVED_MS, 'the tab estimate is the same 33m — no longer DB-pinned')
  assert.equal(active.durationSource, 'observed')

  const row = rowFor(snap, SWIFT)
  assert.ok(row)
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, SWIFT_OBSERVED_MS)

  // The DISTRIBUTION columns are untouched: they still show the raw 28m–33m spread over n=2.
  const stat = statFor(snap, SWIFT)
  assert.ok(stat)
  assert.equal(stat.n, 2)
  assert.equal(stat.minMs, SWIFT_CLICKOFF_MS, 'min is still the 28m click-off — the columns are honest')
  assert.equal(stat.maxMs, SWIFT_OBSERVED_MS)
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE — GROWTH CAPTURED. [16m (=base), then 33m] ⇒ 33m.
// ---------------------------------------------------------------------------------------------

test('growth over the DB base is captured — [16m base, then 33m] ⇒ estimate 33m', () => {
  const { mod, feed } = makeModule()
  const t0 = 1_000_000_000_000
  const afterBase = selfCycle(feed, SWIFT, t0, SWIFT_DB_MS) // 16m — a cast at the base
  const afterGrown = selfCycle(feed, SWIFT, afterBase + 5_000, SWIFT_OBSERVED_MS) // 33m — focus/AA extended

  castAndLand(feed, SWIFT, afterGrown + 5_000)
  const snap = mod.snapshot().state

  const active = snap.active.find((a) => a.spell === SWIFT)
  assert.ok(active)
  assert.equal(active.overlayDurationMs, SWIFT_OBSERVED_MS, 'the extended 33m wins')
  assert.equal(active.overlaySource, 'observed')
  assert.equal(active.estimatedMs, SWIFT_OBSERVED_MS)
  assert.equal(active.durationSource, 'observed')
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE — INVISIBILITY FLOOR. DB 20m, observed max only 4m (always broken early) ⇒ 20m, 'db'.
// The estimate must NOT collapse to the broken-early observations.
// ---------------------------------------------------------------------------------------------

test('a buff always broken early keeps its DB FLOOR — DB 20m, observed max 4m ⇒ 20m, source db', () => {
  const { stats, key } = statsWithDb('Invisibility', 1_200_000) // DB 20m
  stats.everFaded.add(key)
  // all ≤4m24
  ;[264_000, 180_000, 240_000, 264_000, 120_000].forEach((s, i) => {
    stats.pushSample(key, SELF_CASTER, 'Invisibility', { ms: s, ts: (i + 1) * 60_000 })
  })

  const est = stats.estimateFor(key)
  assert.equal(est.ms, 1_200_000, 'the DB floor holds — a below-base observation is an early break, discarded')
  assert.equal(est.source, 'db', 'and it legitimately stays a db chip')

  // The overlay agrees, via the projection.
  const active = buildActive({ spell: 'Invisibility', key, entityKey: SELF_KEY, startedTs: 1_000 }, stats, new PetEntities())
  assert.equal(active.overlayDurationMs, 1_200_000)
  assert.equal(active.overlaySource, 'db')
  const row = buildTimerRows({ active: [active], stats: {} }, { holds: [], ends: [] })[0]
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 1_200_000)
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE — SWIFT DISTRIBUTION. DB 16m; a window whose MAX is a 36m extension (the mass are
// shorter click-offs/refreshes) ⇒ ~36m, source observed. Only the max recovers it.
// ---------------------------------------------------------------------------------------------

test('the observed MAX over the window beats the DB base — Swift DB 16m, a 36m sample in window ⇒ 36m, observed', () => {
  const { stats, key } = statsWithDb(SWIFT, SWIFT_DB_MS) // DB 16m
  stats.everFaded.add(key)
  // The real shape: a mass of shorter samples (median ~15m53) with one focus-extended 36m20.
  ;[953_000, 954_000, 2_180_000, 951_000, 950_000].forEach((s, i) => {
    stats.pushSample(key, SELF_CASTER, SWIFT, { ms: s, ts: (i + 1) * 3_600_000 })
  })

  const est = stats.estimateFor(key)
  assert.equal(est.ms, 2_180_000, 'the 36m20 extension wins over both the DB base and the shorter mass')
  assert.equal(est.source, 'observed', 'a logged cast beat the floor — the UI shows a "log" chip')

  // Median/IQR would have stayed dragged below the truth — the columns still report them honestly.
  const stat = stats.statFor(key)
  assert.ok(stat)
  assert.ok(stat.medianMs != null && stat.medianMs < SWIFT_DB_MS + 100_000, 'median stays near the DB base, well below 36m')
  assert.equal(stat.maxMs, 2_180_000)
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE — DECREASE RECOVERS. A long observation ages out of the recent window ⇒ estimate drops.
// ---------------------------------------------------------------------------------------------

test('a genuine decrease recovers as the old long sample leaves the recent window', () => {
  const stats = new SpellStats() // no DB — the observed max IS the estimate, so the window is visible
  const key = 'faded focus spell'
  stats.everFaded.add(key)
  stats.pushSample(key, SELF_CASTER, 'Faded Focus Spell', { ms: 2_400_000, ts: 3_600_000 }) // 40m, focus-extended

  assert.equal(stats.estimateFor(key).ms, 2_400_000, 'while the 40m sample is in the window it stands')

  // The focus is removed; five later casts all run the base 20m. RECENT_SAMPLE_WINDOW is 5, so the
  // 40m ages out of the window and the estimate recovers to the true shorter duration. Every one of
  // these is UNCENSORED, which is what JOS-180 requires for an eviction: a real decrease is proved
  // by full cycles that ran short, never by cycles something else ended.
  for (let i = 0; i < 5; i++) {
    stats.pushSample(key, SELF_CASTER, 'Faded Focus Spell', { ms: 1_200_000, ts: 7_200_000 + i * 3_600_000 })
  }
  assert.equal(stats.estimateFor(key).ms, 1_200_000, 'the 40m has left the window; a real decrease is recovered')

  // The all-time min/max columns still remember both — only the estimate windowed.
  const stat = stats.statFor(key)
  assert.ok(stat)
  assert.equal(stat.maxMs, 2_400_000)
  assert.equal(stat.minMs, 1_200_000)
})

// ---------------------------------------------------------------------------------------------
// REFRESH-INFLATION DEFENCE. A buff re-applied before it expires must NOT be measured land→fade as
// one over-long span (which the MAX would then trust). The re-land RESETS the open cast's landedTs,
// so a refresh mints ONE clean full cycle — never the sum of the leftover plus the new duration.
// ---------------------------------------------------------------------------------------------

test('a refresh before expiry mints one CLEAN full-cycle sample, not an inflated land→fade span', () => {
  const { mod, feed } = makeModule()
  const t0 = 1_000_000_000_000

  // Land Swift, then RE-APPLY it 10 minutes in (well before the ~33m expiry).
  feed(castBegin(SWIFT, t0))
  const land1 = t0 + 1_000
  feed(buffApply(SWIFT, 'self', SWIFT_DB_MS, land1))
  const refreshAt = land1 + 600_000 // +10m, still active
  feed(keepAlive(refreshAt - 1_000))
  feed(castBegin(SWIFT, refreshAt))
  const land2 = refreshAt + 1_000
  feed(buffApply(SWIFT, 'self', SWIFT_DB_MS, land2)) // the re-land resets the open cast's landedTs
  feed(keepAlive(land2 + SWIFT_OBSERVED_MS / 2))
  feed(buffFade(SWIFT, land2 + SWIFT_OBSERVED_MS)) // wears off 33m after the RE-LAND

  const snap = mod.snapshot().state
  const stat = statFor(snap, SWIFT)
  assert.ok(stat, 'Swift should have a mined stat')
  assert.equal(stat.n, 1, 'exactly one sample — the refresh did not double-count')
  assert.equal(stat.maxMs, SWIFT_OBSERVED_MS, 'the span is measured from the RE-LAND (33m), not from the first land (~43m)')
  // Concretely: an un-reset span would have been land2+33m − land1 ≈ 43m and would have inflated the
  // MAX estimator above the true duration. It is 33m.
  assert.ok(stat.maxMs < land2 + SWIFT_OBSERVED_MS - land1, 'and strictly less than the inflated land1→fade span')
})

// ---------------------------------------------------------------------------------------------
// CENSORING still mints NOTHING — a censored instance leaves the estimate on the DB floor.
// ---------------------------------------------------------------------------------------------

test('a player-death-censored self buff mints no sample — the estimate falls back to the DB base', () => {
  const { mod, feed } = makeModule()
  const t0 = 1_000_000_000_000
  feed(castBegin(SWIFT, t0))
  feed(buffApply(SWIFT, 'self', SWIFT_DB_MS, t0 + 1_000))
  // Death strips the self buff BEFORE any wear-off — the instance ends without minting a sample.
  feed({ kind: 'playerDeath', ts: t0 + 60_000, raw: '[x] You have been slain.' } as Omit<LogEvent, 'seq'>)

  castAndLand(feed, SWIFT, t0 + 120_000)
  const snap = mod.snapshot().state

  const active = snap.active.find((a) => a.spell === SWIFT)
  assert.ok(active)
  assert.equal(active.overlayDurationMs, SWIFT_DB_MS, 'no clean sample ⇒ the DB base, not a truncated value')
  assert.equal(active.overlaySource, 'db')
  assert.equal(active.estimatedMs, SWIFT_DB_MS)
  assert.equal(active.durationSource, 'db')
})

test('a zone-censored debuff on a mob mints no sample — the estimate falls back to the DB base', () => {
  const { mod, feed } = makeModule()
  const t0 = 1_000_000_000_000
  feed(castBegin(SD, t0))
  feed(buffApply(SD, 'a fire giant warrior', SD_DB_MS, t0 + 1_000))
  // Zone — the mob is left behind (world-model law 4), the debuff instance censored, no sample.
  feed({ kind: 'zone', ts: t0 + 30_000, raw: '[x] You have entered somewhere.', zone: 'somewhere' } as Omit<LogEvent, 'seq'>)

  const t1 = t0 + 60_000
  feed(castBegin(SD, t1))
  feed(buffApply(SD, 'a fire giant warrior', SD_DB_MS, t1 + 1_000))
  const snap = mod.snapshot().state

  const active = snap.active.find((a) => a.spell === SD)
  assert.ok(active, 'the recast debuff should be active on the mob')
  assert.equal(active.overlayDurationMs, SD_DB_MS, 'the zone censored the first instance — no observed value exists')
  assert.equal(active.overlaySource, 'db')
})

// ---------------------------------------------------------------------------------------------
// THE DEBUFF exemplar: an observed land→worn-off above the DB base drives the per-target countdown.
// ---------------------------------------------------------------------------------------------

test('a debuff (Shiftless Deeds) observed above its DB base drives the per-target countdown from the observation', () => {
  const { mod, feed } = makeModule()
  const t0 = 1_000_000_000_000
  feed(castBegin(SD, t0))
  feed(buffApply(SD, 'a fire giant warrior', SD_DB_MS, t0 + 1_000))
  feed(buffFade(SD, t0 + 1_000 + SD_OBSERVED_MS, 'a fire giant warrior'))

  const t1 = t0 + 1_000 + SD_OBSERVED_MS + 5_000
  feed(castBegin(SD, t1))
  feed(buffApply(SD, 'another fire giant warrior', SD_DB_MS, t1 + 1_000))
  const snap = mod.snapshot().state

  const row = rowFor(snap, SD)
  assert.ok(row, 'the debuff should project a row')
  assert.equal(row.group, 'target', 'a debuff is filed under the mob it is on')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, SD_OBSERVED_MS, 'the per-target countdown uses the observed 3m, above the DB 2m30s')
})

// ---------------------------------------------------------------------------------------------
// DISTRIBUTION COLUMNS ARE BYTE-IDENTICAL. Only the estimate + its source change; n / median / IQR
// / min-max still read straight off the raw samples.
// ---------------------------------------------------------------------------------------------

test('the estimate windows to the recent MAX while the distribution columns keep every sample', () => {
  const stats = new SpellStats() // no DB, so the observed max IS the estimate
  const key = 'made up spell'
  stats.everFaded.add(key)
  const SAMPLES = [2_400_000, 1_980_000] // 40m then 33m
  SAMPLES.forEach((s, i) => {
    stats.pushSample(key, SELF_CASTER, 'Made Up Spell', { ms: s, ts: (i + 1) * 3_600_000 })
  })

  // The estimator is the MAX over the recent window — 40m here.
  assert.equal(stats.estimateFor(key).ms, 2_400_000, 'estimate = the recent-window MAX')
  assert.equal(stats.estimateFor(key).source, 'observed')

  const active = buildActive({ spell: 'Made Up Spell', key, entityKey: SELF_KEY, startedTs: 1_000 }, stats, new PetEntities())
  assert.equal(active.overlayDurationMs, 2_400_000, 'the overlay counts down from the same MAX')
  assert.equal(active.estimatedMs, 2_400_000, 'and the tab estimate matches — one estimator, both surfaces')

  const stat = stats.statFor(key)
  assert.ok(stat)
  assert.equal(stat.n, 2)
  assert.equal(stat.minMs, 1_980_000, 'min sample')
  assert.equal(stat.maxMs, 2_400_000, 'max sample')
  assert.equal(stat.medianMs, (2_400_000 + 1_980_000) / 2, 'median across the two — unchanged')
})
