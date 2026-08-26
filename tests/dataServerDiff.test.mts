// THE DIFF OPS AND THE EPOCH LAW (JOS-468) — the two rules that decide what a view actually shows.
//
// The client's whole job in a live stream is to turn reset-then-diffs into a window, and to know
// when the window it holds stopped being about this world. Both are asserted here in the smallest
// terms available: a stated window, one frame, the window after.
//
// THE OPS ARE POSITIONAL, and the table below is what that means: an insert lands immediately
// before or after the row it NAMES (never where a comparison would have put it), an update merges
// only the cells it carries, a drop removes one row, and an op that names a row the window does not
// hold is refused with a note rather than guessed at. Nothing here re-orders anything — the engine
// sorted the view, and this client's job is to not undo that (owner ruling 4).
//
// THE EPOCH LAW is the other half: a bump drops EVERY window on the connection, whether it was
// announced by an epoch frame or simply carried by a stream frame from a newer generation, and a
// frame from a generation the world has already left is dropped. The fixtures' own bump (moment 04)
// is exercised in dataServerClient.test.mts; what is here is the law's edges.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openView, rig, rowKeys, shakeHands } from './dataServerRig.mjs'
import type { DiffMessage, Row } from '../src/shared/dataServer/protocol.generated'

interface DiffCase {
  what: string
  rows: Row[]
  ops: DiffMessage['ops']
  total?: number
  expectKeys: string[]
  expectCells?: Record<string, Record<string, unknown>>
  expectTotal?: number
  expectNote?: string
}

