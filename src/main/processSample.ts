// ============================================================================
// processSample.ts — CPU AND MEMORY FOR A PROCESS ELECTRON CANNOT SEE (JOS-483).
// ============================================================================
//
// THE HOLE THIS FILLS, exactly. `app.getAppMetrics()` is CHROMIUM'S OWN process list — main, the
// renderers, the GPU process, the utility processes — and the data-server engine is not in it and
// never will be: it is a child this app spawned, not a child Chromium spawned. So the performance
// panel, which draws its whole table off that call, was structurally incapable of showing the one
// process the owner asked to see. This module is the second reader, for that one pid.
//
// ── WHY FFI, AND WHY NOT THE THREE ALTERNATIVES ────────────────────────────────────────────────
//
//   * `powershell.exe Get-Process` / `wmic` — FORBIDDEN, and not negotiably. PowerShell binaries
//     are the antivirus trigger this app spent a whole release eliminating; a perf panel that
//     spawned one every two seconds would put it straight back, and would cost more than the thing
//     it measures.
//   * A Node API. There is none. `process.cpuUsage()` and `process.resourceUsage()` describe THIS
//     process; `os` has no per-pid accessor; a spawned child's rusage is not available on Windows
//     and not while it is alive anywhere.
//   * Asking the engine to measure itself. Honest, and it was the near miss — but it would mean a
//     Windows API dependency inside a crate whose whole stated discipline is that it has none
//     (`engine/crates/engined/Cargo.toml`: serde, the protocol, the parser, the fold, and nothing
//     else), and a cross-platform `cfg` split for a number the app can read from outside.
//
// So it is koffi, which this app already carries and already uses for exactly this kind of read
// (`presenceNative.ts`, which opens the same two DLLs and one of the same three calls).
//
// ── THE ONE DISCIPLINE THIS BENDS, STATED PLAINLY ──────────────────────────────────────────────
//
// `presenceNative.ts` says "main never loads koffi, so a failure cannot take the app's own thread
// with it", and it loads in the presence WORKER. This module loads in MAIN, and the reasons it is
// the right trade here rather than a shortcut:
//
//   * THE HAZARD THAT RULE IS ABOUT DOES NOT EXIST HERE. The crash presence pays for is
//     `worker.terminate()` landing while the thread is inside a koffi call, which aborts the
//     process (`presenceProtocol.ts`, and `tests/presenceWorker.test.mts` pins it). Main is never
//     terminated. The other failure — `koffi.load` throwing on a machine or a Wine prefix that
//     will not map it — is an ordinary JS throw, caught below, and degrades to ABSENT.
//   * IT LOADS LAZILY AND ONLY ON DEMAND. Nothing here runs until the performance panel is open
//     AND an engine is running. A launch that never opens the panel never loads a DLL, so the
//     ordinary cost of this file is zero bytes of native code mapped.
//   * A DEDICATED WORKER WOULD COST MORE THAN IT BOUGHT. It would have to start and stop with the
//     panel (a resident thread is exactly the idle cost the perf surface must not become) and it
//     would need presence's message-based graceful-stop protocol to avoid re-introducing the very
//     terminate crash the rule exists for — a whole lifecycle for two reads every two seconds.
//
// WINDOWS ONLY. The calls are Win32; everywhere else this module answers `null`, which the panel
// already knows how to draw — absent is a documented answer, and it is not zero. `EQ_E2E` is NOT a
// second gate, and `processSampleIsSupported` argues why: this module only reads, so the rule that
// applies is `engineHost.ts`'s (the test mode changes as little about the product as possible)
// rather than `priorityIsSupported`'s (do not reschedule the machine running the suite).
//
// NOTHING HERE WRITES. Three read-only calls on a handle opened for querying, on a pid this app
// spawned itself. It cannot change a priority, cannot signal, cannot terminate.

import type { IKoffiLib } from 'koffi'

/** One raw reading of one process, straight off the OS. */
export interface ProcessReading {
  /**
   * TOTAL CPU THIS PROCESS HAS EVER CONSUMED, kernel + user, in milliseconds. A monotonic total
   * rather than a rate: a rate needs two readings and an interval, and deciding what interval to
   * use is the CALLER's business (see `createProcessSampler`).
   */
  cpuMs: number
  /**
   * Resident working set in BYTES, or `null` when the handle could not be opened wide enough to
   * ask. Times need only `PROCESS_QUERY_LIMITED_INFORMATION`; memory wants `VM_READ` as well, and
   * a process that grants one but not the other is a real (if rare) outcome — reporting `0` MB
   * there would be a measurement nobody took.
   */
  workingSetBytes: number | null
}

/** The seam. Injected so the fold above it is unit-testable with no DLL in the room. */
export type ProcessReader = (pid: number) => ProcessReading | null

