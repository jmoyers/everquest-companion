// ============================================================================
// ReleaseHealthSection — "did I release buggy code", on one time base (JOS-96).
// ============================================================================
//
// A NEW SECTION BESIDE Health / Startup / Versions, not a rework of any of them. Those answer
// what goes wrong, how launches went, and who is on what; this one puts the error rate, the
// adoption it happened to, and the release dates on a single x-axis so the reader can see which
// build a change of behaviour started in.
//
// It renders and nothing else: every vertex, break, marker position and axis maximum comes from
// `./releaseChart.ts`, which is pure and pinned by tests/usageAnalytics.test.mts. That split is
// the same one `analyticsRows.ts` has, for the same reason.
//
// ---------------------------------------------------------------------------------------
// THE HOUSE RULE, AS IT LANDS ON SCREEN
// ---------------------------------------------------------------------------------------
// A build that predates the emitting client sends nothing, and to a SUM that is indistinguishable
// from a build that reported perfectly and found no errors. If this panel let those two share a
// rendering it would show the entire back catalogue as flawless, which is the exact inverse of
// what is known about it. So:
//
//   * NOT REPORTING HAS ITS OWN VISUAL LANGUAGE — a dashed swatch, the words "not reporting",
//     and NO CURVE ON THE CHART. A true zero is a solid swatch, a drawn line sitting on the
//     floor of the rate axis, and the numeral 0.
//   * COVERAGE IS ALWAYS ON SCREEN, above the chart and again as its own band beneath it: what
//     share of the fleet was running a build that could have told us. An error curve at 20%
//     coverage is a rumour, and the reader can see that it is without doing arithmetic.
//   * THE RATE IS A DASH, NEVER A ZERO, wherever it is unknown — `rateLabel`'s standing rule in
//     this panel, applied to the one table where the difference is the whole point.
//
// BUG REPORTS ARE A SEPARATE COLUMN, never added to the error counts. They are a different kind
// of evidence (a person was annoyed enough to type something) and they exist for EVERY build ever
// shipped, including the ones with no health reporting — which makes them the only signal about
// those builds, and the reason this section is useful during the rollout rather than after it.

import type { JSX } from 'react'
import { Box, Typography } from '@mui/material'
import type { TriageAnalyticsData, TriageReleaseHealthVersion } from '@shared/triage'
import { formatNum } from '../../lib/formatRate'
import { Section } from './AnalyticsBits'
import { ReleaseIssues } from './ReleaseIssues'
import { pctLabel, rateLabel } from './analyticsRows'
import {
  CHART_W,
  RATE_H,
  SHARE_H,
  coverageNote,
  releaseChart,
  type ReleaseChartGeometry
} from './releaseChart'

/**
 * One hue per build, by POSITION in the (newest-first) list rather than by hashing the version
 * string. Position is stable for as long as the reader is looking at it, and it means the newest
 * build — the one the question is usually about — is always the same colour at the top of the
 * legend. A hash would shuffle every colour on the day a new release lands.
 */
const HUES = [210, 12, 140, 275, 42, 190, 330, 90] as const
const hueOf = (i: number): string => `hsl(${String(HUES[i % HUES.length])} 70% 55%)`

