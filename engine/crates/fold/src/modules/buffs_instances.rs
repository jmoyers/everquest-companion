//! `src/main/modules/buffsInstances.ts` — the buff-INSTANCE store.
//!
//! A buff INSTANCE is a pair (spell LINE, targetEntity) keyed by (spellKey, entityKey). This file
//! owns the three live collections — the single pending cast, the landed-and-open casts awaiting
//! their fade, and the currently-active instances — plus every mutation of them: landing, fade
//! pairing (the duration sample), the CENSORING paths (death / zone / log hole / hygiene / entity
//! retirement) and the offline PAUSE, which is not a censor at all but the one place a live clock is
//! rewound.
//!
//! It knows nothing about log events: the module above translates events into these calls.
//!
//! ── THE TWO MAPS ARE `JsMap`s, AND THAT IS LOAD-BEARING ────────────────────────────────────────
//!
//! `active`'s ITERATION ORDER IS PUBLISHED, twice over. `remove_shared_wear_off` collects the
//! matching candidates in map order and closes them in that order, which decides the order of the
//! duration samples pushed AND the order of the derived `buffExpired` events handed back to the bus;
//! `clear_self_illusion` emits in map order for the same reason. A JS `Map` iterates in insertion
//! order, so a `HashMap` here would randomize a sequence the golden pins. (The SNAPSHOT sorts by
//! `startedTs`, so the published array is not what makes this matter — the derived stream is.)
//!
//! ── WHAT THE STORE DOES NOT OWN ────────────────────────────────────────────────────────────────
//!
//! `SpellStats` and `PetEntities` are handed in on every call rather than held, because the crowd-
//! control half shares the stats object and Rust will not let two registry modules hold a mutable
//! reference to one. The TS holds them as fields; the difference is spelling, and the borrow is
//! taken once at the top of the module's `on_event` and passed down.
//!
//! A RESOLVED expiry is reported back through `derived`, a queue the caller drains — the TS's
//! `onExpired` callback, which the module stamps and emits.

use crate::jsmap::JsMap;
use crate::modules::buff_rounds::HoldGroup;
use crate::modules::buffs_entities::PetEntities;
use crate::modules::buffs_instance_rules::{
    death_bound_span, death_censors_active, death_censors_open, hygiene_cap, landing_is_permanent,
    open_left_behind_on_zone, reap_orphaned_open, unwitnessed_cull_cap, OpenCast, Pending,
};
use crate::modules::buffs_shapes::{
    instance_entity_key, instance_key, instance_spell_key, spell_key, BuffClass, Disposition,
    DurationSample, LAND_TIMEOUT_MS, MAX_SAMPLE_MS, SELF_CASTER, SELF_KEY,
};
use crate::modules::buffs_stats::SpellStats;
use crate::modules::buffs_view::{build_active, ActiveBuff, ActiveSpec};
use eqlog::names::id_key;

/// Everything a LANDING states about itself.
pub struct LandingSpec {
    pub target: String,
    pub ts: i64,
    pub illusion: bool,
    pub duration_ms: Option<i64>,
    /// 'self' or an allowlisted external — the learner's second key (ruling 4).
    pub caster: Option<String>,
    /// The spell LINE key this instance is identified by, when it differs from what the row is
    /// NAMED. A family row is named for every candidate and keyed on one of them.
    pub line_key: Option<String>,
    /// The RANKED text the cast line spelled, when a named anchor resolved this landing and it is
    /// not simply the spell's own name. DISPLAY ONLY.
    pub cast_name: Option<String>,
    /// The spells this landing sentence could be, when it is a FAMILY the anchor could not narrow.
    /// Present ⇒ the row shows the ~ chip and mints nothing.
    pub candidates: Option<Vec<String>>,
    pub permanent_illusion_owned_ts: Option<i64>,
}

/// A RESOLVED expiry the module is to synthesize a `buffExpired` for.
pub struct Expiry {
    pub spell: String,
    pub target: String,
}

#[derive(Default)]
pub struct BuffInstances {
    /// The single cast currently in flight, or none.
    pub pending: Option<Pending>,
    /// Landed casts awaiting their fade, keyed by INSTANCE key.
    pub open: JsMap<OpenCast>,
    /// Currently-active buff instances, keyed by INSTANCE key.
    pub active: JsMap<ActiveBuff>,
    /// Resolved expiries produced while folding the current event, in emission order.
    pub expired: Vec<Expiry>,
}

