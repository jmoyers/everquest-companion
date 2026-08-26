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
export function tapOutput(app: ElectronApplication): AppOutput {
  const chunks: string[] = []
  const proc = app.process()
  proc.stdout?.on('data', (b: Buffer) => chunks.push(b.toString()))
  proc.stderr?.on('data', (b: Buffer) => chunks.push(b.toString()))
  const text = (): string => chunks.join('')
  return {
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

// ── the parity probe's one line (JOS-479) ──────────────────────────────────────────────
//
// Door (2) again, and for the same reason it was the door for READY: the probe has no renderer
// surface, by ruling — it is an instrument that writes ONE sentence to the dev log and changes
// nothing. So the app's own stdout is not a convenient way to observe it, it is the only way, and a
// spec that invented an IPC channel to read a verdict would be testing a product that does not
// exist. The line's shape is `src/main/dataServer/parityProbe.ts parityLine`, and the head is
// anchored field by field for `READY_RE`'s reason: a loose `/parity/` would be satisfied by a
// sentence containing the word, and this line is the whole evidence that two worlds were compared.

const PARITY_RE =
  /data-server parity: (\d+) agree, (\d+) diverge, (\d+) skipped of (\d+) \[([^\]]*)\] — ([^\n]*)/g

/** What one module's clause said. `null` when the line never mentioned it. */
export type ModuleVerdict = 'AGREE' | 'DIVERGE' | 'SKIP'

/** One parity run, as the app reported it. */
export interface ParitySay {
  /** The whole line, for a failure detail that quotes rather than summarizes. */
  readonly line: string
  readonly agree: number
  readonly diverge: number
  readonly skipped: number
  readonly probed: number
  /** The bracket: `epoch N, engine <status>, <n> events, mtime <ms>, mark <offset> of <logPath>` —
   *  the last clause being the ENGINE's own answer about which file it is folding and how far it
   *  has got, and the one before it the file fact owner ruling 21 made the server's to state. */
  readonly where: string
  /** The log the ENGINE said it was folding, off that bracket, or null when it named no mark. */
  readonly engineLog: string | null
  /** The log file's mtime AS THE ENGINE SERVED IT, or null when the line said `no mtime`. The app
   *  can stat the same file itself, which is exactly what makes this checkable. */
  readonly engineMtimeMs: number | null
  /** The per-module clauses, joined — `loot AGREE(seq 4211) · kills AGREE(seq 4211) · …`. */
  readonly modules: string
  /** What the line said about one module, or null if it did not name it. */
  verdict(module: string): ModuleVerdict | null
  /** WHERE a module diverged — the dotted path the probe reported — or null when it did not
   *  diverge. A spec that pins a KNOWN divergence has to pin the path too, or the pin would be
   *  satisfied by any new defect in the same module. */
  divergePath(module: string): string | null
}

/** One module's clause out of the joined tail — `loot AGREE(seq 4211)`. Anchored on the ` · `
 *  separator rather than on the bare name, because a divergence detail quotes arbitrary state and
 *  can contain a module's name inside it. */
function clauseFor(modules: string, module: string): string | null {
  const re = new RegExp(`(?:^|· )${module} (?:AGREE|DIVERGE|SKIP)[^·]*`)
  const found = re.exec(modules)
  return found ? found[0].replace(/^· /, '').trimEnd() : null
}

function readParity(match: RegExpMatchArray): ParitySay {
  const modules = match[6]
  const where = match[5]
  const mark = /, mark \d+ of (.+)$/.exec(where)
  // ANCHORED ON ITS OWN CLAUSE, not on the bracket's tail: the mark clause ends the sentence
  // because a log path can contain anything, so everything else is read by name from in front of
  // it. `no mtime` is the engine having no answer, and it parses to null rather than to NaN.
  const mtime = /, mtime (\d+),/.exec(where)
  return {
    line: match[0],
    agree: Number(match[1]),
    diverge: Number(match[2]),
    skipped: Number(match[3]),
    probed: Number(match[4]),
    where,
    engineLog: mark ? mark[1] : null,
    engineMtimeMs: mtime ? Number(mtime[1]) : null,
    modules,
    verdict: (module) => {
      const clause = clauseFor(modules, module)
      if (clause === null) return null
      const found = /(AGREE|DIVERGE|SKIP)/.exec(clause)
      return found ? (found[1] as ModuleVerdict) : null
    },
    divergePath: (module) => {
      const clause = clauseFor(modules, module)
      const found = clause === null ? null : /\) at (.+?): engine /.exec(clause)
      return found ? found[1] : null
    }
  }
}

/** Every parity line seen so far, oldest first. A run per attach, so a spec that switches
 *  characters can read the second one. */
export function parityRuns(out: AppOutput): ParitySay[] {
  PARITY_RE.lastIndex = 0
  return Array.from(out.text().matchAll(PARITY_RE), readParity)
}

/**
 * Wait for the app to report a parity run, or give up.
 *
 * GENEROUS BY DEFAULT because the probe waits for BOTH folds — this process's historical scan and
 * the engine's, the latter from a DEBUG cargo build, which the engine's own README measures at
 * roughly ten times the release cost. It is still a condition and never a clock: the wait ends the
 * moment the sentence appears.
 */
export async function settleParity(
  out: AppOutput,
  after = 0,
  timeoutMs = 180_000
): Promise<ParitySay | null> {
  const t0 = Date.now()
  for (;;) {
    const runs = parityRuns(out)
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
