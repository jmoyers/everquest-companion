// THIS WEEK'S LOCKOUTS (JOS-74) — the lockout window's arithmetic, and a golden over real kill
// history straddling a Tuesday reset.
//
// WHAT IS BEING PINNED. A raid boss's weekly LOOT lockout is per boss per difficulty and resets
// on a Pacific wall clock (the sources are cited in the header of
// src/renderer/src/features/bosses/lockout.ts, along with which of the two constants is
// double-sourced and which still wants verifying in game). Nothing about it is parsed: the app
// already records, per mob and per instance tier, when your most recent CREDITED kill landed, so
// "locked this week" is a comparison and the only hard part is the boundary.
//
// THE BOUNDARY IS THE SUBJECT. It is a PACIFIC WALL-CLOCK instant, so it is 15:00 UTC for half
// the year and 16:00 UTC for the other half, and a user in Tokyo must get the same two instants a
// user in Denver does. Hence: DST in both directions, the exact-boundary kill, a week over a
// month/year edge, and the same `now` recomputed under five machine timezones.
//
// THIS FILE PINS THE PROCESS TIMEZONE (below) because the second half replays REAL log lines, and
// an EQ timestamp parses to a LOCAL epoch (`parseEqTimestamp`) — so "Tue Aug 04 22:55:08" is a
// different instant on a machine in Tokyo, and the golden would be asserting the test machine's
// zone rather than the app's arithmetic. node:test runs each file in its own process, so the pin
// is this file's alone.
//
// Run: `npm test`.

process.env.TZ = 'America/Los_Angeles'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent, parseEqTimestamp } from '../src/main/log/parser'
import { KillsModule } from '../src/main/modules/kills'
import { allStatuses, type TargetStatus } from '../src/renderer/src/features/bosses/bossStatus'
import {
  DIFFICULTY_TIERS,
  LOCKOUT_RESET_HOUR,
  LOCKOUT_RESET_WEEKDAY,
  LOCKOUT_TIMEZONE,
  lockoutWindow,
  rungTitle,
  tierLadder,
  tierLocks,
  untilReset,
  type LockoutWindow
} from '../src/renderer/src/features/bosses/lockout'
import { formatDate } from '../src/renderer/src/lib/formatDate'
import { TIER_OPEN_WORLD, TIER_UNKNOWN } from '../src/shared/kills'
import type { KillTierRun, RaidTarget } from '../src/shared/types'
import { readFixture } from './harness.mts'

const HOUR = 3_600_000

