// ============================================================================
// ipc.ts — the `triage:*` channels. OWNER OPT-IN ONLY. Never registered in a shipped app.
// ============================================================================
//
// HOW THIS MODULE IS REACHED, and why a shipped build cannot reach it — three independent
// locks, any one of which is sufficient:
//
//   1. THE GATE. `src/main/index.ts` calls `registerTriageIpc()` from inside
//      `if (!OWNER_TOOLS) return`, behind a DYNAMIC `import()`. That predicate is
//      `EQ_OWNER_TOOLS=1` AND not packaged AND not the e2e harness (src/shared/ownerTools.ts),
//      so a packaged app never evaluates this module at all, neither does the headless
//      harness — and neither does an ordinary `npm run dev` in a checkout that did not ask
//      for it. JOS-72 added that last term after a stranger's self-compiled macOS build,
//      which is not `app.isPackaged`, came up with this tab in its nav drawer.
//   2. THE DEPENDENCIES. The chain below reaches `@aws-sdk/client-s3`,
//      `@aws-sdk/credential-providers`, `@aws-sdk/dsql-signer` and `pg` — every one of them a
//      **devDependency**. electron-builder packages `dependencies` only, so even a build with
//      the gate patched out would fail to resolve them. This is a structural property of the
//      packaging, not a runtime check someone can flip.
//   3. THE CREDENTIALS. Authentication is an IAM token that `@aws-sdk/dsql-signer` derives
//      locally from the LAUNCHING SHELL's AWS profile (`AWS_PROFILE`, default `eqc`) — the
//      same door the `triage-feedback` CLI uses. There is no password anywhere to leak.
//      Possession of the owner's IAM credentials IS the access control; any other shell gets
//      IAM denials on the first statement and this panel renders them as prose.
//
// THE RENDERER STILL DOES NOT GET TO BE TRUSTED. Every argument below is validated at the
// handler (`validate.ts`) — `reportId` in particular reaches a file path as well as a SQL
// parameter and is required to be a 26-character ULID and nothing else.
//
// THE LAW (§10.3): a raw log slice never reaches anything public. `triage:slice` moves capped
// slice TEXT from main to the renderer over IPC, where it is rendered in a local window. It is
// never written to a published artefact, never put in an issue body, and only exists in a
// build compiled with the dev flag on.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { TriageResult } from '../../shared/triage'
import { awsBackend, TRIAGE_PROFILE, type TriageBackend } from './backend'
import { fetchGhDownloads } from './ghDownloads'
import { fetchLiveSessions } from './liveSessions'
import { unreachable } from './store'
import {
  isInstallId,
  isReportId,
  validateAnalyticsDays,
  validateBlockReason,
  validateClosedMessage,
  validatePatch,
  validateQuery
} from './validate'

/** Prose, never a stack. An IAM denial is the ACCESS CONTROL WORKING and must read like it. */
function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/AccessDenied|not authorized|UnrecognizedClient|ExpiredToken|could not be refreshed|CredentialsProviderError/i.test(raw)) {
    return `${raw}\n\nThis surface authenticates with your shell's AWS profile (AWS_PROFILE, default 'eqc'). Nothing else grants access.`
  }
  // The FEEDBACK panels' half of the analytics tab's `unreachable` state. They have no
  // structured unavailable state — every failure is prose here — so the naming happens in the
  // prose: a dropped socket is a transient fact about the connection, not a bug in the panel,
  // and `Connection terminated unexpectedly` alone reads like one.
  if (unreachable(err)) {
    return `${raw}\n\nThe DSQL cluster stopped answering (the connection dropped). Nothing needs migrating - retrying opens a fresh connection.`
  }
  return raw
}

/** One shape for every reply: a rejected invoke would leave the panel blank with no reason. */
async function attempt<T>(run: () => Promise<T>): Promise<TriageResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    return { ok: false, error: message(err) }
  }
}

const REJECT = { ok: false as const, error: 'Invalid triage request - rejected at the handler.' }

/**
 * `backend` is injectable so the surface can be driven without AWS; the default is the real
 * one. Returns a disposer that closes the DSQL connection — the app calls it on teardown so a
 * live socket cannot hold the process open (the same hang the CLI's `finally` exists for).
 */
