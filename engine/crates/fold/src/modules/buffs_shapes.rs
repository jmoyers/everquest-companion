//! `src/main/modules/buffsShapes.ts` — the shared vocabulary of the buffs model: the tuning
//! constants every part of it is calibrated against, the instance/cast record shapes, and the pure
//! helpers. Nothing here holds state.

use eqlog::names::spell_canon_key;

/// Land a pending cast this many ms after `castBegin` if nothing cleared it first.
pub const LAND_TIMEOUT_MS: i64 = 15_000;

/// Sanity ceiling on a mined duration sample. No EQ Legends buff lasts anywhere near this long, so
/// a land→fade gap beyond it is DEFINITIONALLY a missed censor and is DROPPED.
pub const MAX_SAMPLE_MS: i64 = 3 * 60 * 60_000;

/// LOG-HOLE boundary. An event-time gap of at least this means the character stopped producing log
/// lines for half an hour — a claim about the LOG, and not yet a claim about the world.
///
/// IT IS THE DROP THRESHOLD, NOT THE HOLD THRESHOLD (JOS-262). Half an hour is how long a log must
/// go quiet before an unexplained silence means we LOST THE THREAD and the pre-hole rows are
/// binned. The lighter question — should the hygiene sweep judge a row whose clock a pause may be
/// about to rewind — starts at the detector's own emit floor (60 s), because that is every absence
/// a pause can be reported for.
pub const SESSION_GAP_MS: i64 = 30 * 60_000;

/// THE UNWITNESSED-EXPIRY TIMEOUT — one rule for every row that is not yours (JOS-140 → 149 → 156,
/// owner ruling 2026-08-09 from live testing).
///
/// THE CASE, in the three forms the owner hit it in: you slow a boss and then die; a pet despawns
/// wearing a buff you cast on it; you cast Tashania on a mob and are killed eleven seconds later.
/// In every one the wear-off line is printed to somebody who is not there to receive it, so it
/// never arrives and the bar sits at 0 s. The timeout comes from the ESTIMATE'S QUALITY and from
/// nothing else: a learned duration ('observed'/'cluster') gets 15 s because the only thing left to
/// be late is the LINE; a DB floor gets 60 s, long enough for a line that is merely late and short
/// enough that a stale row is never a fixture of the window. 'deathBound' falls into the 60 s
/// branch by being neither — the number is a LOWER bound, so the true duration is known to be at
/// least that and may be more, and culling it on the learned schedule would retire a row we have
/// positive evidence is still running late.
///
/// A cull is NOT EVIDENCE: it mints no duration sample and counts as no break, because nothing was
/// observed. That is the whole difference between it and a wear-off.
pub fn unwitnessed_timeout_ms(source: Option<EstimatorSource>) -> i64 {
    match source {
        Some(EstimatorSource::Observed) | Some(EstimatorSource::Cluster) => 15_000,
        _ => 60_000,
    }
}

/// HOW LONG A LEARNING RECORD OUTLIVES THE ROW IT BELONGED TO — 3× THE DB BASE (JOS-203).
///
/// Two kinds of thing age on two different clocks. The DISPLAY grace above governs what is SHOWN.
/// What a cull leaves behind is a LEARNING RECORD — the buffs half's open cast, the CC half's
/// late-join memory — which exists for exactly one purpose: to be measurable if the line that ends
/// it does eventually print. Judging those on the display grace is judging them by the number that
/// is already too short.
///
/// THE FLOOR IS THE ONE NUMBER A BAD OBSERVATION CANNOT DRAG DOWN, which is why the window is a
/// multiple of IT rather than of the estimate — the estimate is what a run of break-shortened
/// cycles pulls under the true duration, so remembering on its schedule would be circular. Three of
/// them: past three times what the game's own data states, a line that has still not arrived is not
/// late — we lost the thread, and the record is a leak rather than a chance.
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

/// `f64` ALL THE WAY THROUGH, and it is not fussiness: `p75` is an interpolating percentile, so
/// `2 * p75` is routinely a half-millisecond, and JS compares that number against `now - startedTs`
/// without rounding it. A cap truncated to an integer here would retire a row one millisecond early
/// on exactly the long-duration buffs where the statistic beats the 90-minute floor.
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

/// Recency-weighted MAX window: estimate = MAX over the most recent K samples. Since JOS-180 it is
/// applied ONCE PER EVIDENCE CLASS — see `SpellStats::observed_window_max_for`.
pub const RECENT_SAMPLE_WINDOW: usize = 5;

