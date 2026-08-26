//! VIEWS, OVER A REAL SOCKET, OFF A REAL FOLD (JOS-480).
//!
//! Every test here spawns the built binary, stages a log the product's own file name shape, attaches
//! it, and reads what a client would read. What it is proving is the half `src/views/` cannot prove
//! by itself: that the rows a client receives came off the fold on the ingest thread, that they
//! arrive in the order and at the moments the diff protocol names, and that the frames are the
//! shapes `src/shared/dataServer/viewWindow.ts` can apply.
//!
//! THE LOG IS WRITTEN HERE, LINE BY LINE, and that is deliberate rather than lazy. The committed
//! fixtures are dense traffic with no loot in them at all; this suite needs a ledger whose every
//! row is known so that an ORDER can be asserted rather than merely counted. The lines are real EQ
//! shapes (`eqlog::parse::world`'s own patterns) and they are dated after the launch anchor, so the
//! rebirth boundary fires on the zone line — before there is any loot to lose — exactly as it does
//! on a real log opened today.
//!
//! WHAT IS NOT HERE, and why. **`update` ops.** `loot.ledger` is append-only: a row's cells are
//! settled the moment it is folded, so a live window over it produces inserts and drops and never
//! an update. Writing a test that manufactured one over the socket would be testing a shape this
//! source cannot make; the op is proven exhaustively — changed cells only, an explicit null for a
//! cell that went away, newest-wins within a batch — in `views::diff`'s own unit tests, against the
//! ported client applier. **`subscribe` before any attach** is `tests/ops.rs`'s
//! `a_subscription_acknowledges_then_opens_with_an_empty_reset`: an ack, then a reset naming
//! generation 1 with nothing in it.

mod harness;

