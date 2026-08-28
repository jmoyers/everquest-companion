//! The combat engine's mutable state — `src/main/combat/state.ts`.
//!
//! Routing, lifecycle and the view builders are plain functions over one explicit state object
//! rather than methods on a 1,400-line class. `CombatEngine` owns exactly one of these.
//!
//! Two flags decide the whole live half. `hydrating` is true from `reset()` until `set_live()` and
//! gates the snapshot-time sweep block, because a replay is not a moment in time; `recording` opens
//! the classification ring ([`EngineState::log`]). A historical fold clears neither, so its `recent`
//! is empty and no session mark can enter it.
//!
//! Three seams the golden's construction never installs, each a documented behaviour rather than a
//! gap: no combo provider (the class-swap coat clear never fires), no derived emitter (every emit
//! site is a no-op), no held-clicky set (`castless_kind` is the identity, so no lane name moves).

use serde::Serialize;

use crate::combat::aggregate::Agg;
use crate::combat::ally::AllyCharms;
use crate::combat::charm::CharmModel;
use crate::combat::encounter::{
    CoatSlot, Encounter, MarkerRaw, TimelineRaw, ZoneSession, ZoneSessionClose, FALLBACK_IDLE_MS,
    MARKER_CAP, RECENT_CAP, TIMELINE_CAP,
};
use crate::combat::others::{OtherCombatants, SpecialAttacks};
use crate::combat::petnudge::PetNudgeState;
use crate::combat::procdetect::RecentCasts;
use crate::combat::roster::{RosterSnap, RosterSource};
use crate::combat::statetimeline::StateTimeline;
use crate::combat::world::{Resolved, WorldModel};
use eqlog::names::{id_key, id_key_ref};
use std::collections::HashSet;

/// One half of the combat-modifier pair — the last stance (or invocation) the player committed to,
/// with the ts of that commit. Session-scoped: a stance is not tied to a zone, so it survives every
/// zone line and the epoch boundary alike, and only `reset()` clears it.
#[derive(Debug, Clone)]
pub struct Modifier {
    pub name: String,
    pub ts: i64,
}

/// The roster, pulled once per event rather than once per decision — and the two are exactly
/// equivalent, not merely close.
///
/// The bus order is what makes hoisting safe: the roster module is registered BEFORE the engine, so
/// by the time the engine folds a line the roster has already advanced for it, and nothing on the
/// engine's dispatch path can write it. The property the live pull exists for — a user edit between
/// two log lines reaching the very next one — is untouched, because the refresh is per event.
#[derive(Debug, Default)]
pub struct RosterFacts {
    /// Keys currently in the roster — the "never a hostile" test.
    pub members: HashSet<String>,
    /// Keys admitted since the last epoch or self-leave — the attribution test.
    pub admitted: HashSet<String>,
    /// The roster's own spelling for an admitted key, for the meter row's label.
    pub names: std::collections::HashMap<String, String>,
}

impl RosterFacts {
    fn pull(roster: Option<&dyn RosterSource>) -> RosterFacts {
        let Some(r) = roster else {
            return RosterFacts::default();
        };
        let snap = r.snap();
        RosterFacts {
            members: r.members().into_iter().collect(),
            admitted: r.admitted().into_iter().collect(),
            names: snap.members.into_iter().map(|m| (m.key, m.name)).collect(),
        }
    }
}

/// One line as the engine classified it — `shared/combat.ts ClassifiedLine`, for the live
/// processing log.
///
/// `cat` and `role` are strings rather than enums: the call sites pass an event's own `dtype`
/// straight through beside this file's own words, so an enum would enumerate a set the TS does not
/// and turn a display label into a contract.
#[derive(Debug, Clone, Serialize)]
pub struct ClassifiedLine {
    pub ts: i64,
    pub cat: String,
    /// Who it was attributed to — the four source kinds plus two commentary roles: `info` for a
    /// state transition the engine narrates, `dropped` for a line it deliberately refused.
    pub role: String,
    pub text: String,
}

