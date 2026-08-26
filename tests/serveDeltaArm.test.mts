// THE CURSOR ARM, THE MARK COMMAND AND THE SERVED FACT (JOS-493, pruned by JOS-499).
//
// THIS FILE USED TO BE ABOUT ARBITRATION BETWEEN TWO WORLDS. With `EQC_ENGINE_SERVE=1` a
// renderer hydrated its snapshot from the RUST ENGINE and then rode `module:delta` out of the
// TypeScript fold, so `knownSeq` and `delta.seq` were unrelated numbers and every increment was
// dropped as a dupe. Twelve of its claims were about telling those two worlds apart — which hook
// rides which channel, what the `served` flag decides, what a flag-off launch pushes, which half
// gates a command. THE SECOND WORLD IS DELETED, so those claims are not weakened, they are
// unstatable: there is nothing left to arbitrate.
//
// WHAT SURVIVES IS EVERYTHING THAT WAS NEVER ABOUT THE ARBITRATION — the two channels being
// distinct names on both bridges, the world-change id colliding with no module, the racing-cursor
// guard, the unsubscribe discipline, the fan-out reaching the same windows the rebuild does, the
// mark carrying the instant main already stamped, and the served-mtime graft being quoted rather
// than re-derived (owner ruling 21).
//
// THE DEFECT THESE PINS EXIST FOR, in one sentence: with `EQC_ENGINE_SERVE=1` a renderer hydrated
// its module snapshot from the RUST ENGINE and then rode `module:delta` out of the TypeScript fold,
// so `knownSeq` and `delta.seq` were unrelated numbers and every increment was dropped as a dupe
// (MEASURED at engine seq 4 against app seq 3 on a respawn watch; STRUCTURAL for the four modules
// that publish a private revision counter — combo, character, respawn, buffTimers).
//
// WHAT CAN BE PINNED HERE AND WHAT CANNOT. The behaviour end to end needs a real engine, a real
// socket and two renderers, and it is claimed by `tests/e2e/engine-shim.e2e.mts` and the
// engine-on suite. What a node suite CAN hold is the set of structural properties the fix rests on,
// each of which would compile, ship and fail silently if it regressed:
//
//   1. THE TWO CHANNELS ARE DISTINCT and both bridges expose the second one under the SAME name —
//      `tests/sessionMarks.test.mts` pin 3's argument, and the same failure mode: a second name for
//      one signal is how the two windows end up folding two different worlds.
//   2. EACH FOLDER RIDES EXACTLY ONE OF THEM, and the SNAPSHOT decides which. A hook that read a
//      flag instead would hold a stale opinion the moment the shim fell back mid-session.
//   3. THE MARK IS STILL ONE INSTANT. The engine's command must carry the number main already
//      stamped — a second clock read here would be a third boundary. AND ITS SIBLING CARRIES NONE
//      (JOS-494): `respawn.confirmSighting` names a ROW, because the instant it re-bases onto is
//      one the fold already holds — so the pin there is the params shape and the ORDER, which is
//      the mark's "both halves or neither" applied to one half.
//   4. THE SERVED FACT IS QUOTED, NEVER RE-DERIVED (owner ruling 21). The shim grafts the mtime the
//      ENGINE reported; a `statSync` in that file would prove nothing about who owns the fact.
//
// SOURCE PINS in `tests/fightSelection.test.mts`' technique — comments are stripped first, because
// this repo explains itself in prose that would otherwise satisfy its own greps. They are source
// pins rather than behavioural ones because every module involved reaches Electron: the hooks are
// renderer React, `serveShim.ts` imports the error log, and `serveDeltas.ts` imports the pipeline.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IPC } from '../src/shared/ipc'
import { MODULE_WORLD_CHANGED } from '../src/shared/types'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** The same file with its COMMENTS removed — see the header. */
const code = (rel: string): string =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** The two folding hooks. They are separate files by an old decision (`useOverlayModule.ts`'s
 *  header) and they hydrate through the SAME ipc handler, so every rule below binds both. */
const HOOKS = [
  '../src/renderer/src/lib/useModule.ts',
  '../src/renderer/src/overlay/useOverlayModule.ts'
] as const

// ── 1. the two channels ────────────────────────────────────────────────────────────────

test('the increment channel and the cursor channel are DISTINCT names', () => {
  // THE INCREMENT CHANNEL IS GONE (JOS-499), so the claim inverts: there is no second channel for
  // a cursor to be confused with, and `IPC` must not carry a name nothing produces.
  assert.equal((IPC as Record<string, unknown>).onModuleDelta, undefined)
  assert.equal(IPC.onModuleChanged, 'module:changed')
})

