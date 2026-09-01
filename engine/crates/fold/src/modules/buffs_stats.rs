//! The one observed-duration learner, and the per-line game knowledge beside it: the mined duration
//! samples, the recency map, and the spell catalog.
//!
//! This is GAME knowledge, not character state — a spell's duration and its cast messages are
//! identical across a rebirth — so the module's rebirth and session-gap clears leave it intact.
//!
//! Keyed on (LINE, CASTER):
//!
//!   * the LINE is rank-stripped, so `Mesmerization III` and `Mesmerization VII` pool. Not per-rank:
//!     the committed spells.json has zero rows at rank VI or above, so a per-rank key would start
//!     every upgrade back at the DB floor and re-learn from nothing on every level.
//!   * the CASTER is 'self' or an allowlisted external. A duration is a fact about a caster's AAs,
//!     focus items and rank, so pooling a grouped enchanter's mez with your own gives a bar wrong
//!     for both.
//!
//! The estimator is `max(DB baseline, max over the recent window of observed samples)`. The DB base
//! is a FLOOR and the observed max is an EXTENSION over it, because a beneficial buff's true
//! duration is never below its base — AA and focus only extend — so a below-base observation is an
//! early termination and the max discards it.
//!
//! The baseline is RANK-SCALED: an upgrade tier grows a spell's duration by a per-category
//! percentage, so the floor is the DB base grown by the highest tier a cast line has named for this
//! (line, caster) — see `buffs_shapes::scaled_floor_ms`. Only that number changes; every rule the
//! learner applies to it is untouched.
//!
//! The floor can lose exactly one way. Its assumption is a claim about the game the wiki describes,
//! and this server re-tiered spells the scrape still describes the old way, so a below-floor
//! observation may overrule it when the log CORROBORATES it (see [`corroborated_max`]). The source
//! then reads `Cluster` rather than `Observed`, because the two make opposite claims about the row.
//!
//! A third kind of evidence covers the case where no cycle can ever be witnessed: a debuffed mob's
//! DEATH with no wear-off since the landing is a LOWER BOUND. On raid mobs that is all the evidence
//! there is. A bound folds into the max like any other sample and reports `DeathBound` when it wins,
//! and it is refused the cluster rule and the n/median columns, because it is not a CYCLE.
//!
//! The window is applied ONCE PER EVIDENCE CLASS: the most recent five uncensored samples are one
//! window and the most recent five lower bounds are a second, with the observed candidate the max
//! over both. So a censored sample can never push an uncensored one out of view, or vice versa —
//! without which a run of early breaks drives the estimate under the true duration, the shorter
//! unwitnessed grace then culls every full-length hold, and the number is frozen below the truth
//! permanently. A real decrease still recovers, in five uncensored shorter cycles.

use crate::jsfn::parse_spell_rank;
use crate::jsmap::JsMap;
use crate::modules::buffs_shapes::{
    corroborated_max, learn_key, percentile, scaled_floor_ms, tier_of, BuffClass, DurationSample,
    EstimatorSource, RECENT_SAMPLE_WINDOW, SELF_CASTER,
};
use crate::spell_facts::{DurationCategory, Nature, SpellFacts, SpellRow};
use eqlog::jsstr::js_trim;
use serde::Serialize;
use std::collections::HashSet;

/// The winning candidate of the estimator's window: the longest span, and whether it is a bound.
#[derive(Debug, Clone, Copy)]
pub struct WindowMax {
    pub ms: i64,
    pub bound: bool,
}

/// Fold one sample into the running window max. A tie goes to the MEASURED cycle: the bound adds
/// nothing to an observation that agrees with it, and must not weaken the label the log earned.
fn fold_window_max(best: Option<WindowMax>, s: &DurationSample) -> WindowMax {
    let bound = s.death_bound;
    match best {
        None => WindowMax { ms: s.ms, bound },
        Some(b) if s.ms > b.ms => WindowMax { ms: s.ms, bound },
        Some(b) if s.ms == b.ms && !bound => WindowMax {
            ms: b.ms,
            bound: false,
        },
        Some(b) => b,
    }
}