const CASES: DiffCase[] = [
  {
    what: 'insert at the head, before the first row',
    rows: [{ key: 'b', cells: {} }],
    ops: [{ op: 'insert', before: 'b', row: { key: 'a', cells: {} } }],
    expectKeys: ['a', 'b']
  },
  {
    what: 'insert at the tail, after the last row',
    rows: [{ key: 'a', cells: {} }],
    ops: [{ op: 'insert', after: 'a', row: { key: 'b', cells: {} } }],
    expectKeys: ['a', 'b']
  },
  {
    what: 'insert between two anchors',
    rows: [
      { key: 'a', cells: {} },
      { key: 'c', cells: {} }
    ],
    ops: [{ op: 'insert', after: 'a', row: { key: 'b', cells: {} } }],
    expectKeys: ['a', 'b', 'c']
  },
  {
    what: 'an anchor in the MIDDLE, named with before',
    rows: [
      { key: 'a', cells: {} },
      { key: 'c', cells: {} }
    ],
    ops: [{ op: 'insert', before: 'c', row: { key: 'b', cells: {} } }],
    expectKeys: ['a', 'b', 'c']
  },
  {
    what: 'insert with neither anchor means the window was empty',
    rows: [],
    ops: [{ op: 'insert', row: { key: 'only', cells: {} } }],
    expectKeys: ['only']
  },
  {
    what: 'ops apply IN ORDER: the second may anchor on what the first inserted',
    rows: [{ key: 'a', cells: {} }],
    ops: [
      { op: 'insert', after: 'a', row: { key: 'b', cells: {} } },
      { op: 'insert', after: 'b', row: { key: 'c', cells: {} } }
    ],
    expectKeys: ['a', 'b', 'c']
  },
  {
    what: 'an insert and the drop it pushes out, in one batch',
    rows: [
      { key: 'b', cells: {} },
      { key: 'c', cells: {} }
    ],
    ops: [
      { op: 'insert', before: 'b', row: { key: 'a', cells: {} } },
      { op: 'drop', key: 'c' }
    ],
    expectKeys: ['a', 'b']
  },
  {
    // THE ENGINE'S OWN ORDER (JOS-480). `engined`'s diff emits every drop FIRST, so that every
    // anchor a later insert names is a row the window still holds — the reverse of the case above,
    // and the ordering `tests/views.rs` observes coming off a real fold. Both are legal: ops apply
    // in order and either sequence lands the same window, which is exactly what this pins.
    what: 'a drop and the insert that follows it, in the order the engine sends them',
    // The window as a newest-first ledger holds it: the highest key is the head.
    rows: [
      { key: 'loot:2', cells: {} },
      { key: 'loot:1', cells: {} },
      { key: 'loot:0', cells: {} }
    ],
    ops: [
      { op: 'drop', key: 'loot:0' },
      { op: 'insert', before: 'loot:2', row: { key: 'loot:3', cells: {} } }
    ],
    total: 4,
    expectKeys: ['loot:3', 'loot:2', 'loot:1'],
    expectTotal: 4
  },
  {
    // AN ABSENT VALUE ARRIVES AS null, not as the dash the renderer draws (`views/loot.rs` argues
    // why). A row full of nulls is an ordinary row and must not be treated as a row with holes.
    what: 'a row whose cells are null is a row like any other',
    rows: [{ key: 'loot:2', cells: { item: 'Cloak of Flames', from: 'a fire giant warlord' } }],
    ops: [
      {
        op: 'insert',
        before: 'loot:2',
        row: {
          key: 'loot:3',
          cells: { item: 'Golden Efreeti Boots', count: null, disposition: null, created: null }
        }
      }
    ],
    expectKeys: ['loot:3', 'loot:2'],
    expectCells: {
      'loot:3': {
        item: 'Golden Efreeti Boots',
        count: null,
        disposition: null,
        created: null
      }
    }
  },
  {
    what: 'drop shrinks the window',
    rows: [
      { key: 'a', cells: {} },
      { key: 'b', cells: {} }
    ],
    ops: [{ op: 'drop', key: 'a' }],
    expectKeys: ['b']
  },
  {
    what: 'dropping the last row leaves an EMPTY window, which is not a loading one',
    rows: [{ key: 'a', cells: {} }],
    ops: [{ op: 'drop', key: 'a' }],
    expectKeys: []
  },
  {
    what: 'update merges the cells it carries and leaves the rest alone',
    rows: [{ key: 'a', cells: { name: 'Primitive', dps: 1, share: 0.5 } }],
    ops: [{ op: 'update', key: 'a', cells: { dps: 2 } }],
    expectKeys: ['a'],
    expectCells: { a: { name: 'Primitive', dps: 2, share: 0.5 } }
  },
  {
    what: 'an EXPLICIT null clears a cell, and only that cell',
    rows: [{ key: 'a', cells: { zone: "Nagafen's Lair", from: 'a fire giant warlord' } }],
    ops: [{ op: 'update', key: 'a', cells: { zone: null } }],
    expectKeys: ['a'],
    expectCells: { a: { zone: null, from: 'a fire giant warlord' } }
  },
  {
    what: 'an update may introduce a cell the row never had',
    rows: [{ key: 'a', cells: { dps: 1 } }],
    ops: [{ op: 'update', key: 'a', cells: { mine: true } }],
    expectKeys: ['a'],
    expectCells: { a: { dps: 1, mine: true } }
  },
  {
    what: 'newest wins WITHIN a batch: two updates of one cell leave the later one',
    rows: [{ key: 'a', cells: { dps: 1 } }],
    ops: [
      { op: 'update', key: 'a', cells: { dps: 2 } },
      { op: 'update', key: 'a', cells: { dps: 3 } }
    ],
    expectKeys: ['a'],
    expectCells: { a: { dps: 3 } }
  },
  {
    what: 'total drifts only when the frame says so',
    rows: [{ key: 'a', cells: {} }],
    ops: [{ op: 'drop', key: 'a' }],
    total: 1833,
    expectKeys: [],
    expectTotal: 1833
  },
  {
    what: 'an insert anchored on a row outside the window is refused, not guessed',
    rows: [{ key: 'a', cells: {} }],
    ops: [{ op: 'insert', before: 'zzz', row: { key: 'b', cells: {} } }],
    expectKeys: ['a'],
    expectNote: 'zzz'
  },
  {
    what: 'an update of a row outside the window is refused',
    rows: [{ key: 'a', cells: {} }],
    ops: [{ op: 'update', key: 'zzz', cells: { dps: 1 } }],
    expectKeys: ['a'],
    expectNote: 'zzz'
  },
  {
    what: 'a drop of a row outside the window is refused',
    rows: [{ key: 'a', cells: {} }],
    ops: [{ op: 'drop', key: 'zzz' }],
    expectKeys: ['a'],
    expectNote: 'zzz'
  },
  {
    what: 'a second insert of a key the window already holds is refused',
    rows: [{ key: 'a', cells: { dps: 1 } }],
    ops: [{ op: 'insert', after: 'a', row: { key: 'a', cells: { dps: 99 } } }],
    expectKeys: ['a'],
    expectCells: { a: { dps: 1 } },
    expectNote: 'already holds'
  },
  {
    what: 'one refused op does not cost the batch its other ops',
    rows: [{ key: 'a', cells: { dps: 1 } }],
    ops: [
      { op: 'drop', key: 'zzz' },
      { op: 'update', key: 'a', cells: { dps: 2 } }
    ],
    expectKeys: ['a'],
    expectCells: { a: { dps: 2 } },
    expectNote: 'zzz'
  }
]

