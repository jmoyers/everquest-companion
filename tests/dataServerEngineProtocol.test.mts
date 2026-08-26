// The PURE half of the engine supervisor (JOS-467): the announce line's grammar, the restart
// schedule, the exit-trail fold, and where the binary is looked for.
//
// These are the rules a wrong supervisor loses QUIETLY. A loose announce regex does not fail — it
// connects to the wrong port and reports success. An unfolded exit trail does not fail — it fills
// the fleet's error store with 245 copies of one true sentence (JOS-164 measured exactly that). An
// uncapped backoff does not fail — it becomes a restart storm against a machine that will never run
// the binary. Every one of those is a test here rather than something somebody notices in
// production, which is the whole reason this half imports nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENGINE_DETAIL_MAX,
  ENGINE_EXIT_LOOP_ERROR_NAME,
  ENGINE_HOST,
  ENGINE_QUICK_EXIT_MS,
  ENGINE_QUICK_EXIT_STREAK,
  ENGINE_RESTART_BACKOFF_MS,
  NEW_ENGINE_EXIT_TRAIL,
  boundedDetail,
  engineBinaryCandidates,
  engineExitStep,
  engineRestartDelayMs,
  isCargoTargetBinary,
  parseAnnounce,
  stagedEngineNames,
  type EngineExitCause,
  type EngineExitTrail
} from '../src/main/dataServer/engineProtocol'

// ---- 1. the announce line --------------------------------------------------------------

test('the announce line is read exactly as the contract spells it', () => {
  assert.deepEqual(parseAnnounce('EQC-ENGINE PORT=51413 PROTOCOL=1'), { port: 51413, protocolVersion: 1 })
  // A pipe on Windows may carry the line ending a text-mode writer produced. A line ending is not
  // a protocol violation - `ndjson.ts` strips the same byte for the same reason.
  assert.deepEqual(parseAnnounce('EQC-ENGINE PORT=1 PROTOCOL=0\r'), { port: 1, protocolVersion: 0 })
})

test('NOTHING ELSE IS AN ANNOUNCE LINE — a loose regex would read a port out of a panic', () => {
  for (const line of [
    '',
    ' EQC-ENGINE PORT=8080 PROTOCOL=1',
    'EQC-ENGINE PORT=8080 PROTOCOL=1 ',
    'EQC-ENGINE PORT=8080 PROTOCOL=1 extra',
    'listening: EQC-ENGINE PORT=8080 PROTOCOL=1',
    "thread 'main' panicked at src/main.rs:12: PORT=8080",
    'EQC-ENGINE PROTOCOL=1 PORT=8080',
    'EQC-ENGINE  PORT=8080 PROTOCOL=1',
    'eqc-engine PORT=8080 PROTOCOL=1',
    'EQC-ENGINE PORT=8080',
    'EQC-ENGINE PORT=-1 PROTOCOL=1',
    'EQC-ENGINE PORT=8080 PROTOCOL=x'
  ]) {
    assert.equal(parseAnnounce(line), null, `accepted \`${line}\``)
  }
})

test('a port outside the range a socket can hold is refused, PORT=0 included', () => {
  // The engine binds port 0 to ASK for an ephemeral port; the port it ANNOUNCES is the one the OS
  // gave it, and that is never 0. A literal `PORT=0` means it printed the argument, not the answer.
  assert.equal(parseAnnounce('EQC-ENGINE PORT=0 PROTOCOL=1'), null)
  assert.equal(parseAnnounce('EQC-ENGINE PORT=65536 PROTOCOL=1'), null)
  assert.deepEqual(parseAnnounce('EQC-ENGINE PORT=65535 PROTOCOL=1'), { port: 65535, protocolVersion: 1 })
})

test('the host is a NUMERIC loopback literal, never the name localhost', () => {
  // A name resolves through whatever the machine's resolver says today; a numeric literal cannot be
  // pointed elsewhere. `src/main/feedback/net.ts` set this precedent and token.ts's header promised
  // this feature would keep it.
  assert.equal(ENGINE_HOST, '127.0.0.1')
})

// ---- 2. the backoff --------------------------------------------------------------------

test('the restart backoff climbs and then CAPS — an uncapped retry is a restart storm', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => engineRestartDelayMs(n)),
    [...ENGINE_RESTART_BACKOFF_MS]
  )
  const ceiling = ENGINE_RESTART_BACKOFF_MS[ENGINE_RESTART_BACKOFF_MS.length - 1]
  assert.equal(engineRestartDelayMs(6), ceiling)
  assert.equal(engineRestartDelayMs(9999), ceiling, 'every later failure sits on the ceiling')
  // A failure count that is not a count still has to produce a delay: the first step, never a NaN
  // handed to setTimeout (which fires IMMEDIATELY and turns a backoff into a busy loop).
  assert.equal(engineRestartDelayMs(0), ENGINE_RESTART_BACKOFF_MS[0])
  assert.equal(engineRestartDelayMs(Number.NaN), ENGINE_RESTART_BACKOFF_MS[0])
})

