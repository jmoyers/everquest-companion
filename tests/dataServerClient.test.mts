// THE CLIENT LIBRARY, PROVEN AGAINST THE COMMITTED CONVERSATION (JOS-468).
//
// `protocol/fixtures/01-05` are the verbatim truth of this protocol (owner ratification 17), and
// the Rust suite treats them the same way. So the acceptance test here is not a paraphrase of the
// plan doc: the fixtures are replayed into a real `EngineClient` over the memory transport, the
// messages the client emits are compared against the ones the fixtures say a client emits, and the
// MATERIALIZED WINDOW is asserted after every moment.
//
// TWO EDITS ARE MADE TO THE FIXTURE FRAMES, and only these two:
//
//   1. THE CORRELATION IDS ARE RE-ADDRESSED (`readdress`, and its argument is in the rig).
//   2. THE METER'S RESET IS STATED HERE. Fixture 03 is a moment MID-STREAM (a 10 Hz tick over
//      subscription 12) and the committed conversation carries no reset for that view, because the
//      plan doc did not need one to show a tick. A diff can only be asserted against a window, so
//      the two-row window it lands on is written down in this file rather than imagined into the
//      fixture directory.
//
// Fixture 01's reset carries "the first three of fifty rows" and elides the rest, which the second
// moment then leans on: its `drop` names a row the elision removed. That is not papered over — the
// client refuses an op naming a row it does not hold, says so, and this suite asserts exactly that
// before re-running the same moment over a window where the row IS present.
//
// The diff ops themselves and the epoch law get their own file: tests/dataServerDiff.test.mts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../scripts/protocolSchema.mjs'
import { createMemoryPair } from '../src/shared/dataServer/memoryTransport'
import { TransportError, type Transport } from '../src/shared/dataServer/transport'
import { EngineError, createEngineClient } from '../src/shared/dataServer/client'
import {
  TEST_TOKEN,
  clientTurns,
  engineTurns,
  fixture,
  flush,
  openView,
  readdress,
  rig,
  rowKeys,
  shakeHands
} from './dataServerRig.mjs'
import type {
  ClientMessage,
  DiffMessage,
  EchoRequest,
  EngineMessage,
  EpochMessage,
  Hello,
  Reply,
  ResetMessage,
  Row,
  SessionAttachRequest,
  ViewSubscribeRequest,
  ViewUnsubscribeRequest
} from '../src/shared/dataServer/protocol.generated'

const HELLO: Hello = { op: 'hello', token: TEST_TOKEN, protocolVersion: 1 }

// ---- 1. the handshake conversation, verbatim ----------------------------------------------------

test('THE CLIENT EMITS THE COMMITTED CONVERSATION, MESSAGE FOR MESSAGE', async () => {
  const doc = fixture('05-handshake.json')
  const expected = clientTurns(doc)
  const replies = engineTurns(doc)
  const hello = expected[0] as Hello

  // The token is the fixture's own throwaway sample, so the hello this client mints has to equal
  // the committed one exactly: op, token, protocol version, nothing else, and nothing before it.
  const r = rig(hello.token)
  assert.deepEqual(r.sent, [hello], 'hello is the FIRST message on the connection, always')
  assert.equal(r.client.state, 'connecting')
  r.deliver(replies[0])
  assert.equal(r.client.state, 'ready')

  const echo = r.client.request('echo', (expected[1] as EchoRequest).params)
  r.deliver(replies[1])
  assert.deepEqual(await echo, { text: 'hello engine' })

  const health = r.client.request('session.health', {})
  r.deliver(replies[2])
  assert.deepEqual(await health, { status: 'idle', epoch: 0, uptimeMs: 1420 })
  assert.equal(r.client.epoch, null, 'a REPLY does not announce a generation; an epoch frame does')

  const attach = r.client.request('session.attach', (expected[3] as SessionAttachRequest).params)
  r.deliver(replies[3])
  assert.deepEqual(await attach, { epoch: 1, accepted: true })

  const progress = r.client.request('session.progress', {})
  r.deliver(replies[4])
  assert.deepEqual(await progress, { subscription: 4, subscribed: true })

  // …and the refusal envelope: an unsubscribe naming a subscription that is not open.
  const gone = r.client.request('view.unsubscribe', (expected[5] as ViewUnsubscribeRequest).params)
  r.deliver(replies[5])
  await assert.rejects(gone, (error: unknown) => {
    assert.ok(error instanceof EngineError)
    assert.equal(error.code, 'notFound')
    assert.equal(error.message, 'no open subscription 7')
    return true
  })

  assert.deepEqual(r.sent, expected, 'the client wrote a different conversation than the fixture')
  assert.deepEqual(r.states, ['ready'], 'connecting is where a client starts, not a transition')
})

