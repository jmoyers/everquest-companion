//! THE THINGS A LIVE ENGINE SAYS WITHOUT BEING ASKED, and the commands it answers (JOS-487, 494).
//!
//! Three surfaces over a real socket, and every one of them is a claim the fold's own unit tests
//! cannot make — because all three are about what happens on the boundary between the INGEST thread
//! and a CONNECTION thread while a tail is actually watching a file:
//!
//!   * `world.conCard` — a `/con` the game wrote a moment ago becomes a resolved card frame
//!     (boundary verdict 2). What is proven here is the half that is not a projection: that the
//!     consider module's live-only push survives the drain, the resolution and the broadcast, and
//!     that a HISTORICAL con reaches none of it.
//!   * `sessionMarks.add` — refused while the fold is replaying and taken once it is live
//!     (boundary verdict 6), which is `combat/engine.ts sessionMark`'s hydrating gate in the
//!     protocol's own words.
//!   * `respawn.confirmSighting` — the SECOND command, and the one that can refuse for a reason
//!     that has nothing to do with the world (JOS-494). It re-bases one respawn clock onto the
//!     sighting the log made, which is a write that has to cross the same thread boundary a define
//!     does and land at a boundary between two events rather than inside one.
//!   * `moduleChanged` — the dirty bit, at the serve cadence, naming a module whose cursor moved
//!     because of a line the tail read while these tests were watching.
//!
//! THE LOG IS WRITTEN LINE BY LINE, `tests/defines.rs`'s way and for its reason: a claim about what
//! ONE line did needs a log whose every event is known. The lines are real EQ shapes, dated after
//! the launch anchor so the rebirth boundary fires on the opening zone line while there is nothing
//! to lose.

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

/// A `/con` IN HISTORY. It is folded by the scan, which means `live` is false for it, which means
/// no card — and that is the assertion, not the setup.
const A_HISTORICAL_CON: &str =
    "[Wed Aug 19 16:01:00 2026] A fire giant warlord glares at you threateningly -- looks like quite a gamble. (Lvl: 52)\n";

/// The same shape, appended while the tail is watching. THIS one is a card.
const A_LIVE_CON: &str =
    "[Wed Aug 19 16:20:00 2026] A lava guardian glares at you threateningly -- looks like quite a gamble. (Lvl: 50)\n";

/// THE KILL THAT STARTS A RESPAWN CLOCK, and the line that later says the thing is back up. The
/// hit is a real shape (`<Mob> hits YOU for N points of damage.`, the very line the owner was
/// looking at when the round-3 ruling was made) and it names the mob the death did — which is what
/// makes it EVIDENCE the module can be asked to promote.
const A_WATCHED_DEATH: &str =
    "[Wed Aug 19 16:05:00 2026] a fire giant warlord has been slain by Primitive!\n";
const A_SIGHTING: &str =
    "[Wed Aug 19 16:06:00 2026] a fire giant warlord hits YOU for 106 points of damage.\n";

/// A loot line the tail reads, so the `loot` module's cursor moves under a live append.
const A_LIVE_LOOT: &str =
    "[Wed Aug 19 16:21:00 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.\n";

/// ONE LOG LINE, STAMPED `seconds_ago` BEFORE THE HOST'S CLOCK.
///
/// THE TIMER SURFACES ARE THE ONE PLACE A FIXTURE CANNOT BE DATED IN 2026 AND LEFT THERE, and the
/// reason is owner ruling 22 rather than convenience: a live engine ticks its own modules with the
/// wall clock, so a 24-second mez recorded a week ago is swept the instant the fold goes live —
/// which is exactly the divergence JOS-479's parity probe measured (twelve actives engine-side
/// against three app-side on a staged fixture whose buffs were long expired). A RUNNING TIMER IS BY
/// DEFINITION RECENT, so a test about running timers writes recent lines. The weekday is not read
/// by the timestamp parser (`\w{3}`, captured and discarded), which is why one is enough.
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

