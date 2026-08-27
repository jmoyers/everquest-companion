//! ============================================================================
//! fold — THE MODULE FOLD, IN RUST (JOS-459 phase 2; cluster 2a is JOS-471).
//! ============================================================================
//!
//! `eqlog` turns bytes into the canonical event stream. This crate is what CONSUMES that stream:
//! the `EqModule` contract (`src/main/modules/types.ts`), a registry that preserves WIRING ORDER
//! (`src/main/modules/wiring.ts`), and one ported module per file under `modules/`.
//!
//! THE BAR IS DEEP EQUALITY, not byte identity — and the difference from phase 1 is a real one.
//! `goldenOracle.mts` records each module's published snapshot into `<slice>.snapshots.json` and
//! compares it with `firstDiff`, because "a snapshot is assembled on demand out of maps and view
//! builders, so key ORDER is not a claim the engine makes". What IS a claim is every ARRAY's order,
//! every number, and which keys exist at all — a field the TS wrote as `undefined` is ABSENT from
//! the golden, so a Rust module that writes `null` there has diverged.
//!
//! ── THE DELIVERY MODEL, and why it is three lines rather than a bus ─────────────────────────────
//!
//! Over there the bus delivers each PRIMARY event to every listener in registration order — the
//! twenty modules first, then the combat engine, then the epoch and offline-gap detectors — and any
//! DERIVED event a listener synthesized is QUEUED and drained afterwards, through the same loop
//! (`main/log/bus.ts`). `Fold` reproduces exactly that shape: dispatch, observe, drain. There is no
//! `LogBus` type here because with one producer of derived events and no re-entrancy there is
//! nothing for one to own; when 2c brings the buffs module (which derives `buffExpired` while
//! folding) the queue is already the field it needs.
//!
//! ── CACHE TRANSPARENCY (ruling 18) ─────────────────────────────────────────────────────────────
//!
//! NO MODULE HERE READS A WALL CLOCK, EVER — it is HANDED one, and only on the live tail. Every
//! time-based rule inside a FOLD (spellSets' settle window, the buffs hygiene sweep, buffTimers'
//! holds) advances off LOG TIMESTAMPS; the wall clock reaches a module through exactly one door,
//! [`Fold::tick`], which the caller drives from its own clock and which a HISTORICAL FOLD NEVER
//! CALLS. `fold_bytes` does not call it and neither does the oracle harness, so the equivalence law
//! is untouched: a fold of the same bytes is the same pure function of those bytes it always was,
//! and the DEFAULT `oracle:rust-fold` staying green is the proof (owner ruling 22, JOS-481). All
//! state lives behind the registry door — there are no statics, no lazily-populated caches keyed by
//! anything but a fold's own inputs, and nothing outlives a `Fold`. `eqlog`'s `OnceLock` regexes
//! are compile-once CONSTANTS, not memoized answers.
//!
//! ── PHASE 3 IS NOT BUILT, BUT IT IS SHAPED ─────────────────────────────────────────────────────
//!
//! `flush_delta` is declared with a default of `None` and no module implements it. Deltas are the
//! transport ticket, not this one; declaring the method now is what makes "add deltas" an edit to
//! nine files rather than a change to the contract every later cluster will have been written
//! against.

