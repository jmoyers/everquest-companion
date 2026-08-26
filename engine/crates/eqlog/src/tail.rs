//! ============================================================================
//! tail — FOLLOWING A FILE EVERQUEST IS STILL WRITING (JOS-459 phase 1, JOS-472).
//! ============================================================================
//!
//! `scan.rs` folds a COMPLETE file. This is the other half of ingest: the same bytes, arriving a
//! few hundred at a time from another process, read byte-exactly — never re-read, never
//! double-read. It is the Rust port of `src/main/log/Tailer.ts`, and like that file it is purely
//! byte-level: it emits complete raw LINES and parses nothing. The caller parses (parity with the
//! TS shape: `Tailer` emits `'line'`, `session.ts` parses), and every line this module emits is a
//! LIVE line — see [`LIVE`].
//!
//! Boundary verdicts 4-5 of docs/plans/data-server.md put the tail — and therefore the MARK — in
//! the engine. So the two laws below are this module's whole reason to exist.
//!
//! ## THE MARK LAW (ruling 18 law 3: state is addressed by log identity + byte offset)
//!
//! There are TWO offsets and they must never be swapped:
//!
//!   * [`read_offset`](TailCore::read_offset) — the READ cursor. How many bytes this tail has
//!     pulled off the file, INCLUDING a trailing partial line the game has not finished writing.
//!     The cold-read delta ("how many bytes has nobody read") wants this one.
//!   * [`checkpoint_offset`](TailCore::checkpoint_offset) — THE MARK. The end of the last COMPLETE
//!     line emitted, i.e. exactly `read_offset - leftover.len()`. Anything claiming "the state I
//!     hold is `fold(bytes[0, b))`" needs `b` to be this, which is the same definition
//!     `ScanResult.endOffset` uses. It is the addressable coordinate: [`FileTail::mark`] pairs it
//!     with the log's identity and that pair is the only way this module's state is named.
//!
//! They differ by at most one partial line, which is nothing to a byte-count bucket and everything
//! to a claim about what has been folded. A line with no terminating newline is NOT emitted and the
//! mark stays BEFORE it, however long the game takes to finish it.
//!
//! No wall clock appears anywhere in what this module emits. Poll timing decides WHEN bytes are
//! read and can never decide WHAT comes out: the same bytes, chunked any way at all, produce the
//! same line sequence — which is the determinism ruling 18 law 1 calls cacheability.
//!
//! ## THE LEFTOVER IS BYTES, NEVER A STRING
//!
//! The carry across reads is an undecoded `Vec<u8>` (`Tailer.ts:89`), and that is not a tidy-up.
//! Reads are sliced at a fixed byte count ([`TAIL_READ_SLICE_BYTES`]), so a boundary lands wherever
//! it lands — mid-line, and just as easily mid-CHARACTER. Decoding a fragment that ends inside a
//! multi-byte sequence yields U+FFFD and destroys the character permanently; nothing here is decoded
//! until its terminating newline is in hand. That is also what makes the mark exact arithmetic
//! instead of a re-encode. (This is the lesson the JOS-464 audit wrote down, and the reason the
//! whole read path is proven one byte at a time.)
//!
//! ## TRUNCATION / ROTATION — WHAT `Tailer.ts` ACTUALLY DOES, REPRODUCED
//!
//! Characterized by reading `Tailer.ts nextRead` (:280-289) and `readSlices` (:346), not guessed:
//!
//!   1. The ONLY trigger is `size < readOffset` — a STRICT shrink, tested once per poll. A file
//!      truncated to exactly the byte count already read is indistinguishable from an idle file and
//!      nothing happens; that is the TS behaviour and it is reproduced.
//!   2. On a shrink the tail RESTARTS AT ZERO: the read offset is set to 0, the partial-line carry
//!      is DISCARDED (a half-written line that a truncation ate never becomes a line), the handle is
//!      reopened, and the whole new file is read from byte 0. Lines that survived the truncation are
//!      therefore EMITTED AGAIN. The TS makes no attempt to detect that, and neither does this: a
//!      truncation is a new file as far as the tail is concerned, and de-duplication would be a
//!      claim about content that a byte-level tail has no business making.
//!   3. A shrink that is over before it is observed is INVISIBLE. If the file is truncated and grown
//!      back past the old read offset between two polls, no poll ever sees `size < readOffset`, and
//!      the tail keeps reading at an offset that now names different bytes. This is inherent to
//!      polling and the TS has the same hole (chokidar's `change` event carries no size history);
//!      it is stated here rather than papered over.
//!   4. A mid-read shrink — the file gets smaller between the size probe and a slice read — ends the
//!      cycle early (`bytesRead <= 0` → `break`, :346) and leaves the next poll's shrink test to
//!      decide, rather than treating a short read as an error.
//!   5. REPLACEMENT (the path unlinked and recreated) forces a reopen, because an open handle
//!      follows the file it opened and not the name. The TS learns this from chokidar's
//!      `unlink`→`add` pair; polling learns it from a `metadata` call that failed with `NotFound`,
//!      which is the same evidence one layer down. Like the TS, the reopen does NOT itself reset the
//!      offset — rule 1's shrink test decides that from the new file's actual size. THE HOLE THAT
//!      LEAVES, stated rather than fixed: a replacement that is ALREADY longer than the old cursor
//!      the first time it is seen never trips the shrink test and is read from the middle. It is
//!      unreachable in practice (a fresh EverQuest log starts at zero bytes while the cursor it is
//!      compared against is megabytes in, so the very next look catches it small), it is the TS's
//!      behaviour exactly, and it is pinned by a test that says so — inventing a fix here would give
//!      the port behaviour the golden oracle never proved.
//!
//! ## WATCHING IS POLLING, DELIBERATELY
//!
//! `Tailer.ts:158` runs chokidar with `usePolling: true` because EverQuest writes through a path
//! some watchers miss, and that has matched the product for a year. There is no `notify` dependency
//! here and adding one would be a bet against a year of evidence. The poll interval is a parameter
//! ([`FileTail::follow`]); one `metadata` call per interval is strictly LESS IO than the TS spends,
//! since the polling watcher's own stat and the size probe collapse into that one call.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::scan::memchr;

