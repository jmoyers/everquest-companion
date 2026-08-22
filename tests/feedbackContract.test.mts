// The feedback CONTRACT (src/shared/feedback.ts) — one definition, three consumers.
//
// It is run by the renderer dialog (to gate Send), by the main process (at the IPC boundary)
// and by the ingest Lambda (as its whole shape check). If those three ever disagree about what
// "valid" means, the user meets a 400 they cannot act on — so this suite pins the BOUNDARIES
// themselves: at each limit, one past it, one under it. Not a happy path.
//
// The second law it pins is REJECT, NEVER TRUNCATE: an over-long description is an error the
// user is told about, never a silently shortened report. Trimming surrounding whitespace is
// normalization and is allowed; shortening content is not.
//
// The THIRD law, added when sanitization moved from the client to the boundary: the wire's two
// text shapes are governed differently and on purpose, and the truth table below is what says
// so out loud.
//
//   FIELD SHAPE          CLASS                                   VERDICT
//   description          C0 minus TAB/LF, DEL, C1                STRIP  (normalization)
//   (multi-line prose)   whole ANSI/VT escape sequences          STRIP
//                        zero-width / BiDi / BOM                 STRIP
//                        CRLF, CR                                NORMALIZE to LF
//                        TAB, LF                                 KEEP
//                        over MAX_DESCRIPTION after all that     REJECT (never truncate)
//   env.* free-form      ANY control character, incl. TAB/LF     REJECT invalid_payload
//   (single-line)        zero-width / BiDi / BOM                 REJECT invalid_payload
//                        surrounding whitespace                  TRIM   (normalization)
//   env.appVersion,      anything off the pattern                REJECT (already did)
//   installId, sha256
//
// Stripping is not truncation: REJECT-NEVER-TRUNCATE is a law about the user's WORDS, and no
// word is shortened by deleting a NUL. The classes themselves live in src/shared/sanitizeText.ts
// and are pinned character by character in tests/wireSanitize.test.mts.
//
// The scrub half of this wave has its own suite: tests/logScrub.test.mts.
//
// No Electron, no network, no fixtures — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LOG_WINDOW,
  FEEDBACK_API_VERSION,
  LOG_WINDOW_CHOICES,
  MAX_DESCRIPTION,
  MAX_ENV_FIELD,
  MAX_INVENTORY_LINES,
  MAX_SLICE_LINES,
  MAX_UPLOAD_BYTES,
  MIN_DESCRIPTION,
  validateDraft,
  validateInventoryMeta,
  validateLogMeta,
  validateSubmit,
  type FeedbackDraft,
  type FeedbackEnv,
  type InventoryDumpMeta,
  type LogSliceMeta,
  type SubmitRequest
} from '../src/shared/feedback'

// ---------------------------------------------------------------------------------------
// validateDraft — the user's own words
// ---------------------------------------------------------------------------------------

const draft = (over: Partial<FeedbackDraft> = {}): unknown => ({
  type: 'bug',
  description: 'the meter shows zero dps after zoning',
  ...over
})

/** `n` characters of prose-shaped text (never whitespace — trim would eat it). */
const chars = (n: number): string => 'x'.repeat(n)

test('validateDraft accepts the shape the dialog produces', () => {
  const res = validateDraft(draft())
  assert.equal(res.ok, true)
  assert.deepEqual(res.ok && res.value, {
    type: 'bug',
    description: 'the meter shows zero dps after zoning'
  })
})

test('description length is bounded at both ends, measured AFTER trim', () => {
  assert.equal(validateDraft(draft({ description: chars(MIN_DESCRIPTION) })).ok, true)
  assert.equal(validateDraft(draft({ description: chars(MAX_DESCRIPTION) })).ok, true)

  const short = validateDraft(draft({ description: chars(MIN_DESCRIPTION - 1) }))
  assert.equal(short.ok, false)
  assert.equal(!short.ok && short.field, 'description')
  assert.equal(!short.ok && short.error, 'invalid_payload')

  const long = validateDraft(draft({ description: chars(MAX_DESCRIPTION + 1) }))
  assert.equal(long.ok, false)
  assert.equal(!long.ok && long.field, 'description')

  // Padding is not content: a min-length description drowned in whitespace still fails, and
  // surrounding whitespace on a valid one is normalized away.
  assert.equal(validateDraft(draft({ description: `   ${chars(MIN_DESCRIPTION - 1)}   ` })).ok, false)
  const padded = validateDraft(draft({ description: `\n  ${chars(MIN_DESCRIPTION)}  \n` }))
  assert.equal(padded.ok && padded.value.description, chars(MIN_DESCRIPTION))
})

