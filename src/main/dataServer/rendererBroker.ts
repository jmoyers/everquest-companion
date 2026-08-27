// ============================================================================
// rendererBroker.ts — MAIN BROKERS A RENDERER'S CONNECTION, AND CARRIES NO FRAMES (JOS-484).
// ============================================================================
//
// Owner ruling 7, verbatim: "one connection per renderer, brokered by main". This file is the
// brokerage, and the whole design turns on one word in the sentence below it.
//
// ── BYTES, NOT FRAMES. THE ONE DECISION THIS FILE IS ───────────────────────────────────────────
//
// The obvious brokerage is a proxy: main runs an `EngineClient`, renderers ask over IPC, main
// serializes an answer per window. That is exactly the cost JOS-458 measured and named — a
// per-window serialization of state that main had already serialized once to get. The engine exists
// to delete that cost, and a broker that re-created it would have moved the fold and kept the bill.
//
// So main relays RAW BYTES and never parses one. A renderer asks; main opens a FRESH loopback
// connection to the engine, makes a `MessageChannelMain` pair, hands one port to that renderer, and
// pumps: socket chunk in → `port.postMessage(chunk)`; port message out → `socket.write(chunk)`. No
// JSON, no `LineDecoder`, no protocol type is imported by this file at all — the only thing it can
// do to a chunk is move it. The renderer runs the real `EngineClient` over a `messagePortChannel`
// (`src/shared/dataServer/messagePortChannel.ts`) and is a first-class peer of the engine: its
// subscriptions, its diffs and its epoch are its own, and main's cost per view is zero.
//
// ONE CONNECTION PER RENDERER is enforced HERE rather than trusted: a second `engine:connect` from
// a webContents that already holds one closes the first. A renderer that reloads therefore replaces
// its connection rather than leaking one per reload, and the engine's connection count stays a
// function of how many windows are open.
//
// ── THE TOKEN ──────────────────────────────────────────────────────────────────────────────────
//
// Loopback is not a permission boundary — the token is (`token.ts`) — and a renderer that holds a
// socket has to present one. It rides the SAME `postMessage` that carries the port, for two
// reasons. It is one delivery rather than two, so there is no window in which a renderer holds a
// wire it cannot use or a secret with nothing to use it on; and it never touches a channel anything
// persists. It is not in the store, not in a URL, not in the DOM, and not in `localStorage`: it
// lives in the preload's closure and in the `EngineClient` that preload's channel serves, both of
// which die with the renderer. A respawned engine mints a new secret (spawn contract rule 5), which
// is why every launch invalidates every port below.
//
// ── LIFECYCLE, ALL FOUR DIRECTIONS ─────────────────────────────────────────────────────────────
//
//   * THE RENDERER LETS GO — it closes its channel, which posts the end sentinel; the relay
//     destroys the socket. Same for a window that is destroyed outright (`webContents 'destroyed'`)
//     and for a port whose renderer-side end was collected (`MessagePortMain 'close'`).
//   * THE ENGINE DIES — the socket ends, the relay posts the sentinel and closes the port, and the
//     renderer's transport reports a failed connection. Its client keeps its rows (they were true
//     when they were sent) and shows an error until it reconnects.
//   * THE ENGINE RESPAWNS — `noteEngineLaunch` closes EVERY relay, because a new launch means a new
//     port and a new token and nothing about the old connection is valid. Renderers reconnect and
//     re-subscribe from scratch; RESUME IS RE-QUERY (diff-protocol rule 3), which the client library
//     already enforces on its own state, so there is nothing to carry across and nothing to resume.
//   * THE APP QUITS — `stopRendererBroker` closes everything, beside the supervisor's own teardown.
//
// ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────────────────────────
//
// No queueing, no reconnect timer, no state. A connection that fails is a connection the renderer
// asks for again; the retry policy belongs to the surface that wants a view, not to the plumbing.
// And no `EQC_ENGINE` read: `engineHost.ts` owns the one gate for this feature, and it simply never
// calls `noteEngineLaunch`, so the handler below finds no launch and refuses. One gate, one place.

