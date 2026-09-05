// ============================================================================
// preload/engine.ts — the renderer's door to the data server (JOS-484, phase 3).
// ============================================================================
//
// A separate file for FILE MASS, like `dev.ts`/`perf.ts`/`windows.ts` before it: index.ts sits at
// the measured 400-code-line ceiling and the house rule is to split rather than ratchet. Spread
// into `api` there, so `window.eq.engineConnect()` sits exactly where it would if it were inline.
//
// ── WHAT CROSSES THE BRIDGE, AND WHAT DOES NOT ────────────────────────────────────────────────
//
// THE MESSAGEPORT DOES NOT. It arrives here on `engine:port`, is wrapped in a `ByteChannel`
// (`shared/dataServer/messagePortChannel.ts`) and stays in this file's closure for the life of the
// connection. What the renderer gets is that channel's four plain functions — write, onData,
// onClose, close — which is the whole shape the NDJSON transport above it needs and nothing more.
// The renderer therefore runs the REAL `EngineClient` over the REAL wire while holding no
// transferable object at all, and a preload that hands out a port it cannot take back is a preload
// that cannot enforce a lifetime.
//
// THE TOKEN DOES, and it has to: `EngineClient` presents it at hello, and the client lives in the
// renderer because that is the point of the whole exercise (main relays bytes and serializes
// nothing — see `main/dataServer/rendererBroker.ts`). What it never does is settle anywhere: it is
// a promise's resolution value, not a property of `window`, not a store key, not an attribute. It
// dies with the renderer, and a respawned engine mints a new one regardless (spawn contract rule 5).
//
// ── THE GATE ──────────────────────────────────────────────────────────────────────────────────
//
// `engineEnabled` is a STATIC boolean read from `process.env`, exactly like `isE2E` in index.ts and
// `ownerTools` in dev.ts, and for their reasons: the variable is fixed before the process starts,
// the renderer has no `process` of its own, and an IPC round trip would make every consumer async
// for an answer that cannot change. It is a READOUT, never a grant — main registers the handler
// unconditionally and refuses when no engine is running, so a renderer that ignored this flag would
// find `{ok:false}` on the other side of the door.
//
// AND IT READS THE FLAG THE WAY MAIN DOES, THROUGH THE SAME PREDICATE (JOS-495). The default is ON
// now, and a readout still comparing `=== '1'` would answer FALSE on every ordinary launch — so
// `engineProvider.tsx` would never even attempt the connect that `rendererBroker.ts` was standing
// ready to serve, and the renderer half of the cutover would be dark in exactly the builds it is
// meant to run in. The mismatch would be silent at both ends: main refuses nothing, the renderer
// asks nothing. `shared/dataServer/engineFlags.ts` is why the two cannot drift.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import { messagePortChannel } from '../shared/dataServer/messagePortChannel'
import type { ByteChannel } from '../shared/dataServer/ndjson'
import type { EngineLaunchSay } from '../shared/engineLaunch'

/** One brokered connection, as the renderer sees it: bytes, and the secret to open with. */
export interface EngineConnection extends ByteChannel {
  /** The per-launch token, presented once at hello. Renderer memory only — see the header. */
  readonly token: string
}

/** What `engine:port` carries beside the port itself. */
interface PortPush {
  nonce: number
  token: string
}

/**
 * THE INBOX, installed at module scope and never removed.
 *
 * It has to exist before any connect is asked for: main posts the port BEFORE the invoke resolves,
 * so a listener attached after the await would be attached after the delivery. Waiters are keyed by
 * the nonce they minted, because a window may ask twice before either answer lands and the second
 * port must not be handed to the first caller.
 */
const waiting = new Map<number, (connection: EngineConnection) => void>()
let nextNonce = 1

ipcRenderer.on(IPC.onEnginePort, (event, payload: PortPush) => {
  const port = event.ports[0]
  const resolve = waiting.get(payload.nonce)
  waiting.delete(payload.nonce)
  if (port === undefined) return
  if (resolve === undefined) {
    // Nobody is waiting — a connect whose caller gave up, or a duplicate. The port is CLOSED rather
    // than dropped: an entangled port that is merely forgotten leaves main relaying a socket into
    // nothing until a garbage collector happens to notice.
    port.close()
    return
  }
  const channel = messagePortChannel(port)
  resolve({ ...channel, token: payload.token })
})

export const engineBridge = {
  // `engineEnabled` LIVED HERE AND IS GONE (JOS-499 item 9). It let the renderer skip one IPC
  // call on a launch that had deliberately turned the engine off. There is no such launch, and a
  // readout with one possible value is a member every reader has to prove is dead. The
  // renderer now simply asks, and `engineConnect` answering null is the honest "not yet".

  /**
   * Open this window's ONE connection to the engine, or answer null.
   *
   * NULL IS NOT AN ERROR, and it is the ordinary answer on most launches: no engine is running.
   * The caller shows no surface and asks again later if it wants to; a rejection here would make
   * "the feature is off" and "the feature is broken" the same observation, which is the mistake
   * `engineHost.ts resolveEngineBinary` documents one process over.
   *
   * A refusal never leaves a waiter behind: the entry is removed on the failure path, so a window
   * that is refused a hundred times holds nothing.
   */
  engineConnect: async (): Promise<EngineConnection | null> => {
    const nonce = nextNonce
    nextNonce += 1
    const arriving = new Promise<EngineConnection>((resolve) => {
      waiting.set(nonce, resolve)
    })
    let ok = false
    try {
      const reply = (await ipcRenderer.invoke(IPC.engineConnect, nonce)) as { ok?: boolean }
      ok = reply.ok === true
    } catch {
      // No handler, or main threw. Both mean there is no connection; neither is worth a stack.
      ok = false
    }
    if (!ok) {
      waiting.delete(nonce)
      return null
    }
    return arriving
  },

  // ── THE LAUNCH, AS THE SHELL SEES IT (JOS-503) ──────────────────────────────────────────────
  //
  // A PUSH AND A READ, and the read is not a poll. `onEngineLaunch` carries every change; the one
  // `engineLaunchState()` exists because a window that mounted (or reloaded, or was opened by the
  // updater) AFTER the state stopped changing would otherwise never learn it — and the states that
  // stop changing are precisely the two the shell has to draw. One call at mount, never again.
  //
  // NOTHING ABOUT THIS CROSSES THE ENGINE'S WIRE. The renderer's own `EngineClient` could hear the
  // progress half itself (`client.onProgress`), and deliberately does not: the FAILURE half has no
  // socket to arrive on, and splitting one question across two transports would make the shell
  // reconcile what main already knows. `main/dataServer/engineLaunchState.ts` carries the argument.

  /** Every change to the engine's launch state. Returns the unsubscriber. */
  onEngineLaunch: (cb: (say: EngineLaunchSay) => void): (() => void) => {
    const listener = (_e: unknown, say: EngineLaunchSay): void => {
      cb(say)
    }
    ipcRenderer.on(IPC.onEngineLaunch, listener)
    return () => {
      ipcRenderer.removeListener(IPC.onEngineLaunch, listener)
    }
  },

  /** What the push last carried. The ONE read a window makes, on mount. */
  engineLaunchState: (): Promise<EngineLaunchSay> =>
    ipcRenderer.invoke(IPC.engineLaunchState) as Promise<EngineLaunchSay>,

  /** The failure card's retry button. Resolves when main has taken the ask, not when it worked. */
  engineRetry: (): Promise<void> => ipcRenderer.invoke(IPC.engineRetry) as Promise<void>
}
