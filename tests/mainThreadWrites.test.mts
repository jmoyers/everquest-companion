// ============================================================================
// mainThreadWrites.test.mts — JOS-371: nothing this app writes on a live path blocks main.
// ============================================================================
//
// THE SHAPE OF THE DEFECT. Every one of these was a synchronous file write on the main process's
// one thread, on a path that runs for as long as the app is open:
//
//   * `errorLog.ts` — `appendFileSync` + `statSync` PER LINE, on the app's error path.
//   * `telemetry/ring.ts` — a temp+fsync+rename per recorded event, up to every 5 minutes.
//   * `data/overlayPersistence.ts` — the same, every 60 seconds, from session.ts's tick.
//   * `resist/ledgerFile.ts` — the same, on the resist module's own tick.
//
// A main-thread stall is bad on its own; while one of this app's overlays holds the mouse it is a
// SYSTEM-WIDE stall, and every one of these widened the "us" half of the live-stall verdict. An
// fsync is precisely the syscall that goes from microseconds to milliseconds on a busy or full
// volume — which is the volume all of this machinery exists for in the first place.
//
// WHAT IS PINNED HERE is the LAW rather than any one mechanism (each mechanism is driven for real
// in its own suite: tests/errorFlood, tests/telemetryRingDurability, tests/resistLedgerDurability):
//
//   1. Each of the four live-path writers reaches disk asynchronously.
//   2. Each SYNC survivor is a named, documented final — the quit path or the crash guard — and
//      there are no others hiding in those files.
//   3. `storeFile.ts` is the OVERTURN, and it is asserted so that nobody re-opens it by accident:
//      that module runs once per launch before `new Store()` and is not on a live path at all, and
//      a routine `store.set` never comes through it (conf's own `atomically` writer does that job,
//      inside node_modules, where this repo cannot move it off the thread by editing its source).
//
// Source pins, not behaviour: three of the four modules import `electron` and cannot be loaded
// outside it, so this suite reads the tree — the technique tests/healthCounters.test.mts uses on
// the same kind of wiring, and for the same honest reason. No Electron, never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The one dependency this suite reads out of node_modules. RESOLVED, never joined (AGENTS.md's
// law): a git worktree has no local install, and a joined path ENOENTs there while the resolver
// walks up to the install tsx itself loaded from — two workers hit exactly that in one day.
const require = createRequire(import.meta.url)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/** Every `*Sync(` call that WRITES — the set the acceptance criterion names, plus the rename a
 *  temp+rename write ends with. Reads and `mkdirSync` are not what stalls a live path. */
