//! The pure rules the buff-instance store applies. Nothing here holds state or reads a clock; each
//! function answers one question the store asks while censoring, retiring or projecting an instance.

use crate::jsmap::JsMap;
use crate::modules::buff_rounds::HoldGroup;
use crate::modules::buffs_shapes::{
    hygiene_cap_ms, learning_record_cap_ms, unwitnessed_timeout_ms, BuffClass, Disposition,
    HYGIENE_ABSOLUTE_MS,
};
use crate::modules::buffs_stats::SpellStats;
use crate::modules::buffs_view::ActiveBuff;

/// A landed instance awaiting its next fade — the record behind one row.
///
/// It is a MULTISET: `group` holds one landing per entity of that name we believe is holding this
/// spell, oldest first. Two same-named mobs slowed in one round are two landings in one group and
/// one row with a count chip, not one row whose clock the second landing silently overwrote.
pub struct OpenCast {
    /// The spell's IDENTITY — the DB name a resolved landing carries, or the joined family when the
    /// anchors could not narrow one. Never the ranked cast text; that is `cast_name`.
    pub spell: String,
    /// The ranked text the cast line spelled, when it says something the DB name does not. Display
    /// only.
    pub cast_name: Option<String>,
    /// The rank-stripped spell key — the LINE, and half of the learner's key.
    pub spell_key: String,
    /// The entity this instance is on ('self' or a canonical name key).
    pub entity_key: String,
    pub group: HoldGroup,
    /// Whose cast this is: 'self' or an allowlisted external.
    pub caster: String,
    /// The entity disposition this cast is bound to (for censoring on zone/death).
    pub disp: Disposition,
    /// True once an `offlineGap` has passed over this open cast — set for a BUFF and a DEBUFF alike.
    /// The instance survives; what is refused is the SAMPLE, because neither half of the pair is a
    /// clean observation once an absence sits inside it:
    ///
    ///   * a BUFF's clock was PAUSED (EQ freezes buffs with your character and resumes them at
    ///     login — measured), so its land→fade span contains frozen time that is not duration;
    ///   * a DEBUFF's clock was not paused, so arithmetically its span IS world time — but the
    ///     wear-off LINE only exists while you are logged in, so a fade printing after an absence
    ///     dates the moment you were there to see it, not the moment the spell ended.
    ///
    /// Both errors point the same way — too long — and the estimator is a recency-weighted MAX,
    /// which is sensitive to exactly that. Neither is correctable, because the gap's start is only a
    /// lower bound on the absence. Censor, never correct.
    pub spanned_gap: bool,
}

/// A cast in flight, not yet confirmed landed or cleared. It displays nothing: it is the
/// bookkeeping the landing side consumes, dropped by a fizzle, an interrupt, a fade of the same
/// spell, or the landing window elapsing with no confirmation.
pub struct Pending {
    pub key: String,
    pub began_ts: i64,
    /// The landing emote's subject key ('self' or a name key), once its text is recognized.
    pub emote_subject_key: Option<String>,
}

/// The death censor's reach: a mob died, so anything that was on an ENEMY goes with it. It takes
/// two tests, because neither alone covers the log:
///
///   * the SPELL'S CLASS, because a mob can share its name with your charmed pet, so a detrimental
///     spell on it may be filed with a `charmed` disposition;
///   * the RECORD'S DISPOSITION, because the Pacify family is beneficial in the committed
///     spells.json and is cast at enemies, so it is a `buff` standing on a hostile.
///
/// The reach is the union, applied identically to open records and active rows. `unknown-hostile` is
/// swept alongside the named key because its inferred target is exactly the mob that just died.
pub fn death_censors_open(o: &OpenCast, entity_key: &str, is_debuff: bool) -> bool {
    if !is_debuff && o.disp != Disposition::Hostile {
        return false;
    }
    o.entity_key == entity_key || o.entity_key == "unknown-hostile"
}

