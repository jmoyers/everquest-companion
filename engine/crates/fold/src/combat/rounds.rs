//! ATTACK-ROUND STRUCTURE — the pure grouper behind the Rounds panel (`src/main/combat/rounds.ts`).
//!
//! COUNTS ONLY. Nothing here ever stores or returns a damage amount as a STAT, so every damage total
//! in the engine stays byte-identical (world-model law 8's tripwire). Amounts are read for exactly
//! one purpose — the fan-out signature below — and discarded.
//!
//! ── WHAT A "ROUND" IS, AND WHY IT NEEDS A GROUPER ─────────────────────────────────────────────
//!
//! EQ Legends ANNOTATES riposte, flurry and rampage swings and says NOTHING about double or triple
//! attack (full-log sweep, 1.35M lines: zero annotations against thousands of measured multi-swing
//! seconds). So a round is a proxy, and the honest one is:
//!
//!   one round = the swings ONE attacker made with ONE verb, at ONE target, in ONE second.
//!
//! THE FAN-OUT HAZARD is why the per-TARGET part is not a refinement but the difference between a
//! right answer and a wrong one. Backstab has a ~10 s reuse timer, so four backstabs in one second is
//! mechanically impossible — and the log contains exactly five such seconds, every one of them two
//! targets carrying the SAME ordered damage sequence: one double-attack round FANNED across two
//! defenders and printed twice. Counting per-target alone reports two 2-swing rounds; not grouping by
//! target at all reports one 4-swing round, which the reuse timer forbids. Collapsing equal sequences
//! reports what happened: one 2-swing round. (One of the five carries a `(Critical)` on only ONE of
//! the two copies, which is why the signature is over AMOUNTS and never over modifiers.)
//!
//! ── WHAT IS EXCLUDED, AND WHY ────────────────────────────────────────────────────────────────
//!
//! A round answers "how many swings did one attack get me", so three annotated families that are
//! EXTRA swings by definition are counted separately and never entered into one: Riposte (a counter
//! granted by the defender's attack), Flurry (extra primary swings after a triple) and Rampage.
//! Frenzy is excluded on the same logic without needing an annotation — it is a multi-hit skill BY
//! DESIGN, so its swings-per-round distribution measures the skill rather than multi-attack.
//!
//! ── WHAT THIS CANNOT SAY (law 6) ─────────────────────────────────────────────────────────────
//!
//! DUAL WIELD puts two weapons on ONE verb, so a same-second 2x on `slash` may be two hands rather
//! than a double attack and no line distinguishes them. Reuse-timer skills have no such confound —
//! one timer, one hand. That split is the whole content of `round_confidence`.

use crate::jsmap::JsMap;

/// How many swing buckets a lane reports: 1, 2, 3, and a 4+ tail.
pub const ROUND_BUCKETS: usize = 4;

/// Why a swing was kept out of round counting — reported so the denominator is never silent. The
/// discriminant IS the serialized field order (`frenzy`, `riposte`, `flurry`, `rampage`), which is
/// the order `excluded` is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundExclusion {
    Frenzy,
    Riposte,
    Flurry,
    Rampage,
}

impl RoundExclusion {
    fn slot(self) -> usize {
        self as usize
    }
}

/// Verbs driven by a REUSE TIMER rather than by a weapon in a hand. HAND-AUTHORED and
/// evidence-verified: a matcher would happily promote a weapon verb into the confident tier.
/// `backstab` (~10 s timer, in-log confirmed), `bash` / `kick` (shield and kick lanes, wiki-stated
/// timers, and `kick` additionally carries the special-attack lane) and `strike` (the monk special
/// lane — one ability, one timer, and the verb is exclusive to it). Everything else is a WEAPON verb.
const REUSE_TIMER_VERBS: [&str; 4] = ["backstab", "bash", "kick", "strike"];

/// The confidence tier for a verb's multi-swing reading. PURE.
pub fn round_confidence(verb: &str) -> &'static str {
    let lower = verb.to_lowercase();
    if REUSE_TIMER_VERBS.contains(&lower.as_str()) {
        "perEvent"
    } else {
        "aggregate"
    }
}

/// Verbs that never enter round counting: multi-hit by design. `flurry` is here as a VERB too — the
/// parser recognizes `You flurry …` as its own melee verb, and a swing that prints under it is the
/// same extra swing the `(Flurry)` annotation marks.
fn excluded_verb(verb_lower: &str) -> Option<RoundExclusion> {
    match verb_lower {
        "frenzy" => Some(RoundExclusion::Frenzy),
        "flurry" => Some(RoundExclusion::Flurry),
        _ => None,
    }
}

