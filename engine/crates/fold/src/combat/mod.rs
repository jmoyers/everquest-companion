//! ============================================================================
//! combat — THE COMBAT ENGINE, IN RUST (JOS-459 phase 2d; the ticket is JOS-477).
//! ============================================================================
//!
//! `src/main/combat/` is ~33 files and 12,400 lines: a formal state machine over the log stream
//! (`engine.ts` as the facade over `state.ts` + `ingest.ts`, with routing / rounds / healing /
//! procDetect / world / charmModel / taxonomy / stateTimeline / mergeSessions beside it). This module
//! is its port, and as of JOS-477's final landing it is WHOLE for everything the snapshot publishes:
//! `combat` and `scopes` agree with the golden on every leaf of all six slices.
//!
//! ── A SUBMODULE OF `fold`, NOT A CRATE OF ITS OWN, AND THE ARGUMENT FOR IT ─────────────────────
//!
//! The ticket left the call open. Three things decide it, and all three point the same way:
//!
//!   1. THE BUS ORDER IS A DISPATCH FACT, NOT A LAYERING ONE. The engine is a subscriber that sits
//!      AFTER the twenty modules and BEFORE the epoch/offline-gap detectors (`pipeline.ts:311,326`,
//!      `foldArm.mts construct()`). `Fold::on_primary` is the loop that owns that order. A separate
//!      crate would have to be driven BY `fold` — so `fold` would depend on it — while the roster
//!      PULL (below) makes it depend on `fold` in turn. That is a cycle, and the only ways out are
//!      a third crate holding `Event` and the `EqModule` trait, or a callback the caller wires by
//!      hand. Both are structure bought to keep two files apart.
//!   2. THE ROSTER SEAM IS A PULL ACROSS THE SAME BOUNDARY. `engine.ts:215` installs a closure onto
//!      cluster 2b's `roster` MODULE, and the engine reads it DURING dispatch. Here that is
//!      `EqModule::as_roster` — a defaulted trait method on the registry's own contract. Split
//!      across crates it becomes a public trait in a shared crate plus two impls, for one method.
//!   3. IT REUSES THIS CRATE'S PORTS WHOLESALE — `Event`, `JsMap` (JS `Map` iteration order, which
//!      every published array here depends on), `jsfn`, and `eqlog::names`/`jsstr`. The README's
//!      rule is "reach for the existing ports before writing a helper"; a crate boundary is a
//!      standing invitation to write the second spelling.
//!
//! So: one file per TS module under `combat/`, exactly the recipe `modules/` follows.
//!
//! ── WHAT IS PORTED, AND THE FOUR THINGS THAT DELIBERATELY ARE NOT ─────────────────────────────
//!
//! PORTED: the construction, the log-clock snapshot contract, the world model, the whole attribution
//! ladder, the encounter and zone-stay lifecycles, every accumulator on the `Agg` (damage, healing,
//! rounds, modifiers, the proc ledger and the minute-window ledger), the active-state timeline, the
//! blade coats, the cast-less proc detector, all six view builders, the per-fight timeline, and the
//! PER-SCOPE WALK the acceptance oracle is built on.
//!
//! NOT PORTED, and each absence is a PROOF rather than a gap — every one is unreachable under the
//! construction `foldArm.mts` actually makes, and the goldens agree:
//!
//!   * `unsplit()` (`mergeSessions.ts`) — the engine-level UNDO of a session mark. No UI calls it
//!     over there either ("*the capability to merge it back, but not put that in the app*"), so it
//!     is an absence on both sides rather than a divergence.
//!   * FIGHT SEARCH (`fightSearch.ts`) and the fold PROBE (`foldProbe.ts`). Neither is on the
//!     snapshot path at all: one answers a search box, the other is the bench's own instrumentation.
//!
//! ── THREE THINGS LEFT THAT LIST, AND ALL THREE LEFT IT THE SAME WAY ───────────────────────────
//!
//! THE PET NUDGE (`petnudge.rs`, JOS-488), THE CLASSIFICATION RING (`st.recent` and its forty call
//! sites, JOS-492) and THE SESSION MARK ([`CombatEngine::session_mark`], JOS-492) are real code now.
//! NOT ONE GOLDEN MOVED, and the reason is the same for each: what used to be an absent MODEL is now
//! a shut GATE, and the gate is the TypeScript's own.
//!
//!   * the nudge is armed only by `if !hydrating && is_pet_summon_spell(…)`;
//!   * the ring is written only `if recording`;
//!   * a mark is refused by `if hydrating { return false }`.
//!
//! The recorder never calls `set_live()`, so all three read false for every recorded byte: no
//! `petNudge` key, `recent: []`, and `closedBy: 'zone'` on every zone session in every slice. THAT
//! IS THE DIFFERENCE THE CUTOVER TICKETS WERE FOR — the same absence, stated by the thing that
//! causes it, so a LIVE engine stops publishing an empty answer where the app publishes a real one.
//!
//! NOTHING HERE IS STUBBED WITH A PLAUSIBLE VALUE, which is what let the ledger measure the gap
//! honestly while it existed: every number this module published was a number it had actually folded.
//!
//! ── CACHE TRANSPARENCY (ruling 18) ────────────────────────────────────────────────────────────
//!
//! NO WALL CLOCK, EVER. `snapshot(now, …)` takes `now` as a PARAMETER and the recorder passes the
//! slice's LAST EVENT TS — never `Date.now()`. That is `goldenOracle.mts`'s rule and it is not a
//! recording convenience: the hydrating gate, the deferred encounter closure, the charm sweep and
//! the ally-bind expiry all evaluate against it, so a fold that read the host clock would answer a
//! different question every day it ran.
//!
//! **AND THE DETERMINISM IS THE HYDRATING GATE'S, NOT THE SNAPSHOT'S PURITY** (JOS-488). A live
//! snapshot AGES THE MODEL — that is what the four sweeps are — so `snapshot()` is a mutating read
//! over there and is one here too. Ruling 18 law 1 is untouched, and it is untouched structurally:
//! while `hydrating` the sweep block is not entered at all, so a mid-fold answer touches nothing and
//! re-asking it at the same `seq` gives the same object. See [`CombatEngine::snapshot`] for why the
//! mutation lives behind a `RefCell` instead of a `&mut self` that would have repainted the engine's
//! whole reader seam.

pub mod aggregate;
pub mod ally;
pub mod charm;
pub mod collate;
pub mod encounter;
pub mod healing;
pub mod ingest;
pub mod lifecycle;
pub mod others;
pub mod petnudge;
pub mod poisons;
pub mod procbuffs;
pub mod procdetect;
pub mod procrouting;
pub mod procviews;
pub mod procwindows;
pub mod roster;
pub mod rounds;
pub mod routing;
pub mod spellfacts;
pub mod state;
pub mod statetimeline;
pub mod timeline;
pub mod views;
pub mod world;

pub use encounter::ZoneSessionClose;
pub use roster::{RosterMember, RosterSnap, RosterSource};

use crate::event::Event;
use encounter::{ACTIVE_MS, SLOW_SAMPLE_CAP};
use serde::Serialize;
use serde_json::{json, Value};
use state::EngineState;
use std::cell::RefCell;

