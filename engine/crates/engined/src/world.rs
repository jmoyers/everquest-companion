//! The one door: every piece of state this process holds lives behind [`World`], and every reader —
//! including the engine's own — asks by calling a method. There is no `pub` field and no way to
//! borrow the state, so a cache under this seam would stay invisible to callers. Nothing is cached
//! now and nothing may be.
//!
//! State is addressed by (log identity, byte offset), never "current": the epoch is stated on every
//! answer that depends on it, and progress is [`World::mark`]. No world state may be a function of
//! the wall clock — the two clock-shaped reads here, `uptimeMs` and `logMtimeMs`, are properties of
//! the process and of a file. A new generation is a new world and the only way between them is the
//! fresh reset; there is no incremental repair.
//!
//! The epoch bump and its announcement are one critical section, so no connection can hear about
//! generation N+1 before N; opening a subscription and stamping its reset share that section for
//! the same reason. The generation doubles as the ingest's ownership token: bumped under this lock,
//! readable without it (an in-flight fold asks "do I still own the world?" at every slice
//! boundary), and re-checked inside the lock by every `report_*`, so a loser can write nothing,
//! ever.

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
/// Generous on purpose: the ingest answers at a boundary it already reaches — a 1 MiB read of the
/// scan or a 25 ms nap of the tail — which is ~110 ms in a release build folding ~9 MB/s through
/// the twenty modules, and near a second in a debug build. Five seconds clears that by a wide
/// margin while still being short enough that a client's request does not look hung.
const SNAPSHOT_PATIENCE: std::time::Duration = std::time::Duration::from_secs(5);

/// What [`World::module_snapshot`] found.
///
/// Three outcomes and not two, because "this engine has no such module" and "this engine has no
/// fold" are different sentences a client branches on differently: the first is a caller bug or a
/// build skew, the second is a session that has not attached yet and will.
#[derive(Debug)]
pub enum SnapshotAnswer {
    /// The module answered with its published state.
    Snapshot(ingest::ModuleSnapshot),
    /// The fold carries no module by that name. The registry is the authority — see
    /// [`ingest::EventSink::snapshot`].
    NotFound,
    /// Nothing is folding, or the fold could not be reached. The string is the diagnostic that
    /// reaches the client's `ErrorReply.message`.
    Unavailable(String),
}

/// What a performance question found — [`World::perf_snapshot`], [`World::perf_budgets`] and
/// [`World::perf_timeline`] all answer with it.
///
/// There is no `NotFound`: a perf question names nothing that could be absent, and an engine with
/// no fold is not a failure but an idle engine, which `status: idle` and an empty serve list say
/// exactly. The only refusal is a fold that has a door and did not answer through it.
///
/// Generic over the result because the three ops share every one of those sentences — same door,
/// same deadline, same two outcomes.
#[derive(Debug)]
pub enum PerfAnswer<T> {
    /// The engine's own numbers.
    Perf(Box<T>),
    /// A fold that was there to ask and did not answer in time.
    Unavailable(String),
}

/// What a combat question found.
///
/// No `NotFound`, for [`PerfAnswer`]'s reason: there is no module id to typo, only one combat
/// engine or none. A fold built without one, a world with no fold, and a fold that did not answer
/// in time are all `unavailable` — the same sentence to a client: ask again when something is
/// attached.
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
    /// The process's knowledge corpus — committed data plus the overlay the app pushes.
    ///
    /// Not world state, and it does not move with the epoch: a character switch is not the app
    /// withdrawing what it fetched, and `items.json` says the same thing about the same item in
    /// every generation. It is held here so the `knowledge.*` ops are answerable by a world with no
    /// fold at all.
    knowledge: Arc<knowledge::Corpus>,
    /// The ingest's ownership token. Written only under `state`'s lock; read without it.
    generation: AtomicU64,
    /// What an accepted attach starts. See [`ingest::Starter`].
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
    /// What the current ingest has folded, in the only coordinates the addressing rule allows.
    fold: Fold,
    /// The app knowledge the engine has been told — the latest `*.define` payload per family.
    ///
    /// One entry per family, because a define is an idempotent full-set replace: the latest push is
    /// the whole of what the app has said, so overwriting is the absence of history by design. That
    /// is also what makes a crash-respawn a replay of the latest push.
    ///
    /// It survives an attach, deliberately. This is not fold state — the fold's own copy is cleared
    /// with the fold — it is what the app has told this process, and a character switch is not the
    /// app withdrawing it. Every attach re-applies it at construction (`ingest::run`).
    defines: std::collections::BTreeMap<String, serde_json::Value>,
    /// The way to write into the current fold, or `None` when nothing is folding — app knowledge
    /// (`*.define`) and the session mark, the statements made *to* a fold rather than about one.
    /// Cleared by an attach and by an ended ingest, in the same critical section `asks` is: a
    /// preempted fold must not be able to take a define or a mark either.
    write_to: Option<Sender<ingest::Write>>,
    /// The way to ask the current fold a question, or `None` when nothing is folding.
    ///
    /// One door, every question (see [`ingest::Ask`]). A second channel would be a second thing the
    /// fold loop has to remember to drain at every boundary, which is how one ends up drained only
    /// while the tail is live.
    ///
    /// It is a sender and not the fold: the world holds a way to reach the ingest thread, never a
    /// second handle on its state. A preemption drops it — `attach` clears the field under the same
    /// lock that bumps the epoch — so a reader can never be answered by a disowned fold.
    asks: Option<Sender<ingest::Ask>>,
    /// The client's spell table for the install this world is attached to. `None` before the first
    /// attach, and replaced by every attach.
    ///
    /// A third kind of field: not folded from the log, so it does not belong to a generation the
    /// way `fold` does; not something the app told this process, so it does not survive an attach
    /// the way `defines` does. It is a fact about an install, and the install is named by the log —
    /// so it is derived at attach and replaced at attach, which is the lifetime a character switch
    /// onto a second EverQuest folder needs.
    ///
    /// An `Arc` so it can leave the lock: reading it is 38 MB and a few hundred milliseconds on the
    /// first ask, and holding this mutex across that would stall every other connection and the
    /// ingest's own `report_*` calls. The handle is cloned out under the lock and the parse happens
    /// with the lock released.
    client_spells: Option<std::sync::Arc<crate::spells::ClientSpells>>,
    /// Where the character logs live, as the app named it. `None` until a `logs.setDir` arrives,
    /// which is what makes `logs.list` refusable rather than emptily wrong.
    ///
    /// App knowledge that survives an attach, exactly as `defines` does. It is not a `*.define`
    /// family, though, and the difference earns the field: the five defines are fold inputs, held
    /// so the next attach can apply them at construction (`held_defines`), while a directory
    /// changes no fold at all. Putting it in `defines` would make a directory look like a parse
    /// input to everything downstream that reads that map.
    log_dir: crate::logs::LogDir,
}

