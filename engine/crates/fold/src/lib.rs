//! The module fold: the `EqModule` contract, a registry that preserves wiring order, and one
//! ported module per file under `modules/`.
//!
//! Parity with the TypeScript is deep equality, not byte identity — array order, numbers and which
//! keys exist are claims; key order is not, and a field the TS wrote as `undefined` must be absent
//! rather than `null`.
//!
//! Delivery is dispatch, observe, drain: a primary event reaches every listener in registration
//! order, and anything a listener derived is queued and drained afterwards through the same loop.
//!
//! No module reads a wall clock; it is handed one through [`Fold::tick`], which only the live tail
//! calls. Every other time-based rule advances off log timestamps, so a fold of the same bytes
//! stays a pure function of those bytes. All state lives behind the registry — no statics, no
//! caches keyed by anything but a fold's own inputs, nothing outliving a `Fold`.

/// The announce cursor — the number that decides whether a renderer re-fetches. Read it before
/// touching any module's [`EqModule::published_seq`].
pub mod announce;
pub mod combat;
/// The client's string table (`dbstr_us.txt`), parsed down to its spell-category namespace — the
/// words behind the integer ids `spells_us.txt` stores. Pure over a string; the file belongs to
/// `engined::spells`, which owns the install directory both sit in.
pub mod dbstr;
pub mod epoch;
pub mod event;
pub mod jsfn;
pub mod jsmap;
pub mod knowledge;
pub mod message_overlay;
pub mod modules;
pub mod overlay_file;
pub mod session;
pub mod spell_facts;
/// The client's spell table (`spells_us.txt`), parsed. Pure over a string; the file and the
/// directory belong to `engined::spells`. Nothing in the fold reads it — a fold that never needs
/// the client table can be replayed, shipped and re-estimated without one.
pub mod spells_us;

use event::Event;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

/// The extension contract — `src/main/modules/types.ts EqModule`.
pub trait EqModule {
    /// Stable id, matching the TS module's `id` exactly (it is the golden's join key).
    fn id(&self) -> &'static str;

    /// Called on character (re)load, before the historical replay begins.
    fn reset(&mut self);

    /// Fold one event. `live` gates nothing here — the registry gates the push.
    fn on_event(&mut self, ev: &Event, live: bool);

    /// Optional wall-clock heartbeat, ~1x/sec on the live tail only. A historical fold never calls
    /// it, which is what keeps a replay decided entirely by the bytes.
    ///
    /// A tick's derived events are collected and queued, not delivered — anything a heartbeat
    /// synthesizes reaches the other modules with the next primary event, as `bus.emitDerived`
    /// does. No module emits on a tick today; the door is taken anyway so the first one that does
    /// is not silently dropped.
    ///
    /// `timer_rows` is a parameter rather than a handle because a module cannot hold a mutable
    /// handle on two modules the registry is iterating. [`Registry::tick`] builds the projection
    /// once, before the loop, which is also the instant the TS's lazy pull would have read at:
    /// alerts is registered before buffs and buffTimers, so the hygiene sweep has not run yet.
    fn on_tick(&mut self, _now_ms: i64, _timer_rows: &[modules::buff_timer_rows::BuffTimerRow]) {}

    /// Would this module read the timer projection on the next beat?
    ///
    /// The rows are a parameter here, so something has to decide whether to build them; the
    /// condition is the TS's own — at most once per heartbeat and only while an early warning is
    /// armed. One bool per module per second against a fold of a whole `buffs.active` and CC
    /// ledger, and an ordinary session builds no projection at all.
    fn wants_timer_rows(&self) -> bool {
        false
    }

    /// Full current state for hydration, plus the last seq folded in: `{ "seq": n, "state": … }`.
    fn snapshot(&self) -> Value;

    /// Everything since the last flush, or `None`. Nothing calls it yet and no module overrides it;
    /// it is here so the contract does not have to change later.
    fn flush_delta(&mut self) -> Option<Value> {
        None
    }

    /// The derived events this module synthesized while folding the event it was just handed, in
    /// emission order.
    ///
    /// A hand-back rather than a callback, because a module cannot hold a mutable reference to the
    /// queue the registry is iterating. The observable order is identical: within one module,
    /// emission order; across modules, registration order; the whole batch delivered after the
    /// primary event reached every module.
    ///
    /// One producer (`buffs`, `buffExpired`). Defaulted empty for the rest.
    fn take_derived(&mut self) -> Vec<Event<'static>> {
        Vec::new()
    }

    /// The group-roster pull seam.
    ///
    /// The combat engine does not fold the roster, it asks the module for it, during the same
    /// delivery and after the module has advanced for that line — which holds for free here,
    /// because the registry has already dispatched before `Fold` reaches the engine.
    ///
    /// A defaulted method rather than a downcast: the one module that can answer implements one
    /// method and every other says nothing. `None` reads as an empty roster.
    fn as_roster(&self) -> Option<&dyn combat::RosterSource> {
        None
    }

    /// The loot-ledger pull seam. `as_roster`'s shape and reason.
    ///
    /// A view does not read `snapshot()` instead because that builds a fresh JSON tree of every
    /// row: a subscription over a fifty-row window would pay for the whole log's loot each time it
    /// was serviced. The seam hands over the rows already in memory.
    fn as_loot(&self) -> Option<&modules::loot::LootModule> {
        None
    }

    // The remaining view pull seams, all `as_loot`'s shape: a module is known by what it can
    // answer, so "this module cannot answer that" stays a compile-time fact rather than a runtime
    // `None` behind an `as_any` downcast.

    /// The live buff instances — `buffs.active`, half of the timer-row projection.
    fn as_buffs(&self) -> Option<&modules::buffs::BuffsModule> {
        None
    }

    /// The crowd-control holds and ends — `buffTimers`, the other half.
    fn as_buff_timers(&self) -> Option<&modules::buff_timers::BuffTimersModule> {
        None
    }

    /// The respawn watch rows.
    fn as_respawn(&self) -> Option<&modules::respawn::RespawnModule> {
        None
    }

    /// The respawn write seam — a separate method rather than a `&mut` on `as_respawn`.
    ///
    /// The pull seams serve views and may only read; `confirmSighting` moves a clock. Widening the
    /// read seam would let a view mutate the world it is drawing, with only a comment saying not
    /// to.
    fn as_respawn_mut(&mut self) -> Option<&mut modules::respawn::RespawnModule> {
        None
    }

    // The persisted-knowledge seams. `resist` owns `resist-ledger.json` and `buffs` owns the mined
    // half of `message-overlay.json`; both are read at attach and written on a cadence, so each
    // needs a `&mut` seam for the seed and a `&` seam for the write — a reader may not mutate the
    // world it is serializing. Nothing in this crate calls them: `registered()` cannot reach a
    // directory, so the world the goldens were recorded in is what every test still builds.

    /// The resist ledger, to be seeded from the app's persisted file.
    fn as_resist_mut(&mut self) -> Option<&mut modules::resist::ResistModule> {
        None
    }

    /// The resist ledger, to be written.
    fn as_resist(&self) -> Option<&modules::resist::ResistModule> {
        None
    }

    /// The buffs module, to be seeded with the persisted message-overlay register — and, in the
    /// same act, to be told which source key this fold's own observations are filed under.
    fn as_buffs_mut(&mut self) -> Option<&mut modules::buffs::BuffsModule> {
        None
    }

    /// The progression columns and the recent-kill ring.
    fn as_progression(&self) -> Option<&modules::progression::ProgressionModule> {
        None
    }

    /// The event feed's ring.
    fn as_event_feed(&self) -> Option<&modules::event_feed::EventFeedModule> {
        None
    }

    /// The module's published cursor, without building its state — the module dirty bit. It moves
    /// only when the published state changed; anything else makes it a log-line counter that
    /// defeats the serve loop's coalescing. It must also stay cheap: the serve loop asks every
    /// module once per beat, and asking through `snapshot()` would serialize twenty modules' state
    /// to compare twenty integers.
    ///
    /// Two shapes answer it. Four modules publish a private revision counter as both this and their
    /// snapshot's `seq`. The rest cannot touch their snapshot's `seq` — the goldens pin it — so
    /// they carry an [`crate::announce::Announce`] beside it: a cursor in the same number space,
    /// bumped only from the arms that mutate published state.
    ///
    /// `None` means this module does not announce, so a module that gains state without gaining
    /// this method goes quiet rather than claiming to be unchanged.
    fn published_seq(&self) -> Option<i64> {
        None
    }

    /// The live `/con`s this module saw while folding the event it was just handed.
    ///
    /// A hand-back rather than a callback, like [`EqModule::take_fires`]. One producer
    /// (`consider`), and structurally empty for every historical fold — a con card is live-only.
    fn take_cons(&mut self) -> Vec<modules::consider::ConEvent> {
        Vec::new()
    }

    /// The app-knowledge seam — the one door a `*.define` command reaches a module through.
    ///
    /// `as_roster`'s shape, with mutability, which is the whole of what a define is: the app
    /// telling the fold something the log cannot. Five families, one per module (see
    /// [`Defines::family`]); the mapping is total and static, so `Registry::define` is a lookup.
    fn as_defines(&mut self) -> Option<&mut dyn Defines> {
        None
    }

    /// The alert fires this module produced while folding the live event it was just handed, in
    /// emission order.
    ///
    /// A hand-back like [`EqModule::take_derived`], but these do not re-enter the bus — a fire
    /// leaves the process — so the ingest drains them at its own boundary rather than
    /// `Fold::on_primary`.
    ///
    /// One producer (`alerts`), and structurally empty for every historical fold: firing is
    /// live-only.
    fn take_fires(&mut self) -> Vec<modules::alerts_rules::Fire> {
        Vec::new()
    }

    /// The own-loot pull seam — what you have looted, off every corpse. Read side only: the fold is
    /// the one writer, and the index's lifetime has exactly one owner (`consider`).
    fn as_own_loot(&self) -> Option<&dyn knowledge::OwnLoot> {
        None
    }

    /// Install the knowledge lookups, after construction rather than through [`ClusterDeps`].
    ///
    /// A seam and not a construction parameter: `ClusterDeps` is spelled as a struct literal by the
    /// parity runner, so a field added there would have to be answered there, and the only answer
    /// the oracle may give is "absent". Exactly one caller installs it,
    /// `engined::foldsink::registry_for`.
    fn install_knowledge(&mut self, _k: &Arc<dyn knowledge::Knowledge>) {}
}

/// What a module does with app knowledge. One method, one law.
///
/// A define is an idempotent full-set replace — not a delta, not a merge: pushing A then B leaves
/// exactly what pushing B alone would. So a crash-respawn is a replay of the latest push, arrival
/// order cannot matter, and the input is hash-friendly.
///
/// The payload is a `Value` because these shapes are the store's contract rather than the
/// protocol's: the module reads what it needs out of the JSON, instead of a typed mirror in the
/// protocol crate that would have to be kept in step with a settings file.
pub trait Defines {
    /// The family this module answers to: `alerts`, `buffTrust`, `respawn`, `combo`, `roster` —
    /// the `*.define` op's own prefix, so the wire name and the module's claim on it are one string.
    fn family(&self) -> &'static str;

    /// Take the whole set. A payload this module cannot read leaves it exactly as it was, which is
    /// the honest outcome for app knowledge that arrived malformed: the previous set is still the
    /// last thing the user actually said.
    fn define(&mut self, payload: &Value);
}

/// Registration order is bus delivery order — `src/main/modules/wiring.ts` `ordered`, verbatim.
///
/// Spelled in full rather than as "the ones we have ported", so an unimplemented module is a fact
/// the code states. The parity harness reads `missing()` off it and names every absent module,
/// rather than comparing a subset and reporting green.
pub const WIRING_ORDER: &[&str] = &[
    "combo",
    "roster",
    "loot",
    "turnins",
    "classUnlocks",
    "kills",
    "respawn",
    "progression",
    "leveling",
    "character",
    "outputFiles",
    "spellSets",
    "itemTiers",
    "observedSpellRanks",
    "alerts",
    "buffs",
    "buffTimers",
    "consider",
    "resist",
    "eventFeed",
];

/// The registered modules, in delivery order, and the dispatch loop over them.
#[derive(Default)]
pub struct Registry {
    mods: Vec<Box<dyn EqModule>>,
}

impl Registry {
    pub fn new() -> Self {
        Registry { mods: Vec::new() }
    }

    /// Register in delivery order. It is the caller's job to follow `WIRING_ORDER`; `registered`
    /// is the caller that matters, and it is asserted.
    pub fn register(&mut self, m: Box<dyn EqModule>) {
        self.mods.push(m);
    }

    pub fn reset(&mut self) {
        for m in &mut self.mods {
            m.reset();
        }
    }

    /// Deliver one event to every module, in order, appending whatever any of them synthesized to
    /// the caller's derived queue. The queue is the caller's because it is the bus's: a module that
    /// emits during a drain appends to the queue being drained, which is the shift-until-empty
    /// semantics `LogBus.drain` has.
    pub fn dispatch(&mut self, ev: &Event, live: bool, derived: &mut Vec<Event<'static>>) {
        for m in &mut self.mods {
            m.on_event(ev, live);
            let mut out = m.take_derived();
            if !out.is_empty() {
                derived.append(&mut out);
            }
        }
    }

