/**
 * analyticsDigest.mts — `triage-feedback analytics digest`, as a pure renderer.
 *
 * Surface 3 of the four in docs/plans/usage-analytics.md §1: "the same pulse/adoption/funnel/
 * health numbers as text, for the terminal". SAME NUMBERS, literally: this file renders the
 * `TriageAnalyticsData` that `src/main/triage/analytics.ts` builds, which is the same value the
 * Analytics panel renders. Two views, one computation — the CLI cannot disagree with the tab.
 *
 * PURE, like `triageCluster.mts` beside it: it takes a value and returns a string, touches no
 * database and no clock, so `tests/usageAnalytics.test.mts` asserts the output directly.
 *
 * THE FORMAT IS FIXED-WIDTH TEXT, not markdown. `digest` (the feedback one) renders markdown
 * because its output is meant to be pasted to a model; this output is meant to be READ in a
 * terminal, and a table of numbers reads better aligned than fenced.
 */

import type {
  TriageAnalyticsData,
  TriageDownloads,
  TriageFunnelStepRow,
  TriageLiveSessions,
  TriageMixRow
} from '../src/shared/triage'

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

/** Durations read in minutes here: a session is minutes, and `formatMs` lives in the renderer. */
function minutes(ms: number | null): string {
  return ms === null ? '-' : `${(ms / 60_000).toFixed(1)} min`
}

function bar(label: string, n: number, max: number, width = 24): string {
  const filled = max > 0 ? Math.round((n / max) * width) : 0
  return `  ${label.padEnd(22)} ${String(n).padStart(8)}  ${'█'.repeat(filled)}`
}

/** A `dim -> n` list as a bar chart, capped. Empty renders as one honest line. */
function mixBlock(rows: readonly TriageMixRow[], limit = 10): string[] {
  if (rows.length === 0) return ['  (nothing recorded)']
  const max = Math.max(...rows.map((r) => r.n))
  return rows.slice(0, limit).map((r) => bar(r.id, r.n, max))
}

function funnelBlock(steps: readonly TriageFunnelStepRow[]): string[] {
  if (steps.length === 0) return ['  (no steps declared)']
  return steps.map(
    (s) =>
      `  ${s.step.padEnd(22)} ${String(s.n).padStart(8)}  ${pct(s.conversion).padStart(7)} of step 1` +
      (s.dropOff > 0 ? `  (−${pct(s.dropOff)} here)` : '')
  )
}

/**
 * RIGHT NOW, from CloudWatch rather than from the counter tables — the one line in the digest
 * that is not a fact about a day (`src/main/triage/liveSessions.ts` explains the metric and the
 * derivation). Absent (`--json`, which is a machine shape over the counter tables) prints
 * nothing; unavailable prints the reason, because "CloudWatch did not answer" and "nobody is in
 * the app" are opposite facts and must not share a rendering.
 *
 * The age says `est.` and, when the lookback truncated it, `≥`. That is the whole caveat: one
 * word and one glyph, not a sentence about methodology.
 */
export function liveLines(live: TriageLiveSessions | undefined): string[] {
  if (live === undefined) return []
  if (!live.available) return [`  live sessions: (unavailable: ${live.reason})`]
  const age =
    live.avgAgeMs === null
      ? ''
      : ` · avg age ${live.ageIsFloor ? '≥' : ''}${minutes(live.avgAgeMs)} est.`
  return [`  live sessions ${String(live.activeNow)} right now${age}`]
}

function pulseLines(d: TriageAnalyticsData, live?: TriageLiveSessions): string[] {
  const p = d.pulse
  return [
    'PULSE',
    ...liveLines(live),
    `  DAU ${String(p.dau)} · WAU ${String(p.wau)} · MAU ${String(p.mau)} · installs all-time ${String(p.installsTotal)}`,
    `  today (UTC): ${String(p.installsToday)} new install(s) · ${String(p.upgradesToday)} upgrade(s)`,
    `  sessions ${String(p.sessions)} (${p.sessionsPerDay.toFixed(1)}/day on days with data)`,
    `  session length: mean ${minutes(p.meanSessionMs)} · median ${p.medianSessionLabel ?? '-'}`,
    `  log lines parsed ${String(p.linesParsed)} in the window (re-reads included)`,
  ]
}