pub mod combat;
/// The CLIENT's string table (`dbstr_us.txt`), parsed down to its spell-category namespace — the
/// words behind the integer ids `spells_us.txt` stores (JOS-507). PURE over a string, like
/// `spells_us`; the file belongs to `engined::spells`, which owns the install directory both sit in.
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
/// The CLIENT's spell table (`spells_us.txt`), parsed — boundary verdict 7. PURE over a string; the
/// file and the directory belong to `engined::spells`, exactly as `overlay_file`'s do to
/// `engined::state`. Nothing in the fold reads it: `modules/resist` is emphatic that a fold which
/// never needs the client table can be replayed, shipped and re-estimated without one.
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

    /// Fold one event. `live` gates nothing here — the registry gates the push (JOS-60).
    fn on_event(&mut self, ev: &Event, live: bool);

    /// Optional wall-clock heartbeat, ~1x/sec on the LIVE tail only — `registry.tick(Date.now())`
    /// over there, [`Fold::tick`] here. A HISTORICAL FOLD NEVER CALLS IT, which is what lets every
    /// module keep the cache-transparency promise above: the bytes still decide everything a
    /// replay can observe.
    ///
    /// A TICK'S DERIVED EVENTS ARE COLLECTED AND QUEUED, NOT DELIVERED. No module's `on_tick`
    /// emits one TODAY — MEASURED: the buffs hygiene sweep retires and culls rows, and neither path
    /// synthesizes a `buffExpired` (only a resolved wear-off and the illusion clear do, both
    /// event-driven) — and [`Registry::tick`] takes them anyway, because a contract with a
    /// [`EqModule::take_derived`] door and one caller that silently drops what comes through it is
    /// a defect waiting for the first module that uses it. QUEUED rather than drained is what the
    /// TS does: `bus.emitDerived` pushes onto a queue only `emit` drains, so anything a heartbeat
    /// synthesized reaches the other modules with the NEXT primary event.
    ///
    /// `timer_rows` IS THE `setTimerRows` SEAM (JOS-492), and it is a PARAMETER here because it
    /// cannot be a handle. Over there `wiring.ts` injects a lazy pull into the ALERTS module —
    /// `() => buildTimerRows(buffs.snapshot().state, buffTimers.snapshot().state)` — reaching across
    /// two modules registered after it. A module here cannot hold a mutable-world handle on two
    /// modules the registry is iterating, so [`Registry::tick`] builds the projection ONCE, before
    /// the loop, and hands it to everybody. Nineteen modules ignore it.
    ///
    /// THE INSTANT IS THE ONE THE LAZY PULL WOULD HAVE READ AT: the alerts module is registered
    /// BEFORE buffs and buffTimers, so its heartbeat runs before theirs and the rows it pulls are the
    /// ones the beat started with — the hygiene sweep has not run yet. Building them before the loop
    /// reproduces that exactly, and it does so for every reader rather than for the one that happens
    /// to be first.
    fn on_tick(&mut self, _now_ms: i64, _timer_rows: &[modules::buff_timer_rows::BuffTimerRow]) {}

    /// WOULD THIS MODULE READ THE TIMER PROJECTION ON THE NEXT BEAT? — the LAZINESS half of the
    /// `setTimerRows` seam (JOS-492).
    ///
    /// Over there the pull is a CLOSURE, so not calling it costs nothing; here the rows are a
    /// parameter and something has to decide whether to build them. This is that decision, and it
    /// keeps the TS's own condition rather than approximating it: the projection is built "at most
    /// once per heartbeat and only while an early warning is actually armed".
    ///
    /// `false` FOR NINETEEN MODULES AND FOR THE TWENTIETH TOO, almost always: an ordinary session
    /// has no def carrying an offset and nothing armed, so no beat of it builds a projection at all.
    /// Asking is one bool per module per second, against a fold of a whole `buffs.active` and a whole
    /// CC ledger — which is why the question is worth asking rather than just building them.
    fn wants_timer_rows(&self) -> bool {
        false
    }

    /// Full current state for hydration, plus the last seq folded in: `{ "seq": n, "state": … }`.
    fn snapshot(&self) -> Value;

    /// Everything since the last flush, or `None`. PHASE 3 — see the header. Nothing calls it yet
    /// and no module overrides it; it is here so the contract does not have to change later.
    fn flush_delta(&mut self) -> Option<Value> {
        None
    }

    /// THE DERIVED EVENTS THIS MODULE SYNTHESIZED WHILE FOLDING THE EVENT IT WAS JUST HANDED, in
    /// emission order — `bus.emitDerived` (cluster 2c).
    ///
    /// A HAND-BACK RATHER THAN A CALLBACK, and the difference is ownership rather than taste. Over
    /// there `wiring.ts` injects `emitDerived: (ev, live) => bus.emitDerived(ev, live)` into the
    /// buffs module, so the module holds a reference to the queue and pushes into it mid-fold. A
    /// module here cannot hold a mutable reference to a queue the registry is iterating; so it
    /// buffers its own emissions and the registry takes them the instant `on_event` returns. The
    /// resulting ORDER is identical, and that is the only thing the fold can observe: within one
    /// module, emission order; across modules, registration order; and the whole batch delivered
    /// after the primary event has reached every module, which is exactly `LogBus.emit`'s drain.
    ///
    /// One producer (`buffs`, `buffExpired`). Defaulted empty for the other nineteen.
    fn take_derived(&mut self) -> Vec<Event<'static>> {
        Vec::new()
    }

    /// THE GROUP-ROSTER PULL SEAM (JOS-477 / cluster 2b's `roster` module).
    ///
    /// `pipeline.ts` wires `combat.setRoster(modules.roster)` — the combat engine does not FOLD the
    /// roster, it ASKS the module for it, and it asks DURING the same delivery, after the module
    /// has already advanced for the line (`engine.ts:215`, and `state.ts rosterProvider`'s note
    /// about why a pull rather than a stored copy). Over here the registry has already dispatched
    /// by the time `Fold` hands the event to the engine, so the same guarantee holds for free.
    ///
    /// A DEFAULTED METHOD RATHER THAN A DOWNCAST, so that the one module which can answer it
    /// implements one method and every other module says nothing. Defaulted to `None`, which is
    /// exactly `EMPTY_ROSTER` / `EMPTY_ROSTER_VIEW` at the reading end — an engine constructed
    /// without the seam behaves as it did before the group model existed.
    fn as_roster(&self) -> Option<&dyn combat::RosterSource> {
        None
    }

    /// THE LOOT-LEDGER PULL SEAM (JOS-480 / the view layer's first product source).
    ///
    /// Exactly the shape `as_roster` is, and for exactly its reason: one module can answer, so one
    /// module implements one method and the other nineteen say nothing. A downcast would work and
    /// would put `Any` on a contract whose whole point is that a module is known by what it can
    /// answer rather than by what it is.
    ///
    /// WHY A VIEW DOES NOT READ `snapshot()` INSTEAD. It could — the ledger is in there — but
    /// `snapshot()` builds a fresh JSON tree of EVERY row, and a subscription over a fifty-row
    /// window would pay for the whole log's loot every time it was serviced. The rows are already
    /// in memory in the module's own shape; the seam hands them over rather than a copy of them.
    fn as_loot(&self) -> Option<&modules::loot::LootModule> {
        None
    }

    // ── THE REMAINING VIEW PULL SEAMS (JOS-487) ────────────────────────────────────────────────
    //
    // SIX MORE OF EXACTLY `as_loot`'s SHAPE, and the repetition is the design rather than a thing
    // to factor away. A module is known here by WHAT IT CAN ANSWER, not by what it is; the
    // alternative — one `as_any` and a downcast per source — would put `Any` on a contract whose
    // whole point is that it does not have one, and it would move every "this module cannot answer
    // that" from the compiler to a runtime `None`. Each is `None` for nineteen modules and the
    // real thing for one.
    //
    // WHY A VIEW DOES NOT READ `snapshot()` INSTEAD is `as_loot`'s answer, and it is sharper here:
    // `respawn.snapshot()` builds sixty rows AND forty candidates AND the whole preference blob to
    // answer a question about sixty rows, and it would do it at the serve cadence.

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

    /// THE RESPAWN WRITE SEAM (JOS-494) — `as_respawn`'s mirror, and a SEPARATE method rather than
    /// a `&mut` on that one.
    ///
    /// The split is the same law `engined::ingest`'s two doors are built on: an `Ask` is handed the
    /// fold by `&` and an `ingest::Write` by `&mut`, so which door a request belongs on is decided
    /// by the compiler rather than by a convention. Here that law reaches one module. Every one of
    /// the seven `as_*` pull seams above serves a VIEW and may only read; `respawn.confirmSighting`
    /// is the only thing a person can press that reaches this module without being a preference,
    /// and it MOVES a clock. Widening `as_respawn` to `&mut` for its sake would have let a view
    /// mutate the world it is drawing, and nothing but a comment would have said not to.
    fn as_respawn_mut(&mut self) -> Option<&mut modules::respawn::RespawnModule> {
        None
    }

    // ── THE PERSISTED-KNOWLEDGE SEAMS (JOS-496 item 3) ─────────────────────────────────────────
    //
    // TWO MODULES OWN AN ARTIFACT THE APP KEEPS IN `userData` — `resist` owns `resist-ledger.json`
    // and `buffs` owns the mined half of `message-overlay.json` — and both are read at attach and
    // written on a cadence. They need a `&mut` seam for the seed and a `&` seam for the write, and
    // the split is `as_respawn` / `as_respawn_mut`'s law rather than a new one: a reader may not
    // mutate the world it is serializing.
    //
    // NOTHING IN THIS CRATE CALLS THEM. `registered()` cannot reach a directory and does not know
    // one exists, so the world the six goldens were recorded in is still exactly what the parity
    // runner and every fold test build — `install_knowledge`'s argument, applied to a second thing
    // the app knows and the fold cannot derive.

    /// The resist ledger, to be SEEDED from the app's persisted file.
    fn as_resist_mut(&mut self) -> Option<&mut modules::resist::ResistModule> {
        None
    }

    /// The resist ledger, to be WRITTEN.
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

    /// THE MODULE'S PUBLISHED CURSOR, WITHOUT BUILDING ITS STATE (JOS-487) — the module dirty bit.
    ///
    /// It is exactly the `seq` [`EqModule::snapshot`] puts in its answer: for most modules the seq
    /// of the last event folded, and for the four that publish a private revision counter (combo,
    /// character, respawn, buffTimers) that counter. THE POINT IS THAT IT IS CHEAP. The serve loop
    /// asks every module this once per beat to decide which ones to announce, and asking through
    /// `snapshot()` would serialize twenty modules' whole state ten times a second to compare
    /// twenty integers.
    ///
    /// `None` MEANS "THIS MODULE DOES NOT ANNOUNCE", which is an honest answer rather than a
    /// silent one: `Registry::published_seqs` reports what it was told and nothing about what it
    /// was not, so a module that gains state without gaining this method goes quiet rather than
    /// claiming to be unchanged. All twenty implement it.
    fn published_seq(&self) -> Option<i64> {
        None
    }

    /// THE LIVE `/con`s THIS MODULE SAW WHILE FOLDING THE EVENT IT WAS JUST HANDED (JOS-487,
    /// boundary verdict 2).
    ///
    /// A HAND-BACK RATHER THAN A CALLBACK, exactly like [`EqModule::take_fires`] and for the same
    /// ownership reason — and, over there, in place of the hook `pipeline.ts` installs INTO the
    /// module. One producer (`consider`), defaulted empty for the other nineteen, and structurally
    /// empty for every historical fold: a con card is live-only by the same boundary law a fire is.
    fn take_cons(&mut self) -> Vec<modules::consider::ConEvent> {
        Vec::new()
    }

    /// THE APP-KNOWLEDGE SEAM (JOS-482, boundary verdict 3) — the one door a `*.define` command
    /// reaches a module through.
    ///
    /// Exactly the shape `as_roster` and `as_loot` are, and for exactly their reason: a handful of
    /// modules can answer, so those modules implement one method and the rest say nothing. What is
    /// different is the MUTABILITY, and that is the whole of what a define is — the app telling the
    /// fold something the log cannot.
    ///
    /// FIVE FAMILIES, ONE PER MODULE (see [`Defines::family`]). The mapping is total and static, so
    /// `Registry::define` is a lookup rather than a negotiation.
    fn as_defines(&mut self) -> Option<&mut dyn Defines> {
        None
    }

    /// THE ALERT FIRES THIS MODULE PRODUCED WHILE FOLDING THE LIVE EVENT IT WAS JUST HANDED, in
    /// emission order (JOS-482, owner ruling 22).
    ///
    /// A HAND-BACK RATHER THAN A CALLBACK, exactly like [`EqModule::take_derived`] and for the same
    /// ownership reason: a module cannot hold a mutable reference to a queue the registry is
    /// iterating, so it buffers its own and the caller takes them. Unlike `take_derived` these do
    /// not re-enter the bus — a fire leaves the process — so they are drained by the INGEST at its
    /// own boundary rather than by `Fold::on_primary`.
    ///
    /// One producer (`alerts`). Defaulted empty for the other nineteen, and structurally empty for
    /// every historical fold: firing is live-only by the boundary law.
    fn take_fires(&mut self) -> Vec<modules::alerts_rules::Fire> {
        Vec::new()
    }

    /// THE OWN-LOOT PULL SEAM (JOS-486) — what YOU have looted, off every corpse.
    ///
    /// The `as_roster`/`as_loot` shape a third time: one module owns the index (`consider`, which
    /// also owns its character-scoped and epoch-scoped lifetime), so that module implements one
    /// method and the other nineteen say nothing. It is the READ side only — the fold is the one
    /// writer, and a knowledge join that could write into it would be a second owner of a lifetime
    /// whose whole point is that it has one.
    fn as_own_loot(&self) -> Option<&dyn knowledge::OwnLoot> {
        None
    }

    /// INSTALL THE KNOWLEDGE LOOKUPS — the injected `deps.lookupItem` / `deps.lookupMob` this
    /// module's TypeScript twin takes, arriving after construction rather than through
    /// [`ClusterDeps`].
    ///
    /// A SEAM AND NOT A CONSTRUCTION PARAMETER, for the reason `setConCardHook` is one over there
    /// and for one this crate cares about more: `ClusterDeps` is spelled as a struct LITERAL by the
    /// parity runner, so a field added to it would have to be answered there — and the one answer
    /// the oracle may ever give is "absent". A seam nobody calls in that construction cannot be
    /// half-answered. Exactly one caller installs it: `engined::foldsink::registry_for`.
    ///
    /// Defaulted to a no-op, which is the eighteen modules that have nothing to ask.
    fn install_knowledge(&mut self, _k: &Arc<dyn knowledge::Knowledge>) {}
}

