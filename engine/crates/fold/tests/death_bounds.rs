//! The death lower bound's two limits: it mints only off a LIVE row, and it never outranks a fade.
//!
//! Driven through the real instance store and the real committed catalog, because both rules are
//! about what the store's own bookkeeping — a culled row, a witnessed cycle — does to the estimator.

use fold::modules::buffs_entities::PetEntities;
use fold::modules::buffs_instances::{BuffInstances, LandingSpec};
use fold::modules::buffs_shapes::{instance_key, spell_key, EstimatorSource, SELF_CASTER};
use fold::modules::buffs_stats::SpellStats;
use fold::spell_facts::SpellFacts;

/// A slow with a 2 m 30 s base and a wear-off sentence: the owner's field case.
const SLOW: &str = "Shiftless Deeds";
/// The rank the owner casts, whose scaled floor is 210 s.
const SLOW_IV: &str = "Shiftless Deeds IV";
/// The mob of the field case: article-named, so the world hands the name out more than once.
const MOB: &str = "a rockhopper hatchling";

struct World {
    inst: BuffInstances,
    stats: SpellStats,
    pets: PetEntities,
}

impl World {
    /// A world that has HEARD this spell's wear-off sentence — rail 2 — and nothing else.
    fn new(spell: &str) -> Self {
        let mut stats = SpellStats::new(SpellFacts::project(&eqlog::spelldb::shared()));
        stats.witness_wear_off_channel(&spell_key(spell));
        World {
            inst: BuffInstances::new(),
            stats,
            pets: PetEntities::new(),
        }
    }

    fn land(&mut self, spell: &str, ranked: &str, mob: &str, ts: i64) {
        let key = spell_key(spell);
        let db_ms = self.stats.db_duration_for(&key);
        self.inst.apply_message_buff(
            spell,
            &LandingSpec {
                target: mob.to_string(),
                ts,
                illusion: false,
                duration_ms: db_ms,
                caster: None,
                line_key: Some(key),
                cast_name: Some(ranked.to_string()),
                candidates: None,
                permanent_illusion_owned_ts: None,
            },
            &mut self.stats,
            &mut self.pets,
        );
    }

    fn fade(&mut self, spell: &str, mob: &str, ts: i64) {
        let key = spell_key(spell);
        self.inst
            .record_fade(&key, mob, spell, ts, &mut self.stats, &self.pets);
    }

    fn death(&mut self, mob: &str, ts: i64) {
        self.inst
            .on_entity_death(mob, ts, &mut self.stats, &self.pets);
    }

    /// The unwitnessed cull, run from the store's own sweep: it takes the ROW and leaves the RECORD.
    fn sweep(&mut self, now: i64) {
        self.inst.sweep_hygiene(now, 0, &self.stats, &self.pets);
    }

    fn estimate(&self, spell: &str) -> (Option<i64>, Option<EstimatorSource>) {
        let est = self.stats.estimate_for(&spell_key(spell), SELF_CASTER);
        (est.ms, est.source)
    }

    fn row_lives(&self, spell: &str, mob: &str) -> bool {
        self.inst
            .active
            .contains_key(&instance_key(&spell_key(spell), mob))
    }

    fn record_lives(&self, spell: &str, mob: &str) -> bool {
        self.inst
            .open
            .contains_key(&instance_key(&spell_key(spell), mob))
    }
}

/// (a) The field case: a landing that never resolved, its row culled, and an unrelated same-named
/// corpse inside the record's retention window. The corpse teaches nothing.
///
/// Every rail the old model had admitted this span — one landing, a witnessed channel, above the
/// estimate, inside both caps — which is why the bar drew 6 m against a 3 m 30 s spell.
#[test]
fn a_corpse_arriving_after_the_cull_mints_no_bound() {
    let mut w = World::new(SLOW);
    w.land(SLOW, SLOW_IV, MOB, 0);
    assert_eq!(w.estimate(SLOW), (Some(210_000), Some(EstimatorSource::Db)));

    // Past the floor plus the 60 s unwitnessed grace: the row goes, the learning record stays.
    w.sweep(300_000);
    assert!(!w.row_lives(SLOW, MOB));
    assert!(w.record_lives(SLOW, MOB));

    w.death(MOB, 400_000);
    assert_eq!(w.estimate(SLOW), (Some(210_000), Some(EstimatorSource::Db)));
    // The censor's other duties are untouched: the record's one landing was closed with it.
    assert!(!w.record_lives(SLOW, MOB));
}

