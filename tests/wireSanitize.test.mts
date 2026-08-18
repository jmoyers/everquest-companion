// EVERYTHING A CLIENT SENDS US, SANITIZED — the four boundaries, in one suite.
//
// Sanitization used to be entirely CLIENT-side: the log scrubber and the contract's bounds both
// ran in the app, and the server trusted that an honest client had run them. A hostile or buggy
// client is not obliged to, and this suite is what says so at each boundary WE control:
//
//   1. THE SHARED HELPER (src/shared/sanitizeText.ts) — the character classes themselves, pinned
//      code point by code point. Everything below rests on these being right.
//   2. THE TELEMETRY SCHEMA (src/shared/telemetryValidate.ts) — pinned to have NO free-text
//      field at all, adversarially: an ESC injected into every string-valued slot of every event
//      kind and of the envelope must be REFUSED, not carried. `tests/telemetryContract.test.mts`
//      already asserts the same property declaratively (every string is a member of a closed
//      set); this is the same fact approached from the attacker's side, so a future field that
//      is somehow both "closed" and permissive still fails here.
//   3. THE OWNER-SIDE READERS (src/main/triage/rows.ts) — defense in depth for LEGACY ROWS. The
//      wire refuses control characters now, but rows written before that rule are still in the
//      table and a guard that only covers new rows is not a guard. Everything these mappers
//      hand to the triage tab, and everything `store.ts` hands to the CLI, is sanitized.
//   4. THE SLICE RE-SCRUB (rescrubSlice) — the presign policy pins an upload's key, size and
//      content-type and CANNOT pin its content, so a downloaded slice is re-scrubbed with the
//      app's OWN shared scrubber before it touches the owner's disk, and the delta is reported.
//   5. THE INVENTORY DUMP (sanitizeInventory) — the same third leg over a TAB-SEPARATED table the
//      GAME wrote, where the tabs are the format and must survive (JOS-404) while everything else
//      in the control classes still goes.
//
// The feedback wire's own truth table (strip in `description`, reject in `env.*`) lives with the
// rest of the contract, in tests/feedbackContract.test.mts.
//
// No Electron, no AWS, no network, no fixtures: this suite NEVER SKIPS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasNulByte,
  hasWireControls,
  sanitizeAndFlag,
  sanitizeMultiline,
  sanitizeOneLine,
  sanitizeTabbedAndFlag,
  sanitizeTabbedLine,
  stripAnsi
} from '../src/shared/sanitizeText'
import {
  inventoryNotes,
  parseEnv,
  rescrubNotes,
  rescrubSlice,
  sanitizeInventory,
  toDetail,
  toRow
} from '../src/main/triage/rows'
import {
  validateEnvelope,
  validateTelemetryBatch,
  validateTelemetryEvent
} from '../src/shared/telemetryValidate'
import { TELEMETRY_EVENT_KINDS, type TelemetryEvent } from '../src/shared/telemetry'

/** Written as codes, never as literals: a control character pasted into a source file is a
 *  character nobody reviewing the diff can see. */
const ch = (code: number): string => String.fromCharCode(code)
const ESC = ch(0x1b)
const BEL = ch(0x07)
const NUL = ch(0x00)
const ST = `${ESC}\\`

// =========================================================================================
// 1. the shared helper — the character classes, code point by code point
// =========================================================================================

test('stripAnsi removes whole escape sequences, payload and all', () => {
  const table: [string, string, string][] = [
    ['CSI colour', `${ESC}[31mred${ESC}[0m`, 'red'],
    ['CSI erase-display', `${ESC}[2Jgone`, 'gone'],
    ['CSI with intermediates', `${ESC}[?25lhidden`, 'hidden'],
    ['OSC set-title, BEL-terminated', `${ESC}]0;pwned${BEL}after`, 'after'],
    ['OSC set-title, ST-terminated', `${ESC}]0;pwned${ST}after`, 'after'],
    ['OSC 52 clipboard write', `${ESC}]52;c;bWFsaWNl${BEL}after`, 'after'],
    ['DCS', `${ESC}Pq#0;2;0;0;0${ST}after`, 'after'],
    ['APC', `${ESC}_payload${ST}after`, 'after'],
    ['Fe next-line', `${ESC}Eafter`, 'after'],
    ['Fs full reset', `${ESC}cafter`, 'after'],
    ['nF charset select', `${ESC}(Bafter`, 'after'],
    // A CSI truncated at the end of the string has no final byte, so arms 1-3 all miss and the
    // catch-all takes it. The ESC never survives, which is the only property that matters.
    ['a truncated CSI still loses its ESC', `${ESC}[`, '']
  ]
  for (const [name, sent, want] of table) assert.equal(stripAnsi(sent), want, name)
  // and text that merely LOOKS like an escape (no ESC) is left completely alone
  assert.equal(stripAnsi('[31m is how you write it'), '[31m is how you write it')
})

