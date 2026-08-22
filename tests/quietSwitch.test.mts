/**
 * quietSwitch.test.mts — the nudge's decision, and the four ways it is forbidden to nag (JOS-432).
 *
 * THE SUBJECT. The owner ruled option (b) on 2026-08-21 — while the app is attached to a log that
 * has gone quiet and a SIBLING `eqlog_*.txt` is growing, offer a one-click switch — with a verbatim
 * constraint attached: the nudge must be structurally incapable of nagging. `src/main/log/
 * quietSwitch.ts` is that structure, and these are the properties the structure is FOR:
 *
 *   1. quiet + a growing sibling asks EXACTLY ONCE, and keeps its silence while the sibling keeps
 *      growing (the acceptance criterion, and the one a naive implementation fails immediately);
 *   2. the memory is keyed on the CANDIDATE alone, which is what bounds two-account alternation to
 *      one ask per log rather than one per ordered pair;
 *   3. a quiet log ALONE fires nothing — growth is required, and growth means growth THIS module
 *      watched happen between two of its own polls, never a size it found on first look;
 *   4. the generous threshold really gates it: nothing at all happens before it elapses, and a
 *      single line arriving resets the stretch.
 *
 * Pure: every instant and every file size is an argument, so nothing here touches a disk or a clock
 * and it never skips. The fs/IPC binding it feeds is `src/main/switchNudge.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  POLL_MS,
  QUIET_MS,
  QuietSwitchWatcher,
  logIsQuiet,
  type QuietSwitchObservation,
  type QuietSwitchOutcome
} from '../src/main/log/quietSwitch'

const MINE = 'C:\\EQ\\Logs\\eqlog_Primitive_freeport.txt'
const THEIRS = 'C:\\EQ\\Logs\\eqlog_Alterna_freeport.txt'
const THIRD = 'C:\\EQ\\Logs\\eqlog_Bantam_freeport.txt'

/** A poll: who we are attached to, when the tail last saw a line, and every log's size right now. */
function poll(
  w: QuietSwitchWatcher,
  o: {
    now: number
    active?: string
    lastLineAt: number
    sizes: Readonly<Record<string, number>>
  }
): QuietSwitchOutcome {
  const obs: QuietSwitchObservation = {
    now: o.now,
    activeLogPath: o.active ?? MINE,
    lastLineAt: o.lastLineAt,
    logs: Object.entries(o.sizes).map(([path, size]) => ({ path, size }))
  }
  return w.observe(obs)
}

const T0 = 1_700_000_000_000
/** Comfortably past the threshold — every "we are quiet now" instant below is built from this. */
const QUIET_AT = T0 + QUIET_MS + 1

test('the threshold gates everything: before it elapses nothing is even considered', () => {
  const w = new QuietSwitchWatcher()
  // A sibling growing hand over fist, while our log has been silent for one second short of the
  // threshold. The whole mechanism must be asleep.
  let outcome = poll(w, { now: T0 + QUIET_MS - 1, lastLineAt: T0, sizes: { [MINE]: 10, [THEIRS]: 10 } })
  assert.equal(outcome.kind, 'live')
  outcome = poll(w, { now: T0 + QUIET_MS - 1, lastLineAt: T0, sizes: { [MINE]: 10, [THEIRS]: 9_999 } })
  assert.equal(outcome.kind, 'live', 'growth below the quiet threshold is not this feature s business')

  assert.equal(logIsQuiet(T0, T0 + QUIET_MS - 1), false)
  assert.equal(logIsQuiet(T0, T0 + QUIET_MS), true)
  // The generosity is the point (ordinary AFK and zoning must never reach it) and the poll is a
  // small fraction of it, so the first ask lands promptly once it does.
  assert.ok(QUIET_MS >= 5 * 60_000, 'the threshold stays generous — several minutes, per the ruling')
  assert.ok(POLL_MS < QUIET_MS / 4)
})

test('a QUIET LOG ALONE fires nothing — a growing sibling is required', () => {
  const w = new QuietSwitchWatcher()
  // The reporter's actual case: the game client died, so NOTHING in the directory moves. Poll for
  // an hour of wall clock and the app must never ask a question it has no evidence for.
  for (let i = 0; i < 240; i++) {
    const outcome = poll(w, {
      now: QUIET_AT + i * POLL_MS,
      lastLineAt: T0,
      sizes: { [MINE]: 4_096, [THEIRS]: 2_048 }
    })
    assert.equal(outcome.kind, 'watching')
  }
})