for (const c of CASES) {
  test(`diff: ${c.what}`, () => {
    const r = rig()
    shakeHands(r)
    const view = openView(r, { source: 'loot.ledger' })
    r.deliver({ kind: 'reset', id: view.id, epoch: 1, total: 999, rows: c.rows })
    const diff: DiffMessage = { kind: 'diff', id: view.id, epoch: 1, ops: c.ops }
    r.deliver(c.total === undefined ? diff : { ...diff, total: c.total })

    const keys = rowKeys(view.handle.state)
    assert.deepEqual(keys, c.expectKeys)
    assert.equal(view.handle.state.total, c.expectTotal ?? 999)
    assert.equal(view.handle.state.loading, false)
    for (const [key, cells] of Object.entries(c.expectCells ?? {})) {
      assert.deepEqual(view.handle.state.rows?.[keys.indexOf(key)].cells, cells)
    }
    if (c.expectNote === undefined) assert.deepEqual(r.notes, [])
    else assert.ok(r.notes.some((n) => n.includes(c.expectNote ?? '')), r.notes.join(' | '))
  })
}

test('a diff never mutates the array or the rows a listener was already handed', () => {
  // A React consumer decides what to re-render by comparing identities. An in-place update would
  // produce an unchanged-LOOKING row that has quietly changed, which is the worst of both.
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'combat.live' })
  r.deliver({
    kind: 'reset',
    id: view.id,
    epoch: 1,
    total: 2,
    rows: [
      { key: 'a', cells: { dps: 1 } },
      { key: 'b', cells: { dps: 2 } }
    ]
  })
  const before = view.states[view.states.length - 1]
  r.deliver({
    kind: 'diff',
    id: view.id,
    epoch: 1,
    ops: [{ op: 'update', key: 'a', cells: { dps: 9 } }]
  })
  const after = view.states[view.states.length - 1]

  assert.notEqual(before.rows, after.rows, 'the array identity did not move')
  assert.deepEqual(before.rows?.[0].cells, { dps: 1 }, 'the old state was mutated underneath')
  assert.notEqual(before.rows?.[0], after.rows?.[0], 'the changed row kept its identity')
  assert.equal(before.rows?.[1], after.rows?.[1], 'an UNCHANGED row should keep its identity')
})

// ---- the epoch law ------------------------------------------------------------------------------

test('a frame carrying a newer epoch bumps the world by itself', () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'loot.ledger' })
  r.deliver({ kind: 'reset', id: view.id, epoch: 3, total: 1, rows: [{ key: 'a', cells: {} }] })
  // No EpochMessage at all — just a reset from a newer generation.
  r.deliver({ kind: 'reset', id: view.id, epoch: 4, total: 2, rows: [{ key: 'b', cells: {} }] })
  assert.equal(r.client.epoch, 4)
  assert.deepEqual(rowKeys(view.handle.state), ['b'], 'the two generations were merged')
  assert.deepEqual(
    view.states.map((s) => s.loading),
    [false, true, false],
    'the drop was not observable: a view must be able to say it is re-loading'
  )
})

