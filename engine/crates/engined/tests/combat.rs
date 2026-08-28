//! The combat surface over a real socket off a real fold: the ops `combat.snapshot` and
//! `combat.searchFights`, and the view source `combat.live`.
//!
//! The log is written here and stamped with this machine's clock, unlike every other suite in this
//! crate. Two claims below turn on the difference between a replay's instant and a live world's, and
//! a fight dated in a committed fixture would produce a meter whose every rate had been divided by
//! its staleness. The weekday in an EQ stamp is not parsed, so `Wed` is written and means nothing.
//!
//! One claim uses a committed fixture instead: catching an answer mid-fold needs a log big enough
//! that the scan is still running when the question is asked.
//!
//! What no unit test can claim: the answers came off the fold on the ingest thread through the one
//! door, `now` is chosen by the world's own state rather than by the caller, and a live window over
//! a source whose rows edit produces `update` ops carrying changed cells only.

mod harness;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use harness::{attach, combat_snapshot, health, search_fights, subscribe, Client, Engine};
use protocol::generated::{
    CombatSearchFightsResult, CombatSnapshotOpts, CombatSnapshotResult, DiffOp, EngineMessage,
    ErrorCode, ReplyResult, Row,
};

/// How long a wait may take before the test is called hung. A failure mechanism — every assertion
/// waits for a condition, never for the clock.
const PATIENCE: Duration = Duration::from_secs(120);

/// The mob every fight below is against. Two words, so a two-token query is a real coverage test.
const MOB: &str = "a fire giant warlord";

/// A scratch directory holding one log named the way the product names one.
struct Staged {
    dir: PathBuf,
    /// The wall clock the first line was stamped with. Every later line is an offset from it, so
    /// the log's own span is known to the second without re-reading the file.
    started_ms: i64,
    clock: eqlog::Clock,
}

impl Staged {
    /// A session still going on. Eight seconds back is pinned from both sides: the lines are written
    /// seconds apart in log time, so the session must start far enough back that its last line is
    /// not stamped ahead of now; and a fight whose mob has not been seen for `PRESENCE_GONE_MS`
    /// (20 s) is over, which would close the live fight this suite is about.
    fn new(tag: &str) -> Self {
        Staged::aged(tag, 8_000)
    }

    /// A session that stopped: every line minutes old, the way a log looks when the player walked
    /// away or the fight is long finished.
    fn stale(tag: &str) -> Self {
        Staged::aged(tag, 180_000)
    }

    fn aged(tag: &str, back_ms: i64) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-combat-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        Self {
            dir,
            started_ms: wall_clock_ms() - back_ms,
            clock: eqlog::Clock::new(eqlog::host_timezone()),
        }
    }

    fn log(&self) -> PathBuf {
        self.dir.join("eqlog_Primitive_freeport.txt")
    }

    /// One EQ-stamped line, `after` seconds into the session.
    fn line(&self, after: i64, text: &str) -> String {
        let civil = self
            .clock
            .civil(self.started_ms + after * 1000)
            .expect("this machine's clock is a date");
        const MONTHS: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let month = MONTHS[(civil.month as usize).saturating_sub(1).min(11)];
        format!(
            "[Wed {month} {day:02} {hour:02}:{minute:02}:{second:02} {year}] {text}\n",
            day = civil.day,
            hour = civil.hour,
            minute = civil.minute,
            second = civil.second,
            year = civil.year
        )
    }

    /// Append the way EverQuest appends: an open, a write, a flush. One write for whatever is handed
    /// over, so several lines that land together land in one tail poll.
    fn append(&self, text: &str) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log())
            .expect("the log takes an append");
        file.write_all(text.as_bytes()).expect("append");
        file.flush().expect("flush");
    }

    /// The session this suite folds: a zone line, then one fight against [`MOB`] that you and one
    /// other combatant the log names are both hitting.
    ///
    /// The zone line comes first so the character-rebirth boundary fires before there is a fight to
    /// lose, which is also what a real log opened today does by itself.
    fn stage_a_fight(&self) {
        let mut text = self.line(0, "You have entered Nagafen's Lair.");
        text.push_str(&self.line(2, &format!("You slash {MOB} for 155 points of damage.")));
        text.push_str(&self.line(4, &format!("You slash {MOB} for 240 points of damage.")));
        text.push_str(&self.line(5, &format!("Rowel slashes {MOB} for 60 points of damage.")));
        text.push_str(&self.line(6, &format!("You slash {MOB} for 105 points of damage.")));
        self.append(&text);
    }

    /// Write the committed fixture into the scratch log, `repeats` times over — the only way to make
    /// a scan long enough to be caught mid-flight. Repetition is sound because the parser holds no
    /// state across lines.
    fn stage_the_fixture(&self, repeats: usize) -> PathBuf {
        let source = repo_root()
            .join("tests")
            .join("fixtures")
            .join("cw2-loadout-swap-aug2.log");
        let bytes = std::fs::read(&source)
            .unwrap_or_else(|e| panic!("the fixture at {} is readable: {e}", source.display()));
        let path = self.log();
        let mut out = std::fs::File::create(&path).expect("the scratch log");
        for _ in 0..repeats {
            out.write_all(&bytes).expect("the scratch log takes bytes");
        }
        out.flush().expect("flush");
        path
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ignored = std::fs::remove_dir_all(&self.dir);
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is three levels below the repo root")
        .to_path_buf()
}