/// HOW MANY CLASSIFIED LINES ONE SNAPSHOT CARRIES — `st.recent…slice(-150)`, the newest 150.
///
/// Half the ring's own bound on purpose: the ring is what the ENGINE remembers and this is what a
/// PAYLOAD costs, and the two are different budgets. A panel showing the last 150 lines while the
/// model holds 300 is what lets `showUnparsed` be a client-side question with a real answer either
/// way — the 150 it ships are 150 of whichever set was asked for.
const RECENT_VIEW: usize = 150;

/// `shared/combat.ts SnapshotOpts`. The golden's full-fat call is
/// `{ maxSegments: 100_000, timeline: true, showUnparsed: true }` and the per-scope walk's is
/// `{ selectedId, maxSegments: 1 }`.
#[derive(Debug, Clone, Default)]
pub struct SnapshotOpts {
    pub selected_id: Option<String>,
    /// Include lines the engine could not classify (damage-shaped but unmatched). Reads the
    /// classification ring, which a historical fold never writes — see `state.rs` fact 2.
    pub show_unparsed: bool,
    /// Cap on how many finalized-fight summaries to serialize, newest-first. The current encounter
    /// and the zone summary are ALWAYS included regardless of the cap. A selected finalized fight
    /// OUTSIDE the cap is still fully resolvable through `selected`, which searches history
    /// directly — the cap is a payload bound, never a retention one.
    pub max_segments: usize,
    /// Include the SELECTED encounter's event timeline. Off by default: the timeline payload is
    /// heavier than the bar view, so it is only fetched when the view is in Timeline mode.
    pub timeline: bool,
}

impl SnapshotOpts {
    /// The recorder's full-fat options.
    pub fn full() -> Self {
        SnapshotOpts {
            selected_id: None,
            show_unparsed: true,
            max_segments: 100_000,
            timeline: true,
        }
    }

    /// The per-scope walk's options — one segment, one resolved selection, no timeline.
    pub fn scope(id: &str) -> Self {
        SnapshotOpts {
            selected_id: Some(id.to_string()),
            show_unparsed: false,
            max_segments: 1,
            timeline: false,
        }
    }
}

/// The rolling time-to-slow rollup. Statistics are computed over the LANDED samples ONLY and the
/// nulls are surfaced as `noLand` so the reader sees both halves. With no landed samples every
/// statistic is ABSENT rather than 0 — "0 ms to slow" would be a lie about a thing that never
/// happened (law 5).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlowRollup {
    pulls: usize,
    landed: usize,
    no_land: usize,
    window: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    avg_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    median_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_ms: Option<i64>,
}

/// The live stance/invocation pair, as the snapshot carries it. Every field is ABSENT rather than
/// null when never observed this session.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StanceState {
    #[serde(skip_serializing_if = "Option::is_none")]
    stance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stance_ts: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    invocation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    invocation_ts: Option<i64>,
}

/// THE PUBLIC FACE: one engine owning one `EngineState`, plus snapshot assembly.
pub struct CombatEngine {
    /// ── WHY THE STATE IS BEHIND A `RefCell` (JOS-488) ─────────────────────────────────────────
    ///
    /// `engine.ts snapshot(now)` IS A MUTATING READ: when the fold is live it sweeps the charm binds,
    /// the ally binds and the pet nudge, and it evaluates deferred encounter closure — at `now`,
    /// before it serializes anything. That is not an implementation detail to be optimized away.
    /// The closure it evaluates FINALIZES the open fight, so the next event, the next poll and the
    /// next view frame all have to see it; computing it into a throwaway copy would leave the engine
    /// holding a fight the answer said was over, and cloning an uncapped `history` ten times a second
    /// to avoid saying so is not a cost this pays.
    ///
    /// THE ALTERNATIVE WAS TO REPAINT THE READER SEAM `&mut`, and it reaches further than it looks:
    /// `EventSink::combat_snapshot` is `&self` because `EventSink::source_rows` is, and that one is
    /// held by the view layer's `Rows` trait behind a `&dyn` the diff protocol's serve pass owns. One
    /// mutating answer would have turned four signatures in three files `&mut` — for a mutation that
    /// belongs to the engine and to nothing else, on a thread the sink provably never leaves
    /// (`EventSink` is deliberately not `Send`, and `Fold` already holds the buffs core in an
    /// `Rc<RefCell<…>>` for exactly this reason).
    ///
    /// SO THE CELL IS THE HONEST SHAPE: the engine ages ITSELF while answering, the callers keep
    /// saying what they mean, and the borrow is taken and dropped inside one method. It can never be
    /// held across a call into anything that could re-enter — `snapshot()` and `fight_summaries()`
    /// are the only borrowers, neither calls the other, and `walk_scopes` finishes each answer before
    /// asking for the next.
    st: RefCell<EngineState>,
    /// Whose log this is, held so `reset()` can re-inject it the way every construction path does
    /// (`reset()` then `setPlayerName`).
    player_name: Option<String>,
}

impl Default for CombatEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl CombatEngine {
    pub fn new() -> Self {
        CombatEngine {
            st: RefCell::new(EngineState::new()),
            player_name: None,
        }
    }

    /// Inject the player's own character name. `goldenOracle.mts characterOf` derives it from the
    /// SLICE FILENAME (`eqlog_<Name>_<server>.<slice>.txt`) rather than hardcoding it, so the
    /// corpus and the harness cannot drift apart silently; `parity` reads it the same way through
    /// `eqlog::character_of`.
    pub fn set_player_name(&mut self, name: &str) {
        self.player_name = Some(name.to_string());
        self.st.get_mut().set_player_name(name);
    }

    pub fn reset(&mut self) {
        self.st.get_mut().reset();
        if let Some(name) = self.player_name.clone() {
            self.st.get_mut().set_player_name(&name);
        }
    }

    /// THE SCAN HAS HANDED OVER TO THE TAIL — `engine.ts setLive()`, and the one call that turns a
    /// replay into a present moment.
    ///
    /// `session.ts` makes it at the end of the historical scan, BEFORE the tailer is started and
    /// before the heartbeat's first `registry.tick(Date.now())`; `engined::foldsink` makes it in the
    /// same place, on the go-live beat. From here on `hydrating` is false, so every snapshot runs the
    /// four sweeps at the instant it was asked for — see [`CombatEngine::snapshot`].
    ///
    /// A HISTORICAL FOLD NEVER CALLS IT, and that is what keeps the equivalence oracle whole: the
    /// parity harness and the golden recorder both fold and ask, and neither has a tail to hand over
    /// to. The sweeps are not skipped there by a flag somebody remembered to set — they are
    /// unreachable, because nothing in that path can reach this method.
    pub fn set_live(&mut self) {
        self.st.get_mut().set_live();
    }

    /// Is this engine still replaying? The flag the snapshot publishes, for a caller that needs it
    /// without serializing a whole meter.
    #[must_use]
    pub fn hydrating(&self) -> bool {
        self.st.borrow().hydrating
    }

