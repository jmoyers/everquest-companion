/**
 * engineSteps.mts — WHAT THE HARNESS CAN SEE OF A RUNNING ENGINE (JOS-470).
 *
 * The engine is the first thing this app has ever shipped that is a SEPARATE PROCESS with a
 * lifecycle of its own, and none of the suite's existing instruments can see one: `mainWindow()`
 * asks a page what bridge it exposes, `settle` polls the DOM, `snapshot()` goes over IPC. A child
 * process is behind all three. So this file is the three doors that DO reach it, each of them
 * outside the app rather than inside it — the engine has no renderer surface in phase 0 and the
 * spec must not invent one to test it (JOS-467's supervisor.ts: "no renderer exposure, on purpose").
 *
 *   1. THE PROCESS TABLE — is there an `engined.exe`, and whose child is it?
 *   2. THE APP'S OWN STDOUT — the supervisor narrates its whole lifecycle through `logInfo`, which
 *      is `console.log` verbatim (errorLog.ts's info channel). Playwright hands back the Electron
 *      ChildProcess, so the harness can read exactly what a developer watching `npm run dev` reads.
 *   3. `<userData>/errors.log` — where the supervisor's FAILURE reports land, and the one durable
 *      half of its narration.
 *
 * WHY (2) IS TAPPED AND NOT SEARCHED FROM THE START. Playwright pipes the app's stdio and is
 * already reading it when `electron.launch()` resolves, so every line printed before that moment is
 * consumed and gone — MEASURED, and it is the whole reason the spec reaches READY the way it does
 * (see engine-boots.e2e.mts, step "ready"). A tap attached the instant the launch resolves sees
 * everything from there on, which includes every line the spec goes on to CAUSE.
 *
 * POSITIVE IDENTIFICATION, THE `mainWindow()` RULE, APPLIED TO A PROCESS. "The engined.exe that
 * appeared while I was launching" is the process-shaped version of `app.firstWindow()` — right
 * almost always, and wrong in exactly the case that costs the most (a second run of this spec on
 * the same machine). `wmic` answers with the PARENT pid, so the spec can name the engine that
 * descends from ITS launch and never touch anyone else's. `wmic` is deprecated and will one day not
 * be there, so the fallback is stated rather than assumed: `parents` comes back null, and the
 * caller says so.
 *
 * AND IT IS DESCENT, NOT PARENTAGE — MEASURED, and it cost this spec its first red run.
 * `ElectronApplication.process()` is NOT the Electron main process on Windows: the pid Playwright
 * hands back re-execs itself, so the real main process (the one that spawns the engine, opens the
 * windows and owns every other `electron.exe` in the launch) is its CHILD. Observed on this ticket:
 * `app.process().pid = 7308`, main = 52676 with parent 7308, `engined.exe` = 45692 with parent
 * 52676. A direct parent compare therefore finds nothing while the engine is plainly running, which
 * is the worst possible failure for an identification helper — it looks exactly like absence. So
 * the question asked here is "does this engine DESCEND from the launch", which is true of both
 * shapes and cannot go stale the day Playwright or Electron changes its mind about the extra hop.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright-core'
import { sleep } from './settle.mjs'

/** The binary's file name — the same one `engineProtocol.ts ENGINE_BIN_NAME` resolves to on
 *  Windows, spelled here because a test asks the OS about it rather than importing main. */
export const ENGINE_PROC_NAME = 'engined.exe'

/** Every live engine process, and (where the machine can say) the whole machine's parent links. */
export interface EngineTable {
  /** Every live `engined.exe` pid on this machine, ours and anybody else's. */
  readonly pids: readonly number[]
  /** pid → parent pid for EVERY process, or null when this machine has no `wmic` to ask. It is the
   *  whole table rather than the engines' own row because the link that matters is a CHAIN — see
   *  the header's measurement of Playwright's extra Electron hop. */
  readonly parents: ReadonlyMap<number, number> | null
}

/** One row of `wmic process get Name,ParentProcessId,ProcessId /FORMAT:CSV`, whose columns come
 *  back alphabetised behind the node name: `Node,Name,ParentProcessId,ProcessId`. */