// ---- 2. the four moments ------------------------------------------------------------------------

test('THE FOUR PLAN-DOC MOMENTS MATERIALIZE THE WINDOW THE FIXTURES DESCRIBE', () => {
  const r = rig()
  shakeHands(r)

  // --- moment 01: subscribe → ack → reset
  const subscribeDoc = fixture('01-subscribe.json')
  const request = clientTurns(subscribeDoc)[0] as ViewSubscribeRequest
  const loot = openView(r, request.params)
  assert.deepEqual(
    r.sent[r.sent.length - 1],
    readdress(request, loot.id),
    'the subscribe the client wrote differs from the committed one'
  )
  assert.deepEqual(loot.handle.state, {
    rows: null,
    total: 0,
    epoch: null,
    loading: true,
    error: null
  })

  const opening = engineTurns(subscribeDoc)
  r.deliver(readdress(opening[0] as Reply, loot.id))
  const reset = opening[1] as ResetMessage
  r.deliver(readdress(reset, loot.id))

  assert.deepEqual(rowKeys(loot.handle.state), ['loot:9412', 'loot:9411', 'loot:9410'])
  assert.equal(loot.handle.state.total, 1834, 'total is the VIEW, not the window')
  assert.equal(loot.handle.state.epoch, 3)
  assert.equal(loot.handle.state.loading, false)
  assert.deepEqual(loot.handle.state.rows?.[0], reset.rows[0], 'a row arrives render-ready, intact')
  assert.equal(r.client.epoch, 3)

  // --- moment 02: a kill inserts before the newest row, and the oldest falls out of the fifty.
  const live = engineTurns(fixture('02-live-diff.json'))[0] as DiffMessage
  r.deliver(readdress(live, loot.id))
  assert.deepEqual(
    rowKeys(loot.handle.state),
    ['loot:9413', 'loot:9412', 'loot:9411', 'loot:9410'],
    'the insert did not land immediately before the anchor it named'
  )
  assert.equal(loot.handle.state.total, 1835, 'total moved, so the frame carried it')
  // The drop names loot:8790 — one of the forty-seven rows fixture 01 elides. An op naming a row
  // this window does not hold is refused with a note rather than guessed at.
  assert.equal(r.notes.length, 1, r.notes.join(' | '))
  assert.ok(r.notes[0].includes('loot:8790'), r.notes[0])

  // --- moment 03: a meter tick. The window it lands on is stated here (see the header).
  const meter = openView(r, { source: 'combat.live' })
  const meterRows: Row[] = [
    { key: 'ally:Primitive', cells: { name: 'Primitive', damage: 180000, dps: 400.1, share: 0.37 } },
    { key: 'ally:Rowel', cells: { name: 'Rowel', damage: 90000, dps: 210.4, share: 0.2 } }
  ]
  r.deliver({ kind: 'reset', id: meter.id, epoch: 3, total: 2, rows: meterRows })
  const tick = engineTurns(fixture('03-meter-tick.json'))[0] as DiffMessage
  r.deliver(readdress(tick, meter.id))

  assert.deepEqual(rowKeys(meter.handle.state), ['ally:Primitive', 'ally:Rowel', 'pet:Vibartik'])
  assert.deepEqual(
    meter.handle.state.rows?.[0].cells,
    { name: 'Primitive', damage: 184220, dps: 412.6, share: 0.38 },
    '`name` was absent from the update, which means UNCHANGED, never cleared'
  )
  assert.equal(meter.handle.state.total, 2, 'no total in the frame means the row count did not move')

  // --- moment 04: the epoch bump is connection-wide; both windows go, one comes back.
  const switchDoc = engineTurns(fixture('04-character-switch.json'))
  r.deliver(switchDoc[0] as EpochMessage)
  assert.equal(r.client.epoch, 4)
  assert.equal(loot.handle.state.rows, null, 'the loot window survived an epoch bump')
  assert.equal(loot.handle.state.loading, true)
  assert.equal(meter.handle.state.rows, null, 'the bump is connection-wide, not per subscription')
  // THE LOADING UI HEARS ALL FOUR COORDINATES (JOS-503). `pct` alone cannot be turned back into
  // "148.8 MB of 238.4 MB", so the mark and the size the fold divided by ride the same frame — the
  // schema's own `offset` vocabulary (`HealthMark.offset`, cache law 3), never a framing word.
  assert.deepEqual(
    r.progress,
    [{ pct: 62.4, events: 1571003, offset: 156000000, logSize: 250000000 }],
    'the loading UI heard nothing'
  )

  r.deliver(readdress(switchDoc[1] as ResetMessage, loot.id))
  assert.deepEqual(loot.handle.state, { rows: [], total: 0, epoch: 4, loading: false, error: null })
  assert.equal(meter.handle.state.loading, true, 'a view resets when ITS fold lands, not before')
})

