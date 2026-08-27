//! The combat engine's MUTABLE STATE — `src/main/combat/state.ts`.
//!
//! Extracted over there so the routing / lifecycle / view modules could be plain functions over one
//! explicit state object instead of methods on a 1,400-line class, and kept that shape here for the
//! same reason. `CombatEngine` (mod.rs) owns exactly one of these and is a thin facade over it.
//!
//! ── THREE FACTS ABOUT A HISTORICAL FOLD THAT DELETE MOST OF THIS FILE'S LIVE HALF ──────────────
//!
//! These are not simplifications taken for convenience; they are properties of the run the goldens
//! were recorded under (`foldArm.mts construct()` + `goldenOracle.mts buildSnapshots`), and each one
//! is checkable against the recorded artifact rather than asserted. **THEY ARE FACTS ABOUT A
//! HISTORICAL FOLD AND THEY SAY NOTHING ABOUT A LIVE ONE** — which is a distinction that cost
//! nothing to make until JOS-488, because until then nothing called `set_live()`:
//!
//!   1. `hydrating` IS TRUE FOR THE WHOLE FOLD, on all six slices (verified in every
//!      `<slice>.snapshots.json`: `combat.hydrating === true`). `set_live()` is what clears it and
//!      the golden recorder never calls it. So the whole snapshot-time sweep block is SKIPPED, and
//!      `now` is used for nothing but the `inCombat` freshness test and the summaries' `active`
//!      flag. A replay is not a moment in time. **A LIVE ENGINE CLEARS IT** at the fold-landed
//!      moment (`engined::foldsink`'s `tick`) and from the first live event, exactly as `session.ts`
//!      does — and the sweeps then run, which is the whole of JOS-488.
//!   2. `recording` IS FALSE FOR THE WHOLE FOLD, for the same reason — and SINCE JOS-492 THE RING
//!      IT GATES IS REAL ([`EngineState::log`]). `recent` is still `[]` in every one of the six
//!      goldens, and now for the reason the TypeScript has: the gate is shut, not the buffer
//!      missing. That is the difference the cutover ticket was for — the same absence, stated by
//!      the thing that causes it — and it is what closes the NAMED GAP JOS-488 opened when
//!      `set_live()` grew a caller and a live meter started publishing an empty ring where the app
//!      publishes classified lines.
//!   3. NO SESSION MARK CAN ENTER. A mark is refused while hydrating and is a user action stored
//!      nowhere — so `closedBy` is `'zone'` on every zone session in every golden. Unchanged by
//!      going live: there is no op, no command and no caller for one anywhere in this engine.
//!
//! ── AND THREE SEAMS THE GOLDEN'S CONSTRUCTION DOES NOT INSTALL ─────────────────────────────────
//!
//! `foldArm.mts construct()` makes THREE of the five construction calls: `setRoster`, `reset()`,
//! `setPlayerName`. It does NOT call `setCombo`, `setDerivedEmitter` or `setHeldClickies`. That is
//! not an oversight to be corrected here — the golden IS the bar, and wiring a seam the recorder
//! left unwired would make this fold fold something the TS did not. Each absence is a DOCUMENTED
//! BEHAVIOUR rather than a gap: `comboProvider` returning null means the class-swap coat clear never
//! fires, an unwired `emitDerived` makes every emit site a no-op (the buffs module's own precedent),
//! and an empty held-clicky set makes `castlessKind` the identity function so not one lane name
//! moves.
//!
//! ── THE FIELDS PORTED BY PROOF OF ABSENCE, WHICH IS DIFFERENT FROM BEING SKIPPED ───────────────
//!
//! THE CLASSIFICATION RING USED TO BE ONE OF THEM AND IS NOW REAL CODE (JOS-492 — [`EngineState::
//! log`] and its forty call sites). Its absence from the goldens is unchanged and is now proven by
//! the GATE — `if !self.recording { return }`, the TS's own first line — rather than by the buffer
//! not existing. Same shape as the pet nudge below, and for the same reason: the cutover ticket's
//! whole subject is turning a proof about a live world into code that a live world runs.
//!
//! THE PET NUDGE is armed only by `if (!st.hydrating && isPetSummonSpell(...))`, and fact 1 says
//! `hydrating` is true for the whole of every recorded slice — so its arm is never set, `view(now)`
//! answers `undefined` in every state it can reach, and `JSON.stringify` drops the key. The goldens
//! agree: no slice carries `combat.petNudge`. THAT ARGUMENT IS NOW MADE BY THE GATE RATHER THAN BY
//! THE MODEL'S ABSENCE (JOS-488): `petnudge.rs` is real code, a live engine arms it, and the oracle
//! is untouched because the oracle never goes live. The goldens still carry no `petNudge` key.
//!
//! THE COMBO PULL is a field that exists and is never installed (seam 1 above). `coat_class_checked_ts`
//! is kept and advanced exactly where the TS advances it, because the THROTTLE is observable state even
//! when the question behind it is never asked; the answer is not, so nothing here consults one.

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
/// with the ts of that commit. SESSION-scoped: a stance is not tied to a zone, so it survives every
/// zone line and the epoch boundary alike, and only `reset()` clears it.
#[derive(Debug, Clone)]
pub struct Modifier {
    pub name: String,
    pub ts: i64,
}

