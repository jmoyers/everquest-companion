// THE TRANSPORT SEAM, PROVEN (JOS-464).
//
// The owner's constraint on this protocol, verbatim: "lets make sure the way this works we could
// change the wire method at a later date and need to just swap an artifact. im thinking over the
// open internet via websockets etc."
//
// The structural answer is that protocol logic talks to a `Transport` and exactly one module below
// it knows what a frame is. A claim like that is cheap to make and easy to break silently, so this
// suite makes it a MEASUREMENT rather than a comment:
//
//   1. ONE CONVERSATION, TWO ADAPTERS. The committed fixtures — the real handshake, a real
//      subscribe, a real reset, real diffs — are replayed over a transport with NO bytes in it at
//      all and over the NDJSON codec, and the two are asserted to deliver identical messages. Code
//      that survives having its framing removed was not depending on the framing.
//   2. THE FRAMING IS WHERE IT SAYS IT IS. Every other file in src/shared/dataServer is read and
//      checked for a newline literal. That is the assertion that keeps the seam honest as the
//      directory grows.
//   3. THE FRAMING CANNOT BE FORGED FROM ABOVE. A message whose payload is full of newlines still
//      travels as exactly one frame, because JSON escapes control characters — a property of the
//      format, not of this app's data, and therefore worth pinning once.
//
// `engine/crates/protocol/tests/transport.rs` is the mirror of this file on the Rust side, over the
// same fixtures, with the same three claims.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_DIR, ROOT, readFixtureNames } from '../scripts/protocolSchema.mjs'
import type { ClientMessage, EngineMessage } from '../src/shared/dataServer/protocol.generated'
import { createMemoryPair } from '../src/shared/dataServer/memoryTransport'
import {
  DELIMITER,
  LineDecoder,
  MAX_LINE_CHARS,
  createNdjsonTransport,
  decodeLine,
  encodeLine,
  type ByteChannel
} from '../src/shared/dataServer/ndjson'
import { TransportError, type Transport } from '../src/shared/dataServer/transport'

// ---- the conversation, read from the committed fixtures -----------------------------------------

interface Conversation {
  client: ClientMessage[]
  engine: EngineMessage[]
}

function conversation(): Conversation {
  const client: ClientMessage[] = []
  const engine: EngineMessage[] = []
  for (const name of readFixtureNames()) {
    const doc = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as {
      messages: { dir: 'client' | 'engine'; message: unknown }[]
    }
    for (const frame of doc.messages) {
      if (frame.dir === 'client') client.push(frame.message as ClientMessage)
      else engine.push(frame.message as EngineMessage)
    }
  }
  assert.ok(client.length >= 6 && engine.length >= 6, 'the conversation is too thin to prove anything')
  return { client, engine }
}

/** A byte channel that is just a pair of arrays — the smallest thing NDJSON can sit on. */
function pipe(): { channel: ByteChannel; written: string[]; deliver: (chunk: string) => void; end: () => void } {
  const written: string[] = []
  let onData: ((chunk: string) => void) | undefined
  let onClose: ((error?: unknown) => void) | undefined
  return {
    written,
    deliver: (chunk) => onData?.(chunk),
    end: () => onClose?.(),
    channel: {
      write: (chunk) => {
        written.push(chunk)
      },
      onData: (handler) => {
        onData = handler
      },
      onClose: (handler) => {
        onClose = handler
      },
      close: () => {
        /* the array pipe has nothing to release */
      }
    }
  }
}

function drain<Out, In>(transport: Transport<Out, In>): In[] {
  const heard: In[] = []
  transport.onMessage((message) => heard.push(message))
  transport.onError((error) => {
    throw error
  })
  return heard
}

// ---- 1. one conversation, two adapters ----------------------------------------------------------