/// Everything the engine folds into.
pub struct EngineState {
    /// Canonical name keys of your live pets — charmed and summoned alike — kept in lockstep with
    /// the world model's pet instances so the pure `classify()` stays cheap. An ATTRIBUTION set, not
    /// a charm roster: both kinds attribute as "your pet".
    pub pet_names: HashSet<String>,
    pub world: WorldModel,
    /// Ownership for the two caster-less broadcasts. Nothing enters `pet_names` from a charm line,
    /// and no CC hold opens, unless this model says the broadcast resolved one of the owner's casts.
    pub charm: CharmModel,
    /// Ownership for somebody else's charm pet, strictly disjoint from your rows: nothing here ever
    /// enters `pet_names`, `ever_pet`, `known_players` or the world model's pet set, and an ally pet
    /// opens no encounter, engages no hostile and refreshes no presence. That disjointness is what
    /// makes the feature law-8-safe.
    pub ally: AllyCharms,
    /// Every other combatant the log names — the refusal ladder that replaced the roster as the
    /// thing deciding whether a player-vs-mob line is recorded at all. The weakest model here, and
    /// asked last on purpose.
    pub others: OtherCombatants,
    /// Canonical name keys of entities known to be PLAYERS — never hostiles, never a pet's target,
    /// never enemy healers. Two sources, both narrow on purpose: the tailed character, and anyone
    /// who healed the owner. `note_player` shows why even that needs three refusals in front of it.
    pub known_players: HashSet<String>,
    /// Every name key that has ever been one of your pets this session. Small, never pruned, and the
    /// reason `note_player` can never mistake a pet for a player.
    pub ever_pet: HashSet<String>,
    /// Every name key you have landed damage on this session — the third absolute refusal
    /// `note_player` runs. Written from your own outgoing damage and nothing else.
    pub ever_struck: HashSet<String>,
    pub player_key: Option<String>,
    pub player_key_injected: bool,

    pub zone: Option<String>,
    pub seq: u64,
    pub current: Option<Encounter>,
    pub history: Vec<Encounter>,
    pub zone_agg: Agg,
    pub zone_finalized_ms: i64,
    pub zone_active_ms: i64,
    /// First/last attributed-damage ts in the LIVE zone session (0 = none yet).
    pub zone_start_ts: i64,
    pub zone_last_ts: i64,
    pub zone_history: Vec<ZoneSession>,
    pub zone_seq: u64,

    /// True from `reset()` until `set_live()`; gates the snapshot-time sweeps.
    pub hydrating: bool,
    /// True from `set_live()`; gates the classification ring.
    pub recording: bool,
    /// The classification ring — one row per line the engine had something to say about, newest
    /// last, capped drop-oldest at [`RECENT_CAP`]. Written only while `recording`.
    pub recent: Vec<ClassifiedLine>,
    /// ts of the last encounter-relevant activity (attributed damage OR a CC event). Drives the
    /// `FALLBACK_IDLE_MS` closure independent of the damage timeline.
    pub last_activity_ts: i64,

    pub stance: Option<Modifier>,
    pub invocation: Option<Modifier>,
    pub specials: SpecialAttacks,

    /// Rolling time-to-slow samples, newest last, capped at `SLOW_SAMPLE_CAP`. One entry per
    /// finalized pull that opened with a slow-capable coat on: the ms to the first slow landing, or
    /// `None` when the pull ended without one. The `None`s are why this is a list of samples rather
    /// than a running mean — they are counted, never averaged in as zero.
    pub slow_samples: Vec<Option<i64>>,

    /// Blade coats, four concurrent because that is what the game has: `coat_utility` is the one
    /// active utility poison and `coat_combat` holds at most one venom per mutually-exclusive line
    /// (venoms on different lines stack, the two members of a line replace each other).
    /// Session-scoped like the stance pair — a coat survives zoning.
    ///
    /// Never assign these two anywhere but `route_coat` / `route_dry` / `clear_coats`: a clear that
    /// moved the slots without ending the SPANS is a defect this engine has shipped before.
    pub coat_utility: Option<CoatSlot>,
    pub coat_combat: Vec<CoatSlot>,
    /// Log-clock ts of the last combo consultation (0 = never) — the throttle half of the class-swap
    /// coat clear, driven by event timestamps so a replay consults at identical instants. This fold
    /// installs no combo provider, so the consultation never happens; the gate is what decides when
    /// it would.
    pub coat_class_checked_ts: i64,
    /// The active-state timeline — "what was on at time T" as an interval model with evidence on
    /// both edges. Session-level and purely additive; `Encounter::stance_spans` is left alone.
    pub state_timeline: StateTimeline,
    /// Rank-normalized own-casts, for the cast-less proc detector. Only the player prints `You begin
    /// casting`, which is exactly the gate the detector needs.
    pub recent_casts: RecentCasts,
    /// Which spells this character owns an instant clicky for — canonical spell keys from the
    /// `/outputfile inventory` dump. Empty without that dump, and then `castless_kind` is the
    /// identity function so no lane name moves.
    pub held_clickies: HashSet<String>,
    /// The one-sentence nudge for an unbound summoned pet. Armed only when live — a summon from four
    /// hours ago is not news. The model in `petnudge.rs` is pure and clock-injected.
    pub pet_nudge: PetNudgeState,
    /// ts of the last `You activate Quick Buff.` (0 = never). That AA re-applies the player's
    /// memorized buffs and prints only their LANDINGS, so the burst it opens is cast evidence in a
    /// different shape and the heal-side proc inference must not read those landings as procs.
    pub quick_buff_ts: i64,

