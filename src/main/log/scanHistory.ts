import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { parseEvent } from './parser'
import { createSlicer, type Slicer } from './replaySlicer'
import type { LogBus } from './bus'

export interface ScanResult {
  /**
   * Byte offset (into the file) of the end of the last complete line processed.
   * The live tailer resumes here so no bytes appended during the scan are lost
   * and none are double-read. See FIX 1 in AGENTS notes.
   */
  endOffset: number
  /**
   * The next sequence number to use. The scan stamps events [startSeq, seq); the
   * tailer continues from here so the whole scan+tail stream is one monotonic
   * sequence for the character.
   */
  seq: number
  /**
   * The FROZEN EOF this scan bounded itself by — the file's size at the moment it started, before
   * a byte was read (JOS-57 scope addition).
   *
   * It is not `endOffset`, and the difference is at most one incomplete trailing line — which is
   * exactly why the cold-read delta uses THIS one. The persisted mark is the tailer's offset, and
   * the tailer's offset is the file's SIZE as of its last read; subtracting `endOffset` from it
   * would go a few bytes negative every time the log happened to end mid-line, and a "the log
   * rotated" verdict would be handed out for a partial line. Two observations of the same
   * quantity, taken the same way, subtract cleanly.
   */
  size: number
  /**
   * HOW LONG THE FIRST MEGABYTE TOOK TO ARRIVE, ms (JOS-57 scope addition) — the cold-disk hint.
   *
   * WHAT MAKES IT A DISK MEASUREMENT and not a fold measurement: the read stream's high-water mark
   * IS a megabyte, so the first chunk to satisfy this is the first read, and it is stamped BEFORE
   * that chunk is folded. Nothing this app does with the bytes is inside the number; what is
   * inside it is the time the operating system — and anything sitting between it and the disk, an
   * on-access virus scanner being the hypothesis this exists to test — took to hand them over.
   *
   * Absent when the file is smaller than a megabyte: a partial read is a different measurement
   * wearing this one's name, and there is no cold-read question to ask of a log that small.
   */
  firstMbMs?: number
  /**
   * THE FOLD STOPPED EARLY BECAUSE ITS CALLER STOPPED OWNING THE WORLD (JOS-457) — a newer
   * character switch preempted it (see `ScanOptions.cancelled`).
   *
   * PRESENT ONLY WHEN IT HAPPENED, so a completed scan is byte-identical to what it always was and
   * the two `assert.deepEqual`s in tests/replayChunking.test.mts still describe the whole result.
   *
   * When it IS present, EVERY OTHER FIELD IS A PARTIAL READING and none of them means what its own
   * doc comment says — `endOffset` most of all, because it is the end of the last line folded
   * rather than the end of the log, and handing it to a Tailer would start the live tail in the
   * middle of a file. The one honest use for an aborted result is to throw it away.
   */
  aborted?: true
}

/** The read stream's high-water mark, and the size of the "first MB" measured above. One constant
 *  so the two can never be given different numbers — the measurement's whole claim is that it
 *  lands on a chunk boundary. Exported because the boundary test has to place a character AT the
 *  real one, and a test that guessed the number would silently stop testing anything. */
export const READ_CHUNK_BYTES = 1 << 20

/** Everything about a scan that is not "which file, which bus, from which seq". */
export interface ScanOptions {
  /** Parser ruleset id (defaults to the classic EQ profile). */
  profileId?: string
  /**
   * The cooperative scheduler (docs/plans/chunked-replay.md §1). Defaults to a REPLAY_SLICE_MS
   * budget at REPLAY_DUTY — which is what production always wants, and is what session.ts passes
   * explicitly so it can read the duty the slicer measured. The other caller is the equivalence
   * test, which passes `unchunkedSlicer()` to fold the same bytes with no yielding at all and
   * compare. There is deliberately no environment variable behind this: see replaySlicer.ts.
   */
  slicer?: Slicer
  /**
   * THE ABORT (JOS-457): "does my caller still own the world?", asked at every point this fold is
   * suspended. Absent means a fold that can never be stopped, which is what every caller but
   * session.ts wants.
   *
   * A CHECK, NOT A SIGNAL, and never an `AbortSignal`: the question is not "has somebody asked me
   * to stop" but "is the answer I am building still the one anybody wants", and the ONE thing that
   * can answer that is the switch generation (main/switchController.ts). A signal would be a second
   * copy of a fact that already has an owner.
   */
  cancelled?: () => boolean
}

