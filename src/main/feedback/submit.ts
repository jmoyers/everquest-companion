// feedback/submit.ts — assemble the report, POST it, then upload the slice.
//
// ============================ THE ONE RULE ============================
// THE GAME LOG IS OPENED READ-ONLY AND IS NEVER WRITTEN TO. This module reads it only
// through `slice.ts`, whose single fs call is `open(path, 'r')`.
// ======================================================================
//
// CONTRACT: `submitFeedback` NEVER REJECTS. Every outcome — a validation failure, a 429, a
// dead network, a bucket that failed validation — is a typed `SubmitResult`. A dialog that
// has to `try/catch` an IPC call to know what happened is a dialog that will show the wrong
// thing on the day it matters.
//
// WHAT QUEUES AND WHAT DOES NOT (§6.3): a transport failure (status 0 — offline, DNS, TLS,
// timeout) or a 5xx queues for a later attempt. A 4xx does not: retrying a 400 forever is a
// bug, not resilience. The one refinement on the plan's "5xx queues" is `closed` (503 + the
// kill switch): that is a DELIBERATE stop, and re-POSTing at a paused endpoint is precisely
// what the kill switch exists to prevent — so a `closed` response is reported to the user and
// not queued.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { release } from 'node:os'
import { basename } from 'node:path'
import {
  MAX_BODY_BYTES,
  validateDraft,
  type FeedbackDraft,
  type AchievementsDumpMeta,
  type FeedbackEnv,
  type InventoryDumpMeta,
  type LogSliceMeta,
  type PresignedUpload,
  type SubmitErrorCode,
  type SubmitRequest
} from '../../shared/feedback'
import { CHANNEL } from '../channel'
import { E2E } from '../e2e'
import { logError, logInfo } from '../errorLog'
import { resolveActiveCharacter } from '../log/config'
import { findOutputFile } from '../outputs/discovery'
import { getUpdateChannel } from '../store'
import { FEEDBACK_API_URL, allowedUploadUrl, postForm, postJson } from './net'
import {
  buildInventoryAttachment,
  inventoryMeta,
  type InventoryAttachment,
  type InventoryResult
} from './inventory'
import {
  achievementsMeta,
  buildAchievementsAttachment,
  type AchievementsAttachment,
  type AchievementsResult
} from './achievements'
import { feedbackPerfBlock } from './perf'
import { buildSlice, sliceMeta, type FeedbackSlice } from './slice'
import { enqueue, installId, type QueuedReport } from './state'

/** The public result of a submit attempt. Never a thrown error, never a bare boolean. */
export type SubmitResult =
  | {
      ok: true
      reportId: string
      logUploaded: boolean
      inventoryUploaded: boolean
      achievementsUploaded: boolean
    }
  | {
      ok: false
      error: SubmitErrorCode
      message: string
      queued: boolean
      /** Set for `invalid_payload` so the dialog can focus the offending input. */
      field?: string
      /** Set for `quota_exceeded` — seconds until the daily counter rolls over. */
      retryAfterSec?: number
    }

const failure = (
  error: SubmitErrorCode,
  message: string,
  extra: { queued?: boolean; field?: string; retryAfterSec?: number } = {}
): SubmitResult => ({ ok: false, error, message, queued: false, ...extra })

// ---- environment ---------------------------------------------------------------------------

/**
 * Everything the client knows about ITSELF. Assembled here, never typed by the user, and
 * deliberately NOT containing: character name, server, EQ install path, machine name, user
 * name, or any progress state (§3.1). The character name does survive inside an ATTACHED
 * slice — which is disclosed in the dialog and previewable before it leaves the machine.
 *
 * IT IS ASYNC FOR ONE FIELD (JOS-369): `perf.state.gpuVendor` comes from `app.getGPUInfo`, which
 * is a promise to the GPU process. The alternative — a sync env plus a second async call the
 * dialog and the submit path would each have to remember to make — is how a preview and a payload
 * come to disagree about what was sent, which is the one thing this feature promises cannot happen.
 * The vendor is memoized per process, so only the first caller ever waits.
 */
export async function feedbackEnv(): Promise<FeedbackEnv> {
  const perf = await feedbackPerfBlock()
  return {
    appVersion: app.getVersion(),
    // 'e2e' is not a legal tag and can never be sent: the guard in `submitFeedback` fires first.
    channel: CHANNEL === 'prod' ? 'prod' : 'dev',
    updateChannel: getUpdateChannel(),
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    // OMITTED, not null, when the rings are empty — an empty attachment is not an attachment
    // (slice.ts's rule, one artifact over), and absent is the spelling the validator reads.
    ...(perf === null ? {} : { perf })
  }
}

