// THE BROKERED WIRE, BOTH ENDS (JOS-484).
//
// A renderer's connection to the engine crosses four things: a socket main opened, the relay that
// pumps it (`src/main/dataServer/rendererBroker.ts relayBytes`), a MessagePort pair, and the
// adapter that makes the renderer's end a byte channel
// (`src/shared/dataServer/messagePortChannel.ts`). Two of those are new and neither needs Electron
// to be wrong, so both are driven here with fakes and the whole path is driven end to end.
//
// WHAT THIS SUITE IS ACTUALLY DEFENDING, in one sentence each:
//
//   1. MAIN NEVER PARSES A FRAME. The relay's contract is that a chunk goes across as the chunk it
//      was — so the bytes are checked for being IDENTICAL and, more importantly, for arriving in
//      the same SPLITS. A relay that helpfully coalesced would still deliver the right characters
//      and would have started making framing decisions on the way.
//   2. A CHUNK BOUNDARY IS NOT A MESSAGE BOUNDARY, on this wire as on every other. The end-to-end
//      test feeds the socket ONE CHARACTER AT A TIME — the `OneByteAtATime` discipline the program
//      already learned the hard way on the Rust side — because a MessagePort is message-oriented
//      and the temptation to let it do the framing is exactly the mistake the transport seam exists
//      to prevent.
//   3. EITHER END LETTING GO CLOSES THE OTHER, all four ways it can happen. A byte channel that
//      cannot report the end of its stream turns a dead engine into a client that waits forever,
//      and a port whose peer merely forgot it leaves main relaying a socket into nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relayBytes, type RelayPort } from '../src/main/dataServer/byteRelay'
import { messagePortChannel, type PortLike } from '../src/shared/dataServer/messagePortChannel'
import { createNdjsonTransport, type ByteChannel } from '../src/shared/dataServer/ndjson'

// ---- the doubles ---------------------------------------------------------------------------------

/** A byte channel with a socket's manners: what was written, and the two ways it can end. */
interface FakeSocket {
  readonly channel: ByteChannel
  /** Every `write` the relay made, in order and UNJOINED — the split is part of the claim. */
  readonly written: string[]
  /** The peer sent bytes. */
  deliver(chunk: string): void
  /** The peer went away (or we did). */
  end(): void
  readonly closed: () => boolean
}

function fakeSocket(): FakeSocket {
  const written: string[] = []
  let onData: ((chunk: string) => void) | undefined
  let onClose: ((error?: unknown) => void) | undefined
  let settled = false
  const end = (): void => {
    if (settled) return
    settled = true
    onClose?.()
  }
  return {
    written,
    deliver: (chunk) => onData?.(chunk),
    end,
    closed: () => settled,
    channel: {
      write: (chunk) => {
        if (settled) return
        written.push(chunk)
      },
      onData: (handler) => {
        onData = handler
      },
      onClose: (handler) => {
        onClose = handler
      },
      close: end
    }
  }
}

/**
 * An entangled pair with the two shapes the two processes actually see: `MessagePortMain`'s
 * EventEmitter (`on('message', e => e.data)`) on main's end, the DOM's EventTarget
 * (`addEventListener`) on the renderer's.
 *
 * IT BUFFERS UNTIL `start()`, which is the one MessagePort semantic this code depends on: the
 * adapter registers its handler before starting precisely so a reply already in flight is not
 * delivered to nobody. A double that started eager would make that ordering untestable.
 */
interface FakePair {
  readonly main: RelayPort
  readonly renderer: PortLike
  readonly mainClosed: () => boolean
  readonly rendererClosed: () => boolean
}

interface Side {
  started: boolean
  closed: boolean
  queue: unknown[]
  handlers: ((event: { data: unknown }) => void)[]
  closers: (() => void)[]
}

function newSide(): Side {
  return { started: false, closed: false, queue: [], handlers: [], closers: [] }
}

function deliver(side: Side, message: unknown): void {
  if (side.closed) return
  if (!side.started) {
    side.queue.push(message)
    return
  }
  for (const handler of side.handlers) handler({ data: message })
}

function start(side: Side): void {
  if (side.started) return
  side.started = true
  const queued = side.queue.splice(0, side.queue.length)
  for (const message of queued) {
    for (const handler of side.handlers) handler({ data: message })
  }
}

