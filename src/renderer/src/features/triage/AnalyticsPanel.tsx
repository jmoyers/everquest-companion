// ============================================================================
// AnalyticsPanel — the readout (docs/plans/usage-analytics.md A3, surface 1).
// ============================================================================
//
// Pulse · Adoption · Funnels · Health · Versions · Retention, off `usage_daily` +
// `usage_funnel_daily` + `analytics_install`, read in MAIN through the triage role and handed
// over already computed (`src/main/triage/analytics.ts`). This file renders; it decides
// nothing that `./analyticsRows.ts` cannot decide as a pure function and a test cannot pin.
//
// THREE STATES, AND THEY ARE DIFFERENT ON PURPOSE:
//   * NOT MIGRATED (`available:false`) — a cluster missing a table or the `cohort` column. Says
//     so, names the missing thing, and says what to run. The ONLY arm that hides the dashboard.
//   * TABLES EMPTY — honest zeros plus one "no data yet" line. That is what a lit client whose
//     server-side `telemetry_accepting` is still closed looks like, and it is a REAL,
//     informative answer: the pipe exists and is quiet.
//   * DATA — the six sections.
//
// WHAT IS ON SCREEN BY DEFAULT IS THE USER COHORT. The owner runs this app more than anybody,
// so leaving their own dev-build and installed-copy use in the numbers would make a three-install
// population read as a product. "Include mine (split)" adds a SECOND, complete readout below the
// first, under its own heading; there is deliberately no control anywhere that merges them, and
// the two never share a denominator (each cohort's rates are built from its own rows).
//
// The earlier version of this panel listed a `SHAPE` table of promised fields as a stand-in
// for the dashboard. It is gone, and so is its field list, which had gone stale against the
// expanded design (it still said `byPlatform`/`opens`) — the panel IS the shape now.
//
// The drawing primitives (`Sparkline`, `Section`, `MixList`) and the three leaf sections that
// only read one slice each (Health, Versions, Retention) live in `./AnalyticsBits.tsx` — this
// file keeps the parts that DECIDE: which window, which cohorts, which of the three states.

import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  CircularProgress,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  Tab,
  Tabs,
  Typography
} from '@mui/material'
import type {
  TriageAnalytics,
  TriageAnalyticsData,
  TriageDownloads,
  TriageFunnelView,
  TriageLiveSessions
} from '@shared/triage'
import { TRIAGE_ANALYTICS_DAYS, TRIAGE_ANALYTICS_DEFAULT_DAYS } from '@shared/triage'
import { formatNum } from '../../lib/formatRate'
import { useTriageCall } from './useTriage'
import {
  DownloadsSection,
  HealthSection,
  MixList,
  RetentionSection,
  Section,
  Sparkline,
  StartupSection,
  VersionsSection
} from './AnalyticsBits'
import { CoverageSection } from './CoverageSection'
import { ReleaseHealthSection } from './ReleaseHealthSection'
import {
  durationLabel,
  funnelBars,
  liveTiles,
  pctLabel,
  pulseTiles,
  windowIsEmpty
} from './analyticsRows'

/**
 * `live` leads the tile row and comes from CloudWatch rather than from the counter tables — the
 * one number here that is about RIGHT NOW rather than about a day, which is precisely what a
 * day-keyed counter cannot be asked. It is global (the EMF metric is split by channel, never by
 * cohort), so only this readout gets it; the owner readout below renders without it.
 */
function PulseSection({
  data,
  live
}: {
  data: TriageAnalyticsData
  live?: TriageLiveSessions
}): JSX.Element {
  return (
    <Section title="Pulse">
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {[...liveTiles(live), ...pulseTiles(data)].map((t) => (
          <Stack key={t.label} spacing={0} sx={{ minWidth: 140 }}>
            <Typography variant="caption" color="text.secondary">
              {t.label}
            </Typography>
            <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
              {t.value}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t.note}
            </Typography>
          </Stack>
        ))}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 2 }}>
        <Stack spacing={0.25}>
          <Typography variant="caption" color="text.secondary">
            Active installs per day
          </Typography>
          <Sparkline points={data.pulse.activeSeries} />
        </Stack>
        <Stack spacing={0.25}>
          <Typography variant="caption" color="text.secondary">
            Sessions per day
          </Typography>
          <Sparkline points={data.pulse.sessionSeries} />
        </Stack>
      </Box>
    </Section>
  )
}

