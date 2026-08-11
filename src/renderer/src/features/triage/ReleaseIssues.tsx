// ============================================================================
// ReleaseIssues.tsx — "top issues by version" (JOS-100).
// ============================================================================
//
// The half of Release health that an error COUNT cannot be. The section above it answers "did I
// release buggy code"; this answers "buggy HOW", which is the only version of the question
// somebody can act on.
//
// ITS OWN FILE, beside `ReleaseHealthSection.tsx` rather than inside it, for the repo's usual
// reason: that file is the chart plus the per-build table and adding a third structure to it
// would put it past the 400-code-line ceiling. The cut is also a real seam — everything here
// reads ONE field (`TriageReleaseHealthVersion.topIssues`) and nothing else on the page.
//
// ---------------------------------------------------------------------------------------
// WHAT IT SHOWS AND WHAT IT REFUSES TO
// ---------------------------------------------------------------------------------------
// A row is: how often, the error name, the redacted message, and when it was first and last
// seen. Expanding it shows the exemplar — frames and breadcrumbs — as the client sent it.
//
// THE NOT-REPORTING STATE IS NOT RE-STATED HERE. A build that cannot report has no issues, and
// so does a build that reported and was clean; the two are told apart ONE row up, in the table
// that owns that distinction (`reporting`, derived from the denominator). Repeating the
// judgement here would mean a second place that could get it wrong, so this component says
// nothing at all for a version with an empty list and lets the row above speak.
//
// THE MESSAGE IS RENDERED VERBATIM AND THAT IS SAFE BY CONSTRUCTION, not by escaping here: it
// arrived through `validateTelemetryEvent` on the wire, was re-redacted at the ingest Lambda,
// and was validated a THIRD time when the row was read back (`parseExemplar` in
// main/triage/releaseHealth.ts). `REDACTED_MESSAGE_RE` bounds it to printable ASCII, so there
// is no control character in it to render.

import { type JSX, useState } from 'react'
import { Box, Collapse, IconButton, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import type { TriageErrorExemplar, TriageReleaseHealthVersion, TriageReleaseIssue } from '@shared/triage'
import { formatNum } from '../../lib/formatRate'

const MONO = { fontFamily: 'monospace' } as const

/** One frame list, as the report carries it: `out/main/pipeline.js:120:15 - Object.foldEvent`. */
function FrameList({
  frames,
  testId
}: {
  frames: TriageErrorExemplar['frames']
  testId: string
}): JSX.Element {
  return (
    <Box component="ul" sx={{ m: 0, pl: 2 }} data-testid={testId}>
      {frames.map((f, i) => (
        <Typography
          component="li"
          variant="caption"
          key={`${f.file}:${String(f.line)}:${String(f.col)}:${String(i)}`}
          sx={MONO}
        >
          {f.file}:{f.line}:{f.col} - {f.func}
        </Typography>
      ))}
    </Box>
  )
}

/**
 * WHERE IT HAPPENED, and — since JOS-111 — what kind of "where" that is.
 *
 * A `capture` origin means the throw carried no stack of its own and these frames name the site
 * that CAUGHT it. That distinction is the whole reason the field exists: a reader who took a
 * capture site for a throw site would go looking for the bug in the console forwarder. The
 * caption says which, in words, rather than leaving it to a tag nobody would look up.
 */
function Frames({ exemplar }: { exemplar: TriageErrorExemplar }): JSX.Element {
  const external = exemplar.externalFrames ?? []
  if (exemplar.frames.length === 0 && external.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        No stack frames - the throw carried none, and it was caught somewhere that could not say
        where it came from.
      </Typography>
    )
  }
  return (
    <>
      {exemplar.frames.length === 0 ? null : (
        <>
          {exemplar.frameOrigin !== 'capture' ? null : (
            <Typography variant="caption" color="warning.main">
              The throw carried no stack. These frames are where it was CAUGHT, not where it was
              thrown.
            </Typography>
          )}
          <FrameList frames={exemplar.frames} testId="release-issue-frames" />
        </>
      )}
      {external.length === 0 ? null : (
        <>
          <Typography variant="caption" color="text.secondary">
            Outside the app bundle:
          </Typography>
          <FrameList frames={external} testId="release-issue-external-frames" />
        </>
      )}
    </>
  )
}

/**
 * The breadcrumbs, newest first, as `kind (+offset)`.
 *
 * THE OFFSETS ARE LOG TIME, back from the newest crumb — which is what makes them free to
 * collect on the parser's hot path (src/main/telemetry/breadcrumbs.ts). Said in the caption
 * rather than implied, because a reader who assumed wall clock would misread a replay-mode
 * crash, where these are the spacing of historical lines.
 */
