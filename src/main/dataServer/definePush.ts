// ============================================================================
// definePush.ts — THE SLOT A PREFERENCE WRITE SPEAKS THROUGH (JOS-482).
// ============================================================================
//
// Five ipc setters need to say "this family moved" and one file needs to hear it. This is the
// whole of what sits between them: a list of the five commands, a registration, and a call.
//
// IT IMPORTS NOTHING AT RUNTIME, and that is the reason it is its own file rather than the top half
// of `appKnowledge.ts`. Two of them:
//
//   * THE DEPENDENCY. `pipeline.ts setWorldRebuiltObserver`'s argument, applied one layer out: an
//     ipc setter must be able to announce a preference write without importing the engine client,
//     which imports the supervisor, which imports the child-process plumbing. A registration
//     inverts that; an import would be a cycle at module-evaluation time.
//   * THE TEST. `appKnowledge.ts` reads the SETTINGS STORE, which is `electron-store`, which no
//     node unit suite can load. The decision this file holds — who is told, when, and what happens
//     when nobody is listening — is the half worth pinning, and keeping it store-free is what makes
//     it pinnable (tests/dataServerDefines.test.mts).
//
// NOTHING HERE READS `EQC_ENGINE`. The gate is the composition root's: `engineHost.ts` calls
// `installEngineClient` only under the flag, and that is what fills the slot. A launch that asked
// for no engine therefore pays exactly one null check per preference write.

import type { ClientMessage } from '../../shared/dataServer/protocol.generated'

/**
 * THE FIVE FAMILIES, and the op each is pushed under. Spelled as the op names themselves so this
 * list and the wire cannot drift: a family is not a label the app invented, it is the command the
 * schema names. The order is the order a fresh connection says them in, which is arbitrary and
 * stated once here rather than at the call site.
 */
export const DEFINE_OPS = [
  'alerts.define',
  'buffTrust.define',
  'respawn.define',
  'combo.define',
  'roster.define'
] as const

export type DefineOp = (typeof DEFINE_OPS)[number]

/** The params one define carries, drawn straight off the wire union — never restated here. */
export type DefineParams<O extends DefineOp> = Extract<ClientMessage, { op: O }>['params']

/** Filled by `engineClientHost.installEngineClient`, and by nothing else. */
let pusher: ((op: DefineOp) => void) | null = null

/** Arm the push. Null lets go — `stopEngineClient` and a respawn both pass through here. */
export function setAppKnowledgePusher(fn: ((op: DefineOp) => void) | null): void {
  pusher = fn
}

/**
 * ONE FAMILY MOVED — tell the engine, if there is one.
 *
 * CALLED AFTER THE TYPESCRIPT SIDE HAS ALREADY APPLIED, always. Every setter this is added to keeps
 * its existing duties in their existing order (persist, apply live, push now); this is one more
 * line at the end, so a launch with no engine behaves exactly as it did and a launch with one can
 * never be told about a preference the app itself has not adopted.
 *
 * IT NEVER THROWS AND NEVER WAITS. A define is fire-and-forget from a setter's point of view: the
 * user's click is answered by the app's own state, and an engine that refused the push is a line in
 * the dev log rather than a failed save.
 */
export function pushAppKnowledge(op: DefineOp): void {
  pusher?.(op)
}

// ── the sixth statement, which is not a sixth family (JOS-498) ─────────────────────────────────
//
// `logs.setDir` is the same SHAPE of act as the five above — the app states something the engine
// cannot work out for itself, on connect and whenever it changes, as an idempotent full-set replace
// — so it gets the same slot mechanism and lives in the same file. It is deliberately NOT a member
// of `DEFINE_OPS`, and the difference is worth the four extra lines rather than a sixth entry:
//
//   * THE FIVE ARE FOLD INPUTS. Each of them changes what folding a log produces, which is why
//     `pushAllDefines` runs BEFORE every attach and why the engine re-applies them at each fold's
//     construction. A directory changes no fold at all, so pushing it after an attach would be
//     harmless and pushing it before one is merely tidy.
//   * THE FIVE READ THE STORE THROUGH `appKnowledge.ts`. This one reads the RESOLVER — `eqLogsDir()`
//     is an override, plus a memoized discovery sweep, plus a registry read — so its value is not a
//     stored preference at all, it is the answer to "where is EverQuest", and `readDefine`'s
//     switch is the wrong home for it.
//
// WHAT IT SHARES IS THE REASON THIS FILE EXISTS: an ipc setter and `session.ts` must be able to say
// "the EQ directory moved" without importing the engine client, which imports the supervisor, which
// imports the child-process plumbing. A registration inverts that; an import would be a cycle.

/** Filled by `engineClientHost.installEngineClient`, and by nothing else. */
let logDirPusher: (() => void) | null = null

/** Arm the push. Null lets go — `stopEngineClient` and a respawn both pass through here. */
export function setLogDirPusher(fn: (() => void) | null): void {
  logDirPusher = fn
}

/**
 * THE EQ DIRECTORY MOVED — tell the engine, if there is one.
 *
 * `pushAppKnowledge`'s contract exactly: called AFTER this process has already adopted the change,
 * never throws, never waits. A launch with no engine finds a null and pays one comparison.
 */
export function pushLogDir(): void {
  logDirPusher?.()
}