// ---- the session slice cache ------------------------------------------------------------------

/**
 * ONE built slice is cached per (log file, window) for the lifetime of the process, so the
 * bytes the user PREVIEWED, the bytes "Save a copy…" writes and the bytes that are uploaded
 * are the same bytes. Rebuilding at Send time would make the preview a claim about something
 * else — and the promise this feature makes is "you see exactly what is sent".
 */
let cacheKey = ''
let cacheValue: FeedbackSlice | null = null

/** The active character's log + name, or null on a machine with no EQ logs at all. */
export function activeLog(): { logPath: string; selfName: string } | null {
  const c = resolveActiveCharacter()
  return c === null ? null : { logPath: c.logPath, selfName: c.name }
}

/** Build (and cache for this session) a scrubbed slice. Null when no character log resolves. */
export async function cachedSlice(windowMinutes: number): Promise<FeedbackSlice | null> {
  const src = activeLog()
  if (src === null) return null
  const key = `${src.logPath}|${windowMinutes}`
  if (key === cacheKey) return cacheValue
  const slice = await buildSlice({ ...src, windowMinutes })
  cacheKey = key
  cacheValue = slice
  return slice
}

// ---- the inventory dump (JOS-296) ---------------------------------------------------------

/**
 * The active character's dump, or the reason there is none. The RESOLUTION lives here rather
 * than in `inventory.ts` because it needs the registry (which needs `effectiveEqRoot`, which
 * needs Electron) — the packaging half stays pure and path-parameterized, exactly like the
 * slicer's split between `slice.ts` and this file's `activeLog`.
 *
 * `findOutputFile` is the ONE resolver: it prefers `<Character>_<server>-Inventory.txt` and
 * falls back to the newest matching file, which is what a one-character machine always has. No
 * path rule is re-derived here; if the Settings override moves the EQ root, this moves with it.
 */
export function activeInventoryPath(): { path: string; fileName: string } | null {
  const c = resolveActiveCharacter()
  const path = findOutputFile('inventory', c?.name, c?.server)
  return path === null ? null : { path, fileName: basename(path) }
}

/**
 * The same resolution for the achievements dump (JOS-441). `findOutputFile` is kind-parameterized
 * and the `achievements` kind has been `supported` with a VERIFIED filename suffix since JOS-429,
 * so the kind literal is the only thing that differs — no path rule is re-derived here either.
 */
export function activeAchievementsPath(): { path: string; fileName: string } | null {
  const c = resolveActiveCharacter()
  const path = findOutputFile('achievements', c?.name, c?.server)
  return path === null ? null : { path, fileName: basename(path) }
}

/**
 * There is deliberately NO CACHE here, and that is the opposite call from `cachedSlice`.
 *
 * A slice is cached because the promise is "you see exactly what is sent": the bytes previewed,
 * the bytes saved and the bytes uploaded have to be one artifact, and rebuilding at Send time
 * would silently change the subject. A dump makes a DIFFERENT promise — it is the CURRENT export
 * — and it is a ~10 KB file whose whole point is that the player may re-run `/outputfile
 * inventory` mid-report to attach a fresh one (`outputs/registry.ts` states the same rule for the
 * same reason: "a cache would answer with the state from before they typed the command"). The
 * preview re-reads, and so does Send; the freshness stamp in the metadata is what makes the two
 * comparable.
 */
export async function currentInventory(): Promise<InventoryResult> {
  const found = activeInventoryPath()
  if (found === null) return { ok: false, reason: 'no-dump' }
  return await buildInventoryAttachment(found.path, found.fileName)
}

/**
 * The achievements dump, on the same no-cache terms and for the same reason — with one difference
 * of degree: on THIS attachment, re-running the command mid-report is the likely case rather than
 * the edge one, because the dialog's own hint is what tells a player the command exists.
 */
export async function currentAchievements(): Promise<AchievementsResult> {
  const found = activeAchievementsPath()
  if (found === null) return { ok: false, reason: 'no-dump' }
  return await buildAchievementsAttachment(found.path, found.fileName)
}

// ---- the wire ------------------------------------------------------------------------------------