test('sanitizeMultiline keeps TAB and LF and nothing else in that class', () => {
  assert.equal(sanitizeMultiline('a\tb\nc'), 'a\tb\nc')
  assert.equal(sanitizeMultiline('a\r\nb\rc'), 'a\nb\nc')
  // every other C0, DEL, and the C1 block
  for (const code of [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x1f, 0x7f, 0x80, 0x9b, 0x9f]) {
    assert.equal(sanitizeMultiline(`a${ch(code)}b`), 'ab', `U+${code.toString(16)} must go`)
  }
  // ESC is the one that takes a hostage: `ESC b` IS an escape sequence, so the `b` goes with it.
  // That is the correct reading of the byte stream, and it is why the ANSI pass runs first.
  assert.equal(sanitizeMultiline(`a${ESC}b`), 'a')
  assert.equal(sanitizeMultiline(`a${ESC}`), 'a')
  // the invisible / reordering class, boundaries included
  for (const code of [0x200b, 0x200f, 0x2028, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff]) {
    assert.equal(sanitizeMultiline(`a${ch(code)}b`), 'ab', `U+${code.toString(16)} must go`)
  }
  // NEIGHBOURS OF THE CLASSES STAY. These are real characters people type, and a sanitizer that
  // eats them is a sanitizer that corrupts reports.
  for (const code of [0x09, 0x0a, 0x20, 0x7e, 0xa0, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a]) {
    assert.equal(sanitizeMultiline(`a${ch(code)}b`).length, 3, `U+${code.toString(16)} must stay`)
  }
  // it is IDEMPOTENT — running it twice is running it once
  const nasty = `${ESC}]0;t${BEL}a\r\nb${ch(0x202e)}${NUL}`
  assert.equal(sanitizeMultiline(sanitizeMultiline(nasty)), sanitizeMultiline(nasty))
})

test('sanitizeOneLine folds TAB/LF/CR to a single space and deletes the rest', () => {
  assert.equal(sanitizeOneLine('a\nb'), 'a b')
  assert.equal(sanitizeOneLine('a\r\nb'), 'a b') // CRLF is ONE break, so ONE space
  assert.equal(sanitizeOneLine('a\tb'), 'a b')
  assert.equal(sanitizeOneLine(`a${NUL}b`), 'ab')
  assert.equal(sanitizeOneLine(`${ESC}[31ma${ESC}[0m`), 'a')
  // the point of the fold: a value cannot forge an extra row in an aligned table
  assert.equal(sanitizeOneLine('win32\nplatform: linux').includes('\n'), false)
})