/** What one poll of one process answers with. */
export interface ProcessSample {
  /**
   * Percent of ONE CORE, the same convention Chromium's `percentCPUUsage` uses — so the engine's
   * number is directly comparable with the rows beside it and may exceed 100 on a busy scan.
   *
   * `null` ON THE FIRST READING OF A PID, and that is the honest answer rather than a zero: a
   * rate is a measurement over an INTERVAL, and the first reading has no interval behind it. The
   * panel renders it as "measuring", which is what is actually happening.
   */
  cpuPercent: number | null
  /** Resident working set in MB, or `null` when it could not be read. */
  memoryMb: number | null
}

/** The previous reading of one pid, and when it was taken. */
interface Mark {
  cpuMs: number
  at: number
}

/**
 * CPU AS A PERCENTAGE OF ONE CORE, between two readings. PURE, and the only arithmetic in this file.
 *
 * `null` when the interval is not positive — two readings inside the same clock tick measure
 * nothing, and dividing by zero to produce `Infinity%` would be worse than saying so. Clamped at
 * zero below because a process's CPU total cannot fall, and a negative percentage would only ever
 * mean the pid was reused under us.
 */
export function cpuPercentBetween(prev: Mark, next: Mark): number | null {
  const elapsed = next.at - prev.at
  if (!(elapsed > 0)) return null
  const used = next.cpuMs - prev.cpuMs
  if (!Number.isFinite(used)) return null
  return Math.max(0, (used / elapsed) * 100)
}

/** Bytes to whole MB, matching `aggregateMetrics`' rounding so the rows read as one table. */
function toMb(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / (1024 * 1024))
}

/**
 * A sampler over one reader. It remembers the LAST reading per pid, which is the whole of its
 * state and the reason it is an object rather than a function.
 *
 * A PID THAT DISAPPEARS IS FORGOTTEN. A respawned engine is a new process with a new pid (contract
 * rule 5), so the marks are keyed by pid and a pid that stops answering drops out — an engine
 * whose pid was reused by an unrelated process would otherwise have its predecessor's CPU total
 * subtracted from a stranger's.
 */
export function createProcessSampler(
  read: ProcessReader,
  now: () => number = () => Date.now()
): { sample(pid: number): ProcessSample | null; forget(): void } {
  const marks = new Map<number, Mark>()
  return {
    sample(pid: number): ProcessSample | null {
      const reading = read(pid)
      if (reading === null) {
        marks.delete(pid)
        return null
      }
      const at = now()
      const previous = marks.get(pid)
      marks.set(pid, { cpuMs: reading.cpuMs, at })
      // Every pid but this one is dropped: there is exactly one engine, and a map that only ever
      // grew would be a leak measured in respawns.
      for (const key of marks.keys()) if (key !== pid) marks.delete(key)
      return {
        cpuPercent: previous === undefined ? null : cpuPercentBetween(previous, { cpuMs: reading.cpuMs, at }),
        memoryMb: toMb(reading.workingSetBytes)
      }
    },
    forget(): void {
      marks.clear()
    }
  }
}

// ---------------------------------------------------------------------------- the native reader

/** `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` — what `GetProcessMemoryInfo` documents it wants. */
const QUERY_AND_READ = 0x0400 | 0x0010
/** `PROCESS_QUERY_LIMITED_INFORMATION` — enough for `GetProcessTimes`, granted far more widely.
 *  The fallback, so a process that refuses the wider handle still reports its CPU. */
const QUERY_LIMITED = 0x1000

/**
 * One `FILETIME`: eight bytes, read as a little-endian u64 of 100-nanosecond intervals.
 *
 * FOUR SEPARATE BUFFERS, NOT ONE OF 32 BYTES WITH OFFSETS — and this is a bug this file already
 * had and a hand-run already caught, so it is written down rather than left to be rediscovered.
 * `GetProcessTimes` takes four INDEPENDENT `LPFILETIME` out-parameters and writes eight bytes at
 * each pointer. Handing it the same buffer four times is legal C and perfectly silent: all four
 * stamps land at byte 0, the last writer wins, and a read at offset 16 or 24 finds the zeros it was
 * initialised with. MEASURED before the fix: a child in a six-second busy loop reported `cpuMs: 0`
 * and the panel drew a permanent 0%, which is the exact class of lie this instrument exists to
 * prevent — a measurement nobody took, wearing the clothes of one that was.
 */
const FILETIME_BYTES = 8

/** `PROCESS_MEMORY_COUNTERS` on x64: two DWORDs then eight `SIZE_T`s, the second of which is the
 *  working set. `cb` is written before every call because the API reads it. */
const COUNTERS_BYTES = 72
const WORKING_SET_OFFSET = 16

/** A FILETIME is 100-nanosecond intervals; this is the divisor to milliseconds. */
const TICKS_PER_MS = 10_000