use harness::{attach, ledger, subscribe, subscribe_to, Engine, PATIENCE};
use protocol::generated::{
    DiffMessage, DiffOp, EngineMessage, ErrorCode, ResetMessage, Row, ViewDescriptor,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

// ---- the log this suite folds --------------------------------------------------------------

/// The zone every row below is tagged with, and the line that fires the rebirth boundary on an
/// empty ledger.
const ZONE: &str = "[Wed Aug 19 16:00:00 2026] You have entered Nagafen's Lair.\n";

/// FOUR LOOTS, in append order — `loot:0` through `loot:3`. The instants and the item names are
/// deliberately in DIFFERENT orders, so a sort by `at` and a sort by `item` cannot agree by
/// accident and an assertion about one is not silently an assertion about the other.
const LEDGER_LINES: &str = concat!(
    "[Wed Aug 19 16:11:19 2026] You have looted 2 Giant Warlord Bracer from a fire giant warlord corpse.\n",
    "[Wed Aug 19 16:12:00 2026] You have looted an Aged Bone Rod from a fire giant warlord corpse.\n",
    "[Wed Aug 19 16:13:52 2026] You have looted a Flowing Black Silk Sash from a fire giant warlord corpse.\n",
    "[Wed Aug 19 16:14:07 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.\n",
);

/// What the game writes next. The fixture moment 02's own loot, in the log's own grammar.
const A_KILL_DROPS: &str =
    "[Wed Aug 19 16:16:44 2026] You have looted a Golden Efreeti Boots from Efreeti Lord Djarn corpse.\n";

/// A scratch directory holding one log named the way the product names one, so the character comes
/// off the file name exactly as it does in the field.
struct Staged(PathBuf);

impl Staged {
    fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-views-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        let staged = Self(dir);
        staged.append(&format!("{ZONE}{LEDGER_LINES}"));
        staged
    }

    fn log(&self) -> PathBuf {
        self.0.join("eqlog_Primitive_freeport.txt")
    }

    /// Append the way EverQuest appends: an open, a write, a flush. ONE WRITE for whatever is
    /// handed over, which is what makes the coalescing test a claim rather than a race — several
    /// lines that land in one write land in one tail poll.
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

// ---- reading the stream ----------------------------------------------------------------------

/// ONE CONNECTION, READ ONCE AND SORTED BY SUBSCRIPTION.
///
/// A test holding two subscriptions must not be forced to read them in whatever order the engine
/// happened to interleave them — a reader that discarded the frames it was not looking for would
/// lose the other subscription's opening reset and then assert about the wrong one, which is a test
/// that fails for a reason that is not the code's. So every frame is buffered under the id it
/// names, and the two streams are read independently.
///
/// EPOCH FRAMES AND REPLIES ARE DROPPED HERE, and that is correct rather than lossy: progress is
/// connection-wide and arrives whether anybody asked for it, and the attach's own reply lands in
/// the middle of it. Their ordering is `tests/ingest.rs`'s claim; this suite is about what a
/// SUBSCRIPTION is told.
struct Stream {
    client: harness::Client,
    resets: std::collections::VecDeque<ResetMessage>,
    diffs: std::collections::VecDeque<DiffMessage>,
}

impl Stream {
    fn new(client: harness::Client) -> Self {
        Self {
            client,
            resets: std::collections::VecDeque::new(),
            diffs: std::collections::VecDeque::new(),
        }
    }

    fn send(&mut self, message: &protocol::generated::ClientMessage) {
        self.client.send(message);
    }

    fn pump(&mut self) {
        match self.client.recv() {
            EngineMessage::ResetMessage(reset) => self.resets.push_back(reset),
            EngineMessage::DiffMessage(diff) => self.diffs.push_back(diff),
            _ => {}
        }
    }

    /// The next `reset` for this subscription, buffered or read.
    fn reset(&mut self, id: i64) -> ResetMessage {
        loop {
            if let Some(at) = self.resets.iter().position(|r| *r.id == id) {
                return self.resets.remove(at).expect("just found");
            }
            self.pump();
        }
    }

    /// The next `diff` for this subscription.
    fn diff(&mut self, id: i64) -> DiffMessage {
        loop {
            if let Some(at) = self.diffs.iter().position(|d| *d.id == id) {
                return self.diffs.remove(at).expect("just found");
            }
            self.pump();
        }
    }

    /// A subscription's FIRST full window: the empty opening reset, then the one the landed fold
    /// sends.
    ///
    /// Both are resets and a client cannot tell them apart, which is the point of reset-then-diffs
    /// holding for an empty window — but a TEST has to, so it names the two by their epochs. The
    /// opening one names generation 1 (nothing has attached), the fold's names generation 2.
    fn window_when_the_fold_lands(&mut self, id: i64) -> ResetMessage {
        let opening = self.reset(id);
        assert_eq!(*opening.epoch, 1, "the opening reset names the first world");
        assert!(opening.rows.is_empty(), "nothing is attached yet");
        let landed = self.reset(id);
        assert_eq!(
            *landed.epoch, 2,
            "the fold's reset names the generation that landed"
        );
        landed
    }
}

fn keys(rows: &[Row]) -> Vec<&str> {
    rows.iter().map(|r| r.key.0.as_str()).collect()
}

fn cell<'a>(row: &'a Row, name: &str) -> &'a protocol::Cell {
    row.cells.get(name).expect("the cell exists")
}

/// Open a subscription and take the window the landed fold sends it. The log is attached here, so
/// every caller is a subscribe-BEFORE-attach — the mid-fold case, which is what a renderer does.
fn attached(
    engine: &Engine,
    staged: &Staged,
    id: i64,
    descriptor: ViewDescriptor,
) -> (Stream, ResetMessage) {
    let mut stream = Stream::new(engine.connected());
    stream.send(&subscribe_to(id, descriptor));
    stream.send(&attach(1, &staged.log().to_string_lossy()));
    let window = stream.window_when_the_fold_lands(id);
    (stream, window)
}

// ---- the registry ------------------------------------------------------------------------------

