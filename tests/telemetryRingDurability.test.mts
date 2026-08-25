// ============================================================================
// telemetryRingDurability.test.mts — JOS-265: the local telemetry file survives its writers.
// ============================================================================
//
// THE DEFECT, read off the error store rather than guessed. `telemetry.json write failed` grew to
// ~350 occurrences across 0.18-0.23, and EVERY exemplar carries the same code: `ENOSPC`. The four
// largest 0.22 families — 0ae22c6118280de3 (~100, `recordEvent` under the error-report timer),
// 1a2752392e3f33db (29, `retireBatch` after a flush), c4e559b721fd8969 (28, the health timer),
// 7dbdfd323e09a8d8 (27, the heartbeat) — differ only in which caller was holding the pen. The
// volume is full. There is no EBUSY, no EPERM, no EACCES, no ENOENT anywhere in the set, so there
// is no lock to retry through and no missing directory to create; and with both writers being
// synchronous calls on the main process's one thread there was never an interleaving to serialise
// either. The suite therefore drives a FULL DISK, not a race.
//
// WHAT IS PINNED HERE, each one a thing 0.23 got wrong or did not do:
//
//   1. A failed write leaves NO scratch file behind. 0.23 left `telemetry.json.tmp` holding a
//      partial ring on the volume that had just reported it had no room — the single worst thing
//      to do to a full disk, and it was reclaimed only by a later successful write, which is
//      exactly the write that could not happen.
//   2. A failed write leaves the LIVE file exactly as it was. (0.23 got this right; it is pinned
//      because it is the property everything else is arranged around.)
//   3. The bytes are FLUSHED before the rename. 0.23 renamed a file that could still be entirely
//      in the page cache, which is how two installs came to file `telemetry.json parse failed;
//      starting empty` against a write that called itself atomic.
//   4. A writer that has just failed STOPS TOUCHING THE DISK for a spell. 0.23 re-ran the whole
//      cycle for every event and re-filed the failure each time; that is how one install produced
//      ~100 occurrences of one fingerprint, each of them also appending to `errors.log` on the
//      same full disk.
//   5. It comes back on its own. One success clears the pause completely.
//
// And two SOURCE pins on `ring.ts`, because the two rules that make (4) safe cannot be observed
// from outside a process with Electron in it: the in-memory ring is updated BEFORE the gate is
// consulted (so a pause costs persistence and never an event), and the failure payload keeps the
// exact message string the fleet's existing fingerprints were built from.
//
// No Electron and no network: this suite never skips. It writes into a real temp directory so the
// "what was left on disk" assertions are answered by the filesystem, and injects the failures
// through `DurableIo` because a genuinely full volume is not something a test may arrange.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWriteGate,
  nodeIo,
  nodeIoAsync,
  retryDelayMs,
  tempPathFor,
  writeFileDurable,
  writeFileDurableAsync,
  WRITE_RETRY_BASE_MS,
  WRITE_RETRY_MAX_MS,
  type AsyncDurableHandle,
  type AsyncDurableIo,
  type DurableIo
} from '../src/main/telemetry/durableWrite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A real, empty directory to write into. Removed by the test that made it. */
function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'eqc-ring-'))
}

/** The error a full volume throws, spelled the way `node:fs` spells it. */
function enospc(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device, write')
  err.code = 'ENOSPC'
  return err
}

/** Wrap the real io, recording the call order and optionally failing one step the way a full
 *  volume fails it — part of the data written, THEN the error. */
function io(record: string[], fail?: { at: keyof DurableIo; partial?: boolean }): DurableIo {
  const step =
    <K extends keyof DurableIo>(name: K, run: DurableIo[K]): DurableIo[K] =>
      ((...args: unknown[]) => {
        record.push(name)
        if (fail?.at === name) {
          if (fail.partial === true && name === 'write') {
            const [fd, data] = args as [number, string]
            nodeIo.write(fd, data.slice(0, Math.floor(data.length / 2)))
          }
          throw enospc()
        }
        return (run as (...a: unknown[]) => unknown)(...args)
      }) as DurableIo[K]
  return {
    mkdir: step('mkdir', nodeIo.mkdir),
    open: step('open', nodeIo.open),
    write: step('write', nodeIo.write),
    fsync: step('fsync', nodeIo.fsync),
    close: step('close', nodeIo.close),
    rename: step('rename', nodeIo.rename),
    remove: step('remove', nodeIo.remove)
  }
}

// ---- 1-3. THE WRITE ITSELF -------------------------------------------------------------------