function adoptionLines(d: TriageAnalyticsData): string[] {
  const a = d.adoption
  const views = a.views
    .slice(0, 8)
    .map((v) => `  ${v.id.padEnd(22)} ${pct(v.share).padStart(7)} of dwell · ${String(v.visits)} visits`)
  const features =
    a.features.length === 0
      ? ['  (nothing recorded)']
      : a.features
          .slice(0, 12)
          .map(
            (f) =>
              `  ${f.id.padEnd(22)} ${String(f.uses).padStart(8)} uses · ${f.perSession.toFixed(2)}/session`
          )
  return [
    '',
    'ADOPTION',
    '  views by dwell share',
    ...(views.length > 0 ? views : ['  (nothing recorded)']),
    '  features (uses, not reach - see src/main/triage/analytics.ts)',
    ...features,
    '  overlays opened',
    ...mixBlock(a.overlays),
    '  voice engine',
    ...mixBlock(a.voice),
    `  alerts fired ${String(a.alertsFired)} · spoken ${String(a.alertsSpoken)}`,
  ]
}

function funnelLines(d: TriageAnalyticsData): string[] {
  const out: string[] = ['', 'FUNNELS']
  for (const f of d.funnels) {
    out.push(`  ${f.funnel}`)
    out.push(...funnelBlock(f.steps))
    if (f.failures.length > 0) {
      out.push('    failures')
      out.push(...f.failures.slice(0, 6).map((x) => `      ${x.id.padEnd(28)} ${String(x.n)}`))
    }
  }
  return out
}

/**
 * THE TWO SENTENCES THE MIX ABOVE CANNOT SAY (JOS-133), printed under it because both are about
 * how a number in it should be READ rather than about its size:
 *
 *   * `mainErrorLogLines` is no longer the number of times something went wrong. The local error
 *     log caps identical repeats (src/main/errorRepeat.ts) and counts the rest under
 *     `suppressedErrorLines`, so the honest occurrence total is the SUM. Printed even when the
 *     suppressed count is zero — "nothing was suppressed" is the fact that makes the written
 *     number trustworthy, and it is only worth anything if it is always there to read.
 *   * `imageFetchFailures` is counted but is NOT an error, so it is excluded from the release
 *     health rate (`HEALTH_NON_ERROR_FIELDS`). It is right there in the mix, which is precisely
 *     why the exclusion has to be stated: an operator reading a large number and a small error
 *     rate on the same screen deserves to be told they are not the same question.
 */
function errorHonestyLines(h: TriageAnalyticsData['health']): string[] {
  const n = (id: string): number => h.errors.find((r) => r.id === id)?.n ?? 0
  const written = n('mainErrorLogLines')
  const suppressed = n('suppressedErrorLines')
  const images = n('imageFetchFailures')
  const out = [
    `  error log lines: ${String(written)} written · ${String(suppressed)} suppressed as repeats` +
      ` · ${String(written + suppressed)} occurrences`
  ]
  if (images > 0) {
    out.push(`  (imageFetchFailures is a handled condition, excluded from the release health rate)`)
  }
  return out
}

function healthLines(d: TriageAnalyticsData): string[] {
  const h = d.health
  return [
    '',
    'HEALTH',
    `  health rollups received: ${String(h.reports)}`,
    ...mixBlock(h.errors),
    ...errorHonestyLines(h),
    '  update outcomes',
    ...h.update.map(
      (u) =>
        `  ${u.step.padEnd(22)} ok ${String(u.ok).padStart(6)} · failed ${String(u.failed).padStart(6)}` +
        ` · ${u.rate === null ? '-' : pct(u.rate)}`
    ),
    ...(h.updateFailures.length > 0
      ? ['  update failure classes', ...mixBlock(h.updateFailures, 6)]
      : []),
  ]
}

/**
 * STARTUP REPLAY, per build (JOS-57) — the terminal's copy of the tab's section, off the same
 * `TriageAnalyticsData`, so the CLI cannot disagree with the panel.
 *
 * Percentiles print as bucket RANGES because that is what the counters hold; `—` means no launch
 * on that build reported one, which is not the same fact as a fast launch. The log-size mix is
 * printed under the rows rather than beside each of them: it belongs to no build.
 */