/// THE ROSTER, PULLED ONCE PER EVENT rather than once per decision — and the two are EXACTLY
/// equivalent, not merely close.
///
/// Over there `st.roster()` is a live pull and `classify()` makes one per damage, miss and resist
/// probe. What makes hoisting it safe is the bus order, which `pipeline.ts` fixes: the roster module
/// is registered BEFORE the engine, so by the time the engine folds a line the roster has ALREADY
/// advanced for that same line, and nothing on the engine's own dispatch path can write it. So every
/// pull inside one event returns the same three sets, and taking them once at the top of dispatch is
/// the same answer read fewer times. The property the live pull exists for — "a user edit made
/// between two log lines must reach the very next one" — is untouched, because the refresh happens
/// on every event.
#[derive(Debug, Default)]
pub struct RosterFacts {
    /// Keys CURRENTLY in the roster — the "never a hostile" test.
    pub members: HashSet<String>,
    /// Keys admitted since the last epoch or self-leave — the ATTRIBUTION test.
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

/// ONE LINE AS THE ENGINE CLASSIFIED IT — `shared/combat.ts ClassifiedLine`, for the live
/// processing log.
///
/// `cat` and `role` ARE STRINGS RATHER THAN ENUMS, deliberately. Over there `cat` is a bare `string`
/// (the union is documented in a comment, not in the type) because the call sites pass an event's
/// own `dtype` straight through — `melee`, `spell`, `dot`, `ds` — beside the file's own words
/// (`charm`, `pet`, `death`, `zone`, `unparsed`). An enum here would have to enumerate a set the TS
/// does not enumerate, and would turn a display label into a contract.
#[derive(Debug, Clone, Serialize)]
pub struct ClassifiedLine {
    pub ts: i64,
    pub cat: String,
    /// Who it was attributed to — the four SOURCE kinds plus the two COMMENTARY roles: `info` for a
    /// state transition the engine narrates, `dropped` for a line it deliberately refused.
    pub role: String,
    pub text: String,
}

/// Everything the engine folds into.
pub struct EngineState {
    /// Canonical name keys of your LIVE PETS — charmed AND summoned alike. Kept in lockstep with the
    /// world model's pet instances so the pure `classify()` (which only needs name membership) stays
    /// cheap. This is an ATTRIBUTION set, NOT a charm roster: a summoned class pet belongs here
    /// exactly as much as a charmed mob does, because both attribute as "your pet".
    pub pet_names: HashSet<String>,
    pub world: WorldModel,
    /// OWNERSHIP for the two caster-less broadcasts. Nothing enters `pet_names` from a charm line,
    /// and no CC hold opens, unless this model says the broadcast resolved one of the OWNER's casts.
    pub charm: CharmModel,
    /// OWNERSHIP FOR SOMEBODY ELSE'S CHARM PET. STRICTLY DISJOINT FROM YOUR ROWS: nothing here ever
    /// enters `pet_names`, `ever_pet`, `known_players` or the world model's pet set; an ally pet
    /// opens no encounter, engages no hostile and refreshes no presence. That disjointness is what
    /// makes the whole feature law-8-safe.
    pub ally: AllyCharms,
    /// EVERY OTHER COMBATANT THE LOG NAMES — the refusal ladder that replaced the roster as the
    /// thing deciding whether a player-vs-mob line is recorded at all. The WEAKEST model here, and
    /// asked LAST on purpose.
    pub others: OtherCombatants,
    /// Canonical name keys of entities known to be PLAYERS — never hostiles, never a pet's target,
    /// never enemy healers. TWO sources, both narrow on purpose: the tailed character, and anyone
    /// who HEALED the owner (a mob cannot). See `note_player` for the mob lifetap that proves even
    /// that needs three refusals in front of it.
    pub known_players: HashSet<String>,
    /// Every name key that has EVER been one of your pets this session. Small, never pruned, and the
    /// reason `note_player` can never mistake a pet for a player.
    pub ever_pet: HashSet<String>,
    /// Every name key YOU have LANDED DAMAGE ON this session — the third absolute refusal
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

