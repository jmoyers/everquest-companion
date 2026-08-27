//! THE ONE DOOR. Every piece of state this process holds lives behind [`World`], and every reader —
//! including the engine's own — asks for it by calling a method.
//!
//! WHY A STORE THAT HOLDS THIS LITTLE IS SHAPED THIS WAY. Owner ruling 18 (docs/plans/
//! data-server.md, "Cache transparency"): the destination is an engine that parses any given log
//! byte once, ever, with a cache under the store seam so transparent that even the engine's own
//! internal callers cannot tell cached from computed. Nothing is cached now and nothing may be —
//! but the interface laws that keep that door open are cheapest to obey while there is little
//! behind it, and impossible to retrofit once twenty modules have reached into each other's fields.
//! The four that bind this file:
//!
//! * **Reads go through one door** (law 2). There is no `pub` field here and no way to borrow the
//!   state. A caller asks [`World::health`] a question and gets an answer; whether that answer was
//!   computed just now or lifted from a checkpoint is not a distinction the caller can make.
//! * **State is addressed by (log identity, byte offset)** (law 3). Nothing here means "current"
//!   implicitly. The epoch is the world's generation and it is stated on every answer that depends
//!   on it; what the fold has consumed is stated as [`World::mark`] — a path and THE MARK, the end
//!   of the last complete line folded — and never as a time or a "so far".
//! * **Determinism is cacheability** (law 1). The two clock-shaped reads in this file are
//!   `uptimeMs` and the log's `logMtimeMs`, and NEITHER IS WORLD STATE. The first is a property of
//!   the PROCESS, derived from the start instant; the second is a property of a FILE, stated fresh
//!   on each answer and stored nowhere (owner ruling 21 — the server owns log-file facts, and
//!   [`World::health`] argues the three properties that keep it a served fact rather than a
//!   remembered one). No world state may ever be a function of the wall clock.
//! * **A cache invalidates by version, never by patching** (law 5). Which is the same statement as
//!   the epoch: a new generation is a new world, and the only way to move between generations is to
//!   take the fresh reset. There is no incremental repair here and there never will be.
//!
//! THE EPOCH AND ITS ANNOUNCEMENT ARE ONE CRITICAL SECTION. [`World::attach`] bumps the generation
//! and pushes the [`EpochMessage`] to every connection while still holding the lock, so no two
//! attaches can interleave their announcements and no connection can ever be told about generation
//! N+1 before generation N. That is not a performance decision — the lock is held for the length of
//! a few `Sender::send` calls into unbounded queues — it is the ordering the client's
//! drop-and-reset rule depends on. Opening a subscription and stamping its reset happen in that
//! same critical section ([`World::open_subscription`]), for the same reason.
//!
//! THE GENERATION IS THE INGEST'S OWNERSHIP TOKEN (JOS-457, engine-side). It is bumped under this
//! file's lock and readable without it, because the question an in-flight fold asks at every slice
//! boundary — "do I still own the world?" — must not contend with the world it no longer owns. Every
//! statement an ingest makes about the world goes through a `report_*` method that re-asks it INSIDE
//! the lock and answers `false` to a turn that has lost; a loser can therefore write nothing, ever,
//! however long it takes to notice. See `ingest.rs` for the other half.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use protocol::generated::{
    AttachResult, ConCardMessage, DiffMessage, DiffMessageKind, EngineMessage, Epoch, EpochMessage,
    EpochMessageKind, EpochReason, FireCaptures, FireMessage, FireMessageKind, FoldProgress,
    HealthResult, HealthResultStatus, KnowledgeMissMessage, KnowledgeMissMessageKind,
    KnowledgePushDomain, LogMark, ModuleChangedMessage, ModuleChangedMessageKind,
    PerfBudgetsResult, PerfIngest, PerfMoment, PerfServeSource, PerfSnapshotResult,
    PerfSnapshotResultStatus, PerfTimelineResult, RequestId, ResetMessage, ResetMessageKind, Row,
};

use crate::budgets;
use crate::ingest::{self, Starter};
use crate::views::{self, FrameKind, Meter, Prepared, SourceDef};

/// The generation a fresh process starts in.
///
/// One, not zero: there is always a world, even when it is an empty one, and an epoch of zero would
/// read as "no world yet" to anybody skimming a log. A launch is generation 1 and the first attach
/// makes it 2.
const FIRST_EPOCH: i64 = 1;

/// How long [`World::module_snapshot`] waits for the ingest thread before calling it unreachable.
///
/// GENEROUS ON PURPOSE, AND THE ARITHMETIC IS THE REASON. The ingest answers at a boundary it
/// already reaches: one 1 MiB read of the scan, or one 25 ms nap of the tail. A release build folds
/// ~9 MB/s through the twenty modules, so that boundary is ~110 ms; a DEBUG build is an order of
/// magnitude slower, which puts one slice near a second, and a loaded machine further still. Five
/// seconds clears all of that by a wide margin while still being short enough that a client's
/// request does not look hung — and every millisecond above the real wait is spent only on a fold
/// that is not coming back.
const SNAPSHOT_PATIENCE: std::time::Duration = std::time::Duration::from_secs(5);

/// What [`World::module_snapshot`] found.
///
/// THREE OUTCOMES AND NOT TWO, because "this engine has no such module" and "this engine has no
/// fold" are different sentences and a client branches on them differently: the first is a caller
/// bug (or a build skew), the second is a session that has not attached yet and will.
#[derive(Debug)]
pub enum SnapshotAnswer {
    /// The module answered with its published state.
    Snapshot(ingest::ModuleSnapshot),
    /// The fold carries no module by that name. The REGISTRY is the authority — see
    /// [`ingest::EventSink::snapshot`].
    NotFound,
    /// Nothing is folding, or the fold could not be reached. The string is the diagnostic that
    /// reaches the client's `ErrorReply.message`.
    Unavailable(String),
}

/// What a performance question found — [`World::perf_snapshot`], [`World::perf_budgets`] and
/// [`World::perf_timeline`] all answer with it.
///
/// TWO OUTCOMES AND NOT THREE, and the missing one is the point: there is no `NotFound`, because a
/// perf question names nothing that could be absent. An engine with no fold at all is NOT a
/// failure here either — it is an idle engine, and `status: idle` with an empty serve list says so
/// exactly. The only refusal is a fold that HAS a door and did not answer through it, which is a
/// wedged ingest and the one thing a performance panel most needs to be told about rather than
/// shown as a row of zeros.
///
/// IT IS GENERIC OVER THE RESULT because the three ops share every one of those sentences (JOS-502)
/// — same door, same deadline, same two outcomes, and the same reason the refusal is singular. Three
/// enums that differed only in one field's type would be three places for that argument to drift.
#[derive(Debug)]
pub enum PerfAnswer<T> {
    /// The engine's own numbers.
    Perf(Box<T>),
    /// A fold that was there to ask and did not answer in time.
    Unavailable(String),
}

/// WHAT A COMBAT QUESTION FOUND (JOS-485).
///
/// TWO OUTCOMES AND NOT THREE, and the missing one is `NotFound` for the same reason
/// [`PerfAnswer`]'s is missing: the request names nothing that could be absent. There is no module
/// id to typo — there is one combat engine or there is none — so a fold this build made without one
/// is `unavailable` beside a world with no fold at all and a fold that did not answer in time. All
/// three are the same sentence to a client: *ask again when something is attached*.
#[derive(Debug)]
pub enum CombatAnswer<T> {
    /// The engine answered.
    Answer(T),
    /// Nothing is folding, this fold carries no combat engine, or it could not be reached. The
    /// string is the diagnostic that reaches the client's `ErrorReply.message`.
    Unavailable(String),
}

/// A handle on the process's whole state. Cheap to clone; every clone is the same world.
#[derive(Clone)]
pub struct World {
    inner: Arc<Inner>,
}

struct Inner {
    /// When this process started. See the header: process metadata, never world state.
    started: Instant,
    /// THE PROCESS'S KNOWLEDGE CORPUS (JOS-486) — committed data plus the overlay the app pushes.
    ///
    /// IT IS NOT WORLD STATE AND IT DOES NOT MOVE WITH THE EPOCH, which is the same statement
    /// `defines` makes one field down: a character switch is not the app withdrawing what it
    /// fetched, and `items.json` says the same thing about the same item in every generation. It is
    /// held here so that the `knowledge.*` ops are answerable by a world with NO FOLD AT ALL — a
    /// corpus question names nothing that could be absent, exactly as a perf question does not.
    knowledge: Arc<knowledge::Corpus>,
    /// THE INGEST'S OWNERSHIP TOKEN. Written only under `state`'s lock; read without it.
    generation: AtomicU64,
    /// What an accepted attach starts. See [`ingest::Starter`] — this is the phase-2a seam, and the
    /// whole extent of what the fold registry changes here.
    ingest: Starter,
    state: Mutex<State>,
}

struct State {
    epoch: i64,
    /// Every open connection's outbox. Connection-wide messages — [`EpochMessage`], and the
    /// per-subscription resets a landing fold produces — are pushed here under the same lock that
    /// owns the epoch.
    listeners: Vec<Listener>,
    /// The next listener id. Monotonic, never reused, so a stale id can never name a live
    /// connection.
    next_listener: u64,
    /// What the ingest is doing. `Idle` when there is none — see [`World::health`].
    status: HealthResultStatus,
    /// What the current ingest has folded, in the only coordinates law 3 allows.
    fold: Fold,
    /// THE APP KNOWLEDGE THE ENGINE HAS BEEN TOLD — the latest `*.define` payload per family
    /// (JOS-482, boundary verdict 3).
    ///
    /// ONE ENTRY PER FAMILY, AND THAT IS THE COMMAND LAW WORKING. A define is an idempotent
    /// FULL-SET REPLACE, so the latest push is the whole of what the app has said and there is
    /// nothing to accumulate: overwriting here is not losing history, it is the absence of history
    /// by design. Which is also what makes a crash-respawn trivial (replay the latest push) and the
    /// input hash-friendly for ruling 18's cache key.
    ///
    /// IT SURVIVES AN ATTACH, deliberately. This is not fold state — the fold's own copy is cleared
    /// with the fold, like everything else a generation owns — it is what the APP has told this
    /// process, and a character switch is not the app withdrawing it. Every attach re-applies it at
    /// construction (`ingest::run`).
    defines: std::collections::BTreeMap<String, serde_json::Value>,
    /// THE WAY TO WRITE INTO THE CURRENT FOLD, or `None` when nothing is folding — app knowledge
    /// (`*.define`) and the session mark, the two statements made TO a fold rather than about one.
    /// Cleared by an attach and by an ended ingest, exactly as `asks` is and in the same critical
    /// section: a preempted fold must not be able to take a define or a mark either.
    write_to: Option<Sender<ingest::Write>>,
    /// THE WAY TO ASK THE CURRENT FOLD A QUESTION, or `None` when nothing is folding.
    ///
    /// ONE DOOR, EVERY QUESTION (see [`ingest::Ask`]): a module's published state, and — since
    /// JOS-483 — what this ingest has cost. A second channel would be a second thing the fold loop
    /// has to remember to drain at every boundary, which is how one of them ends up drained only
    /// while the tail is live.
    ///
    /// It is a SENDER and not the fold, which is the whole design (see [`ingest::SnapshotAsk`]):
    /// the world holds a way to reach the ingest thread, never a second handle on its state. A
    /// preemption drops it — `attach` clears the field under the same lock that bumps the epoch —
    /// so a reader can never be answered by a fold the world has already disowned.
    asks: Option<Sender<ingest::Ask>>,
    /// THE CLIENT'S SPELL TABLE FOR THE INSTALL THIS WORLD IS ATTACHED TO (boundary verdict 7,
    /// JOS-497 item 3). `None` before the first attach, and replaced by every attach.
    ///
    /// IT IS NOT FOLD STATE AND IT IS NOT APP KNOWLEDGE, which is why it is a third kind of field
    /// here. It is not folded from the log, so it does not belong to a generation the way `fold`
    /// does; and it is not something the app TOLD this process, so it does not survive an attach
    /// the way `defines` does. It is a fact about an INSTALL, and the install is named by the log —
    /// so it is derived at attach and replaced at attach, which is exactly the lifetime a character
    /// switch onto a second EverQuest folder needs.
    ///
    /// AN `Arc` SO IT CAN LEAVE THE LOCK. Reading it is 38 MB and a few hundred milliseconds on the
    /// first ask, and holding this mutex across that would stall every other connection and the
    /// ingest's own `report_*` calls. The handle is cloned out under the lock and the parse happens
    /// with the lock released — the same discipline [`World::module_snapshot`] states for the wait.
    client_spells: Option<std::sync::Arc<crate::spells::ClientSpells>>,
    /// WHERE THE CHARACTER LOGS LIVE, as the APP named it (owner ruling 21, decision sheet 1a —
    /// JOS-498). `None` until a `logs.setDir` arrives, which is what makes `logs.list` refusable
    /// rather than emptily wrong.
    ///
    /// IT IS APP KNOWLEDGE AND IT SURVIVES AN ATTACH, exactly as `defines` does and for the
    /// identical reason: a character switch is not the app withdrawing where its logs live. It is
    /// NOT a `*.define` family, though, and the difference is worth the field rather than a sixth
    /// entry in that map — the five defines are FOLD inputs, held so the next attach can apply them
    /// at construction (`held_defines`) and part of ruling 18's cache key. This changes no fold: a
    /// world that has never heard it folds byte-identically to one that has, so putting it in
    /// `defines` would have made a directory look like a parse input to everything downstream that
    /// reads that map.
    log_dir: crate::logs::LogDir,
}

