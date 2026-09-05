// THE CLOSED RESULT REGISTRY, APP SIDE (src/shared/dataServer/ops.ts).
//
// The schema states a rule it deliberately refuses to put on the wire: a reply carries no op of its
// own, because the op of the REQUEST whose id it names is what decides the result shape. That rule
// is not expressible in the generated types — `ReplyResult` is a bare union there — so `ops.ts` is
// where it becomes one, and this file is where the claim is checked against the committed
// conversation rather than against itself.
//
// IT EXISTS BECAUSE THE REGISTRY IS A CLAIM ABOUT THE ENGINE, not a derivation from it. `ParamsFor`
// is read straight off the wire union and cannot drift; `ResultFor` is written down by hand, so the
// only thing standing between "the registry says session.health answers with a HealthResult" and
// reality is a test that makes the engine answer. `OpsAreExhaustive` covers the other half at
// compile time — a new op in `protocol/schema/` is a TYPE error in ops.ts until somebody writes
// down what it answers with — and the runtime half is here.
//
// JOS-478 added `module.snapshot`, the first data-bearing op, which is why this file exists now
// rather than at JOS-468: it is the first op whose result shape a caller actually reads a value
// out of.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EngineError,
  OPS_ARE_EXHAUSTIVE,
  RESULT_GUARDS,
  type RequestOp
} from '../src/shared/dataServer/ops'
import { fixture, flush, rig, shakeHands } from './dataServerRig.mjs'
import type {
  ClientMessage,
  EngineMessage,
  ModuleSnapshotRequest,
  Reply,
  ReplyResult
} from '../src/shared/dataServer/protocol.generated'

/** Every op the schema's client union names, read off the committed conversation's own shapes. */
const EVERY_OP: RequestOp[] = [
  'echo',
  'session.attach',
  'session.health',
  'session.progress',
  'module.snapshot',
  'perf.snapshot',
  'perf.budgets',
  'perf.timeline',
  'view.subscribe',
  'view.unsubscribe',
  'alerts.define',
  'buffTrust.define',
  'respawn.define',
  'combo.define',
  'roster.define',
  'sessionMarks.add',
  'respawn.confirmSighting',
  'combat.snapshot',
  'combat.searchFights',
  'knowledge.item',
  'knowledge.mob',
  'knowledge.spell',
  'knowledge.search',
  'knowledge.define',
  'resist.levels',
  'resist.spell',
  'spells.search',
  'logs.setDir',
  'logs.list'
]

test('the registry names every op, and the compile-time pin agrees', () => {
  // OPS_ARE_EXHAUSTIVE is a `true` that only typechecks when the registry and the wire union name
  // exactly the same set. Asserting it at runtime is worth one line: it makes the constant
  // load-bearing in a suite as well as in a build, so nobody deletes it as unused.
  assert.equal(OPS_ARE_EXHAUSTIVE, true)
  assert.deepEqual(Object.keys(RESULT_GUARDS).sort(), [...EVERY_OP].sort())
})