test('REJECT, NEVER TRUNCATE — an over-long description is an error, not a haircut', () => {
  const over = chars(MAX_DESCRIPTION + 500)
  const res = validateDraft(draft({ description: over }))
  assert.equal(res.ok, false)
  // and the accepted one comes back the exact length it went in
  const at = validateDraft(draft({ description: chars(MAX_DESCRIPTION) }))
  assert.equal(at.ok && at.value.description.length, MAX_DESCRIPTION)
})

test('retired fields: a title/contact from an older client is dropped, never rejected', () => {
  // The wire once carried optional `title` and `contact`; both were retired. An older client
  // still sending them must not meet a 400 — the validator constructs the value from the
  // fields the contract still has, so the retired ones simply vanish.
  for (const legacy of ['DPS resets', 'me@example.com', chars(10_000), '', null]) {
    const res = validateDraft(draft({ title: legacy, contact: legacy } as object))
    assert.equal(res.ok, true)
    assert.equal(res.ok && 'title' in res.value, false)
    assert.equal(res.ok && 'contact' in res.value, false)
  }
})

// ---------------------------------------------------------------------------------------
// the TRUTH TABLE: what the wire does with control characters, field shape by field shape
// ---------------------------------------------------------------------------------------

/** Written as codes, never as literals: a control character pasted into a source file is a
 *  character nobody reviewing the diff can see. */
const ch = (code: number): string => String.fromCharCode(code)
const ESC = ch(0x1b)
const BEL = ch(0x07)
const NUL = ch(0x00)

test('description STRIPS control characters — normalization, exactly as trim is', () => {
  const body = 'the meter shows zero dps after zoning'
  const table: { name: string; sent: string; kept: string }[] = [
    // the terminal-injection families, removed WHOLE so no visible litter is left behind
    { name: 'CSI colour', sent: `${ESC}[31m${body}${ESC}[0m`, kept: body },
    { name: 'CSI erase-display', sent: `${ESC}[2J${body}`, kept: body },
    { name: 'OSC set-title', sent: `${ESC}]0;pwned${BEL}${body}`, kept: body },
    { name: 'OSC 52 clipboard', sent: `${ESC}]52;c;YQ==${BEL}${body}`, kept: body },
    { name: 'Fe full reset', sent: `${ESC}c${body}`, kept: body },
    // bare controls
    { name: 'NUL', sent: `${body}${NUL}`, kept: body },
    { name: 'DEL', sent: `${body}${ch(0x7f)}`, kept: body },
    { name: 'C1 CSI', sent: `${body}${ch(0x9b)}31m`, kept: `${body}31m` },
    { name: 'BEL', sent: `${body}${BEL}`, kept: body },
    // the invisible / reordering class
    { name: 'zero-width space', sent: `${body}${ch(0x200b)}`, kept: body },
    { name: 'BiDi override', sent: `${ch(0x202e)}${body}`, kept: body },
    { name: 'BOM', sent: `${ch(0xfeff)}${body}`, kept: body },
    // what SURVIVES, because it is content
    { name: 'tab and newline', sent: `line one\n\tline two`, kept: 'line one\n\tline two' },
    { name: 'CRLF', sent: `line one\r\nline two`, kept: 'line one\nline two' },
    { name: 'lone CR', sent: `line one\rline two`, kept: 'line one\nline two' }
  ]
  for (const { name, sent, kept } of table) {
    const res = validateDraft(draft({ description: sent }))
    assert.equal(res.ok, true, `${name} must be accepted after stripping`)
    assert.equal(res.ok && res.value.description, kept, name)
  }
})

