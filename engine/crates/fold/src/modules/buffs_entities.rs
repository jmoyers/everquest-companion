//! `src/main/modules/buffsEntities.ts` — the buffs model's ENTITY state (the who/what), a tiny
//! parallel to the combat world model sharing its pure rules.
//!
//! ENTITIES, NOT NAMES; DISPOSITION, NOT IDENTITY (world-model law 4): a buff binds to the entity a
//! landing message named, and retiring that entity censors every instance bound to its key. "pet" is
//! simply the entity currently claimed — there are no pet-specific branches in the instance store,
//! and the only pet-shaped knowledge is the four slots below.

use crate::jsmap::JsMap;
use crate::modules::buffs_shapes::{Disposition, SELF_KEY};
use eqlog::names::id_key;

#[derive(Default)]
pub struct PetEntities {
    pub charmed_key: Option<String>,
    pub charmed_display: Option<String>,
    /// A charm that just BROKE but whose entity is NOT yet retired (Task #37). Charm/uncharm changes
    /// an entity's DISPOSITION, never its identity: when Allure wears off, the mob KEEPS its buffs
    /// and is merely hostile-capable for a few seconds until you re-charm it. Remembering it here is
    /// what lets a re-charm of the SAME name — with no intervening death or zone of that name —
    /// reconnect to the SAME entity, its buffs never having been censored.
    pub broken_charm_key: Option<String>,
    pub broken_charm_display: Option<String>,
    pub summoned_key: Option<String>,
    pub summoned_display: Option<String>,
    /// The pet's CURRENT hostile fight target (canonical key + display), if cheaply known.
    pub pet_target_key: Option<String>,
    pub pet_target_display: Option<String>,
    /// Display casing for arbitrary bound entities (mobs/players named by a buff message), so the
    /// row's chip reads "Cazic-Thule" and not the lowercased key.
    pub named_entity_display: JsMap<String>,
}

