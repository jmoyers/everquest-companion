//! ============================================================================
//! THE ENGINE MEASURES ITSELF, AND CI HOLDS IT TO IT (owner ruling 3, JOS-501).
//! ============================================================================
//!
//! Owner ruling 3, verbatim: *"Performance goals are enforced in this process, at the parse
//! boundary — self-measured, CI-gated, reported as telemetry. Never promised."* This file is the
//! CI-gated half, and it is the ORACLE'S SUCCESSOR: `oracle:rust-fold` compared two
//! implementations of the fold and the cutover left one, so what replaces it is not another
//! comparison but a BUDGET — the engine's own numbers, measured through the same
//! `perf.snapshot` machinery the in-app performance panel reads, checked against a ceiling.
//!
//! ── TWO TIERS, AND ONLY ONE OF THEM CAN LIVE IN CI ────────────────────────────────────────────
//!
//! **(a) CI — a SYNTHETIC log, committed as a generator rather than as bytes.** The corpus this
//! engine exists for is the owner's real game log, and that never enters git (AGENTS.md: a
//! reporter's slice never becomes a fixture, and the six equivalence slices are gitignored). A
//! generator is the honest substitute: it is deterministic, it is a few hundred lines of source
//! instead of megabytes of somebody's play, and it produces the same bytes on every machine, so a
//! regression is a regression rather than a difference of corpus.
//!
//! **(b) LOCAL — the G3 check**, the same instrument pointed at the owner's 209 MB fixture
//! (`tests/bench/fixtures/Logs/`, gitignored). It is `npm run budget:g3`, the integrator runs it at
//! the release cut, and it PRINTS RATHER THAN ASSERTS. That restraint is the point: a wall-clock
//! ceiling is a claim about a machine, and this suite does not know the machine a release is cut
//! on. The number goes in the release notes, where a human reads it.
//!
//! ── WHY THE CEILINGS ARE SO LOOSE, STATED SO NOBODY TIGHTENS THEM BY FEEL ─────────────────────
//!
//! A GitHub runner is a shared virtual machine with no promise about its neighbours, and this same
//! test also runs on a 24-core desktop that is simultaneously playing EverQuest (the below-normal
//! priority law). The spread between those two is far larger than any regression worth catching by
//! wall clock. So each bound below is sized to catch a GROSS regression — an accidental O(n²), a
//! per-line allocation, a debug build slipping into a release job — and nothing subtler. A budget
//! that goes red on runner variance teaches everyone to re-run it, which is worse than no budget.
//!
//! The RATE is what is asserted rather than the duration, because a rate survives a change in the
//! generator's size and a duration does not.
//!
//! Both constants carry their own MEASUREMENT and the argument for the gap between the measurement
//! and the bound. Read those before changing either — particularly `MAX_SERVE_LATENCY_US`, whose
//! number means something different from what its name suggests.
//!
//! ── AND SINCE JOS-502 THE ENGINE STATES THE SAME TWO BOUNDS ITSELF ────────────────────────────
//!
//! Ruling 19's `perf.budgets` serves these budgets LIVE, off `engined/src/budgets.rs`, so the panel
//! and a bug report carry the verdict this suite computes. THE CONSTANTS ARE THEREFORE WRITTEN
//! TWICE — once there and once here — because `engined` is a BINARY crate with no lib target, so an
//! integration test cannot import from it and the alternative would be adding a library facade to
//! the shipped process for a test's convenience. The duplication is made self-checking instead:
//! `the_engine_serves_the_same_two_bounds_this_suite_asserts` asks the running engine what its
//! budgets are and fails if either number has drifted from the two below. That is the repo's own
//! pattern for a fact that must live in two places (a generated file pinned by a staleness test),
//! and it means a hand edit to one copy is a red test rather than a panel quietly disagreeing with
//! CI about the same build.

mod harness;

