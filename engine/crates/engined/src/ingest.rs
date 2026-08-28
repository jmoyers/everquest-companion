//! One thread per attach: open the log, scan it at full speed, then tail it live, handing every
//! event to one [`EventSink`]. `eqlog` owns what an event is; this module owns who is folding, when
//! it stops, and what it says about itself.
//!
//! An attach preempts any in-flight attach — last pick wins, losers are dropped rather than queued
//! and return silently at their next slice boundary. Each attach builds its own sink and its own
//! parser, so two folds can never reach one set of modules.
//!
//! Nothing event-derived reads a wall clock. Exactly two wall-clock reads reach a sink:
//! [`SinkInputs::attached_at_ms`], once per attach, and [`EventSink::tick`], ~1×/sec and live only.
//! The historical scan never ticks — the tick loop lives past the `TailStart::At` handoff, which is
//! what keeps a replay a pure function of its bytes.

use std::fs::File;
use std::io::{self, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use protocol::generated::HealthResultStatus;

use eqlog::event::Ev;
use eqlog::parse::Parser;
use eqlog::tail::{FileTail, TailCore, TailStart, DEFAULT_POLL_INTERVAL, LIVE};
use eqlog::{host_timezone, spelldb, Clock};

use crate::spawn::DIAGNOSTIC_PREFIX;
use crate::views::{self, Meter};
use crate::world::{FoldMark, World};

/// How many bytes one scan read asks for.
///
/// The scan is deliberately impolite — no yield, no throttle, no slice sleep; the process boundary
/// is what keeps it off the UI. The tail keeps `eqlog`'s 256 KiB slicing, which is about
/// EverQuest's synchronous append rather than about this process's manners.
///
/// A buffer, not a promise: `Read::read` may hand back less. It is also the granularity at which
/// the generation is polled and progress may be announced — big enough to amortize a read, small
/// enough that a preempted fold abandons within milliseconds.
const SCAN_READ_BYTES: usize = 1 << 20;

/// The floor between two progress announcements — ~4/s max, never per-line.
///
/// A cadence rather than a count: an events-based cadence would announce a hundred frames a second
/// on a dense raid slice and none at all on a quiet one.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// The longest prefix of an event's JSON that is searched for its timestamp. See [`ts_of`].
const TS_SCAN_BYTES: usize = 128;

/// The nap the tail loop sleeps in, so a preempted tail notices promptly instead of after a whole
/// poll interval. Mirrors `FileTail::follow`'s own nap.
const TAIL_NAP: Duration = Duration::from_millis(25);

/// The live world's heartbeat interval — `session.ts startHeartbeat`'s `setInterval(…, 1000)`,
/// exactly. See [`Ticking`] for why it is a ceiling rather than a schedule.
const TICK_EVERY: Duration = Duration::from_secs(1);

/// One folded event, as the ingest hands it to a sink.
///
/// Borrowed, never owned: both halves live in the parser's reused buffers and are valid for exactly
/// this call. A sink that needs to keep one copies it, which makes the copy the sink's decision.
pub struct Event<'a> {
    /// The event, serialized. Byte-identical to the TS pipeline's `JSON.stringify(ev)`.
    ///
    /// Built eagerly even though the fold reads `payload` instead: this is the parser oracle's
    /// byte-identity artifact and the format every golden is recorded in, measured at under half a
    /// percent of a fold.
    pub json: &'a str,
    /// The same event, typed — what the fold reads. Recorded in the same call that serialized
    /// `json`, so the two halves cannot disagree about what the parser said.
    pub payload: &'a eqlog::event::Payload,
    /// The event's sequence number. Counts events, not lines, and starts at 0 for each attach.
    pub seq: i64,
    /// `false` for the historical scan, `true` for the live tail. A property of the source, not of
    /// the line — `eqlog::tail::LIVE` is the constant this stamps for the tail half.
    pub live: bool,
}

/// Where ingest ends. The fold seam: one trait, events in, state out.
///
/// The fold registry implements this in `crate::foldsink` (the orphan rule requires the impl to
/// live in this crate); its factory reaches the world as
/// `World::with_ingest(ingest::starter(<factory>))`.
///
/// Not `Send`, deliberately. A sink is built on the ingest thread and never crosses a thread
/// boundary, and the bound would forbid the fold: `fold::Fold` holds the buffs/buffTimers shared
/// core in an `Rc<RefCell<…>>`. The single-threadedness is stated by the type rather than promised.
pub trait EventSink {
    /// One event, in emission order. Called once per event, on the ingest thread, and on no other.
    fn event(&mut self, event: &Event<'_>);

    /// The live heartbeat: the wall clock, in epoch millis, handed to the fold ~1×/sec —
    /// `session.ts startHeartbeat`'s `registry.tick(Date.now())`, moved into the process that owns
    /// the fold.
    ///
    /// Called only while the status is `live`. A replay whose output depended on when it was run
    /// would break the equivalence oracle. The one driver is the tail loop, past the
    /// `TailStart::At` handoff — see [`Ticking`].
    ///
    /// Defaulted to nothing: a sink that folds no modules has no model to age.
    fn tick(&mut self, _now_ms: i64) {}

    /// What this sink can say about itself.
    ///
    /// Defaulted because a fold registry may have nothing to add: the ingest counts events itself
    /// and only merges what a sink volunteers.
    fn report(&self) -> SinkReport {
        SinkReport::default()
    }

    /// One module's published state, or `None` when this sink folds no module by that name.
    ///
    /// `&self` and not `&mut self`: a snapshot that could advance the fold would make the answer
    /// depend on who asked. `None` becomes the protocol's `notFound` — the registry is the
    /// authority, and an empty state would be a lie about a module that does not exist.
    ///
    /// Called on the ingest thread, between events, and on no other — see [`SnapshotAsk`].
    fn snapshot(&self, _module: &str) -> Option<ModuleSnapshot> {
        None
    }

    /// Every row of one view source, in its natural order — the view layer's door onto this fold.
    /// `None` for a source this sink does not carry, which is not an error: a subscription over a
    /// sink that folds no modules gets an honest empty window.
    ///
    /// `&self` for [`EventSink::snapshot`]'s reason, and called at the same boundaries: on the
    /// ingest thread, between events, never inside one, so the rows a window is cut from are a real
    /// prefix state rather than a torn one.
    fn source_rows(&self, _source: &'static views::SourceDef) -> Option<Vec<views::SourceRow>> {
        None
    }

    /// Take one family of app knowledge — the `*.define` commands.
    ///
    /// `true` when a module took it. Defaulted to `false`, because a define this sink cannot apply
    /// is not an error: the world still holds the push, and the next attach that builds a real fold
    /// applies it at construction.
    ///
    /// `&mut self`, called on the ingest thread at the boundaries [`EventSink::snapshot`] is
    /// answered at — which is what makes every write on this door a point on the event stream
    /// rather than a race with one: no event folds half-way across it.
    fn define(&mut self, _family: &str, _payload: &serde_json::Value) -> bool {
        false
    }

    /// Take a session mark — `sessionMarks.add`'s effect on the meter, at `define`'s boundaries.
    ///
    /// `true` when the combat engine took it. Defaulted to `false`: a sink with no engine has no
    /// fight to close, the same honest `false` a hydrating engine answers.
    fn session_mark(&mut self, _at: i64) -> bool {
        false
    }

    /// Confirm a sighting — `respawn.confirmSighting`'s effect on the respawn clocks, at `define`'s
    /// boundaries. The boundary matters here rather than being ceremony: the very next death line
    /// re-bases the row back, so a confirm applied inside one would be a clock whose base depended
    /// on where in a line it landed.
    ///
    /// `true` when the fold re-based that row's clock onto the log's last sighting. `false` covers
    /// no respawn module, an unknown id and a row not currently seen with one answer — the single
    /// boolean `src/main/modules/respawn.ts confirmSighting` returns for the same three cases.
    fn confirm_sighting(&mut self, _row_id: &str) -> bool {
        false
    }

    /// The alert fires this sink produced since the last drain.
    ///
    /// Structurally empty for a historical scan: firing is live-only, gated where the TypeScript
    /// gates it — one gate above the matcher loop.
    fn take_fires(&mut self) -> Vec<Fire> {
        Vec::new()
    }

    /// The con cards this sink resolved since the last drain. Structurally empty for a historical
    /// scan on [`EventSink::take_fires`]'s terms: a card is a thing that happens, and a startup
    /// replay of a month of logs must draw none.
    ///
    /// It hands back the protocol's own shape, the one place this crate's vocabulary rule bends: a
    /// con card is resolved by this crate (`crate::concard`), so a third struct in between would be
    /// the wire shape with a different spelling.
    fn take_con_cards(&mut self) -> Vec<protocol::generated::ConCardMessage> {
        Vec::new()
    }

    /// Every module's published cursor — the module dirty bit's whole read.
    ///
    /// Cheap by contract: a counter per module, never a serialization. The serve loop asks once per
    /// beat, so an idle session costs twenty integer comparisons ten times a second.
    ///
    /// `&self` for [`EventSink::snapshot`]'s reason, and called at the same boundaries.
    fn module_seqs(&self) -> Vec<(&'static str, i64)> {
        Vec::new()
    }

    /// The combat engine's whole snapshot, and the instant it was taken at.
    ///
    /// `None` when this sink folds no combat engine, which the world turns into `unavailable`.
    ///
    /// `&self`, answered at [`EventSink::snapshot`]'s boundaries, so a mid-scan answer is a real
    /// prefix state. The instant is the sink's to choose rather than a parameter, because only the
    /// thread holding the fold knows whether it has reached its tail — which is what decides
    /// between a wall clock and the log's own last stamp.
    ///
    /// `&self` is not "nothing moved" once the tail is live: the engine ages its model at the
    /// instant taken — charm sweep, ally-bind expiry, pet nudge, deferred encounter closure —
    /// behind a cell of its own, so a live answer can close a fight that ended while the log was
    /// quiet. While the scan runs the sweeps are unreachable. See [`answer_asks`].
    fn combat_snapshot(&self, _opts: &CombatOpts) -> Option<CombatSnapshot> {
        None
    }

    /// The fight-history search. `None` on [`EventSink::combat_snapshot`]'s terms.
    ///
    /// The corpus is the fold's uncapped encounter history plus the open fight; the ranking is
    /// `crate::search`. A read that allocates the corpus it ranks, answered at the same boundaries
    /// and deliberately on no cadence — a person typed into a box.
    fn search_fights(&self, _query: &str, _limit: usize) -> Option<FightSearch> {
        None
    }

    /// The names the fold's own knowledge probes could not answer, drained here and announced
    /// connection-wide as `knowledgeMiss` frames.
    ///
    /// `take_fires`'s shape and reason: a lookup called from inside a fold cannot reach the world,
    /// so it buffers and this thread drains at a boundary it already reaches. Unlike a fire, a miss
    /// is a fact about the process's corpus rather than a thing that happened in the log, which is
    /// why the frame carries no epoch and the drain is not generation-gated on the way out (see
    /// `World::announce_knowledge_misses`).
    fn take_knowledge_misses(&mut self) -> Vec<fold::knowledge::Miss> {
        Vec::new()
    }

    /// What you have looted off one creature, for a `knowledge.mob` answer — the fold's half of a
    /// join whose other half is committed data. A sink with no such index answers with no rows.
    fn own_loot_drops(&self, _spellings: &[String]) -> Vec<fold::knowledge::SeenDrop> {
        Vec::new()
    }

    /// How old these creatures are, as the resist fold knows it.
    ///
    /// `&self` and therefore safe on this door: [`fold::modules::resist::ResistModule::level_of`]
    /// is the non-memoising read, which is the whole reason that form exists.
    ///
    /// A sink with no resist module answers with no rows, which is not a special case: it is the
    /// same value a creature nobody has conned and the catalog has never heard of answers with, and
    /// the app reads both as the `null` its profile builder handles. `own_loot_drops` makes the
    /// same choice for the same reason.
    fn mob_levels(
        &self,
        _names: &[String],
    ) -> Vec<(String, fold::modules::resist::world::MobLevelFact)> {
        Vec::new()
    }

    /// A monotonic signal that moves whenever `source` could have changed.
    ///
    /// The view layer's whole cost model rests on this: a subscription is re-cut only when its
    /// source's revision has moved since the window it holds was built, so an idle session pays a
    /// comparison per cadence tick and nothing else. It must be cheap (a counter read, never a
    /// serialization) and honest — a signal that could repeat across a change would let a stale
    /// window stand.
    fn source_revision(&self, _source: &'static views::SourceDef) -> Option<u64> {
        None
    }
}

/// The view layer's [`views::Rows`], over whatever sink this attach is folding into.
///
/// A borrow, built per pass and dropped with it: the sink lives on the ingest thread and this is
/// only the shape the world asks it questions in.
pub struct SinkRows<'a>(pub &'a dyn EventSink);

