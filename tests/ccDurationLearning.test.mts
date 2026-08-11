// THE MEZ THAT OUTLIVED ITS OWN BAR (JOS-180) — pinned to the owner's real bytes.
//
// THE DEFECT, in one sentence: a crowd-control duration could only ever be learned through a LIVE
// hold, and the hold was culled at estimate + grace — so the moment break-shortened cycles dragged
// the learned number below the true duration, every full-length mez was culled before its wear-off
// arrived and the number could never climb back out.
//
// The window is `tests/fixtures/w63-dazzle-break-vs-full.log`, cut by
// `npm run fixtures:cc-duration` from Sun Aug 09 2026 22:40:58–22:55:43 (Plane of Fear, solo
// instance). It carries six Dazzle IV cycles that reach the learner: FIVE the player's own damage
// ended early — each followed in the same second by `<mob> has been awakened by Primitive.` — and
// ONE, on a turmoil toad, that ran its natural course at 136 s. That toad cycle is the first
// witnessed full-duration Dazzle in a 1.5M-line log, and before this ticket the app destroyed it.
//
// Nothing below is authored. Every number is read off the fixture and every assertion runs the real
// parser through the real BuffsModule + BuffTimersModule and out through the real projection.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffTimers, tsOf } from './harness.mts'
import { parseEvent } from '../src/main/log/parser.ts'
import { SpellStats } from '../src/main/modules/buffsStats.ts'
import { RECENT_SAMPLE_WINDOW } from '../src/main/modules/buffsShapes.ts'
import { learnKey, SELF_CASTER } from '../src/shared/buffTrust.ts'

const W63 = readFixture('w63-dazzle-break-vs-full.log')

/** An instant inside the fixture's evening, as ms. */
const at = (hhmmss: string): number => tsOf(`[Sun Aug 09 ${hhmmss} 2026] You have entered Nowhere.`)

const DAZZLE = 'dazzle'
/** Dazzle's committed spells.json row — the base rank's, and the FLOOR the learner extends. */
const DAZZLE_DB_MS = 96_000
/** The toad: mezzed 22:45:14, wore off naturally 22:47:30. */
const TOAD_MS = 136_000
/** The nightmare: mezzed 22:41:25, broken by the player 22:43:05. */
const NIGHTMARE_MS = 100_000

function samplesOf(stats: SpellStats, key = DAZZLE): { ms: number; censored?: boolean }[] {
  return stats.samples.get(learnKey(key, SELF_CASTER))?.samples ?? []
}

// ---------------------------------------------------------------------------------------------
// THE TRAP, REPRODUCED. The first break beats the DB floor, which is what makes the grace shrink.
// ---------------------------------------------------------------------------------------------

test('a BROKEN cycle still teaches a lower bound — the nightmare`s 100 s beats Dazzle`s 96 s DB floor', () => {
  const { buffs } = replayBuffTimers(W63, { until: at('22:44:00') })
  const stat = buffs.stats[DAZZLE]
  assert.ok(stat, 'the Buffs tab knows about Dazzle by now')
  assert.equal(stat.dbDurationMs, DAZZLE_DB_MS, 'the committed row is the base rank`s 96 s')
  assert.equal(stat.n, 1, 'one cycle has closed: the nightmare')
  assert.equal(stat.estimateMs, NIGHTMARE_MS, 'a break is a lower bound and the MAX takes it')
  assert.equal(stat.estimatorSource, 'observed', 'which is what drops the unwitnessed grace to 15 s')
})

// ---------------------------------------------------------------------------------------------
// THE ROW CULL IS LAW AND IS PINNED UNCHANGED (JOS-149/156, the owner's anti-squatting ruling).
// JOS-180 does not lengthen a row's life by one millisecond; it only remembers what was on it.
// ---------------------------------------------------------------------------------------------

test('the toad`s row still dies at estimate + 15 s — the anti-squatting cull is untouched', () => {
  // 22:45:14 + 100 s + 15 s = 22:47:09. Observed at 22:47:20, on the heartbeat, the row is gone —
  // twenty-one seconds before its real wear-off line arrives.
  const { timers, rows } = replayBuffTimers(W63, { until: at('22:47:20'), tickMs: at('22:47:20') })
  assert.equal(
    timers.holds.filter((h) => h.target === 'a turmoil toad').length,
    0,
    'culled on schedule — nothing squats at 0s'
  )
  assert.equal(rows.filter((r) => r.target === 'a turmoil toad').length, 0, 'and nothing is drawn for it')
})