/// THE MOST BYTES ONE READ MAY ASK FOR (`Tailer.ts:35`, JOS-363).
///
/// EverQuest writes its log SYNCHRONOUSLY from the game thread, so anything that delays its append
/// is a frame it did not draw. An append that extends the file needs the file resource exclusively;
/// one uncapped read of a whole delta holds that resource shared for the length of the read, and the
/// delta after a stall or a busy raid is not small. Slicing turns one long hold into a run of short
/// ones with a yield between them.
///
/// 256 KiB is ~2500 log lines: far more than a poll interval of real play produces, and small enough
/// that a slice is a single-digit-millisecond read off a warm file. Public because the tests assert
/// on the number of slices a stated burst takes, and a test that guessed it would silently stop
/// testing anything.
pub const TAIL_READ_SLICE_BYTES: usize = 256 * 1024;

/// EVERY LINE THIS MODULE EMITS IS A LIVE LINE (`session.ts:387-401`).
///
/// `live` is a property of the SOURCE, not of a line: the scan folds history (`live = false`) and
/// the tail folds what is happening now (`live = true`). It is a constant rather than a field on an
/// emitted struct because there is no configuration in which a tailed line is not live — the module
/// that wires this into `session.attach` stamps it, and this is the name it stamps.
pub const LIVE: bool = true;

/// The default poll interval, matching `Tailer.ts`'s `pollInterval ?? 400`.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(400);

/// Positional reads — the one file operation the slice loop needs, named as a trait so the loop can
/// be proven against a source as rude as the OS (`OneByteAtATime`, the precedent in
/// `engine/crates/protocol/tests/transport.rs`).
///
/// `read_at` MAY return fewer bytes than asked for, and every caller here treats that as normal
/// rather than as an end: a short read is the commonest thing a real file hands back under a writer.
pub trait ReadAt {
    /// Read into `out` starting at `offset`. `Ok(0)` means end of file.
    fn read_at(&self, offset: u64, out: &mut [u8]) -> io::Result<usize>;
}

impl ReadAt for File {
    #[cfg(windows)]
    fn read_at(&self, offset: u64, out: &mut [u8]) -> io::Result<usize> {
        std::os::windows::fs::FileExt::seek_read(self, out, offset)
    }

