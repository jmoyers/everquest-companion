//! ============================================================================
//! INGEST — WHAT AN ATTACH ACTUALLY DOES (JOS-459 phase 2/3 seam, JOS-474).
//! ============================================================================
//!
//! One thread per attach: open the log, SCAN it at full speed, then TAIL it live, handing every
//! event to one [`EventSink`]. `eqlog` supplies the two halves and the line law between them
//! (JOS-469 proved the scan byte-identical to the TS parser; JOS-472 proved the tail's line
//! sequence equal to the scan's under any chunking at all), so nothing here re-decides what an
//! event is. This module decides only WHO IS FOLDING, WHEN IT STOPS, and WHAT IT SAYS ABOUT ITSELF.
//!
//! ## THE GENERATION LAW (JOS-457, promoted to protocol law by the schema)
//!
//! An attach PREEMPTS any in-flight attach. Last pick wins; intermediate picks are DROPPED, never
//! queued. This is `src/main/switchController.ts`'s `owns()` moved engine-side, and it is a
//! GENERATION rather than a queue or a mutex for the reason that file states at length: a queue
//! turns six impatient clicks into six sequential full folds (the lock-up with better manners), and
//! a counter can only ever say "you are not the current answer any more", which is the one question
//! every statement in a switch needs to ask.
//!
//! The in-flight scan asks it at its SLICE BOUNDARIES — once per read, never per line — and when
//! the answer is no it returns, having touched nothing. Silently: a loser has nothing to report, and
//! a diagnostic per preempted attach would print six lines for a storm of six clicks.
//!
//! **NO EVENT CAN INTERLEAVE, STRUCTURALLY.** Each attach builds its OWN sink and its OWN parser and
//! folds into nothing else; a loser's sink is dropped with its thread. Two folds cannot reach one
//! set of modules because there is only ever one set per attach — which is precisely the class of
//! defect JOS-457 was (character A's history landing in character B's freshly reset modules), made
//! impossible by construction rather than by ordering.
//!
//! ## THE SINK IS THE FOLD SEAM (and since JOS-478 the fold is on the other side of it)
//!
//! Ingest terminates in a trait object. [`CountingSink`] is still the honest floor — events in, a
//! counter out — and `crate::foldsink` is what production hands [`starter`]: the twenty-module
//! registry, folding on this thread and answering [`EventSink::snapshot`] from it.
//!
//! THE FACTORY TAKES THE PARSE'S INPUTS (JOS-478), which is the one thing about this seam that
//! moved. It used to take nothing, and that was the knot the crate README named for the
//! integrator: `fold::ClusterDeps` wants the spell DB's key set and its class index, both built
//! off a database that exists only INSIDE this thread, so a sink factory that could not see it
//! could not build a fold. It sees it now — [`SinkInputs`] — and the sink is built here, on the
//! ingest thread, rather than on the connection thread that asked for the attach. That second half
//! matters as much as the first: building a fold is tens of milliseconds of index projection, and
//! doing it inside `World::attach` would have put it in front of the `accepted` reply.
//!
//! THE EVENT IS ITS SERIALIZED JSON, and that is not laziness: `eqlog::event::Ev` writes an event
//! key by key in the TS's insertion order because the phase-1 bar is byte identity with
//! `JSON.stringify(ev)` (there is no struct-per-kind to hand over — there is a struct per BRANCH,
//! and the ordering claim lives in the branch). A fold that wants fields parses the line it is
//! given, exactly as `session.ts` hands `Tailer`'s line to the parser today.
//!
//! ## WHAT READS A CLOCK, AND WHAT MAY NOT (ruling 18 law 1)
//!
//! Nothing event-derived reads a wall clock. `pct` is bytes over bytes; `events` is a count; the
//! mark is a byte offset; `lastTs` is the LOG's own timestamp. There are exactly two [`Instant`]s
//! here and both are process metadata in the sense `world.rs` means it for `uptimeMs`: one paces
//! the PROGRESS CADENCE — how often a measurement is announced, never what it measures, and a frame
//! that is skipped changes no state at all — and one times the spell-DB build for a stderr
//! diagnostic. Neither can reach a sink.
//!
//! **TWO WALL-CLOCK READS REACH A SINK, AND BOTH ARE NAMED** (JOS-478, JOS-481). [`now_ms`] is read
//! ONCE per attach into [`SinkInputs::attached_at_ms`] — the world's CONSTRUCTION clock, which
//! measures when this world was built and nothing else; over there `WorldOpts.constructionNowMs`
//! defaults to `Date.now()` at construction for the same reason. And once the fold is LIVE it is
//! read again, ~1×/sec, for [`EventSink::tick`] — the heartbeat owner ruling 22 put engine-side.
//!
//! **THE HISTORICAL SCAN NEVER TICKS**, and that is the whole of why the equivalence law is
//! untouched: the tick loop lives below the `TailStart::At` handoff and there is no path to it from
//! the scan. Every time-based rule inside a fold still advances off LOG timestamps while history is
//! being replayed; what a live world gets on top is the same aging the app's own
//! `registry.tick(Date.now())` has done since JOS-149.

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
/// THE SCAN IS DELIBERATELY IMPOLITE — no yield, no throttle, no slice sleep. That is the whole
/// point of the process boundary (docs/plans/data-server.md, "Why"): the fold used to be throttled
/// to 60% of one core because it shared a thread with the UI, and the fix the owner ruled on is a
/// boundary rather than another throttle. The tail keeps `eqlog`'s 256 KiB slicing, because THAT
/// one is about EverQuest's synchronous append and not about this process's manners.
///
/// The size is a buffer, not a promise: `Read::read` may hand back less. It is also the granularity
/// at which the generation is polled and progress may be announced, which is why it is big enough
/// to amortize a read and small enough that a preempted fold abandons within milliseconds.
const SCAN_READ_BYTES: usize = 1 << 20;

/// The floor between two progress announcements — "~4/s max, never per-line".
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
/// Borrowed, never owned: BOTH halves live in the parser's reused buffers and are valid for exactly
/// this call. A sink that needs to keep one copies it — which makes the copy the sink's decision,
/// stated at the place that pays for it.
pub struct Event<'a> {
    /// The event, serialized. Byte-identical to the TS pipeline's `JSON.stringify(ev)` (JOS-469).
    ///
    /// STILL BUILT EAGERLY AFTER JOS-505, and deliberately: it is the parser oracle's byte-identity
    /// artifact and the format every golden is recorded in, and JOS-504 measured its construction
    /// at under half a percent of a fold. The FOLD no longer reads it — that is what `payload` is —
    /// so the only readers left are the ones that genuinely want the text.
    pub json: &'a str,
    /// The same event, TYPED (JOS-505) — what the fold reads. Field order, absent-vs-null and every
    /// value are the writer's own, recorded in the same call that serialized them, so the two
    /// halves cannot disagree about what the parser said.
    pub payload: &'a eqlog::event::Payload,
    /// The event's sequence number. Counts EVENTS, not lines, and starts at 0 for each attach.
    pub seq: i64,
    /// `false` for the historical scan, `true` for the live tail. A property of the SOURCE, not of
    /// the line — `eqlog::tail::LIVE` is the constant this stamps for the tail half.
    pub live: bool,
}

