// resist/ledgerFile.ts — `resist-ledger.json` on disk: read it when it is torn, and write it when
// the volume is refusing writes. The half of `store.ts` that has no Electron in it, split out for
// exactly the reason `telemetry/durableWrite.ts` was (JOS-265): a full disk and a half-written file
// are not states a test may arrange through `app.getPath`, so they are arranged here instead
// (`tests/resistLedgerDurability.test.mts`).
//
// WHAT THE EVIDENCE SAID (JOS-419). Fingerprint f491e2052171562f, five occurrences on 1.5.0 from one
// install: `resist-ledger.json write failed`, `code=ENOSPC`, `saveUserSources` under the resist
// module's tick. The same volume-is-full shape the telemetry ring filed ~350 times across 0.18-0.23,
// on a file this app had just started writing — so the fix is the one this repo already worked out
// and tested, applied to the second writer rather than re-invented for it.
//
// FOUR THINGS THE 1.5.0 WRITER DID NOT DO, each pinned by the suite:
//
//   1. FLUSH BEFORE THE RENAME. The write was already temp+rename, which is why no torn ledger has
//      actually been filed yet — but renaming a file whose bytes are still only in the page cache is
//      how an "atomic" write ends up truncated anyway after an unclean shutdown, and a machine with
//      a full disk is a machine having a bad day. `writeFileDurable` is the one answer to this in
//      the repo and it is reused, never re-spelled.
//   2. TAKE THE SCRATCH FILE BACK. A failed write left `resist-ledger.json.tmp` holding a whole
//      user ledger on the volume that had just said it had no room.
//   3. STOP TRYING. Every tick re-ran the doomed write and re-filed the same failure. The gate is
//      the telemetry ring's: after a failure the writer leaves the disk alone for a spell that
//      doubles up to fifteen minutes, and one success clears it. The MODULE NEVER LEARNS ABOUT IT —
//      memory is the ledger's truth, and every reader (`profile.ts`, the mob card, the next fold)
//      comes through the in-memory store, so a paused write costs a snapshot and never an
//      observation. The next launch re-folds the log regardless.
//   4. SAY IT ONCE. `report` goes true for the FIRST failure of a session and never again, which is
//      the ticket's ruling: five occurrences from one install is four too many, and each one also
//      appends to `errors.log` on the same full disk.
//
// AND ONE THING IT DID NOT NEED TO DO UNTIL NOW: coalesce. The ledger is snapshot once a minute
// whether or not anything changed, so an app left open at the character select rewrote hundreds of
// kilobytes an hour to say the same thing. `write()` fingerprints what it wrote and declines an
// identical rewrite — which on a failing volume also means the retry ladder is climbed by CHANGES
// rather than by ticks.
//
// THE READ HALF IS THE STORE-SCHEMA SALVAGE PRECEDENT (JOS-272), one granularity coarser. A ledger
// that does not parse is PRESERVED beside itself as `resist-ledger.corrupt.json` — never deleted,
// never silently replaced by an empty one — and then read for whatever WHOLE per-character buckets
// survive. A bucket is the right unit: they are independent, each one is re-derivable by re-folding
// that character's log, and a HALF bucket would be an under-count that looks exactly like a fact.
// Nothing here ever closes an unbalanced bracket to make a truncated file parse.

import { readFileSync, renameSync } from 'node:fs'
import { createWriteGate, nodeIo, writeFileDurable, type DurableIo } from '../telemetry/durableWrite'
import { balancedObjectSequence, parseIf, quarantinePathFor, salvageJsonObject, stripTornPadding } from '../tornJson'
import { BASELINE_SOURCE_KEY, type ResistRow } from '../../shared/resistTypes'

/** One character's bucket as it sits in the file. */
export interface LedgerSource {
  key: string
  rows: ResistRow[]
}

/** The file itself: a version stamp and the user's buckets. The shipped baseline is never in it. */
export interface UserLedgerFile {
  version: number
  sources: LedgerSource[]
}

// ------------------------------------------------------------------------------- reading

