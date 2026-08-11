// ============================================================================
// errorBudget.ts — no error may report itself seven million times (JOS-197).
// ============================================================================
//
// THE READING THIS EXISTS FOR. One 0.14.0 install filed 7,272,196 occurrences of a single
// fingerprint in one day (`Error: EPIPE: broken pipe, write`). The loop that produced them is fixed
// at its source in `deadPipe.ts` — but a fix for THAT loop is not a fix for the shape, and the shape
// is the one thing the fleet keeps proving: something in this app will eventually manage to fail on
// a timer, and whatever it is, the client must not be able to report it without bound.
//
// SO THIS IS A HARD CEILING, AND IT IS THE OUTER GATE. `logError` is the ONE funnel every captured
// error passes through (errorLog.ts's header, JOS-100's argument), so a budget consulted THERE is a
// budget no reporting path can be added around: the error report, the errors.log line and the dev
// stdout line are all downstream of it. Adding a fourth sink tomorrow puts it downstream too,
// without anyone having to remember this file exists.
//
// WHAT IT BOUNDS, PRECISELY. Per FINGERPRINT — the identity the error store already groups by, so
// the cap is spelled in the same units a reader reads the store in — per SESSION:
//
//   occurrences 1 … N-1   reported and written as always
//   occurrence  N         reported and written, and it writes ONE notice saying this is the last
//   occurrences N+1 …     silence: no report, no errors.log line, no console line
//
// The report that leaves the client after the Nth is THE SUMMARY the ticket asked for: it is an
// ordinary `errorReport` carrying `count`, which is what `takeErrorReports` has always drained, so
// the summary needs no wire change and an older ingest reads it exactly as it reads any other.
//
// ---------------------------------------------------------------------------------------
// WHY THE FAILURE DIRECTION IS INVERTED FROM JOS-133, AND THAT IS THE POINT
// ---------------------------------------------------------------------------------------
// `errorRepeat.ts` says: past its key ceiling, NOTHING is suppressed — "this module may cost the
// file lines it did not have to, and may never cost it a line it cannot account for". That is the
// right direction for a question about how long a local file gets. It is the WRONG direction for
// this one. A budget that fails open is not a ceiling, and the whole ticket is that there was no
// ceiling. So past `MAX_BUDGETED_FINGERPRINTS` a fingerprint that cannot be tracked is SILENCED,
// and the worst case is bounded by construction at N × MAX_BUDGETED_FINGERPRINTS occurrences per
// session — with one notice written the first time the ceiling is reached, so a reader of
// errors.log is never left wondering why the file went quiet.
//
// A session that has produced two hundred DISTINCT fingerprints is a session where something is
// badly wrong, and the two hundred and first issue is not the one that explains it. That is
// `MAX_SESSION_FINGERPRINTS`'s argument (telemetry/errorReports.ts) at a wider setting.
//
// ---------------------------------------------------------------------------------------
// WHAT DELIBERATELY IS NOT BEHIND THIS GATE: THE HEALTH COUNTERS
// ---------------------------------------------------------------------------------------
// `mainErrorLogLines + suppressedErrorLines` keeps counting every occurrence, silenced or not, and
// that is not a gap in "no path may bypass the cap" — it is what makes the cap allowable at all.
// JOS-133 shipped `suppressedErrorLines` for exactly this reason: a cap that deflated the fleet's
// error rate would make a build that started looping look like a build that got better, which is
// worse than the noise it fixed. The distinction that resolves it is COST, not principle: a health
// counter emits SEVEN INTEGERS PER HEARTBEAT whatever their magnitude, so there is nothing there to
// flood and nothing to bypass, while an unbudgeted report path costs the fleet per occurrence.
//
// The honest statement of what a reader can know past the cap: `errorReport.count` for a capped
// fingerprint tops out at N per session and is a FLOOR, not a total; the total is in the health
// rate, which never stopped being true.
//
// THIS MODULE IMPORTS NOTHING (`errorRepeat.ts`'s reason, `telemetry/health.ts`'s reason): it is
// consulted from inside the app's error path, where a module-init cycle is the single worst bug to
// discover, and a leaf cannot participate in one. `tests/errorFlood.test.mts` therefore drives the
// real production rule with no Electron in the process.

