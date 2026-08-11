// ============================================================================
// releaseChart.ts — the release-health chart's geometry, as pure functions (JOS-96).
// ============================================================================
//
// Same discipline as `analyticsRows.ts` beside it: everything that DECIDES something — where a
// vertex lands, whether a line breaks, what the axis maximum is — is a pure function here, so
// `tests/usageAnalytics.test.mts` can assert it with no React and no DOM. The .tsx is layout.
//
// ---------------------------------------------------------------------------------------
// ONE TIME BASE (world-model law 9), and here it is the DAY INDEX
// ---------------------------------------------------------------------------------------
// `TriageAnalyticsData.days` is dense and ascending, and every series in this section is already
// aligned to it by `buildReleaseHealth`. So x is `index / (days-1)` for the curves, the adoption
// band and the release markers ALIKE — one mapping, computed once, used by all three. The bug
// this rule exists to prevent (markers swimming against a still curve, 5a9dbc2) is precisely what
// would happen here if the markers were placed by parsing their date into a wall-clock fraction
// while the curves were placed by index.
//
// A release marker whose date is not IN the window is dropped rather than clamped to an edge: a
// marker pinned to day zero reads as "this shipped at the start of the window", which for a
// release from three months ago is a lie the chart tells confidently.
//
// ---------------------------------------------------------------------------------------
// A GAP IS NOT A ZERO — why these are paths and not polylines
// ---------------------------------------------------------------------------------------
// `<polyline>` cannot express a break, so a day with no health report would have to be drawn at
// SOME height, and every available height is a claim: 0 says "no errors that day", the previous
// value says "unchanged", and interpolating says "we measured in between". All three are
// fabrications about a day nobody reported.
//
// So the rate curve is a `<path>` whose `d` starts a NEW SUBPATH (`M`) after every null. A build
// that stopped reporting leaves a visible hole, and a build that never reported at all produces
// an EMPTY string — nothing is drawn, and the legend says "not reporting" instead. That is the
// house rule made geometric rather than editorial.

import type {
  TriageAnalyticsReleaseHealth,
  TriageReleaseHealthVersion
} from '@shared/triage'

/** The viewBox both stacked panels are drawn in. Unitless — the SVG scales to its container. */
export const CHART_W = 640
export const RATE_H = 90
export const SHARE_H = 46

/**
 * x for a day INDEX. A one-day window has no span to divide by, so it draws down the middle
 * rather than at 0/0 — the honest place for a single sample, and it keeps every caller total.
 */
export function dayX(i: number, days: number): number {
  if (days <= 1) return CHART_W / 2
  return (Math.max(0, Math.min(days - 1, i)) / (days - 1)) * CHART_W
}

/**
 * A series of possibly-unknown values as an SVG path, with a BREAK at every null.
 *
 * A lone measured point between two nulls would be an invisible zero-length line, so it is
 * emitted as a tiny horizontal stub — a dot the eye can find. A day that was measured and found
 * clean is a real reading and has to be visible; the alternative is that a perfectly healthy
 * build looks exactly like one that reported nothing, which is the failure this whole section is
 * built to avoid.
 */
export function gappedPath(values: readonly (number | null)[], max: number, height: number): string {
  const span = max > 0 ? max : 1
  const out: string[] = []
  let open = false
  values.forEach((v, i) => {
    if (v === null) {
      open = false
      return
    }
    const x = dayX(i, values.length)
    const y = height - (Math.max(0, Math.min(span, v)) / span) * height
    if (open) {
      out.push(`L${x.toFixed(1)} ${y.toFixed(1)}`)
      return
    }
    out.push(`M${x.toFixed(1)} ${y.toFixed(1)}`)
    // The stub: only if this point has no measured neighbour to be drawn towards.
    if ((values[i + 1] ?? null) === null) out.push(`L${(x + 1.5).toFixed(1)} ${y.toFixed(1)}`)
    open = true
  })
  return out.join(' ')
}

