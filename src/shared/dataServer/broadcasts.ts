// broadcasts.ts — THE CONNECTION-WIDE FRAMES, and the one thing they all are (JOS-487).
//
// SPLIT OUT of client.ts on exactly the terms `protocolDescribe.mts` was split out of the schema
// suite, and by the same rule: the repo's ceilings are a measurement of this tree, and when a fourth
// family lands the answer is to split rather than to ratchet. The `moduleChanged` and `conCard`
// frames put `receive` at a complexity of 14 against a maximum of 12 and client.ts over max-lines;
// what came out is not the arbitrary tenth of a file that would have fixed the number, it is the
// FAMILY the four frames already formed.
//
// WHAT MAKES THEM ONE FAMILY, stated once here instead of four times over there:
//
//   * NO `id`. None of them answers a request or belongs to a subscription. `EpochMessage` set the
//     precedent and each of these cites it.
//   * NO `epoch`, and that is the sharper half. Every other stream frame describes WINDOW STATE a
//     client must reconcile across a generation; these describe things that HAPPENED (a fire, a
//     con), a cursor that MOVED (`moduleChanged`), or a fact about the process's corpus rather than
//     about any world (`knowledgeMiss`). There is nothing to drop and nothing to re-request, so a
//     generation number would be a field with no reader.
//   * THEREFORE NONE OF THEM PASSES THROUGH `noteEpoch`, which is the one place the client is
//     entitled to drop state. That is the property this module exists to make structural: a frame
//     routed here cannot touch the epoch, because this module cannot see it.
//   * A LISTENER THAT MISSED ONE HAS MISSED IT. Nothing is buffered and nothing is replayed on
//     reconnect — which is the honest shape for a sound, a card, and a request for work.
//
// `moduleChanged` IS THE ONE THAT ALMOST DOES NOT BELONG, and the line is worth drawing: it names
// state a client may be holding. But what it names is a MODULE snapshot, not a view window, and the
// answer to it is `module.snapshot` — an op whose reply carries its own generation. So it is a
// pointer, not a payload, and it reconciles nothing.

import type {
  ConCardMessage,
  EngineMessage,
  FireMessage,
  KnowledgeMissMessage,
  ModuleChangedMessage
} from './protocol.generated'

/** One frame kind's listeners. */
type Fanout<T> = Set<(message: T) => void>

/** Every connection-wide listener set, held together because they are one family. */
export interface Broadcasts {
  readonly fire: Fanout<FireMessage>
  readonly conCard: Fanout<ConCardMessage>
  readonly moduleChanged: Fanout<ModuleChangedMessage>
  readonly knowledgeMiss: Fanout<KnowledgeMissMessage>
}

export function createBroadcasts(): Broadcasts {
  return {
    fire: new Set(),
    conCard: new Set(),
    moduleChanged: new Set(),
    knowledgeMiss: new Set()
  }
}

/**
 * Register a listener and hand back the way to stop listening.
 *
 * ONE HELPER FOR FOUR SUBSCRIPTIONS rather than four copies of an add-and-return-a-delete: the
 * repetition was the only thing four `onX` methods ever had, and a bug in one copy of it would be a
 * listener that could not be removed.
 */
export function listen<T>(fanout: Fanout<T>, listener: (message: T) => void): () => void {
  fanout.add(listener)
  return (): void => {
    fanout.delete(listener)
  }
}

/** The four frames this module owns, as one type — see the header for what makes them one. */
export type Broadcast =
  | FireMessage
  | ConCardMessage
  | ModuleChangedMessage
  | KnowledgeMissMessage

/**
 * Deliver one frame if it is a connection-wide one. `true` when it was.
 *
 * IT IS A TYPE PREDICATE AND THE PREDICATE IS THE POINT, not a trick to make a chain compile: this
 * function returns true for EXACTLY the four kinds, so saying so in the signature is what lets the
 * caller's final `else` narrow to the one remaining frame — the diff — and keeps `receive` a chain
 * that ends in a real type rather than in a cast. A frame kind added to the schema and forgotten
 * here therefore fails to typecheck at the caller rather than being silently dropped.
 */
export function deliver(
  broadcasts: Broadcasts,
  message: EngineMessage
): message is Broadcast {
  switch (message.kind) {
    case 'fire':
      return fan(broadcasts.fire, message)
    case 'conCard':
      return fan(broadcasts.conCard, message)
    case 'moduleChanged':
      return fan(broadcasts.moduleChanged, message)
    case 'knowledgeMiss':
      return fan(broadcasts.knowledgeMiss, message)
    default:
      return false
  }
}

function fan<T>(fanout: Fanout<T>, message: T): true {
  for (const listener of fanout) listener(message)
  return true
}