/**
 * THE TWO QUESTIONS A SUSPENDED FOLD ASKS, travelling together because they are asked at the same
 * instant: the scheduler that decides WHEN to pause, and the check that decides whether coming back
 * is still wanted.
 *
 * One object rather than two parameters because `consumeChunk` already sits at the repo's
 * `max-params` ceiling of four — and because the pairing is the point. A yield with no ownership
 * check after it is precisely the hole this ticket closed.
 */
export interface FoldControl {
  slicer: Slicer
  /**
   * See `ScanOptions.cancelled`. REQUIRED here, unlike on the public options, and `NEVER_CANCELLED`
   * is what a caller with nothing to say passes: the check is read inside the splitter's loop, and
   * an optional call there would put two extra branches on the one function in this file that has
   * to stay under the repo's complexity ceiling. Defaulting at the boundary is cheaper than
   * defaulting at the use.
   */
  cancelled: () => boolean
}

/** The fold nobody can stop — every caller that is not a character switch. */
export const NEVER_CANCELLED = (): boolean => false

/** The two bytes the splitter is looking for. Named because `0x0a` three lines apart in two files
 *  is how a line splitter and a tail quietly stop agreeing about what a line is. */
const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

/** The empty carry. One shared frozen-in-practice instance rather than an `alloc(0)` per line —
 *  every completed line resets the carry, which on a 142 MB log is ~1.4M resets. */
const NO_CARRY = Buffer.alloc(0)

/**
 * The byte-splitter's carry-over state, threaded across chunks by `consumeChunk`.
 *
 * Byte-accurate line splitting. We track bytes consumed (not chars) so the
 * returned offset lines up exactly with the file for the tailer handoff.
 * `endOffset` advances to just past each newline of a fully-processed line.
 */
export interface SplitState {
  endOffset: number
  /**
   * The current partial line, AS BYTES — its terminating newline is in the NEXT chunk.
   *
   * There is no separate `pendingBytes` count beside it any more (JOS-373): the carry is bytes now,
   * so its length IS the count the `endOffset` arithmetic wants, and two fields that must agree by
   * hand is exactly the shape that eventually doesn't.
   */
  leftover: Buffer
}

/**
 * Split ONE chunk into complete lines, handing each to `handle`, and carry the trailing
 * partial line into `st` for the next chunk. Extracted from scanLog's loop body so the byte
 * accounting lives in one place.
 *
 * NOTHING IS DECODED UNTIL ITS TERMINATING NEWLINE IS IN HAND (JOS-373), and the hazard that
 * bought that rule is not theoretical. This carry used to be DECODED TEXT: the trailing partial
 * line was run through `toString('utf8')` at the end of every chunk and string-concatenated onto
 * the head of the next one. A read chunk boundary falls at a fixed byte count (READ_CHUNK_BYTES)
 * and lands wherever it lands — mid-line, and just as easily mid-CHARACTER. Decoding half of a
 * multi-byte sequence yields U+FFFD, decoding the other half yields another, and the character is
 * destroyed permanently: the two halves can never be rejoined once the decoder has replaced them.
 * The byte accounting stayed correct throughout, so nothing downstream ever noticed — it is the
 * NAME on the line that is wrong, on a log with one chance per megabyte to be wrong. The live tail
 * had the same bug against its own slice boundary and fixed it first (Tailer.ts `consume`); this is
 * that shape, ported.
 *
 * SO: split on the newline BYTE, decode each line exactly once, whole. The carry is joined to the
 * next chunk's head AT LINE COMPLETION rather than by concatenating it onto the whole chunk — the
 * chunk is a megabyte and the carry is one log line, so the cheap direction is obvious: at most one
 * small `Buffer.concat` per chunk (the carry is cleared by the chunk's first newline and never
 * re-armed until its last), versus a 1 MB copy per chunk. A carry LIST would only pay off for a
 * partial line spanning several chunks, i.e. a single log line over a megabyte long, which is not a
 * shape EverQuest produces.
 *
 * CHUNKED (docs/plans/chunked-replay.md §1): the yield lives HERE, per line, not per read chunk.
 * A 1 MB chunk is ~75 ms of folding on a real log — measured, and four times the whole slice
 * budget — so a scheduler that could only pause between chunks could not honour a 12 ms budget
 * at all. The check happens AFTER the line is folded, so a single monster event overshoots the
 * budget and then yields, rather than being split (it cannot be split) or skipped.
 *
 * The byte accounting, the order and the `handle` calls are byte-for-byte what they were, which is
 * what lets the equivalence test compare the two arms byte for byte.
 *
 * EXPORTED FOR THE BOUNDARY TEST (JOS-373) — the real function, not a copy of it. The hazard is a
 * split at one exact byte INSIDE a multi-byte character, and the only way to put a boundary there
 * deterministically is to hand the splitter the two halves as separate buffers: a read stream can
 * be asked for a chunk size, never made to promise one. The end-to-end arm at the real
 * READ_CHUNK_BYTES runs beside it; neither covers the other.
 *
 * AND THIS IS WHERE A PREEMPTED FOLD STOPS (JOS-457). Both of the checks live here: one on entry
 * (the caller's read stream has just handed over a chunk) and one immediately after every
 * `slicer.yield()` returns, before the next line is folded. That makes the guarantee EXACT rather
 * than approximate. The main process is single-threaded, so a competing character switch can only
 * ever begin while this fold is SUSPENDED — and a fold has exactly two ways to be suspended, both
 * of which resume into one of these two checks. A preempted fold therefore emits ZERO further
 * events onto the bus; it is not "at most one slice's worth", and it is not a race.
 *
 * Nothing is asked PER LINE, so the fold's inner loop costs what it always did — the check rides
 * the yield it is paired with, which on a real log is once every 12 ms rather than 1.4M times.
 */
