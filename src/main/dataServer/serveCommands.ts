// ============================================================================
// serveCommands.ts — THE APP'S OWN COMMANDS, SENT TO THE ENGINE TOO (JOS-493).
// ============================================================================
//
// `serveShim.ts` is the READ half of the cutover and `serveDeltas.ts` is its notification half.
// This is the third kind of traffic, and it is the smallest: a USER ACTION that changes what a fold
// produces, applied to this process's world and stated to the engine's in the same breath.
//
// ── ONE ACTION, ONE INSTANT, EVERY WORLD ───────────────────────────────────────────────────────
//
// `sessionMarks.ts` already carries the owner's law for the only member so far: pressing "New
// session" splits EVERYTHING at once, so main stamps `Date.now()` ONCE and hands that very number to
// the combat engine and to the loot ledger — a second clock read would be a second boundary, and
// everything looted in between would fall on the wrong side of one of them. The engine is a third
// holder of the same boundary and gets the SAME number, for the same reason and by the same rule;
// `SessionMarkAddParams.at` says so on the wire ("the caller's clock rather than the engine's").
//
// ── FIRE AND FORGET, AND WHY THAT IS NOT LAXITY ────────────────────────────────────────────────
//
// `definePush.ts`'s rule, restated for a command: the user's click is answered by the app's own
// state, which has already moved by the time this is called. So nothing waits on the round trip and
// nothing branches on it — an engine that refused is a dev-log line, not a failed press. And a
// refusal is EXPECTED rather than exceptional: the protocol says `sessionMarks.add` can honestly
// answer `not now` while the engine's historical fold is running, which is the same state this
// process's own `combat.sessionMark(at)` refuses in.
//
// THE APP'S OWN ANSWER IS STILL THE GATE. `pressNewSession` calls this only after its own two halves
// have both accepted — see that file's "both halves or neither". A mark the app itself declined must
// not be announced to a third world as though it happened.
//
// ── THE FOLD-SIDE SPLIT IS NOT THIS FILE'S ─────────────────────────────────────────────────────
//
// What the engine DOES with the mark — splitting its zone records the way `combat/engine.ts` splits
// this process's — is JOS-492's work in `engine/`. This ticket is the WIRING, and it lands
// independently on purpose: the command reaching the engine and being acked is a claim that can be
// made and pinned today, and it is the half that has to exist before the other half can be observed
// at all.
//
// ── THE SECOND MEMBER, AND WHY THE FAMILY IS EXACTLY TWO (JOS-494) ─────────────────────────────
//
// `respawn.confirmSighting` joins the mark here rather than in `definePush.ts`, and the line
// between the two files is what a push MEANS rather than which ipc file it happens to sit in. A
// DEFINE is a preference: the engine's world records it under its family and re-applies it at the
// next attach, because a watch list is a fact about what the person wants and outlives any one
// fold. A COMMAND is a thing that happened at a moment — a press — and nothing on either side
// stores one. `ipc/respawn.ts` therefore pushes through BOTH files, one per duty, which is not a
// duplication: its setter edits a preference and its confirm makes a judgement, and the engine
// treats them as differently as this app does.
//
// ── THE `shimServing()` GATE, RESTATED FOR A COMMAND THAT IS NOT PERSISTED ─────────────────────
//
// Both members ask it, and for a command it is a sharper question than for a define. A define
// pushed at a not-yet-serving engine is still worth making — the world holds it and the next attach
// applies it — which is why `definePush.ts` does not ask. A command is not held by anybody: an
// engine that is not serving this app's log is an engine whose respawn clocks nobody is reading and
// whose fold, when it does become the one being read, will have been rebuilt from a log that never
// mentioned the press. So a command sent outside the serve window would be a statement about a
// world with no audience, and its absence costs nothing.

import { logInfo } from '../errorLog'
import { engineRequest } from './engineClientHost'

function note(line: string): void {
  logInfo(`[everquest-companion] ${line}`)
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * "THE USER PRESSED NEW SESSION AT `at`" — told to the engine, if this launch is serving from one.
 *
 * SYNCHRONOUS BY SIGNATURE because its caller is: `pressNewSession` returns the new mark list to the
 * window that pressed, and a press must never be made to wait on a socket.
 */
export function serveSessionMark(at: number): void {
  // NO SERVE GATE (JOS-499 item 9): `engineRequest` rejects when there is no client, and the
  // rejection arm below already says so in one line.
  void engineRequest('sessionMarks.add', { at }).then(
    (ack) => {
      note(
        `data-server sessionMark: ${String(at)} — ` +
          (ack.accepted ? 'the engine split its records' : `the engine said not now (${ack.status})`)
      )
    },
    (err: unknown) => {
      note(`data-server sessionMark: ${String(at)} — the engine refused it (${describeErr(err)})`)
    }
  )
}

/**
 * "THAT SIGHTING WAS THE SPAWN" — told to the engine, if this launch is serving from one.
 *
 * SYNCHRONOUS BY SIGNATURE for `serveSessionMark`'s reason: its caller is an ipc handler that has
 * already answered the person out of this process's own module, and a click must never be made to
 * wait on a socket.
 *
 * THE APP'S OWN ANSWER IS THE GATE HERE TOO. `ipc/respawn.ts` calls this only when its own
 * `confirmSighting` returned true — a press this process itself read as a no-op (a stale click, a
 * row that died between the render and the button) must not be announced to a second world as
 * though it happened. The engine would answer `confirmed: false` for the same row anyway, and
 * relying on that would be this app asking a question it already knows the answer to.
 *
 * A `false` COMING BACK IS STILL WORTH A LINE, and it is the interesting one: the app took the
 * press and the engine did not, which means the two folds disagree about what is standing in that
 * zone — a real divergence, and the sort of thing a developer flips the flag to read about.
 */
export function serveConfirmSighting(rowId: string): void {
  // NO SERVE GATE (JOS-499 item 9): `engineRequest` rejects when there is no client, and the
  // rejection arm below already says so in one line.
  void engineRequest('respawn.confirmSighting', { rowId }).then(
    (ack) => {
      note(
        `data-server confirmSighting: ${rowId} — ` +
          (ack.confirmed
            ? 'the engine re-based its clock'
            : 'the engine had nothing to re-base, though this app did')
      )
    },
    (err: unknown) => {
      note(`data-server confirmSighting: ${rowId} — the engine refused it (${describeErr(err)})`)
    }
  )
}
