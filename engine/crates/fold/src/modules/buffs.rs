//! `src/main/modules/buffs.ts` — a log-mined buff/debuff-duration model AND a small
//! who/what/when simulation of which ENTITY each buff is bound to. All state is derived from
//! events.
//!
//! This file is the `EqModule` surface: it turns log events into calls on the collaborators the
//! model is factored into — `buffs_instances` (the live (spell, entity) instances and every
//! mutation over them), `buffs_stats` (per-SPELL learned knowledge), `buffs_entities` (the
//! pet/charm/target identity slots), `buffs_session` (the last-seen clock and the log-hole
//! question), `buffs_view`/`buffs_shapes` (the projection and the constants) — and builds the
//! snapshot the UI reads.
//!
//! ── THE MODEL (read this before touching anything) ─────────────────────────────────────────────
//!
//! A buff INSTANCE is a pair (spell, targetEntity) keyed by (spellKey, entityKey), where entityKey
//! is 'self' or a canonical entity-name key. The SAME spell can be active on the player AND on the
//! pet AND on a mob simultaneously — three independent instances, three independent timers. There
//! is NO special 'pet' class: "pet" is simply the entity currently claimed, and buff-vs-DEBUFF is a
//! SPELL property read from the catalog's nature.
//!
//! A TRACKED INSTANCE EXISTS ONLY ONCE THE SPELL LANDS ON A NAMED TARGET (JOS-118). ONE rule for
//! buffs, debuffs and crowd control alike: an instance opens ONLY on a line that CONFIRMS the
//! landing, keyed to the entity that line NAMES. Never a cast, never an inferred or "current"
//! target, never a resist — a RESIST prints no landing line at all, so there is nothing to open,
//! which makes the JOS-118 defect impossible by construction rather than detected. HONEST LIMIT,
//! stated rather than papered over: where EQ surfaces no landing line, NOTHING is tracked.
//!
//! WHAT A CAST STILL DOES is record a PENDING cast and an ANCHOR. What it no longer does is DISPLAY
//! anything (owner: *"we should drop provisional all together. i dont want to complicate the
//! model"*).
//!
//! ── THE DERIVED EVENT THIS CLUSTER OWES (Task #47) ─────────────────────────────────────────────
//!
//! This module is the only authoritative source of the RESOLVED "wears off you / your pet" signal.
//! When it resolves a wear-off against the live active set — a self message wear-off, an illusion
//! fade, or a targeted pet/entity fade — it synthesizes `buffExpired { spell: RESOLVED, target }`
//! and hands it BACK ONTO THE SAME BUS, so the alerts module (registered before it, and therefore
//! reached again on the drain) can match ONE reliable kind for both sides of the question. Over
//! there that is an injected `emitDerived` closure; here it is `take_derived`, and the ORDER — the
//! only thing a fold can observe — is identical.
//!
//! The event is stamped with the PRIMARY event's seq/ts/live, which is why the module records those
//! three before dispatching and why a derived `buffExpired` is REFUSED at the top of `on_event`:
//! folding our own synthesized event would be a feedback loop.
//!
//! ── WHAT AN EPOCH AND AN OFFLINE GAP DO, AND WHY THEY ARE DIFFERENT ────────────────────────────
//!
//! An EPOCH is a character rebirth: clear ALL LIVE state — actives, open casts, pending, and the
//! entity bindings. What is KEPT is deliberate: the mined durations, the everFaded/class maps, the
//! learned landing-emote recognition and the observed-message overlay are GAME KNOWLEDGE, not
//! character state. A spell's duration and its cast messages are identical across a rebirth, so
//! re-learning them from zero would needlessly cold-start the model.
//!
//! An OFFLINE GAP is the character having been out of the world, and EQ PAUSES buff timers while it
//! is. It is also the event that ANSWERS an open log hole: the hole asked "did the character
//! leave?", and a derived gap is the log saying yes. It arrives DRAINED, immediately after its
//! `sessionStart` — and therefore BEFORE the `You have entered <zone>.` line that follows every
//! login (verified for all 20 logins in the real log: the zone line is 0–1 lines after the Welcome).
//! That ordering is deliberate: this shift only moves clocks, and the zone event that lands next
//! runs the EXISTING law-4 censor, which is what leaves charmed pets and hostiles behind on a login
//! exactly as on any other zone.

