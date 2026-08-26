// A connected transport pair with no bytes in it.
//
// WHY THIS IS NOT A TOY. The seam's claim is that protocol logic never touches framing. A claim
// like that is only worth something if something can run WITHOUT any framing at all — so
// `tests/dataServerTransport.test.mts` drives the same conversation over this and over the NDJSON
// codec and asserts the two deliver the same messages. A conversation that survives having its
// wire removed is a conversation that was not depending on one, which is precisely what has to
// stay true for a WebSocket transport to be addable later by writing one more file.
//
// MESSAGES ARE STILL STRUCTURED-CLONED through JSON on the way across, so a value that cannot
// survive the wire (a Date, a Map, an undefined field) fails here too. What is absent is only the
// FRAME. A transport that passed object references would prove nothing.
//
// DELIVERY IS SYNCHRONOUS, and that is a deliberate difference from a socket. This exists to make
// a protocol conversation assertable in a straight line; anything whose correctness depends on
// arrival timing belongs in an e2e test against the real supervisor, not here.

import { TransportError, type Transport } from './transport'

/** The two ends of one connection. `a` sends what `b` receives, and the other way round. */
export interface MemoryPair<A, B> {
  readonly a: Transport<A, B>
  readonly b: Transport<B, A>
}

interface Endpoint<Out, In> {
  handler?: (message: In) => void
  errorHandler?: (error: TransportError) => void
  closed: boolean
  peer?: Endpoint<In, Out>
}

function endpointTransport<Out, In>(self: Endpoint<Out, In>): Transport<Out, In> {
  return {
    send(message) {
      if (self.closed) throw new TransportError('closed', 'the transport is closed')
      const peer = self.peer
      if (peer === undefined || peer.closed) {
        throw new TransportError('closed', 'the peer is gone')
      }
      let copy: Out
      try {
        copy = JSON.parse(JSON.stringify(message)) as Out
      } catch (cause) {
        throw new TransportError('encode', 'message could not be serialized', cause)
      }
      peer.handler?.(copy)
    },
    onMessage(handler) {
      self.handler = handler
    },
    onError(handler) {
      self.errorHandler = handler
    },
    close() {
      self.closed = true
    },
    get closed() {
      return self.closed
    }
  }
}

/** Make a connected pair. Neither end knows the other is in the same process. */
export function createMemoryPair<A, B>(): MemoryPair<A, B> {
  const first: Endpoint<A, B> = { closed: false }
  const second: Endpoint<B, A> = { closed: false }
  first.peer = second
  second.peer = first
  return { a: endpointTransport(first), b: endpointTransport(second) }
}
