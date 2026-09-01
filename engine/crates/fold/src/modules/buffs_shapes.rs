//! The shared vocabulary of the buffs model: the tuning constants every part of it is calibrated
//! against, the record shapes, and the pure helpers. Nothing here holds state.

use crate::jsfn::parse_spell_rank;
use crate::spell_facts::DurationCategory;
use eqlog::names::spell_canon_key;

/// The EQ tick — the quantum a damage- or heal-over-time duration is actually served in.
const TICK_MS: i64 = 6_000;

/// Duration growth per upgrade tier, in percent, applied ADDITIVELY.
/// Source: <https://eqlwiki.com/Spell_Upgrade_System> — DoT/HoT +5%, buffs +10%, debuffs +10%,
/// crowd control "+5-10%?", proc-buff duration unstated.
///
/// Where the wiki is unsure the conservative end is taken, because the two errors are not
/// symmetric: an undershot floor is beaten by ONE clean sample, while an overshot one needs three
/// corroborated below-floor cycles to come down. Same reason an `Unstated` row takes 5.
fn rank_scale_pct(cat: DurationCategory) -> i64 {
    match cat {
        DurationCategory::Buff | DurationCategory::Debuff => 10,
        DurationCategory::DotHot | DurationCategory::CrowdControl | DurationCategory::Unstated => 5,
        DurationCategory::ProcBuff => 0,
    }
}

/// The DB floor a cast at `tier` is entitled to: the base grown by the table above, tick-quantized
/// DOWN for a DoT or HoT, and never below the base — scaling only ever raises. Tier 0 is the base
/// unchanged, so an unranked cast is byte-identical to what it was.
///
/// An `Unstated` row quantizes too: it may well BE a DoT, and rounding down to a tick can only
/// lower the floor, which is the side of the error that costs one clean sample instead of three.
pub fn scaled_floor_ms(db_ms: i64, cat: DurationCategory, tier: i64) -> i64 {
    if tier <= 0 || db_ms <= 0 {
        return db_ms;
    }
    let raised = db_ms + db_ms * tier * rank_scale_pct(cat) / 100;
    let served = if matches!(cat, DurationCategory::DotHot | DurationCategory::Unstated) {
        raised - raised % TICK_MS
    } else {
        raised
    };
    served.max(db_ms)
}

/// The upgrade tier a name states: its roman numeral, or 0 when it carries none. Rank I is tier 1,
/// so an unsuffixed name is the base tier and never a claim about an upgrade.
pub fn tier_of(name: &str) -> i64 {
    let parsed = parse_spell_rank(name);
    if parsed.suffixed {
        parsed.rank
    } else {
        0
    }
}

/// Land a pending cast this many ms after `castBegin` if nothing cleared it first.
pub const LAND_TIMEOUT_MS: i64 = 15_000;

/// Sanity ceiling on a mined duration sample. No EQ Legends buff lasts anywhere near this long, so
/// a land→fade gap beyond it is definitionally a missed censor and is dropped.
pub const MAX_SAMPLE_MS: i64 = 3 * 60 * 60_000;

/// Log-hole boundary: an event-time gap of at least this means the character stopped producing log
/// lines for half an hour — a claim about the LOG, and not yet a claim about the world.
///
/// It is the DROP threshold, not the HOLD threshold. The lighter question — should the hygiene sweep
/// judge a row whose clock a pause may be about to rewind — starts at the detector's own emit floor
/// of 60 s, because that is every absence a pause can be reported for.
pub const SESSION_GAP_MS: i64 = 30 * 60_000;

