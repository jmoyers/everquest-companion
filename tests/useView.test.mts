// useView — the hook, run for real (JOS-468).
//
// There is no jsdom and no @testing-library in this repo, and `tests/hookHost.mts` is why one is
// not needed here: it installs a minimal dispatcher into React's own hook seam and runs the hook
// UNMODIFIED, across re-renders and unmounts. Read that file's header before extending this one.
//
// WHAT THIS SUITE CAN SEE, and it is exactly the part no pure function could: the DEPENDENCY
// ARRAY. A view descriptor is written inline at a call site, so it is a new object on every render;
// keying the subscription effect on it would resubscribe forever, and keying it on nothing at all
// would leave a changed query showing the old query's rows. Both are re-render behaviour.
//
// WHAT IT CANNOT SEE: the context provider. `hookHost` deliberately refuses `useContext` (its
// header says so), so `useView` — the two-line wrapper that reads the client off the provider — is
// not exercised here. That is precisely why the hook is split in two: `useViewFrom` takes the
// client explicitly and holds all of the behaviour, and the wrapper is the only part a real React
// tree is needed to prove. The e2e harness inherits it when phase 3 wires a provider into the app.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountHook } from './hookHost.mjs'
import { EngineClientContext, EngineClientProvider, useViewFrom } from '../src/renderer/src/lib/useView'
import type { EngineClient, ViewHandle, ViewState } from '../src/shared/dataServer/client'
import { EngineError } from '../src/shared/dataServer/client'
import type { Row, ViewDescriptor } from '../src/shared/dataServer/protocol.generated'

const LOADING: ViewState = { rows: null, total: 0, epoch: null, loading: true, error: null }

function loaded(rows: Row[], total = rows.length, epoch = 3): ViewState {
  return { rows, total, epoch, loading: false, error: null }
}

interface Opened {
  readonly descriptor: ViewDescriptor
  readonly listener: (view: ViewState) => void
  view: ViewState
  closed: boolean
}

interface Fake {
  readonly client: EngineClient
  /** Every subscription ever opened, in order, closed or not. */
  readonly opened: Opened[]
  /** Push a state to the newest open subscription, the way the client would. */
  push(view: ViewState): void
}

function fakeClient(): Fake {
  const opened: Opened[] = []
  const client = {
    state: 'ready',
    epoch: null,
    attach: () => undefined,
    request: () => Promise.reject(new EngineError('unavailable', 'not in this test')),
    subscribe: (descriptor: ViewDescriptor, listener: (view: ViewState) => void): ViewHandle => {
      const entry: Opened = { descriptor, listener, view: LOADING, closed: false }
      opened.push(entry)
      return {
        get state() {
          return entry.view
        },
        close: () => {
          entry.closed = true
        }
      }
    },
    onState: () => () => undefined,
    onProgress: () => () => undefined,
    close: () => undefined
  } as unknown as EngineClient
  return {
    client,
    opened,
    push: (view) => {
      const entry = opened[opened.length - 1]
      entry.view = view
      entry.listener(view)
    }
  }
}

const openCount = (fake: Fake): number => {
  let live = 0
  for (const entry of fake.opened) {
    if (!entry.closed) live += 1
  }
  return live
}

// ---- the states a view has to draw ---------------------------------------------------------------

test('a view starts loading, with no rows and no error', () => {
  const fake = fakeClient()
  const host = mountHook(() => useViewFrom(fake.client, { source: 'loot.ledger' }))
  assert.deepEqual(host.value, LOADING)
  assert.equal(fake.opened.length, 1, 'the subscription is opened on mount, once')
  assert.deepEqual(fake.opened[0].descriptor, { source: 'loot.ledger' })
  host.unmount()
})

test('the materialized window is handed straight through', () => {
  const fake = fakeClient()
  const rows: Row[] = [{ key: 'loot:9412', cells: { item: 'Cloak of Flames' } }]
  const host = mountHook(() => useViewFrom(fake.client, { source: 'loot.ledger' }))
  host.act(() => {
    fake.push(loaded(rows, 1834))
  })
  assert.equal(host.value.rows, rows, 'the hook re-derived what it was handed')
  assert.equal(host.value.total, 1834)
  assert.equal(host.value.epoch, 3)
  assert.equal(host.value.loading, false)
  host.unmount()
})

