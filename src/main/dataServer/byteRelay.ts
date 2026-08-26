// ============================================================================
// byteRelay.ts — THE PUMP. Bytes between a socket and a port, and nothing else (JOS-484).
// ============================================================================
//
// `rendererBroker.ts` is the wiring: an IPC handler, a `MessageChannelMain`, a webContents, a map of
// live connections. This file is everything that was left over when that was made Electron-free —
// which is the split `supervisor.ts`/`engineHost.ts` already made one directory over, for the same
// reason: the only part with any logic in it is the part worth driving from a unit test, and a test
// that has to boot Electron to watch a teardown is a test nobody runs.
//
// THE WHOLE CONTRACT IS "MOVE THE CHUNK". This module imports no protocol type, no codec and no
// Electron; a socket chunk is posted and a port message is written, and the only value with any
// meaning is the end sentinel. That absence is what owner ruling 7's brokerage costs main: nothing
// per view, because there is nothing here to cost anything. `rendererBroker.ts`'s header carries
// the argument for why that is the whole design rather than an optimization.

import type { ByteChannel } from '../../shared/dataServer/ndjson'

/**
 * What the relay needs from an Electron `MessagePortMain`, structurally.
 *
 * Stated as an interface rather than imported so a fake can be handed in — see
 * `tests/dataServerBroker.test.mts`, which drives both ends of this wire with no Electron at all.
 */
export interface RelayPort {
  postMessage(message: unknown): void
  on(channel: 'message', handler: (event: { data: unknown }) => void): this
  on(channel: 'close', handler: () => void): this
  start(): void
  close(): void
}

/** The one payload on this wire that is not bytes: the stream ended. The renderer's half of the
 *  convention (and the argument for it) is `shared/dataServer/messagePortChannel.ts`. */
const PORT_END = null

/**
 * Join one byte channel and one port so every chunk crosses untouched, in both directions, and
 * either end closing closes the other. Returns the teardown, which is idempotent.
 *
 * `settled` is the same latch both adapters carry, and it is what makes "the socket ended" and "the
 * renderer let go" ONE event however they arrive — a second teardown would post a sentinel down a
 * port that is already closed, and on Electron that is a throw from inside an event handler.
 *
 * NOTHING HERE INSPECTS A CHUNK, with one exception that is not an inspection: a message that is
 * not a string is DROPPED rather than written. That is not framing knowledge, it is a type check on
 * the one input on this path that comes from a renderer — `socket.write` would coerce an object to
 * `[object Object]` and hand the engine a frame nobody sent.
 */
export function relayBytes(channel: ByteChannel, port: RelayPort): () => void {
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    // The sentinel goes out BEFORE the close, because closing an entangled port discards anything
    // not yet posted — without it, a renderer learns its engine is gone only by timing out.
    try {
      port.postMessage(PORT_END)
    } catch {
      // The peer is already gone. That is the case this is announcing; it is not a failure.
    }
    port.close()
    channel.close()
  }

  channel.onData((chunk) => {
    if (settled) return
    try {
      port.postMessage(chunk)
    } catch {
      settle()
    }
  })
  channel.onClose(() => {
    settle()
  })
  port.on('message', (event) => {
    if (settled) return
    if (event.data === PORT_END) {
      settle()
      return
    }
    if (typeof event.data !== 'string') return
    channel.write(event.data)
  })
  port.on('close', () => {
    settle()
  })
  port.start()
  return settle
}
