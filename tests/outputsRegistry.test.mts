// ============================================================================
// THE `/outputfile` REGISTRY — the facts half (JOS-44).
// ============================================================================
//
// `shared/outputs/kinds.ts` is the ONE place that knows, per export command: what the player
// types, one clause of why, what the file is called, and whether we may parse it. Both the main
// process (find + watch + parse) and the renderer (the freshness line) read it, which is the
// whole point — before this the command string was hand-typed per surface.
//
// So what is pinned here is the CONTRACT the two sides rely on:
//   * every kind carries a command, a why-clause and a distinct filename suffix, and the command
//     is spelled the way the game's own kind id is (a typo'd command is a user typing a typo);
//   * the filename PREFERENCE rule — which of several dumps belongs to this character — is a
//     pure function over names, so it is proved here without a filesystem;
//   * the no-guessing law's flags stay coherent: only a `supported` kind may claim a verified
//     filename suffix.
//
// The disk half (`src/main/outputs/registry.ts`: does it exist, its mtime, the watcher) needs
// `effectiveEqRoot()` and therefore electron-store, so it is exercised by the app itself and by
// `tests/e2e/planner.e2e.mts`, not from here. What that half CAN be held to without a disk is
// that it never invents facts of its own — every field of `OutputFileStatus` below either comes
// from a def or from a stat.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isOutputFileName,
  outputFileNames,
  outputFileStatus,
  outputKind,
  preferredOutputFile,
  OUTPUT_KINDS
} from '../src/shared/outputs/kinds'
import { outputAgeLabel, outputUpdatedMillis } from '../src/renderer/src/lib/outputFreshness'

const INVENTORY = outputKind('inventory')

// ---------------------------------------------------------------------------
// THE FACTS
// ---------------------------------------------------------------------------

test('every kind states a command, a why-clause and a distinct file suffix', () => {
  assert.ok(OUTPUT_KINDS.length > 0)
  const ids = OUTPUT_KINDS.map((k) => k.id)
  assert.equal(new Set(ids).size, ids.length, 'kind ids are unique')

  for (const def of OUTPUT_KINDS) {
    // The command is the game's, spelled from the kind's own id — a surface renders it verbatim,
    // so a drift between id and command would have the app teaching a command that does nothing.
    assert.equal(def.command, `/outputfile ${def.id}`, `${def.id} command`)
    assert.ok(def.fileKind.length > 0, `${def.id} has a file suffix`)
    // ONE CLAUSE, addressed to the player. Not a caveat, not methodology: no semicolons, no
    // parenthetical hedges, and short enough to sit on a compact single-line row.
    assert.ok(def.why.length > 0 && def.why.length <= 120, `${def.id} why-clause is one clause`)
    assert.ok(!def.why.includes(';'), `${def.id} why-clause is not two sentences`)
    assert.ok(def.note.length > 0, `${def.id} has a note`)
  }

  const suffixes = OUTPUT_KINDS.map((k) => k.fileKind.toLowerCase())
  assert.equal(new Set(suffixes).size, suffixes.length, 'file suffixes are distinct')
})

test('the no-guessing law: only a graduated kind may claim a verified filename', () => {
  for (const def of OUTPUT_KINDS) {
    if (def.status === 'awaiting-sample') {
      assert.equal(def.fileKindVerified, false, `${def.id} has no verified sample`)
    }
  }
  // Inventory is the one kind measured on the dev machine (Primitive_freeport-Inventory.txt).
  assert.equal(INVENTORY.status, 'supported')
  assert.equal(INVENTORY.fileKindVerified, true)
  assert.equal(INVENTORY.fileKind, 'Inventory')
  assert.equal(INVENTORY.command, '/outputfile inventory')
})

test('an unknown kind throws rather than resolving to undefined', () => {
  // The union is closed, so this can only be reached by a cast — which is exactly the case the
  // throw exists for (a channel payload, a persisted id from a future version).
  assert.throws(() => outputKind('mercenaries' as (typeof OUTPUT_KINDS)[number]['id']), /Unknown output kind/)
})

// ---------------------------------------------------------------------------
// THE FILENAME PATTERN
// ---------------------------------------------------------------------------

