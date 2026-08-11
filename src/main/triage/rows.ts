// ============================================================================
// rows.ts — DSQL row -> the shapes that cross the bridge. Pure, AWS-free, tested.
// ============================================================================
//
// Split out of backend.ts for the same reason triageCluster.mts is split out of the CLI: the
// interesting decisions here are decisions about MEANING, and they must be testable without a
// database, a network or credentials. Nothing in this file imports `pg`, `@aws-sdk/*` or
// Electron, so `tests/triageIpcGuard.test.mts` loads it directly.
//
// Two of those decisions are load-bearing:
//
//   * THE LOG STATE IS TRI-STATE. `log_json` present means the client DECLARED a slice;
//     whether the presigned upload actually landed is a separate fact that costs a HeadObject.
//     The list stops at `declared`, the detail resolves `present` / `missing`. Flattening the
//     two would erase the failed-upload case, which is real and which the CLI prints.
//   * `env_json` IS TEXT HOLDING JSON (schema.sql says so, and nothing ever queries into it).
//     So the parse is TOTAL: a truncated or non-object blob yields `{}`. A detail pane that
//     throws because one row's env is malformed is worse than one that shows no env.

import type {
  TriageDetail,
  TriageLogState,
  TriageOpsState,
  TriageBlockedInstall,
  TriageRow
} from '../../shared/triage'
import type {
  AppChannelTag,
  FeedbackType,
  ReportStatus,
  Severity
} from '../../shared/feedback'
import { sanitizeAndFlag, sanitizeMultiline, sanitizeOneLine } from '../../shared/sanitizeText'
import { scrubLines } from '../../shared/logScrub'

/** A DSQL row as node-postgres hands it over: every column is `unknown` until proven. */
export type Row = Record<string, unknown>

/**
 * Every text column leaves this module SANITIZED — the triage tab's half of the owner-side
 * display hardening, and the twin of the same rule in `store.ts` (which serves the CLI).
 *
 * The wire validators refuse control characters now (src/shared/feedback.ts), but rows written
 * before that rule existed are still in the table and a guard that only covers new rows is not
 * a guard. React will not EXECUTE an escape sequence the way a terminal does, but it will
 * happily render zero-width joiners and BiDi overrides — text that reads as one thing and is
 * another is exactly the input a triage decision must not be made on. `sanitizeMultiline` keeps
 * newlines and tabs (the description pane is `pre-wrap` and should stay readable) and removes
 * ANSI sequences whole, C0/DEL/C1 and the invisible/BiDi class.
 */
const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? sanitizeMultiline(v) : fallback
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)
/** Optional text column: NULL and '' both mean "not set", never the empty string. */
const opt = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? sanitizeMultiline(v).trim() : ''
  return s.length > 0 ? s : undefined
}
const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/**
 * TOTAL: never throws, never returns a non-object, never yields non-string values.
 *
 * KEY AND VALUE ARE BOTH SANITIZED, and to the ONE-LINE rule: this blob is whatever the client
 * sent as `env`, it is rendered as a two-column grid of captions, and a value carrying a newline
 * would forge a row in that grid the same way one carrying an ESC would repaint a terminal. An
 * env value is `os.release()` or `process.versions.node` — there is no legitimate newline in one.
 */
export function parseEnv(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[sanitizeOneLine(k)] = sanitizeOneLine(typeof v === 'string' ? v : JSON.stringify(v))
  }
  return out
}

/** `log_json` holds the LogSliceMeta the client sent. Total, like parseEnv. */
function parseLogMeta(raw: unknown): { bytes?: number; lines?: number } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const meta = parsed as { bytes?: unknown; lines?: unknown }
    return {
      ...(typeof meta.bytes === 'number' ? { bytes: meta.bytes } : {}),
      ...(typeof meta.lines === 'number' ? { lines: meta.lines } : {})
    }
  } catch {
    return {}
  }
}

/** Did this report DECLARE a slice? (Not: did it land — that needs S3.) */
export function declaresLog(row: Row): boolean {
  return row.log_json !== null && row.log_json !== undefined
}

/** One list row. The description IS the report — there is no title and no contact to read. */
export function toRow(row: Row): TriageRow {
  const severity = opt(row.severity)
  const cluster = opt(row.cluster_id)
  const triagedAt = optNum(row.triaged_at)
  return {
    reportId: str(row.report_id),
    type: str(row.report_type, 'bug') as FeedbackType,
    description: str(row.description),
    appVersion: str(row.app_version, '?'),
    platform: str(row.platform, '?'),
    channel: str(row.channel, 'prod') as AppChannelTag,
    status: str(row.status, 'new') as ReportStatus,
    ...(severity ? { severity: severity as Severity } : {}),
    ...(cluster ? { cluster } : {}),
    spamScore: num(row.spam_score),
    receivedAt: num(row.received_at),
    ...(triagedAt === undefined ? {} : { triagedAt }),
    log: declaresLog(row) ? 'declared' : 'none'
  }
}

/**
 * The full record. `logLanded` is the caller's HeadObject answer and is only consulted when a
 * key exists — passing `false` for a report that never attached anything must NOT read as a
 * failed upload.
 */
export function toDetail(row: Row, logLanded: boolean): TriageDetail {
  const key = opt(row.log_key)
  const meta = parseLogMeta(row.log_json)
  const dupeOf = opt(row.dupe_of)
  const issueUrl = opt(row.issue_url)
  const note = opt(row.disposition)
  const redactedAt = optNum(row.redacted_at)
  const log: TriageLogState = !declaresLog(row) && !key ? 'none' : logLanded ? 'present' : 'missing'
  return {
    row: toRow(row),
    installId: str(row.install_id),
    clientTs: num(row.client_ts),
    env: parseEnv(row.env_json),
    ...(dupeOf ? { dupeOf } : {}),
    ...(issueUrl ? { issueUrl } : {}),
    ...(note ? { note } : {}),
    ...(redactedAt === undefined ? {} : { redactedAt }),
    ...(key ? { logKey: key } : {}),
    ...(meta.bytes === undefined ? {} : { logBytes: meta.bytes }),
    ...(meta.lines === undefined ? {} : { logLines: meta.lines }),
    log
  }
}

