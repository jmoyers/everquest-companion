//! ============================================================================
//! THE FOLD, PLUGGED IN (JOS-459 phase 3 first light, JOS-478).
//! ============================================================================
//!
//! `ingest` decides who is folding; `fold` decides what a fold IS. This file is the whole of what
//! joins them: one `impl EventSink for` a fold, and one factory that builds the twenty-module
//! registry out of what an attach knows. It lives in THIS crate because the orphan rule requires it
//! — neither trait nor type is ours to put anywhere else — and it is deliberately the only place
//! either crate's construction is spelled.
//!
//! ── WHAT AN ATTACH BUILDS, AND WHERE EACH INPUT COMES FROM ─────────────────────────────────────
//!
//! `fold::ClusterDeps` is "everything the registry needs from outside the log". Five of its eight
//! fields are facts about COMMITTED DATA and are derived here from the parser's own catalog; the
//! remaining three are APP KNOWLEDGE and are empty on purpose. That split is boundary verdict 3 —
//! the engine never reads a settings file — and it is stated per field below rather than left to be
//! inferred from a `Default::default()`.
//!
//! **THE THREE EMPTY ONES ARE THE NEXT TICKET'S `*.define` COMMANDS.** `respawn_prefs` (the watch
//! list), `self_name` (`roster.setSelfName`, which `session.ts` pushes in app-side), and the
//! `character` ref's app-supplied half all arrive as commands when the app connects. Until then
//! this engine is built exactly as `tests/bench/foldArm.mts construct()` builds the bench world —
//! which is not a coincidence and not a shortcut: the bench world is the one the six-slice
//! equivalence oracle recorded its goldens under, so an engine that matched anything else would be
//! provably right about a world nobody has measured. Alert definitions, buff trust, combo
//! corrections and roster edits are the same story one level up: their modules are registered and
//! folding, and what they are missing is the app's pushed state, not their own logic.
//!
//! **THE CHARACTER REF IS DERIVED, NOT PUSHED**, and that one is not app knowledge: `{ name,
//! server, logPath }` comes off the log's FILE NAME, which is the same fact the parser already
//! derives its character from. Two ways of stating one identity is a way for them to disagree.
//!
//! ── THE CONSTRUCTION CLOCK IS THE ATTACH INSTANT, and that is production-faithful ──────────────
//!
//! `respawn` seeds an ordering clock from `WorldOpts.constructionNowMs` at `reset()`. The golden
//! recorder PINS that to the slice's last timestamped line, and `fold`'s README is emphatic about
//! why — a golden recorded under `Date.now()` would stop re-checking tomorrow. That pin is a
//! property of the ORACLE, not of the product: production TypeScript constructs its world with
//! `Date.now()` and always has, so a live engine seeding from the wall clock at attach is doing
//! exactly what the app does at launch. `ingest::SinkInputs::attached_at_ms` is that instant, read
//! once, on the ingest thread, and it is the only wall clock any of this reaches — every
//! time-based rule inside the fold advances off LOG timestamps (ruling 18 law 1).
//!
//! ── THE COMBAT ENGINE IS REGISTERED HERE NOW (JOS-485), AND IT IS ONE BUILDER CALL ─────────────
//!
//! JOS-478 left this off and said what turning it on would take: *"one builder call
//! (`Fold::with_combat`) plus a source per surface, and nothing else here moves."* That is exactly
//! what happened. It is still not a MODULE — `WIRING_ORDER` does not name it, `Registry::snapshot_of`
//! cannot answer for it, and `module.snapshot` refuses the name `combat` on purpose — so it reaches
//! clients through surfaces of its own: the op `combat.snapshot`, the op `combat.searchFights`, and
//! the view source `combat.live`.
//!
//! **THE PRODUCTION CONSTRUCTION IS `parity`'s, LINE FOR LINE**, and that is deliberate rather than
//! convenient: `engine/crates/parity/src/main.rs` is what the six-slice oracle runs, so a
//! production engine built any other way would be an engine the oracle has never described. New,
//! `reset()`, `set_player_name` off the log's own file name, then `with_combat` — which resets the
//! engine again by itself, which is why the name is injected before it and re-seeded by it, exactly
//! as `foldArm.mts construct()` does. `setCombo`, `setDerivedEmitter` and `setHeldClickies` are
//! called there by nobody and by nobody here.
//!
//! **THE COUPLING IS ONE-WAY AND CHECKED.** `Fold::observe` hands the engine the registry's roster
//! and no module reads the engine, so a fold WITH it publishes exactly what a fold without it
//! publishes — which is what keeps `module.snapshot`, `loot.ledger` and the equivalence oracle
//! untouched by this change. What it costs is real and is not hidden: every event now also folds
//! through the combat engine, which is the same work `parity` measures and the same work the app
//! has always done on its own thread.
//!
//! ── THE INSTANT A COMBAT ANSWER IS TAKEN AT, AND WHY THIS FILE IS WHERE IT IS DECIDED ──────────
//!
//! `combat.snapshot(now, opts)` app-side is `combat.snapshot(Date.now(), opts)` — the wall clock,
//! every poll. `goldenOracle.mts` passes the slice's LAST EVENT TS instead, and `fold::combat`'s
//! header is emphatic that this is not a recording convenience: the hydrating gate, the deferred
//! encounter closure, the charm sweep and the ally-bind expiry all evaluate against `now`, so a
//! REPLAY stamped with a host clock finalizes whatever fight was open and hands the rest of it to a
//! fresh encounter (MEASURED app-side: one 53,577-damage fight splitting into 43,504 + 10,073).
//!
//! Both are right, for different worlds, and the discriminator is **whether this fold has reached
//! its tail**. This file can answer that structurally rather than by asking: `EventSink::tick` is
//! called only while the status is `live` — the historical scan does not call it, cannot reach it,
//! and must not — so "has this sink ever been ticked" IS "is this world live", stated by the one
//! call that could set it. See [`FoldSink::live`].
//!
//! **THE HISTORICAL PATH IS THEREFORE UNCHANGED AND THE ORACLE IS UNTOUCHED.** A fold that never
//! ticks answers every combat question at `fold.last_ts()`, which is the number `goldenOracle.mts`
//! passes — so a mid-scan `combat.snapshot` is a pure function of the bytes folded so far (ruling
//! 18 law 1) and re-asking it at the same `seq` gives the same answer. The wall clock enters
//! exactly where it already entered: a live world, which the oracle has never described.
//!
//! ── …AND THE SAME TICK IS WHERE THE ENGINE IS TOLD (JOS-488) ───────────────────────────────────
//!
//! JOS-485 shipped the instant and left the flag: `hydrating` was true in every answer this engine
//! gave, because the four snapshot-time sweeps were unported and clearing the flag without them
//! would have promised a liveness the fold did not have. Both halves land here now. `EventSink::tick`
//! calls `CombatEngine::set_live()` on its first beat — the same call `session.ts` makes at the end
//! of its scan, in the same position relative to the heartbeat — and `fold::combat` runs the charm
//! sweep, the ally-bind expiry, the pet nudge and the deferred encounter closure at the instant every
//! live answer is taken.
//!
//! The discriminator does not change and neither does its argument: ONE FLAG, set by the one call a
//! historical scan cannot reach, deciding both what `now` means and whether the model may be aged at
//! it. That is why they are the same flag — a world entitled to a wall clock is exactly a world
//! entitled to age itself against one.