test('ONE HOOK, BOTH BUNDLES: both preload bridges expose onModuleChanged, on that channel', () => {
  for (const bridge of ['../src/preload/index.ts', '../src/preload/overlay.ts']) {
    const mod = code(bridge)
    assert.match(mod, /\bonModuleChanged:/, `${bridge} is missing onModuleChanged`)
    assert.match(
      mod,
      /ipcRenderer\.on\(IPC\.onModuleChanged, listener\)/,
      `${bridge} subscribes onModuleChanged to some other channel`
    )
    assert.match(
      mod,
      /removeListener\(IPC\.onModuleChanged, listener\)/,
      `${bridge} hands back a way to stop listening that does not stop this listener`
    )
  }
})

test('the world-change id is one nothing registers, so it can never collide with a module', () => {
  assert.equal(MODULE_WORLD_CHANGED, '*')
  // Every module id in this app is a bare identifier (`loot`, `buffTimers`); the wildcard is not.
  assert.doesNotMatch(MODULE_WORLD_CHANGED, /^[A-Za-z_$][\w$]*$/)
})

// ── 2. each folder rides exactly one channel, and the SNAPSHOT decides which ────────────




test('a cursor that raced the hydrate is remembered, not dropped', () => {
  // UNCHANGED IN SUBSTANCE BY JOS-499, and worth keeping for exactly that reason: this was the
  // subtlest of the JOS-493 pins and it is the one claim of the delta wave that survives the
  // deletion intact. A `module:changed` arriving while a snapshot fetch is in flight cannot be
  // dropped — the reply it raced may have been taken from the engine BEFORE that cursor moved,
  // and no later frame restates a cursor already reported. It terminates because a re-fetch
  // answers at or past the cursor that provoked it.
  for (const rel of ['../src/renderer/src/lib/useModule.ts', '../src/renderer/src/overlay/useOverlayModule.ts']) {
    const hook = code(rel)
    assert.match(hook, /pendingSeq/)
    assert.match(hook, /if \(pendingSeq > knownSeq\) hydrate\(\)/)
  }
})