/// What the world's fold has consumed: a coordinate pair plus what was counted along the way.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Fold {
    /// The log being folded, or `None` before the first attach.
    log: Option<PathBuf>,
    /// The mark: the end of the last complete line folded (`eqlog::tail`'s `checkpoint_offset`, the
    /// same definition as `ScanResult.endOffset`). The coordinate any future checkpoint is keyed
    /// by.
    checkpoint: u64,
    /// Events folded in this generation. Counts events, not lines.
    events: i64,
    /// The `ts` of the last event folded — the log's own clock.
    last_ts: Option<i64>,
}

/// One measurement of an ingest, as the ingest thread hands it to the world.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FoldMark {
    /// The mark — see [`Fold::checkpoint`].
    pub checkpoint: u64,
    /// Events folded so far.
    pub events: i64,
    /// How far through the bytes the mark has reached, as a percentage. A float, bytes over bytes,
    /// engine-measured.
    pub pct: f64,
    /// `pct`'s denominator, carried beside it rather than recomputed by anybody downstream.
    ///
    /// `pct` is lossy about the thing a loading bar most wants to say: "62%" cannot be turned back
    /// into "128 MB of 205 MB", and the second sentence is what tells a person whether to wait. The
    /// numerator is [`Self::checkpoint`], so the denominator is the only fact that was missing.
    ///
    /// It can grow between two marks: EverQuest appends while the fold runs, so this is the larger
    /// of the size at open and the bytes actually read (see `ingest::mark`) rather than a constant.
    pub total: u64,
    /// The `ts` of the last event folded, if one could be read.
    pub last_ts: Option<i64>,
    /// Which loop took this measurement — false for the historical scan, [`eqlog::tail::LIVE`] for
    /// the tail.
    ///
    /// It travels because the numbers beside it cannot be read for it: a caught-up tail reports
    /// `pct` 100 with `events` climbing, byte-for-byte what a scan that has just finished reports,
    /// so a client deciding from frame content whether a catch-up is still running cannot decide at
    /// all.
    ///
    /// It goes on the wire as `FoldProgress.live`, present only when true — see that field.
    pub live: bool,
}

/// One file's last-modified time, in epoch milliseconds, or `None` when there is no answer.
///
/// The server owns log-file facts, so the reading lives here rather than app-side. This is the
/// whole of the reading.
///
/// Every failure is `None`, and that is the honest answer: a missing file, a permission refusal, a
/// filesystem with no modification time and a stamp before the epoch are four reasons and one
/// outcome — this engine cannot state the fact. `0` would claim 1970, which a client would draw as
/// a real date beside a real character name.
///
/// Truncated, not rounded, so it equals `Math.floor(statSync(log).mtimeMs)`: Node reports the same
/// NTFS stamp as a float with sub-millisecond digits, and the schema field is an integer.
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
    /// The mark: the end of the last complete line folded.
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
    /// They live here, not on the connection, for two reasons: a landing fold must reset every open
    /// subscription, which is a statement about all connections at once; and a subscription's
    /// opening reset must be stamped with the epoch under the same lock that can bump it.
    /// Per-connection isolation is unchanged — request ids are client-chosen and two renderers
    /// routinely pick the same number, so a subscription is named by (listener, id).
    subscriptions: std::collections::BTreeMap<i64, Sub>,
}

/// One subscription's server-side state — the query, and what the client is holding because of it.
///
/// The engine keeps a copy of the client's window, and that is not a cache: it is the other operand
/// of the diff. There is no way to compute "what changed" without knowing what was last sent, and
/// asking the client would be a round trip per frame on a stream whose point is not having one.
struct Sub {
    /// The validated descriptor. Every name in it resolved when it was opened, so nothing
    /// downstream re-checks anything.
    view: views::View,
    /// The rows the client holds, or `None` when a fresh reset is owed — before the first one, and
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
    /// connection-wide messages here. One queue, so the order a connection observes is the order
    /// things happened.
    pub outbox: Sender<EngineMessage>,
    /// The other end, drained by the connection's writer thread.
    pub inbox: Receiver<EngineMessage>,
}

