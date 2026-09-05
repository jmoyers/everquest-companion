//! A log-mined buff/debuff-duration model and a small simulation of which ENTITY each buff is bound
//! to. All state is derived from events; this file is the `EqModule` surface over the collaborators
//! the model is factored into.
//!
//! A buff INSTANCE is a pair (spell, target entity), keyed by (spell key, entity key). The same
//! spell can run on you AND your pet AND a mob at once — three independent instances, three
//! independent timers. There is no "pet" class: a pet is simply the entity currently claimed, and
//! buff-vs-debuff is a SPELL property read from the catalog's nature.
//!
//! An instance opens ONLY on a line that CONFIRMS the landing, keyed to the entity that line NAMES.
//! Never a cast, never an inferred or "current" target, never a resist — a resist prints no landing
//! line at all. Honest limit: where EQ surfaces no landing line, nothing is tracked. A cast records
//! a pending cast and an anchor; it displays nothing.
//!
//! This module is the only authoritative source of the RESOLVED wear-off signal. When it resolves a
//! wear-off against the live active set it synthesizes `buffExpired { spell, target }` back onto the
//! same bus so the alerts module can match one reliable kind for both sides of the question. The
//! event is stamped with the PRIMARY event's seq/ts/live, which is why those are recorded before
//! dispatching and why a derived `buffExpired` is refused at the top of `on_event`.
//!
//! An EPOCH is a character rebirth: clear all live state. What is kept is deliberate — the mined
//! durations, the everFaded/class maps, the learned emote recognition and the message overlay are
//! GAME knowledge, identical across a rebirth.
//!
//! An OFFLINE GAP is the character having been out of the world, and EQ pauses buff timers while it
//! is; it is also what answers an open log hole. It arrives drained immediately after its
//! `sessionStart`, and therefore BEFORE the zone line that follows every login — deliberate, because
//! this shift only moves clocks and the zone event landing next runs the ordinary entity censor.

use crate::event::{Event, Key, Kind};
use crate::jsmap::JsMap;
use crate::modules::buff_anchors::CastAnchors;
use crate::modules::buff_landing::{admit_landing, Candidate};
use crate::modules::buffs_entities::PetEntities;
use crate::modules::buffs_instances::{BuffInstances, LandingSpec};
use crate::modules::buffs_mining::OverlayMining;
use crate::modules::buffs_session::SessionFrame;
use crate::modules::buffs_shapes::{
    spell_key, EMOTE_MIN_OBSERVATIONS, EMOTE_WINDOW_MS, PERMANENT_ILLUSION, QUICK_BUFF, SELF_KEY,
};
use crate::modules::buffs_stats::SpellStats;
use crate::modules::buffs_view::ActiveBuff;
use crate::spell_facts::SpellFacts;
use crate::EqModule;
use eqlog::names::id_key;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;

/// The shared halves — the one cast-anchor history and the one learner, held by both this module
/// and the crowd-control one so the two cannot drift.
///
/// The borrow can never nest: the two modules are adjacent in the wiring order with nothing between
/// them, neither reaches into the other during a delivery, and each takes the borrow once at the top
/// of its own `on_event`.
pub struct BuffsCore {
    pub anchors: CastAnchors,
    pub stats: SpellStats,
}

pub type SharedCore = Rc<RefCell<BuffsCore>>;

pub fn shared_core(facts: SpellFacts) -> SharedCore {
    Rc::new(RefCell::new(BuffsCore {
        anchors: CastAnchors::new(),
        stats: SpellStats::new(facts),
    }))
}