interface ProcRow {
  readonly name: string
  readonly parent: number
  readonly pid: number
}

/** Parse that CSV. The header row survives the split and is dropped by the number check, and a
 *  machine-name cell that contains no comma is what makes the last-three-cells read safe. */
function parseWmicCsv(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const cells = line.trim().split(',')
    if (cells.length < 4) continue
    const parent = Number(cells[cells.length - 2])
    const pid = Number(cells[cells.length - 1])
    if (!Number.isInteger(parent) || !Number.isInteger(pid) || pid <= 0) continue
    rows.push({ name: cells[cells.length - 3], parent, pid })
  }
  return rows
}

/** `tasklist` rows: `"engined.exe","33324","Console","1","5,564 K"`. The fallback path — a pid list
 *  with no parentage in it. */
function parseTasklistCsv(out: string): number[] {
  const pids: number[] = []
  for (const line of out.split('\n')) {
    const match = /^"[^"]+","(\d+)"/.exec(line.trim())
    if (match) pids.push(Number(match[1]))
  }
  return pids
}

/**
 * Ask the OS which engines are running. `wmic` first, because it answers the question that makes
 * identification POSITIVE; `tasklist` when it cannot, which is an honest degrade rather than a
 * failure — the caller checks `parents === null` and says which claim it is making.
 */
export function engineTable(): EngineTable {
  // EVERY process, in one call, rather than a second query for the links: the chain from an engine
  // up to the launch passes through processes that are not engines, so a query filtered to
  // `engined.exe` cannot answer the only question worth asking.
  const wmic = spawnSync('wmic', ['process', 'get', 'Name,ParentProcessId,ProcessId', '/FORMAT:CSV'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (!wmic.error && wmic.status === 0) {
    const rows = parseWmicCsv(wmic.stdout)
    const parents = new Map(rows.map((r) => [r.pid, r.parent] as const))
    const pids = rows.filter((r) => r.name.toLowerCase() === ENGINE_PROC_NAME).map((r) => r.pid)
    return { pids, parents }
  }
  const list = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${ENGINE_PROC_NAME}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true
  })
  return { pids: list.error ? [] : parseTasklistCsv(list.stdout), parents: null }
}

/**
 * The engines that DESCEND from `ancestorPid`, when the machine can attribute them; null when it
 * cannot. See the header for why descent rather than parentage.
 *
 * The walk is bounded by the number of processes on the machine and by a visited set, because a
 * parent table read one row at a time is not a guaranteed tree: pids are reused, and a snapshot can
 * name a parent that has already exited and been replaced.
 */
export function engineDescendantsOf(table: EngineTable, ancestorPid: number): number[] | null {
  const parents = table.parents
  if (parents === null) return null
  const descends = (pid: number): boolean => {
    const seen = new Set<number>([pid])
    for (let at = parents.get(pid); at !== undefined && !seen.has(at); at = parents.get(at)) {
      if (at === ancestorPid) return true
      seen.add(at)
    }
    return false
  }
  return table.pids.filter(descends)
}

/**
 * Poll the process table until `ok` accepts it, or the deadline passes — `settle.mts`'s contract,
 * for a reader that is a subprocess rather than a page. It is its own function because `settle`
 * takes an async reader and every read here is a synchronous `spawnSync`, and because the interval
 * is a different animal: each read costs a process launch, so it is 300 ms rather than 60.
 */
export async function settleTable(
  ok: (table: EngineTable) => boolean,
  timeoutMs = 30_000
): Promise<EngineTable> {
  const t0 = Date.now()
  let table = engineTable()
  while (!ok(table) && Date.now() - t0 < timeoutMs) {
    await sleep(300)
    table = engineTable()
  }
  return table
}

/**
 * Kill one engine, the way nothing in this app ever would.
 *
 * The spec uses it to make the supervisor prove it is a SUPERVISOR — and, as the same stroke, to
 * make a READY announcement happen at a moment the harness is listening (see the spec's header).
 * `/F` because a graceful ask is exactly what the app already does at quit and is not the failure
 * being staged here: this is the engine dying without warning.
 */
export function killEngine(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true })
}

// ── the app's own narration ────────────────────────────────────────────────────────────