test('a description made only of control characters fails the MINIMUM, like the empty report it is', () => {
  // The strip runs BEFORE the trim and BEFORE the bounds, so an "escape sequence bomb" does not
  // buy its author a valid report by being long.
  for (const junk of [`${ESC}[31m${ESC}[0m${ESC}[2J`, NUL.repeat(50), ch(0x200b).repeat(50)]) {
    const res = validateDraft(draft({ description: junk }))
    assert.equal(res.ok, false, 'a control-only description is not a report')
    assert.equal(!res.ok && res.field, 'description')
    assert.equal(!res.ok && res.error, 'invalid_payload')
  }
})

test('the length bound is measured on the text that will be STORED', () => {
  // MAX real characters plus a pile of escape sequences is a legal report: the sequences are
  // not content, so removing them is not the truncation §8.3 forbids. And one character past
  // the max is still a rejection — the escape hatch does not become a way to smuggle length.
  const padded = `${ESC}[31m${chars(MAX_DESCRIPTION)}${ESC}[0m`
  const ok = validateDraft(draft({ description: padded }))
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.value.description, chars(MAX_DESCRIPTION))
  assert.equal(validateDraft(draft({ description: `${ESC}[31m${chars(MAX_DESCRIPTION + 1)}` })).ok, false)
})

test('validateDraft rejects everything that is not one of the two types', () => {
  for (const type of ['feature', 'bug']) {
    assert.equal(validateDraft(draft({ type: type as FeedbackDraft['type'] })).ok, true)
  }
  for (const bad of ['Bug', 'question', '', 0, null, undefined]) {
    const res = validateDraft(draft({ type: bad as FeedbackDraft['type'] }))
    assert.equal(res.ok, false, `type ${String(bad)} must be rejected`)
    assert.equal(!res.ok && res.field, 'type')
  }
  // and a non-object body at all
  for (const bad of [null, undefined, 'a report', 42, ['bug']]) {
    assert.equal(validateDraft(bad).ok, false)
  }
})

// ---------------------------------------------------------------------------------------
// validateLogMeta — the attachment's metadata (the presign's cost model rests on it)
// ---------------------------------------------------------------------------------------

const meta = (over: Partial<LogSliceMeta> = {}): unknown => ({
  bytes: 131_072,
  lines: 4_812,
  dropped: 91,
  fromMs: 1_754_000_000_000,
  toMs: 1_754_001_800_000,
  sha256: 'a'.repeat(64),
  ...over
})

test('log metadata is bounded exactly where the presign policy is', () => {
  assert.equal(validateLogMeta(meta({ bytes: 1 })).ok, true)
  assert.equal(validateLogMeta(meta({ bytes: MAX_UPLOAD_BYTES })).ok, true)
  assert.equal(validateLogMeta(meta({ bytes: MAX_UPLOAD_BYTES + 1 })).ok, false)
  // 0 bytes is not an upload: `content-length-range` starts at 1, and an empty window is
  // sent as `log: null`, never as a zero-line slice.
  assert.equal(validateLogMeta(meta({ bytes: 0 })).ok, false)
  assert.equal(validateLogMeta(meta({ lines: 1 })).ok, true)
  assert.equal(validateLogMeta(meta({ lines: MAX_SLICE_LINES })).ok, true)
  assert.equal(validateLogMeta(meta({ lines: MAX_SLICE_LINES + 1 })).ok, false)
  assert.equal(validateLogMeta(meta({ lines: 0 })).ok, false)
  // a scrub that removed nothing is honest information, not an error
  assert.equal(validateLogMeta(meta({ dropped: 0 })).ok, true)
  assert.equal(validateLogMeta(meta({ dropped: -1 })).ok, false)
  // fractional byte counts are a bug in the caller, not a rounding opportunity
  assert.equal(validateLogMeta(meta({ bytes: 1024.5 })).ok, false)
})