impl World {
    /// A fresh world folding into counting sinks. A respawn is a launch, so this is the only way
    /// one is ever made and there is no state to restore.
    #[must_use]
    pub fn new() -> Self {
        Self::with_ingest(ingest::default_starter())
    }

    /// A fresh world whose attaches start the ingest the caller names — the seam the fold registry
    /// arrives through, as `ingest::starter(<its factory>)`.
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

    /// Deregister a connection, and with it every subscription it held. Idempotent: leaving twice
    /// is not an error, because a connection can end in more than one way and the tidy-up path must
    /// not care which.
    pub fn leave(&self, id: ListenerId) {
        self.lock().listeners.retain(|l| l.id != id);
    }

    /// Open one subscription over a validated view, and answer with the epoch its reset must name.
    ///
    /// One critical section: the registration and the stamp happen together, so a subscription's
    /// opening reset cannot name a generation an attach on another connection has already
    /// superseded. An attach that lands after this returns finds the subscription registered and
    /// resets it when its fold lands.
    ///
    /// It opens owing a reset, which is why the ack's own reset is empty even over a live fold. The
    /// rows live on the ingest thread and this call is on a connection thread, so the honest
    /// opening frame is the empty window the protocol requires and the fold answers with a full one
    /// at the next boundary it reaches (one tail nap).
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

    /// Close one subscription. `false` when this connection does not hold it — including one it
    /// held a moment ago, which is the honest answer rather than a comforting one.
    pub fn close_subscription(&self, listener: ListenerId, subscription: i64) -> bool {
        let mut state = self.lock();
        state
            .listeners
            .iter_mut()
            .find(|l| l.id == listener)
            .is_some_and(|l| l.subscriptions.remove(&subscription).is_some())
    }