function shut(side: Side, peer: Side): void {
  if (side.closed) return
  side.closed = true
  // A real entangled port tells its peer it was disentangled. That is the ONLY thing the relay's
  // `close` arm has to notice, so the double has to do it.
  for (const closer of peer.closers) closer()
}

function fakePair(): FakePair {
  const a = newSide()
  const b = newSide()
  return {
    mainClosed: () => a.closed,
    rendererClosed: () => b.closed,
    main: {
      postMessage: (message) => deliver(b, message),
      on(channel: 'message' | 'close', handler: never): RelayPort {
        if (channel === 'message') a.handlers.push(handler as (event: { data: unknown }) => void)
        else a.closers.push(handler as unknown as () => void)
        return this as unknown as RelayPort
      },
      start: () => start(a),
      close: () => shut(a, b)
    } as RelayPort,
    renderer: {
      postMessage: (message) => deliver(a, message),
      addEventListener: (_type, handler) => b.handlers.push(handler),
      start: () => start(b),
      close: () => shut(b, a)
    }
  }
}

/** Collect what a byte channel hands its reader. */
function reader(channel: ByteChannel): { chunks: string[]; ended: () => boolean } {
  const chunks: string[] = []
  let ended = false
  channel.onData((chunk) => chunks.push(chunk))
  channel.onClose(() => {
    ended = true
  })
  return { chunks, ended: () => ended }
}

// ---- the adapter ---------------------------------------------------------------------------------

test('the port channel hands over the SPLITS it was given, not the string they add up to', () => {
  const pair = fakePair()
  const channel = messagePortChannel(pair.renderer)
  const got = reader(channel)
  // Posted from main's end, in three pieces that do not align with anything.
  pair.main.postMessage('{"kind":"he')
  pair.main.postMessage('llo"')
  pair.main.postMessage(',"ok":true}')
  assert.deepEqual(got.chunks, ['{"kind":"he', 'llo"', ',"ok":true}'])
})

test('messages that arrived before a reader existed are still delivered', () => {
  const pair = fakePair()
  // The port is handed over with a reply already on it — main posts the port and the engine's hello
  // answer can land before the renderer has built its transport.
  pair.main.postMessage('early')
  const channel = messagePortChannel(pair.renderer)
  const got = reader(channel)
  assert.deepEqual(got.chunks, ['early'], 'the buffered message was dropped — start() ran too early')
})

test('a payload that is not bytes is not turned into bytes', () => {
  const pair = fakePair()
  const got = reader(messagePortChannel(pair.renderer))
  pair.main.postMessage({ kind: 'hello' })
  pair.main.postMessage(42)
  assert.deepEqual(got.chunks, [], 'an object reached the decoder as a frame nobody sent')
})

test('the END sentinel is the stream ending, and it is reported once', () => {
  const pair = fakePair()
  const channel = messagePortChannel(pair.renderer)
  let ends = 0
  channel.onData(() => undefined)
  channel.onClose(() => {
    ends += 1
  })
  pair.main.postMessage(null)
  pair.main.postMessage(null)
  pair.main.postMessage('bytes after the end')
  assert.equal(ends, 1, 'the end of a stream is one event')
})

test('closing the channel tells the peer BEFORE it closes the port', () => {
  const pair = fakePair()
  const seen: unknown[] = []
  pair.main.on('message', (event) => seen.push(event.data))
  pair.main.start()
  const channel = messagePortChannel(pair.renderer)
  channel.onData(() => undefined)
  channel.close()
  assert.deepEqual(seen, [null], 'main never learned the renderer let go')
  assert.equal(pair.rendererClosed(), true)
})

test('closing is idempotent and a write after it is dropped rather than thrown', () => {
  const pair = fakePair()
  const seen: unknown[] = []
  pair.main.on('message', (event) => seen.push(event.data))
  pair.main.start()
  const channel = messagePortChannel(pair.renderer)
  channel.onData(() => undefined)
  channel.close()
  channel.close()
  channel.write('too late')
  // The second close posts nothing new (the latch), and the late write reaches no peer.
  assert.deepEqual(seen, [null])
})

// ---- the relay -----------------------------------------------------------------------------------