    /// See the module header, fact 1.
    pub hydrating: bool,
    /// See the module header, fact 2.
    pub recording: bool,
    /// THE CLASSIFICATION RING — one row per line the engine had something to say about, newest
    /// last, capped drop-oldest at [`RECENT_CAP`]. Written only while `recording`.
    pub recent: Vec<ClassifiedLine>,
    /// ts of the last encounter-relevant activity (attributed damage OR a CC event). Drives the
    /// `FALLBACK_IDLE_MS` closure independent of the damage timeline.
    pub last_activity_ts: i64,

    pub stance: Option<Modifier>,
    pub invocation: Option<Modifier>,
    pub specials: SpecialAttacks,

    /// ROLLING TIME-TO-SLOW samples, newest last, capped at `SLOW_SAMPLE_CAP`. One entry per
    /// FINALIZED pull that opened with a slow-capable coat on: the ms to the first slow landing, or
    /// `None` when the pull ended without one. The `None`s are the whole reason this is a list of
    /// samples rather than a running mean — they are COUNTED and never averaged in as zero.
    pub slow_samples: Vec<Option<i64>>,

    /// BLADE COATS. FOUR concurrent, because that is what the game has: `coat_utility` is the ONE
    /// active utility poison (a new utility coat replaces it) and `coat_combat` holds at most one venom
    /// per mutually-exclusive LINE — venoms on different lines stack, the two members of a line replace
    /// each other. Session-scoped exactly like the stance pair: a coat survives zoning and is stripped
    /// only by `reset()` or by one of the three boundaries `procrouting::clear_coats` owns.
    ///
    /// NEVER ASSIGN THESE TWO ANYWHERE BUT `route_coat` / `route_dry` / `clear_coats`: a clear that
    /// moved the slots without ending the SPANS is the exact defect JOS-305 was filed for, one case at
    /// a time.
    pub coat_utility: Option<CoatSlot>,
    pub coat_combat: Vec<CoatSlot>,
    /// Log-clock ts of the last combo consultation (0 = never) — the THROTTLE half of the class-swap
    /// coat clear. Driven entirely by event timestamps, so a replay consults at identical instants.
    /// This fold installs no combo provider, so the consultation itself never happens; the field is
    /// kept because the GATE is what decides when it would.
    pub coat_class_checked_ts: i64,
    /// THE ACTIVE-STATE TIMELINE — "what was on at time T" as an interval model with evidence on both
    /// edges. SESSION-level and purely ADDITIVE: written alongside the fields above by the same
    /// writers, and `Encounter::stance_spans` is deliberately left alone.
    pub state_timeline: StateTimeline,
    /// Rank-normalized own-casts, for the cast-less proc detector. Only the PLAYER prints `You begin
    /// casting`, which is exactly the gate the detector needs.
    pub recent_casts: RecentCasts,
    /// WHICH SPELLS THIS CHARACTER OWNS AN INSTANT CLICKY FOR — canonical spell keys from the
    /// `/outputfile inventory` dump. `foldArm.mts` never calls `setHeldClickies`, so it is EMPTY for the
    /// whole of every recorded slice and `castless_kind` is the identity function: not one lane name
    /// moves. That is a documented behaviour of the golden's construction, not a gap.
    pub held_clickies: HashSet<String>,
    /// THE ONE-SENTENCE NUDGE FOR AN UNBOUND SUMMONED PET (JOS-258). ARMED ONLY WHEN LIVE, which is
    /// the gate the whole feature rests on: a summon from four hours ago is not news. See
    /// `petnudge.rs` — the model is pure and clock-injected, and this is its only instance.
    pub pet_nudge: PetNudgeState,
    /// ts of the last `You activate Quick Buff.` (0 = never). That AA re-applies the player's memorized
    /// buffs and prints only their LANDINGS, so the burst it opens is cast evidence in a different
    /// shape and the heal side of the proc inference must not read those landings as procs.
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
    /// `events_total` counts EVERY push, so a fight that outgrows the cap still knows its true instant
    /// count and the view can DECLARE the loss instead of reporting the ring length as if it were the
    /// fight (law 1). The counter is display metadata only.
    pub fn push_timeline(enc: &mut Encounter, rec: TimelineRaw) {
        enc.events.push(rec);
        enc.events_total += 1;
        if enc.events.len() > TIMELINE_CAP {
            enc.events.remove(0);
        }
    }

