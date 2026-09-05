// WAITING OUT A CATCH-UP THAT TAKES AS LONG AS IT TAKES (JOS-518) — `src/main/dataServer/foldWait.ts`.
//
// THE DEFECT THIS SUITE IS THE MEMORY OF. `waitForFold` had a 120-second budget, and post-cutover
// that loop arms the entire read path: on expiry `engineLiveOn` was never set, `engineServeReadiness`
// answered `notLive` forever, every panel stayed empty, and — because nothing had moved the banner's
// phase off `folding` — the engine's LIVE TAIL frames kept feeding the bar, which then read 100%
// with the event count climbing for the rest of the session. Two 1.11.0 reports are that shape:
// "100% for over 5 minutes... still reading the log and the number of events is still going up
// (9,087,066 and rising)", and "Log keeps catching up even while in-game".
//
// THE OWNER'S RULING, which is what every case below asserts: *"it should only give up if the engine
// isn't doing anything or not present due to AV - in all cases but the most pathological, if its
// already parsing, why are we having a timeout?"*
//
// WHY THE LOOP IS DRIVABLE AT ALL. It takes its request, its turn, its sleep and its log sink as
// arguments — `readShim.ts`'s design, for `readShim.ts`'s reason: every interesting case here is a
// failure, and not one of them can be staged reliably against a real engine on a real socket. So
// there is no Electron, no socket and no Rust binary in this file.
//
// NOTHING HERE SLEEPS. `rest` resolves immediately and RECORDS what it was asked to wait, so a
// simulated half-hour of folding costs a millisecond and the pacing is still asserted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EngineError } from '../src/shared/dataServer/client'
import {
  FOLD_NARRATE_EVERY,
  FOLD_POLL_MS,
  FOLD_REFUSAL_LIMIT,
  FOLD_REFUSAL_PAUSE_MS,
  stillFolding,
  waitForFold,
  type FoldHealth,
  type FoldWaitDeps
} from '../src/main/dataServer/foldWait'

/** The budget that used to end this loop. It is gone; the number survives here as the thing every
 *  case below has to run past to mean anything. */
const OLD_BUDGET_MS = 120_000

/** How many polls the deleted budget would have allowed. */
const OLD_BUDGET_POLLS = OLD_BUDGET_MS / FOLD_POLL_MS

const GB = 1024 * 1024 * 1024

function folding(offset: number, events: number): FoldHealth {
  return { status: 'folding', epoch: 2, events, mark: { logPath: 'eqlog_Primitive_freeport.txt', offset } }
}

function live(offset: number, events: number): FoldHealth {
  return { ...folding(offset, events), status: 'live', logMtimeMs: 1_787_181_707_000 }
}

interface Rig {
  readonly deps: FoldWaitDeps
  /** Every health answer the loop was handed, in order. */
  readonly saw: FoldHealth[]
  readonly notes: string[]
  /** Every sleep the loop asked for, in ms. */
  readonly rests: number[]
  asks: number
}

/**
 * A rig around a scripted sequence of answers.
 *
 * `answers` is consulted by ASK NUMBER: an entry that is an error is thrown, anything else is
 * resolved. Past the end of the script the last entry repeats, which is what lets a case say "folds
 * forever" without writing a thousand entries.
 */
function rig(answers: (FoldHealth | Error)[], over?: Partial<FoldWaitDeps>): Rig {
  const saw: FoldHealth[] = []
  const notes: string[] = []
  const rests: number[] = []
  const r: Rig = {
    asks: 0,
    saw,
    notes,
    rests,
    deps: {
      ask: () => {
        const answer = answers[Math.min(r.asks, answers.length - 1)]
        r.asks += 1
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
      },
      mine: () => true,
      rest: (ms) => {
        rests.push(ms)
        return Promise.resolve()
      },
      saw: (health) => saw.push(health),
      note: (line) => notes.push(line),
      logSize: () => null,
      ...over
    }
  }
  return r
}

// ---- 1. a folding engine is never given up on ---------------------------------------------------

test('AN ENGINE STILL FOLDING WELL PAST THE OLD 120s BUDGET ARMS THE SERVE PATH WHEN IT LANDS', async () => {
  // 900 polls is six minutes at the loop's own cadence — three times the budget that used to end
  // this wait, and squarely inside the window the reporter was describing when they said "100% for
  // over 5 minutes".
  const polls = 900
  assert.ok(polls > OLD_BUDGET_POLLS, 'the case has to run PAST the thing it is about')
  const script: FoldHealth[] = []
  for (let i = 0; i < polls; i += 1) script.push(folding(i * 1024, i * 10))
  script.push(live(polls * 1024, polls * 10))

  const r = rig(script)
  const landed = await waitForFold(r.deps)

  assert.equal(landed?.status, 'live')
  assert.equal(r.asks, polls + 1, 'every poll up to the landing was made')
  // THE ARMING. `saw` is where `engineClientHost.ts` records `engineLiveOn` and resolves the banner,
  // and the point of this whole ticket is that it is reached at all.
  assert.equal(r.saw.length, polls + 1)
  assert.equal(r.saw[r.saw.length - 1]?.status, 'live')
  assert.equal(r.rests.every((ms) => ms === FOLD_POLL_MS), true, 'the ordinary beat is the poll')
})

