// JOS-379 — A DEBUFFED MOB'S DEATH TEACHES THE TIMER: no wear-off before the corpse means the
// spell lasted AT LEAST that long.
//
// THE REPORT (owner, live, 2026-08-15, Plane of Fear). The "Slow wore off a mob" alert spoke
// "slow off a dracoliche" while Togor's Insects was visibly still on the mob, and again on
// Cazic-Thule. Folding the owner's own log through these modules found no defect in the alert at
// all: the debuff row landed 22:38:54 (`a dracoliche yawns.`) with the committed spells.json's
// 2:30, so a 5-second early warning fires at 22:41:19 exactly as designed — for THAT clock. The
// clock was wrong. The mob was slain at 22:42:02 and no wear-off ever printed, so the real
// duration is at least 3:08.
//
// WHY THE LEARNER COULD NOT FIX ITSELF. `buffsStats.ts estimateFor` is max(DB floor, recent clean
// samples), and on raid mobs NO clean sample can ever exist: they die before a slow of yours runs
// out, and this server prints no wear-off for your debuff when somebody else lands the killing
// blow (Dread: landed 21:57:06, slain 21:57:42, no line at all). Twenty-seven Togor's landings on
// that night's bosses; zero cycles. The owner ruled NO data patch — the wiki's 2:30 is corroborated
// by the golem cycles of the night before — the buff system must LEARN it.
//
// THE OBSERVATION IT NOW READS. A death with no wear-off since the landing is a LOWER BOUND, and a
// MAX estimator can take one without bias: it lifts the floor toward the truth and never past it.
// The rails that keep "at least" honest are on `buffsInstanceRules.ts deathBoundSpan`; this file
// pins the five cases the owner named, and pins the refusals as hard as the admission.
//
// Fixtures: w69-golem-slow-cycle.log + w70-dracoliche-death-bound.log (tests/
// extract-death-bound-fixtures.mjs carries the hand-read timelines and the raw line ranges).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb } from '../src/main/data/spellDb.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { HoldGroup } from '../src/main/modules/buffRounds.ts'
import { spellKey } from '../src/main/modules/buffsShapes.ts'
import { SELF_CASTER } from '../src/shared/buffTrust.ts'
import {
  DEATH_BOUND_MAX_DB_MULTIPLE,
  DEATH_BOUND_MAX_ESTIMATE_MULTIPLE,
  deathBoundSpan,
  isArticleNamed,
  type DeathBoundStats
} from '../src/main/modules/buffsInstanceRules.ts'
import type { OpenCast } from '../src/main/modules/buffsShapes.ts'
import type { LogEvent } from '../src/shared/logEvents.ts'
import { readFixture, replayBuffTimers, tsOf } from './harness.mts'

const W69 = 'w69-golem-slow-cycle.log'
const W70 = 'w70-dracoliche-death-bound.log'

/** The LINE key both windows are about — rank-stripped, so `Togor's Insects V` pools with it. */
const TOGOR = spellKey("Togor's Insects")
/** What the committed spells.json states for the line. The floor, and the thing being lifted. */
const DB_FLOOR_MS = 150_000
/** 22:38:54 → 22:42:02, hand-read off the owner's log. */
const DRACOLICHE_BOUND_MS = 188_000

