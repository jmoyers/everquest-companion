//! CI budget for the engine's own numbers, read through `perf.snapshot`.
//!
//! Two tiers: CI folds a committed synthetic generator (the owner's real log never enters git), and
//! `npm run budget:g3` points the same instrument at the local 209 MB fixture and prints rather than
//! asserts, because a wall-clock ceiling is a claim about a machine.
//!
//! Ceilings catch gross regressions only — an O(n²), a per-line allocation, a debug build in a
//! release job. Rate is asserted rather than duration, so the generator may change size.
//!
//! The two bounds are also stated in `engined/src/budgets.rs`, since a binary crate cannot be
//! imported by an integration test; the last test here pins the two copies equal.

mod harness;

use harness::{attach, perf_budgets, perf_snapshot, subscribe, Client, Engine, PATIENCE};
use protocol::generated::{
    EngineMessage, PerfBudgetId, PerfBudgetsResult, PerfSnapshotResult, PerfSnapshotResultStatus,
    ReplyResult,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// The floor the synthetic fold must beat, in bytes per second of log scanned.
///
/// Measured 7.8 MB/s (8.0 MB in 1030 ms, 110,319 events) on an i9-13900KF release build at
/// below-normal priority. The floor is an eighth of that: a shared CI runner is several times
/// slower single-threaded, and a debug build is roughly 10× slower still — which is the regression
/// this floor most wants to catch.
const MIN_FOLD_BYTES_PER_SEC: f64 = 1_000_000.0;

/// The ceiling on fold-to-frame latency, in microseconds, for a served view.
///
/// `foldToFrameUs` is not compute: it spans drain, the ~10 Hz coalescing beat, the tail poll, build,
/// sort, diff and serialize. Measured 56 ms for a one-drop diff, so this 2 s bound is a wedge
/// detector — it catches a serve path that stopped serving, never a slow millisecond.
const MAX_SERVE_LATENCY_US: i64 = 2_000_000;

/// How much synthetic log the CI tier folds. Big enough that the rate is a measurement rather than
/// a startup cost, small enough that generating it is not itself the slow part of the job.
const SYNTHETIC_TARGET_BYTES: usize = 8 * 1024 * 1024;

/// The source the serve half is measured over.
const SOURCE: &str = "loot.ledger";

/// How long the G3 tier waits for a fold. The owner's 209 MB log measures ~50 s, where the harness's
/// 30 s `PATIENCE` expires mid-scan. Five minutes marks a wedge, not a budget.
const G3_PATIENCE: std::time::Duration = std::time::Duration::from_secs(300);

/// A 64-bit xorshift, seeded by a constant.
///
/// Hand-rolled so the corpus is byte-identical on every machine and every future run: no crate
/// version, no hash iteration order and no clock may move it.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn pick(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    /// An inclusive range, which is what every damage and heal amount below wants.
    fn between(&mut self, lo: u32, hi: u32) -> u32 {
        lo + (self.next() % u64::from(hi - lo + 1)) as u32
    }
}

/// Names that appear in the synthetic corpus. Invented on purpose: this file is committed to a
/// public repo, so no name here may be one the owner's log contains. Shape is what the parser's
/// patterns care about.
const MOBS: [&str; 8] = [
    "a sand giant",
    "a dust devil",
    "a greater sand elemental",
    "an ancient cyclops",
    "a hill giant",
    "a desert madman",
    "a sabertooth cub",
    "an orc pawn",
];
const ALLIES: [&str; 4] = ["Testarossa", "Benchmark", "Ceilingcat", "Floorboard"];
const ZONES: [&str; 4] = [
    "South Ro",
    "Oasis of Marr",
    "Lake Rathetear",
    "Nagafen's Lair",
];
const SPELLS: [&str; 4] = [
    "Burst of Flame",
    "Shock of Blades",
    "Chill Sight",
    "Minor Healing",
];
const ITEMS: [&str; 5] = [
    "a bronze longsword",
    "a giant scimitar",
    "a rusty dagger",
    "a small bronze shield",
    "a tattered note",
];

/// Two-digit, because an EQ stamp is fixed width and the parser's pattern says so.
fn two(n: u32) -> String {
    format!("{n:02}")
}

/// One EQ timestamp, walked forward a second at a time from a fixed instant.
///
/// Dated after the 2026-07-28 launch anchor: the epoch detector rebirths the world at that boundary,
/// so an earlier corpus would fold entirely in a state no live app is ever in. The arithmetic stays
/// inside one August so no calendar dependency is needed.
fn stamp(second: u32) -> String {
    let day = 3 + (second / 86_400) % 25;
    let rem = second % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(day % 7) as usize];
    format!(
        "[{dow} Aug {} {}:{}:{} 2026] ",
        two(day),
        two(h),
        two(m),
        two(s)
    )
}