/// WHERE INGEST ENDS. The fold seam: one trait, events in, state out.
///
/// The fold registry implements this (in an `impl` block in THIS crate — the orphan rule requires
/// it: `crate::foldsink`); its factory reaches the world as
/// `World::with_ingest(ingest::starter(<factory>))`.
///
/// **IT IS NO LONGER `Send`, AND THAT IS THE SAME EDIT AS THE FACTORY'S** (JOS-478). A sink used to
/// be built on the connection thread and MOVED into the ingest thread, which is what required the
/// bound. It is built on the ingest thread now and never crosses a thread boundary at all, so the
/// bound is not merely unnecessary — keeping it would forbid the fold: `fold::Fold` holds the
/// buffs/buffTimers shared core in an `Rc<RefCell<…>>`, which is exactly the right choice for state
/// that provably lives on one thread and exactly what `Send` refuses. The single-threadedness is
/// now stated by the type rather than promised by a comment.
pub trait EventSink {
    /// One event, in emission order. Called once per event, on the ingest thread, and on no other.
    fn event(&mut self, event: &Event<'_>);

    /// THE LIVE HEARTBEAT (owner ruling 22, JOS-481): the wall clock, in epoch millis, handed to
    /// the fold ~1×/sec — `session.ts startHeartbeat`'s `registry.tick(Date.now())`, moved into the
    /// process that owns the fold.
    ///
    /// **CALLED ONLY WHILE THE STATUS IS `live`.** The historical scan does not call it, cannot
    /// reach it, and must not: a replay whose output depended on when it was run would break the
    /// equivalence oracle and, with it, ruling 18's determinism-is-cacheability law. The one place
    /// it is driven from is the tail loop, past the `TailStart::At` handoff — see [`Ticking`].
    ///
    /// Defaulted to nothing, because a sink that folds no modules ([`CountingSink`]) has no model to
    /// age and a heartbeat over it would be a clock read paid for nobody.
    fn tick(&mut self, _now_ms: i64) {}

    /// What this sink can say about itself.
    ///
    /// Defaulted because a fold registry's answer is its own state and it may have nothing to add:
    /// the ingest counts events itself (an engine-measured fact about the FOLD, not about the sink)
    /// and only merges what a sink volunteers.
    fn report(&self) -> SinkReport {
        SinkReport::default()
    }

    /// One module's published state, or `None` when this sink folds no module by that name.
    ///
    /// `&self` AND NOT `&mut self`, DELIBERATELY: reading a module's state is a read, and a
    /// snapshot that could advance the fold would make the answer depend on who asked. Defaulted to
    /// `None` because a sink that folds nothing — [`CountingSink`] — honestly has no module, and
    /// `None` becomes the protocol's `notFound`: the registry is the authority, and an empty state
    /// would be a lie about a module that does not exist.
    ///
    /// CALLED ON THE INGEST THREAD, between events, and on no other — see [`SnapshotAsk`].
    fn snapshot(&self, _module: &str) -> Option<ModuleSnapshot> {
        None
    }

    /// EVERY ROW OF ONE VIEW SOURCE, in its natural order — the view layer's door onto this fold
    /// (JOS-480). `None` for a source this sink does not carry, which is not an error: a counting
    /// sink folds no modules at all and a subscription over it gets an honest empty window.
    ///
    /// `&self` FOR THE SAME REASON `snapshot` TAKES IT, and called at the same boundaries: on the
    /// ingest thread, between events, never inside one — so the rows a window is cut from are a
    /// real prefix state rather than a torn one.
    fn source_rows(&self, _source: &'static views::SourceDef) -> Option<Vec<views::SourceRow>> {
        None
    }

    /// TAKE ONE FAMILY OF APP KNOWLEDGE — the `*.define` commands (JOS-482, boundary verdict 3).
    ///
    /// `true` when a module took it, `false` when this sink folds nothing that answers to that
    /// family. Defaulted to `false` because a counting sink folds no modules at all, and a define
    /// it cannot apply is not an error: the world still HOLDS the push, and the next attach that
    /// builds a real fold applies it at construction.
    ///
    /// `&mut self` AND CALLED ON THE INGEST THREAD, at the same boundaries [`EventSink::snapshot`]
    /// is answered at — between two reads of the scan, or between two naps of the tail. That is
    /// what makes a define a point on the event stream rather than a race with one: every event
    /// before it folded without it and every event after it folded with it, and no event folded
    /// half-way.
    fn define(&mut self, _family: &str, _payload: &serde_json::Value) -> bool {
        false
    }

    /// TAKE A SESSION MARK (JOS-322, wired by JOS-492) — `sessionMarks.add`'s effect on the meter.
    ///
    /// `true` when the COMBAT ENGINE took it. Defaulted to `false` because a sink with no engine
    /// has no fight to close and no stay to freeze — and that is the same honest `false` a
    /// hydrating engine answers, for the same reason: nothing was split.
    ///
    /// `&mut self` AND THE SAME BOUNDARIES `define` IS APPLIED AT. A mark is a POINT ON THE EVENT
    /// STREAM, which is the whole of what a split means: every event before it belongs to the
    /// record it closed and every event after it to the record it opened, and no event lands
    /// half-way. Answering it under a lock, or on the connection thread, would put the boundary
    /// somewhere the fold was not standing.
    fn session_mark(&mut self, _at: i64) -> bool {
        false
    }

    /// CONFIRM A SIGHTING (JOS-494) — `respawn.confirmSighting`'s effect on the respawn clocks.
    ///
    /// `true` when the fold RE-BASED that row's clock onto the sighting the log last made. `false`
    /// when there was nothing to re-base, which covers a sink with no respawn module and a row the
    /// module refuses (unknown id, or not currently seen) with one answer — and one answer is
    /// right, because that is the single boolean the app's own seam returns for the same three
    /// cases (`src/main/modules/respawn.ts confirmSighting`).
    ///
    /// `&mut self` AND THE SAME BOUNDARIES `define` AND `session_mark` ARE APPLIED AT, for the
    /// third time and the same reason: a confirmation is a POINT ON THE EVENT STREAM. Every event
    /// before it folded against the death's clock and every event after it against the sighting's,
    /// and no event folded half-way — which matters here rather than being ceremony, because the
    /// very next death line re-bases the row back and a confirm applied inside one would be a
    /// clock whose base depended on where in a line it landed.
    fn confirm_sighting(&mut self, _row_id: &str) -> bool {
        false
    }

    /// THE ALERT FIRES THIS SINK PRODUCED SINCE THE LAST DRAIN (JOS-482, owner ruling 22).
    ///
    /// Structurally empty for a historical scan: firing is live-only by the boundary law, which the
    /// fold enforces where the TypeScript enforces it — one gate above the matcher loop.
    fn take_fires(&mut self) -> Vec<Fire> {
        Vec::new()
    }

    /// THE CON CARDS THIS SINK RESOLVED SINCE THE LAST DRAIN (JOS-487, boundary verdict 2).
    ///
    /// Structurally empty for a historical scan, exactly as [`EventSink::take_fires`] is and by the
    /// same boundary law: a card is a thing that HAPPENS, and a startup replay of a month of logs
    /// must draw none.
    ///
    /// IT HANDS BACK THE PROTOCOL'S OWN SHAPE, which is the one place this crate's vocabulary rule
    /// bends and it bends because there is nothing to translate. A `Fire` exists as an ingest type
    /// because the FOLD's alert shape is not the wire's and neither this module nor `world.rs` may
    /// learn what an alert is; a con card is RESOLVED by this crate (`crate::concard`), so a third
    /// struct in between would be a copy of the wire shape with a different spelling.
    fn take_con_cards(&mut self) -> Vec<protocol::generated::ConCardMessage> {
        Vec::new()
    }

    /// EVERY MODULE'S PUBLISHED CURSOR — the module dirty bit's whole read (JOS-487).
    ///
    /// CHEAP BY CONTRACT: a counter per module, never a serialization. The serve loop asks this once
    /// per beat and announces the ones that moved, so the cost of the whole feature on an idle
    /// session is twenty integer comparisons ten times a second.
    ///
    /// `&self` for [`EventSink::snapshot`]'s reason, and called at the same boundaries.
    fn module_seqs(&self) -> Vec<(&'static str, i64)> {
        Vec::new()
    }

    /// THE COMBAT ENGINE'S WHOLE SNAPSHOT, and the instant it was taken at (JOS-485).
    ///
    /// `None` when this sink folds no combat engine at all — a counting sink, or a fold built
    /// without `Fold::with_combat` — which the world turns into `unavailable`, on the same terms
    /// `module.snapshot` uses for a world with no fold: the request was fine, there is simply
    /// nothing behind it.
    ///
    /// `&self`, AND THE INSTANT IS THE SINK'S TO CHOOSE. Both halves matter. It is answered at the
    /// same boundaries [`EventSink::snapshot`] is answered at — on the ingest thread, between events,
    /// never inside one — so a mid-scan answer is a real prefix state. And the instant is not a
    /// parameter because the caller — a connection thread — is the one party that cannot know it:
    /// whether this fold has reached its tail decides whether `now` is a wall clock or the log's own
    /// last stamp, and only the thread holding the fold knows which.
    ///
    /// **`&self` IS NOT `NOTHING MOVED`, ONCE THE TAIL IS LIVE** (JOS-488). The combat engine's own
    /// snapshot AGES ITS MODEL at the instant it is taken — the charm sweep, the ally-bind expiry,
    /// the pet nudge and deferred encounter closure — exactly as `engine.ts` does, so a live answer
    /// can close a fight that ended while the log was quiet. The engine owns that mutation behind a
    /// cell of its own rather than pushing `&mut` up through the view layer's `Rows` seam; see
    /// `fold::combat::CombatEngine`'s `st` field for the argument, and [`answer_asks`] for what it
    /// means at this door. While the scan is running the sweeps are unreachable, which is what leaves
    /// the historical path a pure function of its bytes.
    fn combat_snapshot(&self, _opts: &CombatOpts) -> Option<CombatSnapshot> {
        None
    }

    /// THE FIGHT-HISTORY SEARCH (JOS-485). `None` on the same terms as [`EventSink::combat_snapshot`].
    ///
    /// The corpus is the fold's uncapped encounter history plus the open fight; the ranking is
    /// `crate::search`. It is a READ that allocates the corpus it ranks, so it is answered at the
    /// same boundaries and is deliberately not on any cadence — a person typed into a box.
    fn search_fights(&self, _query: &str, _limit: usize) -> Option<FightSearch> {
        None
    }

    /// THE NAMES THE FOLD'S OWN KNOWLEDGE PROBES COULD NOT ANSWER (JOS-486), drained here and
    /// announced connection-wide as `knowledgeMiss` frames.
    ///
    /// THE SAME SHAPE AS `take_fires` AND FOR THE SAME REASON: a lookup called from inside a fold
    /// cannot reach the world, so it buffers and this thread drains at a boundary it already reaches.
    /// Unlike a fire, a miss is not a thing that HAPPENED in the log — it is a fact about the
    /// process's corpus, which is why the frame carries no epoch and why the drain is not
    /// generation-gated on the way out (see `World::announce_knowledge_misses`).
    fn take_knowledge_misses(&mut self) -> Vec<fold::knowledge::Miss> {
        Vec::new()
    }

    /// WHAT YOU HAVE LOOTED OFF ONE CREATURE, for a `knowledge.mob` answer — the fold's half of a
    /// join whose other half is committed data. A sink with no such index answers with no rows.
    fn own_loot_drops(&self, _spellings: &[String]) -> Vec<fold::knowledge::SeenDrop> {
        Vec::new()
    }

    /// HOW OLD THESE CREATURES ARE, as the resist fold knows it (JOS-497 item 1) — the last fact
    /// `src/main/ipc/resist.ts` was still reading out of the app's own fold synchronously.
    ///
    /// `&self` and therefore safe on this door: [`fold::modules::resist::ResistModule::level_of`]
    /// is the non-memoising read, which is the whole reason that form exists.
    ///
    /// A SINK WITH NO RESIST MODULE ANSWERS WITH NO ROWS, which is not a special case: it is the
    /// same value a creature nobody has conned and the catalog has never heard of answers with, and
    /// the app reads both as the `null` its profile builder has always handled. `own_loot_drops`
    /// makes the same choice for the same reason.
    fn mob_levels(
        &self,
        _names: &[String],
    ) -> Vec<(String, fold::modules::resist::world::MobLevelFact)> {
        Vec::new()
    }

    /// A monotonic signal that moves whenever `source` could have changed.
    ///
    /// THE WHOLE COST MODEL OF THE VIEW LAYER RESTS ON THIS. A subscription is re-cut only when its
    /// source's revision has moved since the window it holds was built, so an idle session — which
    /// is most of a session — pays a comparison per cadence tick and nothing else. It must be
    /// CHEAP (a counter read, never a serialization) and it must be honest: a signal that could
    /// repeat across a change would let a stale window stand.
    fn source_revision(&self, _source: &'static views::SourceDef) -> Option<u64> {
        None
    }
}

/// The view layer's [`views::Rows`], over whatever sink this attach is folding into.
///
/// A BORROW, built per pass and dropped with it: the sink lives on the ingest thread and this is
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
    /// The module's OWN seq — for most modules the seq of the last event it folded, and for the
    /// four that publish a private revision counter (JOS-87) that counter. A hydration cursor,
    /// never the fold's event count.
    pub seq: i64,
    /// The module's state. THE SHAPE IS THE MODULE'S, not this crate's and not the protocol's:
    /// `kills` publishes an object, `loot` publishes an array, and nothing between the module and
    /// the wire is allowed an opinion about which.
    pub state: serde_json::Value,
}

