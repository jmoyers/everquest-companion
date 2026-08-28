// THE LAUNCH BANNER'S ARITHMETIC AND ITS PROSE (JOS-503) — `src/shared/engineLaunch.ts`.
//
// WHAT THIS SUITE IS FOR. Two things a component must not be trusted with, hoisted into a pure
// module so they can be driven directly:
//
//   1. THE ESTIMATE. An ETA is the only thing on the banner that is not a measurement, so the
//      interesting assertions are all about REFUSING to give one — too few samples, too short a
//      span, a rate that has not moved, a mark that went backwards because a new fold started.
//      Every one of those is a real frame sequence and every one of them would, if it produced a
//      number, put an authoritative countdown in front of a user that was invented.
//   2. THE WORDS. Every failure class is read here, so a class that ships with an empty sentence
//      fails the build rather than reaching somebody's screen as a blank card. `engine-absent.
//      e2e.mts` asserts the SAME strings from the DOM, which is what stops the spec and the product
//      agreeing about different sentences.
//
// NOTHING HERE READS A CLOCK. `FoldSay.at` is passed in, so every case below is integer arithmetic
// with nothing sleeping in it — the same discipline `views::Timeline` keeps engine-side.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../scripts/protocolSchema.mjs'
import {
  FOLD_RATE_SAMPLES,
  NEW_FOLD_RING,
  NO_ENGINE_CONSEQUENCE,
  failureWords,
  foldFrameCounts,
  foldRate,
  foldReadout,
  humanBytes,
  humanDuration,
  pushFold,
  reportPrefill,
  type EngineFaultKind,
  type EngineFaultSay,
  type EngineLaunchPhase,
  type FoldRing,
  type FoldSay
} from '../src/shared/engineLaunch'

const MB = 1024 * 1024

/** A fold walking forward at a stated rate, sampled at the engine's own ~4 Hz cadence. */
function walk(opts: { from?: number; total: number; bytesPerSecond: number; frames: number }): FoldRing {
  let ring = NEW_FOLD_RING
  let bytes = opts.from ?? 0
  let at = 1_000_000
  for (let i = 0; i < opts.frames; i += 1) {
    ring = pushFold(ring, sample(bytes, opts.total, at))
    bytes += opts.bytesPerSecond / 4
    at += 250
  }
  return ring
}

function sample(bytes: number, totalBytes: number, at: number): FoldSay {
  return { pct: (bytes / totalBytes) * 100, offset: bytes, logSize: totalBytes, events: bytes, at }
}

// ---- 1. the estimate exists only when it is earned ------------------------------------------

test('ONE SAMPLE IS A MEASUREMENT AND NOT A RATE — percentage and bytes, no countdown', () => {
  const ring = pushFold(NEW_FOLD_RING, sample(50 * MB, 200 * MB, 1_000_000))
  const readout = foldReadout(ring)
  assert.ok(readout)
  assert.equal(readout.pctText, '25%')
  assert.equal(readout.bytesText, '50.0 MB of 200.0 MB')
  assert.equal(readout.etaText, null, 'a countdown from one sample would be invented')
  assert.equal(foldRate(ring), null)
})

test('A SPAN TOO SHORT TO MEASURE OVER GIVES NO ESTIMATE', () => {
  // Two frames 250 ms apart. A rate taken over that is mostly measurement noise, and the ETA it
  // produces swings by minutes between frames — which reads as a broken app rather than a busy one.
  const ring = walk({ total: 200 * MB, bytesPerSecond: 4 * MB, frames: 2 })
  assert.equal(foldRate(ring), null)
  assert.equal(foldReadout(ring)?.etaText, null)
})

test('A STALLED FOLD GIVES NO ESTIMATE RATHER THAN AN INFINITE ONE', () => {
  let ring = NEW_FOLD_RING
  for (let i = 0; i < 8; i += 1) ring = pushFold(ring, sample(10 * MB, 200 * MB, 1_000_000 + i * 250))
  assert.equal(foldRate(ring), null, 'nothing moved, so there is no rate — not a rate of zero')
  assert.equal(foldReadout(ring)?.etaText, null)
})

test('A STEADY FOLD ESTIMATES, AND THE ARITHMETIC IS THE OBVIOUS ONE', () => {
  // 8 MB/s, 100 MB read of 200 MB: 100 MB left is about 12 seconds.
  const ring = walk({ total: 200 * MB, bytesPerSecond: 8 * MB, frames: 8 })
  const readout = foldReadout(ring)
  assert.ok(readout)
  assert.match(readout.etaText ?? '', /^about \d+s left$/)
  const rate = foldRate(ring)
  assert.ok(rate !== null && Math.abs(rate - 8 * MB / 1000) < 1)
})