test('a sibling seen for the FIRST TIME is not yet growth — the baseline is earned', () => {
  const w = new QuietSwitchWatcher()
  // A big sibling on the very first quiet poll proves nothing: it may have been that size for
  // weeks. It joins the baseline instead, and only real growth after that counts.
  assert.equal(poll(w, { now: QUIET_AT, lastLineAt: T0, sizes: { [MINE]: 10, [THEIRS]: 900_000 } }).kind, 'watching')
  assert.equal(
    poll(w, { now: QUIET_AT + POLL_MS, lastLineAt: T0, sizes: { [MINE]: 10, [THEIRS]: 900_000 } }).kind,
    'watching',
    'unchanged size is not growth'
  )
  const asked = poll(w, { now: QUIET_AT + 2 * POLL_MS, lastLineAt: T0, sizes: { [MINE]: 10, [THEIRS]: 900_400 } })
  assert.equal(asked.kind, 'nudge')
  assert.equal(asked.kind === 'nudge' && asked.logPath, THEIRS)
  assert.equal(asked.kind === 'nudge' && asked.grewBy, 400)
})

test('EXACTLY ONE ask per candidate, however long the sibling keeps growing', () => {
  const w = new QuietSwitchWatcher()
  let theirs = 1_000
  let asks = 0
  // Two hours of polls with the other character being played hard the whole time.
  for (let i = 0; i < 480; i++) {
    theirs += 5_000
    const outcome = poll(w, {
      now: QUIET_AT + i * POLL_MS,
      lastLineAt: T0,
      sizes: { [MINE]: 10, [THEIRS]: theirs }
    })
    if (outcome.kind === 'nudge') asks++
  }
  assert.equal(asks, 1, 'the nudge is asked once and never repeated on a timer')
  assert.equal(w.asked(THEIRS), true)
})

test('…and a fresh quiet stretch does not un-spend it (the log went live, then quiet again)', () => {
  const w = new QuietSwitchWatcher()
  let theirs = 1_000
  const grow = (now: number, lastLineAt: number): QuietSwitchOutcome => {
    theirs += 500
    return poll(w, { now, lastLineAt, sizes: { [MINE]: 10, [THEIRS]: theirs } })
  }
  assert.equal(grow(QUIET_AT, T0).kind, 'watching')
  assert.equal(grow(QUIET_AT + POLL_MS, T0).kind, 'nudge')

  // Our character comes back (a line arrives), plays a while, then goes quiet again — the exact
  // shape of a user who alt-tabbed, played, and wandered off a second time.
  const back = QUIET_AT + 10 * POLL_MS
  assert.equal(grow(back, back - 1_000).kind, 'live')
  const quietAgain = back + QUIET_MS + 1
  assert.equal(grow(quietAgain, back).kind, 'watching', 'a new stretch re-earns its baseline')
  assert.equal(grow(quietAgain + POLL_MS, back).kind, 'watching', 'but the candidate is already spent')
  assert.equal(grow(quietAgain + 2 * POLL_MS, back).kind, 'watching')
})

test('the memory is keyed on the CANDIDATE, so two-account alternation asks once per log', () => {
  const w = new QuietSwitchWatcher()
  const sizes: Record<string, number> = { [MINE]: 1_000, [THEIRS]: 1_000 }
  const asks: string[] = []
  let now = QUIET_AT
  let active = MINE
  let lastLineAt = T0

  // Four alternations. Each time, the character we are NOT attached to is the one being played.
  for (let round = 0; round < 4; round++) {
    const other = active === MINE ? THEIRS : MINE
    for (let i = 0; i < 4; i++) {
      sizes[other] += 400
      now += POLL_MS
      const outcome = poll(w, { now, active, lastLineAt, sizes })
      if (outcome.kind === 'nudge') asks.push(outcome.logPath)
    }
    // The user takes the offer (or switches in game): we re-attach, and the quiet clock restarts.
    active = other
    lastLineAt = now
    now += QUIET_MS + 1
  }

  assert.deepEqual(asks, [THEIRS, MINE], 'one ask per LOG — never one per ordered pair of logs')
})

test('a DIFFERENT sibling starting to grow is a genuinely new situation, and may ask', () => {
  const w = new QuietSwitchWatcher()
  const sizes: Record<string, number> = { [MINE]: 1_000, [THEIRS]: 1_000, [THIRD]: 1_000 }
  let now = QUIET_AT
  const step = (grew: readonly string[]): QuietSwitchOutcome => {
    for (const p of grew) sizes[p] += 700
    now += POLL_MS
    return poll(w, { now, lastLineAt: T0, sizes })
  }
  assert.equal(step([THEIRS]).kind, 'watching')
  assert.equal(step([THEIRS]).kind, 'nudge')
  assert.equal(step([THEIRS]).kind, 'watching', 'the spent candidate keeps growing in silence')

  const third = step([THEIRS, THIRD])
  assert.equal(third.kind, 'nudge')
  assert.equal(third.kind === 'nudge' && third.logPath, THIRD)
  assert.equal(step([THEIRS, THIRD]).kind, 'watching', 'and now both are spent, forever')
})