/// WHAT A MODULE DOES WITH APP KNOWLEDGE. One method, one law.
///
/// A DEFINE IS AN IDEMPOTENT FULL-SET REPLACE. Not a delta, not a merge: the payload is the whole
/// of what this family knows, so pushing A and then B leaves exactly what pushing B alone would
/// have left. That is the cutover ledger's command law and it buys three things — a crash-respawn
/// is a replay of the latest push, an order of arrival cannot matter, and the input is hash-friendly
/// for ruling 18's eventual cache key.
///
/// THE PAYLOAD IS A `Value` AND THAT IS DELIBERATE. These shapes are the STORE's contract rather
/// than the protocol's (the `Cells` argument), so the module reads what it needs out of the JSON the
/// way `Event` reads what a module needs out of an event — one reader, at the place that knows what
/// the fields mean, rather than a typed mirror in the protocol crate that would have to be kept in
/// step with a settings file.
pub trait Defines {
    /// The family this module answers to: `alerts`, `buffTrust`, `respawn`, `combo`, `roster` —
    /// the `*.define` op's own prefix, so the wire name and the module's claim on it are one string.
    fn family(&self) -> &'static str;

    /// Take the whole set. A payload this module cannot read leaves it exactly as it was, which is
    /// the honest outcome for app knowledge that arrived malformed: the previous set is still the
    /// last thing the user actually said.
    fn define(&mut self, payload: &Value);
}

