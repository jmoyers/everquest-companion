// ONE WORLD, ONE NUMBERING SPACE — the delta arm, the mark command and the served fact (JOS-493).
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
  assert.notEqual(IPC.onModuleDelta, IPC.onModuleChanged)
  assert.equal(IPC.onModuleDelta, 'module:delta')
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

test('BOTH hooks read `served` off the snapshot rather than reading a flag', () => {
  for (const hook of HOOKS) {
    const mod = code(hook)
    assert.match(
      mod,
      /served = snap\.served === true/,
      `${hook} does not take the world from the snapshot it just hydrated`
    )
    // The shim decides PER CALL, so an opinion formed anywhere but a hydrate would go stale.
    assert.doesNotMatch(
      mod,
      /EQC_ENGINE|process\.env/,
      `${hook} reached for a launch flag; the answer is a property of the ANSWER`
    )
  }
})

test('a TS-fold increment is NOT folded into an engine-served snapshot', () => {
  for (const hook of HOOKS) {
    const mod = code(hook)
    const apply = /const applyOne = \(([\s\S]*?)\n {4}\}/.exec(mod)
    assert.ok(apply, `${hook}: applyOne is gone`)
    assert.match(
      apply[0],
      /if \(served\) return/,
      `${hook}: applyOne folds main's own increments whatever world it is in`
    )
  }
})