test('sanitizeTabbedLine keeps TAB — and ONLY where the columns are the game’s (JOS-404)', () => {
  // The one difference from sanitizeOneLine, and the whole reason this function exists: a row of
  // an inventory export is `Location<TAB>Name<TAB>ID<TAB>Count<TAB>Slots` and the tabs ARE the
  // format. A real row must come out byte for byte.
  const row = 'General 5-Slot13\tEfreeti War Bow\t20861\t1\t10'
  assert.equal(sanitizeTabbedLine(row), row)
  assert.equal(sanitizeTabbedLine('Location\tName\tID\tCount\tSlots'), 'Location\tName\tID\tCount\tSlots')
  // NOTHING ELSE in that class survives, and the output is still ONE line: LF and CR are gone
  // rather than folded, so a forged "row" cannot become two rows in the file on disk.
  assert.equal(sanitizeTabbedLine('a\nb'), 'ab')
  assert.equal(sanitizeTabbedLine('a\r\nb'), 'ab')
  for (const code of [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0d, 0x1f, 0x7f, 0x80, 0x9b, 0x9f]) {
    assert.equal(sanitizeTabbedLine(`a${ch(code)}b`), 'ab', `U+${code.toString(16)} must go`)
  }
  assert.equal(sanitizeTabbedLine(`${ESC}[31mred${ESC}[0m`), 'red')
  assert.equal(sanitizeTabbedLine(`${ESC}]0;pwned${BEL}after`), 'after')
  for (const code of [0x200b, 0x202e, 0x2060, 0x2069, 0xfeff]) {
    assert.equal(sanitizeTabbedLine(`a${ch(code)}b`), 'ab', `U+${code.toString(16)} must go`)
  }
  // and the narrowness is the guarantee: sanitizeOneLine still folds the tab it is given
  assert.equal(sanitizeOneLine(row).includes('\t'), false)
  // the flagging twin agrees with it, and says nothing happened when nothing did
  assert.deepEqual(sanitizeTabbedAndFlag(row), { text: row, changed: false })
  const dirty = sanitizeTabbedAndFlag(`${ESC}[2JGeneral 1\tRusty Dagger\t5\t1\t0`)
  assert.equal(dirty.changed, true)
  assert.equal(dirty.text, 'General 1\tRusty Dagger\t5\t1\t0')
})

test('hasWireControls is the REJECT predicate — stricter than the strip, by design', () => {
  assert.equal(hasWireControls('10.0.22631'), false)
  assert.equal(hasWireControls('x64'), false)
  assert.equal(hasWireControls('Darwin Kernel Version 23.6.0'), false)
  // TAB and LF are legitimate in a description and are NOT legitimate in `os.release()`
  assert.equal(hasWireControls('a\tb'), true)
  assert.equal(hasWireControls('a\nb'), true)
  for (const code of [0x00, 0x1b, 0x7f, 0x9b, 0x200b, 0x202e, 0xfeff]) {
    assert.equal(hasWireControls(`a${ch(code)}b`), true, `U+${code.toString(16)}`)
  }
  // TOTAL: the /g regexes it uses must not carry `lastIndex` between calls
  const dirty = `a${ESC}b`
  for (let i = 0; i < 5; i++) assert.equal(hasWireControls(dirty), true, `call ${String(i)}`)
  for (let i = 0; i < 5; i++) assert.equal(hasWireControls('clean'), false, `call ${String(i)}`)
})

test('hasNulByte is the pre-parse gate both Lambdas run', () => {
  assert.equal(hasNulByte('{"v":1}'), false)
  assert.equal(hasNulByte(`{"v":1,"x":"${NUL}"}`), true)
  assert.equal(hasNulByte(NUL), true)
  assert.equal(hasNulByte(''), false)
  // an ESCAPED nul is JSON text, not a NUL byte — this gate is about the RAW body, and the
  // parsed value is the shared validators' job. (Backslash-u-0-0-0-0, spelled from a char
  // code so no literal control character can hide in this source file.)
  assert.equal(hasNulByte(`{"d":"${ch(92)}u0000"}`), false)
})

test('sanitizeAndFlag reports whether it had to do anything', () => {
  assert.deepEqual(sanitizeAndFlag('[Sun Aug 03] You hit a rat for 12 points of damage.'), {
    text: '[Sun Aug 03] You hit a rat for 12 points of damage.',
    changed: false
  })
  const dirty = sanitizeAndFlag(`[Sun] ${ESC}]0;pwned${BEL}You hit a rat.`)
  assert.equal(dirty.changed, true)
  assert.equal(dirty.text, '[Sun] You hit a rat.')
})

// =========================================================================================
// 2. the telemetry schema — PINNED to have nowhere to put text
// =========================================================================================

/** One valid instance of every event kind. The completeness assertion below is what stops this
 *  list going stale when a twelfth kind is added. */