/** Narrow the ingest API's JSON body. Anything unexpected is treated as no body at all. */
function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/** The presign, if the server sent a well-formed one. Its URL is validated at USE, in `upload`. */
function asUpload(raw: unknown): PresignedUpload | null {
  const o = asRecord(raw)
  if (o === null) return null
  const fields = asRecord(o.fields)
  if (typeof o.url !== 'string' || fields === null || typeof o.key !== 'string') return null
  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) if (typeof v === 'string') flat[k] = v
  return { url: o.url, fields: flat, key: o.key, expiresInSec: typeof o.expiresInSec === 'number' ? o.expiresInSec : 0 }
}

/**
 * POST the gz to the presigned endpoint. Returns whether the object landed.
 *
 * THE SECURITY STEP IS THE FIRST LINE: `upload.url` is REMOTE-SUPPLIED TEXT and this is the
 * moment a user's log would leave the machine. `allowedUploadUrl` pins it to our own bucket in
 * our own region, exactly (see net.ts). On null we upload NOTHING — the report still stands.
 */
async function uploadGz(
  upload: PresignedUpload,
  gz: Buffer,
  what: { field: string; fileName: string }
): Promise<boolean> {
  const url = allowedUploadUrl(upload.url)
  if (url === null) {
    logError('main:feedback', { message: `refused an upload URL outside our bucket: ${upload.url}` })
    return false
  }
  const form = new FormData()
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v)
  if (!('Content-Type' in upload.fields)) form.append('Content-Type', 'application/gzip')
  // S3 requires the file part LAST — everything after it in the form is ignored.
  // `new Uint8Array(gz)` rather than the Buffer itself: a Node Buffer's backing store is typed
  // `ArrayBufferLike` (it may be shared), which is not a `BlobPart`. One 2 MB copy, once.
  form.append('file', new Blob([new Uint8Array(gz)], { type: 'application/gzip' }), what.fileName)
  const res = await postForm(url, form)
  if (res.status < 200 || res.status >= 300) {
    logError('main:feedback', {
      message: `${what.field} upload failed (${res.status})`,
      err: res.networkError
    })
    return false
  }
  return true
}

/** The slice leg. One presign, one POST, one boolean — the report stands either way. */
function uploadSlice(upload: PresignedUpload, gz: Buffer): Promise<boolean> {
  return uploadGz(upload, gz, { field: 'slice', fileName: 'slice.log.gz' })
}

/**
 * The dump leg (JOS-296). Its own presign and its own key, so a slice that fails to land does
 * not take the dump with it — and so the two objects can be deleted independently by `forget`.
 */
function uploadInventory(upload: PresignedUpload, gz: Buffer): Promise<boolean> {
  return uploadGz(upload, gz, { field: 'inventory', fileName: 'inventory.txt.gz' })
}

/** The achievements leg (JOS-441), independent of the other two in exactly the same way. */
function uploadAchievements(upload: PresignedUpload, gz: Buffer): Promise<boolean> {
  return uploadGz(upload, gz, { field: 'achievements', fileName: 'achievements.txt.gz' })
}

/**
 * RUN EVERY UPLOAD LEG and report each one's truth — split out of `sendReport` at three legs,
 * because "did the server mint a presign AND did we build the bytes" is one question asked three
 * times and `sendReport`'s own job is the JSON round trip.
 *
 * A leg needs BOTH halves. A server that minted no presign (one that predates the attachment) and
 * a client that built no bytes both yield `false`, which is the truth in either case.
 */
async function uploadLegs(
  body: Record<string, unknown>,
  gz: Attachments
): Promise<{
  logUploaded: boolean
  inventoryUploaded: boolean
  achievementsUploaded: boolean
}> {
  const leg = async (
    raw: unknown,
    bytes: Buffer | null,
    send: (u: PresignedUpload, b: Buffer) => Promise<boolean>
  ): Promise<boolean> => {
    const upload = asUpload(raw)
    return upload !== null && bytes !== null ? await send(upload, bytes) : false
  }
  return {
    logUploaded: await leg(body.upload, gz.log, uploadSlice),
    inventoryUploaded: await leg(body.inventoryUpload, gz.inventory, uploadInventory),
    achievementsUploaded: await leg(body.achievementsUpload, gz.achievements, uploadAchievements)
  }
}

