//! ============================================================================
//! THE TAIL ORACLE (JOS-472) — a live tail is a scan that arrived awkwardly.
//! ============================================================================
//!
//! The scan of a complete file is PROVEN byte-identical to the TS pipeline (JOS-469, the `parity`
//! binary over six slices of the owner's real log). So the acceptance for the live tail does not
//! need a second golden corpus — it needs one claim:
//!
//!   **the lines a tail emits while a file is being written equal the lines the scan finds in the
//!   finished file, whatever the writes looked like.**
//!
//! Transitively, that makes the tail golden-equivalent too. Everything below exists to make that
//! claim hard to satisfy by luck:
//!
//!   * the WRITER chops each fixture at adversarial boundaries — byte-scale dribble, ordinary
//!     appends, bursts bigger than one read slice — and the plan is FORCED to include a chunk that
//!     ends exactly on the newline byte and a chunk that ends between a `\r` and its `\n`;
//!   * the READER polls at random moments: sometimes after every chunk, sometimes not at all for
//!     several (a burst piles up), sometimes twice (a quiet period, whose second poll must do
//!     nothing at all) — and reads through a slice size small enough that slice boundaries land
//!     mid-line and mid-character too, not just write boundaries;
//!   * EVERY POLL re-asserts the MARK LAW against arithmetic done independently of the tail: the
//!     read cursor is the file's size, and the checkpoint is the offset just past the last newline
//!     written so far — so a partial line is never emitted and never counted;
//!   * the comparison is the serialized EVENT STREAM, byte for byte, against `scan_bytes` over the
//!     final file. Not a line count, not a hash of a summary.
//!
//! LINE ENDINGS ARE NORMALIZED PER RUN, both ways, on purpose. Whether `tests/fixtures/*.log` is
//! CRLF or LF on disk is a property of the CHECKOUT (JOS-458 measured CI and dev disagreeing), and
//! an oracle whose CR coverage depends on git's autocrlf setting is an oracle that quietly stops
//! testing CR handling on somebody's machine. Each fixture is run as LF, as CRLF, and as checked
//! out — same lines, different byte arithmetic, which is exactly the pair the mark law must survive.
//!
//! DETERMINISTIC SEEDS, NO CLOCK. Every chunking is a pure function of a constant seed printed in
//! every failure message, so a failing pattern is reproducible from the output alone. Nothing here
//! reads the wall clock except `the_follow_loop_…`, which asserts on lines rather than on timing.
//!
//! The corpus is committed, so this suite runs in CI. The full-size soak over a real multi-megabyte
//! slice of the owner's log is a LOCAL acceptance step and deliberately not committed (a reporter's
//! slice never becomes a fixture, and neither does the owner's).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;

use eqlog::event::Ev;
use eqlog::parse::Parser;
use eqlog::scan::scan_bytes;
use eqlog::tail::{FileTail, ReopenReason, TailStart, TAIL_READ_SLICE_BYTES};
use eqlog::timestamp::Clock;

// ---------------------------------------------------------------------------------------------
// The corpus and the parser
// ---------------------------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is three levels below the repo root")
        .to_path_buf()
}

/// The fixtures the EVENT-STREAM oracle runs over. A named list rather than a glob: these were
/// chosen for shape diversity (a dense pull, a `/who`-anchored window, a loadout swap big enough to
/// need several read slices, a proc/resist window), and naming them means adding a fixture never
/// silently changes what this proves.
const ORACLE_FIXTURES: [&str; 4] = [
    "e2e-combat.log",
    "cw1-who-anchored.log",
    "cw2-loadout-swap-aug2.log",
    "w42-effect-proc-resist.log",
];