export async function consumeChunk(
  buf: Buffer,
  st: SplitState,
  handle: (raw: string) => void,
  ctl: FoldControl
): Promise<'complete' | 'cancelled'> {
  const { slicer, cancelled } = ctl
  // The caller's read stream has just resumed with this chunk — one of the two instants a competing
  // character switch could have run. Asked before a single line of it is folded.
  if (cancelled()) return 'cancelled'
  let lineStart = 0
  for (let nl = buf.indexOf(NEWLINE, lineStart); nl !== -1; nl = buf.indexOf(NEWLINE, lineStart)) {
    // Bytes for this line = the carry (from prior chunks) + [lineStart..nl] incl. the '\n'.
    st.endOffset += st.leftover.length + (nl - lineStart + 1)
    const seg = buf.subarray(lineStart, nl)
    const line = st.leftover.length > 0 ? Buffer.concat([st.leftover, seg]) : seg
    // A trailing '\r' is stripped as a BYTE, before the decoder sees it — the same test the old
    // `raw.endsWith('\r')` made, moved to the side of the decode where it cannot be confused with
    // a replacement character that happens to sit last.
    const end = line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN ? line.length - 1 : line.length
    if (end > 0) handle(line.toString('utf8', 0, end))
    st.leftover = NO_CARRY
    lineStart = nl + 1
    if (slicer.expired()) {
      await slicer.yield()
      // The other suspension point — see the header. The carry is deliberately left as it is: an
      // abandoned fold's split state is abandoned with it.
      if (cancelled()) return 'cancelled'
    }
  }
  // Carry the trailing partial line to the next chunk, still undecoded. COPIED, never a view: the
  // read stream hands us a fresh megabyte each time, and keeping a subarray of one as the carry
  // would pin that whole megabyte alive for the sake of a partial line.
  if (lineStart < buf.length) {
    const tail = buf.subarray(lineStart)
    st.leftover = st.leftover.length > 0 ? Buffer.concat([st.leftover, tail]) : Buffer.from(tail)
  }
  return 'complete'
}