export function registerTriageIpc(backend: TriageBackend = awsBackend()): () => Promise<void> {
  ipcMain.handle(IPC.triageList, async (_e, raw: unknown) => {
    const q = validateQuery(raw)
    return q === null ? REJECT : await attempt(() => backend.list(q))
  })

  ipcMain.handle(IPC.triageDetail, async (_e, reportId: unknown) =>
    isReportId(reportId) ? await attempt(() => backend.detail(reportId)) : REJECT
  )

  ipcMain.handle(IPC.triageSlice, async (_e, reportId: unknown) =>
    isReportId(reportId) ? await attempt(() => backend.slice(reportId)) : REJECT
  )

  ipcMain.handle(IPC.triagePatch, async (_e, reportId: unknown, rawPatch: unknown) => {
    const patch = validatePatch(rawPatch)
    if (!isReportId(reportId) || patch === null) return REJECT
    return await attempt(() => backend.patch(reportId, patch))
  })

  ipcMain.handle(IPC.triageForget, async (_e, reportId: unknown) =>
    isReportId(reportId) ? await attempt(() => backend.forget(reportId)) : REJECT
  )

  ipcMain.handle(IPC.triageOps, async () => await attempt(() => backend.ops()))

  // POSITIVE POLARITY, decided once (see TriageOpsState): `accepting: false` is what the CLI
  // spells `closed on`. The UI label says "Accepting reports" so the switch cannot read
  // backwards.
  ipcMain.handle(IPC.triageSetAccepting, async (_e, accepting: unknown, rawMessage: unknown) => {
    const text = validateClosedMessage(rawMessage)
    if (typeof accepting !== 'boolean' || text === null) return REJECT
    return await attempt(() => backend.setAccepting(accepting, text))
  })

  ipcMain.handle(IPC.triageSetBlocked, async (_e, installId: unknown, blocked: unknown, rawReason: unknown) => {
    if (!isInstallId(installId) || typeof blocked !== 'boolean') return REJECT
    const reason = validateBlockReason(rawReason, blocked)
    if (reason === null) return REJECT
    return await attempt(() => backend.setBlocked(installId, blocked, reason))
  })

  ipcMain.handle(IPC.triageDigest, async (_e, raw: unknown) => {
    const q = validateQuery(raw)
    return q === null ? REJECT : await attempt(() => backend.digest(q))
  })

  // The window is an ENUM (validate.ts says why), and an omitted one is the default rather
  // than a rejection — the panel's first render has not chosen a window yet.
  //
  // `includeOwner` needs no validator beyond `=== true`: it is a boolean that selects between
  // two server-decided cohorts and never reaches SQL as a value. Anything that is not literally
  // `true` means "user cohort only", which is the safe default in both directions — a renderer
  // sending junk gets the population readout, not the owner's.
  //
  // THE GITHUB DOWNLOAD COUNTS ARE MERGED HERE, and only here. The backend answers from the
  // cluster and `buildAnalytics` is pure over its rows; neither knows this fetch exists, which
  // is what keeps the whole readout assertable without a socket. The two run in PARALLEL — the
  // release list must not add its latency to the database read — and a GitHub failure is a
  // quiet `available: false` inside the value, never a failure of this channel.
  ipcMain.handle(IPC.triageAnalytics, async (_e, rawDays: unknown, rawIncludeOwner: unknown) => {
    const days = validateAnalyticsDays(rawDays)
    if (days === null) return REJECT
    //
    // THE LIVE-SESSION READ RIDES ALONGSIDE THEM BOTH, for the same reasons: it is CloudWatch
    // rather than the cluster, `buildAnalytics` never learns it exists, and a throttled or
    // credential-less CloudWatch is an `available:false` inside the value rather than a failure
    // of this channel. Three reads, one round trip's worth of latency.
    const [result, downloads, live] = await Promise.all([
      attempt(() => backend.analytics(days, rawIncludeOwner === true)),
      fetchGhDownloads(),
      fetchLiveSessions({ profile: TRIAGE_PROFILE })
    ])
    if (!result.ok || !result.value.available) return result
    return { ok: true as const, value: { ...result.value, downloads, live } }
  })

  return () => backend.close()
}