/// What the world's fold has consumed. A COORDINATE PAIR plus what was counted along the way.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Fold {
    /// The log being folded, or `None` before the first attach.
    log: Option<PathBuf>,
    /// THE MARK: the end of the last complete line folded (`eqlog::tail`'s `checkpoint_offset`,
    /// which is the same definition as `ScanResult.endOffset`). The engine owns it — boundary
    /// verdict 4 — and it is the coordinate any future checkpoint is keyed by.
    checkpoint: u64,
    /// Events folded in this generation. Counts EVENTS, not lines.
    events: i64,
    /// The `ts` of the last event folded — THE LOG'S own clock.
    last_ts: Option<i64>,
}

/// One measurement of an ingest, as the ingest thread hands it to the world.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FoldMark {
    /// THE MARK — see [`Fold::checkpoint`].
    pub checkpoint: u64,
    /// Events folded so far.
    pub events: i64,
    /// How far through the bytes the mark has reached, as a percentage. A FLOAT (owner ruling 17),
    /// bytes over bytes, engine-measured.
    pub pct: f64,
    /// `pct`'s DENOMINATOR, carried beside it rather than recomputed by anybody downstream.
    ///
    /// The two travel together for one reason: `pct` is lossy about the thing a loading bar most
    /// wants to say. "62%" cannot be turned back into "128 MB of 205 MB", and the second sentence
    /// is what tells a person whether to wait. The numerator is [`Self::checkpoint`], which this
    /// struct already carried, so the denominator is the only fact that was missing — and it is one
    /// the caller had in its hand at the moment it computed `pct`.
    ///
    /// IT CAN GROW BETWEEN TWO MARKS. EverQuest appends while the fold runs, so this is the larger
    /// of the size at open and the bytes actually read (see `ingest::mark`) rather than a constant.
    pub total: u64,
    /// The `ts` of the last event folded, if one could be read.
    pub last_ts: Option<i64>,
}

/// ONE FILE'S LAST-MODIFIED TIME, in epoch milliseconds, or `None` when there is no answer.
///
/// THE SERVED HALF OF OWNER RULING 21. The app has always taken this itself —
/// `statSync(logPath).mtimeMs` in `main/log/config.ts`, pushed into the character module — and the
/// ruling moves the reading to the process that owns the file. This is the whole of the reading.
///
/// **EVERY FAILURE IS `None`, and that is the honest answer rather than a lazy one.** A missing
/// file, a permission refusal, a filesystem with no modification time, and a timestamp before the
/// epoch are four different reasons and one outcome: this engine cannot state the fact. `0` would
/// claim 1970, which a client would draw as a real date beside a real character name.
///
/// **TRUNCATED, not rounded**, so it equals `Math.floor(statSync(log).mtimeMs)` — Node reports the
/// same NTFS stamp as a float with sub-millisecond digits, and the schema field is an integer.
fn mtime_ms(log: &Path) -> Option<i64> {
    let modified = std::fs::metadata(log).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// What the fold has consumed, as a coordinate the caller can name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    /// The log being folded, or `None` before the first attach.
    pub log: Option<PathBuf>,
    /// THE MARK: the end of the last complete line folded.
    pub checkpoint: u64,
    /// Events folded in this generation.
    pub events: i64,
    /// The `ts` of the last event folded.
    pub last_ts: Option<i64>,
}

struct Listener {
    id: ListenerId,
    outbox: Sender<EngineMessage>,
    /// The subscriptions open on this connection, by the id of the request that opened each.
    ///
    /// THEY LIVE HERE, NOT ON THE CONNECTION, for two reasons that only became true when a fold
    /// arrived: a landing fold must reset EVERY open subscription, which is a statement about all
    /// connections at once; and a subscription's opening reset must be stamped with the epoch under
    /// the same lock that can bump it. Per-connection ISOLATION is unchanged — request ids are
    /// client-chosen and two renderers routinely pick the same number, so a subscription is named
    /// by (listener, id) and one client still cannot unsubscribe another's stream.
    subscriptions: std::collections::BTreeMap<i64, Sub>,
}

/// ONE SUBSCRIPTION'S SERVER-SIDE STATE — the query, and what the client is holding because of it.
///
/// THE ENGINE KEEPS A COPY OF THE CLIENT'S WINDOW, and that is not a cache in ruling 5's sense: it
/// is not an answer kept in case it is asked for again, it is the OTHER OPERAND of the diff. There
/// is no way to compute "what changed" without knowing what was last sent, and the alternative —
/// asking the client — is a round trip per frame on a stream whose whole point is that it does not
/// have one.
struct Sub {
    /// The validated descriptor. Every name in it resolved when it was opened, so nothing
    /// downstream re-checks anything.
    view: views::View,
    /// The rows the client holds, or `None` when a fresh RESET IS OWED — before the first one, and
    /// after a fold lands. A subscription that owes a reset can be sent nothing else: rule 1.
    held: Option<Vec<Row>>,
    /// The view's total as of the last frame, so a `total` that did not move is not re-sent.
    total: i64,
    /// The source revision `held` was cut at. A subscription whose source has not moved since is
    /// not re-cut at all, which is what makes an idle session cost nothing.
    revision: Option<u64>,
}

/// The loot rows a `knowledge.mob` join was handed, as the trait the corpus reads them through.
///
/// A one-line adapter rather than a second trait implementation somewhere clever: the corpus asks
/// for `drops_across(keys)` and the world has already asked the fold for exactly those keys, so the
/// answer is the answer.
struct Seen(Vec<fold::knowledge::SeenDrop>);

impl fold::knowledge::OwnLoot for Seen {
    fn drops_across(&self, _spellings: &[String]) -> Vec<fold::knowledge::SeenDrop> {
        self.0.clone()
    }
}

/// What one source's subscriptions need before a serve pass builds anything.
struct SourceNeed {
    source: &'static SourceDef,
    /// At least one subscription over it owes a reset.
    owed: bool,
    /// The revisions the open subscriptions were last cut at.
    held: Vec<Option<u64>>,
}

/// Names one connection's membership of the world. Opaque on purpose: it is a receipt to hand back
/// to [`World::leave`], never a thing to do arithmetic on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListenerId(u64);

/// What [`World::join`] hands a connection: its receipt, its way to send, and its way to receive.
pub struct Membership {
    /// The receipt for [`World::leave`].
    pub id: ListenerId,
    /// The connection's outbox. Its reader thread pushes replies here; the world pushes
    /// connection-wide messages here. ONE QUEUE, so the order a connection observes is the order
    /// things happened.
    pub outbox: Sender<EngineMessage>,
    /// The other end, drained by the connection's writer thread.
    pub inbox: Receiver<EngineMessage>,
}

impl World {
    /// A fresh world folding into counting sinks. A respawn is a launch (owner ruling 10), so this
    /// is the only way one is ever made and there is no state to restore.
    #[must_use]
    pub fn new() -> Self {
        Self::with_ingest(ingest::default_starter())
    }

    /// A fresh world whose attaches start the ingest the caller names. THE PHASE-2a SEAM: the fold
    /// registry arrives as `ingest::starter(<its factory>)` here and nothing else in this crate
    /// moves.
    #[must_use]
    pub fn with_ingest(ingest: Starter) -> Self {
        Self::with_parts(ingest, crate::foldsink::corpus())
    }

    /// A world whose knowledge corpus is the caller's. The corpus is otherwise the process's one
    /// instance ([`crate::foldsink::corpus`]) and must be, or a name the app pushed in answer to a
    /// miss would be a hit on one path and a miss on the other; this exists for tests that want
    /// their own overlay and their own miss ledger.
    #[must_use]
    pub fn with_parts(ingest: Starter, knowledge: Arc<knowledge::Corpus>) -> Self {
        Self {
            inner: Arc::new(Inner {
                started: Instant::now(),
                knowledge,
                generation: AtomicU64::new(0),
                ingest,
                state: Mutex::new(State {
                    epoch: FIRST_EPOCH,
                    listeners: Vec::new(),
                    next_listener: 0,
                    status: HealthResultStatus::Idle,
                    fold: Fold::default(),
                    asks: None,
                    defines: std::collections::BTreeMap::new(),
                    write_to: None,
                    client_spells: None,
                    log_dir: crate::logs::LogDir::default(),
                }),
            }),
        }
    }

    /// Register a connection and give it its queue.
    pub fn join(&self) -> Membership {
        let (outbox, inbox) = channel();
        let mut state = self.lock();
        let id = ListenerId(state.next_listener);
        state.next_listener += 1;
        state.listeners.push(Listener {
            id,
            outbox: outbox.clone(),
            subscriptions: std::collections::BTreeMap::new(),
        });
        Membership { id, outbox, inbox }
    }

    /// Deregister a connection, and with it every subscription it held. Idempotent: leaving twice is
    /// not an error, because a connection can end in more than one way and the tidy-up path must not
    /// care which.
    pub fn leave(&self, id: ListenerId) {
        self.lock().listeners.retain(|l| l.id != id);
    }

    /// Open one subscription over a validated view, and answer with the epoch its reset must name.
    ///
    /// ONE CRITICAL SECTION, and that closes the caveat phase 0 wrote down here: a caller that read
    /// the epoch and then built a reset from it was racing an attach on another connection, so a
    /// subscription's opening reset could name a generation that had already been superseded. It
    /// cannot now — the registration and the stamp happen together, and an attach that lands after
    /// this returns finds the subscription already registered and resets it when its fold lands.
    ///
    /// IT OPENS OWING A RESET, which is why the ack's own reset is empty even over a fold that is
    /// already live. The rows live on the INGEST THREAD and this call is on a connection thread —
    /// the same wall `module.snapshot` talks through a channel to get past — so the honest opening
    /// frame is the empty window the protocol requires, and the fold answers with a full one at the
    /// next boundary it already reaches (one tail nap). A client cannot tell that from any other
    /// reset, which is the point of reset-then-diffs holding for an empty window.
    pub fn open_subscription(
        &self,
        listener: ListenerId,
        subscription: i64,
        view: views::View,
    ) -> Epoch {
        let mut state = self.lock();
        let epoch = Epoch(state.epoch);
        if let Some(l) = state.listeners.iter_mut().find(|l| l.id == listener) {
            l.subscriptions.insert(
                subscription,
                Sub {
                    view,
                    held: None,
                    total: 0,
                    revision: None,
                },
            );
        }
        epoch
    }