/// Which spelling of a line the Buffs tab shows — the rank question, answered once.
///
/// Highest rank wins. Last-write-wins is refused because this store POOLS ACROSS CHARACTERS
/// (everything here is game knowledge and survives the rebirth clear), so a second enchanter on the
/// same log would drag the name back down; and because once you upgrade a spell it never downgrades,
/// even on a loadout swap.
///
/// A tie keeps the existing spelling, so a re-cast of the same rank never churns the row. A
/// DIFFERENT BASE is not a rank comparison at all, so the newest name simply wins: two names can
/// share a line key without sharing a base spelling, and comparing ordinals across those would be
/// arithmetic on unrelated words.
pub fn preferred_display_name(prev: &str, next: &str) -> String {
    let candidate = js_trim(next);
    if candidate.is_empty() || candidate == js_trim(prev) {
        return prev.to_string();
    }
    let before = parse_spell_rank(prev);
    let after = parse_spell_rank(candidate);
    if before.base.to_lowercase() != after.base.to_lowercase() {
        return candidate.to_string();
    }
    if after.rank > before.rank {
        candidate.to_string()
    } else {
        prev.to_string()
    }
}

/// Per-(line, caster) accumulated duration samples + display name.
struct SpellSamples {
    spell: String,
    samples: Vec<DurationSample>,
}

/// The snapshot's per-line stats record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuffStat {
    pub spell: String,
    pub cls: BuffClass,
    pub n: i64,
    pub median_ms: Option<f64>,
    pub p25: Option<f64>,
    pub p75: Option<f64>,
    pub min_ms: Option<i64>,
    pub max_ms: Option<i64>,
    pub db_duration_ms: Option<i64>,
    pub estimate_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimator_source: Option<EstimatorSource>,
    pub last_seen_ms: Option<i64>,
}

/// What the estimator answered.
#[derive(Debug, Clone, Copy)]
pub struct Estimate {
    pub ms: Option<i64>,
    pub source: Option<EstimatorSource>,
}

pub struct SpellStats {
    /// The projected spell catalog — the authoritative prior. An EMPTY one means no catalog at all.
    pub db: SpellFacts,
    /// Mined samples per (LINE, CASTER). Ranks pool within a caster; casters never pool with each
    /// other.
    samples: JsMap<SpellSamples>,
    /// Spell keys ever seen fading or applied — the set `build_stats` walks.
    pub ever_faded: Vec<String>,
    ever_faded_at: HashSet<String>,
    /// Spell lines this log has ever printed a TARGET-NAMED wear-off for, learned at runtime and
    /// from nothing else.
    ///
    /// The death lower bound reads an ABSENCE: no wear-off between the landing and the corpse. An
    /// absence is only evidence about a spell that prints the line in the first place, so a line
    /// whose channel this log has never demonstrated teaches nothing from silence, however many mobs
    /// die under it. It is the target-named sentence and not the self one: a self wear-off proves a
    /// buff on YOU ends audibly and says nothing about whether a debuff on a mob does.
    wear_off_witnessed: HashSet<String>,
    /// Per-spell LAST-SEEN event ts: the newest castBegin / apply / fade involving the spell.
    last_seen: JsMap<i64>,
    /// The highest upgrade tier a cast line has named for a (LINE, CASTER) — the roman numeral, and
    /// nothing else. Highest wins for the same reason the display name's rank does: a spell once
    /// upgraded never downgrades, and this store pools ranks under one line key.
    cast_tiers: JsMap<i64>,
}

impl SpellStats {
    pub fn new(db: SpellFacts) -> Self {
        SpellStats {
            db,
            samples: JsMap::new(),
            ever_faded: Vec::new(),
            ever_faded_at: HashSet::new(),
            wear_off_witnessed: HashSet::new(),
            last_seen: JsMap::new(),
            cast_tiers: JsMap::new(),
        }
    }

    pub fn reset(&mut self) {
        self.samples.clear();
        self.ever_faded.clear();
        self.ever_faded_at.clear();
        self.wear_off_witnessed.clear();
        self.last_seen.clear();
        self.cast_tiers.clear();
    }

    /// Insertion order is what `build_stats` walks. The object it builds is keyed, so that order is
    /// not published; keeping it stable anyway is what makes a diff between two runs readable.
    pub fn note_ever_faded(&mut self, key: &str) {
        if self.ever_faded_at.insert(key.to_string()) {
            self.ever_faded.push(key.to_string());
        }
    }

    pub fn witness_wear_off_channel(&mut self, key: &str) {
        self.wear_off_witnessed.insert(key.to_string());
    }

    pub fn has_wear_off_channel(&self, key: &str) -> bool {
        self.wear_off_witnessed.contains(key)
    }

    /// Record the newest ts a spell was seen (cast / apply / fade) — the recency signal.
    pub fn touch_last_seen(&mut self, key: &str, ts: i64) {
        if self.last_seen.get(key).is_none_or(|&prev| ts > prev) {
            self.last_seen.insert(key.to_string(), ts);
        }
    }