impl views::Rows for SinkRows<'_> {
    fn rows(&self, source: &'static views::SourceDef) -> Option<Vec<views::SourceRow>> {
        self.0.source_rows(source)
    }
    fn revision(&self, source: &'static views::SourceDef) -> Option<u64> {
        self.0.source_revision(source)
    }
}

/// One module's published state, exactly as `EqModule::snapshot` publishes it.
#[derive(Debug, Clone, PartialEq)]
pub struct ModuleSnapshot {
    /// The module's own seq — for most modules the seq of the last event it folded, and for the
    /// four that publish a private revision counter, that counter. A hydration cursor, never the
    /// fold's event count.
    pub seq: i64,
    /// The module's state. The shape is the module's, not this crate's and not the protocol's:
    /// `kills` publishes an object, `loot` publishes an array, and nothing between the module and
    /// the wire is allowed an opinion about which.
    pub state: serde_json::Value,
}

/// What a combat snapshot was asked for — `src/shared/combat.ts SnapshotOpts`, in the ingest's own
/// vocabulary.
///
/// A third spelling of one idea, on [`Fire`]'s terms and for its reason: this module must not learn
/// what a fold is, and `ops.rs` must not learn what the fold's types are called. The op table
/// validates and clamps; this carries; `crate::foldsink` converts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CombatOpts {
    /// Which fight or zone session to resolve the selection against, or `None` for the default.
    pub selected_id: Option<String>,
    /// Include lines the engine could not classify.
    pub show_unparsed: bool,
    /// Cap on finalized-fight summaries. A payload bound, never a retention one.
    pub max_segments: usize,
    /// Include the selected encounter's event timeline.
    pub timeline: bool,
}

/// The combat engine's snapshot, and the instant it describes.
///
/// The pair rather than the state alone, because `now` is not recoverable from the payload and the
/// whole answer is a function of it — see the protocol's `CombatSnapshotResult.now`.
#[derive(Debug, Clone, PartialEq)]
pub struct CombatSnapshot {
    /// The instant the snapshot was taken at, in epoch millis.
    pub now: i64,
    /// The snapshot. The shape is the engine's, exactly as [`ModuleSnapshot::state`]'s is a
    /// module's — nothing between the fold and the wire is allowed an opinion about it.
    pub state: serde_json::Value,
}

/// One ranked fight.
#[derive(Debug, Clone, PartialEq)]
pub struct FightHit {
    /// The `SegmentSummary`, exactly as the fold published it.
    pub summary: serde_json::Value,
    /// 0..1 relevance.
    pub score: f64,
}

/// What a fight search found, and how much it looked through.
#[derive(Debug, Clone, PartialEq)]
pub struct FightSearch {
    /// The ranked hits, already capped by the caller's limit.
    pub hits: Vec<FightHit>,
    /// How many fights were searched — present even when nothing matched, because "no matches in
    /// 1,428" and "nothing to search" are different sentences.
    pub corpus: i64,
}

/// One alert fire, as the ingest hands it to the world.
///
/// The ingest's own vocabulary, exactly as [`ModuleSnapshot`] is: `crate::foldsink` converts the
/// fold's shape into it at the seam, so neither this module nor `world.rs` learns what an alert is.
/// The world turns it into the protocol's `FireMessage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fire {
    /// The `ts` of the event that matched — the log's own clock.
    pub at: i64,
    /// The alert's label.
    pub rule: String,
    /// `<packId>/<soundId>` — the key the app plays. Resolved by the fold, never a reference.
    pub sound: String,
    /// The text that matched.
    pub message: String,
    /// What this firing may say — the rule's own named captures plus the `{target}` auto token,
    /// already sanitized and capped by the fold. Absent for nearly every alert.
    pub captures: Option<std::collections::BTreeMap<String, String>>,
    /// The spell this firing is about, rank suffix intact. Absent when the family names none.
    pub spell: Option<String>,
    /// The deadline an early warning was early for. Absent on every ordinary fire.
    pub due_at: Option<i64>,
}

/// One push of app knowledge, and the way back.
///
/// [`SnapshotAsk`]'s shape with one direction reversed: the fold lives on the ingest thread and a
/// `*.define` arrives on a connection thread. A `Mutex<Fold>` would put a second owner on state
/// whose whole design is one door; a copy applied later would make the moment a define takes effect
/// unknowable. So the writer posts and waits, and the ingest applies it at a boundary it reaches.
///
/// The wait is what makes the ack mean something: `applied: true` says the live fold has this set,
/// not that a queue accepted it.
pub struct DefineAsk {
    /// The family: `alerts`, `buffTrust`, `respawn`, `combo`, `roster`.
    pub family: String,
    /// The whole set, as the app pushed it.
    pub payload: serde_json::Value,
    /// Where the answer goes: `true` when a module took it.
    pub answer: std::sync::mpsc::Sender<bool>,
}

/// One session mark, and the way back — `sessionMarks.add`'s effect on the meter.
///
/// On the write door rather than [`Ask`] because of what it does: a mark closes the open fight and
/// freezes the running stay. `answer_asks` takes the sink by `&dyn` precisely so that every arm on
/// it is provably a read, and a mark cannot be one.
pub struct MarkAsk {
    /// The instant main stamped for the whole click, so the loot split and this split share one
    /// boundary. Never re-derived here from a host clock.
    pub at: i64,
    /// Where the answer goes: whether the engine took it (false while it is still hydrating).
    pub answer: std::sync::mpsc::Sender<bool>,
}

/// One confirmed sighting, and the way back — `respawn.confirmSighting`'s effect on the respawn
/// clocks.
///
/// On the write door for [`MarkAsk`]'s reason: confirming re-bases a clock and bumps a module's
/// revision, so it will not compile behind `answer_asks`'s `&dyn`.
///
/// It carries no instant, which is the one place it differs from [`MarkAsk`]. A mark's subject is
/// an instant, stamped app-side so the loot split and the meter split share one boundary; a
/// confirmation's subject is a row, and the instant it re-bases onto is that row's own `seenTs`, a
/// log timestamp this fold already holds.
pub struct ConfirmAsk {
    /// The row the person pressed — `<zone key>::<mob key>`, the id the fold keys its history by.
    pub row_id: String,
    /// Where the answer goes: whether a clock actually moved.
    pub answer: std::sync::mpsc::Sender<bool>,
}

/// Every statement made *to* the fold — the write door, the mirror image of [`Ask`].
///
/// An arm here is handed the sink by `&mut` and may move the world; an arm on [`Ask`] is handed it
/// by `&` and may only read. Which door a new request belongs on is therefore decided by the
/// compiler rather than by convention.
///
/// One channel for every write, for the reason [`Ask`] is one channel for every read: the fold is
/// reached at a boundary it already services, and a second channel would be a second thing this
/// loop has to remember to drain in all four places (mid-scan, the live poll, the nap, the
/// landing).
pub enum Write {
    /// One family of app knowledge — see [`DefineAsk`].
    Define(DefineAsk),
    /// One session mark — see [`MarkAsk`].
    Mark(MarkAsk),
    /// One confirmed sighting — see [`ConfirmAsk`].
    Confirm(ConfirmAsk),
}

/// One request for one module's state, and the way back.
///
/// A channel and not a lock, which is the load-bearing rule of this seam. A `Mutex<Fold>` would
/// make the fold's hot loop take a lock per event to serve a reader that asks a few times a minute,
/// and a snapshot copy published after every event is a cache. So the reader posts and waits, and
/// the ingest answers between two reads of the scan or two polls of the tail — never shared, never
/// locked, never interrupted mid-event, so the answer is a real prefix state.
///
/// The cost is a bounded wait on the asking thread; `World::module_snapshot` owns the deadline that
/// turns a wedged ingest into an `unavailable` reply.
pub struct SnapshotAsk {
    /// The module id the client named.
    pub module: String,
    /// Where the answer goes. `None` means the sink folds no such module.
    pub answer: std::sync::mpsc::Sender<Option<ModuleSnapshot>>,
}

/// Every question the one door carries. Adding a reader means adding an arm here and nowhere else.
///
/// One channel rather than one per question: the fold is asked at a boundary it already reaches,
/// and a second channel would be a second place the ingest loop has to remember to drain — which is
/// how one ends up drained only during the tail.
pub enum Ask {
    /// One module's published state — see [`SnapshotAsk`].
    Module(SnapshotAsk),
    /// What this ingest has cost — see [`PerfAsk`].
    Perf(PerfAsk),
    /// The combat engine's whole snapshot — see [`CombatAsk`].
    Combat(CombatAsk),
    /// A ranked search of the fight history — see [`FightSearchAsk`].
    Fights(FightSearchAsk),
    /// What has been looted off one creature — see [`LootAsk`].
    Loot(LootAsk),
    /// How old some creatures are, as the resist fold knows it — see [`MobLevelAsk`].
    MobLevels(MobLevelAsk),
}