/// One run per (seed, line-ending, slice size) row. Spelled out rather than generated so a failure
/// names a row that can be re-run on its own.
const RUNS: [Run; 3] = [
    Run {
        seed: 0x5EED_0001,
        endings: Endings::AsCheckedOut,
        slice_bytes: TAIL_READ_SLICE_BYTES,
    },
    Run {
        seed: 0x0BAD_C0DE,
        endings: Endings::Crlf,
        slice_bytes: 4096,
    },
    Run {
        seed: 0x1234_5678,
        endings: Endings::Lf,
        // A prime, so a slice boundary lands at an offset with no relationship to a line length.
        slice_bytes: 997,
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Endings {
    AsCheckedOut,
    Lf,
    Crlf,
}

#[derive(Clone, Copy, Debug)]
struct Run {
    seed: u64,
    endings: Endings,
    slice_bytes: usize,
}

/// Strip the `\r` of a CRLF pair — and ONLY that one. Real logs carry bare carriage returns inside
/// chat lines (see `jsstr::JS_DOT`'s sky-era divergence), and rewriting those would change what the
/// parser sees.
fn to_lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(b);
    }
    out
}

fn to_crlf(bytes: &[u8]) -> Vec<u8> {
    let lf = to_lf(bytes);
    let mut out = Vec::with_capacity(lf.len() + lf.len() / 40);
    for &b in &lf {
        if b == b'\n' {
            out.push(b'\r');
        }
        out.push(b);
    }
    out
}

fn fixture(name: &str, endings: Endings) -> Vec<u8> {
    let p = repo_root().join("tests").join("fixtures").join(name);
    let raw = std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    match endings {
        Endings::AsCheckedOut => raw,
        Endings::Lf => to_lf(&raw),
        Endings::Crlf => to_crlf(&raw),
    }
}

/// Every committed `*.log` fixture, sorted, for the wide (line-level) sweep.
fn all_fixtures() -> Vec<String> {
    let dir = repo_root().join("tests").join("fixtures");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".log"))
        .collect();
    names.sort();
    assert!(names.len() > 20, "the fixture corpus went missing");
    names
}

/// The bare parser — no spell DB. The tail/scan equivalence is a claim about LINES, and the spell DB
/// only decorates a `buffApply`'s candidate list; loading it would slow every row down for a
/// dimension this oracle does not test. The local soak uses the full `parser_for`.
fn parser() -> Parser {
    Parser::new(
        Clock::new(chrono_tz::America::Los_Angeles),
        None,
        Some("Primitive".to_string()),
    )
}

// ---------------------------------------------------------------------------------------------
// The two sides of the comparison
// ---------------------------------------------------------------------------------------------

/// The PROVEN side: `scan_bytes` over the finished file, serialized as NDJSON.
fn scan_stream(p: &Parser, bytes: &[u8]) -> String {
    let mut out = String::new();
    scan_bytes(p, bytes, |json, _payload| {
        out.push_str(json);
        out.push('\n');
    });
    out
}

/// The TAIL side: the same parse, driven line by line off whatever the tail emitted.
///
/// The seq discipline is `scan.rs` rule 4 restated — `seq` starts at 0, counts EVENTS rather than
/// lines, and a line that parses to nothing does not advance it. Restating it is what makes the
/// comparison meaningful: if the tail's lines equal the scan's lines, the same discipline over them
/// must reproduce the scan's bytes exactly.
fn fold_stream(p: &Parser, lines: &[String]) -> String {
    let mut out = String::new();
    let mut ev = Ev::new();
    let mut seq: i64 = 0;
    for line in lines {
        if p.parse_event(line, seq, &mut ev) {
            seq += 1;
            out.push_str(ev.finish());
            out.push('\n');
        }
    }
    out
}

/// `scan.rs`'s splitter, restated as a LINE list so a divergence can be reported as a line rather
/// than as a megabyte of JSON. Restatements rot, so it is proven against the thing it restates in
/// `the_reference_splitter_is_the_scans_splitter`.
fn reference_lines(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0usize;
    while let Some(off) = bytes[start..].iter().position(|&b| b == b'\n') {
        let nl = start + off;
        let mut end = nl;
        if end > start && bytes[end - 1] == b'\r' {
            end -= 1;
        }
        if end > start {
            out.push(String::from_utf8_lossy(&bytes[start..end]).into_owned());
        }
        start = nl + 1;
    }
    out
}