test('…and the late join never puts the row back — a memory is not a hold', () => {
  const { timers, rows } = replayBuffTimers(W63, { until: at('22:47:35'), ticks: [at('22:47:15')] })
  assert.equal(
    timers.holds.filter((h) => h.target === 'a turmoil toad').length,
    0,
    'the wear-off minted a sample; it did not resurrect a bar'
  )
  assert.equal(rows.filter((r) => r.target === 'a turmoil toad').length, 0)
})

// ---------------------------------------------------------------------------------------------
// THE LATE JOIN. The wear-off arrives 21 s after the cull and is measured anyway — through the
// same cleanliness rules, against the landing the module still remembers.
// ---------------------------------------------------------------------------------------------

test('the toad`s natural wear-off mints 136 s DESPITE the cull that took its row', () => {
  // The heartbeat culls the hold at 22:47:15, strictly BEFORE the 22:47:30 wear-off event — so the
  // cull and the mint are two separate moments, exactly as they are in the running app.
  const { buffs, spellStats } = replayBuffTimers(W63, { until: at('22:48:00'), ticks: [at('22:47:15')] })
  const spans = samplesOf(spellStats).map((s) => s.ms)
  assert.deepEqual(spans, [NIGHTMARE_MS, TOAD_MS], 'the broken 100 s, then the full 136 s')

  const stat = buffs.stats[DAZZLE]
  assert.ok(stat)
  assert.equal(stat.maxMs, TOAD_MS)
  assert.equal(stat.estimateMs, TOAD_MS, 'the estimate finally covers the real duration')
  assert.equal(stat.estimatorSource, 'observed')
})

test('the CcEnd the projection reads is unchanged — a late join records the same break it always did', () => {
  const { timers } = replayBuffTimers(W63, { until: at('22:48:00'), ticks: [at('22:47:15')] })
  const toad = timers.ends.filter((e) => e.key === 'a turmoil toad')
  assert.equal(toad.length, 1, 'exactly one end, named, as before JOS-180')
  assert.equal(toad[0].spell, 'Dazzle')
  assert.equal(toad[0].ts, at('22:47:30'))
})

// ---------------------------------------------------------------------------------------------
// THE ACCEPTANCE. The evening's five broken cycles plus the toad's full one, replayed whole.
// ---------------------------------------------------------------------------------------------

test('the evening`s five break samples plus the toad cycle yield an estimate covering 136 s', () => {
  const { buffs, spellStats } = replayBuffTimers(W63, { ticks: [at('22:47:15')] })
  const spans = samplesOf(spellStats).map((s) => s.ms)
  assert.deepEqual(
    spans,
    [NIGHTMARE_MS, TOAD_MS, 11_000, 74_000, 91_000, 27_000],
    'nightmare, turmoil toad, shiverback, phoboplasm, boogeyman, fetid fiend — read off the log'
  )
  const stat = buffs.stats[DAZZLE]
  assert.ok(stat)
  assert.equal(stat.n, 6)
  assert.equal(stat.estimateMs, TOAD_MS, 'the four breaks AFTER the toad do not drag it back down')
  assert.ok(stat.medianMs != null && stat.medianMs < TOAD_MS, 'a central statistic never would have — median 82.5 s')
})

test('the wake line marks the five broken cycles and leaves the toad`s alone', () => {
  const { spellStats } = replayBuffTimers(W63, { ticks: [at('22:47:15')] })
  const flags = samplesOf(spellStats).map((s) => s.censored === true)
  assert.deepEqual(
    flags,
    [true, false, true, true, true, true],
    'every cycle followed by `has been awakened by` is censored; the toad`s, which was not, is clean'
  )
})

test('a charm break carries no wake line, so charm cycles are learned uncensored', () => {
  // The same window holds two Allure VI charms that ended by their own `worn off of` line with no
  // wake beside them (22:54:17 and 22:55:23). Nothing about the CC censor may touch them.
  const { spellStats } = replayBuffTimers(W63, { ticks: [at('22:47:15')] })
  const allure = samplesOf(spellStats, 'allure')
  assert.equal(allure.length, 2, 'two charm cycles closed in the window')
  assert.deepEqual(allure.map((s) => s.censored === true), [false, false])
})