    /// Fold one canonical event.
    ///
    /// `live` IS THE BELT-AND-BRACES HALF OF GOING LIVE, and it is `ingestOne`'s own first two lines:
    /// a LIVE event is by definition an event the tail delivered, so a world that somehow folded one
    /// without having been told it was live is live anyway. `set_live()` is the ordinary path and
    /// this is the one that cannot be forgotten. (It also matters WITHIN this event: the pet-summon
    /// nudge is gated on `!hydrating`, so a live `You begin casting` in the very first tail delivery
    /// must find the flag already cleared.)
    ///
    /// `recording` is set with it and drives the classification ring, which is not ported — the gap
    /// the module header names rather than a flag with nothing behind it.
    ///
    /// The ROSTER is refreshed first and once, which `state.rs RosterFacts` argues is exactly the
    /// per-decision live pull rather than an approximation of it: the roster module is registered
    /// before the engine, so it has already advanced for this line, and nothing on this dispatch
    /// path can write it.
    pub fn on_event(&mut self, ev: &Event, live: bool, roster: Option<&dyn RosterSource>) {
        let st = self.st.get_mut();
        if live {
            st.set_live();
        }
        st.refresh_roster(roster);
        ingest::ingest_event(st, ev);
    }

    /// A SESSION MARK — "start a new session now", as the ENGINE's records hear it (JOS-322,
    /// ported by JOS-492). `engine.ts sessionMark`, line for line.
    ///
    /// It is the move a ZONE LINE makes, MINUS THE ROOM CHANGE, and that omission is the design:
    /// close the open fight, freeze the running stay into the browsable history tagged
    /// `closedBy: 'mark'`, and mint fresh accumulators. Everything the zone case does beyond that
    /// — retiring the world's mobs, breaking charm, retiring pets, zoning the ally model — is a
    /// statement about having LEFT, and you have not left. So `st.zone` keeps its value,
    /// `world.zone()` is never called, the coats, stances, specials and the session-level state
    /// timeline all run straight through; segment views clip timeline spans to each record's own
    /// span at read time, so a stance spanning the mark reads correctly in BOTH records.
    ///
    /// REFUSED WHILE HYDRATING, and that refusal is what makes replay determinism STRUCTURAL
    /// rather than careful: a mark is a user action, is stored nowhere, and cannot enter a
    /// replaying engine at all — so the JOS-208 replay-vs-live divergence class has no way to
    /// recur here. It is also what keeps the six-slice oracle whole: the golden recorder never
    /// calls `set_live()`, so `hydrating` is true for every recorded byte and this method can
    /// only ever answer `false` there. `closedBy` stays `zone` on every zone session in every
    /// golden, exactly as it was before this existed.
    ///
    /// `ts` IS THE INSTANT THE CALLER STAMPED for the whole click (`src/main/sessionMarks.ts`),
    /// which is what makes the loot split and this split share one boundary. The closure it runs
    /// first is the same wall-clock evaluation `snapshot(now)` runs, so a fight that already ended
    /// by the log's own clock is closed at ITS last damage ts rather than dragged across the
    /// boundary.
    ///
    /// AN EMPTY STAY MINTS NOTHING (`finalize_zone_session`'s own drop rule), which is also what
    /// makes a double-click harmless — the same property the app's `addSessionMark` dedupe gives
    /// the loot half.
    ///
    /// Returns whether the mark was ACCEPTED (false only while hydrating). Whether it minted a
    /// record is a different question, and the honest answer to it is the history itself.
    ///
    /// `&mut self` RATHER THAN THE SNAPSHOT'S `&self` CELL, because this one has a choice: a mark
    /// arrives through a command door the caller owns exclusively, so nothing here is threaded
    /// behind a `&dyn` reader seam and the borrow checker can state the mutation outright.
    pub fn session_mark(&mut self, ts: i64) -> bool {
        let st = self.st.get_mut();
        if st.hydrating {
            return false;
        }
        lifecycle::eval_closure(st, ts);
        lifecycle::finalize_current(st);
        st.finalize_zone_session(ZoneSessionClose::Mark);
        st.reset_zone_accumulators();
        true
    }

    /// The snapshot, at the instant it is asked for — the log's own while replaying, the wall clock
    /// once the tail is running, and the caller's to choose either way.
    ///
    /// ── THE FOUR SWEEPS, AND THE ONE FLAG THAT DECIDES WHETHER THEY RUN ───────────────────────
    ///
    /// Encounters can close purely from elapsed time (death-linger / fallback), an uncorroborated
    /// charm bind expires on the same wall clock, an ally bind cannot outlive its own spell, and the
    /// pet nudge is a pure display timer. A snapshot may be the FIRST OBSERVATION past any of those
    /// deadlines — the log can go quiet for a minute at a time and a screen must not — so this is
    /// the second of the two places each of them is evaluated, the other being every ingested event.
    ///
    /// …BUT NOT WHILE THE HISTORICAL FOLD IS STILL RUNNING. A REPLAY IS NOT A MOMENT IN TIME: every
    /// line in a months-old log is weeks behind the host clock, and a poll landing between two replay
    /// slices used to finalize whatever fight was open and hand the rest of it to a fresh encounter —
    /// MEASURED app-side, one 53,577-damage fight splitting into 43,504 + 10,073 under load (JOS-208
    /// phase 4). `hydrating` is exactly the right question and it is the whole gate: true from
    /// `reset()` until `set_live()`, true for the whole of every recorded slice, and true for every
    /// answer the equivalence oracle has ever compared. Closure from the LOG's own clock is untouched
    /// either way — `ingest_event` evaluates it per event, so a fight that really ended still ends,
    /// at the instant the log says.
    ///
    /// THE ORDER IS THE TS'S, and it is not arbitrary: charm, then ally, then the nudge, then
    /// closure. The charm sweep UNCHARMS through the world model, which is evidence the closure test
    /// then reads (`hostile_presence` excludes a live pet), so evaluating closure first would ask
    /// about a world one sweep out of date.
    ///
    /// `&self` AND A MUTATION BEHIND IT — see the `st` field for the whole argument. The short
    /// version: the sweeps ARE the answer, they belong to the engine, and while hydrating nothing
    /// here writes anything at all.
    pub fn snapshot(
        &self,
        now: i64,
        opts: &SnapshotOpts,
        roster: Option<&dyn RosterSource>,
    ) -> Value {
        let mut guard = self.st.borrow_mut();
        if !guard.hydrating {
            let st = &mut *guard;
            st.sweep_charm(now);
            // …and the ally binds on the same clock and for the same reason (JOS-250): a charm cannot
            // outlive its own spell, and the deadline must be observed by whichever of the two readers
            // reaches it first.
            st.sweep_ally(now);
            // …and the pet nudge (JOS-258), which is a pure display timer: the log can go quiet for a
            // minute at a time and a sentence on the screen must still come off it when it said it would.
            st.pet_nudge.sweep(now);
            lifecycle::eval_closure(st, now);
        }
        // Read-only from here down, and the borrow is released with this function.
        let st: &EngineState = &guard;

        // The finalized fight summaries, newest-first and capped, then the whole-stay row the
        // caller appends. The current encounter is always included regardless of the cap.
        let mut segments = lifecycle::collect_segments(st, now, opts.max_segments);
        segments.push(lifecycle::zone_summary(st));

        // `inCombat` — the ONE thing `now` decides in a historical fold besides a summary's
        // `active` flag: whether the open fight's last damage is inside the freshness window.
        let in_combat = st
            .current
            .as_ref()
            .is_some_and(|e| now - e.last_ts < ACTIVE_MS);

        let selected_id = resolve_selected_id(st, opts);
        let selected = match views::build_selected(st, &selected_id, now) {
            Some(v) => serde_json::to_value(v).unwrap_or(Value::Null),
            // NULL, not an empty shell: with no fights at all the selection resolves to nothing, and
            // the UI shows a quiet "no fights yet".
            None => Value::Null,
        };

        // `recent` — THE CLASSIFICATION RING (JOS-492), empty for the whole of a historical fold
        // because `recording` is false for the whole of one.
        //
        // THE FILTER THEN THE SLICE, in that order, which is the app's own and is not
        // interchangeable: `showUnparsed` false drops the `unparsed` rows FIRST and the newest 150
        // of what is LEFT is what ships, so a burst of refused lines cannot push every classified
        // one out of a panel that was not showing them anyway.
        let kept: Vec<&state::ClassifiedLine> = st
            .recent
            .iter()
            .filter(|r| opts.show_unparsed || r.cat != "unparsed")
            .collect();
        let recent: Vec<Value> = kept[kept.len().saturating_sub(RECENT_VIEW)..]
            .iter()
            .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
            .collect();

        let mut out = json!({
            "selectedId": selected_id,
            "selected": selected,
            "segments": segments,
            "inCombat": in_combat,
            "recent": recent,
            "stance": stance_state(st),
            "poison": { "coat": coat_state(st), "slow": slow_rollup(st) },
            "zoneSessions": lifecycle::zone_session_summaries(st),
            "hydrating": st.hydrating,
            "roster": st.roster_snap(roster),
        });
        // ABSENT IS NOT NULL. `zone` is undefined until the first `You have entered X.` line,
        // `currentTarget` whenever no fight is open or the open one has landed no outgoing hit, and
        // `timeline` whenever the selection resolves to no timeline-carrying segment. All three are
        // dropped by `JSON.stringify` over there and must be dropped here.
        if let Some(zone) = &st.zone {
            out["zone"] = json!(zone);
        }
        if let Some(target) = current_target(st) {
            out["currentTarget"] = json!(target);
        }
        // `timeline: opts.timeline ? buildTimeline(...) : undefined` — so the key is ABSENT when the
        // caller did not ask, and present-and-NULL when it asked and the selection resolved to no
        // timeline-carrying segment (the zone scope, or a fight whose ring the history cap evicted).
        // `JSON.stringify` drops the first and keeps the second, and so does this.
        if opts.timeline {
            out["timeline"] = timeline::build_timeline(st, &selected_id, now)
                .and_then(|t| serde_json::to_value(t).ok())
                .unwrap_or(Value::Null);
        }
        // THE PET NUDGE (JOS-258) — ABSENT in every state but the one, which is what keeps the "no
        // persistent banner" promise structural. It reads the SAME `now` the sweep above just used,
        // so a nudge can never survive the poll that expired it, and a historical fold cannot arm one
        // at all: no golden carries this key and none may start to.
        if let Some(nudge) = st.pet_nudge.view(now) {
            out["petNudge"] = serde_json::to_value(nudge).unwrap_or(Value::Null);
        }
        out
    }