// ---- the slice re-scrub -------------------------------------------------------------

/**
 * RE-SCRUB ON READ — the pure half, here for the same reason everything else in this file is:
 * the interesting decision is a decision about MEANING, and it must be testable without a
 * bucket, a network or credentials. `store.ts downloadSlice` is the only caller.
 *
 * WHY IT EXISTS. The presigned POST policy pins an upload's KEY, its SIZE and its CONTENT-TYPE.
 * It cannot pin its CONTENT. A client that skipped `src/shared/logScrub.ts` — or that was never
 * our client — can put a raw, unscrubbed log window in that object, third-party chat and all,
 * and S3 will accept it. So the bytes are re-scrubbed with the SAME shared module the app runs
 * before uploading, and each surviving line is run through the SAME shared text sanitizer,
 * because a cached slice is a file an operator will eventually `cat` and an ESC in a log line is
 * an escape sequence in their shell.
 *
 * NO `selfName` CARVE-OUT, deliberately. The scrubber can spare the REPORTER's own `/who` row
 * only if it is told whose log this is, and the owner does not know — guessing would mean
 * trusting a client-supplied name to decide which stranger's row survives. The strict rule is
 * the safe one; it costs at most the reporter's own `/who` row, which is a character name the
 * owner has no use for either.
 *
 * `dropped` is therefore "lines the owner-side scrub removed", and for an honest client — which
 * ran this exact module already — it is ZERO. A non-zero value is evidence, not noise.
 */
export function rescrubSlice(raw: string): { text: string; dropped: number; cleaned: number } {
  const { kept, dropped } = scrubLines(raw.split(/\r?\n/))
  let cleaned = 0
  const out = kept.map((line) => {
    const s = sanitizeAndFlag(line)
    if (s.changed) cleaned++
    return s.text
  })
  return { text: out.join('\n'), dropped, cleaned }
}

/**
 * What the owner-side re-scrub found, as `store.ts downloadSlice` reports it. It lives HERE
 * rather than beside the S3 call so that the CLI, the IPC backend and this module's own tests
 * all name one shape without any of them importing `@aws-sdk`.
 */
export interface SliceRescrub {
  /** Where the (re-scrubbed) copy lives on this machine. */
  path: string
  /** Lines the SHARED scrubber removed here that the client's run did not — third-party chat. */
  dropped: number
  /** Lines that carried control characters or ANSI escapes and were cleaned. */
  cleaned: number
  /** True when this is a CACHED copy whose counts were never recorded (a pre-re-scrub cache). */
  fromLegacyCache: boolean
}

/**
 * The re-scrub verdict as PROSE, for the CLI to print. Empty when there is nothing to say —
 * which is the honest-client case, and the case that must stay silent so the other one is loud.
 *
 * A non-zero `dropped` is not a nuisance, it is EVIDENCE: the object in the bucket holds
 * third-party chat that our own client removes before uploading, so that upload did not come
 * from our client (or came from one that was tampered with). Pure, so the wording is testable.
 */
export function rescrubNotes(re: SliceRescrub): string[] {
  if (re.fromLegacyCache) {
    return [
      '[re-scrub: this copy was cached before re-scrub-on-read existed, so what it removed was ' +
        `never measured. Delete ${re.path} and re-run for a real answer.]`
    ]
  }
  const notes: string[] = []
  if (re.dropped > 0) {
    notes.push(
      `WARNING: re-scrub removed ${String(re.dropped)} line(s) of third-party chat from this ` +
        'slice. Our own client removes them BEFORE uploading, so an honest upload has a delta ' +
        'of zero - this one was not scrubbed by our client. The S3 object is untouched (it is ' +
        'the evidence); only the local copy was cleaned.'
    )
  }
  if (re.cleaned > 0) {
    notes.push(
      `${String(re.cleaned)} line(s) carried control characters or ANSI escapes and were ` +
        'sanitized before being written to disk.'
    )
  }
  return notes
}

/** Default kill-switch prose for a cluster whose seed row is missing entirely. */
const NO_CONFIG_MESSAGE = 'Feedback is not open yet. Please try again later.'

/**
 * The Ops state, stated POSITIVELY (`accepting`), which is the opposite polarity from the
 * CLI's `closed on|off`. One polarity, chosen here, labelled in the UI — see the note on
 * `TriageOpsState`. A missing config row reads as NOT accepting, matching schema.sql's seed:
 * a stack whose switch has never been set is closed, and this panel must not claim otherwise.
 */
export function toOps(config: Row | null, profiles: readonly Row[]): TriageOpsState {
  return {
    accepting: config?.accepting === true,
    closedMessage: str(config?.closed_message, NO_CONFIG_MESSAGE),
    maxPerInstallPerDay: num(config?.max_per_install_per_day, 0),
    blocked: profiles.map(toBlocked)
  }
}

export function toBlocked(row: Row): TriageBlockedInstall {
  const reason = opt(row.blocked_reason)
  const blockedAt = optNum(row.blocked_at)
  return {
    installId: str(row.install_id),
    blocked: row.blocked === true,
    ...(reason ? { reason } : {}),
    ...(blockedAt === undefined ? {} : { blockedAt })
  }
}
