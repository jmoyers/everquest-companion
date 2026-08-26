// ============================================================================
// processPriority.test.mts — WHICH PROCESSES GET LOWERED, AND WHAT HAPPENS WHEN WINDOWS SAYS NO
// (JOS-366 — src/main/processPriority.ts).
// ============================================================================
//
// No Electron, no fixtures, no network — the devRestart.test.mts / security.test.mts precedent,
// so this suite never skips. It can only exist because the module takes its `os` and its two
// Electron subscriptions as INJECTED hosts: against the real `node:os` these assertions would be
// reprioritising the machine running the test suite, and the interesting half (EPERM, ESRCH, a
// silent revert by Chromium's priority manager) cannot be produced on demand at all.
//
// FIVE CLAIMS, and they fail in different directions:
//
//   1. THE SELECTION. Main plus every live renderer, deduped, with the not-yet-spawned `0` that
//      `getOSProcessId()` returns for a brand-new webContents dropped rather than passed to the
//      OS. Nothing else is ever in the list — which is how "the GPU and the utility processes are
//      left alone" is kept: this module is only ever handed webContents.
//   2. THE REFUSAL. `setPriority` throwing EPERM or ESRCH is reported, never thrown — a machine
//      that will not let us do this keeps running at the priority it already had.
//   3. THE READ-BACK. A set that reads back as something else is described as the disagreement it
//      is, because that is the one shape a silent Chromium re-raise takes.
//   4. THE RE-APPLY. `did-finish-load` and a window's `show` both put the class back, and the
//      switch going off restores NORMAL rather than leaving processes where they were.
//   5. THE ENGINE (JOS-459 phase 0). The data-server child joins the set through `setEnginePid`,
//      follows the SAME switch as the rest of the app, and never leaves a dead pid behind — a pid
//      is reused by the OS, and lowering a stranger's process is the one outcome forbidden here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPriority,
  describeOutcomes,
  initProcessPriority,
  priorityIsSupported,
  resetProcessPriorityForTests,
  selectPriorityPids,
  setEnginePid,
  setYieldToGame,
  type PriorityOs,
  type PriorityWebContents,
  type PriorityWindow
} from '../src/main/processPriority'

const NORMAL = 0
const BELOW_NORMAL = 10

/** A stand-in for `node:os`, recording every call and able to refuse or lie on demand. */
function stubOs(opts: { refuse?: (pid: number) => string; reports?: (pid: number) => number } = {}): PriorityOs & {
  sets: { pid: number; priority: number }[]
} {
  const sets: { pid: number; priority: number }[] = []
  const current = new Map<number, number>()
  return {
    sets,
    constants: { priority: { PRIORITY_NORMAL: NORMAL, PRIORITY_BELOW_NORMAL: BELOW_NORMAL } },
    setPriority(pid, priority) {
      const why = opts.refuse?.(pid)
      if (why !== undefined) throw new Error(why)
      sets.push({ pid, priority })
      current.set(pid, priority)
    },
    getPriority(pid) {
      if (opts.reports) return opts.reports(pid)
      return current.get(pid) ?? NORMAL
    }
  }
}

// ---- 1. the selection -------------------------------------------------------------------

test('the pid list is main plus every live renderer, deduped, with the unspawned ones dropped', () => {
  assert.deepEqual(
    selectPriorityPids({ mainPid: 100, rendererPids: [200, 300, 200, 100] }),
    [100, 200, 300],
    'main first, each pid once - two webContents can share one renderer process'
  )
  assert.deepEqual(
    // 0 is what `getOSProcessId()` answers for a webContents whose process does not exist yet;
    // on some platforms `setPriority(0, …)` means "the caller's group", which is not what any of
    // this is asking for.
    selectPriorityPids({ mainPid: 100, rendererPids: [0, -1, 1.5, Number.NaN, 400] }),
    [100, 400]
  )
  assert.deepEqual(selectPriorityPids({ mainPid: 0, rendererPids: [] }), [], 'nothing to do is a valid answer')
})

test('Windows only, and never under the e2e harness', () => {
  assert.equal(priorityIsSupported({ platform: 'win32', e2e: false }), true)
  assert.equal(priorityIsSupported({ platform: 'win32', e2e: true }), false, 'a test must not reprioritise its own machine')
  // `os.setPriority` exists on both, but it means NICENESS there - a different mechanism with
  // different semantics, and one an unprivileged process cannot undo.
  assert.equal(priorityIsSupported({ platform: 'darwin', e2e: false }), false)
  assert.equal(priorityIsSupported({ platform: 'linux', e2e: false }), false)
})

// ---- 2. the refusal ---------------------------------------------------------------------

test('EPERM and ESRCH are reported, never thrown - the app keeps the priority it had', () => {
  const os = stubOs({
    refuse: (pid) => (pid === 200 ? 'EPERM: operation not permitted' : pid === 300 ? 'ESRCH: no such process' : undefined)
  })
  const out = applyPriority([100, 200, 300], BELOW_NORMAL, os)

  assert.equal(out.length, 3)
  assert.equal(out[0]?.error, undefined, 'a pid that accepted is unaffected by its neighbours')
  assert.equal(out[0]?.readBack, BELOW_NORMAL)
  assert.match(out[1]?.error ?? '', /EPERM/)
  assert.match(out[2]?.error ?? '', /ESRCH/)
  assert.deepEqual(os.sets, [{ pid: 100, priority: BELOW_NORMAL }], 'only the pid that accepted was set')
})