    /// See `RosterFacts`. Refreshed once per ingested event and once per snapshot.
    pub roster: RosterFacts,
}

impl Default for EngineState {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineState {
    pub fn new() -> Self {
        EngineState {
            pet_names: HashSet::new(),
            world: WorldModel::new(),
            charm: CharmModel::new(),
            ally: AllyCharms::new(),
            others: OtherCombatants::new(),
            known_players: HashSet::new(),
            ever_pet: HashSet::new(),
            ever_struck: HashSet::new(),
            player_key: None,
            player_key_injected: false,
            zone: None,
            seq: 0,
            current: None,
            history: Vec::new(),
            zone_agg: Agg::new(),
            zone_finalized_ms: 0,
            zone_active_ms: 0,
            zone_start_ts: 0,
            zone_last_ts: 0,
            zone_history: Vec::new(),
            zone_seq: 0,
            hydrating: true,
            recording: false,
            recent: Vec::new(),
            last_activity_ts: 0,
            stance: None,
            invocation: None,
            specials: SpecialAttacks::new(),
            slow_samples: Vec::new(),
            coat_utility: None,
            coat_combat: Vec::new(),
            coat_class_checked_ts: 0,
            state_timeline: StateTimeline::new(),
            recent_casts: RecentCasts::new(),
            held_clickies: HashSet::new(),
            pet_nudge: PetNudgeState::new(),
            quick_buff_ts: 0,
            roster: RosterFacts::default(),
        }
    }

    /// Append a point annotation to an encounter's marker ring, drop-oldest at `MARKER_CAP`.
    /// Draw-only: no count, DPS or attribution ever reads this.
    pub fn push_marker(enc: &mut Encounter, m: MarkerRaw) {
        enc.markers.push(m);
        if enc.markers.len() > MARKER_CAP {
            enc.markers.remove(0);
        }
    }

    /// Append one instant to an encounter's timeline ring, capped drop-oldest at `TIMELINE_CAP`.
    /// `events_total` counts every push, so a fight that outgrows the cap still knows its true
    /// instant count and the view can declare the loss rather than report the ring length as the
    /// fight (law 1). Display metadata only.
    pub fn push_timeline(enc: &mut Encounter, rec: TimelineRaw) {
        enc.events.push(rec);
        enc.events_total += 1;
        if enc.events.len() > TIMELINE_CAP {
            enc.events.remove(0);
        }
    }

    /// A reset always precedes a fresh full-log scan (startup or a character switch), so the engine
    /// is hydrating again until that scan hands off to a tail.
    pub fn reset(&mut self) {
        let injected = self.player_key.clone().filter(|_| self.player_key_injected);
        *self = EngineState::new();
        // `set_player_name` is called after `reset()` by every construction path, so this only
        // matters for a reset that arrives later, where the name is still this character's.
        if let Some(name) = injected {
            self.player_key = Some(name.clone());
            self.player_key_injected = true;
            self.known_players.insert(name);
        }
    }

    /// The handover from the scan to the tail — `state.ts setLive()`, and the whole difference
    /// between a replay and a present moment.
    ///
    /// `hydrating` false opens the snapshot-time sweep block, so a fight that ended while the log
    /// was quiet may close on elapsed time and a display timer may come off the screen. Before it
    /// none of that may happen: a poll landing between two replay slices would saw a fight in half
    /// on a clock that has nothing to do with the log.
    ///
    /// `recording` true opens the classification ring — the one flag deciding whether a classified
    /// line is kept, so a historical fold's `recent` stays empty with no caller remembering to.
    ///
    /// Idempotent, and it has to be: `hydrating` is a latch, and nothing but `reset()` sets it back.
    pub fn set_live(&mut self) {
        self.recording = true;
        self.hydrating = false;
    }

