//! THE APP'S `userData` REACHES THE FOLD OVER A REAL SOCKET (JOS-496 item 3).
//!
//! `src/state.rs` owns what a durable write IS and `src/foldsink.rs`'s tests own what a seeded sink
//! holds; this suite owns the one claim neither of them can make — that `session.attach`'s optional
//! `stateDir`, a field added to the schema and regenerated into two languages, actually travels
//! from a client's message through the op table, the world, the ingest thread and into the fold
//! that answers `module.snapshot`.
//!
//! IT IS PROVEN THROUGH `resist`, and that module is the right instrument rather than a convenient
//! one: its whole published surface is two integers — how many pooled rows the ledger holds and how
//! many creatures they are about — so a seeded bucket is VISIBLE in the served state and an
//! unseeded one is unmistakably absent. There is nothing to interpret.
//!
//! **THE WRITE HALF IS NOT HERE, and that is a scope statement.** The cadence is sixty beats of a
//! 1 Hz heartbeat, so a cross-process test of it would sit for a minute per assertion; the write is
//! driven directly in `foldsink.rs`'s own tests, where sixty ticks cost microseconds. What only a
//! real process can prove is the WIRE, and that is what this file proves.
//!
//! THE LOG IS A COPY OF A COMMITTED FIXTURE, staged under the product's own file-name shape, beside
//! a scratch profile directory. Nothing here touches a real game log or a real userData.

mod harness;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use harness::{attach, attach_with_state, health, module_snapshot, Client, Engine};
use protocol::generated::{EngineMessage, HealthResultStatus, ReplyResult};

const FIXTURE: &str = "cw2-loadout-swap-aug2.log";

/// A failure mechanism, never a synchronization one — every assertion waits on a condition.
const PATIENCE: Duration = Duration::from_secs(120);

/// ONE PERSISTED BUCKET, in the app's exact bytes, for a character whose log is NOT the one being
/// folded. That is the case the whole per-source register exists for: this bucket is knowledge
/// nothing can re-derive, so it must survive the attach untouched.
const OTHER_CHARACTERS_LEDGER: &str = r#"{"version":3,"sources":[{"key":"someone_bertox","rows":[{"mobKey":"a bat","spellKey":"malosi","family":"cast","casterKind":"self","casterLevel":51,"mobLevel":20,"debuffs":"","rank":0,"overchannel":false,"week":"2026-W34","resist":4,"land":7,"dmg":{"9":2},"firstTs":1000,"lastTs":2000}]}]}"#;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is three levels below the repo root")
        .to_path_buf()
}

/// A scratch directory holding one staged log and one scratch profile.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-state-wire-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        Self(dir)
    }

    fn stage_log(&self) -> PathBuf {
        let source = repo_root().join("tests").join("fixtures").join(FIXTURE);
        let bytes = std::fs::read(&source)
            .unwrap_or_else(|e| panic!("the fixture at {} is readable: {e}", source.display()));
        let path = self.0.join("eqlog_Primitive_freeport.txt");
        let mut out = std::fs::File::create(&path).expect("the scratch log");
        out.write_all(&bytes).expect("the scratch log takes bytes");
        out.flush().expect("flush");
        path
    }

    /// The scratch `userData`, holding the app's own resist ledger.
    fn stage_profile(&self) -> PathBuf {
        let dir = self.0.join("profile");
        std::fs::create_dir_all(&dir).expect("a scratch profile");
        std::fs::write(dir.join("resist-ledger.json"), OTHER_CHARACTERS_LEDGER)
            .expect("the ledger is written");
        dir
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ignored = std::fs::remove_dir_all(&self.0);
    }
}

fn skip(message: &EngineMessage) {
    assert!(
        matches!(
            message,
            EngineMessage::Reply(_)
                | EngineMessage::ErrorReply(_)
                | EngineMessage::EpochMessage(_)
                | EngineMessage::ResetMessage(_)
                | EngineMessage::ModuleChangedMessage(_)
        ),
        "nothing else belongs on this stream: {message:?}"
    );
}

fn ask_health(client: &mut Client, id: i64) -> protocol::generated::HealthResult {
    client.send(&health(id));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::HealthResult(result) = reply.result else {
                    panic!("session.health answers with a HealthResult");
                };
                return result;
            }
            other => skip(&other),
        }
    }
}

fn settle_live(client: &mut Client, id: &mut i64) {
    let deadline = Instant::now() + PATIENCE;
    loop {
        *id += 1;
        if matches!(ask_health(client, *id).status, HealthResultStatus::Live) {
            return;
        }
        assert!(Instant::now() < deadline, "the fold never went live");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// How many distinct creatures the served resist ledger is about — the second of its two integers,
/// and the one that moves by exactly one when a bucket holding one unfamiliar mob is seeded.
fn resist_mobs(client: &mut Client, id: i64) -> i64 {
    client.send(&module_snapshot(id, "resist"));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::ModuleSnapshotResult(result) = reply.result else {
                    panic!("module.snapshot answers with a ModuleSnapshotResult");
                };
                return result.state["mobs"].as_i64().expect("a mob count");
            }
            other => skip(&other),
        }
    }
}

#[test]
fn an_attach_carrying_a_state_dir_seeds_the_served_fold_and_one_without_it_does_not() {
    let scratch = Scratch::new("wire");
    let log = scratch.stage_log();
    let profile = scratch.stage_profile();

    // THE APP'S ATTACH: log path AND profile directory. `a bat` appears nowhere in the fixture; it
    // is in the seeded ledger and nowhere else, so the mob count carries the seed's own evidence.
    let with_state = Engine::start();
    let mut client = with_state.connected();
    client.send(&attach_with_state(
        1,
        &log.to_string_lossy(),
        Some(&profile.to_string_lossy()),
    ));
    let mut id = 100;
    settle_live(&mut client, &mut id);
    id += 1;
    let seeded = resist_mobs(&mut client, id);

    // …and the SAME log, the same fixture, with no `stateDir` at all: the file-free attach every
    // other client makes and the one the equivalence oracle describes.
    let bare = Engine::start();
    let mut plain = bare.connected();
    plain.send(&attach(1, &log.to_string_lossy()));
    let mut plain_id = 200;
    settle_live(&mut plain, &mut plain_id);
    plain_id += 1;
    let unseeded = resist_mobs(&mut plain, plain_id);

    assert_eq!(
        seeded,
        unseeded + 1,
        "the seeded bucket contributes exactly the one creature the log never mentions"
    );

    // THE FILE IS NOT MOVED, RENAMED OR REWRITTEN by an attach. The write is on the sixtieth beat
    // and this test does not wait for one; what it pins is that reading a profile is a READ.
    assert_eq!(
        std::fs::read_to_string(profile.join("resist-ledger.json")).expect("readable"),
        OTHER_CHARACTERS_LEDGER
    );
}

#[test]
fn a_state_dir_that_does_not_exist_is_an_ordinary_attach() {
    // A PROFILE DIRECTORY THE APP NAMED BEFORE ELECTRON CREATED IT, or one on a volume that is not
    // mounted: every read failure is an EMPTY seed and the fold goes live regardless. A persisted
    // nicety may never be the reason a log does not get folded.
    let scratch = Scratch::new("missing");
    let log = scratch.stage_log();

    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach_with_state(
        1,
        &log.to_string_lossy(),
        Some("C:/nowhere/there-is-no-such-profile"),
    ));
    let mut id = 100;
    settle_live(&mut client, &mut id);
    id += 1;
    // It answers, which is the whole claim: nothing was seeded and nothing refused.
    resist_mobs(&mut client, id);
}
