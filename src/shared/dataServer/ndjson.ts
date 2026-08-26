// NDJSON framing — one JSON message per LF-terminated line.
//
// THIS IS THE ONLY FILE IN src/shared/dataServer THAT KNOWS A NEWLINE EXISTS, and keeping it that
// way is the whole point of the transport seam (see transport.ts). If the wire becomes WebSocket
// frames over the open internet, this file gains a sibling and nothing else in the tree changes.
// `tests/dataServerTransport.test.mts` asserts the absence directly, by reading every other file
// in this directory and failing on a newline literal.
//
// WHY LF IS SAFE AS A DELIMITER, written down so nobody re-derives it nervously: `JSON.stringify`
// escapes every control character inside a string, so a serialized message can never contain a raw
// newline however hostile its contents — a `\n` in a row's text arrives on the wire as the two
// characters `\` and `n`. That is a property of JSON, not of this app's data, so no amount of
// game-log weirdness can smuggle a frame boundary through.
//
// THE DELIMITER IS LF, NEVER CRLF. Windows is the only platform this app ships on and it is
// exactly where a text-mode stream would helpfully translate one into the other; a trailing `\r`
// is stripped on decode rather than trusted, so a peer that framed with CRLF is still read
// correctly.

import { TransportError, type Transport } from './transport'

/** The frame delimiter. One character, and the only one this protocol treats as structural. */
export const DELIMITER = '\n'

/**
 * The largest single frame this codec will assemble, in characters.
 *
 * A FRAMING guard, not a protocol rule: a peer that never sends a delimiter would otherwise grow
 * the buffer without bound, which is a denial of service a loopback socket makes trivial. Payload
 * budgets — how big a view's window may be — are a protocol concern and live engine-side, nowhere
 * near this number. It matches `MAX_LINE_BYTES` in the Rust codec.
 */
export const MAX_LINE_CHARS = 8 * 1024 * 1024

/** Serialize one message into its wire form: the JSON, then the delimiter. */
export function encodeLine(message: unknown): string {
  let json: string
  try {
    json = JSON.stringify(message)
  } catch (cause) {
    throw new TransportError('encode', 'message could not be serialized', cause)
  }
  if (json === undefined) throw new TransportError('encode', 'message serialized to nothing')
  return `${json}${DELIMITER}`
}

/**
 * Parse one wire line back into a message. The line must NOT carry its delimiter.
 *
 * It returns `unknown` rather than a caller-chosen type on purpose: a JSON parse cannot know what
 * arrived, and a generic here would be a cast wearing a type signature. The narrowing belongs to
 * whoever knows which direction the connection runs — see `createNdjsonTransport`.
 */
export function decodeLine(line: string): unknown {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  try {
    return JSON.parse(trimmed)
  } catch (cause) {
    throw new TransportError('decode', 'a frame was not a JSON message', cause)
  }
}

/**
 * The stateful half: bytes arrive in whatever chunks the OS felt like, and a message may be split
 * across any number of them. `push` returns the COMPLETE lines it now has, keeping the remainder.
 *
 * It is separate from the transport so it can be tested on its own against adversarial chunking —
 * a codec that only works when each read happens to land on a frame boundary is a codec that works
 * on a test double and fails on a socket.
 */
export class LineDecoder {
  private buffer = ''

  constructor(private readonly maxLineChars = MAX_LINE_CHARS) {}

  /** Feed a chunk; get back every whole line it completed, in order. */
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let at = this.buffer.indexOf(DELIMITER)
    while (at !== -1) {
      lines.push(this.buffer.slice(0, at))
      this.buffer = this.buffer.slice(at + 1)
      at = this.buffer.indexOf(DELIMITER)
    }
    if (this.buffer.length > this.maxLineChars) {
      this.buffer = ''
      throw new TransportError('frameTooLarge', `a frame exceeded ${String(this.maxLineChars)} characters`)
    }
    return lines
  }

  /**
   * What is still buffered. A non-empty remainder at end of stream is a TRUNCATED FRAME — half a
   * message discarded in silence is how a client ends up rendering a world nobody sent — so the
   * transport reports it rather than dropping it.
   */
  get pending(): string {
    return this.buffer
  }
}

/** What an NDJSON transport needs from whatever is actually carrying the bytes. */
export interface ByteChannel {
  /** Push bytes at the peer. */
  write(chunk: string): void
  /** Register the one handler for arriving bytes. */
  onData(handler: (chunk: string) => void): void
  /** Register the handler for the stream ending, cleanly or otherwise. */
  onClose(handler: (error?: unknown) => void): void
  /** Stop. Idempotent. */
  close(): void
}

/**
 * A {@link Transport} over any byte channel.
 *
 * It takes a channel rather than a socket because phase 0 has no socket: the suite drives it over
 * an in-memory pipe, and the supervisor will hand it a `net.Socket` adapter without this file
 * changing.
 */
export function createNdjsonTransport<Out, In>(channel: ByteChannel): Transport<Out, In> {
  const decoder = new LineDecoder()
  let onMessage: ((message: In) => void) | undefined
  let onError: ((error: TransportError) => void) | undefined
  let closed = false

  const fail = (error: TransportError): void => {
    if (closed) return
    closed = true
    channel.close()
    onError?.(error)
  }

  channel.onData((chunk) => {
    if (closed) return
    let lines: string[]
    try {
      lines = decoder.push(chunk)
    } catch (e) {
      fail(e instanceof TransportError ? e : new TransportError('io', 'framing failed', e))
      return
    }
    for (const line of lines) {
      if (closed) return
      // A blank line is not a message. Being lenient here costs nothing and makes a peer that
      // ends a batch with an extra newline readable instead of fatal.
      if (line.trim() === '') continue
      try {
        // THE ONE CAST IN THE SEAM, and it is where it belongs: the transport is the only thing
        // that knows which direction this connection runs, so it is the only thing entitled to say
        // what a decoded frame is. Whether the peer actually honoured the contract is the schema's
        // question, not the codec's.
        onMessage?.(decodeLine(line) as In)
      } catch (e) {
        fail(e instanceof TransportError ? e : new TransportError('decode', 'a frame was refused', e))
        return
      }
    }
  })

  channel.onClose((error) => {
    if (closed) return
    if (decoder.pending.trim() !== '') {
      fail(new TransportError('decode', 'the stream ended mid-frame'))
      return
    }
    closed = true
    if (error !== undefined) onError?.(new TransportError('io', 'the transport failed', error))
  })

  return {
    send(message) {
      if (closed) throw new TransportError('closed', 'the transport is closed')
      channel.write(encodeLine(message))
    },
    onMessage(handler) {
      onMessage = handler
    },
    onError(handler) {
      onError = handler
    },
    close() {
      if (closed) return
      closed = true
      channel.close()
    },
    get closed() {
      return closed
    }
  }
}