test('a world change re-hydrates unconditionally — it is the one frame with no cursor to compare', () => {
  for (const hook of HOOKS) {
    const mod = code(hook)
    assert.match(
      mod,
      /if \(c\.moduleId === MODULE_WORLD_CHANGED\) \{\s*hydrate\(\)/,
      `${hook}: a world change is filtered by moduleId like an ordinary cursor`
    )
  }
})


test('every subscription is unsubscribed — a hook that leaked one would fold a dead module', () => {
  for (const hook of HOOKS) {
    const mod = code(hook)
    assert.match(mod, /const offChanged = window\.eq(Overlay)?\.onModuleChanged\(/, hook)
    assert.match(mod, /offChanged\(\)/, `${hook}: the cursor subscription is never released`)
  }
})

// ── the wire half: who is told, and under what gate ────────────────────────────────────

test('the cursor fan-out reaches the SAME windows the increments do', () => {
  const mod = code('../src/main/dataServer/serveDeltas.ts')
  assert.match(mod, /sendToMain\(IPC\.onModuleChanged, frame\)/)
  // pipeline.ts owns the module-reading overlay list, and a second copy of it is exactly how the
  // overlays came to be missing from a fan-out once already (JOS-172).
  assert.match(mod, /sendToModuleOverlays\(IPC\.onModuleChanged, frame\)/)
  assert.doesNotMatch(mod, /OVERLAY_KINDS/, 'the overlay list was copied instead of reused')
})


test('a cursor from a replaced connection, or from an engine that is not serving reads, is not forwarded', () => {
  const host = code('../src/main/dataServer/engineClientHost.ts')
  const listener = /client\.onModuleChanged\(\(changed\) => \{([\s\S]*?)\n {2}\}\)/.exec(host)
  assert.ok(listener, 'the engine client no longer forwards moduleChanged')
  // A SUBSCRIPTION IS CONNECTION-SCOPED, NOT TURN-SCOPED, and this pin is the scar: the first draft
  // guarded with `gen !== mine`, the rule every `await` in that file is followed by. `gen` advances
  // on every world rebuild, so the listener went permanently silent the moment this process's own
  // fold landed — a loot line played into the log never reached the ledger and a watched respawn
  // never drew a clock. Identity, not generation.
  assert.match(listener[1], /if \(live\?\.client !== client\) return/, 'the listener is turn-scoped again')
  assert.doesNotMatch(listener[1], /gen !== mine/, 'the generation guard came back — see above')
  assert.match(
    listener[1],
    /if \(!engineServeReadiness\(\)\.ok\) return/,
    'a cursor is forwarded while the READ path is answering from the app’s own fold'
  )
})

test('both edges where the serving world changes hands are announced', () => {
  const host = code('../src/main/dataServer/engineClientHost.ts')
  // Going live: the shim starts serving, so windows holding main's own state should take the
  // engine's. Taken once per turn, off the `first` test, because the health loop can run many times.
  assert.match(host, /const first = engineLiveOn === null/)
  assert.match(host, /if \(first\) \{\s*pushWorldChanged\(\)/, 'the announce is still off the `first` test')
  // …AND MAIN'S OWN SYNCHRONOUS READERS ARE PRIMED ON THE SAME EDGE (JOS-496). It has to be this
  // one and not the first read: the engine publishes a cursor when a module MOVES, and a module
  // that has finished folding and gone quiet will not move again for minutes — so a mirror waiting
  // for a cursor would fall back on every draw of a card the engine could answer perfectly. The two
  // sit in one block because they are one statement about one moment: the world changed hands.
  // The `\s*\}` that used to close this pattern is gone (JOS-499): the same block now also writes
  // the GO-LIVE SENTENCE, which replaced the parity line as the app's statement that the engine has
  // started answering its reads — and two e2e specs use it as their readiness precondition. The
  // claim is unchanged and is the one that matters: both announcements sit inside the `first` test,
  // in one block, because they are one statement about one moment. What may follow them there is
  // not this assertion's business.
  assert.match(host, /if \(first\) \{\s*pushWorldChanged\(\)[\s\S]*?primeMirrors\(\)/)
  // …and the sentence itself is in that block rather than somewhere a re-poll could repeat it.
  assert.match(host, /if \(first\) \{[\s\S]*?debug\(servingLine\(/)
  // Going away: a window holding a served snapshot is IGNORING module:delta because it was served,
  // so without this frame it would sit frozen until the next character rebuild.
  const edges = host.match(/const wasServing = engineLiveOn !== null/g) ?? []
  assert.equal(edges.length, 2, 'the loss edge is asked in exactly the two places that let go')
  assert.equal((host.match(/if \(wasServing\) pushWorldChanged\(\)/g) ?? []).length, 2)
})

// ── 3. the mark is still ONE instant ───────────────────────────────────────────────────

test('THE ENGINE’S COMMAND CARRIES THE INSTANT MAIN ALREADY STAMPED', () => {
  const mod = code('../src/main/sessionMarks.ts')
  // `tests/sessionMarks.test.mts` pins that there is exactly one `Date.now()` in this file; this
  // pins that the third holder of the boundary got THAT number and not one of its own.
  assert.match(mod, /serveSessionMark\(at\)/, 'the engine is told some other instant, or none')
  const command = code('../src/main/dataServer/serveCommands.ts')
  assert.doesNotMatch(command, /Date\.now\(\)/, 'the command file started stamping its own boundary')
  assert.match(command, /engineRequest\('sessionMarks\.add', \{ at \}\)/)
})


test('the press never waits on the socket, and a refusal is not an error', () => {
  const command = code('../src/main/dataServer/serveCommands.ts')
  assert.match(command, /export function serveSessionMark\(at: number\): void/, 'the press became async')
  assert.match(command, /void engineRequest\(/, 'the round trip is awaited somewhere')
  // `accepted: false` is the protocol's honest "not now" while the historical fold runs — the same
  // state this process's own `combat.sessionMark` refuses in. It is a line, never a throw.
  assert.match(command, /ack\.accepted \?/)
  assert.doesNotMatch(command, /\bthrow\b/)
})


// ── 3b. the second command (JOS-494) ───────────────────────────────────────────────────



test('a confirm is a COMMAND, not app knowledge — it does not ride the define push', () => {
  // The line between the two files is what a push MEANS. A define is a preference the engine's
  // world RECORDS and re-applies at the next attach; a command is a thing that happened and is
  // stored by nobody. The same ipc file uses both doors, one per duty, and `respawn.define` is
  // still the only family it names.
  const ipc = code('../src/main/ipc/respawn.ts')
  assert.equal(
    (ipc.match(/pushAppKnowledge\('respawn\.define'\)/g) ?? []).length,
    2,
    'the two preference setters stopped announcing the family'
  )
  assert.doesNotMatch(ipc, /pushAppKnowledge\('respawn\.confirmSighting'/)
  const push = code('../src/main/dataServer/definePush.ts')
  assert.doesNotMatch(push, /confirmSighting/, 'a command joined the define family')
})

// ── 4. the served fact is quoted, never re-derived ─────────────────────────────────────

test('the graft uses the mtime the ENGINE served, and this process never stats the log for it', () => {
  const shim = code('../src/main/dataServer/serveShim.ts')
  assert.match(shim, /const mtime = engineLogMtimeMs\(\)/, 'the graft lost its source')
  // Ruling 21: the app could stat the file in one line, and doing so would prove nothing about who
  // owns the fact. Quoting the served one is what makes the answer evidence.
  assert.doesNotMatch(shim, /statSync|node:fs/, 'the shim started deriving the fact it is meant to quote')
})

test('absent stays absent — a missing mtime never becomes a lastPlayed of 1970', () => {
  const shim = code('../src/main/dataServer/serveShim.ts')
  assert.match(shim, /if \(mtime === null\) return state/)
  const host = code('../src/main/dataServer/engineClientHost.ts')
  assert.match(host, /engineLogMtime = health\.logMtimeMs \?\? null/, 'the health read stopped recording it')
  // It dies with the turn, exactly as `engineLiveOn` does: an mtime measured on a world somebody has
  // since replaced is a fact about a different file.
  const bump = /function bumpGen\(\): number \{([\s\S]*?)\n\}/.exec(host)
  assert.ok(bump, 'bumpGen is gone')
  assert.match(bump[1], /engineLogMtime = null/, 'the served mtime outlives the turn that measured it')
})

test('ONLY the character module is grafted, and only that one field', () => {
  const shim = code('../src/main/dataServer/serveShim.ts')
  assert.match(shim, /const CHARACTER_MODULE = 'character'/)
  assert.match(shim, /moduleId === CHARACTER_MODULE \? graftLastPlayed\(r\.state\) : r\.state/)
  const graft = /function graftLastPlayed\(state: unknown\): unknown \{([\s\S]*?)\n\}/.exec(shim)
  assert.ok(graft, 'graftLastPlayed is gone')
  // A shim that rewrote any other served field would manufacture agreement, which is the opposite
  // of what an instrument is for.
  assert.equal((graft[1].match(/lastPlayed/g) ?? []).length, 1)
})


test('the served snapshot SAYS it was served, and the app’s own arm never does', () => {
  const shim = code('../src/main/dataServer/serveShim.ts')
  assert.match(shim, /return \{ seq: r\.seq, state, served: true \}/)
  const world = code('../src/main/ipc/world.ts')
  assert.doesNotMatch(world, /served/, 'the app’s own arm started claiming it was served')
})

// ── 5. who draws the con card (JOS-496, boundary verdict 2) ────────────────────────────
//
// THE BUG THESE EXIST FOR is one this ticket wrote and then caught in its own audit, and it earns
// a whole section because the shape is a repeat offender in this feature: `shimServing()` IS NOT
// "AN ENGINE EXISTS". It is `EQC_ENGINE` AND `EQC_ENGINE_SERVE`, both default-ON since JOS-495, so
// it answers TRUE on every dev checkout that has never run `cargo build` — where there is no
// binary, no client, and no frame will ever arrive. A publisher handed off on that answer alone
// goes permanently silent in exactly the tree `engineHost.ts`'s header promises "exactly the app it
// got before this ticket", and in any packaged build whose engine failed to spawn.



test('the engine card takes the engine’s HEADER, and the chips are still joined here', () => {
  const card = code('../src/main/conCard.ts')
  // Verdict 2's full form is "resist profile joined engine-side", and verdict 8 (the client spell
  // table) has not landed — so `engined/src/concard.rs` honestly sends the five EMPTY chips.
  // Carrying those through would make every card under serve read "nothing seen yet" forever while
  // the app holds a ledger that can answer: a regression wearing a cutover's clothes.
  assert.match(card, /const \{ chips, spellData \} = chipsFor\(card\.name, await servedMobLevel\(card\.name\)\)/)
  const serve = code('../src/main/dataServer/conCardServe.ts')
  assert.doesNotMatch(serve, /chips/, 'the engine’s empty chips started being carried across')
  // …AND THE ONE INPUT THAT DID MOVE (JOS-497 item 1). The chips are still built here, off the
  // app's own ledger, but the creature's LEVEL is no longer read out of this process's fold inside
  // the profile builder — it is asked of whichever world answers this app's reads. That is the
  // census's last synchronous fold reader closing, and it is pinned here because the shape it
  // replaced (`resistProfileDeps()` with no argument) still compiles and would silently put the
  // read back.
  assert.doesNotMatch(
    code('../src/main/ipc/resist.ts'),
    /levelOf: \(key, display\) => resistModule\.levelOf\(key, display\),/,
    'the unconditional synchronous levelOf came back — see JOS-497 item 1'
  )
})

test('the suppression and the Preferences switch stay app-side, in ONE place for both worlds', () => {
  const card = code('../src/main/conCard.ts')
  // `openCard` is what both `noteConsider` and `noteEngineConCard` call. The re-open suppression is
  // measured on the WALL clock and its only input is a window event that reaches no fold; a second
  // copy of either gate is how two worlds come to disagree about what the person asked for.
  assert.equal((card.match(/conCardSuppressed\(closedAt\.get\(key\), now\)/g) ?? []).length, 1)
  assert.equal((card.match(/getOverlayConfig\('conCard'\)\.open/g) ?? []).length, 1)
  assert.match(card, /return openCard\(payload, card\.id, now\)/)
})