    #[cfg(unix)]
    fn read_at(&self, offset: u64, out: &mut [u8]) -> io::Result<usize> {
        std::os::unix::fs::FileExt::read_at(self, out, offset)
    }
}

/// Fill `out` from `offset`, looping over short reads. Returns how many bytes were actually
/// available (`< out.len()` means the file ended, or shrank, under us).
fn read_filled<S: ReadAt + ?Sized>(src: &S, offset: u64, out: &mut [u8]) -> io::Result<usize> {
    let mut got = 0usize;
    while got < out.len() {
        match src.read_at(offset + got as u64, &mut out[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

/// Split `bytes` into complete lines, handing each to `emit`, and return the trailing PARTIAL line
/// (everything after the last newline — possibly empty).
///
/// The rules are `scan.rs`'s rules, byte for byte, because the tail's whole acceptance is that its
/// line sequence equals the scan's: split on the newline BYTE; strip ONE trailing `\r` as a byte
/// before the decoder sees it; DROP an empty line in the splitter so it never reaches the parser;
/// decode each line exactly once, whole.
fn split_lines<'a>(bytes: &'a [u8], emit: &mut impl FnMut(&str)) -> &'a [u8] {
    let mut start = 0usize;
    while let Some(off) = memchr(b'\n', &bytes[start..]) {
        let nl = start + off;
        let mut end = nl;
        if end > start && bytes[end - 1] == b'\r' {
            end -= 1;
        }
        if end > start {
            emit(&String::from_utf8_lossy(&bytes[start..end]));
        }
        start = nl + 1;
    }
    &bytes[start..]
}

/// The tail's ENTIRE STATE: a read cursor and the undecoded partial line under it. Pure — it knows
/// nothing about files, handles or clocks, which is what lets the byte laws above be proven by
/// feeding it one byte at a time.
#[derive(Debug, Default, Clone)]
pub struct TailCore {
    offset: u64,
    leftover: Vec<u8>,
}

impl TailCore {
    /// A tail whose read cursor starts at `offset` and which holds no partial line — the shape a
    /// handoff from the scan produces (`ScanResult.endOffset` is by definition a line boundary).
    pub fn at(offset: u64) -> Self {
        Self {
            offset,
            leftover: Vec::new(),
        }
    }

    /// The READ cursor: bytes pulled off the file, partial trailing line included.
    pub fn read_offset(&self) -> u64 {
        self.offset
    }

    /// THE MARK: the end of the last complete line emitted. See the module header's mark law.
    pub fn checkpoint_offset(&self) -> u64 {
        self.offset - self.leftover.len() as u64
    }

    /// How many bytes are held back as an unfinished line. `read_offset - checkpoint_offset`, named
    /// so a caller can say "the game is mid-line" without doing the subtraction itself.
    pub fn pending_bytes(&self) -> usize {
        self.leftover.len()
    }

    /// Fold `chunk` — the bytes at `read_offset` — emitting every line it completes, and advance the
    /// cursor by its length. The cursor advances BEFORE the split, exactly as `Tailer.ts:349-350`
    /// orders it, so the mark is correct at every point a caller could observe it.
    pub fn consume(&mut self, chunk: &[u8], mut emit: impl FnMut(&str)) {
        self.offset += chunk.len() as u64;
        if self.leftover.is_empty() {
            let rest = split_lines(chunk, &mut emit);
            // COPIED, never a view: `chunk` is a slice-sized read buffer, and keeping a borrow of it
            // as the carry would pin 256 KiB alive for the sake of a partial line.
            self.leftover.extend_from_slice(rest);
        } else {
            let mut buf = std::mem::take(&mut self.leftover);
            buf.extend_from_slice(chunk);
            let keep = {
                let rest = split_lines(&buf, &mut emit);
                buf.len() - rest.len()
            };
            buf.drain(..keep);
            self.leftover = buf;
        }
        // A burst that ended on a line boundary must not leave a 256 KiB allocation parked on a
        // field that is normally empty.
        if self.leftover.is_empty() && self.leftover.capacity() > TAIL_READ_SLICE_BYTES {
            self.leftover = Vec::new();
        }
    }

    /// Restart at byte 0, DISCARDING the partial line (truncation rule 2 in the module header).
    pub fn reset(&mut self) {
        self.offset = 0;
        self.leftover.clear();
    }
}

/// Where a tail begins reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailStart {
    /// At the end of the file as it stands: only what the game writes from now on.
    Eof,
    /// At byte 0 — the whole file, as lines.
    FromStart,
    /// At an explicit byte offset: THE GAPLESS HANDOFF from the scan. The scan reports the offset it
    /// stopped at and the tail picks up exactly there, so bytes appended during the scan are read
    /// rather than skipped, and none are read twice. Clamped to the current size in case the file
    /// shrank between the scan and the tail's first look.
    At(u64),
}

/// Why a handle had to be opened. Counted rather than timed — see the module header on wall clocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReopenReason {
    /// There isn't one yet.
    First,
    /// The path vanished and came back; the handle follows the file it opened, not the name.
    Replaced,
    /// The file is smaller than the read cursor (truncate/rotate in place).
    Shrunk,
    /// A read on the handle failed, so the handle is suspect and gets dropped.
    Error,
}