    fn row_of(&self, key: &str) -> Option<&SpellRow> {
        self.db.get(key)
    }

    /// Authoritative DB duration (ms) for a spell key, or `None` when unknown. The catalog's own
    /// number, unscaled — what the DB STATES, as against the floor the estimator reads.
    pub fn db_duration_for(&self, key: &str) -> Option<i64> {
        self.row_of(key).and_then(|s| s.duration_ms)
    }

    /// Record the upgrade tier a cast line named for this (line, caster). An unsuffixed name states
    /// the base tier and is not evidence, so it never lowers what a numeral already proved.
    pub fn note_cast_tier(&mut self, key: &str, caster: &str, ranked_name: &str) {
        let tier = tier_of(ranked_name);
        if tier <= 0 {
            return;
        }
        let lk = learn_key(key, caster);
        if self.cast_tiers.get(&lk).is_none_or(|&prev| tier > prev) {
            self.cast_tiers.insert(lk, tier);
        }
    }

    /// The tier this (line, caster) has been seen cast at — 0 when no cast line ever named one.
    pub fn cast_tier(&self, key: &str, caster: &str) -> i64 {
        self.cast_tiers
            .get(&learn_key(key, caster))
            .copied()
            .unwrap_or(0)
    }

    /// The FLOOR the estimator stands on: the DB base grown by the tier the log named for this
    /// caster. A spell whose upgrade path nobody witnessed is its base duration exactly.
    pub fn floor_for(&self, key: &str, caster: &str) -> Option<i64> {
        let db_ms = self.db_duration_for(key)?;
        let cat = self
            .row_of(key)
            .map_or(DurationCategory::Unstated, |s| s.category);
        Some(scaled_floor_ms(db_ms, cat, self.cast_tier(key, caster)))
    }

    /// True when a spell KEY is illusion-flagged in the DB.
    pub fn is_illusion(&self, key: &str) -> bool {
        self.row_of(key).is_some_and(|s| s.illusion)
    }

    /// Does the spell database say this spell never expires?
    ///
    /// The discriminator is the duration TEXT reading `Permanent`, and a null duration alone is not
    /// it. Measured over the committed spells.json: 62 rows state `Permanent` and all of them carry
    /// a null duration, because the duration parser refuses the word — but 453 self rows carry a
    /// null duration, and the rest are instant nukes, `Unlimited`, and clock forms an older scrape
    /// could not read. Admitting on the null would open a permanent instance for every instant
    /// self-cast in the game.
    pub fn is_permanent(&self, key: &str) -> bool {
        self.row_of(key)
            .is_some_and(|s| s.duration_text.as_deref() == Some("Permanent"))
    }

    /// Append a mined duration sample for one caster. The display name is re-read on every sample,
    /// not written once at mint.
    pub fn push_sample(&mut self, key: &str, caster: &str, spell: &str, sample: DurationSample) {
        self.row(key, caster, spell).samples.push(sample);
    }

    /// A landing said what this line is called — the same display-name write as `push_sample`,
    /// without a sample behind it.
    ///
    /// A mint is not the only moment the log states a rank, and on the crowd-control path it is the
    /// rarer one: the cast line is the only line in a mez's family carrying the numeral, while a
    /// sample is minted only from a CLEAN cycle. A row with no samples is a legal row.
    /// The same line states the RANK when it carries a numeral: this seam is fed the ranked cast
    /// text, which on a crowd-control line is the only spelling that ever has one.
    pub fn note_display_name(&mut self, key: &str, caster: &str, spell: &str) {
        self.row(key, caster, spell);
        self.note_cast_tier(key, caster, spell);
    }

    /// The (line, caster) row, minted if new, with its display name brought up to date.
    fn row(&mut self, key: &str, caster: &str, spell: &str) -> &mut SpellSamples {
        let lk = learn_key(key, caster);
        match self.samples.get_mut(&lk) {
            Some(_) => {
                // Two statements because the borrow of the row has to end before
                // `preferred_display_name` can read it back.
                let updated = {
                    let s = self.samples.get(&lk).expect("present");
                    preferred_display_name(&s.spell, spell)
                };
                let s = self.samples.get_mut(&lk).expect("present");
                s.spell = updated;
                s
            }
            None => {
                self.samples.insert(
                    lk.clone(),
                    SpellSamples {
                        spell: spell.to_string(),
                        samples: Vec::new(),
                    },
                );
                self.samples.get_mut(&lk).expect("just inserted")
            }
        }
    }