    /// THE FIGHT-SEARCH CORPUS (JOS-485) — `engine.ts searchFights`'s own, and nothing else.
    ///
    /// The open fight as `kind: "current"`, then every finalized encounter NEWEST-FIRST and
    /// UNCAPPED, which is `collect_segments` at the cap `snapshot()` never passes: over there
    /// `history` is uncapped (only the per-encounter timeline rings and the zone list are capped),
    /// so "search goes back for all time" needs no storage that does not already exist. It is a
    /// separate door rather than a read of `snapshot()` because a search must not pay for a
    /// selection, a zone list, a stance and a roster it throws away — and because the whole-stay
    /// `kind: "zone"` row that `snapshot()` appends is not a fight and must not be findable as one.
    ///
    /// READ-ONLY, like every other reader here: no closure evaluation, no memoization, nothing
    /// mutated. Typing in a search box must never be able to finalize a fight.
    pub fn fight_summaries(&self, now: i64) -> Vec<Value> {
        lifecycle::collect_segments(&self.st.borrow(), now, usize::MAX)
            .into_iter()
            .filter_map(|s| serde_json::to_value(s).ok())
            .collect()
    }

    /// THE PER-SCOPE WALK, exactly as `goldenOracle.mts walkScopes` performs it: every ZONE SESSION
    /// and every FINALIZED FIGHT resolved through the same `snapshot({selectedId})` door the UI
    /// uses, so a change that moved a number the UI shows cannot hide behind an internal field that
    /// did not move.
    ///
    /// UNCAPPED. `engineOracle.mts` caps its walk at 25 fights because a human diffs that file by
    /// eye; this one is diffed by a program, and a cap is a HOLE in an acceptance oracle — a Rust
    /// engine could be wrong about fight 26 and pass.
    ///
    /// ZONE SESSIONS COME FROM `base.zoneSessions` AND FIGHTS FROM `base.segments` WITH `kind ==
    /// 'zone'` SKIPPED, in that order, because that is the order the golden's array is in and array
    /// order is a claim the comparator checks.
    pub fn walk_scopes(&self, now: i64, roster: Option<&dyn RosterSource>) -> Vec<Value> {
        let base = self.snapshot(now, &SnapshotOpts::full(), roster);
        let mut out = Vec::new();
        for zs in base["zoneSessions"].as_array().into_iter().flatten() {
            let id = zs["id"].as_str().unwrap_or_default().to_string();
            let sel = self.snapshot(now, &SnapshotOpts::scope(&id), roster);
            out.push(json!({ "kind": "zoneSession", "id": id, "selected": sel["selected"] }));
        }
        for seg in base["segments"].as_array().into_iter().flatten() {
            if seg["kind"] == "zone" {
                continue;
            }
            let id = seg["id"].as_str().unwrap_or_default().to_string();
            let sel = self.snapshot(now, &SnapshotOpts::scope(&id), roster);
            out.push(json!({ "kind": "fight", "id": id, "selected": sel["selected"] }));
        }
        out
    }
}

/// DEFAULT SELECTION = the FIGHT scope's head row: the open fight if there is one, else the most
/// recent finalized fight. It must never wander into the zone aggregate — a meter that swapped to
/// zone-overall between pulls is exactly what the owner rejected. Overall is reached by ASKING for a
/// zone-session id (`zone` / `zs<n>`), never by default. With no fights at all it resolves to
/// nothing and the selection is empty, which is the honest answer.
///
/// AN EXPLICIT REQUEST IS VALIDATED AGAINST ALL ENCOUNTERS, not just the capped segment window — a
/// selected finalized fight OUTSIDE the cap is still fully resolvable, because the cap is a PAYLOAD
/// bound and never a retention one.
fn resolve_selected_id(st: &EngineState, opts: &SnapshotOpts) -> String {
    let default_id = st
        .current
        .as_ref()
        .map(|e| e.id.clone())
        .or_else(|| st.history.last().map(|e| e.id.clone()))
        .unwrap_or_default();
    let Some(want) = opts.selected_id.as_deref().filter(|s| !s.is_empty()) else {
        return default_id;
    };
    let selectable = want == "zone"
        || st.current.as_ref().is_some_and(|e| e.id == want)
        || st.history.iter().any(|h| h.id == want)
        || st.zone_history.iter().any(|z| z.id == want);
    if selectable {
        want.to_string()
    } else {
        default_id
    }
}