/// What one poll did. Counts only, no durations: poll timing must never leak into anything a caller
/// can fold, and a stats struct is exactly the place that leak would start.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PollStats {
    /// Bytes read this cycle.
    pub bytes: u64,
    /// Slices the read took. `bytes.div_ceil(TAIL_READ_SLICE_BYTES)` in the happy case.
    pub slices: u32,
    /// Set when this cycle opened a handle, and why.
    pub reopened: Option<ReopenReason>,
    /// The file shrank and the tail restarted at byte 0.
    pub restarted: bool,
    /// The path did not exist at all this cycle. Not an error: the game may not have made the file
    /// yet, and a rotation is exactly this followed by an `add`.
    pub missing: bool,
}

/// A COORDINATE, in the only vocabulary ruling 18 law 3 allows: which log, and how far into it the
/// emitted lines reach. Every future cache key over tail state is built from this pair and nothing
/// else — no wall time, no "current".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TailMark<'a> {
    /// The log's identity.
    pub log: &'a Path,
    /// The checkpoint: the end of the last complete line emitted.
    pub offset: u64,
}

/// A tail over one growing file: a persistent read handle, a poll cycle, and [`TailCore`] under it.
///
/// THE HANDLE IS HELD OPEN ON A FILE ANOTHER PROCESS IS APPENDING TO, deliberately (`Tailer.ts:95`).
/// Opening and closing around every read — up to ~2/sec in combat — is an on-access-scan trigger for
/// Defender's minifilter against a file that is routinely hundreds of MB, and a share-mode
/// negotiation against EQ's own handle, on the path of a game that writes its log from the render
/// thread. A shared read handle never blocks an append. The four things that force a reopen are
/// exactly the cases where the handle stops describing the file at the path — see [`ReopenReason`].
#[derive(Debug)]
pub struct FileTail {
    path: PathBuf,
    core: TailCore,
    fh: Option<File>,
    /// The reason the NEXT open will carry, or `None` when the handle in hand is trusted.
    pending_open: Option<ReopenReason>,
    /// A poll saw the path missing; whatever answers to the name next is a different file.
    vanished: bool,
    slice_bytes: usize,
}

impl FileTail {
    /// Point a tail at a path. Does not open the file — the first poll that finds bytes does that —
    /// but does resolve the starting offset, and like `Tailer.start` it does NOT fail when the path
    /// is not there yet: an absent file starts the cursor at the requested offset (or 0), and the
    /// first poll that finds the file applies the shrink rule to it.
    pub fn open(path: impl Into<PathBuf>, start: TailStart) -> Self {
        let path = path.into();
        let size = std::fs::metadata(&path).map(|m| m.len()).ok();
        let offset = match (start, size) {
            (TailStart::At(at), Some(size)) => at.min(size),
            (TailStart::At(at), None) => at,
            (TailStart::FromStart, _) => 0,
            (TailStart::Eof, Some(size)) => size,
            (TailStart::Eof, None) => 0,
        };
        Self {
            path,
            core: TailCore::at(offset),
            fh: None,
            pending_open: Some(ReopenReason::First),
            vanished: false,
            slice_bytes: TAIL_READ_SLICE_BYTES,
        }
    }

