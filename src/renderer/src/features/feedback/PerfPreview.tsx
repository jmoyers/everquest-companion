// PerfPreview — the last ten minutes of stall and tail-read timing, shown before it is sent (JOS-369).
//
// WHY IT IS SHOWN AT ALL, AND WHY IT HAS NO CHECKBOX. This feature's whole promise is "you see
// exactly what is sent", and the perf block leaves the machine with the report, so it is on
// screen. It gets no opt-out control because there is nothing here to opt out OF: sixty rows of
// whole milliseconds, six counters and eleven machine facts drawn from closed enums — no log
// content, no path, no character, no identifier (shared/feedbackPerf.ts states the boundary).
// A checkbox would imply a choice about personal data that this block does not contain.
//
// COLLAPSED BY DEFAULT, and that is the opposite call from the log slice — deliberately. The slice
// is shown EXPANDED because an artifact you have to go looking for is not one you have read, and
// it carries your character's name, your zones and your fights. This carries timer lateness. The
// summary line and the shape are visible without a click; the sixty rows are one click away.
//
// De-nesting: the rows reuse `PreviewLines` — the same fixed-height tonal fill the slice and the
// inventory dump use, not a third subtly-different scroll box.

import { useState, type JSX } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { formatPerfState, formatPerfSummary, perfSparkline, type FeedbackPerf } from '@shared/feedbackPerf'
import { formatPerfEngine } from '@shared/feedbackPerfEngine'
import { PreviewLines } from './LogPreview'
import type { FeedbackContext } from './useFeedback'

/** One row per bucket, as fixed-width text — the same vocabulary the triage CLI prints, so the
 *  reporter and the owner are looking at the same table. */
function rowLines(perf: FeedbackPerf): string[] {
  const head = '   t   main worker   tail  reads reopen'
  const body = perf.rows.map((r) =>
    [
      `${r.t.toString().padStart(4)}s`,
      r.mainMaxLateMs.toString().padStart(6),
      r.workerMaxLateMs.toString().padStart(6),
      r.tailMaxMs.toString().padStart(6),
      r.tailReads.toString().padStart(6),
      r.tailReopens.toString().padStart(6)
    ].join('')
  )
  return [head, ...body]
}

/**
 * The block, or nothing at all.
 *
 * ABSENT is the ordinary state for a report composed in the first seconds of a session — the
 * probe starts at `replayDone` — and it renders as ABSENCE rather than as "no data recorded".
 * There is no attachment, so there is nothing to disclose, and a row explaining that would be a
 * paragraph about a thing that is not happening. `ctx` being null (still in flight) reads the
 * same way, for one turn of the render.
 */
export default function PerfPreview({ ctx }: { ctx: FeedbackContext | null }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const perf: FeedbackPerf | undefined = ctx?.env.perf
  if (perf === undefined) return null
  const minutes = Math.round((perf.rows.length * perf.intervalMs) / 60_000)
  return (
    <Stack spacing={0.5}>
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        role="button"
        tabIndex={0}
        data-testid="feedback-perf-toggle"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setOpen(!open)
        }}
        sx={{ cursor: 'pointer', userSelect: 'none' }}
      >
        {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        <Typography variant="body2">Performance timeline (last {minutes} min)</Typography>
      </Stack>

      <Typography
        variant="caption"
        color="text.secondary"
        data-testid="feedback-perf-summary"
        sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}
      >
        {formatPerfSummary(perf)}
      </Typography>

      {/* The shape, at a glance: one character per ten seconds, oldest first. `pre` because the
          blanks between hitches are the information. */}
      <Box
        data-testid="feedback-perf-sparkline"
        sx={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 11,
          whiteSpace: 'pre',
          overflowX: 'auto',
          color: 'text.secondary'
        }}
      >
        {`|${perfSparkline(perf)}|`}
      </Box>

      {open && (
        <>
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="feedback-perf-state"
            sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}
          >
            {formatPerfState(perf)}
          </Typography>
          {/* THE ENGINE'S OWN NUMBERS (ruling 19, JOS-502), and it is drawn HERE rather than
              arriving free with `formatPerfBlock` because this file deliberately composes the
              formatters itself instead of printing the CLI's composite. That is the whole reason
              this line exists: the feature's promise is "you see exactly what is sent", and a
              block that grew a section the dialog did not draw would break it silently. It is
              inside the expanded half beside the machine facts, which is where the reader who
              wants the detail already is. `formatPerfEngine` says "no engine answered" in words
              when there is nothing — a finding, not a blank. */}
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="feedback-perf-engine"
            sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}
          >
            {`engine: ${formatPerfEngine(perf.engine)}`}
          </Typography>
          <PreviewLines lines={rowLines(perf)} testId="feedback-perf-rows" />
        </>
      )}
    </Stack>
  )
}
