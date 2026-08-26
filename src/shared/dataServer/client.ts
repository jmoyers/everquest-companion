// THE APP'S SIDE OF THE PROTOCOL (JOS-468, phase 0 of the data-server program).
//
// Everything the renderer will eventually read comes through this file: a connection, typed
// requests, and subscriptions that hand a listener a MATERIALIZED WINDOW rather than the frames it
// was assembled from. It sits on `Transport<ClientMessage, EngineMessage>` and therefore cannot
// learn what a frame is even by accident — swapping NDJSON-over-loopback for a WebSocket is a new
// transport adapter and not one line here (owner ruling 15).
//
// THE EPOCH LAW. The epoch is the world's generation and it is CONNECTION-WIDE, so this client
// holds exactly one of them. Any bump — an `EpochMessage` announcing `attach`/`restart`, or a
// stream frame that simply arrives carrying a newer epoch — DROPS ALL WINDOW STATE for EVERY
// subscription, flips them all to `loading`, and waits for the fresh `reset` each one will be sent
// when the new fold lands; a frame from an OLDER epoch is dropped with a debug note, because a
// client that reconciled across a bump would be merging two different worlds. Handing this client a
// new transport is the same event: a reconnect is a character switch as far as state is concerned
// (resume is always re-query, owner ruling 3 of the diff protocol), so `attach` re-hellos, drops
// every window, and re-subscribes everything from scratch under fresh request ids. There is
// deliberately no catch-up arm and no resume token: the only recovery is a re-query.
//
// THE NO-MUNGING LAW. This client NEVER sorts, filters, aggregates, re-keys or derives anything
// from a row (owner ruling 4). Rows arrive render-ready — already formatted, already ordered — and
// the ops are applied POSITIONALLY, exactly as sent: an insert lands immediately before or after
// the anchor row it names, an update merges the cells it carries over the ones it does not mention
// (an ABSENT cell is unchanged; an EXPLICIT null is the engine saying that cell is now null, and it
// is stored as null rather than deleted so a cleared cell and a cell that never existed stay
// distinguishable), and a drop removes one row by key. Where an op cannot be applied as sent — an
// anchor that is not in the window, an update or a drop naming a row this window does not hold, a
// diff for a subscription that has no reset yet, a frame for an id nobody subscribed to — the op is
// DROPPED WITH A DEBUG NOTE and never guessed at, and never thrown: a stream is not a place to
// raise. The next reset is the repair, and the epoch law is what guarantees one is coming.

// The two halves this file sits on, each of which carries the detail of its own law:
//   * `ops.ts`        — the closed op → result registry, and the one error type a caller sees.
//   * `viewWindow.ts` — the diff ops, applied positionally to one window. Pure.
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ConCardMessage,
  type DiffMessage,
  type EngineMessage,
  type Epoch,
  type EpochMessage,
  type ErrorReply,
  type FireMessage,
  type FoldProgress,
  type Hello,
  type HelloReply,
  type ModuleChangedMessage,
  type KnowledgeMissMessage,
  type Reply,
  type ReplyResult,
  type RequestId,
  type ResetMessage,
  type ViewDescriptor
} from './protocol.generated'
import { createBroadcasts, deliver, listen, type Broadcasts } from './broadcasts'
import { TransportError, type Transport } from './transport'
import { EngineError, RESULT_GUARDS, type ParamsFor, type RequestOp, type ResultFor } from './ops'
import { LOADING, applyDiff, type ViewState } from './viewWindow'

export { EngineError, OPS_ARE_EXHAUSTIVE } from './ops'
export type { OpsAreExhaustive, ParamsFor, RequestOp, ResultFor } from './ops'
export type { ViewState } from './viewWindow'

// ---- what a caller sees -------------------------------------------------------------------------

/** connecting → ready, then closed (we stopped) or failed (the connection did). */
export type ConnectionState = 'connecting' | 'ready' | 'closed' | 'failed'

export type ViewListener = (view: ViewState) => void

/** A live subscription. `close()` is idempotent and unsubscribes on the wire when connected. */
export interface ViewHandle {
  readonly state: ViewState
  close(): void
}

export interface EngineClientOptions {
  /** The per-launch connection token, minted by main and presented once at hello. */
  token: string
  /**
   * Where dropped frames and refused ops are noted. Defaults to silence: `src/shared` is bundled
   * into the renderer, where `console` is a lint error and a log line is somebody else's decision.
   */
  debug?: (note: string) => void
}

