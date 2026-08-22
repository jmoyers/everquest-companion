// THE `/outputfile` WATCHERS, AGAINST A REAL DIRECTORY (JOS-431).
//
// Every other half of the outputs registry is pure and is pinned without a disk
// (tests/outputsRegistry.test.mts). This half cannot be: the subject IS what chokidar reports when
// a file on a real filesystem is written, deleted and written again, and a fake that answers with
// the events we hope for would pass on exactly the day the real one stopped sending them. So this
// file drives a temp directory and asserts on the handlers the registry hangs its behavior off.
//
// THE REPORT (01M0FMGA4DQRMG46290GWVVHQ6, v1.6.0). The player re-ran `/outputfile inventory` and
// the app kept showing a days-old timestamp until it was restarted. The file was demonstrably
// fresh — their log named the write to the second and the attached dump's mtime matched it — so
// the miss was ours, and it was here: `watchOutputFile` subscribed to `change` ALONE. An in-place
// rewrite is a `change`; a rewrite that REPLACES the file is `unlink` followed by `add`, and both
// of those were dropped without a listener to hear them.
//
// SO THE THREE EVENTS ARE THREE PROMISES, and they are asserted separately because the registry
// uses them for three different things: `change` is the ordinary rewrite, `add` is the file coming
// back, and `unlink` is the signal to re-arm on whatever is there now.
//
// AND WHAT THE DISK ACTUALLY SAYS, MEASURED HERE RATHER THAN ASSUMED — it is not what the ticket
// predicted, and the difference is why the code is shaped the way it is:
//   * On this platform a delete-and-recreate reaches a SINGLE-FILE watcher as a `change`, because
//     chokidar re-arms on the file's return by itself. That path is conditional inside chokidar
//     and platform-specific, so it is exactly the kind of thing that holds on a dev machine and
//     not on a reporter's; the file watcher now listens to all three events and stops depending
//     on which one arrives.
//   * On a DIRECTORY watcher the same fast replace collapses into one `change` on a file it never
//     stopped tracking, and only a deletion it has processed turns the return into an `add`.
// The directory watcher therefore keeps its one job — an APPEARANCE — and does not subscribe to
// `change`: the file watcher already covers rewrites, and a second subscription to the same event
// would double every reload the app performs.
//
// WHY THE WAITS ARE GENEROUS. `awaitWriteFinish` holds every add/change until the size has been
// stable for 400 ms (watch.ts), so the honest floor for one assertion is half a second and the
// ceiling is whatever a loaded CI machine does to a poll interval. These waits are for a failure
// to be a FAILURE rather than a flake; a passing run does not spend them.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { FSWatcher } from 'chokidar'
import { watchForOutputFile, watchOutputFile } from '../src/main/outputs/watch'
import { outputKind } from '../src/shared/outputs/kinds'

const INVENTORY = outputKind('inventory')
/** The name a real `/outputfile inventory` writes on the dev machine, verbatim. */
const DUMP = 'Primitive_freeport-Inventory.txt'
/** Long enough that a real miss is a failure rather than a slow machine (see the header). */
const WAIT_MS = 8_000

/** A dated line of dump, so a rewrite changes the file's SIZE and not only its mtime. */
function dumpText(rows: number): string {
  return `Location\tName\tID\tCount\tSlots\n${Array.from(
    { length: rows },
    (_, i) => `General${String(i)}\tItem ${String(i)}\t${String(1000 + i)}\t1\t0`
  ).join('\n')}\n`
}

/**
 * A recorder for one watcher's handlers: what fired, and a promise per event that a step can wait
 * on. `next('change')` resolves on the NEXT change, so a step arms its wait before it acts and can
 * never lose a race with a watcher that is faster than the assertion.
 */
interface Recorder {
  changes: number
  gone: number
  errors: unknown[]
  next: (event: 'change' | 'gone') => Promise<void>
  handlers: { onChange: () => void; onGone: () => void; onError: (e: unknown) => void }
}

function recorder(): Recorder {
  let waiters: { event: 'change' | 'gone'; resolve: () => void }[] = []
  const fire = (event: 'change' | 'gone'): void => {
    for (const w of waiters) if (w.event === event) w.resolve()
    // Only the waiters that were just answered leave. A step that is proving an event does NOT
    // arrive holds a waiter across other events, and clearing the whole list would quietly turn
    // that proof into a coincidence.
    waiters = waiters.filter((w) => w.event !== event)
  }
  const rec: Recorder = {
    changes: 0,
    gone: 0,
    errors: [],
    next: (event) =>
      new Promise<void>((resolve) => {
        waiters.push({ event, resolve })
      }),
    handlers: {
      onChange: () => {
        rec.changes += 1
        fire('change')
      },
      onGone: () => {
        rec.gone += 1
        fire('gone')
      },
      onError: (e) => rec.errors.push(e)
    }
  }
  return rec
}

/** Resolve to true if `p` settled inside `WAIT_MS` — a timeout is an assertion, never a hang. */
function within(p: Promise<void>, ms = WAIT_MS): Promise<boolean> {
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())
  ])
}

/** chokidar is asynchronous about arming; nothing may be written until it says it is watching. */
function ready(watcher: FSWatcher): Promise<void> {
  return new Promise<void>((resolve) => {
    watcher.on('ready', () => resolve())
  })
}

/**
 * One temp EQ install root, and the teardown that must run WHATEVER the test did.
 *
 * A watcher is handed over as it is created (`arm`) rather than returned at the end, and that is
 * not a style choice: a failed assertion throws past any return, the watcher is then never closed,
 * its handle keeps the loop alive, and node's runner sits there until the outer timeout kills it.
 * Registering on creation turns every failure back into a failure instead of a hang.
 */
