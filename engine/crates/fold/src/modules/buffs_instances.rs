//! The buff-INSTANCE store: the single pending cast, the landed-and-open casts awaiting their fade,
//! and the currently-active instances — plus every mutation of them. Landing, fade pairing (the
//! duration sample), the censoring paths (death / zone / log hole / hygiene / entity retirement),
//! and the offline PAUSE, which is not a censor at all but the one place a live clock is rewound.
//!
//! It knows nothing about log events: the module above translates events into these calls.
//!
//! `active` is a `JsMap` because its ITERATION ORDER IS PUBLISHED. `remove_shared_wear_off` closes
//! the matching candidates in map order, which decides the order of the duration samples pushed and
//! of the derived expiries handed back to the bus; `clear_self_illusion` emits in map order for the
//! same reason. A hash map here would randomize a sequence the goldens pin.
//!
//! `SpellStats` and `PetEntities` are handed in on every call rather than held, because the
//! crowd-control half shares the stats object; the borrow is taken once at the top of the module's
//! `on_event` and passed down. A resolved expiry is reported back through `expired`, a queue the
//! caller drains.

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
    /// 'self' or an allowlisted external — the learner's second key.
    pub caster: Option<String>,
    /// The spell LINE key this instance is identified by, when it differs from what the row is
    /// named. A family row is named for every candidate and keyed on one of them.
    pub line_key: Option<String>,
    /// The ranked text the cast line spelled, when it is not simply the spell's own name. Display
    /// only.
    pub cast_name: Option<String>,
    /// The spells this landing sentence could be, when it is a FAMILY the anchor could not narrow.
    /// Present means the row shows the ~ chip and mints nothing.
    pub candidates: Option<Vec<String>>,
    pub permanent_illusion_owned_ts: Option<i64>,
}