/// A crowd-control landing, WITH THE CAST THAT ANCHORS IT.
///
/// THE CAST LINE IS NOT DECORATION. `BuffTimersModule::apply` refuses a landing whose candidates
/// have no anchored cast behind them, and the refusal is the model's own honesty rather than a gap:
/// `<mob> has been mesmerized.` is printed for a stranger's mez exactly as for yours, so with no
/// anchor the answer to "whose is it?" is not a guess. Two mobs, each with its own cast, is
/// therefore the smallest fixture that makes two timer rows.
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
        // THE LOG GOES UNDER A `Logs` DIRECTORY, the way a real install has it
        // (`<eqRoot>/Logs/eqlog_<Char>_<server>.txt`). It was flat until JOS-497 item 3, which made
        // the shape load-bearing: the engine derives the client spell table's path from the log's
        // GRANDPARENT, so a flat scratch dir would have it looking beside the system temp folder.
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

    /// Put a `spells_us.txt` where a real install has one — in the install ROOT, beside the `Logs`
    /// directory the log lives in. That is the only thing that makes the derivation checkable: the
    /// engine is told a log path and nothing else, and if it went up the wrong number of levels
    /// this file would not be where it looked.
    ///
    /// THE ROWS ARE HAND-AUTHORED, and that is a rule rather than a convenience: `spells_us.txt` is
    /// Daybreak's file and no slice of it may enter this repo. The numbers are the ones the app-side
    /// suite transcribed from the owner's install and pinned there.
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

// ---- reading the stream ------------------------------------------------------------------------

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

// ---- the con card ------------------------------------------------------------------------------