async function withRoot(
  run: (root: string, arm: (w: FSWatcher) => FSWatcher) => Promise<void>
): Promise<void> {
  // `realpathSync.native` because of WHERE CI puts its temp dir: `C:\Users\RUNNER~1\…` is an 8.3
  // short name, the events come back under the LONG name, and libuv's prefix assertion
  // (`src\win\fs-event.c:72`, run 32447274260) aborts the whole test process on the mismatch.
  // Resolving to the long form before anything watches it is the canonical workaround; a dev
  // machine's temp path is already long-form, which is why this only ever died on CI.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'eqc-outputs-watch-')))
  const watchers: FSWatcher[] = []
  try {
    await run(root, (w) => {
      watchers.push(w)
      return w
    })
  } finally {
    await Promise.all(watchers.map((w) => w.close()))
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// THE SINGLE-FILE WATCHER
// ---------------------------------------------------------------------------

test('an in-place rewrite is still one change — the event this always handled', async () => {
  await withRoot(async (root, arm) => {
    const path = join(root, DUMP)
    writeFileSync(path, dumpText(3))
    const rec = recorder()
    const watcher = arm(watchOutputFile(path, rec.handlers))
    await ready(watcher)

    const heard = rec.next('change')
    writeFileSync(path, dumpText(40))
    assert.equal(await within(heard), true, 'the rewrite was reported')
    assert.equal(rec.errors.length, 0)
  })
})

test('a delete-and-recreate rewrite is reported, and is not one silent unlink', async () => {
  // THE REPORTED FAILURE, as small as it goes. Before JOS-431 this watcher heard neither half of
  // the pair, so the app's model of the dump stayed on the version from before the player typed
  // the command — for the rest of the session, which is what a restart "fixed".
  await withRoot(async (root, arm) => {
    const path = join(root, DUMP)
    writeFileSync(path, dumpText(3))
    const rec = recorder()
    const watcher = arm(watchOutputFile(path, rec.handlers))
    await ready(watcher)

    const vanished = rec.next('gone')
    unlinkSync(path)
    assert.equal(await within(vanished), true, 'the deletion reached onGone')
    // That handler is the registry's cue to re-arm (registry.ts `armFile`), and it is asserted on
    // its own because the re-arm is the part that does not depend on this watcher surviving the
    // deletion of its own subject.
    assert.equal(rec.gone, 1)

    const heard = rec.next('change')
    writeFileSync(path, dumpText(60))
    assert.equal(await within(heard), true, 'the recreated dump was reported as news')
    assert.equal(rec.errors.length, 0)
  })
})

// ---------------------------------------------------------------------------
// THE DIRECTORY WATCHER — the second witness, armed for the whole watch since JOS-431
// ---------------------------------------------------------------------------

test('the directory watcher sees a dump appear, first ever or after a deletion', async () => {
  await withRoot(async (root, arm) => {
    const rec = recorder()
    const watcher = arm(watchForOutputFile(root, INVENTORY, rec.handlers))
    await ready(watcher)

    // THE FIRST WRITE — a machine where `/outputfile inventory` has never been run. This is the
    // case the directory watcher was added for (JOS-44) and it is unchanged.
    const first = rec.next('change')
    const path = join(root, DUMP)
    writeFileSync(path, dumpText(5))
    assert.equal(await within(first), true, 'the first dump was reported')

    // AND AN APPEARANCE THAT IS NOT THE FIRST. This is what JOS-431 keeps this watcher alive FOR:
    // it used to be torn down the moment a file matched, so the only appearance it could ever
    // report was the first one on the machine. Now it outlives every re-arm — which is how the
    // ACTIVE character's own dump gets noticed while the file watcher is parked on somebody
    // else's (registry.ts states that case; it is the same `add` as this one).
    const again = rec.next('change')
    unlinkSync(path)
    // The pause is LOAD-BEARING, and it is the measurement in the header: a delete and a recreate
    // in the same tick reach a directory watcher that still tracks the file as one `change`, and
    // only a deletion this watcher has actually processed makes the return an `add`. Waiting for
    // the deletion to be a non-event is therefore also how the `add` under test is guaranteed.
    assert.equal(await within(rec.next('gone'), 2_000), false, 'a deletion is not this watcher’s news')
    writeFileSync(path, dumpText(90))
    assert.equal(await within(again), true, 'the dump that came back was reported')
    assert.equal(rec.errors.length, 0)
  })
})

test('the directory watcher stays out of every other file in the install root', async () => {
  // Depth 0 on the EQ install root means this watcher is sitting in a directory full of files the
  // app has no business reacting to. `isOutputFileName` is the whole filter, and a dump belonging
  // to a DIFFERENT kind is the near miss worth pinning — a suffix rule that matched loosely would
  // have the inventory model re-read on a guild dump.
  await withRoot(async (root, arm) => {
    const rec = recorder()
    const watcher = arm(watchForOutputFile(root, INVENTORY, rec.handlers))
    await ready(watcher)

    writeFileSync(join(root, 'eqclient.ini'), 'ScreenMode=2\n')
    writeFileSync(join(root, 'Primitive_freeport-Guild.txt'), dumpText(4))
    writeFileSync(join(root, 'Inventory.txt'), dumpText(4))
    assert.equal(await within(rec.next('change'), 2_500), false, 'none of those were ours')

    // …and the real one still is, in the same directory that just failed to move it.
    const ours = rec.next('change')
    writeFileSync(join(root, DUMP), dumpText(7))
    assert.equal(await within(ours), true, 'the kind’s own dump is still reported')
    assert.equal(rec.errors.length, 0)
  })
})