test("the same moment over a window that holds fixture 01's elided rows", () => {
  const r = rig()
  shakeHands(r)
  const loot = openView(r, { source: 'loot.ledger', window: { offset: 0, limit: 4 } })
  const reset = engineTurns(fixture('01-subscribe.json'))[1] as ResetMessage
  r.deliver({
    ...reset,
    id: loot.id,
    rows: [...reset.rows, { key: 'loot:8790', cells: { item: 'a rusty dagger' } }]
  })
  assert.equal(loot.handle.state.rows?.length, 4)

  r.deliver(readdress(engineTurns(fixture('02-live-diff.json'))[0] as DiffMessage, loot.id))
  assert.deepEqual(rowKeys(loot.handle.state), ['loot:9413', 'loot:9412', 'loot:9411', 'loot:9410'])
  assert.deepEqual(r.notes, [], 'nothing should have been refused this time')
})

// ---- 3. reconnection, refusal, failure ----------------------------------------------------------

test('A NEW TRANSPORT IS A FULL RE-HELLO AND A RE-SUBSCRIBE OF EVERYTHING', () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'loot.ledger', filter: { session: 'current' } })
  r.deliver({ kind: 'reset', id: view.id, epoch: 3, total: 1, rows: [{ key: 'a', cells: {} }] })
  assert.deepEqual(rowKeys(view.handle.state), ['a'])

  // The engine died and came back. Main hands the client a new connection.
  const second = createMemoryPair<ClientMessage, EngineMessage>()
  const sent: ClientMessage[] = []
  second.b.onMessage((m) => sent.push(m))
  r.client.attach(second.a)

  assert.equal(r.client.state, 'connecting')
  assert.equal(view.handle.state.rows, null, 'resume is re-query: the old window must be dropped')
  assert.equal(r.client.epoch, null)
  assert.deepEqual(sent, [HELLO])

  second.b.send(engineTurns(fixture('05-handshake.json'))[0])
  const resubscribe = sent[1] as ViewSubscribeRequest
  assert.equal(resubscribe.op, 'view.subscribe')
  assert.deepEqual(resubscribe.params, { source: 'loot.ledger', filter: { session: 'current' } })
  assert.notEqual(resubscribe.id, view.id, 'a fresh id, so late frames for the old one cannot land')

  // A frame still in flight for the OLD id is now an unknown subscription, exactly as intended.
  second.b.send({ kind: 'reset', id: view.id, epoch: 9, total: 1, rows: [{ key: 'ghost', cells: {} }] })
  assert.equal(view.handle.state.rows, null)
  second.b.send({ kind: 'reset', id: resubscribe.id, epoch: 9, total: 1, rows: [{ key: 'b', cells: {} }] })
  assert.deepEqual(rowKeys(view.handle.state), ['b'])
})

