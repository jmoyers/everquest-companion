//! `src/main/modules/buffsInstanceRules.ts` — the PURE rules the buff-instance store applies.
//! Nothing here holds state or reads a clock; each function answers ONE question the store asks
//! while censoring, retiring or projecting an instance.

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
/// IT IS A MULTISET (JOS-140 ruling 7). `group` is the `HoldGroup` of landings for this (spell line,
/// entity NAME): one per entity of that name we believe is holding this spell, oldest first. Two
/// mobs called `a wan ghoul knight` slowed in one round are two landings in one group and ONE row
/// with a count chip, not one row whose clock the second landing silently overwrote.
pub struct OpenCast {
    /// The spell's IDENTITY — the DB name a resolved landing carries, the joined family when the
    /// anchors could not narrow one. NEVER the ranked cast text; that is `cast_name`.
    pub spell: String,
    /// The RANKED text the cast line spelled, when a named anchor resolved this landing and the log
    /// wrote something the DB name does not. DISPLAY ONLY.
    pub cast_name: Option<String>,
    /// The rank-stripped spell key — the LINE, and half of the learner's key.
    pub spell_key: String,
    /// The entity this instance is on ('self' or a canonical name key).
    pub entity_key: String,
    pub group: HoldGroup,
    /// WHOSE cast this is: 'self' or an allowlisted external.
    pub caster: String,
    /// The entity disposition this cast is bound to (for censoring on zone/death).
    pub disp: Disposition,
    /// True once an `offlineGap` has passed over this open cast — set for a BUFF and a DEBUFF alike,
    /// which is the whole of JOS-134's learner rule. The instance itself survives; what is refused
    /// is the SAMPLE, because neither half of the pair is a clean observation once an absence sits
    /// inside it:
    ///
    ///   * A BUFF's clock was PAUSED (EQ freezes buffs with your character and resumes them at
    ///     login — measured), so its land→fade span contains frozen time that is not duration.
    ///   * A DEBUFF's clock was NOT paused (the world kept running), so arithmetically its span IS
    ///     world time. It is still refused for a DIFFERENT reason: the wear-off LINE only exists
    ///     while you are logged in, so a fade printing after an absence dates the moment you were
    ///     there to SEE it, not the moment the spell ended.
    ///
    /// Both errors point the same way — too LONG — and the estimator is a recency-weighted MAX,
    /// chosen precisely because it is sensitive to over-long samples. And neither is correctable:
    /// `offlineGap.fromTs` is a LOWER bound on the absence, so subtracting the gap exactly is not
    /// something we are in a position to do. CENSOR, never correct.
    pub spanned_gap: bool,
}

/// A cast in flight (`You begin casting …`) not yet confirmed landed or cleared.
///
/// It DISPLAYS NOTHING (JOS-118). It is the cast-in-flight bookkeeping the landing side consumes,
/// and it is dropped by a fizzle, an interrupt, a fade of the same spell, or the landing window
/// elapsing with no confirmation.
pub struct Pending {
    pub key: String,
    pub began_ts: i64,
    /// The landing emote's subject key ('self' or a name key), once its text is recognized.
    pub emote_subject_key: Option<String>,
}

/// THE DEATH CENSOR'S REACH (JOS-156). A mob died — which of the things we are holding did it take
/// with it? The answer is "anything that was on an ENEMY", and it takes TWO tests to say that,
/// because neither one alone covers the log:
///
///   * the SPELL'S CLASS. The owner's charm pet and the bees it was killing all answered to
///     "Bzzazzt", so a slow landed on one of the bees was filed with `disp: 'charmed'` — the name
///     matched the live pet — even though the spell on it is detrimental. A disposition test alone
///     let that row outlive four deaths.
///   * the RECORD'S DISPOSITION. The PACIFY family (Calm, Lull, Pacify) is `Beneficial` in the
///     committed spells.json and is cast at enemies, so it is a `cls: 'buff'` standing on a hostile.
///     MEASURED over the full log: reading class alone left those open records behind, and they
///     later paired with a wear-off into duration samples the old code refused.
///
/// So the reach is the UNION, applied identically to open records and active rows.
/// `unknown-hostile` is swept alongside the named key because its inferred target is exactly the mob
/// that just died.
pub fn death_censors_open(o: &OpenCast, entity_key: &str, is_debuff: bool) -> bool {
    if !is_debuff && o.disp != Disposition::Hostile {
        return false;
    }
    o.entity_key == entity_key || o.entity_key == "unknown-hostile"
}