    /// Inject the player's own character name. Keyed canonically so it matches the `id_key` the heal
    /// path uses. Wins over any heal-line-learned name.
    pub fn set_player_name(&mut self, name: &str) {
        let key = id_key(name);
        self.known_players.insert(key.clone());
        self.player_key = Some(key);
        self.player_key_injected = true;
    }

    /// Refresh the per-event roster snapshot. See `RosterFacts` for why once per event is exactly
    /// the live pull.
    pub fn refresh_roster(&mut self, roster: Option<&dyn RosterSource>) {
        self.roster = RosterFacts::pull(roster);
    }

    /// The roster as the SNAPSHOT serializes it. A pull, never a stored copy.
    pub fn roster_snap(&self, roster: Option<&dyn RosterSource>) -> RosterSnap {
        roster.map_or_else(RosterSnap::empty, RosterSource::snap)
    }

    /// Drain the world model's retirement announcements, immediately after every world call that
    /// can retire — which is what makes it equivalent to the TS's synchronous `onRetire`.
    ///
    /// A retired instance cannot redeem its CC hold: the hold claims a mez'd mob is still alive, and
    /// once retired that claim is false forever, because a later sighting spawns a fresh
    /// `nameKey#gen`.
    pub fn drain_retirements(&mut self) {
        if self.world.retired_ids.is_empty() {
            return;
        }
        let ids = std::mem::take(&mut self.world.retired_ids);
        let Some(enc) = self.current.as_mut() else {
            return;
        };
        for id in ids {
            enc.cc_active_until.remove(&id);
        }
    }

    /// `world.resolve` with the retirement queue drained — the one door every routing path uses, so
    /// staleness retirement can never leave a stale hold behind it.
    pub fn resolve(&mut self, name: &str, ts: i64, prefer_charmed: bool) -> Resolved {
        let r = self.world.resolve(name, ts, prefer_charmed);
        self.drain_retirements();
        r
    }

    /// True when `name_key` is a player (the owner, or someone the heal stream tied to them).
    pub fn is_known_player(&self, name_key: &str) -> bool {
        name_key == "you" || self.known_players.contains(name_key)
    }

    /// True when `name_key` is on the roster right now — the "never a hostile" test. `engage_hostile`
    /// and the presence axis both consult it, because a group member's TARGET is what we are
    /// fighting and the member never is: one friendly in `engaged` can merge several pulls into one
    /// segment.
    ///
    /// The live roster rather than `admitted`: someone who left your group and is now duelling you
    /// is not protected by having once been a member.
    pub fn is_member(&self, name_key: &str) -> bool {
        self.roster.members.contains(name_key)
    }

    /// True when `name_key` is someone the engine may book outgoing damage for as a group member.
    /// The admission test — deliberately the wider `admitted` set, so a member who left mid-pull
    /// keeps being recorded and removing someone in the popover only ever hides a row.
    pub fn is_admitted_member(&self, name_key: &str) -> bool {
        if name_key == "you" {
            return false;
        }
        // A pet is never a member, the same absolute guard `note_player` uses: a member is excluded
        // from `engaged` and from presence, so one bad entry silently deletes a real pet's damage.
        if self.pet_names.contains(name_key) || self.ever_pet.contains(name_key) {
            return false;
        }
        self.roster.admitted.contains(name_key)
    }

    /// True if `name_key` currently resolves to an engaged hostile instance.
    pub fn is_engaged_hostile(&self, name_key: &str) -> bool {
        let Some(enc) = &self.current else {
            return false;
        };
        enc.engaged
            .iter()
            .any(|id| name_key_of(id) == Some(name_key))
    }

    /// The in-progress encounter, but only while it is fresh — the rule `route_miss` uses, so a
    /// non-damage event attaches to the fight it belongs to without reviving a stale one, and
    /// without ever opening one (only damage and CC do that).
    pub fn fresh_encounter_id(&self, ts: i64) -> bool {
        self.current
            .as_ref()
            .is_some_and(|e| ts - e.last_ts <= FALLBACK_IDLE_MS)
    }