test('a request made before the handshake lands is queued, not lost', async () => {
  const r = rig()
  const echo = r.client.request('echo', { text: 'early' })
  assert.deepEqual(r.sent, [HELLO], 'nothing may precede the handshake')
  shakeHands(r)
  assert.deepEqual(r.sent[1], { id: 1, op: 'echo', params: { text: 'early' } })
  r.deliver({ kind: 'reply', id: 1, ok: true, result: { text: 'early' } })
  assert.deepEqual(await echo, { text: 'early' })
})

test('a subscription opened before the handshake opens when it lands', () => {
  const r = rig()
  const view = r.client.subscribe({ source: 'loot.ledger' }, () => undefined)
  assert.equal(view.state.loading, true)
  shakeHands(r)
  const opened = r.sent[1] as ViewSubscribeRequest
  assert.equal(opened.op, 'view.subscribe')
  assert.deepEqual(opened.params, { source: 'loot.ledger' })
})

test('a protocol version the engine does not share is fatal at hello', () => {
  const r = rig()
  r.deliver({ kind: 'hello', ok: true, engineVersion: '0.1.0', protocolVersion: 99 })
  assert.equal(r.client.state, 'failed')
  assert.equal(r.transport.closed, false, 'the APP end closes; the engine end is not ours to close')
})

test('a refused handshake is failed, and in-flight requests reject typed', async () => {
  const r = rig()
  const echo = r.client.request('echo', { text: 'doomed' })
  r.deliver({ kind: 'hello', ok: false, engineVersion: '0.1.0', protocolVersion: 1 })
  assert.equal(r.client.state, 'failed')
  await assert.rejects(echo, (error: unknown) => {
    assert.ok(error instanceof EngineError)
    assert.equal(error.code, 'unauthorized')
    return true
  })
  await assert.rejects(r.client.request('echo', { text: 'later' }), EngineError)
})

test('a refused subscription is the VIEW-s error, not the connection-s', async () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'no.such.source' })
  r.deliver({
    kind: 'error',
    id: view.id,
    ok: false,
    error: { code: 'notFound', message: 'unknown source' }
  })
  await flush() // a refusal reaches a view through a promise
  assert.equal(r.client.state, 'ready', 'one bad view must not take the connection down')
  assert.equal(view.handle.state.loading, false, 'a view that will never load is not loading')
  assert.equal(view.handle.state.error?.code, 'notFound')
  assert.equal(view.handle.state.rows, null)
})

test('a transport failure flips the state and rejects everything in flight', async () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'loot.ledger' })
  r.deliver({ kind: 'reset', id: view.id, epoch: 3, total: 1, rows: [{ key: 'a', cells: {} }] })
  const pending = r.client.request('session.health', {})

  r.transport.close() // the engine's end of the socket went away
  await assert.rejects(r.client.request('echo', { text: 'into the void' }), EngineError)

  assert.equal(r.client.state, 'failed')
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof EngineError)
    assert.equal(error.code, 'unavailable')
    return true
  })
  // The rows a user is reading are NOT blanked by a socket — they were true as of the last frame.
  // The DROP happens at the reconnect, which is where the epoch law puts it. That holds even though
  // this subscription's own ack never arrived and its request is one of the ones just rejected.
  await flush()
  assert.deepEqual(rowKeys(view.handle.state), ['a'])
  assert.equal(view.handle.state.error?.code, 'unavailable')
  assert.deepEqual(r.states, ['ready', 'failed'])
})