fn wall_clock_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("a clock after 1970")
            .as_millis(),
    )
    .expect("an instant that fits")
}

/// What an ask came back as. A refusal is an answer here, not a panic: half of what this suite
/// proves is which refusal a client gets and when.
enum Answer<T> {
    Got(T),
    Refused(ErrorCode),
}

/// Everything that can legitimately arrive while a request is outstanding — progress frames, another
/// subscription's reset, a module's dirty bit — none of which is this suite's subject.
fn skip(message: &EngineMessage) {
    assert!(
        matches!(
            message,
            EngineMessage::Reply(_)
                | EngineMessage::ErrorReply(_)
                | EngineMessage::EpochMessage(_)
                | EngineMessage::ResetMessage(_)
                | EngineMessage::DiffMessage(_)
                | EngineMessage::ModuleChangedMessage(_)
        ),
        "nothing else belongs on this stream: {message:?}"
    );
}

fn ask_snapshot(
    client: &mut Client,
    id: i64,
    opts: Option<CombatSnapshotOpts>,
) -> Answer<CombatSnapshotResult> {
    client.send(&combat_snapshot(id, opts));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::CombatSnapshotResult(result) = reply.result else {
                    panic!("combat.snapshot answers with a CombatSnapshotResult");
                };
                return Answer::Got(result);
            }
            EngineMessage::ErrorReply(err) if *err.id == id => {
                return Answer::Refused(err.error.code)
            }
            other => skip(&other),
        }
    }
}

fn ask_search(
    client: &mut Client,
    id: i64,
    query: &str,
    limit: Option<i64>,
) -> Answer<CombatSearchFightsResult> {
    client.send(&search_fights(id, query, limit));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::CombatSearchFightsResult(result) = reply.result else {
                    panic!("combat.searchFights answers with a CombatSearchFightsResult");
                };
                return Answer::Got(result);
            }
            EngineMessage::ErrorReply(err) if *err.id == id => {
                return Answer::Refused(err.error.code)
            }
            other => skip(&other),
        }
    }
}