test('a slice cannot end before it starts, and its digest is 64 hex', () => {
  assert.equal(validateLogMeta(meta({ fromMs: 5, toMs: 5 })).ok, true)
  const backwards = validateLogMeta(meta({ fromMs: 6, toMs: 5 }))
  assert.equal(backwards.ok, false)
  assert.equal(!backwards.ok && backwards.field, 'log.toMs')

  for (const bad of ['a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}z`, '', 12]) {
    const res = validateLogMeta(meta({ sha256: bad as string }))
    assert.equal(res.ok, false, `sha256 ${String(bad)} must be rejected`)
    assert.equal(!res.ok && res.field, 'log.sha256')
  }
})

// ---------------------------------------------------------------------------------------
// validateInventoryMeta — the SECOND attachment's metadata (JOS-296)
// ---------------------------------------------------------------------------------------
//
// Same job as `validateLogMeta` and therefore the same test shape: the bounds ARE the presign's
// cost model, so each one is pinned at the limit, one past it and one under it.

const invMeta = (over: Partial<InventoryDumpMeta> = {}): unknown => ({
  bytes: 2_048,
  lines: 295,
  updatedAt: 1_754_000_000_000,
  sha256: 'b'.repeat(64),
  ...over
})

test('inventory metadata is bounded exactly where the presign policy is', () => {
  assert.equal(validateInventoryMeta(invMeta()).ok, true)
  // THE SIZE CAP, and it is the SAME constant the slice uses — one budget for one upload leg.
  assert.equal(validateInventoryMeta(invMeta({ bytes: 1 })).ok, true)
  assert.equal(validateInventoryMeta(invMeta({ bytes: MAX_UPLOAD_BYTES })).ok, true)
  const tooBig = validateInventoryMeta(invMeta({ bytes: MAX_UPLOAD_BYTES + 1 }))
  assert.equal(tooBig.ok, false)
  assert.equal(!tooBig.ok && tooBig.field, 'inventory.bytes')
  // 0 bytes is not an upload: `content-length-range` starts at 1, and an empty dump is sent as
  // `inventory: null` rather than as a zero-row attachment.
  assert.equal(validateInventoryMeta(invMeta({ bytes: 0 })).ok, false)
  assert.equal(validateInventoryMeta(invMeta({ bytes: 2048.5 })).ok, false)

  assert.equal(validateInventoryMeta(invMeta({ lines: 1 })).ok, true)
  assert.equal(validateInventoryMeta(invMeta({ lines: MAX_INVENTORY_LINES })).ok, true)
  assert.equal(validateInventoryMeta(invMeta({ lines: MAX_INVENTORY_LINES + 1 })).ok, false)
  assert.equal(validateInventoryMeta(invMeta({ lines: 0 })).ok, false)
})

test('the dump freshness stamp is a timestamp, and its digest is 64 hex', () => {
  // `updatedAt` is the file's mtime as the CLIENT's filesystem reports it. It is bounded like
  // any epoch stamp and deliberately NOT compared to a server clock — a machine with a wrong
  // clock is a machine whose bug report we still want.
  assert.equal(validateInventoryMeta(invMeta({ updatedAt: 0 })).ok, true)
  const negative = validateInventoryMeta(invMeta({ updatedAt: -1 }))
  assert.equal(negative.ok, false)
  assert.equal(!negative.ok && negative.field, 'inventory.updatedAt')
  assert.equal(validateInventoryMeta(invMeta({ updatedAt: 1.5 })).ok, false)
  assert.equal(validateInventoryMeta(invMeta({ updatedAt: '2026-08-13' as unknown as number })).ok, false)

  for (const bad of ['b'.repeat(63), 'b'.repeat(65), `${'b'.repeat(63)}z`, '', 12]) {
    const res = validateInventoryMeta(invMeta({ sha256: bad as string }))
    assert.equal(res.ok, false, `sha256 ${String(bad)} must be rejected`)
    assert.equal(!res.ok && res.field, 'inventory.sha256')
  }

  for (const bad of [null, 'a dump', 42, []]) {
    const res = validateInventoryMeta(bad)
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.field, 'inventory')
  }
})

