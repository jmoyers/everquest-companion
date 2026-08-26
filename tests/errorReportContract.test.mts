// ============================================================================
// THE ERROR REPORT, ADVERSARIALLY — the one telemetry event that carries text.
// ============================================================================
//
// `tests/telemetryContract.test.mts` pins the property every OTHER event has: no string in it
// is anything but a closed-enum member. `errorReport` (JOS-100) is the exception the owner
// ruled for — diagnosability over pure anonymity, holding one bright line: GAMEPLAY DATA NEVER
// RIDES AUTOMATICALLY — so it needs its own suite, and this is it.
//
// The suite is organised as the three things that could go wrong:
//   1. THE REDACTOR lets something through (real nasty messages, including the two the ticket
//      named: an ENOENT carrying a Windows user path, and a parse error quoting a mob name).
//   2. THE VALIDATOR accepts free text in a field (a bare path as a message, a function name
//      with a space in it, an 11th frame, an unredacted message, a made-up breadcrumb kind).
//   3. THE TWO COPIES DRIFT — the wire bounds restated in `telemetry.ts` and the producer
//      bounds in `errorReport.ts`. (The breadcrumb VOCABULARY moved to its own suite in JOS-501 —
//      `tests/breadcrumbVocabulary.test.mts`, the same ceiling and the same kind of cut that
//      produced the sibling below.)
//
// ITS SIBLING IS `tests/errorReportLocation.test.mts`, which holds the same three questions asked
// of everything JOS-111 added — the external frames, the component path, the message skeleton and
// their own duplicated patterns. That is a SPLIT rather than a second opinion: this file had
// reached the repo's 400-code-line ceiling and the repo's answer to that is a cut on the file's
// own seam, not a widened threshold.
//
// No Electron, no AWS, no network, no fixtures: this suite NEVER SKIPS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  errorCodeOf,
  errorFingerprint,
  errorNameOf,
  BUNDLE_FILE_PATTERN,
  normalizeFrameFile,
  parseStackFrames,
  redactMessage,
  FINGERPRINT_FRAMES,
  MAX_ERROR_FRAMES,
  MAX_FRAME_FUNC,
  MAX_FRAME_POSITION,
  MAX_REDACTED_MESSAGE,
  type ErrorFrame
} from '../src/shared/errorReport'
import {
  FRAME_FILE_RE,
  MAX_ERROR_FRAMES_WIRE,
  MAX_FRAME_FUNC_WIRE,
  MAX_FRAME_POSITION_WIRE,
  MAX_REDACTED_MESSAGE_WIRE,
  REDACTED_MESSAGE_RE,
  SESSION_AGE_MS_EDGES,
  TELEMETRY_ERROR_VIEWS,
  TELEMETRY_VIEWS,
  type EvErrorReport
} from '../src/shared/telemetry'
import { validateTelemetryEvent } from '../src/shared/telemetryValidate'
import { rollupBatch } from '../src/shared/telemetryRollup'

const ch = (code: number): string => String.fromCharCode(code)
const ESC = ch(0x1b)
const BEL = ch(0x07)

// =========================================================================================
// 1. THE REDACTOR, over real nasty shapes
// =========================================================================================

test('the redactor eats a Windows user path out of an ENOENT — the shape that names a person', () => {
  const raw =
    "ENOENT: no such file or directory, open 'C:\\Users\\jmoye\\AppData\\Roaming\\everquest-companion\\alerts.json'"
  const out = redactMessage(raw)
  // The account name is the whole point: it must not survive in ANY form.
  assert.equal(out.includes('jmoye'), false, out)
  assert.equal(out.includes('C:'), false, out)
  assert.equal(out.includes('AppData'), false, out)
  // …and the DIAGNOSABLE half survives: which errno, and that the argument was a path. That is
  // the entire reason the path pass runs before the quote pass — a quote-first redactor would
  // have collapsed the whole thing to `<str>` and thrown away "it was a file".
  assert.equal(out, 'ENOENT: no such file or directory, open <path>')
})