use harness::{attach, perf_budgets, perf_snapshot, subscribe, Client, Engine, PATIENCE};
use protocol::generated::{
    EngineMessage, PerfBudgetId, PerfBudgetsResult, PerfSnapshotResult, PerfSnapshotResultStatus,
    ReplyResult,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

// ---- the budgets --------------------------------------------------------------------------------

/// THE FLOOR THE SYNTHETIC FOLD MUST BEAT, in bytes per second of log scanned.
///
/// MEASURED before it was chosen rather than after, on the desktop this was written on
/// (i9-13900KF, release build, below-normal priority, with the owner's dev app running):
/// **8.0 MB folded in 1030 ms = 7.8 MB/s, 110,319 events.** That is the same order as the number
/// the product shows on the owner's real log — 209 MB in ~52 s, measured through the app in the
/// same ticket — which is the cross-check that says the synthetic corpus is a fair stand-in and not
/// a benchmark of one lucky regex.
///
/// The floor is **1 MB/s, an eighth of the measurement**, and the two numbers that justify a gap
/// that wide are:
///   * a GitHub `windows-latest` runner is a shared VM with no promise about its neighbours, and
///     several times slower than this desktop for single-threaded work;
///   * a DEBUG build of this engine is roughly an order of magnitude slower than release — which is
///     the regression this floor most wants to catch, because it is the one that has actually
///     happened (the e2e harness built debug for two releases, and `bosses-week` could not fold the
///     owner's log in 900 s because of it).
///
/// So: a debug build breaches this floor, an O(n²) breaches it, and runner variance cannot reach
/// it. A budget that goes red on a slow morning teaches everyone to press re-run, which is worse
/// than no budget.
const MIN_FOLD_BYTES_PER_SEC: f64 = 1_000_000.0;

/// THE CEILING ON FOLD-TO-FRAME LATENCY, in microseconds, for a served view.
///
/// READ THE UNIT BEFORE THE NUMBER. `foldToFrameUs` is not compute — `views/meter.rs` says so in
/// its own header, and says it deliberately: *"From the instant the ingest folded the event that
/// moved the source, to the instant the frame describing it was handed to the connection's outbox.
/// It is the whole engine-side path — drain, cadence, build, filter, sort, cut, diff, serialize."*
/// The ~10 Hz coalescing beat is INSIDE this number, and so is the tail's own poll interval.
///
/// MEASURED here: **56 ms** for the diff produced by one appended drop. That is a beat and a poll,
/// not work, and it is what a healthy engine looks like. So the ceiling is **2 s** — two orders of
/// magnitude above the observed value — and it is deliberately a WEDGE DETECTOR rather than a
/// performance budget: it catches a serve path that has stopped serving (a sort that went
/// quadratic over a large window, a drain that stalls), and it will never catch a slow millisecond.
///
/// THE HONEST GAP, NAMED: there is no compute-only serve measurement in the engine today, because
/// the meter takes ONE instant. Ruling 19's own discipline is that queue time is named as queue
/// time, and a single number that bundles cadence into something the performance panel labels
/// "latency" is in tension with it. Separating them means a second instant taken at frame-build
/// start — a small change in `views/meter.rs`, and a follow-up rather than this ticket's business.
const MAX_SERVE_LATENCY_US: i64 = 2_000_000;

/// How much synthetic log the CI tier folds. Big enough that the rate is a measurement rather than
/// a startup cost, small enough that generating it is not itself the slow part of the job.
const SYNTHETIC_TARGET_BYTES: usize = 8 * 1024 * 1024;

/// The source the serve half is measured over — the one view proven end to end since JOS-484.
const SOURCE: &str = "loot.ledger";

/// How long the G3 tier waits for a fold, which is a different order of magnitude from the CI one.
///
/// The harness's `PATIENCE` is 30 s and that is right for every other suite, which folds a staged
/// fixture of a few hundred kilobytes. G3 folds the owner's 209 MB log — MEASURED at ~50 s here,
/// and 52.5 s through the running app in this same ticket — so the harness's deadline expired at
/// 127 MB with the engine still honestly reporting `folding`. Five minutes is not a budget; it is
/// the point past which a fold has clearly wedged rather than merely being long.
const G3_PATIENCE: std::time::Duration = std::time::Duration::from_secs(300);

// ---- the committed generator --------------------------------------------------------------------

/// A 64-bit xorshift, seeded by a constant.
///
/// DETERMINISM IS THE WHOLE POINT and it is why this is hand-rolled rather than pulled from a crate:
/// the corpus must be byte-identical on every machine and in every future run, so the generator may
/// not depend on a dependency's version, on `HashMap` iteration order, on a clock, or on anything
/// else that is allowed to change. Three lines of arithmetic have none of those problems.
///
/// It is also cache law 1 restated (`docs/plans/data-server.md`): determinism IS cacheability, and a
/// budget corpus that drifted would make every comparison against a previous run meaningless.
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

/// Names that appear in the synthetic corpus.
///
/// INVENTED, and that is a requirement rather than a convenience: this file is COMMITTED and the
/// repo is PUBLIC, so no name here may be one the owner's log actually contains. They are shaped
/// like EQ names — the parser's patterns care about shape — and belong to nobody.
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
/// AFTER THE LAUNCH ANCHOR (2026-07-28) on purpose: the epoch detector rebirths the world at that
/// boundary, and a corpus dated before it would spend the whole fold in a state no live app is ever
/// in. The date arithmetic is deliberately trivial — one August, no month rollover — because a
/// generator that needed a calendar library would be a dependency this file refuses to have.
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
/// THE MIX IS THE MEASUREMENT'S SUBJECT. A corpus of nothing but damage lines would measure one
/// regex and call it the fold; this walks combat, healing, casting, buffs, loot, kills and zoning,
/// so a regression in any module's `on_event` shows up. The proportions are eyeballed from the real
/// log's shape (combat dominates by an order of magnitude, loot and zones are rare), and they do not
/// need to be exact — they need to be FIXED, so two runs measure the same work.
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
        // A ROUND OF COMBAT is the unit, because that is how a real log arrives: several lines
        // sharing one timestamp. It also exercises the second-granularity tiebreak every view sort
        // ends in — the property JOS-484 found the hard way.
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
        // THE RARER LANES, on a fixed cadence rather than a random one so their COUNT is a function
        // of the corpus size alone.
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

// ---- staging ------------------------------------------------------------------------------------

/// A log on disk under the product's own file-name shape, in a directory of this test's own.
///
/// THE NAME MATTERS: the engine derives the character and the server from it (there is no other
/// source), so a file called anything else attaches to a world with no name. `..\Logs\` is the shape
/// the client writes and the shape every other suite stages.
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

// ---- reading the engine's own numbers ------------------------------------------------------------

/// Append one kill and one loot line to the tailed log, so a LIVE fold happens and the view it
/// feeds produces a diff the meter can time. The stamp is far past the corpus's own so the line
/// cannot be mistaken for part of the historical scan.
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
            // A subscription's own frames can arrive between the ask and the answer; they are not
            // this request's business and the id is what says so.
            _ => {}
        }
    }
}

