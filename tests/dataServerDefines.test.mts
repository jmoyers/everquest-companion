// THE PUSH AND THE FIRE, APP SIDE (JOS-482).
//
// Two directions the connect-and-serve wave did not have: the app tells the engine the five things
// the fold knows that the log never said (boundary verdict 3), and the engine tells the app that an
// alert fired (owner ruling 22).
//
// THE COMMITTED CONVERSATION IS THE ACCEPTANCE TEST, exactly as it is for the subscribe moments:
// `protocol/fixtures/07-defines-and-fires.json` is what a real connection says on connect, and this
// suite replays it into a real `EngineClient` over the memory transport — the client's own requests
// are compared against the ones the fixture says a client sends, the acks are resolved through the
// closed op registry, and the fire is asserted where it lands.
//
// WHAT IS PROVEN HERE AND WHAT IS NOT. The wire half is here: the five ops travel, their answers
// narrow, a fire reaches a listener without touching a window or the epoch, and the PUSH-ON-CHANGE
// seam calls exactly once per preference write and is silent when no engine is armed. The half that
// is NOT here is what the ENGINE does with a push — `engine/crates/fold`'s own suite has one worked
// example per family, and `engine/crates/engined/tests/defines.rs` drives all five over a real
// socket against a real fold.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFINE_OPS,
  pushAppKnowledge,
  pushLogDir,
  setAppKnowledgePusher,
  setLogDirPusher,
  type DefineOp
} from '../src/main/dataServer/definePush'
import {
  clientTurns,
  engineTurns,
  fixture,
  flush,
  openView,
  rig,
  shakeHands
} from './dataServerRig.mjs'
import type {
  ClientMessage,
  DefineAck,
  FireMessage
} from '../src/shared/dataServer/protocol.generated'

const MOMENT = '07-defines-and-fires.json'

/** The fixture's own client turns, minus the handshake it does not carry. */
function pushes(): ClientMessage[] {
  return clientTurns(fixture(MOMENT)).filter((m) => 'op' in m && m.op.endsWith('.define'))
}

/** The engine's answer to the request with this id, out of the committed conversation. */
function answerTo(id: number): DefineAck {
  for (const message of engineTurns(fixture(MOMENT))) {
    if (message.kind === 'reply' && message.id === id) return message.result as DefineAck
  }
  throw new Error(`the fixture carries no reply to ${String(id)}`)
}

// ---- the five commands, over the wire ----------------------------------------------------------

test('THE APP PUSHES ALL FIVE FAMILIES and each answer narrows through the op registry', async () => {
  const r = rig()
  shakeHands(r)

  const committed = pushes()
  assert.equal(committed.length, 5, 'the committed conversation pushes every family')

  const acks: DefineAck[] = []
  for (const push of committed) {
    assert.ok('op' in push && 'id' in push)
    const op = push.op as DefineOp
    // The params are the FIXTURE's, so what this client puts on the wire is compared against a
    // committed byte sequence rather than against something this file made up.
    const pending = r.client.request(op, push.params as never)
    const sent = r.sent[r.sent.length - 1]
    assert.deepEqual(
      sent,
      { ...push, id: (sent as { id: number }).id },
      `${op} did not reach the wire as the fixture spells it`
    )
    r.deliver({
      kind: 'reply',
      id: (sent as { id: number }).id,
      ok: true,
      result: answerTo(push.id as number)
    })
    acks.push((await pending) as DefineAck)
  }

  // `applied` is pinned true by the schema; `count` is the entries taken for a LIST payload and
  // ABSENT for the two families that push one object. A client can therefore check its own push
  // against the answer wherever there is something to count, and knows there is not where there
  // is not.
  //
  // THE ALERTS PUSH CARRIES TWO DEFS SINCE JOS-500, and the number tracks the fixture rather than
  // this file's memory of it: the second def is what makes the fire frames downstream able to show
  // a capture map, a resolved spell and an early warning's deadline, which needs a def with a
  // pattern, a phrase and an offset on it. The shape of the claim is unchanged — a LIST family
  // counts what it took, an OBJECT family has nothing to count.
  assert.deepEqual(
    acks.map((a) => a.count),
    [2, undefined, undefined, 1, 1]
  )
  assert.ok(acks.every((a) => a.applied))
})

test('THE OP LIST AND THE WIRE CANNOT DRIFT — every family the app knows is a command the schema has', () => {
  // `DEFINE_OPS` is what `engineClientHost` iterates on connect, and it is spelled as op names on
  // purpose. If the schema grew a sixth `*.define` and this list did not, a family would be pushed
  // by nobody — which is a preference that silently stops reaching the engine.
  const fromSchema = new Set(
    clientTurns(fixture(MOMENT))
      .filter((m) => 'op' in m && m.op.endsWith('.define'))
      .map((m) => (m as { op: string }).op)
  )
  assert.deepEqual(new Set(DEFINE_OPS), fromSchema)
})

// ---- the fires ---------------------------------------------------------------------------------

test('A FIRE REACHES ITS LISTENER FULLY RESOLVED, and the app needs nothing else to play it', () => {
  const r = rig()
  shakeHands(r)
  const heard: FireMessage[] = []
  r.client.onFire((fire) => heard.push(fire))

  const committed = engineTurns(fixture(MOMENT)).find((m) => m.kind === 'fire')
  assert.ok(committed, 'the committed conversation carries a fire')
  r.deliver(committed)

  assert.deepEqual(heard, [committed])
  const [fire] = heard
  // THE CONCARD PRINCIPLE, checked as a shape: the sound is the KEY the renderer's cache is keyed
  // by, not a reference the app would have to look a definition back up for.
  assert.match(fire.sound, /^[^/]+\/[^/]+$/)
  assert.ok(fire.rule.length > 0 && fire.message.length > 0)
})