test('the redactor eats a quoted mob name out of a parse error, and keeps the error', () => {
  const raw = "Unexpected token in parseDamage: 'Innoruuk`s Chosen hits YOU for 412 points'"
  const out = redactMessage(raw)
  assert.equal(out.includes('Innoruuk'), false, out)
  assert.equal(out.includes('hits YOU'), false, out)
  assert.equal(out, 'Unexpected token in parseDamage: <str>')
})

test('the redactor over the rest of the nasty catalogue', () => {
  const table: [string, string, string][] = [
    [
      'a POSIX home path',
      'EACCES: permission denied, scandir /home/josh/.config/everquest-companion/soundpacks',
      'EACCES: permission denied, scandir <path>'
    ],
    // THE SPACE CASE, which the first draft of PATH_RE got wrong and this row is why it is
    // segment-based now: `EverQuest Legends` is this game's own install directory and
    // `Program Files` is on every Windows machine, so a space-terminated path pattern leaks the
    // tail of nearly every real path.
    [
      'a UNC share whose segments contain spaces',
      'Cannot find module \\\\NAS01\\games\\EverQuest Legends\\Logs',
      'Cannot find module <path>'
    ],
    [
      'Program Files, and the sentence AFTER the path survives',
      'spawn C:\\Program Files\\eqc\\out\\main\\presence.exe failed after 3 retries',
      'spawn <path> failed after 3 retries'
    ],
    [
      'a two-segment POSIX home path — named directories, because /Users/josh and /v1/x are the same shape',
      'EACCES: open /Users/josh',
      'EACCES: open <path>'
    ],
    [
      'a URL path is NOT a filesystem path and is left alone',
      'POST /v1/telemetry failed with 503',
      'POST /v1/telemetry failed with 503'
    ],
    [
      'a double-quoted character name',
      'No character named "Primitive" is being tailed',
      'No character named <str> is being tailed'
    ],
    [
      'a property read, which V8 quotes',
      "Cannot read properties of undefined (reading 'characterName')",
      'Cannot read properties of undefined (reading <str>)'
    ],
    [
      'a long number is an id or an offset; a short one is diagnostic',
      'Tailer: seek to 1073741824 failed after 3 retries (errno -4058)',
      'Tailer: seek to <n> failed after 3 retries (errno -4058)'
    ],
    [
      'a file: URL from the renderer',
      'Failed to fetch file:///C:/Users/jmoye/app/out/renderer/index.html',
      'Failed to fetch <path>'
    ],
    ['nothing to redact is left completely alone', 'Maximum call stack size exceeded', 'Maximum call stack size exceeded'],
    ['whitespace the redaction left behind is collapsed', "open   'x'    now", 'open <str> now']
  ]
  for (const [name, raw, want] of table) assert.equal(redactMessage(raw), want, name)
})

test('THE FIXED POINT: redacting twice is redacting once — the server check rests on it', () => {
  const inputs = [
    "ENOENT: open 'C:\\Users\\jmoye\\a\\b.json'",
    'Cannot find module /usr/lib/node_modules/x/y.js',
    'a "b" c 1234567890 D:\\e\\f',
    '<path> <str> <n>',
    'x'.repeat(MAX_REDACTED_MESSAGE + 400),
    // A cut that lands mid-path is exactly the case that would break idempotence if the cap ran
    // BEFORE the redaction. It runs after, so there is no path left to cut into.
    `${'y'.repeat(MAX_REDACTED_MESSAGE - 5)} C:\\Users\\jmoye\\deep\\path\\file.json`,
    '',
    'no quotes but an apostrophe: don\u2019t'
  ]
  for (const raw of inputs) {
    const once = redactMessage(raw)
    assert.equal(redactMessage(once), once, JSON.stringify(raw).slice(0, 60))
    assert.ok(REDACTED_MESSAGE_RE.test(once), `must satisfy its own wire regex: ${once}`)
  }
})

