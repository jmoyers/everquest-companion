// ============================================================================
// SliceBox — the attached log slice, on screen, and NOWHERE ELSE.
// ============================================================================
//
// THE LAW (docs/plans/feedback-triage.md §10.3): a log slice never reaches anything public.
// These bytes came out of S3 into main, were cached under `.triage/slices/` (gitignored twice
// over) and crossed IPC as capped TEXT. They are rendered here, in a local window, on the
// operator's own machine. There is deliberately no copy button, no export, and no path from
// this component into an issue body — `triage-feedback issue` is the only publisher and it
// runs `assertNoLogSlice` over everything it posts.
//
// FIXED HEIGHT, ITS OWN SCROLL, WINDOWED — the AGENTS.md law for any long list, and here it is
// load-bearing twice over: a 5,000-line slice sized to its content would push the whole detail
// pane off the screen, and 5,000 mounted rows would stall the tab on every keystroke in the
// search box.
//
// THE RE-SCRUB CHIP. These lines were re-scrubbed on the way here — `downloadSlice` runs every
// downloaded slice through the app's OWN shared scrubber and text sanitizer before writing the
// local copy, because the presigned POST policy pins an upload's key, size and content-type and
// cannot pin its CONTENT. An honest client already ran that identical module, so its delta is
// zero and this component shows nothing. A NON-ZERO delta is evidence that the client-side scrub
// was skipped or bypassed, and that is exactly the kind of fact a panel must not keep quiet
// about — hence a warning, above the lines, before the operator reads a word of them.

import { type JSX, useDeferredValue, useMemo, useRef, useState } from 'react'
import { Alert, Box, InputAdornment, Stack, TextField, Typography } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import { useWindowedRows } from '../../lib/useWindowedRows'
import type { TriageSlice } from '@shared/triage'

/** Monospace line height. Fixed, because windowing needs one number it can trust. */
const LINE_HEIGHT = 17
const BOX_HEIGHT = 280

/** The re-scrub verdict, stated in the units the operator can act on. Null when there is none. */
function RescrubNotice({ slice }: { slice: TriageSlice }): JSX.Element | null {
  if (slice.rescrubUnknown) {
    return (
      <Alert severity="info" data-testid="triage-slice-rescrub-unknown">
        This copy was cached before re-scrub-on-read existed, so what it removed was never
        measured. Delete <code>{slice.path}</code> and re-open to get a real answer.
      </Alert>
    )
  }
  if (slice.rescrubDropped === 0 && slice.rescrubCleaned === 0) return null
  return (
    <Alert severity="warning" data-testid="triage-slice-rescrub">
      {slice.rescrubDropped > 0 && (
        <>
          Re-scrub removed <strong>{slice.rescrubDropped.toLocaleString()}</strong> line(s) of
          third-party chat that our own client would have removed before uploading - this slice
          was not scrubbed by our client.{' '}
        </>
      )}
      {slice.rescrubCleaned > 0 && (
        <>
          {slice.rescrubCleaned.toLocaleString()} line(s) carried control characters or ANSI
          escapes and were sanitized.{' '}
        </>
      )}
      The object in the bucket is untouched - it is the evidence; only this local copy was
      cleaned.
    </Alert>
  )
}

export default function SliceBox({ slice }: { slice: TriageSlice }): JSX.Element {
  const [query, setQuery] = useState('')
  // The input echoes instantly; the filter runs on the deferred value — the app's search law.
  const deferred = useDeferredValue(query)
  const scrollRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    if (needle.length === 0) return slice.lines
    return slice.lines.filter((l) => l.toLowerCase().includes(needle))
  }, [slice.lines, deferred])

  const win = useWindowedRows({ count: lines.length, rowHeight: LINE_HEIGHT, scrollRef })
  const filtering = deferred.trim().length > 0

  return (
    <Stack spacing={1}>
      <RescrubNotice slice={slice} />
      <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap">
        <TextField
          size="small"
          placeholder="Search in slice"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
          sx={{ minWidth: 260 }}
          data-testid="triage-slice-search"
        />
        {/* Counts, in the app's own units. `totalLines` is the slice; `lines.length` is what
            the filter kept; `truncated` says the bridge capped it — never a silent shortfall. */}
        <Typography variant="caption" color="text.secondary">
          {filtering
            ? `${lines.length.toLocaleString()} of ${slice.lines.length.toLocaleString()} lines match`
            : `${slice.lines.length.toLocaleString()} lines shown`}
          {slice.truncated
            ? ` · capped from ${slice.totalLines.toLocaleString()} - the full slice is cached at ${slice.path}`
            : ''}
        </Typography>
      </Stack>

      <Box
        ref={scrollRef}
        data-testid="triage-slice"
        sx={{
          height: BOX_HEIGHT,
          overflow: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          bgcolor: 'background.default',
          fontFamily: 'monospace',
          fontSize: 11,
          lineHeight: `${String(LINE_HEIGHT)}px`,
          px: 1,
          py: 0.5,
          whiteSpace: 'pre'
        }}
      >
        <div style={{ height: win.topPad }} />
        {lines.slice(win.start, win.end).map((line, i) => (
          <div key={win.start + i}>{line}</div>
        ))}
        <div style={{ height: win.bottomPad }} />
        {lines.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            No line in this slice matches.
          </Typography>
        )}
      </Box>
    </Stack>
  )
}
