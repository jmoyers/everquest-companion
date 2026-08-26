// ============================================================================
// messagePortChannel.ts — a `ByteChannel` over a MessagePort (JOS-484, phase 3).
// ============================================================================
//
// `socketChannel.ts` is the ~30 lines that make a `net.Socket` one of `ndjson.ts`'s byte channels.
// This is its sibling for the one wire a RENDERER can actually hold: a MessagePort handed down from
// main, whose other end main is pumping raw socket bytes into (`main/dataServer/rendererBroker.ts`).
// Nothing above the channel changes — the renderer runs the same `createNdjsonTransport` over the
// same `EngineClient` the main process runs, and neither can tell which wire is underneath.
//
// ── WHY THIS FILE IS NOT ALLOWED TO KNOW WHAT A FRAME IS ───────────────────────────────────────
//
// A MessagePort is MESSAGE-oriented and a socket is not, so it is tempting to post one protocol
// message per `postMessage` and delete the codec on this side. That would be a SECOND FRAMING,
// living in a second place, disagreeing with the first the day either changed — exactly what the
// transport seam exists to prevent (`transport.ts`'s header, owner ruling 15). So the port carries
// the socket's own chunks, verbatim and unaligned, and `LineDecoder` reassembles them here the same
// way it does on the other side of the loopback. A chunk boundary is not a message boundary here
// either, and the suite proves it by splitting mid-frame and mid-character.
//
// ── THE ONE THING THE PORT CARRIES THAT IS NOT BYTES ───────────────────────────────────────────
//
// `null`, and it means THE STREAM ENDED. A DOM MessagePort has no reliable close event — an
// entangled port whose peer is garbage collected simply goes quiet — and a byte channel that cannot
// report the end of its stream turns a dead engine into a client that waits forever. So the relay
// posts one `null` when the socket ends and the channel posts one back when the client closes.
//
// That is a CHANNEL fact, not a protocol message: it says the wire stopped, which is the same thing
// `socket.on('close')` says on the other adapter, and nothing above the channel ever sees it. Any
// other payload is a chunk of bytes and is passed through untouched.

import type { ByteChannel } from './ndjson'

/**
 * What this adapter needs from a MessagePort, structurally rather than by name.
 *
 * A DOM `MessagePort` satisfies it as-is. So does a `node:worker_threads` port through a two-line
 * shim, which is what lets the suite drive this with no browser and no Electron — the same test
 * seam `memoryTransport.ts` is for the layer above.
 */
export interface PortLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
  /** Buffered messages are delivered from here, so it is called only once a handler exists. */
  start(): void
  close(): void
}

/** The one non-byte payload: the stream ended. See the header. */
export const PORT_END = null

/**
 * Wrap a MessagePort as a byte channel.
 *
 * THE `settled` LATCH IS `socketChannel.ts`'s, for its reason: the transport's contract is that the
 * close handler is the END of the stream, so an end that arrived from the peer and an end this side
 * asked for must be one event, not two. A write after it is dropped rather than thrown — a port
 * whose peer has gone still accepts `postMessage` in silence, so throwing here would invent a
 * failure the wire never reported.
 *
 * CLOSING TELLS THE PEER. The `null` goes out BEFORE `port.close()`, because closing an entangled
 * port discards anything not yet posted; without it, main would learn a renderer had let go only
 * when its window was destroyed, and a subscription's socket would outlive the view that opened it.
 */
export function messagePortChannel(port: PortLike): ByteChannel {
  let settled = false
  let onClose: ((error?: unknown) => void) | undefined
  const end = (error?: unknown): void => {
    if (settled) return
    settled = true
    onClose?.(error)
  }
  return {
    write(chunk) {
      if (settled) return
      port.postMessage(chunk)
    },
    onData(handler) {
      port.addEventListener('message', (event) => {
        if (settled) return
        if (event.data === PORT_END) {
          end()
          return
        }
        // A port delivers what was posted, and the relay posts only the strings the socket handed
        // it. Anything else is a peer that is not the relay, and it is not turned into bytes: a
        // stringified object would reach `LineDecoder` as a frame nobody sent.
        if (typeof event.data !== 'string') return
        handler(event.data)
      })
      // AFTER the handler, never before: a port buffers until `start()`, and starting it first is
      // how the hello reply that was already in flight gets delivered to nobody.
      port.start()
    },
    onClose(handler) {
      onClose = handler
    },
    close() {
      if (!settled) {
        port.postMessage(PORT_END)
      }
      port.close()
      end()
    }
  }
}
