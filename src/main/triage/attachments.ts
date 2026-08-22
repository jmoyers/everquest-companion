/**
 * attachments.ts — the S3 half of triage: a report's ATTACHMENT OBJECTS.
 *
 * SPLIT OUT OF store.ts, for the reason store.ts's own header gives for `usageStore.ts`: a file
 * that composed past the 400-code-line ceiling gets a half moved out, not a threshold moved up.
 * The half that moved is the one with a natural boundary — everything here is about the S3
 * objects a report owns, and nothing here touches DSQL.
 *
 * WHAT MADE IT A HALF WORTH NAMING (JOS-296): a report used to own ONE object. It now owns up to
 * two — a scrubbed log slice and an inventory export — and "which objects does this report own"
 * became a question with an answer worth writing down (`attachmentKeysOf`) rather than a field
 * read (`log_key`). `forget` and `wipe` iterate that answer, so adding a third attachment some
 * day is a line here and nothing at the deletion sites.
 *
 * THE THREE PROPERTIES THIS FILE HOLDS:
 *
 *   1. NOTHING A CLIENT UPLOADED IS TRUSTED. The presign policy pins an object's key, size and
 *      content-type; it CANNOT pin its content. So bytes are cleaned on the way IN — through the
 *      app's own pure transforms in ./rows.ts, which are tested without AWS — and what the
 *      cleaning removed travels back with the file.
 *   2. THE S3 OBJECT IS THE EVIDENCE AND IS NEVER MODIFIED. Only the owner's LOCAL copy is
 *      cleaned. `deleteSlice` is the only thing that destroys anything, and it is called by
 *      `forget` and `wipe` alone.
 *   3. LOCAL COPIES ARE CACHED WITH A SIDECAR, so a second read costs nothing and can still
 *      report what the first one found.
 *
 * `Clients` is imported TYPE-ONLY from store.ts, which re-exports this module's names. That is a
 * type cycle, which TypeScript erases, and never a runtime one.
 */

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { sanitizeMultiline } from '../../shared/sanitizeText'
import {
  achievementsNotes,
  inventoryNotes,
  rescrubNotes,
  rescrubSlice,
  sanitizeAchievements,
  sanitizeInventory,
  type InventoryDownload,
  type Row,
  type SliceRescrub
} from './rows'
import type { Clients } from './store'
import { TRIAGE_DIR } from './paths'

/** Downloaded log slices. */
const SLICE_DIR = join(TRIAGE_DIR, 'slices')
/** Downloaded inventory dumps (JOS-296). Its own directory beside `slices/`, so `ls` answers
 *  "what have I got locally" per attachment kind and neither can shadow the other's filenames. */
const INVENTORY_DIR = join(TRIAGE_DIR, 'inventory')
/** Downloaded achievements dumps (JOS-441), on the same one-directory-per-kind rule. */
const ACHIEVEMENTS_DIR = join(TRIAGE_DIR, 'achievements')

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)
/** A text column, sanitized — the same rule store.ts applies to every client-supplied string. */
const str = (v: unknown): string => (typeof v === 'string' ? sanitizeMultiline(v) : '')

// ---- which objects does a report own? ------------------------------------------------

export function logKeyOf(row: Row): string | null {
  const key = str(row.log_key)
  return key.length > 0 ? key : null
}

/** The inventory dump's S3 key (JOS-296), or null when the report carries none. */
export function inventoryKeyOf(row: Row): string | null {
  const key = str(row.inventory_key)
  return key.length > 0 ? key : null
}

/** The achievements dump's S3 key (JOS-441), or null when the report carries none. */
export function achievementsKeyOf(row: Row): string | null {
  const key = str(row.achievements_key)
  return key.length > 0 ? key : null
}

/** Every attachment object a report owns. THE deletion list — `forget` and `wipe` iterate this
 *  rather than naming `log_key` and hoping somebody remembers to add the next one. (JOS-441 is
 *  the second time that hope would have been misplaced, and it cost one line here instead.) */