pub struct BuffsModule {
    seq: i64,
    core: SharedCore,
    /// The pet/charm/target identity slots (the who/what).
    pets: PetEntities,
    /// The live (spell, entity) instances + every mutation over them.
    inst: BuffInstances,
    /// ts from which the Permanent Illusion AA is owned (self illusions become permanent).
    permanent_illusion_owned_ts: Option<i64>,
    /// Emote learning: recognize real landing-emote texts.
    emote_text_count: JsMap<i64>,
    /// Last-seen clock + the log-hole question.
    frame: SessionFrame,
    /// The observed-message overlay: which lines the miner is fed, and what it builds.
    mining: OverlayMining,
    /// A read-only copy of the catalog for the landing gate, which asks it about NATURE. Taking a
    /// second copy rather than reaching through the shared borrow is what keeps `admit_landing` a
    /// plain function over immutable facts.
    facts: SpellFacts,
    /// The `buffExpired` events synthesized while folding the current PRIMARY event, in emission
    /// order, waiting for the registry to take them.
    derived: Vec<Event<'static>>,
    /// The last primary event's identity, which is what an expiry is stamped with. It is a FIELD
    /// rather than a parameter because a wall-clock tick synthesizes expiries too and has no event
    /// of its own to name — and the stamp is deliberately the log's last instant rather than the
    /// host's clock, because a derived event carrying a wall time would put a number into the event
    /// stream that no line of the log ever said.
    ///
    /// Not cleared by `reset()`, and unobservable: a fresh world's first expiry cannot precede its
    /// first event.
    cur_seq: i64,
    cur_ts: i64,
    /// The announce cursor — see [`crate::announce`]. It is not a revision counter; it is the same
    /// question asked one level up, where `on_event` has the whole event in front of it. Three
    /// things are published (`active`, `stats`, `overlay`); each arm answers whether it could have
    /// moved one of them, the arms that could not are named individually, and anything nobody can
    /// answer without reopening the buff system answers `true`. So it over-reports on a subset that
    /// excludes the catch-all arm, which is where every line of a melee round lands.
    announce: crate::announce::Announce,
}

impl BuffsModule {
    pub fn new(facts: SpellFacts, core: SharedCore) -> Self {
        BuffsModule {
            seq: 0,
            core,
            pets: PetEntities::new(),
            inst: BuffInstances::new(),
            permanent_illusion_owned_ts: None,
            emote_text_count: JsMap::new(),
            frame: SessionFrame::new(),
            mining: OverlayMining::new(
                facts.clone(),
                &[(
                    crate::message_overlay::BASELINE_SOURCE,
                    crate::message_overlay::baseline_counts(),
                )],
            ),
            facts,
            derived: Vec::new(),
            cur_seq: 0,
            cur_ts: 0,
            announce: crate::announce::Announce::default(),
        }
    }

    /// Drain the instance store's resolved expiries into the derived queue, stamped with the PRIMARY
    /// event's identity. The `raw` is a synthesized human-readable line, which is what an alert's
    /// recent-fires panel shows.
    fn flush_expiries(&mut self, seq: i64, ts: i64) {
        for e in std::mem::take(&mut self.inst.expired) {
            let who = if e.target == "self" { "you" } else { &e.target };
            self.derived.push(Event::from_value(json!({
                "kind": "buffExpired",
                "seq": seq,
                "ts": ts,
                "raw": format!("{} wore off {}.", e.spell, who),
                "spell": e.spell,
                "target": e.target,
            })));
        }
    }

    fn on_cast_begin(&mut self, ev: &Event, core: &mut BuffsCore) {
        let spell = ev.str(Key::Spell).unwrap_or_default().to_string();
        let key = spell_key(&spell);
        core.anchors.note_self_cast(&spell, ev.ts());
        core.stats.touch_last_seen(&key, ev.ts());
        self.inst.begin_cast(key, ev.ts());
    }