    /// Shrink the read slice. TESTS ONLY, and the reason it exists rather than a constant the tests
    /// override: proving the multi-slice path over a committed fixture would otherwise need a
    /// quarter-megabyte of log per assertion.
    #[doc(hidden)]
    pub fn with_slice_bytes(mut self, bytes: usize) -> Self {
        self.slice_bytes = bytes.max(1);
        self
    }

    /// The log being followed.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The READ cursor. See the module header's mark law before using this for anything.
    pub fn read_offset(&self) -> u64 {
        self.core.read_offset()
    }

    /// THE MARK: the end of the last complete line emitted.
    pub fn checkpoint_offset(&self) -> u64 {
        self.core.checkpoint_offset()
    }

    /// The mark as an addressable coordinate.
    pub fn mark(&self) -> TailMark<'_> {
        TailMark {
            log: &self.path,
            offset: self.core.checkpoint_offset(),
        }
    }

    /// ONE POLL: look at the file, read whatever is new, emit the lines it completes.
    ///
    /// Idempotent when nothing changed — an idle poll opens nothing, reads nothing and emits
    /// nothing. Errors leave the tail RUNNING (the handle is dropped so the next cycle opens a fresh
    /// one under [`ReopenReason::Error`]); the offset is untouched, so a failed read costs bytes
    /// nobody has read, never bytes nobody will read.
    pub fn poll(&mut self, mut emit: impl FnMut(&str)) -> io::Result<PollStats> {
        let mut stats = PollStats::default();

        let size = match std::fs::metadata(&self.path) {
            Ok(m) => m.len(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.vanished = true;
                stats.missing = true;
                return Ok(stats);
            }
            Err(e) => return Err(e),
        };

        if self.vanished {
            self.vanished = false;
            self.pending_open = Some(ReopenReason::Replaced);
        }
        if size < self.core.read_offset() {
            self.core.reset();
            self.pending_open = Some(ReopenReason::Shrunk);
            stats.restarted = true;
        }
        if size <= self.core.read_offset() {
            // Nothing new. Deliberately NOT opening a handle to prove it: the steady-state poll on
            // an idle log must cost one metadata call and nothing else.
            return Ok(stats);
        }

        self.ensure_handle(&mut stats)?;
        let file = self.fh.take().expect("ensure_handle left a handle");
        let result = read_slices(
            &file,
            size,
            self.slice_bytes,
            &mut self.core,
            &mut stats,
            &mut emit,
        );
        match result {
            Ok(()) => {
                self.fh = Some(file);
                Ok(stats)
            }
            Err(e) => {
                // The handle is the prime suspect for anything that failed in there — drop it and
                // let the next cycle open a fresh one under a COUNTED reason rather than hiding the
                // reopen inside a retry.
                drop(file);
                self.pending_open = Some(ReopenReason::Error);
                Err(e)
            }
        }
    }

    /// Poll forever at `interval`, until `stop` is set. Errors do not end the loop — they are handed
    /// to `on_error` and the next cycle opens a fresh handle, which is `Tailer`'s `'error'` event
    /// with the same "the tailer keeps running" contract.
    ///
    /// The sleep is broken into short naps so `stop` is honoured promptly instead of after a whole
    /// interval; nothing about the pacing reaches `emit`.
    pub fn follow(
        &mut self,
        interval: Duration,
        stop: &AtomicBool,
        mut emit: impl FnMut(&str),
        mut on_error: impl FnMut(io::Error),
    ) {
        let nap = interval.min(Duration::from_millis(25));
        while !stop.load(Ordering::Relaxed) {
            if let Err(e) = self.poll(&mut emit) {
                on_error(e);
            }
            let mut slept = Duration::ZERO;
            while slept < interval && !stop.load(Ordering::Relaxed) {
                std::thread::sleep(nap);
                slept += nap;
            }
        }
    }

    /// Open only if there is no trusted handle; record WHY under the reason that forced it.
    fn ensure_handle(&mut self, stats: &mut PollStats) -> io::Result<()> {
        if self.fh.is_some() && self.pending_open.is_none() {
            return Ok(());
        }
        let reason = self.pending_open.unwrap_or(ReopenReason::First);
        self.fh = None;
        self.fh = Some(File::open(&self.path)?);
        self.pending_open = None;
        stats.reopened = Some(reason);
        Ok(())
    }
}