    /// [`Registry::dispatch`] with a stopwatch around each module; the sink receives
    /// `(module index, nanoseconds)` per delivery. `parity --stages` is the one caller. A second
    /// function rather than a flag on the first so the production dispatch never pays two clock
    /// reads per module per event — which means it has to change whenever `dispatch` does.
    pub fn dispatch_timed(
        &mut self,
        ev: &Event,
        live: bool,
        derived: &mut Vec<Event<'static>>,
        sink: &mut dyn FnMut(usize, u64),
    ) {
        for (i, m) in self.mods.iter_mut().enumerate() {
            let t = std::time::Instant::now();
            m.on_event(ev, live);
            let mut out = m.take_derived();
            if !out.is_empty() {
                derived.append(&mut out);
            }
            sink(i, u64::try_from(t.elapsed().as_nanos()).unwrap_or(u64::MAX));
        }
    }

    /// The wall-clock heartbeat, fanned over every module in wiring order.
    ///
    /// A tick advances the model and publishes nothing — no module implements `flush_delta`, so
    /// whoever asks for a snapshot next sees the aged state, which is what a pull-based server
    /// wants.
    ///
    /// Derived events are collected the way `dispatch` collects them, but left queued rather than
    /// drained here; see [`EqModule::on_tick`].
    ///
    /// Not gated on a replay flag: the historical fold is `fold_bytes`, which never calls this.
    pub fn tick(&mut self, now_ms: i64, derived: &mut Vec<Event<'static>>) {
        // Built once, before the loop — see [`EqModule::on_tick`] for why this instant is the one
        // the TS's lazy pull would have read at.
        let rows = self.timer_rows();
        for m in &mut self.mods {
            m.on_tick(now_ms, &rows);
            let mut out = m.take_derived();
            if !out.is_empty() {
                derived.append(&mut out);
            }
        }
    }

    /// The timer-row projection over whatever this build registered.
    ///
    /// Empty when either half is absent: a projection built from buffs alone would state ends for
    /// the beneficial half and know nothing about crowd control, so an early warning measured
    /// against it would be right about mez and wrong about slow.
    ///
    /// Empty when nobody asked, which is [`EqModule::wants_timer_rows`] — the laziness the TS's
    /// closure has for free.
    #[must_use]
    pub fn timer_rows(&self) -> Vec<modules::buff_timer_rows::BuffTimerRow> {
        if !self.mods.iter().any(|m| m.wants_timer_rows()) {
            return Vec::new();
        }
        let (Some(buffs), Some(timers)) = (self.buffs(), self.buff_timers()) else {
            return Vec::new();
        };
        modules::buff_timer_rows::build_timer_rows(
            &buffs.active_buffs(),
            &timers.holds(),
            timers.ends(),
        )
    }

    pub fn ids(&self) -> Vec<&'static str> {
        self.mods.iter().map(|m| m.id()).collect()
    }

    /// The registered module that answers the roster pull, or `None` when this build registered
    /// none. A linear scan over at most twenty modules, made once per delivery.
    pub fn roster(&self) -> Option<&dyn combat::RosterSource> {
        self.mods.iter().find_map(|m| m.as_roster())
    }

    /// The registered module that answers the loot-ledger pull — the same linear scan `roster` is,
    /// made once per view service rather than once per event.
    pub fn loot(&self) -> Option<&modules::loot::LootModule> {
        self.mods.iter().find_map(|m| m.as_loot())
    }

    /// The registered module that answers the buff pull. Same linear scan as `loot`.
    pub fn buffs(&self) -> Option<&modules::buffs::BuffsModule> {
        self.mods.iter().find_map(|m| m.as_buffs())
    }

    /// The registered module that answers the crowd-control pull.
    pub fn buff_timers(&self) -> Option<&modules::buff_timers::BuffTimersModule> {
        self.mods.iter().find_map(|m| m.as_buff_timers())
    }

    /// The registered module that answers the respawn pull.
    pub fn respawn(&self) -> Option<&modules::respawn::RespawnModule> {
        self.mods.iter().find_map(|m| m.as_respawn())
    }

    /// The same module, to be written to — see [`EqModule::as_respawn_mut`] for why the read and
    /// the write are two seams. `None` for a registry carrying no respawn module: a confirmation
    /// with nothing to confirm re-based no clock.
    pub fn respawn_mut(&mut self) -> Option<&mut modules::respawn::RespawnModule> {
        self.mods.iter_mut().find_map(|m| m.as_respawn_mut())
    }

    /// The registered module that owns the resist ledger, to be read.
    pub fn resist(&self) -> Option<&modules::resist::ResistModule> {
        self.mods.iter().find_map(|m| m.as_resist())
    }

    /// Seed the app's persisted knowledge, then name this fold's own source.
    ///
    /// One call, because the order decides correctness: every persisted bucket goes back first,
    /// then `key`'s bucket is discarded, because the log about to be folded restates that bucket's
    /// entire content. Reversed, this character is seeded with counts its own fold re-derives, and
    /// the totals double on every cold launch.
    ///
    /// A bucket for a character you are not folding survives untouched — nothing can re-derive it,
    /// and that asymmetry is what the per-source register is for.
    ///
    /// The one caller is `engined::foldsink`, and only when the attach carried a `stateDir`.
    pub fn seed_persisted(&mut self, key: &str, state: &PersistedState) {
        if let Some(resist) = self.mods.iter_mut().find_map(|m| m.as_resist_mut()) {
            resist.seed(&state.resist);
            resist.begin_source(key);
        }
        if let Some(buffs) = self.mods.iter_mut().find_map(|m| m.as_buffs_mut()) {
            for (source, counts) in &state.overlay {
                buffs.seed_overlay(source, counts);
            }
            buffs.begin_overlay_source(key);
        }
    }

    /// The registered module that answers the progression pull.
    pub fn progression(&self) -> Option<&modules::progression::ProgressionModule> {
        self.mods.iter().find_map(|m| m.as_progression())
    }

    /// The registered module that answers the event-feed pull.
    pub fn event_feed(&self) -> Option<&modules::event_feed::EventFeedModule> {
        self.mods.iter().find_map(|m| m.as_event_feed())
    }

    /// Every registered module's published cursor, in delivery order. See
    /// [`EqModule::published_seq`] for why it is not `snapshot()["seq"]`.
    ///
    /// A module answering `None` is absent from this list rather than present with a zero: the
    /// serve loop announces a change, and a module that states no cursor has said nothing that
    /// could have changed.
    pub fn published_seqs(&self) -> Vec<(&'static str, i64)> {
        self.mods
            .iter()
            .filter_map(|m| m.published_seq().map(|seq| (m.id(), seq)))
            .collect()
    }

    /// Every live `/con` any module saw since the last drain, in registration order. Empty for
    /// every historical fold — see [`EqModule::take_cons`].
    pub fn take_cons(&mut self) -> Vec<modules::consider::ConEvent> {
        let mut out = Vec::new();
        for m in &mut self.mods {
            out.append(&mut m.take_cons());
        }
        out
    }

    /// The registered module that owns the own-loot index (`consider`), or `None` when this build
    /// registered none. The same linear scan, made once per mob lookup.
    pub fn own_loot(&self) -> Option<&dyn knowledge::OwnLoot> {
        self.mods.iter().find_map(|m| m.as_own_loot())
    }

    /// Give every module that asks the knowledge lookups — see [`EqModule::install_knowledge`].
    ///
    /// The one caller is the production construction, `engined::foldsink::registry_for`, right
    /// after `registered()`. The parity runner, the bench arm and this crate's tests never call it,
    /// so goldens are still compared against the world they were recorded in.
    pub fn install_knowledge(&mut self, k: &Arc<dyn knowledge::Knowledge>) {
        for m in &mut self.mods {
            m.install_knowledge(k);
        }
    }

    /// One module's published snapshot, by the id it answers to — `{ "seq": …, "state": … }`, the
    /// pair the goldens join on.
    ///
    /// `None` for a name nothing registered, and that is the answer rather than an absence to paper
    /// over: an empty state would be a lie about a module that does not exist. A `WIRING_ORDER`
    /// name this build did not register answers `None` too.
    ///
    /// A linear scan over at most twenty entries, made once per request rather than once per event.
    pub fn snapshot_of(&self, id: &str) -> Option<Value> {
        self.mods
            .iter()
            .find(|m| m.id() == id)
            .map(|m| m.snapshot())
    }

    /// Push one family of app knowledge into the module that owns it.
    ///
    /// `false` for a family no registered module claims — `snapshot_of`'s rule. A linear scan over
    /// at most twenty entries, made a handful of times per session.
    pub fn define(&mut self, family: &str, payload: &Value) -> bool {
        for m in &mut self.mods {
            if let Some(d) = m.as_defines() {
                if d.family() == family {
                    d.define(payload);
                    return true;
                }
            }
        }
        false
    }

    /// Every alert fire any module produced since the last drain, in registration order. Empty for
    /// every historical fold — see [`EqModule::take_fires`].
    pub fn take_fires(&mut self) -> Vec<modules::alerts_rules::Fire> {
        let mut out = Vec::new();
        for m in &mut self.mods {
            out.append(&mut m.take_fires());
        }
        out
    }

    /// Every id `WIRING_ORDER` names that nothing registered — the harness's skipped list.
    pub fn missing(&self) -> Vec<&'static str> {
        let have: HashSet<&str> = self.ids().into_iter().collect();
        WIRING_ORDER
            .iter()
            .copied()
            .filter(|id| !have.contains(id))
            .collect()
    }

    /// `{ "modules": [ { "id": …, "snapshot": { "seq": …, "state": … } }, … ] }` — the same shape
    /// the golden's `modules` array carries, in delivery order, so the comparator joins on `id`
    /// and compares `snapshot` whole.
    pub fn snapshots(&self) -> Value {
        json!({
            "modules": self.mods.iter().map(|m| json!({
                "id": m.id(),
                "snapshot": m.snapshot(),
            })).collect::<Vec<_>>(),
            "skipped": self.missing(),
        })
    }
}

/// The registry plus the derived-event producers that sit beside it on the bus.
pub struct Fold {
    pub registry: Registry,
    /// The post-registry subscriber: the engine subscribes after the registry and before the
    /// detectors. That position is load-bearing in two directions — every module has folded the
    /// line before the engine sees it, which is what makes the roster pull answer for the same
    /// line, and the engine's work happens before any derived event the detectors synthesize.
    ///
    /// An `Option` field rather than a listener vector because the engine is also read back, so its
    /// snapshots can be taken. `None` behaves exactly as a fold without the field.
    pub combat: Option<combat::CombatEngine>,
    epoch: epoch::EpochDetector,
    /// The offline-gap detector, subscribed after the epoch detector and queued in that order.
    /// `progression` publishes each gap's instants, `roster` marks members stale across one, and
    /// `buffs` pauses every beneficial buff by the length of the absence — see `session.rs`.
    sessions: session::SessionDetector,
    /// The bus's derived queue. Three producers: the registry's own modules (`buffs`, via
    /// `buffExpired`), the epoch detector, and the offline-gap detector.
    derived: Vec<Event<'static>>,
    events: u64,
    last_ts: i64,
}

impl Fold {
    pub fn new(registry: Registry, launch_ms: i64) -> Self {
        let mut f = Fold {
            registry,
            combat: None,
            epoch: epoch::EpochDetector::new(launch_ms),
            sessions: session::SessionDetector::new(),
            derived: Vec::new(),
            events: 0,
            last_ts: 0,
        };
        f.reset();
        f
    }

    /// Subscribe the combat engine behind the registry (see the field). Builder-shaped so existing
    /// `Fold::new` call sites do not move.
    pub fn with_combat(mut self, engine: combat::CombatEngine) -> Self {
        // Resets only the engine it just installed. `Fold::new` has already reset the world, and a
        // second `registry.reset()` would put every module that publishes a revision counter as its
        // `seq` exactly one ahead of the golden.
        self.combat = Some(engine);
        if let Some(c) = &mut self.combat {
            c.reset();
        }
        self
    }

    pub fn reset(&mut self) {
        self.registry.reset();
        if let Some(c) = &mut self.combat {
            c.reset();
        }
        self.epoch.reset();
        self.sessions.reset();
        self.derived.clear();
        self.events = 0;
        self.last_ts = 0;
    }

    /// How many primary events were folded — `ScanResult.seq`.
    pub fn events(&self) -> u64 {
        self.events
    }

    /// The highest timestamp any event carried, which is the instant the combat snapshot is taken
    /// at. Accumulated with `max` rather than "the last one": the stream is not monotonic across a
    /// log rollover, and the snapshot's `now` must not travel backwards because one line did.
    pub fn last_ts(&self) -> i64 {
        self.last_ts
    }

    /// One primary event: deliver it, then drain whatever anybody queued through the same delivery.
    ///
    /// The three producers drain in subscription order — the modules first, so a `buffExpired`
    /// precedes both detectors' output for the same primary event, then the epoch detector, then
    /// the offline-gap detector. That is the order the goldens were recorded under.
    pub fn on_primary(&mut self, ev: &Event, live: bool) {
        self.events += 1;
        self.last_ts = self.last_ts.max(ev.ts());
        self.observe(ev, live);
        // Shift-until-empty, so anything a derived event queues in turn is delivered too — and it
        // can: `buffs` folds an `epoch` by clearing its live state, and a cleared instance may
        // still announce its own end.
        let mut i = 0;
        while i < self.derived.len() {
            let d = self.derived[i].clone();
            i += 1;
            self.observe(&d, live);
        }
        self.derived.clear();
    }

