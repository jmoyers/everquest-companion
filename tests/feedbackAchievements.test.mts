// The feedback ACHIEVEMENTS attachment (src/main/feedback/achievements.ts) — JOS-441.
//
// WHY THIS FILE IS NOT A COPY OF `feedbackInventory.test.mts`, and where the line is. The packaging
// PATHS are shared code now (`dumpLines`, `previewOfDump`, `MAX_DUMP_READ_BYTES`) and are already
// pinned over there; re-asserting the row cap and the empty-file refusal against a second temp file
// would be testing the same three functions twice. What is genuinely new, and what is here:
//
//   * THE FORMAT SWEEP FOR THIS KIND. `inventory.ts`'s header ends by naming its own precondition
//     — a future dump kind must RE-DO the sweep rather than inherit the finding — and the
//     "no chat, so no scrub" decision in `achievements.ts` is only honest if something re-derives
//     it on every run. Two of the sweep's checks come back POSITIVE on this file and are
//     asserted as the game's own words rather than waved away, which is the point of running it.
//   * THE ROUND TRIP over the committed real dump, so what we claim to package is what the game
//     actually writes.
//   * THE OWNER SIDE: the sanitize-on-read must be a NO-OP on a real dump, byte for byte, or the
//     CLI's warning fires on every honest upload (the JOS-404 lesson, which cost 1,079 false
//     accusations the first time).
//
// No Electron, no network. Both fixtures are committed, so this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  FEEDBACK_API_VERSION,
  MAX_ACHIEVEMENTS_LINES,
  MAX_UPLOAD_BYTES,
  validateSubmit,
  type AchievementsDumpMeta
} from '../src/shared/feedback'
import {
  achievementsMeta,
  buildAchievementsAttachment
} from '../src/main/feedback/achievements'
import { dumpLines } from '../src/main/feedback/inventory'
import { achievementsNotes, sanitizeAchievements } from '../src/main/triage/rows'
import { parseAchievementsDump } from '../src/shared/outputs/achievements'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const REAL_DUMP = join(FIXTURES, 'Primitive_freeport-Achievements.txt')
const TOKEN_DUMP = join(FIXTURES, 'synthetic-token-unlock-Achievements.txt')

// ---- the round trip over the committed real dump -------------------------------------------

test('the committed dump packages verbatim: the gz IS the file, and the digest is of the gz', async () => {
  const res = await buildAchievementsAttachment(REAL_DUMP, 'Primitive_freeport-Achievements.txt')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')

  const raw = readFileSync(REAL_DUMP, 'utf8')
  assert.equal(res.text, raw, 'nothing is trimmed, folded or normalized on the way out')
  assert.equal(gunzipSync(res.gz).toString('utf8'), raw, 'and the gz round-trips to the same bytes')
  assert.equal(res.sha256, createHash('sha256').update(res.gz).digest('hex'))
  assert.equal(res.lines, 1_884, 'the measured line count of the owner’s real dump')
  assert.equal(res.fileName, 'Primitive_freeport-Achievements.txt')
  assert.ok(res.bytes > 0 && res.bytes <= MAX_UPLOAD_BYTES)
  assert.ok(res.updatedAt > 0, 'the FILE’s mtime, not ours')
})

test('the metadata half carries the four wire fields and nothing else', async () => {
  const res = await buildAchievementsAttachment(REAL_DUMP, 'Primitive_freeport-Achievements.txt')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  const meta = achievementsMeta(res)
  assert.deepEqual(Object.keys(meta).sort(), ['bytes', 'lines', 'sha256', 'updatedAt'])
  // No fileName and no path — the filename is the ONE place the character's identity appears
  // (the sweep below proves it is nowhere in the contents), and the wire does not need it.
  assert.equal('fileName' in meta, false)
})

