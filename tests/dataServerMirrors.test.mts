// THE MIRROR ARM (JOS-496, cutover ledger item 6) — the third shape the cutover needs.
//
// `serveShim.ts` moved the app's three GENUINE fold queries onto the engine, because a query has an
// `ipcMain.handle` body to put an await in. The census's other readers are SYNCHRONOUS and do not:
// `viewerLevel()` is called from inside a profile builder on every draw, and `inventoryWrittenAt` is
// handed to the inventory parser AS A FUNCTION. `serveMirrors.ts` is what answers those — a small
// pushed cache refreshed on the engine's own publication cursor.
//
// EVERY CLAIM BELOW IS A TIMING CLAIM, which is exactly why this is a unit and not an e2e: a reply
// that lands after a world change, a burst of cursors during one in-flight refresh, a cursor that
// arrives out of order, a refusal — none of them can be staged against a real engine, and all of
// them are a two-line fake here. That is `readShim.ts`'s argument, and the module takes even its log
// sink as a dependency so this file can run with no Electron at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIRRORED_MODULES,
  installMirrors,
  mirroredModuleState,
  noteMirrorChanged,
  primeMirrors,
  resetMirrors,
  type MirrorReply
} from '../src/main/dataServer/serveMirrors'

/** A requester whose replies are handed out one at a time, so a test can hold one in flight. */
function engine() {
  const asked: string[] = []
  const notes: string[] = []
  let pending: ((reply: MirrorReply) => void)[] = []
  let rejectNext: string | null = null
  return {
    asked,
    notes,
    install(): void {
      installMirrors({
        request: (module) => {
          asked.push(module)
          if (rejectNext !== null) {
            const why = rejectNext
            rejectNext = null
            return Promise.reject(new Error(why))
          }
          return new Promise<MirrorReply>((resolve) => pending.push(resolve))
        },
        note: (line) => notes.push(line)
      })
    },
    refuseNext(why: string): void {
      rejectNext = why
    },
    /** Answer every request that is waiting, in order, and let the microtasks run. */
    async answer(...replies: MirrorReply[]): Promise<void> {
      const waiting = pending
      pending = []
      waiting.forEach((resolve, i) => {
        const r = replies[i]
        if (r !== undefined) resolve(r)
      })
      await Promise.resolve()
      await Promise.resolve()
    },
    inFlight(): number {
      return pending.length
    }
  }
}

function reply(module: string, seq: number, state: unknown): MirrorReply {
  return { module, seq, state }
}

test.beforeEach(() => {
  installMirrors(null)
})

// ---- the fallback contract -------------------------------------------------------------

test('with no engine installed EVERY read is null, which is every caller asking its own fold', () => {
  // THE LAUNCH THIS DESCRIBES IS THE ORDINARY ONE for a dev checkout with no `cargo build`, and it
  // is also every moment before the engine goes live. `null` is not an error state here, it is the
  // flag-off world — `ipc/resist.ts viewerLevel` and `session.ts inventoryWrittenAt` both `??` past
  // it into the app's own module, so a mirror that never fills in costs one comparison.
  for (const id of MIRRORED_MODULES) assert.equal(mirroredModuleState(id), null)
  // …and a cursor arriving with nothing installed asks nobody anything rather than throwing.
  noteMirrorChanged('character', 4)
  assert.equal(mirroredModuleState('character'), null)
})

test('an UNMIRRORED module is never asked about — the list is closed, not a lazy cache', async () => {
  const e = engine()
  e.install()
  noteMirrorChanged('loot', 9)
  noteMirrorChanged('buffs', 9)
  await e.answer()
  assert.deepEqual(e.asked, [])
  // A module off the list reads null forever, which is the honest answer: nothing is mirroring it.
  assert.equal(mirroredModuleState('loot'), null)
})

// ---- the priming edge ------------------------------------------------------------------

test('PRIMING IS NOT OPTIONAL: a module that has gone quiet will never send another cursor', async () => {
  // THE BUG THIS PINS. The engine publishes a cursor when a module MOVES. A `character` module that
  // finished folding and is sitting in a zone does not move for minutes — so a mirror that waited
  // for a cursor would fall back on every single draw of a card the engine could answer perfectly.
  // The go-live edge is what asks the first time.
  const e = engine()
  e.install()
  primeMirrors()
  assert.deepEqual(e.asked, [...MIRRORED_MODULES])
  await e.answer(reply('character', 3, { level: { level: 52 } }), reply('outputFiles', 1, { 'inventory.txt': 7 }))
  assert.deepEqual(mirroredModuleState('character'), { level: { level: 52 } })
  assert.deepEqual(mirroredModuleState('outputFiles'), { 'inventory.txt': 7 })
})

// ---- the cursor ------------------------------------------------------------------------

test('a cursor the mirror already holds is not re-asked, and a newer one is', async () => {
  const e = engine()
  e.install()
  noteMirrorChanged('character', 5)
  await e.answer(reply('character', 5, { level: { level: 60 } }))
  assert.deepEqual(e.asked, ['character'])
  // The same seq, and an older one, are both already covered — re-asking would be a round trip per
  // publication beat for a fact that did not move.
  noteMirrorChanged('character', 5)
  noteMirrorChanged('character', 4)
  await e.answer()
  assert.deepEqual(e.asked, ['character'])
  noteMirrorChanged('character', 6)
  await e.answer(reply('character', 6, { level: { level: 61 } }))
  assert.deepEqual(e.asked, ['character', 'character'])
  assert.deepEqual(mirroredModuleState('character'), { level: { level: 61 } })
})