impl BuffInstances {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.pending = None;
        self.open.clear();
        self.active.clear();
        self.expired.clear();
    }

    fn expire(&mut self, spell: String, target: String) {
        self.expired.push(Expiry { spell, target });
    }

    /// True when any active instance is of this spell key (the ambiguous-apply tiebreak).
    pub fn has_active_spell(&self, key: &str) -> bool {
        self.active
            .iter()
            .any(|(ik, _)| instance_spell_key(ik) == key)
    }

    /// ILLUSION EXCLUSIVITY (Task #36, the user's rule): only ONE illusion can be active on a given
    /// entity at a time. Removes every illusion-flagged active + open instance bound to `entity_key`
    /// EXCEPT the one being applied now. Applies to self AND pet.
    fn clear_illusions_on(&mut self, entity_key: &str, keep_key: &str, stats: &SpellStats) {
        let doomed: Vec<String> = self
            .active
            .iter()
            .map(|(ik, _)| ik.to_string())
            .filter(|ik| {
                ik != keep_key
                    && instance_entity_key(ik) == entity_key
                    && stats.is_illusion(instance_spell_key(ik))
            })
            .collect();
        for ik in doomed {
            self.active.remove(&ik);
            self.open.remove(&ik);
        }
    }

    /// Remove the (single) illusion-flagged SELF active — the `Your illusion fades.` handler.
    ///
    /// The raw line names no spell, but the model has RESOLVED it to the one active self illusion,
    /// so the derived event carries that resolved spell and an alert pinned to
    /// `Illusion: Wood Elf` can fire on the player-side click-off.
    pub fn clear_self_illusion(&mut self, stats: &SpellStats) {
        let doomed: Vec<(String, String)> = self
            .active
            .iter()
            .filter(|(ik, a)| a.is_self && stats.is_illusion(instance_spell_key(ik)))
            .map(|(ik, a)| (ik.to_string(), a.spell.clone()))
            .collect();
        for (ik, spell) in doomed {
            self.active.remove(&ik);
            self.open.remove(&ik);
            self.expire(spell, SELF_KEY.to_string());
        }
    }

    /// A cast nothing confirmed within the landing window never landed, so its record is DROPPED
    /// (JOS-118). It opens nothing on the way out.
    pub fn drop_unconfirmed_pending(&mut self, now: i64) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| now - p.began_ts >= LAND_TIMEOUT_MS)
        {
            self.pending = None;
        }
    }

    /// Stage a new cast in flight. A CAST OPENS NOTHING — no instance, no open cast, no row
    /// (JOS-118, owner: "we should drop provisional all together").
    ///
    /// This used to show the cast OPTIMISTICALLY the instant it began: a provisional row bound to a
    /// GUESS at the target, retracted only by a fizzle or an interrupt. A RESIST is neither, so a
    /// resisted debuff left a bar on screen naming a mob the log never said it landed on — and
    /// fifteen seconds later the guess was PROMOTED to a solid row plus an open cast that could pair
    /// with an unrelated later fade into a duration sample. What went is the DISPLAY, not the
    /// attribution machinery: the pending record is what the landing side hangs off, and the anchor
    /// lives beside it in `buff_anchors.rs`.
    pub fn begin_cast(&mut self, key: String, ts: i64) {
        self.pending = Some(Pending {
            key,
            began_ts: ts,
            emote_subject_key: None,
        });
    }

    /// A fizzle/interrupt of `key` clears the pending cast. It never opened anything to retract.
    pub fn clear_pending_cast(&mut self, key: &str) {
        if self.pending.as_ref().is_some_and(|p| p.key == key) {
            self.pending = None;
        }
    }

    /// Infer the target disposition of a cast at LAND time from the current entity state, a LEARNED
    /// landing emote, and the spell's class. A learned self-emote proves a SELF cast even while a
    /// pet is live.
    fn infer_cast_disposition(
        &self,
        key: &str,
        emote_subject_key: Option<&str>,
        stats: &SpellStats,
        pets: &PetEntities,
    ) -> Disposition {
        if emote_subject_key == Some(SELF_KEY) {
            return Disposition::Zelf;
        }
        if let Some(sub) = emote_subject_key.filter(|s| *s != SELF_KEY) {
            if pets.charmed_key.as_deref() == Some(sub) {
                return Disposition::Charmed;
            }
            if pets.summoned_key.as_deref() == Some(sub) {
                return Disposition::Summoned;
            }
            return if pets.summoned_key.is_some() {
                Disposition::Summoned
            } else {
                Disposition::Charmed
            };
        }
        if stats.class_of(key) == BuffClass::Debuff {
            return Disposition::Hostile;
        }
        if pets.charmed_key.is_some() {
            return Disposition::Charmed;
        }
        if pets.summoned_key.is_some() {
            return Disposition::Summoned;
        }
        Disposition::Zelf
    }

    /// Apply a buff from an EXACT chat MESSAGE match. `target` is 'self' for a cast-on-you/self-heal
    /// line, else the named target — bound to THAT entity's key.
    ///
    /// A REPEAT LANDING IS A ROUND, NOT AN OVERWRITE (JOS-140): it goes to the instance's
    /// `HoldGroup`, which decides whether it refreshes the newest landing or opens another.
    pub fn apply_message_buff(
        &mut self,
        spell: &str,
        spec: &LandingSpec,
        stats: &mut SpellStats,
        pets: &mut PetEntities,
    ) {
        let key = spec.line_key.clone().unwrap_or_else(|| spell_key(spell));
        // WHAT A LANDING MUST STATE TO OPEN A ROW — a duration, an illusion flag, or (JOS-215) the
        // spell DB's own word that it never expires. The third arm is the reported defect: a
        // permanent buff has no duration BECAUSE it is permanent, so the first two arms refused 57
        // of the 62 permanent spells outright — they printed their landing sentence, the parser
        // emitted a perfectly good `buffApply`, and this line dropped it on the floor.
        if spec.duration_ms.is_none() && !spec.illusion && !stats.is_permanent(&key) {
            return;
        }
        // A SELF apply of a DETRIMENTAL spell is an incoming debuff a MOB cast on the player — not
        // the player's own buff. The bar shows only the player's beneficial buffs.
        let is_self = spec.target == "self";
        if is_self && stats.class_of(&key) == BuffClass::Debuff {
            return;
        }
        stats.note_ever_faded(&key);
        stats.touch_last_seen(&key, spec.ts);
        if self.pending.as_ref().is_some_and(|p| p.key == key) {
            self.pending = None;
        }

        // WHERE it binds: the entity it names, that entity's disposition, whose cast it is, and
        // whether it is PERMANENT. Also the one side effect worth naming — the target's display
        // CASING is remembered here, so the row's chip reads "Cazic-Thule" and not the key.
        let e_key = if is_self {
            SELF_KEY.to_string()
        } else {
            id_key(&spec.target)
        };
        if !is_self {
            pets.named_entity_display
                .insert(e_key.clone(), spec.target.clone());
        }
        let disp = if is_self {
            Disposition::Zelf
        } else {
            pets.disp_for_named_target(&spec.target)
        };
        let caster = spec
            .caster
            .clone()
            .unwrap_or_else(|| SELF_CASTER.to_string());
        let permanent = landing_is_permanent(
            is_self,
            stats.is_permanent(&key),
            spec.illusion,
            spec.ts,
            spec.permanent_illusion_owned_ts,
        );

        let i_key = instance_key(&key, &e_key);
        self.open_record(
            &i_key,
            spell,
            spec.cast_name.as_deref(),
            &key,
            &e_key,
            &caster,
            disp,
        );
        {
            let record = self.open.get_mut(&i_key).expect("just opened");
            // A FAMILY never mints (we do not know which spell it was), so its landings open
            // contaminated.
            record.group.land(spec.ts, spec.candidates.is_some());
        }
        // A permanent self illusion has no expiry to pair with, so it keeps no open record at all.
        if permanent {
            self.open.remove(&i_key);
        }
        let projected = {
            let record = self.open.get(&i_key);
            let (started_ts, count, record_spell, record_cast) = match record {
                Some(r) => (
                    r.group.oldest_ts(),
                    r.group.count() as i64,
                    r.spell.clone(),
                    r.cast_name.clone(),
                ),
                // The permanent branch above deleted it: report the landing instant and a count of
                // one, which is `landingSpec`'s own `at.permanent ? … : …`.
                None => (spec.ts, 1, spell.to_string(), spec.cast_name.clone()),
            };
            let spec_out = ActiveSpec {
                spell: record_spell,
                cast_name: record_cast,
                key: key.clone(),
                entity_key: e_key.clone(),
                started_ts: if permanent { spec.ts } else { started_ts },
                disp_override: Some(disp),
                caster: Some(caster.clone()),
                count: Some(if permanent { 1 } else { count }),
                candidates: spec.candidates.clone(),
                message_driven: true,
                permanent,
            };
            build_active(&spec_out, stats, pets)
        };
        self.active.insert(i_key.clone(), projected);
        // ILLUSION EXCLUSIVITY: a new illusion apply on this entity replaces any prior illusion
        // active on it (self OR pet).
        if spec.illusion {
            self.clear_illusions_on(&e_key, &i_key, stats);
        }
    }

    /// The open record this landing belongs to, created on first sight — or RECREATED when the
    /// CASTER changed, because a different caster's durations are a different learner key and
    /// pooling one cycle across the two would be the thing ruling 4 forbids.
    #[allow(clippy::too_many_arguments)]
    fn open_record(
        &mut self,
        i_key: &str,
        spell: &str,
        cast_name: Option<&str>,
        key: &str,
        e_key: &str,
        caster: &str,
        disp: Disposition,
    ) {
        if let Some(existing) = self.open.get_mut(i_key) {
            if existing.caster == caster {
                existing.spell = spell.to_string();
                // The NEWEST landing's word on what was cast, including "nothing extra" — a re-land
                // through a Quick Buff burst names no rank, and keeping the previous cast's would
                // attribute a rank to a landing that never stated one.
                existing.cast_name = cast_name.map(str::to_string);
                existing.disp = disp;
                return;
            }
        }
        // SINGLETON unless the entity is a plain HOSTILE: you, your summoned pet and your charmed
        // pet are identities this model tracks (law 4), so a re-cast on one of them is unambiguously
        // a refresh. A mob is only ever a NAME, and the world hands out that name more than once.
        self.open.insert(
            i_key.to_string(),
            OpenCast {
                spell: spell.to_string(),
                cast_name: cast_name.map(str::to_string),
                spell_key: key.to_string(),
                entity_key: e_key.to_string(),
                group: HoldGroup::new(disp != Disposition::Hostile),
                caster: caster.to_string(),
                disp,
                spanned_gap: false,
            },
        );
    }

    /// AUTHORITATIVE removal: a `msg_wears_off` proves the SELF instance expired NOW. Pairs a
    /// duration sample if the open cast exists, then clears that instance.
    fn remove_authoritative(
        &mut self,
        key: &str,
        entity_key: &str,
        ts: i64,
        stats: &mut SpellStats,
        pets: &PetEntities,
    ) {
        let i_key = instance_key(key, entity_key);
        let spell = self
            .active
            .get(&i_key)
            .map(|a| a.spell.clone())
            .or_else(|| {
                let caster = self
                    .open
                    .get(&i_key)
                    .map(|o| o.caster.clone())
                    .unwrap_or_else(|| SELF_CASTER.to_string());
                stats.sample_spell_name(key, &caster).map(str::to_string)
            })
            .unwrap_or_else(|| key.to_string());
        stats.note_ever_faded(key);
        self.record_fade(key, entity_key, &spell, ts, stats, pets);
        // The wear-off is now RESOLVED to `spell` on `entity_key`. Alerts match this reliable,
        // unambiguous kind instead of the raw ambiguous `buffWearOff`.
        self.expire(spell, pets.target_display_for(entity_key));
    }

    /// SHARED wears-off resolution (Task #45). A wears-off line whose message maps to MULTIPLE
    /// candidate spells (the haste/strength/armor families) removes whichever matching ACTIVE self
    /// buff(s) exist — resolve against the active set, do not guess a single spell:
    ///   * exactly ONE candidate active → remove it (the common case; EQ stacking keeps one member
    ///     of a family up at a time);
    ///   * MULTIPLE active → remove ALL of them (they honestly share this message);
    ///   * NONE active → no-op. A wears-off for a buff we never tracked must not create a phantom
    ///     fade sample.
    ///
    /// Removing by only the FIRST candidate — the old code — missed the actually-active buff: self
    /// Quickness/Swift never cleared, because the first candidate `Aanya's Quickening` was never the
    /// one that was up.
    pub fn remove_shared_wear_off(
        &mut self,
        candidate_names: &[String],
        entity_key: &str,
        ts: i64,
        stats: &mut SpellStats,
        pets: &PetEntities,
    ) {
        let cands: Vec<String> = candidate_names.iter().map(|n| spell_key(n)).collect();
        let mut matched: Vec<String> = Vec::new();
        for (ik, _) in self.active.iter() {
            if instance_entity_key(ik) != entity_key {
                continue;
            }
            let k = instance_spell_key(ik);
            if cands.iter().any(|c| c == k) && !matched.iter().any(|m| m == k) {
                matched.push(k.to_string());
            }
        }
        for k in matched {
            self.remove_authoritative(&k, entity_key, ts, stats, pets);
        }
    }

    /// Pair a fade with its own open landed instance (a duration sample) and clear the active.
    ///
    /// A SAMPLE IS MINTED ONLY FROM AN EXACT (spell, entity, CASTER) CHAIN: our own cast (or an
    /// allowlisted external's), landing on THAT entity, wearing off THAT entity. Only ONE caster's
    /// modifiers shape a duration anyone is entitled to learn from. A fade that cannot be matched to
    /// its own exact instance mints NOTHING.
    ///
    /// WHICH LANDING DOES IT CLOSE? The OLDEST (ruling 7). The wear-off names the mob but not which
    /// mob of that name, so under a fixed duration the oldest landing is the maximum-likelihood one
    /// to have just ended — and pairing newest-first instead produced, on the reporter's own bytes,
    /// spans from 42 s to 119 s out of the same lines. The row survives with one fewer on its count
    /// chip; only an empty group clears it.
    ///
    /// CLOSURE stays honest in the other direction too: the fade proves THIS entity's copy is gone,
    /// so a still-live slow on mob A survives mob B's wear-off.
    pub fn record_fade(
        &mut self,
        key: &str,
        entity_key: &str,
        spell: &str,
        fade_ts: i64,
        stats: &mut SpellStats,
        pets: &PetEntities,
    ) {
        stats.touch_last_seen(key, fade_ts);
        let i_key = instance_key(key, entity_key);
        if self.open.contains_key(&i_key) {
            let (sample, caster, spanned, empty) = {
                let open = self.open.get_mut(&i_key).expect("present");
                let closed = open.group.close_oldest(fade_ts);
                (
                    closed.and_then(|c| c.sample_ms),
                    open.caster.clone(),
                    open.spanned_gap,
                    open.group.is_empty(),
                )
            };
            // CENSOR a sample whose land→fade window crossed an offline gap (world-model law 5).
            // The fade itself is still authoritative — the instance clears exactly as it always did
            // — but the SPAN is not a duration: it contains an absence whose length we know only to
            // within the reconnect window, and contributing it would poison the recency-weighted MAX
            // with a value guaranteed too large.
            if !spanned {
                if let Some(ms) = sample.filter(|&s| s > 0 && s <= MAX_SAMPLE_MS) {
                    // NEVER CENSORED on this path (JOS-180): the wake line is a CROWD-CONTROL
                    // annotation, and there is no sentence in the log that says a beneficial buff or
                    // a debuff ended early.
                    self.add_sample(
                        key,
                        &caster,
                        spell,
                        DurationSample {
                            ms,
                            ts: fade_ts,
                            censored: false,
                            death_bound: false,
                        },
                        stats,
                        pets,
                    );
                }
            }
            if empty {
                self.open.remove(&i_key);
            } else {
                self.restat(&i_key, stats, pets);
                return;
            }
        }
        self.active.remove(&i_key);
    }

    /// Re-project one live instance after its group changed (count / oldest clock moved).
    fn restat(&mut self, i_key: &str, stats: &SpellStats, pets: &PetEntities) {
        let Some(prev) = self.active.get(i_key) else {
            return;
        };
        let Some(open) = self.open.get(i_key) else {
            return;
        };
        let spec = reproject_spec(
            prev,
            &open.spell_key,
            &open.entity_key,
            open.group.oldest_ts(),
            &open.caster,
            open.group.count() as i64,
        );
        let built = build_active(&spec, stats, pets);
        self.active.insert(i_key.to_string(), built);
    }

    fn add_sample(
        &mut self,
        key: &str,
        caster: &str,
        spell: &str,
        sample: DurationSample,
        stats: &mut SpellStats,
        pets: &PetEntities,
    ) {
        stats.push_sample(key, caster, spell, sample);
        // Re-stat every live instance of this spell (they share the per-(line, caster) stats).
        let targets: Vec<String> = self
            .active
            .iter()
            .filter(|(ik, _)| instance_spell_key(ik) == key)
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in targets {
            let count = self
                .open
                .get(&ik)
                .map(|o| o.group.count() as i64)
                .or_else(|| self.active.get(&ik).and_then(|a| a.count))
                .unwrap_or(1);
            let a = self.active.get(&ik).expect("named above");
            let spec = reproject_spec(
                a,
                key,
                instance_entity_key(&ik),
                a.started_ts,
                a.caster.as_deref().unwrap_or(SELF_CASTER),
                count,
            );
            let built = build_active(&spec, stats, pets);
            self.active.insert(ik, built);
        }
    }

    /// OFFLINE GAP — the buff-timer PAUSE, and the asymmetry that is the whole of JOS-134.
    ///
    /// YOUR BUFFS PAUSE. Buff timers do NOT run while the character is out of the world; the game
    /// saves each buff's REMAINING duration and resumes it at login. So a beneficial instance that
    /// survives a gap has its clock shifted forward by the absence, or every countdown reads as
    /// long-expired and the hygiene sweep retires a buff that is still up.
    ///
    /// MEASURED, not assumed. Swift Like the Wind (DB 16 min): landed Fri Jul 31 00:51:59, camped
    /// 01:05:43, logged in 14:49:15, wore off 14:50:28. Wall-clock elapsed 13h58m29s; measured
    /// absence 13h43m08s; the difference is 15m21s, which matches this character's observed ONLINE
    /// duration for that spell (two clean same-evening pairs, 15m13s and 15m09s) to within the
    /// camp's own fuzz. If timers RAN while offline the buff would have expired unobserved around
    /// 01:08 and that wear-off line could never have printed at all.
    ///
    /// DEBUFFS DO NOT PAUSE, and that is deliberate (owner's design, 2026-08-09). What EQ pauses is
    /// your CHARACTER; the world it stands in keeps running. A slow you landed on a mob is a timer in
    /// the world, not a timer on you, so it keeps burning down while you are gone and its clock is
    /// left exactly where it was.
    ///
    /// `from_ts` is the last instant the character is KNOWN to have been in the world, so only
    /// instances that PREDATE it are shifted: anything raised after it was raised on this side of
    /// the absence and has nothing to be compensated for.
    pub fn on_offline_pause(
        &mut self,
        from_ts: i64,
        offline_ms: i64,
        stats: &SpellStats,
        pets: &PetEntities,
    ) {
        if offline_ms <= 0 {
            return;
        }
        let keys: Vec<String> = self.open.iter().map(|(ik, _)| ik.to_string()).collect();
        for ik in keys {
            let (oldest, is_debuff) = {
                let o = self.open.get(&ik).expect("named above");
                (
                    o.group.oldest_ts(),
                    stats.class_of(&o.spell_key) == BuffClass::Debuff,
                )
            };
            if oldest > from_ts {
                continue;
            }
            let shifted = {
                let o = self.open.get_mut(&ik).expect("named above");
                // The learner is censored either way; only the CLOCK is asymmetric.
                o.spanned_gap = true;
                !is_debuff && o.group.shift_by(offline_ms, from_ts)
            };
            if shifted {
                self.restat(&ik, stats, pets);
            }
        }
        let bumped: Vec<String> = self
            .active
            .iter()
            // An active with no open record behind it (a permanent illusion) has no group to shift.
            .filter(|(ik, a)| {
                a.cls != BuffClass::Debuff && a.started_ts <= from_ts && !self.open.contains_key(ik)
            })
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in bumped {
            if let Some(a) = self.active.get_mut(&ik) {
                a.started_ts += offline_ms;
            }
        }
        // A cast in flight when the character left the world never completed — the camp (or the
        // crash) took it. Shifting it would resurrect a cast that produced no landing message.
        self.pending = None;
    }

    /// Session-gap clear: wipe live actives/opens/pending.
    pub fn clear_for_gap(&mut self) {
        self.active.clear();
        self.open.clear();
        self.pending = None;
    }

    /// Drop every instance whose clock predates `ts` — the UNEXPLAINED-hole resolution (JOS-134).
    ///
    /// A log hole that no login ever explains means we lost the thread rather than that the character
    /// left, and the old blanket wipe is still the honest answer for what was standing when it
    /// opened. It is SCOPED rather than blanket because the ruling arrives AFTER the hole did — it
    /// waits for in-world evidence, and that evidence can be a cast — and anything raised on this
    /// side of the hole is evidence from this side of it.
    pub fn drop_predating(&mut self, ts: i64) {
        let dead: Vec<String> = self
            .active
            .iter()
            .filter(|(_, a)| a.started_ts <= ts)
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.active.remove(&ik);
        }
        let dead: Vec<String> = self
            .open
            .iter()
            .filter(|(_, o)| o.group.oldest_ts() <= ts)
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.open.remove(&ik);
        }
        if self.pending.as_ref().is_some_and(|p| p.began_ts <= ts) {
            self.pending = None;
        }
    }

    /// Hygiene sweep: retire any active past its per-spell cap.
    ///
    /// `held_before_ts` is the last-known-online instant of a log hole whose explanation has not
    /// arrived yet (0 when there is none). A BUFF older than it is EXEMPT for the length of that
    /// wait: if the hole turns out to be a logout, that buff's clock is about to be rewound by the
    /// absence, and judging it against a `now` from the far side would retire — a beat before the
    /// pause lands — exactly the buff the pause exists to keep. DEBUFFS get no exemption; their
    /// clocks never stop.
    ///
    /// THE CULL TAKES THE ROW AND LEAVES THE PAIRING RECORD (JOS-156), and that half is deliberate.
    /// MEASURED before it was written: with the record deleted too, twenty consecutive real-length
    /// Shiftless Deeds IV cycles (234 s each, against a 150 s DB row) mint ZERO samples and the
    /// estimate stays pinned to the DB floor forever — because the first cycle that would teach the
    /// true duration is the first one culled, and the learner can never ratchet past DB + 60 s. It
    /// costs nothing where the ruling actually bites: when the line is never coming, nothing ever
    /// pairs with the surviving record and the LONG STOP collects it minting nothing.
    pub fn sweep_hygiene(
        &mut self,
        now: i64,
        held_before_ts: i64,
        stats: &SpellStats,
        pets: &PetEntities,
    ) {
        // CALLED ONCE PER EVENT, so its cost is paid 1.4M times on a full replay. The TS's own note
        // applies: nothing here spreads the map into a fresh array, and the loop deletes only the
        // entry it is standing on.
        let keys: Vec<String> = self.active.iter().map(|(ik, _)| ik.to_string()).collect();
        for ik in keys {
            let Some(a) = self.active.get(&ik) else {
                continue;
            };
            if a.permanent == Some(true) {
                continue;
            }
            if held_before_ts > 0 && a.cls != BuffClass::Debuff && a.started_ts <= held_before_ts {
                continue;
            }
            let db_ms = stats.db_duration_for(instance_spell_key(&ik));
            // THE LONG STOP goes first, because it is the one that means "we lost the thread" — and
            // it is the only one that takes the PAIRING RECORD with it. A MULTISET RETIRES ONE
            // LANDING AT A TIME: five mobs mezzed in one round age out one after another, and the
            // row keeps whichever landings are still inside the cap.
            let long_cap = hygiene_cap(a, db_ms);
            let elapsed = (now - a.started_ts) as f64;
            if elapsed > long_cap {
                // `now - longCap` is FRACTIONAL over there whenever the p75 statistic beat the
                // 90-minute floor, and `dropExpired` compares an integer `startedTs` against it.
                // For an integer x, `x <= r` is `x <= floor(r)` — so the floor is the exact answer
                // rather than a rounding of one.
                let cutoff = (now as f64 - long_cap).floor() as i64;
                self.retire_expired(&ik, cutoff, stats, pets);
                continue;
            }
            if elapsed > unwitnessed_cull_cap(a) {
                self.active.remove(&ik);
            }
        }
        // …AND THE RECORDS THE CULL ABOVE LEFT BEHIND (JOS-203). The loop can only ever reach a
        // record through its active row, so before this the open cast of a culled row had no reaper
        // at all.
        reap_orphaned_open(&mut self.open, &self.active, stats, now);
    }

    /// The long-stop path: shed the landings older than `cutoff_ts`, and drop the record when empty.
    fn retire_expired(&mut self, ik: &str, cutoff_ts: i64, stats: &SpellStats, pets: &PetEntities) {
        if self.open.contains_key(ik) {
            let empty = {
                let open = self.open.get_mut(ik).expect("present");
                open.group.drop_expired(cutoff_ts);
                open.group.is_empty()
            };
            if !empty {
                self.restat(ik, stats, pets);
                return;
            }
            self.open.remove(ik);
        }
        self.active.remove(ik);
    }

    /// `playerDeath` strips SELF buffs: censor open SELF casts + clear their actives.
    pub fn on_player_death(&mut self, stats: &SpellStats, pets: &PetEntities) {
        let dead: Vec<String> = self
            .open
            .iter()
            .filter(|(_, o)| o.entity_key == SELF_KEY)
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.open.remove(&ik);
        }
        let dead: Vec<String> = self
            .active
            .iter()
            .filter(|(_, a)| a.is_self)
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.active.remove(&ik);
        }
        if let Some(p) = &self.pending {
            // A pending self cast is abandoned (death interrupts it). A debuff/pet cast survives.
            let disp =
                self.infer_cast_disposition(&p.key, p.emote_subject_key.as_deref(), stats, pets);
            if disp == Disposition::Zelf {
                self.pending = None;
            }
        }
    }

    /// A MOB OF THIS NAME DIED — the death censor, and since JOS-156 the ONE path every death SHAPE
    /// reaches.
    ///
    /// IT CLOSES ONE LANDING, NOT THE ROW (ruling 7). A group is a multiset of same-named mobs we
    /// believe are holding the spell, and one death is evidence about ONE of them. The OLDEST is
    /// closed for the identical reason a wear-off closes the oldest. This used to delete the whole
    /// row, so killing one of four slowed mobs cleared all four.
    ///
    /// AND IT MINTS NO CYCLE. A land-to-death span is not a duration — the spell was cut short by
    /// the corpse, not observed running out. `contaminate_all` is the separate half: it is about the
    /// landings that SURVIVE the close, which are now landings of a group that has lost track of
    /// which mob is which.
    ///
    /// WHAT IT DOES MINT, SINCE JOS-379, IS A LOWER BOUND — and the distinction above is exactly why
    /// it may. The span is a PROOF THE DURATION IS AT LEAST THIS LONG, because no wear-off ever
    /// printed between the landing and the corpse; a landing still in this group has by construction
    /// not been closed by one. Every rail that keeps "at least" honest is on `death_bound_span`.
    pub fn on_entity_death(
        &mut self,
        entity_key: &str,
        ts: i64,
        stats: &mut SpellStats,
        pets: &PetEntities,
    ) {
        let keys: Vec<String> = self.open.iter().map(|(ik, _)| ik.to_string()).collect();
        for ik in keys {
            self.censor_open_on_death(&ik, entity_key, ts, stats, pets);
        }
        let dead: Vec<String> = self
            .active
            .iter()
            .filter(|(ik, a)| {
                !self.open.contains_key(ik)
                    && death_censors_active(a, instance_entity_key(ik), entity_key)
            })
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.active.remove(&ik);
        }
    }

    /// One open record against one corpse: MEASURE it (the lower bound), then close its oldest
    /// landing and contaminate what is left.
    ///
    /// THE BOUND IS READ BEFORE THE CLOSE, because the close is what CONSUMES the landing it
    /// measures, and MINTED before it too: `add_sample` only re-projects rows that already exist, so
    /// a row this death is about to delete is re-read and then deleted, which costs nothing and
    /// keeps the mint beside the reasoning that earned it.
    fn censor_open_on_death(
        &mut self,
        ik: &str,
        entity_key: &str,
        ts: i64,
        stats: &mut SpellStats,
        pets: &PetEntities,
    ) {
        let Some(o) = self.open.get(ik) else {
            return;
        };
        let is_debuff = stats.class_of(&o.spell_key) == BuffClass::Debuff;
        if !death_censors_open(o, entity_key, is_debuff) {
            return;
        }
        // NEVER off the `unknown-hostile` bucket `death_censors_open` also sweeps: that row's target
        // is an INFERENCE, and a span measured against a mob the log never named is not evidence.
        let ms = if is_debuff && o.entity_key == entity_key {
            death_bound_span(o, entity_key, ts, stats)
        } else {
            None
        };
        let (spell_key_of, caster, spell) =
            (o.spell_key.clone(), o.caster.clone(), o.spell.clone());
        if let Some(ms) = ms {
            self.add_sample(
                &spell_key_of,
                &caster,
                &spell,
                DurationSample {
                    ms,
                    ts,
                    censored: false,
                    death_bound: true,
                },
                stats,
                pets,
            );
        }
        let empty = {
            let o = self.open.get_mut(ik).expect("present");
            o.group.contaminate_all();
            o.group.close_oldest(ts);
            o.group.is_empty()
        };
        if !empty {
            self.restat(ik, stats, pets);
        } else if self.open.remove(ik) {
            self.active.remove(ik);
        }
    }

    /// Retire an ENTITY — NO pet-specific branches. Censors every open cast + active instance bound
    /// to `entity_key`, buff and debuff alike. Used on uncharm / summoned-pet death / broken-charm
    /// death / zone-left-behind / single-pet succession; the pet is just the entity currently
    /// claimed, and buffs on other players are censored the same way.
    pub fn retire_entity(&mut self, entity_key: &str, pets: &mut PetEntities) {
        let dead: Vec<String> = self
            .open
            .iter()
            .filter(|(_, o)| o.entity_key == entity_key)
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.open.remove(&ik);
        }
        let dead: Vec<String> = self
            .active
            .iter()
            .filter(|(ik, _)| instance_entity_key(ik) == entity_key)
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.active.remove(&ik);
        }
        pets.retire_slots(entity_key);
    }

    /// ZONE: the player keeps self buffs; a SUMMONED pet follows and keeps its buffs; a CHARMED pet
    /// is LEFT BEHIND; hostile mobs are left behind.
    pub fn on_zone(&mut self, stats: &SpellStats, pets: &mut PetEntities) {
        let dead: Vec<String> = self
            .open
            .iter()
            .filter(|(_, o)| open_left_behind_on_zone(o))
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.open.remove(&ik);
        }
        let dead: Vec<String> = self
            .active
            .iter()
            .filter(|(_, a)| {
                a.cls == BuffClass::Debuff
                    || a.disposition == Some(Disposition::Charmed)
                    || a.disposition == Some(Disposition::Hostile)
            })
            .map(|(ik, _)| ik.to_string())
            .collect();
        for ik in dead {
            self.active.remove(&ik);
        }
        pets.clear_on_zone();
        if let Some(p) = &self.pending {
            let disp =
                self.infer_cast_disposition(&p.key, p.emote_subject_key.as_deref(), stats, pets);
            if disp == Disposition::Charmed || disp == Disposition::Hostile {
                self.pending = None;
            }
        }
    }
}