    /// `reset()` — a reset always precedes a fresh full-log scan (startup or a character switch), so
    /// we are hydrating again until that scan hands off to a tail that, in this fold, never comes.
    pub fn reset(&mut self) {
        let injected = self.player_key.clone().filter(|_| self.player_key_injected);
        *self = EngineState::new();
        // `set_player_name` is called AFTER `reset()` by every construction path, so this only ever
        // matters for a reset that arrives later — and there the name is still this character's.
        // Re-seeding rather than dropping it keeps the two orderings from meaning different things.
        if let Some(name) = injected {
            self.player_key = Some(name.clone());
            self.player_key_injected = true;
            self.known_players.insert(name);
        }
    }

    /// THE HANDOVER FROM THE SCAN TO THE TAIL — `state.ts setLive()`, two field writes and the whole
    /// difference between a replay and a present moment.
    ///
    /// `hydrating` FALSE is what opens the snapshot-time sweep block (`CombatEngine::snapshot`): from
    /// here on every answer describes the real present, so a fight that ended while the log was quiet
    /// is allowed to close on elapsed time and a display timer is allowed to come off the screen.
    /// Before it, none of that may happen — a poll landing between two replay slices used to saw a
    /// fight in half on a clock that has nothing to do with the log (the JOS-208 measurement).
    ///
    /// `recording` TRUE opens the classification ring ([`EngineState::log`]) — the live processing
    /// log the meter's own panel draws. It is the ONE flag that decides whether a classified line is
    /// kept, which is what keeps a historical fold's `recent` empty without any caller having to
    /// remember that it should be.
    ///
    /// IDEMPOTENT, and it has to be: the go-live beat is one call, but nothing structural stops a
    /// second, and `hydrating` is a latch rather than a toggle — nothing but `reset()` sets it back.
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
    /// the live pull rather than an approximation of it.
    pub fn refresh_roster(&mut self, roster: Option<&dyn RosterSource>) {
        self.roster = RosterFacts::pull(roster);
    }

    /// The roster as the SNAPSHOT serializes it. A pull, never a stored copy.
    pub fn roster_snap(&self, roster: Option<&dyn RosterSource>) -> RosterSnap {
        roster.map_or_else(RosterSnap::empty, RosterSource::snap)
    }

    // ── The retirement queue (world.rs's header carries the argument) ─────────────────────────

    /// DRAIN THE WORLD MODEL'S RETIREMENT ANNOUNCEMENTS. Called immediately after every world call
    /// that can retire, which is what makes it equivalent to the TS's synchronous `onRetire`.
    ///
    /// A RETIRED INSTANCE CANNOT REDEEM ITS CC HOLD (JOS-176). The hold is a claim that a mez'd mob
    /// is still alive and still in this fight; the moment the world model retires that instance the
    /// claim is false forever, because a later sighting of the name spawns a fresh `nameKey#gen`.
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

    /// `world.resolve` with the retirement queue drained — the ONE door every routing path uses, so
    /// staleness retirement can never leave a stale hold behind it.
    pub fn resolve(&mut self, name: &str, ts: i64, prefer_charmed: bool) -> Resolved {
        let r = self.world.resolve(name, ts, prefer_charmed);
        self.drain_retirements();
        r
    }

    // ── The membership questions the routing ladder asks ──────────────────────────────────────

    /// True when `name_key` is a player (the owner, or someone the heal stream tied to them).
    pub fn is_known_player(&self, name_key: &str) -> bool {
        name_key == "you" || self.known_players.contains(name_key)
    }

    /// True when `name_key` is on the roster RIGHT NOW — the "never a hostile" test. `engage_hostile`
    /// and the presence axis both consult it, because a group member's TARGET is what we are
    /// fighting and the member never is: one friendly in `engaged` merged three of the owner's pulls
    /// into a single 214-second segment.
    ///
    /// The LIVE roster rather than `admitted`: someone who genuinely left your group and is now
    /// duelling you is not protected by having once been a member.
    pub fn is_member(&self, name_key: &str) -> bool {
        self.roster.members.contains(name_key)
    }