/**
 * Stream the log once and emit every canonical LogEvent onto the bus with
 * live:false. This is the historical feeder: it produces the exact same event
 * stream the live tailer will continue, so every consumer (loot/kills/levels/AA
 * reducers, the combat engine) is rebuilt from one parse pass instead of three
 * hand-synced pipelines.
 *
 * Streaming (FIX 2): reads via a byte stream with a chunk-based line splitter and
 * yields to the event loop periodically, so the Electron main process is never
 * blocked for the multi-second duration of a 68MB scan. Events are emitted in
 * strict file order.
 *
 * COOPERATIVELY SCHEDULED (docs/plans/chunked-replay.md §1): "periodically" used to mean "between
 * read chunks", which measured at 75 ms of main-loop stall per chunk. It now means "every
 * REPLAY_SLICE_MS of folding", which bounds the block directly — and, since JOS-50, each of those
 * pauses is a real REST rather than a `setImmediate`, so the fold cannot hold a core flat out for
 * the length of a replay either. See replaySlicer.ts for both constants and the measurements
 * behind them.
 *
 * Bounded (FIX 1): captures the file size S up front, processes only bytes [0, S),
 * and returns `endOffset` = the byte offset of the end of the last complete line
 * at or before S. The caller hands this to the tailer as its start offset for a
 * gapless handoff.
 *
 * THE LIVE HANDOFF IS UNAFFECTED BY SLICING, and this is the property that makes chunking safe.
 * There is no buffer-then-drain anywhere in this app: the scan reads to a FROZEN EOF (the size
 * captured above, before the first byte is read) and returns the byte offset of the last complete
 * line it consumed; session.ts then starts the Tailer AT that offset. Lines the game appends while
 * the scan runs land past S, are never read here, and are read by the tailer as its first bytes.
 * So a longer wall-clock scan simply means more bytes waiting for the tailer — never a line folded
 * twice, never one skipped, whatever the slice budget is.
 *
 * PREEMPTABLE (JOS-457, `ScanOptions.cancelled`). Until this ticket a replay could not be stopped
 * once started, which is what turned six impatient dropdown picks into six concurrent whole-log
 * folds on the main process. A cancelled fold now returns at its next suspension point with
 * `aborted: true` and a partial reading its caller must discard. THE HANDOFF ABOVE IS UNTOUCHED and
 * cannot be reached from here: an aborted scan's caller never owns the world any more, so it never
 * starts a tailer — the WINNER's scan reads to its own frozen EOF and hands over its own
 * `endOffset`, exactly as a lone scan always did.
 */
export async function scanLog(
  logPath: string,
  bus: LogBus,
  startSeq = 0,
  opts: ScanOptions = {}
): Promise<ScanResult> {
  let size: number
  try {
    size = (await stat(logPath)).size
  } catch {
    return { endOffset: 0, seq: startSeq, size: 0 }
  }
  if (size === 0) return { endOffset: 0, seq: startSeq, size: 0 }

  let seq = startSeq

  const handle = (raw: string): void => {
    const ev = parseEvent(raw, seq, opts.profileId)
    if (!ev) return // not a log line at all (no timestamp)
    seq++
    bus.emit(ev, false)
  }

  // Byte-accurate line splitting (see SplitState / consumeChunk).
  const st: SplitState = { endOffset: 0, leftover: NO_CARRY }
  const ctl: FoldControl = {
    slicer: opts.slicer ?? createSlicer(),
    cancelled: opts.cancelled ?? NEVER_CANCELLED
  }
  let aborted = false

  const stream = createReadStream(logPath, {
    start: 0,
    end: size - 1,
    highWaterMark: READ_CHUNK_BYTES
  })

  // The cold-disk clock (see ScanResult.firstMbMs), started at the last statement before the first
  // byte is asked for.
  const coldRead = startColdReadClock()

  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      coldRead.saw(buf.length)
      // BOTH OF THIS FOLD'S SUSPENSION POINTS ANSWER HERE (JOS-457) — the `for await` above, which
      // has just resumed with a megabyte from disk, and every `slicer.yield()` inside the splitter.
      // Breaking out of a `for await` destroys the read stream, so an abandoned fold stops READING
      // the file as well as folding it.
      if ((await consumeChunk(buf, st, handle, ctl)) === 'cancelled') {
        aborted = true
        break
      }
    }
  } catch {
    // Partial results are still valid up to endOffset; fall through and return.
  }

  // A trailing partial line (no final newline) is intentionally NOT counted in
  // endOffset — the tailer will re-read those bytes and complete the line when
  // the game appends the rest, avoiding a dropped/duplicated final entry.
  return {
    endOffset: st.endOffset,
    seq,
    size,
    ...coldRead.result(),
    ...(aborted ? { aborted: true as const } : {})
  }
}

/**
 * THE COLD-DISK CLOCK (JOS-57's `ScanResult.firstMbMs`), as an object so `scanLog` stays under the
 * repo's complexity ceiling — the arithmetic is unchanged.
 *
 * `saw()` is called at the top of the read loop, between the read completing and anything being
 * parsed, so the fold is outside the number by construction rather than by estimate.
 *
 * A log under a megabyte reports nothing rather than a small number, which is the honest answer:
 * the question is how long the OS took to hand over a megabyte nobody had read.
 */
function startColdReadClock(): { saw: (bytes: number) => void; result: () => { firstMbMs?: number } } {
  const startedAt = performance.now()
  let bytesRead = 0
  let firstMbMs: number | undefined
  return {
    saw: (bytes) => {
      bytesRead += bytes
      if (firstMbMs === undefined && bytesRead >= READ_CHUNK_BYTES) firstMbMs = performance.now() - startedAt
    },
    result: () => (firstMbMs === undefined ? {} : { firstMbMs })
  }
}