/// Wait for the fold to land, then answer. Every test but the mid-fold one starts here.
fn live_client(engine: &Engine, staged: &Staged) -> Client {
    let mut client = engine.connected();
    client.send(&attach(1, &staged.log().to_string_lossy()));
    let deadline = Instant::now() + PATIENCE;
    let mut id = 1000;
    loop {
        assert!(Instant::now() < deadline, "the fold never went live");
        id += 1;
        client.send(&health(id));
        let status = loop {
            match client.recv() {
                EngineMessage::Reply(reply) if *reply.id == id => {
                    let ReplyResult::HealthResult(health) = reply.result else {
                        panic!("session.health answers with a HealthResult");
                    };
                    break health.status;
                }
                other => skip(&other),
            }
        };
        if matches!(status, protocol::generated::HealthResultStatus::Live) {
            return client;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn snapshot(
    client: &mut Client,
    id: i64,
    opts: Option<CombatSnapshotOpts>,
) -> CombatSnapshotResult {
    match ask_snapshot(client, id, opts) {
        Answer::Got(result) => result,
        Answer::Refused(code) => panic!("combat.snapshot was refused: {code:?}"),
    }
}

fn search(
    client: &mut Client,
    id: i64,
    query: &str,
    limit: Option<i64>,
) -> CombatSearchFightsResult {
    match ask_search(client, id, query, limit) {
        Answer::Got(result) => result,
        Answer::Refused(code) => panic!("combat.searchFights was refused: {code:?}"),
    }
}

/// `fold::combat::SnapshotOpts::full()`, spelled on the wire.
fn full() -> CombatSnapshotOpts {
    CombatSnapshotOpts {
        selected_id: None,
        show_unparsed: Some(true),
        max_segments: Some(100_000),
        timeline: Some(true),
    }
}

fn cell(row: &Row, name: &str) -> serde_json::Value {
    row.cells
        .get(name)
        .unwrap_or_else(|| panic!("the row carries a {name} cell: {:?}", row.cells))
        .as_json()
        .clone()
}

#[test]
fn a_world_with_no_fold_has_no_meter_and_says_so() {
    // `unavailable` and not `notFound`: the request names nothing that could be misspelled. The same
    // answer covers a fold that never attached and one that carries no combat engine.
    let engine = Engine::start();
    let mut client = engine.connected();
    let Answer::Refused(code) = ask_snapshot(&mut client, 1, None) else {
        panic!("a world with nothing attached has no meter to read");
    };
    assert!(matches!(code, ErrorCode::Unavailable));

    // …and the connection survives it: a refused request is not a broken conversation.
    let Answer::Refused(again) = ask_search(&mut client, 2, "anything", None) else {
        panic!("and neither has it a history to search");
    };
    assert!(matches!(again, ErrorCode::Unavailable));
}

#[test]
fn a_live_meter_is_stamped_with_the_engines_own_clock_and_agrees_with_a_second_fold() {
    // The self-consistency claim: fold the same bytes beside the engine, take the snapshot at the
    // instant the engine said it used, and the two are the same object. Socket, op table, channel,
    // ingest thread and combat engine hand back what the fold in that thread actually holds.
    let staged = Staged::new("live");
    staged.stage_a_fight();
    let engine = Engine::start();
    let mut client = live_client(&engine, &staged);

    let answer = snapshot(&mut client, 2, Some(full()));

    // The instant is the process's own, because the tail is running: later than every line in the
    // log, which is the whole difference from the mid-fold answer below.
    let now = answer.now;
    assert!(
        now >= staged.started_ms,
        "a live meter is stamped after the session started: {now} vs {}",
        staged.started_ms
    );
    assert!(
        (now - wall_clock_ms()).abs() < 60_000,
        "a live meter is stamped with THIS machine's clock: {now}"
    );

    let oracle = fold_beside(&staged.log());
    let mine = oracle
        .combat
        .as_ref()
        .expect("the oracle carries a combat engine")
        .snapshot(
            now,
            &fold::combat::SnapshotOpts::full(),
            oracle.registry.roster(),
        );
    assert_eq!(
        serde_json::Value::Object(answer.snapshot.0.clone()),
        mine,
        "the engine's meter is not the fold's meter"
    );

    // …and the rows are the ones the log stated: you at 500, the other combatant at 60.
    let entities = &mine["selected"]["entities"];
    assert_eq!(
        entities[0]["name"], "You",
        "the row is labelled the way the log names you"
    );
    assert_eq!(entities[0]["total"], 500);
    assert_eq!(entities[1]["name"], "Rowel");
    assert_eq!(entities[1]["total"], 60);
    // …and the meter is live, which is the flag and the four sweeps together: the tail's go-live
    // beat calls `set_live()`, and every answer past it ages the model at the instant it was asked
    // for. The fight above is still open because the log is still talking.
    assert_eq!(answer.snapshot["hydrating"], serde_json::json!(false));
    assert_eq!(mine["segments"][0]["kind"], "current");
    // A nudge is absent, not null: the key is dropped in every state but the armed one.
    assert!(
        answer.snapshot.0.get("petNudge").is_none(),
        "no summon, no nudge"
    );
}

#[test]
fn a_live_meter_closes_a_fight_the_log_stopped_talking_about() {
    // The sweep end to end over the socket: the go-live beat reached the combat engine inside the
    // ingest thread, and a snapshot taken afterwards evaluated deferred closure at the wall clock it
    // was answered at.
    //
    // The session is three minutes old and nothing killed the mob, so the fight can only end on
    // elapsed time — the mob unseen for `PRESENCE_GONE_MS` past the linger. No byte of this log says
    // the fight is over; the clock does.
    let staged = Staged::stale("stale");
    staged.stage_a_fight();
    let engine = Engine::start();
    let mut client = live_client(&engine, &staged);

    let answer = snapshot(&mut client, 2, Some(full()));
    assert_eq!(answer.snapshot["hydrating"], serde_json::json!(false));
    assert_eq!(
        answer.snapshot["segments"][0]["kind"],
        serde_json::json!("fight"),
        "a poll past every deadline finalizes the fight: {:?}",
        answer.snapshot["segments"][0]
    );
    assert_eq!(answer.snapshot["inCombat"], serde_json::json!(false));
    // Finalized at the fight's own clock, never the poll's: the span is the four seconds the log
    // describes rather than the three minutes since.
    assert_eq!(
        answer.snapshot["segments"][0]["total"],
        serde_json::json!(560)
    );
    assert_eq!(
        answer.snapshot["segments"][0]["durationSec"],
        serde_json::json!(4.0)
    );
    // …and nothing is in front of you any more, which is the half of the sweep the header pill reads.
    assert!(
        answer.snapshot.0.get("currentTarget").is_none(),
        "a fight that just closed reports no target"
    );
    // The same bytes folded beside it and handed the same instant agree, closure included: the sweep
    // is a function of `now` and the fold and of nothing else.
    let oracle = fold_beside(&staged.log());
    let mine = oracle
        .combat
        .as_ref()
        .expect("the oracle carries a combat engine")
        .snapshot(
            answer.now,
            &fold::combat::SnapshotOpts::full(),
            oracle.registry.roster(),
        );
    assert_eq!(serde_json::Value::Object(answer.snapshot.0.clone()), mine);
}

#[test]
fn a_session_mark_splits_the_live_meter_over_the_socket() {
    // An accepted press does the thing end to end: through the op table, the write door and the
    // ingest thread into the combat engine's records. The press lands between two fights, so the
    // meter must disagree with itself either side of it — one live stay holding 500 before, a frozen
    // `closedBy: 'mark'` record plus a live stay that started over after.
    let staged = Staged::new("mark-split");
    staged.stage_a_fight();
    let engine = Engine::start();
    let mut client = live_client(&engine, &staged);

    let before = snapshot(&mut client, 2, Some(full()));
    assert_eq!(
        before.snapshot["zoneSessions"]
            .as_array()
            .expect("zoneSessions")
            .len(),
        1,
        "one live stay and no frozen records yet: {:?}",
        before.snapshot["zoneSessions"]
    );
    assert_eq!(
        before.snapshot["zoneSessions"][0]["total"],
        serde_json::json!(560)
    );

    client.send(&harness::session_mark(3, wall_clock_ms()));
    let ack = loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == 3 => {
                let ReplyResult::SessionMarkAck(ack) = reply.result else {
                    panic!("sessionMarks.add answers a SessionMarkAck");
                };
                break ack;
            }
            other => skip(&other),
        }
    };
    assert!(ack.accepted, "a live world takes the press");

    // The ack is the receipt for the act, not for the queueing: the split is already in a snapshot
    // asked for immediately afterwards. That is what the bounded wait in `World::session_mark` buys.
    let after = snapshot(&mut client, 4, Some(full()));
    let stays = after.snapshot["zoneSessions"]
        .as_array()
        .expect("zoneSessions");
    assert_eq!(
        stays.len(),
        2,
        "the live stay plus one frozen record: {stays:?}"
    );
    assert_eq!(stays[0]["live"], serde_json::json!(true));
    assert_eq!(
        stays[0]["total"],
        serde_json::json!(0),
        "the new stay starts over"
    );
    assert_eq!(stays[1]["closedBy"], serde_json::json!("mark"));
    assert_eq!(stays[1]["total"], serde_json::json!(560));
    // …and the room did not change, which is the difference between a mark and a zone line.
    assert_eq!(after.snapshot["zone"], serde_json::json!("Nagafen's Lair"));
    assert_eq!(stays[0]["zone"], serde_json::json!("Nagafen's Lair"));
    assert_eq!(stays[1]["zone"], serde_json::json!("Nagafen's Lair"));
}

#[test]
fn a_snapshot_taken_mid_fold_is_stamped_with_the_logs_own_clock() {
    // A replay is not a moment in time. A poll landing between two replay slices used to finalize
    // whatever fight was open and hand the rest to a fresh encounter — measured, one 53,577-damage
    // fight splitting into 43,504 + 10,073. So a mid-fold snapshot is stamped with the fold's own
    // last timestamp, inside the log's span and nowhere near this machine's clock.
    //
    // The log must be big enough that the scan is still running; the loop fails outright if the fold
    // finished first, since a test that degraded to asking after it landed would assert the
    // opposite of what it claims.
    let staged = Staged::new("midfold");
    let log = staged.stage_the_fixture(8);
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &log.to_string_lossy()));

    let deadline = Instant::now() + PATIENCE;
    let mut id = 100;
    let mid = loop {
        assert!(Instant::now() < deadline, "the engine never answered");
        id += 1;
        match ask_snapshot(&mut client, id, None) {
            // The ingest is still opening the log and building the parse's inputs.
            Answer::Refused(ErrorCode::Unavailable) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Answer::Refused(code) => panic!("combat.snapshot was refused: {code:?}"),
            Answer::Got(got) => break got,
        }
    };

    // The fixture's last line is in the past, so a wall-clock stamp would be hours or weeks ahead of
    // it. The margin is a day rather than a millisecond so the suite does not depend on how recently
    // the fixture was recorded.
    let ahead = wall_clock_ms() - mid.now;
    assert!(
        ahead > 86_400_000,
        "a mid-fold answer is stamped with the LOG's clock, not this machine's: {} ms apart",
        ahead
    );
    // …and it is a real instant off a real line rather than a zero: the fixture's own span.
    assert!(mid.now > 1_700_000_000_000, "a folded log has a clock");
    assert_eq!(
        mid.snapshot["hydrating"],
        serde_json::json!(true),
        "the scan has not handed over"
    );
}

