// ============================================================================
// processPriority.ts — the companion runs BELOW the game, and keeps doing so (JOS-366).
// ============================================================================
//
// WHY BELOW-NORMAL. Windows schedules by priority class, and until this module existed the
// companion's processes sat in the same class as EverQuest: every burst of work here — a GC
// pause, a delta flush to five overlay windows, a speech synthesis, a store write — competed with
// the game's render thread on equal terms for a core. It should never be an equal fight. The game
// is the foreground experience and nothing this app does is latency-critical at the millisecond
// scale, so PRIORITY_BELOW_NORMAL is simply the truth about this app written down where the
// scheduler can read it. The user-facing half of that argument (and the switch) is in
// shared/processPriority.ts.
//
// WHICH PROCESSES, AND WHICH ARE DELIBERATELY LEFT ALONE.
//
//   MAIN (`process.pid`)     — ours, and the busiest: the log tail, the fold, every store write.
//   EVERY RENDERER           — the main window, all five overlays, the cursor ring, DevTools.
//                              Reached through `webContents`, which is the ONLY thing this
//                              process is handed for them; each one's `getOSProcessId()` is the
//                              pid, and two webContents can share one (dedupe below).
//   THE GPU PROCESS          — NOT TOUCHED. Chromium owns its scheduling and reasons about it
//                              globally (it is the one process that must keep up with the
//                              compositor at all times); demoting it degrades our own drawing
//                              without giving the game back anything it was competing for, since
//                              it is not the process burning CPU on a fold.
//   UTILITY PROCESSES        — NOT TOUCHED either, and the audio service is why: it drives its
//                              threads through MMCSS (the OS's own multimedia scheduling class),
//                              which is a STRONGER and more specific statement than a process
//                              priority class. Overriding the class underneath it is how an alert
//                              sound starts crackling. Electron gives us no `webContents` for
//                              them anyway, which is the mechanism keeping this promise: this
//                              module cannot reach a process it is never handed.
//
// WHY IT RE-APPLIES RATHER THAN SETTING ONCE. Chromium runs its own process-priority manager:
// when a renderer's visibility changes it calls `SetProcessBackgrounded`, which on Windows writes
// the priority class outright — so a window being shown can RAISE a renderer we lowered, silently
// and at any time. So the class is (re)applied on `did-finish-load` (covers first load, every
// reload, and the crash-recovery reload) and on the window's `show` (covers the visibility
// transition that does the raising), and every apply READS BACK with `os.getPriority` so a revert
// is visible in the dev log instead of being a thing we assume did not happen.
//
// WINDOWS ONLY. `os.setPriority` exists on macOS/Linux but means NICENESS — a different mechanism
// with different semantics (per-thread inheritance, an unprivileged process cannot lower its own
// niceness back afterwards), and a "below normal" that would have to be argued separately. The
// field is Windows; this ticket is Windows. Everywhere else, and under `EQ_E2E`, the whole module
// is a no-op — an integration test must not reprioritise the machine running it.
//
// NO ELECTRON IMPORT, ON PURPOSE, and it is the same seam ipc/perf.ts describes: the pid
// arithmetic and the failure policy are a MECHANISM, the switch is a POLICY, and the composition
// root owns both halves' wiring. Concretely it buys a `node:test` unit over a stubbed `os` — no
// Electron, so the suite never skips — which is the only way to assert what happens when Windows
// refuses. Every Electron object arrives STRUCTURALLY typed (`PriorityWebContents`,
// `PriorityWindow`), so the real ones satisfy it and a test's stubs do too.

import os from 'node:os'

/** The slice of `node:os` this module uses. Injected so a test can watch every call and make
 *  Windows refuse on demand. */
export interface PriorityOs {
  setPriority(pid: number, priority: number): void
  getPriority(pid: number): number
  readonly constants: { readonly priority: { readonly PRIORITY_NORMAL: number; readonly PRIORITY_BELOW_NORMAL: number } }
}

/** Electron's `WebContents`, reduced to what a priority decision needs. The two events are one
 *  signature because a method's parameters are compared BIVARIANTLY, so Electron's per-event
 *  overloads still satisfy it — and because `unified-signatures` is right that two identical
 *  shapes are one shape. */