test('THE BRIGHT LINE: an EQ log line reaching a message is swallowed whole', () => {
  // A `throw new Error(line)` in the parser is a plausible future accident, and the redactor
  // cannot know that "You slash a rat" is gameplay — it CAN know that everything after an EQ
  // timestamp is. The prefix is the one signature a log line cannot be written without.
  const table = [
    '[Sat Aug 01 13:00:28 2026] You slash a rat for 12 points of damage.',
    "parse failed: [Thu Aug 06 12:44:20 2026] Jaber says, 'My leader is Primitive.'",
    '[Sun Jul  6 09:01:02 2026] Kahaptra Z`Taj hits YOU for 412 points of damage.'
  ]
  for (const raw of table) {
    const out = redactMessage(raw)
    assert.ok(out.endsWith('<logline>'), out)
    for (const leak of ['slash', 'rat', 'Jaber', 'Primitive', 'Kahaptra', 'points']) {
      assert.equal(out.includes(leak), false, `${leak} survived: ${out}`)
    }
    assert.equal(redactMessage(out), out, 'still a fixed point')
  }
})

test('the redactor is a sanitizer too: control characters, ANSI and invisibles never survive', () => {
  const nasty = `${ESC}]0;pwned${BEL}broke\nat ${ch(0x202e)}line${ch(0x00)}`
  const out = redactMessage(nasty)
  assert.ok(REDACTED_MESSAGE_RE.test(out), out)
  for (const code of [0x1b, 0x07, 0x00, 0x0a, 0x09, 0x202e, 0xfeff]) {
    assert.equal(out.includes(ch(code)), false, `U+${code.toString(16)} survived: ${out}`)
  }
  assert.equal(out.includes('pwned'), false, 'an OSC payload leaves with its ESC')
})

test('the redactor is total: a thrown non-string has no message and that is fine', () => {
  for (const junk of [undefined, null, 42, {}, [], Symbol('x')]) {
    assert.equal(redactMessage(junk), '')
  }
})

// =========================================================================================
// 2. FRAMES — the absolute prefix is cut off before the value exists
// =========================================================================================

test('normalizeFrameFile keeps the bundle path and nothing above it', () => {
  const table: [string, string | null][] = [
    ['C:\\Users\\jmoye\\AppData\\Local\\Programs\\eqc\\resources\\app.asar\\out\\main\\index.js', 'out/main/index.js'],
    ['file:///C:/Users/jmoye/dev/eqc/out/renderer/assets/index-a1b2.js', 'out/renderer/assets/index-a1b2.js'],
    ['/home/josh/eqc/out/preload/index.js', 'out/preload/index.js'],
    ['out/main/session.js', 'out/main/session.js'],
    // THE GREEDY-MATCH TRIPWIRE. `scout` contains the letters `out`, so a lazy regex with an
    // optional separator returns `out/app/out/main/index.js` and publishes a directory the user
    // named themselves. This assertion is the whole reason BUNDLE_ROOT_RE is written the way it is.
    ['C:\\Users\\scout\\app\\out\\main\\index.js', 'out/main/index.js'],
    // THE HARNESS ROOT NORMALIZES TO THE SHIPPED ONE. `out-e2e/` is the same files from the same
    // sources, built to a different directory so the headless suite never races the dev watcher.
    // The e2e spec found this: it asserted on frames and got an empty list, because every
    // renderer frame under the harness was being dropped for having the "wrong" root.
    ['C:\\eqc\\out-e2e\\renderer\\assets\\index-a1b2.js', 'out/renderer/assets/index-a1b2.js'],
    ['out-e2e/main/index.js', 'out/main/index.js'],
    ['node:internal/modules/cjs/loader', null],
    ['electron/js2c/browser_init', null],
    ['C:\\Users\\jmoye\\secret\\notes.txt', null]
  ]
  for (const [raw, want] of table) assert.equal(normalizeFrameFile(raw), want, raw)
})