use std::collections::HashSet;

use crate::ingest::{
    CombatOpts, CombatSnapshot, Event, EventSink, FightHit, FightSearch, ModuleSnapshot,
    SinkFactory, SinkInputs, SinkReport,
};
use crate::views;

/// The factory `main.rs` hands the world: every attach folds the whole registry.
#[must_use]
pub fn folding_sinks() -> SinkFactory {
    std::sync::Arc::new(|inputs| Box::new(FoldSink::new(inputs)))
}

/// THE PROCESS'S KNOWLEDGE CORPUS.
///
/// One `Arc`, handed to the registry at every attach and held by the world for the `knowledge.*`
/// ops. It is the SAME instance both times — a second corpus would be a second overlay, so a name
/// the app pushed in answer to a miss would be a hit on one path and a miss on the other, forever.
///
/// THE CONCRETE TYPE, NOT THE TRAIT. `fold::knowledge::Knowledge` carries only what a MODULE needs
/// to ask (an item, a mob, the identity keys, the miss ledger), and deliberately so — the fold has
/// no business knowing a spell catalog or a search exist. The world answers ops off the wider
/// surface and hands the registry the narrower one, which is one value seen two ways rather than
/// two values.
#[must_use]
pub fn corpus() -> std::sync::Arc<knowledge::Corpus> {
    knowledge::shared()
}

/// One attach's fold, and the counters the ingest reports off it.
pub struct FoldSink {
    fold: fold::Fold,
    /// The process's corpus, kept so this sink can drain its miss ledger at the ingest's boundary.
    /// The SAME instance the registry was handed — see [`corpus`].
    knowledge: std::sync::Arc<knowledge::Corpus>,
    /// THE PARSER'S OWN CLOCK, kept because a VIEW has to render an instant (JOS-480).
    ///
    /// The one thing a view source needs that the fold does not: `loot.ledger`'s `at` cell is the
    /// wall clock the log's timestamps were read in, and reading it through a second clock built
    /// from the same zone would be a second answer waiting to disagree — the same argument the
    /// spell DB's single copy makes one level up. It is the ZONE that is load-bearing here, never a
    /// wall-clock READ: nothing in this file asks what time it is now.
    clock: eqlog::Clock,
    /// HAS THIS WORLD REACHED ITS TAIL? — the whole of the `now` decision (see the module header).
    ///
    /// Set by `tick` and by nothing else, which is what makes it structural: the tick is called
    /// once at go-live and ~1×/sec after, and the historical scan has no path to it. So a fold that
    /// is still scanning cannot have this set, and a fold that has gone live cannot have it clear.
    live: bool,
    /// THE APP'S `userData`, and this generation's memory of what it last wrote there (JOS-496
    /// item 3). `None` when the attach carried no `stateDir`, which is every attach but the app's —
    /// and which means this fold neither read a file nor will write one. See [`crate::state`].
    state: Option<crate::state::StateDir>,
    /// HOW MANY BEATS THIS WORLD HAS TAKEN — half of `combat.live`'s revision signal.
    ///
    /// The meter's rows are a function of the events folded AND of the instant they are read at: a
    /// fight's `durationSec` grows with `now` while the log says nothing, which is why the app polls
    /// its own snapshot on a 1 s interval rather than on its tailer. Counting beats and adding them
    /// to the event count gives the view layer a signal that moves on both — an event, or a second
    /// of a live world — and never repeats across either.
    beats: u64,
}

impl FoldSink {
    /// Build the registry this attach folds into. See the module header for every input.
    #[must_use]
    pub fn new(inputs: &SinkInputs<'_>) -> Self {
        let launch_ms = fold::epoch::launch_ms(inputs.clock);
        let mut fold = fold::Fold::new(registry_for(inputs, launch_ms), launch_ms)
            .with_combat(combat_for(inputs));
        // ── THE APP'S PERSISTED KNOWLEDGE, PUT BACK BEFORE THE FIRST BYTE (JOS-496 item 3) ─────
        //
        // Read, seed, then name this fold's own bucket — [`fold::Registry::seed_persisted`] does
        // the last two as one call because their ORDER is the whole of JOS-231 and splitting them
        // would let a caller get it wrong. It happens HERE, after `Fold::new`, because `new`
        // resets every module and `ResistModule::reset` discards its own source's bucket; a seed
        // that ran before it would be thrown away by it.
        //
        // NONE OF THIS RUNS WITHOUT A `stateDir`. The whole block is inside the `Option`, so a fold
        // with no state directory is byte-for-byte the fold this file built before the ticket — no
        // read, no source rename, no write — which is what keeps the equivalence oracle's world
        // reachable structurally rather than by care.
        let state = inputs.state_dir.map(|dir| {
            let store = crate::state::StateDir::new(dir);
            fold.registry
                .seed_persisted(&source_key(inputs), &store.read());
            store
        });
        Self {
            fold,
            clock: eqlog::Clock::new(inputs.clock.tz()),
            live: false,
            beats: 0,
            knowledge: corpus(),
            state,
        }
    }

    /// THE INSTANT A COMBAT ANSWER IS TAKEN AT. See the module header for the whole argument.
    ///
    /// The process's own wall clock once the tail is running — which is `Date.now()` at
    /// `src/main/ipc/world.ts:23`, read fresh per answer exactly as that handler reads it — and the
    /// fold's own `last_ts` before that, which is the number `goldenOracle.mts` passes and the only
    /// honest instant for a replay.
    fn combat_now(&self) -> i64 {
        if self.live {
            crate::ingest::wall_clock_ms()
        } else {
            self.fold.last_ts()
        }
    }
}

/// The combat engine one attach folds into, constructed as `parity` constructs it.
///
/// `reset()` then `set_player_name` BEFORE the builder, because `with_combat` resets what it is
/// given and `CombatEngine::reset` re-seeds an injected name by itself — so this is one ordering
/// stated twice rather than two orderings. The name is the log's own file name's, the same fact the
/// parser derives its character from and the same one `goldenOracle.mts characterOf` reads off a
/// slice filename; a second spelling of "whose log is this" is a way for the two to disagree.
fn combat_for(inputs: &SinkInputs<'_>) -> fold::combat::CombatEngine {
    let mut engine = fold::combat::CombatEngine::new();
    engine.reset();
    if let Some(name) = inputs.character {
        engine.set_player_name(name);
    }
    engine
}

