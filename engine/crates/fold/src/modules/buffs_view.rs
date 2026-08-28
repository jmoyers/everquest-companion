//! The `ActiveBuff` projection: turn one live buff instance (spell line, entity, caster) plus how it
//! got there into the row the UI renders. Pure — it reads the learned per-spell stats and the
//! current pet identities and writes nothing — so every caller in the instance store shares one
//! definition of what a row says.

use crate::modules::buffs_entities::PetEntities;
use crate::modules::buffs_shapes::{
    spell_key, BuffClass, Disposition, EstimatorSource, SELF_CASTER, SELF_KEY,
};
use crate::modules::buffs_stats::SpellStats;
use serde::Serialize;

/// A currently-active (landed, not yet faded) buff INSTANCE = (spell, target entity).
///
/// Optional fields are skipped when absent and nullable ones are written as null, and the goldens
/// pin the difference. A count chip on every row would be noise, and a `caster` on every row would
/// suggest the model doubts who cast your own buffs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBuff {
    /// The spell's IDENTITY — the DB's own display name whenever the model resolved which spell this
    /// is, never the ranked text one cast line happened to spell. A FAMILY the anchors could not
    /// narrow names every candidate here and says so with `candidates`, which is an honest absence
    /// of an identity rather than a second spelling of one.
    pub spell: String,
    /// The ranked name the cast line spelled, when a cast anchor resolved this instance AND the
    /// log's spelling says something `spell` does not. Display only: nothing keys, matches, learns
    /// or alerts off it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cast_name: Option<String>,
    pub cls: BuffClass,
    /// True when the spell CALMS its target — a second, orthogonal fact about the spell, not a
    /// correction to `cls`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calms_target: Option<bool>,
    #[serde(rename = "self")]
    pub is_self: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disposition: Option<Disposition>,
    pub started_ts: i64,
    pub estimated_ms: Option<i64>,
    pub p25: Option<f64>,
    pub p75: Option<f64>,
    pub n: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inferred_target: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_source: Option<EstimatorSource>,
    pub overlay_duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overlay_source: Option<EstimatorSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permanent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permanent_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_driven: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caster: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<String>>,
}

/// Everything that identifies the instance being projected, plus how it was established.
#[derive(Debug, Clone, Default)]
pub struct ActiveSpec {
    /// The IDENTITY — a resolved landing's DB name, or the joined family.
    pub spell: String,
    /// Display only: the ranked text the cast line spelled, when it said one.
    pub cast_name: Option<String>,
    pub key: String,
    pub entity_key: String,
    pub started_ts: i64,
    pub disp_override: Option<Disposition>,
    /// 'self' or an allowlisted external — the second half of the learner's key.
    pub caster: Option<String>,
    /// How many entities of that display name are holding it.
    pub count: Option<i64>,
    /// Present when the landing sentence stayed a FAMILY (a Quick Buff burst cannot narrow one).
    pub candidates: Option<Vec<String>>,
    pub message_driven: bool,
    pub permanent: bool,
}

/// Target label + inference. Self: none. Otherwise the bound entity's display name; a debuff whose
/// target was inferred (no confirmed message) is flagged.
fn resolve_target_label(
    entity_key: &str,
    cls: BuffClass,
    is_self: bool,
    disp: Option<Disposition>,
    message_driven: bool,
    pets: &PetEntities,
) -> (Option<String>, bool) {
    if is_self {
        return (None, false);
    }
    // A landing line NAMED this entity, so the target is stated rather than inferred — even when it
    // is also the mob we believe the pet is fighting. This is the only way an instance ever opens.
    if message_driven {
        return (pets.entity_display_for(entity_key), false);
    }
    // Self-keyed debuff = an inferred, not-yet-named hostile target.
    if cls == BuffClass::Debuff && entity_key == SELF_KEY {
        return (pets.pet_target_display.clone(), true);
    }
    if disp == Some(Disposition::Summoned) && pets.summoned_key.as_deref() == Some(entity_key) {
        return (pets.summoned_display.clone(), false);
    }
    if disp == Some(Disposition::Charmed) && pets.charmed_key.as_deref() == Some(entity_key) {
        return (pets.charmed_display.clone(), false);
    }
    if pets.pet_target_key.as_deref() == Some(entity_key) {
        return (pets.pet_target_display.clone(), cls == BuffClass::Debuff);
    }
    if entity_key == "unknown-hostile" {
        return (None, true);
    }
    // A cast-timing-inferred debuff target (no confirming message) is a best guess.
    (
        pets.entity_display_for(entity_key),
        cls == BuffClass::Debuff && !message_driven,
    )
}