/// The offset just past the last newline in `bytes` — the checkpoint the mark law demands after
/// every one of the writer's chunks, computed without asking the tail anything.
fn last_newline_end(bytes: &[u8]) -> u64 {
    match bytes.iter().rposition(|&b| b == b'\n') {
        Some(i) => i as u64 + 1,
        None => 0,
    }
}

// ---------------------------------------------------------------------------------------------
// Determinism: the seeded chunker
// ---------------------------------------------------------------------------------------------

/// xorshift64*, spelled out. A named PRNG rather than a dependency, and never seeded from a clock: a
/// chunk pattern that breaks the tail must be reproducible from the seed printed in the failure.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

/// Cumulative END offsets of the chunks the writer will append, in order, finishing at `len`.
///
/// The forced cuts are what stops this from being a random walk that happens to miss the two
/// boundaries that matter: a boundary AT a newline's index makes the preceding chunk end on the byte
/// before it (the `\r` of a CRLF pair — the mid-CRLF cut), and a boundary one past it makes the
/// chunk end exactly ON the newline byte.
fn chunk_plan(bytes: &[u8], rng: &mut Rng) -> Vec<usize> {
    let n = bytes.len();
    let mut plan = Vec::new();
    let mut at = 0usize;
    while at < n {
        let step = match rng.below(10) {
            0..=2 => 1 + rng.below(8),
            3..=6 => 1 + rng.below(400),
            7..=8 => 1 + rng.below(20_000),
            _ => 1 + rng.below(200_000),
        };
        at = (at + step).min(n);
        plan.push(at);
    }
    let newlines: Vec<usize> = bytes
        .iter()
        .enumerate()
        .filter(|(_, &c)| c == b'\n')
        .map(|(i, _)| i)
        .collect();
    for _ in 0..16 {
        if newlines.is_empty() {
            break;
        }
        let nl = newlines[rng.below(newlines.len())];
        plan.push(nl);
        plan.push(nl + 1);
    }
    plan.push(n);
    plan.sort_unstable();
    plan.dedup();
    plan.retain(|&x| x > 0 && x <= n);
    plan
}

// ---------------------------------------------------------------------------------------------
// The temp file the writer and the tail share
// ---------------------------------------------------------------------------------------------