/** The estimate the app would draw for Togor's Insects after folding `lines`. */
function togorEstimate(lines: string[], prime?: string[]): { ms: number | null; source: string | undefined } {
  const { spellStats } = replayBuffTimers(lines, prime ? { prime } : undefined)
  return spellStats.estimateFor(TOGOR, SELF_CASTER)
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PREMISE. Without these the assertions below would pass against a log that simply said
// nothing, which is the failure mode a bound-from-silence rule has to be pinned against.

test('JOS-379 premise: the dracoliche window contains the landing, the kill, and NO wear-off', () => {
  const w70 = readFixture(W70)
  assert.ok(
    w70.some((l) => l.includes('[Sat Aug 15 22:38:54 2026] a dracoliche yawns.')),
    'the landing sentence for Togor’s Insects on the dracoliche'
  )
  assert.ok(
    w70.some((l) => l.includes('[Sat Aug 15 22:42:02 2026] A dracoliche has been slain by Vebn!')),
    'and the kill, landed by another player'
  )
  assert.equal(
    w70.filter((l) => l.includes("Togor's Insects spell has worn off")).length,
    0,
    'and not one wear-off line for the spell anywhere in the window — the silence is the evidence'
  )
  assert.equal(tsOf('[Sat Aug 15 22:42:02 2026] x') - tsOf('[Sat Aug 15 22:38:54 2026] x'), DRACOLICHE_BOUND_MS)
})

test('JOS-379 premise: the golem window IS a completed cycle — the channel exists', () => {
  const w69 = readFixture(W69)
  assert.ok(w69.some((l) => l.includes('[Fri Aug 14 21:03:39 2026] a rock golem yawns.')), 'the landing')
  assert.ok(
    w69.some((l) => l.includes("[Fri Aug 14 21:05:59 2026] Your Togor's Insects spell has worn off of a rock golem.")),
    'and the wear-off sentence that proves this spell announces its own end on a mob'
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE ORDINARY CYCLE IS UNTOUCHED. The first thing the change must not do is move a number
// that was already right.

test('JOS-379 (b): a clean golem cycle at 2:20 leaves the estimate at the 2:30 floor', () => {
  const est = togorEstimate(readFixture(W69))
  assert.equal(est.ms, DB_FLOOR_MS, 'the DB floor holds — a below-floor observation is not a shorter spell')
  assert.equal(est.source, 'db', 'and it says so: one cycle can never corroborate a JOS-212 cluster')
})

test('JOS-379: the golem cycle is counted as a CYCLE — n rises, and it is 2:20', () => {
  const { spellStats } = replayBuffTimers(readFixture(W69))
  const stat = spellStats.statFor(TOGOR, SELF_CASTER)
  assert.equal(stat?.n, 1, 'one land→fade pair')
  assert.equal(stat?.maxMs, 140_000, '21:03:39 → 21:05:59, exactly the 2:20 the owner measured')
})

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE TICKET. The acceptance case, end to end, through the real parser and the real modules.

test('JOS-379 (a): the dracoliche death lifts Togor’s Insects to >= 3:08, source deathBound', () => {
  const est = togorEstimate(readFixture(W70), readFixture(W69))
  assert.equal(est.ms, DRACOLICHE_BOUND_MS, 'landing 22:38:54 → corpse 22:42:02, and not a millisecond more')
  assert.equal(est.source, 'deathBound', 'labelled as a BOUND, never as an observation — it is a floor, not a duration')
  assert.ok(est.ms != null && est.ms > DB_FLOOR_MS, 'and it is strictly above the classic-era floor it replaces')
})

test('JOS-379 (a): the bound is not a cycle — n stays at the one real golem pair', () => {
  // The distribution columns are a report on what was OBSERVED. Nothing was observed ENDING here,
  // so a bound may not inflate the confidence hint or drag the median (buffsStats.ts statFor).
  const { spellStats } = replayBuffTimers(readFixture(W70), { prime: readFixture(W69) })
  const stat = spellStats.statFor(TOGOR, SELF_CASTER)
  assert.equal(stat?.n, 1, 'the golem cycle, and only the golem cycle')
  assert.equal(stat?.maxMs, 140_000, 'the bound is absent from max as well as from n')
  assert.equal(stat?.estimateMs, DRACOLICHE_BOUND_MS, 'while the ESTIMATE — where it belongs — carries it')
  assert.equal(stat?.estimatorSource, 'deathBound')
})

test('JOS-379 (a): the two mobs that died INSIDE the span taught nothing', () => {
  // `a nightmare` (landed 22:39:03, slain 22:39:23) and `a dracoliche pet` (landed 22:39:27, slain
  // 22:39:31) are in the same window, on the same line, with the same channel witnessed. Both spans
  // are far under the estimate, so both are refused — a bound below what the app already draws is
  // true and useless, and admitting one would put noise in the window for nothing.
  const est = togorEstimate(readFixture(W70), readFixture(W69))
  assert.equal(est.ms, DRACOLICHE_BOUND_MS, 'the longest bound is the only one that could have won')
  const { spellStats } = replayBuffTimers(readFixture(W70), { prime: readFixture(W69) })
  // One sample per admitted bound: the golem cycle plus exactly ONE bound, not three.
  assert.equal(spellStats.cleanWindowFor(TOGOR, SELF_CASTER).length, 1, 'the clean window still holds one cycle')
})

// ─────────────────────────────────────────────────────────────────────────────
// (d) THE WITNESSED-CHANNEL RULE. The same bytes, minus the proof that this spell ever speaks.

test('JOS-379 (d): with the wear-off channel never witnessed, the same death teaches nothing', () => {
  const est = togorEstimate(readFixture(W70))
  assert.equal(est.ms, DB_FLOOR_MS, 'the floor stands: silence is only evidence about a spell known to speak')
  assert.equal(est.source, 'db')
})

test('JOS-379 (d): and the ONE line that grants the channel is the target-named wear-off', () => {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  const stats = mod.spellStats()
  let seq = 0
  const feed = (ev: Omit<LogEvent, 'seq'>): void => {
    mod.onEvent({ ...ev, seq: seq++ } as LogEvent)
  }
  const t = tsOf('[Sat Aug 15 22:00:00 2026] x')
  // The TARGETLESS shapes: a self buff's wear-off and a pet's. Neither says anything about whether
  // a debuff on a MOB announces itself, which is the only question the bound ever asks.
  feed({ kind: 'buffFade', ts: t, raw: '[x] Your Togor’s Insects spell has worn off.', spell: "Togor's Insects" })
  assert.equal(stats.hasWearOffChannel(TOGOR), false, 'a self wear-off is a different channel')
  feed({ kind: 'buffFade', ts: t + 1_000, raw: '[x] …', spell: "Togor's Insects", target: 'pet' })
  assert.equal(stats.hasWearOffChannel(TOGOR), false, 'and so is the possessive pet form')
  feed({ kind: 'buffFade', ts: t + 2_000, raw: '[x] …', spell: "Togor's Insects", target: 'a rock golem' })
  assert.equal(stats.hasWearOffChannel(TOGOR), true, 'the target-NAMED sentence is the one that grants it')
})

// ─────────────────────────────────────────────────────────────────────────────
// (c) THE IDENTITY GUARD and the caps, on the rule itself. The owner's log holds no
// article-named mob that dies far enough past its landing to exercise the same-name cap (the
// longest is the dracoliche's own 3:08), so these drive `deathBoundSpan` directly with the
// numbers the rule is written in rather than inventing a log line the game never printed.

/** A learner that states one floor and one estimate, with the channel witnessed. */
function statsStub(estimateMs: number | null, dbMs: number | null = DB_FLOOR_MS, witnessed = true): DeathBoundStats {
  return {
    estimateFor: () => ({ ms: estimateMs }),
    dbDurationFor: () => dbMs,
    hasWearOffChannel: () => witnessed
  }
}

/**
 * One open debuff record holding `count` landings at ts 0 — a ROUND, which is the only shape that
 * produces a count above one (a later landing REFRESHES the hold it already has, buffRounds.ts).
 */
function record(count = 1): OpenCast {
  const group = new HoldGroup(false)
  for (let i = 0; i < count; i++) group.land(0)
  return { spell: "Togor's Insects", spellKey: TOGOR, entityKey: 'a rock golem', group, caster: SELF_CASTER, disp: 'hostile' }
}

test('JOS-379 (c): an article-named mob dying six minutes after ONE landing is refused', () => {
  const sixMinutes = 360_000
  assert.equal(
    deathBoundSpan(record(), 'a rock golem', sixMinutes, statsStub(DB_FLOOR_MS)),
    null,
    'a golem that dies at 4x the stated duration is far likelier to be a DIFFERENT golem'
  )
  assert.equal(
    deathBoundSpan(record(), 'cazic-thule', sixMinutes, statsStub(DB_FLOOR_MS)),
    sixMinutes,
    'the same span on a name the world hands out once is admitted — there is no twin to confuse it with'
  )
})

test('JOS-379 (c): the same-name cap is exactly 2x the estimate, and the article is what decides', () => {
  const cap = DEATH_BOUND_MAX_ESTIMATE_MULTIPLE * DB_FLOOR_MS
  assert.equal(deathBoundSpan(record(), 'a rock golem', cap, statsStub(DB_FLOOR_MS)), cap, 'at the cap: admitted')
  assert.equal(deathBoundSpan(record(), 'a rock golem', cap + 1, statsStub(DB_FLOOR_MS)), null, 'a millisecond past: refused')
  assert.equal(isArticleNamed('a dracoliche'), true)
  assert.equal(isArticleNamed('an elemental warrior'), true)
  assert.equal(isArticleNamed('the ghoul lord'), true)
  assert.equal(isArticleNamed('cazic-thule'), false, 'a proper name is an identity')
  assert.equal(isArticleNamed('dread'), false)
  assert.equal(isArticleNamed('amygdalan knight'), false, 'and so is an unarticled two-word one')
})

test('JOS-379 (c): no bound may ever exceed 3x what the spell database states', () => {
  const cap = DEATH_BOUND_MAX_DB_MULTIPLE * DB_FLOOR_MS
  assert.equal(deathBoundSpan(record(), 'cazic-thule', cap, statsStub(DB_FLOOR_MS)), cap, 'at the ceiling: admitted')
  assert.equal(
    deathBoundSpan(record(), 'cazic-thule', cap + 1, statsStub(DB_FLOOR_MS)),
    null,
    'past it, a missed wear-off is the likelier explanation and must not teach nonsense'
  )
})

test('JOS-379 (c): two landings of one name, a corpse that names neither — refused', () => {
  assert.equal(
    deathBoundSpan(record(2), 'a rock golem', 200_000, statsStub(DB_FLOOR_MS)),
    null,
    'a corpse says WHICH NAME died, never which mob of it — and a wear-off may already have closed the other'
  )
})

test('JOS-379 (c): the other refusals — no channel, no DB row, no gain, an offline gap', () => {
  const span = 200_000
  assert.equal(deathBoundSpan(record(), 'cazic-thule', span, statsStub(DB_FLOOR_MS, DB_FLOOR_MS, false)), null, 'channel')
  assert.equal(deathBoundSpan(record(), 'cazic-thule', span, statsStub(DB_FLOOR_MS, null)), null, 'no floor to cap against')
  assert.equal(deathBoundSpan(record(), 'cazic-thule', DB_FLOOR_MS, statsStub(DB_FLOOR_MS)), null, 'equal to the estimate teaches nothing')
  assert.equal(deathBoundSpan(record(), 'cazic-thule', span, statsStub(null)), null, 'a row counting UP has nothing to beat')
  const spanned = { ...record(), spannedGap: true }
  assert.equal(
    deathBoundSpan(spanned, 'cazic-thule', span, statsStub(DB_FLOOR_MS)),
    null,
    'across an absence the wear-off line could have printed to nobody — the silence stops being about the world'
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// (e) THE MEMORY. The anti-squatting cull (JOS-149/156) retires an overdue row while deliberately
// KEEPING the open record, and JOS-203 retires that record on the FLOOR's schedule — so the buffs
// half ALREADY remembers a landing whose bar is gone, and a death after the cull is still measured
// against it. No second memory map was needed; this pins that the inherited one is enough.
//
// The owner's own dracoliche never reached this state (the row was still standing at 22:42:02: the
// cull is estimate + 60 s = 22:42:24), which is why the timings here are driven rather than cut —
// a 4-minute raid mob, every line shape real.

test('JOS-379 (e): a death AFTER the bar was culled is still measured against the landing', () => {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  const stats = mod.spellStats()
  let seq = 0
  const feed = (ev: Omit<LogEvent, 'seq'>): void => {
    mod.onEvent({ ...ev, seq: seq++ } as LogEvent)
  }
  const T0 = tsOf('[Sat Aug 15 22:00:00 2026] x')
  // The channel, witnessed by a real earlier cycle's sentence.
  feed({ kind: 'buffFade', ts: T0, raw: '[x] …', spell: "Togor's Insects", target: 'a rock golem' })

  const SPELL = "Togor's Insects V"
  feed({ kind: 'castBegin', ts: T0 + 7_000, raw: `[x] You begin casting ${SPELL}.`, spell: SPELL })
  feed({
    kind: 'buffApply',
    ts: T0 + 10_000,
    raw: '[x] Cazic-Thule yawns.',
    spell: SPELL,
    target: 'Cazic-Thule',
    illusion: false,
    durationMs: DB_FLOOR_MS,
    candidates: [{ name: SPELL, durationMs: DB_FLOOR_MS, illusion: false }]
  })
  assert.ok(mod.snapshot().state.active.some((a) => a.target === 'Cazic-Thule'), 'the slow is on the board')

  // The heartbeat, past the DB floor plus its 60-second grace: the ROW goes, by owner ruling.
  mod.onTick(T0 + 10_000 + DB_FLOOR_MS + 61_000)
  assert.equal(
    mod.snapshot().state.active.some((a) => a.target === 'Cazic-Thule'),
    false,
    'the anti-squatting cull retired the bar — that ruling is untouched here'
  )

  feed({ kind: 'death', ts: T0 + 250_000, raw: '[x] Cazic-Thule has been slain by Vebn!', name: 'Cazic-Thule', bySelf: false, killer: 'Vebn' })
  const est = stats.estimateFor(TOGOR, SELF_CASTER)
  assert.equal(est.ms, 240_000, 'the span is measured from the LANDING the record still remembers, not from the cull')
  assert.equal(est.source, 'deathBound')
})

// ─────────────────────────────────────────────────────────────────────────────
// (f) THE LAWS THE CHANGE MUST NOT BEND.

test('JOS-379: a bound may never corroborate a JOS-212 below-floor cluster', () => {
  // Three agreeing clean cycles are the strongest statement this model makes about a duration, and
  // a bound is not a cycle. It is refused entry to the clean window, so it can neither build a
  // cluster nor break one — `cleanWindowFor` is the one seam and this reads it after a real fold.
  const { spellStats } = replayBuffTimers(readFixture(W70), { prime: readFixture(W69) })
  assert.deepEqual(
    spellStats.cleanWindowFor(TOGOR, SELF_CASTER),
    [140_000],
    'only the golem cycle is in the cluster’s pool'
  )
})

test('JOS-379: nothing about buffs on the PLAYER changes — a self buff has no death bound', () => {
  // The rule is gated on a DEBUFF instance bound to the entity that died. The owner's own death
  // strips self buffs through `onPlayerDeath`, which is a different path entirely and mints
  // nothing; this pins that the dracoliche window taught the learner about exactly one line.
  const { spellStats } = replayBuffTimers(readFixture(W70), { prime: readFixture(W69) })
  const learned = [...spellStats.everFaded].filter(
    (k) => spellStats.statFor(k, SELF_CASTER)?.estimatorSource === 'deathBound'
  )
  assert.deepEqual(learned, [TOGOR], 'one line learned a bound in that whole raid window, and it is the reported one')
})