/// A second fold of the same bytes, constructed the way `crate::foldsink` constructs one.
///
/// The construction is restated because a test crate cannot reach into the binary's own module. A
/// change to the engine's construction that this file does not follow shows up as a divergence.
///
/// `construction_now_ms` is the one input that cannot be reproduced exactly (it is the engine's
/// attach instant); it seeds `respawn`'s ordering clock, which the combat engine never reads.
fn fold_beside(log: &Path) -> fold::Fold {
    let bytes = std::fs::read(log).expect("the staged log is readable");
    let parser = eqlog::parser_for("Primitive", eqlog::host_timezone());
    let db = parser.spell_db().expect("the parser carries the catalog");
    let launch_ms = fold::epoch::launch_ms(parser.clock());
    let deps = fold::ClusterDeps {
        known_spell: db.keys().map(str::to_string).collect(),
        spell_classes: fold::modules::combo::evidence::spell_class_index(db),
        facts: fold::spell_facts::SpellFacts::project(db),
        launch_ms,
        construction_now_ms: wall_clock_ms(),
        character: Some(serde_json::json!({
            "name": "Primitive",
            "server": "freeport",
            "logPath": log.to_string_lossy(),
        })),
        self_name: None,
        respawn_prefs: fold::modules::respawn::RespawnPrefs::default(),
    };
    let mut engine = fold::combat::CombatEngine::new();
    engine.reset();
    engine.set_player_name("Primitive");
    let mut folder = fold::Fold::new(fold::registered(deps), launch_ms).with_combat(engine);
    folder.fold_bytes(&parser, &bytes);
    // …and then the handover, because `FoldSink::tick` calls `set_live()` on its go-live beat. A
    // second fold that skipped it would be a replay compared to a live world: `hydrating: true` and
    // no snapshot-time sweeps, a difference in every field a closed fight touches.
    if let Some(combat) = folder.combat.as_mut() {
        combat.set_live();
    }
    folder
}