/// The mob in front of you (world-model law 6, LIVE half). ABSENT when no encounter is open or when
/// the open encounter has not yet landed an outgoing hit — never a guess, and never the largest
/// target, which is the FINALIZED naming rule and would relabel a live pull retroactively.
///
/// READ-ONLY, and deliberately does NOT evaluate closure: the snapshot has already done that before
/// it asks, so a fight that just closed on elapsed time reports nothing.
fn current_target(st: &EngineState) -> Option<Value> {
    let e = st.current.as_ref()?;
    let name = e.last_out_target.as_ref()?;
    Some(json!({
        "name": name,
        "others": e.agg.targets.len().saturating_sub(1),
        "lastTs": e.last_ts,
    }))
}

/// The live blade-coat pair, copied out so a consumer cannot mutate engine state.
///
/// EVERY consumer must render ALL of them. The header pill showed only the UTILITY slot until
/// 2026-08-04, which meant a rogue running the usual asp + siphoning + stunning with no utility poison
/// on saw NOTHING at all in the passive readout.
fn coat_state(st: &EngineState) -> Value {
    let mut out = json!({ "combat": st.coat_combat });
    if let Some(u) = &st.coat_utility {
        out["utility"] = json!(u);
    }
    out
}

fn stance_state(st: &EngineState) -> StanceState {
    StanceState {
        stance: st.stance.as_ref().map(|m| m.name.clone()),
        stance_ts: st.stance.as_ref().map(|m| m.ts),
        invocation: st.invocation.as_ref().map(|m| m.name.clone()),
        invocation_ts: st.invocation.as_ref().map(|m| m.ts),
    }
}

/// `engine.ts slowRollup`. The median of an even-length sample is the ROUNDED mean of the two
/// middle values, and the mean is rounded too — `Math.round`, which is round-half-UP and not
/// Rust's round-half-away-from-zero. Every sample here is a non-negative duration, so the two agree
/// on this input; the distinction is written down because a negative would split them.
fn slow_rollup(st: &EngineState) -> SlowRollup {
    let mut landed: Vec<i64> = st.slow_samples.iter().flatten().copied().collect();
    landed.sort_unstable();
    let pulls = st.slow_samples.len();
    let mut out = SlowRollup {
        pulls,
        landed: landed.len(),
        no_land: pulls - landed.len(),
        window: SLOW_SAMPLE_CAP,
        avg_ms: None,
        median_ms: None,
        min_ms: None,
        max_ms: None,
    };
    if landed.is_empty() {
        return out;
    }
    let sum: i64 = landed.iter().sum();
    let mid = landed.len() >> 1;
    out.avg_ms = Some(js_round(sum as f64 / landed.len() as f64));
    out.median_ms = Some(if landed.len() % 2 == 1 {
        landed[mid]
    } else {
        js_round((landed[mid - 1] + landed[mid]) as f64 / 2.0)
    });
    out.min_ms = Some(landed[0]);
    out.max_ms = Some(landed[landed.len() - 1]);
    out
}

