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
import { readFileSync } from 'node:fs'
import {
  ENGINE_DETAIL_MAX,
  ENGINE_EXIT_LOOP_ERROR_NAME,
  ENGINE_HOST,
  ENGINE_PROFILE_BANNER,
  ENGINE_PROFILE_ENV,
  ENGINE_QUICK_EXIT_MS,
  ENGINE_QUICK_EXIT_STREAK,
  ENGINE_RESTART_BACKOFF_MS,
  ENGINE_SERVED_CYCLE_ERROR_NAME,
  ENGINE_SERVED_CYCLE_STREAK,
  NEW_ENGINE_EXIT_TRAIL,
  NEW_ENGINE_SERVED_TRAIL,
  boundedDetail,
  engineBinaryCandidates,
  engineBinaryProfile,
  engineExitStep,
  engineProfileNotice,
  engineProfileOptIn,
  engineRestartDelayMs,
  engineServedCycleStep,
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

// ---- 3b. the OTHER trail: an engine that keeps dying after it served (JOS-519) ----------
//
// The mirror image of the section above, and the pair is the point. That trail asks "is this
// launch loop never going to work" and is reset by a launch reaching READY. This one asks "has a
// WORKING engine been replaced too often to be a coincidence", so reaching READY is what FEEDS it -
// which is exactly why an engine that serves, dies, and always comes back was invisible.

test('THREE DEATHS AFTER SERVING ARE ONE ENTRY, and the count keeps climbing under it', () => {
  let trail = NEW_ENGINE_SERVED_TRAIL
  const logs: (string | undefined)[] = []
  for (let i = 0; i < 10; i += 1) {
    const step = engineServedCycleStep(trail, cause({ detail: 'STATUS_ACCESS_VIOLATION' }))
    trail = step.trail
    if (step.log) logs.push(step.log.name)
  }
  assert.deepEqual(logs, [ENGINE_SERVED_CYCLE_ERROR_NAME], 'one entry per session, not one per death')
  assert.equal(trail.cycles, 10, 'the count is still honest after the entry is written')
  assert.equal(trail.reported, true)
})

test('the entry names the count and the last exit, and is its OWN fingerprint', () => {
  let trail = NEW_ENGINE_SERVED_TRAIL
  let log = null
  for (let i = 0; i < ENGINE_SERVED_CYCLE_STREAK; i += 1) {
    const step = engineServedCycleStep(trail, cause({ detail: 'the engine went away', exitCode: 3221225477 }))
    trail = step.trail
    log = step.log
  }
  assert.ok(log)
  assert.equal(log.exits, ENGINE_SERVED_CYCLE_STREAK)
  assert.equal(log.code, 3221225477, 'the ten-digit code rides the machine-readable field')
  assert.match(log.message, /restarted 3 times this session after serving/)
  assert.match(log.message, /the engine went away/, 'the fold’s own detail, not a second one')
  assert.notEqual(log.name, ENGINE_EXIT_LOOP_ERROR_NAME, 'a working engine dying is a different ticket')
})

test('a death is a death however long the engine lived — this trail has no quick-exit window', () => {
  // `engineExitStep` resets on a slow failure, because an hourly hiccup is not a launch loop. Here
  // an engine that serves for an hour and then dies IS the subject, so nothing about lifetime is
  // consulted at all: three of them, an hour apart, still file the entry.
  let trail = NEW_ENGINE_SERVED_TRAIL
  let log = null
  for (let i = 0; i < ENGINE_SERVED_CYCLE_STREAK; i += 1) {
    const step = engineServedCycleStep(trail, cause({ lifetimeMs: 3_600_000 }))
    trail = step.trail
    log = step.log
  }
  assert.equal(log?.name, ENGINE_SERVED_CYCLE_ERROR_NAME)
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
//
// THE INCIDENT THIS SECTION IS NOW THE MEMORY OF (JOS-520). The order used to be DEBUG BEFORE
// RELEASE, argued as "a developer with a fresh `cargo build` means to run THAT binary". Then the
// integrator ran `cargo test` in the owner's checkout — which writes `target/debug/engined.exe` as
// a side effect of testing the engine — and the owner's dev app silently switched engines on its
// next restart: spell DB 4050 ms instead of 469 ms, parse ~10× slower, catch-up in minutes on a log
// that folds in seconds. The premise was that a debug binary in the tree was put there ON PURPOSE
// by whoever is launching, and a build tool falsifies it without anybody typing anything.

test('the binary is PROBED, and the dev tree contributes RELEASE unless somebody asks otherwise', () => {
  const found = engineBinaryCandidates({
    appPath: 'C:/repo',
    resourcesPath: 'C:/app/resources',
    cwd: 'C:/repo',
    binName: 'engined.exe'
  })
  assert.deepEqual(found, [
    // NO `target/debug` ANYWHERE IN THIS LIST. That is the whole ticket: a debug binary `cargo test`
    // left behind is not a candidate at all on a launch that did not name one.
    'C:/repo/engine/target/release/engined.exe',
    // Packaged: beside the asar, which is where electron-builder's extraResources copies the
    // release binary (JOS-473). `tests/enginePackaging.test.mts` pins the config against THIS list.
    'C:/app/resources/engine/engined.exe',
    'C:/app/resources/engined.exe'
  ])
})

test('THE DEBUG OPT-IN IS EXPLICIT, PER LAUNCH, AND WINS WHEN IT IS GIVEN (JOS-520)', () => {
  const base = { appPath: 'C:/repo', resourcesPath: 'C:/app/resources', cwd: 'C:/repo', binName: 'e' } as const
  // Opted in: debug FIRST, because a launch that asked for the debug engine must not be answered
  // with the release build sitting beside it.
  assert.deepEqual(engineBinaryCandidates({ ...base, profile: 'debug' }), [
    'C:/repo/engine/target/debug/e',
    'C:/repo/engine/target/release/e',
    'C:/app/resources/engine/e',
    'C:/app/resources/e'
  ])
  // `release` is the default said out loud, and says exactly the same thing the default does.
  assert.deepEqual(engineBinaryCandidates({ ...base, profile: 'release' }), engineBinaryCandidates(base))
  // AND THE PACKAGED CANDIDATES ARE UNTOUCHED BY EITHER — invariant 2. A packaged app has no
  // `engine/target/` at all, so the opt-in can only ever add a path that does not exist there.
  for (const profile of ['debug', 'release', undefined] as const) {
    const packaged = engineBinaryCandidates({ appPath: 'C:/app/resources/app.asar', resourcesPath: 'RES', binName: 'e', profile })
    assert.deepEqual(packaged.slice(-2), ['RES/engine/e', 'RES/e'])
  }
})

test('SELF-REVERTING BY CONSTRUCTION: the opt-in is a value, so absence is the release engine', () => {
  // "Afterwards it should swap back" (the owner's ruling) needs no mechanism — there is nowhere for
  // the choice to live. The same env with the profile dropped is byte-identical to a tree that
  // never opted in, which is what the next launch without the variable gets.
  const base = { appPath: 'C:/r', resourcesPath: '', binName: 'e' } as const
  assert.deepEqual(engineBinaryCandidates(base), ['C:/r/engine/target/release/e'])
  assert.deepEqual(engineBinaryCandidates({ ...base, profile: 'debug' }), [
    'C:/r/engine/target/debug/e',
    'C:/r/engine/target/release/e'
  ])
  assert.deepEqual(engineBinaryCandidates(base), ['C:/r/engine/target/release/e'])
})

test('the opt-in is READ from a shell, so it is trimmed and case-folded — and nothing else passes', () => {
  assert.equal(engineProfileOptIn('debug'), 'debug')
  assert.equal(engineProfileOptIn(' Debug \n'), 'debug')
  assert.equal(engineProfileOptIn('RELEASE'), 'release')
  // Absence is the ordinary launch.
  assert.equal(engineProfileOptIn(undefined), null)
  assert.equal(engineProfileOptIn(''), null)
  // A TYPO IS NOT A PROFILE. Guessing would be the same silent wrong answer this ticket removes,
  // pointed the other way: somebody who typed `dbg` believes they are on the debug engine.
  // `engineHost.ts` says so out loud rather than throwing — see the source pin below.
  assert.equal(engineProfileOptIn('dbg'), null)
  assert.equal(engineProfileOptIn('1'), null)
  assert.equal(engineProfileOptIn('debug release'), null)
})

test('`cwd` covers the launch where getAppPath() is NOT the checkout', () => {
  // MEASURED, booting the built app: launched against `out-e2e/main/index.js`, `app.getAppPath()`
  // answers `…/out-e2e/main` and the engine tree is two levels above it. `cwd` is the checkout on
  // every launch a developer starts, so the two roots together answer where either alone does not.
  assert.deepEqual(
    engineBinaryCandidates({ appPath: 'C:/repo/out-e2e/main', resourcesPath: '', cwd: 'C:/repo', binName: 'e' }),
    ['C:/repo/out-e2e/main/engine/target/release/e', 'C:/repo/engine/target/release/e']
  )
  // …and both roots honour the opt-in, in the same order.
  assert.deepEqual(
    engineBinaryCandidates({
      appPath: 'C:/repo/out-e2e/main',
      resourcesPath: '',
      cwd: 'C:/repo',
      binName: 'e',
      profile: 'debug'
    }),
    [
      'C:/repo/out-e2e/main/engine/target/debug/e',
      'C:/repo/out-e2e/main/engine/target/release/e',
      'C:/repo/engine/target/debug/e',
      'C:/repo/engine/target/release/e'
    ]
  )
  // …and the common case, where they are the same string, probes each path ONCE.
  assert.deepEqual(engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', cwd: 'C:/r', binName: 'e' }), [
    'C:/r/engine/target/release/e'
  ])
})

test('AN OUTRIGHT NAME WINS, and is still only a candidate (JOS-501)', () => {
  // The e2e harness builds the engine in RELEASE and states the path rather than hoping the
  // resolver's default order agrees with it: a suite that pays for one build and asserts against
  // another proves nothing. It goes FIRST because nothing derived can be a better answer than the
  // launcher naming the file.
  assert.deepEqual(
    engineBinaryCandidates({
      appPath: 'C:/r',
      resourcesPath: '',
      cwd: 'C:/r',
      binName: 'e',
      override: 'C:/r/engine/target/release/e'
    }),
    [
      'C:/r/engine/target/release/e'
      // …and the release path is NOT repeated: the dedupe that keeps a doubled root from being
      // probed twice covers the override for free.
    ]
  )

  // IT OUTRANKS THE OPT-IN TOO, which is the standing `engine-boots.e2e.mts` rests on: the harness
  // names its release build, and a debug opt-in in the ambient environment cannot take it away.
  assert.deepEqual(
    engineBinaryCandidates({
      appPath: 'C:/r',
      resourcesPath: '',
      binName: 'e',
      profile: 'debug',
      override: 'C:/r/engine/target/release/e'
    }),
    ['C:/r/engine/target/release/e', 'C:/r/engine/target/debug/e']
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
    ['C:/r/engine/target/release/e']
  )

  // IT SELECTS, IT NEVER DISABLES. An absent or empty override leaves the list exactly as it was —
  // which is what lets `engine-absent.e2e.mts` keep arranging absence with `cwd` alone.
  const plain = engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', binName: 'e' })
  assert.deepEqual(engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', binName: 'e', override: '' }), plain)

  // AND IT IS NOT TRUSTED TO EXIST. The caller `existsSync`es every candidate in order, so a stale
  // value degrades to the ordinary search rather than resolving to a file that is not there.
  assert.deepEqual(
    engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', binName: 'e', override: 'C:/gone/e' }),
    ['C:/gone/e', 'C:/r/engine/target/release/e']
  )
})

test('an unknown root contributes no candidates rather than a path rooted at nothing', () => {
  assert.deepEqual(engineBinaryCandidates({ appPath: '', resourcesPath: '', binName: 'e' }), [])
  assert.deepEqual(engineBinaryCandidates({ appPath: 'C:/r', resourcesPath: '', binName: 'e' }), [
    'C:/r/engine/target/release/e'
  ])
})

// ---- 5b. and when a non-release engine wins, it is UNMISSABLE (JOS-520, invariant 1) ----
//
// The incident's real damage was not that a debug engine ran. It was that a debug engine ran and
// the only evidence in the whole product was one dev-log line indistinguishable from every other
// dev-log line, so a ten-fold slowdown read as a mystery. Silence is reserved for the ordinary
// launch; everything else says which profile, and which opt-in put it there.

test('a debug engine ANNOUNCES ITSELF, names the opt-in, and says how to undo it', () => {
  const notice = engineProfileNotice('C:/r/engine/target/debug/engined.exe', {
    appPath: 'C:/r',
    resourcesPath: '',
    profile: 'debug'
  })
  assert.ok(notice)
  assert.ok(notice.startsWith(ENGINE_PROFILE_BANNER), 'the loud marker leads the line')
  assert.match(notice, /DEBUG engine at C:\/r\/engine\/target\/debug\/engined\.exe/)
  assert.match(notice, new RegExp(`${ENGINE_PROFILE_ENV}=debug opt-in`), 'it names what selected it')
  // The measurement, so a reader does not have to own a stopwatch to know what this costs…
  assert.match(notice, /4050 ms instead of 469 ms/)
  // …and the way out, which for a per-launch variable is simply launching without it.
  assert.match(notice, /relaunch without EQC_ENGINE_PROFILE/)
})

test('SILENCE IS FOR THE ORDINARY LAUNCH, and for the packaged one especially', () => {
  const env = { appPath: 'C:/r', resourcesPath: 'RES' }
  // The dev release binary — what every un-opted-in checkout resolves.
  assert.equal(engineProfileNotice('C:/r/engine/target/release/engined.exe', env), null)
  // The shipped binary, whose profile is release by construction (electron-builder copies out of
  // `engine/target/release`, pinned in enginePackaging.test.mts).
  assert.equal(engineProfileNotice('RES/engine/engined.exe', env), null)
  // The staged copy of a RELEASE binary (JOS-496 runs the engine from `userData/engine-run`) is
  // never itself the input — `engineHost.ts` computes the notice on the path it FOUND — but a
  // reader asking about the copy gets silence rather than a warning about an unclassifiable file.
  assert.equal(engineProfileNotice('C:/Users/x/AppData/Roaming/eqc/engine-run/engined.exe', env), null)
})

test('THE HARNESS IS NOT EXEMPT: an override that lands on debug is just as loud', () => {
  const notice = engineProfileNotice('C:/r/engine/target/debug/e', {
    appPath: 'C:/r',
    resourcesPath: '',
    override: 'C:/r/engine/target/debug/e'
  })
  assert.ok(notice)
  assert.ok(notice.startsWith(ENGINE_PROFILE_BANNER))
  assert.match(notice, /EQ_ENGINE_BIN/, 'the line names the mechanism that actually chose it')
  // …and the release binary the harness really names is silent, which is why `engine-boots.e2e.mts`
  // sees nothing new.
  assert.equal(
    engineProfileNotice('C:/r/engine/target/release/e', {
      appPath: 'C:/r',
      resourcesPath: '',
      override: 'C:/r/engine/target/release/e'
    }),
    null
  )
  // A NAMED BINARY OF UNKNOWN PROVENANCE is still worth a line: whoever pointed at it should be able
  // to see that the pointer took effect. Separator-blind, because `join()` hands back backslashes.
  assert.ok(engineProfileNotice('D:/scratch/e', { appPath: 'C:/r', resourcesPath: '', override: 'D:/scratch/e' }))
  assert.ok(engineProfileNotice('D:\\scratch\\e', { appPath: 'C:/r', resourcesPath: '', override: 'D:/scratch/e' }))
})

test('the profile is read off the path cargo writes to, both spellings', () => {
  assert.equal(engineBinaryProfile('C:/r/engine/target/debug/engined.exe'), 'debug')
  assert.equal(engineBinaryProfile('C:\\r\\engine\\target\\release\\engined.exe'), 'release')
  // Not cargo's output at all: the packaged path, the staging directory, some other `target`.
  assert.equal(engineBinaryProfile('RES/engine/engined.exe'), null)
  assert.equal(engineBinaryProfile('C:/app/target/debug/engined.exe'), null)
  // …and `isCargoTargetBinary` is exactly this question asked as a yes/no, so the two cannot drift.
  for (const path of [
    'C:/r/engine/target/debug/engined.exe',
    'C:/r/engine/target/release/engined.exe',
    'RES/engine/engined.exe',
    'C:/app/target/debug/engined.exe'
  ]) {
    assert.equal(isCargoTargetBinary(path), engineBinaryProfile(path) !== null)
  }
})

test('THE HOST READS THE VARIABLE AND EMITS THE LINE — the seam, pinned at the source', () => {
  // `engineHost.ts` imports Electron, so it cannot be imported here at all; this is the technique
  // `engineAlertsAudio.test.mts` and `serveDeltaArm.test.mts` use on the same file, with the same
  // comment strip (this repo explains itself in prose that would otherwise satisfy its own greps).
  const host = readFileSync(new URL('../src/main/dataServer/engineHost.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  // The opt-in is READ HERE, from the environment, and handed to the pure half as data.
  assert.match(host, /process\.env\[ENGINE_PROFILE_ENV\]/)
  assert.match(host, /profile: devEngineProfile\(\)/)
  // The loud line goes to `logWarn`, not `logInfo` — the whole point is that it does not read like
  // the narration nobody noticed.
  assert.match(host, /const notice = engineProfileNotice\(found, env\)/)
  assert.match(host, /if \(notice !== null\) logWarn\(/)
  // …and the one absence this ticket can newly cause — a checkout holding only a debug build —
  // is answered where it is discovered, for the developer and for nobody else.
  assert.match(host, /if \(!app\.isPackaged && env\.profile === undefined\)/)
  assert.match(host, /not a candidate unless a launch names it/)
  // …and it is computed BEFORE staging, because a staged copy no longer carries the profile in its
  // path (JOS-496 copies the image into `userData/engine-run`).
  const resolve = /function resolveEngineBinary\(\): string \| null \{([\s\S]*?)\n\}/.exec(host)
  assert.ok(resolve, 'resolveEngineBinary is gone or has changed shape')
  assert.ok(
    resolve[1].indexOf('engineProfileNotice') < resolve[1].indexOf('stageDevBinary'),
    'the notice must be computed on the found path, before the copy'
  )
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