export interface PriorityWebContents {
  getOSProcessId(): number
  isDestroyed(): boolean
  on(event: 'did-finish-load' | 'destroyed', listener: () => void): unknown
}

/** Electron's `BrowserWindow`, reduced the same way. `show` is the visibility transition that
 *  Chromium answers by raising the renderer's class. */
export interface PriorityWindow {
  readonly webContents: PriorityWebContents
  on(event: 'show', listener: () => void): unknown
}

/** What the class was set to, and what the OS said afterwards. */
export interface PriorityOutcome {
  pid: number
  /** The `os.constants.priority.*` value asked for. */
  wanted: number
  /** What `os.getPriority` reported straight after — `null` when the read itself refused. */
  readBack: number | null
  /** Set when `setPriority` refused (EPERM/ESRCH and friends). */
  error?: string
}

/**
 * Is there anything to do on this machine at all?
 *
 * A PURE PREDICATE over the two facts, rather than a `process.platform` test buried in a call
 * site, because "Windows only, and never under the e2e harness" is a rule worth being able to
 * read a test of.
 */
export function priorityIsSupported(env: { platform: string; e2e: boolean }): boolean {
  return env.platform === 'win32' && !env.e2e
}

/**
 * THE PID SELECTION, PURE. Main first, then every renderer, deduped, with anything that is not a
 * live pid dropped.
 *
 * The dropping is not defensive decoration: `getOSProcessId()` returns 0 for a `webContents`
 * whose renderer has not been spawned yet (the window is created before its process is), and 0 is
 * a pid `setPriority` would happily interpret as "the calling process's group" on some platforms.
 * A renderer that reports the main process's own pid is folded away by the dedupe rather than
 * being set twice.
 */
export function selectPriorityPids(input: {
  mainPid: number
  rendererPids: readonly number[]
  /** Processes this app SPAWNED that are ours to schedule — today exactly one, the data-server
   *  engine (JOS-459 phase 0). Last in the list because main and the renderers are what the user
   *  is looking at; the order only decides which pid is set first, and none of them can fail
   *  because another did. */
  childPids?: readonly number[]
}): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const pid of [input.mainPid, ...input.rendererPids, ...(input.childPids ?? [])]) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
  }
  return out
}

/**
 * Apply one priority class to a set of pids, reading each one back.
 *
 * NEVER THROWS, per pid. `os.setPriority` raises EPERM when the target refuses the change (a
 * process in a job object, an anti-cheat or security product holding a handle) and ESRCH when it
 * has already exited — which is ordinary: a renderer can die between the moment its pid was
 * collected and the moment this runs. Either way the answer is the same, and it is the answer the
 * whole feature is worth: the app keeps running at the priority it already had. The caller logs;
 * this function reports.
 */
export function applyPriority(pids: readonly number[], wanted: number, host: PriorityOs): PriorityOutcome[] {
  return pids.map((pid) => {
    try {
      host.setPriority(pid, wanted)
    } catch (err) {
      return { pid, wanted, readBack: null, error: err instanceof Error ? err.message : String(err) }
    }
    // The read-back is a SECOND syscall and it is worth it: this is the only way a silent revert
    // by Chromium's priority manager can ever be seen. It gets its own guard because a pid that
    // died between the two calls must not turn a successful set into a reported failure.
    let readBack: number | null = null
    try {
      readBack = host.getPriority(pid)
    } catch {
      readBack = null
    }
    return { pid, wanted, readBack }
  })
}

/** One line per apply, for the dev log. Names the class asked for and what came back, so a
 *  revert reads as the disagreement it is rather than as a number nobody can interpret. */
export function describeOutcomes(outcomes: readonly PriorityOutcome[]): string {
  const parts = outcomes.map((o) => {
    if (o.error !== undefined) return `${String(o.pid)}: refused (${o.error})`
    if (o.readBack === null) return `${String(o.pid)}: set, unreadable`
    if (o.readBack !== o.wanted) return `${String(o.pid)}: set ${String(o.wanted)} but reads ${String(o.readBack)}`
    return `${String(o.pid)}: ${String(o.readBack)}`
  })
  return `process priority - ${parts.join(', ')}`
}