/// One `resist.levels` question.
///
/// Same door as every arm above, and the reason is sharper here: the answer is session state. A
/// `/con` the player typed thirty seconds ago beats the committed catalog, and that statement lives
/// inside the resist fold on the ingest thread — there is nowhere else to read it from.
///
/// Plural because the op is: the caller sends the names as the log spells them, already bounded by
/// the op table, and this thread folds each key and answers what it can state.
pub struct MobLevelAsk {
    /// The creature names to answer for, as the asker spelled them.
    pub names: Vec<String>,
    /// Where the answer goes: the echoed name beside the fact, and no entry for a creature the fold
    /// can state nothing about. A short list is the honest answer rather than a padded one — see
    /// the schema's `ResistLevelsResult`.
    pub answer: std::sync::mpsc::Sender<Vec<(String, fold::modules::resist::world::MobLevelFact)>>,
}

/// One request for the combat engine's snapshot.
///
/// Same door as [`SnapshotAsk`], and the argument does not weaken with size: the combat engine's
/// state is the largest thing this fold holds, which makes a `Mutex` around it the worst of the
/// shapes rather than the most tempting — the fold's hot loop would take that lock on every damage
/// line to serve a reader that asks once a second.
pub struct CombatAsk {
    /// What the caller asked for, already validated and clamped by the op table.
    pub opts: CombatOpts,
    /// Where the answer goes. `None` means this fold carries no combat engine.
    pub answer: std::sync::mpsc::Sender<Option<CombatSnapshot>>,
}

/// One fight-history search.
///
/// The one ask on this door that is user-initiated, which is why the door's boundary rule is stated
/// as a ceiling rather than a budget — `src/main/ipc/world.ts` makes the same distinction by
/// leaving its own search handler out of the timed seams.
pub struct FightSearchAsk {
    /// What the user typed.
    pub query: String,
    /// How many ranked hits to return, already clamped by the op table.
    pub limit: usize,
    /// Where the answer goes. `None` means this fold carries no combat engine.
    pub answer: std::sync::mpsc::Sender<Option<FightSearch>>,
}

/// One request for the own-loot half of a mob answer.
///
/// Same door, and a third arm rather than a shortcut. The `knowledge.mob` op joins the committed
/// catalog, which the world can read for itself, with your loot history, which lives inside the
/// `consider` module on the ingest thread and is character- and epoch-scoped. Reading the second
/// any other way would mean sharing the fold or publishing a copy of it after every loot line.
///
/// The answer is never `None`: a fold with no such index and a creature nothing has been looted
/// from both answer with no rows, which is the same sentence and deserves the same value.
pub struct LootAsk {
    /// Every `mobKey` the creature answers to, canonical first — the corpus resolved them.
    pub spellings: Vec<String>,
    /// Where the answer goes.
    pub answer: std::sync::mpsc::Sender<Vec<fold::knowledge::SeenDrop>>,
}

/// One request for the ingest's own cost.
///
/// Same door, and the meter is not simply shared instead because it is `&mut` on the ingest thread
/// by construction — it is written on the serve path, the hottest thing this thread does after the
/// parse. Posting an ask costs the fold one `try_recv` at a boundary it was reaching anyway.
///
/// The answer is never `None`: an ingest that has served nothing still has an honest answer, which
/// is a different sentence from the `unavailable` a world with no fold at all gives.
pub struct PerfAsk {
    /// Where the answer goes.
    pub answer: std::sync::mpsc::Sender<EnginePerf>,
}

/// What the ingest thread says about itself: what starting this generation cost, and what serving
/// it has cost since.
///
/// Not the generated type. The mapping onto `PerfSnapshotResult` happens in `world.rs`, where the
/// world's own half of the answer (status, epoch, mark, subscriber counts) is merged in.
#[derive(Debug, Clone, Default)]
pub struct EnginePerf {
    /// What building this generation cost.
    pub ingest: IngestCost,
    /// One row per source that has served a frame, ordered by name.
    pub serve: Vec<views::SourceMeter>,
    /// The bounded recent history, oldest first — what `perf.timeline` serves.
    ///
    /// It rides the answer `perf.snapshot` already asked for rather than earning a second `Ask`
    /// arm: each new door would be another `try_recv` on the hot boundary, while carrying the ring
    /// along costs copying at most `views::TIMELINE_CAPACITY` five-integer structs. One ask, one
    /// answer, three views of it.
    pub timeline: Vec<views::Moment>,
}

/// What starting one generation cost, measured rather than modelled.
///
/// Every field is an `Option` and absent means not yet measured. A `scan_ms` of zero would say a
/// whole log folded instantly, which is the report of a scan that has not finished rather than of a
/// fast one — the same rule `HealthResult`'s last three fields keep.
#[derive(Debug, Clone, Copy, Default)]
pub struct IngestCost {
    /// How long the spell catalog took to become available for this attach.
    pub spell_db_ms: Option<u64>,
    /// Wall time from the first byte read to the fold landing.
    pub scan_ms: Option<u64>,
    /// Bytes the scan read, up to the mark it landed on.
    pub scan_bytes: Option<u64>,
}

/// What a sink volunteers about itself.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SinkReport {
    /// Events this sink has taken.
    pub events: i64,
    /// How many of them arrived live. The split between "this came out of history" and "this is
    /// happening now" is the one a loading UI and a bug report both want, and it is free here.
    pub live_events: i64,
    /// The `seq` of the last event taken. Reported rather than derived from `events`: they are the
    /// same number only for a sink that keeps everything, and a fold that declines an event is
    /// exactly the case where the difference matters.
    pub last_seq: Option<i64>,
    /// The `ts` of the last event taken — the log's own clock, never the host's.
    pub last_ts: Option<i64>,
}

/// The honest floor under a fold: a counter, and nothing else. `session.health` can say how much
/// has been folded and how far into the log's own time it reached without any module existing yet.
#[derive(Debug, Default)]
pub struct CountingSink {
    events: i64,
    live_events: i64,
    last_seq: Option<i64>,
    last_ts: Option<i64>,
}

impl EventSink for CountingSink {
    fn event(&mut self, event: &Event<'_>) {
        self.events += 1;
        if event.live {
            self.live_events += 1;
        }
        self.last_seq = Some(event.seq);
        // A stamp that cannot be read is not a zero: the last one that could be read stands, which
        // keeps `lastTs` monotonic over a log holding a line the timestamp pattern declines.
        if let Some(ts) = ts_of(event.json) {
            self.last_ts = Some(ts);
        }
    }

    fn report(&self) -> SinkReport {
        SinkReport {
            events: self.events,
            live_events: self.live_events,
            last_seq: self.last_seq,
            last_ts: self.last_ts,
        }
    }
}

/// Everything an attach knows by the time it could build a fold, handed to the sink factory.
///
/// Exactly the set the parse is a pure function of, plus the one wall-clock instant a world is
/// constructed at. Nothing here is discovered by the engine: the log path came from the app, the
/// character comes off that path's file name, and the catalog is committed data.
pub struct SinkInputs<'a> {
    /// The log this attach opened.
    pub log: &'a Path,
    /// The character whose log it is, off the file name. `None` when the name is not a log's.
    pub character: Option<&'a str>,
    /// The parser's effective spell catalog — the process's one copy (`eqlog::spelldb::shared`).
    /// `None` is representable so a caller can build a sink with no catalog; production never does.
    pub db: Option<&'a spelldb::SpellDb>,
    /// The parser's own clock. Handed over rather than rebuilt, because a fold that resolved its
    /// launch instant through a second zone would answer a different question than the parser's
    /// timestamps ask.
    pub clock: &'a Clock,
    /// When this attach happened, in epoch millis — the world's construction clock.
    ///
    /// The one wall-clock read that reaches a sink. Over there `WorldOpts.constructionNowMs`
    /// defaults to `Date.now()` at construction and the respawn module seeds its ordering clock
    /// from it; the golden recorder pins it to the slice's last timestamped line only so a golden
    /// re-checks tomorrow. It is not fold-derived state, and no module may read a clock after this.
    pub attached_at_ms: i64,
    /// The app's `userData`, or `None` when the attach did not carry one.
    ///
    /// App knowledge: the engine cannot derive it and must not guess it. `None` is the honest state
    /// for every caller but the app, and it means no persistence at all — no read, no write, and
    /// the file-free fold the equivalence oracle records. See [`crate::state`].
    pub state_dir: Option<&'a Path>,
}