export interface ReleaseSeries {
  version: string
  /** False ⇒ no rate path at all, and the legend says "not reporting" rather than showing zero. */
  reporting: boolean
  /** The error-rate curve, broken at every unreported day. Empty for a non-reporting build. */
  ratePath: string
  /** The adoption curve — always drawn, because `version` has been sent by every client ever. */
  sharePath: string
}

export interface ReleaseMarker {
  version: string
  date: string
  x: number
}

export interface ReleaseChartGeometry {
  days: readonly string[]
  /** The rate axis top. Rounded UP to something readable, never fitted exactly to the peak. */
  maxRate: number
  series: ReleaseSeries[]
  markers: ReleaseMarker[]
  /** Reporting coverage per day, 0..1, as its own path. Null days (no actives) break it. */
  coveragePath: string
}

/**
 * The rate axis. The peak, rounded up to the next 1 / 2 / 5 ×10ⁿ so the number at the top is one
 * a person can hold — and never below 1, so a fleet whose worst build averages 0.2 errors per
 * session does not get a chart that makes 0.2 look like the ceiling of the scale.
 */
export function rateAxisMax(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 1) return 1
  const mag = 10 ** Math.floor(Math.log10(peak))
  for (const step of [1, 2, 5, 10]) {
    if (peak <= step * mag) return step * mag
  }
  return 10 * mag
}

function seriesOf(v: TriageReleaseHealthVersion, maxRate: number): ReleaseSeries {
  return {
    version: v.version,
    reporting: v.reporting,
    // A NON-REPORTING BUILD GETS NO CURVE AT ALL. Not a flat line at zero, not a dotted guess —
    // nothing, plus a legend entry that says why. Drawing anything would be inventing the data
    // whose absence is the single most important fact about that build.
    ratePath: v.reporting ? gappedPath(v.days.map((d) => d.rate), maxRate, RATE_H) : '',
    sharePath: gappedPath(v.days.map((d) => d.share), 1, SHARE_H)
  }
}

/**
 * The whole chart, from the built section plus the window's day keys.
 *
 * The markers come from the versions themselves (each carries its committed `releaseDate`), so a
 * release with no note — a dev build, or one newer than this copy of the app — simply has no
 * marker rather than a guessed one.
 */
export function releaseChart(
  health: TriageAnalyticsReleaseHealth,
  days: readonly string[]
): ReleaseChartGeometry {
  const peak = health.versions.reduce(
    (max, v) => v.days.reduce((m, d) => (d.rate !== null && d.rate > m ? d.rate : m), max),
    0
  )
  const maxRate = rateAxisMax(peak)
  const index = new Map(days.map((d, i) => [d, i]))
  return {
    days,
    maxRate,
    series: health.versions.map((v) => seriesOf(v, maxRate)),
    markers: health.versions.flatMap((v) => {
      // DROPPED, NOT CLAMPED, when the release predates the window — see the header.
      const at = v.releaseDate === null ? undefined : index.get(v.releaseDate)
      return at === undefined ? [] : [{ version: v.version, date: v.releaseDate ?? '', x: dayX(at, days.length) }]
    }),
    coveragePath: gappedPath(health.coverage.map((c) => c.share), 1, SHARE_H)
  }
}

/**
 * The sentence at the top of the section. It leads with the WORST case rather than an average,
 * because the reader is asking "is anything wrong" and a mean over builds would bury exactly the
 * one build they need to see.
 *
 * NO REPORTING AT ALL gets its own sentence, and it is the single most misreadable state this
 * section has: an empty error chart looks like good news and means the opposite.
 */
export function coverageNote(health: TriageAnalyticsReleaseHealth): string {
  if (!health.anyReporting) {
    return 'No build in this window has reported health yet. The error curve is MISSING, not flat - nothing here says the fleet is healthy.'
  }
  const share = health.coverageShare
  const pct = share === null ? '-' : `${Math.round(share * 100).toString()}%`
  const quiet = health.versions.filter((v) => !v.reporting).length
  const tail =
    quiet === 0
      ? 'Every build shown reports.'
      : `${quiet.toString()} build${quiet === 1 ? '' : 's'} shown cannot report - their rows read "not reporting", never zero.`
  return `${pct} of install-days in this window ran a build that can report errors. ${tail}`
}