test('parseStackFrames takes app frames, skips the rest, and caps at ten', () => {
  const stack = [
    'TypeError: x is not a function',
    '    at Object.foldEvent (C:\\Users\\jmoye\\eqc\\out\\main\\pipeline.js:120:15)',
    '    at node:internal/modules/cjs/loader:1105:14',
    '    at C:\\Users\\jmoye\\eqc\\out\\main\\index.js:44:3',
    '    at file:///C:/eqc/out/renderer/assets/index-a1b2.js:9:1'
  ].join('\n')
  const frames = parseStackFrames(stack)
  assert.deepEqual(frames, [
    { file: 'out/main/pipeline.js', line: 120, col: 15, func: 'Object.foldEvent' },
    { file: 'out/main/index.js', line: 44, col: 3, func: '<anonymous>' },
    { file: 'out/renderer/assets/index-a1b2.js', line: 9, col: 1, func: '<anonymous>' }
  ])
  // The cap counts APP frames, so a stack of forty yields ten.
  const many = Array.from({ length: 40 }, (_, i) => `    at f${String(i)} (out/main/a.js:${String(i + 1)}:1)`).join('\n')
  assert.equal(parseStackFrames(many).length, MAX_ERROR_FRAMES)
  // A function name that is not identifier-shaped degrades to <anonymous>; the LOCATION is the
  // diagnostic half and losing a whole frame over its label would be the wrong trade. `async
  // Promise.all` is V8's own spelling and really does contain a space.
  const spaced = '    at async Promise.all (index 0) (C:\\eqc\\out\\main\\a.js:1:2)'
  assert.deepEqual(parseStackFrames(spaced), [
    { file: 'out/main/a.js', line: 1, col: 2, func: '<anonymous>' }
  ])
  assert.deepEqual(parseStackFrames(undefined), [])
  assert.deepEqual(parseStackFrames('no frames here'), [])
})

// =========================================================================================
// 3. THE FINGERPRINT
// =========================================================================================

const frame = (file: string, line: number, func = 'f'): ErrorFrame => ({ file, line, col: 1, func })

test('the fingerprint groups by name and top frames, and ignores the varying parts', () => {
  const a = [frame('out/main/a.js', 10), frame('out/main/b.js', 20), frame('out/main/c.js', 30)]
  assert.match(errorFingerprint('TypeError', a), /^[0-9a-f]{16}$/)
  // deterministic
  assert.equal(errorFingerprint('TypeError', a), errorFingerprint('TypeError', a))
  // the NAME separates
  assert.notEqual(errorFingerprint('TypeError', a), errorFingerprint('RangeError', a))
  // a different top frame separates
  assert.notEqual(errorFingerprint('TypeError', a), errorFingerprint('TypeError', [frame('out/main/z.js', 10), ...a.slice(1)]))
  // COLUMNS DO NOT: a minifier moves them between builds, and an issue that re-fingerprints on
  // every release cannot be tracked across one.
  const shiftedCols = a.map((f) => ({ ...f, col: f.col + 99 }))
  assert.equal(errorFingerprint('TypeError', shiftedCols), errorFingerprint('TypeError', a))
  // and neither does anything past FINGERPRINT_FRAMES — a deeper caller changing is the same bug
  const deeper = [...a, frame('out/main/deep.js', 999)]
  assert.equal(errorFingerprint('TypeError', deeper), errorFingerprint('TypeError', a))
  assert.equal(FINGERPRINT_FRAMES, 3)
})

test('errorNameOf / errorCodeOf refuse prose and fall back honestly', () => {
  assert.equal(errorNameOf('TypeError'), 'TypeError')
  assert.equal(errorNameOf('a Nisch Mas Mender'), 'Error', 'a name with spaces is prose')
  assert.equal(errorNameOf(undefined), 'Error')
  assert.equal(errorCodeOf('ENOENT'), 'ENOENT')
  assert.equal(errorCodeOf(-4058), '-4058')
  assert.equal(errorCodeOf('no such file or directory'), undefined)
  assert.equal(errorCodeOf(undefined), undefined)
})