/// `ClusterDeps`, assembled — the one place either crate's construction is spelled.
///
/// ── AND THE ONE PLACE THE KNOWLEDGE LOOKUPS ARE INSTALLED (JOS-486) ────────────────────────────
///
/// `Registry::install_knowledge` is called HERE and in no other construction in this repo. That is
/// the ticket's condition and it is structural rather than conventional: `fold::registered()` —
/// which the parity runner, the bench arm and every fold test call — cannot reach a corpus, because
/// the `fold` crate cannot name the crate that holds one (the dependency runs `knowledge → fold`).
/// So the world the six goldens were recorded in is still exactly what those callers build:
/// `consider` with no `lookupMob` and `eventFeed` with no `lookupItem`, which is what `foldArm.mts`
/// passes and what every golden records (`knowledge` absent from every consider row, the feed `[]`).
/// The proof is the DEFAULT `oracle:rust-fold` staying green.
///
/// A PRODUCTION FOLD DIFFERS FROM THAT WORLD ONLY ON THE LIVE TAIL. Both probes sit behind the
/// `live` gate — the feed admits nothing historical at all, and consider enriches live cons plus a
/// bounded backfill on the first WALL-CLOCK TICK, which `fold_bytes` never calls. A historical fold
/// with a corpus installed is byte-for-byte the same fold as one without, which is the property the
/// oracle checks and the reason this line is safe to write.
fn registry_for(inputs: &SinkInputs<'_>, launch_ms: i64) -> fold::Registry {
    let mut registry = fold::registered(cluster_deps(inputs, launch_ms));
    let lookups: std::sync::Arc<dyn fold::knowledge::Knowledge> = corpus();
    registry.install_knowledge(&lookups);
    registry
}

/// The deps themselves. Split from `registry_for` so the install above reads as the one extra act
/// it is, rather than hiding at the bottom of a forty-line struct literal.
fn cluster_deps(inputs: &SinkInputs<'_>, launch_ms: i64) -> fold::ClusterDeps {
    fold::ClusterDeps {
        // ── committed data, read off the parser's OWN catalog ──────────────────────────────────
        // The SAME database the parser is emitting `candidates` out of, never a second load: two
        // loads is two answers waiting to disagree after an overlay change (`Parser::spell_db`
        // says so at the accessor).
        known_spell: inputs
            .db
            .map(|db| db.keys().map(str::to_string).collect::<HashSet<String>>())
            .unwrap_or_default(),
        spell_classes: inputs
            .db
            .map(fold::modules::combo::evidence::spell_class_index)
            .unwrap_or_default(),
        facts: inputs
            .db
            .map(fold::spell_facts::SpellFacts::project)
            .unwrap_or_default(),
        // ── facts about THIS run ───────────────────────────────────────────────────────────────
        launch_ms,
        construction_now_ms: inputs.attached_at_ms,
        // The identity the log's own file name states. `server_of` answering `None` is the honest
        // outcome for a name that carries no server, and it becomes an empty string exactly as the
        // golden recorder's does.
        character: inputs.character.map(|name| {
            serde_json::json!({
                "name": name,
                "server": server_of(inputs.log).unwrap_or_default(),
                "logPath": inputs.log.to_string_lossy(),
            })
        }),
        // ── app knowledge: EMPTY AT CONSTRUCTION, and then PUSHED (JOS-482) ─────────────────────
        //
        // The `*.define` commands land immediately after this factory returns — `ingest::run`
        // applies every held define before the first byte is folded — so a world the app has
        // spoken to differs from this one by exactly those five pushes and by nothing else.
        // Alerts, buff trust, respawn watches, combo corrections and roster edits all arrive that
        // way, through the modules' own `Defines` seam rather than through this struct, because a
        // define also has to be answerable MID-FOLD and a construction parameter cannot be.
        //
        // `self_name` is the one that has not moved: `roster.setSelfName` is `session.ts`'s line
        // and it is not one of the five families the cutover ledger names. It stays `None` here,
        // which is what the bench world and all six goldens recorded.
        self_name: None,
        respawn_prefs: fold::modules::respawn::RespawnPrefs::default(),
    }
}

/// WHICH BUCKET THIS FOLD'S OBSERVATIONS ARE FILED UNDER — `log/config.ts characterId(ref)`, which
/// is `` `${c.name}_${c.server}`.toLowerCase() `` and nothing else (JOS-496 item 3).
///
/// IT MUST BE THE APP'S SPELLING, CHARACTER FOR CHARACTER. The key is what a re-fold matches on to
/// REPLACE a bucket rather than add to it, so an engine that filed the same character's counts
/// under `Primitive@freeport` while the app filed them under `primitive_freeport` would leave two
/// buckets in one register, each holding a full copy of the same log's observations — the JOS-231
/// doubling, arriving through a second door. The app-side reader would then sum both.
///
/// A log whose file name states no character falls back to the module's own constructed default,
/// `log`. That is the bench's key and the goldens' key, and it is the honest one here: a fold that
/// cannot say whose log it is cannot file its counts under a character either. It also cannot be
/// reached from a real attach — `ingest::run` already prints a diagnostic for a nameless log.
fn source_key(inputs: &SinkInputs<'_>) -> String {
    let Some(name) = inputs.character else {
        return "log".to_owned();
    };
    let server = server_of(inputs.log).unwrap_or_default();
    format!("{name}_{server}").to_lowercase()
}

/// The SERVER out of a log's file name — the second half of what `character_of` reads.
///
/// TWO SHAPES, the same two `ingest::character_of` accepts: the product's `eqlog_<Name>_<server>
/// .txt` and the oracle corpus's `eqlog_<Name>_<server>.<slice>.txt`, which `eqlog::server_of`
/// already implements. The last underscore separates the character from the server, because a
/// character name may hold one and a server may not — stated the same way in both readers on
/// purpose.
fn server_of(log: &std::path::Path) -> Option<String> {
    let name = log.file_name()?.to_string_lossy().into_owned();
    if let Some(server) = eqlog::server_of(&name) {
        return Some(server);
    }
    let stem = name.get(..name.len().checked_sub(4)?)?;
    if !name[stem.len()..].eq_ignore_ascii_case(".txt") {
        return None;
    }
    let rest = stem.strip_prefix("eqlog_").or_else(|| {
        stem.get(..6)
            .filter(|head| head.eq_ignore_ascii_case("eqlog_"))
            .and_then(|_| stem.get(6..))
    })?;
    let split = rest.rfind('_')?;
    let server = &rest[split + 1..];
    if rest[..split].is_empty() || server.is_empty() {
        return None;
    }
    Some(server.to_owned())
}

impl EventSink for FoldSink {
    /// One event, straight from the parser into the fold (JOS-505).
    ///
    /// IT USED TO PARSE THE NDJSON BACK. `Event::from_json` was the fold's door and could decline a
    /// line; now there is nothing to decline, because the payload IS what the parser wrote and a
    /// parse that produced no event never reaches this method at all. The `Option` that guarded it
    /// described a failure only a corrupt string could cause, and the string is no longer on the
    /// path.
    fn event(&mut self, event: &Event<'_>) {
        self.fold
            .on_primary(&fold::event::Event::typed(event.payload), event.live);
    }