/// WHAT A COMBAT SNAPSHOT WAS ASKED FOR — `src/shared/combat.ts SnapshotOpts`, in the INGEST's own
/// vocabulary.
///
/// A third spelling of one idea (the protocol's `CombatSnapshotOpts`, this, and
/// `fold::combat::SnapshotOpts`), and it is the same three-layer shape [`Fire`] has for the same
/// reason: this module must not learn what a fold is, and `ops.rs` must not learn what the fold's
/// types are called. The op table validates and clamps; this carries; `crate::foldsink` converts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CombatOpts {
    /// Which fight or zone session to resolve the selection against, or `None` for the default.
    pub selected_id: Option<String>,
    /// Include lines the engine could not classify.
    pub show_unparsed: bool,
    /// Cap on finalized-fight summaries. A PAYLOAD bound, never a retention one.
    pub max_segments: usize,
    /// Include the selected encounter's event timeline.
    pub timeline: bool,
}

/// THE COMBAT ENGINE'S SNAPSHOT, and the instant it describes.
///
/// The pair rather than the state alone, because `now` is not recoverable from the payload and the
/// whole answer is a function of it — see the protocol's `CombatSnapshotResult.now`.
#[derive(Debug, Clone, PartialEq)]
pub struct CombatSnapshot {
    /// The instant the snapshot was taken at, in epoch millis.
    pub now: i64,
    /// The snapshot. THE SHAPE IS THE ENGINE'S, exactly as [`ModuleSnapshot::state`]'s is a
    /// module's — nothing between the fold and the wire is allowed an opinion about it.
    pub state: serde_json::Value,
}

/// ONE RANKED FIGHT.
#[derive(Debug, Clone, PartialEq)]
pub struct FightHit {
    /// The `SegmentSummary`, exactly as the fold published it.
    pub summary: serde_json::Value,
    /// 0..1 relevance.
    pub score: f64,
}

/// WHAT A FIGHT SEARCH FOUND, and how much it looked through.
#[derive(Debug, Clone, PartialEq)]
pub struct FightSearch {
    /// The ranked hits, already capped by the caller's limit.
    pub hits: Vec<FightHit>,
    /// How many fights were SEARCHED — present even when nothing matched, because "no matches in
    /// 1,428" and "nothing to search" are different sentences.
    pub corpus: i64,
}

/// ONE ALERT FIRE, as the ingest hands it to the world.
///
/// The ingest's OWN vocabulary, exactly as [`ModuleSnapshot`] is: `crate::foldsink` converts the
/// fold's shape into it at the seam, so neither this module nor `world.rs` learns what an alert is.
/// The world turns it into the protocol's `FireMessage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fire {
    /// The `ts` of the event that matched — the LOG's own clock.
    pub at: i64,
    /// The alert's label.
    pub rule: String,
    /// `<packId>/<soundId>` — the key the app plays. Resolved by the fold, never a reference.
    pub sound: String,
    /// The text that matched.
    pub message: String,
    /// WHAT THIS FIRING MAY SAY (JOS-500) — the rule's own named captures plus the `{target}` auto
    /// token, already sanitized and capped by the fold. Absent for nearly every alert.
    pub captures: Option<std::collections::BTreeMap<String, String>>,
    /// The spell this firing is about, rank suffix intact. Absent when the family names none.
    pub spell: Option<String>,
    /// The deadline an early warning was early for. Absent on every ordinary fire.
    pub due_at: Option<i64>,
}

/// ONE PUSH OF APP KNOWLEDGE, and the way back.
///
/// THE SAME SHAPE AS [`SnapshotAsk`] AND FOR THE SAME REASON, one direction reversed: the fold
/// lives on the ingest thread and a `*.define` arrives on a connection thread. A `Mutex<Fold>`
/// would put a second owner on state whose whole design is one door; a copy applied later would
/// make the moment a define takes effect unknowable. So the writer posts and waits, and the ingest
/// applies it at a boundary it already reaches.
///
/// THE WAIT IS WHAT MAKES THE ACK MEAN SOMETHING. `applied: true` is a statement that the LIVE fold
/// has this set, not that a queue accepted it — which is the difference between a client that can
/// push a rule and immediately reason about it and one that has to poll.
pub struct DefineAsk {
    /// The family: `alerts`, `buffTrust`, `respawn`, `combo`, `roster`.
    pub family: String,
    /// The whole set, as the app pushed it.
    pub payload: serde_json::Value,
    /// Where the answer goes: `true` when a module took it.
    pub answer: std::sync::mpsc::Sender<bool>,
}

/// ONE SESSION MARK, and the way back (JOS-492) — `sessionMarks.add`'s effect on the meter.
///
/// THE SECOND WRITE THIS DOOR CARRIES, and it is here rather than on [`Ask`] because of what it
/// does: a mark closes the open fight and freezes the running stay. `answer_asks` takes the sink by
/// `&dyn` precisely so that every arm on it is provably a READ; a mark cannot be one, so it belongs
/// with the defines — which is the placement that door's own header already predicted.
pub struct MarkAsk {
    /// The instant MAIN stamped for the whole click, so the loot split and this split share one
    /// boundary. NEVER re-derived here from a host clock.
    pub at: i64,
    /// Where the answer goes: whether the ENGINE took it (false while it is still hydrating).
    pub answer: std::sync::mpsc::Sender<bool>,
}

/// ONE CONFIRMED SIGHTING, and the way back (JOS-494) — `respawn.confirmSighting`'s effect on the
/// respawn clocks.
///
/// THE THIRD WRITE, AND THE DOOR CHOSE ITSELF AGAIN. `answer_asks` takes the sink by `&dyn`, so a
/// read arm cannot mutate; confirming re-bases a clock and bumps a module's revision, so it will
/// not compile over there — exactly the structural placement [`Write`]'s own header promises, now
/// demonstrated three times.
///
/// IT CARRIES NO INSTANT, which is the one place it differs from [`MarkAsk`] and is the whole of
/// why it needed no clock ruling. A mark's subject IS an instant, stamped app-side so the loot
/// split and the meter split share one boundary. A confirmation's subject is a ROW: the instant it
/// re-bases onto is that row's own `seenTs`, a LOG timestamp this fold already holds, so there is
/// nothing for a caller's clock to say and nothing for this struct to carry.
pub struct ConfirmAsk {
    /// The row the person pressed — `<zone key>::<mob key>`, the id the fold keys its history by.
    pub row_id: String,
    /// Where the answer goes: whether a clock actually moved.
    pub answer: std::sync::mpsc::Sender<bool>,
}

/// EVERY STATEMENT MADE *TO* THE FOLD — the write door, the mirror image of [`Ask`].
///
/// THREE ARMS AND ONE RULE: an arm here is handed the sink by `&mut`, so it may fold, define, or
/// otherwise MOVE the world; an arm on [`Ask`] is handed it by `&`, so it may only read. Which door
/// a new request belongs on is therefore decided by the compiler rather than by a convention, and a
/// read that quietly grew a mutation would not compile where it lives.
///
/// ONE CHANNEL FOR EVERY WRITE, for exactly the reason `Ask` is one channel for every read: the
/// door's property is that the fold is reached at a boundary it already services, and a second
/// channel would be a second thing this loop has to remember to drain in all four places
/// (mid-scan, the live poll, the nap, and the landing).
pub enum Write {
    /// One family of app knowledge — see [`DefineAsk`].
    Define(DefineAsk),
    /// One session mark — see [`MarkAsk`].
    Mark(MarkAsk),
    /// One confirmed sighting — see [`ConfirmAsk`].
    Confirm(ConfirmAsk),
}