export function attachmentKeysOf(row: Row): string[] {
  return [logKeyOf(row), inventoryKeyOf(row), achievementsKeyOf(row)].filter(
    (k): k is string => k !== null
  )
}

/** Did the upload actually land? One HeadObject, which is why no S3 event Lambda exists.
 *  Key-parameterized, so the dump's object is asked the same question the slice's is. */
export async function logObjectExists(c: Clients, key: string): Promise<boolean> {
  try {
    await c.s3.send(new HeadObjectCommand({ Bucket: c.stack.bucket_name, Key: key }))
    return true
  } catch {
    return false
  }
}

// ---- download + clean ----------------------------------------------------------------

/** The cleaned text plus what the cleaning found. `dropped` is the slice's alone — a dump has no
 *  line the scrubber could drop, which is `sanitizeInventory`'s whole argument (./rows.ts). */
interface Cleaned {
  text: string
  dropped?: number
  cleaned: number
}

/**
 * DOWNLOAD AN ATTACHMENT AND CLEAN IT ON THE WAY IN. ONE function for both kinds, because
 * everything except the cleaner is identical and two copies of it would drift.
 *
 * A cached copy written before the sidecar existed comes back FLAGGED rather than reporting
 * zeros: claiming a measurement nobody took is worse than saying it is unknown, and the fix
 * (delete the file, read it again) is one the note states.
 */
async function downloadAttachment(
  c: Clients,
  spec: { dir: string; dest: string; meta: string; key: string },
  clean: (raw: string) => Cleaned
): Promise<SliceRescrub> {
  mkdirSync(spec.dir, { recursive: true })
  const unknown = { path: spec.dest, dropped: 0, cleaned: 0, fromLegacyCache: true }
  if (existsSync(spec.dest)) {
    if (!existsSync(spec.meta)) return unknown
    try {
      const m = JSON.parse(readFileSync(spec.meta, 'utf8')) as Partial<SliceRescrub>
      return { path: spec.dest, dropped: num(m.dropped), cleaned: num(m.cleaned), fromLegacyCache: false }
    } catch {
      return unknown
    }
  }
  const res = await c.s3.send(new GetObjectCommand({ Bucket: c.stack.bucket_name, Key: spec.key }))
  if (!res.Body) throw new Error(`S3 returned no body for ${spec.key}`)
  const gz = Buffer.from(await res.Body.transformToByteArray())
  const out = clean(gunzipSync(gz).toString('utf8'))
  const dropped = num(out.dropped)
  writeFileSync(spec.dest, out.text)
  writeFileSync(spec.meta, `${JSON.stringify({ dropped, cleaned: out.cleaned })}\n`)
  return { path: spec.dest, dropped, cleaned: out.cleaned, fromLegacyCache: false }
}

/** A slice, RE-SCRUBBED ON READ, at .triage/slices/<reportId>.log. Gitignored twice over
 *  (`.triage/` and the blanket `*.log`); its contents never reach a public issue. */
export function downloadSlice(c: Clients, reportId: string, key: string): Promise<SliceRescrub> {
  const dest = join(SLICE_DIR, `${reportId}.log`)
  const meta = join(SLICE_DIR, `${reportId}.rescrub.json`)
  return downloadAttachment(c, { dir: SLICE_DIR, dest, meta, key }, rescrubSlice)
}

/**
 * An inventory dump, SANITIZED ON READ, at .triage/inventory/<reportId>.txt (JOS-296).
 *
 * `downloadSlice`'s twin, and the difference is deliberate: it does NOT run the log scrubber.
 * `sanitizeInventory` (./rows.ts) carries the argument — the dump has no chat in it to drop, and
 * a drop list over a table of item names could only ever destroy evidence. The returned shape
 * therefore has no `dropped`: reporting a zero for a measurement nobody takes would invite a
 * reader to conclude the scrubber ran and found nothing.
 */