test('THE PACKAGED BYTES STILL PARSE AS THE FORMAT THE APP READS', async () => {
  // The attachment exists to answer a question about the class-unlock pseudo-rows, so "it
  // uploaded something" is not the claim — the claim is that what lands is a file the parser can
  // read the discrimination out of. That is what makes a token-user's report diagnosable.
  const res = await buildAchievementsAttachment(REAL_DUMP, 'Primitive_freeport-Achievements.txt')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  const dump = parseAchievementsDump(gunzipSync(res.gz).toString('utf8'))
  assert.equal(dump.rows.length, 1_858, 'every row but the 26 category headers')
})

// ---- the named refusals --------------------------------------------------------------------

interface Temp {
  dir: string
  path: string
}

function writeDump(text: string, name = 'Testchar_freeport-Achievements.txt'): Temp {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-feedback-ach-'))
  const path = join(dir, name)
  writeFileSync(path, text, 'utf8')
  return { dir, path }
}

const cleanup = (t: Temp): void => {
  rmSync(t.dir, { recursive: true, force: true })
}

test('every way of having nothing is a NAMED reason, never a throw', async () => {
  const missing = await buildAchievementsAttachment(
    join(tmpdir(), 'eqc-no-such-achievements-file.txt'),
    'x.txt'
  )
  assert.equal(missing.ok, false)
  assert.equal(!missing.ok && missing.reason, 'no-dump')

  const empty = writeDump('')
  try {
    const res = await buildAchievementsAttachment(empty.path, 'empty.txt')
    assert.equal(!res.ok && res.reason, 'empty')
  } finally {
    cleanup(empty)
  }

  // OVER THE ROW CAP IS REFUSED, NEVER TRIMMED. The discrimination this attachment exists for
  // lives in two boilerplate rows at the BOTTOM of each class's block, so a dump trimmed from
  // either end can drop exactly the evidence that was worth sending.
  const huge = writeDump(
    `${Array.from({ length: MAX_ACHIEVEMENTS_LINES + 1 }, (_, i) => `I\tAch ${String(i)}`).join('\r\n')}\r\n`
  )
  try {
    const res = await buildAchievementsAttachment(huge.path, 'huge.txt')
    assert.equal(!res.ok && res.reason, 'too-large')
  } finally {
    cleanup(huge)
  }

  const dir = mkdtempSync(join(tmpdir(), 'eqc-feedback-ach-dir-'))
  try {
    const res = await buildAchievementsAttachment(dir, 'a-directory')
    assert.equal(!res.ok && res.reason, 'unreadable', 'a directory stats fine and is not a dump')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- THE FORMAT SWEEP, executable ------------------------------------------------------------

test('THE FORMAT SWEEP: the achievements dump carries nothing the log scrubber would remove', () => {
  // The finding in `src/main/feedback/achievements.ts`'s header, re-derived on every run. It was
  // re-done for this kind rather than inherited from the inventory's, which is the precondition
  // that header names — and doing it turned up two positives that had to be explained rather
  // than assumed away (see the two checks that assert what the hits ARE).
  for (const path of [REAL_DUMP, TOKEN_DUMP]) {
    const text = readFileSync(path, 'utf8')
    const where = `${path}:`

    // 1. Printable ASCII plus TAB/CR/LF and nothing else — so there is nothing for the wire
    //    sanitizer to strip either. Spelled as code, not a regex class: a control character
    //    written into a source file is one nobody reviewing the diff sees.
    const bad = [...text].find((c) => {
      const code = c.codePointAt(0) ?? 0
      return c !== '\t' && c !== '\r' && c !== '\n' && (code < 0x20 || code > 0x7e)
    })
    assert.equal(
      bad,
      undefined,
      `${where} non-printable byte U+${(bad?.codePointAt(0) ?? 0).toString(16)}`
    )

    // 2. No timestamps. Every log line carries `[Day Mon DD HH:MM:SS YYYY]`; not one row here does.
    assert.equal(/^\[[A-Z][a-z]{2} [A-Z][a-z]{2} /m.test(text), false, `${where} a log prefix`)

    // 3. No speech, no tells, no /who, no emotes — the families the scrubber drops.
    assert.equal(
      /\b(says|tells you|told you|shouts|auctions)\b/.test(text),
      false,
      `${where} speech`
    )

    // 4. No paths, URLs or e-mail-shaped text. Nothing in this file names a machine.
    assert.equal(/https?:\/\/|[A-Za-z]:\\|@[A-Za-z0-9-]+\./.test(text), false, `${where} a locator`)

    // 5. THE ONE THAT MATTERS MOST: the character's name is in the FILENAME, never in the
    //    CONTENTS. That is why `AchievementsDumpMeta` carries no filename.
    assert.equal(/primitive/i.test(text), false, `${where} the character name`)

    // 6. THE FIRST POSITIVE, ASSERTED RATHER THAN DISMISSED. `Freeport` DOES appear — as the
    //    CITY, in the game's own achievement names. The dev character's server happens to share
    //    the name, which is exactly why this was checked instead of assumed. Every hit is a place
    //    name the game wrote; none is the server field.
    const freeport = [...text.matchAll(/^.*Freeport.*$/gm)].map((m) => m[0])
    assert.ok(freeport.length > 0, `${where} expected the city to appear`)
    for (const line of freeport) {
      assert.ok(
        /Race Unlock|Militia|Traveler|Visit |Sewers/.test(line),
        `${where} a Freeport hit that is not a place name: ${line}`
      )
    }

    // 7. THE SECOND POSITIVE. There are exactly two quoted strings in the file, and BOTH are TASK
    //    TITLES the game wrote inside a `Complete the '…' task` sentence — not speech somebody
    //    typed. Every other apostrophe is a possessive in an item or NPC name. Asserted as an
    //    exact list rather than a pattern: a THIRD quoted string appearing is news, and the
    //    sentence it sits in is what has to be read before the no-scrub decision survives it.
    const quoted = [...text.matchAll(/^.*'[^'\t\r\n]{15,}'.*$/gm)].map((m) => m[0].trim())
    assert.deepEqual(
      quoted,
      [
        "I\t\tComplete the 'Aid the Kerrans of Kerra Isle' Task.",
        "I\t\tComplete the 'Renouncing Your Faith' task for a mysterious Emissary."
      ],
      `${where} unexpected quoted text`
    )

    // 8. It is the tab-indented tree the parser expects: one to four fields, and the indent
    //    columns of a component row are always empty.
    const rows = dumpLines(text).filter((l) => l.length > 0)
    assert.ok(rows.length > 0, `${where} no rows`)
    for (const row of rows) {
      const fields = row.split('\t')
      assert.ok(fields.length <= 4, `${where} a row with ${String(fields.length)} fields: ${row}`)
      if (fields.length > 2) assert.equal(fields[1], '', `${where} a non-empty indent: ${row}`)
    }
  }
})

// ---- THE OWNER SIDE OF THE SAME BYTES --------------------------------------------------------

test('the owner-side sanitize is a NO-OP on a real dump, byte for byte', () => {
  // The JOS-404 lesson, re-asserted for the kind that arrived after it: the client packages the
  // dump verbatim and the owner sanitizes it on the way to disk, and those two facts only
  // compose if the sanitize changes nothing. It uses `sanitizeTabbedAndFlag`, so the tabs this
  // format is built out of survive — the one-line fold would accuse all 1,884 rows.
  for (const path of [REAL_DUMP, TOKEN_DUMP]) {
    const raw = readFileSync(path, 'utf8')
    const out = sanitizeAchievements(raw)
    assert.equal(out.cleaned, 0, `${path}: an honest dump cleans nothing`)
    assert.equal(out.text, raw, `${path}: including its CRLF terminators, byte for byte`)
    assert.deepEqual(
      achievementsNotes({ path, cleaned: out.cleaned, fromLegacyCache: false }),
      [],
      'so the CLI stays silent, which is what makes the other case loud'
    )
  }
})

test('a forged dump IS flagged, and the warning names the achievements export', () => {
  const forged = 'C\tPrimary Class Unlock - Bard\r\nC\t\tObtain [31mMask of Song.\r\n'
  const out = sanitizeAchievements(forged)
  assert.equal(out.cleaned, 1, 'exactly the row that carried the escape')
  assert.equal(out.text.includes(''), false)
  const notes = achievementsNotes({ path: '/tmp/x.txt', cleaned: out.cleaned, fromLegacyCache: false })
  assert.equal(notes.length, 1)
  assert.match(notes[0], /achievements export/, 'never blamed on the inventory')
})

// ---- THE WIRE CONTRACT for the third attachment ----------------------------------------------
//
// These live here rather than in `feedbackContract.test.mts` because that file is at its measured
// 400-code-line ceiling and the answer to a ceiling in this repo is a split, not a widened
// threshold. The properties are the SAME four JOS-296 pinned for the second attachment, asserted a
// second time on purpose: a rule that has only ever been applied once is a coincidence, and the
// additive-field argument is the whole reason `FEEDBACK_API_VERSION` is still 1.

/** The achievements dump's metadata, sized like the real one: 1,884 lines, ~8 KB gzipped. */
const achMeta = (over: Partial<AchievementsDumpMeta> = {}): unknown => ({
  bytes: 8_192,
  lines: 1_884,
  updatedAt: 1_754_000_000_000,
  sha256: 'c'.repeat(64),
  ...over
})

/** A whole request with no attachments, so each test names only the one it is about. */
const submit = (over: Record<string, unknown> = {}): unknown => ({
  v: FEEDBACK_API_VERSION,
  draft: { type: 'bug', description: 'sky quests i never ran read as turned in' },
  env: {
    appVersion: '1.7.0',
    channel: 'prod',
    updateChannel: 'main',
    platform: 'win32',
    osRelease: '10.0.26200',
    arch: 'x64',
    electron: '43.2.0',
    chrome: '150.0.7871.129',
    node: '24.18.0'
  },
  installId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  clientReportId: '9c858901-8a57-4791-81fe-4c455b099bc9',
  clientTs: 1_754_000_000_000,
  log: null,
  inventory: null,
  ...over
})

test('validateSubmit accepts the achievements dump, and treats absence as "none attached"', () => {
  const withAch = validateSubmit(submit({ achievements: achMeta() }))
  assert.equal(withAch.ok, true)
  assert.equal(withAch.ok && withAch.value.achievements?.lines, 1_884)
  assert.equal(withAch.ok && withAch.value.achievements?.updatedAt, 1_754_000_000_000)

  // THE ADDITIVE PROPERTY, which is what lets `v` stay 1: an old client that never heard of this
  // field is accepted, not 400d, and its omission reads exactly as "attached no dump".
  const absent = validateSubmit(submit())
  assert.equal(absent.ok && absent.value.achievements, null)
  const explicit = validateSubmit(submit({ achievements: null }))
  assert.equal(explicit.ok && explicit.value.achievements, null)
})

test('a malformed achievements dump names ITS OWN field, never the inventory’s', () => {
  // The one reason `validateAchievementsMeta` is a second function rather than a parameterised
  // one: an error that names the wrong attachment is a report nobody can act on.
  const cases: [unknown, string][] = [
    [achMeta({ lines: MAX_ACHIEVEMENTS_LINES + 1 }), 'achievements.lines'],
    [achMeta({ bytes: MAX_UPLOAD_BYTES + 1 }), 'achievements.bytes'],
    [achMeta({ bytes: 0 }), 'achievements.bytes'],
    [achMeta({ sha256: 'nope' }), 'achievements.sha256'],
    ['the whole file', 'achievements']
  ]
  for (const [value, field] of cases) {
    const res = validateSubmit(submit({ achievements: value }))
    assert.equal(res.ok, false, `expected a refusal for ${field}`)
    assert.equal(!res.ok && res.field, field)
  }
  // …and the bounds it DOES accept are the presign policy's, at both edges.
  assert.equal(validateSubmit(submit({ achievements: achMeta({ bytes: 1 }) })).ok, true)
  assert.equal(
    validateSubmit(submit({ achievements: achMeta({ bytes: MAX_UPLOAD_BYTES }) })).ok,
    true
  )
  assert.equal(
    validateSubmit(submit({ achievements: achMeta({ lines: MAX_ACHIEVEMENTS_LINES }) })).ok,
    true
  )
})
