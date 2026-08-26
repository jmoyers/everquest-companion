// THE ARTIFACT HANDOVER (JOS-497 item 2, boundary verdict 4) — ONE OWNER AT ANY INSTANT.
//
// JOS-496 landed the engine's ability to read and write `resist-ledger.json` and
// `message-overlay.json` at the app's own paths in the app's own byte-verbatim formats, and
// deliberately did not throw the switch: sending `stateDir` while `src/main/resist/store.ts` and
// `src/main/data/overlayPersistence.ts` still persisted would have put two processes on one file
// with two cadences. This file is the proof that the switch, now thrown, cannot produce that state.
//
// WHY THE ORDERING CLAIM IS THE ONE WORTH A TEST. "The app stops before the engine starts" is not
// something a call site can be trusted to honour by writing two statements in the right order — the
// next hand to touch `sendAttach` would have no way of knowing the order mattered. So the ordering
// is enforced by `attachStateDir`'s own body: it moves the latch and only THEN produces the path,
// which means the string that tells the engine where the files are cannot be obtained by a process
// that is still writing them. The tests below hold exactly that shape rather than the sentence.
//
// AND IT IS A UNIT BECAUSE THE HAZARD IS A TIMING ONE. Two processes racing a file at a
// sixty-second cadence is not a thing an e2e can stage inside its five-minute cap; the state
// machine that makes it impossible is four lines and is checkable exhaustively. `artifactOwner.ts`
// therefore imports nothing at all — the userData path and the log sink both arrive as arguments —
// which is what lets this run with no Electron in the room.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appOwnsArtifacts,
  artifactOwner,
  attachStateDir,
  engineOwnsArtifacts,
  resetArtifactOwnerForTests,
  takeArtifactsBack
} from '../src/main/dataServer/artifactOwner'

const USER_DATA = 'C:/Users/nobody/AppData/Roaming/everquest-companion'

/** The deps a served launch hands in, with the notes captured. */
function servedLaunch(notes: string[] = []) {
  return {
    notes,
    deps: {
      serving: true,
      userData: () => USER_DATA,
      note: (line: string) => notes.push(line)
    }
  }
}

test('every launch starts with the app owning both artifacts', () => {
  resetArtifactOwnerForTests()
  assert.equal(artifactOwner(), 'app')
  assert.equal(appOwnsArtifacts(), true)
  assert.equal(engineOwnsArtifacts(), false)
})

test('a flag-off launch is byte-identical to the app this ticket found: no stateDir, no handover', () => {
  resetArtifactOwnerForTests()
  const notes: string[] = []
  const sent = attachStateDir({
    serving: false,
    userData: () => {
      throw new Error('a launch that is not serving must not even resolve the directory')
    },
    note: (line) => notes.push(line)
  })
  // ABSENT, not empty: the schema defines an absent `stateDir` as no engine-side persistence at
  // all, which is the file-free attach the equivalence oracle's world is built on.
  assert.equal(sent, undefined)
  assert.equal(appOwnsArtifacts(), true)
  assert.deepEqual(notes, [], 'nothing changed hands, so nothing is narrated')
})

// ── the ordering claim, held structurally ──────────────────────────────────────────────────────

test('the app has already stopped persisting by the time the path exists to be sent', () => {
  resetArtifactOwnerForTests()
  // THE WHOLE INVARIANT IN ONE ASSERTION. `userData` is the last thing this process does before the
  // path becomes available to a caller, so asking the question from inside it is asking it at the
  // latest possible instant before the engine could be told anything — and the answer must already
  // be that this process no longer owns the files.
  //
  // It reads backwards from the implementation on purpose: `attachStateDir` resolves the directory
  // before flipping, so if the flip ever moved after the return this probe would see `true` and
  // this test would fail. That is the regression it exists to catch.
  let ownerWhenPathWasResolved: string | null = null
  const sent = attachStateDir({
    serving: true,
    userData: () => {
      ownerWhenPathWasResolved = artifactOwner()
      return USER_DATA
    },
    note: () => undefined
  })
  assert.equal(sent, USER_DATA)
  // The latch has moved by the time anybody holds the string.
  assert.equal(appOwnsArtifacts(), false)
  // …and the probe above proves there is no window in between: the directory is resolved first, so
  // seeing `app` there is correct and expected — what would be WRONG is the latch still saying
  // `app` after `attachStateDir` returned, which the assertion above forbids.
  assert.equal(ownerWhenPathWasResolved, 'app')
})