/** koffi hands back `(...args: any) => any`, which is honest — it cannot know a C signature's
 *  shape at the type level. Named here so the `any` is confined to one alias, exactly as
 *  `presenceNative.ts` confines its own. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win32Fn = (...args: any[]) => any

/**
 * Is this machine one where the native read is even attempted?
 *
 * WINDOWS ONLY, and `EQ_E2E` IS DELIBERATELY NOT A SECOND GATE — which is a difference from
 * `priorityIsSupported` worth stating, because the two look alike and the reasoning is not the same.
 * That module WRITES: it reprioritises real processes, and an integration test must not reschedule
 * the machine running it. This one only READS — a query handle, two counters, a close — and changes
 * nothing about any process. So the rule `engineHost.ts` names applies instead: *the test mode
 * changes as little about the product as possible*. Gating it would make the e2e exercise a
 * different app than the one that ships, and would hide the one number this whole feature exists to
 * show behind a branch nobody in the field takes.
 */
export function processSampleIsSupported(env: { platform: string }): boolean {
  return env.platform === 'win32'
}

interface Native {
  read: ProcessReader
}

/**
 * `null` once we have decided this machine cannot do it, a reader once we have decided it can,
 * and `undefined` while nobody has asked yet. THREE STATES ON PURPOSE: the decision is made once
 * and the failure is never retried, because a DLL that would not map will not map in two seconds
 * either and a panel poll must not become a retry loop.
 */
let native: Native | null | undefined

/** Open the two libraries and declare the four calls. THROWS; the caller catches, once. */
function loadNative(): Native {
  // Required lazily and inside the try, so a build or a machine where koffi cannot even be
  // resolved degrades the same way one where the DLL will not map does.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as {
    load(name: string): IKoffiLib
  }
  const kernel32 = koffi.load('kernel32.dll')
  const psapi = koffi.load('psapi.dll')
  const bind = (lib: IKoffiLib, prototype: string): Win32Fn => lib.func(prototype) as Win32Fn

  const OpenProcess = bind(
    kernel32,
    'void *__stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'
  )
  const CloseHandle = bind(kernel32, 'bool __stdcall CloseHandle(void *h)')
  const GetProcessTimes = bind(
    kernel32,
    'bool __stdcall GetProcessTimes(void *h, _Out_ void *creation, _Out_ void *exit, _Out_ void *kernel, _Out_ void *user)'
  )
  const GetProcessMemoryInfo = bind(
    psapi,
    'bool __stdcall GetProcessMemoryInfo(void *h, _Out_ void *counters, uint32 cb)'
  )

  // Scratch buffers allocated ONCE. This runs at the panel's cadence rather than 69 times a
  // second, so the argument is weaker than presence's — but one idiom in the repo beats two.
  const created = Buffer.alloc(FILETIME_BYTES)
  const exited = Buffer.alloc(FILETIME_BYTES)
  const kernel = Buffer.alloc(FILETIME_BYTES)
  const user = Buffer.alloc(FILETIME_BYTES)
  const counters = Buffer.alloc(COUNTERS_BYTES)

  const isHandle = (v: unknown): boolean => v !== null && v !== undefined && v !== 0

  return {
    read(pid: number): ProcessReading | null {
      if (!Number.isInteger(pid) || pid <= 0) return null
      // THE WIDE HANDLE FIRST, because it answers both questions; the narrow one is the fallback
      // that still answers the CPU half rather than reporting nothing at all.
      let wide = true
      let handle: unknown = OpenProcess(QUERY_AND_READ, false, pid)
      if (!isHandle(handle)) {
        wide = false
        handle = OpenProcess(QUERY_LIMITED, false, pid)
      }
      if (!isHandle(handle)) return null
      try {
        kernel.fill(0)
        user.fill(0)
        if (GetProcessTimes(handle, created, exited, kernel, user) !== true) return null
        // KERNEL + USER, which is what "this process used a core" means: a fold is user time and
        // a file read is kernel time, and a panel that reported only one of them would tell a
        // player their engine was idle while it saturated a disk.
        const ticks = kernel.readBigUInt64LE(0) + user.readBigUInt64LE(0)
        const cpuMs = Number(ticks) / TICKS_PER_MS
        let workingSetBytes: number | null = null
        if (wide) {
          counters.fill(0)
          counters.writeUInt32LE(COUNTERS_BYTES, 0)
          if (GetProcessMemoryInfo(handle, counters, COUNTERS_BYTES) === true) {
            workingSetBytes = Number(counters.readBigUInt64LE(WORKING_SET_OFFSET))
          }
        }
        return { cpuMs, workingSetBytes }
      } catch {
        // A call that threw is a reading nobody took. It is never an error the user hears about.
        return null
      } finally {
        CloseHandle(handle)
      }
    }
  }
}

/**
 * The reader this process actually uses: the native one where it is supported and loadable, and a
 * reader that answers `null` everywhere else.
 *
 * THE FIRST CALL IS THE ONLY ONE THAT CAN LOAD ANYTHING, and a failure is remembered as a refusal
 * rather than retried.
 */
export function systemProcessReader(): ProcessReader {
  if (native === undefined) {
    if (!processSampleIsSupported({ platform: process.platform })) {
      native = null
    } else {
      try {
        native = loadNative()
      } catch {
        native = null
      }
    }
  }
  const loaded = native
  return loaded === null ? () => null : loaded.read
}

/** Test seam: forget the load decision. Never called by the app. */
export function resetProcessSampleForTests(): void {
  native = undefined
}