test('an epoch bump drops EVERY window on the connection', () => {
  const r = rig()
  shakeHands(r)
  const first = openView(r, { source: 'loot.ledger' })
  const second = openView(r, { source: 'combat.live' })
  r.deliver({ kind: 'reset', id: first.id, epoch: 1, total: 1, rows: [{ key: 'a', cells: {} }] })
  r.deliver({ kind: 'reset', id: second.id, epoch: 1, total: 1, rows: [{ key: 'x', cells: {} }] })

  r.deliver({ kind: 'epoch', epoch: 2, reason: 'restart' })
  assert.equal(first.handle.state.rows, null)
  assert.equal(second.handle.state.rows, null)
  assert.equal(first.handle.state.total, 0, 'a dropped window knows nothing, total included')
  assert.equal(first.handle.state.epoch, null)

  // A diff for the old world cannot be applied to a window that no longer exists.
  r.deliver({ kind: 'diff', id: first.id, epoch: 2, ops: [{ op: 'drop', key: 'a' }] })
  assert.equal(first.handle.state.rows, null)
  assert.ok(r.notes.some((n) => n.includes('before its reset')), r.notes.join(' | '))
})

test('a frame from an epoch the world has left is dropped with a note', () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'loot.ledger' })
  r.deliver({ kind: 'reset', id: view.id, epoch: 4, total: 1, rows: [{ key: 'new', cells: {} }] })
  r.deliver({
    kind: 'diff',
    id: view.id,
    epoch: 3,
    ops: [{ op: 'insert', before: 'new', row: { key: 'stale', cells: {} } }]
  })
  assert.deepEqual(rowKeys(view.handle.state), ['new'])
  assert.ok(r.notes.some((n) => n.includes('epoch 3')), r.notes.join(' | '))
  assert.equal(r.client.epoch, 4)
})

test('a progress tick is not a bump', () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'loot.ledger' })
  r.deliver({ kind: 'reset', id: view.id, epoch: 4, total: 1, rows: [{ key: 'a', cells: {} }] })
  r.deliver({ kind: 'epoch', epoch: 4, reason: 'progress', progress: { pct: 12.5, events: 100 } })
  assert.deepEqual(rowKeys(view.handle.state), ['a'], 'a progress tick dropped the window')
  assert.deepEqual(r.progress, [{ pct: 12.5, events: 100 }])
})

test('frames for a subscription nobody opened are dropped, never thrown', () => {
  const r = rig()
  shakeHands(r)
  assert.doesNotThrow(() => {
    r.deliver({ kind: 'reset', id: 999, epoch: 1, total: 0, rows: [] })
    r.deliver({ kind: 'diff', id: 999, epoch: 1, ops: [{ op: 'drop', key: 'a' }] })
    r.deliver({ kind: 'reply', id: 999, ok: true, result: { text: 'nobody asked' } })
    r.deliver({
      kind: 'error',
      id: 999,
      ok: false,
      error: { code: 'internal', message: 'nobody asked' }
    })
  })
  assert.equal(r.notes.length, 4, r.notes.join(' | '))
  // …and the epoch on such a frame still counted: the generation belongs to the CONNECTION.
  assert.equal(r.client.epoch, 1)
})

test('a diff that arrives before its reset is dropped', () => {
  const r = rig()
  shakeHands(r)
  const view = openView(r, { source: 'loot.ledger' })
  r.deliver({
    kind: 'diff',
    id: view.id,
    epoch: 1,
    ops: [{ op: 'insert', row: { key: 'a', cells: {} } }]
  })
  assert.equal(view.handle.state.rows, null)
  assert.ok(r.notes.some((n) => n.includes('before its reset')), r.notes.join(' | '))
})