#[test]
fn a_fight_is_findable_by_the_mob_and_the_zone_even_typed_badly() {
    let staged = Staged::new("search");
    staged.stage_a_fight();
    let engine = Engine::start();
    let mut client = live_client(&engine, &staged);

    // The open fight is in the corpus as `kind: "current"`, which is why a search finds the mob you
    // are presently swinging at.
    let found = search(&mut client, 2, "fire giant", None);
    assert_eq!(found.corpus, 1, "one open fight and no finalized ones");
    assert_eq!(found.hits.len(), 1);
    assert_eq!(found.hits[0].summary["kind"], "current");
    assert_eq!(found.hits[0].summary["name"], MOB);

    // The typo path: `giatn` is a transposition and `nagafn` a deletion, both inside the edit
    // budget, and the zone half of the haystack is what makes the second findable at all.
    let typo = search(&mut client, 3, "fire giatn", None);
    assert_eq!(typo.hits.len(), 1, "a transposition is one edit");
    let zone = search(&mut client, 4, "nagafn", None);
    assert_eq!(zone.hits.len(), 1, "the zone is part of the haystack");

    // …and the coverage rule: a query whose second token matches nothing excludes the fight
    // entirely, rather than surfacing it because the first token landed.
    let partial = search(&mut client, 5, "fire dragon", None);
    assert!(partial.hits.is_empty());
    assert_eq!(partial.corpus, 1, "it was searched and it did not match");
}