/** What one `data-server engine ready:` line says. Every field is a claim: the pid names the
 *  process, the port names the socket, and `engine`/`status` can only have come back from a real
 *  `session.health` round-trip over that socket. */
export interface EngineReady {
  readonly pid: number
  readonly port: number
  readonly protocol: number
  readonly engineVersion: string
  readonly status: string
}

/**
 * The ready line, exactly as `supervisor.ts reachedReady` prints it. Anchored on every field for
 * `ANNOUNCE_RE`'s reason one layer up: a loose `/ready/` would be satisfied by any sentence
 * containing the word, and this line is the harness's only evidence that a health round-trip
 * happened at all.
 */
const READY_RE =
  /data-server engine ready: pid (\d+), port (\d+), protocol (\d+), engine ([^,]+), status (\w+)/g

/** A tap on everything the app prints from the moment it is attached. */
export interface AppOutput {
  /** Everything captured so far, both streams, in arrival order. */
  text(): string
  /** Every ready announcement seen so far, oldest first. */
  ready(): EngineReady[]
  /** Was this said? A plain substring — the caller passes the sentence it means. */
  said(needle: string): boolean
}

/**
 * Tap the app's stdout and stderr.
 *
 * BOTH STREAMS, because the two halves of the engine's narration are on different ones: main's own
 * `logInfo` lines go to stdout, and the ENGINE's stderr diagnostics are re-printed through the same
 * function (supervisor.ts's `readLines(child.stderr, …)`) — while Electron itself writes to stderr.
 * Concatenating them is right for a substring reader and wrong for nothing here: no assertion in
 * this spec is about WHICH stream a line arrived on.
 */
/**
 * ONE TAP PER APP, SHARED (JOS-499) — and it is a fix rather than an optimisation.
 *
 * THE DEFECT IT CLOSES, measured: `launchOnFixture` now waits for the engine's go-live sentence
 * before handing a launch back, and it does that by tapping the output. A spec that then called
 * `tapOutput` itself got a SECOND, EMPTY accumulator — so the sentence it was waiting for had
 * already gone past and could never be seen. `engine-alert-fires` failed exactly that way: "the app
 * never reported the engine serving", on a launch that had reported it seconds earlier.
 *
 * SHARING IS ALSO THE MORE HONEST SEMANTIC. `said()` means "has this app ever said", and a tap
 * attached later answering "no" for a line already printed was quietly wrong — the same
 * attach-race `engine-boots.e2e.mts` documents at length for the READY line. `settleServing(out, n)`
 * indexes into occurrences, so a shared buffer gives it the true count rather than a suffix.
 *
 * A `WeakMap` so a closed app's buffer is collectable, and the listeners are attached once.
 */
const TAPS = new WeakMap<ElectronApplication, AppOutput>()

export function tapOutput(app: ElectronApplication): AppOutput {
  const existing = TAPS.get(app)
  if (existing) return existing
  const chunks: string[] = []
  const proc = app.process()
  proc.stdout?.on('data', (b: Buffer) => chunks.push(b.toString()))
  proc.stderr?.on('data', (b: Buffer) => chunks.push(b.toString()))
  const text = (): string => chunks.join('')
  const tap: AppOutput = {
    text,
    said: (needle) => text().includes(needle),
    ready: () => {
      const out: EngineReady[] = []
      // A fresh regex state per call: READY_RE is global, and a shared `lastIndex` across calls
      // would make the second read of the same text find nothing.
      READY_RE.lastIndex = 0
      for (const m of text().matchAll(READY_RE)) {
        out.push({
          pid: Number(m[1]),
          port: Number(m[2]),
          protocol: Number(m[3]),
          engineVersion: m[4].trim(),
          status: m[5]
        })
      }
      return out
    }
  }
  TAPS.set(app, tap)
  return tap
}

/**
 * Wait for the app to SAY something, or give up.
 *
 * A tail of the pipe is not a synchronous read: the lines a quit prints are written while the
 * process is ending and arrive on this side a beat later, so a plain read straight after
 * `closeWindows()` is a race the app usually loses.
 */