test('EVERY GUARD IS DISCRIMINATING — no two ops accept each other’s result', () => {
  // The guards are the cheapest possible check that the engine kept its side of the registry. That
  // is only true if each one accepts its OWN shape and refuses every other, which is a property of
  // the set rather than of any single guard — so it is asserted over the whole matrix.
  const shapes: Record<RequestOp, ReplyResult> = {
    echo: { text: 'hello engine' },
    'session.attach': { epoch: 2, accepted: true },
    'session.health': { status: 'live', epoch: 2, uptimeMs: 925 },
    'session.progress': { subscription: 4, subscribed: true },
    'module.snapshot': { module: 'kills', seq: 139859, state: { v: 3, mobs: {} } },
    // The engine's own numbers (JOS-483). `status` is deliberately present and deliberately NOT
    // what the guard reads: `session.health` owns that field too, and a guard two arms both pass
    // is a guard that cannot tell them apart — so `serve` is the discriminator, and this shape
    // carrying `status` is what makes that a real assertion in the matrix below.
    'perf.snapshot': { status: 'live', epoch: 2, uptimeMs: 925, ingest: {}, serve: [] },
    // THE TRAP SHAPES, per this file's convention: a budget that measured NOTHING (the state a
    // just-launched engine is in, and the one a guard reading truthiness rather than `in` would
    // get wrong), and an EMPTY ring (the commonest honest timeline answer). Neither carries
    // `uptimeMs`, which is the schema decision that keeps `session.health`'s negation one clause
    // long — if a later hand adds it, this matrix is what says so.
    'perf.budgets': {
      epoch: 2,
      budgets: [
        {
          id: 'foldRate',
          label: 'fold rate',
          limit: 'at least 1.0 MB/s',
          verdict: 'unmeasured',
          note: 'nothing has folded yet'
        }
      ]
    },
    'perf.timeline': { epoch: 2, capacity: 30, cadenceMs: 10_000, timeline: [] },
    'view.subscribe': { subscription: 7, subscribed: true },
    'view.unsubscribe': { subscription: 7, subscribed: false },
    // The five defines share `DefineAck` the way the three above share `SubscribeAck`, and for the
    // same reason: the schema has one ack arm and five ops that mean it. The two shapes below are
    // BOTH legal answers — a list payload counts, an object payload does not — and each op is given
    // one of them so the matrix exercises both.
    'alerts.define': { applied: true, count: 1 },
    'buffTrust.define': { applied: true },
    'respawn.define': { applied: true },
    'combo.define': { applied: true, count: 2 },
    'roster.define': { applied: true, count: 0 },
    // THE REFUSED SHAPE, not the accepted one (JOS-487). Both are legal, and the refusal is the one
    // worth putting in the matrix: it is the answer a caller has to branch on, and it is the one an
    // over-eager guard reading `accepted` as a truthiness test would silently drop.
    'sessionMarks.add': { accepted: false, status: 'folding' },
    // THE NO-OP, FOR THE REASON THE REFUSED MARK ABOVE IS HERE (JOS-494): both booleans are legal
    // answers and the negative one is the trap. A guard that read `confirmed` as a truthiness test
    // rather than as `in` would call a perfectly good ack the wrong shape — which is the mistake
    // `knowledge.item`'s guard is written to avoid too, and it is worth making the matrix able to
    // catch it here rather than trusting the comment beside the guard.
    'respawn.confirmSighting': { confirmed: false },
    // THE COMBAT SURFACE (JOS-485). The snapshot's `now` is deliberately present in this shape and
    // deliberately NOT what the guard reads — the same trap `perf.snapshot`'s `status` sprang — and
    // the search result carries an EMPTY `hits` beside a non-zero `corpus`, because that is the
    // answer to a query that matched nothing and a guard reading truthiness would miss it.
    'combat.snapshot': { now: 1787181707000, snapshot: { hydrating: false, segments: [] } },
    'combat.searchFights': { hits: [], corpus: 1428 },
    // THE KNOWLEDGE SURFACE (JOS-486). The three lookups share `KnowledgeResult` the way the
    // subscribe family shares `SubscribeAck` — but they are NOT a family in the sense below,
    // because the shape names its own `domain`: a caller holding an item card and a mob card can
    // tell them apart from the value alone, which is exactly what `DefineAck` cannot do. So the
    // three are given DIFFERENT domains here and the matrix still may not separate them by guard.
    'knowledge.item': {
      domain: 'item',
      name: "Rune of Al'Kabor",
      found: true,
      record: { name: "Rune of Al'Kabor", lore: true, quest: true, questUses: [] }
    },
    'knowledge.mob': {
      domain: 'mob',
      name: 'a sand giant',
      found: true,
      record: { name: 'a sand giant', cached: true }
    },
    // A MISS IS A LEGAL ANSWER AND THE MATRIX SAYS SO: `found: false` with a record that is still a
    // card. A guard that read `found` rather than `record` would call this the wrong shape.
    'knowledge.spell': {
      domain: 'spell',
      name: 'Spell Of Nothing',
      found: false,
      record: { queried: 'Spell Of Nothing', found: false, illusion: false }
    },
    'knowledge.search': {
      query: 'rune',
      total: 41,
      hits: [{ domain: 'item', name: "Rune of Al'Kabor", page: "Rune of Al'Kabor" }]
    },
    // …and the push-back is a `DefineAck` with no `count`, because one entry is not a list.
    'knowledge.define': { applied: true },
    // THE EMPTY ANSWER, DELIBERATELY (JOS-497 item 1). `levels: []` is what "nothing states a
    // level for any of these creatures" looks like on the wire, and it is the shape an over-eager
    // guard would get wrong: a truthiness test on an empty array calls a perfectly good answer the
    // wrong shape, and a card that fell back to the app's own fold for it would be main reading a
    // fold this ticket exists to stop reading. Same trap as the refused mark and the un-confirmed
    // sighting above, sprung a third way.
    'resist.levels': { levels: [] },
    // THE MISSING-FILE ANSWER, which is the shape worth putting in the matrix for the same reason
    // the refused mark is: an `EQ_INSTALL_DIR` pointed at a folder of logs with no EverQuest behind
    // it is a SUPPORTED state, it carries no `spell`, and a guard reading `spell` would call the
    // commonest honest answer a wrong shape.
    'resist.spell': {
      spellName: 'Tashani',
      table: 'missing',
      path: 'C:/nowhere/EverQuest Legends/spells_us.txt'
    },
    // THE CATALOGUE SEARCH (JOS-507), and its EMPTY shape for the same reason `resist.levels`'s and
    // `logs.list`'s are empty: a filter that excludes everything is a real answer, and so is an
    // install with no `spells_us.txt` behind it. Note `spellTable` rather than `table` — the word
    // above is already `resist.spell`'s discriminator, and a second arm carrying it would be a shape
    // that guard could not refuse. This is the collision being designed out rather than caught.
    'spells.search': {
      spells: [],
      total: 0,
      offset: 0,
      limit: 50,
      categories: [],
      spellTable: 'missing',
      path: 'C:/nowhere/EverQuest Legends/spells_us.txt'
    },
    // LOG DISCOVERY (JOS-498). The push answers with the ack six ops already share — one directory
    // is not a list, so there is no `count`, and it joins the family below rather than pretending to
    // a discriminator it cannot have.
    'logs.setDir': { applied: true },
    // AND THE LIST'S SHAPE IS THE EMPTY ONE, deliberately, for the reason `resist.levels`'s is: an
    // install where nobody has typed `/log on` is a real answer with no rows in it, and a guard that
    // read `characters` for truthiness rather than with `in` would call the correct picker's own
    // reply a wrong shape. The `dir` and `readable` beside it are what make it an ANSWER rather than
    // a silence, and they are deliberately NOT what the guard reads.
    'logs.list': { dir: 'C:/EverQuest Legends/Logs', readable: 'ok', characters: [] }
  }
  for (const op of EVERY_OP) {
    assert.equal(RESULT_GUARDS[op](shapes[op]), true, `${op} refused its own result`)
  }
  // TWO FAMILIES SHARE A SHAPE BY DESIGN, and naming them here is what keeps each exception
  // deliberate rather than a hole. `session.progress`, `view.subscribe` and `view.unsubscribe` all
  // mean `SubscribeAck` — the schema has one ack arm and three ops that use it — and since JOS-482
  // the five `*.define` commands all mean `DefineAck` for the same reason: a full-set replace has
  // nothing per-family to report back, so five near-identical answers are one shape rather than
  // five. Within a family the matrix may not separate; ACROSS them it still must.
  const families: Set<RequestOp>[] = [
    new Set<RequestOp>(['session.progress', 'view.subscribe', 'view.unsubscribe']),
    new Set<RequestOp>([
      'alerts.define',
      'buffTrust.define',
      'respawn.define',
      'combo.define',
      'roster.define',
      // `knowledge.define` joins the ack family (JOS-486) — it is a define BY SHAPE even though it
      // is not one by LAW: it carries one entry rather than a whole set, which the schema argues at
      // length beside the op. The ack it answers with is the same ack, so the guard cannot separate
      // it from the other five, and pretending otherwise would be a guard that lies.
      'knowledge.define',
      // `logs.setDir` joins for the same reason as `knowledge.define` and from the other direction
      // (JOS-498): it is a define BY SHAPE and not by LAW — one directory rather than a whole set,
      // and no fold input at all — and one directory is not a list, so its ack carries no `count`
      // and nothing could tell it from `buffTrust.define`'s.
      'logs.setDir'
    ]),
    // The three lookups mean one shape. They are separable by VALUE (`domain`) and not by guard,
    // which is the honest place to draw that line: a guard is a shape check, not a content check.
    new Set<RequestOp>(['knowledge.item', 'knowledge.mob', 'knowledge.spell'])
  ]
  const shareShape = (a: RequestOp, b: RequestOp): boolean =>
    families.some((family) => family.has(a) && family.has(b))
  for (const op of EVERY_OP) {
    for (const other of EVERY_OP) {
      if (op === other) continue
      if (shareShape(op, other)) continue
      assert.equal(
        RESULT_GUARDS[op](shapes[other]),
        false,
        `${op}'s guard accepted ${other}'s result`
      )
    }
  }
})