// =========================================================================================
// 4. THE VALIDATOR, ADVERSARIALLY
// =========================================================================================

/** A valid report, as the client would build one. Every negative below is one edit away from it. */
function sample(over: Partial<EvErrorReport> = {}): Record<string, unknown> {
  const frames = [
    { file: 'out/main/pipeline.js', line: 120, col: 15, func: 'Object.foldEvent' },
    { file: 'out/main/index.js', line: 44, col: 3, func: '<anonymous>' }
  ]
  return {
    t: 'errorReport',
    errorName: 'TypeError',
    code: 'ENOENT',
    redactedMessage: 'ENOENT: no such file or directory, open <path>',
    frames,
    fingerprint: errorFingerprint('TypeError', frames),
    breadcrumbs: [
      { kind: 'damage', offsetMs: 0 },
      { kind: 'zone', offsetMs: 1_200 }
    ],
    view: 'combat',
    sessionAgeBucket: 2,
    mode: 'live',
    count: 1,
    ...over
  }
}

const ok = (o: Record<string, unknown>): boolean => validateTelemetryEvent(o).ok
function refused(o: Record<string, unknown>, field: string, why: string): void {
  const res = validateTelemetryEvent(o)
  assert.equal(res.ok, false, why)
  if (!res.ok) assert.equal(res.field, field, `${why} — wrong field named: ${res.field}`)
}

test('the sample is valid and round-trips field for field', () => {
  const res = validateTelemetryEvent(sample())
  assert.equal(res.ok, true, res.ok ? '' : res.message)
  if (res.ok) assert.deepEqual(res.value, sample() as unknown as EvErrorReport)
})

test('ADVERSARIAL: free text is refused in every field', () => {
  // A MESSAGE THAT IS A BARE PATH — the headline case. It is not a fixed point of the redactor,
  // so the server refuses it rather than repairing it: a repaired message is a message accepted
  // from a client that is not running the code we think it is.
  refused(
    sample({ redactedMessage: 'C:\\Users\\jmoye\\AppData\\Roaming\\eqc\\alerts.json' }),
    'redactedMessage',
    'a bare Windows path as the message'
  )
  refused(
    sample({ redactedMessage: "a mob said 'hello there'" }),
    'redactedMessage',
    'an unredacted quoted string'
  )
  refused(
    sample({ redactedMessage: 'offset 1073741824' }),
    'redactedMessage',
    'an unredacted long number'
  )
  // …and a WHOLE LOG LINE, which is the bright line this feature is not allowed to cross. This
  // assertion is the reason `EQ_LOG_LINE_RE` exists at all: a log line carries no path, no
  // quotes and no long number, so before that arm was added it was a FIXED POINT of the
  // redactor and sailed through this validator untouched. The suite found it, not a reviewer.
  refused(
    sample({ redactedMessage: '[Sat Aug 01 13:00:28 2026] You slash a rat for 12 points of damage.' }),
    'redactedMessage',
    'a log line as the message'
  )
  // control characters and invisibles, which is the wireSanitize pin applied to this field
  for (const poison of [`${ESC}[2J`, `${ESC}]0;pwned${BEL}`, ch(0x00), ch(0x202e), '\n', '\t']) {
    refused(sample({ redactedMessage: `broke${poison}` }), 'redactedMessage', JSON.stringify(poison))
  }

  // A FUNCTION NAME WITH SPACES IN IT is prose wearing a function's clothes.
  refused(
    sample({ frames: [{ file: 'out/main/a.js', line: 1, col: 1, func: 'a Nisch Mas Mender' }] }),
    'frames[0].func',
    'a function name with spaces'
  )
  // A FILE THAT IS NOT BUNDLE-RELATIVE. The anchor is the privacy property.
  for (const file of [
    'C:\\Users\\jmoye\\out\\main\\a.js',
    '/home/josh/out/main/a.js',
    '../out/main/a.js',
    'out/../../secret.txt',
    'src/main/index.ts',
    'file:///out/main/a.js'
  ]) {
    refused(sample({ frames: [{ file, line: 1, col: 1, func: 'f' }] }), 'frames[0].file', file)
  }

  // errorName / code / fingerprint / view / mode
  refused(sample({ errorName: 'Type Error' }), 'errorName', 'a name with a space')
  refused(sample({ errorName: 'the app broke while zoning into Plane of Sky' }), 'errorName', 'prose')
  refused(sample({ code: 'no such file or directory' }), 'code', 'prose in code')
  refused(sample({ fingerprint: 'not-hex-at-all!!' }), 'fingerprint', 'a non-hex fingerprint')
  refused(sample({ fingerprint: 'abc' }), 'fingerprint', 'a short fingerprint')
  refused(sample({ view: 'Plane of Sky' }), 'view', 'a zone name as a view')
  refused(sample({ mode: 'hydrating' }), 'mode', 'a mode outside the enum')
  refused(sample({ breadcrumbs: [{ kind: 'a rat hit you', offsetMs: 0 }] }), 'breadcrumbs[0].kind', 'a log LINE as a crumb kind')
})