    /// Serve every open subscription — the view layer's cadence tick.
    ///
    /// Called from the ingest thread at [`views::SERVE_EVERY`] at most. A short lock learns which
    /// sources are subscribed and at what revision; the expensive build of each moved or owed
    /// source happens outside the lock, so a connection asking `session.health` is never behind a
    /// fold's loot ledger; then under the lock the ownership is re-asked and the frames are cut,
    /// diffed and pushed. A turn that lost the world between the build and the push writes nothing,
    /// which is what makes building outside safe.
    ///
    /// `folded_at` is when the ingest folded the events this pass is reporting, or `None` when it
    /// folded none. It is the origin of the fold-to-frame measurement and nothing else.
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
                // The change signal is read first and it is cheap — a counter the module bumps on
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
    /// The status is the ingest's: `idle` with no fold, `starting` when an attach is accepted,
    /// `attaching` while the log is opened and the parse's inputs are built, `folding` for the
    /// historical scan, `live` once the tail owns the file.
    ///
    /// The mark, the event count and the log's last timestamp are all absent before the first
    /// attach, and absent is not zero: publishing `offset: 0` would be a measurement nobody took.
    /// The discriminator is the log, which the world knows from the instant an attach is accepted.
    ///
    /// `logMtimeMs` is not a fold fact at all, and three properties of it are deliberate. It is
    /// re-stated per answer, never remembered, because a remembered mtime is wrong the moment the
    /// game appends a line. It never enters fold state — a module that folded an mtime would be a
    /// module whose output depended on when it ran. And the stat happens with the lock released,
    /// because a filesystem call is unbounded and this lock is on the path of every `report_*` the
    /// ingest makes; the state is copied out first and the stat is made against the copy.
    #[must_use]
    pub fn health(&self) -> HealthResult {
        // The lock is taken and released in this block, and everything below is a function of the
        // copy — see the note above about statting outside it.
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
            // …and `lastEventTs` does not, because it has its own reason to be missing: a fold that
            // has folded nothing yet, or whose events carried no stamp the parser could read,
            // honestly has no log clock to report.
            last_event_ts: fold.last_ts,
            // The file fact. Absent before an attach because there is no file, and absent when the
            // stat fails because a log renamed out from under the engine has no answer — `0` would
            // claim 1970 rather than admit the miss.
            log_mtime_ms: fold.log.as_deref().and_then(mtime_ms),
            mark,
        }
    }

    /// Answer `module.snapshot` — one module's published state, from the fold that is running.
    ///
    /// The answer comes from the ingest thread and from nowhere else. This method holds the world's
    /// lock only long enough to copy the way in (see [`State::asks`]); the wait happens with the
    /// lock released, or the fold's own `report_progress` would deadlock against the reader waiting
    /// for it.
    ///
    /// The deadline is a failure mechanism, not a latency budget: the answer arrives within one
    /// read boundary of a scan or one nap of a tail, and [`SNAPSHOT_PATIENCE`] exists so a fold
    /// wedged on a pathological file becomes an `unavailable` reply rather than a connection that
    /// never answers.
    #[must_use]
    pub fn module_snapshot(&self, module: &str) -> SnapshotAnswer {
        // The lock is taken and released in these three lines, written as three so nothing about
        // drop order has to be reasoned about: the guard is a named binding inside a block, and the
        // block ends before anything below can block.
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

    /// Answer `perf.snapshot` — what this engine is doing and what it has cost.
    ///
    /// Two halves from two places. The world knows where the fold has got to and who is subscribed
    /// to what, both in one critical section so the counts and the coordinate describe the same
    /// instant; the ingest thread knows what the scan and the serve path cost, and is asked through
    /// the one door with the lock released, for [`World::module_snapshot`]'s deadlock reason.
    ///
    /// An engine with nothing attached still answers: the ingest half is empty, but `status`,
    /// `epoch` and `uptimeMs` are real facts about a real process.
    ///
    /// It reads the counters and resets nothing (`Meter::peek`): two panels open at once must see
    /// the same session, and the stderr report must not lose the interval it was about to print.
    #[must_use]
    pub fn perf_snapshot(&self) -> PerfAnswer<PerfSnapshotResult> {
        // One critical section for the world's whole half, ending before anything can block.
        //
        // It copies the state rather than calling `health()`, which stats the log file with the
        // lock deliberately released — calling it from inside a lock would be the
        // deadlock-and-stall shape that method's design forbids. The copy has to happen here
        // anyway: the subscriber counts and the coordinate must describe the same instant, or the
        // row states one epoch's mark beside another's watchers.
        //
        // `perf.snapshot` carries no mtime: it is a question about this process rather than about
        // the file it is reading, and `session.health` is where the file fact belongs.
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

    /// How long this process has been up, in milliseconds — the one clock a performance answer is
    /// allowed to read.
    ///
    /// Process-relative and not a wall clock: it survives an attach, which the epoch does not, and
    /// carries nothing about when or where a person plays, which is why `views::Timeline` stamps
    /// its moments with it. It takes no lock — the start instant is set once at construction and
    /// never written again, and the ingest thread calls this on the serve beat.
    #[must_use]
    pub fn uptime_ms(&self) -> u64 {
        u64::try_from(self.inner.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Answer `perf.budgets` — every budget this build enforces, judged against this generation.
    ///
    /// Same door, deadline and ask as [`World::perf_snapshot`]: the ingest answers one `PerfAsk`
    /// carrying the cost, the serve rows and the ring, and the three perf ops are three readings of
    /// it. A second door would be a second `try_recv` on this thread's hottest boundary.
    ///
    /// The world's half is one field, so there is no critical section here. A budget verdict is a
    /// fact about the generation the measurements came from, so the epoch is carried and a reader
    /// comparing two answers across an attach can see they are not comparable.
    ///
    /// The arithmetic and the prose are `budgets`'s: this method pulls three readings out of the
    /// answer and hands them over.
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
                // The worst across every source, and the generation's worst rather than any
                // window's: a wedge detector that forgot the frame that wedged would clear itself.
                // `filter_map` drops the sources whose frames were all owed resets — absent, never
                // zero, the rule the whole meter keeps.
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
    /// Same door and same ask as [`World::perf_budgets`]. The ring arrives already bounded and
    /// ordered oldest-first (`views::Timeline`), so this method maps five fields and states the
    /// horizon: `capacity` and `cadenceMs` ride the answer because a client inferring the horizon
    /// from the length would infer it wrongly for the first five minutes of every generation.
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
    /// The same door and deadline `module.snapshot` uses, and it is not a registry op: the combat
    /// engine is the post-registry subscriber (`WIRING_ORDER` does not name it), so it is reached
    /// by its own arm rather than by a module id. See [`ask_fold`] for the wait, and
    /// `crate::foldsink` for which clock the answer is stamped with.
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
    /// User-initiated, and it travels the same door anyway. A search is heavier than a snapshot —
    /// it summarizes every finalized fight of the session before ranking one — and it is still
    /// answered at a boundary the ingest already reaches rather than under a lock, because the
    /// alternative lets a person typing into a box stall the fold between keystrokes.
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

    /// Answer `resist.levels` — how old these creatures are, as the resist fold knows it.
    ///
    /// The same door and deadline, and like `combat.snapshot` not a registry op: the resist
    /// module's published state is two integers, and this fact is in neither of them.
    ///
    /// There is no `NotFound` arm. A creature nobody has conned and the committed catalog has never
    /// heard of is not a request naming something that does not exist — it is a good question whose
    /// honest answer is that nothing states a level, so the name is simply missing from the list.
    /// The only refusal here is the one every reader on this door shares: there is nobody to ask.
    pub fn resist_levels(
        &self,
        names: &[String],
    ) -> Result<Vec<(String, fold::modules::resist::world::MobLevelFact)>, String> {
        let names = names.to_vec();
        self.ask_fold(|answer| ingest::Ask::MobLevels(ingest::MobLevelAsk { names, answer }))
    }

    /// The client's spell table for the install this world is attached to. `None` when nothing has
    /// been attached, which is the only state in which there is no install to speak of.
    ///
    /// It does not go through the ingest door, unlike every other reader on this type. The table is
    /// not fold state — the resist fold never reads it, which is what lets a ledger be replayed and
    /// re-estimated without one — so there is nothing to ask the ingest thread about, and reading a
    /// file on the thread that tails the log would be a stall for nothing.
    ///
    /// The handle leaves the lock and the parse happens outside it, which is why this returns an
    /// `Arc` rather than an answer: `ClientSpells::table` blocks its caller for a few hundred
    /// milliseconds on the first ask, and doing that under this mutex would stall every other
    /// connection and deadlock against the ingest's own `report_*` calls.
    #[must_use]
    pub fn client_spells(&self) -> Option<Arc<crate::spells::ClientSpells>> {
        self.lock().client_spells.clone()
    }

    /// Post one ask through the one door and wait for it — the shape `module_snapshot` and
    /// `perf_snapshot` each spell out by hand.
    ///
    /// The lock is taken and released before anything blocks, which is why this is a method and not
    /// a closure at the call site: the ingest thread takes this lock in every `report_*` it makes,
    /// so waiting under it would deadlock against the thread being waited for. `Err` is the three
    /// ways there is nobody to answer — nothing attached, an ingest that ended between the copy and
    /// the send, and a fold that did not answer inside [`SNAPSHOT_PATIENCE`] — each stated
    /// differently because they read differently in a bug report.
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
    /// answers. The lock is not held here — see the caller.
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

    /// Take one family of app knowledge — `alerts.define` and its four siblings.
    ///
    /// The order is the design: the world records the push first, under the lock, then hands it to
    /// the running fold with the lock released and waits. Recording first is what makes the
    /// before-attach case need no special path — a define pushed at a world with no ingest is one
    /// nobody has asked for yet, and the next attach applies it at construction
    /// ([`World::held_defines`]). The lock is not held across the wait, or this deadlocks against
    /// the ingest's own `report_*` calls.
    ///
    /// The wait is what the ack is for: `applied: true` says the live fold has this set, not that a
    /// queue accepted it. Bounded by [`SNAPSHOT_PATIENCE`]; the world's record is already written
    /// by then, so a timeout costs the current generation's copy and nothing more.
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

    /// Everything the app has told this process, for an attach to apply at construction.
    ///
    /// A copy, taken under the lock and handed over: the ingest thread must not hold a borrow into
    /// world state, and the payloads are a handful of small objects. Ordered by family, so two
    /// attaches of the same world apply them in the same order — not observable today, since the
    /// five families touch five different modules, and pinning it costs nothing.
    #[must_use]
    pub fn held_defines(&self) -> Vec<(String, serde_json::Value)> {
        self.lock()
            .defines
            .iter()
            .map(|(family, payload)| (family.clone(), payload.clone()))
            .collect()
    }

    /// Where the character logs live, as the app just said.
    ///
    /// An idempotent full-set replace of one value: the latest push is the whole of what the app
    /// has said, the same command law the five defines are under.
    ///
    /// Nothing is handed to a fold, which is the whole difference from [`World::define`]. A define
    /// changes what folding a log produces and therefore has to reach the running ingest and be
    /// re-applied at the next attach's construction; a directory changes nothing about any fold, so
    /// the write ends here — and this call therefore cannot block on the ingest thread.
    pub fn set_log_dir(&self, dir: &str) {
        self.lock().log_dir.set(dir);
    }

    /// The character logs in the directory the app named, or `Err` when it has named none.
    ///
    /// The scan happens with the lock released, as [`World::module_snapshot`]'s wait does: it is a
    /// readdir plus one stat per file, fast on a warm directory and unbounded on a disconnected
    /// network share, and this mutex is taken by the ingest thread in every `report_*` it makes.
    ///
    /// The path is copied out and echoed back by the caller, so the answer names the directory it
    /// is about — see `LogsListResult`, where that echo is the client's own staleness test.
    ///
    /// It needs no fold and no attach: a fresh install has characters to choose between before
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

    /// The ingest offers to take writes: install this turn's push channel.
    ///
    /// A `report_*` method like every other statement an ingest makes, with ownership re-asked
    /// inside the lock: a turn that has already lost must not be able to install a door onto a fold
    /// nobody wants.
    pub fn serve_writes(&self, generation: u64, push: Sender<ingest::Write>) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        state.write_to = Some(push);
        true
    }

    /// An alert fired — announce it to every connection.
    ///
    /// A `report_*` like every other statement an ingest makes: ownership is re-asked inside the
    /// lock, so a preempted fold that matched a line on its way out announces nothing.
    /// Connection-wide, like the epoch, because a fire belongs to the world rather than to any
    /// subscription and every window on this app plays the same sound.
    ///
    /// It changes no world state, which is what makes it unlike every other `report_*` here and why
    /// it takes the fire by reference: a fire is a thing that happened, and the engine keeps no
    /// ledger of them (the fold's own module does, as its published `history`). Nothing to
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
            // What it says, carried verbatim. Nothing is decided here and nothing is defaulted: an
            // absent field is the fold's statement that this firing has nothing true to say there,
            // and null-filling it would turn "no spell in this family" into a value the app would
            // have to learn to disbelieve.
            captures: fire.captures.clone().map(FireCaptures),
            spell: fire.spell.clone(),
            due_at: fire.due_at,
        });
        broadcast(&mut state, &frame);
        true
    }

    /// A live `/con` produced a card — announce it to every connection.
    ///
    /// A `report_*` like [`World::report_fire`] in every respect, including the two that make it
    /// unusual: ownership is re-asked inside the lock, so a preempted fold that parsed a con line
    /// on its way out draws nothing; and it changes no world state, because a card is a thing that
    /// happened rather than a thing to reconcile. Connection-wide, no `id`, no `epoch` — there is
    /// nothing to drop and nothing to re-request.
    pub fn report_con_card(&self, generation: u64, card: &ConCardMessage) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        broadcast(&mut state, &EngineMessage::ConCardMessage(card.clone()));
        true
    }

    /// Modules moved — announce the dirty bits.
    ///
    /// One frame per module, and the caller has already decided which: the ingest holds the last
    /// cursor it announced per module and hands over only the ones that moved (see
    /// `ingest::Serving::changed_modules`), so the coalescing happens where the beat is.
    ///
    /// They go out under one lock, in the order given, so a connection cannot observe module B's
    /// new cursor before module A's when the same fold moved both.
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

    /// Take a session mark, or refuse it — `sessionMarks.add`.
    ///
    /// The mark is stored nowhere, and that absence is the feature: a relaunch replays the log into
    /// the records the log alone describes. The other half of that is the refusal — a mark cannot
    /// enter a replaying fold, so a replay cannot diverge from a live run.
    ///
    /// Refused unless the world is live, the engine-side spelling of `combat/engine.ts
    /// sessionMark`'s `if (st.hydrating) return false`. The two gates are one boundary because
    /// `foldsink::tick` calls `CombatEngine::set_live()` on a beat that happens before
    /// `report_fold_landed` publishes `status: "live"`. Both are kept: the status gate is what the
    /// client is told, the engine's is what owns the model.
    ///
    /// The status and the door are read together in one critical section and the wait happens
    /// outside it, or this deadlocks against the ingest's own `report_*` calls. The wait is what
    /// makes the ack usable: without it a client could ask `combat.snapshot` the instant its ack
    /// arrived and be answered by a fold that had not yet reached the mark's boundary.
    ///
    /// It returns the status it decided under, read in that same section: a client asking
    /// `session.health` afterwards would be racing a fold that may have gone live in between.
    pub fn session_mark(&self, at: i64) -> (bool, HealthResultStatus) {
        let (status, push) = {
            let state = self.lock();
            (state.status, state.write_to.clone())
        };
        if !matches!(status, HealthResultStatus::Live) {
            return (false, status);
        }
        // A live world with no door is a world being replaced between the two reads above: the
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
        // The fold's own answer is the answer. A timeout answers `false`, the honest reading of
        // what this process knows: the mark may still be applied at the next boundary, and a client
        // told `true` by a wait that never returned would have been told something nobody observed.
        let took = wait.recv_timeout(SNAPSHOT_PATIENCE).unwrap_or(false);
        (took, status)
    }

    /// Confirm a sighting — `respawn.confirmSighting`, the last of the app's commands.
    ///
    /// It holds nothing and stores nothing, unlike [`World::define`]: a define is a preference that
    /// outlives any one fold, while a confirmation is a judgement about one spawn of one mob in one
    /// session, which `src/main/ipc/respawn.ts` does not persist either. So a confirm pushed at a
    /// world with no ingest is about a row that does not exist, and `false` is the honest answer.
    ///
    /// There is no status gate, unlike [`World::session_mark`]: `respawnModule.confirmSighting`'s
    /// two refusals are both about the row rather than the world, and nothing persists a
    /// confirmation, so a re-fold of this log never sees one. Mirroring the app-side seam is the
    /// bar, and a gate the app does not have would be this process disagreeing with it.
    ///
    /// The wait is [`World::define`]'s: the answer says the live fold has moved that clock, so a
    /// client can push and then reason about the world it made. A timeout answers `false`.
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

    /// The process's corpus, for the ops that read it directly — `knowledge.item`,
    /// `knowledge.spell` and `knowledge.search` name nothing a fold owns, so they are answered
    /// without one.
    #[must_use]
    pub fn knowledge(&self) -> &Arc<knowledge::Corpus> {
        &self.inner.knowledge
    }

    /// Answer `knowledge.mob` — the join the two owners have to make together.
    ///
    /// The corpus resolves the identity, the fold answers for the loot, and the corpus joins. The
    /// order is the design: the roster's statement that two spellings are one creature is committed
    /// data, so the keys are known before anything is asked of the fold, and what crosses the
    /// thread boundary is a handful of rows rather than a handle on somebody's state.
    ///
    /// An engine with no fold still answers, with the empty loot history a creature nothing has
    /// been looted from gets. A mob card before the first attach is a real card: the drop table,
    /// the quest cross-ref and the era evidence are committed data.
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

    /// Announce every name this process could not answer — the `knowledgeMiss` frames.
    ///
    /// Connection-wide, like the epoch and the fire, because the fetch is the app's and one app
    /// makes it once however many windows are open.
    ///
    /// Not generation-gated, which is the difference from every other broadcast in this file. A
    /// `report_*` re-asks ownership because it states something about this generation's world; a
    /// miss states something about the process's corpus, equally true whichever fold noticed it and
    /// equally true after the next attach. Dropping one because the fold that found it lost the
    /// world would mean the name is never fetched at all: the corpus records it as announced and
    /// never offers it again.
    pub fn announce_knowledge_misses(&self, misses: &[fold::knowledge::Miss]) {
        if misses.is_empty() {
            return;
        }
        let mut state = self.lock();
        for miss in misses {
            let Ok(domain) = KnowledgePushDomain::try_from(miss.domain.as_str()) else {
                // A domain the wire has no arm for cannot be announced, and silence is honester
                // than a frame nobody can read. The corpus only records the two it can be pushed
                // answers for (`knowledge::FETCHABLE_DOMAINS`), so this is unreachable by
                // construction — stated rather than `unwrap`ped, because an engine that panicked on
                // a diagnostic would be worse than one that says nothing.
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

    /// What the fold has consumed: the log, the mark, and what was counted reaching it. The
    /// engine's own door onto the addressable coordinate.
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

    /// Answer `session.attach` — begin folding one log, preempting anything already folding.
    ///
    /// Inside the lock: the epoch bumps, the generation bumps (which strips the in-flight ingest of
    /// its ownership before this call returns), the world is emptied of the previous fold's
    /// coordinates, the status becomes `starting`, and the bump is announced to every connection.
    /// Outside it: the ingest thread starts, because a thread spawn is a syscall and the epoch's
    /// critical section must stay the length of a few queue pushes.
    ///
    /// `accepted` is always true: the only way to lose is to be superseded, and nothing can
    /// supersede an acceptance that completes inside the lock. The turn that loses is the older
    /// ingest, and it reports nothing to anybody.
    ///
    /// No `progress` rides the announcement: at the bump the fold has not opened the file, so a
    /// percentage would be inventing a measurement.
    ///
    /// `state_dir` is the app's `userData`; `None` is the file-free attach a client that said
    /// nothing gets. It is a parameter rather than a second method, even though almost every caller
    /// here passes `None`, because a convenience wrapper would let a future call site attach
    /// without considering the question.
    pub fn attach(&self, log_path: &str, state_dir: Option<&str>) -> AttachResult {
        let log = PathBuf::from(log_path);
        let state_dir = state_dir.map(PathBuf::from);
        let generation;
        let epoch;
        {
            let mut state = self.lock();
            state.epoch += 1;
            epoch = Epoch(state.epoch);
            // Bumped under the lock, so the atomic and the epoch can never disagree about which
            // turn owns the world.
            generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
            state.status = HealthResultStatus::Starting;
            state.fold = Fold {
                log: Some(log.clone()),
                ..Fold::default()
            };
            // The old fold stops being askable at the bump, in the same critical section that
            // strips it of its ownership — not when it notices, not when its thread ends. A reader
            // must never be answered by a generation the world has already replaced.
            state.asks = None;
            // …and neither is it writable. `defines` itself is untouched: that is the app's
            // knowledge, not this generation's, and the fold about to be built re-applies it at
            // construction. A session mark has no such second life — it is stored nowhere, so a
            // mark posted at a fold being replaced is a mark that did not happen.
            state.write_to = None;
            // The install is named by the log, so the client table is re-derived here and nowhere
            // else: `<eqRoot>/Logs/<log>` up two, plus `spells_us.txt` — a path join and an empty
            // cell, so this costs an attach nothing and the 38 MB read waits for somebody to ask
            // (`crate::spells`).
            //
            // Replaced rather than kept, even when the path is the same. A character switch onto a
            // second EverQuest folder must not answer out of the first folder's table, and deciding
            // that by comparing paths would be a cache with an invalidation rule. A re-attach onto
            // the same install pays one lazy re-read, once, if anybody asks.
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

    /// The ingest offers to answer questions: install this turn's ask channel.
    ///
    /// A `report_*` method like every other statement an ingest makes, with ownership re-asked
    /// inside the lock. Called once per attach, before the first byte is folded, so
    /// `module.snapshot` and `perf.snapshot` during the historical scan are answerable rather than
    /// merely eventually answerable.
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
                // Both coordinates, not a rounded one. `offset` is the mark itself — the same
                // coordinate `HealthMark.offset` reports — and `logSize` is what `pct` was divided
                // by. Saturating rather than wrapping: a silent wrap would draw a negative progress
                // bar where a saturate draws a stuck one.
                offset: i64::try_from(mark.checkpoint).unwrap_or(i64::MAX),
                log_size: i64::try_from(mark.total).unwrap_or(i64::MAX),
                // Present only when true, the `song`/`rare` idiom this wire already uses: a scan
                // frame says nothing rather than saying false, so a historical fold's frames are
                // byte-identical to what they were before this field existed.
                live: if mark.live { Some(true) } else { None },
            }),
        });
        broadcast(&mut state, &frame);
        true
    }

    /// The fold landed: the historical scan is complete and the tail has the file.
    ///
    /// Every open subscription is reset, on every connection, stamped with this generation — rule 1
    /// of the diff protocol at the one moment the whole window changed at once. A reset is sent
    /// even when the window is empty: a client that special-cased "no reset because there was
    /// nothing" could not tell an empty view from a view that never re-opened.
    ///
    /// Exactly one per winning attach. A preempted ingest never reaches here, and one that does can
    /// only pass through once — the tail loop that follows has no way back.
    ///
    /// The sources are built before the lock is taken, for the reason [`World::serve_views`] gives;
    /// the stamp, the status and the send happen in one critical section, so a reset can only ever
    /// name the generation that landed.
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

    /// There is no fold any more — the ingest could not start, could not read, or panicked.
    ///
    /// `idle` is the same word a never-attached process uses, and that is the honest one: it says
    /// nothing is being folded. The epoch is untouched, deliberately — a fold that died created no
    /// new generation, and a client told about generation N is still looking at generation N's
    /// (empty) world rather than at a world it has never heard of.
    pub fn report_idle(&self, generation: u64) -> bool {
        let mut state = self.lock();
        if !self.owns(generation) {
            return false;
        }
        state.status = HealthResultStatus::Idle;
        // And nothing is askable any more. The ingest's receiver is about to be dropped with its
        // thread; clearing the sender here makes the world say "no fold" rather than making every
        // reader discover it one failed send at a time.
        state.asks = None;
        state.write_to = None;
        true
    }

    /// Take the lock, surviving a poisoned one.
    ///
    /// A poisoned mutex must not end the engine. Poisoning means some thread panicked while holding
    /// this lock; the state it guards is an integer, a list of channel senders and a byte offset,
    /// none of which a panic can leave torn. Propagating the panic would turn one bad connection —
    /// or one bad fold — into a dead engine for every other renderer.
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

