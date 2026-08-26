// ============================================================================
// engineProvider.tsx — THE RENDERER'S OWN CONNECTION TO THE ENGINE (JOS-484, phase 3).
// ============================================================================
//
// `useView.ts` was written in phase 0 with a note in its header: "THE CLIENT ARRIVES BY CONTEXT
// (there is no preload bridge yet, and phase 3 decides what one looks like)". This file is what
// phase 3 decided. It is the composition root of the renderer's half of the data server, and it is
// deliberately the only file in `src/renderer` that knows a preload bridge, a token or a transport
// exists — everything below it sees an `EngineClient` or it sees null.
//
// ── WHAT IT MOUNTS, AND WHY THE VALUE MAY BE NULL ─────────────────────────────────────────────
//
// `EngineClientContext` holds the live client, or null. NULL IS THE ORDINARY STATE and it means one
// thing: this window has no connection right now — the launch has no engine (no `EQC_ENGINE=1`, no
// built binary), or the engine has not become ready yet, or the connection just died. Every surface
// gated on the engine reads the context DIRECTLY and shows nothing when it is null, which is why
// `useEngineClient`'s throw is never reached in the product: a view that would throw is a view that
// was never rendered.
//
// ── ONE CLIENT PER CONNECTION, NEVER REUSED ACROSS ONE ────────────────────────────────────────
//
// `engineClientHost.ts` states the rule for main and it is the same rule here: a token IS the
// identity of one connection to one launch, and a respawn mints a new secret. So a failed
// connection produces a NEW client rather than a re-attached one, and the old one is closed. There
// is nothing to carry across — resume is always re-query (diff-protocol rule 3), which the client
// library already enforces on its own window state.
//
// ── THE RETRY IS A DEV LOOP, AND IT IS BOUNDED BY BEING BORING ────────────────────────────────
//
// The engine becomes ready asynchronously (spawn → announce → health probe), so the first ask can
// legitimately arrive before there is anything to connect to; and a respawn invalidates every port
// main handed out. Both are answered by asking again on a fixed interval. It is a plain timer, not
// a backoff, because the whole thing is behind a developer's environment variable and the cost of
// being wrong is one refused IPC call every few seconds. When the flag is unset this file does
// exactly nothing: no timer, no IPC, no client — one `if`, read once.

import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { createEngineClient, type EngineClient } from '../../../shared/dataServer/client'
import { createNdjsonTransport } from '../../../shared/dataServer/ndjson'
import type { ClientMessage, EngineMessage } from '../../../shared/dataServer/protocol.generated'
import { EngineClientProvider } from './useView'

/** How long before a window that could not connect asks again. See the header for why it is flat. */
const RETRY_MS = 4_000

/**
 * Give every view below this a client — when there is one.
 *
 * THE EFFECT IS KEYED ON AN ATTEMPT COUNTER rather than looping inside itself, so React owns the
 * lifetime of each try: a strict-mode double mount, an unmount mid-connect and a reconnect all take
 * the same path, which is the cleanup closing whatever that attempt produced. A connection that
 * arrives after its attempt was torn down is closed on arrival rather than leaked — main is
 * relaying a real socket into that port, and forgetting one would leave the socket open until the
 * window died.
 */
export function EngineProvider({ children }: { children: ReactNode }): JSX.Element {
  const [client, setClient] = useState<EngineClient | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // NO PRE-CHECK (JOS-499 item 9). There used to be a static preload readout saying whether
    // this launch wanted an engine at all, so a deliberately engine-less launch could skip the
    // call. Every launch wants one now, and `engineConnect` answering null is the same
    // information without a flag — the retry below is what turns that into "not yet".
    let live = true
    let created: EngineClient | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const askAgain = (): void => {
      if (!live || timer !== undefined) return
      timer = setTimeout(() => {
        if (live) setAttempt((n) => n + 1)
      }, RETRY_MS)
    }
    void window.eq.engineConnect().then(
      (connection) => {
        if (!live) {
          connection?.close()
          return
        }
        if (connection === null) {
          askAgain()
          return
        }
        const next = createEngineClient({ token: connection.token })
        created = next
        next.onState((state) => {
          // A FAILED connection is dropped from the context immediately, which is what takes every
          // engine-backed surface off the screen rather than leaving one showing rows nobody is
          // still receiving. `closed` is this effect's own teardown and needs no reaction.
          if (state === 'failed') {
            setClient((held) => (held === next ? null : held))
            askAgain()
          }
        })
        next.attach(createNdjsonTransport<ClientMessage, EngineMessage>(connection))
        setClient(next)
      },
      () => {
        askAgain()
      }
    )
    return (): void => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
      created?.close()
      setClient((held) => (held === created ? null : held))
    }
  }, [attempt])

  return <EngineClientProvider value={client}>{children}</EngineClientProvider>
}