// ---------------------------------------------------------------------------------------
// validateSubmit — the whole request, as the Lambda sees it
// ---------------------------------------------------------------------------------------

const env = (over: Partial<FeedbackEnv> = {}): unknown => ({
  appVersion: '0.2.0',
  channel: 'prod',
  updateChannel: 'main',
  platform: 'win32',
  osRelease: '10.0.22631',
  arch: 'x64',
  electron: '33.2.0',
  chrome: '130.0.6723.44',
  node: '20.18.0',
  ...over
})

const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const UUID_B = '9c858901-8a57-4791-81fe-4c455b099bc9'

const submit = (over: Record<string, unknown> = {}): unknown => ({
  v: FEEDBACK_API_VERSION,
  draft: draft(),
  env: env(),
  installId: UUID_A,
  clientReportId: UUID_B,
  clientTs: 1_754_000_000_000,
  log: meta(),
  inventory: invMeta(),
  ...over
})

test('validateSubmit accepts a real request, with and without an attachment', () => {
  const withLog = validateSubmit(submit())
  assert.equal(withLog.ok, true)
  assert.equal(withLog.ok && withLog.value.log?.lines, 4_812)

  const noLog = validateSubmit(submit({ log: null }))
  assert.equal(noLog.ok, true)
  assert.equal(noLog.ok && noLog.value.log, null)
  // an absent key is the same statement as an explicit null
  const absent = validateSubmit(submit({ log: undefined }))
  assert.equal(absent.ok && absent.value.log, null)
})

// ---------------------------------------------------------------------------------------
// JOS-296 — the SECOND attachment on the whole request. Four properties, and the second and
// third are what make "additive" a fact rather than an intention.
// ---------------------------------------------------------------------------------------

/** The accepted request. Asserts acceptance itself, so callers below read the VALUE and never
 *  re-branch on `ok` — which is what keeps a four-case table a table. */
function accepted(over: Record<string, unknown>): SubmitRequest {
  const res = validateSubmit(submit(over))
  assert.equal(res.ok, true, `expected acceptance of ${JSON.stringify(Object.keys(over))}`)
  if (!res.ok) throw new Error('unreachable')
  return res.value
}

test('validateSubmit accepts BOTH attachments, either one alone, or neither', () => {
  const both = accepted({})
  assert.equal(both.log?.lines, 4_812)
  assert.equal(both.inventory?.lines, 295)
  assert.equal(both.inventory?.updatedAt, 1_754_000_000_000)

  const invOnly = accepted({ log: null })
  assert.equal(invOnly.log, null)
  assert.equal(invOnly.inventory?.bytes, 2_048)

  const logOnly = accepted({ inventory: null })
  assert.equal(logOnly.inventory, null)
  assert.equal(logOnly.log?.bytes, 131_072)

  const neither = accepted({ log: null, inventory: null })
  assert.equal(neither.log, null)
  assert.equal(neither.inventory, null)
})

test('an OLD client that never heard of the dump is accepted, not 400d — the field is additive', () => {
  // The whole reason FEEDBACK_API_VERSION stays 1: `v` is a hard gate, so a bump would turn
  // every installed client's report into a 400 the moment the new server deployed. An absent
  // `inventory` must therefore read exactly as "attached no dump".
  const absent = accepted({ inventory: undefined })
  assert.equal(absent.inventory, null)
  assert.equal(absent.v, FEEDBACK_API_VERSION)
})

test('unknown fields are STILL dropped, dump or no dump — the validator constructs, never copies', () => {
  // The retired `title`/`contact` law, re-asserted at the whole-request level now that a second
  // optional attachment exists: a client sending something the contract does not name gets a
  // value built out of the fields it DOES name, and nothing rides along.
  const res = validateSubmit(
    submit({
      title: 'gear counts are wrong',
      contact: 'me@example.com',
      inventoryText: 'Location\tName\tID\tCount\tSlots',
      attachments: ['log', 'inventory'],
      v: FEEDBACK_API_VERSION
    })
  )
  assert.equal(res.ok, true)
  const value = res.ok ? (res.value as unknown as Record<string, unknown>) : {}
  for (const stray of ['title', 'contact', 'inventoryText', 'attachments']) {
    assert.equal(stray in value, false, `${stray} must not survive validation`)
  }
  assert.deepEqual(Object.keys(value).sort(), [
    'achievements',
    'clientReportId',
    'clientTs',
    'draft',
    'env',
    'installId',
    'inventory',
    'log',
    'v'
  ])
})

