/**
 * dataServerRig.mts — one EngineClient, one memory transport, and a record of everything.
 *
 * Shared by `dataServerClient.test.mts` (the committed conversations and the connection's
 * lifecycle) and `dataServerDiff.test.mts` (the diff ops and the epoch law). It is a helper module
 * rather than a test file for the same reason `hookHost.mts` is: two suites need it, and neither
 * one owns it.
 *
 * DELIVERY IS SYNCHRONOUS, because the memory transport is (see its header) — so a protocol
 * conversation reads as a straight line here, with `await` needed only where a REQUEST's promise is
 * the thing under test.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_DIR } from '../scripts/protocolSchema.mjs'
import { createMemoryPair } from '../src/shared/dataServer/memoryTransport'
import type { Transport } from '../src/shared/dataServer/transport'
import {
  createEngineClient,
  type ConnectionState,
  type EngineClient,
  type ViewHandle,
  type ViewState
} from '../src/shared/dataServer/client'
import type {
  ClientMessage,
  EngineMessage,
  FoldProgress,
  ViewDescriptor,
  ViewSubscribeRequest
} from '../src/shared/dataServer/protocol.generated'

export interface FixtureDoc {
  moment: string
  messages: { dir: 'client' | 'engine'; message: unknown }[]
}

export function fixture(name: string): FixtureDoc {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as FixtureDoc
}

export function clientTurns(doc: FixtureDoc): ClientMessage[] {
  const turns: ClientMessage[] = []
  for (const frame of doc.messages) {
    if (frame.dir === 'client') turns.push(frame.message as ClientMessage)
  }
  return turns
}

export function engineTurns(doc: FixtureDoc): EngineMessage[] {
  const turns: EngineMessage[] = []
  for (const frame of doc.messages) {
    if (frame.dir === 'engine') turns.push(frame.message as EngineMessage)
  }
  return turns
}

/**
 * Re-address one committed stream frame to the id THIS client chose. `id` is a client-chosen
 * correlation number — the fixtures' 7 and 12 are the plan doc author's picks, not an engine's — so
 * this is the one edit a replay is allowed to make. Every other byte is delivered as committed.
 */
export function readdress<M extends { id: number }>(message: M, id: number): M {
  return { ...message, id }
}

export const TEST_TOKEN = 'a'.repeat(64)

export interface Rig {
  readonly client: EngineClient
  /** Everything the client put on the wire, in order. */
  readonly sent: ClientMessage[]
  /** Every dropped frame and refused op the client noted. */
  readonly notes: string[]
  readonly states: ConnectionState[]
  readonly progress: FoldProgress[]
  /** The ENGINE's end of the connection. */
  readonly transport: Transport<EngineMessage, ClientMessage>
  deliver(message: EngineMessage): void
}

export function rig(token = TEST_TOKEN): Rig {
  const pair = createMemoryPair<ClientMessage, EngineMessage>()
  const sent: ClientMessage[] = []
  const notes: string[] = []
  const states: ConnectionState[] = []
  const progress: FoldProgress[] = []
  pair.b.onMessage((message) => sent.push(message))
  const client = createEngineClient({ token, debug: (note) => notes.push(note) })
  client.onState((state) => states.push(state))
  client.onProgress((tick) => progress.push(tick))
  client.attach(pair.a)
  return {
    client,
    sent,
    notes,
    states,
    progress,
    transport: pair.b,
    deliver: (message) => {
      pair.b.send(message)
    }
  }
}

/** Complete the handshake with the reply the committed conversation actually carries. */
export function shakeHands(r: Rig): void {
  r.deliver(engineTurns(fixture('05-handshake.json'))[0])
  assert.equal(r.client.state, 'ready')
}

export interface OpenView {
  /** The id the CLIENT picked for this subscription — which its frames will carry. */
  readonly id: number
  /** Every state the listener was handed, in order. */
  readonly states: ViewState[]
  readonly handle: ViewHandle
}

/** Open one subscription over a connection that is up, and read back the id it was given. */
export function openView(r: Rig, descriptor: ViewDescriptor): OpenView {
  const states: ViewState[] = []
  const handle = r.client.subscribe(descriptor, (view) => states.push(view))
  const last = r.sent[r.sent.length - 1] as ViewSubscribeRequest
  assert.equal(last.op, 'view.subscribe', 'the subscription never reached the wire')
  return { id: last.id, states, handle }
}

/**
 * Let the microtask queue drain. Delivery is synchronous, but a REFUSAL reaches a view through a
 * promise rejection, so a view's error lands one tick after the frame that caused it.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function rowKeys(view: ViewState): string[] {
  const keys: string[] = []
  for (const row of view.rows ?? []) keys.push(row.key)
  return keys
}