export async function settleSaid(out: AppOutput, needle: string, timeoutMs = 8_000): Promise<boolean> {
  const t0 = Date.now()
  while (!out.said(needle)) {
    if (Date.now() - t0 >= timeoutMs) return false
    await sleep(200)
  }
  return true
}

/** Wait for the app to announce a READY engine that is not `notPid`, or give up. */
export async function settleReady(
  out: AppOutput,
  notPid: number,
  timeoutMs = 30_000
): Promise<EngineReady | null> {
  const t0 = Date.now()
  for (;;) {
    const found = out.ready().find((r) => r.pid !== notPid)
    if (found) return found
    if (Date.now() - t0 >= timeoutMs) return null
    await sleep(200)
  }
}

// ── the go-live sentence (JOS-499, replacing the parity line) ──────────────────────────
//
// Door (2) again, and for the same reason it was the door for READY: this has no renderer surface
// and is not meant to — it is one sentence in the dev log at the one moment the engine starts
// answering the app.s reads. A spec that invented an IPC channel to observe it would be testing a
// product that does not exist.
//
// IT REPLACED THE PARITY LINE, which two specs used as a readiness PRECONDITION rather than for its
// verdict. The verdict went with the second world; the readiness is a real fact about this launch
// and is what those specs actually needed. Anchored field by field for READY_RE.s reason: a loose
// /serving/ would be satisfied by any sentence containing the word.