test('the version is a hard gate — an unknown wire version never reaches the model', () => {
  for (const v of [0, 2, '1', null, undefined]) {
    const res = validateSubmit(submit({ v }))
    assert.equal(res.ok, false, `v=${String(v)} must be rejected`)
    assert.equal(!res.ok && res.field, 'v')
  }
})

test('ids must be v4 uuids — they key the quota and the idempotency item', () => {
  for (const field of ['installId', 'clientReportId']) {
    for (const bad of [
      '',
      'not-a-uuid',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301', // v1, not v4
      '3f2504e04f8941d39a0c0305e82c3301', // unhyphenated
      `${UUID_A} `,
      42
    ]) {
      const res = validateSubmit(submit({ [field]: bad }))
      assert.equal(res.ok, false, `${field}=${String(bad)} must be rejected`)
      assert.equal(!res.ok && res.field, field)
    }
  }
})

test('env is pinned to what the client can actually report', () => {
  // appVersion: semver, with CI's prerelease channel tag allowed
  for (const good of ['0.1.0', '0.2.0', '1.10.3', '0.2.0-main.41']) {
    assert.equal(validateSubmit(submit({ env: env({ appVersion: good }) })).ok, true)
  }
  for (const bad of ['0.2', 'v0.2.0', '', 'latest']) {
    const res = validateSubmit(submit({ env: env({ appVersion: bad }) }))
    assert.equal(res.ok, false, `appVersion=${bad} must be rejected`)
    assert.equal(!res.ok && res.field, 'env.appVersion')
  }
  // channel: 'e2e' is NOT a submitting channel — the headless harness never files a report
  assert.equal(validateSubmit(submit({ env: env({ channel: 'dev' }) })).ok, true)
  const e2e = validateSubmit(submit({ env: env({ channel: 'e2e' as FeedbackEnv['channel'] }) }))
  assert.equal(e2e.ok, false)
  assert.equal(!e2e.ok && e2e.field, 'env.channel')
  // updateChannel: exactly the store's two values
  assert.equal(validateSubmit(submit({ env: env({ updateChannel: 'stable' }) })).ok, true)
  assert.equal(
    validateSubmit(submit({ env: env({ updateChannel: 'beta' as 'main' }) })).ok,
    false
  )
  // free-form runtime strings: present and bounded
  const empty = validateSubmit(submit({ env: env({ arch: '' }) }))
  assert.equal(empty.ok, false)
  assert.equal(!empty.ok && empty.field, 'env.arch')
  assert.equal(validateSubmit(submit({ env: env({ osRelease: chars(MAX_ENV_FIELD) }) })).ok, true)
  assert.equal(
    validateSubmit(submit({ env: env({ osRelease: chars(MAX_ENV_FIELD + 1) }) })).ok,
    false
  )
  assert.equal(validateSubmit(submit({ env: null })).ok, false)
})

test("clientTs is kept, never trusted — any finite clock passes, a non-number doesn't", () => {
  for (const ts of [0, -1, 1_754_000_000_000, 4_102_444_800_000]) {
    assert.equal(validateSubmit(submit({ clientTs: ts })).ok, true, `clientTs=${ts}`)
  }
  for (const bad of ['now', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const res = validateSubmit(submit({ clientTs: bad }))
    assert.equal(res.ok, false, `clientTs=${String(bad)} must be rejected`)
    assert.equal(!res.ok && res.field, 'clientTs')
  }
})

test('a nested failure names the nested field, so the dialog can focus it', () => {
  const res = validateSubmit(submit({ draft: draft({ description: 'short' }) }))
  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.field, 'description')
  const logRes = validateSubmit(submit({ log: meta({ bytes: MAX_UPLOAD_BYTES + 1 }) }))
  assert.equal(!logRes.ok && logRes.field, 'log.bytes')
  // …and a malformed DUMP names ITS field, so a failure is never blamed on the wrong attachment.
  const invRes = validateSubmit(submit({ inventory: invMeta({ lines: MAX_INVENTORY_LINES + 1 }) }))
  assert.equal(!invRes.ok && invRes.field, 'inventory.lines')
  const notAnObject = validateSubmit(submit({ inventory: 'yes please' }))
  assert.equal(!notAnObject.ok && notAnObject.field, 'inventory')
})