test('a transport that reports its own failure is the same outcome', async () => {
  // What a real socket does: the codec notices a half-written frame and raises on its error
  // channel rather than on a send. Both paths have to land in the same place.
  let fail: (error: TransportError) => void = () => undefined
  const transport: Transport<ClientMessage, EngineMessage> = {
    send: () => undefined,
    onMessage: () => undefined,
    onError: (handler) => {
      fail = handler
    },
    close: () => undefined,
    closed: false
  }
  const client = createEngineClient({ token: TEST_TOKEN })
  client.attach(transport)
  const pending = client.request('session.health', {})
  fail(new TransportError('decode', 'a truncated final frame'))
  assert.equal(client.state, 'failed')
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof EngineError)
    assert.equal(error.code, 'unavailable')
    assert.ok(error.cause instanceof TransportError, 'the transport error was thrown away')
    return true
  })
})

test('closing the client rejects what is in flight and stops answering', async () => {
  const r = rig()
  shakeHands(r)
  const pending = r.client.request('session.health', {})
  r.client.close()
  assert.equal(r.client.state, 'closed')
  await assert.rejects(pending, EngineError)
  await assert.rejects(r.client.request('echo', { text: 'after' }), EngineError)
})

test('unsubscribing says so on the wire and stops the listener', () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'loot.ledger' })
  r.deliver({ kind: 'reset', id: view.id, epoch: 1, total: 0, rows: [] })
  const seen = view.states.length
  view.handle.close()

  const last = r.sent[r.sent.length - 1] as ViewUnsubscribeRequest
  assert.equal(last.op, 'view.unsubscribe')
  assert.deepEqual(last.params, { subscription: view.id })
  r.deliver({ kind: 'reset', id: view.id, epoch: 1, total: 1, rows: [{ key: 'late', cells: {} }] })
  assert.equal(view.states.length, seen, 'a closed subscription is still being told things')
  view.handle.close() // idempotent
})

test('a reply carrying another op-s result shape is refused', async () => {
  // The registry is a CLAIM about what the engine answers with. This is the cheapest check that it
  // kept its side of the bargain, and it turns a wrong shape into a typed rejection rather than a
  // caller reading a field that is not there.
  const r = rig()
  shakeHands(r)
  const health = r.client.request('session.health', {})
  r.deliver({ kind: 'reply', id: 1, ok: true, result: { text: 'this is an echo result' } })
  await assert.rejects(health, (error: unknown) => {
    assert.ok(error instanceof EngineError)
    assert.equal(error.code, 'internal')
    return true
  })
})

// ---- 4. the two laws, asserted over the source ---------------------------------------------------

test('THE CLIENT AND THE HOOK CANNOT SORT, FILTER OR AGGREGATE (owner ruling 4)', () => {
  const files = [
    join(ROOT, 'src', 'shared', 'dataServer', 'client.ts'),
    join(ROOT, 'src', 'renderer', 'src', 'lib', 'useView.ts')
  ]
  const banned = /\.(sort|filter|reduce|reduceRight|flatMap|group)\(/
  for (const file of files) {
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      banned,
      `${file} derives something from the rows it was sent - views arrive render-ready`
    )
  }
})

test('the transport is the only thing the client knows about the wire', () => {
  const source = readFileSync(join(ROOT, 'src', 'shared', 'dataServer', 'client.ts'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(code.includes('TransportError'), 'the comment stripper ate the code')
  for (const framing of ['socket', 'Socket', 'port', 'DELIMITER', 'ndjson', 'byteLength']) {
    assert.equal(new RegExp(`\\b${framing}\\b`).test(code), false, `client.ts names \`${framing}\``)
  }
})