#[test]
fn a_source_this_engine_does_not_serve_is_not_found() {
    // PHASE 0 ACCEPTED EVERY DESCRIPTOR because there was no registry to be absent from. There is
    // one now, so the views schema's own rule holds: "an unknown one is a `notFound` error, never
    // an empty result".
    let engine = Engine::start();
    let mut client = engine.connected();

    // THE STAND-IN KEEPS MOVING, WHICH IS THE REGISTRY WORKING. `combat.live` stood here until
    // JOS-485 served it and `eventFeed.recent` until JOS-487 did; what is left is
    // `combat.encounters`, which the cutover ledger names and the drill-down ticket will serve.
    client.send(&subscribe(7, "combat.encounters"));
    let EngineMessage::ErrorReply(refusal) = client.recv() else {
        panic!("a refusal");
    };
    assert_eq!(*refusal.id, 7);
    assert!(matches!(refusal.error.code, ErrorCode::NotFound));
    assert!(
        refusal.error.message.contains("loot.ledger")
            && refusal.error.message.contains("combat.live")
            && refusal.error.message.contains("eventFeed.recent"),
        "the refusal names what IS served: {}",
        refusal.error.message
    );

    // …and the connection survives a refused subscription, which is the difference between a bad
    // request and a broken conversation.
    client.send(&subscribe(8, "loot.ledger"));
    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("an ack");
    };
    assert_eq!(*reply.id, 8);
}

#[test]
fn a_descriptor_this_source_cannot_answer_is_bad_params_rather_than_a_quiet_lie() {
    let engine = Engine::start();
    let mut client = engine.connected();

    // The plan doc's own worked example filters `{"session":"current"}`. `loot.ledger` carries no
    // such field, and serving every row while the client believes it filtered is the one answer
    // that cannot be debugged.
    let mut descriptor = ledger(&[], 0, 50);
    descriptor.filter = Some(protocol::generated::ViewFilter(
        std::collections::BTreeMap::from([("session".to_owned(), protocol::Cell::text("current"))]),
    ));
    client.send(&subscribe_to(7, descriptor));
    let EngineMessage::ErrorReply(refusal) = client.recv() else {
        panic!("a refusal");
    };
    assert!(matches!(refusal.error.code, ErrorCode::BadParams));
    assert!(refusal.error.message.contains("session"));

    // A window nobody could want is refused by its number rather than served slowly.
    client.send(&subscribe_to(8, ledger(&[], 0, 1_000_000)));
    let EngineMessage::ErrorReply(refusal) = client.recv() else {
        panic!("a refusal");
    };
    assert!(matches!(refusal.error.code, ErrorCode::BadParams));
}

// ---- the fold lands ----------------------------------------------------------------------------

#[test]
fn a_subscription_opened_before_the_attach_takes_its_rows_when_the_fold_lands() {
    let staged = Staged::new("land");
    let engine = Engine::start();
    let (_client, window) = attached(&engine, &staged, 7, ledger(&[], 0, 50));

    // NEWEST FIRST, which is what the flat ledger draws, and the whole view is four rows.
    assert_eq!(window.total, 4);
    assert_eq!(keys(&window.rows), ["loot:3", "loot:2", "loot:1", "loot:0"]);

    // RENDER-READY: the cells are what `FlatRow` puts on screen, off the fold, through the log's
    // own clock. Nothing here is a number the renderer would have to format.
    let head = &window.rows[0];
    assert_eq!(*cell(head, "at"), protocol::Cell::text("Aug 19, 04:14 PM"));
    assert_eq!(*cell(head, "item"), protocol::Cell::text("Cloak of Flames"));
    assert_eq!(
        *cell(head, "from"),
        protocol::Cell::text("a fire giant warlord")
    );
    assert_eq!(
        *cell(head, "zone"),
        protocol::Cell::text("Nagafen's Lair"),
        "the zone is the module's own state, tagged onto the row it folded"
    );
    assert_eq!(*cell(head, "count"), protocol::Cell::null());

    // …and the stacked loot keeps its magnitude as a NUMBER beside the name rather than inside it.
    let stacked = &window.rows[3];
    assert_eq!(
        *cell(stacked, "item"),
        protocol::Cell::text("Giant Warlord Bracer")
    );
    assert_eq!(*cell(stacked, "count"), protocol::Cell::int(2));
}