test('A MARK THAT WENT BACKWARDS STARTS A NEW RING — a character switch, not a negative rate', () => {
  // THE REAL SEQUENCE: a fold reaches 180 MB, the user switches character, the engine re-attaches
  // and the next frame reports 2 MB of a different file. Averaging across that boundary would
  // produce a negative rate and an ETA in the past.
  const done = walk({ total: 200 * MB, bytesPerSecond: 8 * MB, frames: 8 })
  const fresh = pushFold(done, sample(2 * MB, 90 * MB, 1_100_000))
  assert.equal(foldRate(fresh), null, 'the new fold has one sample, so it has no rate yet')
  const readout = foldReadout(fresh)
  assert.equal(readout?.bytesText, '2.0 MB of 90.0 MB', 'and it draws the NEW file, not the old one')
  assert.equal(readout?.etaText, null)
})

test('THE RING IS BOUNDED, so an eight-hour fold does not accumulate an eight-hour array', () => {
  const ring = walk({ total: 4096 * MB, bytesPerSecond: 8 * MB, frames: FOLD_RATE_SAMPLES * 5 })
  assert.equal(ring.samples.length, FOLD_RATE_SAMPLES)
})

test('A DENOMINATOR THAT GREW IS BELIEVED — EverQuest is still writing the file', () => {
  // The engine's own rule (`ingest::mark`): the denominator is the larger of the size at open and
  // the bytes actually read. It can therefore go UP between frames, and the readout must re-read it
  // rather than cache the first one it saw.
  let ring = pushFold(NEW_FOLD_RING, sample(10 * MB, 100 * MB, 1_000_000))
  ring = pushFold(ring, sample(20 * MB, 140 * MB, 1_004_000))
  assert.equal(foldReadout(ring)?.bytesText, '20.0 MB of 140.0 MB')
})

test('A PCT PAST ITS CEILING IS CLAMPED FOR THE BAR — a bar cannot be 104% wide', () => {
  const ring = pushFold(NEW_FOLD_RING, { pct: 104.2, offset: 5, logSize: 4, events: 9, at: 1 })
  assert.equal(foldReadout(ring)?.pct, 100)
  assert.equal(foldReadout(ring)?.pctText, '100%')
  // …and the bytes line never claims a total smaller than what has been read.
  assert.equal(foldReadout(ring)?.bytesText, '5 B of 5 B')
})

test('AN EMPTY RING DRAWS NOTHING AT ALL', () => {
  assert.equal(foldReadout(NEW_FOLD_RING), null)
})

// ---- 2. formatting, en-US and fixed (owner ruling 25) ---------------------------------------

test('bytes read the way a file manager reads them', () => {
  assert.equal(humanBytes(0), '0 B')
  assert.equal(humanBytes(999), '999 B')
  assert.equal(humanBytes(1024), '1.0 KB')
  assert.equal(humanBytes(209 * MB), '209.0 MB')
  assert.equal(humanBytes(3 * 1024 * MB), '3.0 GB')
  // A nonsense input is answered rather than propagated: this string is on a person's screen.
  assert.equal(humanBytes(-1), '0 B')
  assert.equal(humanBytes(Number.NaN), '0 B')
})

test('a duration says what an ESTIMATE can honestly claim, and no more', () => {
  assert.equal(humanDuration(1), '1s', 'never zero seconds — that would read as finished')
  assert.equal(humanDuration(41_000), '41s')
  assert.equal(humanDuration(163_000), '3m', 'not 2m 43s: the extrapolation has no such precision')
  assert.equal(humanDuration(4_800_000), '1h 20m')
})

// ---- 3. the words a person actually reads ----------------------------------------------------

const EVERY_KIND: readonly EngineFaultKind[] = [
  'no-binary',
  'spawn-failed',
  'announce-timeout',
  'bad-announce',
  'unhealthy',
  'exited'
]

function fault(kind: EngineFaultKind, attempts = 3): EngineFaultSay {
  return { kind, attempts, lookedIn: [], detail: null }
}

test('EVERY FAILURE CLASS HAS WORDS — a new one cannot ship as a blank card', () => {
  for (const kind of EVERY_KIND) {
    const words = failureWords(fault(kind))
    assert.ok(words.headline.length > 10, `${kind} has no headline`)
    assert.ok(words.body.length > 20, `${kind} has no body`)
    // AND THEY ARE PLAIN. The word "engine" is ours; a user's word for it is the thing that reads
    // their log, so every class says that somewhere rather than assuming the jargon.
    assert.match(`${words.headline} ${words.body}`, /log file|data engine/i, `${kind} speaks jargon`)
  }
})

