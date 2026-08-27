// ============================================================================
// supervisorChild.ts — THE CHILD, STRUCTURALLY (split out of supervisor.ts, JOS-503).
// ============================================================================
//
// Every shape here is `node:child_process`'s reduced to what a lifecycle decision needs — the
// `PriorityWebContents` discipline (processPriority.ts): the real objects satisfy these by
// structure, and a test's fakes do too, so neither is a cast. Method parameters compare
// BIVARIANTLY, which is why `signal: string | null` below accepts Node's `NodeJS.Signals | null`.
//
// WHY IT IS ITS OWN FILE. `supervisor.ts` reached the repo's measured 400-code-line ceiling, and
// the house rule at that ceiling is to SPLIT rather than to ratchet (`dev.ts`/`perf.ts`/
// `windows.ts` beside `preload/index.ts` set the precedent, and `sliceSteps.mts` beside
// `leveling.e2e.mts` in the suite). This is the seam the file already had a section header for: it
// is about what a CHILD PROCESS looks like from here, which is a different subject from when to
// spawn one, and nothing in it mentions a launch, a token or a backoff.
//
// It imports the shared line codec and nothing else — no Electron, no `node:child_process`, no
// `node:net` — so the supervisor's structural Electron-freedom is unchanged by the move.

import { LineDecoder } from '../../shared/dataServer/ndjson'

export interface SupervisedStdin {
  write(chunk: string): unknown
  /** Closing stdin IS the shutdown signal — contract rule 3. */
  end(): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

export interface SupervisedStream {
  setEncoding(encoding: string): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
}

export interface SupervisedChild {
  /** OPTIONAL, not `number | undefined`: Node declares it optional on `ChildProcess` (it is absent
   *  until the process actually exists), and a required-but-undefined property is a different type
   *  that the real object does not satisfy. */
  readonly pid?: number
  readonly stdin: SupervisedStdin | null
  readonly stdout: SupervisedStream | null
  readonly stderr: SupervisedStream | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  /** NO SIGNAL PARAMETER, and that is the interface stating a policy rather than being lazy: the
   *  escalation sends the DEFAULT (`SIGTERM`, which on Windows is a `TerminateProcess`), and a seam
   *  that could carry a signal would be a seam somebody could send `SIGKILL` through on a platform
   *  that does not have it. It also makes the shape satisfiable: Node's `kill(signal?: Signals |
   *  number)` is not comparable to a `string` parameter in either direction. */
  kill(): unknown
  /** The engine must never hold a quitting app open. */
  unref(): unknown
}

/**
 * Split one of the child's streams into lines. `LineDecoder` is the shared codec — the same one the
 * wire uses — so there is exactly one answer in this repo to "where does a line end".
 *
 * IT CANNOT THROW INTO THE STREAM. `LineDecoder.push` raises on a frame past its ceiling, and a
 * throw inside a `'data'` handler is an uncaught exception in the main process — i.e. a child that
 * printed 8 MB with no newline could take the app down. A decoder that has given up is simply
 * stopped: the launch will fail its announce timeout or its next health probe, which are the paths
 * built to handle it.
 */
export function readLines(stream: SupervisedStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  const decoder = new LineDecoder()
  let dead = false
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    if (dead) return
    let lines: string[]
    try {
      lines = decoder.push(chunk)
    } catch {
      dead = true
      return
    }
    for (const line of lines) {
      if (line.trim() !== '') onLine(line)
    }
  })
}

/** Whatever was thrown, as a sentence. Every failure path in the supervisor lands here. */
export function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