function startupLines(d: TriageAnalyticsData): string[] {
  const s = d.startup
  const head = ['', 'STARTUP REPLAY (per build; percentiles are bucket ranges, not exact numbers)']
  if (s.byVersion.length === 0) return [...head, '  (no launch has reported a replay yet)']
  return [
    ...head,
    ...s.byVersion.map(
      (r) =>
        `  ${r.version.padEnd(14)} ${String(r.launches).padStart(5)} launches` +
        ` · replay p50 ${(r.p50ReplayLabel ?? '-').padStart(11)} p95 ${(r.p95ReplayLabel ?? '-').padStart(11)}` +
        ` · block p50 ${(r.p50BlockLabel ?? '-').padStart(10)} p95 ${(r.p95BlockLabel ?? '-').padStart(10)}` +
        ` · duty ${r.dutyAchieved === null ? '-' : pct(r.dutyAchieved)}` +
        ` · ${r.meanEventsReplayed === null ? '-' : String(Math.round(r.meanEventsReplayed))} events/launch` +
        ` · ${String(r.blocksOver50)} stalls >50ms`
    ),
    '  log size of measured launches (all builds)',
    ...mixBlock(s.logSizes),
  ]
}

function versionLines(d: TriageAnalyticsData): string[] {
  if (d.versions.length === 0) return ['', 'VERSIONS', '  (nothing recorded)']
  return [
    '',
    'VERSIONS',
    ...d.versions
      .slice(0, 10)
      .map(
        (v) =>
          `  ${v.version.padEnd(14)} ${String(v.installs).padStart(6)} installs · peak ${pct(v.peakShare).padStart(7)}` +
          ` · first ${v.firstSeenDay ?? '-'} · majority ${v.majorityDay ?? '-'}` +
          ` · ${v.daysToAdopt === null ? 'not adopted' : `${String(v.daysToAdopt)}d to adopt`}`
      ),
  ]
}

/**
 * GITHUB DOWNLOADS, printed under the versions they belong to and LABELLED SO NOBODY READS THEM
 * AS INSTALLS. The auto-updater fetches the installer again on every install it updates, so this
 * column counts the fleet updating itself far more than it counts new users — the install answer
 * is `analytics_install`, three sections up as "installs all-time".
 *
 * Absent (no fetch was made, e.g. `--json`) prints nothing at all; a FAILED fetch prints the
 * heading and the reason, because "GitHub did not answer" and "nobody downloaded" are opposite
 * facts and a silently missing section would let them share a rendering.
 */
export function downloadsLines(gh: TriageDownloads | undefined): string[] {
  if (gh === undefined) return []
  const head = ['', 'GH DOWNLOADS (updater-inflated - NOT installs; global, never cohort-split)']
  if (!gh.available) return [...head, `  (unavailable: ${gh.reason})`]
  if (gh.releases.length === 0) return [...head, '  (no published releases)']
  return [
    ...head,
    ...gh.releases
      .slice(0, 10)
      .map(
        (r) =>
          `  ${r.tag.padEnd(14)} ${String(r.exeDownloads).padStart(6)} installer` +
          ` · ${String(r.totalDownloads).padStart(6)} all assets` +
          ` · published ${r.publishedAt?.slice(0, 10) ?? '-'}`
      ),
  ]
}

/**
 * COVERAGE (JOS-109) — the terminal's copy of the tab's coverage block, off the same
 * `TriageAnalyticsData`, so the CLI cannot disagree with the panel.
 *
 * IT PRINTS AFTER `downloadsLines` ON PURPOSE, because it is the only section that reads BOTH the
 * counters and the GitHub numbers, and the comparison lands better under the per-tag rows it is
 * comparing against. `src/main/triage/coverage.ts` holds the argument; what is repeated here is
 * only what stops a reader misreading the two figures.
 *
 * THE SUBTRACTION IS NOT PRINTED. `downloads - reporting` reads as a dark-install count and is
 * not one; both numbers go out and the gap is left to speak for itself.
 */