    /// A landing emote adjacent to a cast, learned by REPETITION: a text seen twice next to a cast
    /// is trusted to name that cast's subject, which proves a SELF cast even while a pet is live.
    fn on_spell_emote(&mut self, ev: &Event) {
        let ts = ev.ts();
        let Some((began_ts, already_named)) = self
            .inst
            .pending
            .as_ref()
            .map(|p| (p.began_ts, p.emote_subject_key.is_some()))
        else {
            return;
        };
        if ts - began_ts > EMOTE_WINDOW_MS || ts < began_ts || already_named {
            return;
        }
        let text = ev.str(Key::Text).unwrap_or_default().to_string();
        let n = self.emote_text_count.get(&text).copied().unwrap_or(0) + 1;
        self.emote_text_count.insert(text, n);
        if n >= EMOTE_MIN_OBSERVATIONS {
            let subject = ev.str(Key::Subject).unwrap_or_default();
            let key = if subject == "self" {
                SELF_KEY.to_string()
            } else {
                id_key(subject)
            };
            // Re-taken because the count write above ended the first borrow.
            if let Some(p) = self.inst.pending.as_mut() {
                p.emote_subject_key = Some(key);
            }
        }
    }

    /// Cast-anchored attribution: a landing emote is a broadcast naming no caster, so without an
    /// anchor a stranger's buff would bind as ours. A refusal means the landing produces nothing.
    fn on_buff_apply(&mut self, ev: &Event, core: &mut BuffsCore) {
        let cands = candidates_of(ev);
        let ts = ev.ts();
        let landing = {
            let inst = &self.inst;
            let has_active = |k: &str| inst.has_active_spell(k);
            admit_landing(&cands, ts, &core.anchors, &self.facts, &has_active)
        };
        let Some(landing) = landing else { return };
        let spec = LandingSpec {
            target: ev.str(Key::Target).unwrap_or_default().to_string(),
            ts,
            illusion: landing.illusion,
            duration_ms: landing.duration_ms,
            caster: Some(landing.caster),
            line_key: landing.line_key,
            cast_name: landing.cast_name,
            candidates: landing.candidates,
            permanent_illusion_owned_ts: self.permanent_illusion_owned_ts,
        };
        self.inst
            .apply_message_buff(&landing.spell, &spec, &mut core.stats, &mut self.pets);
    }

    /// A HoT tick is not a landing. `You healed <X> over time for N by <Spell>.` is printed once per
    /// tick by an already-landed heal-over-time and is cast-detached by construction, so treating it
    /// as a landing would restart the clock every tick and mint every tick→fade span as a sample.
    /// Only the DIRECT heal line opens anything here.
    fn on_heal(&mut self, ev: &Event, core: &mut BuffsCore) {
        if ev.bool(Key::OverTime) {
            return;
        }
        let Some(spell) = ev.str(Key::Spell).filter(|s| !s.is_empty()) else {
            return;
        };
        if id_key(ev.str(Key::Healer).unwrap_or_default()) != "you" {
            return;
        }
        let key = spell_key(spell);
        let Some(row) = self.facts.get(&key) else {
            return;
        };
        let Some(duration_ms) = row.duration_ms else {
            return;
        };
        let (name, illusion) = (row.name.clone(), row.illusion);
        let spec = LandingSpec {
            target: "self".to_string(),
            ts: ev.ts(),
            illusion,
            duration_ms: Some(duration_ms),
            caster: None,
            line_key: None,
            cast_name: None,
            candidates: None,
            permanent_illusion_owned_ts: self.permanent_illusion_owned_ts,
        };
        self.inst
            .apply_message_buff(&name, &spec, &mut core.stats, &mut self.pets);
    }

    fn on_buff_fade(&mut self, ev: &Event, core: &mut BuffsCore) {
        let spell = ev.str(Key::Spell).unwrap_or_default().to_string();
        let key = spell_key(&spell);
        core.stats.note_ever_faded(&key);
        // The wear-off channel is witnessed only for the TARGET-NAMED sentence. `Your <X> spell has
        // worn off of <target>.` is the one line proving this spell announces its own end on
        // somebody who is not you, which is what lets a later silence over a corpse mean anything.
        // The targetless shapes are a different channel: the parser emits no target at all for a
        // self buff and the literal `pet` for the possessive form, and a mob can never be called
        // `pet`, so the two cannot collide.
        let target = ev.str(Key::Target);
        if target.is_some_and(|t| t != "pet") {
            core.stats.witness_wear_off_channel(&key);
        }
        // Resolve the fade's target entity: the possessive `pet` form against the CURRENT pet's key,
        // a named mob to that mob's key, targetless to self.
        let (entity_key, _disp) = self.pets.fade_target_entity(target);
        // A fade is not a landing: retro-landing the pending cast to measure the span is unsound
        // whenever the fade belongs to an EARLIER instance of the same spell.
        self.inst.clear_pending_cast(&key);
        self.inst.record_fade(
            &key,
            &entity_key,
            &spell,
            ev.ts(),
            &mut core.stats,
            &self.pets,
        );
        // `buffFade` already carries a resolved spell and target, so the derived event is
        // synthesized outright: one alert kind covers every shape of wear-off.
        let display = self.pets.buff_fade_target_display(target, &entity_key);
        self.inst
            .expired
            .push(crate::modules::buffs_instances::Expiry {
                spell,
                target: display,
            });
    }

