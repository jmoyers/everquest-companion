// JOS-457 — RAPID CHARACTER SWITCHES: ONE PREEMPTABLE REPLAY, SILENT UNTIL LIVE.
//
// THE DEFECT (owner, live, 2026-08-23): switching back and forth quickly between characters via the
// dropdown effectively CRASHES the app — it locks up, shows random encounters, and plays random
// audio alerts while stuck in a pseudo-loading state.
//
// THE MECHANISM. `session.ts tailCharacter` is the one seam every switch funnels through and it had
// no single-flight guard and no abort, so N quick picks ran N whole-log folds CONCURRENTLY on the
// main process. They interleaved at every `await`: one call's `resetWorldFor` wiped the world
// another was still folding into (the random encounters), and the replay bracket and the replay
// gate were one boolean each with NO OWNER, so the first fold to finish re-opened the push path
// while months of somebody else's history were still to fold — and every celebration detector reads
// an increment as news (the random audio).
//
// WHAT THIS FILE PINS, and it is the load-bearing half: the SEAM, driven for real. The switch
// generation (main/switchController.ts), the fold's abort (`ScanOptions.cancelled` through
// scanHistory.ts + replaySlicer.ts), the registry's replay bracket and the replay gate are all the
// shipping modules, folding real files off disk through the real parser and the real bus. No
// Electron, no mocks of the things under test.
//
// WHAT IT CANNOT PIN, said plainly: `session.ts` itself. That module reaches Electron through
// pipeline.ts/windows.ts/store.ts, so a node test cannot call `tailCharacter` — the helper below
// makes the same four moves in the same order and is a TRANSCRIPTION, not the ship code. The
// end-to-end proof that `tailCharacter`'s own statements are in that order is
// tests/e2e/character-switch-storm.e2e.mts, which drives a storm of picks over the real IPC. This
// is the JOS-87 shape (a unit test could not see either half of that fix either) and it is written
// down here so nobody reads a green run as more than it is.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LogBus } from '../src/main/log/bus'
import { ModuleRegistry } from '../src/main/modules/registry'
import { createSlicer } from '../src/main/log/replaySlicer'
import { scanLog } from '../src/main/log/scanHistory'
import { beginSwitch, type SwitchTurn } from '../src/main/switchController'
import { historicalReplayRunning, setHistoricalReplayRunning } from '../src/main/replayGate'
import type { EqModule, ModuleDelta } from '../src/main/modules/types'
import type { LogEvent } from '../src/shared/logEvents'

/** The timestamp prefix every line the parser will accept has to carry. */
const TS = '[Mon Aug 04 12:00:00 2026] '

/**
 * The two logs, and why the zone names are shaped like this: `You have entered <name>.` parses into
 * a `zone` event whose `zone` is the name VERBATIM (verified against the real parser), so a world
 * built from one log and a world built from the other can never be mistaken for each other. Every
 * assertion below is "whose events are in here", which needs exactly that property.
 */
const A_ZONES = Array.from({ length: 240 }, (_, i) => `Aurora ${String(i + 1)}`)
const B_ZONES = Array.from({ length: 60 }, (_, i) => `Beacon ${String(i + 1)}`)

/** The event at which the competing pick is made — deep enough into A that a partial fold is
 *  unmistakable, shallow enough that a bug leaves plenty of A behind to be caught with. */
const PREEMPT_AFTER = 30

function writeLog(dir: string, name: string, zones: readonly string[]): string {
  const path = join(dir, name)
  writeFileSync(path, zones.map((z) => `${TS}You have entered ${z}.\n`).join(''), 'utf8')
  return path
}

/**
 * A module with the SAME accumulation behaviour every shipped one has — it appends to `pending` on
 * every event without consulting `live`, because that is the fact the whole defect rested on
 * (tests/replayDeltaSilence.test.mts's SpyModule, same reason, kept separate so neither test can
 * quietly change the other's oracle).
 */
class ZoneSpy implements EqModule<string[], { appended: string[] }> {
  readonly id = 'zones'
  private all: string[] = []
  private pending: string[] = []
  private seq = 0

  reset(): void {
    this.all = []
    this.pending = []
    this.seq = 0
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind !== 'zone') return
    this.all.push(ev.zone)
    this.pending.push(ev.zone)
  }

  snapshot(): { seq: number; state: string[] } {
    return { seq: this.seq, state: [...this.all] }
  }

  flushDelta(): { seq: number; delta: { appended: string[] } } | null {
    if (this.pending.length === 0) return null
    const appended = this.pending
    this.pending = []
    return { seq: this.seq, delta: { appended } }
  }
}

