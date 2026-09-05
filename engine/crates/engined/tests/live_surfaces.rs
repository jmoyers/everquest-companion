//! The things a live engine says without being asked, and the commands it answers.
//!
//! Every claim here is one the fold's own unit tests cannot make, because each is about the boundary
//! between the ingest thread and a connection thread while a tail is watching a file:
//!
//!   * `world.conCard` — a `/con` the game wrote a moment ago becomes a resolved card frame, and a
//!     historical con reaches none of it;
//!   * `sessionMarks.add` — refused while the fold is replaying, taken once it is live;
//!   * `respawn.confirmSighting` — re-bases one respawn clock onto the sighting the log made, a
//!     write crossing the same thread boundary a define does;
//!   * `moduleChanged` — the dirty bit, at the serve cadence, naming a module whose cursor moved.
//!
//! The log is written line by line, because a claim about what one line did needs a log whose every
//! event is known, dated after the launch anchor so the rebirth boundary fires on the zone line.

mod harness;

use harness::{
    attach, health, module_snapshot, resist_levels, resist_spell, respawn_confirm, respawn_define,
    session_mark, subscribe, Client, Engine, PATIENCE,
};
use protocol::generated::{
    ClientSpellDebuffAxis, ConCardMessage, EngineMessage, HealthResultStatus, ModuleChangedMessage,
    ReplyResult, ResistAxis, ResistLevelSource, SpellTableState,
};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// The zone line every scratch log opens with.
const ZONE: &str = "[Wed Aug 19 16:00:00 2026] You have entered Nagafen's Lair.\n";

/// A `/con` in history: folded by the scan, so `live` is false for it and no card is drawn. That is
/// the assertion, not the setup.
const A_HISTORICAL_CON: &str =
    "[Wed Aug 19 16:01:00 2026] A fire giant warlord glares at you threateningly -- looks like quite a gamble. (Lvl: 52)\n";

/// The same shape, appended while the tail is watching. This one is a card.
const A_LIVE_CON: &str =
    "[Wed Aug 19 16:20:00 2026] A lava guardian glares at you threateningly -- looks like quite a gamble. (Lvl: 50)\n";

/// The kill that starts a respawn clock, and the line that later says the thing is back up. The hit
/// is a real shape (`<Mob> hits YOU for N points of damage.`) and it names the mob the death did,
/// which is what makes it evidence the module can be asked to promote.
const A_WATCHED_DEATH: &str =
    "[Wed Aug 19 16:05:00 2026] a fire giant warlord has been slain by Primitive!\n";
const A_SIGHTING: &str =
    "[Wed Aug 19 16:06:00 2026] a fire giant warlord hits YOU for 106 points of damage.\n";

/// A loot line the tail reads, so the `loot` module's cursor moves under a live append.
const A_LIVE_LOOT: &str =
    "[Wed Aug 19 16:21:00 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.\n";

/// One log line, stamped `seconds_ago` before the host's clock.
///
/// The timer surfaces cannot use a fixture dated once and left there: a live engine ticks its own
/// modules with the wall clock, so a 24-second mez recorded a week ago is swept the instant the fold
/// goes live. A running timer is by definition recent. The weekday is captured and discarded by the
/// timestamp parser (`\w{3}`), which is why one is enough.
fn line(seconds_ago: i64, text: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let now_ms = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("a clock after 1970")
            .as_millis(),
    )
    .expect("an instant this side of the heat death");
    let clock = eqlog::Clock::new(eqlog::host_timezone());
    let t = clock
        .civil(now_ms - seconds_ago * 1000)
        .expect("the host clock resolves");
    format!(
        "[Mon {month} {day:02} {hour:02}:{minute:02}:{second:02} {year}] {text}\n",
        month = MONTHS[(t.month as usize).saturating_sub(1)],
        day = t.day,
        hour = t.hour,
        minute = t.minute,
        second = t.second,
        year = t.year
    )
}

/// A crowd-control landing, with the cast that anchors it.
///
/// `BuffTimersModule::apply` refuses a landing whose candidates have no anchored cast behind them:
/// `<mob> has been mesmerized.` is printed for a stranger's mez exactly as for yours, so with no
/// anchor there is no non-guess answer to whose it is. Two mobs, each with its own cast, is the
/// smallest fixture that makes two timer rows.
fn a_mez(seconds_ago: i64, mob: &str) -> String {
    format!(
        "{}{}",
        line(seconds_ago + 2, "You begin casting Mesmerization."),
        line(seconds_ago, &format!("{mob} has been mesmerized."))
    )
}

