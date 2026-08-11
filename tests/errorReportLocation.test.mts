// ============================================================================
// WHERE IT BROKE — the frameless error's location, adversarially (JOS-111).
// ============================================================================
//
// `tests/errorReportContract.test.mts` is the redactor, the bundle frames and the wire's
// original shape. THIS suite is the half JOS-111 added, and it is its own file for that file's
// own reason: it had grown past the repo's 400-code-line ceiling and the answer here is a split,
// not a widened threshold.
//
// WHAT IT GUARDS. Triage of the live 0.13.0 error stream found the two loudest issues were both
// FRAMELESS — no in-bundle stack — so both hashed `Error` and nothing else and collapsed into one
// row. The fix gives such a report a LOCATION (an external frame, a capture site, an unwrapped
// nested error) or, failing all of those, a coarse shape of its own already-redacted message. Each
// of those is a new way for something to reach the wire, so each gets its own refusals here:
//
//   1. THE CLASSIFIER truncates every external location to a PUBLIC module name. Everything to
//      the left of the `node_modules/` boundary is the install path and therefore somebody's
//      account name; everything to the right of the package is detail the package already
//      implies. What survives is identical on every install in the fleet.
//   2. THE VALIDATOR refuses an `externalFrames` file that is not one of those three shapes, a
//      `componentPath` that is prose rather than component names, and a `frameOrigin` outside its
//      enum — and it accepts all three being ABSENT, which is what every client older than this
//      ticket sends and what every exemplar already in the store looks like.
//   3. THE MARKER that carries React's component stack is one string in two files, pinned equal,
//      because a marker that drifts is a field that silently stops being produced.
//
// No Electron, no AWS, no network, no fixtures: this suite NEVER SKIPS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStackFrames } from '../src/shared/errorReport'
import {
  classifyExternalFrameFile,
  messageSkeleton,
  parseComponentPath,
  parseExternalFrames,
  COMPONENT_PATH_PATTERN,
  COMPONENT_STACK_MARKER,
  EXTERNAL_FILE_PATTERN,
  MAX_COMPONENT_DEPTH,
  MAX_EXTERNAL_FRAMES,
  MAX_MESSAGE_SKELETON
} from '../src/shared/errorReportLocation'
import {
  COMPONENT_PATH_RE,
  EXTERNAL_FRAME_FILE_RE,
  MAX_COMPONENT_DEPTH_WIRE,
  MAX_EXTERNAL_FRAMES_WIRE,
  type EvErrorReport
} from '../src/shared/telemetry'
import { validateTelemetryEvent } from '../src/shared/telemetryValidate'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A valid report, as the client would build one. Structurally the `sample()` in the contract
 *  suite; kept here rather than shared because a test helper that two suites both edit is a
 *  third place for the contract to live. */