function coverageLines(d: TriageAnalyticsData, gh: TriageDownloads | undefined): string[] {
  const c = d.coverage
  const out = [
    '',
    'COVERAGE (opt-out flips are EXACT over installs that ever reported; a FLOOR, never a rate)',
    `  turned off: ${String(c.optOuts)} · turned back on: ${String(c.optIns)} (this window; never netted)`,
  ]
  if (!c.anyFlips) {
    out.push('  (no flips reported: nobody left, OR no install is on a build new enough to say)')
  } else {
    out.push('  build            off      on')
    out.push(
      ...c.byVersion.map(
        (v) =>
          `  ${v.version.padEnd(14)} ${String(v.optOuts).padStart(5)}   ${String(v.optIns).padStart(5)}`
      )
    )
  }
  out.push(`  installs that ever reported: ${String(c.reportingInstalls)} (all time, not the window)`)
  if (gh?.available === true) {
    const fetches = gh.releases.reduce((sum, r) => sum + r.exeDownloads, 0)
    out.push(
      `  ESTIMATE: ${String(fetches)} installer fetches vs ${String(c.reportingInstalls)} reporting installs.`,
      '    Downloads are NOT installs (updater re-fetches, re-downloads, curiosity clicks) and one',
      '    machine updated four times is four of them. The gap is shown, never subtracted.'
    )
  }
  return out
}

function retentionLines(d: TriageAnalyticsData): string[] {
  if (d.retention.length === 0) return ['', 'RETENTION', '  (no cohorts yet)']
  const cell = (v: number | null, of: number): string =>
    v === null ? '   -  ' : `${String(v).padStart(3)} ${pct(of > 0 ? v / of : 0).padStart(6)}`
  return [
    '',
    'RETENTION (survival: first seen on the day, still seen on or after +N)',
    '  cohort       installs        D1            D7           D30',
    ...d.retention.map(
      (c) =>
        `  ${c.cohortDay}  ${String(c.installs).padStart(6)}  ${cell(c.d1, c.installs)}  ` +
        `${cell(c.d7, c.installs)}  ${cell(c.d30, c.installs)}`
    ),
  ]
}

/**
 * WHICH COHORT THIS IS, said out loud at the top of every digest — including the default one.
 *
 * A digest that silently excluded the owner would be a worse lie than one that silently included
 * them, because the reader cannot see the filter. So the header names the cohort every time, and
 * for the user cohort it also states the two things a reader would otherwise have to guess:
 * where the owner's numbers went (a separate digest, never a subtraction from these), and that
 * the split is FROM-MARKING-ONWARD — counters are anonymous sums with no id in them, so rows
 * aggregated before an install was marked stay exactly where they were aggregated.
 */
function cohortLines(cohort: string): string[] {
  if (cohort === 'owner') {
    return [
      'COHORT: owner - YOUR OWN USE (dev builds, tagged from env.channel, plus any install',
      '  marked with `analytics owner-add`). Not included in the user digest, and never added',
      '  to it. Rows aggregated before an install was marked are in the USER cohort and stay',
      '  there - the split is from-marking-onward.',
    ]
  }
  return [
    'COHORT: user - your own use is EXCLUDED (`--cohort owner` for it, `all` for both, split).',
    '  From-marking-onward: counters carry no id, so rows aggregated before an install was',
    '  marked as yours are still counted here and cannot be moved.',
  ]
}

/**
 * The whole digest, for ONE cohort. The header states the cohort and the window and, when the
 * tables are empty, SAYS SO in one line before printing the zeros — the numbers below it are
 * then read as "nothing has arrived", which is what they mean, rather than as "everybody left".
 *
 * `downloads` is OPTIONAL and comes from outside `TriageAnalyticsData` (the GitHub releases API,
 * fetched separately — `src/main/triage/ghDownloads.ts`). It is passed to ONE digest even when
 * both cohorts print, because a release download belongs to no cohort.
 */
export function renderAnalyticsDigest(
  d: TriageAnalyticsData,
  cohort = 'user',
  downloads?: TriageDownloads,
  live?: TriageLiveSessions
): string {
  const head = [
    `usage analytics - last ${String(d.windowDays)} days (${d.days[0] ?? '?'} → ${d.days.at(-1) ?? '?'})`,
    ...cohortLines(cohort),
    d.empty
      ? 'NO DATA YET: the tables exist and are empty. Every number below is a true zero.'
      : '',
  ].filter((line) => line.length > 0)
  return [
    ...head,
    '',
    ...pulseLines(d, live),
    ...adoptionLines(d),
    ...funnelLines(d),
    ...healthLines(d),
    ...startupLines(d),
    ...versionLines(d),
    ...downloadsLines(downloads),
    ...coverageLines(d, downloads),
    ...retentionLines(d),
    '',
  ].join('\n')
}

