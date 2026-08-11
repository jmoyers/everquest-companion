// ============================================================================
// ghDownloads.ts — release download counts, fetched BESIDE the analytics readout.
// ============================================================================
//
// THE NUMBER THIS FETCHES IS NOT AN INSTALL COUNT. electron-updater re-downloads the installer
// asset for every install it updates, so `download_count` is dominated by the fleet updating
// itself (v0.5.0: 61 downloads within hours of publication, from a fleet nowhere near that
// size). Every label that renders these numbers says so, in the CLI and in the tab; the install
// truth is `analytics_install`, which the same readout already shows as "installs all-time".
//
// IT DOES NOT FLOW THROUGH `buildAnalytics`. That function is pure over three arrays of counter
// rows and stays that way — a network fetch inside it would make the whole readout untestable
// without a socket. This module is called in parallel with the database read and merged at the
// presentation edges (`ipc.ts` for the tab, `triageAnalytics.mts` for the digest).
//
// FAILURE IS SOFT, ALWAYS. GitHub is unauthenticated here (60 requests/hour per IP), so a spent
// rate limit is an ordinary Tuesday, not a bug. Nothing below throws: every outcome is either
// `available: true` or a `reason` string the renderer prints in place of the section. A dark
// github.com must never be able to fail a digest that is otherwise about a database.
//
// THE REDUCTION IS SEPARATE AND PURE (`toDownloadRows`), so `tests/ghDownloads.test.mts` can
// feed it a captured response shape and assert the per-tag arithmetic without a network.

import type { TriageDownloadRow, TriageDownloads } from '../../shared/triage'

/** The repo the app publishes to — electron-builder.yml's `publish` block, same owner/repo. */
const RELEASES_URL =
  'https://api.github.com/repos/jmoyers/everquest-companion/releases?per_page=100'

/** The readout must not sit and wait on GitHub; the database half is the point of the screen. */
const TIMEOUT_MS = 5_000

const UA = 'everquest-companion/0.1 (triage analytics)'

function isArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** A count from untrusted JSON. Anything that is not a finite number contributes zero. */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** The installer, as opposed to `latest.yml` / `.blockmap` — which the updater fetches far more. */
function isInstaller(asset: Record<string, unknown>): boolean {
  return (text(asset.name) ?? '').toLowerCase().endsWith('.exe')
}

/**
 * The releases list, reduced to one row per tag. PURE and TOTAL: the argument is whatever
 * `res.json()` produced, so every field is treated as absent-until-proven and a payload that is
 * not an array at all reduces to no rows rather than a throw.
 *
 * DRAFTS ARE DROPPED. An unauthenticated GET never sees one, but a draft's counts would be a
 * release nobody could have downloaded, and a zero row in the table reads as a failed launch.
 * Newest first, by publication date — the tag order the operator is asking about.
 */
export function toDownloadRows(payload: unknown): TriageDownloadRow[] {
  if (!isArray(payload)) return []
  return payload
    .filter(isRecord)
    .filter((r) => r.draft !== true)
    .map((r) => {
      const assets = isArray(r.assets) ? r.assets.filter(isRecord) : []
      return {
        tag: text(r.tag_name) ?? text(r.name) ?? '(untagged)',
        exeDownloads: assets
          .filter(isInstaller)
          .reduce((sum, a) => sum + count(a.download_count), 0),
        totalDownloads: assets.reduce((sum, a) => sum + count(a.download_count), 0),
        publishedAt: text(r.published_at)
      }
    })
    .sort(
      (a, b) =>
        (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') ||
        b.tag.localeCompare(a.tag, undefined, { numeric: true })
    )
}

/**
 * Why a non-200 happened, in the words the operator needs. A 403 with no remaining budget is the
 * rate limit and is named as such — otherwise it reads as "GitHub blocked us", which is a very
 * different thing to go and debug.
 */
function httpReason(status: number, statusText: string, remaining: string | null): string {
  if (status === 403 && remaining === '0') {
    return 'github rate limit spent (60/hr unauthenticated) - it refills within the hour'
  }
  return `github answered ${String(status)}${statusText.length > 0 ? ` ${statusText}` : ''}`
}

/**
 * The one call. Never throws, never rejects: an unreachable host, a timeout, a rate limit and a
 * malformed body all land as `available: false` with a reason the section prints verbatim.
 */
export async function fetchGhDownloads(nowMs: number = Date.now()): Promise<TriageDownloads> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    ctrl.abort()
  }, TIMEOUT_MS)
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': UA },
      signal: ctrl.signal
    })
    if (!res.ok) {
      return {
        available: false,
        reason: httpReason(res.status, res.statusText, res.headers.get('x-ratelimit-remaining'))
      }
    }
    const payload: unknown = await res.json()
    return { available: true, releases: toDownloadRows(payload), fetchedAtMs: nowMs }
  } catch (err) {
    if (ctrl.signal.aborted) {
      return { available: false, reason: `github did not answer within ${String(TIMEOUT_MS / 1000)}s` }
    }
    return { available: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