const SERVING_RE =
  /data-server serving: (.*?) — the engine's fold is live and is now answering this app's reads \(epoch (\d+)/g

/** One go-live edge, as the app reported it. */
export interface ServingSay {
  /** The whole line, for a failure detail that quotes rather than summarizes. */
  readonly line: string
  /** The log both sides are on. */
  readonly logPath: string
  readonly epoch: number
}

/** Every go-live edge seen so far, oldest first. One per attach, so a spec that switches
 *  characters sees several. */
export function servingRuns(out: AppOutput): ServingSay[] {
  return Array.from(out.text().matchAll(SERVING_RE), (m) => ({
    line: m[0],
    logPath: m[1],
    epoch: Number(m[2])
  }))
}

/**
 * Wait for the engine to start serving this app.s reads, or give up.
 *
 * GENEROUS BY DEFAULT because it waits for the ENGINE.s whole fold, from a DEBUG cargo build, which
 * the engine.s own README measures at roughly ten times the release cost. It is still a condition
 * and never a clock: the wait ends the moment the sentence appears.
 */
export async function settleServing(
  out: AppOutput,
  after = 0,
  timeoutMs = 180_000
): Promise<ServingSay | null> {
  const t0 = Date.now()
  for (;;) {
    const runs = servingRuns(out)
    if (runs.length > after) return runs[after]
    if (Date.now() - t0 >= timeoutMs) return null
    await sleep(250)
  }
}

// ── the durable half ───────────────────────────────────────────────────────────────────

/** `<userData>/errors.log`, or '' when nothing was ever written to it. The file sink is
 *  asynchronous now (JOS-371), so a caller that has just caused an entry polls rather than reads. */
export function errorLogText(userData: string): string {
  try {
    return readFileSync(join(userData, 'errors.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Wait for `<userData>/errors.log` to say something. */
export async function settleErrorLog(
  userData: string,
  ok: (text: string) => boolean,
  timeoutMs = 15_000
): Promise<string> {
  const t0 = Date.now()
  let text = errorLogText(userData)
  while (!ok(text) && Date.now() - t0 < timeoutMs) {
    await sleep(250)
    text = errorLogText(userData)
  }
  return text
}

// ── the door, knocked on with the wrong key ────────────────────────────────────────────

/** What a stranger gets for connecting to the engine's port. */
export interface KnockResult {
  /** Did the TCP connect succeed at all? */
  readonly connected: boolean
  /** Everything the engine said before it hung up. */
  readonly reply: string
  /** Did the engine close the connection by itself? */
  readonly closed: boolean
}

/**
 * Connect to the engine's loopback port with a WRONG token and see what happens.
 *
 * WHY THE HARNESS CAN DO THIS AT ALL, and why that is not a hole. The port is not a secret the
 * engine keeps — `token.ts`'s header says so in as many words: *loopback is not a permission
 * boundary… the port is not the authentication. The token is.* The harness learns the port the way
 * a developer does, by reading the app's own dev narration, and it never learns the token (main
 * mints it, writes it down the child's stdin, and REDACTS it out of everything the child says).
 * So this knock is exactly the position any other process on the machine is already in, and what
 * it proves is the property that matters: the open port is not an open door.
 *
 * The engine's answer is fixed by contract (engined's README, clause 4): one
 * `HelloReply { ok: false }` as a courtesy, then the socket closes.
 */
export function knockWithWrongToken(port: number, protocolVersion: number): Promise<KnockResult> {
  return new Promise<KnockResult>((resolve) => {
    // 64 hex characters, so the refusal is about the VALUE and not about the shape: a token that
    // fails `looksLikeToken` would be refused before the compare and would prove less.
    const wrong = 'f'.repeat(64)
    let reply = ''
    let connected = false
    let closed = false
    const socket = connect({ host: '127.0.0.1', port })
    const done = (): void => {
      socket.destroy()
      resolve({ connected, reply, closed })
    }
    socket.setTimeout(5_000, done)
    socket.on('connect', () => {
      connected = true
      socket.write(`${JSON.stringify({ op: 'hello', token: wrong, protocolVersion })}\n`)
    })
    socket.on('data', (b: Buffer) => {
      reply += b.toString()
    })
    socket.on('end', () => {
      closed = true
      done()
    })
    socket.on('error', done)
  })
}

/**
 * WAIT FOR ONE LAUNCH TO BE ANSWERING FROM THE ENGINE, then let the caller proceed.
 *
 * `settleServing` above takes an already-tapped output, because a spec that wants the SENTENCE
 * wants to keep reading the stream afterwards. This one exists for
 * `logFixture.launchOnFixture`, which has a launch and no tap, and whose callers mostly do not
 * care about the line at all — only that the world has arrived before they look at it.
 *
 * QUIET ON EXPIRY, deliberately. A launch with no engine binary never prints the sentence and is a
 * legitimate state (`tests/e2e/engine-absent.e2e.mts`); a wait that failed there would turn the
 * harness into a second opinion about whether an engine is required.
 */
export async function settleEngineServing(
  app: ElectronApplication,
  timeoutMs = 90_000
): Promise<boolean> {
  const out = tapOutput(app)
  const said = await settleServing(out, 0, timeoutMs)
  return said !== null
}

/**
 * WAIT FOR A REAL-INSTALL LAUNCH TO HAVE FOLDED THE OWNER'S WHOLE LOG, and PRINT how long it took.
 *
 * `settleEngineServing` above is for staged fixtures, where the fold is a few megabytes and 90 s is
 * an absurd amount of headroom. A spec that launches on the REAL INSTALL is waiting on the owner's
 * entire log — measured at 52.5 s per fold under the release engine (JOS-501) — and a step that
 * settles on rendered rows without waiting for that first is really settling on a whole-log fold
 * through whatever short cap it happened to choose. That is precisely how `bosses-week` read an
 * empty roster on its first release-engine run.
 *
 * THE NUMBER IS PRINTED, NEVER ASSERTED. It is the single most useful line in the log when a
 * real-install spec goes slow, and it is also a wall-clock measurement of somebody else's machine —
 * exactly the kind of frozen number this repo has learned rots (AGENTS.md). So it narrates and the
 * only thing that can fail is the CONDITION.
 *
 * QUIET ON EXPIRY for `settleEngineServing`'s reason: a launch with no engine binary legitimately
 * never says the sentence, and a wait that failed there would make the harness a second opinion
 * about whether an engine is required.
 */
export async function settleRealLogFold(
  app: ElectronApplication,
  label: string,
  timeoutMs = 240_000
): Promise<boolean> {
  const began = Date.now()
  const served = await settleEngineServing(app, timeoutMs)
  const secs = ((Date.now() - began) / 1000).toFixed(1)
  console.log(
    served
      ? `${label}: the engine folded the real log and is serving — ${secs}s`
      : `${label}: no serving sentence after ${secs}s — served surfaces will read empty`
  )
  return served
}