/// A directory under the OS temp root, removed on drop. No `tempfile` dependency for four lines of
/// `create_dir_all`; the name carries the pid and a counter so parallel test threads cannot collide.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "eqlog-tail-{}-{}-{}",
            std::process::id(),
            n,
            tag.replace(['.', '/', '\\'], "_")
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Self(dir)
    }
    fn log(&self) -> PathBuf {
        self.0.join("eqlog_Primitive_freeport.txt")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The game's half: append bytes and make them visible to another reader immediately, the way
/// EverQuest's synchronous write from the render thread is.
fn append(path: &Path, bytes: &[u8]) {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open for append");
    f.write_all(bytes).expect("append");
    f.flush().expect("flush");
}

// ---------------------------------------------------------------------------------------------
// THE ORACLE
// ---------------------------------------------------------------------------------------------

/// What a run actually exercised, so the suite can prove it tested what it claims to test.
#[derive(Default, Debug)]
struct Coverage {
    ended_on_newline: u32,
    ended_mid_crlf: u32,
    multi_slice_polls: u32,
    idle_polls: u32,
    burst_chunks: u32,
}

impl Coverage {
    fn add(&mut self, o: &Coverage) {
        self.ended_on_newline += o.ended_on_newline;
        self.ended_mid_crlf += o.ended_mid_crlf;
        self.multi_slice_polls += o.multi_slice_polls;
        self.idle_polls += o.idle_polls;
        self.burst_chunks += o.burst_chunks;
    }
}

/// Drive one byte image through one seeded chunking. Returns the tail's lines and what it covered.
fn run_one(name: &str, bytes: &[u8], run: Run) -> (Vec<String>, Coverage) {
    let seed = run.seed;
    let scratch = Scratch::new(name);
    let path = scratch.log();
    let mut rng = Rng::new(seed);
    let plan = chunk_plan(bytes, &mut rng);

    // The tail is pointed at a file that does not exist yet — the launch order the product has, and
    // a shape the poll cycle must survive without erroring.
    let mut tail = FileTail::open(&path, TailStart::FromStart).with_slice_bytes(run.slice_bytes);
    let mut writer = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .expect("the game's handle");

    let mut lines: Vec<String> = Vec::new();
    let mut cov = Coverage::default();
    let mut prev = 0usize;

    for &end in &plan {
        let chunk = &bytes[prev..end];
        match chunk.last() {
            Some(b'\n') => cov.ended_on_newline += 1,
            Some(b'\r') if bytes.get(end) == Some(&b'\n') => cov.ended_mid_crlf += 1,
            _ => {}
        }
        writer.write_all(chunk).expect("append");
        writer.flush().expect("flush");
        prev = end;

        // Bursts and pauses. `0` piles the next chunk on top without a poll; `1` is a quiet period
        // whose SECOND poll must be a complete no-op.
        let polls = match rng.below(8) {
            0 => 0,
            1 => 2,
            _ => 1,
        };
        if polls == 0 {
            cov.burst_chunks += 1;
        }
        for i in 0..polls {
            let stats = tail
                .poll(|l| lines.push(l.to_string()))
                .unwrap_or_else(|e| panic!("{name} seed {seed:#x}: poll failed: {e}"));
            if stats.slices > 1 {
                cov.multi_slice_polls += 1;
            }
            if i > 0 {
                cov.idle_polls += 1;
                assert_eq!(
                    stats.bytes, 0,
                    "{name} seed {seed:#x}: idle poll read bytes"
                );
                assert_eq!(
                    stats.reopened, None,
                    "{name} seed {seed:#x}: idle poll opened a handle"
                );
            }
            // THE MARK LAW, re-derived from the bytes written so far rather than from the tail.
            assert_eq!(
                tail.read_offset(),
                prev as u64,
                "{name} seed {seed:#x}: the read cursor is not the file size"
            );
            assert_eq!(
                tail.checkpoint_offset(),
                last_newline_end(&bytes[..prev]),
                "{name} seed {seed:#x}: the mark is not the end of the last complete line"
            );
            assert_eq!(tail.mark().offset, tail.checkpoint_offset());
            assert_eq!(tail.mark().log, path.as_path());
        }
    }

    // Drain whatever the last burst left unread.
    tail.poll(|l| lines.push(l.to_string()))
        .expect("final poll");
    assert_eq!(tail.read_offset(), bytes.len() as u64);
    assert_eq!(tail.checkpoint_offset(), last_newline_end(bytes));
    (lines, cov)
}

#[test]
fn the_reference_splitter_is_the_scans_splitter() {
    let p = parser();
    for name in ORACLE_FIXTURES {
        for endings in [Endings::AsCheckedOut, Endings::Lf, Endings::Crlf] {
            let bytes = fixture(name, endings);
            assert_eq!(
                fold_stream(&p, &reference_lines(&bytes)),
                scan_stream(&p, &bytes),
                "{name} {endings:?}: the reference splitter and scan_bytes disagree"
            );
        }
    }
}

#[test]
fn the_tail_and_the_scan_agree_over_adversarial_chunkings() {
    let p = parser();
    let mut total = Coverage::default();
    for name in ORACLE_FIXTURES {
        for run in RUNS {
            let bytes = fixture(name, run.endings);
            let want_lines = reference_lines(&bytes);
            let (lines, cov) = run_one(name, &bytes, run);

            // Report the first divergence as a LINE — a diff of two multi-megabyte JSON strings is
            // not a diagnostic.
            if lines != want_lines {
                let at = lines
                    .iter()
                    .zip(&want_lines)
                    .position(|(a, b)| a != b)
                    .unwrap_or(lines.len().min(want_lines.len()));
                panic!(
                    "{name} {run:?}: tail line {at} diverges from the scan\n  tail: {:?}\n  scan: {:?}\n  ({} tailed vs {} scanned)",
                    lines.get(at),
                    want_lines.get(at),
                    lines.len(),
                    want_lines.len()
                );
            }
            // THE ACCEPTANCE: the serialized event streams are equal byte for byte.
            let tailed = fold_stream(&p, &lines);
            let scanned = scan_stream(&p, &bytes);
            assert_eq!(
                tailed.len(),
                scanned.len(),
                "{name} {run:?}: event stream byte length"
            );
            assert!(tailed == scanned, "{name} {run:?}: event stream bytes");
            total.add(&cov);
        }
    }
    // A suite that stopped exercising its adversarial cases would still be green without this.
    assert!(
        total.ended_on_newline > 0,
        "no chunk ended on the newline byte: {total:?}"
    );
    assert!(
        total.ended_mid_crlf > 0,
        "no chunk ended between a CR and its LF: {total:?}"
    );
    assert!(
        total.multi_slice_polls > 0,
        "no poll ever took more than one slice: {total:?}"
    );
    assert!(
        total.idle_polls > 0,
        "no quiet period was polled: {total:?}"
    );
    assert!(total.burst_chunks > 0, "no burst piled up: {total:?}");
}

#[test]
fn every_committed_fixture_survives_one_adversarial_chunking() {
    // Wide rather than deep: one row over the whole corpus, compared at the LINE level (the level
    // the tail is responsible for). Adding a fixture extends this automatically.
    let run = RUNS[2];
    for name in all_fixtures() {
        let bytes = fixture(&name, run.endings);
        let (lines, _) = run_one(&name, &bytes, run);
        assert_eq!(
            lines,
            reference_lines(&bytes),
            "{name} {run:?}: tail lines diverge from the scan's"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// The named cases the ticket calls out, each on its own so a failure names itself
// ---------------------------------------------------------------------------------------------

#[test]
fn a_final_line_with_no_terminator_waits_and_the_mark_waits_with_it() {
    let scratch = Scratch::new("unterminated");
    let path = scratch.log();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let mut lines = Vec::new();

    append(
        &path,
        b"[Wed Aug 19 16:21:47 2026] You have entered Freeport.\n",
    );
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines.len(), 1);
    let after_first = tail.checkpoint_offset();
    assert_eq!(after_first, tail.read_offset());

    // The game is mid-line. Poll as often as you like: no line, and the mark does not move.
    append(&path, b"[Wed Aug 19 16:21:48 2026] Atesc hit a thunder");
    for _ in 0..5 {
        tail.poll(|l| lines.push(l.to_string())).unwrap();
        assert_eq!(lines.len(), 1, "a partial line was emitted");
        assert_eq!(tail.checkpoint_offset(), after_first, "the mark moved");
        assert!(tail.read_offset() > after_first, "the cursor did not move");
    }

    append(&path, b" spirit princess for 231 points of damage.\n");
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines.len(), 2);
    assert!(lines[1].ends_with("231 points of damage."));
    assert_eq!(tail.checkpoint_offset(), tail.read_offset());
}

#[test]
fn an_append_after_a_quiet_period_is_read_and_the_idle_polls_cost_nothing() {
    let scratch = Scratch::new("quiet");
    let path = scratch.log();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let mut lines = Vec::new();

    append(
        &path,
        b"[Wed Aug 19 16:21:47 2026] You have entered Freeport.\n",
    );
    let first = tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(first.reopened, Some(ReopenReason::First));
    assert_eq!(first.slices, 1);

    for _ in 0..20 {
        let idle = tail
            .poll(|_| panic!("an idle poll emitted a line"))
            .unwrap();
        assert_eq!(idle.bytes, 0);
        assert_eq!(idle.slices, 0);
        assert_eq!(idle.reopened, None, "an idle poll must not open anything");
        assert!(!idle.missing);
    }

    append(
        &path,
        b"[Wed Aug 19 16:31:00 2026] You have entered the Plane of Sky.\n",
    );
    let woke = tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(woke.reopened, None, "the handle is still the right one");
    assert_eq!(lines.len(), 2);
    assert!(lines[1].ends_with("Plane of Sky."));
}

#[test]
fn a_tail_over_a_file_that_does_not_exist_yet_waits_for_it_without_erroring() {
    let scratch = Scratch::new("absent");
    let path = scratch.log();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let stats = tail.poll(|_| panic!("no file, no lines")).unwrap();
    assert!(stats.missing);
    assert_eq!(tail.checkpoint_offset(), 0);

    append(
        &path,
        b"[Wed Aug 19 16:21:47 2026] Welcome to EverQuest Legends!\n",
    );
    let mut lines = Vec::new();
    let stats = tail.poll(|l| lines.push(l.to_string())).unwrap();
    // The path came back, so the handle is opened under `Replaced` — the poll's version of
    // chokidar's unlink→add, and the reopen does not itself move the offset.
    assert_eq!(stats.reopened, Some(ReopenReason::Replaced));
    assert_eq!(lines.len(), 1);
}

#[test]
fn the_handoff_from_a_scan_reads_the_bytes_that_arrived_during_it() {
    let scratch = Scratch::new("handoff");
    let path = scratch.log();
    let history = b"[Wed Aug 19 16:00:00 2026] old one.\n[Wed Aug 19 16:00:01 2026] old two.\n";
    append(&path, history);
    // The scan's endOffset is a line boundary by construction; the game appended more while it ran.
    append(&path, b"[Wed Aug 19 16:00:02 2026] new three.\n");

    let mut tail = FileTail::open(&path, TailStart::At(history.len() as u64));
    let mut lines = Vec::new();
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines.len(), 1, "history must not be re-read");
    assert!(lines[0].ends_with("new three."));

    // …and an offset past the end of a file that shrank in between is CLAMPED, never trusted.
    let size = std::fs::metadata(&path).unwrap().len();
    let mut late = FileTail::open(&path, TailStart::At(1_000_000));
    assert_eq!(late.read_offset(), size);
    assert_eq!(late.poll(|_| {}).unwrap().bytes, 0);
}

#[test]
fn eof_start_reads_only_what_the_game_writes_next() {
    let scratch = Scratch::new("eof");
    let path = scratch.log();
    append(&path, b"[Wed Aug 19 16:00:00 2026] before the tail.\n");
    let mut tail = FileTail::open(&path, TailStart::Eof);
    let mut lines = Vec::new();
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert!(lines.is_empty());
    append(&path, b"[Wed Aug 19 16:00:01 2026] after the tail.\n");
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].ends_with("after the tail."));
}

