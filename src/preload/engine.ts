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
import { engineFlagOn } from '../shared/dataServer/engineFlags'
import { IPC } from '../shared/ipc'
import { messagePortChannel } from '../shared/dataServer/messagePortChannel'
import type { ByteChannel } from '../shared/dataServer/ndjson'

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
  /**
   * Does this launch want an engine — i.e. was it started WITHOUT `EQC_ENGINE=0`? A readout, not a
   * grant, and true by default since JOS-495 — see the header.
   *
   * The renderer uses it to decide whether to try at all, which keeps a launch that deliberately
   * turned the engine off from making one IPC call it already knows the answer to.
   */
  engineEnabled: engineFlagOn(process.env.EQC_ENGINE),

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
  }
}