    /// Close one subscription. `false` when this connection does not hold it — including one it held
    /// a moment ago, which is the honest answer rather than a comforting one.
    pub fn close_subscription(&self, listener: ListenerId, subscription: i64) -> bool {
        let mut state = self.lock();
        state
            .listeners
            .iter_mut()
            .find(|l| l.id == listener)
            .is_some_and(|l| l.subscriptions.remove(&subscription).is_some())
    }

    /// SERVE EVERY OPEN SUBSCRIPTION — the view layer's cadence tick.
    ///
    /// Called from the ingest thread at [`views::SERVE_EVERY`] at most, after each tail drain and
    /// between the naps that follow it. Three things happen, in this order, and the order is the
    /// design:
    ///
    /// 1. **A short lock** learns which sources are subscribed and what revision each subscription
    ///    was last cut at. Nothing is built yet.
    /// 2. **Outside the lock**, each source whose revision moved — or that owes somebody a reset —
    ///    is built. That is the expensive step (a source's whole row set), and it happens on the
    ///    ingest thread with the world unlocked, so a connection asking `session.health` is never
    ///    behind a fold's loot ledger.
    /// 3. **Under the lock**, the ownership is re-asked and the frames are cut, diffed and pushed.
    ///    A turn that lost the world between steps 2 and 3 writes nothing, by the same law every
    ///    other `report_*` obeys — which is exactly why the build in step 2 is safe to do outside.
    ///
    /// `folded_at` is when the ingest folded the events this pass is reporting, or `None` when it
    /// folded none (a pass that exists only to answer a subscription that just opened). It is the
    /// origin of the fold-to-frame measurement and nothing else.
    pub fn serve_views(
        &self,
        generation: u64,
        rows: &dyn views::Rows,
        folded_at: Option<Instant>,
        meter: &mut Meter,
    ) -> bool {
        let prepared = self.prepare(rows, false);
        if prepared.is_empty() {
            return self.owns(generation);
        }
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        serve(&mut state, &prepared, false, folded_at, meter);
        true
    }

    /// Which sources have to be built for the next serve pass, and their rows.
    ///
    /// `force` is a landing fold: every subscription is owed a reset, so every subscribed source is
    /// built whatever its revision says.
    fn prepare(&self, rows: &dyn views::Rows, force: bool) -> Vec<Prepared> {
        let needs = {
            let state = self.lock();
            let mut needs: Vec<SourceNeed> = Vec::new();
            for listener in &state.listeners {
                for sub in listener.subscriptions.values() {
                    let source = sub.view.source;
                    let need = match needs.iter_mut().find(|n| n.source.id == source.id) {
                        Some(need) => need,
                        None => {
                            needs.push(SourceNeed {
                                source,
                                owed: false,
                                held: Vec::new(),
                            });
                            needs.last_mut().expect("just pushed")
                        }
                    };
                    need.owed |= sub.held.is_none();
                    need.held.push(sub.revision);
                }
            }
            needs
        };

        needs
            .into_iter()
            .filter_map(|need| {
                // THE CHANGE SIGNAL IS READ FIRST AND IT IS CHEAP — a counter the module bumps on
                // any change it could have made. Everything after this line is only paid for when
                // something actually moved.
                let revision = rows.revision(need.source).unwrap_or(0);
                let stale = need.held.iter().any(|held| *held != Some(revision));
                if !force && !need.owed && !stale {
                    return None;
                }
                Some(Prepared {
                    source: need.source.id,
                    revision,
                    rows: rows.rows(need.source).unwrap_or_default(),
                })
            })
            .collect()
    }

    /// Answer `session.health`.
    ///
    /// THE STATUS IS THE INGEST'S, AND IT IS HONEST NOW (JOS-474): `idle` when no fold exists —
    /// a fresh process, or one whose ingest ended — then `starting` at the instant an attach is
    /// accepted, `attaching` while the log is opened and the parse's inputs are built, `folding`
    /// for the length of the historical scan, and `live` once the tail owns the file.
    ///
    /// THE MARK IS ON THE WIRE NOW (JOS-478), and the schema gap phase 2 wrote down here is closed:
    /// `HealthResult` carries the mark — the addressable coordinate of ruling 18 law 3, a log
    /// identity and the byte offset of the last complete line folded — plus the event count and the
    /// log's own last timestamp. The engine still OWNS all three (boundary verdict 4); it merely
    /// answers them to a client as well as to itself.
    ///
    /// ALL THREE ARE ABSENT BEFORE THE FIRST ATTACH, and absent is not zero. A fresh process has no
    /// log, so it has no coordinate; publishing `offset: 0` would be a measurement nobody took, and
    /// a client cannot tell "nothing folded" from "folded nothing" if the two look the same. The
    /// discriminator is the LOG: the world knows one from the instant an attach is accepted, and
    /// from that instant the count and the mark are real answers even while they read zero.
    ///
    /// AND SINCE JOS-481 IT CARRIES A FOURTH FIELD THAT IS NOT A FOLD FACT AT ALL: `logMtimeMs`,
    /// the log file's last-modified time, stated because owner ruling 21 says the SERVER owns
    /// log-file facts — "the server should be the one reading the log file, rather than the app
    /// reaching in… reported so the app can use it to display and choose the correct character on
    /// launch". Three properties of it are deliberate:
    ///
    ///   * **It is re-stated per answer**, never remembered. A remembered mtime is a cache of
    ///     something the filesystem already holds, and it would be wrong the moment the game
    ///     appended a line. Ruling 5 forbids the cache; the syscall is the honest answer.
    ///   * **It never enters fold state.** It is a fact about a FILE, not about the events in it,
    ///     and ruling 18 addresses state by (log identity, byte offset) and by nothing else. A
    ///     module that folded an mtime would be a module whose output depended on when it ran.
    ///   * **The stat happens with the lock RELEASED.** A filesystem call is unbounded (a stalled
    ///     network drive, a file being rotated) and the world's lock is on the path of every
    ///     `report_*` the ingest makes — holding it across a syscall would let a slow disk stall a
    ///     fold. The state is copied out first; the stat is made against the copy.
    #[must_use]
    pub fn health(&self) -> HealthResult {
        // THE LOCK IS TAKEN AND RELEASED IN THIS BLOCK, and everything below is a function of the
        // copy — see the note above about statting outside it. `Fold` is small and `Clone`, which
        // is what `mark()` already relies on.
        let (status, epoch, fold) = {
            let state = self.lock();
            (state.status, state.epoch, state.fold.clone())
        };
        let mark = fold.log.as_ref().map(|log| LogMark {
            log: log.to_string_lossy().into_owned(),
            offset: i64::try_from(fold.checkpoint).unwrap_or(i64::MAX),
        });
        HealthResult {
            status,
            epoch: Epoch(epoch),
            uptime_ms: i64::try_from(self.inner.started.elapsed().as_millis()).unwrap_or(i64::MAX),
            // `events` rides with the mark, because they are one measurement read two ways: the
            // count and the coordinate it was reached at. One present and the other absent would
            // be a pair a reader has to reason about.
            events: mark.as_ref().map(|_| fold.events),
            // …and `lastEventTs` does NOT, because it has its own reason to be missing: a fold that
            // has folded nothing yet, or whose events so far carried no stamp the parser could
            // read, honestly has no log clock to report.
            last_event_ts: fold.last_ts,
            // THE FILE FACT. Absent before an attach because there is no file, and absent when the
            // stat fails because a log that was renamed out from under the engine has no answer —
            // and `0` would claim 1970 rather than admit the miss.
            log_mtime_ms: fold.log.as_deref().and_then(mtime_ms),
            mark,
        }
    }

    /// Answer `module.snapshot` — one module's published state, from the fold that is running.
    ///
    /// THE ANSWER COMES FROM THE INGEST THREAD AND FROM NOWHERE ELSE. This method holds the world's
    /// lock only long enough to copy the way IN (see [`State::asks`]); the wait happens with
    /// the lock released, or the fold's own `report_progress` would deadlock against the reader
    /// waiting for it.
    ///
    /// THE DEADLINE IS A FAILURE MECHANISM, not a latency budget. In the shapes that exist the
    /// answer arrives within one read boundary of a scan or one nap of a tail; [`SNAPSHOT_PATIENCE`]
    /// exists so that a fold wedged on a pathological file turns into an `unavailable` reply rather
    /// than a connection that never answers — the same argument the ingest suite's own deadline
    /// makes.
    #[must_use]
    pub fn module_snapshot(&self, module: &str) -> SnapshotAnswer {
        // THE LOCK IS TAKEN AND RELEASED IN THESE THREE LINES, and they are three lines rather than
        // one so that nothing about drop order has to be reasoned about: the guard is a named
        // binding inside a block, and the block ends before anything below can block.
        let asks = {
            let state = self.lock();
            state.asks.clone()
        };
        let Some(asks) = asks else {
            return SnapshotAnswer::Unavailable(
                "no log is attached, so there is no fold to ask".to_owned(),
            );
        };
        let (answer, wait) = channel();
        let ask = ingest::Ask::Module(ingest::SnapshotAsk {
            module: module.to_owned(),
            answer,
        });
        if asks.send(ask).is_err() {
            // The receiver is gone: the ingest ended between the copy above and this send. That is
            // the same outcome as never having had one, and it is stated differently because the
            // two are different things to read in a bug report.
            return SnapshotAnswer::Unavailable("the fold that was answering has ended".to_owned());
        }
        match wait.recv_timeout(SNAPSHOT_PATIENCE) {
            Ok(Some(snapshot)) => SnapshotAnswer::Snapshot(snapshot),
            Ok(None) => SnapshotAnswer::NotFound,
            Err(_) => SnapshotAnswer::Unavailable(format!(
                "the fold did not answer within {} ms",
                SNAPSHOT_PATIENCE.as_millis()
            )),
        }
    }