/** A bucket we are willing to seed from: our shape, and not a stale copy of the shipped baseline
 *  (which is re-seeded from the bundle every launch and would otherwise be counted twice). */
function isLedgerSource(v: unknown): v is LedgerSource {
  if (typeof v !== 'object' || v === null) return false
  const src = v as Partial<LedgerSource>
  return typeof src.key === 'string' && src.key !== BASELINE_SOURCE_KEY && Array.isArray(src.rows)
}

/** Is this our file at all? The VERSION gate is separate on purpose — see `usableSources`. */
function isLedgerFile(v: unknown): v is UserLedgerFile {
  if (typeof v !== 'object' || v === null) return false
  const file = v as Partial<UserLedgerFile>
  return typeof file.version === 'number' && Array.isArray(file.sources)
}

/**
 * The buckets this build may seed from. A ledger of any other version is DISCARDED, not migrated —
 * `ResistLedgerStore.seed`'s rule, for its reasons: the honest upgrade is the re-fold this app
 * performs from the log on every launch anyway.
 */
function usableSources(file: UserLedgerFile, version: number): LedgerSource[] {
  if (file.version !== version) return []
  return file.sources.filter(isLedgerSource)
}

/** What a load found, and anything about it worth a line in `errors.log`. */
export interface LedgerLoad {
  sources: LedgerSource[]
  /** Where an unparseable file was kept. Absent ⇒ nothing was moved aside. */
  quarantinedPath?: string
  /** One sentence for the log. Absent ⇒ an ordinary read, and nothing to say. */
  notice?: string
}

/** How every failure path here names a thrown value. One spelling for every step. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * THE TRUNCATION SALVAGE, and the only place this file reads the raw text structurally.
 *
 * A file that stops mid-way has no closing bracket anywhere, so no whole-object scan can help it.
 * What it does still contain is a run of COMPLETE `{"key":…,"rows":[…]}` elements at the head of the
 * `sources` array, and each of those is one character's whole bucket. They are harvested up to the
 * first element that does not close, and everything from there on is dropped.
 *
 * The version is read off the head with a pattern rather than a parser because there is no valid
 * JSON left to parse it out of; `JSON.stringify({version, sources})` puts it first, and a file whose
 * version cannot be found is treated as one that fails the gate.
 */
function salvageTruncated(text: string, version: number): LedgerSource[] {
  const head = text.slice(0, Math.max(0, text.indexOf('"sources"')))
  const stamp = /"version"\s*:\s*(\d+)/.exec(head)
  if (!stamp || Number(stamp[1]) !== version) return []
  const open = text.indexOf('[', text.indexOf('"sources"'))
  if (open < 0) return []
  const out: LedgerSource[] = []
  for (const element of balancedObjectSequence(text.slice(open + 1))) {
    const src = parseIf(element, isLedgerSource)
    if (src !== undefined) out.push(src)
  }
  return out
}

/** Everything recoverable from bytes that would not parse, and the sentence describing it. */
function salvageLedger(raw: string, version: number): { sources: LedgerSource[]; detail: string } {
  const whole = salvageJsonObject(raw, isLedgerFile)
  if (whole !== undefined) {
    const sources = usableSources(whole.value, version)
    const residue = whole.residue > 0 ? `, ${whole.residue} stale trailing bytes discarded` : ''
    return { sources, detail: `salvaged ${sources.length} character buckets out of the torn file${residue}` }
  }
  const partial = salvageTruncated(stripTornPadding(raw), version)
  if (partial.length > 0) {
    return { sources: partial, detail: `salvaged the first ${partial.length} whole character buckets of a truncated file` }
  }
  return { sources: [], detail: 'nothing whole could be recovered, starting empty' }
}

/** Move the unreadable file aside, KEEPING it. Answers where it went, or why it could not go. */
function preserve(path: string): { at?: string; why?: string } {
  const at = quarantinePathFor(path)
  try {
    renameSync(path, at)
    return { at }
  } catch (err) {
    return { why: errText(err) }
  }
}

/**
 * Read the user's half of the ledger. NEVER THROWS: every outcome — missing, unreadable, foreign,
 * stale, torn — is a supported state that answers with buckets (possibly none) and a notice.
 */