function AdoptionSection({ data }: { data: TriageAnalyticsData }): JSX.Element {
  const a = data.adoption
  return (
    <Section title="Adoption">
      <Typography variant="caption" color="text.secondary">
        Feature numbers are USES, not reach: a daily counter cannot say how many distinct
        installs touched a feature without keeping a per-install trail, which this design
        deliberately does not.
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 2 }}>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Views by dwell share
          </Typography>
          <MixList
            rows={a.views.map((v) => ({ id: `${v.id} · ${pctLabel(v.share)}`, n: v.visits }))}
            empty="No view dwell recorded."
          />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Features (uses · per session)
          </Typography>
          <MixList
            rows={a.features.map((f) => ({ id: `${f.id} · ${f.perSession.toFixed(2)}/s`, n: f.uses }))}
            empty="No feature use recorded."
          />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Overlays opened
          </Typography>
          <MixList rows={a.overlays} empty="No overlay opened." />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            Voice engine · cursor ring · auto-hide
          </Typography>
          <MixList
            rows={[
              ...a.voice.map((v) => ({ id: `voice ${v.id}`, n: v.n })),
              ...a.cursorRing.map((v) => ({ id: `cursor ring ${v.id}`, n: v.n })),
              ...a.autoHide.map((v) => ({ id: `auto-hide ${v.id}`, n: v.n }))
            ]}
            empty="No setup snapshot recorded."
          />
        </Stack>
      </Box>
      <Typography variant="caption" color="text.secondary">
        Alerts fired {formatNum(a.alertsFired)} · spoken {formatNum(a.alertsSpoken)}
      </Typography>
    </Section>
  )
}

function FunnelCard({ view }: { view: TriageFunnelView }): JSX.Element {
  const bars = funnelBars(view.steps)
  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {view.funnel}
      </Typography>
      {bars.map((b) => (
        <Box key={b.step} sx={{ display: 'grid', gridTemplateColumns: '150px 1fr 120px', columnGap: 1.5, alignItems: 'center' }}>
          <Typography variant="caption">{b.step}</Typography>
          <Box sx={{ height: 8, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Box sx={{ width: `${String(b.widthPct)}%`, height: '100%', bgcolor: 'success.main', borderRadius: 1 }} />
          </Box>
          <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatNum(b.n)} · {b.conversion}
            {b.dropOff === null ? '' : ` · ${b.dropOff}`}
          </Typography>
        </Box>
      ))}
      {view.byVersion.length > 1 && (
        <Typography variant="caption" color="text.secondary">
          by version -{' '}
          {view.byVersion
            .map((v) => `${v.version}: ${funnelBars(v.steps).at(-1)?.conversion ?? '-'} end-to-end`)
            .join(' · ')}
        </Typography>
      )}
      {view.failures.length > 0 && (
        <Typography variant="caption" color="warning.main">
          failures - {view.failures.map((f) => `${f.id} ${String(f.n)}`).join(' · ')}
        </Typography>
      )}
    </Stack>
  )
}

/**
 * `downloads` is deliberately a SEPARATE prop rather than a field of `data`: it is fetched from
 * GitHub at the IPC edge, not computed from the counter tables, and it is global — so only the
 * user-cohort readout is given it, and the owner readout below renders without it.
 */
function Readout({
  data,
  downloads,
  live
}: {
  data: TriageAnalyticsData
  downloads?: TriageDownloads
  live?: TriageLiveSessions
}): JSX.Element {
  return (
    <Stack spacing={2}>
      {windowIsEmpty(data) && (
        <Alert severity="info" data-testid="analytics-empty">
          <AlertTitle>No data yet</AlertTitle>
          The tables are there and empty - every number below is a true zero, not a missing
          reading. The client is lit; if this stays empty, check whether{' '}
          <code>telemetry_accepting</code> is still closed (<code>analytics open</code>).
        </Alert>
      )}
      <PulseSection data={data} live={live} />
      <AdoptionSection data={data} />
      <Section title="Funnels">
        <Stack spacing={2}>
          {data.funnels.map((f) => (
            <FunnelCard key={f.funnel} view={f} />
          ))}
        </Stack>
      </Section>
      <HealthSection data={data} />
      {/* Beside Health and above Versions: it is a health fact, read per build. */}
      <StartupSection data={data} />
      {/*
        JOS-96, and it sits HERE rather than at the end for a reason: Health above says what goes
        wrong across the fleet, and this says which build it started going wrong in. Reading the
        second immediately after the first is the whole workflow — "is anything up" then "did I
        ship it". Versions below then answers "who is still on that build".
      */}
      <ReleaseHealthSection data={data} />
      {/*
        JOS-109, directly under Release health because it is read the same way (per build) and
        answers the question that follows it: did anyone leave, and how much of the fleet would
        these counters see if they had. It is also the only section given `downloads` besides
        DownloadsSection below, because the dark-cohort ESTIMATE is a comparison against them.
      */}
      <CoverageSection data={data} downloads={downloads} />
      <VersionsSection data={data} />
      <DownloadsSection downloads={downloads} />
      <RetentionSection data={data} />
      <Typography variant="caption" color="text.secondary">
        Window {data.days[0] ?? '?'} → {data.days.at(-1) ?? '?'} · median session length is a
        bucket range, not an average · durations shown as {durationLabel(1_800_000)}-style spans.
      </Typography>
    </Stack>
  )
}

