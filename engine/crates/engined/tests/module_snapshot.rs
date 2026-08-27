//! THE FOLD SERVES, OVER A REAL SOCKET, AGAINST THE REAL BINARY (JOS-478).
//!
//! `src/foldsink.rs`'s own tests own what a fold sink IS; this suite owns what a CLIENT can get out
//! of one. Four claims, and they are different claims:
//!
//!   * after an attach lands, `module.snapshot` answers for every module in the registry, and the
//!     state it answers with is DEEP-EQUAL to what a direct `fold::Fold` of the same bytes
//!     publishes;
//!   * a snapshot asked for DURING the historical scan is answered — and the answer is a real
//!     PREFIX state: exactly the events up to the `seq` it names and no part of another, which is
//!     the whole claim the channel-not-a-lock design exists to make;
//!   * a module the registry does not carry is `notFound`, and a process with nothing attached is
//!     `unavailable` — two different sentences for two different situations;
//!   * `session.health` carries the MARK once the fold is live, and carries none of the four
//!     optional fields before an attach — including `logMtimeMs`, the FILE fact owner ruling 21
//!     made the server's to read: served true, refreshed per answer, and never the log's own clock.
//!
//! ── WHY THE ORACLE IS A SECOND FOLD AND NOT THE TS SNAPSHOTS ───────────────────────────────────
//!
//! This suite proves SELF-CONSISTENCY: that the path a client's request travels — socket, ops
//! table, channel, ingest thread, registry — hands back what the fold in that thread actually
//! holds. It does NOT re-prove the fold's semantics; `npm run oracle:rust-fold` does that against
//! the recorded TypeScript snapshots on six slices of the owner's real log, and re-litigating it
//! here over a 900 KB fixture would be a weaker copy of a stronger test.
//!
//! ── THE ONE CONSTRUCTION INPUT THE ORACLE CANNOT MATCH ─────────────────────────────────────────
//!
//! `construction_now_ms` is the ATTACH INSTANT engine-side (`foldsink.rs`'s header argues why that
//! is production-faithful) and the test's own `now` here, and the two are milliseconds apart. Only
//! `respawn` reads it — it seeds an ordering clock from it at `reset()` — so `respawn` is compared
//! for SHAPE rather than for equality, and named as the exception rather than quietly dropped from
//! the list. Every other module in `WIRING_ORDER` is compared whole.
//!
//! THE LOG IS A COPY OF A COMMITTED FIXTURE, staged under the product's own file-name shape.
//! Nothing here writes to a real game log.

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

/// How long a wait may take before the test is called hung. A FAILURE MECHANISM — every assertion
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

    /// Write the fixture into the scratch log, `repeats` times over.
    ///
    /// REPETITION IS SOUND because the parser holds no state across lines and the oracle folds THE
    /// SAME BYTES — whatever the repetition does to the fold, it does to both sides of the compare.
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