impl PetEntities {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.clear_for_gap();
        self.named_entity_display.clear();
    }

    /// Session-gap / rebirth clear: every live pet binding goes, learned display casing stays.
    pub fn clear_for_gap(&mut self) {
        self.charmed_key = None;
        self.charmed_display = None;
        self.broken_charm_key = None;
        self.broken_charm_display = None;
        self.summoned_key = None;
        self.summoned_display = None;
        self.pet_target_key = None;
        self.pet_target_display = None;
    }

    /// Current pet identities, for the shared fade classifier. During a charm-break hostile window
    /// the ex-pet is still the SAME entity, so its name is classified as the (charmed) pet — a buff
    /// fading on it in that window is the pet's buff fading, NOT a hostile debuff.
    fn charmed_or_broken(&self) -> Option<&str> {
        self.charmed_key
            .as_deref()
            .or(self.broken_charm_key.as_deref())
    }

    /// The current pet's canonical entity key (summoned preferred, else charmed).
    fn current_pet_key(&self) -> Option<&str> {
        self.summoned_key.as_deref().or(self.charmed_key.as_deref())
    }

    /// The current pet's display name (summoned preferred, else charmed).
    fn current_pet_display(&self) -> Option<&str> {
        self.summoned_display
            .as_deref()
            .or(self.charmed_display.as_deref())
    }

    /// Disposition for a named message target: a live pet, else hostile.
    pub fn disp_for_named_target(&self, target: &str) -> Disposition {
        let k = id_key(target);
        if self.charmed_key.as_deref() == Some(k.as_str()) {
            return Disposition::Charmed;
        }
        if self.summoned_key.as_deref() == Some(k.as_str()) {
            return Disposition::Summoned;
        }
        Disposition::Hostile
    }

    /// `combat/entityRules.ts classifyFadeTarget` — a fade-target NAME against the current pet
    /// identities. A targetless fade is yours; the literal `pet` form prefers the SUMMONED pet (the
    /// class pet is the canonical "pet" in EQ) and falls back to the charmed one, and with no known
    /// pet at all it is still a pet-form fade and reads 'summoned'.
    fn classify_fade_target(&self, target_name_key: Option<&str>) -> Disposition {
        let Some(key) = target_name_key else {
            return Disposition::Zelf;
        };
        if key == "pet" {
            if self.summoned_key.is_some() {
                return Disposition::Summoned;
            }
            if self.charmed_or_broken().is_some() {
                return Disposition::Charmed;
            }
            return Disposition::Summoned;
        }
        if self.summoned_key.as_deref() == Some(key) {
            return Disposition::Summoned;
        }
        if self.charmed_or_broken() == Some(key) {
            return Disposition::Charmed;
        }
        Disposition::Hostile
    }

    /// Resolve a `buffFade`'s raw target into an entity key + disposition.
    pub fn fade_target_entity(&self, raw_target: Option<&str>) -> (String, Disposition) {
        // `if (!rawTarget)` — an EMPTY string is falsy over there too, which is why this asks about
        // emptiness rather than only about absence.
        let Some(raw) = raw_target.filter(|t| !t.is_empty()) else {
            return (SELF_KEY.to_string(), Disposition::Zelf);
        };
        if raw == "pet" {
            // Possessive `Your pet's …` — resolve against the CURRENT pet entity.
            let disp = self.classify_fade_target(Some("pet"));
            let key = self.current_pet_key().unwrap_or("pet").to_string();
            return (key, disp);
        }
        let name_key = id_key(raw);
        let disp = self.classify_fade_target(Some(&name_key));
        (name_key, disp)
    }

    /// The `buffExpired.target` display for a `buffFade`: targetless → 'self'; the possessive 'pet'
    /// form → the current pet's display name (or the literal 'pet'); a named mob → its raw display
    /// name, because the fade line preserves casing.
    pub fn buff_fade_target_display(&self, raw_target: Option<&str>, entity_key: &str) -> String {
        let Some(raw) = raw_target.filter(|t| !t.is_empty()) else {
            return SELF_KEY.to_string();
        };
        if raw == "pet" {
            return self
                .named_entity_display
                .get(entity_key)
                .cloned()
                .or_else(|| self.current_pet_display().map(str::to_string))
                .unwrap_or_else(|| "pet".to_string());
        }
        raw.to_string()
    }

    /// Map an entity key to a `buffExpired.target` value: 'self' or the entity's display name.
    pub fn target_display_for(&self, entity_key: &str) -> String {
        if entity_key == SELF_KEY {
            return SELF_KEY.to_string();
        }
        self.named_entity_display
            .get(entity_key)
            .cloned()
            .unwrap_or_else(|| entity_key.to_string())
    }

    /// Best display name for an entity key (a pet, the inferred target, a named mob, else the key).
    pub fn entity_display_for(&self, entity_key: &str) -> Option<String> {
        if self.summoned_key.as_deref() == Some(entity_key) {
            return self.summoned_display.clone();
        }
        if self.charmed_key.as_deref() == Some(entity_key) {
            return self.charmed_display.clone();
        }
        if self.pet_target_key.as_deref() == Some(entity_key) {
            return self.pet_target_display.clone();
        }
        if entity_key == "unknown-hostile" || entity_key == "pet" {
            return None;
        }
        Some(
            self.named_entity_display
                .get(entity_key)
                .cloned()
                .unwrap_or_else(|| entity_key.to_string()),
        )
    }

    /// Clear the entity from pet state if it was a pet (charmed / broken-charm / summoned).
    pub fn retire_slots(&mut self, entity_key: &str) {
        if self.charmed_key.as_deref() == Some(entity_key) {
            self.charmed_key = None;
            self.charmed_display = None;
        }
        if self.broken_charm_key.as_deref() == Some(entity_key) {
            self.broken_charm_key = None;
            self.broken_charm_display = None;
        }
        if self.summoned_key.as_deref() == Some(entity_key) {
            self.summoned_key = None;
            self.summoned_display = None;
        }
    }

    /// ZONE: the charmed pet is left behind, and so is a broken-charm entity — its actives were
    /// censored by the instance store's 'charmed'-disposition sweep, so its state is dropped here so
    /// a later charm of that name is a fresh entity. The inferred fight target goes unconditionally.
    /// Returns whether anything changed.
    pub fn clear_on_zone(&mut self) -> bool {
        let mut changed = false;
        if self.charmed_key.is_some() {
            self.charmed_key = None;
            self.charmed_display = None;
            changed = true;
        }
        if self.broken_charm_key.is_some() {
            self.broken_charm_key = None;
            self.broken_charm_display = None;
            changed = true;
        }
        self.pet_target_key = None;
        self.pet_target_display = None;
        changed
    }
}