#[test]
fn an_empty_query_finds_nothing_and_still_counts_what_it_could_have_searched() {
    let staged = Staged::new("empty");
    staged.stage_a_fight();
    let engine = Engine::start();
    let mut client = live_client(&engine, &staged);

    for query in ["", "   ", "`'()"] {
        let found = search(&mut client, 2, query, None);
        assert!(found.hits.is_empty(), "{query:?} returned the whole corpus");
        assert_eq!(
            found.corpus, 1,
            "{query:?} answered corpus 0, which says there was nothing to search"
        );
    }
}

#[test]
fn a_limit_is_clamped_rather_than_refused() {
    // A client asking for an unbounded payload is a payload problem, not a conversation-ending one:
    // every one of these is an answer.
    let staged = Staged::new("limits");
    staged.stage_a_fight();
    let engine = Engine::start();
    let mut client = live_client(&engine, &staged);

    let mut id = 1;
    for limit in [Some(5_000_000), Some(0), Some(-1), Some(1), None] {
        id += 1;
        let found = search(&mut client, id, "fire giant", limit);
        assert_eq!(
            found.hits.len(),
            1,
            "limit {limit:?} did not answer with the one hit there is"
        );
    }
}

#[test]
fn a_live_meter_window_updates_the_cells_that_moved_and_no_others() {
    // `combat.live` holds the same keys for a whole fight while their numbers move, which is the
    // shape `update` exists for. What must move: the damage total, the rate, the bar's fill. What
    // must not be sent: name, kind, tag, rank — a cell that did not move is absent, not resent.
    let staged = Staged::new("update");
    staged.stage_a_fight();
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&subscribe(7, "combat.live"));
    client.send(&attach(1, &staged.log().to_string_lossy()));

    // The opening reset names generation 1 and is empty; the fold's names generation 2 and carries
    // the meter. A client cannot tell the two apart, which is why reset-then-diffs has to hold for
    // an empty window; a test can, by their epochs.
    let opening = next_reset(&mut client, 7);
    assert_eq!(*opening.epoch, 1);
    assert!(opening.rows.is_empty());
    let landed = next_reset(&mut client, 7);
    assert_eq!(*landed.epoch, 2);

    assert_eq!(
        landed
            .rows
            .iter()
            .map(|r| r.key.0.as_str())
            .collect::<Vec<_>>(),
        ["you", "member:rowel"],
        "the meter's own ranking, total desc"
    );
    assert_eq!(landed.total, 2);
    let you = &landed.rows[0];
    assert_eq!(cell(you, "rank"), serde_json::json!(1));
    assert_eq!(cell(you, "name"), serde_json::json!("You"));
    assert_eq!(cell(you, "kind"), serde_json::json!("you"));
    assert_eq!(cell(you, "tag"), serde_json::Value::Null, "you get no word");
    assert_eq!(cell(you, "total"), serde_json::json!("500"));
    assert_eq!(cell(you, "pct"), serde_json::json!(100.0));
    // `other` rather than `player`: EQ spells a summoned pet's name with the same grammar it gives
    // people, so the word must not pick one. Key and kind disagree on purpose — `member:rowel` is
    // the minted identity, `other` is what the attribution ladder can claim today, and the same row
    // becomes `member` once the roster learns the name.
    let them = &landed.rows[1];
    assert_eq!(cell(them, "kind"), serde_json::json!("other"));
    assert_eq!(cell(them, "tag"), serde_json::json!("other"));
    assert_eq!(cell(them, "total"), serde_json::json!("60"));

    // Another hit into the same fight, so the key set does not move and the only thing that can be
    // reported is an edit.
    staged.append(&staged.line(8, &format!("You slash {MOB} for 500 points of damage.")));

    let diff = next_diff(&mut client, 7);
    assert_eq!(*diff.epoch, 2, "no generation changed");
    // Nothing but updates: the same two keys in the same order, so nothing to move or remove.
    let updates: Vec<_> = diff
        .ops
        .iter()
        .map(|op| match op {
            DiffOp::UpdateOp(update) => update,
            other => panic!("a hit into an open fight is an edit, not {other:?}"),
        })
        .collect();
    assert_eq!(updates.len(), 2, "both rows moved: {:?}", diff.ops);

    // One hit, two rows, two different cell sets:
    //   * `you` — total moved (500 → 1000) and so did the rate; `pct` did not, because you were
    //     already the top bar at 100%.
    //   * `member:rowel` — total did not move; the rate did because the fight is longer, and `pct`
    //     did because their 60 is now a smaller share of a bigger top bar (12% → 6%).
    let you = updates
        .iter()
        .find(|u| u.key.0 == "you")
        .expect("your row moved");
    assert_eq!(
        you.cells.keys().collect::<Vec<_>>(),
        ["dps", "total"],
        "only the two cells that moved"
    );
    assert_eq!(
        you.cells["total"].as_json(),
        &serde_json::json!("1.0k"),
        "500 + 500 is a thousand, and the app spells a thousand `1.0k`"
    );

    let them = updates
        .iter()
        .find(|u| u.key.0 == "member:rowel")
        .expect("their row moved too");
    assert_eq!(
        them.cells.keys().collect::<Vec<_>>(),
        ["dps", "pct"],
        "their damage did not move, so `total` is not on the wire"
    );
    assert!(
        !them.cells.contains_key("total"),
        "a cell nobody changed must be ABSENT, not resent"
    );

    // …and neither row resent the four cells that say who it is.
    for update in &updates {
        for unchanged in ["name", "kind", "tag", "rank"] {
            assert!(
                !update.cells.contains_key(unchanged),
                "{} resent {unchanged}: {:?}",
                update.key.0,
                update.cells
            );
        }
    }
    assert!(
        diff.total.is_none(),
        "the row count did not move, so total is absent"
    );
}