// ---- 3. the exit trail -----------------------------------------------------------------

function cause(over: Partial<EngineExitCause> = {}): EngineExitCause {
  return {
    failure: 'exited',
    exitCode: 1,
    signal: null,
    lifetimeMs: 40,
    attempt: 1,
    detail: null,
    ...over
  }
}

test('EVERY REPORT IS A NAME/MESSAGE/CODE TRIPLE the error store can fingerprint', () => {
  // The mistake this exists to not repeat is childProcessGone.ts's: a bare `{reason, exitCode}` has
  // no `name` and no `message`, and `caughtFields` reads exactly those - so the loudest new family
  // in the fleet was filed as the literal text `Error: ` for five releases.
  const step = engineExitStep(NEW_ENGINE_EXIT_TRAIL, cause({ exitCode: 3221225477 }))
  assert.ok(step.log)
  assert.equal(step.log.name, 'EngineExited')
  assert.ok(step.log.message.length > 0)
  // The exit code AGAIN, machine-readable, because `redactMessage` folds runs of five or more
  // digits to `<n>` and a Windows crash code is ten digits.
  assert.equal(step.log.code, 3221225477)
  assert.match(step.log.message, /attempt 1/)
})

test('each failure mode is its OWN fingerprint — one bug must not bury another', () => {
  const names = (['spawn-failed', 'announce-timeout', 'bad-announce', 'unhealthy', 'exited'] as const).map(
    (failure) => engineExitStep(NEW_ENGINE_EXIT_TRAIL, cause({ failure }))?.log?.name
  )
  assert.equal(new Set(names).size, names.length, `two failure modes share a name: ${names.join(', ')}`)
  assert.ok(!names.includes(ENGINE_EXIT_LOOP_ERROR_NAME), 'the collapsed name must be distinct too')
})

test('A CRASH LOOP MINTS ONE ERROR NAME, NOT FIFTY', () => {
  let trail: EngineExitTrail = NEW_ENGINE_EXIT_TRAIL
  const logs: (string | undefined)[] = []
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const step = engineExitStep(trail, cause({ attempt, lifetimeMs: 40 }))
    trail = step.trail
    if (step.log) logs.push(step.log.name)
  }
  // The first two are ordinary exemplars - a single fast failure really can be a one-off, and
  // silencing it would trade this bug for a quieter one. The third carries the diagnosis. Nothing
  // after it is logged at all.
  assert.equal(logs.length, ENGINE_QUICK_EXIT_STREAK)
  assert.deepEqual(logs.slice(0, -1), ['EngineExited', 'EngineExited'])
  assert.equal(logs[logs.length - 1], ENGINE_EXIT_LOOP_ERROR_NAME)
  assert.equal(trail.collapsed, true)
  assert.equal(trail.streak, ENGINE_QUICK_EXIT_STREAK, 'the streak is HELD, never run away with')
})

test('a launch that lived a while RESETS the trail — an hourly hiccup never collapses', () => {
  let trail = engineExitStep(NEW_ENGINE_EXIT_TRAIL, cause()).trail
  trail = engineExitStep(trail, cause()).trail
  assert.equal(trail.streak, 2, 'two fast failures in')
  const slow = engineExitStep(trail, cause({ lifetimeMs: ENGINE_QUICK_EXIT_MS + 1 }))
  assert.deepEqual(slow.trail, NEW_ENGINE_EXIT_TRAIL)
  assert.equal(slow.log?.name, 'EngineExited', 'and it is still reported, ordinarily')
})

test('the collapsed entry says WHY it stopped talking, and carries the last failure', () => {
  let trail = NEW_ENGINE_EXIT_TRAIL
  let log = null
  for (let i = 0; i < ENGINE_QUICK_EXIT_STREAK; i += 1) {
    const step = engineExitStep(trail, cause({ attempt: i + 1, detail: 'STATUS_DLL_NOT_FOUND' }))
    trail = step.trail
    log = step.log
  }
  assert.ok(log)
  assert.equal(log.exits, ENGINE_QUICK_EXIT_STREAK)
  assert.match(log.message, /launch loop/)
  assert.match(log.message, /STATUS_DLL_NOT_FOUND/, 'the exemplar has to survive the collapse')
  assert.match(log.message, /not logged/, 'a reader must know the silence is deliberate')
})