test('THE FULL DISK: a write that runs out of space mid-file leaves no scratch file behind', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    writeFileDurable(dir, path, '{"version":1,"events":[],"lastBatch":null}', io([]))

    // Now the volume fills up half way through the next write — the ENOSPC exemplars' shape.
    const calls: string[] = []
    assert.throws(
      () => {
        writeFileDurable(dir, path, JSON.stringify({ version: 1, events: Array.from({ length: 200 }, (_, i) => i) }), io(calls, { at: 'write', partial: true }))
      },
      (err: NodeJS.ErrnoException) => err.code === 'ENOSPC'
    )

    // THE POINT: the partial temp is gone, so the bytes went back to the volume that has none.
    assert.equal(existsSync(tempPathFor(path)), false, 'the scratch file must not survive a failed write')
    assert.deepEqual(readdirSync(dir), ['telemetry.json'], 'nothing but the live file is left in userData')
    // And the descriptor was closed before the unlink was attempted — on Windows the unlink of an
    // open handle fails, so the ORDER is what makes the line above true, not a lucky platform.
    assert.ok(calls.indexOf('close') < calls.indexOf('remove'), `close must precede remove; got ${calls.join(',')}`)

    // AND THE LIVE FILE IS UNTOUCHED — still the last thing that was written whole.
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [], lastBatch: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE FULL DISK: a failed RENAME is survivable the same way', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    writeFileDurable(dir, path, '{"version":1,"events":[],"lastBatch":null}', io([]))
    assert.throws(() => {
      writeFileDurable(dir, path, '{"version":1,"events":[1,2,3],"lastBatch":null}', io([], { at: 'rename' }))
    })
    assert.equal(existsSync(tempPathFor(path)), false)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [], lastBatch: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE FLUSH: the bytes are forced out of the cache BEFORE the rename publishes them', () => {
  const dir = scratchDir()
  try {
    const calls: string[] = []
    const path = join(dir, 'telemetry.json')
    writeFileDurable(dir, path, '{"version":1}', io(calls))
    assert.deepEqual(calls, ['mkdir', 'open', 'write', 'fsync', 'close', 'rename'])
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1 })
    // Written whole, and the temp did not outlive the write.
    assert.deepEqual(readdirSync(dir), ['telemetry.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 4-5. THE STORM GATE ---------------------------------------------------------------------

test('THE STORM: after a failed write the ring stops touching the disk until the pause is up', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    const gate = createWriteGate()
    const calls: string[] = []
    const full = io(calls, { at: 'write' })

    // t=0: one attempt, one failure, one pause.
    let attempts = 0
    const attempt = (now: number, disk: DurableIo): boolean => {
      if (!gate.ready(now)) return false
      attempts += 1
      try {
        writeFileDurable(dir, path, '{"version":1,"events":[]}', disk)
        gate.succeeded()
        return true
      } catch {
        gate.failed(now)
        return false
      }
    }

    assert.equal(attempt(0, full), false)
    assert.equal(attempts, 1)

    // The heartbeat, the health report, the error report and a flush all record events over the
    // next half minute — 0.23 wrote (and re-filed) four more times. Now: not one syscall.
    const after = calls.length
    for (const t of [1_000, 5_000, 12_000, 29_999]) assert.equal(attempt(t, full), false)
    assert.equal(attempts, 1, 'a paused writer must not attempt the write at all')
    assert.equal(calls.length, after, 'a paused writer must not make a single fs call')

    // The pause expires; exactly one more attempt is spent, and it fails, so the next pause is
    // longer — the doubling that keeps a session-long ENOSPC from filing hundreds of occurrences.
    assert.equal(attempt(WRITE_RETRY_BASE_MS, full), false)
    assert.equal(attempts, 2)
    assert.equal(gate.failures(), 2)
    assert.equal(attempt(WRITE_RETRY_BASE_MS + 1, full), false)
    assert.equal(attempts, 2, 'the second pause is longer than the first, not equal to zero')

    // THE DISK IS FREED. The next attempt after the pause lands, and one success clears everything
    // — including the events that piled up in memory while the writes were paused.
    const t = WRITE_RETRY_BASE_MS + retryDelayMs(2)
    assert.equal(attempt(t, io(calls)), true)
    assert.equal(gate.failures(), 0)
    assert.equal(attempt(t + 1, io(calls)), true, 'a recovered writer is not still serving a pause')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE BACKOFF: 30s, 1m, 2m, 4m… and it stops doubling at the cap', () => {
  assert.equal(retryDelayMs(0), 0)
  assert.equal(retryDelayMs(-1), 0)
  assert.equal(retryDelayMs(1), 30_000)
  assert.equal(retryDelayMs(2), 60_000)
  assert.equal(retryDelayMs(3), 120_000)
  assert.equal(retryDelayMs(4), 240_000)
  assert.equal(retryDelayMs(5), 480_000)
  assert.equal(retryDelayMs(6), WRITE_RETRY_MAX_MS)
  // A session that has failed all day must not overflow into an infinite or negative wait.
  assert.equal(retryDelayMs(2000), WRITE_RETRY_MAX_MS)
  assert.equal(retryDelayMs(Number.MAX_SAFE_INTEGER), WRITE_RETRY_MAX_MS)
})

test('THE PAUSE IS ANNOUNCED ONCE: only the success that ENDS one says so', () => {
  const gate = createWriteGate()
  assert.equal(gate.succeeded(), false, 'a writer that never failed has no recovery to narrate')
  gate.failed(0)
  assert.equal(gate.succeeded(), true)
  assert.equal(gate.succeeded(), false)
  // And the switch being flipped forgets the pause outright (`dropRing`).
  gate.failed(0)
  assert.equal(gate.ready(1), false)
  gate.reset()
  assert.equal(gate.ready(1), true)
  assert.equal(gate.failures(), 0)
})

// ---- 6. THE SAME WRITE, OFF THE MAIN THREAD (JOS-371) ----------------------------------------
//
// The whole of JOS-265 above holds only if the ASYNC writer that replaced the sync one on the live
// path makes the same four promises. It is asserted the same way — a real temp directory, failures
// injected step by step — because a durability argument that is only made about the version nobody
// runs is not an argument.

/** Which async step to fail, and how. The async io has no separate `write`/`fsync`/`close` methods
 *  (an async fsync needs the HANDLE, not a descriptor), so the step names live on the handle. */
type AsyncStep = 'mkdir' | 'open' | 'write' | 'sync' | 'close' | 'rename' | 'remove'

/** The async twin of `io()` above: record the call order, optionally fail one step the way a full
 *  volume fails it (part of the data written, THEN the error). */
function ioAsync(record: string[], fail?: { at: AsyncStep; partial?: boolean }): AsyncDurableIo {
  const guard = async (name: AsyncStep): Promise<void> => {
    record.push(name)
    if (fail?.at === name) throw enospc()
  }
  return {
    mkdir: async (dir) => {
      await guard('mkdir')
      await nodeIoAsync.mkdir(dir)
    },
    open: async (path) => {
      await guard('open')
      const real = await nodeIoAsync.open(path)
      const wrapped: AsyncDurableHandle = {
        write: async (data) => {
          record.push('write')
          if (fail?.at === 'write') {
            if (fail.partial === true) await real.write(data.slice(0, Math.floor(data.length / 2)))
            throw enospc()
          }
          await real.write(data)
        },
        sync: async () => {
          await guard('sync')
          await real.sync()
        },
        close: async () => {
          record.push('close')
          await real.close()
          if (fail?.at === 'close') throw enospc()
        }
      }
      return wrapped
    },
    rename: async (from, to) => {
      await guard('rename')
      await nodeIoAsync.rename(from, to)
    },
    remove: async (path) => {
      await guard('remove')
      await nodeIoAsync.remove(path)
    }
  }
}

test('OFF THE THREAD: a write that runs out of space mid-file still leaves no scratch behind', async () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    await writeFileDurableAsync(dir, path, '{"version":1,"events":[],"lastBatch":null}', ioAsync([]))

    const calls: string[] = []
    await assert.rejects(
      writeFileDurableAsync(
        dir,
        path,
        JSON.stringify({ version: 1, events: Array.from({ length: 200 }, (_, i) => i) }),
        ioAsync(calls, { at: 'write', partial: true })
      ),
      (err: NodeJS.ErrnoException) => err.code === 'ENOSPC'
    )
    assert.equal(existsSync(tempPathFor(path)), false, 'the scratch file must not survive a failed write')
    assert.deepEqual(readdirSync(dir), ['telemetry.json'])
    assert.ok(calls.indexOf('close') < calls.indexOf('remove'), `close must precede remove; got ${calls.join(',')}`)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [], lastBatch: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OFF THE THREAD: a failed RENAME is survivable the same way', async () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    await writeFileDurableAsync(dir, path, '{"version":1,"events":[],"lastBatch":null}', ioAsync([]))
    await assert.rejects(
      writeFileDurableAsync(dir, path, '{"version":1,"events":[1,2,3],"lastBatch":null}', ioAsync([], { at: 'rename' }))
    )
    assert.equal(existsSync(tempPathFor(path)), false)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [], lastBatch: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OFF THE THREAD: the fsync did NOT go away — it flushes before the rename, exactly as before', async () => {
  const dir = scratchDir()
  try {
    const calls: string[] = []
    const path = join(dir, 'telemetry.json')
    await writeFileDurableAsync(dir, path, '{"version":1}', ioAsync(calls))
    // The sync writer's order, step for step. `sync` is `fsync(2)` through the FileHandle; what
    // changed is the thread it runs on, never that it runs.
    assert.deepEqual(calls, ['mkdir', 'open', 'write', 'sync', 'close', 'rename'])
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1 })
    assert.deepEqual(readdirSync(dir), ['telemetry.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OFF THE THREAD: the real async io writes a whole file through a real FileHandle', async () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    await writeFileDurableAsync(dir, path, '{"version":1,"events":[7],"lastBatch":null}')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [7], lastBatch: null })
    assert.deepEqual(readdirSync(dir), ['telemetry.json'], 'no scratch file outlives a good write')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 7. THE TWO RULES THAT LIVE IN ring.ts ---------------------------------------------------

const RING_SRC = readFileSync(join(ROOT, 'src', 'main', 'telemetry', 'ring.ts'), 'utf8')

test('MEMORY FIRST: writeRing updates the cache BEFORE it consults the gate', () => {
  const body = RING_SRC.slice(RING_SRC.indexOf('export function writeRing'))
  const cacheAt = body.indexOf('cached = next')
  const gateAt = body.indexOf('writeGate.ready')
  assert.ok(cacheAt > 0 && gateAt > 0, 'writeRing must set the cache and ask the gate')
  assert.ok(
    cacheAt < gateAt,
    'a skipped write may cost persistence and NEVER an event: the ring in memory is updated first'
  )
})

test('ONE WRITE IN FLIGHT: the async ring writer serialises itself and coalesces what is owed', () => {
  // The sync writer got serialisation for free — a sync call cannot interleave. Two async ones can,
  // and two interleaved writers share ONE `.tmp` path, so the second would rename a scratch file
  // the first is still filling. `writing` is the latch; `owed` is the coalescing, and REPLACING
  // rather than queueing is correct because a ring write is the whole file and the newest ring
  // already contains every event an older one had.
  assert.match(RING_SRC, /let writing = false/)
  assert.match(RING_SRC, /let owed: \{ data: string; now: number \} \| null = null/)
  const body = RING_SRC.slice(RING_SRC.indexOf('export function writeRing'), RING_SRC.indexOf('export function flushRingSync'))
  assert.ok(body.indexOf('writeGate.ready(now)') < body.indexOf('owed = {'), 'the gate is still asked before a byte is touched')
  assert.match(body, /if \(writing\) return\r?\n {2}writing = true\r?\n {2}void drainWrites\(\)/)
  // …and there is exactly ONE caller of the async durable write in the file: the drain.
  assert.equal(RING_SRC.match(/writeFileDurableAsync\(/g)?.length, 1)
})

test('THE QUIT FINAL: the one sync write left in the ring, and a drop outlives an in-flight write', () => {
  // `sessionEnd` is recorded as the last window closes; an async write scheduled at that moment is
  // one the process may never turn the event loop for again. `flushRingSync` is the documented
  // final — the ONLY synchronous durable write left here — and it respects the same gate.
  assert.equal(RING_SRC.match(/writeFileDurableFinal\(/g)?.length, 1)
  const flush = RING_SRC.slice(RING_SRC.indexOf('export function flushRingSync'))
  assert.ok(flush.indexOf('if (owed === null) return') < flush.indexOf('writeFileDurableFinal('))
  assert.match(flush, /if \(!writeGate\.ready\(now\)\) return/)
  // NEVER A TORN FILE TO BUY A LAST RECORD: it writes through its OWN scratch file, so it can run
  // on top of a threadpool write without two writers ever filling one temp.
  // A drop cannot cancel a write already in the threadpool, so it discards what is owed and asks
  // the drain to delete again on its way out — the file must not come back after "turn it off".
  const drop = RING_SRC.slice(RING_SRC.indexOf('export function dropRing'), RING_SRC.indexOf('export function resetRingCache'))
  assert.match(drop, /owed = null/)
  assert.match(drop, /if \(writing\) dropDuringWrite = true/)
  assert.match(RING_SRC, /if \(dropDuringWrite\) \{\r?\n {4}dropDuringWrite = false\r?\n {4}removeRingFiles\(\)/)
})

test('THE FINGERPRINT SURVIVES THE FIX: the failure message is unchanged, character for character', () => {
  // The error store aggregates on the message plus the frames. Rewording this line would split
  // ~350 filed occurrences from everything the fix files next, and the triage loop would be
  // reading two half-histories. Anything that varies per occurrence goes to the console instead.
  assert.ok(RING_SRC.includes("{ message: 'telemetry.json write failed', err }"))
  assert.ok(
    !/message: `telemetry\.json write failed/.test(RING_SRC),
    'the failure message must stay a literal — no interpolated counts, delays or codes'
  )
})
