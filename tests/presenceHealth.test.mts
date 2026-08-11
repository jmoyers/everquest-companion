// THE WATCHER'S EXIT, AND THE LOOP IT CAN GET STUCK IN (JOS-164, retargeted by JOS-182).
//
// Split out of `tests/presence.test.mts` for size, and it is a clean seam: everything here is
// about the watcher ENDING — the reason it announces, and the trail that recognises a run of
// immediate exits. The line protocol, the EQ-window predicate, the debounce and the gating matrix
// stay in the original file.
//
// WHAT CHANGED UNDER IT, AND WHAT DID NOT. This file used to be `presenceSelfReap.test.mts` and
// its second half read the PowerShell the watcher child ran, asserting that it never asked .NET
// about a process again. There is no child and no PowerShell any more, so those assertions are
// gone — replaced by `tests/presenceNative.test.mts`, which calls the real Win32 surface that took
// their place, and `tests/presenceWorker.test.mts`, which runs the real worker.
//
// The FOLD is what survived, and deliberately: the sequence it recognises — a watcher that starts,
// says why it cannot work, and exits cleanly, forever, on the restart backoff — is not specific to
// a self-reaping child. It is what a machine whose native surface will not load does, which is the
// same population of machines (a locked-down enterprise desktop, a Wine prefix) that produced the
// bug in the first place.
//
// PURE, and it never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NEW_WATCHER_EXIT_TRAIL,
  WATCHER_EXIT_LOOP_ERROR_NAME,
  WATCHER_QUICK_EXIT_STREAK,
  WATCHER_STALE_MS,
  parsePresenceLine,
  watcherExitStep,
  type WatcherExitLog,
  type WatcherExitTrail
} from '../src/main/presenceProtocol'
import { errorFingerprint, errorNameOf, parseStackFrames } from '../src/shared/errorReport'

test('the EXIT line is the watcher’s last word, and its shape is narrow on purpose', () => {
  // JOS-164. From main, an exit used to be a code and nothing else — which is how 245 reports
  // came to say "exited unexpectedly" about a watcher that had DECIDED to stop and knew exactly
  // why. The reason line is what closes that gap, and JOS-182 kept it: the child's `parent-gone`
  // is impossible for a thread, but a surface that will not load is not, and it says so.
  for (const reason of ['native-unavailable', 'native-failing']) {
    assert.deepEqual(parsePresenceLine(`X|${reason}`), { t: 'exit', reason })
    assert.deepEqual(parsePresenceLine(`X|${reason}\r`), { t: 'exit', reason })
  }
  // The reason lands in main's error log, so it is bounded by SHAPE rather than trusted:
  // lowercase kebab, capped, ONE field. Everything else is junk and moves nothing.
  for (const junk of [
    'X',
    'X|',
    'X| ',
    'X|1|2',
    'X|Native-Unavailable',
    'X|native unavailable',
    `X|${'a'.repeat(64)}`,
    'X|native-unavailable|extra'
  ]) {
    assert.equal(parsePresenceLine(junk), null, `${JSON.stringify(junk)} must not decode`)
  }
  assert.equal(parsePresenceLine(`X|${'a'.repeat(63)}`)?.t, 'exit', 'the cap is inclusive at 63')
})

// ------------------------------------------------- the immediate-exit loop (JOS-164, JOS-182)
//
// THE BUG, AS A SEQUENCE. One install produced 245+ copies of `presence watcher exited
// unexpectedly` in two days — one every ~32 s, forever — because its `Get-Process` could not see
// a LIVE parent, so the child reaped itself about a second after every spawn. Each entry was
// true and none of them was the diagnosis; the diagnosis is only visible in the SHAPE of the run.
// These drive that whole sequence, including the part that must NOT fire.

/** Fold a run of exits through the trail, collecting whatever each one would have logged. */
function exitRun(
  exits: readonly { code: number | null; lifetimeMs: number; reason?: string }[]
): { logs: (WatcherExitLog | null)[]; trail: WatcherExitTrail } {
  let trail = NEW_WATCHER_EXIT_TRAIL
  const logs: (WatcherExitLog | null)[] = []
  for (const e of exits) {
    const step = watcherExitStep(trail, { code: e.code, lifetimeMs: e.lifetimeMs, reason: e.reason ?? null })
    trail = step.trail
    logs.push(step.log)
  }
  return { logs, trail }
}

/** One immediate exit: clean, fast, and carrying the watcher's own reason. This is what a machine
 *  that cannot load the Win32 surface produces on every single restart. */
const QUICK_EXIT = { code: 0, lifetimeMs: 900, reason: 'native-unavailable' } as const

test('THE WATCHER’S REASON REACHES THE LOG — every exit carries it, and its lifetime', () => {
  // `X|native-unavailable` decodes in `pumpMessage` and waits for the exit handler, which is the
  // only place that knows the code and how long the watcher lived. All three land in one entry, so
  // a reader of errors.log sees "it chose to stop, 900 ms in, because the surface would not load"
  // instead of "code 0".
  const first = watcherExitStep(NEW_WATCHER_EXIT_TRAIL, {
    code: 0,
    lifetimeMs: 900,
    reason: 'native-unavailable'
  })
  assert.deepEqual(first.log, {
    message: 'presence watcher exited unexpectedly',
    code: 0,
    lifetimeMs: 900,
    reason: 'native-unavailable'
  })
  // A watcher that was terminated, threw or was starved never got to say anything, and the entry
  // says so rather than inventing a reason.
  const silentDeath = watcherExitStep(NEW_WATCHER_EXIT_TRAIL, { code: 1, lifetimeMs: 40, reason: null })
  assert.equal(silentDeath.log?.reason, null)
  assert.equal(silentDeath.log?.lifetimeMs, 40)
})