test('a spawn that never produced a child reports no exit code rather than a fake one', () => {
  const step = engineExitStep(NEW_ENGINE_EXIT_TRAIL, cause({ failure: 'spawn-failed', exitCode: null }))
  assert.equal(step.log?.code, undefined, '`errorCodeOf` takes a number; absent is the honest answer')
  assert.equal(step.log?.exitCode, null)
})

// ---- 4. the detail bound ---------------------------------------------------------------

test('a detail line is bounded by SHAPE, not trusted by provenance', () => {
  // It is text from outside our types heading for errors.log, which is a place text goes to be read
  // by a person - so control bytes (which could forge extra lines) become spaces and the whole
  // thing is capped. Same discipline as presenceProtocol.ts `logSafeTitle`.
  assert.equal(boundedDetail('panicked at \u0000src\nmain.rs'), 'panicked at src main.rs')
  assert.equal(boundedDetail('   '), null, 'whitespace says nothing')
  assert.equal(boundedDetail(undefined), null)
  assert.equal(boundedDetail(new Error('nope')), null, 'only a string is a detail')
  const long = boundedDetail('x'.repeat(ENGINE_DETAIL_MAX * 3))
  assert.equal(long?.length, ENGINE_DETAIL_MAX + 1, 'capped, with the ellipsis that says so')
  assert.ok(long?.endsWith('…'))
})

// ---- 5. where the binary is looked for -------------------------------------------------

test('the binary is PROBED, dev build first, and every candidate is absolute', () => {
  const found = engineBinaryCandidates({
    appPath: 'C:/repo',
    resourcesPath: 'C:/app/resources',
    cwd: 'C:/repo',
    binName: 'engined.exe'
  })
  assert.deepEqual(found, [
    // A developer with a fresh `cargo build` means to run THAT binary, and a stale release build
    // sitting beside it must not silently win.
    'C:/repo/engine/target/debug/engined.exe',
    'C:/repo/engine/target/release/engined.exe',
    // Packaged: beside the asar, which is where electron-builder's extraResources copies the
    // release binary (JOS-473). `tests/enginePackaging.test.mts` pins the config against THIS list.
    'C:/app/resources/engine/engined.exe',
    'C:/app/resources/engined.exe'
  ])
})

test('`cwd` covers the launch where getAppPath() is NOT the checkout', () => {
  // MEASURED, booting the built app: launched against `out-e2e/main/index.js`, `app.getAppPath()`
  // answers `…/out-e2e/main` and the engine tree is two levels above it. `cwd` is the checkout on
  // every launch a developer starts, so the two roots together answer where either alone does not.
  assert.deepEqual(
    engineBinaryCandidates({ appPath: 'C:/repo/out-e2e/main', resourcesPath: '', cwd: 'C:/repo', binName: 'e' }),
    [
      'C:/repo/out-e2e/main/engine/target/debug/e',
      'C:/repo/out-e2e/main/engine/target/release/e',
      'C:/repo/engine/target/debug/e',
      'C:/repo/engine/target/release/e'
    ]
  )
  // …and the common case, where they are the same string, probes each path ONCE.
  assert.deepEqual(engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', cwd: 'C:/r', binName: 'e' }), [
    'C:/r/engine/target/debug/e',
    'C:/r/engine/target/release/e'
  ])
})

test('AN OUTRIGHT NAME WINS, and is still only a candidate (JOS-501)', () => {
  // The e2e harness builds the engine in RELEASE and the probe order prefers DEBUG, so on a machine
  // holding both the suite would have paid for one binary and asserted against the other. The
  // harness therefore states the path. It goes FIRST because nothing derived can be a better answer
  // than the launcher naming the file.
  assert.deepEqual(
    engineBinaryCandidates({
      appPath: 'C:/r',
      resourcesPath: '',
      cwd: 'C:/r',
      binName: 'e',
      override: 'C:/r/engine/target/release/e'
    }),
    [
      'C:/r/engine/target/release/e',
      'C:/r/engine/target/debug/e'
      // …and the release path is NOT repeated: the dedupe that keeps a doubled root from being
      // probed twice covers the override for free.
    ]
  )

  // A BACKSLASH PATH IS THE ORDINARY CASE on Windows — `join()` produces one and every other
  // candidate here is built with `/` — so it is normalised rather than left to defeat the dedupe.
  assert.deepEqual(
    engineBinaryCandidates({
      appPath: 'C:/r',
      resourcesPath: '',
      binName: 'e',
      override: 'C:\\r\\engine\\target\\release\\e'
    }),
    ['C:/r/engine/target/release/e', 'C:/r/engine/target/debug/e']
  )

  // IT SELECTS, IT NEVER DISABLES. An absent or empty override leaves the list exactly as it was —
  // which is what lets `engine-absent.e2e.mts` keep arranging absence with `cwd` alone.
  const plain = engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', binName: 'e' })
  assert.deepEqual(engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', binName: 'e', override: '' }), plain)

  // AND IT IS NOT TRUSTED TO EXIST. The caller `existsSync`es every candidate in order, so a stale
  // value degrades to the ordinary search rather than resolving to a file that is not there.
  assert.deepEqual(
    engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', binName: 'e', override: 'C:/gone/e' }),
    ['C:/gone/e', 'C:/r/engine/target/debug/e', 'C:/r/engine/target/release/e']
  )
})

test('an unknown root contributes no candidates rather than a path rooted at nothing', () => {
  assert.deepEqual(engineBinaryCandidates({ appPath: '', resourcesPath: '', binName: 'e' }), [])
  assert.deepEqual(engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', binName: 'e' }), [
    'C:/r/engine/target/debug/e',
    'C:/r/engine/target/release/e'
  ])
})