    /// The fresh in-progress encounter, mutably. `None` both when nothing is open and when what is
    /// open is stale.
    pub fn fresh_encounter(&mut self, ts: i64) -> Option<&mut Encounter> {
        match self.current.as_mut() {
            Some(e) if ts - e.last_ts <= FALLBACK_IDLE_MS => Some(e),
            _ => None,
        }
    }

    /// Record player-shaped evidence for a name.
    ///
    /// A pet is never a player, and the guard is absolute: a name that is or ever was one of your
    /// pets, or that any charm broadcast has ever named, can never be filed here. Getting it wrong
    /// is silent — a "player" is excluded from `engaged`, from enemy healing and from a pet's target
    /// set, so one bad entry deletes real damage with no error anywhere.
    ///
    /// Something you have been killing is never a player either. "A mob cannot heal the owner" is
    /// false: your own lifetap names the DRAINED MOB as the healer (`Lord of Loathing healed you for
    /// 509 hit points by Leech Touch I.`).
    ///
    /// The signal is your own SWING, and the narrowness is measured. The wider rule — anything ever
    /// an engaged hostile — is wrong in the same corpus, because a raid boss can mind-control your
    /// own healer into hitting you. Being hit happens to you; hitting is something you do, and only
    /// the second one names a mob.
    pub fn note_player(&mut self, name_key: Option<&str>) {
        let Some(name_key) = name_key else { return };
        if name_key.is_empty() || name_key == "you" {
            return;
        }
        if self.ever_pet.contains(name_key) || self.charm.ever_charmed(name_key) {
            return;
        }
        if self.ever_struck.contains(name_key) {
            return;
        }
        self.known_players.insert(name_key.to_string());
        // …and a heal landing on you outranks a swing at you, so it also un-marks the
        // record-everything ladder's hostile flag. The three refusals above make this safe.
        self.others.clear_hostile(name_key);
    }

    /// Record that YOU landed damage on `name_key` — the only writer of `ever_struck`. Your pet's
    /// swings are deliberately not evidence: a pet auto-attacks what it is pointed at, including a
    /// charmed ally, so it carries no statement of intent.
    pub fn note_struck(&mut self, name_key: &str) {
        if name_key.is_empty() || name_key == "you" {
            return;
        }
        self.ever_struck.insert(name_key.to_string());
    }

    /// Bind `name_key` into the attribution set. The one door, so "was this ever a pet?" has a
    /// single answer and a player can never shadow one.
    pub fn note_pet(&mut self, name_key: &str) {
        self.pet_names.insert(name_key.to_string());
        self.ever_pet.insert(name_key.to_string());
        self.known_players.remove(name_key);
        self.retract_other(name_key, "bound as your pet");
    }

    /// A stronger model has claimed a name — take back the row the record-everything ladder booked
    /// for it. The pet and charm models are authoritative for pet attribution, so a pet that swung
    /// before its binding line arrived ends up with ONE row, never two.
    ///
    /// It cannot lose a number that existed before it did: an `Other` row is additive by
    /// construction — no you/pet total, no target ledger, no `engaged` set, no presence clock — so
    /// deleting it moves exactly the damage this feature added. The same lines are re-booked under
    /// the pet's own row from the bind onward.
    ///
    /// A roster member is never retracted: their row is the roster's, not this ladder's.
    ///
    /// The stated limit: it reaches the live aggregates — the open fight, the finalized fights still
    /// in history (whose memoized summary is dropped so it re-derives) and the live zone session. An
    /// already-frozen zone session keeps the row; its aggregate is immutable by design.
    ///
    /// `why` reaches the processing log and nothing else: a row disappearing from a meter is the
    /// most confusing thing this engine can do without saying why.
    pub fn retract_other(&mut self, name_key: &str, why: &str) {
        if name_key.is_empty() || self.roster.admitted.contains(name_key) {
            return;
        }
        if !self.others.note_pet(name_key) {
            return;
        }
        if !self.others.is_recorded(name_key) {
            return;
        }
        self.others.forget(name_key);
        let id = format!("member:{name_key}");
        self.zone_agg.drop_out(&id);
        if let Some(enc) = self.current.as_mut() {
            if enc.agg.drop_out(&id) {
                enc.summary = None;
            }
        }
        for enc in &mut self.history {
            if enc.agg.drop_out(&id) {
                enc.summary = None;
            }
        }
        // The last activity ts, not a clock: a retraction is triggered by a line the engine folded,
        // so it is stamped with the fight's own last instant.
        let ts = self.last_activity_ts;
        self.log(
            ts,
            "charm",
            "dropped",
            format!("✕ {name_key}: {why} - its recorded row is now the pet's"),
        );
    }