export async function downloadInventory(
  c: Clients,
  reportId: string,
  key: string
): Promise<InventoryDownload> {
  const dest = join(INVENTORY_DIR, `${reportId}.txt`)
  const meta = join(INVENTORY_DIR, `${reportId}.sanitize.json`)
  const dl = await downloadAttachment(c, { dir: INVENTORY_DIR, dest, meta, key }, sanitizeInventory)
  return { path: dl.path, cleaned: dl.cleaned, fromLegacyCache: dl.fromLegacyCache }
}

/**
 * An achievements dump, sanitized on read, at .triage/achievements/<reportId>.txt (JOS-441).
 *
 * The same shape and the same refusal to scrub, on this file's own sweep
 * (src/main/feedback/achievements.ts). Its own directory so `ls .triage/achievements` answers
 * "which reports carried one" — which, for the ticket this was built for, is the question.
 */
export async function downloadAchievements(
  c: Clients,
  reportId: string,
  key: string
): Promise<InventoryDownload> {
  const dest = join(ACHIEVEMENTS_DIR, `${reportId}.txt`)
  const meta = join(ACHIEVEMENTS_DIR, `${reportId}.sanitize.json`)
  const dl = await downloadAttachment(
    c,
    { dir: ACHIEVEMENTS_DIR, dest, meta, key },
    sanitizeAchievements
  )
  return { path: dl.path, cleaned: dl.cleaned, fromLegacyCache: dl.fromLegacyCache }
}

/** Delete ONE attachment object. Named for the slice historically; it takes any key, and
 *  `attachmentKeysOf` is what makes sure every one of a report's objects is passed to it. */
export async function deleteSlice(c: Clients, key: string): Promise<void> {
  await c.s3.send(new DeleteObjectCommand({ Bucket: c.stack.bucket_name, Key: key }))
}

// ---- what `show` says about a report's attachments ------------------------------------

/** One attachment leg's answer: the line to print, plus any verdict that has to be LOUD. */
export interface AttachmentReport {
  line: string
  warnings: string[]
}

/** Fetch one leg and describe it. `declared but never landed` is a REAL outcome — the row says
 *  an attachment exists and the HeadObject says the upload failed or expired. */
async function reportOne(
  c: Clients,
  label: string,
  key: string,
  read: () => Promise<{ path: string; notes: string[] }>
): Promise<AttachmentReport> {
  if (!(await logObjectExists(c, key))) {
    return { line: `[${label}: declared but never landed — the upload failed or expired]`, warnings: [] }
  }
  const got = await read()
  return { line: `[${label}: ${got.path}]`, warnings: got.notes }
}

/**
 * Every attachment a report owns, downloaded and described — what `triage-feedback show` prints
 * under the row (JOS-296).
 *
 * IT RETURNS LINES RATHER THAN PRINTING THEM, so the console stays the CLI's and this stays
 * testable. The two legs run INDEPENDENTLY and in order: a report can easily carry one and not
 * the other, and an early exit on the slice must never swallow the dump.
 */
export async function attachmentReports(
  c: Clients,
  reportId: string,
  row: Row
): Promise<AttachmentReport[]> {
  const out: AttachmentReport[] = []
  const logKey = logKeyOf(row)
  if (logKey !== null) {
    out.push(
      await reportOne(c, 'log slice', logKey, async () => {
        const slice = await downloadSlice(c, reportId, logKey)
        return { path: slice.path, notes: rescrubNotes(slice) }
      })
    )
  }
  const invKey = inventoryKeyOf(row)
  if (invKey !== null) {
    out.push(
      await reportOne(c, 'inventory export', invKey, async () => {
        const dump = await downloadInventory(c, reportId, invKey)
        return { path: dump.path, notes: inventoryNotes(dump) }
      })
    )
  }
  const achKey = achievementsKeyOf(row)
  if (achKey !== null) {
    out.push(
      await reportOne(c, 'achievements export', achKey, async () => {
        const dump = await downloadAchievements(c, reportId, achKey)
        return { path: dump.path, notes: achievementsNotes(dump) }
      })
    )
  }
  return out
}