test('the ACTIVE log is never its own candidate, and case never lets one through twice', () => {
  const w = new QuietSwitchWatcher()
  // Our own log growing while the tail sees nothing is a different defect entirely (a wedged
  // tailer), and it is emphatically not "another character's log is active".
  assert.equal(poll(w, { now: QUIET_AT, lastLineAt: T0, sizes: { [MINE]: 10 } }).kind, 'watching')
  assert.equal(poll(w, { now: QUIET_AT + POLL_MS, lastLineAt: T0, sizes: { [MINE]: 5_000 } }).kind, 'watching')

  // Windows hands the same file back under whatever casing the caller used; the memory of having
  // asked must survive that or the whole guarantee is one `readdir` away from failing.
  const sizes: Record<string, number> = { [MINE]: 10, [THEIRS]: 1_000 }
  let now = QUIET_AT + 3 * POLL_MS
  assert.equal(poll(w, { now, lastLineAt: T0, sizes }).kind, 'watching')
  sizes[THEIRS] += 100
  now += POLL_MS
  assert.equal(poll(w, { now, lastLineAt: T0, sizes }).kind, 'nudge')

  const shouty = THEIRS.toUpperCase()
  const recased: Record<string, number> = { [MINE]: 10, [shouty]: sizes[THEIRS] }
  now += POLL_MS
  assert.equal(poll(w, { now, lastLineAt: T0, sizes: recased }).kind, 'watching')
  recased[shouty] += 100
  now += POLL_MS
  assert.equal(poll(w, { now, lastLineAt: T0, sizes: recased }).kind, 'watching', 'same log, louder')
  assert.equal(w.asked(shouty), true)
})

test('a character SWITCH drops the baseline: growth is only ever read within one attachment', () => {
  const w = new QuietSwitchWatcher()
  const sizes: Record<string, number> = { [MINE]: 1_000, [THIRD]: 1_000 }
  assert.equal(poll(w, { now: QUIET_AT, lastLineAt: T0, sizes }).kind, 'watching')
  // We re-attach to THIRD while it is quiet, and MINE is the one that grew in the meantime. The
  // first poll after a switch may not claim growth it measured against the previous attachment.
  sizes[MINE] += 9_000
  const first = poll(w, { now: QUIET_AT + POLL_MS, active: THIRD, lastLineAt: T0, sizes })
  assert.equal(first.kind, 'watching')
  sizes[MINE] += 9_000
  const second = poll(w, { now: QUIET_AT + 2 * POLL_MS, active: THIRD, lastLineAt: T0, sizes })
  assert.equal(second.kind, 'nudge')
  assert.equal(second.kind === 'nudge' && second.logPath, MINE)
})

test('the outcome carries what the card has to say: which log, and how long we were silent', () => {
  const w = new QuietSwitchWatcher()
  const quietFor = QUIET_MS + 7 * 60_000
  assert.equal(
    poll(w, { now: T0 + quietFor, lastLineAt: T0, sizes: { [MINE]: 10, [THEIRS]: 100 } }).kind,
    'watching'
  )
  const asked = poll(w, {
    now: T0 + quietFor + POLL_MS,
    lastLineAt: T0,
    sizes: { [MINE]: 10, [THEIRS]: 350 }
  })
  assert.equal(asked.kind, 'nudge')
  assert.equal(asked.kind === 'nudge' && asked.quietMs, quietFor + POLL_MS)
  assert.equal(asked.kind === 'nudge' && asked.grewBy, 250)
})

test('when several siblings grew at once, the busiest one is the offer — and only it', () => {
  const w = new QuietSwitchWatcher()
  const sizes: Record<string, number> = { [MINE]: 10, [THEIRS]: 1_000, [THIRD]: 1_000 }
  assert.equal(poll(w, { now: QUIET_AT, lastLineAt: T0, sizes }).kind, 'watching')
  sizes[THEIRS] += 50
  sizes[THIRD] += 5_000
  const asked = poll(w, { now: QUIET_AT + POLL_MS, lastLineAt: T0, sizes })
  assert.equal(asked.kind, 'nudge')
  assert.equal(asked.kind === 'nudge' && asked.logPath, THIRD, 'no stacking: one card, the busiest log')
  assert.equal(w.asked(THEIRS), false, 'the runner-up was not silently spent')
})
