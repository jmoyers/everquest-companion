// The feedback INVENTORY attachment (src/main/feedback/inventory.ts) — JOS-296.
//
// Two kinds of input, both deliberate:
//
//   * SYNTHETIC dumps written into a temp dir, for the paths that are about SIZE and FAILURE
//     (the row cap, the byte cap, an empty file, a missing one, a directory where a file should
//     be). Those need shapes no real export has, so they are built here.
//   * THE COMMITTED REAL DUMP (`tests/fixtures/Primitive_freeport-Inventory.txt`, 295 rows, the
//     measured one), read READ-ONLY, for the round trip. It is the awaiting-sample law applied
//     to an attachment: what we claim to package is what the game actually writes, not a shape
//     invented in a test.
//
// The last test in this file is the FORMAT SWEEP, executable. The module header states a finding
// — the dump carries no chat, no speech, no timestamps, no paths and not even the character
// name, so the log scrubber does not apply to it — and a finding that only lives in a comment is
// a finding that quietly stops being true. This suite re-derives it from the committed fixtures
// on every run, so a future dump that breaks it breaks a test instead of a promise.
//
// No Electron, no network. The two fixtures are committed, so this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { MAX_INVENTORY_LINES, MAX_UPLOAD_BYTES, PREVIEW_MAX_LINES } from '../src/shared/feedback'
import {
  buildInventoryAttachment,
  dumpLines,
  inventoryMeta,
  MAX_DUMP_READ_BYTES,
  previewOfDump
} from '../src/main/feedback/inventory'
import { inventoryNotes, sanitizeInventory } from '../src/main/triage/rows'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const REAL_DUMP = join(FIXTURES, 'Primitive_freeport-Inventory.txt')
const KEYRING_DUMP = join(FIXTURES, 'jos66-sky-keyring-Inventory.txt')

interface Temp {
  dir: string
  path: string
}

function writeDump(text: string, name = 'Testchar_freeport-Inventory.txt'): Temp {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-feedback-inv-'))
  const path = join(dir, name)
  writeFileSync(path, text, 'utf8')
  return { dir, path }
}

const cleanup = (t: Temp): void => {
  rmSync(t.dir, { recursive: true, force: true })
}

/** A synthetic dump with `rows` item rows, in the real header + tab-separated shape. */
function syntheticDump(rows: number): string {
  const out = ['Location\tName\tID\tCount\tSlots']
  for (let i = 0; i < rows; i++) out.push(`General ${String((i % 10) + 1)}\tItem ${String(i)}\t${String(1000 + i)}\t1\t0`)
  return `${out.join('\r\n')}\r\n`
}

// ---- pure helpers ---------------------------------------------------------------------------

test('dumpLines drops the trailing newline’s empty line and KEEPS the interior blank', () => {
  // The interior blank is the file's SECTION SEPARATOR (item table, blank, keyring table). A
  // filter that dropped it would hand the owner a dump that parses differently from the
  // player's, which is the one thing an evidence file must never do.
  const text = 'Location\tName\tID\tCount\tSlots\r\nEar\tRing\t1\t1\t0\r\n\r\nKeyRing\tName\tID\t\r\n'
  const lines = dumpLines(text)
  assert.deepEqual(lines, [
    'Location\tName\tID\tCount\tSlots',
    'Ear\tRing\t1\t1\t0',
    '',
    'KeyRing\tName\tID\t'
  ])
  assert.deepEqual(dumpLines(''), [])
  assert.deepEqual(dumpLines('\n'), [''])
})

test('previewOfDump caps at PREVIEW_MAX_LINES and says how much it left out', () => {
  const short = Array.from({ length: 10 }, (_, i) => `row ${String(i)}`)
  const whole = previewOfDump(short)
  assert.equal(whole.truncatedPreview, false)
  assert.deepEqual(whole.previewLines, short)

  const long = Array.from({ length: PREVIEW_MAX_LINES + 250 }, (_, i) => `row ${String(i)}`)
  const capped = previewOfDump(long)
  assert.equal(capped.truncatedPreview, true)
  assert.equal(capped.previewLines.length, PREVIEW_MAX_LINES + 1)
  // A dump is a table read from the top, not a timeline, so the head is kept whole and the
  // omission marker is last — no head/tail split (that is the slice's shape, for its reason).
  assert.equal(capped.previewLines[0], 'row 0')
  assert.ok(capped.previewLines[PREVIEW_MAX_LINES].includes('250'))
  assert.ok(capped.previewLines[PREVIEW_MAX_LINES].includes('more rows'))
})

