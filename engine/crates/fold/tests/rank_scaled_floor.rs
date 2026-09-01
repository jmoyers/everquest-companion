//! The rank-scaled DB floor, driven through the REAL committed spell catalog.
//!
//! It lives out here rather than beside the estimator because these cases need the whole catalog
//! load, and because the rule they pin is one a reader should be able to run on its own.

use fold::modules::buffs_shapes::{spell_key, DurationSample, EstimatorSource, SELF_CASTER};
use fold::modules::buffs_stats::SpellStats;
use fold::spell_facts::SpellFacts;

fn catalog() -> SpellStats {
    SpellStats::new(SpellFacts::project(&eqlog::spelldb::shared()))
}

fn clean(ms: i64, ts: i64) -> DurationSample {
    DurationSample {
        ms,
        ts,
        censored: false,
        death_bound: false,
    }
}

/// The floor a ranked cast stands on, and the two things it is not: the DB's own number, and a
/// claim a later cast of a lower rank can withdraw.
///
/// Odium is a 30 s base whose page states a curse counter and no damage line, so it takes the
/// conservative rate and the tick rounding: tier 10 is 45 s of entitlement and 42 s of clock.
#[test]
fn a_ranked_cast_line_grows_the_floor_and_a_lower_one_never_lowers_it() {
    let mut s = catalog();
    let key = spell_key("Odium");
    assert_eq!(s.floor_for(&key, SELF_CASTER), Some(30_000));
    s.note_cast_tier(&key, SELF_CASTER, "Odium X");
    assert_eq!(s.floor_for(&key, SELF_CASTER), Some(42_000));
    let est = s.estimate_for(&key, SELF_CASTER);
    assert_eq!(
        (est.ms, est.source),
        (Some(42_000), Some(EstimatorSource::Db))
    );
    s.note_cast_tier(&key, SELF_CASTER, "Odium III");
    assert_eq!(s.cast_tier(&key, SELF_CASTER), 10);
    // What the catalog STATES is unscaled, and stays the tab's `dbDurationMs`.
    assert_eq!(s.db_duration_for(&key), Some(30_000));
    // A rank one caster proved says nothing about anybody else's.
    assert_eq!(s.floor_for(&key, "someone else"), Some(30_000));
}

/// Only the floor moved: a clean cycle above it still wins outright, one below it still loses, and
/// a corroborated below-floor cluster still takes the grown floor down.
#[test]
fn the_learner_decides_everything_above_and_below_the_grown_floor() {
    let key = spell_key("Odium");
    let mut s = catalog();
    s.note_cast_tier(&key, SELF_CASTER, "Odium X");
    s.push_sample(&key, SELF_CASTER, "Odium", clean(20_000, 1));
    assert_eq!(s.estimate_for(&key, SELF_CASTER).ms, Some(42_000));
    s.push_sample(&key, SELF_CASTER, "Odium", clean(50_000, 2));
    let est = s.estimate_for(&key, SELF_CASTER);
    assert_eq!(
        (est.ms, est.source),
        (Some(50_000), Some(EstimatorSource::Observed))
    );

    let mut s = catalog();
    s.note_cast_tier(&key, SELF_CASTER, "Odium X");
    for (i, ms) in [36_000, 36_100, 35_900].iter().enumerate() {
        s.push_sample(&key, SELF_CASTER, "Odium", clean(*ms, i as i64));
    }
    let est = s.estimate_for(&key, SELF_CASTER);
    assert_eq!(
        (est.ms, est.source),
        (Some(36_100), Some(EstimatorSource::Cluster))
    );
}

/// A buff grows at twice a DoT's rate, holds no tick boundary, and an unranked cast is exactly the
/// base it always was.
#[test]
fn a_ranked_buff_grows_at_its_own_rate_and_an_unranked_one_not_at_all() {
    let mut s = catalog();
    let key = spell_key("Clarity");
    let base = s.db_duration_for(&key).expect("a catalogued duration");
    assert_eq!(s.floor_for(&key, SELF_CASTER), Some(base));
    s.note_cast_tier(&key, SELF_CASTER, "Clarity V");
    assert_eq!(s.floor_for(&key, SELF_CASTER), Some(base + base / 2));
}