test('module.snapshot travels the client as the registry says it does', async () => {
  const r = rig()
  shakeHands(r)

  const answer = r.client.request('module.snapshot', { module: 'kills' })
  const sent = r.sent[r.sent.length - 1] as ModuleSnapshotRequest
  assert.equal(sent.op, 'module.snapshot')
  assert.equal(sent.params.module, 'kills')

  // THE COMMITTED ANSWER, verbatim off the fixture — re-addressed to the id THIS client chose,
  // which is the one edit a replay is allowed to make (see the rig).
  const committed = fixture('06-module-snapshot.json').messages.find(
    (frame) =>
      frame.dir === 'engine' &&
      (frame.message as Reply).kind === 'reply' &&
      ((frame.message as Reply).result as { module?: string }).module === 'kills'
  )
  assert.ok(committed, 'the moment carries a kills snapshot')
  r.deliver({ ...(committed.message as Reply), id: sent.id } as EngineMessage)

  const result = await answer
  assert.equal(result.module, 'kills')
  assert.equal(result.seq, 139859)
  // The state is the MODULE's shape, not the protocol's — so this reads a field the protocol has
  // never heard of, which is exactly the point of the open type.
  assert.deepEqual((result.state as { mobs: Record<string, { count: number }> }).mobs['a sand giant'], {
    count: 41,
    lastTs: 1787181707000
  })
})

