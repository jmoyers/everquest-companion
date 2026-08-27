//! AN ATTACH THAT ACTUALLY FOLDS, OVER A REAL SOCKET, AGAINST THE REAL BINARY (JOS-474).
//!
//! `src/ingest.rs`'s own tests drive the ingest in-process and can hold it still at a gate; they
//! own the claims about WHAT is folded. This suite owns the claims a client can make — that the
//! frames the schema promises actually arrive, in the order it promises them, carrying measurements
//! that survive serialization into another language's shapes:
//!
//!   * an attach over the wire reaches `live`, and the last progress frame before it lands carries
//!     the EXACT event count `eqlog`'s proven scan finds in those same bytes;
//!   * progress frames are BOUNDED — a cadence, never a frame per line — and monotonic;
//!   * a landing fold resets every open subscription, once, naming the generation that landed;
//!   * a line appended after the tail takes over arrives, and says so on the wire.
//!
//! THE LOG IS A COPY OF A COMMITTED FIXTURE, staged in a scratch directory under the name the
//! product uses (`eqlog_<Name>_<server>.txt`) so the character comes off the file name exactly as
//! it does in the field. Nothing here writes to a real game log, and the fixture is never modified.

mod harness;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use harness::{attach, health, progress, subscribe, Engine};
use protocol::generated::{EngineMessage, EpochReason, HealthResultStatus, ReplyResult};

/// The fixture staged for these tests, and how many times it is written into the scratch log. Two
/// copies is ~900 KB: enough that the scan spans more than one read of the file and the progress
/// cadence has something to pace, small enough that a debug build folds it promptly.
const FIXTURE: &str = "cw2-loadout-swap-aug2.log";
const REPEATS: usize = 2;

/// How long a `settle` may take before the test is called hung. A FAILURE MECHANISM: nothing here
/// waits for the clock, every assertion waits for a condition.
const PATIENCE: Duration = Duration::from_secs(60);

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is three levels below the repo root")
        .to_path_buf()
}

/// A scratch directory holding one log named the way the product names one.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-wire-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        Self(dir)
    }

    fn stage(&self) -> PathBuf {
        let source = repo_root().join("tests").join("fixtures").join(FIXTURE);
        let bytes = std::fs::read(&source)
            .unwrap_or_else(|e| panic!("the fixture at {} is readable: {e}", source.display()));
        let path = self.0.join("eqlog_Primitive_freeport.txt");
        let mut out = std::fs::File::create(&path).expect("the scratch log");
        for _ in 0..REPEATS {
            out.write_all(&bytes).expect("the scratch log takes bytes");
        }
        out.flush().expect("flush");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ignored = std::fs::remove_dir_all(&self.0);
    }
}

/// THE ORACLE: what `eqlog`'s proven scan finds in these exact bytes. Never a number typed here —
/// a frozen count would stop meaning anything the first time the parser learned a line shape.
fn scan_oracle(path: &Path) -> i64 {
    let bytes = std::fs::read(path).expect("the log is readable");
    let parser = eqlog::parser_for("Primitive", eqlog::host_timezone());
    i64::try_from(eqlog::scan::scan_bytes(
        &parser,
        &bytes,
        |_line, _payload| {},
    ))
    .expect("a count")
}

/// Append one line the way EverQuest appends one.
fn append(path: &Path, line: &str) {
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("the log takes an append");
    file.write_all(line.as_bytes()).expect("append");
    file.flush().expect("flush");
}

/// One progress frame, reduced to what a client reads off it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Progress {
    pct: f64,
    events: i64,
}