    /// Answer `perf.snapshot` — what this engine is doing and what it has cost (ruling 19, JOS-483).
    ///
    /// THE ANSWER HAS TWO HALVES AND THEY COME FROM TWO PLACES, which is the whole shape of this
    /// method. The WORLD knows where the fold has got to (the same five facts [`World::health`]
    /// reports) and who is subscribed to what — both under this lock, in one critical section, so
    /// the counts and the coordinate describe the same instant. The INGEST THREAD knows what the
    /// scan cost and what the serve path has cost, and it is asked through the one door with the
    /// lock RELEASED, for the deadlock reason [`World::module_snapshot`] states.
    ///
    /// AN ENGINE WITH NOTHING ATTACHED STILL ANSWERS. There is no fold to ask, so the ingest half is
    /// empty — but `status`, `epoch` and `uptimeMs` are real facts about a real process, and a panel
    /// that could not show a just-launched engine at all would be a panel that goes blank exactly
    /// when somebody is waiting for the engine to come up.
    ///
    /// IT READS THE COUNTERS AND RESETS NOTHING (`Meter::peek`). Two panels open at once must see
    /// the same session, and the stderr report must not lose the interval it was about to print.
    #[must_use]
    pub fn perf_snapshot(&self) -> PerfAnswer<PerfSnapshotResult> {
        // ONE CRITICAL SECTION FOR THE WORLD'S WHOLE HALF, and it ends before anything can block.
        //
        // IT COPIES THE STATE RATHER THAN CALLING `health()`, and that is not duplication for its
        // own sake: `health()` STATS THE LOG FILE with the lock deliberately released (see its own
        // note — a filesystem call is unbounded and the world's lock is on the path of every
        // `report_*` an ingest makes), so calling it from inside a lock would be exactly the
        // deadlock-and-stall shape that method's design forbids. And the copy has to happen here
        // anyway: the subscriber counts and the coordinate must describe the SAME instant, or the
        // row states one epoch's mark beside another's watchers.
        //
        // `perf.snapshot` CARRIES NO MTIME. It is a question about this process, not about the file
        // it is reading — `session.health` is where the file fact belongs and where it stays.
        let (status, epoch, fold, watched, asks) = {
            let state = self.lock();
            (
                state.status,
                state.epoch,
                state.fold.clone(),
                subscriber_counts(&state),
                state.asks.clone(),
            )
        };
        // A world with no fold has no door, and that is an idle engine rather than a refusal.
        let measured = match asks {
            None => ingest::EnginePerf::default(),
            Some(asks) => match self.ask_perf(&asks) {
                Ok(measured) => measured,
                Err(why) => return PerfAnswer::Unavailable(why),
            },
        };
        let mark = fold.log.as_ref().map(|log| LogMark {
            log: log.to_string_lossy().into_owned(),
            offset: i64::try_from(fold.checkpoint).unwrap_or(i64::MAX),
        });
        PerfAnswer::Perf(Box::new(PerfSnapshotResult {
            status: perf_status(status),
            epoch: Epoch(epoch),
            uptime_ms: i64::try_from(self.inner.started.elapsed().as_millis()).unwrap_or(i64::MAX),
            // The same pairing `health()` argues for: the count rides with the mark, because they
            // are one measurement read two ways, and `lastEventTs` does not, because it has its own
            // reason to be missing.
            events: mark.as_ref().map(|_| fold.events),
            last_event_ts: fold.last_ts,
            mark,
            ingest: PerfIngest {
                spell_db_ms: measured.ingest.spell_db_ms.map(clamp_i64),
                scan_ms: measured.ingest.scan_ms.map(clamp_i64),
                scan_bytes: measured.ingest.scan_bytes.map(clamp_i64),
            },
            serve: serve_rows(&measured.serve, &watched),
        }))
    }

    /// How long THIS PROCESS has been up, in milliseconds — the one clock a performance answer is
    /// allowed to read.
    ///
    /// PROCESS-RELATIVE AND NOT A WALL CLOCK. It survives an attach, which the epoch does not, and
    /// it carries nothing about when or where a person plays — which is why `views::Timeline`
    /// stamps its moments with it rather than taking a clock of its own. It takes NO LOCK: the
    /// start instant is set once at construction and never written again, and the ingest thread
    /// calls this on the serve beat.
    #[must_use]
    pub fn uptime_ms(&self) -> u64 {
        u64::try_from(self.inner.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Answer `perf.budgets` — every budget this build enforces, judged against this generation.
    ///
    /// SAME DOOR, SAME DEADLINE, SAME TWO OUTCOMES as [`World::perf_snapshot`], and the SAME ASK:
    /// the ingest answers one `PerfAsk` carrying the cost, the serve rows and the ring, and the
    /// three perf ops are three readings of that one answer. A second door would be a second
    /// `try_recv` on the hottest boundary this thread has, bought for nothing.
    ///
    /// THE WORLD'S HALF IS ONE FIELD, so there is no critical section here at all — no subscriber
    /// counts to pair with a coordinate, no status to copy. A budget verdict is a fact about the
    /// generation the measurements came from, so the epoch is read (under the lock, where every
    /// read of it belongs) and carried, and a reader comparing two answers across an attach can see
    /// that they are not comparable.
    ///
    /// THE ARITHMETIC AND THE PROSE ARE `budgets`'s, not this method's. Ruling 4 puts the
    /// comparison and the rendering on this side of the wire; this method's whole job is to pull
    /// three readings out of the answer and hand them over.
    #[must_use]
    pub fn perf_budgets(&self) -> PerfAnswer<PerfBudgetsResult> {
        let (epoch, asks) = {
            let state = self.lock();
            (state.epoch, state.asks.clone())
        };
        let measured = match asks {
            None => ingest::EnginePerf::default(),
            Some(asks) => match self.ask_perf(&asks) {
                Ok(measured) => measured,
                Err(why) => return PerfAnswer::Unavailable(why),
            },
        };
        PerfAnswer::Perf(Box::new(PerfBudgetsResult {
            epoch: Epoch(epoch),
            budgets: budgets::budgets(&budgets::Readings {
                scan_ms: measured.ingest.scan_ms,
                scan_bytes: measured.ingest.scan_bytes,
                // THE WORST ACROSS EVERY SOURCE, and it is the generation's worst rather than any
                // window's: a wedge detector that forgot the frame that wedged would be a wedge
                // detector that clears itself. `filter_map` drops the sources whose frames were all
                // owed resets — absent, never zero, the rule the whole meter keeps.
                worst_serve_us: measured
                    .serve
                    .iter()
                    .filter_map(|row| row.latency_max_us)
                    .max(),
            }),
        }))
    }

    /// Answer `perf.timeline` — the bounded recent history behind the snapshot's totals.
    ///
    /// SAME DOOR AND SAME ASK as [`World::perf_budgets`], for the reasons stated there. The ring
    /// arrives already bounded and already ordered oldest-first (`views::Timeline`), so this method
    /// maps five fields and states the horizon: `capacity` and `cadenceMs` are on the answer
    /// because a client that had to infer the horizon from the LENGTH would infer it wrongly for
    /// the whole first five minutes of every generation.
    #[must_use]
    pub fn perf_timeline(&self) -> PerfAnswer<PerfTimelineResult> {
        let (epoch, asks) = {
            let state = self.lock();
            (state.epoch, state.asks.clone())
        };
        let measured = match asks {
            None => ingest::EnginePerf::default(),
            Some(asks) => match self.ask_perf(&asks) {
                Ok(measured) => measured,
                Err(why) => return PerfAnswer::Unavailable(why),
            },
        };
        PerfAnswer::Perf(Box::new(PerfTimelineResult {
            epoch: Epoch(epoch),
            capacity: i64::try_from(views::TIMELINE_CAPACITY).unwrap_or(i64::MAX),
            cadence_ms: i64::try_from(views::TIMELINE_CADENCE.as_millis()).unwrap_or(i64::MAX),
            timeline: measured.timeline.iter().map(moment_row).collect(),
        }))
    }

    /// Answer `combat.snapshot` — the combat engine's whole state, from the fold that is running.
    ///
    /// THE SAME DOOR AND THE SAME DEADLINE `module.snapshot` uses, and it is not a registry op: the
    /// combat engine is the post-registry subscriber (`WIRING_ORDER` does not name it), so it is
    /// reached by its own arm on the one door rather than by a module id. See [`ask_fold`] for the
    /// wait, and `crate::foldsink` for which clock the answer is stamped with.
    #[must_use]
    pub fn combat_snapshot(
        &self,
        opts: &ingest::CombatOpts,
    ) -> CombatAnswer<ingest::CombatSnapshot> {
        let opts = opts.clone();
        match self.ask_fold(|answer| ingest::Ask::Combat(ingest::CombatAsk { opts, answer })) {
            Err(why) => CombatAnswer::Unavailable(why),
            Ok(None) => CombatAnswer::Unavailable(
                "this fold carries no combat engine, so there is no meter to read".to_owned(),
            ),
            Ok(Some(snapshot)) => CombatAnswer::Answer(snapshot),
        }
    }

    /// Answer `combat.searchFights` — a ranked search of the fold's whole encounter history.
    ///
    /// USER-INITIATED, and it travels the same door anyway. A search is heavier than a snapshot (it
    /// summarizes every finalized fight of the session before it ranks one), and it is still
    /// answered at a boundary the ingest already reaches rather than under a lock — the alternative
    /// would let a person typing into a box stall the fold between keystrokes, which is the exact
    /// shape of hitch this whole program exists to remove.
    #[must_use]
    pub fn search_fights(&self, query: &str, limit: usize) -> CombatAnswer<ingest::FightSearch> {
        let query = query.to_owned();
        match self.ask_fold(|answer| {
            ingest::Ask::Fights(ingest::FightSearchAsk {
                query,
                limit,
                answer,
            })
        }) {
            Err(why) => CombatAnswer::Unavailable(why),
            Ok(None) => CombatAnswer::Unavailable(
                "this fold carries no combat engine, so there is no fight history to search"
                    .to_owned(),
            ),
            Ok(Some(found)) => CombatAnswer::Answer(found),
        }
    }

    /// Answer `resist.levels` — how old these creatures are, as the resist fold knows it
    /// (JOS-497 item 1, cutover ledger item 6).
    ///
    /// THE SAME DOOR AND THE SAME DEADLINE, and like `combat.snapshot` it is not a registry op: the
    /// resist module's PUBLISHED state is two integers, and this fact is in neither of them.
    ///
    /// THERE IS NO `NotFound` ARM, and its absence is the answer being right rather than the
    /// registry being lax. A creature nobody has conned and the committed catalog has never heard of
    /// is not a request naming something that does not exist — it is a perfectly good question whose
    /// honest answer is that nothing states a level. So a name with no answer is simply missing from
    /// the list, and the only refusal here is the one every reader on this door shares: there is
    /// nobody to ask.
    pub fn resist_levels(
        &self,
        names: &[String],
    ) -> Result<Vec<(String, fold::modules::resist::world::MobLevelFact)>, String> {
        let names = names.to_vec();
        self.ask_fold(|answer| ingest::Ask::MobLevels(ingest::MobLevelAsk { names, answer }))
    }

    /// THE CLIENT'S SPELL TABLE FOR THE INSTALL THIS WORLD IS ATTACHED TO (boundary verdict 7,
    /// JOS-497 item 3). `None` when nothing has been attached, which is the only state in which
    /// there is no install to speak of.
    ///
    /// IT DOES NOT GO THROUGH THE INGEST DOOR, and that is the difference between this and every
    /// other reader on this type. The table is not fold state — the resist fold is emphatic that it
    /// never reads the client table, which is what lets a ledger be replayed and re-estimated
    /// without one — so there is nothing to ask the ingest thread ABOUT. It is a file beside a
    /// directory the attach named, and reading it on the thread that tails the log is exactly the
    /// stall this program exists to remove.
    ///
    /// THE HANDLE LEAVES THE LOCK AND THE PARSE HAPPENS OUTSIDE IT. That is the whole reason this
    /// returns an `Arc` rather than an answer: `ClientSpells::table` blocks its caller for a few
    /// hundred milliseconds on the first ask, and doing that under this mutex would stall every
    /// other connection and deadlock against the ingest's own `report_*` calls — `module_snapshot`
    /// states the same rule for the same lock.
    #[must_use]
    pub fn client_spells(&self) -> Option<Arc<crate::spells::ClientSpells>> {
        self.lock().client_spells.clone()
    }

    /// POST ONE ASK THROUGH THE ONE DOOR AND WAIT FOR IT — the shape `module_snapshot` and
    /// `perf_snapshot` each spell out by hand, written once for the readers JOS-485 added.
    ///
    /// THE LOCK IS TAKEN AND RELEASED BEFORE ANYTHING BLOCKS, which is the whole of why this is a
    /// method and not a closure at the call site: the ingest thread takes this lock in every
    /// `report_*` it makes, so waiting under it would deadlock against the very thread being waited
    /// for. `Err` is the three ways there is nobody to answer — nothing attached, an ingest that
    /// ended between the copy and the send, and a fold that did not answer inside
    /// [`SNAPSHOT_PATIENCE`] — each stated differently because they read differently in a bug
    /// report.
    ///
    /// The two older readers are deliberately NOT rewritten onto it. They are proven where they
    /// stand, this is add-only, and a refactor of the door is not a thing to bundle into a ticket
    /// that is adding a surface to it.
    fn ask_fold<T>(&self, make: impl FnOnce(Sender<T>) -> ingest::Ask) -> Result<T, String> {
        let asks = {
            let state = self.lock();
            state.asks.clone()
        };
        let Some(asks) = asks else {
            return Err("no log is attached, so there is no fold to ask".to_owned());
        };
        let (answer, wait) = channel();
        if asks.send(make(answer)).is_err() {
            return Err("the fold that was answering has ended".to_owned());
        }
        wait.recv_timeout(SNAPSHOT_PATIENCE).map_err(|_| {
            format!(
                "the fold did not answer within {} ms",
                SNAPSHOT_PATIENCE.as_millis()
            )
        })
    }

    /// Post the perf ask and wait for the fold, on the same terms `module_snapshot` waits: a
    /// deadline that turns a wedged ingest into a refusal rather than a connection that never
    /// answers. The lock is NOT held here — see the caller.
    fn ask_perf(&self, asks: &Sender<ingest::Ask>) -> Result<ingest::EnginePerf, String> {
        let (answer, wait) = channel();
        if asks
            .send(ingest::Ask::Perf(ingest::PerfAsk { answer }))
            .is_err()
        {
            // The ingest ended between copying the sender and sending through it. Its measurements
            // went with it, and reporting the last generation's numbers under this one's epoch
            // would be worse than saying so.
            return Err("the fold that was answering has ended".to_owned());
        }
        wait.recv_timeout(SNAPSHOT_PATIENCE).map_err(|_| {
            format!(
                "the fold did not answer within {} ms",
                SNAPSHOT_PATIENCE.as_millis()
            )
        })
    }

    /// TAKE ONE FAMILY OF APP KNOWLEDGE — `alerts.define` and its four siblings (JOS-482).
    ///
    /// TWO THINGS HAPPEN AND THE ORDER IS THE DESIGN. The world RECORDS the push first, under the
    /// lock, replacing whatever that family last said; then, with the lock released, it hands the
    /// push to the fold that is running and waits for it. Recording first is what makes the
    /// before-attach case work with no special path at all: a define pushed at a world with no
    /// ingest is simply a define nobody has asked for yet, and the next attach applies it at
    /// construction ([`World::held_defines`]).
    ///
    /// THE WAIT IS WHAT THE ACK IS FOR. `applied: true` is meant to say that the live fold has this
    /// set — not that a queue accepted it — so a client can push a rule and immediately reason
    /// about the world it made. It is bounded by [`SNAPSHOT_PATIENCE`] for the same reason a
    /// snapshot is: a wedged ingest must turn into an answer rather than into a connection that
    /// never replies. The world's own record is already written by then, so a timeout costs the
    /// current generation's copy and nothing more — the next attach still applies it.
    ///
    /// THE LOCK IS NOT HELD ACROSS THE WAIT, exactly as `module_snapshot` does not hold it: the
    /// ingest thread takes this lock in every `report_*` it makes, so waiting under it would
    /// deadlock against the very thread being waited for.
    pub fn define(&self, family: &str, payload: serde_json::Value) {
        let push = {
            let mut state = self.lock();
            state.defines.insert(family.to_owned(), payload.clone());
            state.write_to.clone()
        };
        let Some(push) = push else {
            return;
        };
        let (answer, wait) = channel();
        let ask = ingest::Write::Define(ingest::DefineAsk {
            family: family.to_owned(),
            payload,
            answer,
        });
        if push.send(ask).is_ok() {
            let _took = wait.recv_timeout(SNAPSHOT_PATIENCE);
        }
    }

    /// EVERYTHING THE APP HAS TOLD THIS PROCESS, for an attach to apply at construction.
    ///
    /// A COPY, taken under the lock and handed over — the ingest thread must not hold a borrow into
    /// world state, and the payloads are a handful of small objects pushed a handful of times per
    /// session. Ordered by family (a `BTreeMap`), so two attaches of the same world apply them in
    /// the same order; the order is not observable today — the five families touch five different
    /// modules — and pinning it costs nothing against the day it is.
    #[must_use]
    pub fn held_defines(&self) -> Vec<(String, serde_json::Value)> {
        self.lock()
            .defines
            .iter()
            .map(|(family, payload)| (family.clone(), payload.clone()))
            .collect()
    }

    /// WHERE THE CHARACTER LOGS LIVE, as the app just said (owner ruling 21, decision sheet 1a).
    ///
    /// AN IDEMPOTENT FULL-SET REPLACE OF ONE VALUE, which for a single path means the latest push is
    /// the whole of what the app has said — the same command law the five defines are under, and the
    /// reason a crash-respawn needs nothing but a replay of the latest push.
    ///
    /// NOTHING IS HANDED TO A FOLD, and that is the whole difference from [`World::define`] one
    /// method up. A define changes what folding a log produces and therefore has to reach the
    /// running ingest and be re-applied at the next attach's construction; a directory changes
    /// nothing about any fold, so the write ends here. It also means this call cannot block on the
    /// ingest thread, which is why it takes the lock and drops it in one statement.
    pub fn set_log_dir(&self, dir: &str) {
        self.lock().log_dir.set(dir);
    }

    /// THE CHARACTER LOGS IN THE DIRECTORY THE APP NAMED, or `Err` when it has named none.
    ///
    /// THE SCAN HAPPENS WITH THE LOCK RELEASED, exactly as [`World::module_snapshot`]'s wait does
    /// and for the same reason: it is a readdir plus one stat per file, which is fast on a warm
    /// directory and unbounded on a disconnected network share — and this mutex is taken by the
    /// ingest thread in every `report_*` it makes. Holding it across a filesystem call would let one
    /// slow share stall the fold.
    ///
    /// THE PATH IS COPIED OUT AND ECHOED BACK by the caller, so the answer names the directory it is
    /// about. See `LogsListResult` in the schema: that echo is the client's own staleness test.
    ///
    /// IT NEEDS NO FOLD AND NO ATTACH. A world that has folded nothing answers this perfectly, which
    /// is the launch the op exists for — a fresh install has characters to choose between before
    /// there is anything to attach to.
    pub fn list_logs(&self) -> Result<(String, crate::logs::LogScan), String> {
        let dir = self.lock().log_dir.get().map(std::path::Path::to_path_buf);
        let Some(dir) = dir else {
            return Err(
                "no log directory has been pushed, so there is nothing to enumerate; the app names \
                 it with logs.setDir"
                    .to_owned(),
            );
        };
        let scan = crate::logs::scan(&dir);
        Ok((dir.to_string_lossy().into_owned(), scan))
    }

    /// THE INGEST OFFERS TO TAKE WRITES: install this turn's push channel.
    ///
    /// A `report_*` method like every other statement an ingest makes, and ownership is re-asked
    /// INSIDE the lock for the same reason: a turn that has already lost must not be able to
    /// install a door onto a fold nobody wants.
    pub fn serve_writes(&self, generation: u64, push: Sender<ingest::Write>) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        state.write_to = Some(push);
        true
    }

    /// AN ALERT FIRED (owner ruling 22) — announce it to every connection.
    ///
    /// A `report_*` like every other statement an ingest makes: ownership is re-asked inside the
    /// lock, so a preempted fold that matched a line on its way out announces nothing. CONNECTION-
    /// WIDE, like the epoch, because a fire belongs to the world rather than to any subscription —
    /// and because every window on this app plays the same sound.
    ///
    /// IT CHANGES NO WORLD STATE, which is what makes it different from every other `report_*` here
    /// and why it takes the fire by reference: a fire is a thing that HAPPENED, and the engine keeps
    /// no ledger of them (the fold's own module does, as its published `history`). Nothing to
    /// reconcile means nothing to re-request, which is why the frame carries no epoch.
    pub fn report_fire(&self, generation: u64, fire: &ingest::Fire) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        let frame = EngineMessage::FireMessage(FireMessage {
            kind: FireMessageKind::Fire,
            at: fire.at,
            rule: fire.rule.clone(),
            sound: fire.sound.clone(),
            message: fire.message.clone(),
            // WHAT IT SAYS (JOS-500, ruling 27), carried verbatim. Nothing is decided here and
            // nothing is defaulted: an absent field is the fold's own statement that this firing has
            // nothing true to say there, and null-filling it would turn "no spell in this family"
            // into a value the app would have to learn to disbelieve.
            captures: fire.captures.clone().map(FireCaptures),
            spell: fire.spell.clone(),
            due_at: fire.due_at,
        });
        broadcast(&mut state, &frame);
        true
    }