    /// Disposition, not identity: re-charming the same name after a charm break — with no
    /// intervening death or zone of that name — is the SAME entity. Its buffs are still active on it
    /// and it must not trigger single-pet succession against itself.
    fn on_charm(&mut self, ev: &Event) {
        let mob = ev.str(Key::Mob).unwrap_or_default().to_string();
        let new_key = id_key(&mob);
        let same_as_broken = self.pets.broken_charm_key.as_deref() == Some(new_key.as_str());
        let same_as_charmed = self.pets.charmed_key.as_deref() == Some(new_key.as_str());
        if !same_as_broken && !same_as_charmed {
            // Single-pet invariant: charming a DIFFERENT entity retires the prior pet(s), including
            // a broken-charm entity never re-charmed — that one really is left behind.
            for slot in [
                self.pets.charmed_key.clone(),
                self.pets.broken_charm_key.clone(),
                self.pets.summoned_key.clone(),
            ]
            .into_iter()
            .flatten()
            {
                self.inst.retire_entity(&slot, &mut self.pets);
            }
            self.pets.pet_target_key = None;
            self.pets.pet_target_display = None;
        }
        // Re-bind the charmed entity. If this reconnects a broken charm, its buff instances were
        // never censored and remain active on it.
        self.pets.charmed_key = Some(new_key);
        self.pets.charmed_display = Some(mob);
        self.pets.broken_charm_key = None;
        self.pets.broken_charm_display = None;
    }

    fn on_pet_claim(&mut self, ev: &Event) {
        let name = ev.str(Key::Name).unwrap_or_default().to_string();
        let key = id_key(&name);
        let known = [
            self.pets.charmed_key.as_deref(),
            self.pets.summoned_key.as_deref(),
            self.pets.broken_charm_key.as_deref(),
        ]
        .contains(&Some(key.as_str()));
        if known {
            return;
        }
        // Single-pet succession: claiming a DIFFERENT pet retires the prior pet(s), including a
        // broken-charm entity never re-charmed.
        for slot in [
            self.pets.summoned_key.clone(),
            self.pets.charmed_key.clone(),
            self.pets.broken_charm_key.clone(),
        ]
        .into_iter()
        .flatten()
        {
            self.inst.retire_entity(&slot, &mut self.pets);
        }
        self.pets.summoned_key = Some(key);
        self.pets.summoned_display = Some(name);
    }

    /// A charm break is a disposition change, not a retirement. The mob keeps its identity and every
    /// buff instance; it is simply hostile-capable until you re-charm it. The broken-charm slot is
    /// what lets a re-charm of the SAME name reconnect with buffs intact, and a death or zone of
    /// that name in the meantime retires it through the existing paths.
    fn on_uncharm(&mut self, ev: &Event) {
        let mob = id_key(ev.str(Key::Mob).unwrap_or_default());
        if self.pets.charmed_key.as_deref() == Some(mob.as_str()) {
            self.pets.broken_charm_key = self.pets.charmed_key.take();
            self.pets.broken_charm_display = self.pets.charmed_display.take();
        }
    }