/// `Math.round` — ROUND HALF UP, which is not `f64::round` (round half away from zero). They differ
/// only for negatives; this is spelled out so a later reader does not "simplify" it.
fn js_round(v: f64) -> i64 {
    (v + 0.5).floor() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(lines: &[&str]) -> CombatEngine {
        let mut e = CombatEngine::new();
        e.set_player_name("Primitive");
        for line in lines {
            let ev = Event::from_json(line).expect("a JSON object");
            e.on_event(&ev, false, None);
        }
        e
    }

    /// The same fold, then the handover the tail makes — `engined::foldsink`'s go-live beat, and
    /// `session.ts`'s `combat.setLive()` before it.
    fn fold_then_go_live(lines: &[&str]) -> CombatEngine {
        let mut e = fold(lines);
        e.set_live();
        e
    }

    /// One outgoing hit, as the parser emits it.
    fn hit(seq: i64, ts: i64, amount: i64) -> String {
        format!(
            r#"{{"kind":"damage","seq":{seq},"ts":{ts},"raw":"d","attacker":"You","target":"a kodiak","amount":{amount},"dtype":"spell","skill":"Smiting Strike","crit":false}}"#
        )
    }

    /// A historical fold never leaves hydration, and the whole snapshot-time sweep block hangs off
    /// that one flag — `state.rs` fact 1, which every one of the six goldens agrees with.
    #[test]
    fn a_historical_fold_stays_hydrating_and_records_no_lines() {
        let e = fold(&[r#"{"kind":"zone","seq":0,"ts":10,"raw":"z","zone":"Innothule Swamp"}"#]);
        let snap = e.snapshot(10, &SnapshotOpts::full(), None);
        assert_eq!(snap["hydrating"], json!(true));
        assert_eq!(snap["recent"], json!([]));
    }

    /// …AND THE HANDOVER IS THE ONLY THING THAT CHANGES THAT (JOS-488). Before the go-live call the
    /// answer is `hydrating: true`; after it, `false`. Nothing else in this engine writes the flag
    /// except a LIVE event, which is the belt-and-braces half of the same handover.
    #[test]
    fn hydrating_is_true_until_the_handover_and_false_after_it() {
        let lines = [r#"{"kind":"zone","seq":0,"ts":10,"raw":"z","zone":"Najena"}"#];
        let mut e = fold(&lines);
        assert!(
            e.hydrating(),
            "a fold that has not handed over is replaying"
        );
        assert_eq!(
            e.snapshot(10, &SnapshotOpts::full(), None)["hydrating"],
            json!(true)
        );

        e.set_live();
        assert!(!e.hydrating());
        assert_eq!(
            e.snapshot(10, &SnapshotOpts::full(), None)["hydrating"],
            json!(false)
        );

        // …and the fallback path, with no `set_live()` at all: one event the tail delivered says the
        // same thing, and says it before the rest of that event is folded.
        let mut e = fold(&lines);
        let ev = Event::from_json(&hit(1, 1_000, 10)).expect("a JSON object");
        e.on_event(&ev, true, None);
        assert!(!e.hydrating(), "a live event is a live world");
    }

    /// A LIVE FIGHT CLOSES ON ELAPSED TIME, AT THE SNAPSHOT — the death-linger arm of
    /// `eval_closure`, reached by a poll rather than by a line, which is the whole reason the sweep
    /// block exists. The mob has not been seen for `PRESENCE_GONE_MS` and the linger has elapsed, so
    /// the fight is over and the meter says so without waiting for the log to speak again.
    #[test]
    fn a_live_snapshot_closes_a_fight_the_log_stopped_talking_about() {
        let e = fold_then_go_live(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            &hit(1, 1_000, 500),
        ]);
        let now = 1_000 + encounter::PRESENCE_GONE_MS;

        let snap = e.snapshot(now, &SnapshotOpts::full(), None);
        assert_eq!(
            snap["segments"][0]["kind"],
            json!("fight"),
            "the open fight was finalized by the poll: {snap}"
        );
        assert_eq!(snap["inCombat"], json!(false));
        // FINALIZED AT THE FIGHT'S OWN CLOCK, never at `now` — the closure is deferred, the fight is
        // not. A fight stamped at the eval moment would have grown by the twenty seconds of silence
        // that closed it; this one is still the one-second floor its single hit earns.
        assert_eq!(snap["segments"][0]["startTs"], json!(1_000));
        assert_eq!(snap["segments"][0]["durationSec"], json!(1.0));
        assert_eq!(snap["segments"][0]["active"], json!(false));
        assert_eq!(snap["segments"][0]["total"], json!(500));
        assert!(
            snap.get("currentTarget").is_none(),
            "a fight that just closed reports no target"
        );
    }

    /// …AND A MID-FOLD SNAPSHOT NEVER DOES ANY OF THAT — the JOS-208 pin, and the reason the gate is
    /// `hydrating` rather than a policy somebody remembers to apply.
    ///
    /// The same two lines, the same instant, and a `now` far past every deadline: the fight stays
    /// OPEN, and the hit that arrives afterwards lands in it. A replay whose fight had been
    /// finalized by a poll would hand the rest of that fight to a fresh encounter — MEASURED, one
    /// 53,577-damage fight splitting into 43,504 + 10,073 under load.
    #[test]
    fn a_mid_fold_snapshot_sweeps_nothing_and_cannot_split_a_fight() {
        let mut e = fold(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            &hit(1, 1_000, 43_504),
        ]);
        // A POLL FROM A DIFFERENT WORLD: the host clock, weeks past every timestamp in the log.
        let snap = e.snapshot(1_800_000_000_000, &SnapshotOpts::full(), None);
        assert_eq!(snap["segments"][0]["kind"], json!("current"));

        let ev = Event::from_json(&hit(2, 2_000, 10_073)).expect("a JSON object");
        e.on_event(&ev, false, None);
        let after = e.snapshot(2_000, &SnapshotOpts::full(), None);
        assert_eq!(
            after["segments"][0]["total"],
            json!(53_577),
            "the poll split the fight: {after}"
        );
        assert_eq!(
            after["segments"]
                .as_array()
                .expect("segments")
                .iter()
                .filter(|s| s["kind"] != json!("zone"))
                .count(),
            1,
            "one fight, not two"
        );
    }

    /// AN UNCORROBORATED CHARM BIND EXPIRES AT THE SNAPSHOT, on the same clock and for the same
    /// reason: the deadline belongs to whichever of the two readers reaches it first, and between
    /// two log lines that reader is the poll.
    #[test]
    fn a_live_snapshot_sweeps_a_charm_bind_whose_window_closed() {
        let lines = [
            r#"{"kind":"castBegin","seq":0,"ts":0,"raw":"c","spell":"Charm"}"#,
            r#"{"kind":"charm","seq":1,"ts":1000,"raw":"c","mob":"a rock golem"}"#,
        ];
        let horizon = 1_000 + crate::combat::spellfacts::provisional_window_ms("Charm");

        let e = fold_then_go_live(&lines);
        assert!(
            e.st.borrow().pet_names.contains("a rock golem"),
            "the broadcast resolved our own cast, so it bound"
        );
        e.snapshot(horizon - 1, &SnapshotOpts::full(), None);
        assert!(
            e.st.borrow().pet_names.contains("a rock golem"),
            "one ms early is early"
        );
        e.snapshot(horizon, &SnapshotOpts::full(), None);
        assert!(
            !e.st.borrow().pet_names.contains("a rock golem"),
            "the corroboration window closed and the bind is gone"
        );

        // …and the replay is untouched, however late the poll: a bind demoted by the host clock
        // mid-scan would attribute a charmed mob's damage differently on a busy machine.
        let e = fold(&lines);
        e.snapshot(horizon + 1_000_000, &SnapshotOpts::full(), None);
        assert!(e.st.borrow().pet_names.contains("a rock golem"));
    }

    /// THE PET NUDGE IS A LIVE-ONLY MODEL, and this is the gate rather than the model: the same two
    /// lines arm nothing while replaying and raise a nudge once the tail is running.
    #[test]
    fn the_pet_nudge_arms_only_once_the_tail_is_running() {
        let summon =
            r#"{"kind":"castBegin","seq":0,"ts":1000,"raw":"c","spell":"Kintaz's Animation"}"#;

        let mut e = fold(&[]);
        e.set_live();
        let ev = Event::from_json(summon).expect("a JSON object");
        e.on_event(&ev, false, None);
        let shown = 1_000 + petnudge::NUDGE_GRACE_MS;
        assert_eq!(
            e.snapshot(shown, &SnapshotOpts::full(), None)["petNudge"],
            json!({ "summonedTs": 1_000, "expiresTs": 1_000 + petnudge::NUDGE_GRACE_MS + petnudge::NUDGE_SHOW_MS })
        );
        // ABSENT, never null, in every state but the one — inside the grace, and past the timeout.
        assert!(e
            .snapshot(1_000, &SnapshotOpts::full(), None)
            .get("petNudge")
            .is_none());
        let gone = 1_000 + petnudge::NUDGE_GRACE_MS + petnudge::NUDGE_SHOW_MS;
        assert!(e
            .snapshot(gone, &SnapshotOpts::full(), None)
            .get("petNudge")
            .is_none());

        // A HISTORICAL FOLD ARMS NOTHING, which is why no golden carries the key: the arm is gated on
        // `!hydrating` at the cast, so the model has nothing to publish however it is asked.
        let e = fold(&[summon]);
        assert!(e
            .snapshot(shown, &SnapshotOpts::full(), None)
            .get("petNudge")
            .is_none());
    }

    /// `zone` is ABSENT — never null — until the first `You have entered X.` line, because a
    /// session that starts mid-zone genuinely cannot say where it is.
    #[test]
    fn the_zone_is_absent_until_a_zone_line_names_one() {
        let e = fold(&[r#"{"kind":"unknown","seq":0,"ts":1,"raw":"x"}"#]);
        let snap = e.snapshot(1, &SnapshotOpts::full(), None);
        assert!(snap.get("zone").is_none(), "{snap}");
        assert_eq!(snap["zoneSessions"][0]["zone"], json!("Session"));

        let e = fold(&[r#"{"kind":"zone","seq":0,"ts":10,"raw":"z","zone":"Najena"}"#]);
        let snap = e.snapshot(10, &SnapshotOpts::full(), None);
        assert_eq!(snap["zone"], json!("Najena"));
        assert_eq!(snap["segments"][0]["name"], json!("Najena - overall"));
    }

    /// A RE-ASSERT OF THE STANCE YOU ARE ALREADY IN MOVES NOTHING. `stanceTs` is the ts of the last
    /// CHANGE, not of the last line that mentioned one.
    #[test]
    fn re_asserting_the_same_stance_does_not_move_its_timestamp() {
        let e = fold(&[
            r#"{"kind":"stanceChange","seq":0,"ts":1000,"raw":"s","stance":"offensive"}"#,
            r#"{"kind":"stanceChange","seq":1,"ts":2000,"raw":"s","stance":"offensive"}"#,
            r#"{"kind":"invocationChange","seq":2,"ts":3000,"raw":"i","invocation":"inversion"}"#,
            r#"{"kind":"stanceChange","seq":3,"ts":4000,"raw":"s","stance":"defensive"}"#,
        ]);
        let snap = e.snapshot(4000, &SnapshotOpts::full(), None);
        assert_eq!(
            snap["stance"],
            json!({
                "stance": "defensive", "stanceTs": 4000,
                "invocation": "inversion", "invocationTs": 3000
            })
        );
    }

    /// The stance pair is SESSION-scoped: it survives a zone line, because a stance is not tied to
    /// a room. Only `reset()` clears it.
    #[test]
    fn the_standing_choices_survive_a_zone_line() {
        let e = fold(&[
            r#"{"kind":"stanceChange","seq":0,"ts":1000,"raw":"s","stance":"offensive"}"#,
            r#"{"kind":"zone","seq":1,"ts":2000,"raw":"z","zone":"The Plane of Sky"}"#,
        ]);
        let snap = e.snapshot(2000, &SnapshotOpts::full(), None);
        assert_eq!(snap["stance"]["stance"], json!("offensive"));
        assert_eq!(snap["stance"]["stanceTs"], json!(1000));
    }

    /// The live stay's floor: a stay with no finalized encounter behind it has a span of ONE
    /// SECOND, not zero — `Math.max(1, …)` is the definition, not a guard.
    #[test]
    fn an_unstarted_stay_reports_a_one_second_span() {
        let e = fold(&[r#"{"kind":"zone","seq":0,"ts":10,"raw":"z","zone":"Najena"}"#]);
        let snap = e.snapshot(10, &SnapshotOpts::full(), None);
        assert_eq!(snap["segments"][0]["durationSec"], json!(1.0));
        assert_eq!(snap["segments"][0]["dps"], json!(0.0));
        assert_eq!(snap["zoneSessions"].as_array().expect("live").len(), 1);
        assert_eq!(snap["zoneSessions"][0]["live"], json!(true));
        // ABSENT on the live entry, which has not ended at all.
        assert!(snap["zoneSessions"][0].get("closedBy").is_none());
    }

    /// With no landed sample every statistic is ABSENT rather than 0.
    #[test]
    fn a_slow_rollup_with_no_samples_states_no_statistics() {
        let e = fold(&[]);
        let snap = e.snapshot(0, &SnapshotOpts::full(), None);
        assert_eq!(
            snap["poison"]["slow"],
            json!({ "pulls": 0, "landed": 0, "noLand": 0, "window": 25 })
        );
    }

    /// The walk visits every zone session and every finalized fight, zone sessions first, and the
    /// whole-stay `kind: 'zone'` segment is SKIPPED on the fight pass (it is already the first
    /// zone-session entry).
    #[test]
    fn the_scope_walk_covers_the_zone_sessions_and_skips_the_zone_segment() {
        let e = fold(&[r#"{"kind":"zone","seq":0,"ts":10,"raw":"z","zone":"Najena"}"#]);
        let scopes = e.walk_scopes(10, None);
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0]["kind"], json!("zoneSession"));
        assert_eq!(scopes[0]["id"], json!("zone"));
    }

    // ── THE CLASSIFICATION RING (JOS-492) ─────────────────────────────────────────────────────

    /// Every classified line a snapshot carries, as `<role>|<cat>|<text>` — the three fields that
    /// make one row recognisable.
    fn lines(snap: &Value) -> Vec<String> {
        snap["recent"]
            .as_array()
            .expect("recent")
            .iter()
            .map(|r| {
                format!(
                    "{}|{}|{}",
                    r["role"].as_str().unwrap_or(""),
                    r["cat"].as_str().unwrap_or(""),
                    r["text"].as_str().unwrap_or("")
                )
            })
            .collect()
    }

    /// A HISTORICAL FOLD WRITES NOTHING, and that is the six-slice oracle's whole claim about this
    /// buffer: the gate is `recording`, the recorder never calls `set_live()`, and `recent` is `[]`
    /// in every golden. THE SAME BYTES ARE FOLDED LIVE BELOW, so this is a claim about the GATE
    /// rather than about the lines being unreachable.
    #[test]
    fn a_replay_leaves_the_classification_ring_empty() {
        let e = fold(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            &hit(1, 1_000, 500),
        ]);
        assert_eq!(
            e.snapshot(1_000, &SnapshotOpts::full(), None)["recent"],
            json!([])
        );
    }

    /// …AND A LIVE ONE CARRIES REAL ROWS — the named gap JOS-488 opened, closed. Every line here is
    /// the app's own sentence, copied verbatim so a bug report quoting one is findable in either
    /// tree.
    #[test]
    fn a_live_fold_classifies_the_lines_it_folds() {
        let mut e = CombatEngine::new();
        e.set_player_name("Primitive");
        e.set_live();
        for line in [
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            &hit(1, 1_000, 500),
            r#"{"kind":"damage","seq":2,"ts":1500,"raw":"d","attacker":"a kodiak","target":"You","amount":42,"dtype":"melee","skill":"bite","crit":false}"#,
            r#"{"kind":"stanceChange","seq":3,"ts":1600,"raw":"s","stance":"offensive"}"#,
            r#"{"kind":"death","seq":4,"ts":2000,"raw":"d","name":"a kodiak","bySelf":true}"#,
        ] {
            let ev = Event::from_json(line).expect("a JSON object");
            e.on_event(&ev, true, None);
        }
        let snap = e.snapshot(2_000, &SnapshotOpts::full(), None);
        let lines = lines(&snap);
        assert!(
            lines.contains(&"info|zone|▸ entered Najena".to_owned()),
            "{lines:?}"
        );
        assert!(
            // THE LANE NAME IS THE ROUTED ONE, `· proc` MARKER AND ALL. The TypeScript logs the
            // LANED event too (`route(st, laned)` — the origin verdict is reached before the fold),
            // so a cast-less firing reads in the ring exactly as it reads on the meter row.
            lines.contains(&"you|spell|You → a kodiak  500  Smiting Strike · proc".to_owned()),
            "{lines:?}"
        );
        assert!(
            lines.contains(&"enemy|melee|a kodiak → You  42  bite".to_owned()),
            "{lines:?}"
        );
        assert!(
            lines.contains(&"info|stance|▸ stance: offensive".to_owned()),
            "{lines:?}"
        );
        // A death names WHY the world resolved it the way it did — the reason is the model's, and
        // printing it is the difference between "the meter lost my kill" and a report somebody can act on.
        assert!(
            lines.contains(&"info|death|☠ a kodiak died - plain hostile death".to_owned()),
            "{lines:?}"
        );
        // THE ORDER IS THE FOLD'S: newest last, one row per line the engine had something to say
        // about, and nothing between the two damage rows.
        let zone = lines.iter().position(|l| l.contains("entered Najena"));
        let death = lines.iter().position(|l| l.contains("died"));
        assert!(zone < death, "{lines:?}");
    }

    /// A CRIT IS A STAR AND AN AMBIGUOUS HIT IS A TILDE — and the tilde REPLACES the star rather
    /// than joining it, because "the engine could not attribute this cleanly" outranks "it crit".
    #[test]
    fn a_crit_is_marked_and_a_refusal_is_said_out_loud() {
        let mut e = CombatEngine::new();
        e.set_player_name("Primitive");
        e.set_live();
        for line in [
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            r#"{"kind":"damage","seq":1,"ts":1000,"raw":"d","attacker":"You","target":"a kodiak","amount":900,"dtype":"spell","skill":"Smiting Strike","crit":true}"#,
            // A caster-less other-player DoT: not our fight, and the RAW LINE is what the ring keeps.
            r#"{"kind":"damage","seq":2,"ts":1200,"raw":"Somebody's tick hits a kodiak for 9 points of damage.","target":"a kodiak","amount":9,"dtype":"dot","skill":"tick","crit":false}"#,
        ] {
            let ev = Event::from_json(line).expect("a JSON object");
            e.on_event(&ev, true, None);
        }
        let lines = lines(&e.snapshot(1_200, &SnapshotOpts::full(), None));
        assert!(
            lines.contains(&"you|spell|You → a kodiak  900*  Smiting Strike · proc".to_owned()),
            "{lines:?}"
        );
        assert!(
            lines.contains(
                &"dropped|other|Somebody's tick hits a kodiak for 9 points of damage.".to_owned()
            ),
            "{lines:?}"
        );
    }

    /// THE RING IS BOUNDED, drop-oldest, and a snapshot carries at most the newest 150 — two
    /// different budgets on purpose (what the engine REMEMBERS versus what a payload COSTS).
    #[test]
    fn the_ring_is_bounded_and_the_payload_is_bounded_tighter() {
        let mut e = CombatEngine::new();
        e.set_player_name("Primitive");
        e.set_live();
        for seq in 0..(encounter::RECENT_CAP as i64 + 50) {
            let ev = Event::from_json(&hit(seq, 1_000 + seq * 10, 1)).expect("a JSON object");
            e.on_event(&ev, true, None);
        }
        let snap = e.snapshot(9_999_999, &SnapshotOpts::full(), None);
        assert_eq!(
            snap["recent"].as_array().expect("recent").len(),
            RECENT_VIEW
        );
    }

    /// `showUnparsed` FILTERS BEFORE IT SLICES, which is the app's order and is not interchangeable:
    /// a burst of refused lines must not push every classified one out of a panel that was not
    /// showing them anyway.
    #[test]
    fn the_unparsed_filter_runs_before_the_cap() {
        let mut e = CombatEngine::new();
        e.set_player_name("Primitive");
        e.set_live();
        let ev = Event::from_json(r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#)
            .expect("a JSON object");
        e.on_event(&ev, true, None);
        // …the ring has one `zone` row. `unparsed` is not a category this fold emits, so the two
        // answers agree — which is the honest pin: the FILTER is what is under test, not a category
        // this engine invented to exercise it.
        let with = e.snapshot(0, &SnapshotOpts::full(), None);
        let opts = SnapshotOpts {
            show_unparsed: false,
            ..SnapshotOpts::full()
        };
        let without = e.snapshot(0, &opts, None);
        assert_eq!(with["recent"], without["recent"]);
        assert_eq!(lines(&with).len(), 1);
    }

    // ── THE SESSION MARK (JOS-322, ported by JOS-492) ─────────────────────────────────────────

    /// A MARK MID-LIVE SPLITS THE ACCOUNTING, AND LEAVES THE ROOM ALONE.
    ///
    /// Two hits either side of the press: the first belongs to a stay frozen as `closedBy: 'mark'`,
    /// the second to a fresh live stay that starts at zero. `zone` is untouched — the whole
    /// difference between a mark and a zone line.
    #[test]
    fn a_mark_mid_live_splits_the_stay_and_keeps_the_room() {
        let mut e = fold_then_go_live(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            &hit(1, 1_000, 500),
        ]);
        assert!(e.session_mark(2_000), "a live engine takes the mark");

        let ev = Event::from_json(&hit(2, 3_000, 70)).expect("a JSON object");
        e.on_event(&ev, true, None);
        let snap = e.snapshot(3_000, &SnapshotOpts::full(), None);

        // The room did not change: `zone` still names it, and the LIVE stay carries its name.
        assert_eq!(snap["zone"], json!("Najena"));
        assert_eq!(snap["zoneSessions"][0]["zone"], json!("Najena"));
        assert_eq!(snap["zoneSessions"][0]["live"], json!(true));
        // …and it accounts only for what happened AFTER the press.
        assert_eq!(snap["zoneSessions"][0]["total"], json!(70));
        // The frozen record behind it is the pre-mark half, tagged by what closed it.
        assert_eq!(snap["zoneSessions"][1]["closedBy"], json!("mark"));
        assert_eq!(snap["zoneSessions"][1]["total"], json!(500));
        assert_eq!(snap["zoneSessions"][1]["zone"], json!("Najena"));
    }

    /// THE OPEN FIGHT IS CLOSED BY THE PRESS. `finalizeCurrent` runs, so the hit that follows opens
    /// a NEW encounter rather than extending the one the mark was meant to end.
    #[test]
    fn a_mark_closes_the_open_fight() {
        let mut e = fold_then_go_live(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            &hit(1, 1_000, 500),
        ]);
        assert_eq!(
            e.snapshot(1_000, &SnapshotOpts::full(), None)["segments"][0]["kind"],
            json!("current"),
            "the fight is open before the press"
        );
        e.session_mark(2_000);
        let ev = Event::from_json(&hit(2, 3_000, 70)).expect("a JSON object");
        e.on_event(&ev, true, None);
        let snap = e.snapshot(3_000, &SnapshotOpts::full(), None);
        // The open fight is the post-mark one, worth 70 — the 500 is behind the boundary.
        assert_eq!(snap["segments"][0]["kind"], json!("current"));
        assert_eq!(snap["segments"][0]["total"], json!(70));
    }

    /// REFUSED WHILE HYDRATING, and the refusal changes nothing at all. This is the structural half
    /// of replay determinism AND the reason the six-slice oracle is untouched: the recorder never
    /// hands over, so this is the only answer a golden fold can ever get.
    #[test]
    fn a_mark_is_refused_while_hydrating_and_moves_nothing() {
        let mut e = fold(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            &hit(1, 1_000, 500),
        ]);
        let before = e.snapshot(1_000, &SnapshotOpts::full(), None);
        assert!(!e.session_mark(2_000), "a replaying engine refuses");
        let after = e.snapshot(1_000, &SnapshotOpts::full(), None);
        assert_eq!(before, after, "a refused mark is not a mark");
        assert_eq!(
            after["zoneSessions"].as_array().expect("sessions").len(),
            1,
            "no record was minted"
        );
    }

    /// AN EMPTY STAY MINTS NOTHING, which is what makes a double-click harmless: the second press
    /// finds an aggregate with no attributed damage in it and `finalize_zone_session` drops it.
    #[test]
    fn a_second_mark_with_nothing_between_mints_no_record() {
        let mut e = fold_then_go_live(&[
            r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#,
            &hit(1, 1_000, 500),
        ]);
        e.session_mark(2_000);
        e.session_mark(2_000);
        let snap = e.snapshot(2_000, &SnapshotOpts::full(), None);
        assert_eq!(
            snap["zoneSessions"].as_array().expect("sessions").len(),
            2,
            "the live stay plus ONE frozen record: {snap}"
        );
        assert_eq!(snap["zoneSessions"][1]["closedBy"], json!("mark"));
    }

    /// `EMPTY_ROSTER` is what an engine with no roster module registered publishes — and it is what
    /// five of the six recorded goldens carry verbatim.
    #[test]
    fn an_unwired_roster_seam_publishes_the_empty_roster() {
        let e = fold(&[]);
        let snap = e.snapshot(0, &SnapshotOpts::full(), None);
        assert_eq!(
            snap["roster"],
            json!({ "members": [], "seen": false, "lastSignalTs": 0 })
        );
    }
}