/// ONE REQUEST FOR ONE MODULE'S STATE, and the way back.
///
/// WHY A CHANNEL AND NOT A LOCK — the load-bearing paragraph of this seam. The fold lives on the
/// ingest thread; a `module.snapshot` request arrives on a connection thread. Three shapes were
/// available and two of them are wrong here:
///
///   * A `Mutex<Fold>` shared between the threads. It would make the fold's own hot loop take a
///     lock per event, for the benefit of a reader that asks a few times a minute — and it would
///     put a second owner on state whose whole design (`world.rs`'s header, ruling 18 law 2) is
///     that reads go through ONE DOOR. A fold behind a mutex is a fold two things can hold.
///   * A snapshot COPY the ingest publishes into the world after every event. That is a cache, and
///     ruling 5 says build none — and it would pay for twenty modules' serialization on every line
///     to answer a question nobody asked.
///   * This: the reader posts an ask and waits; the ingest answers it at a boundary it already
///     reaches — between two reads of the scan, or between two polls of the tail. The fold is
///     never shared, never locked, and never interrupted mid-event, so the answer is a REAL PREFIX
///     STATE: every event up to `seq` and no part of another. Mid-scan that is the whole claim.
///
/// The cost is a bounded wait on the asking thread — one 1 MiB read during a scan, one tail nap
/// while live — and `World::module_snapshot` owns the deadline that turns a wedged ingest into an
/// `unavailable` reply rather than a connection that never answers.
pub struct SnapshotAsk {
    /// The module id the client named.
    pub module: String,
    /// Where the answer goes. `None` means the sink folds no such module.
    pub answer: std::sync::mpsc::Sender<Option<ModuleSnapshot>>,
}

/// EVERY QUESTION THE ONE DOOR CARRIES. Adding a reader means adding an arm here and nowhere else.
///
/// It is one channel rather than one per question deliberately: the door's whole property is that
/// the fold is asked at a boundary it already reaches, and a second channel would be a second place
/// the ingest loop has to remember to drain — which is how one of them ends up drained only during
/// the tail, and a request answered in 25 ms while live hangs for a whole megabyte mid-scan.
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

/// ONE `resist.levels` QUESTION (JOS-497 item 1).
///
/// SAME DOOR, SAME REASON as every arm above, and the reason is sharper here than usual: the answer
/// is SESSION STATE. A `/con` the player typed thirty seconds ago beats the committed catalog, and
/// that statement lives inside the resist fold on the ingest thread — there is nowhere else to read
/// it from. Publishing it into the world after every con line would be a cache (ruling 5), and
/// sharing the fold behind a lock would put the reader in contention with the fold's hot loop.
///
/// PLURAL BECAUSE THE OP IS. The caller sends the names as the log spells them, already bounded by
/// the op table; this thread folds each key and answers what it can state.
pub struct MobLevelAsk {
    /// The creature names to answer for, as the asker spelled them.
    pub names: Vec<String>,
    /// Where the answer goes: the echoed name beside the fact, and NO ENTRY for a creature the fold
    /// can state nothing about. A short list is the honest answer rather than a padded one — see
    /// the schema's `ResistLevelsResult`.
    pub answer: std::sync::mpsc::Sender<Vec<(String, fold::modules::resist::world::MobLevelFact)>>,
}

/// ONE REQUEST FOR THE COMBAT ENGINE'S SNAPSHOT (JOS-485).
///
/// SAME DOOR, SAME REASON as [`SnapshotAsk`], and the argument does not weaken with size: the
/// combat engine's state is the largest thing this fold holds, which makes a `Mutex` around it the
/// worst of the three shapes rather than the most tempting — the fold's hot loop would take that
/// lock on every damage line to serve a reader that asks once a second.
pub struct CombatAsk {
    /// What the caller asked for, already validated and clamped by the op table.
    pub opts: CombatOpts,
    /// Where the answer goes. `None` means this fold carries no combat engine.
    pub answer: std::sync::mpsc::Sender<Option<CombatSnapshot>>,
}

/// ONE FIGHT-HISTORY SEARCH (JOS-485).
///
/// The one ask on this door that is USER-INITIATED, and it is the reason the door's boundary rule
/// is stated as a ceiling rather than a budget: a person typing into a search box is not the
/// "the app froze on its own" case, and `src/main/ipc/world.ts` makes the same distinction by
/// leaving its own search handler out of the timed seams.
pub struct FightSearchAsk {
    /// What the user typed.
    pub query: String,
    /// How many ranked hits to return, already clamped by the op table.
    pub limit: usize,
    /// Where the answer goes. `None` means this fold carries no combat engine.
    pub answer: std::sync::mpsc::Sender<Option<FightSearch>>,
}

/// ONE REQUEST FOR THE OWN-LOOT HALF OF A MOB ANSWER (JOS-486).
///
/// SAME DOOR, SAME REASON, AND A THIRD ARM RATHER THAN A SHORTCUT. The `knowledge.mob` op joins two
/// things: the committed catalog, which the world can read for itself because it is process-wide
/// committed data, and YOUR LOOT HISTORY, which lives inside the `consider` module on the ingest
/// thread and is character-scoped and epoch-scoped. Reading the second one any other way would mean
/// either sharing the fold (a second owner of state whose whole design is one door) or publishing a
/// copy of it into the world after every loot line (a cache, which ruling 5 forbids). So the world
/// posts an ask and the fold answers at a boundary it already reaches.
///
/// THE ANSWER IS NEVER `None`: a fold with no such index, and a creature nothing has been looted
/// from, both answer with no rows — which is the same sentence and deserves the same value.
pub struct LootAsk {
    /// Every `mobKey` the creature answers to, canonical first — the corpus resolved them.
    pub spellings: Vec<String>,
    /// Where the answer goes.
    pub answer: std::sync::mpsc::Sender<Vec<fold::knowledge::SeenDrop>>,
}

/// ONE REQUEST FOR THE INGEST'S OWN COST (owner ruling 19 surface, JOS-483).
///
/// SAME DOOR, SAME REASON, and it is worth saying why the meter is not simply shared instead. The
/// meter is `&mut` on the ingest thread by construction — it is written on the serve path, which is
/// the hottest thing this thread does after the parse — and putting it behind a lock would make
/// every frame pay for a reader that asks twice a second while a panel happens to be open. Posting
/// an ask costs the fold one `try_recv` at a boundary it was reaching anyway.
///
/// The answer is never `None`: an ingest that has served nothing still has an honest answer (no
/// rows, and whatever of the scan has been measured so far), which is a different sentence from the
/// `unavailable` a world with no fold at all gives.
pub struct PerfAsk {
    /// Where the answer goes.
    pub answer: std::sync::mpsc::Sender<EnginePerf>,
}

/// WHAT THE INGEST THREAD SAYS ABOUT ITSELF: what starting this generation cost, and what serving
/// it has cost since.
///
/// NOT THE GENERATED TYPE. The mapping onto `PerfSnapshotResult` happens in `world.rs`, where the
/// world's own half of the answer (status, epoch, mark, subscriber counts) is merged in — this
/// thread knows nothing about either.
#[derive(Debug, Clone, Default)]
pub struct EnginePerf {
    /// What building this generation cost.
    pub ingest: IngestCost,
    /// One row per source that has served a frame, ordered by name.
    pub serve: Vec<views::SourceMeter>,
    /// THE BOUNDED RECENT HISTORY, oldest first (JOS-502) — what `perf.timeline` serves.
    ///
    /// IT RIDES THE ANSWER `perf.snapshot` ALREADY ASKED FOR, rather than earning a second `Ask`
    /// arm. Three ops now read one door: the meter is `&mut` on this thread by construction and
    /// each new door would be another `try_recv` on the hot boundary, while the whole cost of
    /// carrying the ring along is copying at most `views::TIMELINE_CAPACITY` five-integer structs.
    /// One ask, one answer, three views of it.
    pub timeline: Vec<views::Moment>,
}

/// WHAT STARTING ONE GENERATION COST, measured rather than modelled.
///
/// EVERY FIELD IS AN OPTION AND ABSENT MEANS NOT YET MEASURED. A `scan_ms` of zero would say a
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
    /// How many of them arrived LIVE. The split between "this came out of history" and "this is
    /// happening now" is the one a loading UI and a bug report both want, and it is free here.
    pub live_events: i64,
    /// The `seq` of the last event taken. Reported rather than derived from `events`: they are the
    /// same number only for a sink that keeps everything, and a fold that declines an event is
    /// exactly the case where the difference matters.
    pub last_seq: Option<i64>,
    /// The `ts` of the last event taken — THE LOG'S OWN CLOCK, never the host's.
    pub last_ts: Option<i64>,
}

/// The phase-now sink: a counter, and nothing else.
///
/// It is not a placeholder for a fold so much as the honest floor under one — `session.health` can
/// say how much has been folded and how far into the log's own time it reached without any module
/// existing yet.
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
        // A STAMP THAT CANNOT BE READ IS NOT A ZERO. The last one that could be read stands, which
        // keeps `lastTs` monotonic over a log that holds a line the timestamp pattern declines.
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