/// THE SPEC FOR RE-PROJECTING A ROW THAT IS ALREADY LIVE: everything the instance IS, carried
/// forward from the row being replaced, with only the coordinates a re-projection restates supplied
/// by the caller.
///
/// IT EXISTS BECAUSE THE STORE RE-PROJECTS FROM TWO PLACES THAT MUST NOT DRIFT — `restat` (the hold
/// group moved) and `add_sample` (a fresh duration changed what every live instance of that line
/// counts down from). Both used to hand-copy the same seven fields, and a display fact added to one
/// and not the other is precisely the shape of the defect JOS-238 fixed one level up: a row that says
/// a different thing depending on which internal event last touched it.
fn reproject_spec(
    a: &ActiveBuff,
    key: &str,
    entity_key: &str,
    started_ts: i64,
    caster: &str,
    count: i64,
) -> ActiveSpec {
    ActiveSpec {
        spell: a.spell.clone(),
        cast_name: a.cast_name.clone(),
        key: key.to_string(),
        entity_key: entity_key.to_string(),
        started_ts,
        disp_override: a.disposition,
        caster: Some(caster.to_string()),
        count: Some(count),
        candidates: a.candidates.clone(),
        message_driven: a.message_driven == Some(true),
        permanent: a.permanent == Some(true),
    }
}