/// Builds the sink one attach folds into. The construction seam — see [`EventSink`].
pub type SinkFactory = Arc<dyn Fn(&SinkInputs<'_>) -> Box<dyn EventSink> + Send + Sync>;

/// The factory a plain engine uses.
#[must_use]
pub fn counting_sinks() -> SinkFactory {
    Arc::new(|_inputs| Box::new(CountingSink::default()))
}

/// What [`World`] does when an attach is accepted: begin folding this log, under this generation.
///
/// The world holds one of these rather than a sink factory so that what an attach starts is a
/// single injected decision. Production hands it [`starter`]; `world.rs`'s own unit tests hand it a
/// no-op, which is how the epoch and subscription laws are proven without a fold in the room.
///
/// The fourth argument is the app's `stateDir`, `None` for every caller that did not push one. See
/// [`crate::state`] for why absent means no persistence at all rather than a default location.
pub type Starter = Arc<dyn Fn(&World, u64, PathBuf, Option<PathBuf>) + Send + Sync>;

/// The starter a real engine uses: one ingest thread per attach, folding into `sinks`.
#[must_use]
pub fn starter(sinks: SinkFactory) -> Starter {
    Arc::new(move |world, generation, log, state_dir| {
        start(world, generation, log, state_dir, Arc::clone(&sinks));
    })
}

/// The starter [`World::new`](crate::world::World::new) uses — counting sinks, nothing folded.
#[must_use]
pub fn default_starter() -> Starter {
    starter(counting_sinks())
}

/// Read an event's `ts` back out of its serialized form.
///
/// A scan of a bounded prefix, exact rather than heuristic: `Ev::envelope` writes `seq`, `ts`,
/// `raw` in that order and the only kind that writes anything ahead of the envelope is `group` (a
/// short `change` string), so the first `"ts":` in an event is always the envelope's and always
/// well inside [`TS_SCAN_BYTES`]. `raw` — the only field that could contain a counterfeit — is
/// written after it, every time.
///
/// Bytes, not `str`, so a prefix cut cannot land inside a multi-byte character and panic.
fn ts_of(json: &str) -> Option<i64> {
    const KEY: &[u8] = b"\"ts\":";
    let bytes = json.as_bytes();
    let head = &bytes[..bytes.len().min(TS_SCAN_BYTES)];
    let at = head.windows(KEY.len()).position(|w| w == KEY)?;
    let mut i = at + KEY.len();
    let negative = head.get(i) == Some(&b'-');
    if negative {
        i += 1;
    }
    let first_digit = i;
    let mut value: i64 = 0;
    while let Some(&b) = head.get(i) {
        if !b.is_ascii_digit() {
            break;
        }
        value = value.checked_mul(10)?.checked_add(i64::from(b - b'0'))?;
        i += 1;
    }
    if i == first_digit {
        return None;
    }
    Some(if negative { -value } else { value })
}

/// The character whose log this is, from the file name.
///
/// The name is load-bearing and must be known before the fold starts: the self-`/who` rule and the
/// pet-leader carve-out both decline every line until it is set. The engine derives it rather than
/// being told it, because the log's identity and the character's identity are the same fact, and
/// two ways of stating it is a way for them to disagree.
///
/// Two shapes: the product's own `eqlog_<Name>_<server>.txt`, and the oracle corpus's slice form
/// `eqlog_<Name>_<server>.<slice>.txt`, which [`eqlog::character_of`] already implements. Anything
/// else yields `None`, and a parser with no character is the honest result rather than a guess.
#[must_use]
pub fn character_of(log: &Path) -> Option<String> {
    let name = log.file_name()?.to_string_lossy().into_owned();
    if let Some(character) = eqlog::character_of(&name) {
        return Some(character);
    }
    let stem = name.get(..name.len().checked_sub(4)?)?;
    if !name[stem.len()..].eq_ignore_ascii_case(".txt") {
        return None;
    }
    let head = stem.get(..6)?;
    if !head.eq_ignore_ascii_case("eqlog_") {
        return None;
    }
    let rest = stem.get(6..)?;
    // The last underscore separates the character from the server, which is also how eqlog's regex
    // resolves (`([^_]+?)` cannot hold one) — stated the same way in two places on purpose.
    let split = rest.rfind('_')?;
    let (character, server) = (&rest[..split], &rest[split + 1..]);
    if character.is_empty() || server.is_empty() {
        return None;
    }
    Some(character.to_owned())
}

/// How an ingest ended, when it ended without an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ended {
    /// A newer attach took the world. The loser touched nothing and said nothing.
    Preempted,
}