/// EVERYTHING AN ATTACH KNOWS BY THE TIME IT COULD BUILD A FOLD, handed to the sink factory.
///
/// It is exactly the set the parse is a pure function of, plus the one wall-clock instant a world
/// is constructed at. Nothing here is discovered by the engine: the log path came from the app, the
/// character comes off that path's file name, and the catalog is committed data.
pub struct SinkInputs<'a> {
    /// The log this attach opened.
    pub log: &'a Path,
    /// The character whose log it is, off the FILE NAME. `None` when the name is not a log's.
    pub character: Option<&'a str>,
    /// The parser's effective spell catalog — the process's one copy (`eqlog::spelldb::shared`).
    /// `None` is representable so a caller can build a sink with no catalog; production never does.
    pub db: Option<&'a spelldb::SpellDb>,
    /// The parser's own clock. Handed over rather than rebuilt because a fold that resolved its
    /// launch instant through a SECOND zone would be answering a different question than the
    /// parser's timestamps ask.
    pub clock: &'a Clock,
    /// WHEN THIS ATTACH HAPPENED, in epoch millis — the world's construction clock.
    ///
    /// THE ONE WALL-CLOCK READ THAT REACHES A SINK, and it is production-faithful rather than a
    /// convenience. Over there `WorldOpts.constructionNowMs` defaults to `Date.now()` at
    /// construction and the respawn module seeds its ordering clock from it; the golden recorder
    /// PINS it to the slice's last timestamped line only so a golden re-checks tomorrow. A live
    /// world is built when the attach happens, so that is the instant. It is not fold-derived
    /// state and no module may read a clock after this (`fold`'s "two rules that are not style").
    pub attached_at_ms: i64,
    /// THE APP'S `userData` (JOS-496 item 3), or `None` when the attach did not carry one.
    ///
    /// APP KNOWLEDGE, in exactly the sense boundary verdict 3 gives the phrase: the engine cannot
    /// derive it and must not guess it. `None` is the honest state for every caller but the app,
    /// and it means NO PERSISTENCE AT ALL — no read, no write, and a fold that is the file-free one
    /// the equivalence oracle records. See [`crate::state`].
    pub state_dir: Option<&'a Path>,
}