test('ADVERSARIAL: the eleventh frame and the eleventh breadcrumb fail the event', () => {
  const eleven = Array.from({ length: MAX_ERROR_FRAMES_WIRE + 1 }, (_, i) => ({
    file: 'out/main/a.js',
    line: i + 1,
    col: 1,
    func: 'f'
  }))
  refused(sample({ frames: eleven }), 'frames', 'an 11th frame')
  assert.equal(ok(sample({ frames: eleven.slice(0, MAX_ERROR_FRAMES_WIRE) })), true, '10 is fine')

  const crumbs = Array.from({ length: 11 }, () => ({ kind: 'damage', offsetMs: 1 }))
  refused(sample({ breadcrumbs: crumbs }), 'breadcrumbs', 'an 11th breadcrumb')
  assert.equal(ok(sample({ breadcrumbs: crumbs.slice(0, 10) })), true, '10 is fine')
})

test('ADVERSARIAL: the numeric fields are bounded, and a smuggled field never survives', () => {
  refused(sample({ frames: [{ file: 'out/main/a.js', line: MAX_FRAME_POSITION_WIRE + 1, col: 1, func: 'f' }] }), 'frames[0].line', 'an absurd line')
  refused(sample({ frames: [{ file: 'out/main/a.js', line: -1, col: 1, func: 'f' }] }), 'frames[0].line', 'a negative line')
  refused(sample({ sessionAgeBucket: SESSION_AGE_MS_EDGES.length + 1 }), 'sessionAgeBucket', 'a bucket past the edges')
  refused(sample({ count: -1 }), 'count', 'a negative count')
  refused(sample({ breadcrumbs: [{ kind: 'damage', offsetMs: 60 * 60_000 }] }), 'breadcrumbs[0].offsetMs', 'an offset past the cap')

  // THE CONSTRUCTION PROPERTY: the validator builds a new object field by field, so a smuggled
  // key is not stripped by a rule someone has to remember — it never appears at all.
  const smuggled = { ...sample(), characterName: 'Primitive', logLine: 'You slash a rat.' }
  const res = validateTelemetryEvent(smuggled)
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal('characterName' in res.value, false)
    assert.equal('logLine' in res.value, false)
  }
  // …and the same for a frame's own extra keys.
  const fatFrame = validateTelemetryEvent(
    sample({ frames: [{ file: 'out/main/a.js', line: 1, col: 1, func: 'f', source: 'You slash a rat.' } as never] })
  )
  assert.equal(fatFrame.ok, true)
  if (fatFrame.ok && fatFrame.value.t === 'errorReport') {
    assert.deepEqual(Object.keys(fatFrame.value.frames[0]).sort(), ['col', 'file', 'func', 'line'])
  }
})