    /// A LIVE `/con` PRODUCED A CARD (boundary verdict 2) — announce it to every connection.
    ///
    /// A `report_*` like [`World::report_fire`] in every respect, including the two that make it
    /// unusual: ownership is re-asked inside the lock, so a preempted fold that parsed a con line on
    /// its way out draws nothing; and it CHANGES NO WORLD STATE, because a card is a thing that
    /// happened rather than a thing to reconcile. Connection-wide, no `id`, no `epoch` — the frame
    /// carries no generation because there is nothing to drop and nothing to re-request.
    pub fn report_con_card(&self, generation: u64, card: &ConCardMessage) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        broadcast(&mut state, &EngineMessage::ConCardMessage(card.clone()));
        true
    }

    /// MODULES MOVED — announce the dirty bits (JOS-487).
    ///
    /// ONE FRAME PER MODULE, and the caller has already decided which: the ingest holds the last
    /// cursor it announced per module and hands over only the ones that moved since (see
    /// `ingest::Serving::changed_modules`). The COALESCING therefore happens where the beat is,
    /// which is the only place that knows what a beat is.
    ///
    /// THEY GO OUT UNDER ONE LOCK, in the order given, so a connection cannot observe module B's new
    /// cursor before module A's when the same fold moved both.
    pub fn report_modules_changed(&self, generation: u64, changed: &[(&'static str, i64)]) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        for (module, seq) in changed {
            let frame = EngineMessage::ModuleChangedMessage(ModuleChangedMessage {
                kind: ModuleChangedMessageKind::ModuleChanged,
                module: (*module).to_owned(),
                seq: *seq,
            });
            broadcast(&mut state, &frame);
        }
        true
    }

    /// TAKE A SESSION MARK, OR REFUSE IT (boundary verdict 6) — `sessionMarks.add`.
    ///
    /// THE MARK IS STORED NOWHERE, and that absence is the feature. A mark is a user action; it is
    /// ephemeral app-side (`main/sessionMarks.ts` keeps a module-scope array that is empty at every
    /// launch) and it is ephemeral here, which is half of the replay-determinism story — a relaunch
    /// replays the log into the records the log alone describes. The other half is the refusal.
    ///
    /// REFUSED UNLESS THE WORLD IS LIVE, and that is the honest engine-side spelling of
    /// `combat/engine.ts sessionMark`'s `if (st.hydrating) return false`. Over there `hydrating` is
    /// true for the whole of a historical fold and is cleared by the first live tail event; over
    /// here that same boundary IS the status — `starting`, `attaching` and `folding` are the fold
    /// running, `live` is the tail owning the file, and `idle` is no fold at all. A mark cannot
    /// enter a replaying fold, so the JOS-208 replay-versus-live divergence class has no way to
    /// recur here either.
    ///
    /// AND SINCE JOS-492 AN ACCEPTED MARK DOES THE THING. The mark's effect is a COMBAT-ENGINE act
    /// — close the open fight, freeze the running stay into history tagged `closedBy: 'mark'`, mint
    /// fresh accumulators — and the engine is registered now (`foldsink::combat_for`), so the
    /// acceptance is handed to it through the WRITE DOOR and this method waits for it. What was
    /// the command, the law and the reply is now all three plus the act.
    ///
    /// THE TWO GATES ARE ONE BOUNDARY, and the ordering is what makes that true rather than
    /// hopeful: `foldsink::tick` calls `CombatEngine::set_live()` on its first beat, and that beat
    /// happens BEFORE `report_fold_landed` publishes `status: "live"` — so a world this method
    /// finds `Live` is a world whose engine has already left `hydrating`, and the engine's own
    /// refusal can never contradict the status the reply names. Both are kept anyway: the status
    /// gate is what the client is TOLD, and the engine's is what actually owns the model.
    ///
    /// THE LOCK IS NOT HELD ACROSS THE HAND-OVER, exactly as [`World::define`] does not hold it and
    /// for the identical reason: the ingest thread takes this lock in every `report_*` it makes, so
    /// waiting under it would deadlock against the thread being waited for. The status and the door
    /// are read together in one critical section, and the wait happens outside it.
    ///
    /// THE WAIT IS WHAT MAKES THE ACK USABLE. Without it a client could ask `combat.snapshot` the
    /// instant its ack arrived and be answered by a fold that had not yet reached the boundary the
    /// mark was queued at — the split would appear a beat later, which for a person who just
    /// pressed a button is the meter ignoring them. It is bounded by [`SNAPSHOT_PATIENCE`] for the
    /// reason every wait on this door is: a wedged ingest must become an answer rather than a
    /// connection that never replies.
    ///
    /// IT RETURNS THE STATUS IT DECIDED UNDER, read in the SAME critical section as the decision.
    /// A client that asked `session.health` afterwards would be racing a fold that may have gone
    /// live in between, and a refusal explained by a state that no longer holds is worse than one
    /// with no explanation at all.
    pub fn session_mark(&self, at: i64) -> (bool, HealthResultStatus) {
        let (status, push) = {
            let state = self.lock();
            (state.status, state.write_to.clone())
        };
        if !matches!(status, HealthResultStatus::Live) {
            return (false, status);
        }
        // A LIVE WORLD WITH NO DOOR IS A WORLD BEING REPLACED between the two reads above — the
        // attach that cleared it has not yet published its own status. Nothing can be split, so
        // nothing is claimed.
        let Some(push) = push else {
            return (false, status);
        };
        let (answer, wait) = channel();
        let ask = ingest::Write::Mark(ingest::MarkAsk { at, answer });
        if push.send(ask).is_err() {
            return (false, status);
        }
        // THE FOLD'S OWN ANSWER IS THE ANSWER. A timeout answers `false`, which is the honest
        // reading of what this process knows: the mark may still be applied at the next boundary,
        // and a client told `true` by a wait that never returned would have been told something
        // nobody here observed.
        let took = wait.recv_timeout(SNAPSHOT_PATIENCE).unwrap_or(false);
        (took, status)
    }

    /// CONFIRM A SIGHTING (JOS-494) — `respawn.confirmSighting`, the last of the app's commands.
    ///
    /// IT HOLDS NOTHING AND STORES NOTHING, which is the whole difference from [`World::define`]
    /// and is not a shortcut. A define is a PREFERENCE: the world records it under its family so
    /// the next attach re-applies it at construction, because the user's watch list is a fact about
    /// what they want and outlives any one fold. A confirmation is a judgement about one spawn of
    /// one mob in one session — `src/main/ipc/respawn.ts` persists none of it either, and for the
    /// stated reason that the fold is rebuilt from a log that has never heard of the click. So
    /// there is nothing here to hold: a confirm pushed at a world with no ingest is a confirm about
    /// a row that does not exist, and the honest answer is `false`.
    ///
    /// AND THERE IS NO STATUS GATE, which is the whole difference from [`World::session_mark`].
    /// That one refuses while the fold is replaying because the model it reaches refuses
    /// (`combat/engine.ts sessionMark`'s `if (st.hydrating) return false`) and because a mark
    /// entering a replaying fold is the divergence class boundary verdict 6 exists to make
    /// impossible. Neither applies here: `respawnModule.confirmSighting` has exactly two refusals
    /// and both are about the ROW rather than about the world, and a confirmation cannot diverge a
    /// replay for the same reason a mark cannot — nothing persists it, so a re-fold of this log
    /// never sees one. Mirroring the app-side seam exactly is the bar this command is held to, and
    /// a gate the app does not have would be this process quietly disagreeing with it.
    ///
    /// THE WAIT IS [`World::define`]'s, for [`World::define`]'s reason: the answer is meant to say
    /// that the live fold has moved that clock, so a client can push and then reason about the
    /// world it made. A timeout answers `false` — the honest reading of what this process knows,
    /// exactly as `session_mark`'s does.
    pub fn confirm_sighting(&self, row_id: &str) -> bool {
        let Some(push) = self.lock().write_to.clone() else {
            return false;
        };
        let (answer, wait) = channel();
        let ask = ingest::Write::Confirm(ingest::ConfirmAsk {
            row_id: row_id.to_owned(),
            answer,
        });
        if push.send(ask).is_err() {
            return false;
        }
        wait.recv_timeout(SNAPSHOT_PATIENCE).unwrap_or(false)
    }

    /// THE PROCESS'S CORPUS, for the ops that read it directly — `knowledge.item`, `knowledge.spell`
    /// and `knowledge.search` name nothing a fold owns, so they are answered without one.
    #[must_use]
    pub fn knowledge(&self) -> &Arc<knowledge::Corpus> {
        &self.inner.knowledge
    }

    /// ANSWER `knowledge.mob` — the join the two owners have to make together.
    ///
    /// THE CORPUS RESOLVES THE IDENTITY, THE FOLD ANSWERS FOR THE LOOT, AND THE CORPUS JOINS. The
    /// order is the design: the roster's statement that two spellings are one creature lives in
    /// committed data, so the keys are known before anything is asked of the fold, and what crosses
    /// the thread boundary is a handful of rows rather than a handle on somebody's state.
    ///
    /// AN ENGINE WITH NO FOLD STILL ANSWERS, with an empty loot history — the same value a creature
    /// nothing has been looted from gets. A mob card before the first attach is a real card: the drop
    /// table, the quest cross-ref and the era evidence are all committed data, and the one thing
    /// missing is a history that genuinely does not exist yet.
    #[must_use]
    pub fn knowledge_mob(&self, name: &str) -> fold::knowledge::Answer {
        use fold::knowledge::Knowledge as _;
        let keys = self.inner.knowledge.identity_keys(name);
        let seen = self.own_loot(keys);
        self.inner.knowledge.mob(name, &Seen(seen))
    }

    /// Ask the current fold what has been looted off one creature. No fold, or a fold that does not
    /// answer in time, is an empty history rather than a refusal: the rest of the card is committed
    /// data and is worth drawing.
    fn own_loot(&self, spellings: Vec<String>) -> Vec<fold::knowledge::SeenDrop> {
        if spellings.is_empty() {
            return Vec::new();
        }
        let asks = {
            let state = self.lock();
            state.asks.clone()
        };
        let Some(asks) = asks else {
            return Vec::new();
        };
        let (answer, wait) = channel();
        let ask = ingest::Ask::Loot(ingest::LootAsk { spellings, answer });
        if asks.send(ask).is_err() {
            return Vec::new();
        }
        wait.recv_timeout(SNAPSHOT_PATIENCE).unwrap_or_default()
    }

    /// ANNOUNCE EVERY NAME THIS PROCESS COULD NOT ANSWER — the `knowledgeMiss` frames.
    ///
    /// CONNECTION-WIDE, like the epoch and the fire, because the fetch is the app's and one app
    /// makes it once however many windows are open.
    ///
    /// **NOT GENERATION-GATED, and that is the difference from every other broadcast in this file.**
    /// A `report_*` re-asks ownership inside the lock because it states something about THIS
    /// generation's world, and a preempted fold must not be able to write one. A miss states
    /// something about the PROCESS's corpus — this build has no page for that name — which is
    /// equally true whichever fold noticed it and equally true after the next attach. The answer it
    /// asks for lands in the overlay, which survives an attach exactly as the world's `defines` do.
    /// Dropping a miss because the fold that found it lost the world would mean the name is simply
    /// never fetched: the corpus records it as ANNOUNCED and never offers it again.
    pub fn announce_knowledge_misses(&self, misses: &[fold::knowledge::Miss]) {
        if misses.is_empty() {
            return;
        }
        let mut state = self.lock();
        for miss in misses {
            let Ok(domain) = KnowledgePushDomain::try_from(miss.domain.as_str()) else {
                // A domain the wire has no arm for cannot be announced, and the honest outcome is
                // silence rather than a frame nobody can read. The corpus only ever records the two
                // it can be pushed answers for (`knowledge::FETCHABLE_DOMAINS`), so this is
                // unreachable by construction — and stated rather than `unwrap`ped, because an
                // engine that panicked on a diagnostic would be worse than one that says nothing.
                continue;
            };
            let frame = EngineMessage::KnowledgeMissMessage(KnowledgeMissMessage {
                kind: KnowledgeMissMessageKind::KnowledgeMiss,
                domain,
                name: miss.name.clone(),
            });
            broadcast(&mut state, &frame);
        }
    }

    /// What the fold has consumed: the log, THE MARK, and what was counted reaching it.
    ///
    /// The engine's own door onto the coordinate ruling 18 law 3 names. Not on the wire — see the
    /// schema gap in [`World::health`].
    #[must_use]
    pub fn mark(&self) -> Mark {
        let fold = self.lock().fold.clone();
        Mark {
            log: fold.log,
            checkpoint: fold.checkpoint,
            events: fold.events,
            last_ts: fold.last_ts,
        }
    }

    /// Answer `session.attach` — begin folding one log, PREEMPTING anything already folding.
    ///
    /// WHAT HAPPENS INSIDE THE LOCK: the epoch bumps, the generation bumps (which is what strips the
    /// in-flight ingest of its ownership, before this call returns and before anything new starts),
    /// the world is emptied of the previous fold's coordinates, the status becomes `starting`, and
    /// the bump is announced to every connection.
    ///
    /// WHAT HAPPENS OUTSIDE IT: the ingest thread starts. Deliberately after the lock is released —
    /// a thread spawn is a syscall and the epoch's critical section must stay the length of a few
    /// queue pushes.
    ///
    /// `accepted` IS ALWAYS TRUE, and now the field earns its place: an attach preempts any
    /// in-flight attach (last pick wins, never queued), so the only way to lose is to be superseded
    /// — and nothing can supersede an acceptance that completes inside the lock. The turn that LOSES
    /// is the older ingest, and it reports nothing to anybody, by law.
    ///
    /// NO `progress` RIDES THE ANNOUNCEMENT. At the instant of the bump the fold has not opened the
    /// file, so a percentage would be inventing a measurement. The first honest frame arrives from
    /// the ingest a moment later, carrying `pct` 0 and the size it actually measured.
    /// `state_dir` IS THE APP'S `userData` (JOS-496 item 3), and `None` — the file-free attach — is
    /// what a client that said nothing gets, because `stateDir` is optional on the wire.
    ///
    /// IT IS A PARAMETER RATHER THAN A SECOND METHOD, even though almost every caller here passes
    /// `None`, because a convenience wrapper would let a future call site attach without ever
    /// considering the question. `logPath` and `stateDir` are the same KIND of fact — this world,
    /// folded from this log, filed beside this profile — and an attach that named one and not the
    /// other should say so out loud.
    pub fn attach(&self, log_path: &str, state_dir: Option<&str>) -> AttachResult {
        let log = PathBuf::from(log_path);
        let state_dir = state_dir.map(PathBuf::from);
        let generation;
        let epoch;
        {
            let mut state = self.lock();
            state.epoch += 1;
            epoch = Epoch(state.epoch);
            // BUMPED UNDER THE LOCK, so the atomic and the epoch can never disagree about which
            // turn owns the world.
            generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
            state.status = HealthResultStatus::Starting;
            state.fold = Fold {
                log: Some(log.clone()),
                ..Fold::default()
            };
            // THE OLD FOLD STOPS BEING ASKABLE AT THE BUMP, in the same critical section that
            // strips it of its ownership. Not when it notices, not when its thread ends: a reader
            // must never be answered by a generation the world has already replaced, and the
            // preempted ingest's own `report_*` calls already cannot write anything.
            state.asks = None;
            // …and neither is it WRITABLE. `defines` itself is untouched: that is the app's
            // knowledge, not this generation's, and the fold about to be built re-applies it at
            // construction. A session mark has no such second life — it is stored nowhere, so a
            // mark posted at a fold that is being replaced is simply a mark that did not happen.
            state.write_to = None;
            // THE INSTALL IS NAMED BY THE LOG (boundary verdict 7, JOS-497 item 3), so the client
            // table is re-derived here and NOWHERE else. `<eqRoot>/Logs/<log>` up two, plus
            // `spells_us.txt` — a path join and an empty cell, so this costs an attach nothing and
            // the 38 MB read waits for somebody to actually ask (`crate::spells`).
            //
            // REPLACED RATHER THAN KEPT, even when the path is the same. A character switch onto a
            // second EverQuest folder must not answer out of the first folder's table, and deciding
            // that by comparing paths would be a cache with an invalidation rule — which is the
            // thing ruling 5 forbids and ruling 18 law 5 answers with "a mismatch is a full
            // re-fold". A re-attach onto the same install pays one lazy re-read, once, if anybody
            // asks.
            state.client_spells = crate::spells::ClientSpells::beside_log(&log).map(Arc::new);
            let announcement = EngineMessage::EpochMessage(EpochMessage {
                kind: EpochMessageKind::Epoch,
                epoch: Epoch(state.epoch),
                reason: EpochReason::Attach,
                progress: None,
            });
            broadcast(&mut state, &announcement);
        }

        (self.inner.ingest)(self, generation, log, state_dir);

        AttachResult {
            epoch,
            accepted: true,
        }
    }

    /// Does this turn still own the world? The lock-free half of the generation law.
    #[must_use]
    pub fn owns(&self, generation: u64) -> bool {
        self.inner.generation.load(Ordering::SeqCst) == generation
    }

    /// THE INGEST OFFERS TO ANSWER QUESTIONS: install this turn's ask channel.
    ///
    /// A `report_*` method like every other statement an ingest makes, and for the same reason —
    /// ownership is re-asked INSIDE the lock, so a turn that has already lost cannot install a door
    /// onto a fold nobody wants. It is called once per attach, before the first byte is folded, so
    /// that `module.snapshot` and `perf.snapshot` during the historical scan are answerable rather
    /// than merely eventually answerable.
    pub fn serve_asks(&self, generation: u64, asks: Sender<ingest::Ask>) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        state.asks = Some(asks);
        true
    }

    /// Move the health status, if this turn still owns the world.
    pub fn report_status(&self, generation: u64, status: HealthResultStatus) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        state.status = status;
        true
    }

    /// Announce one measurement of the fold to every connection.
    ///
    /// The frame is an `EpochMessage` carrying `progress` — the schema says in as many words that
    /// progress frames are not a fourth stream kind, they are this — so a client that acked
    /// `session.progress` and a client that acked nothing see the same thing, which is what
    /// connection-wide means.
    pub fn report_progress(&self, generation: u64, mark: FoldMark) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        state.fold.checkpoint = mark.checkpoint;
        state.fold.events = mark.events;
        state.fold.last_ts = mark.last_ts;
        let frame = EngineMessage::EpochMessage(EpochMessage {
            kind: EpochMessageKind::Epoch,
            epoch: Epoch(state.epoch),
            reason: EpochReason::Progress,
            progress: Some(FoldProgress {
                pct: mark.pct,
                events: mark.events,
                // BOTH COORDINATES, NOT A ROUNDED ONE. `offset` is the mark itself — the same
                // coordinate `HealthMark.offset` reports, which is why it carries that name — and
                // `logSize` is what `pct` was divided by. Saturating rather than wrapping: the wire
                // type is a signed 64-bit integer and a log larger than 8 exabytes is not a thing,
                // but a silent wrap would draw a NEGATIVE progress bar where a saturate draws a
                // stuck one.
                offset: i64::try_from(mark.checkpoint).unwrap_or(i64::MAX),
                log_size: i64::try_from(mark.total).unwrap_or(i64::MAX),
            }),
        });
        broadcast(&mut state, &frame);
        true
    }

    /// THE FOLD LANDED: the historical scan is complete and the tail has the file.
    ///
    /// Every open subscription is RESET, on every connection, stamped with this generation — rule 1
    /// of the diff protocol (reset-then-diffs) at the one moment the whole window changed at once.
    /// The rows are empty until the fold registry arrives; a client that special-cased "no reset
    /// because there was nothing" would be a client that cannot tell an empty view from a view that
    /// never re-opened.
    ///
    /// EXACTLY ONE PER WINNING ATTACH. A preempted ingest never reaches here, and one that does can
    /// only pass through it once — the tail loop that follows has no way back.
    ///
    /// THE RESET CARRIES ROWS NOW (JOS-480), and the phase-0 note that said it would is closed. The
    /// sources are built BEFORE the lock is taken, for the reason [`World::serve_views`] gives at
    /// length; the stamp, the status and the send still happen in one critical section, so a reset
    /// can still only ever name the generation that landed.
    pub fn report_fold_landed(
        &self,
        generation: u64,
        mark: FoldMark,
        rows: &dyn views::Rows,
        folded_at: Option<Instant>,
        meter: &mut Meter,
    ) -> bool {
        let prepared = self.prepare(rows, true);
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        state.status = HealthResultStatus::Live;
        state.fold.checkpoint = mark.checkpoint;
        state.fold.events = mark.events;
        state.fold.last_ts = mark.last_ts;
        serve(&mut state, &prepared, true, folded_at, meter);
        true
    }

    /// THERE IS NO FOLD ANY MORE — the ingest could not start, could not read, or panicked.
    ///
    /// `idle` is the same word a never-attached process uses, and that is the honest one: it says
    /// nothing is being folded. The EPOCH IS UNTOUCHED, deliberately — a fold that died did not
    /// create a new generation, and a client that was told about generation N is still looking at
    /// generation N's (empty) world rather than at a world it has never heard of.
    pub fn report_idle(&self, generation: u64) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        state.status = HealthResultStatus::Idle;
        // AND NOTHING IS ASKABLE ANY MORE. The ingest's receiver is about to be dropped with its
        // thread; clearing the sender here makes the world say "no fold" rather than making every
        // reader discover it one failed send at a time.
        state.asks = None;
        state.write_to = None;
        true
    }

    /// Take the lock, surviving a poisoned one.
    ///
    /// A POISONED MUTEX MUST NOT END THE ENGINE. Poisoning means some thread panicked while holding
    /// this lock; the state it guards is an integer, a list of channel senders and a byte offset,
    /// none of which a panic can leave torn. Propagating the panic would turn one bad connection —
    /// or one bad fold — into a dead engine for every other renderer, which is precisely the blast
    /// radius this process boundary exists to shrink.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