// ---------------------------------------------------------------- the wired half

/** Everything the composition root hands this module. Every Electron dependency is a callback,
 *  so nothing here imports Electron. */
export interface PriorityWiring {
  /** This process's own pid (`process.pid`). */
  mainPid: number
  /** The stored switch, read once at wiring time. Later changes come through `setYieldToGame`. */
  enabled: boolean
  /** Every `webContents` this process creates, as it is created. */
  onWebContentsCreated(cb: (wc: PriorityWebContents) => void): void
  /** Every `BrowserWindow` this process creates, as it is created. */
  onWindowCreated(cb: (win: PriorityWindow) => void): void
  /** Where the read-back line goes. Absent ⇒ nothing is logged (a packaged build). */
  debug?: (line: string) => void
  /** Where a refusal goes. */
  onError?: (err: unknown) => void
  /** TEST SEAMS. */
  os?: PriorityOs
  platform?: string
  e2e?: boolean
}

interface PriorityState {
  wiring: PriorityWiring
  host: PriorityOs
  supported: boolean
  enabled: boolean
  /** Live renderer webContents. Pruned on `destroyed` so a long session cannot accumulate them. */
  contents: Set<PriorityWebContents>
}

let state: PriorityState | null = null

/**
 * THE DATA-SERVER ENGINE'S PID, when there is one (JOS-459 phase 0).
 *
 * WHY IT BELONGS IN THIS MODULE'S SET rather than getting a priority call of its own at the spawn
 * site: the engine is one of THIS APP'S processes, and the whole argument at the top of this file
 * is about the app's processes as a group. The plan says it plainly — "one Rust process,
 * below-normal priority" (docs/plans/data-server.md, "The shape") — and it is the process that will
 * eventually do the fold, i.e. the one whose bursts main is currently paying for. Nothing about the
 * reasoning changes because the work moved out of process.
 *
 * IT FOLLOWS THE SAME SWITCH, and that is a judgement worth stating rather than defaulting into: a
 * user who turns "yield to the game" OFF has said the companion should not de-prioritise itself,
 * and the engine IS the companion. A hard-coded below-normal here would make the switch quietly
 * partial — the one process it did not cover being the busiest one — which is the sort of
 * half-honoured setting this repo has a law about.
 *
 * OUTSIDE `PriorityState` on purpose: the engine can be spawned before `initProcessPriority` runs
 * or on a machine where priority is unsupported, and in both cases the pid is still the truth. It
 * is module-level like `state` and cleared by the same test-seam reset.
 */
let enginePid: number | null = null

/**
 * Tell the module which process is the engine, or that there is no longer one.
 *
 * Called by the supervisor's `onPid` on both edges (`dataServer/engineHost.ts`). A RESPAWN IS A
 * LAUNCH, so this is called with a fresh pid every time — there is no long-lived engine identity to
 * cache. Applying immediately rather than waiting for the next window event is the same discipline
 * `setYieldToGame` keeps: this session's processes must never disagree with what the setting says.
 */
export function setEnginePid(pid: number | null): void {
  enginePid = pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null
  if (state) applyNow(state, enginePid === null ? 'engine gone' : 'engine spawned')
}

/**
 * Which process is the engine right now, or `null` when none is running.
 *
 * A SECOND READER OF A FACT THIS MODULE ALREADY TRACKS (JOS-483). The performance panel wants the
 * engine's CPU and working set beside main's and the renderers', and `app.getAppMetrics()` cannot
 * give it: that is Chromium's own process list and the engine is not in it. The pid it needs is
 * exactly the one this module is already told about on both edges, so exporting the read is
 * cheaper — and one fact fewer to keep true — than a second subscription to the supervisor.
 *
 * IT IS A READ AND NOTHING ELSE. Nothing about priority happens here; a caller that wanted to
 * change the class would still go through `setEnginePid`/`setYieldToGame`.
 */
export function getEnginePid(): number | null {
  return enginePid
}