    /// THE LIVE HEARTBEAT, straight through (owner ruling 22, JOS-481). One line, because the whole
    /// of the decision is `fold`'s: which modules have an `on_tick`, what each does with the number,
    /// and — the load-bearing half — that the historical path never calls it.
    ///
    /// WHY THE ENGINE HAD TO GROW ONE. The app has aged its own fold on a wall clock since JOS-149,
    /// so an engine that only ever advanced off log timestamps was serving a world that was correct
    /// about the bytes and stale about the hour. MEASURED by the in-app parity probe on a staged
    /// fixture whose buffs are long expired by wall time: twelve actives engine-side against three
    /// app-side, with the two folds agreeing exactly on everything the log had said (JOS-479).
    /// …and since JOS-485 it is also the one call that says THIS WORLD IS LIVE. See
    /// [`FoldSink::live`]: the flag is set here because this is the only method a historical scan
    /// cannot reach, which makes "am I live" a fact stated by the call graph rather than a second
    /// copy of the world's status that could drift from it.
    fn tick(&mut self, now_ms: i64) {
        // …AND THE COMBAT ENGINE GOES LIVE HERE, ON THE FIRST BEAT AND ONLY ON IT (JOS-488). The
        // beat this method is called from IS the go-live moment: one tick at the landing, before
        // `report_fold_landed` publishes `status: "live"`, then ~1×/sec. `session.ts` orders the two
        // the same way — `combat.setLive()` at the end of the scan, then `startHeartbeat()`'s single
        // `registry.tick(Date.now())` — so the engine is told it is live BEFORE the model it owns is
        // aged, on both sides, in the same order.
        //
        // GUARDED ON `self.live` RATHER THAN LEFT TO IDEMPOTENCE. `set_live` is idempotent and
        // re-calling it would be harmless today; the guard says what this line MEANS, which is that
        // going live happens once per attach. A new generation is a new sink and a new engine.
        //
        // WHAT IT COSTS AND WHERE IT LANDS: from here `hydrating` is false, so every `combat.snapshot`
        // and every `combat.live` frame runs the four snapshot-time sweeps at the instant it is
        // answered — the deferred encounter closure among them. A live meter that says a fight is
        // over is this. A HISTORICAL scan reaches none of it: the scan cannot call `tick`.
        if !self.live {
            if let Some(combat) = self.fold.combat.as_mut() {
                combat.set_live();
            }
        }
        self.live = true;
        self.beats = self.beats.saturating_add(1);
        self.fold.tick(now_ms);
        // ── …AND EVERY SIXTIETH BEAT, THE DISK (JOS-496 item 3) ────────────────────────────────
        //
        // `resist/module.ts onTick`'s "every sixtieth tick, a ledger persist" and `session.ts`'s
        // 60-second overlay save, which at a 1 Hz heartbeat are the same minute stated twice.
        //
        // IT IS IN `tick` AND NOWHERE ELSE, which is what makes "nothing during a replay" a fact
        // about the call graph rather than a guard somebody has to remember: the historical scan
        // cannot reach this method (see the module header's `live` argument), and a replay is
        // re-deriving what is already on disk anyway. The write is coalesced on a fingerprint and
        // can never take the engine down — `state::StateDir::put` carries both arguments.
        if self.beats.is_multiple_of(crate::state::WRITE_EVERY_BEATS) {
            if let Some(state) = self.state.as_mut() {
                state.write(&self.fold.registry);
            }
        }
    }

    /// What the fold can say about itself. `last_ts` is `max(ev.ts)` — the LOG's own clock,
    /// accumulated the way the golden recorder's bus listener accumulates it, so a log that rolls
    /// over cannot walk it backwards.
    fn report(&self) -> SinkReport {
        SinkReport {
            events: i64::try_from(self.fold.events()).unwrap_or(i64::MAX),
            last_ts: Some(self.fold.last_ts()),
            ..SinkReport::default()
        }
    }

    /// One module's published state, straight off the registry.
    ///
    /// `snapshot()` over there returns `{ "seq": …, "state": … }` and this splits the pair rather
    /// than re-deriving either half: the module's `seq` is its own (four of them publish a private
    /// revision counter instead of an event seq — JOS-87), and reading it off anything but the
    /// module's own answer would be a second opinion about a number the module owns.
    fn snapshot(&self, module: &str) -> Option<ModuleSnapshot> {
        let published = self.fold.registry.snapshot_of(module)?;
        Some(ModuleSnapshot {
            seq: published.get("seq").and_then(serde_json::Value::as_i64)?,
            state: published.get("state").cloned()?,
        })
    }

    /// THE VIEW LAYER'S DOOR (JOS-480). One `match` on the source, and each arm reads its module
    /// through that module's own pull seam — never through `snapshot()`, which would serialize the
    /// whole thing to draw fifty rows of it.
    ///
    /// A SOURCE WHOSE MODULE IS NOT REGISTERED ANSWERS `None`, and the view layer serves an empty
    /// window rather than refusing: the descriptor was valid, this fold simply has nothing behind
    /// it. That is the same distinction `module.snapshot` draws between `notFound` and
    /// `unavailable`, one level down.
    fn source_rows(&self, source: &'static views::SourceDef) -> Option<Vec<views::SourceRow>> {
        let registry = &self.fold.registry;
        match source.id {
            id if id == views::loot::LEDGER.id => {
                Some(views::loot::rows(registry.loot()?, &self.clock))
            }
            id if id == views::buffs::ACTIVE.id => Some(views::buffs::rows(registry.buffs()?)),
            // TWO MODULES, ONE SOURCE, and the `?` on either is what makes that honest: the timer
            // projection is a fold over `buffs.active` AND `buffTimers.holds`, so a registry
            // carrying one of them cannot serve half a window — it serves none, and the view layer
            // answers the empty one.
            id if id == views::timers::ROWS.id => Some(views::timers::rows(
                registry.buffs()?,
                registry.buff_timers()?,
            )),
            id if id == views::respawn::WATCHES.id => {
                Some(views::respawn::rows(registry.respawn()?))
            }
            id if id == views::kills::RECENT.id => {
                Some(views::kills::rows(registry.progression()?))
            }
            id if id == views::progression::RECENT.id => Some(views::progression::rows(
                registry.progression()?,
                &self.clock,
            )),
            id if id == views::event_feed::RECENT.id => {
                Some(views::event_feed::rows(registry.event_feed()?))
            }
            // THE METER'S ROWS COME OUT OF THE SNAPSHOT'S OWN `selected`, at the cheapest options
            // that produce one: no finalized-fight list, no timeline, no unparsed ring. A level-1
            // meter draws the selection's sources and nothing else, and `maxSegments: 0` is what
            // says so — the current encounter and the zone summary are always included whatever the
            // cap, so the selection still resolves exactly as a full-fat call resolves it.
            id if id == views::combat::LIVE.id => {
                let snapshot = self.combat_snapshot(&CombatOpts {
                    max_segments: 0,
                    ..CombatOpts::default()
                })?;
                Some(views::combat::rows(&snapshot.state["selected"]))
            }
            _ => None,
        }
    }

    /// THE APP-KNOWLEDGE DOOR (JOS-482). One call through to the registry, which owns the mapping
    /// from a family to the module that answers for it — the same shape `snapshot` has, one
    /// direction reversed.
    fn define(&mut self, family: &str, payload: &serde_json::Value) -> bool {
        self.fold.registry.define(family, payload)
    }