/// Read `[core.read_offset(), size)` in bounded slices, folding each into `core`.
///
/// Free function over [`ReadAt`] rather than a method so the loop is provable against a source that
/// hands back one byte per call — the shape a real file under a live writer produces and a `Cursor`
/// never does.
fn read_slices<S: ReadAt + ?Sized>(
    src: &S,
    size: u64,
    slice_bytes: usize,
    core: &mut TailCore,
    stats: &mut PollStats,
    emit: &mut impl FnMut(&str),
) -> io::Result<()> {
    let mut buf = vec![0u8; slice_bytes.min((size - core.read_offset()) as usize).max(1)];
    while core.read_offset() < size {
        let want = slice_bytes.min((size - core.read_offset()) as usize);
        if buf.len() < want {
            buf.resize(want, 0);
        }
        let got = read_filled(src, core.read_offset(), &mut buf[..want])?;
        if got == 0 {
            // The file shrank under us; the NEXT poll's shrink test says what that means. A short
            // read is not an error.
            break;
        }
        stats.slices += 1;
        stats.bytes += got as u64;
        core.consume(&buf[..got], &mut *emit);
        if core.read_offset() < size {
            // The slice boundary's whole point: give the game's synchronous append a gap to take the
            // file resource in. `Tailer.ts` yields the event loop here; a dedicated below-normal
            // thread yields the scheduler.
            std::thread::yield_now();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect what a core emits for a whole input handed over in `chunk` sizes.
    fn lines_in_chunks(bytes: &[u8], chunk: usize) -> (Vec<String>, TailCore) {
        let mut core = TailCore::default();
        let mut out = Vec::new();
        for piece in bytes.chunks(chunk) {
            core.consume(piece, |l| out.push(l.to_string()));
        }
        (out, core)
    }

    #[test]
    fn a_line_is_emitted_only_when_its_newline_arrives_and_the_mark_waits_with_it() {
        let mut core = TailCore::default();
        let mut out: Vec<String> = Vec::new();
        core.consume(b"[ts] first\n[ts] unfinis", |l| out.push(l.to_string()));
        assert_eq!(out, ["[ts] first"]);
        assert_eq!(core.read_offset(), 23);
        // THE MARK LAW: the cursor is past the partial line, the mark is not.
        assert_eq!(core.checkpoint_offset(), 11);
        assert_eq!(core.pending_bytes(), 12);

        core.consume(b"hed\n", |l| out.push(l.to_string()));
        assert_eq!(out, ["[ts] first", "[ts] unfinished"]);
        assert_eq!(core.checkpoint_offset(), core.read_offset());
        assert_eq!(core.checkpoint_offset(), 27);
    }

    #[test]
    fn one_byte_at_a_time_is_the_same_line_sequence_as_one_chunk() {
        let bytes = b"[a] one\r\n[b] two\n\n[c] three\r\n".to_vec();
        let (whole, whole_core) = lines_in_chunks(&bytes, bytes.len());
        assert_eq!(whole, ["[a] one", "[b] two", "[c] three"]);
        for chunk in [1usize, 2, 3, 5, 7, 13] {
            let (got, core) = lines_in_chunks(&bytes, chunk);
            assert_eq!(got, whole, "chunk size {chunk}");
            assert_eq!(core.checkpoint_offset(), whole_core.checkpoint_offset());
        }
    }

    #[test]
    fn a_multi_byte_character_cut_in_half_by_a_chunk_boundary_survives_whole() {
        // Authored bytes, not a log claim: this proves the SPLITTER, and the committed corpus is
        // scrubbed ASCII so it cannot exercise a mid-character cut on its own.
        let bytes = "[ts] Sh\u{e0}dow \u{2014} \u{1f600} done\n"
            .as_bytes()
            .to_vec();
        for chunk in 1..bytes.len() {
            let (got, _) = lines_in_chunks(&bytes, chunk);
            assert_eq!(
                got,
                ["[ts] Sh\u{e0}dow \u{2014} \u{1f600} done"],
                "chunk size {chunk}"
            );
        }
    }

    #[test]
    fn a_chunk_ending_on_the_newline_byte_and_one_ending_mid_crlf() {
        // Ends exactly ON the newline: the line is complete and the mark reaches the cursor.
        let mut core = TailCore::default();
        let mut out = Vec::new();
        core.consume(b"[a] one\r\n", |l| out.push(l.to_string()));
        assert_eq!(out, ["[a] one"]);
        assert_eq!(core.checkpoint_offset(), 9);

        // Ends BETWEEN the CR and the LF: nothing is emitted, and the CR is still a byte rather than
        // a decoded character, so the next chunk's LF can still strip it.
        let mut core = TailCore::default();
        let mut out = Vec::new();
        core.consume(b"[a] one\r", |l| out.push(l.to_string()));
        assert!(out.is_empty());
        assert_eq!(core.checkpoint_offset(), 0);
        core.consume(b"\n[b] two\r\n", |l| out.push(l.to_string()));
        assert_eq!(out, ["[a] one", "[b] two"]);
        assert_eq!(core.checkpoint_offset(), 18);
    }

    #[test]
    fn an_empty_line_is_dropped_by_the_splitter_and_a_lone_cr_line_with_it() {
        let (got, core) = lines_in_chunks(b"\n\r\n[a] one\n\n", 3);
        assert_eq!(got, ["[a] one"]);
        // Dropped lines still MOVE THE MARK — they were read, they are just not lines.
        assert_eq!(core.checkpoint_offset(), 12);
    }

    #[test]
    fn a_reset_discards_the_partial_line_the_truncation_ate() {
        let mut core = TailCore::at(500);
        core.consume(b"[a] half-writ", |_| unreachable!());
        assert_eq!(core.checkpoint_offset(), 500);
        core.reset();
        assert_eq!(core.read_offset(), 0);
        assert_eq!(core.checkpoint_offset(), 0);
        let mut out = Vec::new();
        core.consume(b"ten\n", |l| out.push(l.to_string()));
        assert_eq!(out, ["ten"], "the orphaned prefix must not be re-attached");
    }

    /// A source as rude as the OS: one byte per `read_at`, whatever was asked for.
    struct OneByteAtATime(Vec<u8>);

    impl ReadAt for OneByteAtATime {
        fn read_at(&self, offset: u64, out: &mut [u8]) -> io::Result<usize> {
            let at = offset as usize;
            if out.is_empty() || at >= self.0.len() {
                return Ok(0);
            }
            out[0] = self.0[at];
            Ok(1)
        }
    }

    #[test]
    fn the_slice_loop_survives_a_source_that_hands_back_one_byte_per_read() {
        let bytes = b"[a] one\r\n[b] two\r\n[c] partial".to_vec();
        let src = OneByteAtATime(bytes.clone());
        let mut core = TailCore::default();
        let mut stats = PollStats::default();
        let mut out = Vec::new();
        read_slices(
            &src,
            bytes.len() as u64,
            8,
            &mut core,
            &mut stats,
            &mut |l: &str| out.push(l.to_string()),
        )
        .expect("a short read is not an error");
        assert_eq!(out, ["[a] one", "[b] two"]);
        assert_eq!(core.read_offset(), bytes.len() as u64);
        assert_eq!(core.checkpoint_offset(), 18);
        assert_eq!(stats.bytes, bytes.len() as u64);
        assert_eq!(stats.slices, 4, "29 bytes in 8-byte slices");
    }

    #[test]
    fn a_source_that_ends_early_ends_the_cycle_rather_than_erroring() {
        // `size` claims more than the source holds — the mid-read shrink of truncation rule 4.
        let src = OneByteAtATime(b"[a] one\n".to_vec());
        let mut core = TailCore::default();
        let mut stats = PollStats::default();
        let mut out = Vec::new();
        read_slices(&src, 4096, 8, &mut core, &mut stats, &mut |l: &str| {
            out.push(l.to_string())
        })
        .expect("a shrink under us is not an error");
        assert_eq!(out, ["[a] one"]);
        assert_eq!(core.read_offset(), 8);
    }
}