/// Builds the sink one attach folds into. THE CONSTRUCTION SEAM — see [`EventSink`].
pub type SinkFactory = Arc<dyn Fn(&SinkInputs<'_>) -> Box<dyn EventSink> + Send + Sync>;

/// The factory a plain engine uses.
#[must_use]
pub fn counting_sinks() -> SinkFactory {
    Arc::new(|_inputs| Box::new(CountingSink::default()))
}

/// What [`World`] does when an attach is accepted: begin folding this log, under this generation.
///
/// The world holds one of these rather than a sink factory so that WHAT AN ATTACH STARTS is a
/// single injected decision. Production hands it [`starter`]; `world.rs`'s own unit tests hand it a
/// no-op, which is how the epoch and subscription laws are proven without a fold in the room.
///
/// THE FOURTH ARGUMENT IS THE APP'S `stateDir` (JOS-496 item 3), `None` for every caller that did
/// not push one — which is every caller but the app. See [`crate::state`] for what it buys and for
/// why absent means no persistence at all rather than a default location.
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
/// A SCAN OF A BOUNDED PREFIX, and it is exact rather than a heuristic: `Ev::envelope` writes
/// `seq`, `ts`, `raw` in that order and the only kind that writes anything AHEAD of the envelope is
/// `group` (a short `change` string), so the first `"ts":` in an event is always the envelope's and
/// always well inside [`TS_SCAN_BYTES`]. The `raw` line — the only field that could contain a
/// counterfeit — is written after it, every time.
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

/// The character whose log this is, from the FILE NAME.
///
/// THE NAME IS LOAD-BEARING and must be known before the fold starts: the self-`/who` rule and the
/// pet-leader carve-out both decline every line until it is set (`eqlog::parser_for` says so, and
/// `session.ts` arranges the same order app-side). The engine derives it rather than being told it,
/// because the log's identity and the character's identity are the same fact and two ways of
/// stating it is a way for them to disagree.
///
/// TWO SHAPES, and the second is `eqlog`'s: the product's own `eqlog_<Name>_<server>.txt`, and the
/// oracle corpus's slice form `eqlog_<Name>_<server>.<slice>.txt`, which
/// [`eqlog::character_of`] already implements as `goldenOracle.mts characterOf` does. Anything else
/// yields `None`, and a parser with no character is the honest result — not a guess.
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
    // The LAST underscore separates the character from the server, which is also how eqlog's
    // regex resolves (`([^_]+?)` cannot hold one) — stated the same way in two places on purpose.
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
/// A FAILURE TO SPAWN IS NOT A DEAD ENGINE. The epoch has already been bumped and announced; all
/// that is left is to say the world holds no fold, which is what `idle` means.
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
            // A PANICKING FOLD MUST NOT TAKE THE PROCESS. One bad line, one unwrap somebody adds in
            // phase 2, must cost the fold and nothing else — the same blast-radius argument
            // `World::lock` makes for a poisoned mutex, and the same one that put the fold in
            // another process to begin with. The epoch is untouched: a fold that died did not
            // create a new generation, and the client's state is still the one it was told about.
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
    // ATTACHING is exactly "opening the file and building what a fold depends on" — the spell DB
    // and the character, because a parse is a pure function of (bytes, spell DB, character), and
    // since JOS-478 the REGISTRY as well, because a fold that has no modules has not begun either.
    // Nothing is folded until all of it exists, and the whole of it happens inside this window.
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
    // ONE SPELL DB PER PROCESS (JOS-478), which is what it always ought to have been: it is a pure
    // function of committed data, and until this ticket it was rebuilt on EVERY ATTACH — 386 ms in
    // a release build — only because `eqlog::Parser` owned its `SpellDb` by value and `SpellDb` was
    // neither `Clone` nor shareable. It is an `Arc` now and `spelldb::shared()` is the process's one
    // copy, so the measurement below reads ~0 ms on the second attach of a session and the number
    // is still printed rather than assumed.
    let building = Instant::now();
    let db = spelldb::shared();
    let spell_db_ms = u64::try_from(building.elapsed().as_millis()).unwrap_or(u64::MAX);
    eprintln!("{DIAGNOSTIC_PREFIX} ingest: spell db ready in {spell_db_ms} ms");

    // WHAT THIS GENERATION HAS COST, from before the first byte. `Serving` is built HERE rather
    // than at the fold landing (where the view layer first needs it) because it is now also the
    // answer to `perf.snapshot`, and a door that opens before the scan must have something behind
    // it during the scan — otherwise the one moment a panel most wants to see the engine, the whole
    // minute it spends folding a 200 MB log, is the one moment it can report nothing. Its cadence
    // is not ticked until the tail, so building it early costs a struct.
    let mut serving = Serving::new();
    serving.cost.spell_db_ms = Some(spell_db_ms);
    let parser = Parser::new(
        Clock::new(host_timezone()),
        Some(Arc::clone(&db)),
        character.clone(),
    );

    // THE SINK IS BUILT HERE, ON THIS THREAD, and after the catalog exists — the two facts that
    // made the fold constructible at all (see the module header). It is handed THE PARSER'S OWN
    // clock rather than a second one built from the same zone, so a fold resolving a local-time
    // anchor cannot drift from the timestamps it will compare against. `attached_at_ms` is read
    // once, now, because now is when this world was constructed.
    let mut sink = sinks(&SinkInputs {
        log,
        character: character.as_deref(),
        db: Some(&db),
        clock: parser.clock(),
        attached_at_ms: wall_clock_ms(),
        state_dir,
    });

    // ── APP KNOWLEDGE, APPLIED BEFORE THE FIRST BYTE (JOS-482, boundary verdict 3) ───────────────
    //
    // A `*.define` pushed BEFORE this attach — which is what an ordinary launch looks like, since
    // the app pushes all five the moment it connects and attaches afterwards — is HELD by the world
    // and applied here, at construction. That timing is the whole point: alert defs, buff trust,
    // respawn watches, combo corrections and roster edits all change what a fold PRODUCES, so a
    // world that took them after the historical scan would have folded the log twice into two
    // different answers. It is the same instant `pipeline.ts` passes them to `createModules`.
    for (family, payload) in world.held_defines() {
        sink.define(&family, &payload);
    }

    let mut file = File::open(log)?;
    let size = file.metadata()?.len();

    if !world.report_status(generation, HealthResultStatus::Folding) {
        return Ok(Ended::Preempted);
    }

    // THE SNAPSHOT DOOR OPENS BEFORE THE FIRST BYTE IS FOLDED, so `module.snapshot` can be asked
    // DURING the scan and answered with a real prefix state. Installed through a `report_*` method
    // like every other statement an ingest makes, so a turn that has already lost installs nothing.
    let (asks, answers) = channel::<Ask>();
    if !world.serve_asks(generation, asks) {
        return Ok(Ended::Preempted);
    }

    // …AND SO DOES THE DEFINE DOOR, for the same reason and at the same instant: a preference the
    // user changes while a 200 MB log is folding must reach the fold that is folding it, not the
    // next one. A second channel rather than a second arm on the first: the two carry opposite
    // directions (a read out, a write in) and share nothing but the boundary they are serviced at.
    let (write_to, writes) = channel::<Write>();
    if !world.serve_writes(generation, write_to) {
        return Ok(Ended::Preempted);
    }

    // ---- the scan: the whole file, at full speed -------------------------------------------
    //
    // The line splitting is `eqlog::tail::TailCore`'s rather than `scan_bytes`'s, and the two are
    // the same law: JOS-472's oracle IS the claim that a tail's line sequence equals the scan's
    // over any chunking at all. Using the chunked one buys three things the whole-file one cannot
    // give: a 200 MB log is never a 200 MB allocation, the read cursor is a live measurement to
    // report progress from, and every read boundary is a place to ask who owns the world.
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
        // THE SLICE BOUNDARY, and every one of this loop's outward-facing acts happens here and
        // nowhere else: the generation poll, at most one progress frame per cadence, and whatever
        // snapshots were asked for while the last megabyte was folding. The order is deliberate —
        // a turn that has lost answers nobody, including a reader that is waiting.
        if !world.owns(generation) {
            return Ok(Ended::Preempted);
        }
        if cadence.due() && !world.report_progress(generation, mark(&core, size, seq, &*sink)) {
            return Ok(Ended::Preempted);
        }
        answer_asks(&answers, &*sink, &serving);
        // A DEFINE MID-SCAN IS TAKEN MID-SCAN, and the fold does not restart for it. That is the
        // honest reading of a full-set replace: it is a fact about the world from here on, and the
        // events already folded were folded under what the user had said at the time. The app
        // pushes on connect, before it attaches, so this path is the mid-fold EDIT rather than the
        // ordinary one.
        answer_writes(&writes, &mut *sink);
    }

    // THE FINAL MEASUREMENT IS NOT OPTIONAL and does not ask the cadence. It is the one frame that
    // states the whole fold — `pct` at its ceiling and the exact event count — and a client whose
    // loading bar depends on it must never lose it to a fold that finished inside one interval.
    let landed = mark(&core, size, seq, &*sink);
    let landed_at = Instant::now();
    // THE SCAN'S OWN BILL, closed at the instant it landed. `read_offset` rather than the file's
    // size at open: the file may have grown under the scan, and what this measurement is about is
    // the bytes this fold actually read.
    serving.cost.scan_ms = Some(u64::try_from(scanning.elapsed().as_millis()).unwrap_or(u64::MAX));
    serving.cost.scan_bytes = Some(core.read_offset());
    if !world.report_progress(generation, landed) {
        return Ok(Ended::Preempted);
    }

    // ---- the fold lands ---------------------------------------------------------------------
    //
    // The handoff is `ScanResult.endOffset` → `TailStart::At`: the tail picks up at the end of the
    // last COMPLETE line the scan folded, so bytes appended DURING the scan are read rather than
    // skipped and none are read twice. That seam is the lossless one the architecture diagram
    // names, and the mark law (eqlog::tail's header) is what makes the arithmetic exact.
    // THE FOLD LANDS AS A RESET, per open subscription, carrying rows (JOS-480). `landed_at` is the
    // instant the scan finished, so the first frame of a generation reports the honest fold-to-frame
    // cost of building and cutting every open window off a whole log.
    // ---- THE WORLD GOES LIVE, AND IT IS AGED BEFORE ANYBODY CAN READ IT ----------------------
    //
    // ONE TICK BEFORE THE CADENCE, and it is ordered BEFORE `report_fold_landed` on purpose. That
    // call is what publishes `status: "live"`, the landing reset and the mark; a client — the app's
    // own parity probe among them — polls health and starts asking questions the instant it sees
    // `live`. Ticking afterwards would leave a window, however short, in which the engine served a
    // world the app had already swept, and a race is not a thing to leave in a comparison.
    //
    // It is also exactly what `session.ts startHeartbeat` does: one `registry.tick(Date.now())`
    // before the interval is armed, and before `registry.flushNow()` and `sendWorldRebuilt` publish
    // anything (JOS-149). Whatever real time invalidated while the log was quiet is swept before the
    // first publish, on both sides, in the same order.
    let mut ticking = Ticking::new();
    ticking.beat(&mut *sink);
    // `serving` was built before the scan (JOS-483) rather than here, because it now also holds
    // this generation's cost and answers `perf.snapshot` — and a door that opens before the first
    // byte must have something behind it DURING the scan, which is the whole minute a panel most
    // wants to see the engine. Its cadence is not ticked until the tail either way.
    if !world.report_fold_landed(
        generation,
        landed,
        &SinkRows(&*sink),
        Some(landed_at),
        &mut serving.meter,
    ) {
        return Ok(Ended::Preempted);
    }
    // READ BACK THROUGH THE ONE DOOR, deliberately: this diagnostic is the only place the engine
    // states its own coordinate out loud, and it states the world's copy rather than the ingest's
    // local one — so a mark the world failed to record could not print as if it had.
    let recorded = world.mark();
    eprintln!(
        "{DIAGNOSTIC_PREFIX} fold landed: {} events, mark {} of {}, now live",
        recorded.events,
        recorded.checkpoint,
        recorded.log.as_deref().unwrap_or(log).display()
    );
    // …and beside it, what serving every open window off that fold cost. FORCED rather than left to
    // the meter's cadence: the first frames of a generation are the measurement anybody debugging a
    // slow view wants first, and a session quiet enough never to reach the cadence would otherwise
    // never report the one pass it did make.
    serving.say(true);
    let mut tail = FileTail::open(log, TailStart::At(landed.checkpoint));

    // ---- the tail: live, until something newer takes the world ------------------------------
    //
    // WHAT HAS BEEN ANNOUNCED, not what has been folded. The cadence may DEFER a frame but must
    // never DROP one: an event whose arrival was announced by nobody is an event the client cannot
    // know about at all, and "the count did not change since the last poll" is not the same
    // question as "the count did not change since the last frame".
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
        // WHEN THE FOLD PRODUCED WHAT THE NEXT FRAME WILL REPORT. Read here, once, at the end of the
        // drain that produced it — the origin of ruling 19's fold-to-frame measurement, and the one
        // number that cannot be recovered later. A drain that folded nothing sets nothing, so a
        // frame with no fold behind it is not timed against the age of the session.
        if seq != before {
            serving.folded_at.get_or_insert_with(Instant::now);
        }
        // THE HEARTBEAT, AFTER THE DRAIN AND BEFORE ANYTHING PUBLISHES. Order within one turn of
        // this loop is the only ordering claim available (the app's tailer and its 1 s interval are
        // two independent macrotasks and make none at all), so the useful one is this: whatever the
        // poll folded is aged by the same beat, and both are visible to the progress frame, the
        // snapshot answers and the view pass below rather than to the next turn's.
        ticking.due(&mut *sink);
        if let Err(e) = polled {
            // A FAILED POLL LEAVES THE TAIL RUNNING — `FileTail` drops its handle and the next
            // cycle opens a fresh one under a counted reason. This is `Tailer`'s `'error'` event
            // with the same contract, and ending the ingest here would turn a transient sharing
            // violation into a session that never sees another line.
            eprintln!(
                "{DIAGNOSTIC_PREFIX} a tail poll of {} failed: {e}",
                log.display()
            );
        }
        // A LIVE PROGRESS FRAME IS THE ONLY WIRE EVIDENCE A LIVE LINE LANDED until views arrive in
        // phase 3, so it is emitted when the fold ADVANCED and the cadence allows — never on an
        // idle poll, which is what keeps an idle session silent. `pct` stays honest: the mark over
        // the bytes read, which is 100 exactly when the game is not mid-line.
        if seq != announced && cadence.due() {
            let live_total = tail.read_offset();
            let advanced = FoldMark {
                checkpoint: tail.checkpoint_offset(),
                events: seq,
                pct: pct_of(tail.checkpoint_offset(), live_total),
                // The LIVE denominator is the tail's own read offset, which is what `pct` is over
                // here — the file has no fixed size once EverQuest is appending to it.
                total: live_total,
                last_ts: sink.report().last_ts,
            };
            announced = seq;
            if !world.report_progress(generation, advanced) {
                return Ok(Ended::Preempted);
            }
        }
        answer_asks(&answers, &*sink, &serving);
        answer_writes(&writes, &mut *sink);
        // THE FIRES, IMMEDIATELY AND NOT AT A CADENCE (owner ruling 22). Everything else this loop
        // publishes is STATE, which coalesces by definition — the newest window is the whole
        // answer. A fire is not state: two charm breaks are two sounds, and folding them would
        // silence one. So every fire the drain produced goes out now, in the order the fold made
        // them, and the ~10 Hz view cadence never touches them.
        for fire in sink.take_fires() {
            if !world.report_fire(generation, &fire) {
                return Ok(Ended::Preempted);
            }
        }
        // THE CON CARDS, ON THE FIRES' TERMS AND FOR THE FIRES' REASON. A `/con` is a thing that
        // happened, not state: two cons of two creatures are two cards, and coalescing them would
        // drop the first — which is precisely what the overlay's queue exists to sequence. So they
        // go out now, in fold order, and the view cadence never touches them either.
        for card in sink.take_con_cards() {
            if !world.report_con_card(generation, &card) {
                return Ok(Ended::Preempted);
            }
        }
        // …AND THE NAMES THE FOLD'S PROBES COULD NOT ANSWER (JOS-486), beside the fires and for the
        // same reason: the app has to hear about a live loot line's unknown item on the tick that
        // folded it, not on the next view cadence. Not generation-gated: a miss describes the
        // PROCESS's corpus rather than this generation's world, and the answer that comes back
        // (`knowledge.define`) survives an attach exactly as the world's other defines do.
        world.announce_knowledge_misses(&sink.take_knowledge_misses());
        // THE VIEWS, AT THEIR OWN CADENCE. Everything the drain above folded collapses into at most
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