/// TRUNCATION, characterized in `tail.rs`'s header and reproduced here rule by rule.
#[test]
fn a_truncated_file_restarts_at_zero_and_the_half_written_line_is_dropped() {
    let scratch = Scratch::new("truncate");
    let path = scratch.log();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let mut lines = Vec::new();

    let two_lines = b"[Wed Aug 19 16:00:00 2026] one.\n[Wed Aug 19 16:00:01 2026] two.\n";
    append(&path, two_lines);
    append(&path, b"[Wed Aug 19 16:00:02 2026] half-writ");
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(tail.checkpoint_offset(), two_lines.len() as u64);
    assert!(tail.read_offset() > two_lines.len() as u64);

    // Rules 1 and 2: a strict shrink restarts at zero, the carry is discarded, the handle reopens.
    let new_bytes: &[u8] = b"[Wed Aug 19 17:00:00 2026] after the rotation.\n";
    File::create(&path).expect("truncate in place");
    append(&path, new_bytes);
    let stats = tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert!(stats.restarted);
    assert_eq!(stats.reopened, Some(ReopenReason::Shrunk));
    assert_eq!(lines.len(), 3);
    assert!(
        lines[2].ends_with("after the rotation."),
        "the orphaned prefix must not be glued onto the new file's first line"
    );
    assert_eq!(tail.read_offset(), new_bytes.len() as u64);
    assert_eq!(tail.checkpoint_offset(), new_bytes.len() as u64);
}