    /// True when `name_key` is someone the engine may book OUTGOING damage for as a group member.
    /// The ADMISSION test — deliberately the wider `admitted` set, so a member who left mid-pull
    /// keeps being recorded and a user REMOVING someone in the popover only ever hides a row.
    pub fn is_admitted_member(&self, name_key: &str) -> bool {
        if name_key == "you" {
            return false;
        }
        // A PET IS NEVER A MEMBER. The same absolute guard `note_player` uses, and it matters for
        // the same reason: a "member" is excluded from `engaged` and from presence, so one bad entry
        // would silently delete a real pet's damage with no error anywhere.
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

    /// The in-progress encounter, but only while it is FRESH — the same rule `route_miss` uses, so a
    /// non-damage event can attach to the fight it belongs to without reviving a stale one (and
    /// without ever OPENING one: only damage and CC do that).
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

    // ── The evidence the routing paths read off a line ────────────────────────────────────────

    /// Record player-shaped evidence for a name.
    ///
    /// A PET IS NEVER A PLAYER, and the guard is absolute in both directions: a name that is or has
    /// ever been one of your pets — or that any charm broadcast has ever named — can never be filed
    /// here. Getting this wrong is expensive and silent: a "player" is excluded from `engaged`, from
    /// enemy healing and from a pet's target set, so one bad entry deletes real damage with no error
    /// anywhere.
    ///
    /// SOMETHING YOU HAVE BEEN KILLING IS NEVER A PLAYER EITHER (JOS-48), and it is the same guard
    /// for the same reason. The heal line the caller read is `<H> healed you for N`, and the belief
    /// behind it — "a mob cannot heal the owner" — is FALSE: your OWN lifetap prints exactly that
    /// shape and names the DRAINED MOB as the healer (`Lord of Loathing healed you for 509 hit
    /// points by Leech Touch I.`). Five of those in one reporting slice; filing them as players
    /// deleted every pet swing at them from that instant (measured: 18 hits, 398 points, one pet,
    /// one pull).
    ///
    /// THE SIGNAL IS YOUR OWN SWING, AND THE NARROWNESS IS MEASURED, NOT TIMID. The wider rule —
    /// "anything that was ever an engaged hostile" — is WRONG in the same corpus: a raid boss
    /// mind-controls the reporter's own healer, so `Sonista slashes YOU` lands 27 seconds before
    /// `Sonista healed you`. Being hit is something that HAPPENS to you; hitting is something you DO,
    /// and only the second one names a mob.
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
        // …and a heal landing on YOU outranks a swing at you, so it also un-marks the
        // record-everything ladder's hostile flag. The three refusals above make this safe.
        self.others.clear_hostile(name_key);
    }

    /// Record that YOU landed damage on `name_key` — the only writer of `ever_struck`. Your PET's
    /// swings are deliberately not evidence: a pet auto-attacks what it is pointed at, including a
    /// charmed ally, so it carries no statement of intent.
    pub fn note_struck(&mut self, name_key: &str) {
        if name_key.is_empty() || name_key == "you" {
            return;
        }
        self.ever_struck.insert(name_key.to_string());
    }

    /// Bind `name_key` into the attribution set. THE one door, so "was this ever a pet?" has a single
    /// answer and a player can never shadow one.
    pub fn note_pet(&mut self, name_key: &str) {
        self.pet_names.insert(name_key.to_string());
        self.ever_pet.insert(name_key.to_string());
        self.known_players.remove(name_key);
        self.retract_other(name_key, "bound as your pet");
    }