/// A scratch directory holding one log named the way the product names one.
struct Staged(PathBuf);

impl Staged {
    fn new(tag: &str, body: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-live-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        // The log goes under a `Logs` directory, the way a real install has it
        // (`<eqRoot>/Logs/eqlog_<Char>_<server>.txt`). The shape is load-bearing: the engine derives
        // the client spell table's path from the log's grandparent.
        std::fs::create_dir_all(dir.join("Logs")).expect("a scratch install");
        let staged = Self(dir);
        staged.append(&format!("{ZONE}{body}"));
        staged
    }

    /// The install root — what `<eqRoot>` is for this staged copy.
    fn root(&self) -> &std::path::Path {
        &self.0
    }

    fn log(&self) -> PathBuf {
        self.0.join("Logs").join("eqlog_Primitive_freeport.txt")
    }

    fn path(&self) -> String {
        self.log().to_string_lossy().into_owned()
    }

    /// Put a `spells_us.txt` where a real install has one — in the install root, beside the `Logs`
    /// directory the log lives in. That is what makes the derivation checkable: the engine is told a
    /// log path and nothing else.
    ///
    /// The rows are hand-authored because `spells_us.txt` is Daybreak's file and no slice of it may
    /// enter this repo.
    fn stage_spell_table(&self) {
        let row = |id: &str, name: &str, resist: &str, slots: &str| {
            let mut f = vec!["0".to_string(); 173];
            for field in f.iter_mut().take(52).skip(36) {
                *field = "255".to_string();
            }
            f[0] = id.to_owned();
            f[1] = name.to_owned();
            f[29] = resist.to_owned();
            // An enchanter level, so the row is one a player can learn.
            f[49] = "16".to_owned();
            f[172] = slots.to_owned();
            f.join("^")
        };
        std::fs::write(
            self.root().join("spells_us.txt"),
            format!(
                "{}\n{}\n",
                row("677", "Tashani", "1", "2|50|-10|0|101|23"),
                row("350", "Chaos Flux", "1", "1|50|-20|0|101|30")
            ),
        )
        .expect("the staged spell table");
    }

    /// Append the way EverQuest appends: an open, a write, a flush.
    fn append(&self, text: &str) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log())
            .expect("the log takes an append");
        file.write_all(text.as_bytes()).expect("append");
        file.flush().expect("flush");
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ignored = std::fs::remove_dir_all(&self.0);
    }
}

/// One connection, read once, keeping the two frame kinds this suite is about.
struct Conn {
    client: Client,
    cards: Vec<ConCardMessage>,
    changed: Vec<ModuleChangedMessage>,
}

impl Conn {
    fn new(client: Client) -> Self {
        Self {
            client,
            cards: Vec::new(),
            changed: Vec::new(),
        }
    }

    /// Take one message off the wire, filing the connection-wide frames this suite collects.
    fn pump(&mut self) -> EngineMessage {
        let message = self.client.recv();
        match &message {
            EngineMessage::ConCardMessage(card) => self.cards.push(card.clone()),
            EngineMessage::ModuleChangedMessage(changed) => self.changed.push(changed.clone()),
            _ => {}
        }
        message
    }