test('module.snapshot carries an ARRAY state through the client unchanged', async () => {
  // `loot` publishes an array where `kills` publishes an object. A client that had narrowed the
  // state to a record would drop this on the floor, and a schema that had said `type: object`
  // would have made that the contract.
  const r = rig()
  shakeHands(r)
  const answer = r.client.request('module.snapshot', { module: 'loot' })
  const sent = r.sent[r.sent.length - 1] as ModuleSnapshotRequest
  r.deliver({
    kind: 'reply',
    id: sent.id,
    ok: true,
    result: { module: 'loot', seq: 12, state: [{ item: 'Rune of Al`Kabor', qty: 2 }] }
  })
  const result = await answer
  assert.ok(Array.isArray(result.state))
  assert.equal((result.state as { qty: number }[])[0].qty, 2)
})

test('an unknown module is a notFound the caller can branch on', async () => {
  const r = rig()
  shakeHands(r)
  const answer = r.client.request('module.snapshot', { module: 'loot.ledger' })
  const sent = r.sent[r.sent.length - 1] as ModuleSnapshotRequest
  r.deliver({
    kind: 'error',
    id: sent.id,
    ok: false,
    error: { code: 'notFound', message: 'this engine folds no module named "loot.ledger"' }
  })
  await assert.rejects(answer, (e: unknown) => {
    assert.ok(e instanceof EngineError)
    assert.equal(e.code, 'notFound')
    return true
  })
})

test('a reply carrying ANOTHER op’s result is refused rather than handed over', async () => {
  // The failure this prevents: a caller reads `result.state` off a SubscribeAck and gets
  // `undefined` several frames later, with nothing in the log to say why.
  const r = rig()
  shakeHands(r)
  const answer = r.client.request('module.snapshot', { module: 'kills' })
  const sent = r.sent[r.sent.length - 1] as ClientMessage & { id: number }
  r.deliver({
    kind: 'reply',
    id: sent.id,
    ok: true,
    result: { subscription: sent.id, subscribed: true }
  })
  await assert.rejects(answer, (e: unknown) => {
    assert.ok(e instanceof EngineError)
    assert.equal(e.code, 'internal')
    return true
  })
  await flush()
})

test('HEALTH’S NEW FIELDS ARE OPTIONAL, and absent is not zero', async () => {
  // Ruling 18 law 3: state is addressed by (log identity, byte offset). A health answer before any
  // attach has no such coordinate, and the schema says so by leaving the fields out — so the
  // client must hand back an object where they are `undefined`, never one where they are 0.
  const r = rig()
  shakeHands(r)
  const fresh = r.client.request('session.health', {})
  const first = r.sent[r.sent.length - 1] as ClientMessage & { id: number }
  r.deliver({
    kind: 'reply',
    id: first.id,
    ok: true,
    result: { status: 'idle', epoch: 1, uptimeMs: 12 }
  })
  const before = await fresh
  assert.equal(before.mark, undefined)
  assert.equal(before.events, undefined)
  assert.equal(before.lastEventTs, undefined)

  const live = r.client.request('session.health', {})
  const second = r.sent[r.sent.length - 1] as ClientMessage & { id: number }
  r.deliver({
    kind: 'reply',
    id: second.id,
    ok: true,
    result: {
      status: 'live',
      epoch: 2,
      uptimeMs: 925,
      mark: { log: 'C:\\EQ\\Logs\\eqlog_Primitive_freeport.txt', offset: 9185240 },
      events: 139860,
      lastEventTs: 1787181707000
    }
  })
  const after = await live
  assert.equal(after.mark?.offset, 9185240)
  assert.equal(after.events, 139860)
  assert.equal(after.lastEventTs, 1787181707000)
})