// ---------------------------------------------------------------------------------------------
// THE WAKE LINE IS AN ANNOTATION AND NOT AN ENDING. It is its own event kind, it is NOT a `cc`,
// and JOS-161's per-song break alerts (which fire on `cc {refresh:true}`) see exactly what they saw.
// ---------------------------------------------------------------------------------------------

test('`has been awakened by` parses as ccWake and never as a cc — the break alerts are untouched', () => {
  const wake = parseEvent('[Sun Aug 09 22:43:05 2026] A nightmare has been awakened by Primitive.', 1)
  assert.equal(wake?.kind, 'ccWake', 'its own kind — it used to be `unknown`')
  assert.ok(wake && 'mob' in wake && wake.mob === 'A nightmare')
  assert.ok(wake && 'by' in wake && wake.by === 'Primitive')

  const worn = parseEvent('[Sun Aug 09 22:43:05 2026] Your Dazzle spell has worn off of a nightmare.', 2)
  assert.equal(worn?.kind, 'cc', 'the wear-off is still the cc refresh JOS-161`s `breaks` template fires on')
  assert.ok(worn && 'refresh' in worn && worn.refresh === true)
  assert.ok(worn && 'spell' in worn && worn.spell === 'Dazzle')
})

test('the wake closes nothing — one break line, one end, however many wakes follow it', () => {
  const { timers } = replayBuffTimers(W63, { until: at('22:43:10') })
  const nightmare = timers.ends.filter((e) => e.key === 'a nightmare')
  assert.equal(nightmare.length, 1, 'the wear-off recorded one end; the wake recorded none')
})

// ---------------------------------------------------------------------------------------------
// THE SPLIT WINDOW, stated directly against the learner. The fixture proves the estimate reaches
// 136 s; these prove it STAYS there for the reason JOS-180 says it does, and that the property the
// window exists for — a real decrease recovering — is not the price.
// ---------------------------------------------------------------------------------------------

/** The evening's shape, then N more broken cycles: does the full-length reading survive? */
function afterMoreBreaks(n: number): number | null {
  const stats = new SpellStats()
  let ts = 0
  const push = (ms: number, censored: boolean): void => {
    ts += 60_000
    stats.pushSample(DAZZLE, SELF_CASTER, 'Dazzle IV', { ms, ts })
    if (censored) stats.censorSampleAt(DAZZLE, SELF_CASTER, ts)
  }
  push(NIGHTMARE_MS, true)
  push(TOAD_MS, false)
  for (let i = 0; i < n; i++) push(11_000 + i * 1_000, true)
  return stats.estimateFor(DAZZLE).ms
}

test('broken cycles never evict the full-length one, however many of them arrive', () => {
  for (const n of [1, RECENT_SAMPLE_WINDOW, RECENT_SAMPLE_WINDOW * 4]) {
    assert.equal(afterMoreBreaks(n), TOAD_MS, `${n} further breaks and the 136 s reading still stands`)
  }
})

test('…but five UNCENSORED shorter cycles still retire it — a real decrease recovers as before', () => {
  const stats = new SpellStats()
  let ts = 0
  const push = (ms: number, censored: boolean): void => {
    ts += 60_000
    stats.pushSample(DAZZLE, SELF_CASTER, 'Dazzle IV', { ms, ts })
    if (censored) stats.censorSampleAt(DAZZLE, SELF_CASTER, ts)
  }
  push(TOAD_MS, false)
  assert.equal(stats.estimateFor(DAZZLE).ms, TOAD_MS)
  // Five full cycles that genuinely ran short — a focus removed, a rank lost. THIS is evidence of a
  // decrease, and it ages the long reading out exactly as it always did.
  for (let i = 0; i < RECENT_SAMPLE_WINDOW; i++) push(60_000, false)
  assert.equal(stats.estimateFor(DAZZLE).ms, 60_000, 'the 136 s has left the uncensored window')
})

test('the distribution columns still report every cycle — only the ESTIMATE reads the censoring', () => {
  const { buffs } = replayBuffTimers(W63, { ticks: [at('22:47:15')] })
  const stat = buffs.stats[DAZZLE]
  assert.ok(stat)
  assert.equal(stat.n, 6, 'six closed cycles, broken or not')
  assert.equal(stat.minMs, 11_000, 'including the 11 s shiverback a nuke ended immediately')
  assert.equal(stat.maxMs, TOAD_MS)
})