/// The unwitnessed-expiry timeout — one rule for every row that is not yours.
///
/// When you die with a slow on a boss, or a pet despawns wearing a buff you cast, the wear-off line
/// is printed to somebody who is not there to receive it, so it never arrives and the bar sits at
/// 0 s. The timeout comes from the ESTIMATE'S QUALITY and nothing else: a learned duration gets 15 s
/// because the only thing left to be late is the LINE, and a DB floor gets 60 s, long enough for a
/// merely late line and short enough that a stale row is never a fixture of the window. A death
/// bound takes the 60 s branch by being neither — it is a LOWER bound, so culling it on the learned
/// schedule would retire a row we have positive evidence is still running. A rank-scaled floor is
/// still a floor and reports `Db`, so it keeps the 60 s grace: the rank raised the number, not its
/// quality.
///
/// A cull is not evidence: it mints no sample and counts as no break, because nothing was observed.
pub fn unwitnessed_timeout_ms(source: Option<EstimatorSource>) -> i64 {
    match source {
        Some(EstimatorSource::Observed) | Some(EstimatorSource::Cluster) => 15_000,
        _ => 60_000,
    }
}

/// How long a learning record outlives the row it belonged to — 3x the DB FLOOR, which is the
/// rank-scaled one. Sizing an upgraded spell's memory off the unscaled base would retire the record
/// before the late line it exists to catch can arrive; the floor is still observation-proof either
/// way, which is the property the multiple is chosen for.
///
/// Two things age on two clocks. The display grace above governs what is SHOWN; what a cull leaves
/// behind is a LEARNING RECORD, which exists only to be measurable if the line that ends it does
/// eventually print, so judging it on the display grace judges it by a number already too short.
///
/// The multiple is of the DB FLOOR rather than of the estimate, because the floor is the one number
/// a bad observation cannot drag down — the estimate is what a run of break-shortened cycles pulls
/// under the true duration, so remembering on its schedule would be circular.
pub const LEARNING_RECORD_DB_MULTIPLE: i64 = 3;

pub fn learning_record_cap_ms(db_ms: Option<i64>, unknown_cap_ms: i64) -> i64 {
    match db_ms {
        Some(ms) if ms > 0 => LEARNING_RECORD_DB_MULTIPLE * ms,
        _ => unknown_cap_ms,
    }
}

/// Active-buff HYGIENE cap. An active past this auto-retires — it answers "we lost the thread",
/// never "it expired".
pub const HYGIENE_ABSOLUTE_MS: i64 = 90 * 60_000;

/// `f64` all the way through, and not out of fussiness: `p75` is an interpolating percentile, so
/// `2 * p75` is routinely a half-millisecond. A cap truncated to an integer would retire a row one
/// millisecond early on exactly the long buffs where the statistic beats the 90-minute floor.
pub fn hygiene_cap_ms(p75: Option<f64>, n: i64) -> f64 {
    let stat = match p75 {
        Some(v) if n >= 2 => 2.0 * v,
        _ => 0.0,
    };
    stat.max(HYGIENE_ABSOLUTE_MS as f64)
}

/// Window after a `castBegin` within which a landing emote is attributed to that cast.
pub const EMOTE_WINDOW_MS: i64 = 5_000;
/// How many times an emote TEXT must appear adjacent to a cast before it is TRUSTED.
pub const EMOTE_MIN_OBSERVATIONS: i64 = 2;

/// Recency-weighted MAX window: estimate = max over the most recent K samples, applied once per
/// evidence class — see `SpellStats::observed_window_max_for`.
pub const RECENT_SAMPLE_WINDOW: usize = 5;

/// The below-floor overrule: when the app may believe its own stopwatch over the spell database.
///
/// The floor rests on one assumption — a beneficial buff's true duration is never below its DB base,
/// because AA and focus only extend. The committed spells.json is a classic-era scrape and EQ
/// Legends re-tiered spells, so for a real population of rows the base is simply wrong, and because
/// the estimator is a max no amount of evidence could ever move it.
///
/// Measured over the owner's whole log (66 learned rows, 20 below their floor), the two populations
/// separate on the spread of the top three clean cycles: timers genuinely running out sit under 9%,
/// buffs being clicked off sit above 12%. So the threshold is the empty middle at 10%, over three
/// samples — two agreeing cycles are also what two click-offs of one habit look like.
pub const BELOW_FLOOR_MIN_SAMPLES: usize = 3;
pub const BELOW_FLOOR_MAX_SPREAD: f64 = 0.1;