export interface EngineClient {
  readonly state: ConnectionState
  /** The world's generation, or null before the first frame that names one. */
  readonly epoch: Epoch | null
  /** Take a (new) connection: re-hello, drop every window, re-subscribe everything. */
  attach(transport: Transport<ClientMessage, EngineMessage>): void
  request<O extends RequestOp>(op: O, params: ParamsFor<O>): Promise<ResultFor<O>>
  subscribe(descriptor: ViewDescriptor, listener: ViewListener): ViewHandle
  onState(listener: (state: ConnectionState) => void): () => void
  /** Fold progress, for the loading UI. Arrives on connection-wide epoch frames. */
  onProgress(listener: (progress: FoldProgress) => void): () => void
  /**
   * ALERT FIRES (JOS-482, owner ruling 22). Connection-wide, like progress, and for the same
   * reason: a fire belongs to the world rather than to any subscription, and every window plays
   * the same sound.
   *
   * IT IS NOT A SUBSCRIPTION AND HAS NO WINDOW. A fire is a thing that happened once — there is
   * nothing to reset, nothing to diff and nothing to re-request — so it does not go through
   * `subscribe`, it does not touch the epoch, and a listener that missed one has missed it. That is
   * the honest shape for a sound: an alert nobody was listening for is not an alert to replay.
   */
  onFire(listener: (fire: FireMessage) => void): () => void

  /**
   * ONE LIVE `/con` PRODUCED A CARD (JOS-487, boundary verdict 2).
   *
   * `onFire`'s shape exactly, and for `onFire`'s reasons: connection-wide, no subscription, no
   * epoch, nothing to replay. A card is a thing that happened, and a listener that missed one has
   * missed it — which is the honest shape for a card whose whole purpose is the two seconds before
   * you decide to pull.
   */
  onConCard(listener: (card: ConCardMessage) => void): () => void

  /**
   * A MODULE'S PUBLISHED STATE MOVED — the dirty bit (JOS-487).
   *
   * THE PUSH THAT REPLACES A POLL. It carries a name and a cursor and no state at all, so a holder
   * of a `module.snapshot` compares its own `seq` against this one and refetches only when this one
   * is ahead. The app-side `useModule` refetch shim rides it; until that lands, this is the seam it
   * will ride and nothing subscribes.
   *
   * IT IS COALESCED ENGINE-SIDE to one per module per serve beat, so a busy tail delivers a
   * bounded number of these rather than one per event — but a listener must still be idempotent in
   * the cursor, because "the newest number wins" is the only thing the coalescing promises.
   */
  onModuleChanged(listener: (changed: ModuleChangedMessage) => void): () => void
  /**
   * KNOWLEDGE MISSES (JOS-486, boundary verdict 5). Connection-wide, like fires and progress, and
   * with the same shape for the same reason: a miss belongs to the PROCESS's corpus rather than to
   * any subscription, so it carries no id and no epoch.
   *
   * IT IS A REQUEST FOR WORK, WHICH IS WHAT MAKES IT DIFFERENT FROM A FIRE. The engine ships with no
   * network stack; the app owns the wiki fetch and the scrape etiquette that goes with it (one
   * serialized queue, 150 ms spacing, `Retry-After` honoured across the whole queue), so this frame
   * says "I could not answer this name" and the answer goes back as a `knowledge.define` command.
   * The engine announces each name AT MOST ONCE per process — a listener that misses one will not
   * be told again, which is the same honest shape a fire has.
   *
   * THIS CLIENT ONLY DELIVERS IT. Nothing here fetches anything: the handler belongs to whoever owns
   * main's `itemLookup`/`mobLookup` queues, and putting a fetch in a shared transport module would
   * put a network call in the renderer's copy of it.
   */
  onKnowledgeMiss(listener: (miss: KnowledgeMissMessage) => void): () => void
  close(): void
}

// ---- internals ----------------------------------------------------------------------------------

interface PendingRequest {
  readonly op: RequestOp
  readonly resolve: (result: ReplyResult) => void
  readonly reject: (error: EngineError) => void
}

interface LiveSubscription {
  /** The id of the subscribe request that opened it — which is also the id its frames carry. */
  id: RequestId
  readonly descriptor: ViewDescriptor
  readonly listener: ViewListener
  view: ViewState
  closed: boolean
}