test('THE QUARANTINE REMEDY IS ON THE TWO CLASSES IT EXPLAINS, AND NOT THE OTHERS', () => {
  // A missing file and a refused launch are what antivirus quarantine looks like from inside the
  // app. An engine that started and then went quiet was NOT quarantined, and suggesting it would
  // send somebody hunting through a quarantine list with nothing in it.
  for (const kind of ['no-binary', 'spawn-failed', 'announce-timeout'] as const) {
    assert.match(failureWords(fault(kind)).remedy ?? '', /antivirus/i, `${kind} should suggest it`)
  }
  for (const kind of ['unhealthy', 'exited'] as const) {
    assert.equal(failureWords(fault(kind)).remedy, null, `${kind} has nothing honest to suggest`)
  }
  assert.match(failureWords(fault('bad-announce')).remedy ?? '', /[Rr]einstall/)
})

test('THE CARD NEVER LIES ABOUT DEGRADED FUNCTION', () => {
  // Post-cutover there is no second fold to fall back to, so "some features are unavailable" would
  // be describing a product that does not exist. The sentence has to say there is no data at all.
  assert.match(NO_ENGINE_CONSEQUENCE, /cannot read your log at all/)
  assert.match(NO_ENGINE_CONSEQUENCE, /every panel will stay empty/)
})

test('the attempt count is only spoken when there is more than one', () => {
  assert.doesNotMatch(failureWords(fault('exited', 1)).body, /tried/)
  assert.match(failureWords(fault('exited', 4)).body, /tried 4 times/)
  // An absence attempted nothing, so it must never grow a count at all.
  assert.doesNotMatch(failureWords(fault('no-binary', 0)).body, /tried/)
})

test('THE REPORT PREFILL CARRIES THE CLASS AND NOTHING ELSE', () => {
  // PRE-TAGGED SO TRIAGE CAN FIND THEM: the feedback contract has one categorisation field
  // (`type: 'feature' | 'bug'`), so the class rides in the description as a greppable marker.
  assert.match(reportPrefill(fault('unhealthy')), /^engine-fault: unhealthy/)
  // AND THE PATHS DO NOT. They carry the user's own home directory; they are drawn on the card
  // where a person can read them, and the telemetry bright line says the app does not seed them
  // into something that will be transmitted.
  const withPaths: EngineFaultSay = {
    kind: 'no-binary',
    attempts: 0,
    lookedIn: ['C:/Users/somebody/app/engine/target/debug/engined.exe'],
    detail: null
  }
  assert.doesNotMatch(reportPrefill(withPaths), /somebody/)
  assert.doesNotMatch(reportPrefill(withPaths), /engined\.exe/)
})

// ---- 3. which frames the banner is allowed to count (JOS-518) --------------------------------
//
// THE DEFECT THIS IS THE MEMORY OF. The engine's LIVE TAIL emits the same progress shape as its
// historical scan, and until this ticket the only thing separating them was this process's own
// PHASE. That was a single defence over a genuine ambiguity, and it failed the way single defences
// do: the fold wait expired at its 120-second budget, nothing ever moved the phase off `folding`,
// and the tail's frames then held the bar at 100% with the count climbing for the rest of the
// session — "9,087,066 and rising", in the reporter's words.

test('A FRAME THE TAIL FLAGGED IS NEVER COUNTED, WHATEVER THE PHASE', () => {
  const phases: EngineLaunchPhase[] = ['starting', 'folding', 'live', 'absent', 'failed']
  for (const phase of phases) {
    assert.equal(foldFrameCounts(phase, true), false, `a live-tail frame was counted in ${phase}`)
  }
})

test('a scan frame counts in the one phase the bar is on screen for, and nowhere else', () => {
  // Absent IS the scan's answer on this wire — the field is present only when true — so both
  // spellings of "not the tail" are read here.
  for (const live of [undefined, false]) {
    assert.equal(foldFrameCounts('folding', live), true)
    for (const phase of ['starting', 'live', 'absent', 'failed'] as EngineLaunchPhase[]) {
      assert.equal(foldFrameCounts(phase, live), false, `counted in phase ${phase}`)
    }
  }
})

test('`noteFoldProgress` ASKS THAT QUESTION rather than spelling its own', () => {
  // The predicate is only worth testing if the one caller in the product goes through it — and that
  // caller cannot be imported here at all (`engineLaunchState.ts` reaches `windows.ts`, which
  // imports Electron), so the seam is asserted over the source. Same instrument
  // `serveDeltaArm.test.mts` uses on `engineClientHost.ts`, for the same reason.
  const state = readFileSync(join(ROOT, 'src', 'main', 'dataServer', 'engineLaunchState.ts'), 'utf8')
  assert.match(state, /if \(!foldFrameCounts\(say\.phase, progress\.live\)\) return/)
  assert.doesNotMatch(
    state,
    /if \(say\.phase !== 'folding'\) return[\s\S]{0,40}const fold: FoldSay/,
    'the phase-only test came back — it is the defence that failed'
  )
})