    /// Re-index `pet_names` off the world model's live pets, and report the name keys that fell out.
    ///
    /// `pet_names` is not a second opinion about who your pets are — it is a fast NAME index of the
    /// world model's pet INSTANCES, so every path that can retire one has to put the two back in
    /// step. `ever_pet` is untouched: a retired pet is still a pet, never a candidate player.
    pub fn sync_pet_names(&mut self) -> Vec<String> {
        let live: HashSet<String> = self.world.pet_name_keys().into_iter().collect();
        let dropped: Vec<String> = self
            .pet_names
            .iter()
            .filter(|k| !live.contains(*k))
            .cloned()
            .collect();
        for key in &dropped {
            self.pet_names.remove(key);
        }
        dropped
    }

    /// Demote the charm binds whose corroboration window has closed. Driven by the LOG clock — once
    /// per ingested event, and (live only) once per snapshot — so a replay and a live tail demote at
    /// exactly the same instants.
    pub fn sweep_charm(&mut self, now: i64) {
        if self.charm.idle() {
            return;
        }
        for d in self.charm.sweep(now) {
            self.world.uncharm(&d.display, now);
            self.drain_retirements();
            self.pet_names.remove(&d.name_key);
            self.log(
                now,
                "charm",
                "dropped",
                format!("✕ {}: charm bind never corroborated - unbound", d.display),
            );
        }
    }

    /// End the ally binds whose charm can no longer be running. Same clock, same two callers.
    pub fn sweep_ally(&mut self, now: i64) {
        if self.ally.idle() {
            return;
        }
        for e in self.ally.sweep(now) {
            self.log(
                now,
                "charm",
                "dropped",
                format!(
                    "✕ {}: {}'s charm has run its full duration - unbound",
                    e.display, e.charmer
                ),
            );
        }
    }

    /// May `name_key` be a third-party charmer? The behavioural half of the caster gate; the name
    /// shape answers the other half, and the ally model asks both.
    ///
    /// The three refusals are the same absolute guards `note_player` wears: a name you have landed
    /// damage on is a mob, a name a charm broadcast has ever named is a mob, and a name that is or
    /// was your pet is a pet. They are what catches the single-word proper-named mob the shape test
    /// cannot refuse.
    pub fn ally_caster_allowed(&self, name_key: &str) -> bool {
        if name_key.is_empty() || name_key == "you" || Some(name_key) == self.player_key.as_deref()
        {
            return false;
        }
        if self.pet_names.contains(name_key) || self.ever_pet.contains(name_key) {
            return false;
        }
        if self.ever_struck.contains(name_key) || self.charm.ever_charmed(name_key) {
            return false;
        }
        true
    }

    /// Is `name_key` on the friendly side of an ally charm? A bound ally pet swinging at one of
    /// these is the soft-hostile proof that its charm broke.
    ///
    /// Five sources, widest first: you, your own live pets, the group roster, anyone the heal stream
    /// proved a player, and the ally model's own caster/charmer set. The last does the work in
    /// practice — the measured breaks are pets turning on the stranger who charmed them, and a
    /// stranger is invisible to the other four.
    pub fn ally_friendly(&self, name_key: &str) -> bool {
        if name_key.is_empty() || name_key == "you" {
            return true;
        }
        if self.pet_names.contains(name_key) {
            return true;
        }
        if self.is_known_player(name_key) || self.is_member(name_key) {
            return true;
        }
        self.ally.is_friendly(name_key)
    }

    /// Learn the player's proper name as a FALLBACK only (an injected name wins): `You healed
    /// <Player>` where the target is not a pet and not an engaged hostile → that name IS the player.
    /// EQ never writes literal "You" as a heal target; it uses the character name.
    pub fn learn_player_key(
        &mut self,
        healer_key: Option<&str>,
        t_key: &str,
        is_you_tgt: bool,
        is_pet_tgt: bool,
    ) {
        if !self.player_key_injected
            && healer_key == Some("you")
            && !is_you_tgt
            && !is_pet_tgt
            && !self.is_engaged_hostile(t_key)
            && self.player_key.is_none()
        {
            self.player_key = Some(t_key.to_string());
        }
        if let Some(k) = self.player_key.clone() {
            self.known_players.insert(k);
        }
    }