    /// One delivery: every module, then every detector. Used for a primary event and for each event
    /// of the drain alike — the detectors are ordinary subscribers and refuse the derived kinds by
    /// name rather than by position.
    fn observe(&mut self, ev: &Event, live: bool) {
        self.registry.dispatch(ev, live, &mut self.derived);
        // …then the engine, the next subscriber on the bus. The two field borrows are disjoint,
        // which is what lets the engine pull the roster out of the registry that has just finished
        // folding this same line.
        //
        // A derived event reaches it too, which is why this is one function rather than two: the
        // engine handles `epoch` by name (dropping the fight, the zone and the world), so
        // delivering a boundary to the modules alone would leave it holding a dead character's
        // encounter.
        if let Some(c) = &mut self.combat {
            c.on_event(ev, live, self.registry.roster());
        }
        if let Some(d) = self.epoch.observe(ev) {
            self.derived.push(d);
        }
        if let Some(d) = self.sessions.observe(ev) {
            self.derived.push(d);
        }
    }

    /// One wall-clock tick over the whole world — the app runs it once at go-live and then ~1×/sec
    /// while the live tail is running, never during a replay.
    ///
    /// A historical fold is [`Fold::fold_bytes`], which never calls this, so the fold of a given
    /// log stays a pure function of its bytes. What a tick changes is a live world: the app's own
    /// fold is aged by a wall clock, and an engine that did not do the same would serve state the
    /// app retired seconds ago.
    ///
    /// The combat engine is not ticked, because the TS heartbeat is `registry.tick` alone —
    /// `CombatEngine` declares no `onTick`. If one ever grows a heartbeat, this is the line that
    /// changes.
    pub fn tick(&mut self, now_ms: i64) {
        self.registry.tick(now_ms, &mut self.derived);
    }

    /// Fold a complete log through `eqlog::scan`. Historical, so `live` is false from the first byte
    /// to the last, and it never ticks — see [`Fold::tick`].
    ///
    /// Streamed, never collected: a slice folds to hundreds of thousands of events, and holding
    /// them as parsed values at once costs more than the machine has.
    pub fn fold_bytes(&mut self, parser: &eqlog::Parser, bytes: &[u8]) {
        eqlog::scan::scan_bytes(parser, bytes, |_json, payload| {
            self.on_primary(&Event::typed(payload), false);
        });
    }

    /// [`Fold::fold_bytes`] with per-consumer attribution: nanoseconds per registered module
    /// (delivery order), for the combat engine, the two detectors, and the event wrap. The bus
    /// semantics are `on_primary`/`observe`'s, restated here with stopwatches because a flag on the
    /// production path would make every ordinary fold pay the clock reads.
    ///
    /// Observer cost: ~2 clock reads per consumer per event (~40-60 ns a pair), inflating each
    /// bucket equally — shares are trustworthy, absolutes are a shade high.
    pub fn fold_bytes_attributed(
        &mut self,
        parser: &eqlog::Parser,
        bytes: &[u8],
    ) -> FoldAttribution {
        let mut out = FoldAttribution {
            module_ids: self.registry.ids(),
            module_ns: vec![0u64; self.registry.ids().len()],
            combat_ns: 0,
            detectors_ns: 0,
            reparse_ns: 0,
        };
        eqlog::scan::scan_bytes(parser, bytes, |_json, payload| {
            // The `reparse_ns` bucket now measures wrapping the parser's payload — a discriminant
            // copy and a reference. It stays in the table because the attribution is compared
            // against an earlier baseline, and a vanished row would read as a row nobody measured.
            let t = std::time::Instant::now();
            let ev = Event::typed(payload);
            out.reparse_ns += u64::try_from(t.elapsed().as_nanos()).unwrap_or(u64::MAX);
            self.events += 1;
            self.last_ts = self.last_ts.max(ev.ts());
            self.observe_attributed(&ev, false, &mut out);
            let mut i = 0;
            while i < self.derived.len() {
                let d = self.derived[i].clone();
                i += 1;
                self.observe_attributed(&d, false, &mut out);
            }
            self.derived.clear();
        });
        out
    }

    /// `observe`, with the stopwatches — see [`Fold::fold_bytes_attributed`].
    fn observe_attributed(&mut self, ev: &Event, live: bool, out: &mut FoldAttribution) {
        self.registry
            .dispatch_timed(ev, live, &mut self.derived, &mut |i, ns| {
                out.module_ns[i] += ns;
            });
        if let Some(c) = &mut self.combat {
            let t = std::time::Instant::now();
            c.on_event(ev, live, self.registry.roster());
            out.combat_ns += u64::try_from(t.elapsed().as_nanos()).unwrap_or(u64::MAX);
        }
        let t = std::time::Instant::now();
        if let Some(d) = self.epoch.observe(ev) {
            self.derived.push(d);
        }
        if let Some(d) = self.sessions.observe(ev) {
            self.derived.push(d);
        }
        out.detectors_ns += u64::try_from(t.elapsed().as_nanos()).unwrap_or(u64::MAX);
    }
}

/// Where an attributed fold's time went — [`Fold::fold_bytes_attributed`]'s answer.
#[derive(Debug)]
pub struct FoldAttribution {
    /// Registered module ids, delivery order — index-aligned with `module_ns`.
    pub module_ids: Vec<&'static str>,
    pub module_ns: Vec<u64>,
    pub combat_ns: u64,
    pub detectors_ns: u64,
    pub reparse_ns: u64,
}

/// The app's persisted knowledge, already parsed — what [`Registry::seed_persisted`] puts back.
///
/// Deliberately not a field of [`ClusterDeps`]: `registered()` is what the parity runner, the bench
/// arm and every test call, so a seed field there would be a door a file could walk through into
/// the world the oracle records. The seed arrives after construction, from the one caller handed a
/// `stateDir` — the same rule `install_knowledge` follows.
///
/// Both halves are default-empty, and an empty seed is not the same act as no seed: the
/// `begin_source` half still runs, because naming this fold's own bucket is right either way.
#[derive(Debug, Default)]
pub struct PersistedState {
    /// `<userData>/resist-ledger.json`'s buckets, the shipped baseline's already refused.
    pub resist: Vec<modules::resist::ledger_file::LedgerSource>,
    /// `<userData>/message-overlay.json`'s buckets, keyed by the source that produced them. The key
    /// travels with the counts because merging two origins under one key would put the fold's own
    /// output back in the pile it is seeded from, and the totals double.
    pub overlay: Vec<(String, Vec<message_overlay::SeedMessage>)>,
}

/// Everything the cluster needs from outside itself — `wiring.ts ModuleWiringDeps`.
///
/// A struct rather than a parameter list so a module with a new construction input adds a field and
/// a registration line instead of re-threading every call site.
///
/// Every field is a fact about the run rather than about the log's bytes, and each is derived by
/// the caller the way the TS harness derives it, because the goldens were recorded that way.
#[derive(Default)]
pub struct ClusterDeps {
    /// `wiring.ts` `knownSpell`, passed as the key set rather than as a closure so nothing in this
    /// crate borrows the parser.
    pub known_spell: HashSet<String>,
    /// `spellClasses.ts`'s canon-key → class-set index, built once off the same DB (evidence.rs).
    pub spell_classes: modules::combo::evidence::SpellClassIndex,
    /// `epochDetector.ts LAUNCH_MS`, resolved through the fold's own zone.
    pub launch_ms: i64,
    /// `WorldOpts.constructionNowMs` — the pinned construction clock the respawn module seeds its
    /// ordering clock from. See `modules/respawn.rs`'s header for why it cannot be a wall clock.
    pub construction_now_ms: i64,
    /// The `CharacterRef` pushed in with `setCharacter`, derived from the log's filename.
    pub character: Option<Value>,
    /// `roster.setSelfName`. The bench does not call it, so the parity runner passes `None` and the
    /// recorded goldens are what that produces.
    pub self_name: Option<String>,
    /// `deps.respawnPrefs` — the shipped default is an empty watch list, which is what every
    /// non-Electron caller passes.
    pub respawn_prefs: modules::respawn::RespawnPrefs,
    /// The whole of `db.byKey`, projected into the scalar facts the buffs model reads
    /// (`spell_facts.rs`). An empty one is the TS's absent `db?`: every read answers nothing, which
    /// is what a caller with no catalog gets.
    pub facts: spell_facts::SpellFacts,
}