    /// THE SESSION MARK, straight through to the engine that owns what one means (JOS-492).
    ///
    /// ONE LINE, and the whole of the decision is `fold::combat`'s: the hydrating refusal, the
    /// deferred closure evaluated at the stamped instant, the frozen `closedBy: 'mark'` record and
    /// the fresh accumulators. A sink with no engine answers `false` through the same `?` — no
    /// engine, no meter, nothing split.
    ///
    /// NOT `combat_now()`: the instant is the CALLER'S, stamped once app-side for the whole click
    /// so that the loot split and this split share one boundary. Substituting the fold's own clock
    /// here would put the two halves of one user action at two different instants.
    fn session_mark(&mut self, at: i64) -> bool {
        self.fold
            .combat
            .as_mut()
            .is_some_and(|engine| engine.session_mark(at))
    }

    /// THE CONFIRMED SIGHTING, straight through to the module that owns what one means (JOS-494).
    ///
    /// ONE LINE, like `session_mark` above and through the registry rather than around it: the
    /// whole of the decision is `fold::modules::respawn`'s — the unknown id, the row that is not
    /// currently seen, and the base that the next death takes back by arithmetic. A registry with
    /// no respawn module answers `false` through the same `?`, which is the same honest `false`
    /// the module itself gives a row it does not carry.
    ///
    /// IT GOES THROUGH `respawn_mut` AND NOT `respawn`, which is the compiler saying this is a
    /// write: the six lines above it in `source_rows` read the same module by `&`, and the seam
    /// they use will not let anything move.
    fn confirm_sighting(&mut self, row_id: &str) -> bool {
        self.fold
            .registry
            .respawn_mut()
            .is_some_and(|respawn| respawn.confirm_sighting(row_id))
    }

    /// The alert fires the registry made while folding the last drain, converted from the FOLD's
    /// shape into the INGEST's at this seam — which is the whole reason both types exist. Neither
    /// `ingest.rs` nor `world.rs` ever learns what an alert is.
    /// THE CON CARDS (JOS-487, boundary verdict 2). The live `/con`s the consider module saw while
    /// folding the last drain, each RESOLVED into the card the overlay draws — `crate::concard`
    /// owns what that means and this is the one line that joins the two.
    ///
    /// A LINE THAT NAMES NOTHING IS DROPPED HERE rather than sent as an empty card, which is
    /// `noteConsider`'s own first guard: a creature name that folds to no key has no queue identity.
    ///
    /// …AND SO IS A PERSON (JOS-492). The corpus this sink already holds for the `knowledge.*` ops
    /// is the second half of `conCardIsPlayer`, so the refusal the app has always made is made here
    /// too — see `crate::concard`. It is the SAME `Arc` the registry was handed at construction, so
    /// there is exactly one catalog in this process and the card cannot disagree with a lookup.
    fn take_con_cards(&mut self) -> Vec<protocol::generated::ConCardMessage> {
        let knowledge = std::sync::Arc::clone(&self.knowledge);
        self.fold
            .registry
            .take_cons()
            .iter()
            .filter_map(|ev| crate::concard::card(ev, &*knowledge))
            .collect()
    }

    /// THE MODULE DIRTY BITS (JOS-487) — every registered module's published cursor, straight off
    /// the registry and without building a single module's state. See `EqModule::published_seq`.
    fn module_seqs(&self) -> Vec<(&'static str, i64)> {
        self.fold.registry.published_seqs()
    }

    fn take_fires(&mut self) -> Vec<crate::ingest::Fire> {
        self.fold
            .registry
            .take_fires()
            .into_iter()
            .map(|f| crate::ingest::Fire {
                at: f.at,
                rule: f.rule,
                sound: f.sound,
                message: f.message,
                // The speech fields cross the seam as the plain map and options they already are —
                // the fold resolved them, and this is a rename rather than a decision (JOS-500).
                captures: f.captures,
                spell: f.spell,
                due_at: f.due_at,
            })
            .collect()
    }

    /// THE COMBAT SNAPSHOT (JOS-485) — one call through to the engine, at the instant this fold is
    /// entitled to (see [`FoldSink::combat_now`]).
    ///
    /// THE ROSTER IS PULLED FROM THE REGISTRY, exactly as `Fold::observe` pulls it on every event
    /// and exactly as `engine.ts:215` installs the closure app-side. Reading it from anywhere else
    /// would be a second answer to "who am I grouped with" beside the one the meter's own rows were
    /// attributed under — and the snapshot carries the roster precisely so the scope chip and the
    /// rows it filters can never disagree.
    fn combat_snapshot(&self, opts: &CombatOpts) -> Option<CombatSnapshot> {
        let engine = self.fold.combat.as_ref()?;
        let now = self.combat_now();
        Some(CombatSnapshot {
            now,
            state: engine.snapshot(now, &snapshot_opts(opts), self.fold.registry.roster()),
        })
    }

    /// THE FIGHT SEARCH (JOS-485). The corpus is the engine's — uncapped history plus the open
    /// fight, through its own door rather than through a snapshot — and the ranking is
    /// `crate::search`, which is `shared/fuzzy.ts` ported with its golden cases.
    fn search_fights(&self, query: &str, limit: usize) -> Option<FightSearch> {
        let engine = self.fold.combat.as_ref()?;
        let corpus = engine.fight_summaries(self.combat_now());
        Some(FightSearch {
            // THE CORPUS IS COUNTED BEFORE THE QUERY IS LOOKED AT, which is what makes an empty
            // query answer `{ hits: [], corpus: 1428 }` rather than `corpus: 0`. A UI saying
            // "search 1,428 fights" in an empty box is reading this number.
            corpus: i64::try_from(corpus.len()).unwrap_or(i64::MAX),
            hits: crate::search::search(&corpus, query, limit)
                .into_iter()
                .map(|hit| FightHit {
                    summary: hit.summary,
                    score: hit.score,
                })
                .collect(),
        })
    }

    /// WHAT YOU HAVE LOOTED OFF ONE CREATURE (JOS-486) — the half of a `knowledge.mob` answer that
    /// only a FOLD can give, read through the module's own pull seam.
    ///
    /// It is on the sink rather than on the corpus because the two halves have different owners and
    /// different lifetimes: the catalog is committed data that outlives every generation, and this is
    /// character-scoped, epoch-scoped state the `consider` module clears on a rebirth. Joining them
    /// anywhere but at the read would mean one of them holding a stale copy of the other.
    ///
    /// A build with no `consider` module answers with no rows — the same value a creature nothing has
    /// been looted from answers with, so neither is a special case.
    fn own_loot_drops(&self, spellings: &[String]) -> Vec<fold::knowledge::SeenDrop> {
        self.fold
            .registry
            .own_loot()
            .map(|index| index.drops_across(spellings))
            .unwrap_or_default()
    }