    /// A STRONGER MODEL HAS CLAIMED A NAME — take back the row the record-everything ladder booked
    /// for it. The pet and charm models are authoritative for pet attribution, so a pet that swung a
    /// few times before its binding line arrived must end up with ONE row (its own), never two.
    ///
    /// IT CANNOT LOSE A NUMBER THAT EXISTED BEFORE IT DID: an `Other` row is additive by construction
    /// — it enters no you/pet total, no target ledger, no `engaged` set and no presence clock — so
    /// deleting it moves exactly the damage this feature added and nothing else. The damage is not
    /// discarded either; the same lines are re-booked under the pet's own row from the bind onward.
    ///
    /// A ROSTER MEMBER IS NEVER RETRACTED: their row is the roster's, not this ladder's, and both
    /// `note_struck` and a charm broadcast can name a real group-mate.
    ///
    /// THE STATED LIMIT: it reaches the live aggregates — the open fight, the finalized fights still
    /// in history (whose memoized summary is dropped so it re-derives) and the live zone session. A
    /// zone session already FROZEN keeps the row: its aggregate is immutable by design and a pet
    /// bound after you left the zone is not worth a thaw. Measured on the owner's whole log, every
    /// retraction fires within the same fight as the swings it takes back.
    /// `why` REACHES THE PROCESSING LOG AND NOTHING ELSE, exactly as it does over there: the four
    /// callers each know a different reason this name stopped being a recorded combatant, and the
    /// retraction is a row DISAPPEARING from a meter — which is the single most confusing thing this
    /// engine can do without saying why.
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
        // THE LAST ACTIVITY TS, not a clock: a retraction is triggered by a line the engine folded,
        // and stamping it with the fight's own last instant is what the TS does.
        let ts = self.last_activity_ts;
        self.log(
            ts,
            "charm",
            "dropped",
            format!("✕ {name_key}: {why} - its recorded row is now the pet's"),
        );
    }

    /// RE-INDEX `pet_names` off the world model's live pets, and report the name keys that fell out.
    ///
    /// `pet_names` is not a second opinion about who your pets are — it is a fast NAME index of the
    /// world model's pet INSTANCES, which is why every path that can retire one has to put the two
    /// back in step. `ever_pet` is untouched by design: it records that a name was EVER yours, and a
    /// retired pet is still a pet, never a candidate player.
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

    /// DEMOTE the charm binds whose corroboration window has closed. Driven by the LOG clock — once
    /// per ingested event, and (live only) once per snapshot — so a replay and a live tail demote at
    /// exactly the same instants. Cheap: the guard is an emptiness read.
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

    /// END the ally binds whose charm can no longer be running. Same clock, same two callers.
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

    /// MAY `name_key` BE A THIRD-PARTY CHARMER? The behavioural half of the caster gate — the name
    /// shape answers the other half, and the ally model asks both.
    ///
    /// The three refusals are the SAME absolute guards `note_player` wears, for the same reason: a
    /// name YOU have landed damage on is a mob, a name any charm broadcast has ever named is a mob,
    /// and a name that is or was your pet is a pet. A single-word proper-named mob is exactly what
    /// the shape test cannot refuse, and these are what catch it.
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

    /// IS `name_key` ON THE FRIENDLY SIDE OF AN ALLY CHARM? A bound ally pet swinging at one of these
    /// is the SOFT-HOSTILE PROOF that its charm broke.
    ///
    /// Five sources, widest first: you, your own live pets, the group roster, anyone the heal stream
    /// proved a player, and the ally model's own caster/charmer set. The last does the work in
    /// practice, because the measured breaks are pets turning on the STRANGER who charmed them, and
    /// a stranger is invisible to the other four.
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