test('a kind claims its own files, case-insensitively, and nobody else’s', () => {
  assert.ok(isOutputFileName(INVENTORY, 'Primitive_freeport-Inventory.txt'))
  assert.ok(isOutputFileName(INVENTORY, 'primitive_freeport-inventory.txt'))
  assert.ok(isOutputFileName(INVENTORY, 'Primitive-Inventory.txt'))
  // Another kind's dump, the log itself, and a near-miss suffix are all not ours.
  assert.equal(isOutputFileName(INVENTORY, 'Primitive_freeport-Guild.txt'), false)
  assert.equal(isOutputFileName(INVENTORY, 'eqlog_Primitive_freeport.txt'), false)
  assert.equal(isOutputFileName(INVENTORY, 'Inventory.txt'), false, 'the hyphen is part of the rule')
  assert.equal(isOutputFileName(INVENTORY, 'Primitive-Inventory.txt.bak'), false)
  assert.ok(isOutputFileName(outputKind('guild'), 'Primitive_freeport-Guild.txt'))
})

test('the preferred filenames are most-specific first, and stop where knowledge stops', () => {
  assert.deepEqual(outputFileNames(INVENTORY, 'Primitive', 'freeport'), [
    'Primitive_freeport-Inventory.txt',
    'Primitive-Inventory.txt'
  ])
  // A server with no character names nothing: the `_server` form needs both halves.
  assert.deepEqual(outputFileNames(INVENTORY, undefined, 'freeport'), [])
  assert.deepEqual(outputFileNames(INVENTORY, 'Primitive'), ['Primitive-Inventory.txt'])
  assert.deepEqual(outputFileNames(INVENTORY), [])
})

test('a character’s own dump wins over a newer one belonging to somebody else', () => {
  // Newest first, as discovery hands them over: the OTHER character dumped more recently.
  const files = ['Alt_freeport-Inventory.txt', 'Primitive_freeport-Inventory.txt']
  assert.equal(
    preferredOutputFile(files, INVENTORY, 'Primitive', 'freeport'),
    'Primitive_freeport-Inventory.txt',
    'the named character’s file, not the newest file'
  )
  // …and case never decides it (the client’s spelling of the server is not ours to assume).
  assert.equal(
    preferredOutputFile(['ALT_FREEPORT-INVENTORY.TXT', 'primitive_FREEPORT-Inventory.txt'], INVENTORY, 'Primitive', 'freeport'),
    'primitive_FREEPORT-Inventory.txt'
  )
})

test('the bare <name>-Kind.txt form is the fallback, and the newest file the last resort', () => {
  // The `_server` form is absent, so the older resolver's form resolves.
  assert.equal(
    preferredOutputFile(['Alt-Inventory.txt', 'Primitive-Inventory.txt'], INVENTORY, 'Primitive', 'freeport'),
    'Primitive-Inventory.txt'
  )
  // Nothing matches the character at all ⇒ the newest file, which is what a one-character
  // machine always lands on (measured: the dev machine only ever has the `_server` form).
  assert.equal(
    preferredOutputFile(['Somebody_else-Inventory.txt', 'Older-Inventory.txt'], INVENTORY, 'Primitive', 'freeport'),
    'Somebody_else-Inventory.txt'
  )
  // No character named at all — same rule, no crash.
  assert.equal(preferredOutputFile(['A-Inventory.txt'], INVENTORY), 'A-Inventory.txt')
  // And no candidates is a null answer, never a throw: it is the never-run state.
  assert.equal(preferredOutputFile([], INVENTORY, 'Primitive', 'freeport'), null)
})

// ---------------------------------------------------------------------------
// THE CAPTURE STEPS (JOS-185)
// ---------------------------------------------------------------------------

test('the inventory kind teaches how to capture the CONDITIONAL storages, not just the command', () => {
  const steps = INVENTORY.steps
  const all = steps.join('\n')
  // The three storages `/outputfile inventory` exports only under a condition the file never
  // states, plus the one it never exports at all. Each is a game fact with a source in the
  // registry's own header; a step deleted here is a player's items going quietly missing.
  assert.match(all, /Bank/)
  assert.match(all, /Hoard/)
  assert.match(all, /Depot/)
  assert.match(all, /Wind Runes/)

  // ORDER IS THE CONTENT: opening the hoard AFTER typing the command captures nothing, so every
  // window step must precede the step that types it.
  const typeAt = steps.findIndex((s) => s.includes(INVENTORY.command))
  assert.ok(typeAt > 0, 'the command is a step, and it is not the first one')
  for (const s of [/Bank/, /Hoard/, /Depot/]) {
    assert.ok(
      steps.slice(0, typeAt).some((step) => s.test(step)),
      `the ${String(s)} step must come before the command is typed`
    )
  }

  // A kind with no verified sample teaches nothing it has not measured — the no-guessing law
  // reaches the instructions too, not just the parser.
  for (const kind of OUTPUT_KINDS.filter((k) => k.status === 'awaiting-sample')) {
    assert.deepEqual(kind.steps, [], `${kind.id} must not invent capture steps`)
  }
})