    /// HOW OLD THESE CREATURES ARE (JOS-497 item 1) — `resist/module.ts levelOf`, read through the
    /// module's own pull seam exactly as `own_loot_drops` reads the consider module's.
    ///
    /// THE KEY IS FOLDED HERE AND NOT BY THE CALLER, and the schema says why: a pre-folded key on
    /// the wire would be a second opinion about a join key. `consider::mob_key` is the port of
    /// `shared/mobKey.ts` and is the one spelling rule this engine has, so the app sends the name
    /// the log printed and this line turns it into whatever the fold files a `/con` under.
    ///
    /// A CREATURE WITH NO LEVEL PRODUCES NO ROW rather than a row full of nulls — the absence IS the
    /// answer (`levelOf` returns `null`), and the app maps name to row and reads a miss as exactly
    /// that. It also means a request naming thirty creatures nobody has ever conned costs thirty
    /// catalog lookups and sends nothing, which is the right shape for a card that will draw
    /// "no data".
    fn mob_levels(
        &self,
        names: &[String],
    ) -> Vec<(String, fold::modules::resist::world::MobLevelFact)> {
        let Some(resist) = self.fold.registry.resist() else {
            return Vec::new();
        };
        names
            .iter()
            .filter_map(|name| {
                let key = fold::modules::consider::mob_key(name);
                resist.level_of(&key, name).map(|fact| (name.clone(), fact))
            })
            .collect()
    }

    /// The names this fold's own probes could not answer — drained at the ingest's boundary and
    /// announced connection-wide, exactly as `take_fires` is.
    ///
    /// IT IS THE CORPUS'S LEDGER, NOT THE FOLD'S. A miss made by a `knowledge.item` op on a
    /// connection thread lands in the same place, which is why each name is announced once for the
    /// process rather than once per asker.
    fn take_knowledge_misses(&mut self) -> Vec<fold::knowledge::Miss> {
        fold::knowledge::Knowledge::take_misses(&*self.knowledge)
    }

    /// THE CHANGE SIGNAL PER SOURCE. Cheap by contract — a counter read, never a serialization.
    ///
    /// THREE OF THESE ARE COARSE AND THE COARSENESS IS STATED AT THE MODULE. `loot`, `respawn` and
    /// `buffTimers` keep real revision counters that move only when their state could have; `buffs`,
    /// `progression` and `eventFeed` do not, so they report the fold's own `seq`, which moves on
    /// every event. That NEVER MISSES A CHANGE — the property correctness needs — and it over-reports,
    /// which costs a re-cut per serve beat on a busy tail over row sets of tens. Named rather than
    /// hidden; the fix is the counters, not a cache (ruling 5).
    ///
    /// `timers.rows` TAKES THE MAX OF ITS TWO INPUTS, which is the only honest answer for a source
    /// folded from two modules: either moving could move the window, so a signal that watched one
    /// of them would let a stale window stand.
    fn source_revision(&self, source: &'static views::SourceDef) -> Option<u64> {
        let registry = &self.fold.registry;
        let signal = |seq: i64| u64::try_from(seq).unwrap_or(0);
        match source.id {
            id if id == views::loot::LEDGER.id => Some(registry.loot()?.revision()),
            id if id == views::buffs::ACTIVE.id => Some(signal(registry.buffs()?.revision())),
            id if id == views::timers::ROWS.id => Some(
                signal(registry.buffs()?.revision())
                    .max(signal(registry.buff_timers()?.revision())),
            ),
            id if id == views::respawn::WATCHES.id => Some(signal(registry.respawn()?.revision())),
            id if id == views::kills::RECENT.id || id == views::progression::RECENT.id => {
                Some(signal(registry.progression()?.revision()))
            }
            id if id == views::event_feed::RECENT.id => {
                Some(signal(registry.event_feed()?.revision()))
            }
            // NO COUNTER TO READ, AND THAT IS HONEST RATHER THAN A GAP. The `loot` module publishes
            // a revision because it can say exactly when it changed; the combat engine cannot —
            // every damage, miss, resist, heal, charm and zone line moves some row of the meter, so
            // "when could this have changed" IS "did an event land". The event count answers that,
            // it is a field read, and it is monotonic.
            //
            // THE BEATS ARE ADDED BECAUSE THE ROWS ARE A FUNCTION OF `now` TOO — a live fight's
            // `durationSec` grows while the log is quiet, which is why the app polls its own
            // snapshot on an interval rather than on its tailer. The sum of two monotonic counters
            // is monotonic and cannot repeat across a change, so a quiet live meter re-cuts once a
            // second and an idle historical one never re-cuts at all.
            id if id == views::combat::LIVE.id => {
                self.fold.combat.as_ref()?;
                Some(self.fold.events().saturating_add(self.beats))
            }
            _ => None,
        }
    }
}

/// The ingest's opts, in the fold's vocabulary. The one place the two spellings meet — see
/// [`crate::ingest::CombatOpts`] for why there are two.
fn snapshot_opts(opts: &CombatOpts) -> fold::combat::SnapshotOpts {
    fold::combat::SnapshotOpts {
        selected_id: opts.selected_id.clone(),
        show_unparsed: opts.show_unparsed,
        max_segments: opts.max_segments,
        timeline: opts.timeline,
    }
}

/// A `Clock` the sink factory can be handed in a test that has no parser. Not used in production —
/// the ingest hands over the parser's own.
#[cfg(test)]
fn test_clock() -> eqlog::Clock {
    eqlog::Clock::new(eqlog::host_timezone())
}

#[cfg(test)]
mod tests {
    use super::{folding_sinks, server_of, source_key, FoldSink};
    use crate::ingest::{Event, EventSink, SinkInputs};
    use std::path::{Path, PathBuf};

    fn inputs<'a>(log: &'a Path, clock: &'a eqlog::Clock) -> SinkInputs<'a> {
        SinkInputs {
            log,
            character: Some("Primitive"),
            db: None,
            clock,
            attached_at_ms: 1_787_181_707_000,
            // NO STATE DIRECTORY, which is what makes these unit tests describe the same fold the
            // equivalence oracle describes: nothing is read, nothing is seeded, nothing is written.
            // `tests/state.rs` is where the persisting sink is driven.
            state_dir: None,
        }
    }