interface ClientState {
  readonly token: string
  readonly debug: (note: string) => void
  transport: Transport<ClientMessage, EngineMessage> | null
  state: ConnectionState
  nextId: RequestId
  epoch: Epoch | null
  readonly pending: Map<RequestId, PendingRequest>
  /** Requests made before the handshake landed. Sent, in order, the moment it does. */
  readonly outbox: ClientMessage[]
  readonly subs: Map<RequestId, LiveSubscription>
  readonly stateListeners: Set<(state: ConnectionState) => void>
  readonly progressListeners: Set<(progress: FoldProgress) => void>
  /** The four connection-wide fan-outs, held together because they are one family — see
   *  `broadcasts.ts` for what makes them one. */
  readonly broadcasts: Broadcasts
}

function setConnectionState(s: ClientState, next: ConnectionState): void {
  if (s.state === next) return
  s.state = next
  for (const listener of s.stateListeners) listener(next)
}

function emit(sub: LiveSubscription, view: ViewState): void {
  sub.view = view
  if (!sub.closed) sub.listener(view)
}

function nextRequestId(s: ClientState): RequestId {
  const id = s.nextId
  s.nextId += 1
  return id
}

function sendNow(s: ClientState, message: ClientMessage): void {
  const transport = s.transport
  if (transport === null || transport.closed) {
    failConnection(s, new EngineError('unavailable', 'there is no open connection'))
    return
  }
  try {
    transport.send(message)
  } catch (error) {
    failConnection(
      s,
      new EngineError('unavailable', 'the transport refused a message', undefined, error)
    )
  }
}

/** Ready ⇒ straight out; connecting ⇒ queued behind the handshake; otherwise there is no wire. */
function send(s: ClientState, message: ClientMessage): void {
  if (s.state === 'ready') sendNow(s, message)
  else if (s.state === 'connecting') s.outbox.push(message)
}

function rejectAllPending(s: ClientState, error: EngineError): void {
  const inFlight = Array.from(s.pending.values())
  s.pending.clear()
  s.outbox.length = 0
  for (const request of inFlight) request.reject(error)
}

/** THE EPOCH LAW's teeth: every window this client holds, gone, all at once. */
function dropAllWindowState(s: ClientState): void {
  for (const sub of s.subs.values()) emit(sub, LOADING)
}

function failConnection(s: ClientState, error: EngineError): void {
  if (s.state === 'failed' || s.state === 'closed') return
  setConnectionState(s, 'failed')
  s.transport?.close()
  rejectAllPending(s, error)
  // The rows stay: they were true as of the last frame, and a user reading a table should not have
  // it blanked by a socket. The DROP happens on the reconnect (`attach`), which is where the epoch
  // law says it belongs — the fresh reset is what replaces them.
  for (const sub of s.subs.values()) emit(sub, { ...sub.view, error })
}

// ---- the handshake ------------------------------------------------------------------------------

function attach(s: ClientState, transport: Transport<ClientMessage, EngineMessage>): void {
  const reconnect = s.transport !== null
  if (reconnect) {
    s.transport?.close()
    // Anything in flight belonged to the connection that is gone; a request is never resumed.
    rejectAllPending(s, new EngineError('unavailable', 'the connection was replaced'))
  }
  s.transport = transport
  s.epoch = null
  setConnectionState(s, 'connecting')
  if (reconnect) dropAllWindowState(s)
  transport.onMessage((message) => {
    receive(s, message)
  })
  transport.onError((error: TransportError) => {
    failConnection(s, new EngineError('unavailable', error.message, undefined, error))
  })
  const hello: Hello = { op: 'hello', token: s.token, protocolVersion: PROTOCOL_VERSION }
  sendNow(s, hello)
}

function onHelloReply(s: ClientState, reply: HelloReply): void {
  if (s.state !== 'connecting') {
    s.debug('a second hello reply arrived on an established connection - dropped')
    return
  }
  if (reply.protocolVersion !== PROTOCOL_VERSION) {
    failConnection(
      s,
      new EngineError(
        'protocolMismatch',
        `the engine speaks protocol ${reply.protocolVersion}, this build speaks ${PROTOCOL_VERSION}`
      )
    )
    return
  }
  if (!reply.ok) {
    failConnection(s, new EngineError('unauthorized', 'the engine refused the handshake'))
    return
  }
  setConnectionState(s, 'ready')
  resubscribeAll(s)
  const queued = s.outbox.splice(0, s.outbox.length)
  for (const message of queued) sendNow(s, message)
}

// ---- requests -----------------------------------------------------------------------------------

async function request<O extends RequestOp>(
  s: ClientState,
  op: O,
  params: ParamsFor<O>
): Promise<ResultFor<O>> {
  if (s.state === 'closed' || s.state === 'failed') {
    throw new EngineError('unavailable', `the connection is ${s.state}`)
  }
  const result = await sendRequest(s, nextRequestId(s), op, params)
  // Narrowed by the registry: `onReply` refused anything the op does not own before resolving.
  return result as ResultFor<O>
}