#[test]
fn a_truncation_re_emits_the_lines_that_survived_it_and_says_so() {
    // The honest half of the characterization: the TS makes no attempt to notice that the first N
    // bytes of the new file are bytes it already read, so neither does this. A truncation is a NEW
    // FILE to a byte-level tail; de-duplicating would be a claim about content.
    let scratch = Scratch::new("re-emit");
    let path = scratch.log();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let mut lines = Vec::new();
    append(&path, b"[Wed Aug 19 16:00:00 2026] one.\n");
    append(&path, b"[Wed Aug 19 16:00:01 2026] two.\n");
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines.len(), 2);

    File::create(&path).expect("truncate in place");
    append(&path, b"[Wed Aug 19 16:00:00 2026] one.\n");
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(
        lines.len(),
        3,
        "the surviving line is emitted a second time"
    );
    assert!(lines[2].ends_with("one."));
}

#[test]
fn a_shrink_to_exactly_the_read_offset_is_indistinguishable_from_an_idle_file() {
    // Rule 1's strictness, pinned so nobody "fixes" it into a `<=` and turns every idle poll on a
    // fully-read file into a full re-read.
    let scratch = Scratch::new("exact");
    let path = scratch.log();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let mut lines = Vec::new();
    append(&path, b"[Wed Aug 19 16:00:00 2026] one.\n");
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(tail.read_offset(), 32);

    File::create(&path).expect("truncate in place");
    append(&path, b"[Wed Aug 19 16:00:09 2026] two.\n");
    let stats = tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert!(!stats.restarted);
    assert_eq!(
        lines.len(),
        1,
        "the replacement is the same size: invisible"
    );
}