const EVENTS: TelemetryEvent[] = [
  { t: 'sessionStart', coldStartMsBucket: 2 },
  { t: 'sessionHeartbeat', uptimeMs: 300_000 },
  { t: 'sessionEnd', durationMs: 3_600_000, viewsVisited: 4 },
  { t: 'viewDwell', view: 'combat', ms: 90_000 },
  { t: 'overlayToggle', kind: 'heal-fight', open: true },
  { t: 'featureUse', feature: 'mapOpen', count: 3 },
  { t: 'alertFired', count: 12, spokenCount: 4 },
  {
    t: 'setupSnapshot',
    charCountBucket: 1,
    logSizeBucket: 3,
    alertCountBucket: 2,
    overlaysEnabled: ['fight', 'events'],
    cursorRing: false,
    autoHide: true,
    voiceEngine: 'kokoro',
    soundPackCount: 2,
    updateChannel: 'main'
  },
  { t: 'funnelStep', funnel: 'voice-install', step: 'downloadStarted' },
  {
    t: 'healthCounters',
    rendererCrashes: 0,
    mainErrorLogLines: 7,
    parserStalls: 0,
    presenceRestarts: 1,
    speechFailures: 0
  },
  { t: 'updateOutcome', step: 'download', ok: false, failureClass: 'network' },
  // THE ONE EVENT WITH TEXT IN IT (JOS-100), and it belongs in this list more than any other:
  // the pin below poisons every string slot and requires a refusal, so `errorReport`'s
  // pattern-bound fields have to earn the same "cannot speak to the terminal that prints it"
  // property the enum-bound ones get for free. `redactedMessage` is bounded to printable ASCII
  // precisely so this assertion holds for it.
  {
    t: 'errorReport',
    errorName: 'TypeError',
    code: 'ENOENT',
    redactedMessage: 'ENOENT: no such file or directory, open <path>',
    frames: [{ file: 'out/main/pipeline.js', line: 120, col: 15, func: 'Object.foldEvent' }],
    fingerprint: '0123456789abcdef',
    breadcrumbs: [{ kind: 'damage', offsetMs: 0 }],
    view: 'combat',
    sessionAgeBucket: 2,
    mode: 'live',
    count: 1
  },
  // THE TWO FIELDLESS KINDS (JOS-109). They contribute exactly one string slot each — their own
  // `t` — and the poison walk below therefore proves the only thing there is to prove about
  // them: that `optOut[2J` is not an event kind. An event with no fields cannot smuggle
  // text because it has nowhere to put any, which is the entire design.
  { t: 'optOut' },
  { t: 'optIn' }
]

const ENVELOPE = {
  analyticsId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  appVersion: '0.2.0',
  channel: 'prod',
  platform: 'win32',
  tzOffsetBucket: -5
}

test('every telemetry event kind has a sample here — a new kind needs one', () => {
  assert.deepEqual(
    EVENTS.map((e) => e.t).sort(),
    [...TELEMETRY_EVENT_KINDS].sort(),
    'add the new kind to EVENTS: that is how it gets its no-free-text assertion'
  )
  for (const ev of EVENTS) assert.equal(validateTelemetryEvent(ev).ok, true, ev.t)
})

test('THE PIN: no telemetry string field will carry an escape sequence — there is no free text', () => {
  // The adversarial form of "every string field is enum- or regex-bound". Walk every string
  // slot in every event and in the envelope, poison it, and require a REFUSAL. A field that
  // accepted the poisoned value would be free text by definition, whatever it was called.
  const poisons = [`${ESC}[2J`, `${ESC}]0;pwned${BEL}`, NUL, ch(0x202e), '\n']
  let slots = 0
  for (const ev of EVENTS) {
    for (const [key, value] of Object.entries(ev)) {
      if (typeof value !== 'string') continue
      slots++
      for (const poison of poisons) {
        const res = validateTelemetryEvent({ ...ev, [key]: `${value}${poison}` })
        assert.equal(res.ok, false, `${ev.t}.${key} accepted ${JSON.stringify(poison)}`)
      }
    }
    // the ARRAY-valued slot (`overlaysEnabled`) is a closed set too
    if (ev.t === 'setupSnapshot') {
      const res = validateTelemetryEvent({ ...ev, overlaysEnabled: [`fight${ESC}[2J`] })
      assert.equal(res.ok, false, 'overlaysEnabled accepted free text')
    }
  }
  assert.ok(slots >= 8, `expected the schema to have string slots to poison, found ${String(slots)}`)

  for (const key of ['analyticsId', 'appVersion', 'channel', 'platform']) {
    for (const poison of poisons) {
      const res = validateEnvelope({ ...ENVELOPE, [key]: `${String(ENVELOPE[key as 'channel'])}${poison}` })
      assert.equal(res.ok, false, `env.${key} accepted ${JSON.stringify(poison)}`)
      assert.equal(!res.ok && res.field, `env.${key}`)
    }
  }
})