/// The overlay's countdown duration, computed here where the samples and the DB live and carried on
/// the row so the pure projection never reaches back. It is the SAME estimator the Buffs tab uses,
/// so the two surfaces cannot state different numbers. A permanent buff never counts down; a spell
/// with no floor and no sample carries no number and counts up. It is read PER CASTER, because the
/// AAs and focus items behind an external's duration are theirs.
fn overlay_duration_of(
    key: &str,
    permanent: bool,
    stats: &SpellStats,
    caster: &str,
) -> (Option<i64>, Option<EstimatorSource>) {
    if permanent {
        return (None, None);
    }
    let est = stats.estimate_for(key, caster);
    match (est.ms, est.source) {
        (Some(ms), Some(src)) => (Some(ms), Some(src)),
        _ => (None, None),
    }
}

pub fn build_active(spec: &ActiveSpec, stats: &SpellStats, pets: &PetEntities) -> ActiveBuff {
    let caster = spec
        .caster
        .clone()
        .unwrap_or_else(|| SELF_CASTER.to_string());
    let cls = stats.class_of(&spec.key);
    // A DEBUFF is never the player's own buff, even if cast timing bound it to the self key before
    // its class was known: a debuff on self means an inferred hostile target we could not name yet.
    let is_self = spec.entity_key == SELF_KEY && cls != BuffClass::Debuff;
    let (target, inferred_target) = resolve_target_label(
        &spec.entity_key,
        cls,
        is_self,
        spec.disp_override,
        spec.message_driven,
        pets,
    );
    // The calm flag, read at the same seam as `cls` and from the same DB. A FAMILY answers only if
    // every candidate calms — the same unanimity rule a family's duration takes.
    let calms = stats.calms_target(&spec.key)
        || spec
            .candidates
            .as_ref()
            .is_some_and(|cs| cs.iter().all(|c| stats.calms_target(&spell_key(c))));
    // Why it is permanent, derived rather than plumbed: `landing_is_permanent` asks the DB first and
    // the AA second, so re-asking the DB here answers the same question in the same order.
    let permanent_source = if stats.is_permanent(&spec.key) {
        "spell"
    } else {
        "illusion-aa"
    };
    let st = stats.stat_for(&spec.key, &caster);
    let est = stats.estimate_for(&spec.key, &caster);
    let (overlay_duration_ms, overlay_source) =
        overlay_duration_of(&spec.key, spec.permanent, stats, &caster);
    let count = spec.count.unwrap_or(1);
    ActiveBuff {
        spell: spec.spell.clone(),
        cast_name: spec
            .cast_name
            .clone()
            .filter(|c| c.as_str() != spec.spell.as_str()),
        cls,
        calms_target: calms.then_some(true),
        is_self,
        disposition: spec.disp_override,
        started_ts: spec.started_ts,
        estimated_ms: if spec.permanent { None } else { est.ms },
        p25: st.as_ref().and_then(|s| s.p25),
        p75: st.as_ref().and_then(|s| s.p75),
        n: st.as_ref().map_or(0, |s| s.n),
        target,
        inferred_target: inferred_target.then_some(true),
        duration_source: if spec.permanent { None } else { est.source },
        overlay_duration_ms,
        overlay_source,
        permanent: spec.permanent.then_some(true),
        permanent_source: spec.permanent.then_some(permanent_source),
        message_driven: spec.message_driven.then_some(true),
        count: (count > 1).then_some(count),
        caster: (caster != SELF_CASTER).then_some(caster),
        candidates: spec.candidates.clone(),
    }
}