test('bytes cross the relay untouched, in both directions and in their own splits', () => {
  const socket = fakeSocket()
  const pair = fakePair()
  const seen: unknown[] = []
  pair.main.on('message', () => undefined)
  const renderer = messagePortChannel(pair.renderer)
  renderer.onData((chunk) => seen.push(chunk))
  renderer.onClose(() => undefined)
  relayBytes(socket.channel, pair.main)

  // engine → renderer
  socket.deliver('{"kind":"reset"')
  socket.deliver(',"id":7}')
  assert.deepEqual(seen, ['{"kind":"reset"', ',"id":7}'])

  // renderer → engine
  renderer.write('{"op":"hello"}')
  renderer.write('{"id":1}')
  assert.deepEqual(socket.written, ['{"op":"hello"}', '{"id":1}'])
})

test('the relay refuses to write anything that is not bytes', () => {
  const socket = fakeSocket()
  const pair = fakePair()
  relayBytes(socket.channel, pair.main)
  // A renderer that is not the preload's channel — the one thing on this wire main does not trust.
  pair.renderer.postMessage({ op: 'hello' })
  pair.renderer.postMessage(7)
  assert.deepEqual(socket.written, [], 'an object reached the socket as [object Object]')
})

test('the ENGINE going away closes the renderer’s end and says so', () => {
  const socket = fakeSocket()
  const pair = fakePair()
  const renderer = messagePortChannel(pair.renderer)
  const got = reader(renderer)
  relayBytes(socket.channel, pair.main)
  socket.end()
  assert.equal(got.ended(), true, 'the renderer was never told its stream ended')
  assert.equal(pair.mainClosed(), true, 'main kept a port for a socket that is gone')
})

test('the RENDERER letting go destroys the socket', () => {
  const socket = fakeSocket()
  const pair = fakePair()
  const renderer = messagePortChannel(pair.renderer)
  renderer.onData(() => undefined)
  renderer.onClose(() => undefined)
  relayBytes(socket.channel, pair.main)
  renderer.close()
  assert.equal(socket.closed(), true, 'the socket outlived the view that opened it')
})

test('a renderer that is simply GONE — its port disentangled — destroys the socket too', () => {
  const socket = fakeSocket()
  const pair = fakePair()
  relayBytes(socket.channel, pair.main)
  // No sentinel, no goodbye: the window was destroyed and its end of the pair went with it.
  pair.renderer.close()
  assert.equal(socket.closed(), true)
})

test('the relay’s own settle is idempotent — closing twice posts nothing twice', () => {
  const socket = fakeSocket()
  const pair = fakePair()
  const seen: unknown[] = []
  pair.renderer.addEventListener('message', (event) => seen.push(event.data))
  pair.renderer.start()
  const settle = relayBytes(socket.channel, pair.main)
  settle()
  settle()
  socket.end()
  assert.deepEqual(seen, [null], 'the end of a stream is one event on this side too')
})

// ---- the whole path ------------------------------------------------------------------------------

test('A REAL CONVERSATION CROSSES THE BROKER ONE CHARACTER AT A TIME', () => {
  // The claim this file exists for: nothing between the engine's socket and the renderer's client
  // knows what a frame is, so a socket that reads one byte per wake still delivers whole messages
  // — and the reassembly happens in `LineDecoder`, on the renderer's side, exactly once.
  const socket = fakeSocket()
  const pair = fakePair()
  const renderer = messagePortChannel(pair.renderer)
  const transport = createNdjsonTransport<{ op: string }, { kind: string; id?: number }>(renderer)
  const received: { kind: string; id?: number }[] = []
  transport.onMessage((message) => received.push(message))
  relayBytes(socket.channel, pair.main)

  const wire =
    '{"kind":"hello","ok":true}' + String.fromCharCode(10) + '{"kind":"reset","id":7}' + String.fromCharCode(10)
  for (const character of wire) socket.deliver(character)

  assert.deepEqual(received, [{ kind: 'hello', ok: true }, { kind: 'reset', id: 7 }])
  assert.equal(socket.written.length, 0, 'nothing has been sent back yet')

  // …and the client's own send goes out as one frame, terminated, with nobody above the codec
  // having decided that.
  transport.send({ op: 'hello' })
  assert.equal(socket.written.length, 1)
  assert.equal(socket.written[0], '{"op":"hello"}' + String.fromCharCode(10))
})