/// Base modifiers that mark a swing as an EXTRA swing rather than part of an attack round. Keyed
/// lowercase; the parser has already decomposed every compound form before anything here sees it.
fn extra_swing_mod(m_lower: &str) -> Option<RoundExclusion> {
    match m_lower {
        "riposte" => Some(RoundExclusion::Riposte),
        "flurry" => Some(RoundExclusion::Flurry),
        "rampage" => Some(RoundExclusion::Rampage),
        _ => None,
    }
}

/// Why a swing is not part of an attack round, or `None` when it is one. PURE.
///
/// `verb_lower` is the caller's already-lowercased verb: `RoundAccum::add` needs the same string a
/// statement later, and lowercasing it twice per swing on a 1.4M-event fold is a measurable cost for
/// no meaning.
pub fn round_exclusion<S: AsRef<str>>(verb_lower: &str, modifiers: &[S]) -> Option<RoundExclusion> {
    if let Some(why) = excluded_verb(verb_lower) {
        return Some(why);
    }
    for m in modifiers {
        if let Some(why) = extra_swing_mod(&m.as_ref().to_lowercase()) {
            return Some(why);
        }
    }
    None
}

/// One logged swing ATTEMPT, reduced to what round structure needs. Landed and avoided swings both
/// arrive here: a round is swings ATTEMPTED, and a double attack whose second swing missed is still a
/// double attack.
///
/// THE MODIFIER LIST IS ELEMENT-GENERIC (JOS-506), defaulting to the `String` the miss path still
/// carries. The damage path's modifiers are now borrowed slices of the parser's own buffers, and the
/// miss path's are still owned — one generic parameter lets both feed this without either side
/// allocating a list to satisfy the other's spelling.
pub struct SwingRecord<'a, S: AsRef<str> = String> {
    pub ts: i64,
    /// Un-conjugated melee verb (`slash`, `backstab`) — the ROUND identity.
    pub verb: &'a str,
    /// Display lane name (special-attack renamed); labels the row only.
    pub skill: &'a str,
    /// The defender, as the line named it. Case-folded by the accumulator (law 2).
    pub target: &'a str,
    /// Landed amount, or 0 for an avoided swing. Used ONLY for the fan-out signature.
    pub amount: i64,
    pub avoided: bool,
    pub modifiers: &'a [S],
}

/// The bucket index (0-based) for a round of `swings` swings; the last bucket is 4+.
fn round_bucket(swings: usize) -> usize {
    swings.clamp(1, ROUND_BUCKETS) - 1
}

/// The finalized per-verb round counters for one source.
#[derive(Debug, Clone)]
pub struct RoundLaneTally {
    pub verb: String,
    /// Display label — the special-attack lane name when the log named one, else the verb.
    pub skill: String,
    /// `buckets[i]` = rounds with exactly `i + 1` swings; the last bucket is 4-or-more.
    pub buckets: [i64; ROUND_BUCKETS],
    pub rounds: i64,
    pub multi_rounds: i64,
    /// Rounds printed against more than one defender (a collapsed fan-out).
    pub fanned_rounds: i64,
}

fn new_lane(verb: &str, skill: &str) -> RoundLaneTally {
    RoundLaneTally {
        verb: verb.to_string(),
        skill: skill.to_string(),
        buckets: [0; ROUND_BUCKETS],
        rounds: 0,
        multi_rounds: 0,
        fanned_rounds: 0,
    }
}

/// A per-target swing sequence being assembled for one (verb, second).
///
/// `seq` holds NUMBERS: a landed swing contributes its amount, an avoided one contributes -1.
/// Amounts reaching a round are always > 0 (`route()` drops anything else) so -1 can never collide
/// with one.
#[derive(Debug, Clone)]
struct PendingLane {
    verb: String,
    skill: String,
    seq: Vec<i64>,
}

/// One (verb, second) round after the per-target lanes were collapsed.
struct CollapsedRound {
    verb: String,
    skill: String,
    swings: usize,
    targets: i64,
}

/// One swing's contribution to a fan-out signature: its amount, or -1 when it was avoided.
fn signature_token(amount: i64, avoided: bool) -> i64 {
    if avoided {
        -1
    } else {
        amount
    }
}

