//! The join between `ingest` (who is folding) and `fold` (what a fold is): one `impl EventSink` and
//! one factory that builds the module registry out of what an attach knows. It lives in this crate
//! because the orphan rule requires it, and it is the only place either crate's construction is
//! spelled.
//!
//! `ClusterDeps` splits two ways. Facts about committed data are derived here from the parser's own
//! catalog; app knowledge is empty at construction and arrives afterwards as `*.define` commands —
//! the engine never reads a settings file. The character ref is neither: it comes off the log's file
//! name, the same fact the parser derives its character from, because two ways of stating one
//! identity is a way for them to disagree.
//!
//! The combat engine is registered but is not a module — `WIRING_ORDER` does not name it and
//! `module.snapshot` refuses the name — so it reaches clients through `combat.snapshot`,
//! `combat.searchFights` and the view source `combat.live`.
//!
//! A combat answer is taken at the wall clock once this world has reached its tail and at
//! `fold.last_ts()` before that; a replay stamped with a host clock would finalize whatever fight
//! was open and hand the rest to a fresh encounter. [`FoldSink::live`] states which world this is
//! structurally: `EventSink::tick` is the one call the historical scan cannot reach. The same flag
//! decides whether the model may be aged, since a world entitled to a wall clock is exactly one
//! entitled to age itself against one.
//!
//! The attach instant is the only wall clock read at construction; every other time-based rule
//! inside the fold advances off log timestamps.

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

/// The process's knowledge corpus.
///
/// One `Arc`, handed to the registry at every attach and held by the world for the `knowledge.*`
/// ops. It must be the same instance both times: a second corpus would be a second overlay, so a
/// name the app pushed in answer to a miss would be a hit on one path and a miss on the other.
///
/// The concrete type, not the trait: `fold::knowledge::Knowledge` carries only what a module needs
/// to ask, so the fold never learns that a spell catalog or a search exist.
#[must_use]
pub fn corpus() -> std::sync::Arc<knowledge::Corpus> {
    knowledge::shared()
}

/// One attach's fold, and the counters the ingest reports off it.
pub struct FoldSink {
    fold: fold::Fold,
    /// The process's corpus, kept so this sink can drain its miss ledger at the ingest's boundary.
    /// The same instance the registry was handed — see [`corpus`].
    knowledge: std::sync::Arc<knowledge::Corpus>,
    /// The parser's own clock, kept because a view has to render an instant: `loot.ledger`'s `at`
    /// cell is the wall clock the log's timestamps were read in, and a second clock built from the
    /// same zone would be a second answer waiting to disagree. It is the ZONE that is load-bearing
    /// — nothing in this file asks what time it is now.
    clock: eqlog::Clock,
    /// Has this world reached its tail? The whole of the `now` decision.
    ///
    /// Set by `tick` and by nothing else, which is what makes it structural: the historical scan has
    /// no path to `tick`, so a fold that is still scanning cannot have this set.
    live: bool,
    /// The app's `userData`, and this generation's memory of what it last wrote there. `None` when
    /// the attach carried no `stateDir`, which means this fold neither read a file nor writes one.
    state: Option<crate::state::StateDir>,
    /// How many beats this world has taken — half of `combat.live`'s revision signal.
    ///
    /// The meter's rows are a function of the events folded AND of the instant they are read at: a
    /// fight's `durationSec` grows with `now` while the log says nothing. Beats plus events moves on
    /// either and repeats across neither.
    beats: u64,
}