test('THE SAME CONVERSATION SURVIVES BOTH TRANSPORTS IDENTICALLY', () => {
  const { client, engine } = conversation()

  // --- with no bytes at all
  const pair = createMemoryPair<ClientMessage, EngineMessage>()
  const heardByEngine = drain(pair.b)
  const heardByApp = drain(pair.a)
  for (const message of client) pair.a.send(message)
  for (const message of engine) pair.b.send(message)

  // --- and over a real wire with a real delimiter
  const toEngine = pipe()
  const toApp = pipe()
  const appSide = createNdjsonTransport<ClientMessage, EngineMessage>(toEngine.channel)
  const engineSide = createNdjsonTransport<EngineMessage, ClientMessage>(toApp.channel)
  for (const message of client) appSide.send(message)
  for (const message of engine) engineSide.send(message)

  // …and read back off that wire, by a transport that was handed nothing but bytes.
  const engineInbox = pipe()
  const ndHeardByEngine = drain(createNdjsonTransport<EngineMessage, ClientMessage>(engineInbox.channel))
  for (const chunk of toEngine.written) engineInbox.deliver(chunk)

  const appInbox = pipe()
  const ndHeardByApp = drain(createNdjsonTransport<ClientMessage, EngineMessage>(appInbox.channel))
  for (const chunk of toApp.written) appInbox.deliver(chunk)

  assert.deepEqual(heardByEngine, client, 'the memory transport lost a client turn')
  assert.deepEqual(heardByApp, engine, 'the memory transport lost an engine turn')
  assert.deepEqual(ndHeardByEngine, client, 'ndjson lost a client turn')
  assert.deepEqual(ndHeardByApp, engine, 'ndjson lost an engine turn')
  assert.deepEqual(heardByEngine, ndHeardByEngine, 'the two adapters disagree')
  assert.deepEqual(heardByApp, ndHeardByApp, 'the two adapters disagree')
})

test('the framing is exactly one message per line, and the last one is terminated', () => {
  const { engine } = conversation()
  const wire = pipe()
  const transport = createNdjsonTransport<EngineMessage, ClientMessage>(wire.channel)
  for (const message of engine) transport.send(message)

  const bytes = wire.written.join('')
  assert.equal(
    [...bytes].filter((c) => c === DELIMITER).length,
    engine.length,
    'one delimiter per message, no more and no fewer'
  )
  assert.ok(bytes.endsWith(DELIMITER), 'every frame is terminated')
  for (const line of bytes.split(DELIMITER).filter((l) => l !== '')) {
    JSON.parse(line)
  }
})

// ---- 2. the framing is where it says it is ------------------------------------------------------

test('ndjson.ts IS THE ONLY FILE IN src/shared/dataServer THAT KNOWS A NEWLINE EXISTS', () => {
  // The seam's structural claim, asserted directly. The check is over ESCAPE LITERALS rather than
  // over prose: the other files have to be able to EXPLAIN why framing is absent, which is not the
  // same as containing one.
  const dir = join(ROOT, 'src', 'shared', 'dataServer')
  const files = readdirSync(dir).filter((n) => n.endsWith('.ts'))
  assert.ok(files.length >= 4, 'the directory is smaller than expected — is the path right?')

  const literal = /(['"`])\\r?\\n\1|String\.fromCharCode\(\s*10\s*\)|\\u000a/i
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8')
    if (name === 'ndjson.ts') {
      assert.match(source, /DELIMITER = '\\n'/, 'the codec no longer names its own delimiter')
      continue
    }
    assert.doesNotMatch(
      source,
      literal,
      `${name} carries a newline literal — framing belongs in ndjson.ts alone`
    )
  }
})

test('the generated types carry no framing either — the schema never gave them any', () => {
  // Over the CODE, not the prose: a doc comment is allowed to explain that the socket and its
  // framing live elsewhere (the `Token` description does exactly that), and saying so is the
  // opposite of declaring it. What must not exist is a field or a constant.
  const generated = readFileSync(join(ROOT, 'src', 'shared', 'dataServer', 'protocol.generated.ts'), 'utf8')
  const code = generated.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(code.includes('export type ProtocolMessage'), 'the comment stripper ate the code')
  for (const framing of ['DELIMITER', 'MAX_LINE', 'socket', 'Socket', 'port', 'byteLength', 'frame']) {
    assert.equal(
      new RegExp(`\\b${framing}\\b`).test(code),
      false,
      `the generated types declare \`${framing}\` — framing belongs in a transport adapter`
    )
  }
})

// ---- 3. the framing cannot be forged from above -------------------------------------------------

test('a payload full of newlines cannot forge a frame', () => {
  const hostile = 'line one\nline two\r\n{"kind":"epoch"}\n\n'
  const message = {
    kind: 'reset',
    id: 1,
    epoch: 0,
    total: 1,
    rows: [{ key: 'row:1', cells: { text: hostile } }]
  } satisfies EngineMessage

  const line = encodeLine(message)
  assert.equal([...line].filter((c) => c === DELIMITER).length, 1, 'the only newline is the terminator')
  assert.deepEqual(decodeLine(line.slice(0, -1)), message, 'the hostile payload came back intact')
})

test('a message split across arbitrary chunk boundaries still arrives whole', () => {
  // A codec that only works when each read lands on a frame boundary works on a test double and
  // fails on a socket. So the whole wire is fed one CHARACTER at a time.
  const { engine } = conversation()
  const wire = pipe()
  const writer = createNdjsonTransport<EngineMessage, ClientMessage>(wire.channel)
  for (const message of engine) writer.send(message)
  const bytes = wire.written.join('')

  const reader = pipe()
  const transport = createNdjsonTransport<EngineMessage, EngineMessage>(reader.channel)
  const heard = drain(transport)
  for (const char of bytes) reader.deliver(char)
  assert.deepEqual(heard, engine, 'character-by-character delivery lost a message')
})

test('a CRLF-framing peer is still understood', () => {
  const reader = pipe()
  const transport = createNdjsonTransport<EngineMessage, EngineMessage>(reader.channel)
  const heard = drain(transport)
  reader.deliver('{"kind":"epoch","epoch":2,"reason":"restart"}\r\n')
  assert.equal(heard.length, 1)
  assert.equal(heard[0].kind, 'epoch')
})

test('a truncated final frame is an error rather than a quiet nothing', () => {
  // Half a message discarded in silence is how a client ends up rendering a world nobody sent.
  const reader = pipe()
  const transport = createNdjsonTransport<EngineMessage, EngineMessage>(reader.channel)
  const errors: TransportError[] = []
  transport.onMessage(() => assert.fail('nothing complete arrived'))
  transport.onError((e) => errors.push(e))
  reader.deliver('{"kind":"epoch","epoch":2,"rea')
  reader.end()
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'decode')
  assert.equal(transport.closed, true)
})