    /// Mark the sample closed at `closed_ts` CENSORED — the log named something that ended that
    /// cycle early, so its span is a lower bound and not the duration.
    ///
    /// It is retroactive because the log is: the wake line is printed AFTER the wear-off sentence it
    /// explains (measured: 1,472 of 1,472 paired wakes follow their wear-off, in the same second),
    /// so the sample is always already minted when the cause arrives. The estimate is a max over
    /// both windows and does not move; what changes is what this sample may EVICT later.
    ///
    /// Returns whether it found one, so the caller knows whether to re-stat.
    pub fn censor_sample_at(&mut self, key: &str, caster: &str, closed_ts: i64) -> bool {
        let Some(s) = self.samples.get_mut(&learn_key(key, caster)) else {
            return false;
        };
        // Newest first: a re-used ts can only mean the same second, and the newest is the one the
        // caller just minted.
        for sample in s.samples.iter_mut().rev() {
            if sample.ts != closed_ts {
                continue;
            }
            if sample.censored {
                return false;
            }
            sample.censored = true;
            return true;
        }
        false
    }

    /// The display name last minted for a (line, caster), for a row that has lost its own.
    pub fn sample_spell_name(&self, key: &str, caster: &str) -> Option<&str> {
        self.samples
            .get(&learn_key(key, caster))
            .map(|s| s.spell.as_str())
    }

    pub fn stat_for(&self, key: &str, caster: &str) -> Option<BuffStat> {
        let s = self.samples.get(&learn_key(key, caster))?;
        if s.samples.is_empty() {
            return None;
        }
        // The DISTRIBUTION columns describe every cycle the model measured, censored or not: they
        // report what was OBSERVED, and hiding the broken cycles would misdescribe the log. Only the
        // estimate reads the censoring. A death bound is not counted at all, because `n` is the
        // number of land→fade pairs and a bound has no fade in it.
        let mut sorted: Vec<i64> = s
            .samples
            .iter()
            .filter(|x| !x.death_bound)
            .map(|x| x.ms)
            .collect();
        sorted.sort_unstable();
        let n = sorted.len();
        let est = self.estimate_for(key, caster);
        Some(BuffStat {
            spell: s.spell.clone(),
            cls: self.class_of(key),
            n: n as i64,
            median_ms: (n > 0).then(|| percentile(&sorted, 0.5)),
            p25: (n > 0).then(|| percentile(&sorted, 0.25)),
            p75: (n > 0).then(|| percentile(&sorted, 0.75)),
            min_ms: sorted.first().copied(),
            max_ms: sorted.last().copied(),
            db_duration_ms: self.db_duration_for(key),
            estimate_ms: est.ms,
            estimator_source: est.source,
            last_seen_ms: self.last_seen.get(key).copied(),
        })
    }

    /// The observed candidate that competes with the DB floor: the MAX over the most recent window
    /// of samples for this (line, caster), or `None` when there are none.
    ///
    /// MAX, not median or p75: samples are dominated by early terminations that read short — a buff
    /// clicked off, a mez a nuke broke — and those never lift the max, so it recovers a focus- or
    /// AA-extended true duration that a central statistic stays dragged below. A WINDOW rather than
    /// all-time, because a focus effect later removed genuinely shortens the duration and an old
    /// long observation has to be able to age out.
    ///
    /// A censored sample still counts toward the max: it is a real observation, just a truncated
    /// one, so the span is a LOWER BOUND. Discarding it outright would hand the DB floor back to
    /// exactly the spells the learner exists for, and max is the one estimator that can accept a
    /// lower bound safely.
    pub fn observed_window_max_for(&self, key: &str, caster: &str) -> Option<WindowMax> {
        let s = self.samples.get(&learn_key(key, caster))?;
        let mut best: Option<WindowMax> = None;
        let mut clean = 0usize;
        let mut broken = 0usize;
        for sample in s.samples.iter().rev() {
            if sample.is_lower_bound() {
                if broken >= RECENT_SAMPLE_WINDOW {
                    continue;
                }
                broken += 1;
            } else {
                if clean >= RECENT_SAMPLE_WINDOW {
                    continue;
                }
                clean += 1;
            }
            best = Some(fold_window_max(best, sample));
            if clean >= RECENT_SAMPLE_WINDOW && broken >= RECENT_SAMPLE_WINDOW {
                break;
            }
        }
        best
    }