/** The §8.3 response table, as data. A status we do not recognize is `internal`. */
const STATUS_ERROR: Readonly<Record<number, SubmitErrorCode>> = {
  400: 'invalid_payload',
  403: 'blocked',
  413: 'too_large',
  429: 'quota_exceeded',
  503: 'closed'
}

/** Map a non-2xx response onto a typed error, preferring the server's own words. */
function errorFor(status: number, body: Record<string, unknown> | null): {
  error: SubmitErrorCode
  message: string
  field?: string
  retryAfterSec?: number
} {
  const code = typeof body?.error === 'string' ? (body.error as SubmitErrorCode) : null
  const message = typeof body?.message === 'string' ? body.message : `The server returned ${status}.`
  const field = typeof body?.field === 'string' ? body.field : undefined
  const retryAfterSec = typeof body?.retryAfterSec === 'number' ? body.retryAfterSec : undefined
  return { error: code ?? STATUS_ERROR[status] ?? 'internal', message, field, retryAfterSec }
}

/** Did this outcome earn another attempt later? Transport death and 5xx, but never `closed`. */
function retryable(status: number, error: SubmitErrorCode): boolean {
  if (error === 'closed') return false
  return status === 0 || status >= 500
}

/**
 * The BYTES of a report's attachments — never in the JSON body, always on their own presigns.
 * One field per attachment rather than a positional pair, so adding a third some day is a field
 * and not a signature every caller has to re-read. (JOS-441 was that third, and it was.)
 */
export interface Attachments {
  log: Buffer | null
  inventory: Buffer | null
  achievements: Buffer | null
}

export const NO_ATTACHMENTS: Attachments = { log: null, inventory: null, achievements: null }

/**
 * Send ONE assembled request. Shared by the interactive path and the queue drain, so an
 * offline retry goes over exactly the same wire as the first attempt.
 *
 * THE TWO UPLOAD LEGS ARE INDEPENDENT AND NEITHER CAN FAIL THE REPORT. The row is already
 * written by the time a presign exists; a refused URL, a 403 or a dead socket on either leg
 * costs that attachment and nothing else. A server that minted no `inventoryUpload` (one that
 * predates JOS-296) simply yields `inventoryUploaded: false`, which is the truth.
 */
export async function sendReport(
  req: SubmitRequest,
  gz: Attachments
): Promise<SubmitResult & { retry?: boolean }> {
  const json = JSON.stringify(req)
  if (Buffer.byteLength(json, 'utf8') > MAX_BODY_BYTES) {
    return failure('too_large', 'That report is too large to send. Please shorten the description.')
  }
  const res = await postJson(FEEDBACK_API_URL, req)
  const body = asRecord(res.body)
  if (res.status >= 200 && res.status < 300 && body?.ok === true && typeof body.reportId === 'string') {
    return { ok: true, reportId: body.reportId, ...(await uploadLegs(body, gz)) }
  }
  const mapped = errorFor(res.status, body)
  return { ...failure(mapped.error, mapped.message, mapped), retry: retryable(res.status, mapped.error) }
}

// ---- the public submit --------------------------------------------------------------------------

/** Assemble a `SubmitRequest` for a draft + whichever attachments were built. */
async function requestFor(
  draft: FeedbackDraft,
  meta: AttachmentMeta,
  clientReportId: string
): Promise<SubmitRequest> {
  return {
    v: 1,
    draft,
    env: await feedbackEnv(),
    installId: installId(),
    clientReportId,
    clientTs: Date.now(),
    log: meta.log,
    inventory: meta.inventory,
    achievements: meta.achievements
  }
}

/** The metadata half of the three attachments — named once, since three call sites carry it. */
interface AttachmentMeta {
  log: LogSliceMeta | null
  inventory: InventoryDumpMeta | null
  achievements: AchievementsDumpMeta | null
}

function queueEntry(req: SubmitRequest): QueuedReport {
  return {
    clientReportId: req.clientReportId,
    draft: req.draft,
    env: req.env,
    clientTs: req.clientTs,
    log: req.log,
    inventory: req.inventory,
    achievements: req.achievements,
    attempts: 1,
    // The first retry waits out the normal backoff; the periodic drain picks it up.
    nextAttemptAt: Date.now() + 5 * 60 * 1000,
    queuedAt: Date.now()
  }
}

/** `sendReport` with a belt-and-braces catch: `postJson`/`postForm` already swallow transport
 *  errors, so reaching the catch means a BUG — which must still not reject an IPC call. */