test('an epoch bump puts the view back into loading, with no rows', () => {
  const fake = fakeClient()
  const host = mountHook(() => useViewFrom(fake.client, { source: 'loot.ledger' }))
  host.act(() => {
    fake.push(loaded([{ key: 'a', cells: {} }]))
  })
  assert.equal(host.value.rows?.length, 1)
  host.act(() => {
    fake.push(LOADING)
  })
  assert.deepEqual(host.value, LOADING, 'a dropped window must not keep rendering its rows')
  host.unmount()
})

test('a refused view reports its error and stops loading', () => {
  const fake = fakeClient()
  const host = mountHook(() => useViewFrom(fake.client, { source: 'no.such.source' }))
  const error = new EngineError('notFound', 'unknown source')
  host.act(() => {
    fake.push({ rows: null, total: 0, epoch: null, loading: false, error })
  })
  assert.equal(host.value.error, error)
  assert.equal(host.value.loading, false, 'a view that will never load is not loading')
  host.unmount()
})

// ---- the dependency array ------------------------------------------------------------------------

test('AN EQUAL DESCRIPTOR WRITTEN INLINE DOES NOT RESUBSCRIBE', () => {
  // The bug this pins: `[descriptor]` as the effect's dependency. A call site writes the descriptor
  // inline, so every render hands over a NEW object, and the view would tear itself down and open a
  // fresh subscription on every single render — 10 Hz of resubscribes under a live meter.
  const fake = fakeClient()
  const host = mountHook(() =>
    useViewFrom(fake.client, {
      source: 'loot.ledger',
      filter: { session: 'current' },
      sort: [['at', 'desc']],
      window: { offset: 0, limit: 50 }
    })
  )
  host.act(() => {
    fake.push(loaded([{ key: 'a', cells: {} }]))
  })
  host.render()
  host.render()
  assert.equal(fake.opened.length, 1, 'the subscription was re-opened for an identical query')
  assert.equal(host.value.rows?.length, 1, 'and the window survived the re-renders')
  host.unmount()
})

test('a CHANGED descriptor resubscribes, and shows loading rather than the old query', () => {
  const fake = fakeClient()
  let descriptor: ViewDescriptor = { source: 'loot.ledger', filter: { session: 'current' } }
  const host = mountHook(() => useViewFrom(fake.client, descriptor))
  host.act(() => {
    fake.push(loaded([{ key: 'a', cells: {} }]))
  })
  assert.equal(host.value.rows?.length, 1)

  host.act(() => {
    descriptor = { source: 'loot.ledger', filter: { session: 'all' } }
  })
  assert.equal(fake.opened.length, 2, 'a different query has to be a different subscription')
  assert.deepEqual(fake.opened[1].descriptor, { source: 'loot.ledger', filter: { session: 'all' } })
  assert.equal(fake.opened[0].closed, true, 'the old subscription was left open')
  assert.equal(openCount(fake), 1)
  assert.deepEqual(host.value, LOADING, 'the old query-s rows were shown under the new query')

  host.act(() => {
    fake.push(loaded([{ key: 'b', cells: {} }, { key: 'c', cells: {} }]))
  })
  assert.equal(host.value.rows?.length, 2)
  host.unmount()
})

test('the window a subscription already holds is read at subscribe time', () => {
  // A resubscribe over a connection that is already up can materialize INSIDE the subscribe call,
  // which is the gap useModule had to buffer for. Here the handle simply carries it.
  const fake = fakeClient()
  const client = {
    ...fake.client,
    subscribe: (descriptor: ViewDescriptor, listener: (view: ViewState) => void): ViewHandle => {
      const handle = fake.client.subscribe(descriptor, listener)
      fake.opened[fake.opened.length - 1].view = loaded([{ key: 'immediate', cells: {} }], 7)
      return handle
    }
  } as unknown as EngineClient
  const host = mountHook(() => useViewFrom(client, { source: 'loot.ledger' }))
  assert.deepEqual(host.value.rows?.[0].key, 'immediate')
  assert.equal(host.value.total, 7)
  host.unmount()
})

test('unmounting unsubscribes', () => {
  const fake = fakeClient()
  const host = mountHook(() => useViewFrom(fake.client, { source: 'loot.ledger' }))
  assert.equal(openCount(fake), 1)
  host.unmount()
  assert.equal(openCount(fake), 0, 'the subscription outlived the component that opened it')
  assert.equal(fake.opened.length, 1)
})

// ---- the provider seam ---------------------------------------------------------------------------

test('the provider is the context-s own, so a test tree and the app share one seam', () => {
  assert.equal(EngineClientProvider, EngineClientContext.Provider)
})