test('A FIRE TOUCHES NO WINDOW AND NO EPOCH — it is a thing that happened, not state', async () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'loot.ledger' })
  r.deliver({ kind: 'reply', id: view.id, ok: true, result: { subscription: view.id, subscribed: true } })
  r.deliver({
    kind: 'reset',
    id: view.id,
    epoch: 3,
    total: 1,
    rows: [{ key: 'loot:1', cells: { item: 'Cloak of Flames' } }]
  })
  await flush()
  const before = view.states[view.states.length - 1]
  assert.deepEqual(before.rows?.map((row) => row.key), ['loot:1'])
  assert.equal(r.client.epoch, 3)

  const framesBefore = view.states.length
  r.deliver({
    kind: 'fire',
    at: 1787181707000,
    rule: 'Charm break',
    sound: 'classic/bell',
    message: 'Your charm spell has worn off.'
  })

  assert.equal(view.states.length, framesBefore, 'no subscription was disturbed')
  assert.equal(r.client.epoch, 3, 'and the generation did not move')
  assert.deepEqual(r.notes, [], 'a fire is not a frame the client had to drop')
})

test('A FIRE WITH NOBODY LISTENING IS DROPPED IN SILENCE — an alert is not a thing to replay', () => {
  const r = rig()
  shakeHands(r)
  r.deliver({
    kind: 'fire',
    at: 1,
    rule: 'Charm break',
    sound: 'classic/bell',
    message: 'x'
  })
  assert.deepEqual(r.notes, [])
  assert.equal(r.client.state, 'ready')
})

test('a listener can let go, and stops hearing', () => {
  const r = rig()
  shakeHands(r)
  const heard: FireMessage[] = []
  const stop = r.client.onFire((fire) => heard.push(fire))
  const frame: FireMessage = {
    kind: 'fire',
    at: 1,
    rule: 'Charm break',
    sound: 'classic/bell',
    message: 'x'
  }
  r.deliver(frame)
  stop()
  r.deliver(frame)
  assert.equal(heard.length, 1)
})

// ---- push on change ----------------------------------------------------------------------------

test('PUSH ON CHANGE: a preference write announces exactly one family, and only when armed', () => {
  // THE SILENT CASE FIRST, because it is the one every launch takes. `EQC_ENGINE` unset means
  // `installEngineClient` was never called, so the slot is empty and a preference write costs one
  // null check — the same shape `pipeline.ts`'s world-rebuilt observer has.
  setAppKnowledgePusher(null)
  for (const op of DEFINE_OPS) pushAppKnowledge(op)

  const announced: DefineOp[] = []
  setAppKnowledgePusher((op) => announced.push(op))
  pushAppKnowledge('alerts.define')
  pushAppKnowledge('roster.define')
  pushAppKnowledge('alerts.define')
  assert.deepEqual(announced, ['alerts.define', 'roster.define', 'alerts.define'])

  // …AND LETTING GO IS COMPLETE. A respawned engine installs a fresh pusher and `stopEngineClient`
  // clears it; a write between the two must reach nobody rather than the client that is gone.
  setAppKnowledgePusher(null)
  pushAppKnowledge('combo.define')
  assert.equal(announced.length, 3)
})

test('a family announced twice is announced twice — the coalescing is the ENGINE’s, not this seam’s', () => {
  // A define is an idempotent full-set replace, so two pushes of one family leave what one push
  // would leave. That is a property of the COMMAND, and deduping here would be this seam deciding
  // that a write it cannot see the contents of did not matter.
  const announced: DefineOp[] = []
  setAppKnowledgePusher((op) => announced.push(op))
  pushAppKnowledge('respawn.define')
  pushAppKnowledge('respawn.define')
  setAppKnowledgePusher(null)
  assert.deepEqual(announced, ['respawn.define', 'respawn.define'])
})

test('THE LOG-DIRECTORY SLOT IS ITS OWN SLOT, and it is not a sixth define (JOS-498)', () => {
  // Owner ruling 21 / decision sheet 1a: the app names the directory and pushes it. It gets the same
  // mechanism as the five families — a registration, so `session.ts` can say "the EQ dir moved"
  // without importing the engine client that imports it back — and deliberately not the same LIST.
  // The five are FOLD inputs, re-applied at every attach's construction and part of ruling 18's
  // cache key; a directory changes no fold, and putting it in `DEFINE_OPS` would have made
  // `pushAllDefines` state it before every attach as though it did.
  assert.equal(
    (DEFINE_OPS as readonly string[]).includes('logs.setDir'),
    false,
    'logs.setDir is not a member of the define family'
  )

  // SILENT WITH NO ENGINE, exactly as `pushAppKnowledge` is: a launch that armed no client pays one
  // null check per settings change.
  setLogDirPusher(null)
  pushLogDir()

  let announced = 0
  setLogDirPusher(() => {
    announced += 1
  })
  pushLogDir()
  pushLogDir()
  // TWO PUSHES ARE TWO PUSHES. The command is an idempotent full-set replace of one value, so the
  // second leaves what the first left — which is the ENGINE's business, and a seam that deduped here
  // would be deciding that a write it cannot see the contents of did not matter.
  assert.equal(announced, 2)

  // …and letting go is complete: `stopEngineClient` clears it, and a settings change between a
  // teardown and the next connection must reach nobody rather than a client that is gone.
  setLogDirPusher(null)
  pushLogDir()
  assert.equal(announced, 2)
})