    /// Presence refresh — record that `name` is still in the current fight as of `ts`. The LIVENESS
    /// axis only: it moves nothing on the damage timeline, so DPS denominators and the fled-mob
    /// fallback clock are unaffected.
    ///
    /// Conservative in both directions: it never engages anything (only already-engaged instances
    /// are refreshed, so a miss or resist cannot open or join an encounter) and it never resolves or
    /// creates a world instance, matching engaged ids by name prefix instead. Name-level matching
    /// refreshes every engaged twin sharing the name, because the log cannot tell twins apart on a
    /// miss line and a retired twin is "gone" via `is_retired` anyway.
    pub fn note_presence(&mut self, name: &str, ts: i64) {
        if self.current.is_none() {
            return;
        }
        let key = id_key_ref(name);
        if self.is_known_player(&key) {
            return;
        }
        // …and a group member is never a hostile either. Stated here rather than left to
        // `engage_hostile`'s refusal so the rule does not depend on that other guard staying correct.
        if self.is_member(&key) {
            return;
        }
        // Keep the world's per-instance clock in lockstep with the encounter's presence axis, so
        // staleness retirement ages an instance out on exactly the evidence closure calls presence.
        self.world.note_seen(&key, ts);
        self.drain_retirements();
        let ids: Vec<String> = match &self.current {
            Some(enc) => enc
                .engaged
                .iter()
                .filter(|id| name_key_of(id) == Some(key.as_ref()))
                .cloned()
                .collect(),
            None => return,
        };
        for id in ids {
            self.note_presence_id(&id, ts);
        }
    }

    /// Presence refresh for an already-resolved engaged instance id.
    ///
    /// A refresh may only ever describe a HOSTILE we are fighting. Two entities can never be
    /// refreshed here, because keeping a fight alive on their account merges pulls: a known player
    /// (never a hostile) and a live pet of ours (never something we are killing).
    pub fn note_presence_id(&mut self, instance_id: &str, ts: i64) {
        if self.world.is_live_pet(instance_id) {
            return;
        }
        if let Some(name_key) = name_key_of(instance_id) {
            if self.is_known_player(name_key) || self.is_member(name_key) {
                return;
            }
        }
        let Some(enc) = self.current.as_mut() else {
            return;
        };
        if !enc.engaged.contains(instance_id) {
            return;
        }
        let prev = enc.engaged_seen.get(instance_id).copied();
        if prev.is_none_or(|p| ts > p) {
            enc.engaged_seen.insert(instance_id.to_string(), ts);
        }
    }

    /// Instance-resolved defender label for a damage-free instant (miss / resist), so twins read as
    /// `a deadly black widow (7)` / `(8)` rather than piling onto a bare-named ghost row.
    ///
    /// Resolution is gated on the name already being engaged in this encounter, which keeps law 8
    /// intact: `engaged` membership only ever comes from landed damage or heals, so a whiff at a mob
    /// we have never damaged has zero world-model side effects and keeps its raw name.
    ///
    /// It is NOT a pure read, which is why callers make it even when they discard the label. The
    /// `resolve()` inside refreshes `last_seen_ts`, retires stale instances, and adopts the
    /// sighting's casing as the instance display — and that display is what the next `bump_target`
    /// freezes into a fight's name (first write wins). An outgoing damage-shield tick is
    /// sentence-initial for the mob, and it is the mid-sentence miss that flips the display back.
    pub fn defender_label(&mut self, name: &str, ts: i64) -> String {
        let key = id_key_ref(name);
        if key == "you" {
            return "You".to_string();
        }
        let engaged = match &self.current {
            Some(enc) => enc
                .engaged
                .iter()
                .any(|id| name_key_of(id) == Some(key.as_ref())),
            None => false,
        };
        if engaged {
            self.resolve(name, ts, false).label
        } else {
            name.to_string()
        }
    }

