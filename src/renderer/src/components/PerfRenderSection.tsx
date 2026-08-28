// PerfRenderSection — RENDERER COMMITS, inside the performance popover (JOS-513).
//
// > "The app measures main, the engine, and serve latency, but nothing counts renderer COMMITS — so
// > a re-render regression shows up as feel, not as a number. Measured, never promised."
//
// It reads like `PerfEngineSection` one block down on purpose: the same `label · value` fact rows,
// the same tabular numerals, and the same rule that a thing with nothing behind it is OMITTED
// rather than shown as a zero. Its own file for that file's reason — the chip's popover is already
// at the repo's factoring ceiling and the answer to that is a split, not a ratchet.
//
// THE SECTION IS ABSENT, NOT EMPTY, IN A BUILD. `useRenderCommits` returns `null` when the meter is
// not compiled in, and `null` renders nothing at all — no heading, no dashes, no greyed row
// promising numbers that will never arrive. That is the whole of the production story: the ticket
// says dev-only and bug reports do NOT carry it, so a packaged app has no row to carry.
//
// THE ONE ZERO THAT IS ALLOWED IS THE APP-WIDE ROW, and it is the point of the feature rather than
// an exception to the rule. "0.0/s over the last 5 s" is a measurement somebody made with a mounted
// Profiler; an idle app that reads near-zero is the honest test of the whole render program. A
// SURFACE with no commits, by contrast, is a measurement nobody made — those rows are omitted.
//
// EVERY NUMBER HERE IS `renderCommits.ts`'s. Nothing is computed in this file except the choice
// between a number and a word.

import { type JSX } from 'react'
import { Divider, Stack, Tooltip, Typography } from '@mui/material'
import { formatMs } from '@shared/perf'
import { useRenderCommits } from '../lib/renderMeter'
import type { RenderCommitSample, SurfaceCommits } from '../lib/renderCommits'

/**
 * THE CAVEAT, CARRIED WITH THE NUMBER (the ticket names it, and `PerfEngineSection`'s budget rows
 * set the precedent: a caveat a reader needs at the moment he reads the figure belongs in the
 * tooltip, not in a document he does not have open).
 *
 * Both halves are measured facts about this instrument rather than hedging. StrictMode renders
 * every commit twice in dev, so a DURATION here is about double what the same commit costs in a
 * build. And this panel is inside the tree it counts: its own 1 Hz refresh lands in the app-wide
 * row while you read it — which is also why the per-view row, mounted below the title bar, is the
 * cleaner read of a view's own behaviour.
 */
const CAVEAT =
  'Dev-only, and this window only - each overlay is its own renderer process. ' +
  'Counts include React’s own bookkeeping: StrictMode renders every commit twice in dev (so a ' +
  'duration here is roughly double a build’s), and this panel’s own 1 Hz refresh commits into the ' +
  'app-wide row while you are reading it. The per-view row sits below the title bar and does not ' +
  'carry the panel’s own cost.'

/** One `label · value` row — `PerfEngineSection`'s `Fact`, mirrored rather than imported for the
 *  reason stated there: a four-line presentational helper is not a dependency worth having. */
function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
    </Stack>
  )
}

/** Seconds, one decimal — the window a rate was taken over, stated so `2.4/s` is never a figure
 *  over an interval the reader has to guess at. */
function seconds(ms: number): string {
  return `${(ms / 1_000).toFixed(1)} s`
}

/**
 * A rate, or the word for not having one yet. "measuring" is `PerfEngineSection`'s own vocabulary
 * for the first reading of a rate that has no interval behind it, and this is the same situation:
 * a meter that has been running for 300 ms cannot divide by a second.
 */
function rateOf(row: SurfaceCommits): string {
  return row.perSecond === null ? 'measuring' : `${row.perSecond.toFixed(1)}/s`
}

/** The per-surface rows: which Profiler id is committing, and how hard. Only ids with a commit in
 *  the window appear at all — see the header. */
function SurfaceRows({ surfaces }: { surfaces: readonly SurfaceCommits[] }): JSX.Element | null {
  if (surfaces.length === 0) return null
  return (
    <Stack spacing={0.25} data-testid="perf-render-surfaces">
      {surfaces.map((row) => (
        <Fact key={row.id} label={row.id} value={`${rateOf(row)} · ${String(row.commits)}`} />
      ))}
    </Stack>
  )
}

/**
 * The whole section. `null` — no meter in this build — renders NOTHING, which is the difference
 * between "this build does not count commits" and "this app is committing nothing"; the second of
 * those is a row that says 0.0/s.
 */
export default function PerfRenderSection({ open }: { open: boolean }): JSX.Element | null {
  const sample: RenderCommitSample | null = useRenderCommits(open)
  if (sample === null) return null
  const { root } = sample
  return (
    <Stack spacing={0.25} data-testid="perf-render">
      <Divider />
      <Tooltip title={CAVEAT} placement="left">
        <Typography variant="caption" color="text.secondary" sx={{ pt: 0.5 }}>
          render commits (dev, this window)
        </Typography>
      </Tooltip>
      <Fact
        label={`app-wide, last ${seconds(sample.spanMs)}`}
        value={`${rateOf(root)} · ${String(root.commits)}${sample.saturated ? ' or more' : ''}`}
      />
      {/* Absent rather than zero: with no commit in the window there is no worst commit, and
          `0 ms` would claim a render that took no time. */}
      {root.worstMs !== null && <Fact label="worst commit" value={formatMs(root.worstMs)} />}
      <SurfaceRows surfaces={sample.surfaces} />
    </Stack>
  )
}