export function loadUserLedgerFile(path: string, version: number): LedgerLoad {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sources: [] }
    return { sources: [], notice: `resist-ledger.json could not be read (${errText(err)}); starting empty` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The ONLY path that quarantines. A file that parses is a file this app can safely overwrite on
    // the next snapshot; a file that does not is evidence, and evidence is kept.
    const salvage = salvageLedger(raw, version)
    const kept = preserve(path)
    const where = kept.at === undefined ? `it could not be moved aside (${kept.why ?? 'unknown'})` : `moved to ${kept.at}`
    const load: LedgerLoad = { sources: salvage.sources, notice: `resist-ledger.json is not valid JSON, ${salvage.detail} - ${where}` }
    if (kept.at !== undefined) load.quarantinedPath = kept.at
    return load
  }
  // Parsed, but not ours (or not this version): start empty and let the next snapshot replace it.
  // Silent, exactly as before — a version bump is a planned discard, not an incident.
  return { sources: isLedgerFile(parsed) ? usableSources(parsed, version) : [] }
}

// ------------------------------------------------------------------------------- writing

/**
 * FNV-1a over the serialized ledger, paired with its length. The pair is what "has anything changed
 * since the last successful write" is decided on, because holding the previous JSON to compare
 * against would double the file's footprint in memory for a question a 32-bit answer settles.
 *
 * A collision would skip ONE snapshot of changed counts. It costs nothing durable: the in-memory
 * ledger is unaffected, the next change writes, and the current character's bucket is re-derived
 * from the log on the next launch regardless.
 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`
}

/** What one `write()` did. `status` is the whole answer; the rest is what the caller logs. */
export interface LedgerWriteOutcome {
  /** `written` — it landed. `unchanged` — identical bytes, nothing to do. `paused` — the gate is
   *  serving out a backoff. `busy` — a write is already running on this writer. `failed` — the disk
   *  said no. */
  status: 'written' | 'unchanged' | 'paused' | 'busy' | 'failed'
  /** `failed` only: what was thrown. */
  err?: unknown
  /** `failed` only: how long the writer will now leave the disk alone. */
  delayMs?: number
  /** `failed` only, and TRUE AT MOST ONCE PER SESSION: this failure is the one worth reporting. */
  report?: boolean
  /** `written` only: this write ended a pause, so the recovery is worth saying once. */
  recovered?: boolean
}

export interface LedgerWriter {
  write(dir: string, path: string, json: string, now?: number): LedgerWriteOutcome
  /** Forget the pause, the fingerprint and the once-per-session report. For tests and for a reset. */
  reset(): void
}

/**
 * ONE WRITER, one failure state, one fingerprint. A closure rather than module state so the store
 * owns exactly one and a test can own a dozen — `createWriteGate`'s own arrangement, for the same
 * reason.
 */
export function createLedgerWriter(io: DurableIo = nodeIo): LedgerWriter {
  const gate = createWriteGate()
  let lastWritten: string | null = null
  let reported = false
  // SERIALISATION, structurally rather than hopefully. Every call below is synchronous on the main
  // process's one thread, so today nothing CAN re-enter; the guard is here so that a future caller
  // reaching this from inside a failure path (an error hook, a shutdown handler) coalesces into the
  // write already in flight instead of racing its temp file.
  let writing = false

  return {
    write(dir, path, json, now = Date.now()) {
      if (writing) return { status: 'busy' }
      const stamp = fingerprint(json)
      if (stamp === lastWritten) return { status: 'unchanged' }
      if (!gate.ready(now)) return { status: 'paused' }
      writing = true
      try {
        writeFileDurable(dir, path, json, io)
        lastWritten = stamp
        return { status: 'written', recovered: gate.succeeded() }
      } catch (err) {
        const { delayMs } = gate.failed(now)
        const report = !reported
        reported = true
        return { status: 'failed', err, delayMs, report }
      } finally {
        writing = false
      }
    },
    reset() {
      gate.reset()
      lastWritten = null
      reported = false
      writing = false
    }
  }
}