/// THE LIVE WORLD'S OWN CLOCK (owner ruling 22, JOS-481) — one cadence and one wall-clock read.
///
/// ONE PER ATTACH, like the sink and the parser, and constructed at the LANDING rather than at the
/// top of the ingest: a heartbeat belongs to a live world, and a world that is still scanning does
/// not have one. That is not a policy expressed in a flag — it is where the value is created. A
/// preempted fold's `Ticking` dies with its thread along with everything else that turn built.
///
/// THE INTERVAL IS THE APP'S. `session.ts` arms `setInterval(…, 1000)`, so this is 1 s; the tail
/// polls every 400 ms, so a beat lands on roughly every third turn of the loop and never oftener
/// than the app's own. It is a CEILING and not a promise: a turn that ran late beats once, not
/// twice, because a heartbeat is "age the model to now", which is idempotent in `now` — three
/// missed beats are one beat with a later number.
struct Ticking {
    cadence: Cadence,
}

impl Ticking {
    /// ARMED FROM NOW, not owed: [`Ticking::beat`] is called once at go-live, so the cadence's job
    /// is the interval AFTER that one — `startHeartbeat`'s `registry.tick(…)` then `setInterval`,
    /// in that order.
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

    /// Beat now, whatever the cadence says — the go-live sweep. Reads the wall clock ONCE and hands
    /// it in; nothing here interprets it, which is the whole of this seam's contract with the fold.
    fn beat(&mut self, sink: &mut dyn EventSink) {
        sink.tick(wall_clock_ms());
    }
}

/// WHAT THE LIVE TAIL OWES THE VIEW LAYER: a cadence, the counters, and the fold instant the next
/// frame will be measured against.
///
/// One per attach, like the sink and the parser — a new generation is a new world, and last world's
/// measurements are not this one's.
struct Serving {
    cadence: Cadence,
    meter: Meter,
    /// When the fold produced what the next frame will report, or `None` when it has produced
    /// nothing since the last one. TAKEN by a frame, never merely read: a second frame with no new
    /// events behind it must not be timed against the first one's fold.
    folded_at: Option<Instant>,
    /// What building this generation cost — filled in as each half of it is measured (JOS-483).
    cost: IngestCost,
    /// THE BOUNDED HISTORY BEHIND `perf.timeline` (JOS-502), sampled off the serve beat.
    ///
    /// It lives here rather than in the world for the two reasons the meter does: it is a property
    /// of THIS GENERATION, and it is written on the thread that already owns the counters it reads,
    /// so a history costs no lock on the path every `report_*` contends for. It is fixed-capacity
    /// by construction — see `views::TIMELINE_CAPACITY` for why a bound is the whole design.
    timeline: views::Timeline,
    /// THE MODULE CURSOR LAST ANNOUNCED, per module (JOS-487).
    ///
    /// IT LIVES HERE AND NOT IN THE WORLD, which is the same placement the meter has and for the
    /// same two reasons. It is a property of THIS GENERATION — a new attach builds a new `Serving`
    /// and the fresh fold announces every module on its first beat, which is exactly right, because
    /// after an epoch bump a client has dropped everything anyway. And it is read and written only
    /// on the ingest thread, so it costs no lock on the path every `report_*` already contends for.
    ///
    /// IT IS ALSO WHAT MAKES THE FRAME COALESCED. A busy tail moves a module's seq many times
    /// between two beats; this map remembers the last number announced, so what goes out is one
    /// frame per module per beat carrying the newest cursor — newest-wins, rule 2's own rule.
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
    /// A MODULE ABSENT FROM `module_seqs` IS ABSENT FROM THE ANSWER and keeps whatever it last
    /// announced: a fold that stopped reporting a cursor has said nothing, which is not the same as
    /// saying it went back to zero.
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

    /// This ingest's own answer to `perf.snapshot`. A READ: the meter is peeked rather than
    /// drained, so a panel polling every two seconds cannot zero the counters under the stderr
    /// report or make one poll's numbers depend on the last one (see `views::meter`).
    fn perf(&self) -> EnginePerf {
        EnginePerf {
            ingest: self.cost,
            serve: self.meter.peek(),
            timeline: self.timeline.peek(),
        }
    }

    /// One cadence tick. `false` when this turn no longer owns the world.
    ///
    /// TWO THINGS RIDE THIS BEAT, and the ORDER between them is deliberate: the views first, then
    /// the module dirty bits. A client that draws a view and also holds a module snapshot should
    /// see the rows before it is told to refetch — the other order would send it to `module.snapshot`
    /// for state the very next frame was about to hand it.
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
        // THE RING RIDES THE SERVE BEAT and enforces its own cadence — offered a tick a hundred
        // times more often than it samples, which is two integer operations per beat and keeps the
        // horizon a property of `views::Timeline` rather than of this loop. It is offered AFTER the
        // serve so a window closes on frames that have actually been counted, and the uptime comes
        // from the world because a performance question is never answered off a wall clock.
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
/// answering snapshots between them.
///
/// A LIVE ENGINE SPENDS ALMOST ALL OF ITS TIME HERE, so a reader that only got served at the top of
/// a poll would wait a whole poll interval for state that has not moved in minutes. Serving inside
/// the nap makes the live latency one [`TAIL_NAP`] instead.
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
        // A WRITE ARRIVING WHILE THE TAIL NAPS IS TAKEN IN THAT NAP, for the same reason: a live
        // engine spends almost all of its time here, so a preference saved on an idle log would
        // otherwise wait out a whole poll interval before the fold had heard of it — and a SESSION
        // MARK, which the user presses BECAUSE the log has gone quiet, would land almost always in
        // exactly this nap.
        answer_writes(writes, sink);
        // A SUBSCRIPTION OPENED WHILE THE TAIL IS NAPPING IS OWED A RESET, and the nap is where a
        // live engine spends almost all of its time — the same argument `answer_snapshots` makes
        // one line up. Serving here makes the wait for a full window one nap instead of one poll.
        // Nothing is built when nothing owes and nothing moved.
        serving.tick(world, generation, &*sink);
    }
}

/// Answer everything asked of the fold since the last boundary, and block on none of it.
///
/// `try_recv` UNTIL EMPTY rather than a blocking read: this is called from the fold's own loop and
/// must never stall it. A send that fails is an asker that gave up (its deadline passed, or its
/// connection closed) and is dropped without comment — there is nobody left to tell.
///
/// EVERY ARM IS A READ OF THE FOLD. A module snapshot, a combat snapshot, a fight search and an
/// own-loot read all take `&self` on the sink, and a perf snapshot peeks the meter, so no arm here
/// folds an event, applies a define or moves the ingest's own counters — which is what makes it safe
/// to call at every boundary, including inside the nap. That is a property of the `Ask` enum rather
/// than of this loop: a new arm that needed `&mut` would not compile here, and would belong on the
/// define door instead.
///
/// …WITH ONE STATED EXCEPTION, AND IT IS THE COMBAT ENGINE AGEING ITSELF (JOS-488). `snapshot(now)`
/// over there is a MUTATING READ once the tail is live: it sweeps the charm and ally binds and the
/// pet nudge, and it evaluates deferred encounter closure, all at the instant asked for — so a live
/// combat answer can finalize the open fight, and the next one sees it. That is the ported behaviour
/// and not a leak: it advances only what TIME advances, it is idempotent in `now`, and every event
/// the fold has read has already been folded before this function is reached. WHILE THE SCAN IS
/// RUNNING IT CANNOT HAPPEN AT ALL — the gate is `hydrating`, the scan never leaves it, and that is
/// what keeps a mid-fold answer a real prefix state (ruling 18 law 1).
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

/// Apply every WRITE pushed since the last boundary, and block on none of them.
///
/// `try_recv` UNTIL EMPTY, exactly as [`answer_asks`] is, and for the same reason: this runs
/// inside the fold's own loop and must never stall it. A send that fails is a pusher whose deadline
/// passed or whose connection closed — the write is STILL APPLIED, because the fold is the only
/// place it can take effect and a half-applied world would be worse than a lost receipt. For a
/// DEFINE that is also exactly right: the world already holds the set, so the fold is now in step
/// with what the world holds. For a MARK the receipt is the only record there is (a mark is stored
/// nowhere, by design), so a lost one costs the client its answer and nothing else — and a CONFIRM
/// is a mark's twin on that axis: nothing persists it either, and the module's own next snapshot is
/// a better statement of what happened than the receipt was.
fn answer_writes(writes: &Receiver<Write>, sink: &mut dyn EventSink) {
    while let Ok(write) = writes.try_recv() {
        match write {
            Write::Define(ask) => {
                let took = sink.define(&ask.family, &ask.payload);
                let _dropped = ask.answer.send(took);
            }
            // THE ENGINE'S OWN GATE ANSWERS, not this loop's idea of whether the world is live:
            // `CombatEngine::session_mark` refuses while hydrating, which is the same boundary the
            // world's status gate reads and is the one that actually owns the model.
            Write::Mark(ask) => {
                let took = sink.session_mark(ask.at);
                let _dropped = ask.answer.send(took);
            }
            // THE MODULE'S OWN TWO REFUSALS ANSWER, and there is no gate above them at all — see
            // `World::confirm_sighting`. A confirmation is about a ROW, so "is the world live" is
            // not a question that could bear on it.
            Write::Confirm(ask) => {
                let moved = sink.confirm_sighting(&ask.row_id);
                let _dropped = ask.answer.send(moved);
            }
        }
    }
}