// ---- the `perf.snapshot` folds ---------------------------------------------------------------
//
// FREE FUNCTIONS, ALL FOUR, and none of them touches the lock: `perf_snapshot` reads the world once
// and then does its arithmetic outside the critical section. A fold that formatted numbers with the
// world held would be a fold that made every connection wait for a diagnostic.

/// The two status enums are generated from two schema definitions with the same five members, so
/// the mapping is exhaustive BY THE COMPILER: a member added to one and not the other stops this
/// building rather than being quietly mapped to the wrong thing.
fn perf_status(status: HealthResultStatus) -> PerfSnapshotResultStatus {
    match status {
        HealthResultStatus::Starting => PerfSnapshotResultStatus::Starting,
        HealthResultStatus::Attaching => PerfSnapshotResultStatus::Attaching,
        HealthResultStatus::Folding => PerfSnapshotResultStatus::Folding,
        HealthResultStatus::Live => PerfSnapshotResultStatus::Live,
        HealthResultStatus::Idle => PerfSnapshotResultStatus::Idle,
    }
}

/// A counter onto the wire's `integer`. Saturating rather than wrapping: a byte count this app can
/// produce does not reach 2^63, and an `as` cast that could silently report a negative one has no
/// place in an instrument.
fn clamp_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// HOW MANY SUBSCRIPTIONS ARE OPEN OVER EACH SOURCE, RIGHT NOW, across every connection.
///
/// A LIVE COUNT, not a cumulative one, and the world's own answer rather than the meter's — the
/// meter counts frames that were sent and knows nothing about who is still listening. It is what
/// makes a row with no recent frames readable: `subscribers 0` means nobody is watching, and
/// `subscribers 2, frames 40` on a quiet source means nothing has moved.
fn subscriber_counts(state: &State) -> BTreeMap<&'static str, i64> {
    let mut counts: BTreeMap<&'static str, i64> = BTreeMap::new();
    for listener in &state.listeners {
        for sub in listener.subscriptions.values() {
            *counts.entry(sub.view.source.id).or_default() += 1;
        }
    }
    counts
}