/// The same union for an ACTIVE row.
pub fn death_censors_active(a: &ActiveBuff, a_key: &str, entity_key: &str) -> bool {
    if a.cls != BuffClass::Debuff && a.disposition != Some(Disposition::Hostile) {
        return false;
    }
    a_key == entity_key || a_key == "unknown-hostile" || a.inferred_target == Some(true)
}

/// A name the world hands out more than once. The leading article is how EQ spells "one of these"
/// (`a rock golem`) as against an identity (`Cazic-Thule`). Read off the canonical key, which is
/// already lowercased at the boundary.
pub fn is_article_named(entity_key: &str) -> bool {
    entity_key.starts_with("a ") || entity_key.starts_with("an ") || entity_key.starts_with("the ")
}

/// How much longer than the current estimate an ARTICLE-named mob's bound may claim.
pub const DEATH_BOUND_MAX_ESTIMATE_MULTIPLE: i64 = 2;
/// The absolute ceiling on any bound, as a multiple of the spell database's own duration.
pub const DEATH_BOUND_MAX_DB_MULTIPLE: i64 = 3;

/// The death lower bound — the span a corpse is allowed to teach, or `None` when it teaches nothing.
///
/// A debuffed mob that dies with no wear-off since its landing proves the debuff lasted AT LEAST
/// landing→corpse. That is not a DURATION, but a MAX estimator does not need one: a lower bound
/// lifts the floor toward the truth and can never lift it past, so long as the wear-off line is
/// reliable when it does happen. On raid mobs it is the only evidence there is — they die first.
///
/// Five rails, each of which refuses rather than guesses:
///
///  1. The channel must be WITNESSED. Silence is evidence only about a spell this log has heard
///     speak; otherwise "no wear-off printed" is a fact about the spell's messages, not its
///     duration.
///  2. ONE landing only. A corpse names a mob but never which mob of that name, so with two
///     landings the log does not say which died — and a wear-off may already have closed the other.
///  3. It must BEAT the current estimate. A bound below what the app already draws is useless.
///  4. The same-name cap: for an article-named mob the span may not exceed twice the current
///     estimate, because a same-named mob dying long after the landing is more likely a different
///     one. A proper name has no twin and takes no such cap.
///  5. The absolute cap: no bound may exceed three times what the spell database states. With no
///     database row there is nothing to multiply and the bound is refused outright.
///
/// An offline gap refuses it too: the wear-off sentence only exists while you are logged in, so
/// across an absence "no wear-off printed" stops being a claim about the world at all.
pub fn death_bound_span(
    o: &OpenCast,
    entity_key: &str,
    death_ts: i64,
    stats: &SpellStats,
) -> Option<i64> {
    let db_ms = stats.db_duration_for(&o.spell_key);
    if !stats.has_wear_off_channel(&o.spell_key) || o.spanned_gap {
        return None;
    }
    let db_ms = db_ms.filter(|&ms| ms > 0)?;
    if o.group.count() != 1 {
        return None;
    }
    let span = death_ts - o.group.oldest_ts();
    let estimate_ms = stats.estimate_for(&o.spell_key, &o.caster).ms?;
    if span <= 0 || span <= estimate_ms {
        return None;
    }
    if is_article_named(entity_key) && span > DEATH_BOUND_MAX_ESTIMATE_MULTIPLE * estimate_ms {
        return None;
    }
    (span <= DEATH_BOUND_MAX_DB_MULTIPLE * db_ms).then_some(span)
}

/// Zone: the player keeps self buffs, a SUMMONED pet follows and keeps its buffs, a CHARMED pet is
/// left behind, and so are hostile mobs.
pub fn open_left_behind_on_zone(o: &OpenCast) -> bool {
    match o.disp {
        Disposition::Zelf => false,
        Disposition::Summoned => false,
        Disposition::Charmed => true,
        Disposition::Hostile => true,
    }
}

/// The long-stop retirement every instance has: 90 minutes, or twice what we know about the spell,
/// whichever is longer. It answers "we lost the thread", not "it expired".
pub fn hygiene_cap(a: &ActiveBuff, db_ms: Option<i64>) -> f64 {
    hygiene_cap_ms(a.p75, a.n).max(db_ms.map_or(0.0, |ms| 2.0 * ms as f64))
}