    /// The most recent CLEAN samples for this (line, caster), newest first — the same window the max
    /// walks on the uncensored side, handed out as a list because the below-floor overrule asks a
    /// question a max cannot answer: do the observations AGREE?
    ///
    /// Lower bounds are absent by construction: they are bounds on a duration rather than
    /// measurements of one, so they may neither corroborate a cluster nor break one.
    pub fn clean_window_for(&self, key: &str, caster: &str) -> Vec<i64> {
        let Some(s) = self.samples.get(&learn_key(key, caster)) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for sample in s.samples.iter().rev() {
            if out.len() >= RECENT_SAMPLE_WINDOW {
                break;
            }
            if !sample.is_lower_bound() {
                out.push(sample.ms);
            }
        }
        out
    }

    /// The one estimator — see this file's header for the rules that compose it.
    ///
    /// Two exactnesses on the below-floor overrule. The number returned is the WHOLE window's max,
    /// not the clean cluster's: if a censored sample in the window is longer, the log proved the
    /// spell was still running then, and the estimate may never be drawn below a proven lower bound.
    /// And the comparison is STRICT, so an observation merely equalling the floor changes nothing.
    pub fn estimate_for(&self, key: &str, caster: &str) -> Estimate {
        let db_ms = self.floor_for(key, caster);
        let observed = self.observed_window_max_for(key, caster);
        let learned = match observed {
            Some(o) if o.bound => EstimatorSource::DeathBound,
            _ => EstimatorSource::Observed,
        };
        if let Some(db) = db_ms {
            if let Some(o) = observed {
                if o.ms > db {
                    return Estimate {
                        ms: Some(o.ms),
                        source: Some(learned),
                    };
                }
                if o.ms < db && corroborated_max(&self.clean_window_for(key, caster)).is_some() {
                    return Estimate {
                        ms: Some(o.ms),
                        source: Some(EstimatorSource::Cluster),
                    };
                }
            }
            return Estimate {
                ms: Some(db),
                source: Some(EstimatorSource::Db),
            };
        }
        match observed {
            Some(o) => Estimate {
                ms: Some(o.ms),
                source: Some(learned),
            },
            None => Estimate {
                ms: None,
                source: None,
            },
        }
    }

    /// The buff/debuff class of a spell, from the spell's NATURE and from nothing else. A spell
    /// whose nature nobody states is not a debuff by assumption — it reads `Buff` — and it is never
    /// resolved by looking at who it landed on, which is what used to put a resist buff on the
    /// debuffs overlay when it landed on somebody the model was not holding as a pet.
    pub fn class_of(&self, key: &str) -> BuffClass {
        match self.row_of(key).map(|s| s.nature) {
            Some(Nature::Detrimental) => BuffClass::Debuff,
            _ => BuffClass::Buff,
        }
    }

    /// Does this spell CALM its target — a second, orthogonal question asked at the same seam.
    /// `class_of` says whether the spell is a good thing or a bad thing; this says whether the thing
    /// it does happens to an ENEMY.
    pub fn calms_target(&self, key: &str) -> bool {
        self.row_of(key).is_some_and(|s| s.calms_target)
    }

    /// The snapshot's per-line stats record: every spell ever faded, with or without samples.
    ///
    /// It reports the SELF caster's numbers only. An allowlisted external's samples live under their
    /// own learner key precisely so they cannot be mistaken for yours.
    pub fn build_stats(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut stats = serde_json::Map::new();
        for key in &self.ever_faded {
            let st = match self.stat_for(key, SELF_CASTER) {
                Some(st) => st,
                None => {
                    let db_ms = self.db_duration_for(key);
                    // No samples, so the estimate is the floor and the floor alone.
                    let floor_ms = self.floor_for(key, SELF_CASTER);
                    BuffStat {
                        spell: self
                            .sample_spell_name(key, SELF_CASTER)
                            .map(str::to_string)
                            .or_else(|| self.row_of(key).map(|s| s.name.clone()))
                            .unwrap_or_else(|| key.clone()),
                        cls: self.class_of(key),
                        n: 0,
                        median_ms: None,
                        p25: None,
                        p75: None,
                        min_ms: None,
                        max_ms: None,
                        db_duration_ms: db_ms,
                        estimate_ms: floor_ms,
                        estimator_source: floor_ms.map(|_| EstimatorSource::Db),
                        last_seen_ms: self.last_seen.get(key).copied(),
                    }
                }
            };
            stats.insert(
                key.clone(),
                serde_json::to_value(st).expect("a plain record"),
            );
        }
        stats
    }
}