impl FoldSink {
    /// Build the registry this attach folds into. See the module header for every input.
    #[must_use]
    pub fn new(inputs: &SinkInputs<'_>) -> Self {
        let launch_ms = fold::epoch::launch_ms(inputs.clock);
        let mut fold = fold::Fold::new(registry_for(inputs, launch_ms), launch_ms)
            .with_combat(combat_for(inputs));
        // The app's persisted knowledge, put back before the first byte. Read, seed, then name this
        // fold's own bucket — `seed_persisted` does the last two as one call because their order is
        // load-bearing. It happens after `Fold::new` because `new` resets every module and
        // `ResistModule::reset` discards its own source's bucket, so an earlier seed is thrown away.
        //
        // None of it runs without a `stateDir`: the whole block is inside the `Option`, so a fold
        // with no state directory is byte-for-byte the fold built without one — no read, no source
        // rename, no write — which keeps the equivalence oracle's world reachable structurally.
        let state = inputs.state_dir.map(|dir| {
            let store = crate::state::StateDir::new(dir);
            fold.registry
                .seed_persisted(&source_key(inputs), &store.read());
            store
        });
        Self {
            fold,
            // Copied, never rebuilt from a name: a fixed-offset clock has no name to rebuild from.
            clock: *inputs.clock,
            live: false,
            beats: 0,
            knowledge: corpus(),
            state,
        }
    }

    /// The instant a combat answer is taken at: the process's own wall clock once the tail is
    /// running, read fresh per answer, and the fold's own `last_ts` before that — the only honest
    /// instant for a replay.
    fn combat_now(&self) -> i64 {
        if self.live {
            crate::ingest::wall_clock_ms()
        } else {
            self.fold.last_ts()
        }
    }
}

/// The combat engine one attach folds into.
///
/// `reset()` then `set_player_name` before the builder, because `with_combat` resets what it is
/// given and `CombatEngine::reset` re-seeds an injected name by itself. The name comes off the log's
/// own file name, the same fact the parser derives its character from.
fn combat_for(inputs: &SinkInputs<'_>) -> fold::combat::CombatEngine {
    let mut engine = fold::combat::CombatEngine::new();
    engine.reset();
    if let Some(name) = inputs.character {
        engine.set_player_name(name);
    }
    engine
}

/// `ClusterDeps`, assembled, and the one place `install_knowledge` is called.
///
/// That is structural rather than conventional: `fold::registered()` — which the parity runner, the
/// bench arm and every fold test call — cannot reach a corpus, because the `fold` crate cannot name
/// the crate that holds one. So the world the goldens were recorded in is still exactly what those
/// callers build.
///
/// A production fold differs from that world only on the live tail: both knowledge probes sit behind
/// the `live` gate, so a historical fold with a corpus installed is byte-for-byte the same fold as
/// one without.
fn registry_for(inputs: &SinkInputs<'_>, launch_ms: i64) -> fold::Registry {
    let mut registry = fold::registered(cluster_deps(inputs, launch_ms));
    let lookups: std::sync::Arc<dyn fold::knowledge::Knowledge> = corpus();
    registry.install_knowledge(&lookups);
    registry
}

/// The deps themselves. Split from `registry_for` so the install above reads as the one extra act
/// it is, rather than hiding at the bottom of a struct literal.
fn cluster_deps(inputs: &SinkInputs<'_>, launch_ms: i64) -> fold::ClusterDeps {
    fold::ClusterDeps {
        // Committed data, read off the parser's own catalog — the same database the parser emits
        // `candidates` out of, never a second load: two loads is two answers waiting to disagree
        // after an overlay change.
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
        launch_ms,
        construction_now_ms: inputs.attached_at_ms,
        // The identity the log's own file name states. `server_of` answering `None` is the honest
        // outcome for a name that carries no server, and it becomes an empty string.
        character: inputs.character.map(|name| {
            serde_json::json!({
                "name": name,
                "server": server_of(inputs.log).unwrap_or_default(),
                "logPath": inputs.log.to_string_lossy(),
            })
        }),
        // App knowledge is empty at construction and pushed afterwards: `ingest::run` applies every
        // held define before the first byte is folded, so a world the app has spoken to differs
        // from this one by exactly those pushes. They arrive through the modules' own `Defines`
        // seam rather than through this struct, because a define also has to be answerable
        // mid-fold and a construction parameter cannot be.
        //
        // `self_name` is not one of the pushed families and stays `None`, which is what the bench
        // world and every golden recorded.
        self_name: None,
        respawn_prefs: fold::modules::respawn::RespawnPrefs::default(),
    }
}