interface World {
  bus: LogBus
  registry: ModuleRegistry
  mod: ZoneSpy
  /** Every `module:delta` that reached the "renderer". Must stay empty for a whole storm. */
  deltas: ModuleDelta[]
  /** What the world holds right now, in fold order. */
  zones: () => string[]
}

function world(): World {
  const deltas: ModuleDelta[] = []
  const registry = new ModuleRegistry({
    emitDelta: (d) => {
      deltas.push(d)
    }
  })
  const mod = new ZoneSpy()
  registry.register(mod)
  const bus = new LogBus()
  registry.attach(bus)
  return { bus, registry, mod, deltas, zones: () => mod.snapshot().state }
}

/**
 * ONE SWITCH'S REPLAY, in `tailCharacter`'s own order — see the file header for what this is and
 * what it is not. The gate and the bracket CLOSE unconditionally at the top and are opened only by
 * the turn that reaches the end still owning the world.
 */
async function foldAsSwitch(
  w: World,
  turn: SwitchTurn,
  logPath: string
): Promise<'kept' | 'preempted'> {
  setHistoricalReplayRunning(true)
  w.registry.reset()
  w.registry.beginReplay()
  try {
    // `budgetMs: 0` yields after EVERY line, which is what makes the interleaving in these tests a
    // statement about the code rather than about this machine's timer resolution; `duty: 1` keeps
    // the yields free (`setImmediate`), the same arm every equivalence test uses.
    await scanLog(logPath, w.bus, 0, {
      slicer: createSlicer({ budgetMs: 0, duty: 1 }),
      cancelled: () => !turn.owns()
    })
    if (!turn.owns()) return 'preempted'
    return 'kept'
  } finally {
    if (turn.owns()) {
      w.registry.endReplay()
      setHistoricalReplayRunning(false)
    }
  }
}

test('the generation: the last pick owns the world and every earlier one has lost it for good', () => {
  const first = beginSwitch()
  assert.equal(first.owns(), true, 'a switch owns the world from the moment it begins')

  const second = beginSwitch()
  assert.equal(first.owns(), false, 'a newer pick takes it away — no queueing, no waiting')
  assert.equal(second.owns(), true)

  const third = beginSwitch()
  assert.equal(second.owns(), false, 'the INTERMEDIATE pick is dropped too, not stacked behind')
  assert.equal(third.owns(), true, 'last pick wins')

  // Nothing hands it back. A preempted switch describes a world that has since been rebuilt, so
  // "you may finish after all" is not a state this can ever be in.
  assert.equal(first.owns(), false)
  assert.equal(second.owns(), false)
})

test('a preempted fold emits NOTHING after the generation moved, and says its reading is partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-switch-'))
  const logA = writeLog(dir, 'a.txt', A_ZONES)
  const w = world()

  const turn = beginSwitch()
  /** Every event, with the answer to "did the fold that emitted this still own the world?". */
  const seen: { zone: string; owned: boolean }[] = []
  w.bus.subscribe((ev) => {
    if (ev.kind !== 'zone') return
    seen.push({ zone: ev.zone, owned: turn.owns() })
    // THE COMPETING PICK, made from INSIDE the fold — the pessimistic case. In the real app a
    // switch can only start while the fold is suspended (the main process is single-threaded), so
    // this is strictly harder than production: the generation moves mid-slice and the fold has to
    // notice at its very next yield.
    if (seen.length === PREEMPT_AFTER) beginSwitch()
  })

  const scan = await scanLog(logA, w.bus, 0, {
    slicer: createSlicer({ budgetMs: 0, duty: 1 }),
    cancelled: () => !turn.owns()
  })

  assert.equal(scan.aborted, true, 'the fold reports that it stopped early')
  assert.ok(
    scan.endOffset < statSync(logA).size,
    `a preempted fold's endOffset is a partial reading (${String(scan.endOffset)} of ${String(statSync(logA).size)})`
  )
  assert.equal(
    seen.filter((s) => !s.owned).length,
    0,
    'not one event was emitted after the generation moved — the guarantee is zero, not "one slice"'
  )
  assert.equal(seen.length, PREEMPT_AFTER, 'it stopped at the very next yield, having folded no more')
  assert.equal(w.deltas.length, 0, 'and nothing reached a renderer on the way out')
})