#[test]
fn the_window_offset_and_limit_are_honoured_and_total_ignores_them() {
    let staged = Staged::new("window");
    let engine = Engine::start();
    let (_client, window) = attached(&engine, &staged, 7, ledger(&[], 1, 2));

    assert_eq!(keys(&window.rows), ["loot:2", "loot:1"]);
    assert_eq!(
        window.total, 4,
        "total is the VIEW's size, which is what a `2-3 of 4` line reads off"
    );
}

#[test]
fn a_stated_sort_is_the_one_the_window_arrives_in() {
    let staged = Staged::new("sort");
    let engine = Engine::start();

    // The default, restated here beside its opposite so the two are one claim rather than two.
    let (_by_default, newest_first) = attached(&engine, &staged, 7, ledger(&[], 0, 50));
    assert_eq!(
        keys(&newest_first.rows),
        ["loot:3", "loot:2", "loot:1", "loot:0"]
    );

    // AND ONE EXPLICIT ONE. `item` ascending is not the reverse of `at` — the staged instants and
    // the staged item names are deliberately in different orders — so this cannot pass by
    // coincidence. It opens on a SECOND connection, over a fold that is already live: the empty
    // opening reset, then the full one the fold answers with at its next boundary.
    let mut second = Stream::new(engine.connected());
    second.send(&subscribe_to(9, ledger(&[("item", "asc")], 0, 50)));
    let opening = second.reset(9);
    assert!(
        opening.rows.is_empty(),
        "the rows live on the ingest thread; the opening reset is a connection thread's"
    );
    let sorted = second.reset(9);
    assert_eq!(
        keys(&sorted.rows),
        ["loot:1", "loot:3", "loot:2", "loot:0"],
        "Aged Bone Rod, Cloak of Flames, Flowing Black Silk Sash, Giant Warlord Bracer"
    );
}

// ---- live -------------------------------------------------------------------------------------

#[test]
fn a_line_the_game_writes_arrives_as_an_insert_at_the_head() {
    let staged = Staged::new("insert");
    let engine = Engine::start();
    let (mut client, window) = attached(&engine, &staged, 7, ledger(&[], 0, 50));
    assert_eq!(keys(&window.rows)[0], "loot:3");

    staged.append(A_KILL_DROPS);

    let diff = client.diff(7);
    assert_eq!(*diff.epoch, 2, "a live diff names the generation it is in");
    assert_eq!(
        diff.total,
        Some(5),
        "the view grew, so total rides — and only then"
    );
    let [DiffOp::InsertOp(insert)] = diff.ops.as_slice() else {
        panic!("one insert, got {:?}", diff.ops);
    };
    // NEWEST FIRST MEANS AT THE HEAD, and the head is named rather than implied: the client applies
    // ops positionally and an insert that named no anchor would mean "the window was empty".
    assert_eq!(insert.before.as_deref().map(String::as_str), Some("loot:3"));
    assert!(insert.after.is_none(), "exactly one anchor");
    assert_eq!(*insert.row.key, "loot:4");
    assert_eq!(
        *cell(&insert.row, "item"),
        protocol::Cell::text("Golden Efreeti Boots")
    );
    assert_eq!(
        *cell(&insert.row, "from"),
        protocol::Cell::text("Efreeti Lord Djarn")
    );
}

#[test]
fn a_full_window_pushes_its_oldest_row_out_in_the_same_batch() {
    // Fixture moment 02 exactly: a kill drops loot into a FULL newest-first window, so one row
    // enters and one leaves — and the one that left still exists in the view, which is why `total`
    // goes up while the window's size does not.
    let staged = Staged::new("overflow");
    let engine = Engine::start();
    let (mut client, window) = attached(&engine, &staged, 7, ledger(&[], 0, 4));
    assert_eq!(window.rows.len(), 4);

    staged.append(A_KILL_DROPS);

    let diff = client.diff(7);
    assert_eq!(diff.total, Some(5));
    assert_eq!(diff.ops.len(), 2, "{:?}", diff.ops);
    // THE DROP GOES FIRST so every anchor the batch names is a row the client still holds.
    let [DiffOp::DropOp(dropped), DiffOp::InsertOp(insert)] = diff.ops.as_slice() else {
        panic!("a drop then an insert, got {:?}", diff.ops);
    };
    assert_eq!(
        *dropped.key, "loot:0",
        "the oldest row fell out of the four"
    );
    assert_eq!(*insert.row.key, "loot:4");
    assert_eq!(insert.before.as_deref().map(String::as_str), Some("loot:3"));
}

