// Where the resist ledger lives: the shipped baseline, plus this user's own logs (JOS-382).
//
// TWO SOURCES, MERGED AT READ, AND ONLY ONE OF THEM IS EVER WRITTEN — the same arrangement as the
// observed-message overlay:
//
//   1. THE COMMITTED BASELINE — `resistBaseline.json`, mined by `scripts/gen-resist-baseline.ts`
//      and IMPORTED so electron-vite inlines it into the main bundle. A path-relative read would
//      miss in `out/main/` (the note in spellDb.ts). It is re-seeded from the bundle every launch
//      and never written back: copying 700 kB of it into userData would only create a second,
//      staler copy.
//   2. THIS USER'S OWN LOGS — `<userData>/resist-ledger.json`, one bucket per character,
//      accreting. A bucket for a character you are NOT folding this run is knowledge nothing can
//      re-derive, so it is seeded and left alone; the character you ARE folding has its bucket
//      DISCARDED before the fold starts (JOS-231), which is what makes re-reading the same log
//      every launch a no-op instead of a doubling.
//
// The file is a REGISTER: counts filed under the source that produced them, no verdicts. Every R,
// every interval and every "nearly immune" is derived on demand in `profile.ts`.
//
// AND THE FILE HALF IS NOT HERE (JOS-419). Everything about surviving a full disk or a torn read —
// the durable write, the backoff after a failure, the once-per-session report, the salvage that
// keeps the corrupt bytes beside themselves — lives in `ledgerFile.ts`, which imports no Electron
// and is therefore drivable by a node test. This module is the part that knows the paths and owns
// the logger: it decides WHAT to write and what a failure is worth saying, never how.

import { app } from 'electron'
import { join } from 'node:path'
import { logError, logInfo } from '../errorLog'
import { BASELINE_SOURCE_KEY, type ResistLedger } from '../../shared/resistTypes'
import { ResistLedgerStore, type ResistBucket } from './ledger'
import {
  createLedgerWriter,
  loadUserLedgerFile,
  type LedgerSource,
  type LedgerWriteOutcome
} from './ledgerFile'
/**
 * THE SEAM, DECLARED WHERE IT IS BUILT (JOS-499). It lived in `resist/module.ts` — the fold plug —
 * so that nothing under `src/main/modules` had to import Electron. There is no fold and no plug;
 * the only thing that ever produced one of these is `resistLedgerSeam()` below, and the only
 * thing that consumed it was the deleted module. It is kept rather than inlined because the
 * ENGINE owns this ledger's IO now (boundary verdict 4) and this seam is what the app-arm
 * writers are still shaped around; `artifactOwner.ts` gates whether they run at all.
 */
export interface ResistLedgerSeam {
  beginSource: (key: string) => void
  persist: () => void
  counts: () => { rows: number; mobs: number }
}
import { appOwnsArtifacts } from '../dataServer/artifactOwner'
// Inlined committed baseline (bundled into the main build, like spells.json).
import baselineJson from '../data/resistBaseline.json'

/**
 * Bump to invalidate every user ledger in the field. The baseline carries its own schema.
 *
 * VERSION 2 (JOS-397): rows carry the ISO week they were observed in. A version-1 row pooled its
 * counts ACROSS weeks and no migration can un-pool them — the honest upgrade is the re-fold this app
 * does from the log on every launch.
 *
 * VERSION 3 (JOS-400) IS A DELETION, and it is a bump precisely because the thing deleted was ON
 * DISK. Version 2 also wrote the run detector's per-(mob, spell) outcome rings beside the rows; the
 * detector is gone, nothing reads a ring any more, and a field ledger written by version 2 would
 * otherwise keep carrying kilobytes of them forward forever. Rows are unaffected in shape — they are
 * simply re-folded from the log, as they are on every launch.
 */
export const RESIST_LEDGER_VERSION = 3

/** The committed baseline, typed. Read-only, re-seeded from the bundle on every launch. */
export function baselineLedger(): ResistLedger {
  return baselineJson as unknown as ResistLedger
}

function userLedgerPath(): string {
  return join(app.getPath('userData'), 'resist-ledger.json')
}

/**
 * The user's buckets, and a line in `errors.log` when the file was anything other than ordinary.
 * A torn file is salvaged and PRESERVED beside itself rather than lost — `ledgerFile.ts` holds the
 * mechanics and the argument; this is the half that knows where the log is.
 */
function loadUserSources(): LedgerSource[] {
  const load = loadUserLedgerFile(userLedgerPath(), RESIST_LEDGER_VERSION)
  if (load.notice !== undefined) logError('main:resistLedger', { message: load.notice })
  return load.sources
}

/**
 * Persist the user's buckets. Durable (temp + flush + rename, and no scratch file left behind on a
 * failure), coalesced (identical bytes are not rewritten), and QUIET ON A FULL DISK: the first
 * failure of a session is reported, every later one only paces the backoff, and the module carries
 * on folding either way. The shipped baseline's bucket is never written.
 */