use crate::event::Event;
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

/// THE SHARED HALVES (JOS-140 ruling 1) — the ONE cast-anchor history and the ONE learner, held by
/// both this module and the crowd-control one.
///
/// Before that ticket both existed TWICE, folded from the same events, cleared on different rules,
/// and used to answer the same questions — which is exactly how the two systems drifted apart. Over
/// there `wiring.ts` hands the same JavaScript objects to both constructors; here they live behind
/// one `Rc<RefCell<…>>` that both modules clone. The borrow can never nest: the two are ADJACENT in
/// the wiring order with nothing between them, neither reaches into the other during a delivery, and
/// each takes the borrow once at the top of its own `on_event`.
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
    /// Emote learning (Task #33): recognize real landing-emote TEXTS.
    emote_text_count: JsMap<i64>,
    /// Last-seen clock + the log-hole question.
    frame: SessionFrame,
    /// The observed-message overlay: which lines the miner is fed, and what it builds.
    mining: OverlayMining,
    /// A read-only copy of the catalog for the landing gate, which asks it about NATURE. It is the
    /// same projection the learner holds; taking a second copy rather than reaching through the
    /// shared borrow is what keeps `admit_landing` a plain function over immutable facts.
    facts: SpellFacts,
    /// The `buffExpired` events synthesized while folding the current PRIMARY event, in emission
    /// order, waiting for the registry to take them.
    derived: Vec<Event>,
    /// `curSeq`/`curTs` — THE LAST PRIMARY EVENT'S IDENTITY, which is what an expiry is stamped
    /// with (`emitBuffExpired`). It has to be a FIELD rather than a parameter because a wall-clock
    /// tick synthesizes expiries too and has no event of its own to name: over there `onTick` runs
    /// long after `onEvent` set these, and the stamp is deliberately the log's last instant rather
    /// than the host's clock — a derived event carrying a wall time would put a number into the
    /// event stream that no line of the log ever said.
    ///
    /// NOT CLEARED BY `reset()`, exactly as over there: the TS resets nine fields and not these two.
    /// It is unobservable (a fresh world's first expiry cannot precede its first event) and it is
    /// copied rather than tidied, because a port that tidies is a port that has stopped matching.
    cur_seq: i64,
    cur_ts: i64,
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
        }
    }

    /// Drain the instance store's resolved expiries into the derived queue, stamped with the PRIMARY
    /// event's identity. `who` is 'you' for a player-side expiry, else the bound entity's display
    /// name; the `raw` is a synthesized human-readable line, which is what an alert's recent-fires
    /// panel shows.
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
        let spell = ev.str("spell").unwrap_or_default().to_string();
        let key = spell_key(&spell);
        core.anchors.note_self_cast(&spell, ev.ts());
        core.stats.touch_last_seen(&key, ev.ts());
        self.inst.begin_cast(key, ev.ts());
    }

    /// A landing emote adjacent to a cast, learned by REPETITION: a text seen twice next to a cast
    /// is trusted to name that cast's subject, which is what proves a SELF cast even while a pet is
    /// live.
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
        let text = ev.str("text").unwrap_or_default().to_string();
        let n = self.emote_text_count.get(&text).copied().unwrap_or(0) + 1;
        self.emote_text_count.insert(text, n);
        if n >= EMOTE_MIN_OBSERVATIONS {
            let subject = ev.str("subject").unwrap_or_default();
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

    /// CAST-ANCHORED ATTRIBUTION (JOS-140 rulings 2/3). A landing emote is a BROADCAST and names no
    /// caster, so without an anchor a stranger's buff binds as ours. A refusal means the landing
    /// produces nothing at all, which is the honest answer and the one three field reports asked
    /// for.
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
            target: ev.str("target").unwrap_or_default().to_string(),
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

    /// A HoT TICK IS NOT A LANDING (JOS-280, the JOS-118 law one lane over). `You healed <X> over
    /// time for N by <Spell>.` is printed once per tick by an ALREADY-LANDED heal-over-time and is
    /// cast-detached by construction. Without this guard every tick re-entered the landing path on
    /// the rank-STRIPPED name: the clock restarted every 6 s (the reported "timer bar resets in
    /// combat"), the rank chip died, a tick arriving after the wear-off resurrected a phantom bar,
    /// and every tick→fade span was minted as a duration sample — a 5 s median for a 41 s spell.
    /// Only the DIRECT heal line opens anything here.
    fn on_heal(&mut self, ev: &Event, core: &mut BuffsCore) {
        if ev.get("overTime").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let Some(spell) = ev.str("spell").filter(|s| !s.is_empty()) else {
            return;
        };
        if id_key(ev.str("healer").unwrap_or_default()) != "you" {
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
        let spell = ev.str("spell").unwrap_or_default().to_string();
        let key = spell_key(&spell);
        core.stats.note_ever_faded(&key);
        // THE WEAR-OFF CHANNEL IS WITNESSED HERE, AND ONLY FOR THE TARGET-NAMED SENTENCE (JOS-379).
        //
        // `Your <X> spell has worn off of <target>.` is the ONE line that proves this spell announces
        // its own end on somebody who is not you — which is the only thing that lets a later SILENCE
        // over a corpse mean anything. The targetless shapes are a different channel entirely: the
        // parser emits them with NO target at all for a self buff and with the literal `'pet'` for
        // `Your pet's <X> spell has worn off.`, so the named form is exactly "a target that is not
        // the possessive". A mob cannot be called `pet` — the possessive form never carries a name —
        // so the two cannot collide.
        let target = ev.str("target");
        if target.is_some_and(|t| t != "pet") {
            core.stats.witness_wear_off_channel(&key);
        }
        // Resolve the fade's target entity. A possessive 'pet' form resolves against the CURRENT pet
        // entity's key; a named mob → that mob's key; targetless → self.
        let (entity_key, _disp) = self.pets.fade_target_entity(target);
        // A FADE IS NOT A LANDING (JOS-118). This used to retro-land the pending cast so the
        // land→fade span became a duration sample, which is unsound whenever the fade belongs to an
        // EARLIER instance of the same spell: a committed fixture casts Pacify at 20:31:25 and
        // prints its wear-off two seconds later — a different mob's older cast — which minted a
        // 2-second Pacify sample.
        self.inst.clear_pending_cast(&key);
        self.inst.record_fade(
            &key,
            &entity_key,
            &spell,
            ev.ts(),
            &mut core.stats,
            &self.pets,
        );
        // `buffFade` already carries a RESOLVED spell + target, so the derived event is synthesized
        // outright: ONE alert kind covers a fade on your pet or your target as well as the self
        // message wear-off.
        let display = self.pets.buff_fade_target_display(target, &entity_key);
        self.inst
            .expired
            .push(crate::modules::buffs_instances::Expiry {
                spell,
                target: display,
            });
    }

    /// DISPOSITION, NOT IDENTITY (Task #37): re-charming the SAME name after a charm break — with no
    /// intervening death or zone of that name — is the SAME entity. Its buffs are still active on it
    /// and it must NOT trigger single-pet succession against itself; a break→re-charm cycle is the
    /// common case, seconds apart, and preserves everything.
    fn on_charm(&mut self, ev: &Event) {
        let mob = ev.str("mob").unwrap_or_default().to_string();
        let new_key = id_key(&mob);
        let same_as_broken = self.pets.broken_charm_key.as_deref() == Some(new_key.as_str());
        let same_as_charmed = self.pets.charmed_key.as_deref() == Some(new_key.as_str());
        if !same_as_broken && !same_as_charmed {
            // SINGLE-PET INVARIANT: charming a DIFFERENT entity retires the prior pet(s) — including
            // a broken-charm entity we never re-charmed, because you moved on to a new mob and the
            // old one really is left behind.
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
        // Re-bind (or bind) the charmed entity. If this reconnects a broken charm, its buff
        // instances were never censored, so they remain active on it.
        self.pets.charmed_key = Some(new_key);
        self.pets.charmed_display = Some(mob);
        self.pets.broken_charm_key = None;
        self.pets.broken_charm_display = None;
    }

    fn on_pet_claim(&mut self, ev: &Event) {
        let name = ev.str("name").unwrap_or_default().to_string();
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
        // broken-charm entity you never re-charmed — you have moved to a new pet.
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

    /// CHARM BREAK = DISPOSITION CHANGE, NOT RETIREMENT (Task #37). The mob KEEPS its identity and
    /// every buff instance — it is simply hostile-capable now until you re-charm it. This used to
    /// call `retireEntity`, which RESET the pet's buffs: the user-reported bug. Moving it to the
    /// broken-charm slot is what lets a re-charm of the SAME name reconnect with buffs intact; a
    /// death or zone of that name in the meantime retires it through the existing paths.
    fn on_uncharm(&mut self, ev: &Event) {
        let mob = id_key(ev.str("mob").unwrap_or_default());
        if self.pets.charmed_key.as_deref() == Some(mob.as_str()) {
            self.pets.broken_charm_key = self.pets.charmed_key.take();
            self.pets.broken_charm_display = self.pets.charmed_display.take();
        }
    }

    /// A DEATH IS TWO QUESTIONS, AND THEY HAVE DIFFERENT ANSWERS (JOS-156).
    ///
    /// The first is "did something of that name just die?", and the log answers it the same way in
    /// all three shapes — the parser unified them into one event naming the DEAD one — so the debuff
    /// censor runs unconditionally, on the dead name and never on the killer. (The killer is a name
    /// too, and in the owner's Plane of Sky bee fight it was the SAME name: `Bzzazzt has been slain
    /// by Bzzazzt!` is a charmed bee killing its twin.)
    ///
    /// The second is "is the ENTITY behind that name retired?", which is about identity and is the
    /// only place the pet bindings get a vote. That is what used to swallow the first question
    /// whole: a death naming the charmed pet went into the conservative never-censor-a-live-pet
    /// branch and nothing at all happened — not even to the slow on the corpse.
    fn on_death(&mut self, ev: &Event, core: &mut BuffsCore) {
        let name = ev.str("name").unwrap_or_default();
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

    /// Whether this death retires the ENTITY (its identity + every buff on it), not just its
    /// debuffs.
    ///
    /// `charmedPetDiesOnDeathLine` answers FALSE unconditionally over there — a death line naming
    /// the live charmed pet is ambiguous between the pet and a twin of its name, and the model
    /// refuses to retire an entity it may still be holding. Written out here rather than folded
    /// away, so the ruling stays visible.
    fn death_retires_entity(&self, ev: &Event, key: &str) -> bool {
        let killer_is_you =
            ev.bool("bySelf") || id_key(ev.str("killer").unwrap_or_default()) == "you";
        if self.pets.summoned_key.as_deref() == Some(key) {
            return !killer_is_you;
        }
        if self.pets.charmed_key.as_deref() == Some(key) {
            return false;
        }
        // A death naming the broken-charm entity: the ex-pet is now a hostile mob you are likely
        // killing, so THIS death genuinely retires it — censoring its buffs so the next charm of
        // that name binds a fresh entity. Charm no longer protects it, because the twin ambiguity
        // that made us keep a LIVE charmed pet does not apply once the charm has broken.
        self.pets.broken_charm_key.as_deref() == Some(key)
    }

    /// THE ACTIVE-BUFF PULL SEAM (JOS-487) — every live instance, oldest first, typed.
    ///
    /// The half of the timer-row projection that lives in this module, and the same seam
    /// `build_state` reads so the bars and the Buffs tab can never disagree about what is running.
    /// The ORDER is `started_ts` because that is the order `build_state` publishes them in, and the
    /// projection's own sort runs on top of it — a stable sort over a stable input is what makes
    /// two rows that compare equal keep one order between two serve passes.
    #[must_use]
    pub fn active_buffs(&self) -> Vec<ActiveBuff> {
        self.active_instances()
            .into_iter()
            .map(|(_, b)| b)
            .collect()
    }

    /// The same, WITH THE INSTANCE KEY each was filed under — `<spellKey>|<entityKey>`.
    ///
    /// THE KEY IS THE MODEL'S OWN IDENTITY and that is why it is handed out rather than rebuilt:
    /// a view needs a stable row key across two serve passes, and deriving one from the projected
    /// fields would be a second identity for a thing that already has one — two answers waiting to
    /// disagree the first time a spell resolves to a different display name.
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

    /// THE CHANGE SIGNAL, and it is honest about being COARSE. This module has no revision counter:
    /// its state is mutated through a shared instance core with a dozen write paths, and threading a
    /// counter through all of them is a change to the buff system the owner has paused. So it
    /// reports the fold's own `seq`, which moves on EVERY event — it can never miss a change (the
    /// property the view layer's correctness needs) and it over-reports (the property that costs).
    /// What that costs is one re-cut of the buff and timer windows per serve beat on a busy tail,
    /// over a row set of tens; it is named here rather than hidden, and the honest fix is the
    /// counter, not a cache.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.seq
    }

    /// A NEW LOG IS ABOUT TO BE FOLDED FROM ITS FIRST BYTE (JOS-231) — `beginOverlaySource`.
    ///
    /// Mining is GAME knowledge and survives `reset()` on purpose: a spell's cast messages are the
    /// same for every character. But the counts THIS log accounts for are about to be re-stated in
    /// full, so its bucket is discarded rather than added to. `session.resetWorldFor` is the caller
    /// over there, before the scan; `engined::foldsink` is the caller here, at attach.
    pub fn begin_overlay_source(&mut self, key: &str) {
        self.mining.begin_source(key);
    }

    /// SEED ONE PERSISTED BUCKET (JOS-496 item 3). See `OverlayMining::seed` for why it is not part
    /// of construction, and [`BuffsModule::begin_overlay_source`] for the call that must follow it.
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

/// `buffApply.candidates` — `[{ name, durationMs, illusion }]`.
fn candidates_of(ev: &Event) -> Vec<Candidate> {
    let Some(list) = ev.get("candidates").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .map(|c| Candidate {
            name: c
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            duration_ms: c.get("durationMs").and_then(Value::as_i64),
            illusion: c
                .get("illusion")
                .and_then(Value::as_bool)
                .unwrap_or_default(),
        })
        .collect()
}

/// `buffWearOff.candidates` — a plain `string[]`.
fn wear_off_candidates(ev: &Event) -> Vec<String> {
    ev.get("candidates")
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

impl EqModule for BuffsModule {
    fn id(&self) -> &'static str {
        "buffs"
    }

    fn reset(&mut self) {
        self.seq = 0;
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
        // NOTE WHAT IS NOT RESET: the message-overlay mining. It is game knowledge, and
        // `beginOverlaySource` — not `reset` — is what discards a source's bucket.
    }

    /// `live` IS UNUSED HERE, and stating that is the point. Over there it is threaded onto the
    /// derived `buffExpired` so a replayed wear-off stays `live: false`; in this crate the drain
    /// re-uses the PRIMARY event's own flag for everything it delivers (`Fold::on_primary`), which
    /// is the same value arriving by a shorter route. Nothing else in the buffs model reads it.
    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        // A DERIVED `buffExpired` is our OWN synthesized event — never fold it. It exists purely for
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
            return;
        }
        if ev.kind() == "offlineGap" {
            let from_ts = ev.int("fromTs").unwrap_or(0);
            let to_ts = ev.int("toTs").unwrap_or(0);
            self.frame.close_hole();
            self.inst
                .on_offline_pause(from_ts, to_ts - from_ts, &core.stats, &self.pets);
            // A logout despawns your pet, so the bindings go even though the buffs on YOU stay. The
            // instances bound to those entities are censored by the zone line that follows the
            // login. `lastEventTs` is NOT advanced: the gap restates the Welcome's instant, which
            // the Welcome itself already recorded as a primary event.
            self.pets.clear_for_gap();
            return;
        }
        let (seq, ts) = (ev.seq(), ev.ts());
        // Record the primary event's identity so any `buffExpired` synthesized while folding it —
        // or on a later wall-clock tick, which has no event of its own — is stamped with it.
        self.cur_seq = seq;
        self.cur_ts = ts;
        // A log hole that no login ever explained: we lost the thread rather than the character
        // having left, so what was standing when it opened goes, and the pet bindings with it.
        if let Some(unexplained_before) = self.frame.observe(ev) {
            self.inst.drop_predating(unexplained_before);
            self.pets.clear_for_gap();
        }
        self.inst.drop_unconfirmed_pending(ts);
        self.inst
            .sweep_hygiene(ts, self.frame.held_before_ts(), &core.stats, &self.pets);

        // Observed-message overlay mining: feed the anchor cast + any candidate message line so the
        // miner accretes (message, spell) associations across replay AND live.
        self.mining.observe(ev);

        match ev.kind() {
            // ── the cast lifecycle + activated AA ──
            "castBegin" => self.on_cast_begin(ev, &mut core),
            "spellEmote" => self.on_spell_emote(ev),
            // `<Name> begins casting <S>.` — an anchor ONLY for a caster on the externals allowlist
            // (default: nobody). The anchors enforce that; the event is folded either way so the
            // refusal lives in one place.
            "otherCastBegin" => core.anchors.note_other_cast(
                ev.str("caster").unwrap_or_default(),
                ev.str("spell").unwrap_or_default(),
                ts,
            ),
            "castFizzle" | "castInterrupted" => {
                let spell = ev.str("spell").unwrap_or_default().to_string();
                self.inst.clear_pending_cast(&spell_key(&spell));
                core.anchors.clear_cast(&spell);
            }
            // `You activate Quick Buff.` is a SELF anchor that names no spell — a WINDOW, not a name
            // (owner amendment, 2026-08-09). It applies many spells at once with no cast line of
            // their own, so a rule that demanded one per spell would refuse the player's own buffs.
            "aaActivate" => {
                if id_key(ev.str("name").unwrap_or_default()) == QUICK_BUFF {
                    core.anchors.note_quick_buff(ts);
                }
            }
            "aaSpend" => {
                if self.permanent_illusion_owned_ts.is_none()
                    && id_key(ev.str("ability").unwrap_or_default()) == PERMANENT_ILLUSION
                {
                    self.permanent_illusion_owned_ts = Some(ts);
                }
            }
            // ── buff application / expiry ──
            "buffApply" => self.on_buff_apply(ev, &mut core),
            // The wear-off emote prints to the buff HOLDER, so it clears the SELF instance. MANY
            // spells share one wear-off message, so it is resolved against the ACTIVE self set.
            "buffWearOff" => {
                let cands = wear_off_candidates(ev);
                self.inst
                    .remove_shared_wear_off(&cands, SELF_KEY, ts, &mut core.stats, &self.pets);
            }
            // `Your illusion fades.` — only one illusion is ever active on self, so this removes
            // whichever illusion self buff is active. No spell name needed: the line is 27-way
            // ambiguous by design.
            "illusionFade" => self.inst.clear_self_illusion(&core.stats),
            "heal" => self.on_heal(ev, &mut core),
            "buffFade" => self.on_buff_fade(ev, &mut core),
            "playerDeath" => self.inst.on_player_death(&core.stats, &self.pets),
            // ── entity lifecycle (the who/what) ──
            "charm" => self.on_charm(ev),
            "petClaim" => self.on_pet_claim(ev),
            "uncharm" => self.on_uncharm(ev),
            "cc" => {
                let mob = ev.str("mob").unwrap_or_default().to_string();
                self.pets.pet_target_key = Some(id_key(&mob));
                self.pets.pet_target_display = Some(mob);
            }
            "death" => self.on_death(ev, &mut core),
            "zone" => self.inst.on_zone(&core.stats, &mut self.pets),
            _ => {}
        }
        drop(core);
        self.flush_expiries(seq, ts);
    }

    /// THE WALL-CLOCK HEARTBEAT — `buffs.ts onTick`, verbatim, and the biggest thing a live tick
    /// does anywhere in the fold (owner ruling 22, JOS-481).
    ///
    /// TWO CALLS, THE SAME TWO `on_event` MAKES, with the wall clock where the log's clock goes:
    /// a cast nothing confirmed inside the landing window is dropped, and the hygiene sweep retires
    /// every active past its per-spell cap. That second one is why a live engine that never ticked
    /// served twelve buffs for a log whose last line was days ago while the app served three.
    ///
    /// IT NO LONGER RULES ON AN OPEN HOLE (JOS-262), and the omission is the ported behaviour rather
    /// than a simplification: a log hole is a question about the LOG, and only the log's own next
    /// line can answer it. What the tick does is AGE the model, and the sweep still honours whatever
    /// `held_before_ts` an open absence is protecting.
    ///
    /// THE BORROW IS IMMUTABLE, unlike `on_event`'s: the sweep reads the learner's durations and
    /// writes none, so nothing here needs the core's mutable half. And the expiries it resolves are
    /// flushed through the same door a folded event's are, stamped with the LAST EVENT's identity —
    /// see `cur_seq`/`cur_ts`.
    fn on_tick(&mut self, now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        let core_rc = Rc::clone(&self.core);
        let core = core_rc.borrow();
        self.inst.drop_unconfirmed_pending(now_ms);
        self.inst
            .sweep_hygiene(now_ms, self.frame.held_before_ts(), &core.stats, &self.pets);
        drop(core);
        self.flush_expiries(self.cur_seq, self.cur_ts);
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        let core = self.core.borrow();
        json!({ "seq": self.seq, "state": self.build_state(&core.stats) })
    }

    fn take_derived(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.derived)
    }

    fn as_defines(&mut self) -> Option<&mut dyn crate::Defines> {
        Some(self)
    }

    /// THE VIEW PULL SEAM (JOS-487). See `EqModule::as_buffs`.
    fn as_buffs(&self) -> Option<&BuffsModule> {
        Some(self)
    }

    /// THE PERSISTED-OVERLAY WRITE SEAM (JOS-496 item 3). See `EqModule::as_buffs_mut`.
    fn as_buffs_mut(&mut self) -> Option<&mut BuffsModule> {
        Some(self)
    }
}

impl crate::Defines for BuffsModule {
    fn family(&self) -> &'static str {
        "buffTrust"
    }

    /// `buffsModule.setTrust(next)` — the externals allowlist, replaced whole.
    ///
    /// IT LANDS ON THE SHARED CORE and therefore on BOTH modules at once, which is the whole of
    /// JOS-140 ruling 1: the cast anchors exist once, so the buff bar and the crowd-control bar
    /// cannot end up with two ideas of whose spell just landed. `buffs` is the module that answers
    /// for the family because it is the one that owns the core's construction; `buffTimers` clones
    /// the same handle and needs no define of its own.
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