// ---- the round trip, against the REAL committed dump ------------------------------------------

test('the real dump round-trips: gzip is exactly the bytes on disk, and the digest matches', async () => {
  const res = await buildInventoryAttachment(REAL_DUMP, 'Primitive_freeport-Inventory.txt')
  assert.equal(res.ok, true)
  if (!res.ok) return

  const onDisk = readFileSync(REAL_DUMP, 'utf8')
  // THE ROUND TRIP. `gz` is the gzip of the file's text and nothing else — no trimming, no
  // re-joining, no normalization. What the owner ungzips is byte-for-byte what the player has.
  assert.equal(gunzipSync(res.gz).toString('utf8'), onDisk)
  assert.equal(res.text, onDisk)

  // The declared digest is over the GZ bytes (that is what the upload leg checks against).
  assert.equal(res.sha256, createHash('sha256').update(res.gz).digest('hex'))
  assert.equal(res.bytes, res.gz.length)
  assert.ok(res.bytes > 0 && res.bytes < MAX_UPLOAD_BYTES)

  // The measured dump: 295 rows. An identity, not a guess — it is a committed file.
  assert.equal(res.lines, dumpLines(onDisk).length)
  assert.equal(res.lines, 295)
  assert.equal(res.fileName, 'Primitive_freeport-Inventory.txt')
  assert.equal(res.truncatedPreview, false)
  assert.equal(res.previewLines.length, 295)

  // The metadata half is exactly the four wire fields — no path, no filename, nothing else.
  assert.deepEqual(Object.keys(inventoryMeta(res)).sort(), ['bytes', 'lines', 'sha256', 'updatedAt'])
})

test('the dump is opened READ-ONLY — packaging it does not touch the file', async () => {
  const before = readFileSync(REAL_DUMP)
  const beforeStat = statSync(REAL_DUMP)
  await buildInventoryAttachment(REAL_DUMP, 'Primitive_freeport-Inventory.txt')
  const after = readFileSync(REAL_DUMP)
  assert.ok(before.equals(after), 'the committed dump changed — the module wrote to it')
  assert.equal(statSync(REAL_DUMP).mtimeMs, beforeStat.mtimeMs, 'the mtime moved')
})

test('updatedAt is the FILE’s mtime — the JOS-253 freshness truth, not the read time', async () => {
  const fx = writeDump(syntheticDump(3))
  try {
    // Three weeks ago, to the second. This is the number that turns "the app says I don't own
    // that item" into an answer, so it has to be the file's stamp and never `Date.now()`.
    const then = Date.now() - 21 * 86_400_000
    utimesSync(fx.path, new Date(then), new Date(then))
    const res = await buildInventoryAttachment(fx.path, 'Testchar_freeport-Inventory.txt')
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.updatedAt, Math.floor(statSync(fx.path).mtimeMs))
    assert.ok(Math.abs(res.updatedAt - then) < 2_000, `updatedAt was ${String(res.updatedAt)}`)
    assert.ok(res.updatedAt < Date.now() - 20 * 86_400_000, 'the read time leaked into updatedAt')
  } finally {
    cleanup(fx)
  }
})

test('the keyring fixture packages too — two sections, blank line and all', async () => {
  const res = await buildInventoryAttachment(KEYRING_DUMP, 'jos66-sky-keyring-Inventory.txt')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(gunzipSync(res.gz).toString('utf8'), readFileSync(KEYRING_DUMP, 'utf8'))
  assert.ok(res.previewLines.includes(''), 'the section separator survived into the preview')
})

// ---- the refusals ------------------------------------------------------------------------------
//
// EVERY ONE OF THESE IS A NAMED REASON, never a bare null. The dialog has to say WHICH nothing it
// is looking at: "you have never run the command" and "your export is too big" are different
// sentences to a user, and collapsing them would have the app deny an export the user can see.

test('a dump that is not there is `no-dump`, not an error', async () => {
  const res = await buildInventoryAttachment(join(tmpdir(), 'eqc-no-such-Inventory.txt'), 'x.txt')
  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.reason, 'no-dump')
})