#[test]
fn everything_written_between_two_services_arrives_as_one_frame() {
    // RULE 2, COALESCING: the cadence is ~10 Hz and the tail polls at 400 ms, so three lines the
    // game wrote in one breath are one frame and not three. They are written in ONE append for the
    // same reason the test can assert it — one write is one poll.
    let staged = Staged::new("coalesce");
    let engine = Engine::start();
    let (mut client, _window) = attached(&engine, &staged, 7, ledger(&[], 0, 50));

    staged.append(concat!(
        "[Wed Aug 19 16:20:00 2026] You have looted a Rusty Dagger from a gnoll pup corpse.\n",
        "[Wed Aug 19 16:20:01 2026] You have looted a Wolf Pelt from a gnoll pup corpse.\n",
        "[Wed Aug 19 16:20:02 2026] You have looted a Gnoll Fang from a gnoll pup corpse.\n",
    ));

    let diff = client.diff(7);
    assert_eq!(diff.total, Some(7));
    assert_eq!(
        diff.ops.len(),
        3,
        "three loots, one frame, three ops: {:?}",
        diff.ops
    );
    // …and they are inserted in the order the window holds them — newest first, so the LAST line
    // written is the head, and each of the others anchors on what the one before it put there.
    let inserted: Vec<&str> = diff
        .ops
        .iter()
        .map(|op| match op {
            DiffOp::InsertOp(insert) => insert.row.key.0.as_str(),
            other => panic!("an insert, got {other:?}"),
        })
        .collect();
    assert_eq!(inserted, ["loot:6", "loot:5", "loot:4"]);
}

#[test]
fn two_subscriptions_over_one_source_hold_their_own_windows() {
    // The renderer case: one list and one strip, over the same ledger, at different widths. They
    // are two windows and one source — the source is built ONCE per serve pass and cut twice.
    let staged = Staged::new("two");
    let engine = Engine::start();
    let mut client = Stream::new(engine.connected());

    client.send(&subscribe_to(7, ledger(&[], 0, 2)));
    client.send(&subscribe_to(9, ledger(&[("at", "asc")], 0, 3)));
    client.send(&attach(1, &staged.log().to_string_lossy()));

    let narrow = client.window_when_the_fold_lands(7);
    let oldest_first = client.window_when_the_fold_lands(9);
    assert_eq!(keys(&narrow.rows), ["loot:3", "loot:2"]);
    assert_eq!(keys(&oldest_first.rows), ["loot:0", "loot:1", "loot:2"]);
    assert_eq!(narrow.total, 4);
    assert_eq!(oldest_first.total, 4);

    // …and one append reaches both, differently: it is the newest row, so it enters the narrow
    // window at the head and pushes one out, and does not enter the oldest-first window at all.
    staged.append(A_KILL_DROPS);
    let into_narrow = client.diff(7);
    assert_eq!(into_narrow.ops.len(), 2, "{:?}", into_narrow.ops);
    let into_wide = client.diff(9);
    assert_eq!(
        into_wide.total,
        Some(5),
        "the view grew even though this window did not change"
    );
    assert!(
        into_wide.ops.is_empty(),
        "a window whose rows did not move sends no ops: {:?}",
        into_wide.ops
    );
}

// ---- the fixtures, replayed --------------------------------------------------------------------