/**
 * The owner's own readout, under its own heading and visually set apart. A heading rather than a
 * tab because the point is that both are on screen AT THE SAME TIME: the owner is looking for
 * "does my dev build behave like the fleet does", and a tab would make that a memory exercise.
 */
function OwnerReadout({ data }: { data: TriageAnalyticsData }): JSX.Element {
  return (
    <Stack spacing={2} data-testid="analytics-owner" sx={{ pt: 2 }}>
      <Divider />
      <Alert severity="info" icon={false}>
        <AlertTitle>Mine - the owner cohort, shown separately</AlertTitle>
        Your dev builds (tagged automatically from <code>env.channel</code>) and any install
        marked with <code>triage-feedback analytics owner-add &lt;analyticsId&gt;</code> - the id
        is in Preferences → Usage analytics → &ldquo;Anonymous id&rdquo;. These numbers are NOT
        included in the readout above and are never added to it. Counters aggregated before an
        install was marked stay in the user cohort - the split is from-marking-onward.
      </Alert>
      <Readout data={data} />
    </Stack>
  )
}

/**
 * The NOT-AVAILABLE arm, and there are two of them. A cluster that is missing a table asks the
 * operator for one command; a cluster that stopped answering asks for nothing at all — so
 * labelling a dropped connection "not migrated" would send them off to run a migration that was
 * never the problem. `main` decides which state it is (`src/main/triage/backend.ts`); this picks
 * the words.
 */
function Unavailable({ data }: { data: Extract<TriageAnalytics, { available: false }> }): JSX.Element {
  return (
    <Alert severity="warning" data-testid="analytics-unavailable">
      <AlertTitle>
        {data.state === 'missing'
          ? 'This cluster is not migrated to what the readout reads'
          : 'The cluster did not answer'}
      </AlertTitle>
      {data.reason}
    </Alert>
  )
}

export default function AnalyticsPanel(): JSX.Element {
  const [days, setDays] = useState<number>(TRIAGE_ANALYTICS_DEFAULT_DAYS)
  const [includeOwner, setIncludeOwner] = useState(false)
  const run = useCallback(
    () => window.eq.triageAnalytics(days, includeOwner),
    [days, includeOwner]
  )
  const analytics = useTriageCall<TriageAnalytics>(run)
  const ready = analytics.data?.available === true ? analytics.data : null

  const header = (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Tabs value={days} onChange={(_e, v: number) => setDays(v)} variant="scrollable">
        {TRIAGE_ANALYTICS_DAYS.map((d) => (
          <Tab key={d} value={d} label={`${String(d)}d`} data-testid={`analytics-days-${String(d)}`} />
        ))}
      </Tabs>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={includeOwner}
            onChange={(e) => setIncludeOwner(e.target.checked)}
            data-testid="analytics-include-owner"
          />
        }
        label={
          <Typography variant="caption">
            Include mine (split)
            {ready !== null && !ready.ownerPresent && ' - nothing marked yet'}
          </Typography>
        }
      />
    </Stack>
  )

  return (
    <Stack spacing={2} data-testid="triage-analytics">
      {header}
      {analytics.loading && <CircularProgress size={20} />}
      {analytics.error !== null && <Alert severity="error">{analytics.error}</Alert>}
      {analytics.data?.available === false && <Unavailable data={analytics.data} />}
      {ready !== null && (
        <Readout data={ready.data} downloads={ready.downloads} live={ready.live} />
      )}
      {ready?.owner != null && <OwnerReadout data={ready.owner} />}
    </Stack>
  )
}