/// THE BELOW-FLOOR OVERRULE (JOS-212, owner ruling 2026-08-12) — the two numbers that decide when
/// the app may believe its own stopwatch over the spell database.
///
/// The floor rests on ONE assumption: a beneficial buff's true duration is never below its DB base,
/// because AA and focus only EXTEND. That is a claim about the game the wiki describes; the
/// committed spells.json is a CLASSIC-ERA scrape and EQ Legends re-tiered spells, so for a real
/// population of rows the base is a wrong number — and because the estimator is a max, no amount of
/// evidence could ever move it.
///
/// Measured over the owner's whole log (1.59M lines, 66 learned rows, 20 below their floor) the two
/// populations SEPARATE on the spread of the top three clean cycles:
///
///   TIMERS RUNNING OUT   Celerity 0.3% · Feedback 1.3% · Alacrity 2.2% · Cajoling Whispers 2.3%
///                        · Beguile 7.4% · Charm 7.9% · Tashina 8.6%
///   ─────────── the gap the threshold sits in ───────────
///   BUFFS BEING CLICKED  Quickness 12.2% · Languid Pace 13.2% · Improved Invisibility 29.4%
///                        · Invisibility 161.4% · Invisibility Vs Undead 172.4%
///
/// So the spread is 10%: the empty middle of that measurement, not a round number somebody liked.
/// Three samples, because two agreeing cycles are also what two click-offs of the same habit look
/// like.
pub const BELOW_FLOOR_MIN_SAMPLES: usize = 3;
pub const BELOW_FLOOR_MAX_SPREAD: f64 = 0.1;

/// The relative spread of a set of samples: `(max - min) / min`. A RATIO, so one threshold serves a
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

/// THE CLUSTER TEST: given the CLEAN samples of one recency window, is the largest of them
/// corroborated well enough to overrule a DB floor?
///
/// THE SET TESTED IS THE TOP THREE BY VALUE, and the top always includes the number the app would
/// draw — so the rule reads as *the duration we are about to believe must be corroborated by the
/// next two longest clean cycles we have.* Shorter samples in the window are IGNORED rather than
/// counted against it, because a short cycle is exactly what an early termination is; demanding
/// that the click-offs agree too would make the rule unsatisfiable for the spells it exists for.
/// What a click-off habit cannot fake is three near-identical maxima.
pub fn corroborated_max(clean_window: &[i64]) -> Option<i64> {
    if clean_window.len() < BELOW_FLOOR_MIN_SAMPLES {
        return None;
    }
    let mut top: Vec<i64> = clean_window.to_vec();
    top.sort_unstable_by(|a, b| b.cmp(a));
    top.truncate(BELOW_FLOOR_MIN_SAMPLES);
    (relative_spread(&top) <= BELOW_FLOOR_MAX_SPREAD).then(|| top[0])
}

/// The activated-AA name whose burst of self-buff landing messages is trusted confident.
pub const QUICK_BUFF: &str = "quick buff";
/// How long after a Quick Buff activation its burst applies are attributed to it.
pub const QUICK_BUFF_WINDOW_MS: i64 = 5_000;

/// OWN-CAST landing window (Task #45). A message-driven apply is attributed to the player only when
/// their OWN `castBegin` of that spell landed within this window before the emote. Cast times run
/// up to ~8 s (Swift is 8 s) plus the short travel to the landing line, so a slightly generous
/// window avoids dropping real self/pet casts while still rejecting a stranger's buff.
pub const OWN_CAST_WINDOW_MS: i64 = 10_000;

/// The AA that makes self-cast illusion buffs PERMANENT (Task #34).
pub const PERMANENT_ILLUSION: &str = "permanent illusion";

/// The sentinel entity key for a buff on the PLAYER.
pub const SELF_KEY: &str = "self";
/// The sentinel caster key for your own cast — `shared/buffTrust.ts SELF_CASTER`.
pub const SELF_CASTER: &str = "self";

/// Instance-key separator: a NUL, which can never appear in a spell or entity name.
const SEP: char = '\0';

/// The instance key for a (spell, entity) pair — the buff-instance identity (Task #35).
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
/// These two are no longer the same string (JOS-140). A landing a Quick Buff burst admits but
/// cannot narrow is a FAMILY, and its row NAME is the joined candidate list (`Group Resist Magic /
/// Resist Magic`), which `spellCanonKey` would fold into gibberish. The instance is keyed on ONE
/// candidate's real line — the family agrees on nature and duration, which is the only reason it
/// was admitted at all — so anything asking "which spell is this row" must ask the KEY and never
/// re-derive it from what the row says.
pub fn instance_spell_key(i_key: &str) -> &str {
    match i_key.find(SEP) {
        Some(i) => &i_key[..i],
        None => i_key,
    }
}

/// `spellKey` — the canonical spell key (case-stable, RANK-STRIPPED). It is `spellCanonKey`, whose
/// rank tail is CASE-SENSITIVE — deliberately not the DB's own case-insensitive fold.
pub fn spell_key(s: &str) -> String {
    spell_canon_key(s)
}

/// `shared/buffTrust.ts learnKey` — one rank-stripped spell line, one caster. It lives apart from
/// the stats store so the two halves of the model cannot end up computing it differently, which is
/// precisely how the two systems JOS-140 unified drifted apart in the first place.
pub fn learn_key(line_key: &str, caster: &str) -> String {
    format!("{line_key}|{caster}")
}

