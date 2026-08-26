//! APP KNOWLEDGE IN, ALERT FIRES OUT — the two directions JOS-482 opens, over a real socket.
//!
//! Every test here spawns the built binary, stages a log under the product's own file-name shape,
//! pushes one or more `*.define` commands, and reads what a client would read. What it proves is
//! the half the fold's own unit tests cannot: that a push made on a CONNECTION THREAD reaches a
//! fold living on the INGEST thread, at a boundary that fold already reaches, and that the module
//! state a client can then ask for is the state the push made.
//!
//! IT IS A SELF-CONSISTENCY CLAIM AND DELIBERATELY NOT A SEMANTICS ONE — the same distinction
//! `tests/module_snapshot.rs` draws. Each family gets ONE WORKED EXAMPLE whose observable effect is
//! compared against what the TypeScript seam does with the same push (`ipc/alerts.ts setDefs`,
//! `ipc/respawn.ts setPrefs`, `ipc/combo.ts setCorrection`, `ipc/roster.ts setEdit`,
//! `ipc/buffTrust.ts setTrust`), read off the module's own published state. Proving the FOLD's
//! semantics is `npm run oracle:rust-fold`'s job over six slices of the owner's real log, and the
//! oracle's world pushes nothing at all — which is exactly why these pushes cannot disturb it.
//!
//! THE LOG IS WRITTEN HERE, LINE BY LINE, for `tests/views.rs`'s reason: a claim about what one
//! push changed needs a log whose every event is known. The lines are real EQ shapes and they are
//! dated after the launch anchor, so the rebirth boundary fires on the zone line before there is
//! anything to lose.

mod harness;

use harness::{
    alerts_define, attach, buff_trust_define, combo_define, health, module_snapshot,
    respawn_define, roster_define, Client, Engine, PATIENCE,
};
use protocol::generated::{EngineMessage, ReplyResult};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

// ---- the log these tests fold ------------------------------------------------------------------

/// The zone line every scratch log opens with. It fires the rebirth boundary while the world is
/// still empty, so nothing a test wrote is cleared out from under it.
const ZONE: &str = "[Wed Aug 19 16:00:00 2026] You have entered Nagafen's Lair.\n";

/// A death the respawn module counts, and a loot line an alert can be written against.
const A_DEATH: &str =
    "[Wed Aug 19 16:05:00 2026] a fire giant warlord has been slain by Primitive!\n";
const A_LOOT: &str =
    "[Wed Aug 19 16:14:07 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.\n";

/// The same loot, later — what the game writes while the tail is watching.
const A_LATER_LOOT: &str =
    "[Wed Aug 19 16:16:44 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.\n";

/// A cast by somebody else — the third-person line the buff-trust allowlist is about.
const AN_EXTERNAL_CAST: &str = "[Wed Aug 19 16:06:00 2026] Dranix begins casting Mesmerization.\n";

/// A group line, so the roster has a log-derived member for an edit to sit beside.
const A_JOIN: &str = "[Wed Aug 19 16:07:00 2026] Dranix has joined the group.\n";

/// A cast of YOUR OWN, so the combo model has one class observation to build an interval out of.
/// A correction RE-LABELS an interval; it does not conjure one, so the log has to say something
/// about the loadout before there is anything for the user to disagree with.
const A_SELF_CAST: &str = "[Wed Aug 19 16:08:00 2026] You begin casting Mesmerization.\n";

/// A scratch directory holding one log named the way the product names one.
struct Staged(PathBuf);

impl Staged {
    fn new(tag: &str, body: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-defines-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        let staged = Self(dir);
        staged.append(&format!("{ZONE}{body}"));
        staged
    }

    fn log(&self) -> PathBuf {
        self.0.join("eqlog_Primitive_freeport.txt")
    }