/// Collapse per-target lanes whose ordered signature is identical into ONE round, carrying the number
/// of defenders it was printed against. Order-stable: the first lane with a signature keeps its
/// position, later duplicates only bump `targets`.
///
/// THE SIGNATURE IS KEYED BY VERB. It has to be: `RoundAccum` holds one second's worth of EVERY verb
/// open at once, so a signature-only key merged a 163-damage backstab with a 163-damage slash in the
/// same second into one "fanned" round — two real rounds silently becoming one.
fn collapse_fan_out<'a>(lanes: impl Iterator<Item = &'a PendingLane>) -> Vec<CollapsedRound> {
    let mut by_sig: JsMap<usize> = JsMap::new();
    let mut out: Vec<CollapsedRound> = Vec::new();
    for lane in lanes {
        let seq: Vec<String> = lane.seq.iter().map(i64::to_string).collect();
        let sig = format!("{}|{}", lane.verb, seq.join(","));
        if let Some(&idx) = by_sig.get(&sig) {
            out[idx].targets += 1;
            continue;
        }
        by_sig.insert(sig, out.len());
        out.push(CollapsedRound {
            verb: lane.verb.clone(),
            skill: lane.skill.clone(),
            swings: lane.seq.len(),
            targets: 1,
        });
    }
    out
}

/// ROUND COUNTERS FOR ONE SOURCE, folded on ingest and BOUNDED: only the second currently being
/// assembled is held open, so memory is (verbs × targets in one second), not (seconds × targets). A
/// swing whose second differs from the open one FLUSHES the open second into the counters first.
///
/// `snapshot()` is PURE — a view build may not write to an aggregate — so the still-open second is
/// folded into a COPY and the accumulator is left exactly as it was.
#[derive(Debug, Clone)]
pub struct RoundAccum {
    lanes: JsMap<RoundLaneTally>,
    /// The second currently open, or -1 when nothing is pending.
    open_second: i64,
    /// `verb|target` → the sequence being assembled inside `open_second`.
    pending: JsMap<PendingLane>,
    /// Swings kept out of round counting, by reason — the denominator's honesty.
    pub excluded: [i64; 4],
}

impl Default for RoundAccum {
    fn default() -> Self {
        RoundAccum::new()
    }
}

impl RoundAccum {
    pub fn new() -> Self {
        RoundAccum {
            lanes: JsMap::new(),
            open_second: -1,
            pending: JsMap::new(),
            excluded: [0; 4],
        }
    }

    /// Fold one logged swing attempt. Excluded swings are TALLIED, never dropped silently.
    pub fn add<S: AsRef<str>>(&mut self, rec: &SwingRecord<'_, S>) {
        let verb = rec.verb.to_lowercase();
        if let Some(why) = round_exclusion(&verb, rec.modifiers) {
            self.excluded[why.slot()] += 1;
            return;
        }
        let sec = rec.ts.div_euclid(1_000);
        if sec != self.open_second {
            self.flush();
            self.open_second = sec;
        }
        let key = format!("{}|{}", verb, rec.target.trim().to_lowercase());
        let token = signature_token(rec.amount, rec.avoided);
        match self.pending.get_mut(&key) {
            Some(lane) => {
                lane.skill = rec.skill.to_string();
                lane.seq.push(token);
            }
            None => {
                self.pending.insert(
                    key,
                    PendingLane {
                        verb,
                        skill: rec.skill.to_string(),
                        seq: vec![token],
                    },
                );
            }
        }
    }

    /// Close the open second into the counters. Idempotent on an empty pending map.
    ///
    /// THE ONE-LANE FAST PATH is the case, not an edge: one attacker swinging one verb at one
    /// defender inside one second is what a log is overwhelmingly made of, and a single lane cannot
    /// be a fan-out of anything.
    fn flush(&mut self) {
        let n = self.pending.len();
        if n == 0 {
            return;
        }
        let groups: Vec<CollapsedRound> = if n == 1 {
            self.pending
                .values()
                .map(|lane| CollapsedRound {
                    verb: lane.verb.clone(),
                    skill: lane.skill.clone(),
                    swings: lane.seq.len(),
                    targets: 1,
                })
                .collect()
        } else {
            collapse_fan_out(self.pending.values())
        };
        for g in groups {
            count_into(&mut self.lanes, &g);
        }
        self.pending.clear();
    }

    /// The lanes as they stand, INCLUDING the still-open second — without touching the accumulator.
    /// A snapshot can be taken any number of times, mid-fight, with byte-identical results.
    pub fn snapshot(&self) -> Vec<RoundLaneTally> {
        if self.pending.is_empty() {
            return self.lanes.values().cloned().collect();
        }
        let mut copy: JsMap<RoundLaneTally> = JsMap::new();
        for (k, v) in self.lanes.iter() {
            copy.insert(k.to_string(), v.clone());
        }
        for g in collapse_fan_out(self.pending.values()) {
            count_into(&mut copy, &g);
        }
        copy.values().cloned().collect()
    }