/// THE UNION OF WHAT HAS SERVED AND WHAT IS BEING WATCHED, ordered by source name.
///
/// TWO REASONS A SOURCE BELONGS IN THIS LIST and they are different sentences. It has served frames
/// (the meter has an entry) — that is a cost, and it belongs whether or not anybody is still
/// subscribed, because the generation's bill does not disappear when a window closes. Or somebody is
/// subscribed to it right now and it has served nothing yet — that is a subscription waiting for its
/// first frame, which is precisely the state a person stares at when a view looks empty, and
/// omitting it would make "opened and nothing came" indistinguishable from "never opened".
///
/// A source in NEITHER set is absent, and that is the panel's own rule arriving from the data: no
/// rows of zeros for a source this session has never had anything to do with.
/// ONE RING ENTRY ON THE WIRE (JOS-502) — five field assignments and no arithmetic.
///
/// A FREE FUNCTION THAT TOUCHES NO LOCK, like the four beside it. The ring did the subtraction that
/// makes each figure an interval, and `views::Timeline` did it where the counters live; this is the
/// mapping onto the generated type, which is the one thing `views/` may not know about.
fn moment_row(moment: &views::Moment) -> PerfMoment {
    PerfMoment {
        at_ms: clamp_i64(moment.at_ms),
        span_ms: clamp_i64(moment.span_ms),
        frames: clamp_i64(moment.frames),
        payload_weight: clamp_i64(moment.bytes),
        fold_to_frame_us_max: moment.worst_us.map(clamp_i64),
    }
}

fn serve_rows(
    served: &[views::SourceMeter],
    watched: &BTreeMap<&'static str, i64>,
) -> Vec<PerfServeSource> {
    let mut rows: BTreeMap<&'static str, PerfServeSource> = BTreeMap::new();
    for source in served {
        rows.insert(
            source.source,
            PerfServeSource {
                source: source.source.to_owned(),
                frames: clamp_i64(source.frames),
                resets: clamp_i64(source.resets),
                diffs: clamp_i64(source.diffs),
                rows: clamp_i64(source.rows),
                payload_weight: clamp_i64(source.bytes),
                widest_payload_weight: clamp_i64(source.widest as u64),
                fold_to_frame_us_mean: source.latency_mean_us.map(clamp_i64),
                fold_to_frame_us_max: source.latency_max_us.map(clamp_i64),
                // Filled below, from the world's own count — a source that has served frames and
                // has since been unsubscribed honestly has zero.
                subscribers: 0,
            },
        );
    }
    for (source, count) in watched {
        rows.entry(source)
            .or_insert_with(|| empty_serve_row(source))
            .subscribers = *count;
    }
    rows.into_values().collect()
}

