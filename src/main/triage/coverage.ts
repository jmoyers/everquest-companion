// ============================================================================
// coverage.ts — how much of the fleet this pipeline can actually see (JOS-109).
// ============================================================================
//
// Every other section of the Analytics tab describes the population that REPORTS. This one is
// about the population that does not, and it is the only section whose job is to state the limits
// of everything above it.
//
// THE HONEST-MEASUREMENT PROBLEM, and why this is TWO measurements rather than one number.
// The owner's question is "how many installs turn usage analytics off". It has no exact answer,
// for a reason that is structural rather than a gap somebody could close with more code:
//
//     AN INSTALL THAT WENT DARK BEFORE IT EVER REPORTED IS INVISIBLE BY DEFINITION.
//
// Somebody who opens the app, reads the first-run notice and declines before the flush loop's
// first tick is, to this pipeline, identical to somebody who never downloaded it. Making them
// visible would mean sending something before they answered, which is the one thing the notice
// exists to promise we do not do. So there is no version of this feature in which the number is
// exact, and the design decision is to say so twice rather than to publish one confident figure:
//
//   1. OPT-OUT FLIPS — EXACT, over installs that ever reported. `optOuts` / `optIns`, dimmed by
//      the build that was running at the flip. One event per flip (src/main/telemetry/optOut.ts
//      makes that mechanical), so these are counts of a thing a person did. They are a FLOOR on
//      opt-outs, never a rate: they cannot see the dark install, and they cannot see a flip made
//      while the machine was offline (the notice is one best-effort POST and is never retried).
//
//   2. THE DARK COHORT — AN ESTIMATE, and only ever a COMPARISON. GitHub's release download
//      counts beside the number of distinct installs that ever reported. Both printed, neither
//      derived from the other, and THE DIFFERENCE IS NEVER TAKEN. That refusal is the whole
//      point of the section: `downloads - reporting` looks like an opt-out count and is not one,
//      because a download is not an install. The updater re-fetches the installer on every
//      install it updates (v0.5.0 took 61 downloads within hours, from a fleet nowhere near that
//      size), people re-download after a reinstall, and a curiosity click on a releases page
//      costs a download and produces no install at all. Subtracting two numbers that count
//      different things produces a third number that counts nothing. So the gap is SHOWN and left
//      to speak; the panel prints both figures and a sentence about what the gap can mean.
//
// WHAT IS DELIBERATELY ABSENT, so a later reader does not think it was forgotten:
//
//   * NO DENOMINATOR PER VERSION. `healthReports` is a per-version capability signal for errors
//     ("a client on this build reported at all"), which is what lets that section distinguish a
//     true zero from a build too old to speak. Nothing equivalent exists for a flip: a build
//     emits `optOut` only if somebody flips, so a version with no row is genuinely ambiguous
//     between "nobody left" and "this build predates the counter". Inventing a denominator would
//     be inventing the answer. The panel renders absence as a dash and says which it cannot tell.
//   * NO OPT-OUT RATE. `optOuts / reportingInstalls` would divide a WINDOWED count of flips by an
//     ALL-TIME count of installs, which is two different populations wearing one fraction.
//   * NO NETTING. `optOuts - optIns` is not "how many are still off"; it is two actions
//     subtracted. Both are printed.
//
// PURE, like every other builder in this directory: plain rows in, a plain shape out, so
// `tests/telemetryOptOut.test.mts` can author a population by hand. The DOWNLOAD half is not
// here at all — `TriageDownloads` is fetched at the presentation edges (`triage/ipc.ts`,
// `scripts/triageAnalytics.mts`) and merged there, exactly as `ghDownloads` and `liveSessions`
// already are, so `buildAnalytics` stays pure over the counter tables.

import { compareVersions } from '../../shared/releaseNotes'
import { USAGE_METRICS } from '../../shared/telemetryRollup'
import type { TriageAnalyticsCoverage, TriageCoverageVersion } from '../../shared/triage'
import { dimsOf, type InstallRow, type UsageRow } from './usageRows'

/** Builds listed. `MAX_RELEASE_VERSIONS`'s number, for the same reason: a table nobody reads. */
const MAX_COVERAGE_VERSIONS = 8

/**
 * The union of every build that reported EITHER kind of flip, newest first.
 *
 * A version appears here only because it has a row, which is the honest cut: this table cannot
 * list "builds with no opt-outs", because it has no way to tell those from builds that cannot
 * report one. `DIM_NONE` is filtered on the same deploy-skew grounds `buildReleaseHealth` filters
 * it — an ingest Lambda older than this feature cannot write these metrics at all, but a future
 * one that wrote them undimensioned must not render as a version called `-`.
 */
function flipVersions(outs: ReadonlyMap<string, number>, ins: ReadonlyMap<string, number>): string[] {
  const seen = new Set<string>([...outs.keys(), ...ins.keys()])
  return [...seen]
    .filter((v) => /^\d+\.\d+\.\d+/.test(v))
    .sort((a, b) => compareVersions(b, a))
    .slice(0, MAX_COVERAGE_VERSIONS)
}

/**
 * WHAT THIS PIPELINE CAN AND CANNOT SEE, from the counter rows and the install table.
 *
 * `usage` is WINDOWED (the caller reads `usage_daily` from a start day) and `installs` is not —
 * `analytics_install` holds every id that ever sent anything. That asymmetry is real, is not
 * fixable here, and is the reason the two numbers are labelled with their own spans in the panel
 * rather than combined into a rate.
 */
export function buildCoverage(
  usage: readonly UsageRow[],
  installs: readonly InstallRow[]
): TriageAnalyticsCoverage {
  const outs = dimsOf(usage, USAGE_METRICS.optOuts)
  const ins = dimsOf(usage, USAGE_METRICS.optIns)
  const byVersion: TriageCoverageVersion[] = flipVersions(outs, ins).map((version) => ({
    version,
    optOuts: outs.get(version) ?? 0,
    optIns: ins.get(version) ?? 0
  }))
  const total = (counts: ReadonlyMap<string, number>): number =>
    [...counts.values()].reduce((sum, n) => sum + n, 0)
  return {
    reportingInstalls: installs.length,
    optOuts: total(outs),
    optIns: total(ins),
    byVersion,
    anyFlips: outs.size > 0 || ins.size > 0
  }
}