test('an ordinary fold is untouched: no `cancelled`, no `aborted`, the whole log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-switch-'))
  const logB = writeLog(dir, 'b.txt', B_ZONES)
  const w = world()

  const scan = await scanLog(logB, w.bus, 0, { slicer: createSlicer({ budgetMs: 0, duty: 1 }) })

  assert.equal(scan.aborted, undefined, 'a completed scan carries no abort flag at all')
  assert.equal(scan.endOffset, statSync(logB).size, 'it read to the frozen EOF, as it always did')
  assert.deepEqual(w.zones(), B_ZONES)
})

test('two overlapping switches: the world is the winner’s alone, and the gate never opened between them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-switch-'))
  const logA = writeLog(dir, 'a.txt', A_ZONES)
  const logB = writeLog(dir, 'b.txt', B_ZONES)
  const w = world()

  const turnA = beginSwitch()
  let second: Promise<'kept' | 'preempted'> | null = null
  let turnB: SwitchTurn | null = null
  /** Was the replay gate ever OPEN while either fold was still running? One `false` is the bug. */
  const gateOpenDuringFold: string[] = []
  let folded = 0

  w.bus.subscribe((ev) => {
    if (ev.kind !== 'zone') return
    folded += 1
    if (!historicalReplayRunning()) gateOpenDuringFold.push(ev.zone)
    if (folded !== PREEMPT_AFTER || second) return
    // THE SECOND PICK, made at a genuine suspension point (`setImmediate` = the slicer's own yield
    // mechanism), which is the only instant one can be made in the real app. B therefore begins —
    // resetting the world — while A is still parked inside its fold.
    setImmediate(() => {
      turnB = beginSwitch()
      second = foldAsSwitch(w, turnB, logB)
    })
  })

  const firstResult = await foldAsSwitch(w, turnA, logA)
  assert.equal(firstResult, 'preempted', 'the older pick loses and returns having kept nothing')
  assert.ok(second, 'the second switch actually started (otherwise this test proves nothing)')
  assert.equal(await second, 'kept', 'the surviving pick finishes parsing — it is not cancelled too')

  assert.deepEqual(
    w.zones(),
    B_ZONES,
    'the final world is the winner’s ALONE: every Aurora zone the loser folded is gone, and the winner folded its whole log'
  )
  assert.deepEqual(gateOpenDuringFold, [], 'the gate stayed shut for the whole storm, with no gap in the middle')
  assert.equal(w.deltas.length, 0, 'and not one module delta left the process while any fold was running')

  // …and the world goes live normally afterwards: the first LIVE event is the first thing the
  // renderer ever hears about, carrying itself and nothing before it.
  assert.equal(historicalReplayRunning(), false, 'the winner opened the gate on its way out')
  w.bus.emit(
    { kind: 'zone', seq: 999, ts: 1, raw: `${TS}You have entered Beacon Live.`, zone: 'Beacon Live' },
    true
  )
  w.registry.flushNow()
  assert.deepEqual(
    w.deltas.map((d) => d.delta),
    [{ appended: ['Beacon Live'] }],
    'the discard was a DRAIN: the first live delta carries the live event and nothing else'
  )
})

test('a loser’s own close is refused — the bracket and the gate survive it and wait for the owner', () => {
  const w = world()
  const loser = beginSwitch()
  setHistoricalReplayRunning(true)
  w.registry.reset()
  w.registry.beginReplay()

  const winner = beginSwitch()

  // The loser's `finally`, run exactly as session.ts runs it. This is the statement the reported
  // alerts escaped through: unguarded, it re-opens the push path under a fold that has months of
  // another character's history left to go.
  if (loser.owns()) {
    w.registry.endReplay()
    setHistoricalReplayRunning(false)
  }
  assert.equal(historicalReplayRunning(), true, 'the loser did not open the gate it does not own')

  w.bus.emit({ kind: 'zone', seq: 1, ts: 1, raw: `${TS}You have entered Aurora 1.`, zone: 'Aurora 1' }, true)
  w.registry.flushNow()
  assert.equal(w.deltas.length, 0, 'and the registry is still gating every push path')

  // The owner's pass is what closes it, and everything the fold accumulated is discarded there.
  if (winner.owns()) {
    w.registry.endReplay()
    setHistoricalReplayRunning(false)
  }
  assert.equal(historicalReplayRunning(), false)
  assert.equal(w.deltas.length, 0, 'ending a replay pushes nothing — the renderer re-hydrates instead')
})