/// (a, second half) The record keeps every duty it had; only the MINT gained a liveness test.
///
/// The one purpose a record outlives its row for is the late wear-off LINE, and that still mints
/// (first world). A corpse still closes a landing and still leaves what survives unmeasurable
/// (second world, whose same-second round is the only shape a hostile group holds two landings in).
#[test]
fn a_culled_record_still_closes_and_still_catches_its_late_line() {
    let mut w = World::new(SLOW);
    w.land(SLOW, SLOW_IV, MOB, 0);
    w.sweep(300_000);
    assert!(!w.row_lives(SLOW, MOB));
    w.fade(SLOW, MOB, 400_000);
    assert_eq!(
        w.estimate(SLOW),
        (Some(400_000), Some(EstimatorSource::Observed))
    );

    let mut c = World::new(SLOW);
    c.land(SLOW, SLOW_IV, MOB, 0);
    c.land(SLOW, SLOW_IV, MOB, 0);
    c.sweep(300_000);
    assert!(!c.row_lives(SLOW, MOB));

    c.death(MOB, 400_000);
    // One of the two landings was closed by the corpse; the other is still on the books.
    assert!(c.record_lives(SLOW, MOB));
    c.fade(SLOW, MOB, 410_000);
    assert!(!c.record_lives(SLOW, MOB));
    assert_eq!(c.estimate(SLOW), (Some(210_000), Some(EstimatorSource::Db)));
}

/// (b) A death while the row is still live mints exactly as it always did.
#[test]
fn a_death_under_a_live_row_still_mints_its_bound() {
    let mut w = World::new(SLOW);
    w.land(SLOW, SLOW_IV, MOB, 0);
    assert!(w.row_lives(SLOW, MOB));
    w.death(MOB, 400_000);
    assert_eq!(
        w.estimate(SLOW),
        (Some(400_000), Some(EstimatorSource::DeathBound))
    );
}

/// (c) A witnessed clean fade is a ceiling: a live-row bound far above it reads as the fade.
///
/// The bound is still stored at the span the corpse measured — only the estimator's read is capped —
/// and the label the log earned wins the tie, so the row reports `Observed` and not `DeathBound`.
#[test]
fn a_witnessed_fade_caps_what_a_bound_may_contribute() {
    let mut w = World::new(SLOW);
    for i in 0..3 {
        let land = i * 500_000;
        w.land(SLOW, SLOW_IV, MOB, land);
        w.fade(SLOW, MOB, land + 233_000);
    }
    assert_eq!(
        w.estimate(SLOW),
        (Some(233_000), Some(EstimatorSource::Observed))
    );

    w.land(SLOW, SLOW_IV, MOB, 2_000_000);
    assert!(w.row_lives(SLOW, MOB));
    w.death(MOB, 2_400_000);
    assert_eq!(
        w.estimate(SLOW),
        (Some(233_000), Some(EstimatorSource::Observed))
    );
}

/// (d) With no clean fade in the window a bound is the only evidence there is, and keeps its reach.
///
/// The DoT-starvation shape: Odium's 30 s floor lifted to a 34 s bound by a corpse, which is the
/// behaviour the cap must not take away.
#[test]
fn with_no_fade_witnessed_a_bound_still_lifts_the_floor() {
    let mut w = World::new("Odium");
    w.land("Odium", "Odium", MOB, 0);
    assert_eq!(
        w.estimate("Odium"),
        (Some(30_000), Some(EstimatorSource::Db))
    );
    w.death(MOB, 34_000);
    assert_eq!(
        w.estimate("Odium"),
        (Some(34_000), Some(EstimatorSource::DeathBound))
    );
}

/// (e) The owner's numbers, end to end: a 210 s rank-scaled floor, cycles measuring 233-239 s, and
/// a stale record whose corpse used to draw 6 m. The estimate never leaves the range the log states.
#[test]
fn the_field_case_numbers_stay_inside_what_the_log_measured() {
    let mut w = World::new(SLOW);
    w.land(SLOW, SLOW_IV, MOB, 0);
    assert_eq!(w.estimate(SLOW), (Some(210_000), Some(EstimatorSource::Db)));
    w.fade(SLOW, MOB, 233_000);

    for (i, ms) in [236_000_i64, 239_000].iter().enumerate() {
        let land = 500_000 * (i as i64 + 1);
        w.land(SLOW, SLOW_IV, MOB, land);
        w.fade(SLOW, MOB, land + ms);
    }
    assert_eq!(
        w.estimate(SLOW),
        (Some(239_000), Some(EstimatorSource::Observed))
    );

    // The ghost: a landing that never resolved, culled, then an unrelated corpse of the same name.
    w.land(SLOW, SLOW_IV, MOB, 2_000_000);
    w.sweep(2_300_000);
    assert!(!w.row_lives(SLOW, MOB));
    w.death(MOB, 2_380_000);
    assert_eq!(
        w.estimate(SLOW),
        (Some(239_000), Some(EstimatorSource::Observed))
    );

    // And a live-row corpse of the same span is capped rather than refused — still 239 s.
    w.land(SLOW, SLOW_IV, MOB, 3_000_000);
    w.death(MOB, 3_380_000);
    assert_eq!(
        w.estimate(SLOW),
        (Some(239_000), Some(EstimatorSource::Observed))
    );
}