/** The one place a request envelope is built, and the one place its id is registered. */
function sendRequest<O extends RequestOp>(
  s: ClientState,
  id: RequestId,
  op: O,
  params: ParamsFor<O>
): Promise<ReplyResult> {
  return new Promise<ReplyResult>((resolve, reject) => {
    s.pending.set(id, { op, resolve, reject })
    // The registry above is what makes this cast true: `op` and `params` are drawn from the same
    // wire union this is asserting into, and TypeScript simply cannot see that through a generic.
    send(s, { id, op, params } as unknown as ClientMessage)
  })
}

function onReply(s: ClientState, reply: Reply): void {
  const pending = s.pending.get(reply.id)
  if (pending === undefined) {
    s.debug(`a reply arrived for request ${reply.id}, which nobody is waiting for - dropped`)
    return
  }
  s.pending.delete(reply.id)
  if (!RESULT_GUARDS[pending.op](reply.result)) {
    pending.reject(
      new EngineError('internal', `the reply to ${pending.op} carries another op's result`, reply.id)
    )
    return
  }
  pending.resolve(reply.result)
}

function onErrorReply(s: ClientState, reply: ErrorReply): void {
  const pending = s.pending.get(reply.id)
  if (pending === undefined) {
    s.debug(`an error arrived for request ${reply.id}, which nobody is waiting for - dropped`)
    return
  }
  s.pending.delete(reply.id)
  pending.reject(new EngineError(reply.error.code, reply.error.message, reply.id))
}

// ---- subscriptions ------------------------------------------------------------------------------

function subscribe(
  s: ClientState,
  descriptor: ViewDescriptor,
  listener: ViewListener
): ViewHandle {
  const sub: LiveSubscription = {
    id: nextRequestId(s),
    descriptor,
    listener,
    view: LOADING,
    closed: false
  }
  s.subs.set(sub.id, sub)
  if (s.state === 'ready') openOnWire(s, sub)
  return {
    get state() {
      return sub.view
    },
    close() {
      if (sub.closed) return
      sub.closed = true
      s.subs.delete(sub.id)
      if (s.state !== 'ready') return
      const id = nextRequestId(s)
      sendRequest(s, id, 'view.unsubscribe', { subscription: sub.id }).catch((error: unknown) => {
        s.debug(`unsubscribing ${sub.id} was refused: ${String(error)}`)
      })
    }
  }
}

function openOnWire(s: ClientState, sub: LiveSubscription): void {
  sendRequest(s, sub.id, 'view.subscribe', sub.descriptor).catch((error: unknown) => {
    // A refused subscription is the view's own error — a bad source, a bad filter — and it belongs
    // where the view will read it rather than taking the connection down. It arrives one microtask
    // late, because it arrives on a promise.
    //
    // WHAT IS NOT DONE HERE: clearing the window. The same rejection fires when the CONNECTION
    // failed under a subscription that was still being acknowledged, and rows a user is reading are
    // not blanked by a socket (see `failConnection`) — the drop belongs to the reconnect.
    if (sub.closed) return
    const failure = error instanceof EngineError ? error : new EngineError('internal', String(error))
    emit(sub, { ...sub.view, loading: false, error: failure })
  })
}

/**
 * RESUME IS RE-QUERY. Every open subscription is re-opened under a FRESH request id, so any frame
 * still in flight for the old one is an unknown id and gets dropped rather than folded into a
 * window it no longer describes.
 */
function resubscribeAll(s: ClientState): void {
  const open = Array.from(s.subs.values())
  s.subs.clear()
  for (const sub of open) {
    sub.id = nextRequestId(s)
    s.subs.set(sub.id, sub)
    openOnWire(s, sub)
  }
}

// ---- the epoch ----------------------------------------------------------------------------------

/**
 * Fold one frame's epoch into the connection's. Returns false when the frame is from an epoch this
 * client has already left, which is the one case a caller must not apply.
 */
function noteEpoch(s: ClientState, epoch: Epoch): boolean {
  if (s.epoch === null) {
    s.epoch = epoch
    return true
  }
  if (epoch === s.epoch) return true
  if (epoch < s.epoch) {
    s.debug(`a frame from epoch ${epoch} arrived at epoch ${s.epoch} - dropped`)
    return false
  }
  s.epoch = epoch
  dropAllWindowState(s)
  return true
}