    /// Read until the reply to `id` arrives, keeping everything seen on the way.
    fn reply(&mut self, id: i64) -> ReplyResult {
        let deadline = Instant::now() + PATIENCE;
        loop {
            assert!(Instant::now() < deadline, "no reply to request {id}");
            match self.pump() {
                EngineMessage::Reply(reply) if *reply.id == id => return reply.result,
                EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                    panic!("request {id} was refused: {:?}", refusal.error)
                }
                _ => {}
            }
        }
    }

    /// One module's published state, off the live fold.
    fn state(&mut self, id: i64, module: &str) -> serde_json::Value {
        self.client.send(&module_snapshot(id, module));
        match self.reply(id) {
            ReplyResult::ModuleSnapshotResult(result) => result.state,
            other => panic!("module.snapshot answers a snapshot, got {other:?}"),
        }
    }

    fn status(&mut self, id: i64) -> HealthResultStatus {
        self.client.send(&health(id));
        match self.reply(id) {
            ReplyResult::HealthResult(result) => result.status,
            other => panic!("session.health answers health, got {other:?}"),
        }
    }

    /// Poll `session.health` until the ingest is live.
    fn wait_for_live(&mut self, first_id: i64) {
        let deadline = Instant::now() + PATIENCE;
        let mut id = first_id;
        loop {
            if matches!(self.status(id), HealthResultStatus::Live) {
                return;
            }
            assert!(Instant::now() < deadline, "the fold never went live");
            id += 1;
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Read frames until `have` is satisfied, or fail. The frames themselves are collected by
    /// [`Conn::pump`], so this is only the waiting.
    fn wait_until(&mut self, what: &str, mut have: impl FnMut(&Self) -> bool) {
        let deadline = Instant::now() + PATIENCE;
        while !have(self) {
            assert!(Instant::now() < deadline, "{what} never arrived");
            self.pump();
        }
    }
}

#[test]
fn a_live_con_becomes_a_card_and_a_historical_one_becomes_nothing() {
    let staged = Staged::new("concard", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.client.send(&attach(1, &staged.path()));
    conn.wait_for_live(2);

    // The historical con drew nothing: a startup replay of a month of logs must not put a card over
    // the game. It is checkable here because the fold is live, so everything the scan would ever say
    // has been said.
    assert!(
        conn.cards.is_empty(),
        "a replayed con drew a card: {:?}",
        conn.cards
    );

    // …and the same shape, appended while the tail is watching, does.
    staged.append(A_LIVE_CON);
    conn.wait_until("a con card", |c| !c.cards.is_empty());

    let card = conn.cards.first().expect("a card");
    assert_eq!(card.name, "A lava guardian");
    assert_eq!(
        card.id, "a lava guardian",
        "the queue identity is the mob key"
    );
    assert_eq!(card.level, Some(50));
    assert_eq!(
        card.zone.as_deref(),
        Some("Nagafen's Lair"),
        "the zone the module was holding when the line arrived"
    );
    assert_eq!(card.rare, None, "absent rather than false");

    // Five empty chips, and the card says why: with no spell table engine-side this is
    // `mobResistProfile`'s own no-table branch rather than a stub.
    assert!(!card.spell_data);
    assert_eq!(card.chips.len(), 5);
    for chip in &card.chips {
        assert!(chip.tag.is_none());
        assert_eq!(chip.n, 0);
    }
}

#[test]
fn resist_levels_answers_the_con_over_the_catalog_and_says_nothing_about_a_stranger() {
    // The whole path over a socket. `fold::modules::resist::world` owns the semantics — which source
    // wins, how a catalog range becomes a midpoint — and this owns the crossing: a question composed
    // on a connection thread reaches the resist fold on the ingest thread through the read door.
    //
    // The con is in the staged history deliberately: `/con` is folded by the scan like any other
    // line — it is the card that is live-only, not the level — and a resist card drawn on launch has
    // to be able to read a level stated before the tail went live.
    let staged = Staged::new("levels", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.client.send(&attach(1, &staged.path()));
    conn.wait_for_live(2);

    conn.client.send(&resist_levels(
        20,
        // …the conned creature, a creature only the committed catalog knows, and a player, who is in
        // neither and about whom nothing may be invented.
        &["A fire giant warlord", "Innoruuk", "Lasershark"],
    ));
    let ReplyResult::ResistLevelsResult(answer) = conn.reply(20) else {
        panic!("resist.levels answers a ResistLevelsResult");
    };
    let by_name = |name: &str| answer.levels.iter().find(|row| row.mob == name).cloned();

    // The `/con` wins and it is exact: the game stated 52, so the range is a point, and the source
    // says which of the two ladders answered.
    let conned = by_name("A fire giant warlord").expect("the conned creature has a level");
    assert_eq!(conned.level, 52);
    assert_eq!((conned.lo, conned.hi), (52, 52));
    assert!(matches!(conned.from, ResistLevelSource::Con));
    // …and the name is echoed as it was asked, never the folded key: the line spelled it `A fire
    // giant warlord` and the key is `a fire giant warlord`, and the app matches on what it sent.
    assert_eq!(conned.mob, "A fire giant warlord");

    // The catalog answers for a creature nobody has conned, which is what makes a card useful the
    // first time a player meets something.
    let catalog = by_name("Innoruuk").expect("a committed catalog row answers");
    assert!(matches!(catalog.from, ResistLevelSource::Catalog));
    assert!(catalog.level > 0);
    assert!(catalog.lo <= catalog.level && catalog.level <= catalog.hi);

    // A person gets no row at all: `Lasershark` is a player, so neither ladder states a level and
    // the absence is the answer. A row of four zeros would be inventing an age for a character.
    assert!(
        by_name("Lasershark").is_none(),
        "a creature nothing states a level for gets no row: {:?}",
        answer.levels
    );
    assert_eq!(answer.levels.len(), 2);
}

#[test]
fn resist_spell_reads_the_table_beside_the_install_the_attach_named() {
    // The path derivation is the claim and is only checkable end to end: nothing on the wire says
    // where `spells_us.txt` is. The app pushes a log at `<eqRoot>/Logs/<log>` and this engine goes up
    // two and reads beside it; a wrong derivation makes every assertion below report a missing file.
    let staged = Staged::new("spells", A_HISTORICAL_CON);
    staged.stage_spell_table();
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.client.send(&attach(1, &staged.path()));
    conn.wait_for_live(2);

    conn.client.send(&resist_spell(30, "Tashani"));
    let ReplyResult::ResistSpellResult(hit) = conn.reply(30) else {
        panic!("resist.spell answers a ResistSpellResult");
    };
    assert!(matches!(hit.table, SpellTableState::Ok));
    assert_eq!(hit.spell_name, "Tashani", "echoed as asked, never the key");
    assert!(
        hit.path.ends_with("spells_us.txt"),
        "the answer names where it looked: {}",
        hit.path
    );
    let spell = hit.spell.expect("a row for a staged spell");
    // The field map, across a socket: resist type 1 is magic, and `2|50|-10|0|101|23` is a
    // magic-resist debuff of -10 with a cap of 23 (calc 101, not the other way round).
    assert!(matches!(spell.axis, Some(ResistAxis::Magic)));
    assert_eq!(spell.debuff_slots.len(), 1);
    assert!(matches!(
        spell.debuff_slots[0].axis,
        ClientSpellDebuffAxis::Magic
    ));
    assert_eq!(spell.debuff_slots[0].base, -10.0);
    assert_eq!(spell.debuff_slots[0].max, 23.0);

    // The key is folded engine-side, under the same fold the table was built with, so a rank suffix
    // and a case difference are one question — and a caller must not pre-fold.
    conn.client.send(&resist_spell(31, "chaos flux II"));
    let ReplyResult::ResistSpellResult(ranked) = conn.reply(31) else {
        panic!("a ResistSpellResult");
    };
    assert!(
        ranked.spell.is_some(),
        "the rank tail and the case both fold"
    );

    // A miss is not an error and not a missing file: `table: ok` with no `spell` is a different
    // sentence from `table: missing`.
    conn.client.send(&resist_spell(32, "Not A Real Spell"));
    let ReplyResult::ResistSpellResult(miss) = conn.reply(32) else {
        panic!("a ResistSpellResult");
    };
    assert!(matches!(miss.table, SpellTableState::Ok));
    assert!(miss.spell.is_none());
}

#[test]
fn an_install_with_no_spell_table_is_a_supported_state_and_says_where_it_looked() {
    // A folder of logs with no EverQuest behind it is a real configuration. It produces an answer a
    // card can draw a sentence from, never a refusal.
    let staged = Staged::new("nospells", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());
    conn.client.send(&attach(1, &staged.path()));
    conn.wait_for_live(2);

    conn.client.send(&resist_spell(33, "Tashani"));
    let ReplyResult::ResistSpellResult(answer) = conn.reply(33) else {
        panic!("a ResistSpellResult");
    };
    assert!(matches!(answer.table, SpellTableState::Missing));
    assert!(answer.spell.is_none());
    assert!(
        answer.path.ends_with("spells_us.txt"),
        "the sentence a missing table produces has to name a place: {}",
        answer.path
    );
}

#[test]
fn a_mark_is_refused_while_the_fold_replays_and_taken_once_it_is_live() {
    let staged = Staged::new("mark", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    // Before any attach the world is idle, which is not `live`, so the mark is refused — and the ack
    // says which of the four not-live states it was, so a bug report does not have to guess.
    conn.client.send(&session_mark(1, 1_787_181_700_000));
    let ReplyResult::SessionMarkAck(idle) = conn.reply(1) else {
        panic!("sessionMarks.add answers a SessionMarkAck");
    };
    assert!(!idle.accepted);
    assert!(matches!(
        idle.status,
        protocol::generated::SessionMarkAckStatus::Idle
    ));

    conn.client.send(&attach(2, &staged.path()));
    conn.wait_for_live(3);

    // …and once the tail owns the file the same press is taken.
    conn.client.send(&session_mark(10, 1_787_181_760_000));
    let ReplyResult::SessionMarkAck(live) = conn.reply(10) else {
        panic!("sessionMarks.add answers a SessionMarkAck");
    };
    assert!(live.accepted);
    assert!(matches!(
        live.status,
        protocol::generated::SessionMarkAckStatus::Live
    ));

    // A mark is ephemeral: pressing again is taken again, because the engine keeps no ledger for a
    // second press to collide with. The app's `addSessionMark` owns the dedupe.
    conn.client.send(&session_mark(11, 1_787_181_760_000));
    let ReplyResult::SessionMarkAck(again) = conn.reply(11) else {
        panic!("sessionMarks.add answers a SessionMarkAck");
    };
    assert!(again.accepted);
}

#[test]
fn a_confirmed_sighting_re_bases_the_clock_and_an_unknown_row_moves_nothing() {
    // The whole path over a socket: a command composed on a connection thread reaches the fold on
    // the ingest thread through the write door, mutates one module, and the next `module.snapshot`
    // says so. `fold::modules::respawn`'s unit tests own the semantics; this owns the crossing.
    let staged = Staged::new("confirm", &format!("{A_WATCHED_DEATH}{A_SIGHTING}"));
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    // The watch is pushed before the attach: watching is the module's only admission rule, so a
    // define arriving after the fold walked past the sighting line would leave nothing to confirm.
    conn.client.send(&respawn_define(
        1,
        &[("a fire giant warlord", "a fire giant warlord")],
    ));
    let _acked = conn.reply(1);

    conn.client.send(&attach(2, &staged.path()));
    let _accepted = conn.reply(2);
    conn.wait_for_live(3);

    // The clock is on the death and the row is lit: the fold read the hit, and reading it moved no
    // clock. That inaction is the state the press acts on.
    let before = conn.state(20, "respawn");
    let row = &before["rows"][0];
    assert_eq!(row["basis"], "death", "{before}");
    assert!(row["seenTs"].is_i64(), "the row is seen: {before}");
    let row_id = row["id"].as_str().expect("a row id").to_owned();

    conn.client.send(&respawn_confirm(21, &row_id));
    let ReplyResult::RespawnConfirmAck(ack) = conn.reply(21) else {
        panic!("respawn.confirmSighting answers a RespawnConfirmAck");
    };
    assert!(ack.confirmed);

    let after = conn.state(22, "respawn");
    let moved = &after["rows"][0];
    assert_eq!(moved["basis"], "sighting", "{after}");
    assert_eq!(
        moved["baseTs"], before["rows"][0]["seenTs"],
        "the clock counts from the instant the log named it: {after}"
    );
    // …and the row has left the seen state, because the evidence is now at the base. Absent rather
    // than null: the fold omits what it has nothing to say about.
    assert!(moved.get("seenTs").is_none(), "{after}");

    // A row this fold does not carry is a no-op, reported honestly: the frame is well formed and the
    // answer is that there was nothing to re-base.
    conn.client
        .send(&respawn_confirm(23, "nagafen's lair::a mob nobody killed"));
    let ReplyResult::RespawnConfirmAck(nothing) = conn.reply(23) else {
        panic!("respawn.confirmSighting answers a RespawnConfirmAck");
    };
    assert!(!nothing.confirmed);
    assert_eq!(conn.state(24, "respawn")["rows"][0]["basis"], "sighting");
}

#[test]
fn a_timer_subscription_serves_the_rows_the_two_windows_draw() {
    // A zone line stamped a minute ago, recent for the reason `line` gives and because the
    // character-rebirth boundary fires on the first event past the launch anchor — which must be
    // this line rather than a mez appended later.
    let staged = Staged::new("timers", &line(60, "You have entered Nagafen's Lair."));
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.client.send(&attach(1, &staged.path()));
    conn.wait_for_live(2);

    // The landing beat announces every module, so it must be drained before the dirty bit means
    // anything in particular: waiting on an un-cleared list would match that first beat instantly.
    conn.wait_until("the first beat", |c| !c.changed.is_empty());
    conn.changed.clear();

    // Two mezzes: one row proves a cell and two prove the order, which is what this view exists to
    // have already decided. Appended live, the only way a running timer exists at all.
    staged.append(&a_mez(20, "a lava guardian"));
    staged.append(&a_mez(10, "a fire giant warlord"));

    // Wait for the dirty bit before subscribing: `buffTimers` announcing a new cursor is the engine
    // saying it folded those lines, so the reset that follows is cut off a fold that has them.
    conn.wait_until("the buffTimers dirty bit", |c| {
        c.changed.iter().any(|m| m.module == "buffTimers")
    });

    conn.client.send(&subscribe(10, "timers.rows"));
    conn.reply(10);

    // The opening reset is empty by construction (the rows live on the ingest thread), so the frame
    // worth reading is the next one the serve cadence cuts.
    let mut resets = 0;
    let mut rows: Vec<protocol::generated::Row> = Vec::new();
    let deadline = Instant::now() + PATIENCE;
    while resets < 2 {
        assert!(Instant::now() < deadline, "the timer view never answered");
        if let EngineMessage::ResetMessage(reset) = conn.pump() {
            if *reset.id == 10 {
                resets += 1;
                rows = reset.rows;
            }
        }
    }

    assert_eq!(rows.len(), 2, "two holds, two rows: {rows:?}");
    for row in &rows {
        // A hold is a debuffs-window row, decided engine-side so no client has to know the rule.
        assert_eq!(row.cells["kind"], protocol::Cell::text("cc"));
        assert_eq!(row.cells["surface"], protocol::Cell::text("debuffs"));
        assert_eq!(row.cells["group"], protocol::Cell::text("target"));
        // …and the row carries the three numbers a countdown is read from, never the reading itself.
        assert!(matches!(
            row.cells["startedTs"].as_json(),
            serde_json::Value::Number(_)
        ));
        assert!(row.cells.0.contains_key("durationMs"));
        assert!(row.cells.0.contains_key("endsAt"));
        assert!(!row.cells.0.contains_key("remaining"));
        // Both presentation orders are cells, so a window can be cut in either without the client
        // re-sorting anything.
        assert!(row.cells.0.contains_key("order"));
        assert!(row.cells.0.contains_key("flat"));
    }
    // The key is the projection's own id, which is what keeps a bar identified across ticks.
    let keys: Vec<&str> = rows.iter().map(|r| r.key.0.as_str()).collect();
    assert!(
        keys.iter().all(|k| k.starts_with("cc|")),
        "a hold's id names the ledger it came from: {keys:?}"
    );

    // …and the buffs window asks for its own rows and gets none, which is the partition working
    // rather than an empty view: these two rows are debuffs, all of them.
    let mut descriptor = protocol::generated::ViewDescriptor {
        source: "timers.rows".to_owned(),
        filter: None,
        sort: Vec::new(),
        window: None,
    };
    descriptor.filter = Some(protocol::generated::ViewFilter(
        std::collections::BTreeMap::from([("surface".to_owned(), protocol::Cell::text("buffs"))]),
    ));
    conn.client.send(&harness::subscribe_to(11, descriptor));
    conn.reply(11);
    // Two resets arrive and both are waited for: the opening one, empty by construction, and the
    // cadence's, the first frame cut off the real fold and so the one that could have carried a row.
    // Both empty is the filter being honoured.
    let mut seen = 0;
    let deadline = Instant::now() + PATIENCE;
    while seen < 2 {
        assert!(
            Instant::now() < deadline,
            "the filtered view never answered"
        );
        if let EngineMessage::ResetMessage(reset) = conn.pump() {
            if *reset.id == 11 {
                assert!(
                    reset.rows.is_empty(),
                    "a mez is not a buff: {:?}",
                    reset.rows
                );
                assert_eq!(reset.total, 0);
                seen += 1;
            }
        }
    }
}

#[test]
fn a_live_append_makes_the_modules_say_they_moved() {
    let staged = Staged::new("dirty", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    // A subscription is what starts the serve beat: dirty bits ride the same cadence the views do,
    // and though they are connection-wide the beat has to be running. The app subscribes on connect
    // for the same reason.
    conn.client.send(&subscribe(1, "loot.ledger"));
    conn.reply(1);
    conn.client.send(&attach(2, &staged.path()));
    conn.wait_for_live(3);

    // Everything the landing announced is the fold's whole state — every module's first cursor. Drop
    // it: this test is about what one live line does.
    conn.wait_until("the first beat", |c| !c.changed.is_empty());
    conn.changed.clear();

    staged.append(A_LIVE_LOOT);
    conn.wait_until("the loot module's dirty bit", |c| {
        c.changed.iter().any(|m| m.module == "loot")
    });

    let loot: Vec<&ModuleChangedMessage> =
        conn.changed.iter().filter(|m| m.module == "loot").collect();
    assert!(!loot.is_empty());
    // One frame per module per beat, and one line cannot move a module twice, so a single append
    // produces a single frame rather than one per event the drain folded.
    assert_eq!(
        loot.len(),
        1,
        "coalesced to one frame per module per beat: {loot:?}"
    );
    assert!(
        loot[0].seq > 0,
        "the cursor is the module's own published seq"
    );

    // …and the frame carries a name and a cursor and nothing else, so a client not showing that
    // module pays one small frame and ignores it.
    let json = serde_json::to_value(loot[0]).expect("serializes");
    let object = json.as_object().expect("an object");
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["kind", "module", "seq"]);
}

/// A melee round announces only the modules the lines concern.
///
/// The far-end version of the claim `fold`'s own `tests/announce.rs` asks one event at a time: a real
/// tail reading real EQ lines off a real socket produces no `moduleChanged` frame for a module the
/// lines have nothing to do with.
///
/// The silent set is named rather than inferred — asserting "only these announced" would pin every
/// module in the engine and go red for one legitimately doing its job.
///
/// `progression` is the witness that the lines were actually read: its cursor moves on the published
/// `lastTs`, so it is the one module guaranteed to speak for a melee line, and waiting for it proves
/// the tail got that far.
#[test]
fn a_melee_round_leaves_the_modules_it_has_nothing_to_do_with_silent() {
    /// Every migrated module but the one that answers to the log's clock.
    const SILENT: [&str; 14] = [
        "alerts",
        "buffs",
        "classUnlocks",
        "consider",
        "eventFeed",
        "itemTiers",
        "kills",
        "leveling",
        "loot",
        "observedSpellRanks",
        "outputFiles",
        "roster",
        "spellSets",
        "turnins",
    ];

    let staged = Staged::new("melee-silence", ZONE);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());
    conn.client.send(&subscribe(1, "loot.ledger"));
    conn.reply(1);
    conn.client.send(&attach(2, &staged.path()));
    conn.wait_for_live(3);
    // The landing beat announces every module's first cursor — that is the hydration edge, not this
    // test's subject.
    conn.wait_until("the first beat", |c| !c.changed.is_empty());
    conn.changed.clear();

    // A pure melee exchange — swings, a miss and a hit taken: the busiest thing an EQ log does.
    for seconds_ago in (10..16).rev() {
        staged.append(&line(
            seconds_ago,
            "You slash a fire giant warlord for 42 points of damage.",
        ));
        staged.append(&line(
            seconds_ago,
            "You try to kick a fire giant warlord, but miss!",
        ));
        staged.append(&line(
            seconds_ago,
            "a fire giant warlord hits YOU for 106 points of damage.",
        ));
    }
    conn.wait_until("the tail to have read the round", |c| {
        c.changed.iter().any(|m| m.module == "progression")
    });

    let heard: Vec<&str> = conn
        .changed
        .iter()
        .map(|m| m.module.as_str())
        .filter(|m| SILENT.contains(m))
        .collect();
    assert!(
        heard.is_empty(),
        "a melee round announced modules that never read it: {heard:?}"
    );

    // …and the other direction, in the same live world, because a test that only proves silence is
    // satisfied by an engine that has stopped talking. One loot line, one frame.
    conn.changed.clear();
    staged.append(A_LIVE_LOOT);
    conn.wait_until("the loot module's dirty bit", |c| {
        c.changed.iter().any(|m| m.module == "loot")
    });
    let loot: Vec<&ModuleChangedMessage> =
        conn.changed.iter().filter(|m| m.module == "loot").collect();
    assert_eq!(loot.len(), 1, "exactly once: {loot:?}");
}
