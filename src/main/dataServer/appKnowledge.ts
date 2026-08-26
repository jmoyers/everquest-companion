// ============================================================================
// appKnowledge.ts — THE FIVE THINGS THE FOLD KNOWS THAT THE LOG NEVER SAID (JOS-482).
// ============================================================================
//
// Boundary verdict 3, read off the store. The five preferences the fold consumes — alert
// definitions, the buff-trust allowlist, the respawn watch list, class-combo corrections and
// group-roster edits — stay STORE-OWNED app-side; the engine never reads a settings file, and each
// of them is pushed in as a `*.define` command when the app connects and whenever the user changes
// one. `definePush.ts` is the announcement seam; this file is the reading.
//
// ── WHY THE READERS LIVE HERE AND NOT AT THE CALL SITES ────────────────────────────────────────
//
// A define is a FULL-SET REPLACE, so what has to be pushed is "everything this family knows right
// now" — which is a question the STORE answers, not the ipc handler that just wrote to it. Reading
// it here means the engine is handed what was PERSISTED rather than what a renderer sent, so a
// value the store's own normalizer repaired cannot reach the engine unrepaired. It also means a
// setter's push is one line with no payload to thread, and that a push made for any other reason —
// a fresh connection, a respawned engine — reads the identical thing.
//
// TWO OF THE FIVE ARE CHARACTER-SCOPED (`combo`, `roster`) and read through `activeCharId()`, which
// is the same door `ipc/combo.ts` and `ipc/roster.ts` install their own providers behind. Over
// there those two are PULLED — the module re-asks its provider on every read, so a character switch
// needs no notification at all. The engine has no store to ask, so the push replaces the pull: the
// world re-applies whatever it was last told at every attach, and a switch is one push rather than
// a reconciliation.

import { getAlerts, getBuffTrustPrefs, getComboCorrections, getRosterEdits } from '../store'
import { getRespawnPrefs } from '../storeRespawn'
import { activeCharId } from '../session'
import type { DefineOp, DefineParams } from './definePush'

/**
 * What this app currently knows for one family, as the command's params.
 *
 * THE CASTS ARE THE `AlertDefinition` RULING, PAID FOR ONCE AND ONLY THERE. That protocol type
 * states nothing about a def's shape — the field set is the STORE's contract, and a definition
 * round-trips through the fold as the alerts module's published `defs`, so a typed wire shape that
 * dropped an unlisted field would rewrite the user's alerts in transit
 * (protocol/schema/messages.schema.json argues it at length). An open object is what the schema
 * therefore generates, and a TypeScript INTERFACE is not assignable to one however identical its
 * values are. Every other family is typed on both sides and the cast is only the generic's, which
 * TypeScript cannot see through — the values are already exactly the shapes the schema names.
 */
export function readDefine<O extends DefineOp>(op: O): DefineParams<O> {
  switch (op) {
    case 'alerts.define':
      return { defs: getAlerts() } as unknown as DefineParams<O>
    case 'buffTrust.define':
      return { trust: getBuffTrustPrefs() } as unknown as DefineParams<O>
    case 'respawn.define':
      return { prefs: getRespawnPrefs() } as unknown as DefineParams<O>
    case 'combo.define':
      return { corrections: getComboCorrections(activeCharId()) } as unknown as DefineParams<O>
    default:
      return { edits: getRosterEdits(activeCharId()) } as unknown as DefineParams<O>
  }
}