/** The pids to act on RIGHT NOW: main, every live renderer, and the engine if it is running. Read
 *  at each apply rather than cached, because a renderer's pid does not exist until its process is
 *  spawned — and the engine's changes on every respawn. */
function currentPids(s: PriorityState): number[] {
  const rendererPids: number[] = []
  for (const wc of s.contents) {
    try {
      if (wc.isDestroyed()) continue
      rendererPids.push(wc.getOSProcessId())
    } catch {
      // A webContents torn down between the two calls. Not an error, and not a pid.
    }
  }
  return selectPriorityPids({
    mainPid: s.wiring.mainPid,
    rendererPids,
    childPids: enginePid === null ? [] : [enginePid]
  })
}

/** One pass: set every pid to the class the switch currently asks for, read back, report. */
function applyNow(s: PriorityState, why: string): void {
  if (!s.supported) return
  const wanted = s.enabled
    ? s.host.constants.priority.PRIORITY_BELOW_NORMAL
    : s.host.constants.priority.PRIORITY_NORMAL
  const outcomes = applyPriority(currentPids(s), wanted, s.host)
  const refused = outcomes.filter((o) => o.error !== undefined)
  // ONE report, not one per pid: a machine where this is refused refuses it for every process,
  // every time, and a per-pid log line would turn a policy we can live without into pages of
  // errors.log. The dev line below still names each pid.
  if (refused.length > 0 && s.wiring.onError) {
    s.wiring.onError(new Error(`could not set process priority: ${describeOutcomes(refused)}`))
  }
  s.wiring.debug?.(`${describeOutcomes(outcomes)} (${why})`)
}

/** Watch one renderer: apply now, and again every time it finishes a load. */
function track(s: PriorityState, wc: PriorityWebContents): void {
  s.contents.add(wc)
  wc.on('destroyed', () => s.contents.delete(wc))
  // Every load, not the first: a reload gives the renderer a NEW process on some paths, and the
  // crash-recovery reload (windows.ts) is exactly the case where the pid changed underneath us.
  wc.on('did-finish-load', () => applyNow(s, 'did-finish-load'))
  applyNow(s, 'web-contents-created')
}

/**
 * Wire it up. Called ONCE from the composition root, BEFORE the first window is created, so the
 * main window's own webContents arrives through the same door every later one does.
 *
 * The main process is set immediately — it is the one pid that exists already, and it is the one
 * doing the fold.
 */
export function initProcessPriority(wiring: PriorityWiring): void {
  const s: PriorityState = {
    wiring,
    host: wiring.os ?? os,
    supported: priorityIsSupported({
      platform: wiring.platform ?? process.platform,
      e2e: wiring.e2e ?? process.env.EQ_E2E === '1'
    }),
    enabled: wiring.enabled,
    contents: new Set()
  }
  state = s
  if (!s.supported) return
  wiring.onWebContentsCreated((wc) => track(s, wc))
  // The window, not the webContents, because `show` is a BrowserWindow event — and it is the one
  // that matters: Chromium raises a renderer's class when its window becomes visible.
  wiring.onWindowCreated((win) => {
    win.on('show', () => applyNow(s, 'window-show'))
  })
  applyNow(s, 'startup')
}

/**
 * Flip the switch, NOW. Called by the IPC handler in the same call that persists the pref, so
 * this session's processes can never disagree with what Preferences says — the discipline
 * `applyPerfHudEnabled` keeps for the HUD's sampler.
 *
 * Turning it OFF puts every process back to PRIORITY_NORMAL rather than leaving it where it was:
 * a switch whose off state means "stays lowered until you relaunch" is not a switch.
 */
export function setYieldToGame(enabled: boolean): void {
  if (!state) return
  state.enabled = enabled
  applyNow(state, enabled ? 'switched on' : 'switched off')
}

/** TEST SEAM ONLY — forget the wiring, so a test can init more than once. The engine pid goes with
 *  it: it is module state of exactly the same kind, and a leftover pid would leak one test's fake
 *  engine into the next test's expectations. */
export function resetProcessPriorityForTests(): void {
  state = null
  enginePid = null
}