/// `shared/buffTrust.ts casterKey` — a caster name folded to its comparison key (law 2).
pub fn caster_key(name: &str) -> String {
    eqlog::jsstr::js_trim(name).to_lowercase()
}

/// `casterTrusted` against the SHIPPED DEFAULT allowlist, which is EMPTY — you and nobody else.
/// `wiring.ts` only ever installs a non-default one from Preferences, which this world has none of;
/// stating it as a function rather than inlining `caster == "self"` keeps the shape of the question
/// visible for whoever wires the preference in.
pub fn caster_trusted(caster: &str) -> bool {
    let key = caster_key(caster);
    key == SELF_CASTER || key == "you"
}

/// `EstimatorSource` — which of the estimator's inputs produced the number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EstimatorSource {
    /// A clean observed cycle beat the DB floor.
    Observed,
    /// A corroborated below-floor cluster REMOVED the DB floor (JOS-212).
    Cluster,
    /// The DB floor held.
    Db,
    /// A death LOWER BOUND won (JOS-379) — the surfaces say "at least".
    DeathBound,
}

/// `BuffClass` — a SPELL property (JOS-140 ruling 8), never a fact about who it landed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuffClass {
    Buff,
    Debuff,
}

/// `EntityDisposition` — `combat/entityRules.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Disposition {
    #[serde(rename = "self")]
    Zelf,
    Summoned,
    Charmed,
    Hostile,
}

/// ONE MINED DURATION — a land→end span, the instant the line that ended it arrived, and whether
/// the log NAMED something that ended it early (JOS-180).
///
/// It used to be a bare number. The `ts` is what lets a line arriving AFTER the mint reach back and
/// annotate the sample it belongs to, which is the only order the game ever prints the pair in.
#[derive(Debug, Clone)]
pub struct DurationSample {
    pub ms: i64,
    /// Event ts of the line that closed the cycle — the join key for a later annotation.
    pub ts: i64,
    /// True when the log stated a CAUSE for the ending, so the span is a LOWER BOUND rather than
    /// the duration. One-way, like `Hold.clean`: evidence of doubt does not expire.
    pub censored: bool,
    /// A DEATH LOWER BOUND (JOS-379) — the one sample class that is not a cycle at all. NOTHING
    /// ENDED: the mob carrying this debuff died with it still on and no wear-off ever printed, so
    /// all the log states is that the spell lasted AT LEAST `ms`.
    pub death_bound: bool,
}

impl DurationSample {
    /// TRUE WHEN A SAMPLE IS A LOWER BOUND ON THE DURATION RATHER THAN A MEASUREMENT OF IT.
    ///
    /// Two ways the log produces one, and they are the same KIND of evidence from two directions: a
    /// cycle the log named a cause for ending early, and a cycle that never ended at all because
    /// its mob died first. Both prove the spell was still running at the instant they name and
    /// neither says when it would have stopped. Everything that treats the two windows differently
    /// reads THIS rather than either flag.
    pub fn is_lower_bound(&self) -> bool {
        self.censored || self.death_bound
    }
}

/// `percentile` over an ascending slice, with the TS's own linear interpolation.
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
        // Celerity's shape: three cycles within a fraction of a percent.
        assert_eq!(
            corroborated_max(&[901_000, 900_000, 902_000]),
            Some(902_000)
        );
        // …and one short click-off in the window neither corroborates nor breaks it.
        assert_eq!(
            corroborated_max(&[901_000, 12_000, 900_000, 902_000]),
            Some(902_000)
        );
        // Invisibility's shape: the top three disagree by more than 10%, so the floor holds.
        assert_eq!(corroborated_max(&[264_000, 101_000, 96_000]), None);
        // Two cycles are two click-offs of one habit.
        assert_eq!(corroborated_max(&[900_000, 901_000]), None);
    }

    /// The instance key is a NUL join, and both halves come back out of it.
    #[test]
    fn an_instance_key_splits_back_into_its_two_halves() {
        let k = instance_key("mesmerization", "a wan ghoul knight");
        assert_eq!(instance_spell_key(&k), "mesmerization");
        assert_eq!(instance_entity_key(&k), "a wan ghoul knight");
        // A key with no separator is a spell on YOU — the shape the TS falls back to.
        assert_eq!(instance_entity_key("clarity"), SELF_KEY);
        assert_eq!(instance_spell_key("clarity"), "clarity");
    }

    /// The percentile is the TS's interpolating one, so an even sample count lands between.
    #[test]
    fn the_percentile_interpolates_between_neighbours() {
        assert_eq!(percentile(&[1000, 2000], 0.5), 1500.0);
        assert_eq!(percentile(&[1000, 2000, 3000], 0.5), 2000.0);
        assert_eq!(percentile(&[], 0.5), 0.0);
        assert_eq!(percentile(&[7], 0.25), 7.0);
    }
}