/// The relative spread of a set of samples: `(max - min) / min`. A ratio, so one threshold serves a
/// 44-second mez and a 27-minute invisibility.
pub fn relative_spread(ms: &[i64]) -> f64 {
    let Some(&first) = ms.first() else {
        return 0.0;
    };
    let mut lo = first;
    let mut hi = first;
    for &v in ms {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    if lo > 0 {
        (hi - lo) as f64 / lo as f64
    } else {
        f64::INFINITY
    }
}

/// The cluster test: given the CLEAN samples of one recency window, is the largest of them
/// corroborated well enough to overrule a DB floor?
///
/// The set tested is the top three by VALUE, so the rule reads as "the duration we are about to
/// believe must be corroborated by the next two longest clean cycles we have". Shorter samples in
/// the window are ignored rather than counted against it, because a short cycle is exactly what an
/// early termination is — demanding that the click-offs agree too would make the rule unsatisfiable
/// for the spells it exists for. What a click-off habit cannot fake is three near-identical maxima.
pub fn corroborated_max(clean_window: &[i64]) -> Option<i64> {
    if clean_window.len() < BELOW_FLOOR_MIN_SAMPLES {
        return None;
    }
    let mut top: Vec<i64> = clean_window.to_vec();
    top.sort_unstable_by(|a, b| b.cmp(a));
    top.truncate(BELOW_FLOOR_MIN_SAMPLES);
    (relative_spread(&top) <= BELOW_FLOOR_MAX_SPREAD).then(|| top[0])
}

/// The activated AA whose burst of self-buff landing messages is trusted.
pub const QUICK_BUFF: &str = "quick buff";
/// How long after a Quick Buff activation its burst applies are attributed to it.
pub const QUICK_BUFF_WINDOW_MS: i64 = 5_000;

/// Own-cast landing window: a message-driven apply is attributed to the player only when their own
/// cast of that spell began within this window before the emote. Cast times run up to about 8 s plus
/// travel to the landing line, so a slightly generous window avoids dropping real self and pet casts
/// while still rejecting a stranger's buff.
pub const OWN_CAST_WINDOW_MS: i64 = 10_000;

/// The AA that makes self-cast illusion buffs permanent.
pub const PERMANENT_ILLUSION: &str = "permanent illusion";

/// The sentinel entity key for a buff on the PLAYER.
pub const SELF_KEY: &str = "self";
/// The sentinel caster key for your own cast.
pub const SELF_CASTER: &str = "self";

/// Instance-key separator: a NUL, which can never appear in a spell or entity name.
const SEP: char = '\0';

/// The instance key for a (spell, entity) pair — the buff-instance identity.
pub fn instance_key(spell_key_of: &str, entity_key: &str) -> String {
    format!("{spell_key_of}{SEP}{entity_key}")
}

/// Extract the entity key from an instance key.
pub fn instance_entity_key(i_key: &str) -> &str {
    match i_key.find(SEP) {
        Some(i) => &i_key[i + 1..],
        None => SELF_KEY,
    }
}

/// Extract the SPELL LINE key from an instance key — the identity, as opposed to the display name.
///
/// The two are not the same string. A landing a Quick Buff burst admits but cannot narrow is a
/// FAMILY whose row name is the joined candidate list, which [`spell_key`] would fold into
/// gibberish; the instance is keyed on one candidate's real line instead. So anything asking "which
/// spell is this row" must ask the KEY and never re-derive it from what the row says.
pub fn instance_spell_key(i_key: &str) -> &str {
    match i_key.find(SEP) {
        Some(i) => &i_key[..i],
        None => i_key,
    }
}

/// The canonical spell key: case-stable and RANK-STRIPPED, with a case-sensitive rank tail —
/// deliberately not the DB's own case-insensitive fold.
pub fn spell_key(s: &str) -> String {
    spell_canon_key(s)
}

/// The learner's key: one rank-stripped spell line, one caster. It lives apart from the stats store
/// so the two halves of the model cannot end up computing it differently.
pub fn learn_key(line_key: &str, caster: &str) -> String {
    format!("{line_key}|{caster}")
}

/// A caster name folded to its comparison key.
pub fn caster_key(name: &str) -> String {
    eqlog::jsstr::js_trim(name).to_lowercase()
}

/// Trusted against the DEFAULT allowlist, which is empty — you and nobody else. Stated as a function
/// rather than inlined so the shape of the question stays visible.
pub fn caster_trusted(caster: &str) -> bool {
    let key = caster_key(caster);
    key == SELF_CASTER || key == "you"
}

/// Which of the estimator's inputs produced the number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EstimatorSource {
    /// A clean observed cycle beat the DB floor.
    Observed,
    /// A corroborated below-floor cluster removed the DB floor.
    Cluster,
    /// The DB floor held.
    Db,
    /// A death LOWER BOUND won — the surfaces say "at least".
    DeathBound,
}

