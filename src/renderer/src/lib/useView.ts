// useView — the hook every engine-backed view will use to stay live (JOS-468, data-server phase 0).
//
// It is `useModule`'s successor and is modeled on it deliberately, so the discipline that hook
// earned survives the move to the engine. What that hook does by hand, and where each part went:
//
//   * SUBSCRIBE BEFORE THE FIRST STATE, and buffer what arrives during the gap. There is no gap
//     here to buffer: `client.subscribe()` registers the listener in the same call that opens the
//     subscription, so nothing can arrive before somebody is listening. The buffering is designed
//     out rather than dropped — see the EngineClient's header.
//   * DEDUPE BY SEQ. Gone, and gone on purpose: the client materializes the window itself and hands
//     this hook whole states, so there is no ordering left for a view to get wrong.
//   * THE STALE / RE-HYDRATE ESCAPE HATCH. Two of them now, and neither is this hook's arithmetic.
//     A world that was rebuilt (character switch, engine restart, reconnect) bumps the EPOCH, and
//     the client drops every window and flips this subscription back to `loading` until its fresh
//     reset lands — resume is always re-query. A DESCRIPTOR that changes is the second: the state
//     held belongs to the old descriptor, so it is discarded at render time rather than shown for a
//     frame under a query nobody asked for.
//   * UNSUBSCRIBE ON UNMOUNT. Kept exactly: the effect's cleanup closes the handle, which
//     unsubscribes on the wire when there is a wire.
//
// `null` rows are the loading state, matching useModule's `Snap | null` convention: null means this
// view holds no window state at all, which is true before the first reset and true again after an
// epoch bump discards one. It is never an empty result — an empty view is `rows: []`.
//
// THE CLIENT ARRIVES BY CONTEXT (there is no preload bridge yet, and phase 3 decides what one looks
// like). `useViewFrom` takes the client explicitly and is the whole hook; `useView` is the two-line
// wrapper that reads it from the provider. That split is the test seam: a fake client needs no
// provider, no DOM and no preload.

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { EngineClient, ViewState } from '../../../shared/dataServer/client'
import type { ViewDescriptor } from '../../../shared/dataServer/protocol.generated'

/** No window state, no error, not yet told anything. */
const LOADING_VIEW: ViewState = { rows: null, total: 0, epoch: null, loading: true, error: null }

export const EngineClientContext = createContext<EngineClient | null>(null)
/** Wrap the app (or a test tree) in this to give every view below it a client. */
export const EngineClientProvider = EngineClientContext.Provider

export function useEngineClient(): EngineClient {
  const client = useContext(EngineClientContext)
  if (client === null) {
    throw new Error('useView needs an EngineClientProvider above it')
  }
  return client
}

/**
 * The identity of a query, for the effect's dependency list. A view descriptor is normally written
 * inline at the call site, so it is a NEW OBJECT on every render and cannot be a dependency itself
 * — that is a resubscribe loop, which is the shape of bug useModule's `[moduleId]` avoided by
 * keying on a string.
 *
 * The fields are serialized in a FIXED ORDER rather than canonicalized, because canonicalizing an
 * open map means sorting its keys and this file may never sort anything (owner ruling 4's lint
 * lands on renderer code). The honest cost: two descriptors that differ only in the order their
 * filter keys were spelled are two queries here. Nothing is lost when that happens — the view
 * re-subscribes and the engine answers the same thing.
 */
function descriptorKey(descriptor: ViewDescriptor): string {
  return JSON.stringify([
    descriptor.source,
    descriptor.filter ?? null,
    descriptor.sort ?? null,
    descriptor.window ?? null
  ])
}

interface Held {
  /** Which descriptor produced `view`. */
  readonly key: string
  readonly view: ViewState
}

/**
 * Subscribe to one view over an explicit client. Returns the materialized window: render-ready
 * rows exactly as the engine ordered them, the view's `total`, the `epoch` they describe, and the
 * `loading` / `error` states an honest view has to draw.
 */
export function useViewFrom(client: EngineClient, descriptor: ViewDescriptor): ViewState {
  const key = descriptorKey(descriptor)
  const [held, setHeld] = useState<Held>({ key, view: LOADING_VIEW })
  // The latest descriptor without making the effect depend on its identity — `key` is what decides
  // whether the subscription has to be re-opened.
  const descriptorRef = useRef(descriptor)
  descriptorRef.current = descriptor

  useEffect(() => {
    const handle = client.subscribe(descriptorRef.current, (view) => {
      setHeld({ key, view })
    })
    // A resubscribe over a connection that is already up can materialize inside the call above, so
    // the handle's own state is read once rather than waited for.
    setHeld({ key, view: handle.state })
    return () => {
      handle.close()
    }
  }, [client, key])

  // The escape hatch: state belonging to a descriptor nobody is asking about any more is not shown
  // for the render between the change and the effect that acts on it.
  return held.key === key ? held.view : LOADING_VIEW
}

/** The same hook, over the client the provider supplies. */
export function useView(descriptor: ViewDescriptor): ViewState {
  const client = useEngineClient()
  return useViewFrom(client, descriptor)
}