test('N CONSECUTIVE IMMEDIATE EXITS COLLAPSE INTO ONE ENTRY, AND THEN THE STORE GOES QUIET', () => {
  const n = WATCHER_QUICK_EXIT_STREAK
  assert.ok(n >= 2, 'one fast clean exit is a one-off and must still be reported')
  // The reporter's session, at the length that produced 245 entries.
  const { logs, trail } = exitRun(Array.from({ length: 60 }, () => QUICK_EXIT))

  const written = logs.filter((l) => l !== null)
  assert.equal(written.length, n, `${String(n)} entries for a run of any length — not 60, not 245`)
  for (const l of written.slice(0, n - 1)) {
    assert.equal(l.message, 'presence watcher exited unexpectedly')
    assert.equal(l.name, undefined, 'the ordinary entries keep the identity the store already has')
  }
  const collapsed = written[n - 1]
  assert.equal(collapsed.name, WATCHER_EXIT_LOOP_ERROR_NAME)
  assert.equal(collapsed.exits, n)
  assert.match(collapsed.message, /exit loop/)
  assert.equal(collapsed.reason, 'native-unavailable', 'the diagnosis carries the watcher’s own word')
  assert.equal(trail.collapsed, true)
  assert.equal(trail.streak, n, 'the streak is held at N, so a day-long session cannot run it away')
})

test('THE COLLAPSED ENTRY IS ITS OWN FINGERPRINT — that is what makes it a new row', () => {
  // `errorFingerprint` hashes the error NAME and the top frames, never the message (shared/
  // errorReport.ts says why: a message-sensitive hash shatters one issue into singletons). So a
  // distinct diagnosis needs a distinct NAME, and `errorNameOf` is what reads it off the payload
  // `logError` is handed. Same capture site, same frames — only the name differs.
  const frames = parseStackFrames('    at handleWatcherGone (C:\\app\\out\\main\\index.js:900:11)')
  assert.equal(frames.length, 1, 'the capture site parses, or this test proves nothing')

  const { logs } = exitRun(Array.from({ length: WATCHER_QUICK_EXIT_STREAK }, () => QUICK_EXIT))
  const ordinary = logs[0]
  const collapsed = logs[WATCHER_QUICK_EXIT_STREAK - 1]
  assert.ok(ordinary && collapsed)

  const fp = (l: WatcherExitLog): string => errorFingerprint(errorNameOf(l.name), frames)
  assert.equal(errorNameOf(ordinary.name), 'Error', 'an unnamed payload keeps the old identity')
  assert.equal(errorNameOf(collapsed.name), WATCHER_EXIT_LOOP_ERROR_NAME)
  assert.notEqual(fp(ordinary), fp(collapsed))
  // And it is a DIFFERENT name from the one JOS-164 shipped, so the rows that describe a child
  // process which no longer exists stay distinguishable from the rows that describe this.
  assert.notEqual(WATCHER_EXIT_LOOP_ERROR_NAME, 'PresenceSelfReapLoop')
})

test('ONLY A CLEAN, IMMEDIATE EXIT COUNTS — a throw and a long healthy run both reset the trail', () => {
  const n = WATCHER_QUICK_EXIT_STREAK
  // A non-zero code is the watcher THROWING, which is a different story with a different fix.
  const crashes = exitRun(Array.from({ length: 20 }, () => ({ code: 1, lifetimeMs: 300 })))
  assert.equal(crashes.logs.filter((l) => l === null).length, 0, 'every crash is still reported')
  assert.equal(crashes.trail.streak, 0)

  // A watcher that outlived the staleness window was WORKING; whatever ended it is not this bug.
  const healthy = exitRun([{ code: 0, lifetimeMs: WATCHER_STALE_MS }])
  assert.equal(healthy.trail.streak, 0)
  assert.equal(healthy.logs[0]?.name, undefined)
  // …and the window is exclusive at its own edge, one ms below it and inside.
  assert.equal(exitRun([{ code: 0, lifetimeMs: WATCHER_STALE_MS - 1 }]).trail.streak, 1)

  // ONE GOOD RUN IN THE MIDDLE IS ENOUGH: the streak restarts, so the diagnosis never fires for a
  // machine that hiccups occasionally.
  const interrupted = exitRun([
    ...Array.from({ length: n - 1 }, () => QUICK_EXIT),
    { code: 0, lifetimeMs: WATCHER_STALE_MS * 2 },
    ...Array.from({ length: n - 1 }, () => QUICK_EXIT)
  ])
  assert.equal(
    interrupted.logs.filter((l) => l?.name === WATCHER_EXIT_LOOP_ERROR_NAME).length,
    0,
    'never diagnosed — the pattern was broken before it completed, twice'
  )
  assert.equal(interrupted.logs.filter((l) => l !== null).length, 2 * (n - 1) + 1)
})

test('A COLLAPSED RUN STARTS REPORTING AGAIN THE MOMENT THE PATTERN BREAKS', () => {
  // The quiet is about ONE repeating condition, not about the presence watcher forever. The next
  // genuinely different failure is a full entry again.
  const n = WATCHER_QUICK_EXIT_STREAK
  const { logs } = exitRun([
    ...Array.from({ length: n + 10 }, () => QUICK_EXIT),
    { code: 1, lifetimeMs: 50 },
    ...Array.from({ length: n }, () => QUICK_EXIT)
  ])
  const written = logs.filter((l) => l !== null)
  assert.equal(written.length, n + 1 + n)
  assert.equal(written[n].code, 1, 'the throw that broke the run')
  assert.equal(
    written.filter((l) => l.name === WATCHER_EXIT_LOOP_ERROR_NAME).length,
    2,
    'and the loop is diagnosed once per run of it, not once per session'
  )
})