test('validateSubmit returns a value that round-trips through JSON unchanged', () => {
  const res = validateSubmit(submit())
  assert.equal(res.ok, true)
  const value: SubmitRequest = res.ok ? res.value : ({} as SubmitRequest)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('the window choices the dialog offers include its default', () => {
  assert.ok(LOG_WINDOW_CHOICES.includes(DEFAULT_LOG_WINDOW as 15 | 30 | 60))
})

// ---------------------------------------------------------------------------------------
// the other half of the truth table: the SINGLE-LINE fields, which REJECT rather than strip
// ---------------------------------------------------------------------------------------

test('env.* REJECTS control characters — a runtime string cannot legitimately hold one', () => {
  // These values are `os.release()` and `process.versions.*`. They are printed straight into
  // the owner's terminal by the triage CLI, and nothing that produces them can emit an ESC. So
  // one arriving is not untidiness to be repaired, it is a forged payload, and it gets a 400
  // that names the field — which is the OPPOSITE verdict from `description`, deliberately.
  const fields = ['platform', 'osRelease', 'arch', 'electron', 'chrome', 'node'] as const
  const attacks = [
    `10.0.22631${ESC}[2J`,
    `${ESC}]0;pwned${BEL}x64`,
    `x64${NUL}`,
    `x64${ch(0x7f)}`,
    `x64${ch(0x9b)}`,
    `x6${ch(0x200b)}4`,
    `${ch(0x202e)}x64`,
    'multi\nline',
    'tab\tseparated'
  ]
  for (const field of fields) {
    for (const bad of attacks) {
      const res = validateSubmit(submit({ env: env({ [field]: bad }) }))
      assert.equal(res.ok, false, `env.${field} = ${JSON.stringify(bad)} must be refused`)
      assert.equal(!res.ok && res.field, `env.${field}`)
      assert.equal(!res.ok && res.error, 'invalid_payload')
    }
  }
})

test('env.* still NORMALIZES surrounding whitespace — the trim came first and stays', () => {
  // The reject fires on what survives the trim. A trailing newline from a sloppy caller is not
  // an attack and never was; an ESC in the interior is.
  const res = validateSubmit(submit({ env: env({ osRelease: '  10.0.22631\n' }) }))
  assert.equal(res.ok, true)
  assert.equal(res.ok && res.value.env.osRelease, '10.0.22631')
  // and a value that is ONLY whitespace is still the empty value it always was
  assert.equal(validateSubmit(submit({ env: env({ arch: '   ' }) })).ok, false)
})

test('the regex-pinned fields need no separate rule — the shape already refuses', () => {
  // Stated as a test so nobody "helpfully" adds a control check here and makes two rules where
  // the pattern is already total. In JS an un-flagged `$` matches only the very end of input,
  // so a trailing newline does not sneak past `^…$` the way it would in Python.
  for (const bad of [`0.2.0${ESC}[31m`, '0.2.0\n', `0.2.0${NUL}`]) {
    const res = validateSubmit(submit({ env: env({ appVersion: bad }) }))
    assert.equal(res.ok, false, `appVersion=${JSON.stringify(bad)} must be refused`)
    assert.equal(!res.ok && res.field, 'env.appVersion')
  }
  assert.equal(validateSubmit(submit({ installId: `${UUID_A}\n` })).ok, false)
  assert.equal(validateLogMeta(meta({ sha256: `${'a'.repeat(64)}\n` })).ok, false)
})