/// The unwitnessed-expiry cull: a row whose countdown ran out and whose close was never witnessed —
/// you died, the pet despawned — is culled after its own timeout rather than squatting at 0 s under
/// the hygiene cap. It mints nothing: an absence of evidence is not a measurement.
///
/// The exemption is on `self`, not on class. A wear-off for a buff of yours prints to YOU and its
/// clock is paused by an absence; neither is true of a buff on somebody else, because the pet fade
/// line resolves against the CURRENT pet (so a row bound to a despawned pet can never be named by
/// any later line) and a buff on an ally prints nothing to you at all.
///
/// A row with no number is counting UP, has nothing to be overdue against, and keeps the hygiene
/// cap. Nothing here reads a clock, so the cull is judged on the same `started_ts` the countdown
/// draws — which is what makes it respect the offline pause automatically.
pub fn unwitnessed_cull_cap(a: &ActiveBuff) -> f64 {
    if a.cls != BuffClass::Debuff && a.is_self {
        return f64::INFINITY;
    }
    match a.overlay_duration_ms {
        Some(dur) if dur > 0 => (dur + unwitnessed_timeout_ms(a.overlay_source)) as f64,
        // No number at all: the row is counting UP and has nothing to be overdue against.
        _ => f64::INFINITY,
    }
}

/// The orphaned-record reaper — the buffs half of the retention rule.
///
/// The hygiene sweep iterates the ACTIVE map, and its unwitnessed cull deletes the active row while
/// deliberately keeping the open record, which is what lets a late wear-off still mint a sample. The
/// long stop that would collect that record lives in the same active loop, so without this the map
/// would grow without bound and the next landing on a same-named mob would find the stale record and
/// land into its stale group, drawing an ancient clock.
///
/// It reaps only ORPHANS — a record with no active row behind it — on the shared schedule
/// ([`learning_record_cap_ms`]). It mints nothing and says nothing: a reap is not an observation,
/// and nothing in either snapshot describes an open record.
pub fn reap_orphaned_open(
    open: &mut JsMap<OpenCast>,
    active: &JsMap<ActiveBuff>,
    stats: &SpellStats,
    now: i64,
) {
    let mut dead: Vec<String> = Vec::new();
    for (ik, _) in open.iter() {
        if !active.contains_key(ik) {
            dead.push(ik.to_string());
        }
    }
    for ik in dead {
        let cap = {
            let o = open.get(&ik).expect("named above");
            now - learning_record_cap_ms(
                stats.floor_for(&o.spell_key, &o.caster),
                HYGIENE_ABSOLUTE_MS,
            )
        };
        let empty = {
            let o = open.get_mut(&ik).expect("named above");
            o.group.drop_expired(cap);
            o.group.is_empty()
        };
        if empty {
            open.remove(&ik);
        }
    }
}

/// Does this landing never expire — no countdown, no duration sample, no hygiene retirement?
///
/// Two independent reasons: the SPELL itself states `Permanent`, or a SELF illusion was cast at or
/// after the Permanent Illusion AA was owned.
///
/// Both are gated on `self`. All 62 permanent rows in the committed spells.json are self-targeted,
/// so a permanent landing on somebody else is a shape the game does not print; if a re-scrape ever
/// produces one, the honest answer is a count-up row rather than an unkillable bar on an entity this
/// model may lose track of. The illusion-flagged permanents take the FIRST arm, so a player who has
/// not bought the AA still keeps the form the hygiene cap would otherwise retire.
pub fn landing_is_permanent(
    is_self: bool,
    db_permanent: bool,
    illusion: bool,
    ts: i64,
    permanent_illusion_owned_ts: Option<i64>,
) -> bool {
    if !is_self {
        return false;
    }
    if db_permanent {
        return true;
    }
    illusion && permanent_illusion_owned_ts.is_some_and(|owned| ts >= owned)
}
