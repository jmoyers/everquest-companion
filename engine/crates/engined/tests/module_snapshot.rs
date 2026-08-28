//! The fold serves, over a real socket, against the real binary: `module.snapshot` for every module
//! in the registry, a mid-scan snapshot that is a real prefix state, `notFound` and `unavailable` as
//! two different sentences, and `session.health`'s mark and its four optional fields.
//!
//! The oracle is a second fold of the same bytes rather than the recorded TypeScript, because the
//! claim is self-consistency: the path a request travels — socket, ops table, channel, ingest
//! thread, registry — hands back what the fold in that thread actually holds. Fold semantics are
//! `npm run oracle:rust-fold`'s job.
//!
//! `construction_now_ms` is the one construction input the oracle cannot match (the engine's attach
//! instant against this test's `now`). Only `respawn` reads it, so `respawn` is compared for shape
//! and every other module in `WIRING_ORDER` is compared whole.

mod harness;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use harness::{attach, health, module_snapshot, Client, Engine};
use protocol::generated::{
    EngineMessage, ErrorCode, HealthResultStatus, ModuleSnapshotResult, ReplyResult,
};

const FIXTURE: &str = "cw2-loadout-swap-aug2.log";

/// How long a wait may take before the test is called hung. A failure mechanism — every assertion
/// here waits for a condition, never for the clock.
const PATIENCE: Duration = Duration::from_secs(120);

/// The one module whose state the oracle cannot reproduce, and why. See the file header.
const SEEDED_FROM_THE_CONSTRUCTION_CLOCK: &str = "respawn";

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
            "engined-snapshot-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        Self(dir)
    }

    /// Write the fixture into the scratch log, `repeats` times over. Repetition is sound: the parser
    /// holds no state across lines and the oracle folds the same bytes.
    fn stage(&self, repeats: usize) -> PathBuf {
        let source = repo_root().join("tests").join("fixtures").join(FIXTURE);
        let bytes = std::fs::read(&source)
            .unwrap_or_else(|e| panic!("the fixture at {} is readable: {e}", source.display()));
        let path = self.0.join("eqlog_Primitive_freeport.txt");
        let mut out = std::fs::File::create(&path).expect("the scratch log");
        for _ in 0..repeats {
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

/// A fold of the same bytes, constructed the way `foldsink.rs` constructs one, stopped after the
/// event whose `seq` is `upto` (or run to the end when `upto` is `None`).
///
/// The construction is restated because this test crate cannot reach into the binary's own
/// `foldsink` module. A change to the engine's construction that this file does not follow shows up
/// as a divergence, which is the honest failure for it to have.
fn oracle(log: &Path, bytes: &[u8], upto: Option<i64>) -> fold::Fold {
    let parser = eqlog::parser_for("Primitive", eqlog::host_timezone());
    let db = parser.spell_db().expect("the parser carries the catalog");
    let launch_ms = fold::epoch::launch_ms(parser.clock());
    let deps = fold::ClusterDeps {
        known_spell: db.keys().map(str::to_string).collect(),
        spell_classes: fold::modules::combo::evidence::spell_class_index(db),
        facts: fold::spell_facts::SpellFacts::project(db),
        launch_ms,
        construction_now_ms: now_ms(),
        character: Some(serde_json::json!({
            "name": "Primitive",
            "server": "freeport",
            "logPath": log.to_string_lossy(),
        })),
        self_name: None,
        respawn_prefs: fold::modules::respawn::RespawnPrefs::default(),
    };
    let mut folder = fold::Fold::new(fold::registered(deps), launch_ms);
    eqlog::scan::scan_bytes(&parser, bytes, |line, _payload| {
        let Some(ev) = fold::event::Event::from_json(line) else {
            return;
        };
        if upto.is_some_and(|last| ev.seq() > last) {
            return;
        }
        folder.on_primary(&ev, false);
    });
    folder
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("a clock after 1970")
            .as_millis(),
    )
    .expect("an instant that fits")
}

/// Ask for one module and take whichever answer arrives.
enum Answer {
    Snapshot(ModuleSnapshotResult),
    Refused(ErrorCode),
}

fn ask(client: &mut Client, id: i64, module: &str) -> Answer {
    client.send(&module_snapshot(id, module));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::ModuleSnapshotResult(result) = reply.result else {
                    panic!("module.snapshot answers with a ModuleSnapshotResult");
                };
                return Answer::Snapshot(result);
            }
            EngineMessage::ErrorReply(err) if *err.id == id => {
                return Answer::Refused(err.error.code)
            }
            other => skip(&other),
        }
    }
}