/// Every ported module, registered in `WIRING_ORDER`'s relative order.
///
/// Named for what it does rather than for the cluster that brought it, so a reader never has to
/// date it. `Registry::missing()` is what says which modules a given build did not register.
pub fn registered(deps: ClusterDeps) -> Registry {
    let ClusterDeps {
        known_spell,
        spell_classes,
        launch_ms,
        construction_now_ms,
        character,
        self_name,
        respawn_prefs,
        facts,
    } = deps;
    let mut r = Registry::new();
    // combo goes first: within one bus delivery every later module — and the combat engine, which
    // folds the same event afterwards — sees an already-advanced combo state.
    r.register(Box::new(modules::combo::ComboModule::new(
        spell_classes,
        launch_ms,
    )));
    // roster goes second for the same reason: the engine's admission gate pulls the roster through
    // a seam installed before it ever folds a line, so the roster must already be advanced.
    r.register(Box::new(modules::roster::RosterModule::new(
        self_name.as_deref(),
    )));
    r.register(Box::new(modules::loot::LootModule::new()));
    r.register(Box::new(modules::turnins::TurnInsModule::new()));
    r.register(Box::new(modules::class_unlocks::ClassUnlocksModule::new()));
    r.register(Box::new(modules::kills::KillsModule::new()));
    // Beside `kills` because it folds the same death line, and after it, so anything reading both
    // within one delivery sees the kill counted before the clock that kill started.
    r.register(Box::new(modules::respawn::RespawnModule::new(
        construction_now_ms,
        respawn_prefs,
    )));
    r.register(Box::new(modules::progression::ProgressionModule::new()));
    r.register(Box::new(modules::leveling::LevelingModule::new()));
    r.register(Box::new(modules::character::CharacterModule::new(
        character,
    )));
    r.register(Box::new(modules::output_files::OutputFilesModule::new()));
    r.register(Box::new(modules::spell_sets::SpellSetsModule::new()));
    r.register(Box::new(modules::item_tiers::ItemTiersModule::new()));
    r.register(Box::new(
        modules::observed_spell_ranks::ObservedSpellRanksModule::new(known_spell),
    ));
    r.register(Box::new(modules::alerts::AlertsModule::new()));
    // The crowd-control module is built from the buffs module's own anchors and learner, so the two
    // cannot hold two ideas of whose spell just landed or how long it lasts. One `Rc<RefCell<…>>`,
    // cloned into both, is that sharing.
    let core = modules::buffs::shared_core(facts.clone());
    r.register(Box::new(modules::buffs::BuffsModule::new(
        facts,
        core.clone(),
    )));
    r.register(Box::new(modules::buff_timers::BuffTimersModule::new(core)));
    r.register(Box::new(modules::consider::ConsiderModule::new()));
    r.register(Box::new(modules::resist::ResistModule::new()));
    r.register(Box::new(modules::event_feed::EventFeedModule::new()));
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold_lines(lines: &[&str]) -> Value {
        let mut fold = Fold::new(registered(ClusterDeps::default()), i64::MAX);
        for line in lines {
            let ev = Event::from_json(line).expect("a JSON object");
            fold.on_primary(&ev, false);
        }
        fold.registry.snapshots()
    }

    fn state_of(snaps: &Value, id: &str) -> Value {
        snaps["modules"]
            .as_array()
            .expect("modules")
            .iter()
            .find(|m| m["id"] == id)
            .expect("the module")["snapshot"]["state"]
            .clone()
    }

    /// The registered set is a subsequence of the wiring order, and everything absent is named.
    #[test]
    fn registration_follows_the_wiring_order_and_names_what_is_absent() {
        let r = registered(ClusterDeps::default());
        let ids = r.ids();
        let mut at = 0usize;
        for id in &ids {
            let found = WIRING_ORDER[at..]
                .iter()
                .position(|w| w == id)
                .unwrap_or_else(|| panic!("{id} is out of wiring order"));
            at += found + 1;
        }
        // Written against `WIRING_ORDER.len()` rather than a literal, so a module added to the
        // wiring over there fails here until it is ported.
        assert_eq!(ids.len(), WIRING_ORDER.len());
        assert!(r.missing().is_empty(), "{:?}", r.missing());
        // combo and roster are the two whose position is load-bearing.
        assert_eq!(ids[0], "combo");
        assert_eq!(ids[1], "roster");
        // …and eventFeed stays last: a row appended while an earlier module's delta is being
        // emitted still rides out on the same flush pass.
        assert_eq!(ids[ids.len() - 1], "eventFeed");
    }

    /// A loot row is tagged with the zone the module was standing in, and an absent optional field
    /// is omitted rather than written as null.
    #[test]
    fn a_loot_row_carries_the_zone_and_omits_what_the_line_did_not_say() {
        let snaps = fold_lines(&[
            r#"{"kind":"zone","seq":0,"ts":10,"raw":"z","zone":"Innothule Swamp"}"#,
            r#"{"kind":"loot","seq":1,"ts":11,"raw":"l","item":"Bone Chips","source":"corpse"}"#,
        ]);
        let rows = state_of(&snaps, "loot");
        assert_eq!(rows[0]["zone"], "Innothule Swamp");
        assert_eq!(rows[0]["item"], "Bone Chips");
        assert!(rows[0].get("count").is_none(), "{rows}");
        assert!(rows[0].get("created").is_none(), "{rows}");
    }

    /// The credit join claims backward, consumes the line, and every death consumes — including
    /// one this module does not count.
    #[test]
    fn one_experience_line_credits_at_most_one_kill() {
        let snaps = fold_lines(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena 4 (Refined)"}"#,
            r#"{"kind":"expGain","seq":1,"ts":1000,"raw":"e","party":false}"#,
            r#"{"kind":"death","seq":2,"ts":1000,"raw":"d","name":"a stone spider","bySelf":true}"#,
            r#"{"kind":"death","seq":3,"ts":1200,"raw":"d","name":"a stone spider","bySelf":true}"#,
        ]);
        let mobs = state_of(&snaps, "kills")["mobs"].clone();
        let run = &mobs["a stone spider"]["tiers"]["4"];
        assert_eq!(run["count"], 2);
        assert_eq!(run["credited"], 1);
        assert_eq!(run["lastCreditedTs"], 1000);
        assert_eq!(mobs["a stone spider"]["bestTier"], 4);
    }

    /// A kill folded before any zone line states nothing about where it happened, and is not
    /// permitted to claim d0.
    #[test]
    fn a_kill_with_no_zone_line_behind_it_is_tier_unknown() {
        let snaps = fold_lines(&[
            r#"{"kind":"death","seq":0,"ts":5,"raw":"d","name":"A Froglok","bySelf":false,"killer":"Dranix"}"#,
            r#"{"kind":"death","seq":1,"ts":6,"raw":"d","name":"a froglok","bySelf":false,"killer":"You"}"#,
        ]);
        let mobs = state_of(&snaps, "kills")["mobs"].clone();
        // The two casings fold into one entry under the canonical key; the `slain by You` twin is
        // not counted, so the count is 1 and the display is the first spelling seen.
        assert_eq!(mobs["a froglok"]["count"], 1);
        assert_eq!(mobs["a froglok"]["display"], "A Froglok");
        assert_eq!(mobs["a froglok"]["bestTier"], jsfn::TIER_UNKNOWN);
    }

    /// A base-difficulty raid instance prints a bare zone line, so the creating-instance notice is
    /// what says the kill happened inside an instance. Shapes are the real ones; the player name is
    /// invented.
    #[test]
    fn a_bare_zone_with_a_creating_instance_notice_behind_it_is_d0() {
        let snaps = fold_lines(&[
            r#"{"kind":"instanceCreate","seq":0,"ts":0,"raw":"i","player":"Wanderling","zone":"The Plane of Sky","instance":6038}"#,
            r#"{"kind":"zone","seq":1,"ts":30000,"raw":"z","zone":"The Plane of Sky"}"#,
            r#"{"kind":"expGain","seq":2,"ts":60000,"raw":"e","party":true}"#,
            r#"{"kind":"death","seq":3,"ts":60000,"raw":"d","name":"Protector of Sky","bySelf":true}"#,
        ]);
        let mobs = state_of(&snaps, "kills")["mobs"].clone();
        assert_eq!(mobs["protector of sky"]["bestTier"], 0);
        assert_eq!(mobs["protector of sky"]["tiers"]["0"]["credited"], 1);
    }

    /// Memory, not proximity: re-entering an existing instance prints no fresh notice, so a kill
    /// long after the one notice still counts.
    #[test]
    fn a_bare_re_entry_with_no_fresh_notice_is_still_the_instance() {
        let snaps = fold_lines(&[
            r#"{"kind":"instanceCreate","seq":0,"ts":0,"raw":"i","player":"Wanderling","zone":"The Plane of Sky","instance":6038}"#,
            r#"{"kind":"zone","seq":1,"ts":30000,"raw":"z","zone":"The Plane of Sky"}"#,
            r#"{"kind":"death","seq":2,"ts":60000,"raw":"d","name":"Gorgalosk","bySelf":true}"#,
            // 46 minutes later, with only the open world in between.
            r#"{"kind":"zone","seq":3,"ts":2790000,"raw":"z","zone":"Innothule Swamp"}"#,
            r#"{"kind":"zone","seq":4,"ts":2820000,"raw":"z","zone":"The Plane of Sky"}"#,
            r#"{"kind":"death","seq":5,"ts":2830000,"raw":"d","name":"Gorgalosk","bySelf":true}"#,
        ]);
        let mobs = state_of(&snaps, "kills")["mobs"].clone();
        assert_eq!(mobs["gorgalosk"]["tiers"]["0"]["count"], 2);
        assert_eq!(mobs["gorgalosk"]["count"], 2);
    }

    /// A bare zone nobody created an instance of takes nothing off the week, which is what
    /// `TIER_OPEN_WORLD` is for.
    #[test]
    fn a_bare_zone_with_no_notice_is_still_the_open_world() {
        let snaps = fold_lines(&[
            r#"{"kind":"instanceCreate","seq":0,"ts":0,"raw":"i","player":"Wanderling","zone":"The Plane of Sky","instance":6038}"#,
            r#"{"kind":"zone","seq":1,"ts":30000,"raw":"z","zone":"Innothule Swamp"}"#,
            r#"{"kind":"death","seq":2,"ts":60000,"raw":"d","name":"a froglok","bySelf":true}"#,
        ]);
        let mobs = state_of(&snaps, "kills")["mobs"].clone();
        assert_eq!(mobs["a froglok"]["bestTier"], jsfn::TIER_OPEN_WORLD);
    }

    /// A notice older than the lockout period it belongs to is not evidence about tonight.
    #[test]
    fn a_notice_older_than_a_week_no_longer_converts_a_bare_zone() {
        let week = 7 * 24 * 60 * 60 * 1000;
        let snaps = fold_lines(&[
            r#"{"kind":"instanceCreate","seq":0,"ts":0,"raw":"i","player":"Wanderling","zone":"The Plane of Sky","instance":6038}"#,
            r#"{"kind":"zone","seq":1,"ts":10,"raw":"z","zone":"The Plane of Sky"}"#,
            &format!(
                r#"{{"kind":"death","seq":2,"ts":{},"raw":"d","name":"Bazzt Zzzt","bySelf":true}}"#,
                week
            ),
            &format!(
                r#"{{"kind":"death","seq":3,"ts":{},"raw":"d","name":"Sister of the Spire","bySelf":true}}"#,
                week + 1
            ),
        ]);
        let mobs = state_of(&snaps, "kills")["mobs"].clone();
        // The last instant the notice answers for, and the first it does not.
        assert_eq!(mobs["bazzt zzzt"]["bestTier"], 0);
        assert_eq!(
            mobs["sister of the spire"]["bestTier"],
            jsfn::TIER_OPEN_WORLD
        );
    }

    /// The epoch clears the instance memory exactly as it clears the KillMap: the notices named a
    /// player, and the one they named is gone.
    #[test]
    fn the_epoch_forgets_the_instances_the_dead_character_stood_in() {
        let snaps = fold_lines(&[
            r#"{"kind":"instanceCreate","seq":0,"ts":0,"raw":"i","player":"Wanderling","zone":"The Plane of Sky","instance":6038}"#,
            r#"{"kind":"zone","seq":1,"ts":10,"raw":"z","zone":"The Plane of Sky"}"#,
            r#"{"kind":"epoch","seq":2,"ts":20,"raw":"x"}"#,
            r#"{"kind":"death","seq":3,"ts":30,"raw":"d","name":"Eye of Veeshan","bySelf":true}"#,
        ]);
        let mobs = state_of(&snaps, "kills")["mobs"].clone();
        assert_eq!(mobs["eye of veeshan"]["bestTier"], jsfn::TIER_OPEN_WORLD);
    }

    /// The override moves one answer. A stated difficulty keeps its own, and a kill with no zone
    /// line behind it stays unknown — a notice says an instance exists, never where you stand.
    #[test]
    fn the_notice_moves_the_open_world_answer_and_no_other() {
        let snaps = fold_lines(&[
            r#"{"kind":"instanceCreate","seq":0,"ts":0,"raw":"i","player":"Wanderling","zone":"Najena 4 (Refined)","instance":6038}"#,
            r#"{"kind":"zone","seq":1,"ts":10,"raw":"z","zone":"Najena 4 (Refined)"}"#,
            r#"{"kind":"death","seq":2,"ts":20,"raw":"d","name":"a stone spider","bySelf":true}"#,
        ]);
        assert_eq!(
            state_of(&snaps, "kills")["mobs"]["a stone spider"]["bestTier"],
            4
        );
        let snaps = fold_lines(&[
            r#"{"kind":"instanceCreate","seq":0,"ts":0,"raw":"i","player":"Wanderling","zone":"The Plane of Sky","instance":6038}"#,
            r#"{"kind":"death","seq":1,"ts":20,"raw":"d","name":"Noble Dojorn","bySelf":true}"#,
        ]);
        assert_eq!(
            state_of(&snaps, "kills")["mobs"]["noble dojorn"]["bestTier"],
            jsfn::TIER_UNKNOWN
        );
    }

    /// A load opens a window; the burst settles ten quiet seconds later and the definition is
    /// stamped with the settle time, not the load line's.
    #[test]
    fn a_spell_set_load_settles_ten_quiet_seconds_after_its_burst() {
        let snaps = fold_lines(&[
            r#"{"kind":"spellSet","seq":0,"ts":0,"raw":"s","set":"dam","action":"loaded"}"#,
            r#"{"kind":"spellMemorize","seq":1,"ts":1000,"raw":"m","spell":"Clarity II","done":true}"#,
            r#"{"kind":"spellMemorize","seq":2,"ts":2000,"raw":"m","spell":"Malosi","done":true}"#,
            // Not a gem line, but it is still proof that time passed.
            r#"{"kind":"unknown","seq":3,"ts":12000,"raw":"x"}"#,
        ]);
        let state = state_of(&snaps, "spellSets");
        assert_eq!(state["memorized"], json!(["Clarity II", "Malosi"]));
        assert_eq!(state["sets"]["dam"]["observedAt"], 12000);
        assert_eq!(state["sets"]["dam"]["source"], "loaded");
        assert_eq!(
            state["sets"]["dam"]["spells"],
            json!(["Clarity II", "Malosi"])
        );
    }

    /// A forget removes the gem and leaves the rest of the bar in order.
    #[test]
    fn a_forget_closes_the_gap_in_the_memorized_order() {
        let snaps = fold_lines(&[
            r#"{"kind":"spellMemorize","seq":0,"ts":0,"raw":"m","spell":"Clarity","done":true}"#,
            r#"{"kind":"spellMemorize","seq":1,"ts":1,"raw":"m","spell":"Malosi","done":true}"#,
            r#"{"kind":"spellMemorize","seq":2,"ts":2,"raw":"m","spell":"Odium","done":true}"#,
            r#"{"kind":"spellForget","seq":3,"ts":3,"raw":"f","spell":"malosi"}"#,
        ]);
        assert_eq!(
            state_of(&snaps, "spellSets")["memorized"],
            json!(["Clarity", "Odium"])
        );
    }

    /// `tier` is the highest ever observed; `lastTier` is the raw sequence's most recent.
    #[test]
    fn an_item_tier_climbs_to_its_maximum_and_remembers_the_latest() {
        let snaps = fold_lines(&[
            r#"{"kind":"itemMerge","seq":0,"ts":1,"raw":"m","item":"Whitened Treant Fists +4","tier":4}"#,
            r#"{"kind":"itemMerge","seq":1,"ts":2,"raw":"m","item":"Whitened Treant Fists +3","tier":3}"#,
        ]);
        let row = &state_of(&snaps, "itemTiers")["whitened treant fists"];
        assert_eq!(row["tier"], 4);
        assert_eq!(row["lastTier"], 3);
        assert_eq!(row["merges"], 2);
        assert_eq!(row["name"], "Whitened Treant Fists");
    }

    /// An ordinary loot of a ` +N` drop is not evidence; a 'combined' one is, through `created`.
    #[test]
    fn only_a_combined_loot_mints_an_item_tier() {
        let snaps = fold_lines(&[
            r#"{"kind":"loot","seq":0,"ts":1,"raw":"l","item":"Kitchen Toolbelt +4"}"#,
            r#"{"kind":"loot","seq":1,"ts":2,"raw":"l","item":"Silver Earring","disposition":"combined","created":"Silver Earring +1"}"#,
        ]);
        let rows = state_of(&snaps, "itemTiers");
        assert!(rows.get("kitchen toolbelt").is_none(), "{rows}");
        assert_eq!(rows["silver earring"]["tier"], 1);
    }

    /// The cast lane needs no catalog; the merge lane needs one, and an unsuffixed name is never
    /// evidence at all.
    #[test]
    fn the_two_rank_witnesses_are_kept_apart() {
        let mut known = HashSet::new();
        known.insert("shiftless deeds".to_string());
        let mut fold = Fold::new(
            registered(ClusterDeps {
                known_spell: known,
                ..Default::default()
            }),
            i64::MAX,
        );
        for line in [
            r#"{"kind":"castBegin","seq":0,"ts":1,"raw":"c","spell":"Lay on Hands IX"}"#,
            r#"{"kind":"castBegin","seq":1,"ts":2,"raw":"c","spell":"Clarity"}"#,
            r#"{"kind":"itemMerge","seq":2,"ts":3,"raw":"m","item":"Shiftless Deeds III"}"#,
            r#"{"kind":"itemMerge","seq":3,"ts":4,"raw":"m","item":"Gold Plated Koshigatana II"}"#,
            r#"{"kind":"resist","seq":4,"ts":5,"raw":"r","caster":"you","target":"a mob","spell":"Shiftless Deeds IV","incoming":false}"#,
            r#"{"kind":"resist","seq":5,"ts":6,"raw":"r","caster":"Dranix","target":"a mob","spell":"Shiftless Deeds VI","incoming":false}"#,
        ] {
            fold.on_primary(&Event::from_json(line).expect("object"), false);
        }
        let rows = state_of(&fold.registry.snapshots(), "observedSpellRanks");
        // A rank the log has only ever cast is still known, catalog or no catalog.
        assert_eq!(rows["lay on hands"]["castRank"], 9);
        assert!(rows["lay on hands"].get("mergedRank").is_none());
        // An unsuffixed cast mints nothing — rank 1 is the default state, not an observation.
        assert!(rows.get("clarity").is_none(), "{rows}");
        // The merge lane is gated on the catalog…
        assert!(rows.get("gold plated koshigatana").is_none(), "{rows}");
        // …and the union takes the highest of the two halves, from your cast only.
        assert_eq!(rows["shiftless deeds"]["mergedRank"], 3);
        assert_eq!(rows["shiftless deeds"]["castRank"], 4);
        assert_eq!(rows["shiftless deeds"]["rank"], 4);
        assert_eq!(rows["shiftless deeds"]["merges"], 1);
        assert_eq!(rows["shiftless deeds"]["name"], "Shiftless Deeds");
    }

    /// The epoch event is derived, drains after the primary event, and drops every
    /// character-scoped module's state — while `outputFiles` deliberately keeps its receipts.
    #[test]
    fn the_launch_boundary_drops_the_dead_characters_state() {
        let mut fold = Fold::new(registered(ClusterDeps::default()), 1000);
        for line in [
            r#"{"kind":"loot","seq":0,"ts":500,"raw":"l","item":"Beta Sword"}"#,
            r#"{"kind":"outputFile","seq":1,"ts":600,"raw":"o","file":"Inventory.txt"}"#,
            r#"{"kind":"level","seq":2,"ts":700,"raw":"v","level":26}"#,
            r#"{"kind":"loot","seq":3,"ts":1500,"raw":"l","item":"Live Sword"}"#,
        ] {
            fold.on_primary(&Event::from_json(line).expect("object"), false);
        }
        let snaps = fold.registry.snapshots();
        // The boundary event fires on the ts:1500 loot line and is drained after it, so that row
        // is cleared too.
        assert_eq!(state_of(&snaps, "loot"), json!([]));
        assert_eq!(state_of(&snaps, "leveling")["levels"], json!([]));
        // …and the dump receipt outlives the epoch on purpose: the file outlives it too.
        assert_eq!(state_of(&snaps, "outputFiles")["inventory.txt"], 600);
    }

    /// A trade only closes the offer group that names the same NPC, but it always drops it.
    #[test]
    fn a_turn_in_pairs_offers_with_the_trade_that_names_the_same_npc() {
        let snaps = fold_lines(&[
            r#"{"kind":"offer","seq":0,"ts":1,"raw":"o","item":"Bone Chips","npc":"Kizdean Gix"}"#,
            r#"{"kind":"offer","seq":1,"ts":2,"raw":"o","item":"Bone Chips","npc":"Kizdean Gix"}"#,
            r#"{"kind":"trade","seq":2,"ts":3,"raw":"t","npc":"Someone Else"}"#,
            r#"{"kind":"offer","seq":3,"ts":4,"raw":"o","item":"Wind Rune","npc":"Kizdean Gix"}"#,
            r#"{"kind":"trade","seq":4,"ts":5,"raw":"t","npc":"Kizdean Gix"}"#,
        ]);
        let rows = state_of(&snaps, "turnins");
        assert_eq!(rows.as_array().expect("rows").len(), 1);
        assert_eq!(rows[0]["items"], json!(["Wind Rune"]));
        assert_eq!(rows[0]["ts"], 5);
    }

    /// First sighting wins, case-folded — and the newest export wins for a dump.
    #[test]
    fn class_unlocks_dedupe_and_output_files_keep_only_the_newest() {
        let snaps = fold_lines(&[
            r#"{"kind":"classUnlock","seq":0,"ts":1,"raw":"c","className":"Shadow Knight"}"#,
            r#"{"kind":"classUnlock","seq":1,"ts":2,"raw":"c","className":"shadow knight"}"#,
            r#"{"kind":"outputFile","seq":2,"ts":10,"raw":"o","file":"Inventory.txt"}"#,
            r#"{"kind":"outputFile","seq":3,"ts":5,"raw":"o","file":"C:\\EQ\\inventory.txt"}"#,
        ]);
        assert_eq!(
            state_of(&snaps, "classUnlocks"),
            json!([{ "ts": 1, "className": "Shadow Knight" }])
        );
        assert_eq!(
            state_of(&snaps, "outputFiles"),
            json!({ "inventory.txt": 10 })
        );
    }

    /// A module whose state moves only on events reports the seq of the last event it was handed,
    /// derived events included — and four of them deliberately do not.
    ///
    /// `combo`, `character` and `respawn` each have a second input that advances no log seq (a user
    /// correction, `setCharacter`, a watch edit), and `buffTimers` has `onTick`, which expires
    /// holds on an idle log. Each reports a private revision counter instead: `useModule` dedupes
    /// with `d.seq <= knownSeq`, so publishing the event seq would let the renderer drop the very
    /// push that carries the out-of-band change.
    #[test]
    fn the_published_seq_is_the_last_event_folded_except_where_a_revision_is_owed() {
        const OWN_REVISION: [&str; 4] = ["combo", "character", "respawn", "buffTimers"];
        let snaps = fold_lines(&[
            r#"{"kind":"unknown","seq":0,"ts":1,"raw":"x"}"#,
            r#"{"kind":"unknown","seq":41,"ts":2,"raw":"x"}"#,
        ]);
        for m in snaps["modules"].as_array().expect("modules") {
            let id = m["id"].as_str().expect("an id");
            if OWN_REVISION.contains(&id) {
                // Two unknown events move none of the four, so each is still at what its
                // construction spent: one `reset()` apiece, plus `character`'s `setCharacter`,
                // which the composition root always makes — and none for `buffTimers`, whose
                // `reset()` zeroes the counter rather than spending it.
                let want = match id {
                    "character" => 2,
                    "buffTimers" => 0,
                    _ => 1,
                };
                assert_eq!(m["snapshot"]["seq"], want, "{id}");
                continue;
            }
            assert_eq!(m["snapshot"]["seq"], 41, "{id}");
        }
    }

    /// The cast-recency map keeps the rank, refuses a stamp that went backwards, and survives the
    /// launch boundary — alerts is the one character-facing module with no `epoch` branch.
    #[test]
    fn the_cast_recency_map_is_rank_sensitive_and_outlives_the_epoch() {
        let mut fold = Fold::new(registered(ClusterDeps::default()), 1000);
        for line in [
            r#"{"kind":"castBegin","seq":0,"ts":500,"raw":"c","spell":"Mesmerization III"}"#,
            r#"{"kind":"castBegin","seq":1,"ts":400,"raw":"c","spell":"Mesmerization III"}"#,
            r#"{"kind":"castBegin","seq":2,"ts":600,"raw":"c","spell":"Mesmerization"}"#,
            r#"{"kind":"loot","seq":3,"ts":1500,"raw":"l","item":"Live Sword"}"#,
        ] {
            fold.on_primary(&Event::from_json(line).expect("object"), false);
        }
        let state = state_of(&fold.registry.snapshots(), "alerts");
        // Two ranks are two names, the older stamp did not win, and the epoch at ts 1500 did not
        // take the map with it.
        assert_eq!(state["spellLastCast"]["Mesmerization III"], 500);
        assert_eq!(state["spellLastCast"]["Mesmerization"], 600);
        assert_eq!(state["defs"], json!([]));
        assert_eq!(state["history"], json!({}));
        assert!(state.get("poisonSlowSeen").is_none(), "{state}");
    }

    /// A slow proc mints the recency record; a later one moves the target while an out-of-order one
    /// only counts.
    #[test]
    fn the_slow_poison_record_counts_every_proc_and_names_the_newest_target() {
        let snaps = fold_lines(&[
            r#"{"kind":"poisonProc","seq":0,"ts":100,"raw":"p","effect":"slow","target":"a spectre","strike":"Weakening Strike"}"#,
            r#"{"kind":"poisonProc","seq":1,"ts":50,"raw":"p","effect":"slow","target":"a ghoul","strike":"Weakening Strike"}"#,
            r#"{"kind":"poisonProc","seq":2,"ts":90,"raw":"p","effect":"damage","target":"a rat","strike":"Blinding Strike"}"#,
        ]);
        assert_eq!(
            state_of(&snaps, "alerts")["poisonSlowSeen"],
            json!({ "lastAt": 100, "count": 2, "lastTarget": "a spectre" })
        );
    }

    /// One row per mob, newest last, and a re-con moves the row rather than keeping its place —
    /// the one thing that makes this ring not a `JsMap`.
    #[test]
    fn a_re_con_moves_the_mobs_one_row_to_the_end_and_bumps_its_count() {
        let snaps = fold_lines(&[
            r#"{"kind":"zone","seq":0,"ts":1,"raw":"z","zone":"Permafrost Keep"}"#,
            r#"{"kind":"consider","seq":1,"ts":10,"raw":"c","mob":"A goblin priest","rare":false,"level":20,"faction":"indifferent","difficulty":"You could probably win this fight."}"#,
            r#"{"kind":"consider","seq":2,"ts":20,"raw":"c","mob":"Voidling","rare":false,"faction":"indifferent","difficulty":"???"}"#,
            r#"{"kind":"consider","seq":3,"ts":30,"raw":"c","mob":"a goblin priest","rare":true,"level":21,"faction":"scowls","difficulty":"???"}"#,
        ]);
        let rows = state_of(&snaps, "consider");
        assert_eq!(rows.as_array().expect("rows").len(), 2);
        // Voidling is now first because the re-con moved the goblin to the end.
        assert_eq!(rows[0]["id"], "voidling");
        // …and the row that moved carries the newest con's facts under the lowercase spelling,
        // which `adoptDisplay` prefers over the sentence-cased first sighting.
        assert_eq!(rows[1]["mob"], "a goblin priest");
        assert_eq!(rows[1]["cons"], 2);
        assert_eq!(rows[1]["level"], 21);
        assert_eq!(rows[1]["zone"], "Permafrost Keep");
        // A con with no level states none rather than claiming zero.
        assert!(rows[0].get("level").is_none(), "{rows}");
        assert!(rows[0].get("knowledge").is_none(), "{rows}");
    }

    /// The feed admits nothing historical, and its seq is still every event's — the hydration rule.
    #[test]
    fn the_event_feed_stays_empty_through_a_historical_fold() {
        let snaps = fold_lines(&[
            r#"{"kind":"consider","seq":0,"ts":10,"raw":"c","mob":"a rat","rare":false,"faction":"indifferent","difficulty":"???"}"#,
            r#"{"kind":"loot","seq":7,"ts":20,"raw":"l","item":"Bone Chips","source":"a rat"}"#,
        ]);
        assert_eq!(state_of(&snaps, "eventFeed"), json!([]));
    }

    /// Every primary event reaches the offline-gap detector. The rule it applies is proven in
    /// `session.rs`; what this pins is that `Fold` feeds it at all, and that the anchor is the line
    /// about you rather than the reconnect preamble's chat noise.
    #[test]
    fn the_fold_feeds_every_primary_event_to_the_offline_gap_detector() {
        let mut fold = Fold::new(registered(ClusterDeps::default()), i64::MAX);
        for line in [
            r#"{"kind":"loot","seq":0,"ts":1000,"raw":"l","item":"Bone Chips"}"#,
            r#"{"kind":"unknown","seq":1,"ts":500000,"raw":"Channels: 1=General1(400)"}"#,
        ] {
            fold.on_primary(&Event::from_json(line).expect("object"), false);
        }
        let welcome = Event::from_json(
            r#"{"kind":"sessionStart","seq":2,"ts":900000,"raw":"Welcome to EverQuest Legends!"}"#,
        )
        .expect("object");
        let gap = fold.sessions.observe(&welcome).expect("a gap");
        assert_eq!(gap.kind(), "offlineGap");
        assert_eq!(gap.int("fromTs"), Some(1000));
        assert_eq!(gap.int("toTs"), Some(900000));
    }

    // The buffs-model tests drive hand-written NDJSON with an empty catalog, which is the TS's
    // absent `db?`: every DB read answers nothing, so a landing must state its own duration to open
    // a row. That exercises every law below and keeps the fixtures readable.

    /// An unanchored landing produces nothing — the whole of the attribution gate. The same
    /// sentence with a cast line in front of it opens a row.
    #[test]
    fn a_landing_with_no_cast_line_behind_it_opens_nothing() {
        let stranger = fold_lines(&[
            r#"{"kind":"buffApply","seq":0,"ts":1000,"raw":"a","target":"self","spell":"Clarity","illusion":false,"durationMs":60000,"candidates":[{"name":"Clarity","durationMs":60000,"illusion":false}]}"#,
        ]);
        assert_eq!(state_of(&stranger, "buffs")["active"], json!([]));

        let mine = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":900,"raw":"c","spell":"Clarity II"}"#,
            r#"{"kind":"buffApply","seq":1,"ts":1000,"raw":"a","target":"self","spell":"Clarity","illusion":false,"durationMs":60000,"candidates":[{"name":"Clarity","durationMs":60000,"illusion":false}]}"#,
        ]);
        let active = &state_of(&mine, "buffs")["active"];
        assert_eq!(active[0]["spell"], "Clarity");
        // The identity is the DB candidate's name and the rank rides beside it.
        assert_eq!(active[0]["castName"], "Clarity II");
        assert_eq!(active[0]["self"], true);
        assert_eq!(active[0]["startedTs"], 1000);
        assert_eq!(active[0]["messageDriven"], true);
        // No sample yet, so the number is the landing's own stated duration and nothing else.
        assert_eq!(active[0]["n"], 0);
    }

    /// A land-to-fade pair mints one duration sample, and a wear-off sentence shared by several
    /// spells resolves against the active set rather than guessing the first candidate.
    #[test]
    fn a_clean_cycle_mints_a_sample_and_the_shared_wear_off_finds_the_live_one() {
        let snaps = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Swift Like the Wind"}"#,
            r#"{"kind":"buffApply","seq":1,"ts":2000,"raw":"a","target":"self","spell":"Swift Like the Wind","illusion":false,"durationMs":60000,"candidates":[{"name":"Swift Like the Wind","durationMs":60000,"illusion":false}]}"#,
            r#"{"kind":"buffWearOff","seq":2,"ts":102000,"raw":"w","spell":"Aanya's Quickening","candidates":["Aanya's Quickening","Swift Like the Wind"],"target":"self"}"#,
        ]);
        let state = state_of(&snaps, "buffs");
        assert_eq!(state["active"], json!([]));
        let row = &state["stats"]["swift like the wind"];
        assert_eq!(row["n"], 1);
        assert_eq!(row["maxMs"], 100_000);
        // No DB floor to beat, so the observation stands alone and says so.
        assert_eq!(row["estimateMs"], 100_000);
        assert_eq!(row["estimatorSource"], "observed");
    }

    /// The wear-off is synthesized back onto the bus as a resolved `buffExpired` and drained after
    /// the primary event, so every module registered before `buffs` sees it in bus order.
    #[test]
    fn a_resolved_wear_off_is_handed_back_to_the_bus_as_a_derived_event() {
        let mut fold = Fold::new(registered(ClusterDeps::default()), i64::MAX);
        for line in [
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Clarity"}"#,
            r#"{"kind":"buffApply","seq":1,"ts":2000,"raw":"a","target":"self","spell":"Clarity","illusion":false,"durationMs":60000,"candidates":[{"name":"Clarity","durationMs":60000,"illusion":false}]}"#,
        ] {
            fold.on_primary(&Event::from_json(line).expect("object"), false);
        }
        let wear_off = Event::from_json(
            r#"{"kind":"buffWearOff","seq":2,"ts":50000,"raw":"w","spell":"Clarity","candidates":["Clarity"],"target":"self"}"#,
        )
        .expect("object");
        // Dispatch by hand so the queue can be read before `on_primary` drains and clears it.
        let mut derived = Vec::new();
        fold.registry.dispatch(&wear_off, false, &mut derived);
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].kind(), "buffExpired");
        assert_eq!(derived[0].str("spell"), Some("Clarity"));
        assert_eq!(derived[0].str("target"), Some("self"));
        // Stamped with the primary event's identity, which is what lets it slot into the stream.
        assert_eq!(derived[0].seq(), 2);
        assert_eq!(derived[0].ts(), 50000);
        assert_eq!(derived[0].raw(), "Clarity wore off you.");
    }

    /// An offline gap pauses a buff and not a debuff, and censors the sample either way.
    #[test]
    fn an_absence_rewinds_a_buffs_clock_and_leaves_a_debuffs_alone() {
        let mut fold = Fold::new(registered(ClusterDeps::default()), i64::MAX);
        for line in [
            // The anchor, the landing, and an in-world line to give the detector something to
            // measure the absence from.
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Clarity"}"#,
            r#"{"kind":"buffApply","seq":1,"ts":2000,"raw":"a","target":"self","spell":"Clarity","illusion":false,"durationMs":600000,"candidates":[{"name":"Clarity","durationMs":600000,"illusion":false}]}"#,
            // …a login 100 s later, which the detector turns into a gap and the fold drains.
            r#"{"kind":"sessionStart","seq":2,"ts":102000,"raw":"Welcome to EverQuest Legends!"}"#,
        ] {
            fold.on_primary(&Event::from_json(line).expect("object"), false);
        }
        let active = &state_of(&fold.registry.snapshots(), "buffs")["active"];
        // 2000 + (102000 - 2000) = 102000: the clock was rewound by the whole absence, because EQ
        // freezes a buff with your character.
        assert_eq!(active[0]["startedTs"], 102_000);
    }

    /// A crowd-control hold is anchor-gated too, and closing it mints into the same learner the
    /// buffs half reads — which is what the shared core exists for.
    #[test]
    fn a_mez_cycle_mints_into_the_shared_learner() {
        let snaps = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Mesmerization VII"}"#,
            r#"{"kind":"cc","seq":1,"ts":2000,"raw":"m","mob":"a spiroc banisher","verb":"mesmerized","candidates":[{"name":"Mesmerization","durationMs":24000}]}"#,
            r#"{"kind":"cc","seq":2,"ts":46000,"raw":"r","mob":"a spiroc banisher","refresh":true,"spell":"Mesmerization"}"#,
        ]);
        // The hold closed, so nothing is standing…
        assert_eq!(state_of(&snaps, "buffTimers")["holds"], json!([]));
        // …and the 44 s cycle reached the buffs module's stats table, under the rank the cast line
        // named rather than the rank-less landing sentence's.
        let row = &state_of(&snaps, "buffs")["stats"]["mesmerization"];
        assert_eq!(row["spell"], "Mesmerization VII");
        assert_eq!(row["n"], 1);
        assert_eq!(row["maxMs"], 44_000);
    }

    /// A stranger's mez fills nobody's overlay, and the refusal still moves the revision counter
    /// when a break line arrives.
    #[test]
    fn an_unanchored_mez_opens_no_hold_and_a_break_still_counts_a_revision() {
        let snaps = fold_lines(&[
            r#"{"kind":"cc","seq":0,"ts":2000,"raw":"m","mob":"a spiroc banisher","verb":"mesmerized","candidates":[{"name":"Mesmerization","durationMs":24000}]}"#,
        ]);
        assert_eq!(state_of(&snaps, "buffTimers")["holds"], json!([]));
        assert_eq!(snapshot_seq(&snaps, "buffTimers"), 0);

        let snaps = fold_lines(&[
            r#"{"kind":"uncharm","seq":0,"ts":2000,"raw":"u","mob":"a spiroc banisher","spell":"Allure"}"#,
        ]);
        // An `end` is recorded even when we held nothing: it is a real CC break, and the projection
        // uses it to retire an active buff the buffs model does not clear.
        assert_eq!(snapshot_seq(&snaps, "buffTimers"), 1);
        assert_eq!(
            state_of(&snaps, "buffTimers")["ends"],
            json!([{ "key": "a spiroc banisher", "ts": 2000, "spell": "Allure" }])
        );
    }

    fn snapshot_seq(snaps: &Value, id: &str) -> i64 {
        snaps["modules"]
            .as_array()
            .expect("modules")
            .iter()
            .find(|m| m["id"] == id)
            .expect("the module")["snapshot"]["seq"]
            .as_i64()
            .expect("a seq")
    }

    // resist's published surface is two integers, so every law below is stated as a claim about how
    // many pooling keys the ledger holds and how many creatures they are about.

    /// A row's target has to be a creature. A groupmate's landing and your own self-damage are the
    /// two shapes that would put a person's name in a published file, and both are refused; a mob's
    /// is filed. All three lines are otherwise identical.
    #[test]
    fn a_resist_row_is_only_ever_filed_about_a_creature() {
        let snaps = fold_lines(&[
            r#"{"kind":"resist","seq":0,"ts":1000,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}"#,
            r#"{"kind":"resist","seq":1,"ts":2000,"raw":"r","caster":"You","target":"Dranix","spell":"Malosi","incoming":false}"#,
            r#"{"kind":"resist","seq":2,"ts":3000,"raw":"r","caster":"You","target":"You","spell":"Malosi","incoming":false}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 1, "mobs": 1 }));
    }

    /// Your resists only. `You resist <mob>'s <Spell>!` is the incoming form and a different
    /// feature, so it files nothing.
    #[test]
    fn an_incoming_resist_is_yours_and_is_never_filed() {
        let snaps = fold_lines(&[
            r#"{"kind":"resist","seq":0,"ts":1000,"raw":"r","caster":"a froglok ton knight","target":"You","spell":"Fear","incoming":true}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 0, "mobs": 0 }));
    }

    /// The rank and the invocation are pooling terms: casts differing only in printed rank, or in
    /// whether overchannel was up, rolled against different resist adjusts and may not be pooled.
    /// The mob count staying at one is what says the split is about the roll, not the creature.
    #[test]
    fn a_rank_and_an_invocation_each_split_a_resist_row() {
        let snaps = fold_lines(&[
            r#"{"kind":"resist","seq":0,"ts":1000,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Shiftless Deeds IV","incoming":false}"#,
            r#"{"kind":"resist","seq":1,"ts":2000,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Shiftless Deeds VI","incoming":false}"#,
            r#"{"kind":"invocationChange","seq":2,"ts":3000,"raw":"i","invocation":"overchannel"}"#,
            r#"{"kind":"castBegin","seq":3,"ts":3100,"raw":"c","spell":"Shiftless Deeds IV"}"#,
            r#"{"kind":"resist","seq":4,"ts":3200,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Shiftless Deeds IV","incoming":false}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 3, "mobs": 1 }));
    }

    /// The ISO week is in the key, and it is the one term not about `rc`: two identical resists a
    /// fortnight apart are two rows, because a row that pooled them would have no age to weigh. The
    /// instant comes off the log's clock, never a wall clock.
    #[test]
    fn the_iso_week_splits_a_row_so_every_count_has_an_age() {
        const WEEK_MS: i64 = 7 * 86_400_000;
        let later = format!(
            r#"{{"kind":"resist","seq":1,"ts":{},"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}}"#,
            1_787_184_000_000i64 + 2 * WEEK_MS
        );
        let snaps = fold_lines(&[
            r#"{"kind":"resist","seq":0,"ts":1787184000000,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}"#,
            &later,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 2, "mobs": 1 }));
    }

    /// One cast is one roll. A nuke prints its damage line first and its landing emote after, so
    /// the emote is the same roll stated twice: the deferred landing is cancelled and the pair
    /// leaves one row. The `damaged` set on the armed cast is what does it — the cancel-forward
    /// rule never fires, because the game's order is always damage then emote.
    #[test]
    fn a_damage_line_and_its_own_landing_emote_are_one_observation() {
        let snaps = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Chaotic Feedback"}"#,
            r#"{"kind":"damage","seq":1,"ts":2000,"raw":"d","attacker":"You","target":"a kodiak","amount":30,"dtype":"spell","skill":"Chaotic Feedback","crit":false}"#,
            r#"{"kind":"cc","seq":2,"ts":2000,"raw":"e","mob":"a kodiak","candidates":[{"name":"Chaotic Feedback","durationMs":null}]}"#,
            // Far enough past the emote that a surviving deferred landing would have been filed.
            r#"{"kind":"unknown","seq":3,"ts":60000,"raw":"x"}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 1, "mobs": 1 }));
    }

    // One `*.define` example per family, each asserting the push moves the module its TypeScript
    // seam moves. They live here, over hand-written events, because a claim about what a preference
    // does to a fold is sharpest when the event it does it to is written out; the socket suite in
    // `engined` proves the push travels.

    /// Push one family's set into a registry and take the snapshots.
    ///
    /// The launch anchor is stated in both places, and that is not redundancy: the epoch detector
    /// takes it from `Fold::new` while `combo` takes it from its own construction. A world where
    /// the two disagreed would refuse a correction the boundary then kept, or the reverse.
    fn folded_with(family: &str, payload: Value, lines: &[&str]) -> Value {
        let deps = ClusterDeps {
            launch_ms: 1000,
            ..ClusterDeps::default()
        };
        let mut fold = Fold::new(registered(deps), 1000);
        assert!(
            fold.registry.define(family, &payload),
            "no module answers to {family}"
        );
        for line in lines {
            let ev = Event::from_json(line).expect("a JSON object");
            fold.on_primary(&ev, false);
        }
        fold.registry.snapshots()
    }

    /// `alertsModule.setDefs(list)` — the store's list, published back verbatim, extras and all. A
    /// def carries fields no evaluator reads, and the app's alert list is drawn from `defs`, so
    /// anything dropped in transit is an alert the user re-opens and finds rewritten.
    #[test]
    fn a_pushed_alert_definition_round_trips_through_the_module_untouched() {
        let defs = json!([{
            "id": "a1", "name": "Charm break", "enabled": true,
            "sound": { "packId": "classic", "soundId": "bell" },
            "trigger": { "type": "event", "kind": "uncharm" },
            "volume": 0.4, "audio": "speech", "speech": { "mode": "custom", "phrase": "loose!" }
        }]);
        let snaps = folded_with("alerts", defs.clone(), &[]);
        assert_eq!(state_of(&snaps, "alerts")["defs"], defs);
    }

    /// A historical fold makes no sound, however many defs are loaded.
    #[test]
    fn a_replay_fires_nothing_and_a_live_line_fires_once() {
        let defs = json!([{
            "id": "a1", "name": "Charm break", "enabled": true,
            "sound": { "packId": "classic", "soundId": "bell" },
            "trigger": { "type": "event", "kind": "uncharm" }
        }]);
        let mut fold = Fold::new(registered(ClusterDeps::default()), 1000);
        fold.registry.define("alerts", &defs);
        let ev = Event::from_json(
            r#"{"kind":"uncharm","seq":0,"ts":5000,"raw":"Your charm spell has worn off.","mob":"a rat"}"#,
        )
        .expect("object");

        fold.on_primary(&ev, false);
        assert!(fold.registry.take_fires().is_empty(), "replay is silent");

        fold.on_primary(&ev, true);
        let fires = fold.registry.take_fires();
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].rule, "Charm break");
        assert_eq!(fires[0].sound, "classic/bell");
        assert_eq!(fires[0].at, 5000, "the LOG's clock");
        assert_eq!(fires[0].message, "Your charm spell has worn off.");
        // …and the fire is in the module's own ring, which is the app-visible half of it.
        assert_eq!(
            state_of(&fold.registry.snapshots(), "alerts")["history"]["a1"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
    }

    /// `buffsModule.setTrust(next)` — an allowlisted caster's cast anchors a landing and a
    /// stranger's does not. The `cc` event states its candidates so the claim is about the
    /// allowlist rather than about which spells share an emote in the committed catalog.
    #[test]
    fn a_pushed_buff_trust_admits_an_external_casters_anchor() {
        const LINES: [&str; 2] = [
            r#"{"kind":"otherCastBegin","seq":0,"ts":2000,"raw":"c","caster":"Dranix","spell":"Mesmerization"}"#,
            r#"{"kind":"cc","seq":1,"ts":3000,"raw":"m","mob":"a spiroc banisher","verb":"mesmerized","candidates":[{"name":"Mesmerization","durationMs":24000}]}"#,
        ];
        // The control first: under the shipped default the allowlist is empty, so a stranger's cast
        // anchors nothing and the mez opens no hold.
        let mut stranger = Fold::new(registered(ClusterDeps::default()), 1000);
        for line in LINES {
            stranger.on_primary(&Event::from_json(line).expect("object"), false);
        }
        assert_eq!(
            state_of(&stranger.registry.snapshots(), "buffTimers")["holds"],
            json!([])
        );

        // …and with the name pushed, the identical rule admits it — not a looser one.
        let snaps = folded_with("buffTrust", json!({ "externals": ["Dranix"] }), &LINES);
        let holds = state_of(&snaps, "buffTimers")["holds"].clone();
        assert_eq!(holds.as_array().map(Vec::len), Some(1), "{holds}");
        assert_eq!(holds[0]["key"], "a spiroc banisher", "{holds}");
    }

    /// `respawnModule.setPrefs(next)` — the watch list is the only admission rule, so the same
    /// death produces a clock with the push and nothing without it.
    #[test]
    fn a_pushed_respawn_watch_is_what_admits_a_mob_to_a_clock() {
        const LINES: [&str; 2] = [
            r#"{"kind":"zone","seq":0,"ts":2000,"raw":"z","zone":"Permafrost Keep"}"#,
            r#"{"kind":"death","seq":1,"ts":3000,"raw":"d","name":"a ghoul","bySelf":true}"#,
        ];
        let unwatched = fold_lines(&LINES);
        assert_eq!(state_of(&unwatched, "respawn")["rows"], json!([]));

        let snaps = folded_with(
            "respawn",
            json!({ "watches": [{ "key": "a ghoul", "display": "a ghoul", "customSec": 300 }] }),
            &LINES,
        );
        let respawn = state_of(&snaps, "respawn");
        assert_eq!(
            respawn["prefs"]["watches"][0]["customSec"], 300,
            "{respawn}"
        );
        assert_eq!(respawn["rows"][0]["key"], "a ghoul", "{respawn}");
        assert_eq!(
            respawn["rows"][0]["customMs"], 300_000,
            "the user's own number is rung 1, in ms: {respawn}"
        );
    }

    /// A watch payload is normalized the way `shared/respawn.ts` normalizes it, at both ends, so a
    /// hand-edited settings file and a renderer cannot hold two ideas of what a watch is.
    #[test]
    fn a_pushed_watch_list_is_normalized_rather_than_trusted() {
        let snaps = folded_with(
            "respawn",
            json!({ "watches": [
                { "key": "  A Ghoul  ", "display": "" },
                { "key": "a ghoul", "display": "duplicate" },
                { "key": "", "display": "keyless" },
                { "key": "a rat", "display": "a rat", "customSec": 0 }
            ]}),
            &[],
        );
        let watches = state_of(&snaps, "respawn")["prefs"]["watches"].clone();
        assert_eq!(watches.as_array().map(Vec::len), Some(2), "{watches}");
        assert_eq!(watches[0]["key"], "a ghoul", "trimmed and case-folded");
        assert_eq!(
            watches[0]["display"], "a ghoul",
            "an empty display is the key"
        );
        assert!(
            watches[1].get("customSec").is_none(),
            "an out-of-range number is ABSENT, never zero: {watches}"
        );
    }

    /// `comboModule.setCorrection(...)` — the user's span re-labels the intervals, and says so.
    #[test]
    fn a_pushed_combo_correction_relabels_the_span_it_names() {
        // A class observation first, because a correction re-labels an interval rather than
        // conjuring one. Coating your own blades is the observation that needs no catalog: only
        // rogues have poison disciplines on Legends.
        //
        // Two of them, because the launch anchor is 1000 here and the first event past it fires the
        // rebirth boundary, clearing the observation it fired on. The second coat is the new
        // world's.
        const LINES: [&str; 2] = [
            r#"{"kind":"poisonCoat","seq":0,"ts":5000,"raw":"p","who":"you","poison":"Weakening Poison"}"#,
            r#"{"kind":"poisonCoat","seq":1,"ts":6000,"raw":"p","who":"you","poison":"Weakening Poison"}"#,
        ];
        let snaps = folded_with(
            "combo",
            json!([{ "startTs": 2000, "endTs": null, "classes": ["ENC", "ROG"], "setAt": 9000 }]),
            &LINES,
        );
        let combo = state_of(&snaps, "combo");
        assert_eq!(combo["current"]["userLocked"], true, "{combo}");
        assert_eq!(combo["current"]["slots"][0]["candidates"], json!(["ENC"]));
        assert_eq!(combo["current"]["slots"][0]["provenance"], "user");
    }

    /// A correction is refused whole rather than filtered — `ipc/combo.ts`'s door rule, restated
    /// here because a define is a second door onto the same state.
    #[test]
    fn a_combo_correction_that_is_not_the_shape_the_app_validates_is_dropped() {
        for bad in [
            json!({ "startTs": 500, "endTs": null, "classes": ["ENC"], "setAt": 9000 }),
            json!({ "startTs": 2000, "endTs": 1000, "classes": ["ENC"], "setAt": 9000 }),
            json!({ "startTs": 2000, "endTs": null, "classes": ["ENC", "ENC"], "setAt": 9000 }),
            json!({ "startTs": 2000, "endTs": null, "classes": ["XYZ"], "setAt": 9000 }),
            json!({ "startTs": 2000, "endTs": null, "classes": [], "setAt": 9000 }),
        ] {
            let snaps = folded_with(
                "combo",
                json!([bad.clone()]),
                &[
                    r#"{"kind":"poisonCoat","seq":0,"ts":5000,"raw":"p","who":"you","poison":"Weakening Poison"}"#,
                    r#"{"kind":"poisonCoat","seq":1,"ts":6000,"raw":"p","who":"you","poison":"Weakening Poison"}"#,
                ],
            );
            assert_eq!(
                state_of(&snaps, "combo")["current"]["userLocked"],
                false,
                "the interval stands on its own evidence, unlocked: {bad}"
            );
        }
    }

    /// `rosterModule.setEdit(...)` — a name the log never named is a member at the top provenance
    /// rung, and a name it did name can be removed. The edits are a layer over the log, so a
    /// removal is not undone by anything the log says afterwards.
    #[test]
    fn pushed_roster_edits_add_and_remove_over_the_logs_own_roster() {
        const LINES: [&str; 1] =
            [r#"{"kind":"group","seq":0,"ts":2000,"raw":"g","change":"join","name":"Dranix"}"#];
        let snaps = folded_with(
            "roster",
            json!([
                { "key": "rowel", "name": "Rowel", "action": "add", "setAt": 3000 },
                { "key": "dranix", "name": "Dranix", "action": "remove", "setAt": 3000 }
            ]),
            &LINES,
        );
        let members = state_of(&snaps, "roster")["members"].clone();
        assert_eq!(members.as_array().map(Vec::len), Some(1), "{members}");
        assert_eq!(members[0]["key"], "rowel");
        assert_eq!(members[0]["source"], "user", "the top rung: {members}");
    }

    /// An edit older than the last rebirth described a dead character's group, and the fold drops
    /// it by date rather than by deleting it — the list belongs to the app.
    #[test]
    fn a_roster_edit_written_before_the_last_epoch_applies_to_nothing() {
        let snaps = folded_with(
            "roster",
            json!([{ "key": "rowel", "name": "Rowel", "action": "add", "setAt": 500 }]),
            &[r#"{"kind":"loot","seq":0,"ts":1500,"raw":"l","item":"Live Sword"}"#],
        );
        // The launch anchor is 1000 here, so the ts-1500 line fires the rebirth boundary.
        assert_eq!(state_of(&snaps, "roster")["members"], json!([]));
    }

    /// Every family is claimed by exactly one module, and a name nothing claims is refused rather
    /// than silently dropped.
    #[test]
    fn the_five_families_are_claimed_and_nothing_else_is() {
        let mut fold = Fold::new(registered(ClusterDeps::default()), 1000);
        for family in ["alerts", "buffTrust", "respawn", "combo", "roster"] {
            assert!(
                fold.registry.define(family, &json!([])),
                "{family} is claimed"
            );
        }
        assert!(!fold.registry.define("buffTimers", &json!([])));
        assert!(!fold.registry.define("", &json!([])));
    }

    /// A cast that never happened is not a resist: a fizzle disarms, so the landing sentence that
    /// follows has nothing to join to and files nothing.
    #[test]
    fn a_fizzled_cast_can_no_longer_claim_a_landing_sentence() {
        let snaps = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Chaotic Feedback"}"#,
            r#"{"kind":"castFizzle","seq":1,"ts":1500,"raw":"f","spell":"Chaotic Feedback"}"#,
            r#"{"kind":"cc","seq":2,"ts":2000,"raw":"e","mob":"a kodiak","candidates":[{"name":"Chaotic Feedback","durationMs":null}]}"#,
            r#"{"kind":"unknown","seq":3,"ts":60000,"raw":"x"}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 0, "mobs": 0 }));
    }

    /// A debuff window is a pooling term. The same resist before and after a tash lands on the mob
    /// is two rows, and the window closes on the log's clock — eleven minutes later the third
    /// resist pools back with the first.
    #[test]
    fn a_resist_debuff_window_splits_a_row_and_then_closes_on_the_logs_clock() {
        const DEBUFF_MS: i64 = 11 * 60 * 1000;
        let after = format!(
            r#"{{"kind":"resist","seq":4,"ts":{},"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}}"#,
            2_000 + DEBUFF_MS + 1_000
        );
        let snaps = fold_lines(&[
            r#"{"kind":"resist","seq":0,"ts":1000,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}"#,
            r#"{"kind":"castBegin","seq":1,"ts":1500,"raw":"c","spell":"Tashani"}"#,
            r#"{"kind":"cc","seq":2,"ts":2000,"raw":"e","mob":"a froglok ton knight","candidates":[{"name":"Tashani","durationMs":null}]}"#,
            r#"{"kind":"resist","seq":3,"ts":3000,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}"#,
            &after,
        ]);
        // Three keys: the bare Malosi row (shared by the first and the last resist), the
        // tash-debuffed Malosi row, and the Tashani landing's own row.
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 3, "mobs": 1 }));
    }

    /// A DoT's first tick is the landing and the rest are the same roll, but the row is minted
    /// either way — one cast and three ticks is one row rather than none.
    #[test]
    fn only_a_dots_first_tick_is_a_landing_and_the_row_is_minted_regardless() {
        let snaps = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Envenomed Bolt"}"#,
            r#"{"kind":"damage","seq":1,"ts":2000,"raw":"d","attacker":"You","target":"a kodiak","amount":110,"dtype":"dot","skill":"Envenomed Bolt","crit":false}"#,
            r#"{"kind":"damage","seq":2,"ts":5000,"raw":"d","attacker":"You","target":"a kodiak","amount":110,"dtype":"dot","skill":"Envenomed Bolt","crit":false}"#,
            r#"{"kind":"damage","seq":3,"ts":8000,"raw":"d","attacker":"You","target":"a kodiak","amount":110,"dtype":"dot","skill":"Envenomed Bolt","crit":false}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 1, "mobs": 1 }));
    }

    /// A proc is not a cast spell, and the log has no field that says so — what it has is the cast
    /// line, which a proc never prints. An observation joining an armed cast carries that cast's
    /// invocation; one joining none answers `false`. Same spell, same mob, same week, two rows,
    /// because they are two different claims about the roll.
    #[test]
    fn an_observation_with_no_cast_behind_it_is_a_proc() {
        let snaps = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Smiting Strike"}"#,
            r#"{"kind":"damage","seq":1,"ts":2000,"raw":"d","attacker":"You","target":"a kodiak","amount":30,"dtype":"spell","skill":"Smiting Strike","crit":false}"#,
            // Past CAST_JOIN_MS, so this one joins nothing and is filed as a proc.
            r#"{"kind":"damage","seq":2,"ts":20000,"raw":"d","attacker":"You","target":"a kodiak","amount":30,"dtype":"spell","skill":"Smiting Strike","crit":false}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 2, "mobs": 1 }));
    }

    /// The module does not reset at an epoch boundary: what a mob resists is game knowledge and a
    /// rebirth does not unlearn it, so the pre-launch row survives the boundary that empties loot
    /// and leveling.
    #[test]
    fn what_a_mob_resists_outlives_the_launch_boundary() {
        let mut fold = Fold::new(registered(ClusterDeps::default()), 1000);
        for line in [
            r#"{"kind":"resist","seq":0,"ts":500,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}"#,
            r#"{"kind":"loot","seq":1,"ts":1500,"raw":"l","item":"Live Sword"}"#,
        ] {
            fold.on_primary(&Event::from_json(line).expect("object"), false);
        }
        let snaps = fold.registry.snapshots();
        assert_eq!(state_of(&snaps, "loot"), json!([]));
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 1, "mobs": 1 }));
    }

    /// A zone line is a discontinuity: it decides the deferred landing outright rather than waiting
    /// out the window, and drops every open debuff. So the landing lands, and the resist that
    /// follows in the new zone pools with no debuff on the key.
    #[test]
    fn a_zone_line_decides_the_deferred_landing_and_drops_the_debuff_windows() {
        let snaps = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Tashani"}"#,
            r#"{"kind":"cc","seq":1,"ts":1500,"raw":"e","mob":"a froglok ton knight","candidates":[{"name":"Tashani","durationMs":null}]}"#,
            // Inside LAND_DEFER_MS of the emote, so only the zone line can decide it.
            r#"{"kind":"zone","seq":2,"ts":2000,"raw":"z","zone":"Innothule Swamp"}"#,
            r#"{"kind":"resist","seq":3,"ts":2500,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}"#,
        ]);
        // The Tashani landing row, plus an un-debuffed Malosi row — the window died with the zone.
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 2, "mobs": 1 }));
    }

    /// A login after a long silence synthesizes an `offlineGap`, and `progression` publishes the
    /// instants it carries: the columns record what the log said, and an absence is a thing the log
    /// said.
    #[test]
    fn a_login_after_an_absence_writes_an_offline_interval() {
        let snaps = fold_lines(&[
            r#"{"kind":"expGain","seq":0,"ts":1000,"raw":"e","party":false}"#,
            r#"{"kind":"campStart","seq":1,"ts":2000,"raw":"c"}"#,
            r#"{"kind":"sessionStart","seq":2,"ts":900000,"raw":"w"}"#,
        ]);
        let p = state_of(&snaps, "progression");
        assert_eq!(p["offlineStart"], json!([2000]));
        assert_eq!(p["offlineEnd"], json!([900000]));
        assert_eq!(p["offlineCamped"], json!([1]));
    }

    /// The credited/witnessed split, the backward experience join, and the ring row that carries
    /// what the kill paid — all off one four-line window.
    #[test]
    fn a_kill_claims_the_experience_line_before_it_and_a_strangers_does_not_pay_you() {
        let snaps = fold_lines(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            r#"{"kind":"expGain","seq":1,"ts":1000,"raw":"e","party":false,"pct":2}"#,
            r#"{"kind":"death","seq":2,"ts":1000,"raw":"d","name":"a stone spider","bySelf":true}"#,
            r#"{"kind":"death","seq":3,"ts":2000,"raw":"d","name":"a bat","bySelf":false,"killer":"Dranix"}"#,
        ]);
        let p = state_of(&snaps, "progression");
        assert_eq!(p["killTs"], json!([1000]));
        assert_eq!(p["killZone"], json!([0]));
        assert_eq!(p["witnessTs"], json!([2000]));
        assert_eq!(p["recentKills"][0]["name"], "a stone spider");
        assert_eq!(p["recentKills"][0]["zone"], "Najena");
        // `expPct` is the one true f64 in the stream, so it is compared as a number: serde writes
        // `2.0` where `JSON.stringify` writes `2`, and both parse to the same double — which is
        // what the comparator does with them, since it diffs parsed values.
        assert_eq!(p["recentKills"][0]["expPct"].as_f64(), Some(2.0));
        assert_eq!(p["recentKills"][0]["expFlag"], 0);
    }

    /// A group line names a member and an offline gap marks them stale rather than removing them:
    /// hiding a real member is the worse error.
    #[test]
    fn an_offline_gap_dims_a_member_and_never_drops_one() {
        let snaps = fold_lines(&[
            r#"{"kind":"group","seq":0,"ts":1000,"raw":"g","change":"join","name":"Dranix"}"#,
            r#"{"kind":"expGain","seq":1,"ts":2000,"raw":"e","party":true}"#,
            r#"{"kind":"sessionStart","seq":2,"ts":900000,"raw":"w"}"#,
        ]);
        let r = state_of(&snaps, "roster");
        assert_eq!(r["members"][0]["name"], "Dranix");
        assert_eq!(r["members"][0]["source"], "joined");
        assert_eq!(r["members"][0]["stale"], true);
        assert_eq!(r["seen"], true);
        assert_eq!(r["lastSignalTs"], 1000);
    }

    /// A `/who` row states the level at its own instant and outranks a ding in the same second; the
    /// epoch drops the wiped character's zone and level and keeps the ref.
    ///
    /// The derived boundary event drains after the zone line that triggers it, so that zone goes
    /// with the dead character too and the survivor's first zone is the next line.
    #[test]
    fn the_level_fact_takes_the_latest_statement_and_who_breaks_the_tie() {
        let mut fold = Fold::new(
            registered(ClusterDeps {
                character: Some(json!({ "name": "Primitive", "server": "freeport" })),
                ..Default::default()
            }),
            1000,
        );
        for line in [
            r#"{"kind":"zone","seq":0,"ts":500,"raw":"z","zone":"Beta Zone"}"#,
            r#"{"kind":"level","seq":1,"ts":600,"raw":"v","level":26}"#,
            r#"{"kind":"zone","seq":2,"ts":1500,"raw":"z","zone":"Beta Zone"}"#,
            r#"{"kind":"zone","seq":3,"ts":1550,"raw":"z","zone":"Najena"}"#,
            r#"{"kind":"level","seq":4,"ts":1600,"raw":"v","level":30}"#,
            r#"{"kind":"selfWho","seq":5,"ts":1600,"raw":"w","level":31,"classes":["PAL","MNK","ENC"]}"#,
        ] {
            fold.on_primary(&Event::from_json(line).expect("object"), false);
        }
        let state = state_of(&fold.registry.snapshots(), "character");
        assert_eq!(state["character"]["name"], "Primitive");
        assert_eq!(state["zone"], "Najena");
        assert_eq!(
            state["level"],
            json!({ "level": 31, "ts": 1600, "source": "who" })
        );
    }

    /// A watch list nobody filled in clocks nothing, while the recent-kills candidate list still
    /// offers every mob the fold has seen die.
    #[test]
    fn an_empty_watch_list_publishes_candidates_and_no_rows() {
        let snaps = fold_lines(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            r#"{"kind":"death","seq":1,"ts":1000,"raw":"d","name":"a stone spider","bySelf":true}"#,
        ]);
        let state = state_of(&snaps, "respawn");
        assert_eq!(state["v"], 4);
        assert_eq!(state["zone"], "Najena");
        assert_eq!(state["rows"], json!([]));
        assert_eq!(state["prefs"], json!({ "watches": [] }));
        assert_eq!(state["recent"][0]["key"], "a stone spider");
        assert_eq!(state["recent"][0]["watched"], false);
        assert_eq!(state["recent"][0]["kills"], 1);
    }

    /// A world with one standing buff, folded from a log whose clock stopped at `ts`.
    fn world_with_one_active(ts: i64) -> Fold {
        let mut fold = Fold::new(registered(ClusterDeps::default()), i64::MAX);
        for line in [
            format!(
                r#"{{"kind":"castBegin","seq":0,"ts":{},"raw":"c","spell":"Clarity"}}"#,
                ts - 100
            ),
            format!(
                r#"{{"kind":"buffApply","seq":1,"ts":{ts},"raw":"a","target":"self","spell":"Clarity","illusion":false,"durationMs":60000,"candidates":[{{"name":"Clarity","durationMs":60000,"illusion":false}}]}}"#
            ),
        ] {
            fold.on_primary(&Event::from_json(&line).expect("object"), false);
        }
        fold
    }

    /// A fold of bytes whose buffs are long expired by wall time still publishes them, because the
    /// fold judges every clock against the log's own last instant. One tick from a clock that has
    /// moved on retires them, which is what the app does at go-live.
    #[test]
    fn a_wall_clock_tick_retires_a_buff_the_log_never_said_expired() {
        let landed = 1_000_000_000;
        let mut fold = world_with_one_active(landed);
        let before = state_of(&fold.registry.snapshots(), "buffs");
        assert_eq!(
            before["active"].as_array().expect("actives").len(),
            1,
            "the fold's own verdict, judged against the log's clock"
        );
        // A day later, by the host's clock and by nothing in the file.
        fold.tick(landed + 24 * 60 * 60 * 1000);
        let after = state_of(&fold.registry.snapshots(), "buffs");
        assert_eq!(after["active"], json!([]));
    }

    /// …and the tick is the only thing that did it: the same world, ticked at the log's own last
    /// instant, is untouched.
    #[test]
    fn a_tick_at_the_logs_own_instant_retires_nothing() {
        let landed = 1_000_000_000;
        let mut fold = world_with_one_active(landed);
        fold.tick(landed);
        let after = state_of(&fold.registry.snapshots(), "buffs");
        assert_eq!(after["active"].as_array().expect("actives").len(), 1);
    }

    /// A tick is not an event: the fold's event count, its last log timestamp, and every module's
    /// published `seq` all hold still. The third matters because the in-app parity probe skips any
    /// module whose two seqs disagree, so a tick that moved one would turn a live comparison into a
    /// permanent skip that reads like agreement.
    #[test]
    fn a_tick_moves_no_seq_no_event_count_and_no_log_clock() {
        let landed = 1_000_000_000;
        let mut fold = world_with_one_active(landed);
        let before = fold.registry.snapshots();
        let (events, last_ts) = (fold.events(), fold.last_ts());
        fold.tick(landed + 24 * 60 * 60 * 1000);
        let after = fold.registry.snapshots();
        assert_eq!(fold.events(), events);
        assert_eq!(fold.last_ts(), last_ts);
        for (b, a) in before["modules"]
            .as_array()
            .expect("modules")
            .iter()
            .zip(after["modules"].as_array().expect("modules"))
        {
            assert_eq!(b["id"], a["id"]);
            assert_eq!(
                b["snapshot"]["seq"], a["snapshot"]["seq"],
                "{} moved its seq on a tick",
                b["id"]
            );
        }
    }

    /// No registered module's tick emits a derived event today. Pinned so the first module that
    /// grows a tick-time emission has to read the queueing rule in `EqModule::on_tick` rather than
    /// discover it in a divergence.
    #[test]
    fn no_modules_tick_emits_a_derived_event_today() {
        let landed = 1_000_000_000;
        let mut fold = world_with_one_active(landed);
        fold.tick(landed + 24 * 60 * 60 * 1000);
        assert!(fold.derived.is_empty(), "{:?}", fold.derived);
    }

    /// …but the door is open and wired: a module that emits on its heartbeat has those events
    /// collected and left on the caller's queue rather than delivered, as `bus.emitDerived` leaves
    /// them for the next `emit`.
    #[test]
    fn a_ticking_module_hands_its_derived_events_to_the_registry() {
        struct Chatty;
        impl EqModule for Chatty {
            fn id(&self) -> &'static str {
                "chatty"
            }
            fn reset(&mut self) {}
            fn on_event(&mut self, _ev: &Event, _live: bool) {}
            fn on_tick(
                &mut self,
                now_ms: i64,
                _rows: &[crate::modules::buff_timer_rows::BuffTimerRow],
            ) {
                let _ = now_ms;
            }
            fn snapshot(&self) -> Value {
                json!({ "seq": 0, "state": {} })
            }
            fn take_derived(&mut self) -> Vec<Event<'static>> {
                vec![Event::from_value(
                    json!({ "kind": "buffExpired", "seq": 7, "ts": 42, "raw": "x" }),
                )]
            }
        }
        let mut r = Registry::new();
        r.register(Box::new(Chatty));
        let mut derived = Vec::new();
        r.tick(1_000, &mut derived);
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].kind(), "buffExpired");
        assert_eq!(derived[0].int("ts"), Some(42));
    }

    /// `fold_bytes` never ticks: a scan advances only off log timestamps, so a world whose buff is
    /// standing at the log's last instant still has it standing after folding a line stamped at
    /// that same instant, however far past it the host's clock is.
    #[test]
    fn a_historical_fold_never_ticks() {
        let parser = eqlog::Parser::new(eqlog::Clock::new(eqlog::host_timezone()), None, None);
        // The instant comes from the parser, not from a number typed here: the line's stamp is
        // resolved through the host's zone, so a hardcoded epoch ms would pin this test to a
        // timezone rather than to the claim.
        let bytes: &[u8] = b"[Wed Aug 19 16:00:00 2026] You gain experience! (3.288%)\n";
        let mut landed = None;
        eqlog::scan::scan_bytes(&parser, bytes, |line, _payload| {
            landed = Event::from_json(line).map(|ev| ev.ts());
        });
        let landed = landed.expect("the parser dated the line");
        let mut fold = world_with_one_active(landed);
        fold.fold_bytes(&parser, bytes);
        assert_eq!(
            state_of(&fold.registry.snapshots(), "buffs")["active"]
                .as_array()
                .expect("actives")
                .len(),
            1,
            "a scan aged nothing by the host's clock"
        );
        // …and the very same world, handed the host's clock once, retires it.
        fold.tick(landed + 24 * 60 * 60 * 1000);
        assert_eq!(
            state_of(&fold.registry.snapshots(), "buffs")["active"],
            json!([])
        );
    }
}