#[test]
fn a_rotated_log_is_read_from_the_new_files_first_byte() {
    let scratch = Scratch::new("rotated");
    let path = scratch.log();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let mut lines = Vec::new();
    for i in 0..4 {
        append(
            &path,
            format!("[Wed Aug 19 16:00:0{i} 2026] before the rotation {i}.\n").as_bytes(),
        );
    }
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines.len(), 4);

    // The user renamed or deleted the log and EverQuest made a new one. The poll that finds nothing
    // at the path is this port's version of chokidar's `unlink`.
    std::fs::remove_file(&path).unwrap();
    assert!(tail.poll(|_| {}).unwrap().missing);

    append(&path, b"[Wed Aug 19 17:00:00 2026] the new log.\n");
    let stats = tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert!(stats.restarted);
    assert_eq!(stats.reopened, Some(ReopenReason::Shrunk));
    assert_eq!(lines.len(), 5);
    assert!(lines[4].ends_with("the new log."));
    assert_eq!(tail.checkpoint_offset(), tail.read_offset());
}

#[test]
fn a_replacement_that_already_outgrew_the_cursor_resumes_mid_file_exactly_as_the_ts_does() {
    // TRUNCATION RULE 3, pinned as the HOLE it is rather than papered over. `Tailer.ts` reopens on
    // `unlink`→`add` but deliberately leaves the offset to the shrink test, so a replacement that is
    // ALREADY longer than the old cursor when it is first seen gets read from the middle. It is
    // unreachable in practice — a fresh EverQuest log starts at zero bytes and the cursor it is
    // being compared against is megabytes in, so a poll (or chokidar's `add`) always catches it
    // small — and reproducing it is the point: the port must not quietly acquire behaviour the
    // oracle never proved.
    let scratch = Scratch::new("outgrown");
    let path = scratch.log();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let mut lines = Vec::new();
    append(&path, b"[Wed Aug 19 16:00:00 2026] one.\n");
    tail.poll(|l| lines.push(l.to_string())).unwrap();
    let cursor = tail.read_offset();

    std::fs::remove_file(&path).unwrap();
    assert!(tail.poll(|_| {}).unwrap().missing);

    let replacement: &[u8] = b"[Wed Aug 19 17:00:00 2026] a brand new, longer, first line.\n";
    assert!(
        replacement.len() as u64 > cursor,
        "the artificial precondition"
    );
    append(&path, replacement);
    let stats = tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert!(!stats.restarted, "no shrink was ever observable");
    assert_eq!(stats.reopened, Some(ReopenReason::Replaced));
    assert_eq!(lines.len(), 2);
    assert_eq!(
        lines[1],
        String::from_utf8_lossy(&replacement[cursor as usize..replacement.len() - 1]),
        "the resumed read starts at the old cursor, mid-line"
    );
}