/// THE WALL CLOCK, in epoch millis — the process's one spelling of `Date.now()`.
///
/// THREE READERS AND THEY ARE ALL LIVE-WORLD READERS, which is the module header's rule holding
/// rather than bending: [`SinkInputs::attached_at_ms`] (WHEN the world was built, read once per
/// attach), [`Ticking`]'s beat (the app's own `registry.tick(Date.now())`, live only), and — since
/// JOS-485 — a combat answer taken while the tail is running, which is `combat.snapshot(Date.now(),
/// …)` app-side. Nothing a HISTORICAL fold computes can reach any of them: the scan does not
/// construct, does not beat, and answers its combat questions at `fold.last_ts()` instead
/// (`crate::foldsink`'s header carries that argument in full).
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
    // The file may have GROWN under the scan — EverQuest is still writing it — so the denominator
    // is the larger of what it was and what has actually been read. `pct` then never exceeds 100
    // and never claims a byte nobody has seen.
    let total = size.max(core.read_offset());
    FoldMark {
        checkpoint: core.checkpoint_offset(),
        events,
        pct: pct_of(core.checkpoint_offset(), total),
        // THE DENOMINATOR RIDES ALONG (JOS-503). It is computed here anyway; carrying it costs a
        // `u64` and buys the loading bar its human units, which `pct` alone cannot reconstruct.
        total,
        last_ts: sink.report().last_ts,
    }
}

/// `offset / total * 100`, as a float (owner ruling 17: `pct` is a float), clamped to [0, 100] and
/// answering 0 for a log with no bytes in it rather than a NaN.
fn pct_of(offset: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    #[allow(clippy::cast_precision_loss)]
    let pct = (offset as f64) / (total as f64) * 100.0;
    pct.clamp(0.0, 100.0)
}

/// A pacer. See the module header on which clock reads are allowed and why this one is: it decides
/// HOW OFTEN something is announced, never what is announced, and a skipped tick changes no state.
///
/// TWO CADENCES USE IT and they are different rates for different reasons — progress is ~4/s
/// because a loading bar does not need more, and the view layer is ~10/s because that is the rate
/// the diff protocol names for a live meter.
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
        // Set back a full interval so the FIRST boundary of a long fold announces immediately
        // rather than after a quarter second of silence.
        Self {
            last: Instant::now() - interval,
            every: interval,
        }
    }

    /// The same pacer, ARMED rather than owed: the first `due()` comes one whole interval from now.
    ///
    /// For a caller that has ALREADY done the thing once and wants the cadence to carry on from
    /// there — [`Ticking`], whose go-live beat is `session.ts`'s single `registry.tick(Date.now())`
    /// before its `setInterval` is armed. Built with `every()` instead, the loop's very next turn
    /// would beat again a millisecond later, which is not a heartbeat.
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
        // A character name may hold an underscore; the SERVER may not, so the last one splits.
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
        // `group` is the one kind that writes a field AHEAD of the envelope.
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
        // THE PAYLOAD IS NOT READ HERE, and that is the point of these three tests: a counting sink
        // folds nothing and takes its clock off the SERIALIZED half (`ts_of`), which is the one
        // reader of `json` left on the production path. An empty payload is the honest stand-in.
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

    // ----------------------------------------------------------------------------------------
    // THE INGEST, OVER REAL BYTES.
    //
    // The corpus is committed (`tests/fixtures/*.log`, scrubbed), so these run in CI. Every claim
    // about WHAT was folded is settled against `eqlog::scan::scan_bytes` over the same bytes — the
    // proven path — rather than against a number typed here, which is the only way this suite can
    // still be right after a parser change.
    //
    // NOTHING HERE WAITS FOR THE CLOCK. `settle` waits for a condition and the deadline is a
    // FAILURE MECHANISM: it turns a deadlock into a red test instead of a run that never returns.
    // ----------------------------------------------------------------------------------------

    /// How long any condition in this suite may take before the test is called hung.
    const PATIENCE: Duration = Duration::from_secs(30);

    /// The fixture these tests fold. A loadout-swap window: 459 KB of dense mixed traffic —
    /// combat, casts, `/who`, zoning — which is what makes the event count worth comparing.
    const FIXTURE: &str = "cw2-loadout-swap-aug2.log";

    /// How many times the fixture is concatenated into the scratch log.
    ///
    /// A REAL LOG IS MEGABYTES AND A FIXTURE IS NOT. The properties under test here only exist
    /// across READ BOUNDARIES — a fold long enough to be preempted in the middle of, more than one
    /// progress cadence, a scan that spans several 1 MiB slices — so the scratch copy is built big
    /// enough to have them. Repetition is sound because the parser holds no state across lines: the
    /// oracle folds THE SAME BYTES, so the two agree whatever the repetition does.
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

    /// THE ORACLE: what the proven scan finds in these exact bytes.
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
    /// IT SLEEPS BETWEEN LOOKS RATHER THAN SPINNING. A spin here is not a faster test, it is a test
    /// that takes a core away from the fold it is waiting for — measured: a spinning `settle` under
    /// the suite's own parallelism starved the tail thread past a thirty-second deadline.
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

    /// One HEARTBEAT, as a test sink saw it (JOS-481). `events` is how many events that sink had
    /// folded when the beat arrived, which is what makes "the scan never ticks" a checkable claim
    /// rather than a hopeful one.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Beat {
        sink: usize,
        events: i64,
        now_ms: i64,
    }

    /// What every sink this factory builds writes into. ONE SHARED LIST, in the order events were
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

    /// A gate a sink stops at, until a test opens it. THE DETERMINISM TRICK of this suite: a fold
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
            // THE GATE IS TAKEN AFTER THE RECORD, so a test can see that the fold reached its first
            // event and is now standing still — which is the whole point of holding it.
            if let Some(gate) = self.gate.take() {
                gate.wait();
            }
        }

        /// EVERY BEAT, WITH THE FOLD'S OWN POSITION BESIDE IT (JOS-481). Recording `events` is what
        /// turns "the historical scan never ticks" into an assertion: a beat taken mid-scan would
        /// carry a count short of the log's.
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
    /// FIRST sink only — the one whose fold a preemption test needs to hold still.
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
        // A REAL SUBSCRIPTION OVER THE ONE REGISTERED SOURCE. The recording sink folds no modules,
        // so every window it cuts is empty — which is exactly the claim this test is making: one
        // reset, naming the generation that landed, whatever is (not) in it.
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

        // THE PREEMPTION. Last pick wins, and the pick that lost is still standing at the gate.
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

        // EXACTLY ONE FOLD-LANDS PER WINNING ATTACH: two bumps were announced, one reset arrived,
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

        // The walk's first step is observed from INSIDE the attach, before the ingest thread can
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

        // ATTACHING is the window in which the log is opened and the parse's inputs are built. It is
        // WIDE — the spell DB is the whole committed corpus and takes seconds to build in a debug
        // build (the ingest prints its own measurement) — so a sampler looking every couple of
        // milliseconds cannot miss it.
        settle("the ingest to report `attaching`", || {
            matches!(world.health().status, HealthResultStatus::Attaching)
        });
        // FOLDING is deterministic: the sink is holding the first event at the gate, so the scan
        // cannot finish until this test lets it.
        settle("the scan to start", || {
            matches!(world.health().status, HealthResultStatus::Folding)
        });
        gate.release();
        settle("the tail to take over", || {
            matches!(world.health().status, HealthResultStatus::Live)
        });
    }

    // ── THE LIVE TICK (owner ruling 22, JOS-481) ──────────────────────────────────────────────

    /// THE SCAN NEVER TICKS, held still so the claim is a fact rather than a race.
    ///
    /// The sink stops at the gate on its first event, so the fold is PROVABLY mid-scan and standing
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
        // A WHOLE TICK INTERVAL AND MORE, spent inside the scan. There is no cadence that would
        // have let a beat through, because the tick loop lives past the tail handoff entirely.
        std::thread::sleep(super::TICK_EVERY + super::TICK_EVERY / 2);
        assert!(
            ledger.beats_of(0).is_empty(),
            "a scan was ticked: {:?}",
            ledger.beats_of(0)
        );
        gate.release();
    }

    /// A LIVE WORLD HAS ALREADY BEEN AGED BY THE TIME ANYBODY CAN SEE IT IS LIVE.
    ///
    /// The ordering is the point and it is why the go-live beat is taken BEFORE
    /// `report_fold_landed`: `status: "live"` is the edge every client waits on — the app's parity
    /// probe polls `session.health` for exactly it — so a beat taken after the publish would leave
    /// a window in which the engine served a world the app had already swept.
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
        // EVERY BEAT IS PAST THE WHOLE SCAN, which is the same claim the gated test above makes,
        // arrived at from the other side: a beat carrying a short count would be a tick inside the
        // historical fold.
        for beat in &beats {
            assert_eq!(
                beat.events, expected,
                "a beat landed mid-scan: {beat:?} of {expected}"
            );
            // …and the number handed in is a WALL CLOCK, not a log timestamp: within a minute of
            // this test's own reading of it. A bound loose enough never to be flaky and tight
            // enough that a log's `ts` — which is whatever the fixture says — could not pass it.
            assert!(
                (beat.now_ms - super::wall_clock_ms()).abs() < 60_000,
                "{beat:?} is not this machine's clock"
            );
        }
    }

    /// …AND IT KEEPS BEATING, at the app's own interval, on a log nobody is writing to.
    ///
    /// The heartbeat exists precisely FOR the idle log — a buff whose duration ran out while the
    /// player stared at a quiet screen — so "it beats while nothing arrives" is the claim, not a
    /// side effect of one.
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
        // THE CADENCE IS A CEILING, so the gap is at least the interval and never twice per turn.
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

        // THE GAME WRITES A LINE. Two of them: one the parser types, one it files as `unknown` —
        // both are events, and the tail is a byte-level reader that has no opinion about either.
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
        // Nothing to settle ON — this is an ABSENCE. Two poll intervals of the tail is what makes
        // the claim mean something, and it is the one place in this suite that waits on a clock.
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