    /// True when nothing has ever been folded (no lanes, no pending). `excluded` is deliberately not
    /// consulted — it is the same question the TS asks.
    pub fn is_empty(&self) -> bool {
        self.lanes.is_empty() && self.pending.is_empty()
    }
}

/// Fold ONE collapsed round into a lane tally (shared by `flush` and the pure snapshot).
fn count_into(into: &mut JsMap<RoundLaneTally>, g: &CollapsedRound) {
    if !into.contains_key(&g.verb) {
        into.insert(g.verb.clone(), new_lane(&g.verb, &g.skill));
    }
    let lane = into.get_mut(&g.verb).expect("just inserted");
    lane.skill = g.skill.clone();
    lane.buckets[round_bucket(g.swings)] += 1;
    lane.rounds += 1;
    if g.swings >= 2 {
        lane.multi_rounds += 1;
    }
    if g.targets > 1 {
        lane.fanned_rounds += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn swing<'a>(ts: i64, verb: &'a str, target: &'a str, amount: i64) -> SwingRecord<'a> {
        SwingRecord {
            ts,
            verb,
            skill: "Melee",
            target,
            amount,
            avoided: false,
            modifiers: &[],
        }
    }

    /// THE FAN-OUT COLLAPSE: one double-attack round printed against two defenders is ONE round with
    /// two targets, never two rounds and never a quadruple.
    #[test]
    fn one_round_fanned_across_two_defenders_collapses_to_one() {
        let mut a = RoundAccum::new();
        a.add(&swing(0, "backstab", "Warlord Skarlon", 45));
        a.add(&swing(0, "backstab", "a fire giant wizard", 45));
        a.add(&swing(0, "backstab", "Warlord Skarlon", 31));
        a.add(&swing(0, "backstab", "a fire giant wizard", 31));
        let lanes = a.snapshot();
        assert_eq!(lanes.len(), 1);
        assert_eq!(lanes[0].rounds, 1);
        assert_eq!(lanes[0].fanned_rounds, 1);
        assert_eq!(lanes[0].buckets, [0, 1, 0, 0]);
    }

    /// …and two DIFFERENT verbs with the same signature in one second stay two rounds. The signature
    /// is keyed by verb precisely so a 163-damage backstab is never fused with a 163-damage slash.
    #[test]
    fn two_verbs_with_one_signature_stay_two_rounds() {
        let mut a = RoundAccum::new();
        a.add(&swing(0, "backstab", "a bat", 163));
        a.add(&swing(0, "slash", "a bat", 163));
        let lanes = a.snapshot();
        assert_eq!(lanes.len(), 2);
        assert_eq!(lanes.iter().map(|l| l.rounds).sum::<i64>(), 2);
    }

    /// AN EXCLUDED SWING IS TALLIED, NEVER DROPPED SILENTLY.
    #[test]
    fn an_extra_swing_is_counted_out_of_the_rounds_and_into_the_exclusions() {
        let mut a = RoundAccum::new();
        let mods = vec!["Riposte".to_string()];
        a.add(&SwingRecord {
            modifiers: &mods,
            ..swing(0, "slash", "a bat", 20)
        });
        a.add(&swing(0, "frenzy", "a bat", 20));
        assert!(a.snapshot().is_empty());
        assert_eq!(a.excluded[RoundExclusion::Riposte.slot()], 1);
        assert_eq!(a.excluded[RoundExclusion::Frenzy.slot()], 1);
    }

    /// The SNAPSHOT INCLUDES the still-open second and does not close it — repeatable, byte-identical.
    #[test]
    fn a_snapshot_sees_the_open_second_without_closing_it() {
        let mut a = RoundAccum::new();
        a.add(&swing(1_500, "slash", "a bat", 10));
        assert_eq!(a.snapshot()[0].rounds, 1);
        assert_eq!(a.snapshot()[0].rounds, 1);
        a.add(&swing(1_600, "slash", "a bat", 12));
        assert_eq!(a.snapshot()[0].buckets, [0, 1, 0, 0]);
    }

    /// The dual-wield confound, made explicit.
    #[test]
    fn a_reuse_timer_verb_reads_per_event_and_a_weapon_verb_does_not() {
        assert_eq!(round_confidence("Backstab"), "perEvent");
        assert_eq!(round_confidence("slash"), "aggregate");
    }
}