#[test]
fn a_read_slice_is_bounded_and_a_burst_takes_the_slices_it_should() {
    let scratch = Scratch::new("slices");
    let path = scratch.log();
    // A tiny slice size so the multi-slice path is provable without a quarter-megabyte of log.
    let mut tail = FileTail::open(&path, TailStart::FromStart).with_slice_bytes(64);
    let mut lines = Vec::new();
    let mut written = 0usize;
    for i in 0..20 {
        let line = format!("[Wed Aug 19 16:00:{i:02} 2026] line {i}.\n");
        append(&path, line.as_bytes());
        written += line.len();
    }
    let stats = tail.poll(|l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines.len(), 20);
    assert_eq!(stats.bytes, written as u64);
    assert_eq!(stats.slices as usize, written.div_ceil(64));
}

/// The POLLING loop itself, on a thread, against a writer that pauses — the only test here that
/// involves real time, and it asserts on lines rather than on timing.
#[test]
fn the_follow_loop_picks_up_appends_until_it_is_stopped() {
    use std::time::Duration;

    let scratch = Scratch::new("follow");
    let path = scratch.log();
    append(&path, b"[Wed Aug 19 16:00:00 2026] before.\n");

    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<String>();
    let mut tail = FileTail::open(&path, TailStart::FromStart);
    let worker = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            tail.follow(
                Duration::from_millis(10),
                &stop,
                |l| {
                    let _ = tx.send(l.to_string());
                },
                |e| panic!("follow reported {e}"),
            );
            tail
        })
    };

    let mut got = vec![rx.recv().expect("the pre-existing line")];
    for i in 0..3 {
        // A quiet period, then an append. `recv` blocks on the CONDITION rather than sleeping on a
        // guess about the poll interval.
        std::thread::sleep(Duration::from_millis(30));
        append(
            &path,
            format!("[Wed Aug 19 16:00:0{i} 2026] append {i}.\n").as_bytes(),
        );
        got.push(rx.recv().expect("the appended line"));
    }
    stop.store(true, Ordering::Relaxed);
    let tail = worker.join().expect("the follow thread");

    assert_eq!(got.len(), 4);
    assert!(got[0].ends_with("before."));
    assert!(got[3].ends_with("append 2."));
    assert_eq!(tail.checkpoint_offset(), tail.read_offset());
    assert_eq!(
        tail.checkpoint_offset(),
        std::fs::metadata(&path).unwrap().len()
    );
}