/// Build the synthetic log: a deterministic mix of the lanes a real fold spends its time in.
///
/// The mix is the measurement's subject — combat, healing, casting, loot, kills and zoning — so a
/// regression in any module's `on_event` shows up. Proportions are eyeballed from the real log's
/// shape and need only be fixed, not exact, so two runs measure the same work.
fn synthesize(target_bytes: usize) -> String {
    let mut rng = Rng(0x5eed_1234_abcd_ef01);
    let mut out = String::with_capacity(target_bytes + 4096);
    let mut second: u32 = 8 * 3600;
    let mut zone = 0usize;
    out.push_str(&stamp(second));
    out.push_str("You have entered South Ro.\n");

    while out.len() < target_bytes {
        second += 1;
        let mob = MOBS[rng.pick(MOBS.len())];
        // A round of combat is the unit, because that is how a real log arrives: several lines
        // sharing one timestamp, which also exercises the second-granularity tiebreak every view
        // sort ends in.
        for _ in 0..rng.between(2, 6) {
            let at = stamp(second);
            match rng.pick(10) {
                0..=3 => {
                    let dmg = rng.between(12, 480);
                    out.push_str(&at);
                    out.push_str(&format!("You slash {mob} for {dmg} points of damage.\n"));
                }
                4 | 5 => {
                    let dmg = rng.between(8, 260);
                    out.push_str(&at);
                    out.push_str(&format!("{mob} hits YOU for {dmg} points of damage.\n"));
                }
                6 => {
                    let who = ALLIES[rng.pick(ALLIES.len())];
                    let dmg = rng.between(20, 300);
                    out.push_str(&at);
                    out.push_str(&format!("{who} hits {mob} for {dmg} points of damage.\n"));
                }
                7 => {
                    let spell = SPELLS[rng.pick(SPELLS.len())];
                    out.push_str(&at);
                    out.push_str(&format!("You begin casting {spell}.\n"));
                }
                8 => {
                    let heal = rng.between(10, 120);
                    let who = ALLIES[rng.pick(ALLIES.len())];
                    out.push_str(&at);
                    out.push_str(&format!(
                        "{who} has been healed for {heal} points of damage.\n"
                    ));
                }
                _ => {
                    out.push_str(&at);
                    out.push_str(&format!("You try to kick {mob}, but miss!\n"));
                }
            }
        }
        // The rarer lanes on a fixed cadence, so their count is a function of corpus size alone.
        if second.is_multiple_of(17) {
            let at = stamp(second);
            out.push_str(&at);
            out.push_str(&format!("You have slain {mob}!\n"));
            out.push_str(&at);
            let item = ITEMS[rng.pick(ITEMS.len())];
            out.push_str(&format!("--You have looted a {item}.--\n"));
        }
        if second.is_multiple_of(997) {
            zone = (zone + 1) % ZONES.len();
            out.push_str(&stamp(second));
            out.push_str(&format!("You have entered {}.\n", ZONES[zone]));
        }
    }
    out
}

/// A log on disk under the product's own file-name shape, in a directory of this test's own.
///
/// The name matters: the engine derives the character and the server from it and has no other
/// source, and `..\Logs\` is the directory shape the client writes.
struct Staged {
    dir: PathBuf,
}

impl Staged {
    fn new(tag: &str, contents: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("eqc-budget-{tag}-{}", std::process::id()));
        let logs = dir.join("Logs");
        std::fs::create_dir_all(&logs).expect("stage a log directory");
        let mut f = std::fs::File::create(logs.join("eqlog_Benchmark_bench.txt")).expect("create");
        f.write_all(contents.as_bytes()).expect("write the corpus");
        f.flush().expect("flush the corpus");
        Self { dir }
    }

    fn log(&self) -> PathBuf {
        self.dir.join("Logs").join("eqlog_Benchmark_bench.txt")
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Append one kill and one loot line to the tailed log, so a live fold happens and the view it feeds
/// produces a diff the meter can time. The stamp is far past the corpus's own so the line cannot be
/// mistaken for part of the historical scan.
fn append_a_drop(log: &Path) {
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(log)
        .expect("append to the staged log");
    let at = stamp(20 * 86_400);
    writeln!(f, "{at}You have slain a hill giant!").expect("write the kill");
    writeln!(f, "{at}--You have looted a bronze longsword.--").expect("write the drop");
    f.flush().expect("flush the append");
}

fn ask_perf(client: &mut Client, id: i64) -> PerfSnapshotResult {
    client.send(&perf_snapshot(id));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::PerfSnapshotResult(result) = reply.result else {
                    panic!("a perf snapshot result, got {:?}", reply.result);
                };
                return result;
            }
            EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                panic!("perf.snapshot was refused: {:?}", refusal.error);
            }
            // A subscription's own frames can arrive between the ask and the answer; the id says so.
            _ => {}
        }
    }
}

