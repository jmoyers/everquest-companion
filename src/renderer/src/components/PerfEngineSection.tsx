// PerfEngineSection — THE DATA-SERVER ENGINE, inside the performance popover (JOS-483).
//
// > "i want to see the server in the cpu/performance overlay in app." — owner, ruling 19.
//
// It reads like the rest of that popover on purpose: the same `label · value` fact rows, the same
// tabular numerals, the same rule that a thing with nothing behind it is OMITTED rather than shown
// as a zero. `PerfChip.tsx` says why that rule exists one section up — "GPU 0% 0 MB" invites the
// question of whether the GPU process died — and it is exactly as true of a view source nobody has
// subscribed to.
//
// ITS OWN FILE because `PerfChip.tsx` is the chip and its popover, and this is a feature inside the
// popover with its own data source and its own lifecycle. One more block in that file would have
// pushed it past the repo's factoring ceiling, and the answer to that is a split.
//
// THE SECTION IS ABSENT, NOT EMPTY, when there is no engine: the flag is off, or this build carries
// no engine binary (the ordinary state of any checkout that has not run `cargo build`). Main
// collapses those two into one `null` and this renders nothing at all — the chip's own "hidden
// entirely when disabled" discipline, one level down.
//
// EVERY NUMBER HERE IS SOMEBODY ELSE'S MEASUREMENT. Nothing is computed in this file except the
// freshness subtraction, which is `shared/enginePerf.ts`'s pure function and lives there with its
// argument about whose clock is whose.

import { type JSX } from 'react'
import { Divider, Stack, Typography } from '@mui/material'
import {
  engineFireCount,
  eventFreshnessMs,
  formatAge,
  formatBytes,
  formatEngineState,
  formatMicros,
  formatParity,
  type EnginePerfSample
} from '@shared/enginePerf'
import { formatCpu, formatMemory, formatMs } from '@shared/perf'
import type { PerfServeSource } from '@shared/dataServer/protocol.generated'

/** One `label · value` row. The popover's own shape — see `PerfChip.tsx`'s `Fact`, which this
 *  deliberately mirrors rather than imports: that one is private to the chip's own layout, and two
 *  files sharing a four-line presentational helper is not a dependency worth having. */
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

/** Thousands separators, and nothing else. An event count in the hundreds of thousands is the
 *  ordinary case and `139860` is not a number a person reads at a glance. */
function count(n: number): string {
  return n.toLocaleString()
}

/**
 * The engine's own process row — the thing `app.getAppMetrics()` structurally cannot report, and
 * the literal subject of the owner's ask.
 *
 * "measuring" RATHER THAN "0%" on the first reading of a pid: a CPU percentage is a rate and the
 * first reading has no interval behind it. The second poll, two seconds later, has one.
 */
function ProcessRow({ sample }: { sample: EnginePerfSample }): JSX.Element {
  const p = sample.process
  if (p === null) {
    // The supervisor says something exists but no pid could be read — a launch mid-handshake, a
    // backoff between attempts, or a platform where the native read is not attempted at all.
    return <Fact label="engine process" value={`${sample.supervisor} · no process`} />
  }
  const cpu = p.cpuPercent === null ? 'measuring' : formatCpu(p.cpuPercent)
  const mem = p.memoryMb === null ? 'memory unavailable' : formatMemory(p.memoryMb)
  return <Fact label={`engine (pid ${String(p.pid)})`} value={`${cpu} · ${mem}`} />
}

/** What building this generation cost. Each half is omitted while it is still unmeasured — a scan
 *  that has not finished has no duration, and `0 ms` there would say a whole log folded instantly. */
function IngestFacts({ sample }: { sample: EnginePerfSample }): JSX.Element | null {
  const ingest = sample.engine?.ingest
  if (ingest === undefined) return null
  const scan =
    ingest.scanMs === undefined
      ? null
      : `${formatMs(ingest.scanMs)}${ingest.scanBytes === undefined ? '' : ` of ${formatBytes(ingest.scanBytes)}`}`
  return (
    <>
      {ingest.spellDbMs !== undefined && (
        <Fact label="spell db" value={formatMs(ingest.spellDbMs)} />
      )}
      {scan !== null && <Fact label="scan" value={scan} />}
    </>
  )
}

/**
 * ONE VIEW SOURCE'S SERVE PATH — the two measurements ruling 19 names, per source.
 *
 * The latency is absent, not zero, when no frame here had a fold behind it: the opening reset a
 * just-opened subscription is owed carries no fold instant, and timing it against the age of the
 * session is precisely the lie the engine's meter refuses to tell.
 */
function ServeRow({ row }: { row: PerfServeSource }): JSX.Element {
  const latency =
    row.foldToFrameUsMean === undefined
      ? 'not timed'
      : `${formatMicros(row.foldToFrameUsMean)}${row.foldToFrameUsMax === undefined ? '' : ` / ${formatMicros(row.foldToFrameUsMax)}`}`
  const watchers = row.subscribers === 0 ? 'unwatched' : `×${String(row.subscribers)}`
  return (
    <Fact
      label={`${row.source} ${watchers}`}
      value={`${count(row.frames)} frames · ${formatBytes(row.payloadWeight)} · ${latency}`}
    />
  )
}

/** The serve table, or the honest sentence when nothing has been subscribed to yet. */
function ServeTable({ sample }: { sample: EnginePerfSample }): JSX.Element {
  const serve = sample.engine?.serve ?? []
  if (serve.length === 0) {
    return <Fact label="views" value="none subscribed" />
  }
  return (
    <Stack spacing={0.25} data-testid="perf-engine-serve">
      {serve.map((row) => (
        <ServeRow key={row.source} row={row} />
      ))}
    </Stack>
  )
}

/** How far behind the log's own clock the engine's last folded event is. */
function freshness(sample: EnginePerfSample): string | null {
  const ms = eventFreshnessMs(sample)
  return ms === null ? null : `${formatAge(ms)} behind`
}

/**
 * The whole section. `null` — nothing to draw — renders NOTHING, which is the difference between
 * "this build has no engine" and "the engine is idle": the second is a row, the first is silence.
 */
export default function PerfEngineSection({
  sample
}: {
  sample: EnginePerfSample | null
}): JSX.Element | null {
  if (sample === null) return null
  const engine = sample.engine
  const behind = freshness(sample)
  const fires = engineFireCount(engine)
  return (
    <Stack spacing={0.25} data-testid="perf-engine">
      <Divider />
      <Typography variant="caption" color="text.secondary" sx={{ pt: 0.5 }}>
        data-server engine
      </Typography>
      <ProcessRow sample={sample} />
      <Fact label="state" value={formatEngineState(sample)} />
      {engine?.events !== undefined && (
        <Fact
          label="events folded"
          value={behind === null ? count(engine.events) : `${count(engine.events)} · ${behind}`}
        />
      )}
      {engine?.mark !== undefined && (
        <Fact label="mark" value={`${formatBytes(engine.mark.offset)} read`} />
      )}
      <IngestFacts sample={sample} />
      <ServeTable sample={sample} />
      {fires !== null && <Fact label="fires" value={count(fires)} />}
      <Fact label="parity, last probe" value={formatParity(sample.parity)} />
    </Stack>
  )
}