function onEpochMessage(s: ClientState, message: EpochMessage): void {
  noteEpoch(s, message.epoch)
  if (message.progress === undefined) return
  for (const listener of s.progressListeners) listener(message.progress)
}

// ---- materializing a window ---------------------------------------------------------------------

/** The subscription a stream frame names, or null with a note if this client does not hold it. */
function subscriptionFor(s: ClientState, id: RequestId, kind: string): LiveSubscription | null {
  const sub = s.subs.get(id)
  if (sub === undefined) {
    s.debug(`a ${kind} arrived for subscription ${id}, which is not open here - dropped`)
    return null
  }
  return sub
}

function onReset(s: ClientState, message: ResetMessage): void {
  // The epoch is read FIRST and from every frame, even one for a subscription this client does not
  // hold: the generation belongs to the CONNECTION, so a bump is a bump whoever the frame was for.
  if (!noteEpoch(s, message.epoch)) return
  const sub = subscriptionFor(s, message.id, 'reset')
  if (sub === null) return
  emit(sub, {
    rows: message.rows.slice(),
    total: message.total,
    epoch: message.epoch,
    loading: false,
    error: null
  })
}

function onDiff(s: ClientState, message: DiffMessage): void {
  if (!noteEpoch(s, message.epoch)) return
  const sub = subscriptionFor(s, message.id, 'diff')
  if (sub === null) return
  const held = sub.view.rows
  if (held === null) {
    s.debug(`a diff for subscription ${message.id} arrived before its reset - dropped`)
    return
  }
  emit(sub, {
    rows: applyDiff(held, message.ops, s.debug),
    total: message.total ?? sub.view.total,
    epoch: message.epoch,
    loading: false,
    error: null
  })
}

// ---- the front door -----------------------------------------------------------------------------

function receive(s: ClientState, message: EngineMessage): void {
  if (message.kind === 'hello') onHelloReply(s, message)
  else if (message.kind === 'reply') onReply(s, message)
  else if (message.kind === 'error') onErrorReply(s, message)
  else if (message.kind === 'epoch') onEpochMessage(s, message)
  else if (message.kind === 'reset') onReset(s, message)
  // THE FOUR CONNECTION-WIDE FRAMES, IN ONE BRANCH. None of them carries an id or an epoch, so none
  // of them passes through `noteEpoch` — the one place this client is entitled to drop state — and
  // `broadcasts.ts` is where that property became structural rather than repeated four times.
  else if (deliver(s.broadcasts, message)) {
    // Handled there. The predicate is what narrows the remaining frame to a diff below.
  } else onDiff(s, message)
}

export function createEngineClient(options: EngineClientOptions): EngineClient {
  const s: ClientState = {
    token: options.token,
    debug: options.debug ?? ((): void => undefined),
    transport: null,
    state: 'connecting',
    nextId: 1,
    epoch: null,
    pending: new Map(),
    outbox: [],
    subs: new Map(),
    stateListeners: new Set(),
    progressListeners: new Set(),
    broadcasts: createBroadcasts()
  }
  return {
    get state() {
      return s.state
    },
    get epoch() {
      return s.epoch
    },
    attach: (transport): void => {
      attach(s, transport)
    },
    request: <O extends RequestOp>(op: O, params: ParamsFor<O>): Promise<ResultFor<O>> =>
      request(s, op, params),
    subscribe: (descriptor, listener): ViewHandle => subscribe(s, descriptor, listener),
    onState: (listener): (() => void) => {
      s.stateListeners.add(listener)
      return (): void => {
        s.stateListeners.delete(listener)
      }
    },
    onProgress: (listener): (() => void) => {
      s.progressListeners.add(listener)
      return (): void => {
        s.progressListeners.delete(listener)
      }
    },
    // FOUR ONE-LINERS OVER ONE HELPER. What these methods ever had in common was the
    // add-and-return-a-delete, and four copies of it were four chances to write a listener that
    // could not be removed.
    onFire: (listener): (() => void) => listen(s.broadcasts.fire, listener),
    onConCard: (listener): (() => void) => listen(s.broadcasts.conCard, listener),
    onModuleChanged: (listener): (() => void) => listen(s.broadcasts.moduleChanged, listener),
    onKnowledgeMiss: (listener): (() => void) => listen(s.broadcasts.knowledgeMiss, listener),
    close: (): void => {
      if (s.state === 'closed') return
      setConnectionState(s, 'closed')
      s.transport?.close()
      rejectAllPending(s, new EngineError('unavailable', 'the client was closed'))
    }
  }
}