function saveUserSources(store: ResistLedgerStore): void {
  const sources = store
    .toLedger()
    .sources.filter((s) => s.key !== BASELINE_SOURCE_KEY && s.rows.length > 0)
  const dir = app.getPath('userData')
  // OFF THE MAIN THREAD (JOS-371). This runs on the resist module's tick for as long as the app is
  // open, and it used to stop the main process for a write AND an fsync every time. The write is
  // the same temp+fsync+rename in the same order (ledgerFile.ts's header is untouched by this) —
  // only the thread changed, and the writer's own `busy` latch is what keeps two of them out of one
  // scratch file now that two really can overlap. The outcome is reported when it settles; nothing
  // waits for it, because nothing ever read the return value.
  void writer
    .writeAsync(dir, userLedgerPath(), JSON.stringify({ version: RESIST_LEDGER_VERSION, sources }))
    .then(reportWriteOutcome)
}

/** What a settled ledger write is worth saying, and to which sink. Unchanged from the synchronous
 *  version, character for character — see the fingerprint note below. */
function reportWriteOutcome(out: LedgerWriteOutcome): void {
  if (out.status === 'written') {
    if (out.recovered === true) logInfo('[everquest-companion] resist-ledger.json is writable again; the ledger was persisted')
    return
  }
  if (out.status !== 'failed') return
  // THE PAYLOAD IS BYTE-IDENTICAL TO THE ONE 1.5.0 FILED (fingerprint f491e2052171562f): the error
  // store aggregates on the message plus the frames, so keeping this string exact keeps the fix's
  // occurrences aggregating with the ones that motivated it instead of splitting the family in two.
  // Everything that varies per occurrence — the pause, the count — goes to the console.
  if (out.report === true) logError('main:resistLedger', { message: 'resist-ledger.json write failed', err: out.err })
  logInfo(
    `[everquest-companion] resist-ledger.json is unwritable; pausing the ledger's writes for ${Math.round((out.delayMs ?? 0) / 1000)}s`
  )
}

let store: ResistLedgerStore | null = null

/** THE ONE WRITER'S FAILURE STATE. Module-level for the same reason `store` is: one file, one
 *  process writing it. */
const writer = createLedgerWriter()

/** The merged ledger, seeded once per app run. */
export function resistLedger(): ResistLedgerStore {
  const existing = store
  if (existing) return existing
  const created = new ResistLedgerStore()
  created.seed(baselineLedger())
  for (const src of loadUserSources()) created.bucket(src.key).seed(src.rows)
  store = created
  return created
}

/** Discard this character's bucket and hand it back for the fold to write into. */
export function beginResistSource(key: string): ResistBucket {
  return resistLedger().beginSource(key)
}

/**
 * Snapshot the user's half to disk. Cheap enough for a periodic call; best-effort.
 *
 * …UNLESS THE ENGINE OWNS THIS FILE (JOS-497 item 2, boundary verdict 4). Under serve, `stateDir`
 * has been handed to a connected engine that reads and writes `resist-ledger.json` itself, in this
 * app's byte-verbatim format — so this process persisting too would be two writers on one file with
 * two cadences, which is the exact thing JOS-496 declined to ship. The guard is HERE rather than at
 * the caller (`module.ts`'s sixty-tick persist) so that no future call site can escape it by not
 * knowing about it; `dataServer/artifactOwner.ts` is the latch and carries the whole argument.
 *
 * THE FOLD IS UNTOUCHED. This app keeps folding its own ledger in memory — the parity probe
 * compares the two worlds and the resist card's rows are still read out of it — and what stops is
 * only the WRITE. On every launch with no engine, and with `EQC_ENGINE_SERVE=0`, this is exactly
 * the function it has always been.
 */
export function persistResistLedger(): void {
  if (!appOwnsArtifacts()) return
  if (store) saveUserSources(store)
}

/** When the shipped data was mined, for the UI's "differs from shipped data" wording. */
export function baselineFrozenAt(): string | null {
  return baselineLedger().frozenAt ?? null
}

/**
 * The seam the resist MODULE folds into. It exists so nothing under `src/main/modules` has to
 * import Electron: `createModules()` is constructed under plain node by the replay bench and by
 * tests/foldDeterminism.test.mts, and one `app.getPath` in that graph takes both down.
 */
export function resistLedgerSeam(): ResistLedgerSeam {
  return {
    beginSource: (key) => beginResistSource(key),
    persist: () => {
      persistResistLedger()
    },
    counts: () => {
      const ledger = resistLedger()
      let rows = 0
      for (const src of ledger.toLedger().sources) rows += src.rows.length
      return { rows, mobs: ledger.mobKeys().size }
    }
  }
}

/** Test seam: forget the seeded store so the next call re-reads — and the writer's pause,
 *  fingerprint and once-per-session report with it, or a second test would inherit the first's. */
export function resetResistLedgerForTests(): void {
  store = null
  writer.reset()
}