#[test]
fn a_live_con_becomes_a_card_and_a_historical_one_becomes_nothing() {
    let staged = Staged::new("concard", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.client.send(&attach(1, &staged.path()));
    conn.wait_for_live(2);

    // THE HISTORICAL CON DREW NOTHING. This is the assertion the whole boundary law rests on — a
    // startup replay of a month of logs must not put a card over the game — and it is checkable
    // here precisely because the fold is now LIVE: everything the scan was ever going to say has
    // been said.
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

    // THE CHIPS ARE THE FIVE EMPTY ONES AND THE CARD SAYS WHY — the spell table has not moved
    // engine-side (boundary verdict 7), so this is `mobResistProfile`'s own no-table branch rather
    // than a stub. See `crate::concard`'s header.
    assert!(!card.spell_data);
    assert_eq!(card.chips.len(), 5);
    for chip in &card.chips {
        assert!(chip.tag.is_none());
        assert_eq!(chip.n, 0);
    }
}

// ---- how old is this creature (JOS-497 item 1) --------------------------------------------------

#[test]
fn resist_levels_answers_the_con_over_the_catalog_and_says_nothing_about_a_stranger() {
    // THE WHOLE PATH, over a socket, for the LAST fact `src/main/ipc/resist.ts` was reading out of
    // the app's own fold synchronously. `fold::modules::resist::world` owns the SEMANTICS — which
    // source wins, how a catalog range becomes a midpoint — and this owns the crossing: a question
    // composed on a connection thread reaches the resist fold on the ingest thread through the read
    // door, and comes back as the wire's own shape.
    //
    // THE CON IS IN THE STAGED HISTORY, deliberately. `/con` is folded by the scan like any other
    // line — it is the CARD that is live-only, not the level — so a level stated before the tail
    // ever went live is exactly what a resist card drawn on launch has to be able to read.
    let staged = Staged::new("levels", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.client.send(&attach(1, &staged.path()));
    conn.wait_for_live(2);

    conn.client.send(&resist_levels(
        20,
        // …the conned creature, a creature only the committed catalog knows, and a PLAYER, who is
        // in neither and about whom nothing may be invented.
        &["A fire giant warlord", "Innoruuk", "Lasershark"],
    ));
    let ReplyResult::ResistLevelsResult(answer) = conn.reply(20) else {
        panic!("resist.levels answers a ResistLevelsResult");
    };
    let by_name = |name: &str| answer.levels.iter().find(|row| row.mob == name).cloned();

    // THE `/con` WINS AND IT IS EXACT. The game stated 52, so the range is a point and the source
    // says which of the two ladders answered — the card prints that as prose.
    let conned = by_name("A fire giant warlord").expect("the conned creature has a level");
    assert_eq!(conned.level, 52);
    assert_eq!((conned.lo, conned.hi), (52, 52));
    assert!(matches!(conned.from, ResistLevelSource::Con));
    // …and THE NAME IS ECHOED AS IT WAS ASKED, never the folded key. The line spelled it `A fire
    // giant warlord` and the key is `a fire giant warlord`; the app matches on what it sent.
    assert_eq!(conned.mob, "A fire giant warlord");

    // THE CATALOG ANSWERS FOR A CREATURE NOBODY HAS CONNED, which is the arm that makes a card
    // useful the first time a player meets something.
    let catalog = by_name("Innoruuk").expect("a committed catalog row answers");
    assert!(matches!(catalog.from, ResistLevelSource::Catalog));
    assert!(catalog.level > 0);
    assert!(catalog.lo <= catalog.level && catalog.level <= catalog.hi);

    // AND A PERSON GETS NO ROW AT ALL. `Lasershark` is a player — the measured example the con
    // card's own suite uses — so neither ladder states a level, and the absence IS the answer:
    // `levelOf` returns null over there, and a row of four zeros here would be this engine
    // inventing an age for somebody's character.
    assert!(
        by_name("Lasershark").is_none(),
        "a creature nothing states a level for gets no row: {:?}",
        answer.levels
    );
    assert_eq!(answer.levels.len(), 2);
}

// ---- the client's own spell table (JOS-497 item 3) ----------------------------------------------

#[test]
fn resist_spell_reads_the_table_beside_the_install_the_attach_named() {
    // THE PATH DERIVATION IS THE CLAIM, and it is only checkable end to end. Nothing on the wire
    // says where `spells_us.txt` is: the app pushes a log at `<eqRoot>/Logs/<log>` and this engine
    // goes up two and reads beside it. `Staged` puts the log exactly where the product puts one, so
    // writing the table into the staged directory's parent is writing it where a real install has
    // it — and if the derivation were wrong, every assertion below would report a missing file.
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

    // THE KEY IS FOLDED ENGINE-SIDE, so a rank suffix and a case difference are one question — the
    // fold the table was BUILT under, which is why a caller must not pre-fold.
    conn.client.send(&resist_spell(31, "chaos flux II"));
    let ReplyResult::ResistSpellResult(ranked) = conn.reply(31) else {
        panic!("a ResistSpellResult");
    };
    assert!(
        ranked.spell.is_some(),
        "the rank tail and the case both fold"
    );

    // A MISS IS NOT AN ERROR AND IT IS NOT A MISSING FILE. `table: ok` with no `spell` is a
    // different sentence from `table: missing`, and flattening the two would tell a player to go
    // and find a folder they are already in.
    conn.client.send(&resist_spell(32, "Not A Real Spell"));
    let ReplyResult::ResistSpellResult(miss) = conn.reply(32) else {
        panic!("a ResistSpellResult");
    };
    assert!(matches!(miss.table, SpellTableState::Ok));
    assert!(miss.spell.is_none());
}

#[test]
fn an_install_with_no_spell_table_is_a_supported_state_and_says_where_it_looked() {
    // An `EQ_INSTALL_DIR` override pointed at a folder of logs with no EverQuest behind it is a
    // real configuration. What it produces is an answer a card can draw a sentence from, never a
    // refusal — the app's own reader makes exactly this promise (`ipc/resist.ts`).
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

// ---- the session mark --------------------------------------------------------------------------

#[test]
fn a_mark_is_refused_while_the_fold_replays_and_taken_once_it_is_live() {
    let staged = Staged::new("mark", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    // BEFORE ANY ATTACH the world is IDLE, which is not `live`, so the mark is refused — and the
    // ack says which of the four not-live states it was, so a bug report does not have to guess.
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

    // A MARK IS EPHEMERAL AND IDEMPOTENT-LOOKING FROM OUT HERE: pressing again is taken again, and
    // the engine keeps no ledger for a second press to collide with. That is the census's own
    // semantics rather than an accident — the app's `addSessionMark` owns the dedupe.
    conn.client.send(&session_mark(11, 1_787_181_760_000));
    let ReplyResult::SessionMarkAck(again) = conn.reply(11) else {
        panic!("sessionMarks.add answers a SessionMarkAck");
    };
    assert!(again.accepted);
}

// ---- the confirmed sighting --------------------------------------------------------------------

#[test]
fn a_confirmed_sighting_re_bases_the_clock_and_an_unknown_row_moves_nothing() {
    // THE WHOLE PATH, over a socket: a command composed on a connection thread reaches a fold on
    // the ingest thread through the WRITE door, mutates one module, and the very next
    // `module.snapshot` says so. `fold::modules::respawn`'s own unit tests own the SEMANTICS —
    // which instant, which refusals — and this owns the crossing.
    let staged = Staged::new("confirm", &format!("{A_WATCHED_DEATH}{A_SIGHTING}"));
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    // THE WATCH IS PUSHED BEFORE THE ATTACH, which is what the app does on connect and what this
    // test needs: watching is the module's only admission rule, so a define arriving after the fold
    // had already walked past the sighting line would leave nothing to confirm.
    conn.client.send(&respawn_define(
        1,
        &[("a fire giant warlord", "a fire giant warlord")],
    ));
    let _acked = conn.reply(1);

    conn.client.send(&attach(2, &staged.path()));
    let _accepted = conn.reply(2);
    conn.wait_for_live(3);

    // THE CLOCK IS ON THE DEATH AND THE ROW IS LIT — the fold read the hit, and reading it moved
    // no clock. That inaction is the round-3 ruling, and it is the state the press acts on.
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
    // …AND THE ROW HAS LEFT THE SEEN STATE, because the evidence is now AT the base. Absent rather
    // than null: the fold omits what it has nothing to say about.
    assert!(moved.get("seenTs").is_none(), "{after}");

    // A ROW THIS FOLD DOES NOT CARRY IS A NO-OP, REPORTED HONESTLY. It is not an error — the frame
    // is well formed and the answer is that there was nothing to re-base — and nothing else in the
    // module moves for it.
    conn.client
        .send(&respawn_confirm(23, "nagafen's lair::a mob nobody killed"));
    let ReplyResult::RespawnConfirmAck(nothing) = conn.reply(23) else {
        panic!("respawn.confirmSighting answers a RespawnConfirmAck");
    };
    assert!(!nothing.confirmed);
    assert_eq!(conn.state(24, "respawn")["rows"][0]["basis"], "sighting");
}

// ---- the timer rows ----------------------------------------------------------------------------

#[test]
fn a_timer_subscription_serves_the_rows_the_two_windows_draw() {
    // A ZONE LINE STAMPED A MINUTE AGO. It is recent for the reason `line` gives — and because the
    // character-rebirth boundary fires on the first event past the launch anchor, which must be
    // this line rather than a mez we are about to make.
    let staged = Staged::new("timers", &line(60, "You have entered Nagafen's Lair."));
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.client.send(&attach(1, &staged.path()));
    conn.wait_for_live(2);

    // THE LANDING'S OWN BEAT ANNOUNCES EVERY MODULE, so it has to be drained before the dirty bit
    // can be used as a signal about anything in particular. Waiting on an un-cleared list would
    // match that first beat instantly, which is a test that proves the appends were folded by
    // never actually waiting for them.
    conn.wait_until("the first beat", |c| !c.changed.is_empty());
    conn.changed.clear();

    // TWO MEZZES, WHICH IS THE SMALLEST HONEST FIXTURE for this source: one row proves a cell and
    // two prove the ORDER — and the order is the thing this view exists to have already decided.
    // They are appended LIVE, which is the only way a running timer exists at all.
    staged.append(&a_mez(20, "a lava guardian"));
    staged.append(&a_mez(10, "a fire giant warlord"));

    // WAIT FOR THE DIRTY BIT BEFORE SUBSCRIBING, which is this suite using one of its own surfaces
    // as the synchronisation it needs: `buffTimers` announcing a new cursor is the engine saying it
    // has folded those lines, so the reset that follows is cut off a fold that has them.
    conn.wait_until("the buffTimers dirty bit", |c| {
        c.changed.iter().any(|m| m.module == "buffTimers")
    });

    conn.client.send(&subscribe(10, "timers.rows"));
    conn.reply(10);

    // THE OPENING RESET IS EMPTY BY CONSTRUCTION (the rows live on the ingest thread), so the frame
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
        // A HOLD IS A DEBUFFS-WINDOW ROW, decided engine-side so no client has to know the rule.
        assert_eq!(row.cells["kind"], protocol::Cell::text("cc"));
        assert_eq!(row.cells["surface"], protocol::Cell::text("debuffs"));
        assert_eq!(row.cells["group"], protocol::Cell::text("target"));
        // …and the row carries the three numbers a countdown is read from, never the reading
        // itself. See `views::timers`' header for why there is no `remaining` cell.
        assert!(matches!(
            row.cells["startedTs"].as_json(),
            serde_json::Value::Number(_)
        ));
        assert!(row.cells.0.contains_key("durationMs"));
        assert!(row.cells.0.contains_key("endsAt"));
        assert!(!row.cells.0.contains_key("remaining"));
        // THE PRESENTATION ORDERS ARE BOTH CELLS, so a window can be cut in either without the
        // client re-sorting anything.
        assert!(row.cells.0.contains_key("order"));
        assert!(row.cells.0.contains_key("flat"));
    }
    // The key is the projection's own id, which is what keeps a bar identified across ticks.
    let keys: Vec<&str> = rows.iter().map(|r| r.key.0.as_str()).collect();
    assert!(
        keys.iter().all(|k| k.starts_with("cc|")),
        "a hold's id names the ledger it came from: {keys:?}"
    );

    // …AND THE BUFFS WINDOW ASKS FOR ITS OWN ROWS AND GETS NONE, which is the partition working
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
    // EXACTLY TWO RESETS ARRIVE FOR THIS SUBSCRIPTION and the test waits for both rather than
    // sitting on the socket for a fixed time: the OPENING one, empty by construction because the
    // rows live on the ingest thread, and the CADENCE's, which is the first frame cut off the real
    // fold and therefore the one that could have carried a row. Both are empty, and that is the
    // filter being honoured — an unknown filter field would have been `badParams` and `reply` would
    // already have panicked.
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

// ---- the module dirty bit ----------------------------------------------------------------------

#[test]
fn a_live_append_makes_the_modules_say_they_moved() {
    let staged = Staged::new("dirty", A_HISTORICAL_CON);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    // A SUBSCRIPTION IS WHAT STARTS THE SERVE BEAT — the dirty bits ride the same cadence the views
    // do, so a connection that has asked for nothing at all still gets them (they are
    // connection-wide), but the beat has to be running. This is also the honest shape of the app:
    // it subscribes on connect.
    conn.client.send(&subscribe(1, "loot.ledger"));
    conn.reply(1);
    conn.client.send(&attach(2, &staged.path()));
    conn.wait_for_live(3);

    // Everything the LANDING announced is the fold's whole state — every module's first cursor.
    // Drop it: what this test is about is what one LIVE line does.
    conn.wait_until("the first beat", |c| !c.changed.is_empty());
    conn.changed.clear();

    staged.append(A_LIVE_LOOT);
    conn.wait_until("the loot module's dirty bit", |c| {
        c.changed.iter().any(|m| m.module == "loot")
    });

    let loot: Vec<&ModuleChangedMessage> =
        conn.changed.iter().filter(|m| m.module == "loot").collect();
    assert!(!loot.is_empty());
    // ONE FRAME PER MODULE PER BEAT, and one line cannot move a module twice — so a single append
    // produces a single frame for that module rather than one per event the drain folded.
    assert_eq!(
        loot.len(),
        1,
        "coalesced to one frame per module per beat: {loot:?}"
    );
    assert!(
        loot[0].seq > 0,
        "the cursor is the module's own published seq"
    );

    // …and the frame carries a NAME AND A CURSOR AND NOTHING ELSE. The whole point of the dirty bit
    // is that a client which is not showing that module pays one small frame and ignores it.
    let json = serde_json::to_value(loot[0]).expect("serializes");
    let object = json.as_object().expect("an object");
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["kind", "module", "seq"]);
}