/// REGISTRATION ORDER = BUS DELIVERY ORDER, and it is load-bearing — `src/main/modules/wiring.ts`
/// `ordered`, verbatim, all twenty.
///
/// It is spelled here IN FULL rather than as "the ones we have ported", so that the set this crate
/// does not implement yet is a fact the code states rather than a gap a reader has to notice. The
/// parity harness reads `missing()` off it and prints every absent module BY NAME (the no-silent-
/// caps law): a comparator that quietly compared nine modules and said GREEN would be claiming
/// coverage it does not have.
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

    /// Register in delivery order. It is the CALLER's job to register in `WIRING_ORDER` — see
    /// `registered`, which is the one caller that matters and which asserts it.
    pub fn register(&mut self, m: Box<dyn EqModule>) {
        self.mods.push(m);
    }

    pub fn reset(&mut self) {
        for m in &mut self.mods {
            m.reset();
        }
    }

    /// Deliver one event to every module, in order, appending whatever any of them SYNTHESIZED
    /// while folding it to the caller's derived queue (see `EqModule::take_derived`). The queue is
    /// the caller's because it is the bus's: `Fold` owns it and drains it, and a module that emits
    /// while a drain is running appends to the very queue being drained — which is what
    /// `LogBus.drain`'s shift-until-empty does.
    pub fn dispatch(&mut self, ev: &Event, live: bool, derived: &mut Vec<Event<'static>>) {
        for m in &mut self.mods {
            m.on_event(ev, live);
            let mut out = m.take_derived();
            if !out.is_empty() {
                derived.append(&mut out);
            }
        }
    }

    /// [`Registry::dispatch`] with a stopwatch around each module — THE MEASUREMENT INSTRUMENT
    /// (JOS-504) and nothing else: `parity --stages` is its one caller, the sink receives
    /// `(module index, nanoseconds)` per delivery, and the delivery semantics are line-for-line
    /// `dispatch`'s. Kept as a SECOND function rather than a flag on the first so the production
    /// dispatch never pays two clock reads per module per event; if `dispatch` changes, this
    /// changes with it or the attribution is measuring a pipeline that no longer exists.
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

    /// THE WALL-CLOCK HEARTBEAT, fanned over every module in WIRING ORDER — `registry.tick`'s own
    /// loop (`src/main/modules/registry.ts`), minus the half that is not this crate's.
    ///
    /// Over there the method is `for (const mod of this.modules) mod.onTick?.(nowMs)` followed by
    /// `this.doFlush()`. The FIRST line is this; the second is the delta push, which no module here
    /// implements (`flush_delta` is declared and unimplemented — see the crate header) and which is
    /// the transport's business rather than the fold's. So a tick here advances the model and
    /// publishes nothing: whoever asks for a snapshot next sees the aged state, which is exactly
    /// what a pull-based server wants.
    ///
    /// DERIVED EVENTS ARE COLLECTED THE WAY `dispatch` COLLECTS THEM and for the same reason — a
    /// module cannot hold a mutable reference to the queue the registry is iterating — but they are
    /// NOT drained here. See [`EqModule::on_tick`] for why the door is opened for a producer that
    /// does not exist yet, and for why leaving them QUEUED is the ported behaviour rather than an
    /// omission.
    ///
    /// NOT GATED ON A REPLAY FLAG. `registry.ts` opens with `if (this.replaying) return`, which is
    /// the structural half of "never tick during a historical fold"; over here the historical fold
    /// is `fold_bytes`, which does not call this at all, so the guard has nothing to guard. The
    /// caller drives the clock and the caller is the live tail.
    pub fn tick(&mut self, now_ms: i64, derived: &mut Vec<Event<'static>>) {
        // THE TIMER PROJECTION, BUILT ONCE AND BEFORE THE LOOP (JOS-492) — see
        // [`EqModule::on_tick`] for why it is a parameter rather than a handle, and for why this
        // instant is the one the TS's lazy pull would have read at.
        let rows = self.timer_rows();
        for m in &mut self.mods {
            m.on_tick(now_ms, &rows);
            let mut out = m.take_derived();
            if !out.is_empty() {
                derived.append(&mut out);
            }
        }
    }

    /// THE TIMER-ROW PROJECTION over whatever this build registered — `buildTimerRows(buffs,
    /// buffTimers)`, the same one `engined`'s `timers.rows` source cuts windows out of.
    ///
    /// EMPTY WHEN EITHER HALF IS ABSENT, which is the honest answer rather than a partial one: a
    /// projection built from buffs alone would state ends for the beneficial half and silently know
    /// nothing about the crowd-control half, and an early warning measured against it would be right
    /// about mez and wrong about slow. Every production construction registers both.
    ///
    /// …AND EMPTY WHEN NOBODY ASKED, which is the LAZINESS the TS's pull has and this must not lose:
    /// over there the closure "is called from `onTick` and from nowhere else, at most once per
    /// heartbeat and only while an early warning is actually armed". [`EqModule::wants_timer_rows`]
    /// is that condition, asked of every module for the cost of a bool, so an ordinary session — no
    /// offset on any def, nothing armed — builds NO projection on any beat.
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

    /// The registered module that answers the roster pull, or `None` when none does (2b has not
    /// landed, or this build registered a cluster without it). One linear scan over at most twenty
    /// modules, made once per delivery — the TS's `rosterProvider` closure costs a call too.
    pub fn roster(&self) -> Option<&dyn combat::RosterSource> {
        self.mods.iter().find_map(|m| m.as_roster())
    }

    /// The registered module that answers the loot-ledger pull, or `None` when none does — the
    /// same linear scan `roster` is, made once per view service rather than once per event.
    pub fn loot(&self) -> Option<&modules::loot::LootModule> {
        self.mods.iter().find_map(|m| m.as_loot())
    }

    /// The registered module that answers the buff pull (JOS-487). Same linear scan as `loot`.
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

    /// THE SAME MODULE, TO BE WRITTEN TO (JOS-494) — see [`EqModule::as_respawn_mut`] for why the
    /// read and the write are two seams. `None` for a registry that carries no respawn module,
    /// which is the honest answer rather than an absence: a confirmation with nothing to confirm
    /// re-based no clock, exactly as [`Registry::define`] answers `false` for a family nobody
    /// claims.
    pub fn respawn_mut(&mut self) -> Option<&mut modules::respawn::RespawnModule> {
        self.mods.iter_mut().find_map(|m| m.as_respawn_mut())
    }

    /// The registered module that owns the resist ledger, to be READ (JOS-496 item 3).
    pub fn resist(&self) -> Option<&modules::resist::ResistModule> {
        self.mods.iter().find_map(|m| m.as_resist())
    }

    /// SEED THE APP'S PERSISTED KNOWLEDGE, THEN NAME THIS FOLD'S OWN SOURCE (JOS-496 item 3).
    ///
    /// ONE CALL, BECAUSE THE ORDER IS THE WHOLE POINT and splitting it would let a caller get it
    /// wrong. Every persisted bucket goes back first; `key`'s bucket is discarded second, because
    /// the log about to be folded is going to state that bucket's entire content again. Reversed,
    /// this character would be seeded with counts its own fold is about to re-derive — the JOS-231
    /// doubling, measured at 22 → 44 → 88 across three cold launches before the register existed.
    ///
    /// A bucket for a character you are NOT folding survives untouched, and that is not an
    /// oversight: nothing can re-derive it. That asymmetry is what the per-source register is FOR.
    ///
    /// THE ONE CALLER IS `engined::foldsink`, and it calls this only when the attach carried a
    /// `stateDir`. With no state dir there are no sources, and the `begin_source` half alone is
    /// unobservable — every published surface (`resist.snapshot`'s two integers, the overlay in
    /// `buffs.snapshot`) sums across buckets, so which single bucket a lone fold writes into cannot
    /// be seen. The six goldens are recorded through `registered()`, which cannot reach this.
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

    /// EVERY REGISTERED MODULE'S PUBLISHED CURSOR, in delivery order — the module dirty bit's whole
    /// read (JOS-487). See [`EqModule::published_seq`] for why it is not `snapshot()["seq"]`.
    ///
    /// A module that answers `None` is ABSENT from this list rather than present with a zero: the
    /// serve loop announces a CHANGE, and a module that will not state a cursor has said nothing
    /// that could have changed.
    pub fn published_seqs(&self) -> Vec<(&'static str, i64)> {
        self.mods
            .iter()
            .filter_map(|m| m.published_seq().map(|seq| (m.id(), seq)))
            .collect()
    }

    /// EVERY LIVE `/con` ANY MODULE SAW SINCE THE LAST DRAIN, in registration order. Empty for
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

    /// GIVE EVERY MODULE THAT ASKS THE KNOWLEDGE LOOKUPS — see [`EqModule::install_knowledge`].
    ///
    /// THE ONE CALLER IS THE PRODUCTION CONSTRUCTION. `engined::foldsink::registry_for` calls this
    /// immediately after `registered()`; the parity runner, the bench arm and every test in this
    /// crate call it nowhere, so the world the six goldens were recorded in is the world they are
    /// still compared against. That is not a convention — `registered()` cannot reach a corpus, and
    /// this crate cannot even name the one that holds them.
    pub fn install_knowledge(&mut self, k: &Arc<dyn knowledge::Knowledge>) {
        for m in &mut self.mods {
            m.install_knowledge(k);
        }
    }

    /// ONE MODULE'S PUBLISHED SNAPSHOT, by the id it answers to — `{ "seq": …, "state": … }`, the
    /// same pair [`Registry::snapshots`] collects and the same one the goldens join on.
    ///
    /// `None` for a name nothing registered, and that is the ANSWER rather than an absence to be
    /// papered over: the registry is the authority on what a module is (JOS-478's `module.snapshot`
    /// turns this into the protocol's `notFound`), and an empty state would be a lie about a module
    /// that does not exist. Note that a `WIRING_ORDER` name this build has not registered answers
    /// `None` too — a module that is not folding has no state, whatever the wiring says it will.
    ///
    /// A LINEAR SCAN over at most twenty entries, made once per request rather than once per event,
    /// exactly as `Registry::roster` is.
    pub fn snapshot_of(&self, id: &str) -> Option<Value> {
        self.mods
            .iter()
            .find(|m| m.id() == id)
            .map(|m| m.snapshot())
    }

    /// PUSH ONE FAMILY OF APP KNOWLEDGE INTO THE MODULE THAT OWNS IT (JOS-482).
    ///
    /// `false` for a family no registered module claims, which is the answer rather than an
    /// absence: the registry is the authority on what a module is, exactly as it is for
    /// `snapshot_of`. A linear scan over at most twenty entries, made a handful of times per
    /// session rather than once per event.
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

    /// EVERY ALERT FIRE ANY MODULE PRODUCED SINCE THE LAST DRAIN, in registration order. Empty for
    /// every historical fold — see [`EqModule::take_fires`].
    pub fn take_fires(&mut self) -> Vec<modules::alerts_rules::Fire> {
        let mut out = Vec::new();
        for m in &mut self.mods {
            out.append(&mut m.take_fires());
        }
        out
    }

    /// Every id `WIRING_ORDER` names that nothing registered — the harness's SKIPPED list.
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
    /// THE POST-REGISTRY SUBSCRIBER (JOS-477). `pipeline.ts:311,326` and `foldArm.mts construct()`
    /// both subscribe the combat engine to the bus AFTER `registry.attach(bus)` and BEFORE the
    /// epoch/offline-gap detectors, and that position is load-bearing in two directions: the
    /// twenty modules have all folded the line before the engine sees it (which is what makes the
    /// roster PULL answer for the same line), and the engine's own work happens before any derived
    /// event the detectors synthesize off it.
    ///
    /// AN `Option` FIELD RATHER THAN A LISTENER VECTOR, because the engine is not only dispatched
    /// to — it is READ BACK, exactly as `foldArm.mts`'s `World { bus, combat, registry }` hands the
    /// engine out so its snapshots can be taken. A `Vec<Box<dyn …>>` would deliver the events and
    /// then have nothing to hand the recorder. `None` on every 2a/2b/2c call site, and `None` means
    /// the fold behaves precisely as it did before this field existed.
    pub combat: Option<combat::CombatEngine>,
    epoch: epoch::EpochDetector,
    /// The OFFLINE-GAP detector (JOS-475). `index.ts` subscribes it after the epoch detector and it
    /// hands its gap back through the same `emitDerived`, so it is queued in that order here too.
    /// TWO clusters need it: `progression` publishes every gap's contents verbatim in three columns
    /// and `roster` marks members stale across one (2b), and `buffs` folds it to PAUSE every
    /// beneficial buff by the length of the absence (2c) — see `session.rs`.
    sessions: session::SessionDetector,
    /// The bus's derived queue. THREE producers, exactly as over there: the registry's own modules
    /// (`buffs`, whose `buffExpired` cluster 2c brought), the epoch detector, and the offline-gap
    /// detector.
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

    /// Subscribe the combat engine behind the registry (see the field). Builder-shaped so the
    /// existing `Fold::new` call sites do not move — the parallel-worker fence.
    pub fn with_combat(mut self, engine: combat::CombatEngine) -> Self {
        // ONLY the engine it just installed. `Fold::new` has already reset the world, and a SECOND
        // `registry.reset()` is a call no composition root makes — `foldArm.mts construct` resets
        // the registry once and the engine once.
        //
        // MEASURED, JOS-475: it was invisible while every module's `reset()` was idempotent, and it
        // is not once a module's REVISION COUNTER is published as its `seq`. Cluster 2b has three
        // (combo, character, respawn — the JOS-87 rule), and the double reset put every one of them
        // exactly ONE ahead of the golden on all six slices. Resetting only the new field is both
        // the fix and what the builder was always describing.
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

    /// How many PRIMARY events were folded — `ScanResult.seq`.
    pub fn events(&self) -> u64 {
        self.events
    }

    /// THE HIGHEST TIMESTAMP ANY EVENT CARRIED — `goldenOracle.mts`'s `lastTs`, which is the
    /// instant the combat snapshot is taken at. Accumulated with `max` rather than "the last one",
    /// exactly as the recorder's bus listener does (`if (ev.ts > lastTs) lastTs = ev.ts`): the
    /// stream is not guaranteed monotonic across a log rollover, and the snapshot's `now` must not
    /// be able to travel backwards because one line did.
    pub fn last_ts(&self) -> i64 {
        self.last_ts
    }

    /// One primary event: deliver it, then drain whatever anybody queued through the SAME delivery.
    /// That is `LogBus.emit` exactly.
    ///
    /// THE ORDER OF THE THREE PRODUCERS IS THE SUBSCRIPTION ORDER, and it decides the queue's
    /// order: the twenty modules first (so a `buffExpired` precedes both detectors' output for the
    /// same primary event), then the epoch detector, then the offline-gap detector — which is how
    /// `foldArm.mts construct` subscribes them, and therefore how the goldens were recorded.
    pub fn on_primary(&mut self, ev: &Event, live: bool) {
        self.events += 1;
        self.last_ts = self.last_ts.max(ev.ts());
        self.observe(ev, live);
        // Shift-until-empty, so anything a derived event queues IN TURN is delivered too — and it
        // can: `buffs` folds an `epoch` by clearing its live state, and a censored instance is
        // still an instance that may announce its own end.
        let mut i = 0;
        while i < self.derived.len() {
            let d = self.derived[i].clone();
            i += 1;
            self.observe(&d, live);
        }
        self.derived.clear();
    }

    /// One delivery: every module, then every detector. Used for a primary event and for each
    /// event of the drain alike, because the bus makes no distinction between them — the detectors
    /// are ordinary subscribers and they refuse the derived kinds BY NAME rather than by position
    /// (`epochDetector.observe`'s first line, `sessionDetector.observe`'s).
    fn observe(&mut self, ev: &Event, live: bool) {
        self.registry.dispatch(ev, live, &mut self.derived);
        // …then the engine, which is the next subscriber on the bus (see the `combat` field). The
        // two field borrows are disjoint, which is what lets the engine pull the roster out of the
        // registry that has just finished folding this same line.
        //
        // A DERIVED EVENT REACHES IT TOO, and that is why this is one function rather than two:
        // `LogBus.emit` drains through the same listener loop, and `epoch` is a kind the engine
        // handles BY NAME (it drops the fight, the zone and the world), so delivering a boundary to
        // the modules alone would leave the engine holding a dead character's encounter.
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

    /// ONE WALL-CLOCK TICK OVER THE WHOLE WORLD (owner ruling 22, JOS-481) — `session.ts`'s
    /// `registry.tick(Date.now())`, which the app runs once at go-live and then ~1×/sec while the
    /// LIVE tail is running, and never during a replay.
    ///
    /// THE EQUIVALENCE LAW IS UNTOUCHED, and this is the paragraph that says why. A historical fold
    /// is [`Fold::fold_bytes`], which does not call this; the six-slice oracle records its goldens
    /// through that path and nothing else; so the fold of a given log is still a pure function of
    /// its bytes and every cache-transparency law above still holds (ruling 18 law 1). What a tick
    /// changes is a LIVE world, which the oracle has never described and cannot: the app's own fold
    /// has been aged by a wall clock since JOS-149, and an engine that did not do the same would be
    /// serving state the app would have retired seconds ago. That divergence was MEASURED — the
    /// in-app parity probe caught `buffs.active` at 12 rows engine-side against 3 app-side on a
    /// fixture whose buffs are long expired by wall time (JOS-479) — and this is its resolution.
    ///
    /// THE COMBAT ENGINE IS NOT TICKED, and that is a fact about the TS rather than a fence: the
    /// heartbeat over there is `registry.tick` and nothing else — `session.ts startHeartbeat` calls
    /// it alone, `CombatEngine` declares no `onTick`, and `pipeline.ts` subscribes the engine to the
    /// bus and to no clock. So an engine ticked here would be doing something its oracle never did.
    /// If one ever grows a heartbeat, this is the one line that changes.
    pub fn tick(&mut self, now_ms: i64) {
        self.registry.tick(now_ms, &mut self.derived);
    }

    /// Fold a complete log through `eqlog::scan`. Historical, so `live` is false from the first
    /// byte to the last — exactly what a startup replay is. NEVER TICKS: see [`Fold::tick`].
    ///
    /// STREAMED, never collected. A slice folds to hundreds of thousands of events and holding
    /// them as parsed values at once costs more than the machine has — `goldenOracle.mts`'s rule
    /// about its own artifacts, and it applies just as hard to the fold's input.
    pub fn fold_bytes(&mut self, parser: &eqlog::Parser, bytes: &[u8]) {
        eqlog::scan::scan_bytes(parser, bytes, |_json, payload| {
            self.on_primary(&Event::typed(payload), false);
        });
    }

    /// [`Fold::fold_bytes`] with per-consumer attribution — THE MEASUREMENT INSTRUMENT (JOS-504),
    /// `parity --stages`'s second half. Returns nanoseconds per registered module (delivery
    /// order), for the combat engine, for the two detectors, and for `Event::from_json`. The bus
    /// semantics are `on_primary`/`observe`'s exactly — primaries then a shift-until-empty drain —
    /// restated here with stopwatches because a flag on the production path would make every
    /// ordinary fold pay the clock reads. OBSERVER COST, stated: ~2 clock reads per consumer per
    /// event (~40-60 ns a pair), inflating each bucket equally by well under a second across a
    /// 2.5M-event log — shares are trustworthy, absolutes are a shade high.
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
            // THE RE-PARSE IS GONE (JOS-505) and the bucket stays, reading zero, because the
            // attribution table is compared against JOS-504's baseline table and a row that
            // vanished would read as a row nobody measured. It is now the cost of WRAPPING the
            // parser's payload, which is a discriminant copy and a reference.
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

/// THE APP'S PERSISTED KNOWLEDGE, ALREADY PARSED — what [`Registry::seed_persisted`] puts back.
///
/// IT IS NOT A FIELD OF [`ClusterDeps`], and that is the determinism law made structural rather
/// than promised. `ClusterDeps` is what `registered()` takes, and `registered()` is what the parity
/// runner, the bench arm and every test in this crate call; a seed field on it would be a door a
/// file could walk through into the world the six-slice oracle records. So the seed arrives AFTER
/// construction, from the one caller that was handed a `stateDir` — exactly as the knowledge corpus
/// does, and for exactly that reason (`install_knowledge`).
///
/// Both halves are DEFAULT-EMPTY, and an empty seed is not the same act as no seed at all: the
/// `begin_source` half still runs, because naming this fold's own bucket is right whether or not
/// anything was seeded into a neighbouring one.
#[derive(Debug, Default)]
pub struct PersistedState {
    /// `<userData>/resist-ledger.json`'s buckets, the shipped baseline's already refused.
    pub resist: Vec<modules::resist::ledger_file::LedgerSource>,
    /// `<userData>/message-overlay.json`'s buckets, keyed by the source that produced them. The key
    /// travels with the counts because merging two origins under one key would put the fold's own
    /// output back in the pile it is seeded from, which is the JOS-231 defect.
    pub overlay: Vec<(String, Vec<message_overlay::SeedMessage>)>,
}

/// EVERYTHING THE CLUSTER NEEDS FROM OUTSIDE ITSELF — `wiring.ts ModuleWiringDeps`, minus the
/// seams no ported module has yet.
///
/// It is a STRUCT rather than a parameter list because it is the thing later clusters grow: 2c and
/// 2d each bring modules with their own construction inputs, and a struct means they add a FIELD
/// and a registration line instead of re-threading every call site.
///
/// Every field is a fact about the RUN rather than about the log's bytes, which is what makes it a
/// parameter at all — and each of them is derived by the caller exactly as `foldArm.mts` /
/// `goldenOracle.mts` derive it, because the goldens were recorded under those derivations.
#[derive(Default)]
pub struct ClusterDeps {
    /// `wiring.ts` `knownSpell: (key) => spellDb.byKey.has(key)`, passed as the key SET rather than
    /// as a closure so nothing in this crate borrows the parser.
    pub known_spell: HashSet<String>,
    /// `spellClasses.ts`'s canon-key → class-set index, built once off the same DB (evidence.rs).
    pub spell_classes: modules::combo::evidence::SpellClassIndex,
    /// `epochDetector.ts LAUNCH_MS`, resolved through the fold's own zone.
    pub launch_ms: i64,
    /// `WorldOpts.constructionNowMs` — the PINNED construction clock the respawn module seeds its
    /// ordering clock from. See `modules/respawn.rs`'s header for why it cannot be a wall clock.
    pub construction_now_ms: i64,
    /// The `CharacterRef` `index.ts` pushes in with `setCharacter`, derived from the log's filename.
    pub character: Option<Value>,
    /// `roster.setSelfName` — `session.ts`'s line. THE BENCH DOES NOT CALL IT, so the parity runner
    /// passes `None` and the recorded goldens are what that produces (roster.rs's header).
    pub self_name: Option<String>,
    /// `deps.respawnPrefs` — the shipped default is an EMPTY watch list and that is what every
    /// non-Electron caller passes.
    pub respawn_prefs: modules::respawn::RespawnPrefs,
    /// `deps.spellDb` one size up from `known_spell` — the whole of `db.byKey`, projected into the
    /// scalar facts the BUFFS model reads (`spell_facts.rs`), because `wiring.ts` hands the spell
    /// database itself to that module. An EMPTY one is the TS's absent `db?`: every read answers
    /// nothing, which is exactly what a caller with no catalog gets over there.
    pub facts: spell_facts::SpellFacts,
}

/// EVERY PORTED MODULE, registered in `WIRING_ORDER`'s relative order — which since JOS-476 is all
/// twenty of them.
///
/// The name has moved twice and for the same reason both times: it was `cluster_2a` while nine
/// modules were all there was, then `cluster_2a_2b`, and a registry that names the tickets IN it is
/// a registry a reader has to date. `Registry::missing()` is the half that still says what a given
/// build did not register, and it is the half the parity report prints.
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
    // combo goes FIRST (design § 5.1): within one bus delivery every later module — and the combat
    // engine, which folds the same event afterwards — then sees an already-advanced combo state.
    r.register(Box::new(modules::combo::ComboModule::new(
        spell_classes,
        launch_ms,
    )));
    // roster goes SECOND for the same reason: the engine's admission gate pulls the roster through
    // a seam installed before it ever folds a line, so the roster must already be advanced.
    r.register(Box::new(modules::roster::RosterModule::new(
        self_name.as_deref(),
    )));
    r.register(Box::new(modules::loot::LootModule::new()));
    r.register(Box::new(modules::turnins::TurnInsModule::new()));
    r.register(Box::new(modules::class_unlocks::ClassUnlocksModule::new()));
    r.register(Box::new(modules::kills::KillsModule::new()));
    // Beside `kills` because it folds the SAME death line — and AFTER it, so anything reading both
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
    // THE SHARED HALVES (JOS-140 ruling 1). `wiring.ts` constructs the crowd-control module FROM the
    // buffs module's own anchors and learner (`new BuffTimersModule(buffs.castAnchors(),
    // buffs.spellStats())`), so the two cannot end up with two ideas of whose spell just landed or
    // how long it lasts. One `Rc<RefCell<…>>`, cloned into both, is that line.
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

    /// The registered cluster is a SUBSEQUENCE of the wiring order, and everything else is named.
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
        // ALL TWENTY, since JOS-476 — so `missing()` is empty and the SKIP line is a statement
        // that nothing was skipped rather than an absent line. The assertion is written against
        // `WIRING_ORDER.len()` rather than against 20, so a module ADDED to the wiring over there
        // fails here until it is ported, which is the whole no-silent-caps mechanism.
        assert_eq!(ids.len(), WIRING_ORDER.len());
        assert!(r.missing().is_empty(), "{:?}", r.missing());
        // combo and roster are the two whose POSITION is load-bearing rather than free.
        assert_eq!(ids[0], "combo");
        assert_eq!(ids[1], "roster");
        // …and eventFeed stays LAST: a row appended while an earlier module's delta is being
        // emitted still rides out on the same flush pass.
        assert_eq!(ids[ids.len() - 1], "eventFeed");
    }

    /// A loot row is tagged with the zone the module was standing in, and an absent optional field
    /// is OMITTED rather than written as null — the golden was recorded through `JSON.stringify`.
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

    /// The credit join claims BACKWARD, consumes the line, and every death consumes — including
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
        // The two casings fold into ONE entry under the canonical key; the `slain by You` twin is
        // not counted, so the count is 1 and the display is the FIRST spelling seen.
        assert_eq!(mobs["a froglok"]["count"], 1);
        assert_eq!(mobs["a froglok"]["display"], "A Froglok");
        assert_eq!(mobs["a froglok"]["bestTier"], jsfn::TIER_UNKNOWN);
    }

    /// A load opens a window; the burst settles ten quiet seconds later and the definition is
    /// stamped with the SETTLE time, not the load line's.
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

    /// `tier` is the HIGHEST ever observed; `lastTier` is the raw sequence's most recent.
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

    /// An ordinary loot of a ` +N` drop is NOT evidence; a 'combined' one is, through `created`.
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
        // A rank the log has only ever CAST is still known, catalog or no catalog.
        assert_eq!(rows["lay on hands"]["castRank"], 9);
        assert!(rows["lay on hands"].get("mergedRank").is_none());
        // An unsuffixed cast mints nothing — rank 1 is the default state, not an observation.
        assert!(rows.get("clarity").is_none(), "{rows}");
        // The merge lane is gated on the catalog…
        assert!(rows.get("gold plated koshigatana").is_none(), "{rows}");
        // …and the union takes the highest of the two halves, from YOUR cast only.
        assert_eq!(rows["shiftless deeds"]["mergedRank"], 3);
        assert_eq!(rows["shiftless deeds"]["castRank"], 4);
        assert_eq!(rows["shiftless deeds"]["rank"], 4);
        assert_eq!(rows["shiftless deeds"]["merges"], 1);
        assert_eq!(rows["shiftless deeds"]["name"], "Shiftless Deeds");
    }

    /// The epoch event is DERIVED, drains after the primary event, and drops every
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
        // The pre-launch loot went with the epoch; the post-launch row is the only survivor. Note
        // the boundary event fires ON the ts:1500 loot line and is drained AFTER it, so that row
        // is cleared too — which is exactly what the TS does.
        assert_eq!(state_of(&snaps, "loot"), json!([]));
        assert_eq!(state_of(&snaps, "leveling")["levels"], json!([]));
        // …and the dump receipt outlives the epoch on purpose: the FILE outlives it too.
        assert_eq!(state_of(&snaps, "outputFiles")["inventory.txt"], 600);
    }

    /// A trade only closes the offer group that names the same NPC — but it always drops it.
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

    /// A module whose state moves ONLY on events reports the seq of the LAST event it was handed,
    /// derived events included — and FOUR of them deliberately do not (JOS-87).
    ///
    /// `combo`, `character` and `respawn` each have a SECOND INPUT that advances no log seq (a user
    /// correction, `setCharacter`, a watch edit), and `buffTimers` has `onTick`, which expires holds
    /// on a log that is idle — which is precisely when someone is watching a mez run out. Each
    /// reports a private revision counter instead. `useModule` dedupes with `d.seq <= knownSeq`, so
    /// publishing the event seq there would let the renderer drop the very push that carries the
    /// out-of-band change. The distinction is a CONTRACT, not an accident, so the test names both
    /// sides — and `buffTimers` is the one the goldens catch outright, recording 0 for three of the
    /// six slices.
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
                // CONSTRUCTION spent: one `reset()` apiece, plus `character`'s `setCharacter` —
                // which the composition root always makes, ref or no ref — and NONE for
                // `buffTimers`, whose `reset()` zeroes the counter rather than spending it.
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

    // ── CLUSTER 2c (JOS-476) ──────────────────────────────────────────────────────────────────

    /// The cast-recency map keeps the RANK, refuses a stamp that went backwards, and survives the
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

    /// A slow proc mints the recency record, and a LATER one moves the target while an out-of-order
    /// one only counts.
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

    /// One row per mob, newest LAST, and a re-con moves the row rather than keeping its place —
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
        // Voidling is now FIRST because the re-con moved the goblin to the end.
        assert_eq!(rows[0]["id"], "voidling");
        // …and the row that moved carries the newest con's facts under the LOWERCASE spelling,
        // which `adoptDisplay` prefers over the sentence-cased first sighting.
        assert_eq!(rows[1]["mob"], "a goblin priest");
        assert_eq!(rows[1]["cons"], 2);
        assert_eq!(rows[1]["level"], 21);
        assert_eq!(rows[1]["zone"], "Permafrost Keep");
        // A con with no level states none rather than claiming zero.
        assert!(rows[0].get("level").is_none(), "{rows}");
        assert!(rows[0].get("knowledge").is_none(), "{rows}");
    }

    /// The feed admits NOTHING historical, and its seq is still every event's — the hydration rule,
    /// and the reason all six goldens record `[]` beside a live seq.
    #[test]
    fn the_event_feed_stays_empty_through_a_historical_fold() {
        let snaps = fold_lines(&[
            r#"{"kind":"consider","seq":0,"ts":10,"raw":"c","mob":"a rat","rare":false,"faction":"indifferent","difficulty":"???"}"#,
            r#"{"kind":"loot","seq":7,"ts":20,"raw":"l","item":"Bone Chips","source":"a rat"}"#,
        ]);
        assert_eq!(state_of(&snaps, "eventFeed"), json!([]));
    }

    /// EVERY primary event reaches the offline-gap detector, which is the wiring half of the
    /// second derived event this cluster brings. The rule it applies is proven in `session.rs`;
    /// what this pins is that `Fold` feeds it at all, and that the anchor a fold hands it is the
    /// line about YOU rather than the reconnect preamble's chat noise.
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

    // ── THE BUFFS MODEL (JOS-476) ─────────────────────────────────────────────────────────────
    //
    // These drive hand-written NDJSON through the registry with an EMPTY catalog, which is the TS's
    // absent `db?`: every DB read answers nothing, so a landing has to state its own duration to
    // open a row. That is enough to exercise every law below, and it keeps the fixtures readable —
    // the catalog's own contribution is what the six slices prove.

    /// AN UNANCHORED LANDING PRODUCES NOTHING (ruling 3) — the whole of the attribution gate. The
    /// same sentence with a cast line in front of it opens a row.
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
        // THE IDENTITY IS THE DB CANDIDATE'S NAME AND THE RANK RIDES BESIDE IT (JOS-238).
        assert_eq!(active[0]["castName"], "Clarity II");
        assert_eq!(active[0]["self"], true);
        assert_eq!(active[0]["startedTs"], 1000);
        assert_eq!(active[0]["messageDriven"], true);
        // No sample yet, so the number is the landing's own stated duration and nothing else.
        assert_eq!(active[0]["n"], 0);
    }

    /// A LAND→FADE PAIR MINTS ONE DURATION SAMPLE, and the wear-off resolves against the ACTIVE set
    /// rather than guessing the first candidate — the defect that left self Quickness standing
    /// forever because `Aanya's Quickening` was never the one that was up.
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

    /// THE WEAR-OFF IS SYNTHESIZED BACK ONTO THE BUS AS A RESOLVED `buffExpired` (Task #47), and it
    /// is DRAINED after the primary event — so every module registered before `buffs` sees it, in
    /// the same order the TS bus delivers it.
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
        // Stamped with the PRIMARY event's identity, which is what lets it slot into the stream.
        assert_eq!(derived[0].seq(), 2);
        assert_eq!(derived[0].ts(), 50000);
        assert_eq!(derived[0].raw(), "Clarity wore off you.");
    }

    /// AN OFFLINE GAP PAUSES A BUFF AND NOT A DEBUFF, and it CENSORS the sample either way — the two
    /// halves of JOS-134, and the reason the offline-gap detector had to come with this cluster.
    #[test]
    fn an_absence_rewinds_a_buffs_clock_and_leaves_a_debuffs_alone() {
        let mut fold = Fold::new(registered(ClusterDeps::default()), i64::MAX);
        for line in [
            // The anchor, the landing, and an in-world line to give the detector something to
            // measure the absence FROM.
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

    /// A CROWD-CONTROL HOLD IS ANCHOR-GATED TOO, and closing it mints into the SAME learner the
    /// buffs half reads — the JOS-140 unification, which is what the shared core exists for.
    #[test]
    fn a_mez_cycle_mints_into_the_shared_learner() {
        let snaps = fold_lines(&[
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Mesmerization VII"}"#,
            r#"{"kind":"cc","seq":1,"ts":2000,"raw":"m","mob":"a spiroc banisher","verb":"mesmerized","candidates":[{"name":"Mesmerization","durationMs":24000}]}"#,
            r#"{"kind":"cc","seq":2,"ts":46000,"raw":"r","mob":"a spiroc banisher","refresh":true,"spell":"Mesmerization"}"#,
        ]);
        // The hold closed, so nothing is standing…
        assert_eq!(state_of(&snaps, "buffTimers")["holds"], json!([]));
        // …and the 44 s cycle reached the BUFFS module's stats table, under the rank the cast line
        // named (JOS-411) rather than the rank-less landing sentence's.
        let row = &state_of(&snaps, "buffs")["stats"]["mesmerization"];
        assert_eq!(row["spell"], "Mesmerization VII");
        assert_eq!(row["n"], 1);
        assert_eq!(row["maxMs"], 44_000);
    }

    /// A STRANGER'S MEZ FILLS NOBODY'S OVERLAY, and the refusal still moves the revision counter
    /// when a break line arrives — which is what the goldens' non-zero `seq` on two slices is.
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

    // ── resist (JOS-476 cluster 2c) ────────────────────────────────────────────────────────────
    //
    // The published surface is two integers, so every law below is stated as a claim about how many
    // POOLING KEYS the ledger holds and how many creatures they are about — which is exactly what
    // the golden pins.

    /// A ROW'S TARGET HAS TO BE A CREATURE. A groupmate's landing and your own self-damage are the
    /// two shapes that put a person's name in a published file, and both are refused; a mob's is
    /// filed. All three lines are otherwise identical.
    #[test]
    fn a_resist_row_is_only_ever_filed_about_a_creature() {
        let snaps = fold_lines(&[
            r#"{"kind":"resist","seq":0,"ts":1000,"raw":"r","caster":"You","target":"a froglok ton knight","spell":"Malosi","incoming":false}"#,
            r#"{"kind":"resist","seq":1,"ts":2000,"raw":"r","caster":"You","target":"Dranix","spell":"Malosi","incoming":false}"#,
            r#"{"kind":"resist","seq":2,"ts":3000,"raw":"r","caster":"You","target":"You","spell":"Malosi","incoming":false}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 1, "mobs": 1 }));
    }

    /// YOUR RESISTS ONLY. `You resist <mob>'s <Spell>!` is the incoming form and a different feature
    /// entirely, so it files nothing at all.
    #[test]
    fn an_incoming_resist_is_yours_and_is_never_filed() {
        let snaps = fold_lines(&[
            r#"{"kind":"resist","seq":0,"ts":1000,"raw":"r","caster":"a froglok ton knight","target":"You","spell":"Fear","incoming":true}"#,
        ]);
        assert_eq!(state_of(&snaps, "resist"), json!({ "rows": 0, "mobs": 0 }));
    }

    /// THE RANK AND THE INVOCATION ARE POOLING TERMS (JOS-387). Three casts of one spell on one mob
    /// that differ only in the rank the line printed, or in whether overchannel was up, are THREE
    /// rows — they rolled against different resist adjusts and may not be pooled. The mob count
    /// stays at one, which is what says the split is about the roll and not about the creature.
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

    /// THE WEEK IS IN THE KEY (JOS-397), and it is the one term that is not about `rc`. Two
    /// identical resists a fortnight apart are two rows, because a row that pooled them would have
    /// no age to weigh. The instant comes off the LOG's clock, never a wall clock.
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

    /// ONE CAST IS ONE ROLL. A nuke prints its damage line FIRST and its landing emote after, and
    /// the emote is the same roll saying so twice — so the deferred landing is cancelled and the
    /// pair leaves exactly one row behind. (The `damaged` set on the armed cast is what does it;
    /// the cancel-forward rule alone never fires, because the game's order is always damage-then-
    /// emote.)
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

    // ── THE `*.define` SEAM (JOS-482) ──────────────────────────────────────────────────────────
    //
    // ONE WORKED EXAMPLE PER FAMILY, each asserting that the push moves the module the TypeScript
    // seam moves — `ipc/alerts.ts setDefs`, `ipc/buffTrust.ts setTrust`, `ipc/respawn.ts setPrefs`,
    // `ipc/combo.ts setCorrection`, `ipc/roster.ts setEdit`. They live HERE, over hand-written
    // events, because a claim about what a preference does to a fold is sharpest when the event it
    // does it to is written out: the socket suite in `engined` proves the push TRAVELS.

    /// Push one family's set into a registry and take the snapshots.
    ///
    /// THE LAUNCH ANCHOR IS STATED IN BOTH PLACES, and that is not redundancy: the epoch DETECTOR
    /// takes it from `Fold::new` while `combo` takes it from its own construction, and a correction
    /// older than the launch describes the wiped beta character. A world where the two disagreed
    /// would refuse a correction the boundary then kept, or the reverse.
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

    /// `alertsModule.setDefs(list)` — the store's list, published back verbatim, EXTRAS AND ALL.
    /// A def carries fields no evaluator reads, and the module's `defs` is what the app's alert
    /// list is drawn from, so anything dropped in transit would be an alert the user re-opened and
    /// found rewritten.
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

    /// A HISTORICAL FOLD MAKES NO SOUND, however many defs are loaded — the boundary law, which is
    /// also what keeps the six-slice oracle looking at the module it always looked at.
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

    /// `buffsModule.setTrust(next)` — an allowlisted caster's cast ANCHORS a landing, and a
    /// stranger's still does not. The `cc` event is written out with its candidates so the claim is
    /// about the ALLOWLIST rather than about which spells share an emote in the committed catalog.
    #[test]
    fn a_pushed_buff_trust_admits_an_external_casters_anchor() {
        const LINES: [&str; 2] = [
            r#"{"kind":"otherCastBegin","seq":0,"ts":2000,"raw":"c","caster":"Dranix","spell":"Mesmerization"}"#,
            r#"{"kind":"cc","seq":1,"ts":3000,"raw":"m","mob":"a spiroc banisher","verb":"mesmerized","candidates":[{"name":"Mesmerization","durationMs":24000}]}"#,
        ];
        // THE CONTROL FIRST: under the shipped default the allowlist is empty, so a stranger's cast
        // anchors nothing and the mez opens no hold (JOS-140 ruling 3).
        let mut stranger = Fold::new(registered(ClusterDeps::default()), 1000);
        for line in LINES {
            stranger.on_primary(&Event::from_json(line).expect("object"), false);
        }
        assert_eq!(
            state_of(&stranger.registry.snapshots(), "buffTimers")["holds"],
            json!([])
        );

        // …and with the name pushed, the IDENTICAL rule admits it — not a looser one.
        let snaps = folded_with("buffTrust", json!({ "externals": ["Dranix"] }), &LINES);
        let holds = state_of(&snaps, "buffTimers")["holds"].clone();
        assert_eq!(holds.as_array().map(Vec::len), Some(1), "{holds}");
        assert_eq!(holds[0]["key"], "a spiroc banisher", "{holds}");
    }

    /// `respawnModule.setPrefs(next)` — the watch list is the ONLY admission rule, so the same
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

    /// A watch payload is NORMALIZED the way `shared/respawn.ts` normalizes it — at both ends, so a
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
        // A CLASS OBSERVATION FIRST, because a correction RE-LABELS an interval and does not conjure
        // one: the log has to have said something about the loadout before there is anything for the
        // user to disagree with. Coating your own blades is the observation that needs no catalog —
        // only rogues have poison disciplines on Legends.
        //
        // TWO OF THEM, because the launch anchor is 1000 here and the first event past it fires the
        // rebirth boundary — which clears the observation it fired on, exactly as it does for every
        // other character-scoped module. The second coat is the new world's.
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

    /// A correction is REFUSED WHOLE rather than filtered — `ipc/combo.ts`'s door rule, restated at
    /// the engine's door because a define is a second door onto the same state.
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
    /// rung, and a name it DID name can be removed. The edits are a LAYER over the log, so the
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

    /// AN EDIT OLDER THAN THE LAST REBIRTH DESCRIBED A DEAD CHARACTER'S GROUP, and the fold drops
    /// it by DATE rather than by deleting it — the list belongs to the app.
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

    /// EVERY FAMILY IS CLAIMED BY EXACTLY ONE MODULE, and a name nothing claims is refused rather
    /// than silently dropped — the `snapshot_of` rule, one direction reversed.
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

    /// A CAST THAT NEVER HAPPENED IS NOT A RESIST: a fizzle disarms, so the landing sentence that
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

    /// A DEBUFF WINDOW IS A POOLING TERM. The same resist before and after a tash lands on the mob
    /// is two rows, and the window closes on the LOG's clock — eleven minutes later the third
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

    /// A DoT'S FIRST TICK IS THE LANDING and the rest are the same roll — but the ROW is minted
    /// either way, which is why one cast and three ticks is one row rather than none. A fresh cast
    /// re-arms the memory, and it still pools into the same key.
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

    /// A PROC IS NOT A CAST SPELL, and the log has no field that says so — what it has is the CAST
    /// LINE, which a proc never prints. So an observation that joins an armed cast carries that
    /// cast's invocation (here UNKNOWN, because nothing has stated one) and an observation that
    /// joins none answers `false`, and the two are different keys. Same spell, same mob, same
    /// week — two rows, because they are two different claims about the roll.
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

    /// THE MODULE DOES NOT RESET AT AN EPOCH BOUNDARY. What a mob resists is GAME knowledge and a
    /// rebirth does not unlearn it — so the pre-launch row survives the boundary that empties loot
    /// and leveling, and the module still reports the seq of the last event it was handed.
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

    /// A ZONE LINE IS A DISCONTINUITY: it decides the deferred landing outright rather than waiting
    /// out the three-second window, and it drops every open debuff. The landing therefore lands, and
    /// the resist that follows it in the new zone pools with no debuff on the key.
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

    // ── CLUSTER 2b (JOS-475) ──────────────────────────────────────────────────────────────────

    /// A login after a long silence synthesizes an `offlineGap`, and `progression` publishes the
    /// instants it carries — the columns are a record of what the log said, and the absence is a
    /// thing the log said (JOS-475: the producer this cluster had to bring with it).
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
        // `expPct` is the one true f64 in the stream, so it is compared as a NUMBER: serde writes
        // `2.0` where `JSON.stringify` writes `2`, and both parse to the same double — which is
        // exactly what the phase-2 comparator does with them (it diffs two PARSED values).
        assert_eq!(p["recentKills"][0]["expPct"].as_f64(), Some(2.0));
        assert_eq!(p["recentKills"][0]["expFlag"], 0);
    }

    /// A group line names a member and an offline gap marks them STALE rather than removing them —
    /// hiding a real member is the worse error, and is the bug the feature exists to fix.
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

    /// A `/who` row states the level at its own instant and OUTRANKS a ding in the same second; the
    /// epoch drops the wiped character's zone and level and KEEPS the ref.
    ///
    /// Note the zone line that triggers the boundary: the derived event drains AFTER it, so that
    /// zone goes with the dead character too, and the first zone the surviving character has is the
    /// next line. Same shape as the 2a loot case, and the same reason.
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

    /// A watch list nobody filled in clocks NOTHING — the opt-in ruling — while the recent-kills
    /// candidate list still offers every mob the fold has seen die.
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

    // ── THE LIVE TICK (JOS-481, owner ruling 22) ──────────────────────────────────────────────

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

    /// THE ACCEPTANCE CLAIM IN MINIATURE (JOS-479's measured divergence, resolved). A fold of bytes
    /// whose buffs are long expired by WALL time still publishes them — correctly, because the fold
    /// judges every clock against the log's own last instant. One tick from a clock that has moved
    /// on retires them, which is exactly what the app's `registry.tick(Date.now())` does at go-live.
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
        // A DAY LATER, by the host's clock and by nothing in the file.
        fold.tick(landed + 24 * 60 * 60 * 1000);
        let after = state_of(&fold.registry.snapshots(), "buffs");
        assert_eq!(after["active"], json!([]));
    }

    /// …and the tick is the ONLY thing that did it: the same world, ticked at the log's own last
    /// instant, is untouched. Stated separately because "the sweep works" and "the sweep needs a
    /// clock that has actually moved" are two different ways this could pass for the wrong reason.
    #[test]
    fn a_tick_at_the_logs_own_instant_retires_nothing() {
        let landed = 1_000_000_000;
        let mut fold = world_with_one_active(landed);
        fold.tick(landed);
        let after = state_of(&fold.registry.snapshots(), "buffs");
        assert_eq!(after["active"].as_array().expect("actives").len(), 1);
    }

    /// A TICK IS NOT AN EVENT, and three counters say so: the fold's event count, the fold's last
    /// log timestamp, and every module's published `seq`. That third one is load-bearing rather than
    /// tidy — the in-app parity probe SKIPS any module whose two seqs disagree, so a tick that moved
    /// a seq would turn a live comparison into a permanent skip that reads like agreement.
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

    /// NO REGISTERED MODULE'S TICK EMITS A DERIVED EVENT TODAY, and that is MEASURED rather than
    /// assumed: the buffs sweep RETIRES and CULLS rows, and neither path synthesizes a
    /// `buffExpired` — only a resolved wear-off and the illusion clear do, and both are event
    /// driven. Pinned so that the first module that grows a tick-time emission has to come back and
    /// read the queueing rule in `EqModule::on_tick` rather than discover it in a divergence.
    #[test]
    fn no_modules_tick_emits_a_derived_event_today() {
        let landed = 1_000_000_000;
        let mut fold = world_with_one_active(landed);
        fold.tick(landed + 24 * 60 * 60 * 1000);
        assert!(fold.derived.is_empty(), "{:?}", fold.derived);
    }

    /// …but the DOOR is open and wired, which is the half a live registry cannot demonstrate. A
    /// module that emits on its heartbeat has those events COLLECTED — the same hand-back
    /// `dispatch` performs — and left on the caller's queue rather than delivered, exactly as
    /// `bus.emitDerived` leaves them for the next `emit`.
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

    /// `fold_bytes` — THE HISTORICAL PATH, AND THE EQUIVALENCE LAW. It never ticks: a scan advances
    /// only off LOG timestamps, so a world whose buff is standing at the log's last instant still
    /// has it standing after folding a line stamped at that same instant — even though the HOST's
    /// clock is years past it (the line below is dated 2026 and the world's instant is derived from
    /// it). This is the unit-sized statement of what `oracle:rust-fold` proves over six slices.
    #[test]
    fn a_historical_fold_never_ticks() {
        let parser = eqlog::Parser::new(eqlog::Clock::new(eqlog::host_timezone()), None, None);
        // THE INSTANT COMES FROM THE PARSER, not from a number typed here: the line's stamp is
        // resolved through the HOST's zone, so a hardcoded epoch ms would pin this test to a
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
        // …and the very same world, handed the host's clock ONCE, retires it.
        fold.tick(landed + 24 * 60 * 60 * 1000);
        assert_eq!(
            state_of(&fold.registry.snapshots(), "buffs")["active"],
            json!([])
        );
    }
}