/// A source somebody is subscribed to that has served nothing yet. Every counter is a REAL zero
/// here — no frame has been sent — and the two latencies are absent, because nothing was timed.
fn empty_serve_row(source: &str) -> PerfServeSource {
    PerfServeSource {
        source: source.to_owned(),
        frames: 0,
        resets: 0,
        diffs: 0,
        rows: 0,
        payload_weight: 0,
        widest_payload_weight: 0,
        fold_to_frame_us_mean: None,
        fold_to_frame_us_max: None,
        subscribers: 0,
    }
}

/// Push a connection-wide message to every open connection, dropping the ones that have gone.
///
/// A SEND THAT FAILS IS A CONNECTION THAT ENDED, not an error: the writer thread drops its receiver
/// when the socket closes, and the world notices here rather than by being told. `leave` remains
/// the tidy path; this is the honest fallback for every other way a connection can die.
fn broadcast(state: &mut State, message: &EngineMessage) {
    state
        .listeners
        .retain(|listener| listener.outbox.send(message.clone()).is_ok());
}

/// SERVE EVERY SUBSCRIPTION OVER A PREPARED SOURCE — the whole of reset-then-diffs, in one place.
///
/// It runs under the world's lock, which is what stamps every frame it sends with the epoch that
/// was current when it was cut. `reset_all` is a landing fold: every window is a new world's and
/// there is nothing to diff against.
///
/// A SUBSCRIPTION WHOSE SOURCE WAS NOT PREPARED IS SKIPPED, silently and correctly: the pass
/// decided nothing about that source had moved, so there is nothing to say about it.
fn serve(
    state: &mut State,
    prepared: &[Prepared],
    reset_all: bool,
    folded_at: Option<Instant>,
    meter: &mut Meter,
) {
    let landed = state.epoch;
    state.listeners.retain_mut(|listener| {
        let mut alive = true;
        for (id, sub) in &mut listener.subscriptions {
            if !alive {
                break;
            }
            let Some(source) = prepared.iter().find(|p| p.source == sub.view.source.id) else {
                continue;
            };
            if !reset_all && sub.held.is_some() && sub.revision == Some(source.revision) {
                continue;
            }
            let (rows, total) = views::cut(&sub.view, &source.rows);
            let owed = reset_all || sub.held.is_none();
            let message = if owed {
                Some((
                    FrameKind::Reset,
                    rows.len(),
                    0,
                    EngineMessage::ResetMessage(ResetMessage {
                        kind: ResetMessageKind::Reset,
                        id: RequestId(*id),
                        epoch: Epoch(landed),
                        total,
                        rows: rows.clone(),
                    }),
                ))
            } else {
                let held = sub.held.as_deref().unwrap_or_default();
                let ops = views::diff(held, &rows);
                // A FRAME THAT SAYS NOTHING IS NOT SENT. `total` moving on its own is still
                // something to say — a filtered view can shrink outside the window — so the two
                // conditions are separate rather than one.
                if ops.is_empty() && total == sub.total {
                    sub.revision = Some(source.revision);
                    continue;
                }
                Some((
                    FrameKind::Diff,
                    0,
                    ops.len(),
                    EngineMessage::DiffMessage(DiffMessage {
                        kind: DiffMessageKind::Diff,
                        id: RequestId(*id),
                        epoch: Epoch(landed),
                        // Present ONLY when it moved — the schema says so, and fixture 03 is a
                        // meter tick with no `total` for exactly this reason.
                        total: (total != sub.total).then_some(total),
                        ops,
                    }),
                ))
            };
            if let Some((kind, row_count, ops, message)) = message {
                // THE BYTES ARE THE FRAME'S OWN. Measured from the message that is about to go out
                // rather than estimated from the rows, because a payload budget that is estimated
                // is a payload budget nobody is keeping (see `views::meter`).
                let bytes = serde_json::to_string(&message).map_or(0, |json| json.len());
                meter.frame(source.source, kind, row_count, ops, bytes, folded_at);
                alive = listener.outbox.send(message).is_ok();
            }
            sub.held = Some(rows);
            sub.total = total;
            sub.revision = Some(source.revision);
        }
        alive
    });
}

#[cfg(test)]
mod tests {
    use super::{FoldMark, World};
    use crate::views::{self, Meter};
    use protocol::generated::{EngineMessage, EpochReason, HealthResultStatus, ViewDescriptor};
    use std::sync::Arc;

    /// A validated view over the one source this build serves. These tests are about the EPOCH, the
    /// generation and the subscription bookkeeping; the view is the smallest real one there is, and
    /// `views::NoRows` below is what makes every window it cuts empty.
    fn a_view() -> views::View {
        views::validate(&ViewDescriptor {
            source: "loot.ledger".to_owned(),
            filter: None,
            sort: Vec::new(),
            window: None,
        })
        .expect("loot.ledger is registered")
    }

    /// Serve every subscription off a world with no fold behind it — which is what a landing fold
    /// does here, and what makes the reset arrive.
    fn land(world: &World, generation: u64, mark: FoldMark) -> bool {
        world.report_fold_landed(generation, mark, &views::NoRows, None, &mut Meter::new())
    }

    /// A path standing in for a log. NOTHING IN THIS MODULE OPENS IT: these tests drive the world
    /// with the ingest replaced by a no-op, so the epoch, the subscription and the generation laws
    /// are proven with no thread, no file and no timing in the room. The ingest's own behaviour is
    /// proven against real bytes in `ingest.rs`'s tests and over a real socket in `tests/ingest.rs`.
    const A_LOG: &str = "C:/nowhere/eqlog_Nobody_freeport.txt";

    /// A world whose attaches start nothing.
    fn world() -> World {
        World::with_ingest(Arc::new(|_world, _generation, _log, _state_dir| {}))
    }

    /// The generation the current turn holds. A real ingest is HANDED its own number by `attach`
    /// and never has to ask; a test that replaced the ingest has to.
    fn generation(world: &World) -> u64 {
        world
            .inner
            .generation
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn mark(events: i64, pct: f64) -> FoldMark {
        FoldMark {
            checkpoint: 4096,
            events,
            pct,
            total: 8192,
            last_ts: Some(1_787_181_707_000),
        }
    }

    #[test]
    fn a_fresh_world_is_idle_in_the_first_generation() {
        let world = world();
        let health = world.health();
        assert!(matches!(health.status, HealthResultStatus::Idle));
        assert_eq!(*health.epoch, 1);
        assert_eq!(world.mark().checkpoint, 0);
        assert!(world.mark().log.is_none());
    }

    #[test]
    fn an_attach_bumps_the_generation_and_tells_everyone() {
        let world = world();
        let one = world.join();
        let two = world.join();

        let result = world.attach(A_LOG, None);
        assert!(result.accepted);
        assert_eq!(*result.epoch, 2);

        for membership in [&one, &two] {
            let message = membership.inbox.recv().expect("an announcement");
            let EngineMessage::EpochMessage(epoch) = message else {
                panic!("a connection-wide announcement is an epoch message");
            };
            assert_eq!(*epoch.epoch, 2);
            assert!(matches!(epoch.reason, EpochReason::Attach));
            assert!(
                epoch.progress.is_none(),
                "at the bump the fold has not opened the file, so it claims no percentage"
            );
        }
    }

    #[test]
    fn a_connection_that_left_hears_nothing_further() {
        let world = world();
        let stayed = world.join();
        let left = world.join();
        world.leave(left.id);

        world.attach(A_LOG, None);

        assert!(stayed.inbox.recv().is_ok());
        assert!(left.inbox.try_recv().is_err());
    }

    #[test]
    fn the_generation_is_process_global_and_monotonic() {
        let world = world();
        let mirror = world.clone();
        assert_eq!(*world.attach(A_LOG, None).epoch, 2);
        assert_eq!(*mirror.attach(A_LOG, None).epoch, 3);
        assert_eq!(*world.health().epoch, 3);
        assert_eq!(*mirror.health().epoch, 3);
    }

    #[test]
    fn an_attach_strips_the_turn_before_it_of_every_way_to_speak() {
        let world = world();
        world.attach(A_LOG, None);
        let loser = generation(&world);
        world.attach(A_LOG, None);

        assert!(!world.owns(loser));
        assert!(!world.report_status(loser, HealthResultStatus::Live));
        assert!(!world.report_progress(loser, mark(10, 50.0)));
        assert!(!land(&world, loser, mark(10, 100.0)));
        assert!(!world.report_idle(loser));
    }

    #[test]
    fn a_progress_frame_carries_the_measurement_to_every_connection() {
        let world = world();
        let listener = world.join();
        world.attach(A_LOG, None);
        let generation = generation(&world);
        // Drain the attach announcement.
        let _bump = listener.inbox.recv().expect("the bump");

        assert!(world.report_progress(generation, mark(1571, 62.4)));
        loop {
            let EngineMessage::EpochMessage(frame) = listener.inbox.recv().expect("a frame") else {
                panic!("progress rides an epoch message");
            };
            if matches!(frame.reason, EpochReason::Attach) {
                continue;
            }
            assert!(matches!(frame.reason, EpochReason::Progress));
            let progress = frame.progress.expect("a progress frame carries progress");
            assert!((progress.pct - 62.4).abs() < f64::EPSILON);
            assert_eq!(progress.events, 1571);
            // THE TWO COORDINATES A LOADING BAR NEEDS, and they are the mark's own rather than
            // anything derived from `pct` — which is the whole reason they ride the frame.
            assert_eq!(progress.offset, 4096);
            assert_eq!(progress.log_size, 8192);
            break;
        }
        assert_eq!(world.mark().events, 1571);
        assert_eq!(world.mark().checkpoint, 4096);
    }

    #[test]
    fn a_landing_fold_resets_every_open_subscription_and_goes_live() {
        let world = world();
        let listener = world.join();
        let bystander = world.join();
        world.open_subscription(listener.id, 7, a_view());
        world.open_subscription(listener.id, 9, a_view());
        world.attach(A_LOG, None);
        let generation = generation(&world);

        assert!(land(&world, generation, mark(3, 100.0)));
        assert!(matches!(world.health().status, HealthResultStatus::Live));

        let mut reset_ids = Vec::new();
        while let Ok(message) = listener.inbox.try_recv() {
            if let EngineMessage::ResetMessage(reset) = message {
                assert_eq!(*reset.epoch, 2, "a reset names the generation that landed");
                assert!(reset.rows.is_empty());
                assert_eq!(reset.total, 0);
                reset_ids.push(*reset.id);
            }
        }
        assert_eq!(reset_ids, vec![7, 9]);

        // A connection with no subscriptions is told about the epoch and nothing else.
        let mut bystander_resets = 0;
        while let Ok(message) = bystander.inbox.try_recv() {
            if matches!(message, EngineMessage::ResetMessage(_)) {
                bystander_resets += 1;
            }
        }
        assert_eq!(bystander_resets, 0);
    }

    #[test]
    fn a_subscription_belongs_to_its_own_connection() {
        let world = world();
        let mine = world.join();
        let theirs = world.join();
        world.open_subscription(mine.id, 7, a_view());

        assert!(!world.close_subscription(theirs.id, 7));
        assert!(world.close_subscription(mine.id, 7));
        assert!(!world.close_subscription(mine.id, 7));
    }

    #[test]
    fn an_ingest_that_ends_leaves_the_world_idle_with_its_generation_intact() {
        let world = world();
        world.attach(A_LOG, None);
        let generation = generation(&world);
        assert!(world.report_idle(generation));
        assert!(matches!(world.health().status, HealthResultStatus::Idle));
        assert_eq!(*world.health().epoch, 2, "a dead fold bumps nothing");
    }
}