/// THE ORACLE: a fold of the same bytes, constructed the way `foldsink.rs` constructs one, stopped
/// after the event whose `seq` is `upto` (or run to the end when `upto` is `None`).
///
/// THE CONSTRUCTION IS RESTATED HERE, and that is a duplication worth naming: this test crate
/// cannot reach into the binary's own `foldsink` module, so the eight `ClusterDeps` fields are
/// spelled twice. What it buys is the thing being tested — that the ENGINE's fold, reached through
/// a socket and a channel, agrees with a fold built beside it. A change to the engine's
/// construction that this file does not follow shows up here as a divergence, which is the honest
/// failure for it to have.
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
/// A REPLY THIS HELPER IS NOT WAITING FOR IS FINE — the attach's own reply arrives whenever the
/// engine gets to it, and correlation by id is the protocol's whole answer to that. Progress frames,
/// the landing reset and — since JOS-487 — the module dirty bits are connection-wide and arrive on
/// their own schedule, which is exactly what lets these helpers be called mid-fold. A HELLO or a DIFF
/// here would be a real surprise.
///
/// THE DIRTY BIT IS THE MOST AT-HOME OF THEM IN THIS FILE, and it is worth saying why it is skipped
/// rather than asserted: it is the push that tells a client the very state these tests are PULLING,
/// so a suite about `module.snapshot` will see one of these for every module it asks about. What it
/// says is proven in `module_changed.rs`; here it is traffic.
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
    // THE ENGINE HAS TICKED AND THE ORACLE HAS NOT (JOS-481), so before comparing anything this
    // establishes that for THESE bytes the difference is no difference: a world aged to the host's
    // clock publishes exactly what an unaged one does. Asserted rather than assumed, because the
    // day a fixture ends with a buff standing or a spell-set burst open, the failure should name
    // the reason here instead of surfacing as a mystery divergence in the loop below.
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
            // Shape, not equality — see the file header. It still has to ANSWER, and with the two
            // fields the protocol promises.
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

    // …AND THE COUNT IS THE SCAN'S OWN. `loot` is a pure appender — its `seq` is the last event it
    // was handed — so it ties the module's hydration cursor to the number `eqlog`'s proven scan
    // finds in these exact bytes, which is what makes this an assertion rather than a tautology.
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
    // THE CLAIM THE WHOLE DESIGN EXISTS TO MAKE. The fold is never locked and never interrupted
    // mid-event: an ask is answered at a read boundary of the scan, so what comes back is the state
    // after some event N and before event N+1 — not a torn read, and not a copy of a state that has
    // since moved.
    //
    // A BIG ENOUGH LOG THAT THE SCAN IS STILL RUNNING when the question is asked, and no bigger.
    // The window is wide by construction rather than by luck: the snapshot door opens BEFORE the
    // first byte is folded, so every ask that is refused `unavailable` is the ingest still opening
    // the file, and the first one that is ANSWERED lands at the very start of the scan. The loop
    // below fails outright if the fold finished before it could catch one — a test that silently
    // degraded to "we asked after it landed" would prove nothing.
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

    // THE PROOF: fold the same bytes, stop at the seq the engine named, and the two states are the
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

    // NOTHING ATTACHED. There is no fold to ask, which is not the same thing as a module that does
    // not exist — a client told `notFound` here would go hunting for a typo in a perfectly good
    // name.
    let Answer::Refused(code) = ask(&mut client, 1, "loot") else {
        panic!("an engine with no fold cannot answer for a module");
    };
    assert!(matches!(code, ErrorCode::Unavailable), "{code:?}");

    let scratch = Scratch::new("unknown");
    let log = scratch.stage(1);
    client.send(&attach(2, &log.to_string_lossy()));
    let mut id = 100;
    settle_live(&mut client, &mut id);

    // NOW there is a registry, and it is the authority. `loot.ledger` is the trap worth pinning: it
    // is a VIEW source name, and confusing the two must be told rather than answered emptily.
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

    // BEFORE ANY ATTACH: absent, not zero. A fresh process has no coordinate, and publishing
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

    // ── THE FILE FACT (owner ruling 21, JOS-481) ─────────────────────────────────────────────
    //
    // THE SERVED ANSWER IS THE FILESYSTEM'S OWN, compared against a stat this test takes itself.
    // Not against a number typed here and not against `SystemTime::now()`: the claim is that the
    // engine reported the mtime OF THIS FILE, and only the file can settle that.
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
    // …AND IT IS NOT THE LOG'S OWN CLOCK. Two different kinds of fact share a health answer and a
    // reader must never be able to mistake one for the other: the fixture is dated in the log and
    // the scratch copy was written just now, so they cannot coincide.
    assert_ne!(
        live.log_mtime_ms,
        Some(stamp),
        "the file's stamp is not the log's last event"
    );

    // AND IT IS REFRESHED PER ANSWER, never remembered (ruling 5). The game writes a line; the very
    // next health answer says so, with no attach and no re-fold in between.
    let before = live.log_mtime_ms.expect("a served mtime");
    // The filesystem's granularity is coarser than this loop, so the append has to be worth a tick
    // of it. One sleep, and it is the resolution of a stat rather than a guess at a race.
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
