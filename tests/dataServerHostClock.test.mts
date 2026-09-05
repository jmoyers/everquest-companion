// THE HOST'S OWN ZONE, ON THE ATTACH (JOS-536).
//
// Three 1.15.0 reports said the Combat tab was useless under Wine: every fight one second long,
// dozens of encounters a minute. All three perf blocks showed the engine "behind" the log by an
// exact whole number of hours. The engine's zone probe is a WinRT call Wine does not implement, so
// it errored and every stamp parsed as UTC — and the app has always known the right answer, because
// V8 resolves the zone through ICU, which works there.
//
// THIS FILE PINS THE HALF THE APP OWNS: the two facts it states about its own clock, and the shape
// of the absence when it can only state one. The engine's ranking of them is `eqlog`'s own suite;
// what matters here is that a throwing `Intl` produces a hint with an OFFSET rather than no hint at
// all, because the offset alone is what the engine's third rung is for.

import test from 'node:test'
import assert from 'node:assert/strict'
import { hostClockHint } from '../src/main/dataServer/hostClock'

/** A September instant, when Los Angeles is on PDT. */
const SEPTEMBER = new Date('2026-09-03T18:52:00-07:00')

/** A `Date` whose zone is stated rather than inherited from the machine this suite runs on. */
function at(offsetMin: number): Date {
  return Object.assign(new Date(SEPTEMBER), { getTimezoneOffset: () => -offsetMin })
}

test('the hint carries the host name and minutes EAST of UTC', () => {
  // `Date.getTimezoneOffset()` counts the other way — 420 for Los Angeles — and the wire counts
  // east, so the sign flip happens here and nowhere else.
  assert.deepEqual(hostClockHint(at(-420), () => 'America/Los_Angeles'), {
    tz: 'America/Los_Angeles',
    utcOffsetMin: -420
  })
})

test('an east-of-UTC host states a positive offset', () => {
  assert.deepEqual(hostClockHint(at(120), () => 'Europe/Berlin'), {
    tz: 'Europe/Berlin',
    utcOffsetMin: 120
  })
})

test('a host that cannot name a zone still states its offset', () => {
  // THE WINE SHAPE. `tz` is omitted rather than sent empty: an absent name is what tells the engine
  // to fall through to the offset, and `""` would be a name it would try to parse and reject.
  const throwing = (): string => {
    throw new Error('no ICU data')
  }
  assert.deepEqual(hostClockHint(at(-420), throwing), { utcOffsetMin: -420 })
  assert.deepEqual(hostClockHint(at(-420), () => undefined), { utcOffsetMin: -420 })
  assert.deepEqual(hostClockHint(at(-420), () => ''), { utcOffsetMin: -420 })
})

test('UTC is a real answer and not an absent one', () => {
  assert.deepEqual(hostClockHint(at(0), () => 'UTC'), { tz: 'UTC', utcOffsetMin: 0 })
})