test('an unknown property on a telemetry event is DROPPED, so it cannot smuggle text either', () => {
  // The construction property, restated for this suite: the validators build a value field by
  // field from the schema, so a stowaway string never enters the value at all.
  const res = validateTelemetryBatch({
    v: 1,
    env: { ...ENVELOPE, note: `${ESC}[2J` },
    events: [{ ts: 1, ev: { t: 'viewDwell', view: 'combat', ms: 5, note: `${ESC}]0;x${BEL}` } }]
  })
  assert.equal(res.ok, true)
  const json = JSON.stringify(res.ok ? res.value : null)
  assert.equal(json.includes('note'), false)
  assert.equal(json.includes(ESC), false)
})

// =========================================================================================
// 3. the owner-side readers — defense in depth for rows written before the wire rules
// =========================================================================================

/** A real-shaped ULID: 26 Crockford base32 characters. */
const ID = '01K1P6Q8ZJ7X4M2N9V5B3C6D7E'

/** A legacy row: written when the wire had no opinion about control characters. */
const hostileRow = (): Record<string, unknown> => ({
  report_id: ID,
  report_type: 'bug',
  description: `${ESC}]0;pwned${BEL}the meter shows zero dps${ESC}[2J`,
  app_version: `0.2.0${ESC}[31m`,
  platform: `win32${ch(0x202e)}`,
  channel: 'prod',
  status: 'new',
  spam_score: 0,
  received_at: 1_754_000_000_000,
  install_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  client_ts: 1_754_000_000_000,
  disposition: `looks real${ESC}[2J`,
  env_json: JSON.stringify({
    osRelease: `10.0.22631${ESC}[2J`,
    arch: 'x64\nplatform: linux',
    [`node${ESC}[31m`]: '20.18.0'
  })
})