test('code is genuinely optional — absent and null both mean "the throw carried none"', () => {
  for (const code of [undefined, null]) {
    const res = validateTelemetryEvent({ ...sample(), code })
    assert.equal(res.ok, true)
    if (res.ok) assert.equal('code' in res.value, false)
  }
})

// =========================================================================================
// 5. THE COPIES THAT MUST NOT DRIFT
// =========================================================================================

test('the wire bounds and the producer bounds are one number each', () => {
  assert.equal(MAX_REDACTED_MESSAGE_WIRE, MAX_REDACTED_MESSAGE)
  assert.equal(MAX_ERROR_FRAMES_WIRE, MAX_ERROR_FRAMES)
  assert.equal(MAX_FRAME_POSITION_WIRE, MAX_FRAME_POSITION)
  assert.equal(MAX_FRAME_FUNC_WIRE, MAX_FRAME_FUNC)
  // …and the length in REDACTED_MESSAGE_RE is that same number, spelled in a regex where it
  // cannot be a constant. A message of exactly the cap passes; one character more does not.
  assert.ok(REDACTED_MESSAGE_RE.test('a'.repeat(MAX_REDACTED_MESSAGE_WIRE)))
  assert.equal(REDACTED_MESSAGE_RE.test('a'.repeat(MAX_REDACTED_MESSAGE_WIRE + 1)), false)
  // …and the producer's copy of the frame-file pattern is the wire's copy, character for
  // character. The producer applies it too, so a frame the wire would refuse never reaches it.
  assert.equal(BUNDLE_FILE_PATTERN, FRAME_FILE_RE.source)
})


test('the error-view enum is the dwell views plus exactly one honest escape hatch', () => {
  assert.deepEqual([...TELEMETRY_ERROR_VIEWS], [...TELEMETRY_VIEWS, 'unknown'])
})

// =========================================================================================
// 6. THE ROLLUP — one issue is one row, first exemplar wins
// =========================================================================================

const batchOf = (events: Record<string, unknown>[]) => ({
  v: 1 as const,
  env: {
    analyticsId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    appVersion: '0.11.0',
    channel: 'prod' as const,
    platform: 'win32' as const,
    tzOffsetBucket: -5
  },
  events: events.map((ev) => ({ ts: 1, ev: ev as unknown as EvErrorReport }))
})

const CTX = { firstOfDay: false, newInstall: false, upgraded: false }

test('the rollup folds one fingerprint into one row and keeps the FIRST exemplar', () => {
  const first = sample({ count: 2, redactedMessage: 'first <path>' })
  const second = sample({ count: 3, redactedMessage: 'second <path>' })
  const roll = rollupBatch(batchOf([first, second]) as never, CTX)
  assert.equal(roll.errors.length, 1, 'one fingerprint is one row')
  assert.equal(roll.errors[0].n, 5, 'counts add')
  assert.equal(roll.errors[0].exemplar.redactedMessage, 'first <path>', 'FIRST wins')
  assert.equal(roll.errors[0].appVersion, '0.11.0')
  // …and the counters half carries the per-build denominator
  const counters = new Map(roll.counters.map((c) => [`${c.metric} ${c.dim}`, c.n]))
  assert.equal(counters.get('errors 0.11.0'), 5)
  assert.equal(counters.get('errorEvents 0.11.0'), 2)
})

test('two fingerprints are two rows, and a batch with no errors has none', () => {
  const other = sample({ fingerprint: '0123456789abcdef', count: 1 })
  const roll = rollupBatch(batchOf([sample(), other]) as never, CTX)
  assert.equal(roll.errors.length, 2)
  assert.deepEqual(rollupBatch(batchOf([]) as never, CTX).errors, [])
  const usual = rollupBatch(batchOf([{ t: 'sessionHeartbeat', uptimeMs: 1 }]) as never, CTX)
  assert.deepEqual(usual.errors, [], 'the common batch pays nothing for this feature')
})