/// …and the same union for an ACTIVE row. Nothing friendly can be on the thing you just killed.
pub fn death_censors_active(a: &ActiveBuff, a_key: &str, entity_key: &str) -> bool {
    if a.cls != BuffClass::Debuff && a.disposition != Some(Disposition::Hostile) {
        return false;
    }
    a_key == entity_key || a_key == "unknown-hostile" || a.inferred_target == Some(true)
}

/// A NAME THE WORLD HANDS OUT MORE THAN ONCE — the leading article, which is how EQ spells "one of
/// these" (`a rock golem`) as against an identity (`Cazic-Thule`, `Dread`). Read off the canonical
/// KEY, which is already lowercased at the boundary (world-model law 2).
pub fn is_article_named(entity_key: &str) -> bool {
    entity_key.starts_with("a ") || entity_key.starts_with("an ") || entity_key.starts_with("the ")
}

/// How much longer than the current estimate an ARTICLE-named mob's bound may claim.
pub const DEATH_BOUND_MAX_ESTIMATE_MULTIPLE: i64 = 2;
/// The absolute ceiling on any bound, as a multiple of the spell database's own duration.
pub const DEATH_BOUND_MAX_DB_MULTIPLE: i64 = 3;

/// THE DEATH LOWER BOUND (JOS-379, owner ruling 2026-08-15) — the span a corpse is allowed to teach,
/// or `None` when it teaches nothing.
///
/// A debuffed mob that DIES with no wear-off since its landing proves the debuff lasted AT LEAST
/// landing→corpse. The store has always discarded that span structurally, on the correct reasoning
/// that it is not a DURATION — and that reasoning stays correct. What it misses is that a MAX
/// estimator does not need a duration: a lower bound lifts the floor toward the truth and can never
/// lift it past, so long as the wear-off line is reliable when it does happen. Measured the night
/// before the report: five Togor's Insects cycles on rock golems, every one ended by its own
/// wear-off sentence at 2:20–2:29. The line is reliable; it simply never gets the chance on a raid
/// mob. `a dracoliche` was slowed at 22:38:54 and slain at 22:42:02 with no wear-off in between —
/// 3:08 of proof — while the app drew the classic-era database's 2:30 and the early-warning alert
/// announced the slow had worn off at 22:41:19.
///
/// THE FIVE RAILS, each of which refuses rather than guesses:
///
///  1. THE CHANNEL MUST BE WITNESSED. Silence is evidence only about a spell this log has actually
///     heard speak. Without it, "no wear-off printed" is a fact about the spell's messages and not
///     about its duration.
///  2. ONE LANDING ONLY. A corpse names a mob but never WHICH mob of that name, so with two landings
///     in the group the log does not say which one just died — and a wear-off may already have
///     closed the other.
///  3. IT MUST BEAT THE CURRENT ESTIMATE. A bound below what the app already draws is true and
///     useless.
///  4. THE SAME-NAME CAP. For an ARTICLE-named mob the span may not exceed twice the current
///     estimate: `a rock golem` that dies six minutes after a slow landed is far more likely to be a
///     DIFFERENT golem than a slow that ran four times its stated length. A proper name has no twin
///     and takes no such cap.
///  5. THE ABSOLUTE CAP. No bound may exceed three times what the spell database states, ever. With
///     no database row there is nothing to multiply and the bound is refused outright; that is a
///     stated limit, not an oversight.
///
/// AND AN OFFLINE GAP REFUSES IT: the wear-off sentence only exists while you are logged in, so
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

/// ZONE: the player keeps self buffs; a SUMMONED pet follows and keeps its buffs; a CHARMED pet is
/// LEFT BEHIND; hostile mobs are left behind.
pub fn open_left_behind_on_zone(o: &OpenCast) -> bool {
    match o.disp {
        Disposition::Zelf => false,
        // `isLeftBehindOnZone(kind) === kind !== 'summoned'`, applied to each.
        Disposition::Summoned => false,
        Disposition::Charmed => true,
        Disposition::Hostile => true,
    }
}

/// The long-stop retirement every instance has had since Task #33: 90 minutes, or twice what we know
/// about the spell, whichever is longer. It answers "we lost the thread", not "it expired".
pub fn hygiene_cap(a: &ActiveBuff, db_ms: Option<i64>) -> f64 {
    hygiene_cap_ms(a.p75, a.n).max(db_ms.map_or(0.0, |ms| 2.0 * ms as f64))
}