    /// The same inputs, carrying a state directory — the attach the APP makes.
    fn inputs_with_state<'a>(
        log: &'a Path,
        clock: &'a eqlog::Clock,
        state_dir: &'a Path,
    ) -> SinkInputs<'a> {
        SinkInputs {
            state_dir: Some(state_dir),
            ..inputs(log, clock)
        }
    }

    /// A scratch profile directory of this test's own.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("engined-foldsink-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch profile");
        dir
    }

    /// ONE ROW, in the app's exact spelling, for a named mob under a named bucket.
    fn ledger_of(buckets: &[(&str, &str)]) -> String {
        let sources: Vec<String> = buckets
            .iter()
            .map(|(key, mob)| {
                format!(
                    r#"{{"key":"{key}","rows":[{{"mobKey":"{mob}","spellKey":"malosi","family":"cast","casterKind":"self","casterLevel":51,"mobLevel":20,"debuffs":"","rank":0,"overchannel":false,"week":"2026-W34","resist":4,"land":7,"dmg":{{"9":2}},"firstTs":1000,"lastTs":2000}}]}}"#
                )
            })
            .collect();
        format!(r#"{{"version":3,"sources":[{}]}}"#, sources.join(","))
    }

    fn overlay_of(buckets: &[&str]) -> String {
        let sources: Vec<String> = buckets
            .iter()
            .map(|key| {
                format!(
                    r#"{{"key":"{key}","messages":[{{"text":"You feel much faster.","role":"landing","spells":[{{"spell":"Alacrity","count":3}}]}}]}}"#
                )
            })
            .collect();
        format!(
            r#"{{"version":2,"updatedAt":"2026-08-19T16:21:54.000Z","sources":[{}]}}"#,
            sources.join(",")
        )
    }

    /// How many pooled rows the resist module says it holds — its whole published surface.
    fn resist_rows(sink: &FoldSink) -> i64 {
        sink.snapshot("resist").expect("the resist module").state["rows"]
            .as_i64()
            .expect("a row count")
    }

    #[test]
    fn the_source_key_is_the_apps_own_character_id() {
        // `log/config.ts characterId(ref)` — `${name}_${server}`, LOWERCASED. A different spelling
        // would file the same character's counts in a second bucket and the app would sum both.
        let clock = super::test_clock();
        let log = Path::new("C:/EQ/Logs/eqlog_Primitive_freeport.txt");
        assert_eq!(source_key(&inputs(log, &clock)), "primitive_freeport");
        // A log whose name states no character falls back to the module's constructed default,
        // which is the bench's key and every golden's key.
        let nameless = SinkInputs {
            character: None,
            ..inputs(Path::new("C:/EQ/Logs/notalog.txt"), &clock)
        };
        assert_eq!(source_key(&nameless), "log");
    }

    #[test]
    fn the_server_comes_off_the_products_own_file_name() {
        assert_eq!(
            server_of(Path::new("C:/EQ/Logs/eqlog_Primitive_freeport.txt")).as_deref(),
            Some("freeport")
        );
        // The oracle corpus's slice form goes through eqlog's own rule.
        assert_eq!(
            server_of(Path::new("eqlog_Primitive_freeport.patch-week.txt")).as_deref(),
            Some("freeport")
        );
        // A character name may hold an underscore; the SERVER may not, so the last one splits.
        assert_eq!(
            server_of(Path::new("eqlog_Two_Names_freeport.txt")).as_deref(),
            Some("freeport")
        );
        assert!(server_of(Path::new("notalog.txt")).is_none());
        assert!(server_of(Path::new("eqlog_Primitive_.txt")).is_none());
    }

    #[test]
    fn a_fresh_sink_folds_all_twenty_modules_and_skips_none() {
        // THE NO-SILENT-CAPS LAW, engine-side. `Registry::missing()` is what the parity harness
        // prints as SKIP; an engine that served a registry with holes in it would be answering
        // `notFound` for a module that exists.
        let clock = super::test_clock();
        let log = Path::new("C:/nowhere/eqlog_Primitive_freeport.txt");
        let sink = FoldSink::new(&inputs(log, &clock));
        assert_eq!(sink.fold.registry.ids().len(), fold::WIRING_ORDER.len());
        assert!(
            sink.fold.registry.missing().is_empty(),
            "{:?}",
            sink.fold.registry.missing()
        );
        for id in fold::WIRING_ORDER {
            assert!(sink.snapshot(id).is_some(), "{id} answered nothing");
        }
    }

    #[test]
    fn a_name_the_registry_does_not_carry_answers_nothing() {
        // …and `loot.ledger` is the trap worth pinning: it is a VIEW source name, and a caller that
        // confuses the two must be told so rather than handed an empty state.
        let clock = super::test_clock();
        let log = Path::new("C:/nowhere/eqlog_Primitive_freeport.txt");
        let sink = FoldSink::new(&inputs(log, &clock));
        assert!(sink.snapshot("loot.ledger").is_none());
        assert!(sink.snapshot("").is_none());
        assert!(sink.snapshot("combat").is_none(), "combat is not a module");
    }

    /// Feed one death you landed, stamped with `seq` — the event the `kills` module counts:
    /// `death` is the kind, `bySelf` is the counted filter, `name` is what the map is keyed by.
    ///
    /// BUILT THROUGH THE PARSER'S OWN WRITER (JOS-505) rather than as a JSON literal, which it used
    /// to be: the sink reads the TYPED half now, so a hand-written string would drive a path
    /// production does not take. It also removes a trap the literal carried — the two halves cannot
    /// disagree, because there is one statement of the event.
    ///
    /// THE `seq` IS IN THE EVENT, and that is the thing worth knowing here: `ingest::Event::seq` is
    /// the INGEST's counter, and a module's published `seq` comes off the event's own field, which
    /// the parser stamped. The two agree on a real scan by construction; a test that hardcoded one
    /// and varied the other would be pinning a number nothing produces.
    fn kill(sink: &mut dyn EventSink, seq: i64) {
        let mut ev = eqlog::event::Ev::new();
        ev.begin(eqlog::event::Kind::Death);
        ev.envelope(
            seq,
            1_787_181_707_000,
            "a sand giant has been slain by Primitive!",
        );
        ev.s(eqlog::event::Key::Name, "a sand giant");
        ev.b(eqlog::event::Key::BySelf, true);
        let (json, payload) = ev.done();
        sink.event(&Event {
            json,
            payload,
            seq,
            live: false,
        });
    }

    /// How many kills the `kills` module has recorded.
    fn counted(sink: &dyn EventSink) -> usize {
        sink.snapshot("kills").expect("kills is registered").state["mobs"]
            .as_object()
            .map_or(0, serde_json::Map::len)
    }

    #[test]
    fn the_snapshot_advances_with_the_fold_and_reads_between_events() {
        // THE POINT OF THE SEAM, in miniature: a snapshot taken between two events is the state
        // after the first and no part of the second.
        //
        // TWO DEATHS, AND THE FIRST ONE IS SUPPOSED TO VANISH. A live engine resolves the launch
        // anchor through the parser's own clock, so the first event past 2026-07-28 fires the
        // `epoch` boundary — character rebirth — and `kills` CLEARS on it. That is not an artifact
        // of this test: it is what a real attach does, and pinning it here is how a later change to
        // the anchor announces itself as a behaviour change instead of a mystery.
        let clock = super::test_clock();
        let log = Path::new("C:/nowhere/eqlog_Primitive_freeport.txt");
        let mut sink = FoldSink::new(&inputs(log, &clock));
        assert_eq!(counted(&sink), 0);

        kill(&mut sink, 0);
        assert_eq!(counted(&sink), 0, "the epoch boundary cleared the map");
        kill(&mut sink, 1);
        assert_eq!(counted(&sink), 1, "and the next one is the new world's");

        let after = sink.snapshot("kills").expect("kills is registered");
        assert_eq!(after.seq, 1, "the module's own seq is the event it folded");
        assert_eq!(sink.report().events, 2);
    }

    #[test]
    fn the_factory_builds_a_fresh_registry_per_attach() {
        // A NEW SINK PER ATTACH is the ingest's structural guarantee that two folds never reach one
        // set of modules (JOS-457's defect, made impossible). This is the half of it that lives
        // here: the factory constructs, it never hands back something it is holding.
        let clock = super::test_clock();
        let log = Path::new("C:/nowhere/eqlog_Primitive_freeport.txt");
        let factory = folding_sinks();
        let mut first = factory(&inputs(log, &clock));
        kill(&mut *first, 0);
        kill(&mut *first, 1);
        let second = factory(&inputs(log, &clock));
        assert_eq!(first.report().events, 2);
        assert_eq!(second.report().events, 0);
        assert_eq!(counted(&*first), 1);
        assert_eq!(counted(&*second), 0);
    }

    // ── THE APP'S PERSISTED KNOWLEDGE, END TO END (JOS-496 item 3) ─────────────────────────────

    #[test]
    fn an_attach_with_a_state_dir_seeds_both_artifacts_and_discards_its_own_bucket() {
        let dir = scratch("seed");
        // TWO BUCKETS ON DISK: this character's, and somebody else's. The whole design turns on
        // their being treated differently — one is about to be re-derived from the log, the other
        // is knowledge nothing can re-derive.
        std::fs::write(
            dir.join("resist-ledger.json"),
            ledger_of(&[
                ("primitive_freeport", "a rat"),
                ("other_bertox", "a bat"),
                // …and the shipped baseline's, which must be refused on read: it is re-seeded from
                // the bundle on every launch and counting it here would count it twice.
                ("baseline", "a gnoll"),
            ]),
        )
        .expect("the ledger is written");
        std::fs::write(
            dir.join("message-overlay.json"),
            overlay_of(&["primitive_freeport", "other_bertox"]),
        )
        .expect("the register is written");

        let clock = super::test_clock();
        let log = Path::new("C:/nowhere/eqlog_Primitive_freeport.txt");
        let sink = FoldSink::new(&inputs_with_state(log, &clock, &dir));

        // ONE ROW, not three: `other_bertox` survived, `primitive_freeport` was DISCARDED by
        // `begin_source` because its log is about to state its whole content again (JOS-231), and
        // `baseline` was never read at all.
        assert_eq!(resist_rows(&sink), 1);

        // The overlay is the same story through a different door. `other_bertox`'s bucket is still
        // in the register; this character's is empty and waiting for the fold.
        let register = sink
            .fold
            .registry
            .buffs()
            .expect("buffs is registered")
            .overlay_register();
        let mine = register
            .sources
            .iter()
            .find(|s| s.key == "primitive_freeport")
            .expect("this character's bucket exists, discarded");
        assert!(mine.messages.is_empty(), "discarded, not seeded");
        let theirs = register
            .sources
            .iter()
            .find(|s| s.key == "other_bertox")
            .expect("the other character's bucket survived");
        assert_eq!(theirs.messages.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sixtieth_live_beat_writes_both_files_and_the_scan_writes_neither() {
        let dir = scratch("write");
        std::fs::write(
            dir.join("resist-ledger.json"),
            ledger_of(&[("other_bertox", "a bat")]),
        )
        .expect("the ledger is written");
        std::fs::write(
            dir.join("message-overlay.json"),
            overlay_of(&["other_bertox"]),
        )
        .expect("the register is written");

        let clock = super::test_clock();
        let log = Path::new("C:/nowhere/eqlog_Primitive_freeport.txt");
        let mut sink = FoldSink::new(&inputs_with_state(log, &clock, &dir));

        // A HISTORICAL SCAN WRITES NOTHING, and it cannot: the scan folds events and never ticks,
        // and the write lives in `tick` alone. Overwrite both files with junk and prove the scan
        // leaves the junk where it is.
        std::fs::write(dir.join("resist-ledger.json"), "scan must not touch this")
            .expect("junk is written");
        for seq in 0..3 {
            kill(&mut sink, seq);
        }
        assert_eq!(
            std::fs::read_to_string(dir.join("resist-ledger.json")).expect("readable"),
            "scan must not touch this"
        );

        // …and the sixtieth beat writes. Fifty-nine do not — the cadence is the app's
        // "every sixtieth tick" at 1 Hz, which is its minute.
        for _ in 0..(crate::state::WRITE_EVERY_BEATS - 1) {
            sink.tick(1_787_181_707_000);
        }
        assert_eq!(
            std::fs::read_to_string(dir.join("resist-ledger.json")).expect("readable"),
            "scan must not touch this",
            "fifty-nine beats is not a minute"
        );
        sink.tick(1_787_181_707_000);

        // What landed is the app's own format, and it carries the bucket nothing could re-derive.
        let text = std::fs::read_to_string(dir.join("resist-ledger.json")).expect("readable");
        assert!(
            text.starts_with(r#"{"version":3,"sources":[{"key":"other_bertox""#),
            "{text}"
        );
        assert!(text.contains(r#""mobKey":"a bat""#), "{text}");
        // …and it is readable by the app's own reader, proven through the shared parse.
        let back = fold::modules::resist::ledger_file::read_ledger(&text);
        assert_eq!(back.sources.len(), 1);
        assert_eq!(back.sources[0].rows.len(), 1);

        let overlay = std::fs::read_to_string(dir.join("message-overlay.json")).expect("readable");
        assert!(
            overlay.starts_with(r#"{"version":2,"updatedAt":"#),
            "{overlay}"
        );
        assert!(overlay.contains(r#""key":"other_bertox""#), "{overlay}");
        // THE BASELINE IS NOT IN THE FILE. It is compiled into the binary and merged at
        // construction; a copy of it in userData would be 400 kB of staler duplicate.
        assert!(!overlay.contains(r#""key":"baseline""#), "{overlay}");
        // NO SCRATCH FILE LEFT BEHIND by either write.
        assert!(!dir.join("resist-ledger.json.tmp").exists());
        assert!(!dir.join("message-overlay.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_a_state_dir_nothing_is_read_and_nothing_is_written() {
        // THE ORACLE'S WORLD, and the flag-off world: an attach that names no profile directory
        // neither reads a file nor writes one, so the fold is a pure function of its bytes. The
        // directory here holds a file the sink would certainly have read had it been told to.
        let dir = scratch("none");
        std::fs::write(
            dir.join("resist-ledger.json"),
            ledger_of(&[("other_bertox", "a bat")]),
        )
        .expect("the ledger is written");

        let clock = super::test_clock();
        let log = Path::new("C:/nowhere/eqlog_Primitive_freeport.txt");
        let mut sink = FoldSink::new(&inputs(log, &clock));
        assert_eq!(resist_rows(&sink), 0, "nothing was seeded");
        for _ in 0..(crate::state::WRITE_EVERY_BEATS * 2) {
            sink.tick(1_787_181_707_000);
        }
        // Untouched — byte for byte the file this test wrote.
        assert_eq!(
            std::fs::read_to_string(dir.join("resist-ledger.json")).expect("readable"),
            ledger_of(&[("other_bertox", "a bat")])
        );
        assert!(!dir.join("message-overlay.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