test('a pid that dies between the set and the read-back is a set, not a failure', () => {
  const os = stubOs({
    reports: () => {
      throw new Error('ESRCH: no such process')
    }
  })
  const out = applyPriority([100], BELOW_NORMAL, os)
  assert.equal(out[0]?.error, undefined, 'the set succeeded; only the confirmation was lost')
  assert.equal(out[0]?.readBack, null)
  assert.match(describeOutcomes(out), /unreadable/)
})

// ---- 3. the read-back -------------------------------------------------------------------

test('a class that does not stick reads as the disagreement it is', () => {
  // Chromium's process-priority manager raising a renderer back to NORMAL, which is the whole
  // reason the read-back exists.
  const os = stubOs({ reports: () => NORMAL })
  const line = describeOutcomes(applyPriority([555], BELOW_NORMAL, os))
  assert.match(line, /555: set 10 but reads 0/)
})

// ---- 4. the wiring ----------------------------------------------------------------------

/** A stand-in for Electron's `WebContents`: one pid, and the two events the module subscribes to. */
function stubContents(pid: number): PriorityWebContents & { fire: (event: string) => void; kill: () => void } {
  const listeners = new Map<string, (() => void)[]>()
  let destroyed = false
  return {
    getOSProcessId: () => pid,
    isDestroyed: () => destroyed,
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return undefined
    },
    fire(event) {
      for (const l of listeners.get(event) ?? []) l()
    },
    kill() {
      destroyed = true
      for (const l of listeners.get('destroyed') ?? []) l()
    }
  }
}

/** A stand-in for `BrowserWindow`, which is only ever asked for its `show`. */
function stubWindow(wc: PriorityWebContents): PriorityWindow & { show: () => void } {
  const shown: (() => void)[] = []
  return {
    webContents: wc,
    on(_event: 'show', listener: () => void) {
      shown.push(listener)
      return undefined
    },
    show() {
      for (const l of shown) l()
    }
  }
}

interface Wired {
  os: ReturnType<typeof stubOs>
  addContents: (wc: PriorityWebContents) => void
  addWindow: (win: PriorityWindow) => void
  errors: unknown[]
  lines: string[]
}

/** Wire the module against stubs, forcing the supported path (this suite runs on any platform). */
function wire(enabled: boolean, os = stubOs()): Wired {
  resetProcessPriorityForTests()
  let onWc: ((wc: PriorityWebContents) => void) | null = null
  let onWin: ((win: PriorityWindow) => void) | null = null
  const errors: unknown[] = []
  const lines: string[] = []
  initProcessPriority({
    mainPid: 100,
    enabled,
    onWebContentsCreated: (cb) => (onWc = cb),
    onWindowCreated: (cb) => (onWin = cb),
    debug: (line) => lines.push(line),
    onError: (err) => errors.push(err),
    os,
    platform: 'win32',
    e2e: false
  })
  return {
    os,
    addContents: (wc) => (onWc as ((wc: PriorityWebContents) => void) | null)?.(wc),
    addWindow: (win) => (onWin as ((win: PriorityWindow) => void) | null)?.(win),
    errors,
    lines
  }
}

test('the main process is lowered at startup, and every renderer as it appears', () => {
  const w = wire(true)
  assert.deepEqual(w.os.sets, [{ pid: 100, priority: BELOW_NORMAL }], 'main is the one pid that exists already')

  const wc = stubContents(200)
  w.addContents(wc)
  assert.deepEqual(w.os.sets.at(-1), { pid: 200, priority: BELOW_NORMAL })

  // The reload path: a renderer can come back on a NEW process, and the crash-recovery reload is
  // exactly that case.
  w.os.sets.length = 0
  wc.fire('did-finish-load')
  assert.deepEqual(w.os.sets, [
    { pid: 100, priority: BELOW_NORMAL },
    { pid: 200, priority: BELOW_NORMAL }
  ])

  // …and a window becoming visible, which is what makes Chromium raise the class in the first
  // place.
  w.os.sets.length = 0
  const win = stubWindow(wc)
  w.addWindow(win)
  win.show()
  assert.deepEqual(w.os.sets, [
    { pid: 100, priority: BELOW_NORMAL },
    { pid: 200, priority: BELOW_NORMAL }
  ])

  // A dead renderer leaves the set rather than accumulating for the life of the session.
  w.os.sets.length = 0
  wc.kill()
  wc.fire('did-finish-load')
  assert.deepEqual(w.os.sets, [{ pid: 100, priority: BELOW_NORMAL }])
})