/// THE UNWITNESSED-EXPIRY CULL (JOS-140, widened by JOS-149, unified by JOS-156).
///
/// The owner's first case: slow a boss, then die. The wear-off line prints to a character who is not
/// there to receive it, so it never arrives and the bar squats at 0 s — for ninety minutes, under
/// the hygiene cap alone. A row whose countdown ran out and whose close was never witnessed is
/// culled after its own timeout instead. It mints NOTHING: an absence of evidence is not a
/// measurement.
///
/// ONE LINE DECIDES WHO IS EXEMPT, AND IT IS `self`, NOT `cls`. JOS-140 exempted the whole buffs
/// window, on the argument that a wear-off for a buff of yours is printed to YOU and that a
/// beneficial clock is PAUSED by an absence. Both halves of that are true of a SELF buff and neither
/// is true of a buff on somebody else: the pet fade line resolves against the CURRENT pet, so a row
/// bound to a pet that despawned can never be named by any later line, and a buff on an ally prints
/// nothing to you at all. The owner's screenshot is a pair of Focus Death rows at 0 s on two
/// long-dead pets, which the startup replay raised again on every launch.
///
/// A row with no number at all is counting UP, has nothing to be overdue against, and keeps the
/// hygiene cap. Nothing here reads a clock, so the cull is judged on the SAME `startedTs` the
/// countdown draws — which is what makes it respect the offline pause automatically.
pub fn unwitnessed_cull_cap(a: &ActiveBuff) -> f64 {
    if a.cls != BuffClass::Debuff && a.is_self {
        return f64::INFINITY;
    }
    match a.overlay_duration_ms {
        Some(dur) if dur > 0 => (dur + unwitnessed_timeout_ms(a.overlay_source)) as f64,
        // No number at all ⇒ the row is counting UP and has nothing to be overdue against.
        _ => f64::INFINITY,
    }
}

/// THE ORPHANED-RECORD REAPER (JOS-203) — the buffs half's half of the retention rule.
///
/// The hygiene sweep iterates the ACTIVE map, and its unwitnessed cull deletes the active row while
/// deliberately KEEPING the open record (JOS-156's refinement — the record is what lets a late
/// wear-off still mint a sample, and deleting it pinned the estimate to the DB floor forever). But
/// the long stop that would eventually collect that record is inside the same active loop, so once
/// the cull ran there was NO REAPER AT ALL. Two things follow, both measured: the map grows without
/// bound, and the next landing of that spell on a same-named mob finds the stale record and lands
/// into its stale group — so the row draws the ANCIENT landing's clock with the old count chip,
/// instantly overdue and culled again before the player can read it.
///
/// IT REAPS ONLY ORPHANS — a record with no active row behind it — on the SHARED schedule
/// (`learning_record_cap_ms`: 3× the DB base, or the 90-minute long stop when the DB states nothing
/// to multiply). It MINTS NOTHING and SAYS NOTHING: a reap is not an observation, and nothing in
/// either snapshot describes an open record, so the caller does not mark the model dirty for it.
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
            now - learning_record_cap_ms(stats.db_duration_for(&o.spell_key), HYGIENE_ABSOLUTE_MS)
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

/// DOES THIS LANDING NEVER EXPIRE (JOS-215, generalizing Task #34's illusion rule)?
///
/// TWO INDEPENDENT REASONS, both of which mean "no countdown, no duration sample, and no hygiene
/// retirement": the SPELL itself states `Permanent` (Yaulp, the Shielding ladder, the rogue blade
/// coats — 62 rows, every one of them Self), or a SELF illusion was cast at or after the Permanent
/// Illusion AA was owned.
///
/// BOTH ARE GATED ON `self`, and that is not an accident of the AA rule leaking into the new one.
/// All 62 permanent rows are `targetType: Self`, so a permanent landing on somebody else is a shape
/// the game does not print; if a re-scrape ever produces one, the honest answer is a normal count-up
/// row rather than an unkillable bar on an entity this model may lose track of.
///
/// THE FIVE ILLUSION PERMANENTS TAKE THE FIRST ARM, NOT THE SECOND. Lich, Call of Bones and the
/// three wolf forms are the intersection: permanent AND illusion-flagged. Before JOS-215 they were
/// permanent only if the AA had been PURCHASED, so without it they opened as ordinary count-up rows
/// and the 90-minute hygiene cap retired a form the player was still wearing.
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