const WRITING_SYNC = /\b(appendFileSync|writeFileSync|fsyncSync|renameSync|copyFileSync|truncateSync)\s*\(/g

/** How many synchronous WRITE calls a file makes. */
function syncWrites(src: string): string[] {
  return src.match(WRITING_SYNC)?.map((s) => s.replace(/\s*\($/, '')) ?? []
}

test('THE FOUR LIVE-PATH WRITERS all reach disk asynchronously', () => {
  // The error log: one queue, one drain, one batched append.
  assert.match(read('src/main/errorLog.ts'), /await appendFile\(path,/)
  // The three durable writers, through the one async temp+fsync+rename this repo owns.
  for (const file of [
    'src/main/telemetry/ring.ts',
    'src/main/data/overlayPersistence.ts',
    'src/main/resist/ledgerFile.ts'
  ]) {
    assert.match(read(file), /writeFileDurableAsync\(/, `${file} writes through the async door`)
  }
  // …and the async door really is the same write: temp, FSYNC, rename, in that order. The fsync is
  // the point (JOS-265) and an async conversion that quietly dropped it would be a downgrade
  // wearing a performance ticket's name.
  const durable = read('src/main/telemetry/durableWrite.ts')
  const body = durable.slice(durable.indexOf('export async function writeFileDurableAsync'))
  const order = ['io.mkdir(dir)', 'io.open(tmp)', 'fh.write(data)', 'fh.sync()', 'fh.close()', 'io.rename(tmp, path)']
  let at = -1
  for (const step of order) {
    const next = body.indexOf(step)
    assert.ok(next > at, `${step} must follow the step before it`)
    at = next
  }
})

test('THE ITEM-KNOWLEDGE CACHE writes atomically and off the thread, on its existing debounce', () => {
  // This one was not just synchronous, it was a bare `writeFileSync` onto the LIVE path — which
  // truncates first, so a process killed mid-write left a torn file that `loadCache` reads as an
  // EMPTY one. The async durable write cannot produce that, and the debounce that was already
  // there is what serialises it.
  const src = read('src/main/itemLookup.ts')
  assert.equal(/\bwriteFileSync\s*\(/.test(src), false, 'no bare truncating write on a live path')
  assert.match(src, /void writeFileDurableAsync\(dirname\(path\), path,/)
  assert.match(src, /let saving = false/)
  assert.match(src, /if \(saving\) \{/, 'a save asked for mid-write re-arms rather than racing the temp')

  // …and the three DERIVED indexes this module used to build during main's module evaluation are
  // built on first use now, which is only ever a live lookup — see the file's own header for the
  // measurement and for why the 8.6 MB corpus itself cannot leave from here.
  for (const lazy of ['function itemDb(', 'function poskyByItem(', 'function questsByItem(']) {
    assert.ok(src.includes(lazy), `${lazy} must be a function, not a module-scope constant`)
  }
})

test('THE MOB-KNOWLEDGE CACHE writes atomically and off the thread, on its existing debounce', () => {
  // JOS-460: mobLookup.ts was written field for field against itemLookup.ts and inherited the same
  // defect — a bare `writeFileSync` onto the LIVE path, which truncates first, so a process killed
  // mid-write left a torn file that `loadCache` reads as an EMPTY one: every mob this install ever
  // resolved, silently gone. Same fix, same shape, asserted the same way.
  const src = read('src/main/mobLookup.ts')
  assert.equal(/\bwriteFileSync\s*\(/.test(src), false, 'no bare truncating write on a live path')
  assert.match(src, /void writeFileDurableAsync\(dirname\(path\), path,/)
  assert.match(src, /let saving = false/)
  assert.match(src, /if \(saving\) \{/, 'a save asked for mid-write re-arms rather than racing the temp')
})

test('EVERY SYNC SURVIVOR ON THESE PATHS IS A NAMED FINAL, and there are no others', () => {
  // errorLog: one appendFileSync + one writeFileSync, both inside `flushErrorLogSync`.
  const errorLog = read('src/main/errorLog.ts')
  assert.deepEqual(syncWrites(errorLog).sort(), ['appendFileSync', 'writeFileSync'])
  const flush = errorLog.slice(errorLog.indexOf('export function flushErrorLogSync('))
  assert.deepEqual(syncWrites(flush).sort(), ['appendFileSync', 'writeFileSync'], 'both live in the final')

  // ring: no raw sync write at all, and the ONE synchronous durable write is the quit final's.
  const ring = read('src/main/telemetry/ring.ts')
  assert.deepEqual(syncWrites(ring), [])
  const ringFinal = ring.slice(ring.indexOf('export function flushRingSync('))
  assert.match(ringFinal, /writeFileDurableFinal\(/)
  assert.equal(ring.match(/writeFileDurableFinal\(/g)?.length, 1, 'exactly one sync durable write')

  // overlay: the same shape — one sync durable write, inside the quit final.
  const overlay = read('src/main/data/overlayPersistence.ts')
  assert.deepEqual(syncWrites(overlay), [])
  const overlayFinal = overlay.slice(overlay.indexOf('export function saveUserOverlaySync('))
  assert.match(overlayFinal, /writeFileDurableFinal\(/)
  assert.equal(overlay.match(/writeFileDurableFinal\(/g)?.length, 1)
})

test('A QUIT FINAL WRITES THROUGH ITS OWN SCRATCH FILE — never a torn file for a last record', () => {
  // A final can run while a write is still in libuv's threadpool, and two writers sharing one
  // `.tmp` is two of them filling one scratch file with one renaming mid-fill — the exact failure
  // temp+fsync+rename exists to prevent. Two scratch paths remove the hazard outright: whichever
  // rename lands last publishes a COMPLETE file, and the loser's bytes were complete too.
  const durable = read('src/main/telemetry/durableWrite.ts')
  assert.match(durable, /export const FINAL_TEMP_TAG = 'quit'/)
  assert.match(durable, /tmp: tempPathFor\(path, FINAL_TEMP_TAG\)/)
  assert.match(durable, /export function tempPathFor\(path: string, tag\?: string\)/)
  // And whoever deletes the plain temp deletes the tagged one — "off" that leaves events in a
  // sibling file is the switch lying in a different filename.
  const ring = read('src/main/telemetry/ring.ts')
  const remove = ring.slice(ring.indexOf('function removeRingFiles('), ring.indexOf('export function dropRing('))
  assert.match(remove, /rmSync\(tempPathFor\(path\), \{ force: true \}\)/)
  assert.match(remove, /rmSync\(tempPathFor\(path, FINAL_TEMP_TAG\), \{ force: true \}\)/)
  // The two writers that CAN be dropped are dropped instead of racing: the overlay's periodic saver
  // and the ledger's writer both refuse while one is in flight, and both losses are bounded by a
  // cadence that was already their accepted loss.
  // THE IN-FLIGHT LATCH IS NOW THE SECOND GUARD, NOT THE FIRST (JOS-497 item 2). The ownership
  // question comes before it and asks something different: `writing` is "is THIS process mid-write",
  // and `appOwnsArtifacts()` is "does this process write this file at all on this launch" — under
  // serve the engine owns `message-overlay.json`. Both are still here and the drop-rather-than-queue
  // claim this test makes is untouched; only the order changed, so the pin is widened to allow the
  // ownership guard in front rather than loosened to stop checking.
  assert.match(
    read('src/main/data/overlayPersistence.ts'),
    /export function saveUserOverlay\(register: OverlayRegister\): void \{\r?\n {2}if \(!appOwnsArtifacts\(\)\) return\r?\n {2}if \(writing\) return/
  )
  assert.match(read('src/main/resist/ledgerFile.ts'), /if \(writing\) return \{ status: 'busy' \}/)
})

test('WHAT IS OWED STAYS OWED UNTIL THE BYTES ARE DOWN — the quit final must have something to write', () => {
  // MEASURED THE HARD WAY. The drain first cleared `owed` on the way IN, which looked equivalent
  // and was not: `drainWrites()` runs synchronously up to its first `await`, so a `writeRing`
  // during `window-all-closed` emptied `owed` in the same tick, `before-quit` found nothing
  // outstanding, and the process exited before the threadpool write landed. The telemetry e2e's
  // restart assertions went red on exactly that — the heartbeat's records never reached disk.
  const ring = read('src/main/telemetry/ring.ts')
  const drain = ring.slice(ring.indexOf('async function drainWrites('), ring.indexOf('export function writeRing('))
  assert.match(drain, /const pending = owed/)
  assert.equal(drain.match(/if \(owed === pending\) owed = null/g)?.length, 2, 'discharged on both settle arms')
  assert.ok(
    drain.indexOf('await writeFileDurableAsync') < drain.indexOf('if (owed === pending) owed = null'),
    'owed is discharged AFTER the bytes are down, never before'
  )
})

test('THE FINALS ARE WIRED WHERE THE APP ACTUALLY ENDS', () => {
  const index = read('src/main/index.ts')
  const beforeQuit = index.slice(index.indexOf("app.on('before-quit'"))
  const body = beforeQuit.slice(0, beforeQuit.indexOf('\n})'))
  // The ring's final and the error log's, on the ONE event every quit path reaches — an
  // auto-updater's `quitAndInstall` and an OS logoff never emit `window-all-closed`.
  assert.match(body, /flushRingSync/)
  assert.match(body, /flushErrorLogSync\(\)/)
  // The error log goes LAST, so a line any step above it just wrote is in the batch.
  assert.ok(body.lastIndexOf('flushErrorLogSync()') > body.indexOf('flushRingSync'))
  // THE OVERLAY REGISTER HAS NO APP-SIDE FINAL ANY MORE (JOS-499, boundary verdict 4). Both its
  // writers lived here — the quit-time `saveUserOverlaySync` teardown step and the 60-tick
  // `saveUserOverlay` rider on session.ts's heartbeat — and both read the register off this
  // process's buffs module. The ENGINE owns that file now, so the honest assertion inverts:
  // nothing here may write it, because writing one at quit would be this process publishing an
  // empty opinion over the file the engine has been maintaining, at the one moment nothing is
  // left to correct it.
  assert.doesNotMatch(index, /saveUserOverlaySync\(/)
  assert.doesNotMatch(read('src/main/session.ts'), /saveUserOverlay\(/)
})

test('THE OVERTURN: storeFile.ts is not on a live path, and a settings write never comes through it', () => {
  // The premise JOS-371 was briefed on was that the settings store writes synchronously on every
  // settings change. It does not, and this is the evidence, asserted so the question stays answered.
  //
  // (a) `migrateStoreFile` runs ONCE per launch, from store.ts's module scope, BEFORE `new Store()`
  //     — which is the settings-migration law itself (no reader may see a pre-migration shape). It
  //     is finished long before `dataLoaded`, let alone `replayDone`.
  const storeSrc = read('src/main/store.ts')
  const migrateAt = storeSrc.indexOf('migrateStoreFile(join(USER_DATA')
  const constructAt = storeSrc.indexOf('new Store<StoreShape>(')
  assert.ok(migrateAt > 0 && constructAt > 0)
  assert.ok(migrateAt < constructAt, 'the migration runs before the store is constructed')
  assert.equal(storeSrc.match(/migrateStoreFile\(/g)?.length, 1, 'once per launch, from module scope')

  // (b) A routine `store.set(...)` is electron-store's write, and conf has gone through the
  //     `atomically` package since v10. That writer is `atomically.writeFileSync` inside
  //     node_modules — not something this repo moves off the thread by editing its own source.
  const conf = readFileSync(require.resolve('conf/dist/source/index.js'), 'utf8')
  assert.match(conf, /atomically\.writeFileSync\(/, 'conf still writes the settings file synchronously')
  assert.equal(/\bwriteFileSync\s*\(/.test(read('src/main/storeFile.ts')), false, 'and storeFile is not that writer')

  // (c) …so the sync calls in storeFile.ts stay, and the file says why in its own header. This
  //     assertion exists so a later reader finds the argument instead of re-opening the ticket.
  const file = read('src/main/storeFile.ts')
  assert.match(file, /STILL SYNCHRONOUS, ON PURPOSE \(JOS-371/)
  assert.match(file, /THIS MODULE RUNS EXACTLY ONCE PER LAUNCH/)
  assert.match(file, /A ROUTINE SETTINGS WRITE NEVER COMES THROUGH HERE/)
})