test('switching it off puts every process back to NORMAL, in the same call', () => {
  const w = wire(true)
  w.addContents(stubContents(200))
  w.os.sets.length = 0

  setYieldToGame(false)
  assert.deepEqual(w.os.sets, [
    { pid: 100, priority: NORMAL },
    { pid: 200, priority: NORMAL }
  ], 'off means restored, not "lowered until you relaunch"')

  w.os.sets.length = 0
  setYieldToGame(true)
  assert.deepEqual(w.os.sets, [
    { pid: 100, priority: BELOW_NORMAL },
    { pid: 200, priority: BELOW_NORMAL }
  ])
  resetProcessPriorityForTests()
})

test('a machine that refuses is reported ONCE per pass, and never crashes the app', () => {
  const os = stubOs({ refuse: () => 'EPERM: operation not permitted' })
  const w = wire(true, os)
  assert.equal(w.errors.length, 1, 'one line per pass, not one per pid')
  assert.match(String(w.errors[0]), /EPERM/)
  assert.equal(os.sets.length, 0)
  resetProcessPriorityForTests()
})

// ---- 5. the data-server engine (JOS-459 phase 0) -----------------------------------------

test('THE ENGINE JOINS THE SET, and a respawn is a new pid rather than a stale one', () => {
  const w = wire(true)
  assert.deepEqual(w.os.sets, [{ pid: 100, priority: BELOW_NORMAL }])
  // The supervisor's `onPid`, both edges. Applied IMMEDIATELY rather than at the next window event:
  // this session's processes must never disagree with what the setting says.
  setEnginePid(7000)
  assert.deepEqual(w.os.sets.at(-1), { pid: 7000, priority: BELOW_NORMAL }, 'the plan: below-normal')
  // A crash. The old pid must not survive its process — a pid is reused by the OS, and lowering a
  // stranger's process is the one outcome this module must never produce.
  setEnginePid(null)
  const afterGone = w.os.sets.length
  setYieldToGame(true)
  assert.deepEqual(
    w.os.sets.slice(afterGone).map((s) => s.pid),
    [100],
    'with no engine, the set is main again'
  )
  setEnginePid(7001)
  assert.deepEqual(w.os.sets.at(-1), { pid: 7001, priority: BELOW_NORMAL })
  resetProcessPriorityForTests()
})

test('the engine follows the SAME switch as the rest of the app', () => {
  // A judgement, stated where it can be checked: a user who turns "yield to the game" off has said
  // the companion should not de-prioritise itself, and the engine IS the companion. A hard-coded
  // below-normal here would make the switch quietly partial — on the busiest process.
  const w = wire(true)
  setEnginePid(7100)
  setYieldToGame(false)
  const back = w.os.sets.slice(-2)
  assert.deepEqual(back, [
    { pid: 100, priority: NORMAL },
    { pid: 7100, priority: NORMAL }
  ])
  resetProcessPriorityForTests()
})

test('an engine pid known before the module is wired is still lowered when it is', () => {
  // The engine can be spawned before `initProcessPriority` runs, and on a machine where priority is
  // unsupported; in both cases the pid is still the truth, which is why it lives outside the wiring
  // state. `initProcessPriority` directly rather than `wire`, which resets the module first — and
  // the reset clears the engine pid deliberately, so one test's fake engine cannot leak into the
  // next test's expectations.
  resetProcessPriorityForTests()
  const os = stubOs()
  setEnginePid(7200)
  initProcessPriority({
    mainPid: 100,
    enabled: true,
    onWebContentsCreated: () => undefined,
    onWindowCreated: () => undefined,
    os,
    platform: 'win32',
    e2e: false
  })
  assert.deepEqual(os.sets, [
    { pid: 100, priority: BELOW_NORMAL },
    { pid: 7200, priority: BELOW_NORMAL }
  ])
  // And a nonsense pid is dropped rather than handed to the OS — `setPriority(0, …)` means "the
  // caller's group" on some platforms, which is the whole process tree of the session.
  const before = os.sets.length
  setEnginePid(0)
  assert.deepEqual(
    os.sets.slice(before).map((s) => s.pid),
    [100],
    'zero is not a pid; the engine simply leaves the set'
  )
  resetProcessPriorityForTests()
})

test('the pid list carries child processes after main and the renderers', () => {
  assert.deepEqual(
    selectPriorityPids({ mainPid: 100, rendererPids: [200], childPids: [7000, 200, 0] }),
    [100, 200, 7000],
    'deduped against the renderers, and a zero pid is still dropped'
  )
  assert.deepEqual(selectPriorityPids({ mainPid: 100, rendererPids: [] }), [100], 'absent means none')
})

test('an unsupported platform subscribes to nothing at all', () => {
  resetProcessPriorityForTests()
  const os = stubOs()
  let subscribed = 0
  initProcessPriority({
    mainPid: 100,
    enabled: true,
    onWebContentsCreated: () => subscribed++,
    onWindowCreated: () => subscribed++,
    os,
    platform: 'linux',
    e2e: false
  })
  assert.equal(subscribed, 0, 'no listeners, so nothing can be re-applied later either')
  assert.equal(os.sets.length, 0)
  // …and the switch is still safe to flip: the IPC handler does not restate the platform gate.
  setYieldToGame(false)
  assert.equal(os.sets.length, 0)
  resetProcessPriorityForTests()
})
