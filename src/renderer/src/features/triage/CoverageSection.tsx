// ============================================================================
// CoverageSection — what this pipeline can see, and what it cannot (JOS-109).
// ============================================================================
//
// Every other section of the Analytics tab describes the fleet that reports. This one describes
// the edge of it, and the copy is the feature: the numbers are two lines of arithmetic, and the
// reason the block exists is that both of them are easy to read as something they are not.
//
// TWO MEASUREMENTS, RENDERED APART, LABELLED DIFFERENTLY, NEVER COMBINED:
//
//   1. OPT-OUT FLIPS, exact over installs that ever reported. A count of a thing people did.
//   2. DOWNLOADS vs REPORTING INSTALLS, an ESTIMATE, printed as two numbers with the gap left
//      visible. THE SUBTRACTION IS NOT PERFORMED ANYWHERE, in this file or upstream of it: a
//      download is not an install, so the difference is not a count of dark installs, and a
//      component that rendered it would be publishing a fabricated number with a plausible name.
//
// `src/main/triage/coverage.ts` carries the long-form argument. What is repeated here is only
// what a person reading the screen needs in order not to misread it.
//
// HOUSE RULE: no em dashes in user-facing copy.

import type { JSX } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import type { TriageAnalyticsData, TriageDownloads } from '@shared/triage'
import { formatNum } from '../../lib/formatRate'
import { Section } from './AnalyticsBits'

/**
 * Installer fetches across every published release.
 *
 * SUMMED ACROSS TAGS, WHICH IS ITSELF AN OVERCOUNT and is the second reason this number can never
 * be an install count: one machine that has updated through four releases contributed four
 * downloads. It is printed anyway, because the alternative (the largest single tag) understates
 * just as confidently, and the honest thing to publish is the raw fetch total with the sentence
 * that says what it is.
 */
function installerDownloads(downloads: TriageDownloads): number {
  return downloads.available ? downloads.releases.reduce((sum, r) => sum + r.exeDownloads, 0) : 0
}

/** The flips table. Only builds that reported one appear, and the caption says why that matters. */
function FlipRows({ data }: { data: TriageAnalyticsData }): JSX.Element {
  const c = data.coverage
  if (!c.anyFlips) {
    return (
      <Typography variant="caption" color="text.secondary" data-testid="coverage-no-flips">
        No flips reported in this window. That is genuinely ambiguous: nobody turned it off, or no
        install is running a build new enough to say. There is no per build &ldquo;can report a
        flip&rdquo; signal to tell the two apart, so this does not render as a zero.
      </Typography>
    )
  }
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, max-content)',
        columnGap: 3,
        rowGap: 0.25
      }}
    >
      {['Build', 'Turned off', 'Turned back on'].map((h) => (
        <Typography key={h} variant="caption" color="text.secondary">
          {h}
        </Typography>
      ))}
      {c.byVersion.map((v) => (
        <Box key={v.version} sx={{ display: 'contents' }} data-testid="coverage-flip-row">
          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
            {v.version}
          </Typography>
          <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatNum(v.optOuts)}
          </Typography>
          <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatNum(v.optIns)}
          </Typography>
        </Box>
      ))}
    </Box>
  )
}

/** The estimate half. Renders nothing about downloads when there was no fetch to render. */
function DarkCohort({
  data,
  downloads
}: {
  data: TriageAnalyticsData
  downloads?: TriageDownloads
}): JSX.Element {
  const reporting = data.coverage.reportingInstalls
  if (downloads?.available !== true) {
    return (
      <Typography variant="caption" color="text.secondary" data-testid="coverage-downloads-off">
        {formatNum(reporting)} installs have ever reported (all time, not the window). The download
        comparison needs the GitHub releases API, which did not answer this time
        {downloads === undefined ? '' : `: ${downloads.reason}`}.
      </Typography>
    )
  }
  return (
    <Stack spacing={0.5} data-testid="coverage-estimate">
      <Box
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'flex-start' }}
      >
        <Stack spacing={0}>
          <Typography variant="caption" color="text.secondary">
            Installer downloads
          </Typography>
          <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatNum(installerDownloads(downloads))}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            fetches, all releases summed
          </Typography>
        </Stack>
        <Stack spacing={0}>
          <Typography variant="caption" color="text.secondary">
            Installs that ever reported
          </Typography>
          <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatNum(reporting)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            distinct ids, all time
          </Typography>
        </Stack>
      </Box>
      <Typography variant="caption" color="warning.main">
        ESTIMATE, and the gap between these two is NOT an opt-out count. Downloads are not
        installs: the auto updater re fetches the installer on every install it updates, one
        machine that has updated four times contributed four downloads, people re download after a
        reinstall, and a curiosity click costs a download and produces no install. The gap is
        shown, never subtracted.
      </Typography>
    </Stack>
  )
}

/**
 * The block. It sits under Release health because both are read per build, and the question it
 * answers is the one a reader has right after &ldquo;did I ship a bad build&rdquo;: did people
 * leave, and how much of the fleet would I even see if they had.
 */
export function CoverageSection({
  data,
  downloads
}: {
  data: TriageAnalyticsData
  downloads?: TriageDownloads
}): JSX.Element {
  const c = data.coverage
  return (
    <Section title="Coverage: opt-outs, and what these numbers cannot see">
      <Stack spacing={1} data-testid="analytics-coverage">
        <Typography variant="caption" color="text.secondary">
          EXACT, over installs that ever reported. {formatNum(c.optOuts)} turned analytics off in
          this window and {formatNum(c.optIns)} turned it back on, counted from the one notice the
          app sends at the flip. The two are never netted against each other. This is a FLOOR on
          opt-outs, not a rate: an install that went dark before its first batch is invisible by
          definition, and a flip made while offline is never retried.
        </Typography>
        <FlipRows data={data} />
        <DarkCohort data={data} downloads={downloads} />
      </Stack>
    </Section>
  )
}