// The `perf.snapshot` folds. Free functions, and none of them touches the lock: `perf_snapshot`
// reads the world once and does its arithmetic outside the critical section, so no connection waits
// on a diagnostic being formatted.

/// The two status enums are generated from two schema definitions with the same five members, so
/// the mapping is exhaustive by the compiler: a member added to one and not the other stops this
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

/// How many subscriptions are open over each source right now, across every connection.
///
/// A live count, not a cumulative one, and the world's own answer rather than the meter's — the
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

/// The union of what has served and what is being watched, ordered by source name.
///
/// Two different reasons put a source in the list. It has served frames — a cost, which belongs
/// whether or not anybody is still subscribed, because the generation's bill does not disappear
/// when a window closes. Or somebody is subscribed to it right now and it has served nothing yet,
/// which is a subscription waiting for its first frame: omitting it would make "opened and nothing
/// came" indistinguishable from "never opened".
///
/// A source in neither set is absent — no rows of zeros for a source this session has never had
/// anything to do with.
/// One ring entry on the wire — five field assignments and no arithmetic. The ring did the
/// subtraction that makes each figure an interval, where the counters live; this is the mapping
/// onto the generated type, which is the one thing `views/` may not know about.
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

/// A source somebody is subscribed to that has served nothing yet. Every counter is a real zero —
/// no frame has been sent — and the two latencies are absent, because nothing was timed.
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
/// A send that fails is a connection that ended, not an error: the writer thread drops its receiver
/// when the socket closes, and the world notices here rather than by being told. `leave` remains
/// the tidy path; this is the fallback for every other way a connection can die.
fn broadcast(state: &mut State, message: &EngineMessage) {
    state
        .listeners
        .retain(|listener| listener.outbox.send(message.clone()).is_ok());
}

