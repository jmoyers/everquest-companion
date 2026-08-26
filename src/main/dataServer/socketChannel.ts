// ============================================================================
// socketChannel.ts — THE ONLY FILE IN THIS FEATURE THAT KNOWS A SOCKET EXISTS (JOS-467).
// ============================================================================
//
// `transport.ts`'s header promises that nothing above the transport can learn what is carrying the
// bytes, and `ndjson.ts`'s `ByteChannel` is the shape that promise is kept with: "push bytes, hand
// me bytes, tell me when it ends, stop". This file is the ~30 lines that make a `net.Socket` one of
// those. The day the wire becomes WebSockets over the open internet (the owner's constraint,
// JOS-464), this file gains a sibling and nothing else on either side of the seam changes.
//
// NUMERIC LOOPBACK ONLY — `ENGINE_HOST`, never the name `localhost`. The reason is in
// `engineProtocol.ts` beside the constant, and the precedent is `src/main/feedback/net.ts`: a name
// resolves through whatever the machine's resolver says today, and a numeric literal cannot be
// pointed elsewhere. The connect below takes a PORT and supplies the host itself, so there is no
// parameter through which a caller could ever pass one.
//
// UTF-8, DECLARED. `setEncoding('utf8')` makes Node hand the handler STRINGS split on complete
// code points rather than Buffers — which matters because `LineDecoder` accumulates a string and a
// multi-byte character split across two TCP reads would otherwise become two replacement
// characters and a frame that no longer parses. Node's own decoder holds the partial sequence; this
// is the one line that gets that for free instead of re-implementing it.
//
// NO NAGLE. `setNoDelay(true)`, because every message this protocol sends is small and
// latency-sensitive and there is never a second write coming that would benefit from being
// coalesced with the first. On loopback Nagle's 40 ms is pure added latency on a handshake.

import { Socket, connect } from 'node:net'
import { ENGINE_HOST } from './engineProtocol'
import type { ByteChannel } from '../../shared/dataServer/ndjson'

/**
 * Wrap a socket as a byte channel.
 *
 * `error` AND `close` BOTH LAND ON `onClose`, and they must: Node emits `error` and then `close`
 * for a failed socket, so a channel that only listened for one of them would either miss the
 * failure or report a clean end for it. The `settled` latch is what makes the pair one event — the
 * transport's contract is that the close handler is the end of the stream, and calling it twice
 * would let a late `close` overwrite the reason the stream actually ended.
 *
 * A WRITE AFTER THE END IS NOT AN EXCEPTION. `socket.write` on a destroyed socket emits an error
 * asynchronously rather than throwing, and the transport above has already been told the stream
 * ended; the guard here keeps a late write from re-entering the error path for a connection nobody
 * is reading any more.
 */
export function socketChannel(socket: Socket): ByteChannel {
  socket.setEncoding('utf8')
  socket.setNoDelay(true)
  let settled = false
  let onClose: ((error?: unknown) => void) | undefined
  const end = (error?: unknown): void => {
    if (settled) return
    settled = true
    onClose?.(error)
  }
  socket.on('error', (err: unknown) => end(err))
  socket.on('close', () => end())
  return {
    write(chunk) {
      if (settled || socket.destroyed) return
      socket.write(chunk)
    },
    onData(handler) {
      // `setEncoding('utf8')` above is what makes this a string; without it the parameter would be
      // a Buffer wearing a string's type.
      socket.on('data', (chunk: string) => handler(chunk))
    },
    onClose(handler) {
      onClose = handler
    },
    close() {
      // `destroy()` rather than `end()`: this is a probe connection with nothing outstanding, and a
      // half-open FIN handshake would leave it waiting on a peer that has no reason to answer.
      socket.destroy()
      end()
    }
  }
}

/**
 * Open one loopback connection to the engine and hand back its channel.
 *
 * THE CONNECT HAS ITS OWN TIMEOUT because a socket that never completes its handshake never emits
 * `connect` and never emits `error` either — it sits in SYN_SENT until the OS gives up, which on
 * Windows is on the order of twenty seconds. The health probe's own clock cannot cover that: it
 * does not start until there is a channel to talk over.
 *
 * The socket is `unref`'d, for `presence.ts`'s reason: nothing this supervisor holds may be the
 * reason a quitting process stays alive.
 */
export async function connectToEngine(port: number, timeoutMs: number): Promise<ByteChannel> {
  return new Promise<ByteChannel>((resolve, reject) => {
    const socket = connect({ host: ENGINE_HOST, port })
    socket.unref()
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      reject(new Error(`connecting to the engine on port ${String(port)} timed out`))
    })
    socket.once('error', (err: Error) => {
      reject(err)
    })
    socket.once('connect', () => {
      // The connect timeout was a CONNECT timeout. Leaving it armed would kill a healthy connection
      // mid-conversation the moment it went quiet for that long, which is a different rule nobody
      // asked for; the probe above owns the conversation's clock.
      socket.setTimeout(0)
      resolve(socketChannel(socket))
    })
  })
}