async function attemptSend(
  req: SubmitRequest,
  gz: Attachments
): Promise<SubmitResult & { retry?: boolean }> {
  try {
    return await sendReport(req, gz)
  } catch (err) {
    logError('main:feedback', { message: 'submit threw; queueing', err })
    return { ...failure('internal', 'Something went wrong sending that report.'), retry: true }
  }
}

/** The failure half of the union — what `queueFailure` decorates. */
type SubmitFailure = Extract<SubmitResult, { ok: false }>

/** Spool a failed-but-retryable report, and say so in words the dialog can render as-is. */
function queueFailure(res: SubmitFailure, req: SubmitRequest, gz: Attachments): SubmitResult {
  const queued = enqueue(queueEntry(req), gz)
  return {
    ...res,
    queued,
    message: queued
      ? "Saved - we'll send it next time you're online."
      : 'There are already 10 reports waiting to send. Please try again later.'
  }
}

/** A dump that PACKAGED, or null. "Not asked for", "no such file" and "too large" all read the
 *  same here on purpose: each is a report that goes without that attachment, and the dialog
 *  already told the user which one it was before Send was pressed. */
function packaged<T extends { ok: true }>(res: T | { ok: false } | null): T | null {
  return res?.ok === true ? res : null
}

/**
 * Build whichever attachments the user ticked, and hand back BOTH halves of each: the bytes for
 * the upload legs and the metadata for the JSON body. One function so the two can never disagree
 * — a report whose body declares a dump but whose upload has no bytes would be a report the
 * server presigns for nothing.
 */
async function buildAttachments(opts: {
  attachLog: boolean
  windowMinutes: number
  attachInventory: boolean
  attachAchievements: boolean
}): Promise<{ gz: Attachments; meta: AttachmentMeta }> {
  const slice = opts.attachLog ? await cachedSlice(opts.windowMinutes) : null
  const attached = packaged<InventoryAttachment>(
    opts.attachInventory ? await currentInventory() : null
  )
  const achAttached = packaged<AchievementsAttachment>(
    opts.attachAchievements ? await currentAchievements() : null
  )
  return {
    gz: {
      log: slice === null ? null : slice.gz,
      inventory: attached === null ? null : attached.gz,
      achievements: achAttached === null ? null : achAttached.gz
    },
    meta: {
      log: slice === null ? null : sliceMeta(slice),
      inventory: attached === null ? null : inventoryMeta(attached),
      achievements: achAttached === null ? null : achievementsMeta(achAttached)
    }
  }
}

/**
 * Send a report. Never throws; a network failure QUEUES (§4.2).
 *
 * Order of the gates, cheapest and most-certain first:
 *   1. e2e — the headless harness must NEVER touch the network or create rows (§6.6).
 *   2. no endpoint compiled in — this build ships dark; there is nothing to talk to, and
 *      queueing for an endpoint that does not exist would just age out in a week.
 *   3. the shared validator — the same code the dialog gates Send on and the Lambda runs.
 */
export async function submitFeedback(
  draft: FeedbackDraft,
  opts: {
    attachLog: boolean
    windowMinutes: number
    attachInventory: boolean
    attachAchievements: boolean
  }
): Promise<SubmitResult> {
  if (E2E) return failure('internal', 'disabled in e2e')
  if (FEEDBACK_API_URL === '') {
    return failure('internal', 'This build has no feedback endpoint. Please update to a newer version.')
  }
  const valid = validateDraft(draft)
  if (!valid.ok) return failure('invalid_payload', valid.message, { field: valid.field })

  const built = await buildAttachments(opts)
  const req = await requestFor(valid.value, built.meta, randomUUID())

  const res = await attemptSend(req, built.gz)
  if (res.ok) {
    logInfo(
      `[everquest-companion] feedback sent: ${res.reportId} ` +
        `(log ${res.logUploaded ? 'uploaded' : 'not uploaded'}, ` +
        `inventory ${res.inventoryUploaded ? 'uploaded' : 'not uploaded'}, ` +
        `achievements ${res.achievementsUploaded ? 'uploaded' : 'not uploaded'})`
    )
    return {
      ok: true,
      reportId: res.reportId,
      logUploaded: res.logUploaded,
      inventoryUploaded: res.inventoryUploaded,
      achievementsUploaded: res.achievementsUploaded
    }
  }
  return res.retry === true ? queueFailure(res, req, built.gz) : { ...res, queued: false }
}