test('a frame that is not a message closes the transport instead of being skipped', () => {
  const reader = pipe()
  const transport = createNdjsonTransport<EngineMessage, EngineMessage>(reader.channel)
  const errors: TransportError[] = []
  transport.onMessage(() => assert.fail('garbage must not be delivered'))
  transport.onError((e) => errors.push(e))
  reader.deliver('not json at all\n')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'decode')
})

test('an unterminated flood is refused at the framing limit', () => {
  // A peer that never sends a delimiter would otherwise grow the buffer without bound — on
  // loopback, a one-line denial of service. The limit is a FRAMING concern and lives in the codec,
  // not in the protocol.
  const decoder = new LineDecoder(64)
  assert.deepEqual(decoder.push('a'.repeat(32)), [])
  assert.throws(
    () => decoder.push('a'.repeat(64)),
    (e: unknown) => e instanceof TransportError && e.code === 'frameTooLarge'
  )
  assert.ok(MAX_LINE_CHARS > 1_000_000, 'the real limit is far above any legitimate message')
})

test('a blank line between frames is skipped rather than fatal', () => {
  const reader = pipe()
  const transport = createNdjsonTransport<EngineMessage, EngineMessage>(reader.channel)
  const heard = drain(transport)
  reader.deliver('\n{"kind":"epoch","epoch":1,"reason":"attach"}\n\n')
  assert.equal(heard.length, 1)
})

// ---- 4. the memory transport is a real transport, not a stub ------------------------------------

test('the memory transport still enforces what the wire would', () => {
  const pair = createMemoryPair<{ when: unknown }, unknown>()
  drain(pair.b)
  // A value that cannot survive JSON cannot survive this transport either — which is the whole
  // reason it clones through JSON instead of passing a reference.
  assert.throws(() => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    pair.a.send({ when: cyclic })
  }, TransportError)

  pair.a.close()
  assert.equal(pair.a.closed, true)
  assert.throws(() => pair.a.send({ when: 1 }), TransportError)
  pair.a.close() // idempotent
})

test('sending into a closed peer is refused, not dropped', () => {
  const pair = createMemoryPair<number, number>()
  drain(pair.b)
  pair.b.close()
  assert.throws(
    () => pair.a.send(1),
    (e: unknown) => e instanceof TransportError && e.code === 'closed'
  )
})