test('a fold that never lands never stops being waited on, and never stops SAYING so', async () => {
  // The other half of the ruling, and the honest limit of it: this loop has no exit for "still
  // folding". What it owes the person waiting is narration, so the case runs a simulated half-hour
  // and counts the lines. `mine` going false is what ends it — a stand-in for the respawn or the
  // character switch that would end it in the field.
  const halfHourPolls = (30 * 60 * 1000) / FOLD_POLL_MS
  let asked = 0
  const r = rig([folding(4096, 40)], {
    mine: () => {
      asked += 1
      return asked < halfHourPolls
    }
  })

  assert.equal(await waitForFold(r.deps), null, 'a superseded turn says nothing')
  const narrations = r.notes.filter((line) => line.includes('still folding'))
  // One line per thirty seconds, give or take the turn it was cut off on.
  const expected = Math.floor(halfHourPolls / 2 / FOLD_NARRATE_EVERY)
  assert.ok(
    narrations.length >= expected - 1 && narrations.length <= expected + 1,
    `${String(narrations.length)} lines over half an hour, expected about ${String(expected)}`
  )
  assert.ok(narrations.length > 0, 'a long fold that says nothing is the defect this replaces')
})

test('a turn that has been superseded touches nothing', async () => {
  const r = rig([folding(1, 1)], { mine: () => false })
  assert.equal(await waitForFold(r.deps), null)
  assert.deepEqual(r.saw, [], 'a lost turn recorded a health answer')
})

// ---- 2. the exits that are real events ----------------------------------------------------------

test('A CONNECTION THAT DIES ENDS THE TURN, and does not hang', async () => {
  const dead = new EngineError('unavailable', 'there is no open connection')
  const r = rig([dead])

  assert.equal(await waitForFold(r.deps), null)
  assert.equal(r.asks, FOLD_REFUSAL_LIMIT, 'it asked its bounded few times and then stopped')
  assert.equal(r.saw.length, 0)
  assert.ok(
    r.notes.some((line) => line.includes('times running')),
    `the giving-up is unexplained: ${r.notes.join(' | ')}`
  )
  // The retries are SPACED, and by the refusal pause rather than the ordinary beat: a refusal is
  // not a measurement that came back uninteresting.
  assert.deepEqual(r.rests, [FOLD_REFUSAL_PAUSE_MS, FOLD_REFUSAL_PAUSE_MS])
})

test('A TRANSIENTLY REFUSED POLL RETRIES AND THEN ARMS', async () => {
  // The behaviour that used to be absent entirely: one refusal ended the wait, which stranded the
  // session exactly as permanently as the budget did. A refusal is the one failure here that is
  // routinely transient, because the client's own per-request deadline turns a slow answer into a
  // rejection.
  const refused = new EngineError('timeout', 'the engine did not answer session.health within 15000 ms')
  const r = rig([refused, refused, folding(2048, 20), live(4096, 40)])

  const landed = await waitForFold(r.deps)
  assert.equal(landed?.status, 'live')
  assert.equal(r.saw.length, 2, 'both answered polls were passed on')
  assert.deepEqual(r.rests, [FOLD_REFUSAL_PAUSE_MS, FOLD_REFUSAL_PAUSE_MS, FOLD_POLL_MS])
})

test('the refusal count is CONSECUTIVE, not cumulative', async () => {
  // An engine that refused once at minute three and has answered every poll since is not the
  // wedged-alive pathology, and a cumulative count would eventually strand every long session.
  const refused = new EngineError('timeout', 'nobody answered')
  const script: (FoldHealth | Error)[] = []
  for (let i = 0; i < 20; i += 1) {
    script.push(refused, refused, folding(i * 4096, i * 40))
  }
  script.push(live(99_999, 9_087_066))

  const r = rig(script)
  assert.equal((await waitForFold(r.deps))?.status, 'live')
  assert.equal(r.saw.length, 21, 'twenty folding answers and the landing')
})

test('a turn superseded WHILE a poll was in flight says nothing about the answer', async () => {
  // The rule every `await` in `engineClientHost.ts` is followed by, asserted at the two suspension
  // points this loop has. A refusal that arrives after the world was replaced must not spend one of
  // the three retries either.
  let live = true
  const r = rig([folding(1, 1)], {
    ask: () => {
      live = false
      return Promise.resolve(folding(1, 1))
    },
    mine: () => live
  })
  assert.equal(await waitForFold(r.deps), null)
  assert.deepEqual(r.saw, [])
})

// ---- 3. the sentence a long fold explains itself with --------------------------------------------

test('THE NARRATION SAYS WHERE THE FOLD IS, in the units a person waits in', () => {
  const line = stillFolding(folding(3.2 * GB, 9_087_066), 9.1 * GB)
  assert.match(line, /still folding/)
  assert.match(line, /3\.2 GB of 9\.1 GB/)
  assert.match(line, /9,087,066 events/)
})

test('it DEGRADES rather than guessing', () => {
  // World-model law 1, one layer up: each clause is omitted where there is nothing true to put in
  // it, and the sentence still says the one thing that matters.
  assert.match(stillFolding({ status: 'folding', epoch: 2 }, null), /nothing folded yet/)
  assert.doesNotMatch(stillFolding({ status: 'folding', epoch: 2 }, null), /events/)
  // A mark with no denominator yet: the offset alone, never a percentage invented from nothing.
  const noSize = stillFolding(folding(512 * 1024, 500), null)
  assert.match(noSize, /512\.0 KB/)
  assert.doesNotMatch(noSize, / of /)
})

test('a denominator the fold has already passed never reads backwards', () => {
  // `logSize` GROWS while a fold runs (EverQuest is still appending) and the two facts come off
  // different round trips, so the mark can legitimately be ahead of the last size the engine stated.
  // `x of y` where y < x would read as a bar past its own end.
  assert.match(stillFolding(folding(900, 9), 400), /900 B of 900 B/)
})