/** Every string reachable from a value, however deeply nested. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)])
  }
  return []
}

test('NOTHING a triage row mapper returns carries a control character', () => {
  const row = hostileRow()
  for (const [name, value] of [
    ['toRow', toRow(row)],
    ['toDetail', toDetail(row, true)],
    ['parseEnv', parseEnv(row.env_json)]
  ] as const) {
    for (const s of strings(value)) {
      assert.equal(hasWireControls(s), false, `${name} leaked ${JSON.stringify(s)}`)
    }
  }
})

test('the sanitize is a strip, not a blank: the report survives, the escape sequence does not', () => {
  const detail = toDetail(hostileRow(), true)
  assert.equal(detail.row.description, 'the meter shows zero dps')
  assert.equal(detail.row.appVersion, '0.2.0')
  assert.equal(detail.row.platform, 'win32')
  assert.equal(detail.note, 'looks real')
  // env values fold to ONE LINE — a forged `platform: linux` row cannot appear in the grid
  assert.equal(detail.env.osRelease, '10.0.22631')
  assert.equal(detail.env.arch, 'x64 platform: linux')
  // even the KEY is sanitized: a hostile env key is a label in that same grid
  assert.deepEqual(Object.keys(detail.env).sort(), ['arch', 'node', 'osRelease'])
})

test('a clean row is returned completely unchanged — the sanitizer is not a rewriter', () => {
  const clean = {
    ...hostileRow(),
    description: 'the meter shows zero dps after zoning\n\nrepro:\n\t1. zone',
    app_version: '0.2.0',
    platform: 'win32',
    disposition: 'looks real',
    env_json: JSON.stringify({ osRelease: '10.0.22631', arch: 'x64' })
  }
  const detail = toDetail(clean, true)
  assert.equal(detail.row.description, clean.description)
  assert.deepEqual(detail.env, { osRelease: '10.0.22631', arch: 'x64' })
})

// =========================================================================================
// 4. the slice re-scrub — the delta IS the evidence
// =========================================================================================

const COMBAT = '[Sun Aug 03 21:14:02 2026] You hit a giant rat for 42 points of damage.'
const HEAL = '[Sun Aug 03 21:14:03 2026] You have been healed for 120 points of damage.'

test('an already-scrubbed slice has a delta of ZERO — that is what makes non-zero mean something', () => {
  const honest = [COMBAT, HEAL, '[Sun Aug 03 21:14:04 2026] You have gained a level!'].join('\n')
  const res = rescrubSlice(honest)
  assert.equal(res.dropped, 0)
  assert.equal(res.cleaned, 0)
  assert.equal(res.text, honest)
})

test('third-party chat a client failed to scrub is dropped HERE, and counted', () => {
  const bypassed = [
    COMBAT,
    "[Sun Aug 03 21:14:05 2026] Stranger tells the group, 'my address is 12 Elm St'",
    "[Sun Aug 03 21:14:06 2026] Someone says, 'hi'",
    '[Sun Aug 03 21:14:07 2026] [50 WAR] Bystander (Ogre) <Guild> ZONE: freeport',
    '[Sun Aug 03 21:14:08 2026] Rykkerr waves at Primitive.',
    HEAL
  ].join('\n')
  const res = rescrubSlice(bypassed)
  assert.equal(res.dropped, 4, 'every third-party line the client should have removed')
  assert.equal(res.text, [COMBAT, HEAL].join('\n'))
  // the pet-claim carve-out is the shared scrubber's, and it still holds through this path
  const pet = "[Sun Aug 03 21:14:09 2026] Vebarn told you, 'Attacking a giant rat Master.'"
  assert.equal(rescrubSlice(`${COMBAT}\n${pet}`).dropped, 0)
})

test('control characters in a slice line are cleaned, and counted separately', () => {
  // A cached slice is a file the operator will eventually `cat`. An ESC in a log line is an
  // escape sequence in their shell, so it never reaches the disk.
  const nasty = [COMBAT, `${ESC}]0;pwned${BEL}[Sun] You hit a rat.`, `${ESC}[2J${HEAL}`].join('\n')
  const res = rescrubSlice(nasty)
  assert.equal(res.dropped, 0, 'these are combat lines — the scrubber keeps them')
  assert.equal(res.cleaned, 2)
  for (const line of res.text.split('\n')) assert.equal(hasWireControls(line), false)
  assert.ok(res.text.includes('You hit a rat.'), 'the line SURVIVES; only the escape goes')
})

test('the two counts are independent — a bypassed slice can need both', () => {
  const both = [
    COMBAT,
    "[Sun Aug 03 21:14:05 2026] Stranger tells you, 'secret'",
    `${ESC}[31m${HEAL}`
  ].join('\n')
  const res = rescrubSlice(both)
  assert.equal(res.dropped, 1)
  assert.equal(res.cleaned, 1)
  assert.equal(res.text, [COMBAT, HEAL].join('\n'))
})

test('the CLI says NOTHING for an honest slice, and says it plainly otherwise', () => {
  // The silence is the design: a warning that fires on every slice is a warning nobody reads.
  const path = '.triage/slices/ID.log'
  assert.deepEqual(rescrubNotes({ path, dropped: 0, cleaned: 0, fromLegacyCache: false }), [])

  const bypassed = rescrubNotes({ path, dropped: 12, cleaned: 0, fromLegacyCache: false })
  assert.equal(bypassed.length, 1)
  assert.ok(bypassed[0].includes('12 line(s)'))
  assert.ok(bypassed[0].includes('S3 object is untouched'), 'the evidence claim must be stated')

  const both = rescrubNotes({ path, dropped: 3, cleaned: 4, fromLegacyCache: false })
  assert.equal(both.length, 2, 'the two facts are separate facts')

  // A pre-re-scrub cache reports UNKNOWN, never a zero it did not measure.
  const legacy = rescrubNotes({ path, dropped: 0, cleaned: 0, fromLegacyCache: true })
  assert.equal(legacy.length, 1)
  assert.ok(legacy[0].includes('never measured'))
  assert.ok(legacy[0].includes(path), 'it must name the file to delete')
})

test('CRLF slices count lines the same as LF ones', () => {
  // The uploaded object is whatever the client gzipped; a Windows client's newlines must not
  // change what "one line" means to either counter.
  const res = rescrubSlice([COMBAT, "[Sun] Stranger says, 'hi'", HEAL].join('\r\n'))
  assert.equal(res.dropped, 1)
  assert.equal(res.text, [COMBAT, HEAL].join('\n'))
})

// =========================================================================================
// 5. the inventory dump — the SAME third leg, over a TAB-SEPARATED table (JOS-404)
// =========================================================================================
//
// The slice's sanitize is a DISPLAY fold: tabs and newlines become spaces so a reporter's own
// text cannot forge rows in a table the CLI draws. A dump is not the reporter's text and is not
// drawn into a table — it is the game's own tab-separated export, written to disk for the owner
// to read and to re-parse. Folding its tabs counted every honest row as dirty (1079 of 1080 on
// report 01M081TPHPGB173YCC4YH7AMZB) and destroyed the columns. The round trip over the committed
// REAL dump lives with the rest of the dump's format law, in tests/feedbackInventory.test.mts.

/** The dump's shape, in the exact form `src/main/feedback/inventory.ts`'s header measured. */
const DUMP_HEADER = 'Location\tName\tID\tCount\tSlots'
const DUMP_ROW = 'General 5-Slot13\tEfreeti War Bow\t20861\t1\t10'