/**
 * Occurrences of ONE fingerprint that this session may report before it goes silent.
 *
 * WHY A HUNDRED. It has to be large enough that the number itself still says something — "this
 * happened a hundred times in one session" is unambiguously a loop, and a reader chasing a rare
 * intermittent never reaches it — and small enough that the worst case is boring. It is NOT five:
 * `errorRepeat`'s five is about how many copies of an identical LINE a human wants in a file, and
 * five is enough there because the line is the same line. This one bounds a COUNT the fleet reasons
 * about, where the difference between 5 and 100 is the difference between "we saw it" and "we saw
 * how bad it was".
 *
 * The measured comparison that sets the scale: the loop this ticket came from ran at roughly eighty
 * occurrences per SECOND. At any N, a looping fingerprint spends its whole session budget in the
 * first seconds and is silent afterwards — so N buys resolution on the leading edge and costs
 * nothing on the tail. 100 × `MAX_BUDGETED_FINGERPRINTS` = 20,000 reportable occurrences per
 * session, against the 7,272,196 that produced this ticket.
 */
export const MAX_REPORTS_PER_FINGERPRINT = 100

/**
 * Fingerprints tracked at once. A bound on memory — and, unlike `MAX_TRACKED_ERROR_KEYS`, a bound
 * that CLOSES rather than opens (see the header). It is wider than `MAX_SESSION_FINGERPRINTS` (20)
 * on purpose: that one caps distinct EXEMPLARS the wire carries, this one caps distinct issues the
 * app is willing to make any noise about at all, and silencing a fingerprint merely because the
 * report ring was full would take errors.log with it.
 */
export const MAX_BUDGETED_FINGERPRINTS = 200

/** What `logError` should do with this occurrence. */
export interface BudgetVerdict {
  /** Inside the budget: record the report and let both sinks see it. */
  readonly report: boolean
  /** A one-off notice for errors.log, or null. Written whatever `report` says — it is the line
   *  that explains a silence, so it may not be silenced by the rule it is announcing. */
  readonly notice: string | null
}

const OPEN: BudgetVerdict = { report: true, notice: null }
const SILENT: BudgetVerdict = { report: false, notice: null }

/** Occurrences per fingerprint, this session. Reset only by `resetErrorBudget` — the budget is per
 *  SESSION by design, the same argument `errorRepeat`'s `seen` makes: a process that restarts has
 *  already lost the context the earlier copies were reported for. */
const spent = new Map<string, number>()

/** Has the "no room to track anything new" notice already been written this session? */
let ceilingAnnounced = false

/**
 * Spend one occurrence of `fingerprint` and say what to do with it. Total, allocation-light, and
 * never throws — it runs inside `logError`, which is itself the app's last line of defense.
 */
export function errorBudget(fingerprint: string): BudgetVerdict {
  const before = spent.get(fingerprint)
  if (before === undefined && spent.size >= MAX_BUDGETED_FINGERPRINTS) {
    if (ceilingAnnounced) return SILENT
    ceilingAnnounced = true
    return {
      report: false,
      notice:
        `[errorBudget] ${String(MAX_BUDGETED_FINGERPRINTS)} distinct errors have been reported ` +
        'this session; further NEW ones are counted, not reported'
    }
  }
  const n = (before ?? 0) + 1
  // Stop counting past the cap: what the number would become is nobody's question, and leaving it
  // unbounded is the one way an integer in here could ever surprise someone (`errorRepeat`'s rule).
  spent.set(fingerprint, n > MAX_REPORTS_PER_FINGERPRINT ? MAX_REPORTS_PER_FINGERPRINT + 1 : n)
  if (n < MAX_REPORTS_PER_FINGERPRINT) return OPEN
  if (n === MAX_REPORTS_PER_FINGERPRINT) {
    return {
      report: true,
      // Written to the file so a reader of errors.log is never left wondering why an error stopped
      // appearing. It carries no part of the payload — the copies above it are the payload — and it
      // names the fingerprint, which is the identity the error store groups by, so the line and the
      // store row can be lined up by hand.
      notice:
        `[errorBudget] ${fingerprint} has now been reported ` +
        `${String(MAX_REPORTS_PER_FINGERPRINT)} times this session; further occurrences are ` +
        'counted, not reported'
    }
  }
  return SILENT
}

/** Distinct fingerprints currently budgeted. For tests and diagnostics; never sent anywhere. */
export function errorBudgetTracked(): number {
  return spent.size
}

/** Occurrences spent by one fingerprint, capped at N+1. For tests; never sent anywhere. */
export function errorBudgetSpent(fingerprint: string): number {
  return spent.get(fingerprint) ?? 0
}

/** Forget every fingerprint. Called from the collector's session boundaries (via
 *  `resetErrorReports`) and from tests — the budget is per session (see `spent`). */
export function resetErrorBudget(): void {
  spent.clear()
  ceilingAnnounced = false
}