/// Serve every subscription over a prepared source — the whole of reset-then-diffs, in one place.
///
/// It runs under the world's lock, which is what stamps every frame it sends with the epoch that
/// was current when it was cut. `reset_all` is a landing fold: every window is a new world's and
/// there is nothing to diff against.
///
/// A subscription whose source was not prepared is skipped, silently and correctly: the pass
/// decided nothing about that source had moved.
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
                // A frame that says nothing is not sent. `total` moving on its own is still
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
                        // Present only when it moved — the schema says so, and fixture 03 is a
                        // meter tick with no `total` for exactly this reason.
                        total: (total != sub.total).then_some(total),
                        ops,
                    }),
                ))
            };
            if let Some((kind, row_count, ops, message)) = message {
                // The bytes are the frame's own: measured from the message about to go out rather
                // than estimated from the rows, because an estimated payload budget is a payload
                // budget nobody is keeping (see `views::meter`).
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

    /// A validated view over a registered source. These tests are about the epoch, the generation
    /// and the subscription bookkeeping; the view is the smallest real one there is, and
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

    /// A path standing in for a log. Nothing in this module opens it: these tests drive the world
    /// with the ingest replaced by a no-op, so the epoch, subscription and generation laws are
    /// proven with no thread, no file and no timing in the room. The ingest's own behaviour is
    /// proven against real bytes in `ingest.rs`'s tests and over a socket in `tests/ingest.rs`.
    const A_LOG: &str = "C:/nowhere/eqlog_Nobody_freeport.txt";

    /// A world whose attaches start nothing.
    fn world() -> World {
        World::with_ingest(Arc::new(|_world, _generation, _log, _state_dir| {}))
    }

    /// The generation the current turn holds. A real ingest is handed its own number by `attach`
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
            // Every mark these tests make stands in for a scan — the loop a landing fold ends in.
            // The tail's own stamp is proven where there is a real tail: `tests/ingest.rs`.
            live: false,
        }
    }

    #[test]
    fn a_scan_frame_carries_no_live_flag_and_a_tail_frame_carries_it() {
        // `report_progress` is the one place a `FoldMark` becomes a wire frame, so it is the one
        // place the two loops can be told apart downstream. Both arms are read off the same call,
        // to make the asymmetry structural rather than a claim about two different code paths.
        let world = world();
        let membership = world.join();
        let turn = generation(&world);

        assert!(world.report_progress(turn, mark(10, 12.5)));
        assert!(world.report_progress(
            turn,
            FoldMark {
                live: true,
                ..mark(11, 100.0)
            }
        ));

        let mut flags = Vec::new();
        for _ in 0..2 {
            let EngineMessage::EpochMessage(epoch) = membership.inbox.recv().expect("a frame")
            else {
                panic!("a progress announcement is an epoch message");
            };
            flags.push(
                epoch
                    .progress
                    .expect("a progress frame carries progress")
                    .live,
            );
        }
        assert_eq!(
            flags,
            vec![None, Some(true)],
            "absent for the scan, `true` for the tail - never `false`, which would put a field \
             with no reader on every frame of every historical fold"
        );
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
            // The two coordinates a loading bar needs, and they are the mark's own rather than
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