/// Everything that can legitimately arrive on this connection while a request is outstanding, and
/// nothing else.
///
/// A reply this helper is not waiting for is fine: correlation by id is the protocol's answer to
/// that. Progress frames, the landing reset and the module dirty bits are connection-wide and arrive
/// on their own schedule, which is what lets these helpers be called mid-fold. The dirty bit is the
/// push that tells a client the state these tests pull; what it says is proven in
/// `module_changed.rs`, and here it is traffic.
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

fn snapshot(client: &mut Client, id: i64, module: &str) -> ModuleSnapshotResult {
    match ask(client, id, module) {
        Answer::Snapshot(result) => result,
        Answer::Refused(code) => panic!("{module} was refused: {code:?}"),
    }
}

/// The health answer, over an established connection.
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

/// Wait until the fold is live, failing rather than hanging if it never is.
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

#[test]
fn every_module_answers_what_a_direct_fold_of_the_same_bytes_publishes() {
    let scratch = Scratch::new("equal");
    let log = scratch.stage(2);
    let bytes = std::fs::read(&log).expect("the staged log is readable");

    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &log.to_string_lossy()));
    let mut id = 100;
    settle_live(&mut client, &mut id);

    let wanted = oracle(&log, &bytes, None);
    // The engine has ticked and the oracle has not, so this first establishes that for these bytes
    // the difference is no difference: a world aged to the host's clock publishes what an unaged one
    // does. Asserted rather than assumed, so a tick-sensitive fixture fails here by name rather than
    // as a mystery divergence in the loop below.
    {
        let mut aged = oracle(&log, &bytes, None);
        let before = aged.registry.snapshots();
        aged.tick(now_ms());
        assert_eq!(
            before,
            aged.registry.snapshots(),
            "this fixture's end state IS tick-sensitive, so the engine's go-live sweep and the \
             oracle's absence of one are no longer the same world — the comparison below needs a \
             ticked oracle, or a fixture whose tail settles"
        );
    }
    let mut compared = 0;
    for module in fold::WIRING_ORDER {
        id += 1;
        let got = snapshot(&mut client, id, module);
        assert_eq!(&got.module, module, "the answer names what was asked");
        let published = wanted
            .registry
            .snapshot_of(module)
            .unwrap_or_else(|| panic!("the oracle registered {module}"));

        if *module == SEEDED_FROM_THE_CONSTRUCTION_CLOCK {
            // Shape, not equality — see the file header. It still has to answer.
            assert!(got.state.is_object() || got.state.is_array());
            continue;
        }
        assert_eq!(
            got.state, published["state"],
            "{module} diverged between the engine's fold and a direct one"
        );
        assert_eq!(
            got.seq, published["seq"],
            "{module} published a different seq than a direct fold"
        );
        compared += 1;
    }
    assert_eq!(
        compared,
        fold::WIRING_ORDER.len() - 1,
        "every module but the one named exception was compared whole"
    );

    // …and the count is the scan's own. `loot` is a pure appender — its `seq` is the last event it
    // was handed — so this ties the module's hydration cursor to the number the proven scan finds in
    // these exact bytes, rather than to itself.
    let folded = i64::try_from(wanted.events()).expect("a count");
    let scanned = {
        let parser = eqlog::parser_for("Primitive", eqlog::host_timezone());
        i64::try_from(eqlog::scan::scan_bytes(
            &parser,
            &bytes,
            |_line, _payload| {},
        ))
        .expect("a count")
    };
    assert_eq!(folded, scanned, "the fold took every event the scan found");
    id += 1;
    assert_eq!(
        snapshot(&mut client, id, "loot").seq,
        scanned - 1,
        "seq counts from zero, so the last event of {scanned} is {}",
        scanned - 1
    );
}

