// lib/renderMeter.tsx — THE RENDER METER'S MOUNTS AND ITS GATE (JOS-513).
//
// > "DEV-MODE ONLY instrumentation (zero production cost — the standing perf-surface discipline)."
//
// `renderCommits.ts` is the arithmetic and can be driven from a desk; this is everything that only
// exists inside a running renderer — the `<Profiler>` wrapper, the one ring the whole window writes
// into, and the poll-while-open hook the panel reads.
//
// ---------------------------------------------------------------------------------------------
// THE GATE IS SPELLED `import.meta.env.DEV` AT EVERY SITE, AND THAT IS A MEASUREMENT, NOT A STYLE
// ---------------------------------------------------------------------------------------------
// The anchor is vite's own builtin, for `devFlags.ts`'s reason, applied unchanged: a `define` only
// exists from the moment a dev server booted, so a stale `npm run dev` would silently lose the
// instrument. It is NOT `DEV_TOOLS` — that flag means "operator tooling that will never ship" and
// carries a config override; this is a measurement of the app's own health that every
// contributor's dev session should have, with nothing to configure.
//
// THE FIRST VERSION OF THIS FILE EXPORTED `RENDER_METER` and every site read that, which is the
// tidier shape and DID NOT STRIP. Measured on the real `electron-vite build` this repo's e2e suite
// produces: `out-e2e/renderer/assets/index-*.js` still carried `perf-render`, `saturated` and the
// whole ring. Rollup does not inline a cross-module constant here, so `RENDER_METER ? … : …` stayed
// a runtime branch and everything behind it stayed reachable. `import.meta.env.DEV` is substituted
// by vite AT TRANSFORM TIME, INSIDE EACH MODULE, so the ternary is already `false ? … : …` before
// rollup sees it — the branch folds, the imports go unreferenced, and the meter leaves the bundle.
// Same guarantee `devFlags.ts` claims for the triage tab, and proven the same way it says to prove
// it: by grep on the build, not by intent.
//
// FOUR GATES, ALL AUDITED by `tests/renderCommits.test.mts`, which fails the build if a `<Profiler`
// appears in `src/renderer` outside the blessed sites or if any of them stops checking:
//
//   * the two MOUNTS (`main.tsx`, `components/MainColumn.tsx`) pick the wrapper or the bare child —
//     so a build has no Profiler in the tree, no callback, and no ring;
//   * the SECTION (`components/PerfChip.tsx`) is not rendered at all, which is what makes
//     `PerfRenderSection` and this whole file unreachable and therefore deletable;
//   * `useRenderCommits` refuses to arm its interval regardless — belt and braces for a future
//     caller, and the reason the section would still draw nothing even if the bytes survived.
//
// ---------------------------------------------------------------------------------------------
// ONE RING PER WINDOW, AND WHAT THAT MEANS FOR THE OVERLAYS
// ---------------------------------------------------------------------------------------------
// Every overlay is its OWN renderer process with its own React root (`overlay/main.tsx`), so its
// commits are not reachable from this window's ring without either a main-side relay — outside this
// ticket's fences — or an always-on cross-window broadcast, which would violate the poll-only-while-
// open discipline this whole surface is built on. So the panel counts THIS WINDOW, says so in its
// heading, and the overlays remain visible one section up as their own renderer processes in the
// per-process CPU table. Reported to the owner rather than quietly approximated.

import { Profiler, type JSX, type ReactNode, useEffect, useState } from 'react'
import {
  createRing,
  recordCommit,
  summarizeCommits,
  type CommitRing,
  type RenderCommitSample
} from './renderCommits'

/** The outermost Profiler's id — the app-wide row. Named here so the mount and the panel cannot
 *  drift apart on a string. */
export const APP_PROFILER_ID = 'app'

/** How often the open panel re-reads the ring. 1 Hz: fast enough that the number is current while
 *  you watch it, slow enough that the panel's own refresh is a small, STATED part of what it
 *  counts (the caveat is in the section's tooltip — an instrument inside the thing it measures
 *  must say so rather than pretend). */
export const RENDER_READ_INTERVAL_MS = 1_000

/**
 * The window's one ring, created on the FIRST commit rather than at module load — so a production
 * bundle, which mounts no Profiler at all, never allocates the buffers.
 */
let ring: CommitRing | null = null

function meter(): CommitRing {
  ring ??= createRing(performance.now())
  return ring
}

/**
 * React's commit callback. Its real signature carries six parameters and this takes three, which is
 * both legal and the point: `commitTime` is the sixth, and reading the clock here instead — the
 * callback runs during the commit React is reporting — costs nothing and keeps the callback inside
 * the repo's measured `max-params` ceiling. `phase` is unnamed-but-present because the parameter
 * after it is the one this needs; mount and update commits are both commits and both counted.
 */
function onCommit(id: string, phase: 'mount' | 'update' | 'nested-update', actualDuration: number): void {
  recordCommit(meter(), id, performance.now(), actualDuration)
}

/**
 * One Profiler mount. Mounted ONLY behind `RENDER_METER` at both of its call sites, so this
 * component does not exist in the tree of a build — it is not a passthrough in production, it is
 * absent.
 */
export function RenderProfiler({ id, children }: { id: string; children: ReactNode }): JSX.Element {
  return (
    <Profiler id={id} onRender={onCommit}>
      {children}
    </Profiler>
  )
}

/**
 * The panel's numbers, and the whole of the polling discipline (the shape `useEnginePerf` set).
 *
 * `open` IS THE ARMING SIGNAL, passed in rather than inferred from being mounted: the section lives
 * inside a Popover that is open for seconds at a time, and a `keepMounted` added there one day must
 * not silently turn a 1 Hz read into a session-long one.
 *
 * `null` IS A REAL ANSWER, not a loading state — it means there is no meter: a production build, or
 * a panel nobody is looking at. The section renders nothing at all, which is the difference between
 * "this build does not measure commits" and "this app committed nothing", and the second of those
 * is a row reading 0.0/s.
 *
 * RECORDING IS NOT GATED ON `open`. The ring is written by the Profilers whenever the app renders,
 * because a five-second window that only started filling when the popover opened would show the
 * cost of OPENING THE POPOVER and nothing else. What `open` gates is the read.
 */
export function useRenderCommits(open: boolean): RenderCommitSample | null {
  const [sample, setSample] = useState<RenderCommitSample | null>(null)

  useEffect(() => {
    if (!import.meta.env.DEV || !open) return undefined
    const read = (): void => {
      setSample(summarizeCommits(meter(), performance.now(), { rootId: APP_PROFILER_ID }))
    }
    // Read once immediately: the first interval tick is a whole second away and a panel that opens
    // blank for a second reads as broken.
    read()
    const timer = setInterval(read, RENDER_READ_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      // Dropped on close for `useEnginePerf`'s reason: a reading from the last time this was open
      // describes a moment that has passed.
      setSample(null)
    }
  }, [open])

  return sample
}