#[test]
fn the_committed_moments_are_the_shapes_the_engine_actually_sends() {
    // `protocol/fixtures/01` and `02` are the verbatim truth over any prose (owner ruling 17). What
    // is checkable against a REAL source is their SHAPE — which keys a reset carries, which keys a
    // row carries, which keys an insert and a drop carry — because the fixtures' own contents are a
    // worked example over a log nobody has. So the fixture is read, its key sets are taken, and the
    // engine's own frames are held against them.
    let staged = Staged::new("fixtures");
    let engine = Engine::start();
    let (mut client, window) = attached(&engine, &staged, 7, ledger(&[], 0, 4));

    let subscribe = moment("01-subscribe.json");
    let reset = engine_message(&subscribe, 2);
    assert_eq!(
        object_keys(&serde_json::to_value(&window).expect("a reset serializes")),
        object_keys(reset),
        "a reset carries the fixture's own fields"
    );
    assert_eq!(
        object_keys(&serde_json::to_value(&window.rows[0]).expect("a row serializes")),
        object_keys(&reset["rows"][0]),
        "a row is {{key, cells}} — identity OUTSIDE the data"
    );

    staged.append(A_KILL_DROPS);
    let diff = client.diff(7);
    let live = moment("02-live-diff.json");
    let fixture_diff = engine_message(&live, 0);
    assert_eq!(
        object_keys(&serde_json::to_value(&diff).expect("a diff serializes")),
        object_keys(fixture_diff),
        "a diff that moved `total` carries all four fields"
    );
    // The fixture's ops are an insert-before and a drop, in that order; the engine's are a drop and
    // an insert-before. The ORDER inside a batch is the engine's to choose — the client applies in
    // order and both orderings produce the same window — so what is held against the fixture is
    // which OPS and which FIELDS, not which came first.
    let mut fixture_ops: Vec<Vec<String>> = fixture_diff["ops"]
        .as_array()
        .expect("ops")
        .iter()
        .map(object_keys)
        .collect();
    let mut ours: Vec<Vec<String>> = serde_json::to_value(&diff.ops)
        .expect("ops serialize")
        .as_array()
        .expect("an array")
        .iter()
        .map(object_keys)
        .collect();
    fixture_ops.sort();
    ours.sort();
    assert_eq!(ours, fixture_ops);
}

/// One committed fixture, read off disk.
fn moment(name: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is three levels below the repo root")
        .join("protocol")
        .join("fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("the fixture at {} is readable: {e}", path.display()));
    serde_json::from_str(&text).expect("a fixture is JSON")
}

/// The nth message of a fixture, insisting it is one the ENGINE sends.
fn engine_message(fixture: &serde_json::Value, at: usize) -> &serde_json::Value {
    let message = &fixture["messages"][at];
    assert_eq!(message["dir"], "engine", "{message}");
    &message["message"]
}

/// The field names of a JSON object, sorted.
fn object_keys(value: &serde_json::Value) -> Vec<String> {
    let mut keys: Vec<String> = value
        .as_object()
        .unwrap_or_else(|| panic!("an object, got {value}"))
        .keys()
        .cloned()
        .collect();
    keys.sort();
    keys
}

// ---- the engine measures itself ------------------------------------------------------------

#[test]
fn the_engine_reports_what_its_own_serve_path_cost() {
    // OWNER RULING 19, FOUNDATIONS. The `perf.budgets` surface is a later ticket; what must exist
    // now is the measurement, so that the surface has numbers to serve rather than a place to put
    // numbers nobody took. A stderr line is the honest minimal shape, and this is the pin that it
    // is real: a fold lands, a frame goes out, and the engine says what it cost.
    let staged = Staged::new("meter");
    let engine = Engine::watched();
    let (mut client, _window) = attached(&engine, &staged, 7, ledger(&[], 0, 50));
    staged.append(A_KILL_DROPS);
    let _diff = client.diff(7);

    let deadline = Instant::now() + PATIENCE;
    loop {
        let said = engine.diagnostics();
        if let Some(line) = said.iter().find(|line| line.contains("views: loot.ledger")) {
            assert!(line.contains("frames"), "{line}");
            assert!(line.contains("fold->frame"), "{line}");
            assert!(line.contains(" B (widest "), "the payload budget: {line}");
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the engine never reported its serve path: {said:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