#[test]
fn an_attach_folds_the_log_and_the_wire_says_so() {
    let scratch = Scratch::new("folds");
    let log = scratch.stage();
    let expected = scan_oracle(&log);

    let engine = Engine::start();
    let mut client = engine.connected();

    // A SUBSCRIPTION FIRST, so the landing fold has something to reset. The opening reset names
    // generation 1 — the world before the attach.
    client.send(&subscribe(7, "loot.ledger"));
    let EngineMessage::Reply(_ack) = client.recv() else {
        panic!("an ack");
    };
    let EngineMessage::ResetMessage(opening) = client.recv() else {
        panic!("then the opening reset");
    };
    assert_eq!(*opening.epoch, 1);

    // The progress channel, acknowledged as the subscription it is.
    client.send(&progress(5));
    let EngineMessage::Reply(_progress_ack) = client.recv() else {
        panic!("an ack for the progress channel");
    };

    client.send(&attach(3, &log.to_string_lossy()));

    // Read the whole fold off the wire, in order, until the landing reset arrives.
    let mut frames: Vec<Progress> = Vec::new();
    let mut attach_reply = None;
    let mut bump = None;
    let landing;
    loop {
        match client.recv() {
            EngineMessage::EpochMessage(epoch) => match epoch.reason {
                EpochReason::Attach => {
                    assert!(
                        epoch.progress.is_none(),
                        "at the bump the fold has not opened the file"
                    );
                    bump = Some(*epoch.epoch);
                }
                EpochReason::Progress => {
                    let carried = epoch.progress.expect("a progress frame carries progress");
                    assert_eq!(*epoch.epoch, 2, "every frame names the generation folding");
                    frames.push(Progress {
                        pct: carried.pct,
                        events: carried.events,
                    });
                }
                EpochReason::Restart => panic!("nothing restarts here"),
            },
            EngineMessage::Reply(reply) => {
                let ReplyResult::AttachResult(result) = &reply.result else {
                    panic!("an attach result");
                };
                assert!(result.accepted);
                attach_reply = Some(*result.epoch);
            }
            EngineMessage::ResetMessage(reset) => {
                landing = reset;
                break;
            }
            // THE MODULE DIRTY BITS (JOS-487) ARE CONNECTION-WIDE and interleave with everything
            // else on this stream by design, so this test skips them rather than asserting an
            // ordering it does not care about. Their own ordering is asserted in `module_changed`.
            EngineMessage::ModuleChangedMessage(_) => {}
            other => panic!("nothing else belongs on this stream: {other:?}"),
        }
    }

    assert_eq!(
        bump,
        Some(2),
        "the attach was announced before it was answered"
    );
    assert_eq!(attach_reply, Some(2));

    // THE LANDING RESET: the subscription, reopened, naming the generation that landed.
    assert_eq!(*landing.id, 7);
    assert_eq!(*landing.epoch, 2);
    assert_eq!(landing.total, 0, "empty until the fold registry arrives");
    assert!(landing.rows.is_empty());

    // THE FRAMES. Bounded, monotonic, and the last one states the whole fold.
    assert!(!frames.is_empty(), "a fold announces itself at least once");
    assert!(
        frames.len() <= 16,
        "a cadence, not a frame per line: {} frames for {expected} events",
        frames.len()
    );
    for pair in frames.windows(2) {
        assert!(
            pair[1].events >= pair[0].events && pair[1].pct >= pair[0].pct,
            "progress only goes forward: {pair:?}"
        );
    }
    let last = *frames.last().expect("a frame");
    assert_eq!(
        last.events, expected,
        "the final frame states the count the proven scan finds in the same bytes"
    );
    assert!(
        (last.pct - 100.0).abs() < f64::EPSILON,
        "the fixture ends on a newline, so the mark reaches the last byte: {}",
        last.pct
    );

    // …and health agrees, over the same connection.
    //
    // THE REPLY IS WAITED FOR RATHER THAN ASSUMED TO BE NEXT. A live tail publishes connection-wide
    // frames on its own cadence — progress, and since JOS-487 the module dirty bits — so "the next
    // message is my answer" was only ever true because nothing else was talking yet. A request/reply
    // client correlates on the id, which is exactly what this now does.
    client.send(&health(4));
    let reply = loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == 4 => break reply,
            EngineMessage::EpochMessage(_) | EngineMessage::ModuleChangedMessage(_) => {}
            other => panic!("nothing else belongs on this stream: {other:?}"),
        }
    };
    let ReplyResult::HealthResult(result) = &reply.result else {
        panic!("a health result");
    };
    assert!(
        matches!(result.status, HealthResultStatus::Live),
        "the tail has the file: {:?}",
        result.status
    );
    assert_eq!(*result.epoch, 2);
}

#[test]
fn a_line_appended_after_the_fold_lands_arrives_live() {
    let scratch = Scratch::new("live");
    let log = scratch.stage();
    let scanned = scan_oracle(&log);

    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &log.to_string_lossy()));

    // Wait for the fold — the last frame of the scan is the one that names every event in the file.
    let deadline = Instant::now() + PATIENCE;
    let mut folded = 0;
    while folded < scanned {
        assert!(Instant::now() < deadline, "the fold did not land in time");
        if let EngineMessage::EpochMessage(epoch) = client.recv() {
            if let Some(progress) = epoch.progress {
                folded = progress.events;
            }
        }
    }

    // THE GAME WRITES A LINE. It travels the whole path — the file, the tail's poll, the parser,
    // the sink — and the engine says so on the connection-wide channel.
    append(
        &log,
        "[Wed Aug 19 16:21:54 2026] You gain experience! (3.288%)\n",
    );

    let deadline = Instant::now() + PATIENCE;
    loop {
        assert!(Instant::now() < deadline, "the appended line never arrived");
        if let EngineMessage::EpochMessage(epoch) = client.recv() {
            if let Some(progress) = epoch.progress {
                if progress.events == scanned + 1 {
                    assert!(
                        (progress.pct - 100.0).abs() < f64::EPSILON,
                        "a caught-up tail is at its ceiling: {}",
                        progress.pct
                    );
                    break;
                }
            }
        }
    }
}