    fn path(&self) -> String {
        self.log().to_string_lossy().into_owned()
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

/// One connection, read once, with the fires kept.
///
/// EPOCH FRAMES ARE DROPPED and FIRES ARE KEPT, which is the whole shape of this suite: progress is
/// connection-wide and arrives whether anybody asked for it, while a fire is the thing under test.
/// Replies are handed back to the caller that asked for them.
struct Conn {
    client: Client,
    fires: Vec<protocol::generated::FireMessage>,
}

impl Conn {
    fn new(client: Client) -> Self {
        Self {
            client,
            fires: Vec::new(),
        }
    }

    fn send(&mut self, message: &protocol::generated::ClientMessage) {
        self.client.send(message);
    }

    /// Read until the reply to `id` arrives, keeping every fire seen on the way.
    fn reply(&mut self, id: i64) -> ReplyResult {
        let deadline = Instant::now() + PATIENCE;
        loop {
            assert!(Instant::now() < deadline, "no reply to request {id}");
            match self.client.recv() {
                EngineMessage::Reply(reply) if *reply.id == id => return reply.result,
                EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                    panic!("request {id} was refused: {:?}", refusal.error);
                }
                EngineMessage::FireMessage(fire) => self.fires.push(fire),
                _ => {}
            }
        }
    }

    /// One module's published state, off the live fold.
    fn state(&mut self, id: i64, module: &str) -> Value {
        self.send(&module_snapshot(id, module));
        match self.reply(id) {
            ReplyResult::ModuleSnapshotResult(result) => result.state,
            other => panic!("module.snapshot answers a snapshot, got {other:?}"),
        }
    }

    /// Poll `session.health` until the ingest is live.
    fn wait_for_live(&mut self, first_id: i64) {
        let deadline = Instant::now() + PATIENCE;
        let mut id = first_id;
        loop {
            self.send(&health(id));
            let status = match self.reply(id) {
                ReplyResult::HealthResult(result) => result.status,
                other => panic!("session.health answers health, got {other:?}"),
            };
            if matches!(status, protocol::generated::HealthResultStatus::Live) {
                return;
            }
            assert!(Instant::now() < deadline, "the fold never went live");
            id += 1;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    /// Read until one fire arrives, or fail.
    fn next_fire(&mut self) -> protocol::generated::FireMessage {
        if let Some(fire) = self.fires.pop() {
            return fire;
        }
        let deadline = Instant::now() + PATIENCE;
        loop {
            assert!(Instant::now() < deadline, "no fire arrived");
            if let EngineMessage::FireMessage(fire) = self.client.recv() {
                return fire;
            }
        }
    }
}

/// The `count` a define acknowledged, or `None` for a family that pushes one object.
fn ack_count(result: &ReplyResult) -> Option<i64> {
    match result {
        ReplyResult::DefineAck(ack) => {
            assert!(ack.applied, "a define that was not applied");
            ack.count
        }
        other => panic!("a define answers a DefineAck, got {other:?}"),
    }
}

/// One alert definition, as the store holds one — extra fields and all.
///
/// THE EXTRAS ARE THE POINT of carrying them here: `volume`, `audio` and `note` are fields the
/// engine's evaluator does not read, and an `AlertDefinition` that refused them would turn every
/// real store's push into `badParams`. That is the open-object ruling, exercised rather than
/// asserted.
fn a_def(id: &str, name: &str, trigger: Value) -> Value {
    json!({
        "id": id,
        "name": name,
        "enabled": true,
        "sound": { "packId": "classic", "soundId": "bell" },
        "trigger": trigger,
        "volume": 0.8,
        "audio": "sound",
        "note": "authored by a test"
    })
}

// ---- the tests ---------------------------------------------------------------------------------

#[test]
fn a_define_pushed_before_an_attach_is_held_and_applied_at_construction() {
    // THE ORDINARY LAUNCH SHAPE. The app connects, pushes all five, and attaches afterwards — so
    // the common case is a define made at a world with no fold at all. It is recorded by the world
    // and applied by the next attach BEFORE the first byte is folded, which is the only timing that
    // makes a fold reproducible: app knowledge changes what a fold produces.
    let staged = Staged::new("held", A_LOOT);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    let defs = vec![a_def("a1", "Cloak", json!({"type":"event","kind":"loot"}))];
    conn.send(&alerts_define(1, &defs));
    assert_eq!(ack_count(&conn.reply(1)), Some(1));

    conn.send(&attach(2, &staged.path()));
    let _accepted = conn.reply(2);
    conn.wait_for_live(10);

    let state = conn.state(3, "alerts");
    assert_eq!(
        state["defs"],
        json!(defs),
        "the fold was built holding the set the app pushed before it existed"
    );
}

#[test]
fn a_define_is_a_full_set_replace_and_pushing_twice_is_pushing_once() {
    // THE COMMAND LAW: push A then push B leaves exactly what pushing B alone would have left. That
    // is what makes a crash-respawn a replay of the latest push rather than a reconciliation, and
    // what makes the input hash-friendly for ruling 18's cache key.
    let staged = Staged::new("replace", A_LOOT);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.send(&attach(1, &staged.path()));
    let _accepted = conn.reply(1);
    conn.wait_for_live(10);

    let a = vec![
        a_def("a1", "First", json!({"type":"event","kind":"loot"})),
        a_def("a2", "Second", json!({"type":"event","kind":"death"})),
    ];
    conn.send(&alerts_define(2, &a));
    assert_eq!(ack_count(&conn.reply(2)), Some(2));
    assert_eq!(conn.state(3, "alerts")["defs"], json!(a));

    let b = vec![a_def("a3", "Third", json!({"type":"raw","regex":"slain"}))];
    conn.send(&alerts_define(4, &b));
    assert_eq!(ack_count(&conn.reply(4)), Some(1));
    assert_eq!(
        conn.state(5, "alerts")["defs"],
        json!(b),
        "nothing of the first push survives the second"
    );

    // …and the empty set is a set, not a no-op: it is how a user who deleted their last alert is
    // described, and a client can tell it worked because the ack counts zero.
    conn.send(&alerts_define(6, &[]));
    assert_eq!(ack_count(&conn.reply(6)), Some(0));
    assert_eq!(conn.state(7, "alerts")["defs"], json!([]));
}

#[test]
fn each_family_changes_the_module_the_typescript_seam_changes() {
    // ONE WORKED EXAMPLE PER FAMILY, each read off the module's own published state — the same
    // state `module.snapshot` serves and the same state the TS module publishes over `module:delta`.
    let staged = Staged::new(
        "families",
        &format!("{A_DEATH}{A_JOIN}{AN_EXTERNAL_CAST}{A_SELF_CAST}"),
    );
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    // ── the pushes, all five, BEFORE the attach — which is what the app does on connect ─────────
    let defs = vec![a_def("a1", "Slain", json!({"type":"raw","regex":"slain"}))];
    conn.send(&alerts_define(1, &defs));
    assert_eq!(ack_count(&conn.reply(1)), Some(1));

    conn.send(&buff_trust_define(2, &["Dranix"]));
    assert_eq!(ack_count(&conn.reply(2)), None, "one object, no count");

    conn.send(&respawn_define(
        3,
        &[("a fire giant warlord", "a fire giant warlord")],
    ));
    assert_eq!(ack_count(&conn.reply(3)), None);

    // A correction over the whole session, naming an enchanter loadout. `startTs` is after the
    // launch anchor, exactly as `ipc/combo.ts` insists.
    conn.send(&combo_define(
        4,
        &[(1_787_000_000_000, None, &["ENC", "ROG"], 1_787_100_000_000)],
    ));
    assert_eq!(ack_count(&conn.reply(4)), Some(1));

    // THE EDIT IS DATED AFTER THE ZONE LINE, and that is not decoration: the zone line fires the
    // rebirth boundary, and an edit older than the last boundary described a group that belonged to
    // a character who no longer exists. The fold drops such an edit by DATE (`live_edits`), which is
    // the same rule `applyEdits` applies over there.
    conn.send(&roster_define(
        5,
        &[("rowel", "Rowel", "add", 1_787_200_000_000)],
    ));
    assert_eq!(ack_count(&conn.reply(5)), Some(1));

    conn.send(&attach(6, &staged.path()));
    let _accepted = conn.reply(6);
    conn.wait_for_live(100);

    // ── alerts: `setDefs` — the store's list, published verbatim ────────────────────────────────
    assert_eq!(conn.state(10, "alerts")["defs"], json!(defs));

    // ── respawn: `setPrefs` — the watch list is published, and the mob the log killed is WATCHED ─
    let respawn = conn.state(11, "respawn");
    assert_eq!(
        respawn["prefs"]["watches"][0]["key"], "a fire giant warlord",
        "{respawn}"
    );
    let recent = respawn["recent"].as_array().expect("a recent list");
    assert!(
        recent
            .iter()
            .any(|c| c["key"] == "a fire giant warlord" && c["watched"] == true),
        "the watch admits the mob the log already killed: {respawn}"
    );

    // ── roster: `setEdit` — a name the log never named is a member, at the top provenance rung ──
    let roster = conn.state(12, "roster");
    let members = roster["members"].as_array().expect("members");
    assert!(
        members
            .iter()
            .any(|m| m["key"] == "rowel" && m["source"] == "user"),
        "the user's add is a member: {roster}"
    );
    assert!(
        members.iter().any(|m| m["key"] == "dranix"),
        "and the log's own member is untouched: {roster}"
    );

    // ── combo: `setCorrection` — the correction re-labels the span it names ─────────────────────
    let combo = conn.state(13, "combo");
    let current = &combo["current"];
    assert_eq!(
        current["userLocked"], true,
        "the span the user re-labelled is locked to what they said: {combo}"
    );
    assert_eq!(current["slots"][0]["candidates"], json!(["ENC"]), "{combo}");
    assert_eq!(current["slots"][1]["candidates"], json!(["ROG"]), "{combo}");
    assert_eq!(
        current["slots"][0]["provenance"], "user",
        "and it says so: an inference the user overruled is labelled `user`, never `inferred`"
    );

    // ── buffTrust: `setTrust` — acknowledged here, PROVEN in the fold ───────────────────────────
    //
    // The allowlist is the one family whose effect is not published anywhere: it widens the buffs
    // model's ANCHOR rule, and what a client can see of that is a row that either opened or did
    // not. Making that assertion over a socket would mean writing a landing sentence whose
    // candidate resolution runs through the committed spell catalog — so the claim would rest on
    // which spells share an emote in `data/`, which is a fact about the corpus rather than about
    // this push. `fold`'s own `a_pushed_buff_trust_admits_an_external_casters_anchor` hands the
    // module the exact `cc` event instead, with its candidates written out, and asserts the hold
    // both ways. What this connection proves is the half that IS about the wire: the push was
    // taken, in the same batch as the other four, before any attach.
    assert_eq!(
        conn.state(14, "buffTimers")["holds"],
        json!([]),
        "and no hold was invented on the way: this log anchors nothing"
    );
}

#[test]
fn an_alert_fires_on_a_live_line_and_never_on_the_historical_scan() {
    // THE BOUNDARY LAW, over the socket: replay must never make a sound. The staged log ALREADY
    // CONTAINS a line this def matches — so a fold that fired on history would fire before the tail
    // ever ran, and the assertion below would catch it.
    let staged = Staged::new("fires", A_LOOT);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    let defs = vec![a_def(
        "a1",
        "Cloak of Flames",
        json!({"type":"event","kind":"loot","where":{"item":"Cloak of Flames"}}),
    )];
    conn.send(&alerts_define(1, &defs));
    assert_eq!(ack_count(&conn.reply(1)), Some(1));

    conn.send(&attach(2, &staged.path()));
    let _accepted = conn.reply(2);
    conn.wait_for_live(10);

    assert!(
        conn.fires.is_empty(),
        "the historical scan matched the def and said nothing: {:?}",
        conn.fires
    );
    // …and the module's own ring is empty for the same reason: a fire is what writes it.
    assert_eq!(conn.state(3, "alerts")["history"], json!({}));

    // THE GAME WRITES A LINE.
    staged.append(A_LATER_LOOT);
    let fire = conn.next_fire();

    assert_eq!(fire.rule, "Cloak of Flames", "the alert's own label");
    assert_eq!(
        fire.sound, "classic/bell",
        "the KEY the app plays, joined server-side — the app never re-reads the def"
    );
    assert_eq!(
        fire.message,
        A_LATER_LOOT.trim_end(),
        "the text that matched is the log line itself"
    );
    assert!(
        fire.at > 1_780_000_000_000,
        "the LOG's clock, not the host's: {}",
        fire.at
    );

    // And the fire is in the module's history now, which is the app-visible half of the same event.
    let history = conn.state(4, "alerts")["history"].clone();
    assert_eq!(history["a1"].as_array().map(Vec::len), Some(1), "{history}");
}

#[test]
fn a_define_made_while_the_tail_is_live_reaches_the_fold_that_is_running() {
    // The mid-session edit: a user saving an alert while the app is up. The ack is not a receipt
    // for a queue — it says the LIVE fold has this set — so the very next matching line sounds.
    let staged = Staged::new("mid", A_LOOT);
    let engine = Engine::start();
    let mut conn = Conn::new(engine.connected());

    conn.send(&attach(1, &staged.path()));
    let _accepted = conn.reply(1);
    conn.wait_for_live(10);

    let defs = vec![a_def(
        "a9",
        "Late rule",
        json!({"type":"event","kind":"loot"}),
    )];
    conn.send(&alerts_define(2, &defs));
    assert_eq!(ack_count(&conn.reply(2)), Some(1));

    staged.append(A_LATER_LOOT);
    assert_eq!(conn.next_fire().rule, "Late rule");
}