/// Start one attach's ingest on its own thread.
///
/// A failure to spawn is not a dead engine: the epoch has already been bumped and announced, and
/// all that is left is to say the world holds no fold, which is what `idle` means.
pub fn start(
    world: &World,
    generation: u64,
    log: PathBuf,
    state_dir: Option<PathBuf>,
    sinks: SinkFactory,
) {
    let owner = world.clone();
    let spawned = thread::Builder::new()
        .name("engined-ingest".to_owned())
        .spawn(move || {
            // A panicking fold must not take the process: one bad line costs the fold and nothing
            // else, the same blast-radius rule `World::lock` keeps for a poisoned mutex. The epoch
            // is untouched — a fold that died created no new generation, and the client's state is
            // still the one it was told about.
            let ending = catch_unwind(AssertUnwindSafe(|| {
                run(&owner, generation, &log, state_dir.as_deref(), &sinks)
            }));
            match ending {
                Ok(Ok(Ended::Preempted)) => {}
                Ok(Err(e)) => {
                    eprintln!(
                        "{DIAGNOSTIC_PREFIX} the ingest of {} ended: {e}",
                        log.display()
                    );
                    owner.report_idle(generation);
                }
                Err(_) => {
                    eprintln!(
                        "{DIAGNOSTIC_PREFIX} the ingest of {} PANICKED; the world is idle and the \
                         epoch is untouched",
                        log.display()
                    );
                    owner.report_idle(generation);
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("{DIAGNOSTIC_PREFIX} an ingest thread could not be started: {e}");
        world.report_idle(generation);
    }
}

/// Open the log, fold its history, then follow it. Returns when this turn no longer owns the world.
fn run(
    world: &World,
    generation: u64,
    log: &Path,
    state_dir: Option<&Path>,
    sinks: &SinkFactory,
) -> io::Result<Ended> {
    // Attaching is exactly "opening the file and building what a fold depends on" — the spell DB,
    // the character and the registry. Nothing is folded until all of it exists, and the whole of it
    // happens inside this window.
    if !world.report_status(generation, HealthResultStatus::Attaching) {
        return Ok(Ended::Preempted);
    }

    let character = character_of(log);
    if character.is_none() {
        eprintln!(
            "{DIAGNOSTIC_PREFIX} no character name in {}; the self-referential rules will decline \
             every line",
            log.display()
        );
    }
    // One spell DB per process: it is a pure function of committed data, so `spelldb::shared()` is
    // the process's one copy and the second attach of a session pays ~0 ms. Measured and printed
    // rather than assumed.
    let building = Instant::now();
    let db = spelldb::shared();
    let spell_db_ms = u64::try_from(building.elapsed().as_millis()).unwrap_or(u64::MAX);
    eprintln!("{DIAGNOSTIC_PREFIX} ingest: spell db ready in {spell_db_ms} ms");

    // What this generation has cost, from before the first byte. `Serving` is built here rather
    // than at the fold landing because it is also the answer to `perf.snapshot`, and a door that
    // opens before the scan must have something behind it during the scan — the whole minute a
    // panel most wants to see the engine. Its cadence is not ticked until the tail, so building it
    // early costs a struct.
    let mut serving = Serving::new();
    serving.cost.spell_db_ms = Some(spell_db_ms);
    let parser = Parser::new(
        Clock::new(host_timezone()),
        Some(Arc::clone(&db)),
        character.clone(),
    );

    // The sink is built here, on this thread, and after the catalog exists. It is handed the
    // parser's own clock rather than a second one built from the same zone, so a fold resolving a
    // local-time anchor cannot drift from the timestamps it will compare against. `attached_at_ms`
    // is read once, now, because now is when this world was constructed.
    let mut sink = sinks(&SinkInputs {
        log,
        character: character.as_deref(),
        db: Some(&db),
        clock: parser.clock(),
        attached_at_ms: wall_clock_ms(),
        state_dir,
    });

    // App knowledge, applied before the first byte. A `*.define` pushed before this attach — an
    // ordinary launch, since the app pushes all five on connect and attaches afterwards — is held
    // by the world and applied here, at construction. Alert defs, buff trust, respawn watches,
    // combo corrections and roster edits all change what a fold produces, so taking them after the
    // historical scan would fold the log twice into two different answers. It is the same instant
    // `pipeline.ts` passes them to `createModules`.
    for (family, payload) in world.held_defines() {
        sink.define(&family, &payload);
    }

    let mut file = File::open(log)?;
    let size = file.metadata()?.len();

    if !world.report_status(generation, HealthResultStatus::Folding) {
        return Ok(Ended::Preempted);
    }

    // The snapshot door opens before the first byte is folded, so `module.snapshot` can be asked
    // during the scan and answered with a real prefix state. Installed through a `report_*` method
    // like every other statement an ingest makes, so a turn that has already lost installs nothing.
    let (asks, answers) = channel::<Ask>();
    if !world.serve_asks(generation, asks) {
        return Ok(Ended::Preempted);
    }

    // …and so does the define door, at the same instant: a preference the user changes while a
    // 200 MB log is folding must reach the fold that is folding it, not the next one. A second
    // channel rather than a second arm on the first, because the two carry opposite directions and
    // share nothing but the boundary they are serviced at.
    let (write_to, writes) = channel::<Write>();
    if !world.serve_writes(generation, write_to) {
        return Ok(Ended::Preempted);
    }

    // The scan: the whole file, at full speed. The line splitting is `eqlog::tail::TailCore`'s
    // rather than `scan_bytes`'s, and the two are the same law — a tail's line sequence equals the
    // scan's over any chunking at all. The chunked one buys three things the whole-file one cannot:
    // a 200 MB log is never a 200 MB allocation, the read cursor is a live measurement to report
    // progress from, and every read boundary is a place to ask who owns the world.
    let mut core = TailCore::at(0);
    let mut ev = Ev::new();
    let mut seq: i64 = 0;
    let mut buf = vec![0u8; SCAN_READ_BYTES];
    let mut cadence = Cadence::new();
    let scanning = Instant::now();
    loop {
        let got = file.read(&mut buf)?;
        if got == 0 {
            break;
        }
        core.consume(&buf[..got], |line| {
            if parser.parse_event(line, seq, &mut ev) {
                let (json, payload) = ev.done();
                sink.event(&Event {
                    json,
                    payload,
                    seq,
                    live: false,
                });
                seq += 1;
            }
        });
        // The slice boundary, where every one of this loop's outward-facing acts happens: the
        // generation poll, at most one progress frame per cadence, and whatever was asked for while
        // the last megabyte was folding. The order is deliberate — a turn that has lost answers
        // nobody, including a reader that is waiting.
        if !world.owns(generation) {
            return Ok(Ended::Preempted);
        }
        if cadence.due() && !world.report_progress(generation, mark(&core, size, seq, &*sink)) {
            return Ok(Ended::Preempted);
        }
        answer_asks(&answers, &*sink, &serving);
        // A define mid-scan is taken mid-scan and the fold does not restart for it. That is the
        // honest reading of a full-set replace: it is a fact about the world from here on, and the
        // events already folded were folded under what the user had said at the time.
        answer_writes(&writes, &mut *sink);
    }

    // The final measurement is not optional and does not ask the cadence. It is the one frame that
    // states the whole fold — `pct` at its ceiling and the exact event count — and a client whose
    // loading bar depends on it must never lose it to a fold that finished inside one interval.
    let landed = mark(&core, size, seq, &*sink);
    let landed_at = Instant::now();
    // The scan's own bill, closed at the instant it landed. `read_offset` rather than the file's
    // size at open: the file may have grown under the scan, and this measurement is about the bytes
    // this fold actually read.
    serving.cost.scan_ms = Some(u64::try_from(scanning.elapsed().as_millis()).unwrap_or(u64::MAX));
    serving.cost.scan_bytes = Some(core.read_offset());
    if !world.report_progress(generation, landed) {
        return Ok(Ended::Preempted);
    }

    // The fold lands. The handoff is `ScanResult.endOffset` → `TailStart::At`: the tail picks up at
    // the end of the last complete line the scan folded, so bytes appended during the scan are read
    // rather than skipped and none are read twice. The landing is a reset per open subscription,
    // carrying rows; `landed_at` is the instant the scan finished, so the first frame of a
    // generation reports the honest fold-to-frame cost.
    //
    // One tick before the cadence, ordered BEFORE `report_fold_landed` on purpose. That call
    // publishes `status: "live"`, which is the edge every client waits on, so ticking afterwards
    // would leave a window in which the engine served a world the app had already swept. It is also
    // exactly what `session.ts startHeartbeat` does: one `registry.tick(Date.now())` before the
    // interval is armed and before anything publishes.
    let mut ticking = Ticking::new();
    ticking.beat(&mut *sink);
    if !world.report_fold_landed(
        generation,
        landed,
        &SinkRows(&*sink),
        Some(landed_at),
        &mut serving.meter,
    ) {
        return Ok(Ended::Preempted);
    }
    // Read back through the one door: this diagnostic states the world's copy of the coordinate
    // rather than the ingest's local one, so a mark the world failed to record cannot print as if
    // it had.
    let recorded = world.mark();
    eprintln!(
        "{DIAGNOSTIC_PREFIX} fold landed: {} events, mark {} of {}, now live",
        recorded.events,
        recorded.checkpoint,
        recorded.log.as_deref().unwrap_or(log).display()
    );
    // …and beside it, what serving every open window off that fold cost. Forced rather than left to
    // the meter's cadence: a session quiet enough never to reach the cadence would otherwise never
    // report the one pass it did make.
    serving.say(true);
    let mut tail = FileTail::open(log, TailStart::At(landed.checkpoint));

    // The tail: live, until something newer takes the world. `announced` is what has been
    // announced, not what has been folded — the cadence may defer a frame but must never drop one,
    // because an event whose arrival was announced by nobody is an event the client cannot know
    // about at all.
    let mut announced = seq;
    loop {
        if !world.owns(generation) {
            return Ok(Ended::Preempted);
        }
        let before = seq;
        let polled = tail.poll(|line| {
            if parser.parse_event(line, seq, &mut ev) {
                let (json, payload) = ev.done();
                sink.event(&Event {
                    json,
                    payload,
                    seq,
                    live: LIVE,
                });
                seq += 1;
            }
        });
        // When the fold produced what the next frame will report. Read once, at the end of the
        // drain that produced it — the origin of the fold-to-frame measurement, and the one number
        // that cannot be recovered later. A drain that folded nothing sets nothing, so a frame with
        // no fold behind it is not timed against the age of the session.
        if seq != before {
            serving.folded_at.get_or_insert_with(Instant::now);
        }
        // The heartbeat, after the drain and before anything publishes. Order within one turn of
        // this loop is the only ordering claim available, and the useful one is this: whatever the
        // poll folded is aged by the same beat, and both are visible to this turn's progress frame,
        // snapshot answers and view pass rather than to the next turn's.
        ticking.due(&mut *sink);
        if let Err(e) = polled {
            // A failed poll leaves the tail running — `FileTail` drops its handle and the next
            // cycle opens a fresh one. Ending the ingest here would turn a transient sharing
            // violation into a session that never sees another line.
            eprintln!(
                "{DIAGNOSTIC_PREFIX} a tail poll of {} failed: {e}",
                log.display()
            );
        }
        // A live progress frame is emitted when the fold advanced and the cadence allows, never on
        // an idle poll, which is what keeps an idle session silent. `pct` is the mark over the
        // bytes read, which is 100 exactly when the game is not mid-line.
        if seq != announced && cadence.due() {
            let live_total = tail.read_offset();
            let advanced = FoldMark {
                checkpoint: tail.checkpoint_offset(),
                events: seq,
                pct: pct_of(tail.checkpoint_offset(), live_total),
                // The live denominator is the tail's own read offset: the file has no fixed size
                // once EverQuest is appending to it.
                total: live_total,
                last_ts: sink.report().last_ts,
                // The tail says so, with the same constant it stamps on every event it folds. The
                // frame is otherwise indistinguishable from the last frame of a scan — `pct` at its
                // ceiling, the count moving — so a client cannot tell them apart without it.
                live: LIVE,
            };
            announced = seq;
            if !world.report_progress(generation, advanced) {
                return Ok(Ended::Preempted);
            }
        }
        answer_asks(&answers, &*sink, &serving);
        answer_writes(&writes, &mut *sink);
        // The fires, immediately and not at a cadence. Everything else this loop publishes is
        // state, which coalesces by definition; a fire is not state — two charm breaks are two
        // sounds, and folding them would silence one. Every fire the drain produced goes out now,
        // in fold order.
        for fire in sink.take_fires() {
            if !world.report_fire(generation, &fire) {
                return Ok(Ended::Preempted);
            }
        }
        // The con cards, on the fires' terms and for the fires' reason: a `/con` is a thing that
        // happened rather than state, and coalescing two cards would drop the first.
        for card in sink.take_con_cards() {
            if !world.report_con_card(generation, &card) {
                return Ok(Ended::Preempted);
            }
        }
        // …and the names the fold's probes could not answer, beside the fires and for the same
        // reason. Not generation-gated: a miss describes the process's corpus rather than this
        // generation's world, and the answer that comes back survives an attach exactly as the
        // world's other defines do.
        world.announce_knowledge_misses(&sink.take_knowledge_misses());
        // The views, at their own cadence. Everything the drain above folded collapses into at most
        // one frame per subscription per `views::SERVE_EVERY` — rule 2 of the diff protocol, held
        // as a cadence rather than as a per-event push.
        if !serving.tick(world, generation, &*sink) {
            return Ok(Ended::Preempted);
        }
        nap(
            DEFAULT_POLL_INTERVAL,
            world,
            generation,
            &answers,
            &writes,
            &mut *sink,
            &mut serving,
        );
    }
}

/// The live world's own clock — one cadence and one wall-clock read.
///
/// One per attach, constructed at the landing rather than at the top of the ingest: a heartbeat
/// belongs to a live world, and that is where the value is created rather than a policy in a flag.
///
/// The interval is the app's `setInterval(…, 1000)`; the tail polls every 400 ms, so a beat lands
/// on roughly every third turn of the loop. It is a ceiling and not a promise: a turn that ran late
/// beats once, not twice, because "age the model to now" is idempotent in `now`.
struct Ticking {
    cadence: Cadence,
}

impl Ticking {
    /// Armed from now, not owed: [`Ticking::beat`] is called once at go-live, so the cadence's job
    /// is the interval after that one.
    fn new() -> Self {
        Self {
            cadence: Cadence::from_now(TICK_EVERY),
        }
    }

    /// Beat if the cadence allows.
    fn due(&mut self, sink: &mut dyn EventSink) {
        if self.cadence.due() {
            self.beat(sink);
        }
    }

    /// Beat now, whatever the cadence says — the go-live sweep. Reads the wall clock once and hands
    /// it in; nothing here interprets it, which is the whole of this seam's contract with the fold.
    fn beat(&mut self, sink: &mut dyn EventSink) {
        sink.tick(wall_clock_ms());
    }
}

/// What the live tail owes the view layer: a cadence, the counters, and the fold instant the next
/// frame will be measured against.
///
/// One per attach, like the sink and the parser — a new generation is a new world, and last world's
/// measurements are not this one's.
struct Serving {
    cadence: Cadence,
    meter: Meter,
    /// When the fold produced what the next frame will report, or `None` when it has produced
    /// nothing since the last one. Taken by a frame, never merely read: a second frame with no new
    /// events behind it must not be timed against the first one's fold.
    folded_at: Option<Instant>,
    /// What building this generation cost — filled in as each half of it is measured.
    cost: IngestCost,
    /// The bounded history behind `perf.timeline`, sampled off the serve beat.
    ///
    /// It lives here rather than in the world for the two reasons the meter does: it is a property
    /// of this generation, and it is written on the thread that already owns the counters it reads,
    /// so a history costs no lock on the path every `report_*` contends for. Fixed-capacity by
    /// construction — see `views::TIMELINE_CAPACITY`.
    timeline: views::Timeline,
    /// The module cursor last announced, per module.
    ///
    /// Here and not in the world, for the meter's two reasons. It is a property of this generation
    /// — a new attach builds a new `Serving` and the fresh fold announces every module on its first
    /// beat, which is right, because after an epoch bump a client has dropped everything anyway.
    /// And it is touched only on the ingest thread, so it costs no lock on the `report_*` path.
    ///
    /// It is also what makes the frame coalesced: a busy tail moves a module's seq many times
    /// between two beats, so what goes out is one frame per module per beat carrying the newest
    /// cursor.
    announced_seqs: std::collections::BTreeMap<&'static str, i64>,
}

impl Serving {
    fn new() -> Self {
        Self {
            cadence: Cadence::every(views::SERVE_EVERY),
            meter: Meter::new(),
            folded_at: None,
            cost: IngestCost::default(),
            timeline: views::Timeline::new(),
            announced_seqs: std::collections::BTreeMap::new(),
        }
    }

    /// Which modules have moved since the last beat, and record that they were told about.
    ///
    /// A module absent from `module_seqs` keeps whatever it last announced: a fold that stopped
    /// reporting a cursor has said nothing, which is not the same as saying it went back to zero.
    fn changed_modules(&mut self, sink: &dyn EventSink) -> Vec<(&'static str, i64)> {
        let mut changed = Vec::new();
        for (module, seq) in sink.module_seqs() {
            if self.announced_seqs.get(module) == Some(&seq) {
                continue;
            }
            self.announced_seqs.insert(module, seq);
            changed.push((module, seq));
        }
        changed
    }

    /// This ingest's own answer to `perf.snapshot`. A read: the meter is peeked rather than
    /// drained, so a polling panel cannot zero the counters under the stderr report or make one
    /// poll's numbers depend on the last one (see `views::meter`).
    fn perf(&self) -> EnginePerf {
        EnginePerf {
            ingest: self.cost,
            serve: self.meter.peek(),
            timeline: self.timeline.peek(),
        }
    }

    /// One cadence tick. `false` when this turn no longer owns the world.
    ///
    /// The views first, then the module dirty bits: a client that draws a view and also holds a
    /// module snapshot should see the rows before it is told to refetch, or the other order sends
    /// it to `module.snapshot` for state the very next frame was about to hand it.
    fn tick(&mut self, world: &World, generation: u64, sink: &dyn EventSink) -> bool {
        if !self.cadence.due() {
            return true;
        }
        let served = world.serve_views(
            generation,
            &SinkRows(sink),
            self.folded_at.take(),
            &mut self.meter,
        );
        self.say(false);
        // The ring rides the serve beat and enforces its own cadence, which keeps the horizon a
        // property of `views::Timeline` rather than of this loop. Offered after the serve so a
        // window closes on frames that have actually been counted, and the uptime comes from the
        // world because a performance question is never answered off a wall clock.
        self.timeline.tick(world.uptime_ms(), &mut self.meter);
        if !served {
            return false;
        }
        let changed = self.changed_modules(sink);
        changed.is_empty() || world.report_modules_changed(generation, &changed)
    }

    /// Print whatever the meter owes. `force` ignores its cadence — what a landing fold does.
    fn say(&mut self, force: bool) {
        for line in self.meter.take_report(force) {
            eprintln!("{DIAGNOSTIC_PREFIX} {line}");
        }
    }
}

/// Sleep out one poll interval in short naps, waking early when the world changes hands — and
/// answering asks between them.
///
/// A live engine spends almost all of its time here, so a reader served only at the top of a poll
/// would wait a whole poll interval. Serving inside the nap makes the live latency one
/// [`TAIL_NAP`].
fn nap(
    interval: Duration,
    world: &World,
    generation: u64,
    answers: &Receiver<Ask>,
    writes: &Receiver<Write>,
    sink: &mut dyn EventSink,
    serving: &mut Serving,
) {
    let mut slept = Duration::ZERO;
    while slept < interval && world.owns(generation) {
        thread::sleep(TAIL_NAP);
        slept += TAIL_NAP;
        answer_asks(answers, &*sink, serving);
        // A write arriving while the tail naps is taken in that nap, for the same reason — and a
        // session mark, which the user presses because the log has gone quiet, lands almost always
        // in exactly this nap.
        answer_writes(writes, sink);
        // A subscription opened while the tail is napping is owed a reset, for the same reason:
        // serving here makes the wait for a full window one nap instead of one poll. Nothing is
        // built when nothing owes and nothing moved.
        serving.tick(world, generation, &*sink);
    }
}

/// Answer everything asked of the fold since the last boundary, and block on none of it.
///
/// `try_recv` until empty rather than a blocking read: this is called from the fold's own loop and
/// must never stall it. A send that fails is an asker that gave up and is dropped without comment.
///
/// Every arm is a read of the fold, which is what makes it safe to call at every boundary,
/// including inside the nap — a property of the `Ask` enum rather than of this loop, since an arm
/// that needed `&mut` would not compile here and belongs on the write door.
///
/// With one stated exception: the combat engine ages itself, so `snapshot(now)` is a mutating read
/// once the tail is live. It advances only what time advances, it is idempotent in `now`, and while
/// the scan runs it cannot happen at all — the gate is `hydrating` and the scan never leaves it.
fn answer_asks(answers: &Receiver<Ask>, sink: &dyn EventSink, serving: &Serving) {
    while let Ok(ask) = answers.try_recv() {
        match ask {
            Ask::Module(ask) => {
                let _dropped = ask.answer.send(sink.snapshot(&ask.module));
            }
            Ask::Perf(ask) => {
                let _dropped = ask.answer.send(serving.perf());
            }
            Ask::Combat(ask) => {
                let _dropped = ask.answer.send(sink.combat_snapshot(&ask.opts));
            }
            Ask::Fights(ask) => {
                let _dropped = ask.answer.send(sink.search_fights(&ask.query, ask.limit));
            }
            Ask::Loot(ask) => {
                let _dropped = ask.answer.send(sink.own_loot_drops(&ask.spellings));
            }
            Ask::MobLevels(ask) => {
                let _dropped = ask.answer.send(sink.mob_levels(&ask.names));
            }
        }
    }
}

/// Apply every write pushed since the last boundary, and block on none of them.
///
/// `try_recv` until empty, exactly as [`answer_asks`] is and for the same reason. A send that fails
/// is a pusher whose deadline passed or whose connection closed; the write is still applied,
/// because the fold is the only place it can take effect and a half-applied world would be worse
/// than a lost receipt. A mark and a confirm are stored nowhere by design, so a lost receipt costs
/// the client its answer and nothing else.
fn answer_writes(writes: &Receiver<Write>, sink: &mut dyn EventSink) {
    while let Ok(write) = writes.try_recv() {
        match write {
            Write::Define(ask) => {
                let took = sink.define(&ask.family, &ask.payload);
                let _dropped = ask.answer.send(took);
            }
            // The engine's own gate answers, not this loop's idea of whether the world is live:
            // `CombatEngine::session_mark` refuses while hydrating, which is the same boundary the
            // world's status gate reads and the one that actually owns the model.
            Write::Mark(ask) => {
                let took = sink.session_mark(ask.at);
                let _dropped = ask.answer.send(took);
            }
            // The module's own two refusals answer, and there is no gate above them — see
            // `World::confirm_sighting`. A confirmation is about a row, so "is the world live" is
            // not a question that could bear on it.
            Write::Confirm(ask) => {
                let moved = sink.confirm_sighting(&ask.row_id);
                let _dropped = ask.answer.send(moved);
            }
        }
    }
}

/// The wall clock, in epoch millis — the process's one spelling of `Date.now()`.
///
/// Three readers and all three are live-world readers: [`SinkInputs::attached_at_ms`], read once
/// per attach; [`Ticking`]'s beat, live only; and a combat answer taken while the tail is running.
/// Nothing a historical fold computes can reach any of them — the scan does not construct, does not
/// beat, and answers its combat questions at `fold.last_ts()` instead.
///
/// A clock before the epoch is not a thing this platform produces; `unwrap_or_default` answers 0
/// rather than panicking if one ever were.
#[must_use]
pub fn wall_clock_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

/// Build the measurement one progress frame carries, from the scan's own coordinates.
fn mark(core: &TailCore, size: u64, events: i64, sink: &dyn EventSink) -> FoldMark {
    // The file may have grown under the scan, so the denominator is the larger of what it was and
    // what has actually been read. `pct` then never exceeds 100 and never claims an unseen byte.
    let total = size.max(core.read_offset());
    FoldMark {
        checkpoint: core.checkpoint_offset(),
        events,
        pct: pct_of(core.checkpoint_offset(), total),
        // The denominator rides along: computed here anyway, and it buys the loading bar its human
        // units, which `pct` alone cannot reconstruct.
        total,
        last_ts: sink.report().last_ts,
        // The scan's own stamp. This helper is the scan's and only the scan's — the tail builds its
        // `FoldMark` inline because its denominator is its own read offset — so the constant is
        // honest here rather than a parameter every caller has to be trusted to pass correctly.
        live: false,
    }
}

/// `offset / total * 100`, as a float, clamped to [0, 100] and answering 0 for a log with no bytes
/// in it rather than a NaN.
fn pct_of(offset: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    #[allow(clippy::cast_precision_loss)]
    let pct = (offset as f64) / (total as f64) * 100.0;
    pct.clamp(0.0, 100.0)
}

/// A pacer: it decides how often something is announced, never what is announced, and a skipped
/// tick changes no state — which is why it may read a clock at all.
///
/// Two cadences use it at different rates: progress is ~4/s because a loading bar needs no more,
/// and the view layer is ~10/s, the rate the diff protocol names for a live meter.
struct Cadence {
    last: Instant,
    every: Duration,
}

impl Cadence {
    /// The progress pacer.
    fn new() -> Self {
        Self::every(PROGRESS_EVERY)
    }

    fn every(interval: Duration) -> Self {
        // Set back a full interval so the first boundary of a long fold announces immediately
        // rather than after a quarter second of silence.
        Self {
            last: Instant::now() - interval,
            every: interval,
        }
    }

    /// The same pacer, armed rather than owed: the first `due()` comes one whole interval from now.
    ///
    /// For a caller that has already done the thing once — [`Ticking`], whose go-live beat mirrors
    /// `session.ts`'s single `registry.tick(Date.now())` before its `setInterval` is armed. Built
    /// with `every()` instead, the loop's very next turn would beat again a millisecond later.
    fn from_now(interval: Duration) -> Self {
        Self {
            last: Instant::now(),
            every: interval,
        }
    }

    fn due(&mut self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.last) < self.every {
            return false;
        }
        self.last = now;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{character_of, starter, ts_of, CountingSink, Event, EventSink, SinkReport};
    use crate::world::World;
    use protocol::generated::{EngineMessage, EpochReason, HealthResultStatus};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    #[test]
    fn the_character_comes_off_the_products_own_file_name() {
        assert_eq!(
            character_of(Path::new("C:/EQ/Logs/eqlog_Primitive_freeport.txt")).as_deref(),
            Some("Primitive")
        );
        // The oracle corpus's slice form goes through eqlog's own rule.
        assert_eq!(
            character_of(Path::new("eqlog_Primitive_freeport.patch-week.txt")).as_deref(),
            Some("Primitive")
        );
        // A character name may hold an underscore; the server may not, so the last one splits.
        assert_eq!(
            character_of(Path::new("eqlog_Two_Names_freeport.txt")).as_deref(),
            Some("Two_Names")
        );
    }

    #[test]
    fn a_file_name_that_is_not_a_log_names_nobody() {
        for name in [
            "notalog.txt",
            "eqlog_freeport.txt",
            "eqlog__freeport.txt",
            "eqlog_Primitive_.txt",
            "eqlog_Primitive_freeport.log",
            "eqlog_Primitive_freeport",
            ".txt",
        ] {
            assert!(character_of(Path::new(name)).is_none(), "{name}");
        }
    }

    #[test]
    fn the_timestamp_is_read_back_out_of_the_serialized_event() {
        assert_eq!(
            ts_of(r#"{"kind":"unknown","seq":0,"ts":1787181707000,"raw":"[…]"}"#),
            Some(1_787_181_707_000)
        );
        // `group` is the one kind that writes a field ahead of the envelope.
        assert_eq!(
            ts_of(r#"{"kind":"group","change":"join","name":"Dranix","seq":3,"ts":17,"raw":"x"}"#),
            Some(17)
        );
        // A `raw` line that quotes the key cannot win: the envelope's copy comes first.
        assert_eq!(
            ts_of(r#"{"kind":"unknown","seq":0,"ts":5,"raw":"\"ts\":9999"}"#),
            Some(5)
        );
        assert_eq!(ts_of(r#"{"kind":"unknown"}"#), None);
    }

    #[test]
    fn the_counting_sink_counts_events_and_remembers_the_logs_own_clock() {
        let mut sink = CountingSink::default();
        // The payload is not read here: a counting sink folds nothing and takes its clock off the
        // serialized half (`ts_of`). An empty payload is the honest stand-in.
        let empty = eqlog::event::Payload::default();
        for (seq, ts) in [(0, 100), (1, 200), (2, 300)] {
            sink.event(&Event {
                json: &format!(r#"{{"kind":"unknown","seq":{seq},"ts":{ts},"raw":"x"}}"#),
                payload: &empty,
                seq,
                live: false,
            });
        }
        let report = sink.report();
        assert_eq!(report.events, 3);
        assert_eq!(report.last_ts, Some(300));
    }

    #[test]
    fn an_event_with_an_unreadable_stamp_still_counts() {
        let mut sink = CountingSink::default();
        let empty = eqlog::event::Payload::default();
        sink.event(&Event {
            json: r#"{"kind":"unknown","seq":0,"ts":7,"raw":"x"}"#,
            payload: &empty,
            seq: 0,
            live: false,
        });
        sink.event(&Event {
            json: r#"{"kind":"nonsense"}"#,
            payload: &empty,
            seq: 1,
            live: false,
        });
        assert_eq!(sink.report().events, 2);
        assert_eq!(
            sink.report().last_ts,
            Some(7),
            "the last stamp that could be read stands; a missing one is not a zero"
        );
    }

    // The ingest, over real bytes. The corpus is committed (`tests/fixtures/*.log`, scrubbed), so
    // these run in CI, and every claim about what was folded is settled against
    // `eqlog::scan::scan_bytes` over the same bytes rather than against a number typed here — the
    // only way this suite is still right after a parser change.
    //
    // Nothing here waits for the clock: `settle` waits for a condition, and its deadline is a
    // failure mechanism that turns a deadlock into a red test rather than a run that never returns.

    /// How long any condition in this suite may take before the test is called hung.
    const PATIENCE: Duration = Duration::from_secs(30);

    /// The fixture these tests fold. A loadout-swap window: 459 KB of dense mixed traffic — combat,
    /// casts, `/who`, zoning — which is what makes the event count worth comparing.
    const FIXTURE: &str = "cw2-loadout-swap-aug2.log";

    /// How many times the fixture is concatenated into the scratch log.
    ///
    /// The properties under test only exist across read boundaries — a fold long enough to be
    /// preempted mid-way, more than one progress cadence, a scan spanning several 1 MiB slices — so
    /// the scratch copy is built big enough to have them. Repetition is sound because the parser
    /// holds no state across lines: the oracle folds the same bytes.
    const REPEATS: usize = 6;

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("the crate is three levels below the repo root")
            .to_path_buf()
    }

    /// A scratch directory holding one log named the way the product names one, so the character
    /// comes off the file name exactly as it does in the field.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "engined-ingest-{}-{}-{tag}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).expect("a scratch dir");
            Self(dir)
        }

        fn log(&self) -> PathBuf {
            self.0.join("eqlog_Primitive_freeport.txt")
        }

        /// Write the fixture into the scratch log, `REPEATS` times over.
        fn stage(&self) -> PathBuf {
            let source = repo_root().join("tests").join("fixtures").join(FIXTURE);
            let bytes = std::fs::read(&source)
                .unwrap_or_else(|e| panic!("the fixture at {} is readable: {e}", source.display()));
            let path = self.log();
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

    /// Append one line the way EverQuest appends one: an open, a write, a flush.
    fn append(path: &Path, line: &str) {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("the log takes an append");
        file.write_all(line.as_bytes()).expect("append");
        file.flush().expect("flush");
    }

    /// The oracle: what the proven scan finds in these exact bytes.
    fn scan_oracle(path: &Path) -> i64 {
        let bytes = std::fs::read(path).expect("the log is readable");
        let character = character_of(path).expect("the scratch log names a character");
        let parser = eqlog::parser_for(&character, eqlog::host_timezone());
        i64::try_from(eqlog::scan::scan_bytes(
            &parser,
            &bytes,
            |_line, _payload| {},
        ))
        .expect("a count")
    }

    /// Wait for a condition, failing with `what` if it never holds.
    ///
    /// It sleeps between looks rather than spinning: a spin takes a core away from the fold it is
    /// waiting for, and under this suite's own parallelism that starved the tail thread past a
    /// thirty-second deadline.
    fn settle(what: &str, mut ready: impl FnMut() -> bool) {
        const LOOK_EVERY: Duration = Duration::from_millis(2);
        let deadline = Instant::now() + PATIENCE;
        while !ready() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(LOOK_EVERY);
        }
    }

    /// One event, as a test sink saw it.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Taken {
        sink: usize,
        seq: i64,
        live: bool,
    }

    /// One heartbeat, as a test sink saw it. `events` is how many events that sink had folded when
    /// the beat arrived, which is what makes "the scan never ticks" a checkable claim.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Beat {
        sink: usize,
        events: i64,
        now_ms: i64,
    }

    /// What every sink this factory builds writes into. One shared list, in the order events were
    /// taken, so an interleaving would be visible rather than inferred.
    #[derive(Default)]
    struct Ledger {
        taken: Mutex<Vec<Taken>>,
        beats: Mutex<Vec<Beat>>,
        built: AtomicUsize,
    }

    impl Ledger {
        fn taken(&self) -> Vec<Taken> {
            self.taken
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }

        fn of(&self, sink: usize) -> Vec<Taken> {
            self.taken()
                .into_iter()
                .filter(|t| t.sink == sink)
                .collect()
        }

        fn beats_of(&self, sink: usize) -> Vec<Beat> {
            self.beats
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .copied()
                .filter(|b| b.sink == sink)
                .collect()
        }
    }

    /// A gate a sink stops at until a test opens it — the determinism trick of this suite: a fold
    /// held at its first event is a fold a test can ask questions about without racing it.
    #[derive(Default)]
    struct Gate {
        open: Mutex<bool>,
        changed: Condvar,
    }

    impl Gate {
        fn wait(&self) {
            let mut open = self
                .open
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while !*open {
                open = self
                    .changed
                    .wait(open)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
        }

        fn release(&self) {
            *self
                .open
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
            self.changed.notify_all();
        }
    }

    /// A sink that records what it was handed, and optionally stops at a gate on its first event.
    struct RecordingSink {
        id: usize,
        ledger: Arc<Ledger>,
        gate: Option<Arc<Gate>>,
        report: SinkReport,
    }

    impl EventSink for RecordingSink {
        fn event(&mut self, event: &Event<'_>) {
            self.report.events += 1;
            if event.live {
                self.report.live_events += 1;
            }
            self.report.last_seq = Some(event.seq);
            self.report.last_ts = ts_of(event.json);
            self.ledger
                .taken
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(Taken {
                    sink: self.id,
                    seq: event.seq,
                    live: event.live,
                });
            // The gate is taken after the record, so a test can see that the fold reached its first
            // event and is now standing still.
            if let Some(gate) = self.gate.take() {
                gate.wait();
            }
        }

        /// Every beat, with the fold's own position beside it. Recording `events` is what turns
        /// "the historical scan never ticks" into an assertion: a beat taken mid-scan would carry a
        /// count short of the log's.
        fn tick(&mut self, now_ms: i64) {
            self.ledger
                .beats
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(Beat {
                    sink: self.id,
                    events: self.report.events,
                    now_ms,
                });
        }

        fn report(&self) -> SinkReport {
            self.report
        }
    }

    /// A world whose attaches fold into recording sinks. The gate, when given, is handed to the
    /// first sink only — the one whose fold a preemption test needs to hold still.
    fn recording_world(ledger: &Arc<Ledger>, gate: Option<Arc<Gate>>) -> World {
        let ledger = Arc::clone(ledger);
        World::with_ingest(starter(Arc::new(move |_inputs| {
            let id = ledger.built.fetch_add(1, Ordering::SeqCst);
            Box::new(RecordingSink {
                id,
                ledger: Arc::clone(&ledger),
                gate: if id == 0 { gate.clone() } else { None },
                report: SinkReport::default(),
            })
        })))
    }

    /// Every seq a sink was handed, in order, starting at 0 and skipping nothing.
    fn is_one_unbroken_fold(taken: &[Taken]) -> bool {
        taken
            .iter()
            .enumerate()
            .all(|(i, t)| t.seq == i64::try_from(i).expect("a seq"))
    }

    #[test]
    fn an_attach_folds_the_whole_log_and_the_count_is_the_scans_own() {
        let scratch = Scratch::new("whole");
        let log = scratch.stage();
        let expected = scan_oracle(&log);
        let ledger = Arc::new(Ledger::default());
        let world = recording_world(&ledger, None);

        world.attach(&log.to_string_lossy(), None);
        settle("the fold to land", || {
            matches!(world.health().status, HealthResultStatus::Live)
        });

        let mark = world.mark();
        assert_eq!(
            mark.events, expected,
            "the ingest folds what the scan finds"
        );
        assert_eq!(
            mark.checkpoint,
            std::fs::metadata(&log).expect("the log").len(),
            "the fixture ends on a newline, so THE MARK reaches the last byte"
        );
        assert_eq!(mark.log.as_deref(), Some(log.as_path()));
        assert!(
            mark.last_ts.is_some(),
            "the log's own clock, not the host's"
        );

        let taken = ledger.of(0);
        assert_eq!(i64::try_from(taken.len()).expect("a count"), expected);
        assert!(is_one_unbroken_fold(&taken));
        assert!(
            taken.iter().all(|t| !t.live),
            "everything the scan folds is history"
        );
    }

    #[test]
    fn a_second_attach_preempts_the_first_and_no_events_interleave() {
        let scratch = Scratch::new("preempt");
        let log = scratch.stage();
        let expected = scan_oracle(&log);
        let ledger = Arc::new(Ledger::default());
        let gate = Arc::new(Gate::default());
        let world = recording_world(&ledger, Some(Arc::clone(&gate)));
        let listener = world.join();
        // A real subscription over a registered source. The recording sink folds no modules, so
        // every window it cuts is empty — which is exactly the claim: one reset, naming the
        // generation that landed, whatever is (not) in it.
        world.open_subscription(
            listener.id,
            7,
            crate::views::validate(&protocol::generated::ViewDescriptor {
                source: "loot.ledger".to_owned(),
                filter: None,
                sort: Vec::new(),
                window: None,
            })
            .expect("loot.ledger is registered"),
        );

        // The first fold reaches its first event and stops there, holding the world.
        let first = world.attach(&log.to_string_lossy(), None);
        assert_eq!(*first.epoch, 2);
        settle("the first fold to reach its first event", || {
            !ledger.of(0).is_empty()
        });

        // The preemption. Last pick wins, and the pick that lost is still standing at the gate.
        let second = world.attach(&log.to_string_lossy(), None);
        assert_eq!(*second.epoch, 3, "the generation strictly increases");
        assert!(second.accepted);
        gate.release();

        settle("the winning fold to land", || {
            matches!(world.health().status, HealthResultStatus::Live)
                && world.mark().events == expected
        });

        let loser = ledger.of(0);
        let winner = ledger.of(1);
        assert!(
            !loser.is_empty() && i64::try_from(loser.len()).expect("a count") < expected,
            "the loser abandoned its fold: {} of {expected} events",
            loser.len()
        );
        assert!(
            is_one_unbroken_fold(&loser),
            "the loser's own stream is contiguous — no other fold reached its sink"
        );
        assert!(
            is_one_unbroken_fold(&winner),
            "the winner's own stream is contiguous — the loser's events reached no sink but its own"
        );
        assert_eq!(i64::try_from(winner.len()).expect("a count"), expected);

        // Exactly one fold-lands per winning attach: two bumps were announced, one reset arrived,
        // and it names the generation that landed.
        let mut bumps = Vec::new();
        let mut resets = Vec::new();
        while let Ok(message) = listener.inbox.try_recv() {
            match message {
                EngineMessage::EpochMessage(epoch)
                    if matches!(epoch.reason, EpochReason::Attach) =>
                {
                    bumps.push(*epoch.epoch);
                }
                EngineMessage::ResetMessage(reset) => resets.push((*reset.id, *reset.epoch)),
                _ => {}
            }
        }
        assert_eq!(bumps, vec![2, 3]);
        assert_eq!(resets, vec![(7, 3)], "one reset, naming the winner");
    }

    #[test]
    fn the_health_states_walk_starting_attaching_folding_live() {
        let scratch = Scratch::new("walk");
        let log = scratch.stage();
        let ledger = Arc::new(Ledger::default());
        let gate = Arc::new(Gate::default());

        // The walk's first step is observed from inside the attach, before the ingest thread can
        // possibly have run: the starter is called after the epoch's critical section and before
        // anything else exists.
        let observed_starting = Arc::new(Mutex::new(false));
        let seen = Arc::clone(&observed_starting);
        let held = Arc::clone(&gate);
        let world = World::with_ingest(Arc::new(move |world, generation, path, state_dir| {
            *seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                matches!(world.health().status, HealthResultStatus::Starting);
            let ledger = Arc::clone(&ledger);
            let held = Arc::clone(&held);
            super::start(
                world,
                generation,
                path,
                state_dir,
                Arc::new(move |_inputs| {
                    Box::new(RecordingSink {
                        id: 0,
                        ledger: Arc::clone(&ledger),
                        gate: Some(Arc::clone(&held)),
                        report: SinkReport::default(),
                    })
                }),
            );
        }));

        world.attach(&log.to_string_lossy(), None);
        assert!(
            *observed_starting
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            "an accepted attach is `starting` before its ingest exists"
        );

        // Attaching is the window in which the log is opened and the parse's inputs are built. It
        // is wide — the spell DB is the whole committed corpus and takes seconds to build in a
        // debug build — so a sampler looking every couple of milliseconds cannot miss it.
        settle("the ingest to report `attaching`", || {
            matches!(world.health().status, HealthResultStatus::Attaching)
        });
        // Folding is deterministic: the sink is holding the first event at the gate, so the scan
        // cannot finish until this test lets it.
        settle("the scan to start", || {
            matches!(world.health().status, HealthResultStatus::Folding)
        });
        gate.release();
        settle("the tail to take over", || {
            matches!(world.health().status, HealthResultStatus::Live)
        });
    }

    /// The scan never ticks, held still so the claim is a fact rather than a race.
    ///
    /// The sink stops at the gate on its first event, so the fold is provably mid-scan and standing
    /// there for as long as this test likes. `folding` is asserted first so that "no beats yet"
    /// cannot pass by being taken before the ingest thread ever started.
    #[test]
    fn a_historical_scan_is_never_ticked() {
        let scratch = Scratch::new("noticks");
        let log = scratch.stage();
        let ledger = Arc::new(Ledger::default());
        let gate = Arc::new(Gate::default());
        let world = recording_world(&ledger, Some(Arc::clone(&gate)));

        world.attach(&log.to_string_lossy(), None);
        settle("the scan to reach its first event", || {
            !ledger.of(0).is_empty()
        });
        assert!(matches!(world.health().status, HealthResultStatus::Folding));
        // A whole tick interval and more, spent inside the scan. No cadence would have let a beat
        // through, because the tick loop lives past the tail handoff entirely.
        std::thread::sleep(super::TICK_EVERY + super::TICK_EVERY / 2);
        assert!(
            ledger.beats_of(0).is_empty(),
            "a scan was ticked: {:?}",
            ledger.beats_of(0)
        );
        gate.release();
    }

    /// A live world has already been aged by the time anybody can see it is live.
    ///
    /// The ordering is the point, and it is why the go-live beat is taken before
    /// `report_fold_landed`: `status: "live"` is the edge every client waits on, so a beat taken
    /// after the publish would leave a window in which the engine served an unswept world.
    #[test]
    fn the_world_is_ticked_before_it_is_published_as_live() {
        let scratch = Scratch::new("golive");
        let log = scratch.stage();
        let expected = scan_oracle(&log);
        let ledger = Arc::new(Ledger::default());
        let world = recording_world(&ledger, None);

        world.attach(&log.to_string_lossy(), None);
        settle("the fold to land", || {
            matches!(world.health().status, HealthResultStatus::Live)
        });
        let beats = ledger.beats_of(0);
        assert!(
            !beats.is_empty(),
            "a client that saw `live` would have seen an unswept world"
        );
        // Every beat is past the whole scan — the gated test's claim from the other side: a beat
        // carrying a short count would be a tick inside the historical fold.
        for beat in &beats {
            assert_eq!(
                beat.events, expected,
                "a beat landed mid-scan: {beat:?} of {expected}"
            );
            // …and the number handed in is a wall clock, not a log timestamp: within a minute of
            // this test's own reading of it. Loose enough never to be flaky, tight enough that a
            // log's `ts` could not pass it.
            assert!(
                (beat.now_ms - super::wall_clock_ms()).abs() < 60_000,
                "{beat:?} is not this machine's clock"
            );
        }
    }

    /// …and it keeps beating, at the app's own interval, on a log nobody is writing to.
    ///
    /// The heartbeat exists precisely for the idle log — a buff whose duration ran out while the
    /// player stared at a quiet screen — so "it beats while nothing arrives" is the claim.
    #[test]
    fn a_live_world_keeps_beating_while_the_log_is_idle() {
        let scratch = Scratch::new("beating");
        let log = scratch.stage();
        let ledger = Arc::new(Ledger::default());
        let world = recording_world(&ledger, None);

        world.attach(&log.to_string_lossy(), None);
        settle("the fold to land", || {
            matches!(world.health().status, HealthResultStatus::Live)
        });
        settle("a second beat", || ledger.beats_of(0).len() >= 2);
        let beats = ledger.beats_of(0);
        assert!(
            beats.windows(2).all(|w| w[1].now_ms >= w[0].now_ms),
            "the clock went backwards: {beats:?}"
        );
        // The cadence is a ceiling, so the gap is at least the interval and never twice per turn.
        // Measured against the beats' own numbers rather than the test's wall clock.
        let gap = beats[1].now_ms - beats[0].now_ms;
        let interval = i64::try_from(super::TICK_EVERY.as_millis()).expect("an interval");
        assert!(
            gap >= interval - 50,
            "two beats {gap} ms apart, faster than the {interval} ms cadence"
        );
    }

    #[test]
    fn a_line_appended_after_the_fold_lands_arrives_live_through_the_same_sink() {
        let scratch = Scratch::new("append");
        let log = scratch.stage();
        let scanned = scan_oracle(&log);
        let ledger = Arc::new(Ledger::default());
        let world = recording_world(&ledger, None);

        world.attach(&log.to_string_lossy(), None);
        settle("the fold to land", || {
            matches!(world.health().status, HealthResultStatus::Live)
        });
        let mark_before = world.mark().checkpoint;

        // The game writes a line. Two of them: one the parser types, one it files as `unknown` —
        // both are events, and the tail is a byte-level reader with no opinion about either.
        let appended = "[Wed Aug 19 16:21:54 2026] You gain experience! (3.288%)\n\
                        [Wed Aug 19 16:21:55 2026] You are not currently assigned to an adventure.\n";
        append(&log, appended);

        settle("the appended lines to arrive", || {
            world.mark().events == scanned + 2
        });
        let mark_after = world.mark().checkpoint;
        assert_eq!(
            mark_after - mark_before,
            u64::try_from(appended.len()).expect("a length"),
            "THE MARK advanced by exactly the bytes the game wrote"
        );

        let taken = ledger.of(0);
        assert!(
            is_one_unbroken_fold(&taken),
            "the seq continues across the seam"
        );
        let live: Vec<i64> = taken.iter().filter(|t| t.live).map(|t| t.seq).collect();
        assert_eq!(
            live,
            vec![scanned, scanned + 1],
            "the two live events follow the scan's last seq, through the same sink"
        );
    }

    #[test]
    fn a_half_written_line_is_not_an_event_until_the_game_finishes_it() {
        let scratch = Scratch::new("partial");
        let log = scratch.stage();
        let scanned = scan_oracle(&log);
        let ledger = Arc::new(Ledger::default());
        let world = recording_world(&ledger, None);

        world.attach(&log.to_string_lossy(), None);
        settle("the fold to land", || {
            matches!(world.health().status, HealthResultStatus::Live)
        });
        let mark_before = world.mark().checkpoint;

        append(&log, "[Wed Aug 19 16:21:54 2026] You gain exp");
        // Nothing to settle on — this is an absence. Waiting out poll intervals of the tail is what
        // makes the claim mean something, and it is the one place in this suite that waits on a
        // clock.
        std::thread::sleep(super::DEFAULT_POLL_INTERVAL * 3);
        assert_eq!(world.mark().events, scanned, "half a line is not a line");
        assert_eq!(
            world.mark().checkpoint,
            mark_before,
            "and THE MARK waits with it"
        );

        append(&log, "erience! (3.288%)\n");
        settle("the finished line to arrive", || {
            world.mark().events == scanned + 1
        });
    }

    #[test]
    fn an_attach_the_engine_cannot_open_leaves_the_world_idle_with_its_epoch_intact() {
        let scratch = Scratch::new("missing");
        let missing = scratch.0.join("eqlog_Nobody_freeport.txt");
        let ledger = Arc::new(Ledger::default());
        let world = recording_world(&ledger, None);

        let result = world.attach(&missing.to_string_lossy(), None);
        assert!(
            result.accepted,
            "an attach is accepted at the moment it wins, not when the file proves readable"
        );
        settle("the ingest to give up", || {
            matches!(world.health().status, HealthResultStatus::Idle)
        });
        assert_eq!(
            *world.health().epoch,
            2,
            "a fold that could not start bumps nothing back"
        );
        assert!(ledger.taken().is_empty());
    }
}
