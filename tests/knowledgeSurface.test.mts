// THE KNOWLEDGE SURFACE, APP SIDE (JOS-486) — the two things this side of the wire owns.
//
// The corpora themselves are the ENGINE's now, and `engine/crates/knowledge`'s own suite proves the
// indexes against the committed bytes (the item keys, the mob catalog's two spellings, the roster's
// alias statement, the era join, the overlay and the miss ledger). Nothing here re-checks any of it:
// a mirrored assertion proves nothing about the shipped index, which is the argument
// `questItemIndex.ts` was lifted out of `itemLookup.ts` for in the first place.
//
// What IS this side's:
//
//   1. THE RENAME OVERLAY'S ABSENCE, checked rather than assumed. `shared/itemRenames.ts` applies
//      OUR-side renames at load, and the engine's index does not read it — it cannot, being Rust.
//      The table is EMPTY today and the whole design rests on that: an empty table means the two
//      indexes key identically. `itemRenames.ts` names the failure mode itself — "half a rename is
//      worse than none", a name being a join key — so the day somebody adds a row, this test is what
//      says the engine has to learn about it too (a sidecar, the way
//      `scripts/gen-engine-spell-overlay.mts` gives the spell overlay one).
//   2. THE MISS FRAME REACHING A LISTENER, over the real client and the committed fixture bytes. The
//      frame is the app being asked to do work — fetch a wiki page — and a frame that arrived
//      nowhere would be a corpus that never learns anything.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ITEM_RENAMES } from '../src/shared/itemRenames'
import { engineTurns, fixture, rig, shakeHands } from './dataServerRig.mjs'
import type {
  KnowledgeMissMessage,
  Reply,
  KnowledgeResult,
  KnowledgeSearchResult
} from '../src/shared/dataServer/protocol.generated'

test('THE RENAME TABLE IS EMPTY, and the engine index depends on it being empty', () => {
  // NOT A STYLE RULE. `itemsDb.buildItemDbIndex` runs `renamedItems(file.items)` and the engine's
  // `load_item_db` does not — it reads `items.json`'s own keys, which is byte-identical to the TS
  // index for exactly as long as this list has nothing in it. A row added here without a sidecar
  // into the engine would give the two sides two spellings of one join key, which is the drift
  // class `shared/itemRenames.ts` opens its own header with.
  assert.equal(
    ITEM_RENAMES.length,
    0,
    'a rename landed app-side and the engine cannot read it — see engine/crates/knowledge/src/names.rs'
  )
})

test('a knowledge miss reaches a listener, carrying no id and no epoch', () => {
  const r = rig()
  shakeHands(r)
  const heard: KnowledgeMissMessage[] = []
  const stop = r.client.onKnowledgeMiss((miss) => heard.push(miss))

  // THE COMMITTED FRAME, verbatim off the fixture — not one composed here, so this suite and the
  // Rust one are reading the same bytes.
  const committed = engineTurns(fixture('08-knowledge.json')).find(
    (m) => m.kind === 'knowledgeMiss'
  )
  assert.ok(committed, 'the moment carries a miss')
  r.deliver(committed)

  assert.deepEqual(heard, [{ kind: 'knowledgeMiss', domain: 'item', name: 'Shard of Nothing' }])
  // AND IT TOUCHED NO WINDOW AND NO EPOCH. A miss is a statement about the process's corpus, which
  // outlives every generation this client will see — so it must not be able to move the one piece
  // of state this client is entitled to drop everything over.
  assert.equal(r.client.epoch, null, 'a miss names no generation')

  stop()
  r.deliver(committed)
  assert.equal(heard.length, 1, 'a listener that let go stops hearing')
})

test('THE COMMITTED CONVERSATION reads back through the registry the client answers with', async () => {
  // The rig replays the fixture's own replies against the ops registry, which is what makes the
  // registry a claim about the ENGINE rather than about itself: the bytes below came out of a real
  // engine (`engine/crates/engined/README.md`, "Watching the corpora answer, by hand").
  const r = rig()
  shakeHands(r)

  const replies = engineTurns(fixture('08-knowledge.json')).filter(
    (m): m is Reply => m.kind === 'reply'
  )
  const miss = replies.find((m) => (m.result as KnowledgeResult).found === false)
  assert.ok(miss, 'the moment carries a miss reply')

  const answer = r.client.request('knowledge.item', { name: 'Shard of Nothing' })
  const sent = r.sent[r.sent.length - 1]
  assert.equal(sent.op, 'knowledge.item')
  r.deliver({ ...miss, id: sent.id })
  const result = (await answer) as KnowledgeResult
  // A MISS IS AN ANSWER, NOT A REJECTION. The promise resolves; `found` is the flag, and the record
  // is still a card with the player's own name in it.
  assert.equal(result.found, false)
  assert.equal(result.domain, 'item')
  assert.equal(result.record.name, 'Shard of Nothing')
  // …and `offline` rather than `notFound`, because the engine has no network and did not look.
  assert.equal(result.record.offline, true)
  assert.equal(result.record.notFound, undefined)

  // The search result travels the same registry and comes back as its own shape.
  const searchReply = replies.find((m) => 'hits' in (m.result as KnowledgeSearchResult))
  assert.ok(searchReply, 'the moment carries a search reply')
  const hits = r.client.request('knowledge.search', { query: 'rune', domain: 'item', limit: 3 })
  r.deliver({ ...searchReply, id: r.sent[r.sent.length - 1].id })
  const found = (await hits) as KnowledgeSearchResult
  assert.equal(found.total, 41, 'the MATCH count, not the hit count')
  assert.equal(found.hits.length, 3)
  assert.equal(found.hits[0].name, 'Rune', 'exact-then-prefix, ranked by the engine')
})