test('A BURST OF CURSORS IS ONE ROUND TRIP, not one per frame', async () => {
  // The engine coalesces to at most one frame per module per serve beat, but a busy tail still
  // produces a steady stream of them. A refresh already in flight will be superseded by the next
  // cursor anyway, so starting a second is a round trip whose answer is discarded before it lands.
  const e = engine()
  e.install()
  noteMirrorChanged('character', 1)
  noteMirrorChanged('character', 2)
  noteMirrorChanged('character', 3)
  assert.equal(e.inFlight(), 1)
  assert.deepEqual(e.asked, ['character'])
})

test('a reply that lands out of order cannot move the mirror BACKWARDS', async () => {
  const e = engine()
  e.install()
  noteMirrorChanged('character', 9)
  await e.answer(reply('character', 9, { level: { level: 60 } }))
  // An engine that answered a fresh ask with an older cursor is a bookkeeping failure somewhere;
  // the mirror keeps what it has rather than un-learning a ding.
  noteMirrorChanged('character', 10)
  await e.answer(reply('character', 8, { level: { level: 51 } }))
  assert.deepEqual(mirroredModuleState('character'), { level: { level: 60 } })
})

test('THE ECHO TEST: an answer for a module we did not ask about is not held under that name', async () => {
  // `serveShim.ts projectModule`'s test, one level down and for its reason: holding another
  // module's state under this module's name is the one outcome that cannot be debugged.
  const e = engine()
  e.install()
  noteMirrorChanged('character', 2)
  await e.answer(reply('outputFiles', 2, { 'inventory.txt': 1 }))
  assert.equal(mirroredModuleState('character'), null)
})

// ---- the world edges -------------------------------------------------------------------

test('a world change DROPS every mirror — a served level is a fact about one log', async () => {
  const e = engine()
  e.install()
  primeMirrors()
  await e.answer(reply('character', 1, { level: { level: 52 } }), reply('outputFiles', 1, {}))
  assert.notEqual(mirroredModuleState('character'), null)
  resetMirrors()
  for (const id of MIRRORED_MODULES) assert.equal(mirroredModuleState(id), null)
})

test('a reply that lands AFTER a world change is dropped rather than resurrecting the old world', async () => {
  // THE RACE THIS PINS is the one every `await` in `engineClientHost.ts` is followed by a generation
  // check for: a character switch happens while a refresh is in flight, and the reply describes the
  // character the player has just left. Writing it would put the previous character's level on the
  // next card drawn.
  const e = engine()
  e.install()
  noteMirrorChanged('character', 1)
  resetMirrors()
  await e.answer(reply('character', 1, { level: { level: 52 } }))
  assert.equal(mirroredModuleState('character'), null)
})

test('uninstalling clears the mirrors, so a departed engine leaves no served fact behind', async () => {
  const e = engine()
  e.install()
  primeMirrors()
  await e.answer(reply('character', 1, { level: { level: 52 } }), reply('outputFiles', 1, {}))
  installMirrors(null)
  assert.equal(mirroredModuleState('character'), null)
})

// ---- the refusal -----------------------------------------------------------------------

test('A REFUSAL IS THE FALLBACK PATH, not an error, and it is narrated exactly once', async () => {
  const e = engine()
  e.install()
  e.refuseNext('the engine is on another log')
  noteMirrorChanged('character', 1)
  await e.answer()
  // The mirror keeps what it had — nothing — and every caller reads that as "no answer yet".
  assert.equal(mirroredModuleState('character'), null)
  assert.equal(e.notes.length, 1)
  assert.match(e.notes[0] ?? '', /character could not be refreshed/)
  // The note names the STALENESS, not a second world (JOS-501): "the app's own fold answers" was
  // true until JOS-499 deleted that fold, after which it sent readers hunting for a disagreeing
  // fold that does not exist.
  assert.match(e.notes[0] ?? '', /readers keep the last served value/)
  // COALESCED for `readShim.ts`'s reason: these are pushed at a cadence, and a line per failure
  // would bury the very narration a developer opened the dev log to read.
  e.refuseNext('still refusing')
  noteMirrorChanged('character', 2)
  await e.answer()
  assert.equal(e.notes.length, 1)
})

test('a refusal does not wedge the module: the next cursor is asked again', async () => {
  // `inFlight` has to be cleared on the failure path too, or one refused refresh would silence the
  // module for the life of the launch.
  const e = engine()
  e.install()
  e.refuseNext('nope')
  noteMirrorChanged('character', 1)
  await e.answer()
  noteMirrorChanged('character', 2)
  await e.answer(reply('character', 2, { level: { level: 52 } }))
  assert.deepEqual(mirroredModuleState('character'), { level: { level: 52 } })
})

// ---- the list --------------------------------------------------------------------------

test('the mirrored list is exactly the two synchronous readers that have nowhere to put an await', () => {
  // A CLOSED LIST, pinned so a member joins it deliberately: each one costs a round trip per
  // publication beat in which it moved. `character` is `ipc/resist.ts viewerLevel` (every draw of a
  // resist card and every `/con` chip); `outputFiles` is `session.ts inventoryWrittenAt`, handed to
  // the inventory parser by reference and called mid-parse.
  assert.deepEqual([...MIRRORED_MODULES], ['character', 'outputFiles'])
})
