// ============================================================================
// replayChunkEdge.test.mts — the historical scan's READ-CHUNK BOUNDARY (JOS-373).
// ============================================================================
//
// THE HAZARD. A read chunk boundary falls at a fixed byte count (READ_CHUNK_BYTES) and lands
// wherever it lands — mid-line, and just as easily mid-CHARACTER. `consumeChunk` used to carry the
// trailing partial line as DECODED TEXT, so both halves of a straddling multi-byte sequence went
// through the decoder alone, each became U+FFFD, and the character was destroyed permanently — the
// two halves can never be rejoined once the decoder has replaced them. NOTHING DOWNSTREAM COULD
// NOTICE: the byte accounting (`endOffset`, the carry) stayed exactly right, and the only casualty
// was the NAME on the line. On the owner's 142 MB log that is ~142 chances per scan, aimed squarely
// at the lines carrying non-ASCII names.
//
// The live tail had the same bug against its own slice edge and fixed it first — see
// tests/tailerIo.test.mts, 'a multi-byte character straddling a slice edge survives'. These are that
// test's shape, aimed at the replay's boundary instead.
//
// TWO ARMS, BECAUSE NEITHER COVERS THE OTHER.
//   * The unit arm drives the real `consumeChunk` with hand-built buffers and splits the SAME bytes
//     at EVERY interior position. Putting a boundary at one exact byte inside a character is the
//     whole point, and a read stream can be ASKED for a chunk size but never made to promise one —
//     so the deterministic version of this test is the one that hands the splitter the two halves
//     itself. Sweeping every cut also makes the oracle exhaustive rather than a spot check.
//   * The end-to-end arm builds a real multi-megabyte log with characters placed at the REAL 1 MiB
//     boundaries and folds it through `scanLog`, because the seam that ships is the stream's.
//
// This lives beside replayChunking.test.mts rather than inside it: that file is the equivalence and
// live-handoff gate and is already at the repo's 400-line ceiling. It stayed GREEN throughout this
// change, which is the point — it never covered this, and a fix that its oracle cannot see is
// exactly the kind that needs a spec of its own.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogBus } from '../src/main/log/bus'
import {
  consumeChunk,
  scanLog,
  NEVER_CANCELLED,
  READ_CHUNK_BYTES,
  type SplitState
} from '../src/main/log/scanHistory'
import { createSlicer, unchunkedSlicer, type Slicer } from '../src/main/log/replaySlicer'

/** The timestamp prefix every line the parser will accept has to carry. */
const TS = '[Mon Aug 04 12:00:00 2026] '

/** One character per UTF-8 width the encoding uses beyond ASCII. The 4-byte one is a surrogate
 *  pair in JS as well, so it is cut in half by two different mechanisms at once. */
const STRADDLERS = [
  { width: 2, ch: 'é', what: 'U+00E9 — the accent in a European player name' },
  { width: 3, ch: '☃', what: 'U+2603 — the snowman the tail test uses' },
  { width: 4, ch: '𝔊', what: 'U+1D50A — outside the BMP, a surrogate pair in JS too' }
] as const

/** Run `chunks` through the real splitter and report everything it produced. */
async function driveSplit(
  chunks: readonly Buffer[],
  slicer: Slicer
): Promise<{ lines: string[]; endOffset: number; carried: number }> {
  const lines: string[] = []
  const st: SplitState = { endOffset: 0, leftover: Buffer.alloc(0) }
  // `NEVER_CANCELLED` (JOS-457): this arm is about bytes, and a fold nobody can preempt is what the
  // splitter's contract has always been.
  const ctl = { slicer, cancelled: NEVER_CANCELLED }
  for (const c of chunks) await consumeChunk(c, st, (raw) => lines.push(raw), ctl)
  return { lines, endOffset: st.endOffset, carried: st.leftover.length }
}