#[test]
fn a_new_row_enters_the_meter_as_an_insert_anchored_on_one_the_client_holds() {
    // A combatant the fight had never seen enters at the position its damage earns, anchored on a
    // row the client still holds, which is what makes the batch applicable as sent.
    let staged = Staged::new("insert");
    staged.stage_a_fight();
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&subscribe(7, "combat.live"));
    client.send(&attach(1, &staged.log().to_string_lossy()));
    let _opening = next_reset(&mut client, 7);
    let landed = next_reset(&mut client, 7);
    assert_eq!(landed.rows.len(), 2);

    staged.append(&staged.line(
        9,
        &format!("Dranix slashes {MOB} for 300 points of damage."),
    ));

    let diff = next_diff(&mut client, 7);
    assert_eq!(diff.total, Some(3), "the view grew, so total is present");
    let insert = diff
        .ops
        .iter()
        .find_map(|op| match op {
            DiffOp::InsertOp(insert) => Some(insert),
            _ => None,
        })
        .expect("a new combatant is an insert");
    assert_eq!(insert.row.key.0, "member:dranix");
    assert!(
        insert.before.is_some() ^ insert.after.is_some(),
        "an insert into a non-empty window names exactly one anchor"
    );
    // 300 sits between your 500 and Rowel's 60, so it lands after you.
    assert_eq!(insert.after.as_deref().map(String::as_str), Some("you"));
    assert_eq!(cell(&insert.row, "total"), serde_json::json!("300"));
}

/// The next `reset` naming this subscription. Everything else on the connection is ordinary traffic
/// and is skipped.
fn next_reset(client: &mut Client, id: i64) -> protocol::generated::ResetMessage {
    let deadline = Instant::now() + PATIENCE;
    loop {
        assert!(Instant::now() < deadline, "no reset for subscription {id}");
        match client.recv() {
            EngineMessage::ResetMessage(reset) if *reset.id == id => return reset,
            other => skip(&other),
        }
    }
}

/// The next `diff` naming this subscription.
fn next_diff(client: &mut Client, id: i64) -> protocol::generated::DiffMessage {
    let deadline = Instant::now() + PATIENCE;
    loop {
        assert!(Instant::now() < deadline, "no diff for subscription {id}");
        match client.recv() {
            EngineMessage::DiffMessage(diff) if *diff.id == id => return diff,
            other => skip(&other),
        }
    }
}