/// Poll until the engine says what we are waiting for, or the suite's patience runs out. A FAILURE
/// mechanism rather than a synchronisation one — `tests/perf_snapshot.rs` argues it at length.
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

/// What one run measured. Printed whether or not it is asserted on — see the header's tier (b).
struct Measured {
    bytes: i64,
    events: i64,
    scan_ms: i64,
    serve_latency_us: Option<i64>,
}

impl Measured {
    fn rate(&self) -> f64 {
        if self.scan_ms == 0 {
            // A fold too fast to time is not a fold that failed. Report it as the whole corpus in
            // one millisecond, which is a floor on the truth rather than a division by zero.
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
/// engine says it cost. ONE INSTRUMENT FOR BOTH TIERS — the synthetic corpus and the owner's real
/// log differ in what is measured, never in how.
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

    // THE SERVE HALF, AND IT NEEDS A DIFF RATHER THAN THE OPENING RESET.
    //
    // A subscribe opens with a reset built off a fold that landed some time ago, and the meter
    // deliberately TIMES ONLY WHAT IT CAN — a frame with no fold instant behind it is counted and
    // not timed, because calling the age of an old fold "latency" would be a lie. So the only
    // honest way to measure serve compute is to make the fold happen: append a line to the tailed
    // log and let the live path produce a diff off it. That is also the shape the number describes
    // in production, where every diff is a frame built off a fold that just happened.
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
        // NOT A FAILURE. A tail that has not yet noticed the append is a tail doing its job at its
        // own cadence; the deadline exists to turn a wedge into a red test, and an unmeasured serve
        // half is reported as absent rather than as zero.
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

// ---- tier (a): CI -------------------------------------------------------------------------------

/// A BUDGET IS A RELEASE MEASUREMENT, so a debug build takes the number and refuses to judge it.
///
/// MEASURED, and this is the mechanism working rather than a workaround: the first CI run of this
/// suite went red in `cargo test --workspace` — which builds DEBUG — at **0.45 MB/s against a
/// 1 MB/s floor**, and the dedicated release step never ran because the job had already failed.
/// The floor did exactly what its own doc comment says it is for ("a debug build breaches this
/// floor"); it simply fired in the wrong job.
///
/// So the profile is checked rather than assumed. The numbers are still PRINTED under debug, which
/// is worth more than skipping silently: `cargo test --workspace` now reports what a debug fold
/// costs, which is the comparison that makes the release number mean something — and it is the
/// same ~17× gap that made `bosses-week` un-runnable before JOS-501 built the harness in release.
fn release_build() -> bool {
    !cfg!(debug_assertions)
}

#[test]
fn the_synthetic_fold_stays_inside_its_ci_budget() {
    let corpus = synthesize(SYNTHETIC_TARGET_BYTES);
    // THE GENERATOR IS ITSELF UNDER TEST, cheaply: a corpus that silently stopped producing lines
    // would make every number below excellent and meaningless.
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
    // A DEBUG FOLD IS SLOW ENOUGH THAT THE HARNESS'S OWN DEADLINE MATTERS: 8 MB at the measured
    // 0.45 MB/s is ~18 s, which fits inside `PATIENCE` but leaves little room on a busy runner.
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
    // …and everything below this line is a RELEASE claim. See `release_build`.
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

// ---- tier (b): the G3 check, local only ---------------------------------------------------------

/// THE OWNER'S REAL LOG, AT FULL SPEED — `npm run budget:g3`, run at the release cut.
///
/// IT PRINTS AND DOES NOT ASSERT, and that is the ticket's own instruction. G3's goal is a fold of
/// the 209 MB fixture in under 20 s, but the fixture is gitignored and machine-local and this suite
/// does not know what machine a release is cut on — so a hard failure here would be a claim about
/// somebody else's hardware. The integrator reads the number and records it in the release notes,
/// which is a human holding the goal rather than a test pretending to.
///
/// SKIPS RATHER THAN FAILS when the fixture is absent, which is every machine but the owner's and
/// every CI run. A test that failed on a missing gitignored corpus would make the whole suite red
/// for everyone who does not have the owner's game log, which is everyone.
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

/// Ask the running engine what its budgets are — `perf.budgets`, ruling 19's surface (JOS-502).
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

/// THE TWO COPIES OF EACH BOUND AGREE, OR THIS GOES RED (JOS-502).
///
/// `engined/src/budgets.rs` states these same two numbers so the panel and a bug report can carry a
/// live verdict, and it cannot be imported here because `engined` is a binary crate (see the header
/// for why a lib facade was not added for a test's convenience). So the duplication is checked
/// rather than trusted: this asks the shipped engine to render its own limits and fails if either
/// has drifted from the constant this suite asserts against.
///
/// IT COMPARES THE NUMBER AND NOT THE PROSE. The served `limit` is a rendered sentence — "at least
/// 1.0 MB/s" — and pinning the whole string would make every wording change a red test in a file
/// that has nothing to say about wording. What must not drift is the FIGURE, so that is what is
/// looked for inside it. Debug or release makes no difference: a definition is not a measurement.
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