/// Which bucket this fold's observations are filed under: `` `${name}_${server}`.toLowerCase() ``
/// and nothing else.
///
/// It must be the app's spelling character for character. The key is what a re-fold matches on to
/// REPLACE a bucket rather than add to it, so a different spelling would leave two buckets in one
/// register holding the same log's observations, and the app-side reader would sum both.
///
/// A log whose file name states no character falls back to the module's own constructed default,
/// `log`: a fold that cannot say whose log it is cannot file its counts under a character. A real
/// attach cannot reach it — `ingest::run` already refuses a nameless log.
fn source_key(inputs: &SinkInputs<'_>) -> String {
    let Some(name) = inputs.character else {
        return "log".to_owned();
    };
    let server = server_of(inputs.log).unwrap_or_default();
    format!("{name}_{server}").to_lowercase()
}

/// The server out of a log's file name — the second half of what `character_of` reads.
///
/// Two shapes, the same two `ingest::character_of` accepts: the product's
/// `eqlog_<Name>_<server>.txt` and the oracle corpus's `eqlog_<Name>_<server>.<slice>.txt`. The LAST
/// underscore separates character from server, because a character name may hold one and a server
/// may not.
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
    /// One event, straight from the parser into the fold. There is nothing to decline: the payload
    /// IS what the parser wrote, and a parse that produced no event never reaches this method.
    fn event(&mut self, event: &Event<'_>) {
        self.fold
            .on_primary(&fold::event::Event::typed(event.payload), event.live);
    }

    /// The live heartbeat, straight through. One line, because the whole of the decision is
    /// `fold`'s: which modules have an `on_tick`, what each does with the number, and — the
    /// load-bearing half — that the historical path never calls it.
    ///
    /// The engine needs one because the app has aged its own fold on a wall clock for years; an
    /// engine advancing only off log timestamps served a world correct about the bytes and stale
    /// about the hour (measured on a fixture whose buffs were long expired by wall time: twelve
    /// actives engine-side against three app-side, the two folds agreeing on everything the log
    /// said).
    ///
    /// It is also the one call that says this world is live — see [`FoldSink::live`] — which makes
    /// "am I live" a fact stated by the call graph rather than a second copy of the world's status.
    fn tick(&mut self, now_ms: i64) {
        // The combat engine goes live here, on the first beat and only on it: this beat IS the
        // go-live moment — one tick at the landing, before `report_fold_landed` publishes
        // `status: "live"`, then ~1×/sec. The app orders the two the same way, so the engine is told
        // it is live before the model it owns is aged.
        //
        // Guarded on `self.live` rather than left to `set_live`'s idempotence: the guard says that
        // going live happens once per attach. A new generation is a new sink and a new engine.
        //
        // From here `hydrating` is false, so every combat answer runs the four snapshot-time sweeps
        // at the instant it is taken — the deferred encounter closure among them. A historical scan
        // reaches none of it, because the scan cannot call `tick`.
        if !self.live {
            if let Some(combat) = self.fold.combat.as_mut() {
                combat.set_live();
            }
        }
        self.live = true;
        self.beats = self.beats.saturating_add(1);
        self.fold.tick(now_ms);
        // Every sixtieth beat, the disk — the app's "every sixtieth tick" ledger persist and its
        // 60-second overlay save, which at a 1 Hz heartbeat are the same minute stated twice.
        //
        // It is in `tick` and nowhere else, which makes "nothing during a replay" a fact about the
        // call graph rather than a guard somebody has to remember. The write is coalesced on a
        // fingerprint and can never take the engine down.
        if self.beats.is_multiple_of(crate::state::WRITE_EVERY_BEATS) {
            if let Some(state) = self.state.as_mut() {
                state.write(&self.fold.registry);
            }
        }
    }

    /// What the fold can say about itself. `last_ts` is `max(ev.ts)` — the log's own clock, so a log
    /// that rolls over cannot walk it backwards.
    fn report(&self) -> SinkReport {
        SinkReport {
            events: i64::try_from(self.fold.events()).unwrap_or(i64::MAX),
            last_ts: Some(self.fold.last_ts()),
            ..SinkReport::default()
        }
    }

    /// One module's published state, straight off the registry.
    ///
    /// This splits the module's `{ seq, state }` pair rather than re-deriving either half: four
    /// modules publish a private revision counter instead of an event seq, and reading it off
    /// anything but the module's own answer would be a second opinion about a number it owns.
    fn snapshot(&self, module: &str) -> Option<ModuleSnapshot> {
        let published = self.fold.registry.snapshot_of(module)?;
        Some(ModuleSnapshot {
            seq: published.get("seq").and_then(serde_json::Value::as_i64)?,
            state: published.get("state").cloned()?,
        })
    }

    /// The view layer's door. One `match` on the source, and each arm reads its module through that
    /// module's own pull seam — never through `snapshot()`, which would serialize the whole thing
    /// to draw fifty rows of it.
    ///
    /// A source whose module is not registered answers `None`, and the view layer serves an empty
    /// window rather than refusing: the descriptor was valid, this fold simply has nothing behind
    /// it.
    fn source_rows(&self, source: &'static views::SourceDef) -> Option<Vec<views::SourceRow>> {
        let registry = &self.fold.registry;
        match source.id {
            id if id == views::loot::LEDGER.id => {
                Some(views::loot::rows(registry.loot()?, &self.clock))
            }
            id if id == views::buffs::ACTIVE.id => Some(views::buffs::rows(registry.buffs()?)),
            // Two modules, one source, and the `?` on either is what makes that honest: a registry
            // carrying one of them cannot serve half a window, so it serves none.
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
            // The meter's rows come out of the snapshot's own `selected`, at the cheapest options
            // that produce one: no finalized-fight list, no timeline, no unparsed ring. The current
            // encounter and the zone summary are included whatever the cap, so the selection
            // resolves exactly as a full-fat call resolves it.
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

    /// The app-knowledge door. One call through to the registry, which owns the mapping from a
    /// family to the module that answers for it.
    fn define(&mut self, family: &str, payload: &serde_json::Value) -> bool {
        self.fold.registry.define(family, payload)
    }

    /// The session mark, straight through to the engine that owns what one means. A sink with no
    /// engine answers `false` — no engine, no meter, nothing split.
    ///
    /// Not `combat_now()`: the instant is the caller's, stamped once app-side for the whole click so
    /// that the loot split and this split share one boundary. The fold's own clock here would put
    /// the two halves of one user action at two different instants.
    fn session_mark(&mut self, at: i64) -> bool {
        self.fold
            .combat
            .as_mut()
            .is_some_and(|engine| engine.session_mark(at))
    }

    /// The confirmed sighting, straight through to the module that owns what one means. A registry
    /// with no respawn module answers `false`, the same honest `false` the module itself gives for
    /// a row it does not carry.
    ///
    /// Through `respawn_mut` and not `respawn`, which is the compiler saying this is a write.
    fn confirm_sighting(&mut self, row_id: &str) -> bool {
        self.fold
            .registry
            .respawn_mut()
            .is_some_and(|respawn| respawn.confirm_sighting(row_id))
    }

    /// The live `/con`s the consider module saw while folding the last drain, each resolved into the
    /// card the overlay draws. `crate::concard` owns what that means.
    ///
    /// A line that names nothing is dropped here rather than sent as an empty card — a creature name
    /// that folds to no key has no queue identity — and so is a person. The corpus that decides that
    /// is the same `Arc` the registry was handed, so the card cannot disagree with a lookup.
    fn take_con_cards(&mut self) -> Vec<protocol::generated::ConCardMessage> {
        let knowledge = std::sync::Arc::clone(&self.knowledge);
        self.fold
            .registry
            .take_cons()
            .iter()
            .filter_map(|ev| crate::concard::card(ev, &*knowledge))
            .collect()
    }

    /// The module dirty bits: every registered module's published cursor, straight off the registry
    /// and without building a single module's state.
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
                // The speech fields cross the seam as the plain map and options they already are:
                // the fold resolved them, and this is a rename rather than a decision.
                captures: f.captures,
                spell: f.spell,
                due_at: f.due_at,
            })
            .collect()
    }

    /// One call through to the engine, at the instant this fold is entitled to (see
    /// [`FoldSink::combat_now`]).
    ///
    /// The roster is pulled from the registry, exactly as `Fold::observe` pulls it on every event.
    /// Anywhere else would be a second answer to "who am I grouped with" beside the one the meter's
    /// rows were attributed under, and the scope chip and the rows it filters must not disagree.
    fn combat_snapshot(&self, opts: &CombatOpts) -> Option<CombatSnapshot> {
        let engine = self.fold.combat.as_ref()?;
        let now = self.combat_now();
        Some(CombatSnapshot {
            now,
            state: engine.snapshot(now, &snapshot_opts(opts), self.fold.registry.roster()),
        })
    }

    /// The fight search. The corpus is the engine's — uncapped history plus the open fight, through
    /// its own door rather than through a snapshot — and the ranking is `crate::search`.
    fn search_fights(&self, query: &str, limit: usize) -> Option<FightSearch> {
        let engine = self.fold.combat.as_ref()?;
        let corpus = engine.fight_summaries(self.combat_now());
        Some(FightSearch {
            // The corpus is counted before the query is looked at, which is what makes an empty
            // query answer `{ hits: [], corpus: n }` rather than `corpus: 0`. A UI saying
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

    /// What you have looted off one creature — the half of a `knowledge.mob` answer that only a fold
    /// can give, read through the module's own pull seam.
    ///
    /// It is on the sink rather than on the corpus because the two halves have different lifetimes:
    /// the catalog is committed data that outlives every generation, and this is character- and
    /// epoch-scoped state the `consider` module clears on a rebirth. Joining them anywhere but at
    /// the read would mean one holding a stale copy of the other.
    ///
    /// A build with no `consider` module answers with no rows — the same value a creature nothing
    /// has been looted from answers with, so neither is a special case.
    fn own_loot_drops(&self, spellings: &[String]) -> Vec<fold::knowledge::SeenDrop> {
        self.fold
            .registry
            .own_loot()
            .map(|index| index.drops_across(spellings))
            .unwrap_or_default()
    }

    /// How old these creatures are, read through the resist module's own pull seam exactly as
    /// `own_loot_drops` reads the consider module's.
    ///
    /// The key is folded here and not by the caller: a pre-folded key on the wire would be a second
    /// opinion about a join key. `consider::mob_key` is the one spelling rule this engine has, so
    /// the app sends the name the log printed and this line files it the way a `/con` is filed.
    ///
    /// A creature with no level produces no row rather than a row full of nulls — the absence IS
    /// the answer, and the app maps name to row and reads a miss as exactly that.
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
    /// It is the corpus's ledger, not the fold's: a miss made by a `knowledge.item` op on a
    /// connection thread lands in the same place, which is why each name is announced once for the
    /// process rather than once per asker.
    fn take_knowledge_misses(&mut self) -> Vec<fold::knowledge::Miss> {
        fold::knowledge::Knowledge::take_misses(&*self.knowledge)
    }

    /// The change signal per source. Cheap by contract — a counter read, never a serialization.
    ///
    /// Three of these are coarse. `loot`, `respawn` and `buffTimers` keep real revision counters
    /// that move only when their state could have; `buffs`, `progression` and `eventFeed` do not,
    /// so they report the fold's own `seq`, which moves on every event. That never misses a change
    /// and over-reports, costing a re-cut per serve beat on a busy tail; the fix is the counters,
    /// not a cache.
    ///
    /// `timers.rows` takes the max of its two inputs, the only honest answer for a source folded
    /// from two modules: either moving could move the window.
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
            // No counter to read, and that is honest rather than a gap: every damage, miss, resist,
            // heal, charm and zone line moves some row of the meter, so "when could this have
            // changed" IS "did an event land". The event count answers that and is monotonic.
            //
            // The beats are added because the rows are a function of `now` too — a live fight's
            // `durationSec` grows while the log is quiet. The sum of two monotonic counters cannot
            // repeat across a change, so a quiet live meter re-cuts once a second and an idle
            // historical one never re-cuts at all.
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
            // No state directory, which is what makes these tests describe the same fold the
            // equivalence oracle describes: nothing read, nothing seeded, nothing written.
            state_dir: None,
        }
    }

    /// The same inputs, carrying a state directory — the attach the app makes.
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

    /// One row, in the app's exact spelling, for a named mob under a named bucket.
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
        // `${name}_${server}`, lowercased. A different spelling would file the same character's
        // counts in a second bucket and the app would sum both.
        let clock = super::test_clock();
        let log = Path::new("C:/EQ/Logs/eqlog_Primitive_freeport.txt");
        assert_eq!(source_key(&inputs(log, &clock)), "primitive_freeport");
        // A log whose name states no character falls back to the module's constructed default.
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
        // A character name may hold an underscore; the server may not, so the last one splits.
        assert_eq!(
            server_of(Path::new("eqlog_Two_Names_freeport.txt")).as_deref(),
            Some("freeport")
        );
        assert!(server_of(Path::new("notalog.txt")).is_none());
        assert!(server_of(Path::new("eqlog_Primitive_.txt")).is_none());
    }

    #[test]
    fn a_fresh_sink_folds_all_twenty_modules_and_skips_none() {
        // The no-silent-caps law, engine-side: an engine serving a registry with holes in it would
        // answer `notFound` for a module that exists.
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
        // `loot.ledger` is the trap worth pinning: it is a view source name, and a caller that
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
    /// Built through the parser's own writer rather than as a JSON literal, because the sink reads
    /// the typed half and a hand-written string would drive a path production does not take.
    ///
    /// The `seq` goes into the event as well as the envelope: a module's published `seq` comes off
    /// the event's own field, and the two agree on a real scan by construction.
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
        // The point of the seam: a snapshot taken between two events is the state after the first
        // and no part of the second.
        //
        // Two deaths, and the first one is supposed to vanish. The launch anchor resolves through
        // the parser's own clock, so the first event past it fires the `epoch` boundary — character
        // rebirth — and `kills` clears on it. That is what a real attach does, and pinning it here
        // makes a later change to the anchor announce itself as a behaviour change.
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
        // A new sink per attach is the ingest's structural guarantee that two folds never reach one
        // set of modules. The factory constructs; it never hands back something it is holding.
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

    #[test]
    fn an_attach_with_a_state_dir_seeds_both_artifacts_and_discards_its_own_bucket() {
        let dir = scratch("seed");
        // Two buckets on disk: this character's, and somebody else's. The design turns on their
        // being treated differently — one is about to be re-derived from the log, the other is
        // knowledge nothing can re-derive.
        std::fs::write(
            dir.join("resist-ledger.json"),
            ledger_of(&[
                ("primitive_freeport", "a rat"),
                ("other_bertox", "a bat"),
                // The shipped baseline's, which must be refused on read: it is re-seeded from the
                // bundle on every launch and counting it here would count it twice.
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

        // One row, not three: `other_bertox` survived, `primitive_freeport` was discarded by
        // `begin_source` because its log is about to state its whole content again, and `baseline`
        // was never read at all.
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

        // A historical scan writes nothing and cannot: it folds events and never ticks, and the
        // write lives in `tick` alone. Overwrite with junk and prove the scan leaves it there.
        std::fs::write(dir.join("resist-ledger.json"), "scan must not touch this")
            .expect("junk is written");
        for seq in 0..3 {
            kill(&mut sink, seq);
        }
        assert_eq!(
            std::fs::read_to_string(dir.join("resist-ledger.json")).expect("readable"),
            "scan must not touch this"
        );

        // The sixtieth beat writes and fifty-nine do not — the app's "every sixtieth tick" at 1 Hz.
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
        // The baseline is not in the file: it is compiled into the binary and merged at
        // construction, so a copy in userData would be 400 kB of staler duplicate.
        assert!(!overlay.contains(r#""key":"baseline""#), "{overlay}");
        // No scratch file left behind by either write.
        assert!(!dir.join("resist-ledger.json.tmp").exists());
        assert!(!dir.join("message-overlay.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_a_state_dir_nothing_is_read_and_nothing_is_written() {
        // The oracle's world: an attach that names no profile directory neither reads a file nor
        // writes one, so the fold is a pure function of its bytes. The directory here holds a file
        // the sink would certainly have read had it been told to.
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
