// THE WATCHER'S OWN CALLS, MADE (JOS-182 — the successor to tests/presenceWatcherScript.test.mts).
//
// The suite it replaces existed because the watcher's whole program was a PowerShell STRING inside
// a TypeScript module, so nothing in the test run had ever executed a line of it — and a
// `Get-Process` that answers nothing about a live process lived in that string for four releases
// (JOS-164). That file compiled the shipped C# with `Add-Type` and called into it, which was the
// best a test could do about a program made of text.
//
// There is no text any more. `src/main/presenceNative.ts` is ordinary TypeScript, so this file
// simply IMPORTS the shipped surface and calls it — the same four questions, against this machine,
// with real pids. Nothing here is a copy of the implementation: the module under test is the
// module the app loads.
//
// WHAT EACH TEST IS ACTUALLY FOR. The failure mode this surface has to survive is not "the call
// returns the wrong number", it is "the call returns NOTHING and the watcher believes it" — which
// is precisely how JOS-164's install lost overlay auto-hide and the cursor ring for two days. So
// the assertions are about the FAILURE DIRECTIONS as much as the answers: an unreadable process
// answers empty rather than garbage, a failed enumeration is distinguishable from an empty one,
// and a cursor the surface cannot see reads as visible.
//
// Windows-only, and it says so rather than passing vacuously: `startWatcher` never starts a
// watcher off Windows and `koffi.load('user32.dll')` has nothing to open there. CI runs on
// `windows-latest`, so these do not skip there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { loadPresenceNative, type PresenceNative } from '../src/main/presenceNative'
import { eqRootPrefix } from '../src/main/presenceProtocol'

const NOT_WINDOWS = process.platform !== 'win32' && 'the presence surface is user32/kernel32/psapi'

/** A pid high enough that no real process owns it. The kernel's answer to this is the one refusal
 *  that must not be mistaken for an answer. */
const NO_SUCH_PID = 2147483632

/** Loaded once. The load is itself the module's only throwing path, so a failure here fails every
 *  test in the file with the right message rather than being caught and skipped past. */
let native: PresenceNative | null = null
function surface(): PresenceNative {
  native ??= loadPresenceNative()
  return native
}

test('THE SURFACE LOADS AT ALL — three system libraries and ten exports', { skip: NOT_WINDOWS }, () => {
  // The whole error path of `presenceNative.ts`. If this throws on a machine, the watcher says
  // `X|native-unavailable`, exits, and the app fails open — so this test is also the statement of
  // what "unavailable" means: not a bad answer, an absent one.
  assert.doesNotThrow(() => surface())
})

test('the CURSOR answers a boolean, and answers it fast enough to gate an 8 ms stream', {
  skip: NOT_WINDOWS
}, () => {
  // This is the one call that runs on every tick (JOS-120), so "does it work" and "is it cheap"
  // are the same question. The budget is deliberately loose — a CI runner is not this machine, and
  // the number that matters (0.43 us measured locally) is recorded in presenceProtocol.ts's
  // cadence note. What this catches is a regression of a different ORDER: a marshalling change
  // that turns a syscall into something with allocation in it.
  const s = surface()
  assert.equal(typeof s.cursorShowing(), 'boolean')
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 2000; i++) s.cursorShowing()
  const usPerCall = Number(process.hrtime.bigint() - t0) / 2000 / 1000
  assert.ok(usPerCall < 50, `a tick-rate call cost ${usPerCall.toFixed(2)} us`)
})

test('the FOREGROUND WINDOW comes back as a pid and a rectangle', { skip: NOT_WINDOWS }, () => {
  const fg = surface().foreground()
  // Null is legitimate (a locked session has no foreground window) and is not a failure, so the
  // assertions are conditional on having one rather than demanding one — a test that fails on a
  // locked build agent is a flake, not a guard.
  if (fg === null) return
  assert.ok(Number.isInteger(fg.pid) && fg.pid >= 0, `pid ${String(fg.pid)}`)
  for (const [name, v] of Object.entries({ x: fg.x, y: fg.y, width: fg.width, height: fg.height })) {
    // NEGATIVE COORDINATES ARE ORDINARY — a window on a left or upper secondary monitor has them,
    // which is why nothing downstream clamps them. Only non-integers would be a decode bug.
    assert.ok(Number.isInteger(v), `${name} is not an integer: ${String(v)}`)
  }
  assert.equal(typeof fg.title, 'string')
  // The title is read with the length the call returns, so it can never carry the tail of a
  // previous, longer window's title out of the reused buffer.
  assert.equal(fg.title.includes('\0'), false, 'no NUL padding leaked out of the reused buffer')
})

test('IMAGE PATHS answer for this process, and answer EMPTY for one that is not there', {
  skip: NOT_WINDOWS
}, () => {
  // `QueryFullProcessImageNameW` on a PROCESS_QUERY_LIMITED_INFORMATION handle is what replaced
  // .NET's `.MainModule.FileName` in JOS-164, because that opened the process and THREW for every
  // protected one. It answers for far more processes and costs less — and, critically, it has one
  // failure value rather than an exception.
  const s = surface()
  const self = s.imagePath(process.pid)
  assert.match(self.toLowerCase(), /\\(node|electron)\.exe$/, `a full image path, not a name: ${self}`)
  assert.equal(s.imagePath(NO_SUCH_PID), '', 'a pid that is not there answers empty, not garbage')
})

test('THE RUNNING SCAN finds a process under a given root, and never confuses -1 with 0', {
  skip: NOT_WINDOWS
}, () => {
  // The scan that decides `eqRunning`, and therefore — with the shipped `hideWhenNotRunning`
  // default — whether every overlay is on screen. On JOS-164's reporting machine the .NET version
  // of this answered 0 for a machine with the game running, which hides every overlay forever.
  const s = surface()
  const ownRoot = eqRootPrefix(dirname(process.execPath))
  assert.equal(s.eqRunning(ownRoot), 1, 'this very process lives under that root')

  // NOT asserted as 0: the machine running this suite may have EverQuest open, and that is a
  // legitimate 1. What must never happen is -1, which is the enumeration itself failing — the
  // value the loop reads as "hold the last answer" rather than "the game vanished".
  assert.notEqual(s.eqRunning('ZZ:\\nowhere\\'), -1, 'the enumeration works')
  // An empty root disables path matching entirely and leaves only the client image name, which is
  // the posture on an install whose EQ directory could not be resolved.
  assert.notEqual(s.eqRunning(''), -1)
})