function sample(over: Partial<EvErrorReport> = {}): Record<string, unknown> {
  return {
    t: 'errorReport',
    errorName: 'TypeError',
    redactedMessage: 'ENOENT: no such file or directory, open <path>',
    frames: [{ file: 'out/main/pipeline.js', line: 120, col: 15, func: 'Object.foldEvent' }],
    fingerprint: '0123456789abcdef',
    breadcrumbs: [{ kind: 'damage', offsetMs: 0 }],
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

// =========================================================================================
// 1. THE VALIDATOR, over the three new fields
// =========================================================================================

test('an EXTERNAL frame may name a public module and may not name anything else', () => {
  const ext = (file: string): Record<string, unknown> =>
    sample({ externalFrames: [{ file, line: 12, col: 3, func: 'readFileSync' }] })

  for (const file of [
    'node:fs',
    'node:internal/fs/promises',
    'node_modules/chokidar',
    'node_modules/@aws-sdk/client-s3',
    'electron/js2c/renderer_init'
  ]) {
    assert.equal(ok(ext(file)), true, `${file} names something every install has`)
  }
  // THE PRIVACY PROPERTY, stated as refusals: an absolute path cannot satisfy the pattern, so
  // the install directory — and therefore the user's account name — is not a value this field
  // can hold however it was constructed. Traversal is refused for FRAME_FILE_RE's reason.
  for (const file of [
    'C:\\Users\\jmoye\\app\\node_modules\\chokidar\\lib\\a.js',
    '/home/josh/app/node_modules/chokidar',
    'node_modules/../../secret.txt',
    'node_modules/chokidar/lib/fsevents-handler.js',
    'out/main/index.js',
    'node:internal/fs/promises/deep/deeper',
    'a mob said hello'
  ]) {
    refused(ext(file), 'externalFrames[0].file', file)
  }
  refused(
    sample({ externalFrames: [{ file: 'node:fs', line: 1, col: 1, func: 'a Nisch Mas Mender' }] }),
    'externalFrames[0].func',
    'a function name with spaces'
  )
  const six = Array.from({ length: MAX_EXTERNAL_FRAMES_WIRE + 1 }, (_, i) => ({
    file: 'node:fs',
    line: i + 1,
    col: 1,
    func: 'f'
  }))
  refused(sample({ externalFrames: six }), 'externalFrames', 'a sixth external frame')
  assert.equal(ok(sample({ externalFrames: six.slice(0, MAX_EXTERNAL_FRAMES_WIRE) })), true)
})

test('componentPath is component NAMES and can never be prose', () => {
  assert.equal(ok(sample({ componentPath: 'Tooltip>InventoryRow>InventoryPanel' })), true)
  assert.equal(ok(sample({ componentPath: 'Foo.Bar' })), true)
  for (const path of [
    'a Nisch Mas Mender',
    'Tooltip > InventoryRow',
    'Plane of Sky',
    'Tooltip>',
    '<script>alert(1)</script>'
  ]) {
    refused(sample({ componentPath: path }), 'componentPath', path)
  }
  refused(sample({ frameOrigin: 'guessed' }), 'frameOrigin', 'an origin outside the enum')
  assert.equal(ok(sample({ frameOrigin: 'capture' })), true)
})

test('the three JOS-111 fields are ADDITIVE: absent is the whole old contract', () => {
  // The deploy-skew law from the other side. Every one of them may simply not be there, which is
  // what every exemplar stored before this ticket looks like, and the validator CONSTRUCTS the
  // result — so the property never appears rather than appearing as a default.
  const res = validateTelemetryEvent(sample())
  assert.equal(res.ok, true)
  if (res.ok && res.value.t === 'errorReport') {
    for (const field of ['frameOrigin', 'externalFrames', 'componentPath']) {
      assert.equal(field in res.value, false, `${field} must be absent, not defaulted`)
    }
  }
  for (const nulled of [undefined, null]) {
    const r = validateTelemetryEvent(
      sample({ frameOrigin: nulled, externalFrames: nulled, componentPath: nulled })
    )
    assert.equal(r.ok, true, 'null and undefined both mean absent')
  }
})

// =========================================================================================
// 2. THE CLASSIFIER AND THE PARSERS
// =========================================================================================

test('the CLASSIFIER truncates to the package, and an unrecognizable location is dropped', () => {
  const cases: [string, string | null][] = [
    ['C:\\Users\\jmoye\\AppData\\Local\\Programs\\eqc\\node_modules\\chokidar\\lib\\handler.js', 'node_modules/chokidar'],
    ['/home/josh/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js', 'node_modules/@aws-sdk/client-s3'],
    // A NESTED dependency resolves to the package that actually holds the frame, and the LAST
    // boundary is what guarantees nothing to the left of it can survive.
    ['/app/node_modules/a/node_modules/b/index.js', 'node_modules/b'],
    ['node:internal/fs/promises', 'node:internal/fs/promises'],
    ['node:fs', 'node:fs'],
    // Truncated at three segments, so a deep internal path cannot grow without bound.
    ['node:internal/streams/readable/extra/more', 'node:internal/streams/readable'],
    ['node:electron/js2c/renderer_init', 'electron/js2c/renderer_init'],
    ['file:///C:/Users/jmoye/eqc/node_modules/electron/dist/resources/x.js', 'node_modules/electron'],
    // Nothing recognizable: refused rather than repaired. A location we cannot classify is a
    // location we cannot promise is not somebody's home directory.
    ['C:\\Users\\jmoye\\Documents\\thing.js', null],
    ['/home/josh/secret/plan.js', null],
    ['<anonymous>', null],
    ['out/main/index.js', null]
  ]
  for (const [raw, want] of cases) {
    assert.equal(classifyExternalFrameFile(raw), want, raw)
  }
  // …and whatever it does return, the wire will hold.
  for (const [raw] of cases) {
    const got = classifyExternalFrameFile(raw)
    if (got === null) continue
    assert.match(got, EXTERNAL_FRAME_FILE_RE, raw)
    assert.equal(got.includes('jmoye'), false, 'no account name survives')
  }
})

test('a stack with no bundle in it still yields EXTERNAL frames, newest first', () => {
  const stack = [
    'Error: ENOENT: no such file or directory',
    '    at Object.readFileSync (node:fs:452:20)',
    '    at async open (node:internal/fs/promises:601:12)',
    '    at FSWatcher._handle (C:\\Users\\jmoye\\eqc\\node_modules\\chokidar\\lib\\handler.js:88:9)',
    '    at Timeout._onTimeout (C:\\Users\\jmoye\\Documents\\private.js:1:1)'
  ].join('\n')
  assert.deepEqual(parseStackFrames(stack), [], 'nothing in the bundle — this is the frameless case')
  assert.deepEqual(parseExternalFrames(stack), [
    { file: 'node:fs', line: 452, col: 20, func: 'Object.readFileSync' },
    // `async open` has a SPACE in it, so it degrades to `<anonymous>` exactly as an app frame
    // would: the location is the diagnostic half and losing a frame over its label is worse.
    { file: 'node:internal/fs/promises', line: 601, col: 12, func: '<anonymous>' },
    { file: 'node_modules/chokidar', line: 88, col: 9, func: 'FSWatcher._handle' }
  ])
  assert.equal(JSON.stringify(parseExternalFrames(stack)).includes('jmoye'), false)
})

test('parseComponentPath reads only a MARKED stack, and only its components', () => {
  const marked =
    'TypeError: x\n    at f (out/main/a.js:1:2)\n\n' +
    `${COMPONENT_STACK_MARKER}\n    at Tooltip (http://localhost:5173/src/Tooltip.tsx:5:11)` +
    '\n    at div\n    at InventoryRow\n    at Foo.Bar'
  assert.equal(parseComponentPath(marked), 'Tooltip>InventoryRow>Foo.Bar', 'host elements dropped')
  assert.match(parseComponentPath(marked) ?? '', COMPONENT_PATH_RE)

  // React's OWN dev-mode append carries no marker, and an unmarked `at Name` line is
  // character-for-character a V8 frame — so it is left alone rather than guessed at.
  assert.equal(parseComponentPath('Error: x\n    at Tooltip\n    at App'), undefined)
  assert.equal(parseComponentPath(undefined), undefined)
  assert.equal(parseComponentPath(`${COMPONENT_STACK_MARKER}\n    at div\n    at span`), undefined)

  // The depth cap holds even against a stack that is nothing but components.
  const deep = `${COMPONENT_STACK_MARKER}${Array.from({ length: 40 }, (_, i) => `\n    at C${String(i)}`).join('')}`
  assert.equal((parseComponentPath(deep) ?? '').split('>').length, MAX_COMPONENT_DEPTH)
})

test('the message SKELETON groups by shape and never carries what the message did not', () => {
  // Two occurrences of one failure, one issue…
  assert.equal(
    messageSkeleton('Failed to load resource: the server responded with a status of 404'),
    messageSkeleton('Failed to load resource: the server responded with a status of 503')
  )
  // …and two different failures, two.
  assert.notEqual(
    messageSkeleton('Failed to load resource'),
    messageSkeleton('did-fail-load errorCode -105')
  )
  // Its input is the ALREADY-REDACTED message, so the placeholders survive as themselves and
  // there is nothing in it the redactor had already taken out.
  assert.equal(messageSkeleton('ENOENT: open <path> after 3 tries'), 'enoent open <path> after 0 tries')
  assert.ok(messageSkeleton('x'.repeat(500)).length <= MAX_MESSAGE_SKELETON)
})

// =========================================================================================
// 3. THE COPIES THAT MUST NOT DRIFT
// =========================================================================================

test('the location bounds and patterns are one copy each', () => {
  assert.equal(MAX_EXTERNAL_FRAMES, MAX_EXTERNAL_FRAMES_WIRE)
  assert.equal(MAX_COMPONENT_DEPTH, MAX_COMPONENT_DEPTH_WIRE)
  assert.equal(EXTERNAL_FILE_PATTERN, EXTERNAL_FRAME_FILE_RE.source)
  assert.equal(COMPONENT_PATH_PATTERN, COMPONENT_PATH_RE.source)
  // …and the depth in COMPONENT_PATH_RE is that same number, spelled in a regex where it cannot
  // be a constant. Exactly MAX names passes; one more does not.
  const names = (n: number): string => Array.from({ length: n }, (_, i) => `C${String(i)}`).join('>')
  assert.ok(COMPONENT_PATH_RE.test(names(MAX_COMPONENT_DEPTH_WIRE)))
  assert.equal(COMPONENT_PATH_RE.test(names(MAX_COMPONENT_DEPTH_WIRE + 1)), false)
})

test('the component-stack marker is the one ErrorBoundary.tsx actually writes', () => {
  // The renderer holds the other copy as a literal, because that file deliberately imports no app
  // code (the app may be the crash source) and this module bundles into a Lambda that has never
  // heard of React. A marker that drifts is a componentPath that silently stops being produced,
  // which is the failure mode this pin exists for.
  const boundary = readFileSync(join(REPO, 'src/renderer/src/lib/ErrorBoundary.tsx'), 'utf8')
  const sites = boundary.match(/`[^`]*\$\{info\.componentStack\}`/g) ?? []
  // Four today: the parked crash prefill, the IPC report, the console line, and the visible
  // fallback. The two that matter to this ticket are the report and the console line, and holding
  // ALL of them to the marker is what makes a future fifth site correct by default.
  assert.ok(sites.length >= 3, `expected the boundary to interpolate the stack, found ${String(sites.length)}`)
  for (const site of sites) {
    assert.ok(site.includes(`${COMPONENT_STACK_MARKER}\${info.componentStack}`), `unmarked: ${site}`)
  }
})