// ---------------------------------------------------------------------------
// THE STATUS SHAPE (what crosses IPC)
// ---------------------------------------------------------------------------

test('a status is the def’s facts plus the file’s own mtime — nothing invented', () => {
  // `outputStatus` (main) is this constructor over one `findOutputFile` + one `stat`; the stat is
  // the only part that needs a disk, so the JOIN itself is pinned here. What matters is that
  // `command`/`why`/`fileKind`/`supported` are READ OFF the def — a surface must never render a
  // string the registry did not state — and that `updatedAt` is the FILE's, never the read's.
  const dumpedAt = '2026-08-05T18:04:00.000Z'
  const path = 'C:\\EQ\\Primitive_freeport-Inventory.txt'
  assert.deepEqual(outputFileStatus(INVENTORY, { path, updatedAt: dumpedAt }), {
    kind: 'inventory',
    command: '/outputfile inventory',
    why: INVENTORY.why,
    fileKind: 'Inventory',
    // The capture steps ride the same status (JOS-185), for the same reason the command does: a
    // surface must never invent them, and there is exactly one place that states them.
    steps: INVENTORY.steps,
    supported: true,
    path,
    updatedAt: dumpedAt
  })
  assert.ok(INVENTORY.steps.length > 0, 'the one graduated kind carries real capture steps')

  // THE NEVER-RUN STATE: both halves null together, structurally — there is no argument shape
  // that names a file it cannot date, or dates one it cannot name.
  const never = outputFileStatus(outputKind('guild'), null)
  assert.equal(never.path, null)
  assert.equal(never.updatedAt, null)
  assert.equal(never.supported, false, 'an awaiting-sample kind is never claimed as supported')
  assert.equal(never.command, '/outputfile guild')
  assert.equal(never.why, outputKind('guild').why)

  // Every kind can produce a never-run status without throwing — that is the state a machine
  // that has run none of these commands is in, which is most machines.
  for (const def of OUTPUT_KINDS) {
    const s = outputFileStatus(def, null)
    assert.equal(s.kind, def.id)
    assert.equal(s.updatedAt, null)
  }
})

// ---------------------------------------------------------------------------
// THE LINE'S THREE STATES (the words, without a DOM)
// ---------------------------------------------------------------------------

test('the freshness line reads never-run, fresh and stale out of one slot', () => {
  const now = Date.parse('2026-08-05T18:00:00.000Z')

  // NEVER RUN — no file, so no age is claimed and the absence is stated in words.
  assert.equal(outputAgeLabel(outputUpdatedMillis(undefined), now), 'not yet run')

  // FRESH — the dump the player just wrote, and one from earlier in the session.
  assert.equal(outputAgeLabel(outputUpdatedMillis('2026-08-05T17:59:30.000Z'), now), 'updated just now')
  assert.equal(outputAgeLabel(outputUpdatedMillis('2026-08-05T17:38:00.000Z'), now), 'updated 22m ago')

  // STALE — the same slot, the same wording, a bigger number. That number IS the warning; there
  // is no threshold, because EverQuest does not define one.
  assert.equal(outputAgeLabel(outputUpdatedMillis('2026-08-05T14:00:00.000Z'), now), 'updated 4h ago')
  assert.equal(outputAgeLabel(outputUpdatedMillis('2026-08-02T18:00:00.000Z'), now), 'updated 3d ago')

  // A garbled mtime is the never-run state, not `updated NaN ago` and not the epoch.
  assert.equal(outputUpdatedMillis('not a date'), undefined)
  assert.equal(outputAgeLabel(outputUpdatedMillis('not a date'), now), 'not yet run')

  // …and a clock that is behind the file (mid-session DST, a network drive) never reads as a
  // future age: `formatAge` floors at zero, so it says "just now".
  assert.equal(outputAgeLabel(outputUpdatedMillis('2026-08-05T18:05:00.000Z'), now), 'updated just now')
})