test('an honest dump is passed through UNTOUCHED — tabs, terminators and all', () => {
  for (const eol of ['\n', '\r\n']) {
    const honest = [DUMP_HEADER, DUMP_ROW, 'Charm\tEmpty\t0\t0\t0', ''].join(eol)
    const res = sanitizeInventory(honest)
    assert.equal(res.cleaned, 0, `no row of a real dump is dirty (${JSON.stringify(eol)})`)
    // BYTE FOR BYTE, which is the claim the CLI's silence makes about the local copy.
    assert.equal(res.text, honest)
    assert.equal(res.text.split(eol)[1], DUMP_ROW, 'the columns survive for the dump parser')
  }
})

test('a dump row carrying an escape is STILL cleaned, and still counted', () => {
  // The other half: the presign policy cannot pin an object's content, and this file is one the
  // owner will eventually `cat`. Keeping TAB does not mean keeping anything else.
  const forged = [
    DUMP_HEADER,
    `${ESC}]0;pwned${BEL}General 1\tRusty Dagger\t5\t1\t0`,
    DUMP_ROW,
    `Bank1\tScroll${ch(0x202e)}\t9\t1\t0`,
    `Bank2\tNul${NUL}\t9\t1\t0`
  ].join('\r\n')
  const res = sanitizeInventory(forged)
  assert.equal(res.cleaned, 3, 'the three forged rows, and only those')
  for (const line of res.text.split('\r\n')) {
    assert.equal(hasWireControls(line.replace(/\t/g, '')), false, `${JSON.stringify(line)} is clean`)
  }
  assert.ok(res.text.includes('General 1\tRusty Dagger\t5\t1\t0'), 'the row SURVIVES; the escape goes')
  assert.ok(res.text.includes(DUMP_ROW), 'the honest row beside it is untouched')
  // a stray CR INSIDE a row is not a terminator and is not content either
  const strayCr = sanitizeInventory(`${DUMP_HEADER}\r\nGeneral 1\rRusty Dagger\t5\t1\t0`)
  assert.equal(strayCr.cleaned, 1)
  assert.equal(strayCr.text.includes('\r\n'), true, 'the real terminator is untouched')
})

test('the CLI says NOTHING about an honest dump, and names the count otherwise', () => {
  const path = '.triage/inventory/ID.txt'
  assert.deepEqual(inventoryNotes({ path, cleaned: 0, fromLegacyCache: false }), [])

  const warned = inventoryNotes({ path, cleaned: 3, fromLegacyCache: false })
  assert.equal(warned.length, 1)
  assert.ok(warned[0].includes('3 row(s)'))
  assert.ok(warned[0].includes('did not come from the game'), 'the accusation is the point')
  assert.ok(warned[0].includes('S3 object is untouched'), 'the evidence claim must be stated')

  const legacy = inventoryNotes({ path, cleaned: 0, fromLegacyCache: true })
  assert.equal(legacy.length, 1)
  assert.ok(legacy[0].includes('never measured'))
  assert.ok(legacy[0].includes(path), 'it must name the file to delete')
})
