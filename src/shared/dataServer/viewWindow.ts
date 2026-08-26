// ONE SUBSCRIPTION'S WINDOW, and the ops that move it (JOS-468).
//
// This is the mechanical half of the client's NO-MUNGING LAW — the argument for it is in
// `client.ts`'s header, and this file is where it either holds or does not. Everything here is
// pure: a window in, a frame's ops, a new window out. Nothing sorts, filters, aggregates or
// re-keys; the engine already did all of that and sent rows that are ready for a pixel.
//
// THE THREE OPS, applied strictly IN ORDER, so a later op may anchor on what an earlier one did:
//
//   insert — lands immediately BEFORE or AFTER the anchor row it names, wherever that row happens
//            to be. Neither anchor present means the window was empty.
//   update — merges the cells it CARRIES. A cell it does not mention is unchanged; a cell it sets
//            to null is null (stored, not deleted, so a cleared cell stays distinguishable from a
//            cell the view never had).
//   drop   — removes one row by key. The row may still exist in the VIEW; a newest-first window
//            pushes its oldest row out on every insert.
//
// AN OP THAT CANNOT BE APPLIED AS SENT IS REFUSED, NOT GUESSED AT: an anchor the window does not
// hold, a key it does not hold, a key it already holds. Each refusal writes one debug note and the
// rest of the batch still applies. Nothing here throws — a stream is not a place to raise, and the
// next reset is the repair.

import type { Cells, DiffOp, Epoch, InsertOp, Row } from './protocol.generated'
import type { EngineError } from './ops'

/**
 * One subscription's window, materialized. `rows` is null exactly while no window state is held —
 * before the first reset, and after an epoch bump dropped one — which is the same condition
 * `loading` reports; both are kept because the first is the mechanism and the second is the intent.
 * `error` rides here rather than in a channel of its own so a view has ONE thing to render from.
 */
export interface ViewState {
  readonly rows: readonly Row[] | null
  readonly total: number
  readonly epoch: Epoch | null
  readonly loading: boolean
  readonly error: EngineError | null
}

/** The one state a window has when it holds nothing at all. */
export const LOADING: ViewState = { rows: null, total: 0, epoch: null, loading: true, error: null }

/** Where a debug note goes. Never a `console`: this module is bundled into the renderer too. */
export type Debug = (note: string) => void

function indexOfKey(rows: readonly Row[], key: string): number {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].key === key) return i
  }
  return -1
}

function applyInsert(rows: Row[], op: InsertOp, debug: Debug): void {
  const row = op.row
  if (indexOfKey(rows, row.key) >= 0) {
    debug(`insert of ${row.key}, which the window already holds - dropped`)
    return
  }
  const anchor = op.before ?? op.after
  if (anchor === undefined) {
    rows.push(row)
    return
  }
  const at = indexOfKey(rows, anchor)
  if (at < 0) {
    debug(`insert of ${row.key} anchored on ${anchor}, which is not in the window - dropped`)
    return
  }
  rows.splice(op.before === undefined ? at + 1 : at, 0, row)
}

function applyUpdate(rows: Row[], key: string, cells: Cells, debug: Debug): void {
  const at = indexOfKey(rows, key)
  if (at < 0) {
    debug(`update of ${key}, which is not in the window - dropped`)
    return
  }
  // A NEW row object, never a mutation: a React consumer compares identities to know what moved.
  rows[at] = { key, cells: { ...rows[at].cells, ...cells } }
}

function applyDrop(rows: Row[], key: string, debug: Debug): void {
  const at = indexOfKey(rows, key)
  if (at < 0) {
    debug(`drop of ${key}, which is not in the window - dropped`)
    return
  }
  rows.splice(at, 1)
}

/**
 * Apply one frame's ops to the window it describes, and hand back a NEW array. The rows that did
 * not change keep their identity; the ones that did get a fresh object. Neither the array nor any
 * row a listener was already handed is touched.
 */
export function applyDiff(held: readonly Row[], ops: readonly DiffOp[], debug: Debug): Row[] {
  const rows = held.slice()
  for (const op of ops) {
    if (op.op === 'insert') applyInsert(rows, op, debug)
    else if (op.op === 'update') applyUpdate(rows, op.key, op.cells, debug)
    else applyDrop(rows, op.key, debug)
  }
  return rows
}