function Crumbs({ exemplar }: { exemplar: TriageErrorExemplar }): JSX.Element | null {
  if (exemplar.breadcrumbs.length === 0) return null
  return (
    <Box data-testid="release-issue-crumbs">
      <Typography variant="caption" color="text.secondary">
        Log events just before, newest first (offsets in log time, back from the newest):
      </Typography>
      <Typography variant="caption" sx={{ ...MONO, display: 'block' }}>
        {exemplar.breadcrumbs
          .map((c) => (c.offsetMs === 0 ? c.kind : `${c.kind} −${String(Math.round(c.offsetMs / 100) / 10)}s`))
          .join(' · ')}
      </Typography>
    </Box>
  )
}

/** The expanded body: where it happened, and what the app was doing. */
function Exemplar({ issue }: { issue: TriageReleaseIssue }): JSX.Element {
  const e = issue.exemplar
  if (e === null) {
    return (
      <Typography variant="caption" color="warning.main" data-testid="release-issue-noexemplar">
        No example was stored for this fingerprint - the count is still real.
      </Typography>
    )
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, pl: 3, py: 0.5 }}>
      <Typography variant="caption" color="text.secondary">
        {e.mode === 'replay' ? 'while reading log history' : 'while following the log live'} · tab{' '}
        <Box component="span" sx={MONO}>
          {e.view}
        </Box>
        {e.code === undefined ? null : (
          <>
            {' · code '}
            <Box component="span" sx={MONO}>
              {e.code}
            </Box>
          </>
        )}
      </Typography>
      {e.componentPath === undefined ? null : (
        <Typography variant="caption" color="text.secondary" data-testid="release-issue-components">
          React components, innermost first:{' '}
          <Box component="span" sx={MONO}>
            {e.componentPath}
          </Box>
        </Typography>
      )}
      <Frames exemplar={e} />
      <Crumbs exemplar={e} />
      {/*
        THE SYMBOLICATION HINT. The frames name BUNDLE positions, which is all the wire can
        carry; turning them into source lines needs that version's sourcemaps, which CI keeps as
        a private artifact. Naming the command here is the difference between a reader knowing
        the maps exist and a reader concluding the frames are useless.
      */}
      <Typography variant="caption" color="text.secondary">
        Source terms:{' '}
        <Box component="span" sx={MONO}>
          triage-feedback errors show {issue.fingerprint} --maps &lt;dir&gt;
        </Box>{' '}
        against the <Box component="span" sx={MONO}>sourcemaps-&lt;version&gt;</Box> CI artifact.
      </Typography>
    </Box>
  )
}

function IssueRow({ issue }: { issue: TriageReleaseIssue }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Box data-testid="release-issue">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <IconButton
          size="small"
          onClick={() => {
            setOpen((v) => !v)
          }}
          aria-label={open ? 'Hide the example' : 'Show the example'}
          data-testid="release-issue-toggle"
        >
          {open ? <ExpandLessIcon fontSize="inherit" /> : <ExpandMoreIcon fontSize="inherit" />}
        </IconButton>
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', minWidth: 48 }}>
          {formatNum(issue.count)}×
        </Typography>
        <Typography variant="caption" sx={{ ...MONO, whiteSpace: 'nowrap' }}>
          {issue.errorName}
        </Typography>
        {/*
          THE MESSAGE IS THE SHRINKABLE ONE. A compact row means `nowrap` plus exactly one group
          that can ellipsize, and it has to be the world-supplied text rather than a count or a
          date (UI conventions, AGENTS.md) — the numbers either fit or the row is wrong.
        */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ ...MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1, minWidth: 0 }}
          title={issue.redactedMessage}
          data-testid="release-issue-message"
        >
          {issue.redactedMessage}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          {issue.firstSeen === issue.lastSeen ? issue.firstSeen : `${issue.firstSeen} → ${issue.lastSeen}`}
        </Typography>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Exemplar issue={issue} />
      </Collapse>
    </Box>
  )
}

/**
 * Top issues for every build that has any. A version with none renders NOTHING — see the header:
 * the reporting / not-reporting distinction belongs to the row above and is not restated here.
 */
export function ReleaseIssues({
  versions
}: {
  versions: readonly TriageReleaseHealthVersion[]
}): JSX.Element | null {
  const withIssues = versions.filter((v) => v.topIssues.length > 0)
  if (withIssues.length === 0) return null
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }} data-testid="release-issues">
      <Typography variant="caption" color="text.secondary">
        Top issues by build - grouped by a hash of the error and its top frames, so one bug is one
        row however many installs hit it. Expand for the example the first report carried.
      </Typography>
      {withIssues.map((v) => (
        <Box key={v.version} sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography variant="caption" sx={{ ...MONO, fontWeight: 600 }}>
            {v.version}
          </Typography>
          {v.topIssues.map((issue) => (
            <IssueRow key={issue.fingerprint} issue={issue} />
          ))}
        </Box>
      ))}
    </Box>
  )
}
