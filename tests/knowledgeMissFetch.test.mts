// THE APP-SIDE HALF OF A WIKI MISS (JOS-499 item 1, boundary verdict 5).
//
// `tests/knowledgeSurface.test.mts` proves the FRAME reaches a listener over the real client and
// the committed fixture bytes. This proves what the listener then does, which is the half that did
// not exist until the deletion release: the domain picks the right lookup, the record goes back
// under the name the frame carried, a failure defines NOTHING, and an unarmed process is silent
// rather than broken.
//
// WHY IT CAN RUN UNDER PLAIN NODE AT ALL is the reason the lookups are injected:
// `src/main/itemLookup.ts` and `mobLookup.ts` both `import { app } from 'electron'` at module
// scope. The leaf under test holds the DECISION and none of the network, so the fakes below are
// the whole world it needs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asKnowledgeRecord,
  fetchAndDefine,
  installKnowledgeMissFetch,
  type MissOutcome
} from '../src/main/dataServer/knowledgeMissFetch'
import type {
  KnowledgeDefineParams,
  KnowledgeMissMessage
} from '../src/shared/dataServer/protocol.generated'

interface Rig {
  readonly defined: KnowledgeDefineParams[]
  readonly notes: string[]
  readonly itemAsks: string[]
  readonly mobAsks: string[]
}

/** Arm the leaf with fakes and hand back what they recorded. */
function arm(opts: { itemFails?: boolean; mobFails?: boolean; defineFails?: boolean } = {}): Rig {
  const rig: Rig = { defined: [], notes: [], itemAsks: [], mobAsks: [] }
  installKnowledgeMissFetch({
    lookupItem: async (name) => {
      rig.itemAsks.push(name)
      if (opts.itemFails === true) throw new Error('the wiki timed out')
      return await Promise.resolve(asKnowledgeRecord({ name, lore: true, from: 'item' }))
    },
    lookupMob: async (name) => {
      rig.mobAsks.push(name)
      if (opts.mobFails === true) throw new Error('the wiki timed out')
      return await Promise.resolve(asKnowledgeRecord({ name, level: 42, from: 'mob' }))
    },
    define: async (params) => {
      if (opts.defineFails === true) throw new Error('the engine refused it')
      rig.defined.push(params)
      await Promise.resolve()
    },
    note: (line) => rig.notes.push(line)
  })
  return rig
}

const itemMiss: KnowledgeMissMessage = {
  kind: 'knowledgeMiss',
  domain: 'item',
  name: 'Shard of Nothing'
}
const mobMiss: KnowledgeMissMessage = { kind: 'knowledgeMiss', domain: 'mob', name: 'Blugurg' }

test('an ITEM miss is fetched by the item lookup and pushed back under the name the frame carried', async () => {
  const rig = arm()
  const outcome: MissOutcome = await fetchAndDefine(itemMiss)

  assert.equal(outcome, 'defined')
  assert.deepEqual(rig.itemAsks, ['Shard of Nothing'])
  assert.deepEqual(rig.mobAsks, [], 'an item miss must never reach the mob lookup')
  assert.equal(rig.defined.length, 1)
  const pushed = rig.defined[0]
  assert.equal(pushed.domain, 'item')
  // THE NAME IS ECHOED BACK UNCHANGED — the schema's word. The engine folds it into the domain's
  // own key on the way in, so the app never has to know how an item key differs from a mob key,
  // and a "helpfully" normalized name here would miss the ledger entry that raised the frame.
  assert.equal(pushed.name, 'Shard of Nothing')
  assert.equal(pushed.entry.from, 'item')

  installKnowledgeMissFetch(null)
})

test('a MOB miss takes the other lookup', async () => {
  const rig = arm()
  assert.equal(await fetchAndDefine(mobMiss), 'defined')
  assert.deepEqual(rig.mobAsks, ['Blugurg'])
  assert.deepEqual(rig.itemAsks, [])
  assert.equal(rig.defined[0]?.domain, 'mob')
  installKnowledgeMissFetch(null)
})

test('A FAILED FETCH DEFINES NOTHING — a timeout is not the statement that the wiki has no page', async () => {
  const rig = arm({ itemFails: true })
  const outcome = await fetchAndDefine(itemMiss)

  assert.equal(outcome, 'refused')
  // The distinction this test exists for. The schema ALLOWS a real negative (`notFound: true`) and
  // says it stops the engine ever announcing the name again — which is exactly why a network error
  // must not be pushed as one. Burning a name permanently on the strength of a timeout would make
  // the corpus quietly worse the first time the owner's wifi blinked.
  assert.deepEqual(rig.defined, [], 'nothing may be defined when the lookup could not answer')
  assert.equal(rig.notes.length, 1, 'and the refusal is said out loud, once')
  assert.match(rig.notes[0], /could not be answered/)

  installKnowledgeMissFetch(null)
})

test('A REFUSED PUSH NEVER THROWS — the listener runs inside the frame dispatch', async () => {
  // A throw here would surface as a TRANSPORT FAULT and take the connection down: one missing wiki
  // page would cost the app every subscription it holds. Totality is the contract.
  const rig = arm({ defineFails: true })
  assert.equal(await fetchAndDefine(itemMiss), 'refused')
  assert.deepEqual(rig.defined, [])
  installKnowledgeMissFetch(null)
})

test('AN UNARMED PROCESS IS SILENT — a launch with no engine pays one null check', async () => {
  installKnowledgeMissFetch(null)
  assert.equal(await fetchAndDefine(itemMiss), 'unarmed')
})

test('two frames for one name do not open two wiki requests', async () => {
  // BELT AND BRACES, and the leaf says so: the engine announces each name at most once per process,
  // so on the shipped path this never fires. It covers the paths the law does not — an engine
  // RESPAWN is a fresh process with an empty ledger, and the app's serialized queue has an
  // in-flight window long enough for a relaunch to land inside it.
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => (release = resolve))
  const asks: string[] = []
  installKnowledgeMissFetch({
    lookupItem: async (name) => {
      asks.push(name)
      await gate
      return asKnowledgeRecord({ name })
    },
    lookupMob: async (name) => asKnowledgeRecord({ name }),
    define: async () => {
      await Promise.resolve()
    },
    note: () => undefined
  })

  const first = fetchAndDefine(itemMiss)
  const second = await fetchAndDefine(itemMiss)
  assert.equal(second, 'duplicate', 'the second frame rides the first fetch')
  assert.deepEqual(asks, ['Shard of Nothing'], 'and only one request was ever made')

  release?.()
  assert.equal(await first, 'defined')

  // AND THE NAME LEAVES THE SET WHEN THE FETCH SETTLES — the point is not to remember what was
  // fetched (the engine's overlay is that memory) but to avoid two simultaneous requests, so a
  // later miss for the same name is fetchable again.
  assert.equal(await fetchAndDefine(itemMiss), 'defined')
  assert.deepEqual(asks, ['Shard of Nothing', 'Shard of Nothing'])

  installKnowledgeMissFetch(null)
})
