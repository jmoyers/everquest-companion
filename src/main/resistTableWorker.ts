// resistTableWorker.ts — read and parse the client's `spells_us.txt` OFF the main thread
// (JOS-382). Keep it this small.
//
// WHY A WHOLE THREAD. The file is 38 MB and 73,963 rows; reading and splitting it is a few
// hundred milliseconds of pure CPU with no await inside it, and the thread that would otherwise
// spend them is the one tailing the log (JOS-371: no synchronous multi-MB reads on main). It runs
// ONCE per app launch, and only when the cache says the file changed — see `resist/spellTable.ts`
// for the size+mtime key, which is JOS-208's rule applied to somebody else's file: only redo work
// when the source moved.
//
// It speaks exactly once and exits. `latin1` rather than `utf8` because the file is a fixed-width
// legacy dump with high bytes in a handful of names; latin1 never throws and never replaces a
// byte, and every field this parser reads is ASCII.

import { readFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { parseSpellsUs } from './resist/spellsUsParse'
import type { SpellResistTable } from '../shared/resistTypes'

export interface ResistTableWorkerInit {
  path: string
}

export interface ResistTableWorkerReply {
  ok: boolean
  table?: SpellResistTable
  error?: string
}

const init = workerData as ResistTableWorkerInit
const port = parentPort

let reply: ResistTableWorkerReply
try {
  const table = parseSpellsUs(readFileSync(init.path, 'latin1'))
  reply = { ok: true, table }
} catch (err) {
  reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
}
port?.postMessage(reply)