#[test]
fn a_snapshot_taken_mid_fold_is_a_real_prefix_state() {
    // The claim the whole design exists to make: the fold is never locked and never interrupted
    // mid-event, so an ask answered at a read boundary of the scan comes back as the state after
    // some event N and before N+1 — not a torn read, not a state that has since moved.
    //
    // The log must be big enough that the scan is still running when the question is asked. The
    // snapshot door opens before the first byte is folded, so every `unavailable` refusal is the
    // ingest still opening the file and the first answer lands at the start of the scan. The loop
    // fails outright if the fold finished first, since degrading to asking afterwards proves nothing.
    let scratch = Scratch::new("midfold");
    let log = scratch.stage(8);
    let bytes = std::fs::read(&log).expect("the staged log is readable");
    let whole = {
        let parser = eqlog::parser_for("Primitive", eqlog::host_timezone());
        i64::try_from(eqlog::scan::scan_bytes(
            &parser,
            &bytes,
            |_line, _payload| {},
        ))
        .expect("a count")
    };

    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &log.to_string_lossy()));

    let deadline = Instant::now() + PATIENCE;
    let mut id = 100;
    let mid = loop {
        assert!(Instant::now() < deadline, "the engine never answered");
        id += 1;
        match ask(&mut client, id, "loot") {
            // The ingest is still opening the log and building the parse's inputs. There is no
            // fold to ask yet, and saying so is the honest answer rather than a wait.
            Answer::Refused(ErrorCode::Unavailable) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Answer::Refused(code) => panic!("loot was refused: {code:?}"),
            Answer::Snapshot(got) => {
                assert!(
                    got.seq < whole - 1,
                    "the fold finished before a mid-scan question could be asked (seq {} of \
                     {whole}) — stage a bigger log",
                    got.seq
                );
                break got;
            }
        }
    };
    assert!(mid.seq >= 0, "a prefix names a real event: {}", mid.seq);

    // The proof: fold the same bytes, stop at the seq the engine named, and the two states are the
    // same object. Anything torn, stale or mid-event fails here.
    let prefix = oracle(&log, &bytes, Some(mid.seq));
    let published = prefix
        .registry
        .snapshot_of("loot")
        .expect("the oracle registered loot");
    assert_eq!(
        mid.state, published["state"],
        "the mid-fold answer is not the prefix state at seq {}",
        mid.seq
    );
    assert_eq!(mid.seq, published["seq"]);

    // …and the fold carries on afterwards, which is the other half of "the read did not disturb it".
    let mut later = id;
    settle_live(&mut client, &mut later);
    later += 1;
    assert_eq!(snapshot(&mut client, later, "loot").seq, whole - 1);
}

#[test]
fn an_unknown_module_is_not_found_and_an_unattached_engine_is_unavailable() {
    let engine = Engine::start();
    let mut client = engine.connected();

    // Nothing attached: there is no fold to ask, which is not the same thing as a module that does
    // not exist. A client told `notFound` here would hunt for a typo in a perfectly good name.
    let Answer::Refused(code) = ask(&mut client, 1, "loot") else {
        panic!("an engine with no fold cannot answer for a module");
    };
    assert!(matches!(code, ErrorCode::Unavailable), "{code:?}");

    let scratch = Scratch::new("unknown");
    let log = scratch.stage(1);
    client.send(&attach(2, &log.to_string_lossy()));
    let mut id = 100;
    settle_live(&mut client, &mut id);

    // Now there is a registry and it is the authority. `loot.ledger` is the trap worth pinning: it
    // is a view source name, and confusing the two must be told rather than answered emptily.
    for name in ["loot.ledger", "combat", "", "Loot"] {
        id += 1;
        let Answer::Refused(code) = ask(&mut client, id, name) else {
            panic!("{name:?} is not a module and must not answer");
        };
        assert!(matches!(code, ErrorCode::NotFound), "{name:?}: {code:?}");
    }
    // …and the connection is still a conversation afterwards.
    id += 1;
    assert_eq!(snapshot(&mut client, id, "loot").module, "loot");
}