/// Poll until the engine says what we are waiting for, or patience runs out. A failure mechanism
/// rather than a synchronisation one.
fn until(
    client: &mut Client,
    id: &mut i64,
    what: &str,
    patience: std::time::Duration,
    ready: impl Fn(&PerfSnapshotResult) -> bool,
) -> PerfSnapshotResult {
    let deadline = Instant::now() + patience;
    loop {
        *id += 1;
        let perf = ask_perf(client, *id);
        if ready(&perf) {
            return perf;
        }
        assert!(
            Instant::now() < deadline,
            "waited {patience:?} for {what}; the engine last said {perf:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// What one run measured. Printed whether or not it is asserted on.
struct Measured {
    bytes: i64,
    events: i64,
    scan_ms: i64,
    serve_latency_us: Option<i64>,
}

impl Measured {
    fn rate(&self) -> f64 {
        if self.scan_ms == 0 {
            // A fold too fast to time is not a fold that failed: report the whole corpus in one
            // millisecond, which floors the truth rather than dividing by zero.
            return self.bytes as f64 * 1000.0;
        }
        self.bytes as f64 * 1000.0 / self.scan_ms as f64
    }

    fn report(&self, label: &str) {
        println!(
            "
[budget] {label}"
        );
        println!(
            "[budget]   fold      {:.1} MB in {} ms = {:.1} MB/s ({} events)",
            self.bytes as f64 / 1_048_576.0,
            self.scan_ms,
            self.rate() / 1_048_576.0,
            self.events
        );
        match self.serve_latency_us {
            Some(us) => println!(
                "[budget]   serve     fold-to-frame worst {us} us = {:.0} ms (INCLUDES the ~10 Hz \n                 coalescing beat and the tail poll -- see MAX_SERVE_LATENCY_US)",
                us as f64 / 1000.0
            ),
            None => println!("[budget]   serve     no timed frame (nothing was folded behind one)"),
        }
    }
}

/// Attach the engine to a log, wait for the fold to land, subscribe to a view, and report what the
/// engine says it cost. One instrument for both tiers: they differ in what is measured, never how.
fn measure(log: &Path, patience: std::time::Duration) -> Measured {
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &log.to_string_lossy()));

    let mut id = 100;
    let perf = until(&mut client, &mut id, "the fold to go live", patience, |p| {
        p.status == PerfSnapshotResultStatus::Live
    });

    let bytes = perf
        .ingest
        .scan_bytes
        .expect("a finished scan reports its bytes");
    let scan_ms = perf
        .ingest
        .scan_ms
        .expect("a finished scan reports its time");
    let events = perf
        .events
        .expect("a finished scan reports its event count");

    // The serve half needs a diff rather than the opening reset: a subscribe opens with a reset
    // built off an old fold, and the meter times only frames with a fold instant behind them. So
    // make the fold happen by appending to the tailed log, which is also the production shape.
    id += 1;
    client.send(&subscribe(id, SOURCE));
    let _ack = client.recv();
    let _reset = client.recv();
    append_a_drop(log);
    let deadline = Instant::now() + PATIENCE;
    let serve_latency_us = loop {
        id += 1;
        let after = ask_perf(&mut client, id);
        let timed = after
            .serve
            .iter()
            .find(|r| r.source == SOURCE)
            .and_then(|r| r.fold_to_frame_us_max);
        if timed.is_some() {
            break timed;
        }
        // Not a failure: a tail that has not yet noticed the append is working at its own cadence.
        // An unmeasured serve half is reported absent rather than as zero.
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };

    Measured {
        bytes,
        events,
        scan_ms,
        serve_latency_us,
    }
}

/// A budget is a release measurement, so a debug build takes the number and refuses to judge it.
///
/// Measured: a debug fold runs 0.45 MB/s against the 1 MB/s floor, a ~17× gap. The numbers are still
/// printed under debug, which is the comparison that makes the release number mean something.
fn release_build() -> bool {
    !cfg!(debug_assertions)
}

#[test]
fn the_synthetic_fold_stays_inside_its_ci_budget() {
    let corpus = synthesize(SYNTHETIC_TARGET_BYTES);
    // The generator is itself under test: a corpus that silently stopped producing lines would make
    // every number below excellent and meaningless.
    assert!(
        corpus.len() >= SYNTHETIC_TARGET_BYTES,
        "the generator produced {} bytes, wanted at least {SYNTHETIC_TARGET_BYTES}",
        corpus.len()
    );
    assert_eq!(
        corpus,
        synthesize(SYNTHETIC_TARGET_BYTES),
        "the generator is DETERMINISTIC — two calls must produce the same bytes, or a budget \
         comparison across runs is comparing two different corpora"
    );

    let staged = Staged::new("ci", &corpus);
    // A debug fold is slow enough that the deadline matters: 8 MB at 0.45 MB/s is ~18 s, which fits
    // inside `PATIENCE` but leaves little room on a busy runner.
    let m = measure(
        &staged.log(),
        if release_build() {
            PATIENCE
        } else {
            G3_PATIENCE
        },
    );
    m.report(if release_build() {
        "CI tier — synthetic corpus"
    } else {
        "CI tier — synthetic corpus (DEBUG build: measured, not judged)"
    });

    assert!(
        m.events > 100_000,
        "the corpus folded to only {} events; the budget would be measuring parsing failures",
        m.events
    );
    // Everything below this line is a release claim. See `release_build`.
    if !release_build() {
        println!(
            "[budget]   note      a debug fold is ~17x slower than release; the floor below is not \
             applied. Run `npm run budget:ci` for the real check."
        );
        return;
    }
    assert!(
        m.rate() >= MIN_FOLD_BYTES_PER_SEC,
        "FOLD RATE BUDGET BREACHED: {:.2} MB/s, floor is {:.2} MB/s. This ceiling is set an order \
         of magnitude below a workstation measurement precisely so runner variance cannot reach it \
         — read it as a defect, not as a slow machine.",
        m.rate() / 1_048_576.0,
        MIN_FOLD_BYTES_PER_SEC / 1_048_576.0
    );
    if let Some(us) = m.serve_latency_us {
        assert!(
            us <= MAX_SERVE_LATENCY_US,
            "SERVE LATENCY BUDGET BREACHED: {us} us worst fold-to-frame, ceiling is \
             {MAX_SERVE_LATENCY_US} us. This is a WEDGE DETECTOR, not a performance budget: the \n             number includes the coalescing beat, so breaching it means the serve path stopped \n             serving rather than that it got slower."
        );
    }
}

/// The owner's real log at full speed — `npm run budget:g3`, run at the release cut.
///
/// Prints and does not assert: the goal is the 209 MB fixture under 20 s, but the fixture is
/// gitignored and machine-local, so a hard failure would be a claim about somebody else's hardware.
/// The integrator records the number in the release notes.
///
/// Skips rather than fails when the fixture is absent, which is every machine but the owner's.
#[test]
fn the_owners_full_log_folds_at_full_speed() {
    let Ok(path) = std::env::var("EQC_BUDGET_LOG") else {
        println!("[budget] G3 skipped: set EQC_BUDGET_LOG to the owner's fixture to measure it");
        return;
    };
    let log = PathBuf::from(&path);
    assert!(
        log.is_file(),
        "EQC_BUDGET_LOG names {path}, which is not a file"
    );

    let m = measure(&log, G3_PATIENCE);
    m.report("G3 — the owner's real log, full speed");
    println!(
        "[budget]   G3 goal   fold under 20 s; this run took {:.1} s. Not asserted — record it in \
         the release notes.",
        m.scan_ms as f64 / 1000.0
    );
}

/// Ask the running engine what its budgets are.
fn ask_budgets(client: &mut Client, id: i64) -> PerfBudgetsResult {
    client.send(&perf_budgets(id));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::PerfBudgetsResult(result) = reply.result else {
                    panic!("a perf budgets result, got {:?}", reply.result);
                };
                return result;
            }
            EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                panic!("perf.budgets was refused: {:?}", refusal.error);
            }
            _ => {}
        }
    }
}