/** The pin took — every real-log assertion below depends on it. */
test('the process timezone is pinned to Pacific for the fixture replays', () => {
  assert.equal(new Date(2026, 0, 15).getTimezoneOffset(), 480, 'January is PST (UTC-8)')
  assert.equal(new Date(2026, 6, 15).getTimezoneOffset(), 420, 'July is PDT (UTC-7)')
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour12: false,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

/** An instant as a Pacific wall clock, e.g. "Tue 2026-08-04 08:00". */
function pacific(ms: number): string {
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const part of PACIFIC.formatToParts(ms)) p[part.type] = part.value
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

test('the reset day and hour are named constants, editable one at a time', () => {
  assert.equal(LOCKOUT_TIMEZONE, 'America/Los_Angeles')
  assert.equal(LOCKOUT_RESET_WEEKDAY, 2, 'Tuesday — the single-sourced half; VERIFY IN GAME')
  assert.equal(LOCKOUT_RESET_HOUR, 8, '8:00 AM Pacific — the double-sourced half')
})

test('the window is the Tuesday 08:00 Pacific pair either side of now', () => {
  // Wed Aug 05 2026, 10:00 Pacific (PDT, UTC-7).
  const w = lockoutWindow(Date.UTC(2026, 7, 5, 17))
  assert.equal(w.start, Date.UTC(2026, 7, 4, 15), 'Tue Aug 04 08:00 PDT = 15:00 UTC')
  assert.equal(w.next, Date.UTC(2026, 7, 11, 15), 'and the next one a week later')
  assert.equal(pacific(w.start), 'Tue 2026-08-04 08:00')
  assert.equal(pacific(w.next), 'Tue 2026-08-11 08:00')
})

test('the exact boundary belongs to the week it opens, not the one it closes', () => {
  const reset = Date.UTC(2026, 7, 4, 15)
  assert.equal(lockoutWindow(reset).start, reset, 'at 08:00:00 sharp the new week has begun')
  assert.equal(
    lockoutWindow(reset - 1).start,
    Date.UTC(2026, 6, 28, 15),
    'one millisecond earlier is still last week'
  )
  assert.equal(lockoutWindow(reset - 1).next, reset, '…whose next reset is that same instant')
})

test('on reset day before the hour, this week began seven days ago', () => {
  // Tue Aug 04 2026, 07:59 Pacific.
  const w = lockoutWindow(Date.UTC(2026, 7, 4, 14, 59))
  assert.equal(pacific(w.start), 'Tue 2026-07-28 08:00')
  assert.equal(pacific(w.next), 'Tue 2026-08-04 08:00')
})

test('DST spring forward: the week that loses an hour is 167 hours long', () => {
  // 2026 DST begins Sun Mar 08. The week Tue Mar 03 → Tue Mar 10 contains it.
  // Thu Mar 05 2026, 12:00 Pacific (PST, UTC-8).
  const w = lockoutWindow(Date.UTC(2026, 2, 5, 20))
  assert.equal(w.start, Date.UTC(2026, 2, 3, 16), 'Tue Mar 03 08:00 PST = 16:00 UTC')
  assert.equal(w.next, Date.UTC(2026, 2, 10, 15), 'Tue Mar 10 08:00 PDT = 15:00 UTC')
  // The wall clock is 08:00 at BOTH ends — which is the whole point, and is exactly what a
  // fixed -7h/-8h offset gets wrong at one end or the other.
  assert.equal(pacific(w.start), 'Tue 2026-03-03 08:00')
  assert.equal(pacific(w.next), 'Tue 2026-03-10 08:00')
  assert.equal((w.next - w.start) / HOUR, 167, 'seven days minus the hour spring forward ate')
})

test('DST fall back: the week that gains an hour is 169 hours long', () => {
  // 2026 DST ends Sun Nov 01. The week Tue Oct 27 → Tue Nov 03 contains it.
  // Thu Oct 29 2026, 12:00 Pacific (PDT, UTC-7).
  const w = lockoutWindow(Date.UTC(2026, 9, 29, 19))
  assert.equal(w.start, Date.UTC(2026, 9, 27, 15), 'Tue Oct 27 08:00 PDT = 15:00 UTC')
  assert.equal(w.next, Date.UTC(2026, 10, 3, 16), 'Tue Nov 03 08:00 PST = 16:00 UTC')
  assert.equal(pacific(w.start), 'Tue 2026-10-27 08:00')
  assert.equal(pacific(w.next), 'Tue 2026-11-03 08:00')
  assert.equal((w.next - w.start) / HOUR, 169, 'seven days plus the hour fall back returned')
})

test('a week that spans a month and a year edge needs no special case', () => {
  // Fri Jan 01 2027, 12:00 Pacific — the week began in the previous month AND year.
  const w = lockoutWindow(Date.UTC(2027, 0, 1, 20))
  assert.equal(pacific(w.start), 'Tue 2026-12-29 08:00')
  assert.equal(pacific(w.next), 'Tue 2027-01-05 08:00')
  assert.equal(w.start, Date.UTC(2026, 11, 29, 16), 'PST, so 16:00 UTC')
})

test('the same instant gives the same window in every machine timezone', () => {
  const now = Date.UTC(2026, 7, 5, 17)
  const expected = lockoutWindow(now)
  const original = process.env.TZ
  try {
    for (const tz of ['Asia/Tokyo', 'America/New_York', 'UTC', 'Australia/Sydney', 'Pacific/Kiritimati']) {
      process.env.TZ = tz
      assert.deepEqual(lockoutWindow(now), expected, `${tz} reads the same Pacific reset`)
    }
  } finally {
    process.env.TZ = original
  }
  // …and the pin is back, for the fixture replays below.
  assert.equal(new Date(2026, 6, 15).getTimezoneOffset(), 420)
})

test('the countdown is coarse and never negative', () => {
  const w = (msLeft: number): LockoutWindow => ({ start: 0, now: 0, next: msLeft })
  assert.equal(untilReset(w(3 * 24 * HOUR + 4 * HOUR + 30 * 60_000)), '3d 4h')
  assert.equal(untilReset(w(4 * HOUR + 12 * 60_000)), '4h 12m')
  assert.equal(untilReset(w(12 * 60_000)), '12m')
  assert.equal(untilReset(w(-HOUR)), '0m', 'a stale clock reads empty, never "-1h"')
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE PREDICATE — per tier, and credited only
// ─────────────────────────────────────────────────────────────────────────────

const WEEK = lockoutWindow(Date.UTC(2026, 7, 5, 17)) // Tue Aug 04 08:00 PDT → Tue Aug 11 08:00

/** A tier run whose credited kill landed at `ts` (0 = none of its kills were yours). */
function run(ts: number, extra?: Partial<KillTierRun>): KillTierRun {
  return { count: 1, firstTs: ts, lastTs: ts, credited: ts ? 1 : 0, lastCreditedTs: ts, ...extra }
}

test('a kill exactly on the reset instant is inside the week it opens', () => {
  assert.deepEqual(tierLocks({ 2: run(WEEK.start) }, WEEK), [{ tier: 2, ts: WEEK.start }])
  assert.deepEqual(tierLocks({ 2: run(WEEK.start - 1) }, WEEK), [], 'one ms earlier is last week')
  assert.deepEqual(tierLocks({ 2: run(WEEK.next) }, WEEK), [], 'and the next reset closes it')
})

test('difficulties lock independently — the lockout is per boss PER DIFFICULTY', () => {
  const locks = tierLocks(
    {
      0: run(WEEK.start - 30 * 24 * HOUR), // a month ago
      2: run(WEEK.start + HOUR), // this week
      4: run(WEEK.start + 3 * 24 * HOUR) // also this week
    },
    WEEK
  )
  assert.deepEqual(locks, [
    { tier: 2, ts: WEEK.start + HOUR },
    { tier: 4, ts: WEEK.start + 3 * 24 * HOUR }
  ])
  assert.deepEqual(locks.map((l) => l.tier), [2, 4], 'lowest tier first, so the card reads in order')
})

test('a kill you merely WITNESSED locks nothing', () => {
  // The stranger's open-world kill: counted for the mob, credited to nobody. `lastTs` is inside
  // the window and `lastCreditedTs` is 0 — reading the wrong one would report a lockout on loot
  // the player never had a roll at.
  const witnessed: KillTierRun = {
    count: 1,
    firstTs: WEEK.start + HOUR,
    lastTs: WEEK.start + HOUR,
    credited: 0,
    lastCreditedTs: 0
  }
  assert.deepEqual(tierLocks({ 0: witnessed }, WEEK), [])
})

test('an old credited kill plus a fresh witnessed one is still open', () => {
  const mixed: KillTierRun = {
    count: 2,
    firstTs: WEEK.start - 20 * 24 * HOUR,
    lastTs: WEEK.start + HOUR,
    credited: 1,
    lastCreditedTs: WEEK.start - 20 * 24 * HOUR
  }
  assert.deepEqual(tierLocks({ 3: mixed }, WEEK), [], 'yours was three weeks ago')
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE GOLDEN — real kill history straddling one Tuesday reset
// ─────────────────────────────────────────────────────────────────────────────
//
// Two committed fixtures, replayed in chronological order into ONE kills module, give a history
// that sits on both sides of Tue Aug 04 2026 08:00 Pacific:
//
//   Sat Aug 01 16:09:29  Lord of Ire, d4 (The Plane of Hate - Solo 4 (Refined)) — credited
//   Mon Aug 03 23:02:44  Lord of Ire, OPEN WORLD (The Plane of Hate)            — credited
//   ── Tue Aug 04 08:00 Pacific: the reset ──
//   Tue Aug 04 22:55:08  a thunder spirit princess, OPEN WORLD (Plane of Sky)   — credited
//   Wed Aug 05 00:33:45  a thunder spirit princess, killed by Pesmerga          — witnessed
//
// So the SAME record must read three different ways depending only on which side of the boundary
// `now` is standing.
//
// THREE OF THESE FOUR KILLS TAKE NO LOCKOUT (JOS-166 — and this section used to assert the
// opposite for two of them). Two happened in the OPEN WORLD: a bare zone name, no instance, and
// per the wiki no weekly lockout exists on an open-world spawn to be spent. Until d0 became a
// real difficulty those folded to tier 0 next to genuine base-instance clears, so this file
// pinned an open-world kill as a d0 lock — the app reporting loot taken that was never on offer.
// What survives is the one lock the log actually states: Lord of Ire at d4. Section 5 below adds
// the other half of the picture, a week in which all five difficulties really were cleared.

const IRE: RaidTarget = { name: 'Lord of Ire', category: 'Plane of Hate', match: ['Lord of Ire'] }
const PRINCESS: RaidTarget = {
  name: 'Thunder Spirit Princess',
  category: 'Plane of Sky',
  match: ['Thunder Spirit Princess']
}
/** The two Plane of Hate rows section 5 uses, spelled as bosses.json spells them. */
const MAESTRO: RaidTarget = {
  name: 'Maestro of Rancor',
  category: 'Plane of Hate',
  match: ['Maestro of Rancor'],
  zone: 'Plane of Hate'
}
const SPITE: RaidTarget = {
  name: 'Master of Spite',
  category: 'Plane of Hate',
  match: ['Master of Spite'],
  zone: 'Plane of Hate'
}

const IRE_D4 = parseEqTimestamp('Sat Aug 01 16:09:29 2026')
/** The Mon Aug 03 Lord of Ire kill — `The Plane of Hate`, no instance suffix: the open world. */
const IRE_OPEN = parseEqTimestamp('Mon Aug 03 23:02:44 2026')
const PRINCESS_MINE = parseEqTimestamp('Tue Aug 04 22:55:08 2026')

/** Both fixtures through the REAL parser into one kills module, oldest first. */
function history(): TargetStatus[] {
  const mod = new KillsModule()
  mod.reset()
  let seq = 0
  for (const name of ['bosstier-lord-of-ire.log', 'boss-credit-open-world.log']) {
    for (const raw of readFixture(name)) {
      const ev = parseEvent(raw, seq++)
      if (ev) mod.onEvent(ev)
    }
  }
  return allStatuses([IRE, PRINCESS], mod.snapshot().state.mobs)
}

const byName = (list: TargetStatus[], name: string): TargetStatus =>
  list.find((s) => s.target.name === name)!

test('golden: standing before the reset, only the INSTANCED kill is locked', () => {
  // Mon Aug 03 2026, 23:30 Pacific — half an hour after the open-world kill.
  const w = lockoutWindow(parseEqTimestamp('Mon Aug 03 23:30:00 2026'))
  assert.equal(pacific(w.start), 'Tue 2026-07-28 08:00')
  assert.equal(pacific(w.next), 'Tue 2026-08-04 08:00')

  const list = history()
  const ire = byName(list, 'Lord of Ire')
  // TWO CREDITED KILLS IN THIS WINDOW, ONE LOCK. This assertion used to read
  // `[{ tier: 0, ts: IRE_D0 }, { tier: 4, ts: IRE_D4 }]` and the d0 entry was the bug: the Aug 03
  // kill was in `The Plane of Hate` with no instance suffix, so it took no lockout at any
  // difficulty. Only the Aug 01 `- Solo 4 (Refined)` clear did (JOS-166).
  assert.deepEqual(
    tierLocks(ire.tiers, w),
    [{ tier: 4, ts: IRE_D4 }],
    'the instanced clear locks its own difficulty; the open-world kill locks nothing'
  )
  assert.equal(ire.count, 2, 'and BOTH kills are still on the record — tracking did not move')
  assert.equal(ire.credited, 2, 'both paid you experience; neither fact is a lockout on its own')

  // Her kill is still in the future of this window, and the record already holds it: the
  // window is what excludes it, not the order the fixture was folded in.
  assert.deepEqual(tierLocks(byName(list, 'Thunder Spirit Princess').tiers, w), [])
})

test('golden: one Tuesday later the d4 lock is gone, and nothing replaces it', () => {
  // Wed Aug 05 2026, 12:00 Pacific — the reset has been and gone.
  const w = lockoutWindow(parseEqTimestamp('Wed Aug 05 12:00:00 2026'))
  assert.equal(pacific(w.start), 'Tue 2026-08-04 08:00')

  const list = history()
  const ire = byName(list, 'Lord of Ire')
  assert.deepEqual(tierLocks(ire.tiers, w), [], 'last week\'s kills lock nothing this week')
  assert.equal(ire.killed, true, 'the ROSTER is unchanged — overall progression is not a lockout')
  assert.equal(ire.count, 2)

  const princess = byName(list, 'Thunder Spirit Princess')
  // THIS USED TO READ `[{ tier: 0, ts: PRINCESS_MINE }]`. Your kill was real and it was credited,
  // but it happened in the open-world Plane of Sky — no instance, so nothing to be locked out of
  // (JOS-166). The run is still on the record under the open-world key, where it counts toward
  // her kill history and can never green a rung.
  assert.deepEqual(tierLocks(princess.tiers, w), [], 'an open-world kill takes no lockout')

  const open = princess.tiers[TIER_OPEN_WORLD]
  // Pesmerga's kill 98 minutes later is inside the same window and moved `lastTs`; it is not what
  // any lock would be dated by, and on its own it would not have produced one at all.
  assert.equal(open.lastTs > PRINCESS_MINE, true, 'a later kill did happen')
  assert.equal(open.count, 2)
  assert.equal(open.credited, 1)
  assert.equal(open.lastCreditedTs, PRINCESS_MINE, 'and the credit still dates YOUR kill')
  assert.equal(princess.tiers[0], undefined, 'nothing was filed at the base difficulty')
})

test('golden: two Tuesdays later everything is open again', () => {
  const w = lockoutWindow(parseEqTimestamp('Wed Aug 12 12:00:00 2026'))
  assert.equal(pacific(w.start), 'Tue 2026-08-11 08:00')
  const list = history()
  for (const s of list) assert.deepEqual(tierLocks(s.tiers, w), [], `${s.target.name} is open`)
  assert.equal(list.every((s) => s.killed), true, 'and every one of them is still defeated')
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE DIFFICULTY LADDER (JOS-152) — the same locks, with the OPEN rungs drawn
// ─────────────────────────────────────────────────────────────────────────────
//
// The reporter's ask is a rung per difficulty, grey until this week's kill turns it green, so a
// coordinator can read what is LEFT rather than only what is spent. Everything below is a
// statement about that presentation and about the ONE thing it must not overclaim: which kills
// are allowed to green a rung.
//
// THE RULE CHANGED HERE (JOS-166). It used to be "d1..d4 are NAMED by an adjective the zone line
// printed and d0 is the absence of one", so the base rung carried a `stated: false` flag and the
// component drew it as an outline even when cleared. That flag is gone, and so are the tests that
// pinned it: the zone line does state the base INSTANCE (`- Solo` / `- Group N` with no
// adjective), what it does not state is a difficulty for the OPEN WORLD — which is not a lesser
// d0 but no lockout at all. The distinction moved from a presentation flag on the rung to a tier
// KEY on the kill record, so the ladder is five equal promises and the kills that cannot back one
// never arrive.

test('the ladder is one rung per difficulty, base first, always five of them', () => {
  assert.deepEqual(DIFFICULTY_TIERS, [0, 1, 2, 3, 4])
  const rungs = tierLadder([])
  assert.deepEqual(rungs.map((r) => r.tier), [0, 1, 2, 3, 4])
  assert.equal(
    rungs.every((r) => !r.cleared && r.ts === 0),
    true,
    'no locks means five OPEN rungs - never an empty row, which would state nothing'
  )
})

test('a lock turns its own rung green and leaves the others alone', () => {
  const rungs = tierLadder([
    { tier: 2, ts: WEEK.start + HOUR },
    { tier: 4, ts: WEEK.start + 3 * 24 * HOUR }
  ])
  assert.deepEqual(rungs.map((r) => r.cleared), [false, false, true, false, true])
  assert.equal(rungs[2].ts, WEEK.start + HOUR, 'each green rung is dated by ITS OWN kill')
  assert.equal(rungs[4].ts, WEEK.start + 3 * 24 * HOUR)
  assert.equal(rungs[1].ts, 0, 'and an open rung carries no timestamp to render')
})

test('the base rung is a rung like any other - no flag distinguishes it', () => {
  // The REPLACEMENT for 'only the BASE rung is unstated' (JOS-166), and deliberately the same
  // shape of assertion so the reversal is visible in the diff. The old test pinned
  // `[false, true, true, true, true]` on a `stated` field; that field is gone, because the thing
  // it hedged against - an open-world kill masquerading as a base-difficulty clear - can no
  // longer reach a rung at all. What is left is five plain rungs.
  const rungs = tierLadder([])
  assert.deepEqual(
    rungs.map((r) => Object.keys(r).sort()),
    Array.from({ length: 5 }, () => ['cleared', 'tier', 'ts']),
    'a rung is a difficulty, whether it is cleared, and when - nothing else'
  )
})

test('a kill at no difficulty greens nothing, whichever non-difficulty it was', () => {
  // The two keys that are not difficulties (shared/kills.ts) never become locks, so the ladder
  // never sees them - but if one ever leaked through `tierLocks`, the rung lookup would still
  // ignore it rather than paint the base rung with it. Both directions matter: the base rung is
  // now a real promise, so anything that is not a base-instance clear must stay off it.
  const rungs = tierLadder([
    { tier: TIER_OPEN_WORLD, ts: WEEK.start + HOUR },
    { tier: TIER_UNKNOWN, ts: WEEK.start + HOUR }
  ])
  assert.equal(rungs.length, 5)
  assert.equal(rungs.some((r) => r.cleared), false, 'and above all NOT the base rung')
})

test('an unknown difficulty invents no sixth rung', () => {
  // A zone adjective this app has never decoded now folds to TIER_UNKNOWN rather than to a tier
  // above the five, but a stray high tier is still ignored rather than grown into a rung nobody
  // can label (tierStyle clamps the same way).
  const rungs = tierLadder([{ tier: 7, ts: WEEK.start + HOUR }])
  assert.equal(rungs.length, 5)
  assert.equal(rungs.some((r) => r.cleared), false)
})

/** The day format the rung hover is contracted to state — restated from lockout.ts's `RUNG_DAY`
 *  so these assertions are locale-independent (the app formats through the runtime's locale) and
 *  so a change to WHAT "the day" means shows up here as a failure rather than as silence. */
const RUNG_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'numeric', day: 'numeric' }

test('a cleared rung hover is the day of that clear; an open rung says nothing at all', () => {
  // The REPLACEMENT for 'every rung says the same kind of thing, base rung included' (JOS-166),
  // which pinned the sentence `D0 · base - cleared Tue 7/28`. JOS-171 deleted the prose: the card
  // no longer carries a `Locked · <date>` / `open` line under the ladder, so the rung IS the whole
  // statement - its label names the difficulty, its colour says whether the week has taken it, and
  // the hover adds the only fact neither of those can carry.
  //
  // An OPEN rung answers `undefined`, never '': React omits the attribute for the first and emits
  // a present-and-empty one for the second, which suppresses the tooltip the card itself carries.
  const ts = WEEK.start + HOUR
  const [base, awakened] = tierLadder([{ tier: 0, ts }, { tier: 1, ts }])
  assert.equal(rungTitle(base), formatDate(ts, RUNG_DAY))
  const same = 'two difficulties cleared in the same hour say the SAME thing - the tier is on the chip'
  assert.equal(rungTitle(awakened), rungTitle(base), same)
  assert.equal(/D0|base|cleared|week/.test(rungTitle(base) ?? ''), false, 'no prose survives')
  const quiet = tierLadder([]).every((r) => rungTitle(r) === undefined)
  assert.equal(quiet, true, 'and an untouched week hands back five rungs with no title at all')
})

test('golden: standing before the reset, Lord of Ire has ONE green rung and four grey', () => {
  // Mon Aug 03 2026, 23:30 Pacific - the same instant section 3 uses, so this is the same real
  // record (a d4 instance kill on Sat Aug 01, an open-world kill on Mon Aug 03) read as a ladder.
  //
  // IT USED TO BE TWO GREEN (JOS-166). The base rung was green - as an outline, because the model
  // could not say what it meant - off the Aug 03 kill in "The Plane of Hate", which is the open
  // world and carries no lockout. A coordinator reading that card was told d0 was spent when it
  // was still there to take.
  const w = lockoutWindow(parseEqTimestamp('Mon Aug 03 23:30:00 2026'))
  const ire = byName(history(), 'Lord of Ire')
  const rungs = tierLadder(tierLocks(ire.tiers, w))
  assert.deepEqual(rungs.map((r) => r.cleared), [false, false, false, false, true])
  assert.equal(rungs[4].ts, IRE_D4)
  assert.equal(rungs[0].ts, 0, 'the base difficulty is OPEN this week - and it really was')
  assert.equal(
    ire.tiers[TIER_OPEN_WORLD]?.lastCreditedTs,
    IRE_OPEN,
    'the open-world kill is on the record; it is simply not a lockout'
  )
})

test('golden: one Tuesday later the whole ladder is grey again', () => {
  const w = lockoutWindow(parseEqTimestamp('Wed Aug 05 12:00:00 2026'))
  const ire = byName(history(), 'Lord of Ire')
  const rungs = tierLadder(tierLocks(ire.tiers, w))
  assert.equal(rungs.every((r) => !r.cleared), true, 'last week bought this week nothing')
  assert.equal(ire.killed, true, 'and the OVERALL roster still has him defeated')
})

test('golden: two open-world kills of the same boss green no rung between them', () => {
  // Pesmerga killed the princess 98 minutes after the player's own kill, inside the same week.
  // The old assertion here was `[true, false, false, false, false]`: her base rung went green off
  // the PLAYER's kill, and the test's point was that the stranger's could not have done it. Both
  // kills were in the open-world Plane of Sky, so neither takes a lockout (JOS-166) and the whole
  // ladder is grey - which subsumes the original claim rather than dropping it.
  const w = lockoutWindow(parseEqTimestamp('Wed Aug 05 12:00:00 2026'))
  const princess = byName(history(), 'Thunder Spirit Princess')
  const rungs = tierLadder(tierLocks(princess.tiers, w))
  assert.deepEqual(rungs.map((r) => r.cleared), [false, false, false, false, false])
  assert.equal(princess.count, 2, 'both kills are still counted for the mob')
  assert.equal(princess.credited, 1, 'and exactly one of them was yours')
  assert.equal(princess.killed, true, 'the roster still has her defeated')
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. d0 IS A REAL DIFFICULTY (JOS-166) — the five-rung week, and the open world beside it
// ─────────────────────────────────────────────────────────────────────────────
//
// OWNER DECISION, 2026-08-09: a raid target carries FIVE weekly lockouts, d0 through d4, and the
// owner clears all five most weeks. Section 4 above is what that looked like when the app could
// not tell a base instance from the open world — a base rung it drew as an outline and hedged
// about in a tooltip. This section is the two halves of the distinction, both cut verbatim from
// the owner's log on the same three days.
//
//   THE LADDER RUN (tests/fixtures/bosstier-hate-ladder-aug01.log). Sat Aug 01, one boss, one
//   afternoon, five instances entered in order:
//     13:07:45  The Plane of Hate - Solo.                → d0, the BASE instance
//     13:38:00  The Plane of Hate - Solo 1 (Awakened).   → d1
//     13:57:08  The Plane of Hate - Solo 2 (Adaptive).   → d2
//     14:35:15  The Plane of Hate - Solo 3 (Fused).      → d3
//     15:33:26  The Plane of Hate - Solo 4 (Refined).    → d4
//   …with a credited Maestro of Rancor kill inside each. FIVE GREEN RUNGS is the acceptance
//   criterion of this ticket, and before it the first of those five kills was indistinguishable
//   from an open-world kill of the same boss in the same zone.
//
//   THE OPEN WORLD (tests/fixtures/boss-open-world-hate.log). The same zone with no suffix, two
//   credited Master of Spite kills — one before the Tue Aug 04 reset and one after, so whichever
//   week you stand in, one of them is inside it and neither greens anything.

/** The five-difficulty ladder run and the open-world kills, folded into ONE kills module. */
function hateWeek(): TargetStatus[] {
  const mod = new KillsModule()
  mod.reset()
  let seq = 0
  for (const name of ['bosstier-hate-ladder-aug01.log', 'boss-open-world-hate.log']) {
    for (const raw of readFixture(name)) {
      const ev = parseEvent(raw, seq++)
      if (ev) mod.onEvent(ev)
    }
  }
  return allStatuses([MAESTRO, SPITE], mod.snapshot().state.mobs)
}

test('golden: the Aug 01 ladder run fills all FIVE rungs of that week', () => {
  // Sat Aug 01 18:00 Pacific — a couple of hours after the d4 clear, inside the week that opened
  // Tue Jul 28 08:00 and closes Tue Aug 04 08:00.
  const w = lockoutWindow(parseEqTimestamp('Sat Aug 01 18:00:00 2026'))
  assert.equal(pacific(w.start), 'Tue 2026-07-28 08:00')
  assert.equal(pacific(w.next), 'Tue 2026-08-04 08:00')

  const maestro = byName(hateWeek(), 'Maestro of Rancor')
  assert.deepEqual(
    tierLocks(maestro.tiers, w).map((l) => l.tier),
    [0, 1, 2, 3, 4],
    'five difficulties, five credited kills, five locks'
  )

  const rungs = tierLadder(tierLocks(maestro.tiers, w))
  assert.deepEqual(rungs.map((r) => r.cleared), [true, true, true, true, true])
  // Each rung is dated by ITS OWN kill, base rung included — the ladder is not one clear smeared
  // across five boxes.
  assert.deepEqual(
    rungs.map((r) => r.ts),
    [
      parseEqTimestamp('Sat Aug 01 13:23:07 2026'),
      parseEqTimestamp('Sat Aug 01 13:47:58 2026'),
      parseEqTimestamp('Sat Aug 01 14:18:07 2026'),
      parseEqTimestamp('Sat Aug 01 14:56:20 2026'),
      parseEqTimestamp('Sat Aug 01 16:02:37 2026')
    ]
  )
  // …and each rung's hover is exactly that kill's day (JOS-171). All five landed on the same
  // Saturday, so all five read alike — which is the point: the difficulty is the chip's job.
  assert.equal(rungTitle(rungs[0]), formatDate(rungs[0].ts, RUNG_DAY))
  const days = new Set(rungs.map((r) => rungTitle(r)))
  assert.equal(days.size, 1, 'five clears in one afternoon, one day between them')
})

test('golden: the base rung comes from the `- Solo` line, not from an absence', () => {
  // The whole ticket in one assertion. `You have entered The Plane of Hate - Solo.` carries no
  // difficulty adjective, and that used to be the reason d0 could not be trusted; the SUFFIX is
  // the statement, and it is what separates this run from the open-world one below it.
  const maestro = byName(hateWeek(), 'Maestro of Rancor')
  assert.deepEqual(
    Object.keys(maestro.tiers).map(Number).sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
    'five difficulty runs and not one non-difficulty key'
  )
  assert.equal(maestro.tiers[0].count, 1)
  assert.equal(maestro.tiers[0].credited, 1, 'the charmed pet landed it; the exp line credits you')
  assert.equal(maestro.bestTier, 4)
  assert.equal(maestro.count, 5)
})

test('golden: the owner\'s open-world Hate kills fill no rung, in either week', () => {
  const spiteWeeks = [
    // Mon Aug 03 — the week the 00:25 kill lands in (it is BEFORE Tuesday 08:00).
    'Mon Aug 03 12:00:00 2026',
    // Wed Aug 05 — the week the 20:44 kill lands in.
    'Wed Aug 05 12:00:00 2026'
  ]
  for (const stamp of spiteWeeks) {
    const w = lockoutWindow(parseEqTimestamp(stamp))
    const spite = byName(hateWeek(), 'Master of Spite')
    assert.deepEqual(tierLocks(spite.tiers, w), [], `${stamp}: no lockout was ever taken`)
    assert.equal(
      tierLadder(tierLocks(spite.tiers, w)).some((r) => r.cleared),
      false,
      `${stamp}: and therefore no green rung`
    )
  }

  // …while the kills themselves are fully recorded: this is a tracking fact the roster keeps.
  const spite = byName(hateWeek(), 'Master of Spite')
  assert.equal(spite.killed, true)
  assert.equal(spite.count, 2, 'both open-world kills counted')
  assert.equal(spite.credited, 2, 'both were credited to you — credit is not a lockout')
  assert.deepEqual(Object.keys(spite.tiers).map(Number), [TIER_OPEN_WORLD])
  assert.equal(spite.bestTier, TIER_OPEN_WORLD, 'and the card badges the open world, not D0')
})

test('golden: a kill folded before ANY zone line claims no difficulty', () => {
  // The third world the old tier 0 covered. Same ladder fixture with every `You have entered`
  // line removed, so the module never learns where it is: the kills still count and still credit,
  // and not one of them greens a rung.
  const mod = new KillsModule()
  mod.reset()
  let seq = 0
  for (const raw of readFixture('bosstier-hate-ladder-aug01.log')) {
    if (raw.includes('You have entered')) continue
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  const blind = byName(allStatuses([MAESTRO, SPITE], mod.snapshot().state.mobs), 'Maestro of Rancor')

  assert.equal(blind.count, 5, 'the kills are all there')
  assert.deepEqual(Object.keys(blind.tiers).map(Number), [TIER_UNKNOWN], 'under one honest key')
  const w = lockoutWindow(parseEqTimestamp('Sat Aug 01 18:00:00 2026'))
  assert.deepEqual(tierLocks(blind.tiers, w), [], 'and none of them is a lockout the app can claim')
})