test('and an engine cursor is NOT acted on while holding main’s own snapshot', () => {
  for (const hook of HOOKS) {
    const mod = code(hook)
    assert.match(
      mod,
      /if \(!served\) return/,
      `${hook}: the cursor handler acts on a world it is not folding`
    )
    // The dirty bit carries no state by design; the answer to it is the snapshot op.
    assert.match(mod, /if \(c\.seq <= knownSeq\) return/, `${hook}: a cursor we already hold refetches`)
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

test('a cursor that raced the hydrate is remembered, not dropped', () => {
  // No later frame restates a cursor already reported (the protocol sends nothing for a module whose
  // seq did not move), so dropping one would freeze that module until something else moved it.
  for (const hook of HOOKS) {
    const mod = code(hook)
    assert.match(mod, /if \(c\.seq > pendingSeq\) pendingSeq = c\.seq/, `${hook}: the race is dropped`)
    assert.match(
      mod,
      /if \(served && pendingSeq > knownSeq\) hydrate\(\)/,
      `${hook}: the remembered cursor is never settled`
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

test('nothing is pushed when this launch turned the serve flag OFF', () => {
  const mod = code('../src/main/dataServer/serveDeltas.ts')
  // DEFAULT-ON SINCE JOS-495, through the one predicate all five readers of these variables share.
  // The inversion had to land HERE as well as in `serveShim.ts` or the two halves of the read path
  // would disagree on every ordinary launch — served snapshots, suppressed cursors, frozen surfaces.
  // The whole matrix, and the audit that catches a sixth reader, live in tests/engineFlagDefault.
  assert.match(mod, /const SERVE_ASKED = engineFlagOn\(process\.env\.EQC_ENGINE_SERVE\)/)
  // Both exported pushes are gated, and gated FIRST — a fan-out that allocated a frame before
  // checking would still be paying for a feature the launch did not ask for.
  for (const fn of ['pushModuleChanged', 'pushWorldChanged']) {
    const decl = new RegExp(`export function ${fn}\\([^)]*\\): void \\{\\s*if \\(!SERVE_ASKED\\) return`)
    assert.match(mod, decl, `${fn} is not gated on the serve flag`)
  }
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
  assert.match(host, /if \(first\) \{\s*pushWorldChanged\(\)[\s\S]*?primeMirrors\(\)\s*\}/)
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

test('…and only after BOTH of this process’s halves accepted it', () => {
  const mod = code('../src/main/sessionMarks.ts')
  const refusal = mod.indexOf('if (!combat.sessionMark(at)) return marks')
  const dedupe = mod.indexOf('next[next.length - 1] !== at')
  const told = mod.indexOf('serveSessionMark(at)')
  assert.ok(refusal >= 0 && dedupe >= 0 && told >= 0)
  assert.ok(refusal < told, 'a mark the combat engine refused is announced to the engine anyway')
  assert.ok(dedupe < told, 'a deduped double press is announced as a second split')
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

test('the command is gated by the SAME answer the read path uses', () => {
  const command = code('../src/main/dataServer/serveCommands.ts')
  assert.match(command, /if \(!shimServing\(\)\) return/, 'the command invented its own gate')
})

// ── 3b. the second command (JOS-494) ───────────────────────────────────────────────────

test('THE CONFIRM CARRIES A ROW AND NEVER AN INSTANT', () => {
  // The mark's whole subject is a moment main stamped; this one's is a ROW, and the instant it
  // re-bases onto is the row's own `seenTs` — a LOG timestamp the fold already holds. A clock read
  // anywhere on this path would be the app moving an engine clock to a moment the engine's log
  // never stated, which is the pin above from the other direction. `Date.now()` in this file is
  // already forbidden by the mark's test; this is the params shape.
  const command = code('../src/main/dataServer/serveCommands.ts')
  assert.match(command, /engineRequest\('respawn\.confirmSighting', \{ rowId \}\)/)
  assert.match(command, /export function serveConfirmSighting\(rowId: string\): void/)
  // Both commands ask the same gate — a second one would be a second opinion about whether this
  // launch's answers are the engine's.
  assert.equal(
    (command.match(/if \(!shimServing\(\)\) return/g) ?? []).length,
    2,
    'a command in this file stopped asking the serve gate'
  )
})

test('…and it is pushed only AFTER this process applied it, and only when it took', () => {
  // `serveCommands.ts`'s own law, the mark's "both halves or neither" applied to one half: a press
  // this app itself read as a no-op — a stale click, a row that died between the render and the
  // button — must not be announced to a second world as though it happened.
  const ipc = code('../src/main/ipc/respawn.ts')
  const applied = ipc.indexOf('const applied = respawnModule.confirmSighting(id)')
  const told = ipc.indexOf('serveConfirmSighting(id)')
  assert.ok(applied >= 0 && told >= 0, 'the confirm handler no longer has both halves')
  assert.ok(applied < told, 'the engine is told before this process has an answer of its own')
  // INSIDE the `if`, not beside it — the flush and the push share the gate that the apply took.
  const guarded = /if \(applied\) \{([\s\S]*?)\n {4}\}/.exec(ipc)
  assert.ok(guarded, 'the confirm handler stopped guarding its follow-up duties')
  assert.match(guarded[1], /serveConfirmSighting\(id\)/, 'a refused press is announced anyway')
})

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

test('the harness seam projects what the SHIM would serve, not a second spelling of it', () => {
  // A spec comparing the two arms has to be comparing the answer the product would have been given,
  // graft included; two projections would let the e2e pin a code path nothing ships.
  const shim = code('../src/main/dataServer/serveShim.ts')
  assert.equal((shim.match(/projectModule\(moduleId, r\)/g) ?? []).length, 2)
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

test('the con-card hook is ALWAYS installed — the handoff is per-`/con`, not per-launch', () => {
  const card = code('../src/main/conCard.ts')
  // No condition around the registration. A hook skipped at boot on a flag that does not mean what
  // it looks like is a card that silently never appears again.
  assert.match(
    card,
    /considerModule\.setConCardHook\(\(ev, zone\) => \{\s*if \(engineDrawsCards\(\)\) return/
  )
  assert.doesNotMatch(card, /if \(!serving\)/, 'the launch-time skip came back — see the section note')
})

test('the handoff asks the SAME authority the read path does, and both halves of it', () => {
  const ipc = code('../src/main/ipc/index.ts')
  // `shimServing()` alone would be the bug above; `engineServeReadiness()` alone would draw no card
  // on a launch that deliberately turned serving off while an engine ran beside it. Both, and
  // nothing newly invented — one gate, one authority.
  assert.match(ipc, /registerConCardIpc\(\(\) => shimServing\(\) && engineServeReadiness\(\)\.ok\)/)
})

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