    /// A death is two questions with different answers.
    ///
    /// "Did something of that name just die?" — the debuff censor runs unconditionally, on the dead
    /// name and never on the killer. The killer is a name too, and it can be the same name: a
    /// charmed pet killing its twin prints `X has been slain by X!`.
    ///
    /// "Is the ENTITY behind that name retired?" — about identity, and the only place the pet
    /// bindings get a vote. Letting that question swallow the first is how a death naming the
    /// charmed pet used to leave even the slow on the corpse standing.
    fn on_death(&mut self, ev: &Event, core: &mut BuffsCore) {
        let name = ev.str(Key::Name).unwrap_or_default();
        let key = id_key(name);
        self.inst
            .on_entity_death(&key, ev.ts(), &mut core.stats, &self.pets);
        if self.death_retires_entity(ev, &key) {
            self.inst.retire_entity(&key, &mut self.pets);
        }
        if self.pets.pet_target_key.as_deref() == Some(key.as_str()) {
            self.pets.pet_target_key = None;
            self.pets.pet_target_display = None;
        }
    }

    /// Whether this death retires the ENTITY — its identity and every buff on it — not just its
    /// debuffs. A death line naming the LIVE charmed pet is ambiguous between the pet and a twin of
    /// its name, so it never retires; the branch is written out rather than folded away so the rule
    /// stays visible.
    fn death_retires_entity(&self, ev: &Event, key: &str) -> bool {
        let killer_is_you =
            ev.bool(Key::BySelf) || id_key(ev.str(Key::Killer).unwrap_or_default()) == "you";
        if self.pets.summoned_key.as_deref() == Some(key) {
            return !killer_is_you;
        }
        if self.pets.charmed_key.as_deref() == Some(key) {
            return false;
        }
        // A death naming the broken-charm entity genuinely retires it, so the next charm of that
        // name binds a fresh entity. The twin ambiguity that protects a LIVE charmed pet does not
        // apply once the charm has broken.
        self.pets.broken_charm_key.as_deref() == Some(key)
    }

    /// Every live instance, oldest first, typed — the same seam `build_state` reads, so the bars and
    /// the Buffs tab can never disagree about what is running. The order is `started_ts` because
    /// that is what `build_state` publishes, and the projection's stable sort runs on top of it.
    #[must_use]
    pub fn active_buffs(&self) -> Vec<ActiveBuff> {
        self.active_instances()
            .into_iter()
            .map(|(_, b)| b)
            .collect()
    }

    /// The same, with the instance key each was filed under.
    ///
    /// The key is the model's own identity, handed out rather than rebuilt: a view needs a stable
    /// row key across serve passes, and deriving one from the projected fields would be a second
    /// identity waiting to disagree the first time a spell resolves to a different display name.
    #[must_use]
    pub fn active_instances(&self) -> Vec<(String, ActiveBuff)> {
        let mut active: Vec<(String, ActiveBuff)> = self
            .inst
            .active
            .iter()
            .map(|(k, v)| (k.to_owned(), v.clone()))
            .collect();
        active.sort_by_key(|(_, a)| a.started_ts);
        active
    }

    /// The view layer's change signal, and NOT the announce cursor.
    ///
    /// Deliberately coarse: this module has no revision counter, so it reports the fold's own `seq`,
    /// which moves on every event. It can never miss a change — the property the view layer's
    /// correctness needs — and it over-reports, costing one re-cut of the buff and timer windows per
    /// serve beat over a row set of tens.
    ///
    /// The announce cursor beside it answers the same question for a reader with a very different
    /// cost, and answers it by over-approximating per arm — sound for a dirty bit, but a bet for a
    /// window whose remaining times are a function of `now`. Two readers, two signals: fusing them
    /// would tie a view's correctness to an audit made for somebody else's sake.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.seq
    }

    /// A new log is about to be folded from its first byte.
    ///
    /// Mining is GAME knowledge and survives `reset()` on purpose — a spell's cast messages are the
    /// same for every character — but the counts THIS log accounts for are about to be re-stated in
    /// full, so its bucket is discarded rather than added to.
    pub fn begin_overlay_source(&mut self, key: &str) {
        self.mining.begin_source(key);
    }

    /// Seed one persisted bucket. See `OverlayMining::seed` for why it is not part of construction,
    /// and [`BuffsModule::begin_overlay_source`] for the call that must follow it.
    pub fn seed_overlay(&mut self, key: &str, counts: &[crate::message_overlay::SeedMessage]) {
        self.mining.seed(key, counts);
    }

    /// The persistence view of the mined overlay — raw counts per source, no verdicts.
    #[must_use]
    pub fn overlay_register(&self) -> crate::message_overlay::OverlayRegister {
        self.mining.register()
    }

    fn build_state(&self, stats: &SpellStats) -> Value {
        let active = self.active_buffs();
        json!({
            "active": active,
            "stats": stats.build_stats(),
            "overlay": self.mining.build(),
        })
    }
}