    /// Append one classified line — the whole of the classification ring.
    ///
    /// The `recording` gate lives INSIDE this method rather than at its forty call sites, which is
    /// what makes "a replay writes nothing" a structural fact instead of forty remembered ones.
    ///
    /// A display buffer and nothing else: no count, no total, no attribution and no view reads it.
    /// That is why a line is a sentence rather than a record, and the sentences are copied verbatim
    /// from the app so a bug report quoting one is findable in either tree.
    pub fn log(&mut self, ts: i64, cat: &str, role: &str, text: String) {
        if !self.recording {
            return;
        }
        self.recent.push(ClassifiedLine {
            ts,
            cat: cat.to_owned(),
            role: role.to_owned(),
            text,
        });
        if self.recent.len() > RECENT_CAP {
            self.recent.remove(0);
        }
    }

    /// Freeze the live zone aggregate into the capped history, before the aggregate is reset, so the
    /// just-left zone's overall meter stays selectable. A stay that saw no attributed damage is
    /// dropped.
    pub fn finalize_zone_session(&mut self, closed_by: ZoneSessionClose) {
        if self.zone_agg.is_empty() {
            return;
        }
        self.zone_seq += 1;
        let id = format!("zs{}", self.zone_seq);
        let zone = self.zone.clone().unwrap_or_else(|| "Session".to_string());
        let agg = std::mem::replace(&mut self.zone_agg, Agg::new());
        self.zone_history.push(ZoneSession {
            id,
            zone,
            agg,
            closed_by,
            start_ts: self.zone_start_ts,
            last_ts: self.zone_last_ts,
            finalized_ms: self.zone_finalized_ms,
            active_ms: self.zone_active_ms,
        });
        if self.zone_history.len() > crate::combat::encounter::ZONE_HISTORY_CAP {
            self.zone_history.remove(0);
        }
    }

    /// Mint fresh zone accumulators — the second half of every stay boundary, its own function
    /// because two callers share it and must not drift: the zone line and the session mark. The mark
    /// is this and nothing else; everything else the zone case does states that the ROOM changed.
    pub fn reset_zone_accumulators(&mut self) {
        self.zone_agg = Agg::new();
        self.zone_finalized_ms = 0;
        self.zone_active_ms = 0;
        self.zone_start_ts = 0;
        self.zone_last_ts = 0;
    }
}

/// The nameKey half of an instance id `<nameKey>#<gen>`. `None` when the id carries no `#` at a
/// splittable position — the `you` sentinel and nothing else.
pub fn name_key_of(instance_id: &str) -> Option<&str> {
    let hash = instance_id.rfind('#')?;
    (hash > 0).then(|| &instance_id[..hash])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_instance_ids_name_key_is_everything_before_the_last_hash() {
        assert_eq!(name_key_of("a spite golem#12"), Some("a spite golem"));
        assert_eq!(name_key_of("you"), None);
        assert_eq!(name_key_of("#3"), None);
    }

    /// The three absolute refusals: a pet, a charmed name and something you have struck can never be
    /// filed as a player, whatever a heal line says.
    #[test]
    fn a_pet_a_charm_and_a_mob_you_struck_can_never_become_players() {
        let mut st = EngineState::new();
        st.note_pet("vebarn");
        st.note_player(Some("vebarn"));
        assert!(!st.known_players.contains("vebarn"));

        let mut st = EngineState::new();
        st.charm.charm_broadcast("a rock golem", "a rock golem", 0);
        st.note_player(Some("a rock golem"));
        assert!(!st.known_players.contains("a rock golem"));

        let mut st = EngineState::new();
        st.note_struck("lord of loathing");
        st.note_player(Some("lord of loathing"));
        assert!(!st.known_players.contains("lord of loathing"));
    }

    /// …and the one that DOES file: a stranger who healed you, with none of the three against them.
    #[test]
    fn a_healer_with_no_refusal_against_them_is_filed_a_player() {
        let mut st = EngineState::new();
        st.note_player(Some("sonista"));
        assert!(st.is_known_player("sonista"));
    }

    /// A retired pet leaves the attribution set and stays in `ever_pet` — a retired pet is still a
    /// pet, never a candidate player.
    #[test]
    fn syncing_pet_names_drops_the_retired_and_keeps_the_history() {
        let mut st = EngineState::new();
        st.world.claim("Jaber", 0);
        st.note_pet("jaber");
        st.world.claim("Gonekn", 1_000);
        st.note_pet("gonekn");
        let dropped = st.sync_pet_names();
        assert_eq!(dropped, vec!["jaber".to_string()]);
        assert!(!st.pet_names.contains("jaber"));
        assert!(st.ever_pet.contains("jaber"));
    }
}