// ---- 6. the dev copy (JOS-496) ---------------------------------------------------------
//
// WHY IT EXISTS. Windows takes a mandatory exclusive lock on the image file of a RUNNING process, so
// an app that spawns `engine/target/debug/engined.exe` directly makes the next `cargo build -p
// engined` fail at the LINK step — "Access is denied", not a compile error, which is the confusing
// half. The owner's dev app runs all day and every worker in this program builds the engine; before
// this the two could not both be true. `engineHost.ts` copies the image and spawns the copy.

test('a CARGO TARGET binary is the one to copy, and a PACKAGED one is emphatically not', () => {
  // The two dev candidates `engineBinaryCandidates` builds — the ones cargo writes to.
  assert.ok(isCargoTargetBinary('C:/repo/engine/target/debug/engined.exe'))
  assert.ok(isCargoTargetBinary('C:/repo/engine/target/release/engined.exe'))
  // …AND THE SHIPPED PATH IS ANSWERED FALSE, which is what keeps the packaged launch byte-for-byte
  // the one JOS-473 signed and proved by hand. Nothing overwrites it, so there is nothing to dodge,
  // and a staged copy of a signed binary would be a second file for the AV heuristics and the
  // signature checker to have opinions about for no benefit at all.
  assert.equal(isCargoTargetBinary('C:/app/resources/engine/engined.exe'), false)
  assert.equal(isCargoTargetBinary('C:/app/resources/engined.exe'), false)
  // The predicate is about who ELSE WRITES to the path, so a `target` that is not cargo's engine
  // output — and the staging directory itself, which is where the copies land — are both false.
  assert.equal(isCargoTargetBinary('C:/app/target/debug/engined.exe'), false)
  assert.equal(isCargoTargetBinary('C:/Users/x/AppData/Roaming/eqc/engine-run/engined.exe'), false)
})

test('the predicate is SEPARATOR-BLIND, because `node:path` hands back the other one', () => {
  // MEASURED SHAPE, not defensiveness: `engineBinaryCandidates` builds its strings with `/`, but a
  // path that has been through `join`/`dirname` on Windows comes back with `\`. A predicate that
  // answered false for the same file spelled the other way would stage nothing and leave the lock
  // exactly where it was — a silent no-op, which is the worst kind.
  assert.ok(isCargoTargetBinary('C:\\repo\\engine\\target\\debug\\engined.exe'))
  assert.ok(isCargoTargetBinary('C:\\repo/engine\\target/release\\engined.exe'))
})

test('the staged names keep the EXTENSION, because Windows will not execute a file without one', () => {
  const names = stagedEngineNames('engined.exe')
  assert.deepEqual(names, ['engined.exe', 'engined-1.exe', 'engined-2.exe', 'engined-3.exe'])
  // The first name is the whole story on an ordinary launch: one copy, overwritten next time, no
  // accumulation. The rest cover ONE awkward moment — a respawn whose previous engine has not
  // exited yet and is still holding its own image locked (the supervisor ends a launch on an
  // announce timeout, a bad announce or a failed health probe while the child is still ALIVE).
  assert.equal(names[0], 'engined.exe')
  // BOUNDED, because the failure it covers is transient by construction — the supervisor's `retire`
  // escalates to `kill` after the stop grace — and an unbounded search would turn one wedged child
  // into a directory full of executables.
  assert.equal(names.length, 4)
})

test('a name with no extension still gets distinct siblings (the non-Windows spelling)', () => {
  assert.deepEqual(stagedEngineNames('engined'), ['engined', 'engined-1', 'engined-2', 'engined-3'])
  // …and the split takes the LAST dot, so a versioned name keeps all of its stem.
  assert.deepEqual(stagedEngineNames('a.b.exe').slice(0, 2), ['a.b.exe', 'a.b-1.exe'])
})