/** The stacked chart: error rate on top, adoption + coverage underneath, one x-axis for both. */
function Chart({ geo }: { geo: ReleaseChartGeometry }): JSX.Element {
  return (
    <Box
      component="svg"
      data-testid="release-health-chart"
      viewBox={`0 0 ${String(CHART_W)} ${String(RATE_H + SHARE_H + 14)}`}
      preserveAspectRatio="none"
      sx={{ width: '100%', height: 190, display: 'block', overflow: 'visible' }}
    >
      {/* The rate panel's floor — a build reporting ZERO errors draws its line right here, which
          is why the floor is visible at all: an invisible axis would make a clean build's line
          look like no line, and that is the confusion this section exists to prevent. */}
      <line x1={0} y1={RATE_H} x2={CHART_W} y2={RATE_H} stroke="currentColor" opacity={0.25} strokeWidth={1} />
      {/* RELEASE MARKERS, drawn THROUGH both panels: the whole point is to read a change in the
          curve against the day a build shipped, and a marker that stopped at the panel boundary
          would make that a comparison across two pictures. */}
      {geo.markers.map((m) => (
        <g key={`${m.version}-${m.date}`} data-testid="release-marker">
          <line
            x1={m.x}
            y1={0}
            x2={m.x}
            y2={RATE_H + SHARE_H + 4}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.55}
          />
          <title>{`${m.version} released ${m.date}`}</title>
        </g>
      ))}
      {geo.series.map((s, i) => (
        <path
          key={s.version}
          data-testid={s.reporting ? 'release-rate-line' : 'release-rate-absent'}
          d={s.ratePath}
          fill="none"
          stroke={hueOf(i)}
          strokeWidth={1.75}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <g transform={`translate(0 ${String(RATE_H + 14)})`}>
        {/* ADOPTION, underneath and on the same x. Every client has always sent `version`, so
            these curves run the full window even where the rate curves above them do not — and
            that difference in length IS the coverage story, drawn rather than described. */}
        {geo.series.map((s, i) => (
          <path
            key={s.version}
            data-testid="release-share-line"
            d={s.sharePath}
            fill="none"
            stroke={hueOf(i)}
            strokeWidth={1.25}
            strokeOpacity={0.65}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* Coverage over the top of the adoption band, in the text colour rather than a build's
            hue: it is a fact about the INSTRUMENT, not about any one release. */}
        <path
          data-testid="release-coverage-line"
          d={geo.coveragePath}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 2"
          opacity={0.7}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </Box>
  )
}

/** The legend swatch. DASHED AND HOLLOW for a build that cannot report — the same distinction the
 *  chart makes by drawing no line, restated where the words are, so neither stands alone. */
function Swatch({ hue, reporting }: { hue: string; reporting: boolean }): JSX.Element {
  return (
    <Box
      sx={{
        width: 18,
        height: 0,
        alignSelf: 'center',
        border: reporting ? `2px solid ${hue}` : `2px dashed ${hue}`,
        opacity: reporting ? 1 : 0.6
      }}
    />
  )
}

function VersionRow({ v, hue }: { v: TriageReleaseHealthVersion; hue: string }): JSX.Element {
  return (
    <Box sx={{ display: 'contents' }} data-testid="release-health-row">
      <Swatch hue={hue} reporting={v.reporting} />
      <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
        {v.version}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {v.releaseDate ?? 'unreleased'}
      </Typography>
      {/*
        THE ONE CELL THIS WHOLE SECTION TURNS ON. "not reporting" is not a formatting of zero —
        it is a different fact, and it is spelled out in words rather than left to a dash, because
        a dash in a column of numbers is read as "small" by everyone who is skimming.
      */}
      {v.reporting ? (
        <Typography
          variant="caption"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
          data-testid="release-health-rate"
        >
          {rateLabel(v.rate)} · {formatNum(v.errors)} errors / {formatNum(v.reports)} reports
        </Typography>
      ) : (
        <Typography variant="caption" color="warning.main" data-testid="release-health-quiet">
          not reporting - no health data from this build
        </Typography>
      )}
      <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        peak {pctLabel(v.peakShare)}
      </Typography>
      <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }} data-testid="release-health-bugs">
        {formatNum(v.bugReports)} bug report{v.bugReports === 1 ? '' : 's'}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {v.byField.length === 0
          ? v.reporting
            ? 'no errors reported'
            : '-'
          : v.byField.map((f) => `${f.id} ${formatNum(f.n)}`).join(' · ')}
      </Typography>
    </Box>
  )
}

export function ReleaseHealthSection({ data }: { data: TriageAnalyticsData }): JSX.Element {
  const health = data.releaseHealth
  const geo = releaseChart(health, data.days)
  return (
    <Section title="Release health - error rate per build, over adoption">
      <Typography variant="caption" color="text.secondary">
        Errors per health report, per build, on the same x-axis as how much of the fleet was
        running that build; dashed verticals are release dates from the committed notes. The rate
        is self-normalizing - a popular build cannot look buggier just for having more sessions -
        and the bug-report column is a separate kind of evidence that is never added to it.
      </Typography>
      {/*
        THE COVERAGE SENTENCE IS ABOVE THE CHART, deliberately. It is the caveat that governs
        everything below it, and a caveat placed underneath is one the reader meets after they
        have already formed an opinion from the picture.
      */}
      <Typography
        variant="caption"
        color={health.anyReporting ? 'text.secondary' : 'warning.main'}
        data-testid="release-health-coverage"
      >
        {coverageNote(health)}
      </Typography>
      {health.versions.length === 0 ? (
        <Typography variant="caption" color="text.secondary" data-testid="release-health-empty">
          No build has reported anything in this window.
        </Typography>
      ) : (
        <>
          <Chart geo={geo} />
          <Typography variant="caption" color="text.secondary">
            Top: errors per report, 0 to {geo.maxRate.toFixed(geo.maxRate < 1 ? 2 : 0)} - a gap in
            a line is a day that build filed nothing, drawn as a hole rather than as a zero.
            Bottom: share of daily active installs per build, with reporting coverage dashed over
            it. Builds that cannot report have no line at all.
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'max-content max-content max-content 1fr max-content max-content 1fr',
              columnGap: 2,
              rowGap: 0.5,
              alignItems: 'center'
            }}
          >
            {health.versions.map((v, i) => (
              <VersionRow key={v.version} v={v} hue={hueOf(i)} />
            ))}
          </Box>
          {/*
            TOP ISSUES BY VERSION (JOS-100) — the half a COUNT cannot be. Its own component
            (ReleaseIssues.tsx) because this file is at the factoring ceiling, and it renders
            nothing at all for a build with no issues: the reporting / not-reporting judgement
            belongs to the table above, and restating it here would be a second place that could
            get it wrong.
          */}
          <ReleaseIssues versions={health.versions} />
        </>
      )}
    </Section>
  )
}