import { ipcMain, MessageChannelMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc'
import { logInfo } from '../errorLog'
import { connectToEngine } from './socketChannel'
// THE PUMP ITSELF (./byteRelay.ts), which imports no Electron — the same split supervisor.ts makes
// against this file's sibling, and for the same reason: the part with logic in it is unit-tested
// with fakes, and this file is the wiring nobody can test without an app.
import { relayBytes } from './byteRelay'
import type { ReadyEngine } from './supervisor'
import type { ByteChannel } from '../../shared/dataServer/ndjson'

/** How long a renderer's loopback connect may take. `engineClientHost.ts`'s bound, for its reason:
 *  the supervisor's probe just completed a round trip on this port, so this covers the pathological
 *  case rather than budgeting the ordinary one. */
const CONNECT_TIMEOUT_MS = 2_000

// ── the live relays ────────────────────────────────────────────────────────────────────────────

/** One brokered connection. It is only ever taken AWAY — which window holds it is the map's key,
 *  so the record itself is the teardown and nothing else. */
interface Relay {
  readonly close: () => void
}

/** Keyed by `webContents.id` — which is what makes ONE CONNECTION PER RENDERER structural rather
 *  than a rule somebody has to remember. */
const relays = new Map<number, Relay>()

/**
 * THE TURN, per window. `engineClientHost.ts`'s generation counter, needed here for its own reason.
 *
 * `ipcMain.handle` runs an async handler CONCURRENTLY with itself, so two connects from one window —
 * which strict mode's double-mount produces on every dev launch — can both be waiting on a socket at
 * once. Without this, the one that resolves SECOND is the one whose relay ends up in the map, and
 * that is not necessarily the one the renderer is still listening to: a slow first connect would
 * overwrite a fast second one and leave a live socket nobody drops until the window dies. Bumped
 * before the await and re-asked after it, so a turn that has lost hands its socket back instead.
 */
const turns = new Map<number, number>()

/** The launch a renderer would be connected to, or null when there is no engine. Set only by
 *  `engineHost.ts`, which is where this feature's one flag is read. */
let launch: ReadyEngine | null = null

function debug(line: string): void {
  logInfo(`[everquest-companion] ${line}`)
}

/** Take one renderer's connection away. Idempotent, and safe for a window that never had one. */
function dropRelay(id: number, why: string): void {
  const relay = relays.get(id)
  if (relay === undefined) return
  relays.delete(id)
  relay.close()
  debug(`data-server broker: closed the connection for window ${String(id)} (${why})`)
}

/** Take every connection away — a respawn, or a quit. */
function dropAll(why: string): void {
  for (const id of Array.from(relays.keys())) dropRelay(id, why)
}

/**
 * THE SUPERVISOR'S READY EDGE, for the broker. `null` means the launch that was ready is over.
 *
 * EVERY EXISTING RELAY DIES HERE, including on the way IN to a new launch: the port and the token a
 * renderer is holding belong to a process that no longer exists, and a socket to a port some other
 * program may now own is worse than no socket at all. The renderers notice through their own
 * transports and ask again — which is a fresh connect, a fresh token and a fresh reset, i.e.
 * exactly the resume-is-re-query law the protocol already runs on.
 */
export function noteEngineLaunch(info: ReadyEngine | null): void {
  launch = info
  dropAll(info === null ? 'the engine is gone' : 'the engine was relaunched')
}

/** Let go of everything. Called from `stopEngineSupervisor`; idempotent. */
export function stopRendererBroker(): void {
  launch = null
  dropAll('the app is shutting down')
}

// ── the IPC door ───────────────────────────────────────────────────────────────────────────────

/** What `engine:connect` answers. The PORT does not travel in this reply — it travels on the
 *  `engine:port` push that precedes it, because a MessagePort is transferred, never returned. */
export interface EngineConnectReply {
  ok: boolean
  /** Why not, as prose for a dev log. Never a code: nothing branches on this. */
  reason?: string
}

/**
 * Open one renderer's connection.
 *
 * THE ORDER IS DELIBERATE: the port is posted BEFORE this resolves, so a renderer that awaits the
 * reply and then reads its inbox can never be told `ok` for a port that has not been sent. The
 * `nonce` is the renderer's own correlation handle, echoed rather than interpreted — it exists
 * because a window may ask twice before either answer lands, and the second port must not be
 * mistaken for the first.
 */
async function onConnect(event: IpcMainInvokeEvent, nonce: unknown): Promise<EngineConnectReply> {
  const sender = event.sender
  const id = sender.id
  const info = launch
  if (info === null) return { ok: false, reason: 'no engine is running on this launch' }
  // Renderer input, re-validated at the handler like every other channel in this process — it is
  // echoed back into a renderer, so a non-number would simply never match and the caller would hang
  // rather than fail.
  if (typeof nonce !== 'number' || !Number.isFinite(nonce)) {
    return { ok: false, reason: 'a connect must carry a numeric nonce' }
  }
  // ONE CONNECTION PER RENDERER (ruling 7). A window that asks again has replaced its own.
  dropRelay(id, 'the window asked for a new connection')
  const mine = (turns.get(id) ?? 0) + 1
  turns.set(id, mine)

  let channel: ByteChannel
  try {
    channel = await connectToEngine(info.port, CONNECT_TIMEOUT_MS)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    debug(`data-server broker: could not reach the engine for window ${String(id)} (${why})`)
    return { ok: false, reason: why }
  }
  // THREE WAYS THIS TURN CAN HAVE LOST while the connect was in flight, and all three are ordinary:
  // the window went, the launch was replaced, or this window asked AGAIN and that ask has already
  // been answered. A socket nobody will read is closed rather than relayed into a dead port — and,
  // in the third case, rather than overwriting a live relay the renderer is actually listening to.
  if (sender.isDestroyed() || launch !== info || turns.get(id) !== mine) {
    channel.close()
    return { ok: false, reason: 'the connection was superseded before it was handed over' }
  }

  const { port1, port2 } = new MessageChannelMain()
  const close = relayBytes(channel, port1)
  relays.set(id, { close })
  sender.once('destroyed', () => {
    dropRelay(id, 'the window was destroyed')
    // The turn goes with it. Ids are not reused while a window lives, but a map that only ever
    // grows is a leak with a slow fuse, and this is the one moment it can be emptied honestly.
    turns.delete(id)
  })
  // THE TOKEN RIDES THE PORT. One delivery, and it lands in the preload's closure — see the header.
  sender.postMessage(IPC.onEnginePort, { nonce, token: info.token }, [port2])
  debug(`data-server broker: window ${String(id)} is connected to the engine on port ${String(info.port)}`)
  return { ok: true }
}

/**
 * Register the one channel. Called from `registerIpc()` beside every other domain.
 *
 * THE LAUNCH-STATE CHANNELS ARE NOT HERE, and the reason is a cycle rather than a category. They
 * would belong beside this one — the `engine:*` family is registered unconditionally in every build
 * so a refusal is a decision a test can watch — but `engine:retry` has to reach
 * `engineHost.ts retryEngineSupervisor`, and `engineHost.ts` imports THIS file. `src/main/ipc/
 * engine.ts` is the leaf that closes that loop, and it keeps this file's one import direction.
 */
export function registerRendererBrokerIpc(): void {
  ipcMain.handle(IPC.engineConnect, onConnect)
}