/// A resolved expiry the module is to synthesize a `buffExpired` for.
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

    /// Illusion exclusivity: only ONE illusion can be active on an entity at a time. Removes every
    /// illusion-flagged active and open instance bound to `entity_key` except the one being applied
    /// now. Applies to self and pet alike.
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

    /// Remove the single illusion-flagged SELF active — the `Your illusion fades.` handler.
    ///
    /// The raw line names no spell, but the model has resolved it to the one active self illusion,
    /// so the derived event carries that resolved spell and an alert pinned to a named illusion can
    /// fire on the player-side click-off.
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

    /// A cast nothing confirmed within the landing window never landed, so its record is dropped.
    /// It opens nothing on the way out.
    pub fn drop_unconfirmed_pending(&mut self, now: i64) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| now - p.began_ts >= LAND_TIMEOUT_MS)
        {
            self.pending = None;
        }
    }

    /// Stage a new cast in flight. A cast opens nothing — no instance, no open cast, no row —
    /// because a provisional row would be bound to a GUESS at the target and a resist retracts
    /// nothing. What the pending record is for is the landing side, which hangs off it; the anchor
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

    /// Apply a buff from an exact chat-message match. `target` is 'self' for a cast-on-you or
    /// self-heal line, else the named target — bound to THAT entity's key.
    ///
    /// A repeat landing is a ROUND, not an overwrite: it goes to the instance's `HoldGroup`, which
    /// decides whether it refreshes the newest landing or opens another.
    pub fn apply_message_buff(
        &mut self,
        spell: &str,
        spec: &LandingSpec,
        stats: &mut SpellStats,
        pets: &mut PetEntities,
    ) {
        let key = spec.line_key.clone().unwrap_or_else(|| spell_key(spell));
        // What a landing must state to open a row: a duration, an illusion flag, or the spell DB's
        // own word that it never expires. The third arm is not redundant — a permanent buff has no
        // duration BECAUSE it is permanent, so the first two would refuse nearly all of them.
        if spec.duration_ms.is_none() && !spec.illusion && !stats.is_permanent(&key) {
            return;
        }
        // A self apply of a DETRIMENTAL spell is an incoming debuff a mob cast on the player, not
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

        // Where it binds: the entity it names, that entity's disposition, whose cast it is, and
        // whether it is permanent. The one side effect worth naming is that the target's display
        // CASING is remembered here, so the row's chip reads the name and not the key.
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
        // The rank this landing's own cast line named, recorded before the row is projected so an
        // upgraded spell draws its scaled floor on FIRST sight rather than after a sample. An absent
        // cast name carries no numeral and the note is a no-op.
        stats.note_cast_tier(&key, &caster, spec.cast_name.as_deref().unwrap_or_default());
        {
            let record = self.open.get_mut(&i_key).expect("just opened");
            // A family never mints — we do not know which spell it was — so its landings open
            // contaminated.
            record.group.land(spec.ts, spec.candidates.is_some());
        }
        // A permanent self illusion has no expiry to pair with, so it keeps no open record at all.
        if permanent {
            self.open.remove(&i_key);
        }
        let projected = {
            let (started_ts, count, record_spell, record_cast) = match self.open.get(&i_key) {
                Some(r) => (
                    r.group.oldest_ts(),
                    r.group.count() as i64,
                    r.spell.clone(),
                    r.cast_name.clone(),
                ),
                // The permanent branch above deleted it: report the landing instant and a count of
                // one.
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
        // A new illusion apply on this entity replaces any prior illusion active on it.
        if spec.illusion {
            self.clear_illusions_on(&e_key, &i_key, stats);
        }
    }

    /// The open record this landing belongs to, created on first sight — or recreated when the
    /// CASTER changed, because a different caster's durations are a different learner key.
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
                // The NEWEST landing's word on what was cast, including "nothing extra": a re-land
                // through a Quick Buff burst names no rank, and keeping the previous cast's would
                // attribute a rank to a landing that never stated one.
                existing.cast_name = cast_name.map(str::to_string);
                existing.disp = disp;
                return;
            }
        }
        // Singleton unless the entity is a plain HOSTILE: you, your summoned pet and your charmed
        // pet are identities this model tracks, so a re-cast on one of them is unambiguously a
        // refresh. A mob is only ever a NAME, and the world hands out that name more than once.
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

    /// Authoritative removal: a wears-off message proves the SELF instance expired now. Pairs a
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
        // Now resolved to `spell` on `entity_key`. Alerts match this unambiguous kind instead of
        // the raw ambiguous wear-off.
        self.expire(spell, pets.target_display_for(entity_key));
    }

    /// Shared wears-off resolution. A wears-off line whose message maps to MULTIPLE candidate spells
    /// resolves against the ACTIVE set rather than guessing a single spell:
    ///   * exactly one candidate active removes it (the common case; EQ stacking keeps one member
    ///     of a family up at a time);
    ///   * several active removes all of them, because they honestly share this message;
    ///   * none active is a no-op, so a wears-off for a buff we never tracked cannot create a
    ///     phantom fade sample.
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
    /// A sample is minted only from an exact (spell, entity, CASTER) chain: one cast, landing on
    /// that entity, wearing off that entity. Only one caster's modifiers shape a duration anyone is
    /// entitled to learn from, and a fade that cannot be matched to its own exact instance mints
    /// nothing.
    ///
    /// It closes the OLDEST landing: the wear-off names the mob but not which mob of that name, so
    /// under a fixed duration the oldest is the maximum-likelihood one to have just ended. The row
    /// survives with one fewer on its count chip; only an empty group clears it. The fade proves
    /// THIS entity's copy is gone, so a still-live slow on mob A survives mob B's wear-off.
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
            // Censor a sample whose land→fade window crossed an offline gap. The fade itself is
            // still authoritative and the instance clears, but the SPAN is not a duration: it holds
            // an absence whose length we know only to within the reconnect window, and contributing
            // it would poison the recency-weighted MAX with a value guaranteed too large.
            if !spanned {
                if let Some(ms) = sample.filter(|&s| s > 0 && s <= MAX_SAMPLE_MS) {
                    // Never censored on this path: the wake line is a crowd-control annotation, and
                    // no sentence in the log says a beneficial buff or a debuff ended early.
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

    /// The offline-gap PAUSE, and the asymmetry it turns on.
    ///
    /// Your buffs pause: EQ does not run buff timers while the character is out of the world, saving
    /// each buff's remaining duration and resuming it at login (measured — a 16-minute buff landed
    /// before a 13-hour camp printed its wear-off one minute after the login). So a beneficial
    /// instance surviving a gap has its clock shifted forward by the absence, or every countdown
    /// reads long-expired and the hygiene sweep retires a buff that is still up.
    ///
    /// Debuffs do not pause. What EQ pauses is your CHARACTER; the world it stands in keeps running,
    /// so a slow you landed on a mob keeps burning down and its clock is left where it was.
    ///
    /// `from_ts` is the last instant the character is KNOWN to have been in the world, so only
    /// instances predating it are shifted: anything raised after it was raised on this side of the
    /// absence and has nothing to be compensated for.
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
        // A cast in flight when the character left the world never completed. Shifting it would
        // resurrect a cast that produced no landing message.
        self.pending = None;
    }

    /// Session-gap clear: wipe live actives/opens/pending.
    pub fn clear_for_gap(&mut self) {
        self.active.clear();
        self.open.clear();
        self.pending = None;
    }

    /// Drop every instance whose clock predates `ts` — the unexplained-hole resolution.
    ///
    /// A log hole no login explains means we lost the thread rather than that the character left, so
    /// what was standing when it opened goes. It is SCOPED rather than blanket because the ruling
    /// arrives after the hole did — it waits for in-world evidence — and anything raised on this
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
    /// The unwitnessed cull takes the ROW and leaves the PAIRING RECORD, deliberately: the record is
    /// what lets a late wear-off still mint a sample, and deleting it too pins the estimate to the
    /// DB floor forever, because the first cycle that would teach the true duration is the first one
    /// culled. Where the line is never coming, nothing pairs with the surviving record and the long
    /// stop collects it minting nothing.
    ///
    /// Returns whether it changed the PUBLISHED set. It runs once per event and finds nothing to do
    /// on nearly all of them, which is the difference between announcing on every line and
    /// announcing when a buff actually aged out. The `reap_orphaned_open` call at the end is
    /// deliberately not counted: it touches `open`, which is not in the snapshot.
    pub fn sweep_hygiene(
        &mut self,
        now: i64,
        held_before_ts: i64,
        stats: &SpellStats,
        pets: &PetEntities,
    ) -> bool {
        let mut changed = false;
        // Called once per event, so its cost is paid on every line of a full replay: nothing here
        // may copy the map, and the loop deletes only the entry it is standing on.
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
            // The long stop goes first, because it means "we lost the thread" and is the only one
            // that takes the PAIRING RECORD with it. A multiset retires ONE landing at a time, so
            // the row keeps whichever landings are still inside the cap.
            let long_cap = hygiene_cap(a, db_ms);
            let elapsed = (now - a.started_ts) as f64;
            if elapsed > long_cap {
                // The cap is fractional whenever the p75 statistic beat the 90-minute floor, and
                // `drop_expired` compares an integer ts against it. For an integer x, `x <= r` is
                // `x <= floor(r)`, so the floor is the exact answer rather than a rounding of one.
                let cutoff = (now as f64 - long_cap).floor() as i64;
                self.retire_expired(&ik, cutoff, stats, pets);
                changed = true;
                continue;
            }
            if elapsed > unwitnessed_cull_cap(a) {
                self.active.remove(&ik);
                changed = true;
            }
        }
        // The loop above can only reach a record through its active row, so the records the cull
        // left behind need their own reaper.
        reap_orphaned_open(&mut self.open, &self.active, stats, now);
        changed
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

    /// A player death strips SELF buffs: censor open self casts and clear their actives.
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

    /// A mob of this name died — the death censor, and the one path every death shape reaches.
    ///
    /// It closes ONE landing, not the row. A group is a multiset of same-named mobs we believe are
    /// holding the spell, and one death is evidence about one of them; the oldest is closed for the
    /// same reason a wear-off closes the oldest.
    ///
    /// It mints no CYCLE: a land-to-death span is not a duration, because the spell was cut short by
    /// the corpse rather than observed running out. `contaminate_all` is the separate half, about
    /// the landings that SURVIVE the close, which now belong to a group that has lost track of which
    /// mob is which.
    ///
    /// What it does mint is a LOWER BOUND, and the distinction above is why it may: no wear-off ever
    /// printed between the landing and the corpse, and a landing still in this group has by
    /// construction not been closed by one. The rails that keep "at least" honest are on
    /// [`death_bound_span`].
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

    /// One open record against one corpse: measure the lower bound, then close its oldest landing
    /// and contaminate what is left. The bound is read and minted BEFORE the close, because the
    /// close consumes the landing it measures.
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
        // Never off the `unknown-hostile` bucket `death_censors_open` also sweeps: that row's target
        // is an INFERENCE, and a span measured against a mob the log never named is not evidence.
        // The record may have outlived its active row; only the LINE it is kept for may close it.
        let ms = if is_debuff && o.entity_key == entity_key {
            death_bound_span(o, entity_key, ts, self.active.contains_key(ik), stats)
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

    /// Retire an ENTITY, with no pet-specific branches: censor every open cast and active instance
    /// bound to `entity_key`, buff and debuff alike. A pet is just the entity currently claimed, and
    /// buffs on other players are censored the same way.
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

    /// Zone: the player keeps self buffs, a SUMMONED pet follows and keeps its buffs, a CHARMED pet
    /// is left behind, and so are hostile mobs.
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

/// The spec for re-projecting a row that is already live: everything the instance IS, carried
/// forward from the row being replaced, with only the coordinates a re-projection restates supplied
/// by the caller.
///
/// It exists because the store re-projects from two places that must not drift — `restat` (the hold
/// group moved) and `add_sample` (a fresh duration changed what every live instance of that line
/// counts down from). Hand-copying the fields in both is how a row ends up saying different things
/// depending on which internal event last touched it.
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
