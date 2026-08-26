// THE SEAM, app side. A transport moves whole MESSAGES; only what is below it knows about bytes.
//
// THE OWNER'S CONSTRAINT, VERBATIM (JOS-464): "lets make sure the way this works we could change
// the wire method at a later date and need to just swap an artifact. im thinking over the open
// internet via websockets etc."
//
// Its structural consequence is this file. `protocol/schema/` describes MESSAGES and never bytes —
// no newline, no length prefix, no port, no host appears anywhere in it — so the generated types
// carry no framing either, and everything that will later sit above this module (the client lib,
// the subscribe hook, every view) talks to a `Transport` and therefore cannot learn what a frame
// is even by accident.
//
// TODAY THERE ARE TWO IMPLEMENTATIONS and today's wire is NDJSON:
//
//   * `ndjson.ts` — one JSON message per LF-terminated line. THE ONLY FILE IN THIS DIRECTORY THAT
//     MENTIONS A NEWLINE, and the only one that would change if the framing did.
//   * `memoryTransport.ts` — a connected pair with no bytes at all. Not a toy: it is the proof the
//     seam is real, because `tests/dataServerTransport.test.mts` runs the same conversation over
//     it and over NDJSON and asserts the two deliver identical messages. A conversation that
//     survives having its wire removed was not depending on one.
//
// ADDING WEBSOCKETS IS ADDING A THIRD FILE HERE. Nothing above it moves — not the schema, not the
// generated types, not a line of protocol logic.
//
// THE ENGINE'S HALF OF THIS SEAM is engine/crates/protocol/src/transport/, with the same shape and
// the same one-file framing rule. The two are mirrors on purpose: a change to how messages are
// carried has exactly two places to be made, and a test on each side that notices if only one was.

/** Why a transport stopped or refused. `code` is what a caller branches on; `cause` is for a log. */
export class TransportError extends Error {
  constructor(
    readonly code: 'encode' | 'decode' | 'io' | 'frameTooLarge' | 'closed',
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'TransportError'
  }
}

/**
 * One end of a connection, in terms of messages.
 *
 * The two type parameters are what let one interface serve both ends: the app's transport sends
 * `ClientMessage` and receives `EngineMessage`, the engine's the other way round, and neither end
 * can send the other's messages by mistake.
 *
 * NOTHING HERE MENTIONS BYTES. That absence is the contract.
 */
export interface Transport<Out, In> {
  /** Hand one message to the peer. Throws {@link TransportError} if it cannot be delivered. */
  send(message: Out): void
  /**
   * Register the one handler for arriving messages. Calling it twice replaces the handler rather
   * than adding a second — a protocol with two readers is a protocol with a race.
   */
  onMessage(handler: (message: In) => void): void
  /** Register a handler for a transport-level failure. The connection is finished when it fires. */
  onError(handler: (error: TransportError) => void): void
  /** Stop. Idempotent: closing a closed transport is not an error. */
  close(): void
  /** Has this end finished? A closed transport never delivers another message. */
  readonly closed: boolean
}