/// The `buffApply` candidate shape.
fn candidates_of(ev: &Event) -> Vec<Candidate> {
    ev.candidates(Key::Candidates)
        .into_iter()
        .map(|(name, duration_ms, illusion)| Candidate {
            name,
            duration_ms,
            illusion,
        })
        .collect()
}

/// The `buffWearOff` candidate shape — plain names.
fn wear_off_candidates(ev: &Event) -> Vec<String> {
    ev.arr_str(Key::Candidates)
        .into_iter()
        .map(str::to_string)
        .collect()
}

impl EqModule for BuffsModule {
    fn id(&self) -> &'static str {
        "buffs"
    }

    fn reset(&mut self) {
        self.seq = 0;
        self.announce.reset();
        self.inst.reset();
        {
            let mut core = self.core.borrow_mut();
            core.stats.reset();
            core.anchors.reset();
        }
        self.emote_text_count.clear();
        self.frame.reset();
        self.permanent_illusion_owned_ts = None;
        self.pets.reset();
        // Not reset: the message-overlay mining. It is game knowledge, and
        // `begin_overlay_source` — not `reset` — is what discards a source's bucket.
    }

    /// `live` is unused here, and stating that is the point: the drain re-uses the PRIMARY event's
    /// own flag for everything it delivers, so the derived `buffExpired` gets the same value by a
    /// shorter route. Nothing else in the buffs model reads it.
    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        // A derived `buffExpired` is our own synthesized event — never fold it. It exists purely for
        // the alerts module to match.
        if ev.kind() == "buffExpired" {
            return;
        }
        let core_rc = Rc::clone(&self.core);
        let mut core = core_rc.borrow_mut();
        if ev.kind() == "epoch" {
            self.frame.close_hole();
            self.inst.clear_for_gap();
            self.pets.clear_for_gap();
            self.announce.changed(self.seq);
            return;
        }
        if ev.kind() == "offlineGap" {
            let from_ts = ev.int(Key::FromTs).unwrap_or(0);
            let to_ts = ev.int(Key::ToTs).unwrap_or(0);
            self.frame.close_hole();
            self.inst
                .on_offline_pause(from_ts, to_ts - from_ts, &core.stats, &self.pets);
            // A logout despawns your pet, so the bindings go even though the buffs on YOU stay; the
            // instances bound to those entities are censored by the zone line that follows the
            // login. The last-event ts is NOT advanced: the gap restates an instant the primary
            // event already recorded.
            self.pets.clear_for_gap();
            self.announce.changed(self.seq);
            return;
        }
        let (seq, ts) = (ev.seq(), ev.ts());
        // Record the primary event's identity so any `buffExpired` synthesized while folding it —
        // or on a later wall-clock tick, which has no event of its own — is stamped with it.
        self.cur_seq = seq;
        self.cur_ts = ts;
        // The per-event prelude. All four of these run for EVERY line, so each has to answer for
        // itself whether it published anything. First: a log hole no login ever explained means we
        // lost the thread rather than the character having left, so what was standing when it
        // opened goes, and the pet bindings with it.
        let mut published = false;
        if let Some(unexplained_before) = self.frame.observe(ev) {
            self.inst.drop_predating(unexplained_before);
            self.pets.clear_for_gap();
            published = true;
        }
        // Not counted: `pending` is a cast in flight and is not in `build_state`, so dropping one
        // that never landed changes nothing a client can read.
        self.inst.drop_unconfirmed_pending(ts);
        published |=
            self.inst
                .sweep_hygiene(ts, self.frame.held_before_ts(), &core.stats, &self.pets);

        // Overlay mining: feed the anchor cast and any candidate message line so the miner accretes
        // (message, spell) associations across replay AND live. The overlay is published, so a line
        // that reaches the miner counts.
        published |= self.mining.observe(ev);

        // Every arm answers one question: can this move `active`, `stats` or `overlay`? The arms
        // answering `false` move the anchors, the pending cast, the pet bindings or the AA ownership
        // stamp — real state, none of it in the snapshot. Everything else says `true`, the
        // over-approximation the announce law asks for.
        published |= match ev.kind_of() {
            Kind::CastBegin => {
                self.on_cast_begin(ev, &mut core);
                true
            }
            Kind::SpellEmote => {
                self.on_spell_emote(ev);
                true
            }
            // An anchor ONLY for a caster on the externals allowlist (default: nobody). The anchors
            // enforce that; the event is folded either way so the refusal lives in one place.
            Kind::OtherCastBegin => {
                core.anchors.note_other_cast(
                    ev.str(Key::Caster).unwrap_or_default(),
                    ev.str(Key::Spell).unwrap_or_default(),
                    ts,
                );
                // An anchor is what a LATER landing is attributed by. It is not published.
                false
            }
            Kind::CastFizzle | Kind::CastInterrupted => {
                let spell = ev.str(Key::Spell).unwrap_or_default().to_string();
                self.inst.clear_pending_cast(&spell_key(&spell));
                core.anchors.clear_cast(&spell);
                // A cast that never landed opened nothing to retract — see `begin_cast`.
                false
            }
            // `You activate Quick Buff.` is a SELF anchor naming a window rather than a spell: it
            // applies many spells at once with no cast line of their own, so a rule demanding one
            // per spell would refuse the player's own buffs.
            Kind::AaActivate => {
                if id_key(ev.str(Key::Name).unwrap_or_default()) == QUICK_BUFF {
                    core.anchors.note_quick_buff(ts);
                }
                // A window an anchor is read through — not published.
                false
            }
            Kind::AaSpend => {
                if self.permanent_illusion_owned_ts.is_none()
                    && id_key(ev.str(Key::Ability).unwrap_or_default()) == PERMANENT_ILLUSION
                {
                    self.permanent_illusion_owned_ts = Some(ts);
                }
                // The stamp decides how a LATER illusion is classified; no snapshot carries it.
                false
            }
            Kind::BuffApply => {
                self.on_buff_apply(ev, &mut core);
                true
            }
            // The wear-off emote prints to the buff HOLDER, so it clears the SELF instance. Many
            // spells share one wear-off message, so it is resolved against the ACTIVE self set.
            Kind::BuffWearOff => {
                let cands = wear_off_candidates(ev);
                self.inst
                    .remove_shared_wear_off(&cands, SELF_KEY, ts, &mut core.stats, &self.pets);
                true
            }
            // `Your illusion fades.` — only one illusion is ever active on self, so this removes
            // whichever illusion self buff is active. No spell name needed: the line is 27-way
            // ambiguous by design.
            Kind::IllusionFade => {
                self.inst.clear_self_illusion(&core.stats);
                true
            }
            Kind::Heal => {
                self.on_heal(ev, &mut core);
                true
            }
            Kind::BuffFade => {
                self.on_buff_fade(ev, &mut core);
                true
            }
            Kind::PlayerDeath => {
                self.inst.on_player_death(&core.stats, &self.pets);
                true
            }
            // These three are `true` by the unsure rule rather than by audit: a charm or a claim
            // rebinds an entity and instances are held against entities, so whether a rebinding
            // censors a live row is left answered the safe way.
            Kind::Charm => {
                self.on_charm(ev);
                true
            }
            Kind::PetClaim => {
                self.on_pet_claim(ev);
                true
            }
            Kind::Uncharm => {
                self.on_uncharm(ev);
                true
            }
            Kind::Cc => {
                let mob = ev.str(Key::Mob).unwrap_or_default().to_string();
                self.pets.pet_target_key = Some(id_key(&mob));
                self.pets.pet_target_display = Some(mob);
                // Which mob your pet is on. It names the target a later landing binds to and is
                // published nowhere.
                false
            }
            Kind::Death => {
                self.on_death(ev, &mut core);
                true
            }
            Kind::Zone => {
                self.inst.on_zone(&core.stats, &mut self.pets);
                true
            }
            _ => false,
        };
        drop(core);
        if published {
            self.announce.changed(self.seq);
        }
        self.flush_expiries(seq, ts);
    }

    /// The wall-clock heartbeat: the same two calls `on_event` makes, with the wall clock where the
    /// log's clock goes. A cast nothing confirmed inside the landing window is dropped, and the
    /// hygiene sweep retires every active past its per-spell cap — without which a live engine
    /// serves buffs for a log whose last line was days ago.
    ///
    /// It deliberately does NOT rule on an open log hole: a hole is a question about the LOG, and
    /// only the log's own next line can answer it. The tick only AGES the model, and the sweep still
    /// honours whatever `held_before_ts` an open absence is protecting.
    ///
    /// The borrow is immutable, unlike `on_event`'s: the sweep reads the learner's durations and
    /// writes none. Expiries are flushed through the same door a folded event's are, stamped with
    /// the last event's identity — see `cur_seq`/`cur_ts`.
    fn on_tick(&mut self, now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        let core_rc = Rc::clone(&self.core);
        let core = core_rc.borrow();
        self.inst.drop_unconfirmed_pending(now_ms);
        let retired =
            self.inst
                .sweep_hygiene(now_ms, self.frame.held_before_ts(), &core.stats, &self.pets);
        drop(core);
        // A buff retired by the wall clock has no event behind it. `Announce::changed` lands
        // strictly above the fold position, so the sweep can announce a removal the log never
        // mentioned — and a beat that retired nothing stays silent.
        if retired {
            self.announce.changed(self.seq);
        }
        self.flush_expiries(self.cur_seq, self.cur_ts);
    }

    /// The dirty bit: a landing, a wear-off, a retirement, a mined message, or a rebirth. See the
    /// `announce` field and `crate::announce`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        let core = self.core.borrow();
        json!({ "seq": self.seq, "state": self.build_state(&core.stats) })
    }

    fn take_derived(&mut self) -> Vec<Event<'static>> {
        std::mem::take(&mut self.derived)
    }

    fn as_defines(&mut self) -> Option<&mut dyn crate::Defines> {
        Some(self)
    }

    /// The view pull seam. See `EqModule::as_buffs`.
    fn as_buffs(&self) -> Option<&BuffsModule> {
        Some(self)
    }

    /// The persisted-overlay write seam. See `EqModule::as_buffs_mut`.
    fn as_buffs_mut(&mut self) -> Option<&mut BuffsModule> {
        Some(self)
    }
}

impl crate::Defines for BuffsModule {
    fn family(&self) -> &'static str {
        "buffTrust"
    }

    /// The externals allowlist, replaced whole.
    ///
    /// It lands on the shared core and therefore on both modules at once, so the buff bar and the
    /// crowd-control bar cannot end up with two ideas of whose spell just landed. `buffs` answers
    /// for the family because it owns the core's construction; `buffTimers` clones the same handle
    /// and needs no define of its own.
    fn define(&mut self, payload: &Value) {
        let Some(list) = payload.get("externals").and_then(Value::as_array) else {
            return;
        };
        let names: Vec<String> = list
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        self.core.borrow_mut().anchors.set_trust(names);
    }
}