test('a multi-byte character survives a chunk edge AT EVERY BYTE — split anywhere, decode whole', async () => {
  for (const { width, ch, what } of STRADDLERS) {
    assert.equal(Buffer.byteLength(ch), width, `${what} is ${String(width)} bytes`)

    // Three shapes in one payload, so one sweep covers all of them: a plain line, a CRLF line (the
    // '\r' strip happens on the byte side of the decoder now), and a TRAILING PARTIAL with no
    // newline — the shape a live log always has, and the one whose bytes must be CARRIED rather
    // than counted into endOffset.
    const whole = `${TS}Kaelthorn${ch}beard hits YOU for 12 points of damage.`
    const crlf = `${TS}${ch} Snowman of Everfrost begins to cast a spell.`
    const partial = `${TS}half a line the game has not finished ${ch}`
    const payload = Buffer.from(`${whole}\n${crlf}\r\n${partial}`, 'utf8')
    const completeBytes = Buffer.byteLength(`${whole}\n${crlf}\r\n`, 'utf8')

    // The control: the same bytes with no boundary in them at all.
    const control = await driveSplit([payload], unchunkedSlicer())
    assert.deepEqual(control.lines, [whole, crlf], `${what}: the unsplit arm reads both lines`)
    assert.equal(control.endOffset, completeBytes, `${what}: endOffset stops at the last complete line`)
    assert.equal(control.carried, Buffer.byteLength(partial), `${what}: the partial line is carried, not counted`)

    // …and now the same bytes cut at every interior byte, including the ones inside `ch`. Budget 0
    // yields after every line, so the most aggressive interleaving rides along for free.
    for (let cut = 1; cut < payload.length; cut++) {
      const split = await driveSplit(
        [payload.subarray(0, cut), payload.subarray(cut)],
        createSlicer({ budgetMs: 0, duty: 1 })
      )
      assert.deepEqual(split.lines, control.lines, `${what}: cut at byte ${String(cut)} changed a line`)
      assert.equal(split.endOffset, control.endOffset, `${what}: cut at byte ${String(cut)} moved endOffset`)
      assert.equal(split.carried, control.carried, `${what}: cut at byte ${String(cut)} moved the carry`)
    }

    // And the sweep really did cut the character — assert the byte range rather than trusting it.
    const at = payload.indexOf(Buffer.from(ch, 'utf8'))
    assert.ok(at > 0, `${what}: the character is in the payload`)
    for (let cut = at + 1; cut < at + width; cut++) {
      const split = await driveSplit([payload.subarray(0, cut), payload.subarray(cut)], unchunkedSlicer())
      assert.ok(split.lines[0]?.includes(ch), `${what}: intact when cut mid-character at byte ${String(cut)}`)
      assert.ok(
        !split.lines[0]?.includes(String.fromCharCode(0xfffd)),
        `${what}: no U+FFFD when cut mid-character at byte ${String(cut)}`
      )
    }
  }
})

/**
 * A log whose Nth megabyte boundary lands one byte INTO the Nth straddler: filler lines up to the
 * last one that fits, then a padded line placed so the character's first byte is the read chunk's
 * last. Returns the lines in file order; the caller writes them and checks the bytes landed where
 * this claims.
 */
function straddlingCorpus(): string[] {
  const filler = `${TS}A fillerbeast hits YOU for 3 points of damage.`
  const fillerBytes = Buffer.byteLength(filler) + 1 // + '\n'
  const tsBytes = Buffer.byteLength(TS)
  const lines: string[] = []
  let bytes = 0
  const push = (l: string): void => {
    lines.push(l)
    bytes += Buffer.byteLength(l) + 1
  }
  STRADDLERS.forEach(({ ch }, k) => {
    const boundary = (k + 1) * READ_CHUNK_BYTES
    // Fill while a whole filler line still leaves room for the padded one to start early enough.
    while (boundary - 1 - bytes - tsBytes >= fillerBytes) push(filler)
    push(`${TS}${'x'.repeat(boundary - 1 - bytes - tsBytes)}${ch} of Everfrost hits YOU for ${String(k + 1)} points of damage.`)
  })
  push(filler) // so the file ends on a complete line — endOffset should be its whole length
  return lines
}

test('THROUGH scanLog AND A REAL FILE: characters placed at the real 1 MiB read boundaries survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-edge-'))
  // Never the real game log (AGENTS.md, house rules) — a throwaway temp file, EQ-shaped name only.
  const logPath = join(dir, 'eqlog_Boundary_bench.txt')
  try {
    const lines = straddlingCorpus()
    const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
    writeFileSync(logPath, bytes)

    // THE STRADDLE IS ASSERTED, NOT ASSUMED: at each boundary the previous byte starts a multi-byte
    // character and the boundary byte itself is a CONTINUATION byte (0b10xxxxxx) — i.e. the read
    // chunk genuinely ends inside the character.
    STRADDLERS.forEach(({ width, ch }, k) => {
      const boundary = (k + 1) * READ_CHUNK_BYTES
      assert.ok(bytes.length > boundary, 'the corpus reaches past every boundary it claims to cross')
      assert.deepEqual(
        bytes.subarray(boundary - 1, boundary - 1 + width),
        Buffer.from(ch, 'utf8'),
        `boundary ${String(k + 1)}: the character starts on the chunk's last byte`
      )
      assert.equal((bytes[boundary] ?? 0) & 0xc0, 0x80, `boundary ${String(k + 1)}: the chunk ends mid-character`)
    })

    const bus = new LogBus()
    const seen: string[] = []
    bus.subscribe((ev) => seen.push(ev.raw))
    // Budget 0 with duty 1: a yield after every event, the most interleaving the design can
    // produce, and no real rests so the suite stays runnable.
    const res = await scanLog(logPath, bus, 0, { slicer: createSlicer({ budgetMs: 0, duty: 1 }) })

    assert.deepEqual(seen, lines, 'every line arrives exactly as written, boundaries and all')
    assert.equal(res.endOffset, bytes.length, 'the file ends on a complete line, so endOffset is the whole of it')
    assert.equal(res.seq, lines.length, 'and every line parsed into exactly one event')
    for (const { ch } of STRADDLERS) {
      assert.ok(seen.some((l) => l.includes(ch)), `the ${ch} line is in the stream with its character intact`)
    }
    assert.equal(
      seen.some((l) => l.includes(String.fromCharCode(0xfffd))),
      false,
      'and not one U+FFFD anywhere in the fold'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