/// A SPELL property, never a fact about who the spell landed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuffClass {
    Buff,
    Debuff,
}

/// An entity's disposition toward the player.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Disposition {
    #[serde(rename = "self")]
    Zelf,
    Summoned,
    Charmed,
    Hostile,
}

/// One mined duration: a land→end span, the instant the line that ended it arrived, and whether the
/// log named something that ended it early. The `ts` is what lets a line arriving AFTER the mint
/// reach back and annotate the sample it belongs to, which is the only order the game prints them in.
#[derive(Debug, Clone)]
pub struct DurationSample {
    pub ms: i64,
    /// Event ts of the line that closed the cycle — the join key for a later annotation.
    pub ts: i64,
    /// True when the log stated a CAUSE for the ending, so the span is a lower bound rather than the
    /// duration. One-way, like `Hold.clean`: evidence of doubt does not expire.
    pub censored: bool,
    /// A death lower bound — the one sample class that is not a cycle at all. Nothing ended: the mob
    /// carrying this debuff died with it still on and no wear-off ever printed, so all the log
    /// states is that the spell lasted AT LEAST `ms`.
    pub death_bound: bool,
}

impl DurationSample {
    /// True when a sample is a LOWER BOUND on the duration rather than a measurement of it.
    ///
    /// The log produces one two ways, and they are the same kind of evidence from two directions: a
    /// cycle the log named a cause for ending early, and a cycle that never ended at all because its
    /// mob died first. Both prove the spell was still running at the instant they name and neither
    /// says when it would have stopped. Everything treating the two windows differently reads this
    /// rather than either flag.
    pub fn is_lower_bound(&self) -> bool {
        self.censored || self.death_bound
    }
}