test('an empty dump is `empty` — a zero-row attachment is not an attachment', async () => {
  const fx = writeDump('')
  try {
    const res = await buildInventoryAttachment(fx.path, 'Testchar_freeport-Inventory.txt')
    assert.equal(!res.ok && res.reason, 'empty')
  } finally {
    cleanup(fx)
  }
})

test('a path that stats but cannot be read is `unreadable`, which is NOT `no-dump`', async () => {
  // A directory is the portable stand-in for "stats fine, reads never": `readFile` on one fails
  // with EISDIR on every platform, where a chmod-based test would be a no-op on Windows.
  const dir = mkdtempSync(join(tmpdir(), 'eqc-feedback-inv-'))
  const asDir = join(dir, 'Testchar_freeport-Inventory.txt')
  mkdirSync(asDir)
  try {
    const res = await buildInventoryAttachment(asDir, 'Testchar_freeport-Inventory.txt')
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'unreadable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE SIZE CAP IS A REFUSAL, NOT A TRIM — an oversize dump is `too-large` and nothing is sent', async () => {
  // The whole argument for this test: a log slice that will not fit is trimmed from the front,
  // because fewer log lines is less context. A dump cannot be. A trimmed inventory is a
  // well-formed file that silently claims the missing items do not exist, which is the exact
  // failure this attachment exists to diagnose.
  const fx = writeDump(syntheticDump(MAX_INVENTORY_LINES + 5))
  try {
    const res = await buildInventoryAttachment(fx.path, 'Testchar_freeport-Inventory.txt')
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'too-large')
    // …and the row cap is a boundary, not a vibe: one under it packages.
    const under = writeDump(syntheticDump(MAX_INVENTORY_LINES - 1))
    try {
      const ok = await buildInventoryAttachment(under.path, 'Testchar_freeport-Inventory.txt')
      assert.equal(ok.ok, true)
      assert.equal(ok.ok && ok.lines, MAX_INVENTORY_LINES)
      assert.ok(ok.ok && ok.bytes <= MAX_UPLOAD_BYTES)
    } finally {
      cleanup(under)
    }
  } finally {
    cleanup(fx)
  }
})

test('a file too big to load whole is refused on the STAT, without ever reading it', async () => {
  // The read cap exists so a file that is not an inventory dump at all can never be pulled into
  // memory. It is checked before the read, so this test is about the stat and not the content:
  // incompressible random rows keep the file honestly large without a 8 MB write of zeroes.
  const fx = writeDump('x')
  try {
    const rows: string[] = ['Location\tName\tID\tCount\tSlots']
    // ~9 MB of unique text, comfortably past MAX_DUMP_READ_BYTES.
    for (let i = 0; i < 90_000; i++) rows.push(`General 1\t${'q'.repeat(90)}${String(i)}\t${String(i)}\t1\t0`)
    writeFileSync(fx.path, rows.join('\r\n'), 'utf8')
    assert.ok(statSync(fx.path).size > MAX_DUMP_READ_BYTES, 'the fixture is not actually oversize')
    const res = await buildInventoryAttachment(fx.path, 'Testchar_freeport-Inventory.txt')
    assert.equal(!res.ok && res.reason, 'too-large')
  } finally {
    cleanup(fx)
  }
})

// ---- THE FORMAT SWEEP, executable ---------------------------------------------------------------

test('THE FORMAT SWEEP: the committed dumps carry nothing the log scrubber would have to remove', () => {
  // This is the finding in `src/main/feedback/inventory.ts`'s header, re-derived. If a future
  // dump breaks one of these, the comment claiming "no chat, so no scrub" has stopped being
  // true and this test is where that is discovered — not in someone's bug report.
  for (const path of [REAL_DUMP, KEYRING_DUMP]) {
    const text = readFileSync(path, 'utf8')
    const where = `${path}:`

    // 1. Printable ASCII plus TAB/CR/LF, and nothing else. No control character, no C1, no
    //    invisible or BiDi formatting character — so there is nothing here for the wire
    //    sanitizer to strip either. Spelled as a code test rather than a regex character class:
    //    a control character written into a source file is one nobody reviewing the diff sees.
    const bad = [...text].find((c) => {
      const code = c.codePointAt(0) ?? 0
      return c !== '\t' && c !== '\r' && c !== '\n' && (code < 0x20 || code > 0x7e)
    })
    assert.equal(bad, undefined, `${where} non-printable byte U+${(bad?.codePointAt(0) ?? 0).toString(16)}`)

    // 2. No timestamps. Every log line carries the `[Day Mon DD HH:MM:SS YYYY]` prefix that the
    //    scrubber's whole vocabulary is built on; not one row here does.
    assert.equal(/^\[[A-Z][a-z]{2} [A-Z][a-z]{2} /m.test(text), false, `${where} a log prefix`)

    // 3. No speech, no tells, no /who, no emotes — the four families the scrubber drops.
    assert.equal(/\b(says|tells you|told you|shouts|auctions|WHO)\b/.test(text), false, `${where} speech`)

    // 4. No paths, URLs or e-mail-shaped text. Nothing in this file names a machine.
    assert.equal(/https?:\/\/|[A-Za-z]:\\|@[A-Za-z0-9-]+\./.test(text), false, `${where} a locator`)

    // 5. THE ONE THAT MATTERS MOST: the character's name and the server are in the FILENAME,
    //    never in the CONTENTS. That is why `InventoryDumpMeta` carries no filename — the wire
    //    would otherwise learn an identity the dump itself does not state.
    assert.equal(/primitive|freeport/i.test(text), false, `${where} the character or server name`)

    // 6. It is the tab-separated table the parser expects: a header whose second column is
    //    literally `Name`, and rows of 2..5 tab-separated columns.
    const rows = dumpLines(text).filter((l) => l.length > 0)
    assert.ok(rows.length > 0, `${where} no rows`)
    assert.equal(rows[0].split('\t')[1], 'Name', `${where} the header is not a section header`)
    for (const row of rows) {
      const cols = row.split('\t').length
      assert.ok(cols >= 2 && cols <= 5, `${where} a row with ${String(cols)} columns: ${row}`)
    }
  }
})

// ---- THE OWNER SIDE OF THE SAME BYTES (JOS-404) -------------------------------------------------
//
// The client packages the dump verbatim (the round trip above). The OWNER then downloads it and
// sanitizes it on the way to disk (`src/main/triage/rows.ts sanitizeInventory`) — the third leg
// named in this module's header. Those two facts only compose if the sanitize is a NO-OP on a real
// dump, and for a while it was not: it folded every TAB to a space, so the CLI accused all 1080
// rows of report 01M081TPHPGB173YCC4YH7AMZB of not coming from the game and the local copy lost the
// columns the app's own parser reads. The committed dumps are the only honest witness to that, so
// the assertion lives here, beside the format sweep, rather than in a hand-built string.

test('the owner-side sanitize is a NO-OP on a real dump — no warning, no lost columns', async () => {
  const res = await buildInventoryAttachment(REAL_DUMP, 'Primitive_freeport-Inventory.txt')
  assert.equal(res.ok, true)
  if (!res.ok) return

  // Exactly what `downloadInventory` does with the S3 object: ungzip, then sanitize.
  const downloaded = gunzipSync(res.gz).toString('utf8')
  const clean = sanitizeInventory(downloaded)
  assert.equal(clean.cleaned, 0, 'a genuine dump has NO row that needs cleaning')
  assert.equal(clean.text, readFileSync(REAL_DUMP, 'utf8'), 'the local copy is byte-identical')
  // …so the CLI says nothing at all about it, which is what makes the warning worth reading.
  const path = '.triage/inventory/01K1P6Q8ZJ7X4M2N9V5B3C6D7E.txt'
  assert.deepEqual(inventoryNotes({ path, cleaned: clean.cleaned, fromLegacyCache: false }), [])

  // And the structure the app's dump parser needs is intact, column for column.
  const rows = dumpLines(clean.text)
  assert.equal(rows[0].split('\t')[1], 'Name')
  assert.ok(rows.every((r) => r.length === 0 || r.split('\t').length >= 2), 'a row lost its tabs')
})

test('the keyring dump survives the owner-side sanitize too, blank separator and all', () => {
  const onDisk = readFileSync(KEYRING_DUMP, 'utf8')
  const clean = sanitizeInventory(onDisk)
  assert.equal(clean.cleaned, 0)
  assert.equal(clean.text, onDisk)
  assert.ok(clean.text.split(/\r?\n/).includes(''), 'the section separator survived')
})