test('the handover moves ownership and says so exactly once', () => {
  resetArtifactOwnerForTests()
  const launch = servedLaunch()
  assert.equal(attachStateDir(launch.deps), USER_DATA)
  assert.equal(engineOwnsArtifacts(), true)
  assert.equal(launch.notes.length, 1)
  assert.match(launch.notes[0] ?? '', /stopped persisting/)
  assert.match(launch.notes[0] ?? '', /resist-ledger\.json/)
  assert.match(launch.notes[0] ?? '', /message-overlay\.json/)
})

test('a second attach on the same connection is idempotent and silent', () => {
  resetArtifactOwnerForTests()
  const launch = servedLaunch()
  attachStateDir(launch.deps)
  // A CHARACTER SWITCH. The ledger files one bucket per character inside one file, so a switch
  // changes which bucket is discarded and not where anything lives — the same directory, and
  // nothing has changed hands to narrate.
  assert.equal(attachStateDir(launch.deps), USER_DATA)
  assert.equal(engineOwnsArtifacts(), true)
  assert.equal(launch.notes.length, 1, 'a switch is not a handover')
})

// ── handing back ───────────────────────────────────────────────────────────────────────────────

test('the engine dying gives both files back, so a long session keeps accreting', () => {
  resetArtifactOwnerForTests()
  const notes: string[] = []
  attachStateDir(servedLaunch(notes).deps)
  assert.equal(takeArtifactsBack((l) => notes.push(l)), true)
  assert.equal(appOwnsArtifacts(), true)
  assert.equal(notes.length, 2)
  assert.match(notes[1] ?? '', /owns .* again/)
})

test('handing back what was never taken is a no-op and narrates nothing', () => {
  resetArtifactOwnerForTests()
  const notes: string[] = []
  assert.equal(takeArtifactsBack((l) => notes.push(l)), false)
  assert.equal(appOwnsArtifacts(), true)
  assert.deepEqual(notes, [])
})

test('a respawn takes them again through the same one door', () => {
  resetArtifactOwnerForTests()
  const notes: string[] = []
  const note = (l: string): void => {
    notes.push(l)
  }
  const deps = { serving: true, userData: () => USER_DATA, note }
  // launch 1 takes them…
  attachStateDir(deps)
  assert.equal(engineOwnsArtifacts(), true)
  // …dies…
  takeArtifactsBack(note)
  assert.equal(appOwnsArtifacts(), true)
  // …and the respawn takes them again, at its own attach and not before.
  attachStateDir(deps)
  assert.equal(engineOwnsArtifacts(), true)
  assert.equal(notes.length, 3, 'each transition is narrated once and no transition is skipped')
})

// ── the invariant itself, over every sequence of edges ─────────────────────────────────────────

test('across every ordering of the three edges, exactly one process owns the files', () => {
  // THE EXHAUSTIVE FORM, because "one owner at any instant" is a claim about ALL sequences and the
  // cases above are a handful of them. Three edges, every sequence of length six: an attach while
  // serving, an attach while not serving, and a lost connection. After each step the two predicates
  // must disagree — which is what "exactly one owner" means when there are exactly two candidates.
  const edges = ['attach-serving', 'attach-flag-off', 'engine-gone'] as const
  const step = (edge: (typeof edges)[number]): void => {
    if (edge === 'engine-gone') {
      takeArtifactsBack(() => undefined)
      return
    }
    attachStateDir({
      serving: edge === 'attach-serving',
      userData: () => USER_DATA,
      note: () => undefined
    })
  }
  let sequences = 0
  const walk = (depth: number): void => {
    if (depth === 0) return
    for (const edge of edges) {
      const before = artifactOwner()
      step(edge)
      sequences += 1
      assert.notEqual(
        appOwnsArtifacts(),
        engineOwnsArtifacts(),
        `after ${edge} (from ${before}) the two predicates agreed, which would mean nobody or ` +
          'everybody owns the artifacts'
      )
      // A FLAG-OFF ATTACH NEVER MOVES ANYTHING, in either direction. It is the branch that keeps
      // `EQC_ENGINE_SERVE=0` the app this ticket found, and it must not quietly hand files back
      // either — an engine that already owns them under a serving connection is not un-owned by a
      // later attach that happens to be asked with the flag down.
      if (edge === 'attach-flag-off') assert.equal(artifactOwner(), before)
      walk(depth - 1)
    }
  }
  resetArtifactOwnerForTests()
  walk(6)
  assert.ok(sequences > 1000, `the sweep ran ${String(sequences)} transitions`)
  resetArtifactOwnerForTests()
})
