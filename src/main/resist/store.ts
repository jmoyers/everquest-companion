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

import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError } from '../errorLog'
import { BASELINE_SOURCE_KEY, type ResistLedger, type ResistRow } from '../../shared/resistTypes'
import { ResistLedgerStore, type ResistBucket } from './ledger'
import type { ResistLedgerSeam } from './module'
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

interface UserLedgerFile {
  version: number
  sources: { key: string; rows: ResistRow[] }[]
}

/** The committed baseline, typed. Read-only, re-seeded from the bundle on every launch. */
export function baselineLedger(): ResistLedger {
  return baselineJson as unknown as ResistLedger
}

function userLedgerPath(): string {
  return join(app.getPath('userData'), 'resist-ledger.json')
}

function loadUserSources(): UserLedgerFile['sources'] {
  try {
    const file = JSON.parse(readFileSync(userLedgerPath(), 'utf8')) as UserLedgerFile
    if (file.version !== RESIST_LEDGER_VERSION || !Array.isArray(file.sources)) return []
    return file.sources.filter((s) => s.key !== BASELINE_SOURCE_KEY && Array.isArray(s.rows))
  } catch {
    return []
  }
}

/**
 * Persist the user's buckets. Temp file plus rename, because a torn ledger would be a permanently
 * wrong answer rather than a missing one, and rename is atomic within a directory. The shipped
 * baseline's bucket is never written.
 */
function saveUserSources(store: ResistLedgerStore): void {
  const sources = store
    .toLedger()
    .sources.filter((s) => s.key !== BASELINE_SOURCE_KEY && s.rows.length > 0)
  const path = userLedgerPath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ version: RESIST_LEDGER_VERSION, sources }), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    logError('main:resistLedger', { message: 'resist-ledger.json write failed', err })
  }
}

let store: ResistLedgerStore | null = null

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

/** Snapshot the user's half to disk. Cheap enough for a periodic call; best-effort. */
export function persistResistLedger(): void {
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

/** Test seam: forget the seeded store so the next call re-reads. */
export function resetResistLedgerForTests(): void {
  store = null
}