/// Percentile over an ascending slice, with linear interpolation between neighbours.
pub fn percentile(sorted_asc: &[i64], p: f64) -> f64 {
    if sorted_asc.is_empty() {
        return 0.0;
    }
    if sorted_asc.len() == 1 {
        return sorted_asc[0] as f64;
    }
    let idx = (sorted_asc.len() - 1) as f64 * p;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        return sorted_asc[lo] as f64;
    }
    let frac = idx - lo as f64;
    sorted_asc[lo] as f64 * (1.0 - frac) + sorted_asc[hi] as f64 * frac
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cluster rule reads the top three by VALUE and ignores everything shorter, which is what
    /// makes it satisfiable for a spell whose habit is being clicked off.
    #[test]
    fn a_corroborated_cluster_is_three_agreeing_maxima() {
        // Three cycles within a fraction of a percent.
        assert_eq!(
            corroborated_max(&[901_000, 900_000, 902_000]),
            Some(902_000)
        );
        // One short click-off in the window neither corroborates nor breaks it.
        assert_eq!(
            corroborated_max(&[901_000, 12_000, 900_000, 902_000]),
            Some(902_000)
        );
        // The top three disagreeing by more than 10% leaves the floor standing.
        assert_eq!(corroborated_max(&[264_000, 101_000, 96_000]), None);
        // Two cycles are two click-offs of one habit.
        assert_eq!(corroborated_max(&[900_000, 901_000]), None);
    }

    /// Tier 0 is the base untouched, which is what keeps every unranked cast exactly where it was.
    #[test]
    fn an_unranked_cast_stands_on_the_base_duration() {
        assert_eq!(scaled_floor_ms(30_000, DurationCategory::DotHot, 0), 30_000);
        assert_eq!(scaled_floor_ms(30_000, DurationCategory::Buff, 0), 30_000);
        assert_eq!(tier_of("Odium"), 0);
        assert_eq!(tier_of("Odium X"), 10);
        assert_eq!(tier_of("Mesmerization VII"), 7);
        // A ` +N` item level is not a rank.
        assert_eq!(tier_of("Cloak of Flames +4"), 0);
    }

    /// A DoT grows 5% a tier and is served in whole ticks: the 30 s base at tier 10 is 45 s of
    /// entitlement and 42 s of clock.
    #[test]
    fn a_ranked_dot_floor_is_grown_then_quantized_down() {
        assert_eq!(
            scaled_floor_ms(30_000, DurationCategory::DotHot, 10),
            42_000
        );
        assert_eq!(scaled_floor_ms(30_000, DurationCategory::DotHot, 4), 36_000);
        // Quantization may never push the floor under the base it started from.
        assert_eq!(scaled_floor_ms(10_000, DurationCategory::DotHot, 1), 10_000);
    }

    /// Buffs and debuffs grow twice as fast, hold no tick boundary, and a proc buff's duration does
    /// not grow at all.
    #[test]
    fn the_other_categories_take_their_own_rate() {
        assert_eq!(
            scaled_floor_ms(1_620_000, DurationCategory::Buff, 10),
            3_240_000
        );
        assert_eq!(scaled_floor_ms(24_000, DurationCategory::Debuff, 5), 36_000);
        // Crowd control takes the conservative end of the wiki's "+5-10%?".
        assert_eq!(
            scaled_floor_ms(24_000, DurationCategory::CrowdControl, 5),
            30_000
        );
        // An undescribed row takes the conservative rate AND the tick rounding, because it may be a
        // DoT the wiki page never wrote the damage line for.
        assert_eq!(
            scaled_floor_ms(24_000, DurationCategory::Unstated, 5),
            30_000
        );
        assert_eq!(
            scaled_floor_ms(30_000, DurationCategory::Unstated, 10),
            42_000
        );
        assert_eq!(
            scaled_floor_ms(1_200_000, DurationCategory::ProcBuff, 10),
            1_200_000
        );
    }

    /// The instance key is a NUL join, and both halves come back out of it.
    #[test]
    fn an_instance_key_splits_back_into_its_two_halves() {
        let k = instance_key("mesmerization", "a wan ghoul knight");
        assert_eq!(instance_spell_key(&k), "mesmerization");
        assert_eq!(instance_entity_key(&k), "a wan ghoul knight");
        // A key with no separator is a spell on YOU.
        assert_eq!(instance_entity_key("clarity"), SELF_KEY);
        assert_eq!(instance_spell_key("clarity"), "clarity");
    }

    /// The percentile interpolates, so an even sample count lands between neighbours.
    #[test]
    fn the_percentile_interpolates_between_neighbours() {
        assert_eq!(percentile(&[1000, 2000], 0.5), 1500.0);
        assert_eq!(percentile(&[1000, 2000, 3000], 0.5), 2000.0);
        assert_eq!(percentile(&[], 0.5), 0.0);
        assert_eq!(percentile(&[7], 0.25), 7.0);
    }
}