    /// PRESENCE refresh — record that `name` is still in the current fight as of `ts`. The LIVENESS
    /// axis ONLY: it moves nothing on the damage timeline, so DPS denominators and the fled-mob
    /// fallback clock are unaffected.
    ///
    /// Deliberately conservative in both directions: it never ENGAGES anything (only instances
    /// ALREADY engaged are refreshed, so a miss or resist still cannot open or join an encounter),
    /// and it never resolves or creates a world instance — it matches the engaged instance ids by
    /// NAME PREFIX — so a whiff at a mob we have never damaged has no side effect on the world model
    /// at all. Name-level matching refreshes every engaged twin sharing the name: the log cannot tell
    /// twins apart on a miss line, and a retired twin is "gone" via `is_retired` anyway.
    pub fn note_presence(&mut self, name: &str, ts: i64) {
        if self.current.is_none() {
            return;
        }
        let key = id_key_ref(name);
        if self.is_known_player(&key) {
            return;
        }
        // …and a GROUP MEMBER is never a hostile either. Members never reach `engaged`, so the loop
        // below would find nothing to refresh anyway; the early return states the rule where a
        // reader looks for it and keeps it from depending on that other guard staying correct.
        if self.is_member(&key) {
            return;
        }
        // Keep the WORLD's per-instance clock in lockstep with the encounter's presence axis, so
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
    /// PRESENCE DISCIPLINE: a refresh may only ever describe a HOSTILE we are fighting. Two entities
    /// can never be refreshed here, because keeping the fight alive on their account is what let a
    /// stranger's 214-second brawl swallow three of the owner's pulls: a KNOWN PLAYER (never a
    /// hostile) and a LIVE PET of ours (never something we are killing).
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

    /// INSTANCE-RESOLVED defender label for a damage-free instant (miss / resist).
    ///
    /// The damage path labels its defender through the world model, so twins read as `a deadly black
    /// widow (7)` / `(8)`. Miss and resist ticks carried the RAW log name instead, which grew a
    /// bare-named 0-damage ghost row alongside the two real instances in the per-mob panel.
    ///
    /// Resolution is GATED on the name already being engaged in this encounter. That keeps law 8
    /// intact in both directions: `engaged` membership only ever comes from LANDED damage or heals,
    /// so a whiff at a mob we have never damaged still has ZERO world-model side effects and simply
    /// keeps its raw name — the honest label when no instance exists.
    /// ── AND IT IS NOT A PURE READ, WHICH IS WHY THE UNPORTED TIMELINE STILL HAS TO CALL IT ──────
    ///
    /// The `resolve()` inside it REFRESHES `lastSeenTs`, RETIRES the name's stale instances, and
    /// ADOPTS the sighting's casing as the instance display. That last one is load-bearing for a
    /// number the snapshot publishes: `bumpTarget` stores the label it is handed and never refreshes
    /// it (first write wins), so a fight's NAME is whichever spelling the world model held at the
    /// first outgoing hit — and an outgoing DAMAGE SHIELD tick is sentence-initial for the mob
    /// (`A Teir\`Dal ranger is burned by YOUR flames …`). Skipping this call because its RETURN feeds
    /// only the unported timeline left 25/71/2/1/53 fight names per slice capitalized, and it is the
    /// mid-sentence miss at that mob — this call — that flips the display back.
    ///
    /// So the label is discarded here and the call is made anyway. The caller gates on the FRESH
    /// encounter exactly as the TS does; without one, the raw name stands and nothing is touched.
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

    /// APPEND ONE CLASSIFIED LINE — `state.ts log()`, and the whole of the classification ring.
    ///
    /// `if (!this.recording) return` IS THE FIRST LINE OVER THERE AND IT IS THE FIRST LINE HERE, and
    /// keeping the gate INSIDE this method rather than at the forty call sites is what makes "a
    /// replay writes nothing" a structural fact instead of forty remembered ones. It is also what
    /// keeps the six-slice oracle whole: the recorder never calls `set_live()`, so `recording` is
    /// false for every recorded byte and `recent` is `[]` in every golden — the same answer it gave
    /// before this buffer existed, now given by the flag the TypeScript gives it with.
    ///
    /// A DISPLAY BUFFER AND NOTHING ELSE. No count, no total, no attribution and no view reads it;
    /// it is the live processing log a person opens when they want to know why the meter said what
    /// it said. That is why a line is a SENTENCE rather than a record — the reader is a human, and
    /// the sentences are copied verbatim from the app so a bug report quoting one is findable in
    /// either tree.
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

    /// Freeze the LIVE zone aggregate into the capped history, called on a zone change (and on the
    /// epoch boundary) BEFORE the aggregate is reset, so the just-left zone's overall meter stays
    /// selectable. Drops a stay that saw no attributed damage — nothing to show.
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

    /// MINT FRESH ZONE ACCUMULATORS — the second half of every stay boundary, its own function
    /// because there are two callers and one of them must not be allowed to drift: the zone line and
    /// the session mark. THE MARK IS THIS AND NOTHING ELSE; everything the zone case does besides
    /// this pair is a statement about the ROOM changing.
    pub fn reset_zone_accumulators(&mut self) {
        self.zone_agg = Agg::new();
        self.zone_finalized_ms = 0;
        self.zone_active_ms = 0;
        self.zone_start_ts = 0;
        self.zone_last_ts = 0;
    }
}

/// The nameKey half of an instance id `<nameKey>#<gen>`. `None` when the id carries no `#` at a
/// position that could split one — which is the `you` sentinel and nothing else.
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

    /// A retired pet leaves the ATTRIBUTION set and stays in `ever_pet` — a retired pet is still a
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