#[test]
fn health_carries_the_mark_once_the_fold_is_live() {
    let engine = Engine::start();
    let mut client = engine.connected();

    // Before any attach: absent, not zero. A fresh process has no coordinate, and publishing
    // `offset: 0` would be a measurement nobody took.
    let fresh = ask_health(&mut client, 1);
    assert!(matches!(fresh.status, HealthResultStatus::Idle));
    assert!(fresh.mark.is_none());
    assert!(fresh.events.is_none());
    assert!(fresh.last_event_ts.is_none());
    assert!(
        fresh.log_mtime_ms.is_none(),
        "a process with no log has no file to stat — absent, never zero"
    );

    let scratch = Scratch::new("mark");
    let log = scratch.stage(2);
    let bytes = std::fs::read(&log).expect("the staged log is readable");
    let scanned = {
        let parser = eqlog::parser_for("Primitive", eqlog::host_timezone());
        i64::try_from(eqlog::scan::scan_bytes(
            &parser,
            &bytes,
            |_line, _payload| {},
        ))
        .expect("a count")
    };

    client.send(&attach(2, &log.to_string_lossy()));
    let mut id = 100;
    settle_live(&mut client, &mut id);

    id += 1;
    let live = ask_health(&mut client, id);
    let mark = live.mark.expect("a live fold has a mark");
    assert_eq!(
        mark.log,
        log.to_string_lossy(),
        "the mark names the log the app handed over, verbatim"
    );
    assert_eq!(
        mark.offset,
        i64::try_from(bytes.len()).expect("a length"),
        "the fixture ends on a newline, so THE MARK reaches the last byte"
    );
    assert_eq!(
        live.events,
        Some(scanned),
        "the count is the one the proven scan finds in these bytes"
    );
    let stamp = live.last_event_ts.expect("the log's own clock");
    assert!(stamp > 0, "the LOG's clock, never the host's: {stamp}");

    // The served mtime is the filesystem's own, compared against a stat this test takes itself: the
    // claim is that the engine reported the mtime of this file, and only the file can settle that.
    let stat = std::fs::metadata(&log).expect("the staged log");
    let truth = i64::try_from(
        stat.modified()
            .expect("a modification time")
            .duration_since(std::time::UNIX_EPOCH)
            .expect("a stamp past the epoch")
            .as_millis(),
    )
    .expect("an instant");
    assert_eq!(
        live.log_mtime_ms,
        Some(truth),
        "the engine stats the log it owns and serves what the filesystem says"
    );
    // …and it is not the log's own clock: two kinds of fact share a health answer and a reader must
    // not be able to mistake one for the other.
    assert_ne!(
        live.log_mtime_ms,
        Some(stamp),
        "the file's stamp is not the log's last event"
    );

    // And it is refreshed per answer, never remembered: the game writes a line and the very next
    // health answer says so, with no attach and no re-fold in between.
    let before = live.log_mtime_ms.expect("a served mtime");
    // The filesystem's mtime granularity is coarser than this loop, so the append has to be worth a
    // tick of it.
    std::thread::sleep(Duration::from_millis(20));
    {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&log)
            .expect("the staged log takes an append");
        file.write_all(b"[Wed Aug 19 16:21:54 2026] You gain experience! (3.288%)\n")
            .expect("append");
        file.flush().expect("flush");
    }
    let deadline = Instant::now() + PATIENCE;
    let after = loop {
        id += 1;
        let seen = ask_health(&mut client, id)
            .log_mtime_ms
            .expect("a served mtime");
        if seen > before {
            break seen;
        }
        assert!(
            Instant::now() < deadline,
            "the served mtime never moved after the file did"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(after > before, "{after} is not later than {before}");
}