/// The two copies of each bound agree, or this goes red.
///
/// `engined/src/budgets.rs` states the same two numbers and cannot be imported here (binary crate),
/// so the duplication is checked rather than trusted.
///
/// It compares the figure and not the prose: the served `limit` is a rendered sentence, and pinning
/// the whole string would make every wording change a red test.
#[test]
fn the_engine_serves_the_same_two_bounds_this_suite_asserts() {
    let engine = Engine::start();
    let mut client = engine.connected();
    let answer = ask_budgets(&mut client, 1);

    let find = |id: PerfBudgetId| {
        answer
            .budgets
            .iter()
            .find(|b| b.id == id)
            .unwrap_or_else(|| panic!("the engine serves a {id} budget"))
            .clone()
    };

    let fold = find(PerfBudgetId::FoldRate);
    let expected_rate = format!("{:.1} MB/s", MIN_FOLD_BYTES_PER_SEC / 1_000_000.0);
    assert!(
        fold.limit.contains(&expected_rate),
        "the engine's fold-rate floor is {:?}; this suite asserts {expected_rate}",
        fold.limit
    );

    let serve = find(PerfBudgetId::ServeLatency);
    let expected_latency = format!("{:.1} s", MAX_SERVE_LATENCY_US as f64 / 1_000_000.0);
    assert!(
        serve.limit.contains(&expected_latency),
        "the engine's serve-latency ceiling is {:?}; this suite asserts {expected_latency}",
        serve.limit
    );
}
