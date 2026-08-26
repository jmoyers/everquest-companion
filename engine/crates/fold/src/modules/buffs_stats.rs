//! `src/main/modules/buffsStats.ts` — THE ONE OBSERVED-DURATION LEARNER (JOS-140), and the per-line
//! game knowledge beside it: the mined duration samples, the recency map, and the spell catalog.
//!
//! This is GAME knowledge, not character state — a spell's duration and its cast messages are
//! identical across a character rebirth — which is why the module's rebirth and session-gap clears
//! deliberately leave everything here intact.
//!
//! ── KEYED ON (LINE, CASTER) — ruling 4, and both halves of the key are the owner's ──────────────
//!
//!   * the LINE is the rank-stripped key, so `Mesmerization III` and `Mesmerization VII` pool. That
//!     OVERRULES the investigation's per-rank proposal for a measured reason: the committed
//!     spells.json has 121 rank-suffixed names and ZERO rows at rank VI or above, so a per-rank key
//!     would start every upgrade back at the DB floor and re-learn from nothing on every level.
//!   * the CASTER is 'self' or an allowlisted external. A duration is a fact about a caster's AAs,
//!     focus items and rank; a grouped enchanter's 31-second mez and your own 44-second one are two
//!     answers to two questions, and pooling them gives a bar wrong for both.
//!
//! ── THE ESTIMATOR ──────────────────────────────────────────────────────────────────────────────
//!
//!   estimate = max( DB baseline , max-over-recent-window of observed samples )
//!
//! The DB base is a FLOOR and the recent observed max is an EXTENSION over it, because a beneficial
//! buff's true duration is never below its base (AA and focus only EXTEND) — so a BELOW-base
//! observation is an early termination and the max discards it. Invisibility: DB 20m, observed max
//! only 4m24 because it is always broken early ⇒ 20m, source 'db'. Swift Like the Wind: DB 16m,
//! observed 36m20 ⇒ 36m, source 'observed'.
//!
//! JOS-212 ADDED THE ONE WAY THE FLOOR CAN LOSE. The floor's assumption is a claim about the game
//! the wiki describes, and this one re-tiered the spells the scrape still describes the old way — so
//! a below-floor observation may overrule it when the log CORROBORATES it (three clean cycles whose
//! top three agree within 10%, `corroborated_max`). The source then reads 'cluster' rather than
//! 'observed', because the two make opposite claims about the DB row.
//!
//! JOS-379 ADDED A THIRD KIND OF EVIDENCE for the case where no cycle can ever be witnessed at all:
//! a debuffed mob's DEATH with no wear-off since the landing is a LOWER BOUND. On raid mobs that is
//! the whole of the available evidence — they die first, and this server prints no wear-off for your
//! slow when somebody else lands the kill. A bound folds into the MAX exactly like any other sample
//! and reports source 'deathBound' when it wins, because it is a bound and not an answer. It is
//! refused the cluster rule and the n/median columns: a bound is not a CYCLE.
//!
//! ── THE WINDOW IS APPLIED ONCE PER EVIDENCE CLASS (JOS-180) ────────────────────────────────────
//!
//! The most recent five UNCENSORED samples are one window and the most recent five LOWER BOUNDS are
//! a second; the observed candidate is the MAX over both. A censored sample can therefore never
//! push an uncensored one out of view, and vice versa. Measured on the owner's bytes: five early
//! breaks of Dazzle IV drove the estimate to 100 s and evicted the 115 s reading; the 15 s grace an
//! 'observed' estimate gets then culled every hold at 115 s; the real duration is 136 s, so no full
//! cycle could ever be witnessed again and the number was frozen below the truth permanently.
//! Splitting the windows is what makes the recovery STICK. A REAL DECREASE still recovers, which is
//! the property the split must not cost — it takes five UNCENSORED shorter cycles, exactly as it
//! always did.

use crate::jsfn::parse_spell_rank;
use crate::jsmap::JsMap;
use crate::modules::buffs_shapes::{
    corroborated_max, learn_key, percentile, BuffClass, DurationSample, EstimatorSource,
    RECENT_SAMPLE_WINDOW, SELF_CASTER,
};
use crate::spell_facts::{Nature, SpellFacts, SpellRow};
use eqlog::jsstr::js_trim;
use serde::Serialize;
use std::collections::HashSet;

/// The winning candidate of the estimator's window: the longest span, and whether it is a bound.
#[derive(Debug, Clone, Copy)]
pub struct WindowMax {
    pub ms: i64,
    pub bound: bool,
}

/// Fold one sample into the running window max (JOS-379).
///
/// A TIE GOES TO THE MEASURED CYCLE. Two samples agreeing on a number, one of them a real observed
/// ending, is an OBSERVATION — the bound adds nothing to it and must not weaken the label the log
/// already earned.
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

/// WHICH SPELLING OF A LINE THE BUFFS TAB SHOULD SHOW (JOS-411) — the rank question, answered once.
///
/// THE REPORT: *I now have the Mesmerization spell levelled up to X. The buffs section lists
/// 'Mesmerization VI'.* The record's display name was written when the (line, caster) row was first
/// minted and never again, so the tab showed whatever rank was equipped the first time a cycle
/// happened to close — forever, across every upgrade.
///
/// HIGHEST RANK WINS. Last-write-wins is REFUSED for two reasons that are facts about this store
/// rather than preferences: the store POOLS ACROSS CHARACTERS (everything here is game knowledge and
/// survives the rebirth clear), so a second enchanter on the same log would drag the name back down;
/// and it is the domain law already written down — *once you upgrade a spell it never downgrades,
/// even on a loadout swap*.
///
/// A TIE KEEPS THE EXISTING SPELLING, so a re-cast of the same rank never churns the row. A
/// DIFFERENT BASE is not a rank comparison, so the newest name simply wins — two names can share a
/// line key without sharing a base spelling (a hold that never resolved falls back to its first
/// candidate; the corrections overlay can RENAME a line outright), and comparing ordinals across
/// those would be arithmetic on unrelated words.
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
    /// The projected spell catalog — the authoritative prior. An EMPTY one is the TS's absent `db?`.
    pub db: SpellFacts,
    /// Mined samples per (LINE, CASTER). Ranks pool within a caster; casters never pool with each
    /// other (ruling 4).
    samples: JsMap<SpellSamples>,
    /// Spell keys ever seen fading / applied — the set `build_stats` walks.
    pub ever_faded: Vec<String>,
    ever_faded_at: HashSet<String>,
    /// SPELL LINES THIS LOG HAS EVER PRINTED A TARGET-NAMED WEAR-OFF FOR (JOS-379) — the
    /// "wear-off channel witnessed" flag, learned at runtime and from nothing else.
    ///
    /// The death lower bound reads an ABSENCE: no `Your <X> spell has worn off of <mob>.` between
    /// the landing and the corpse. An absence is only evidence about a spell that PRINTS the line in
    /// the first place, so a line whose channel this log has never demonstrated teaches nothing from
    /// silence, however many mobs die under it. It is the TARGET-NAMED sentence and not the self one:
    /// `Your speed returns to normal.` proves a buff on YOU ends audibly and says nothing about
    /// whether a debuff on a MOB does.
    wear_off_witnessed: HashSet<String>,
    /// Per-spell LAST-SEEN event ts: the newest castBegin / apply / fade involving the spell.
    last_seen: JsMap<i64>,
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
        }
    }

    pub fn reset(&mut self) {
        self.samples.clear();
        self.ever_faded.clear();
        self.ever_faded_at.clear();
        self.wear_off_witnessed.clear();
        self.last_seen.clear();
    }

    /// `everFaded.add` — a JS `Set`, so the INSERTION order is what `build_stats` walks. The object
    /// it builds is keyed, so that order is not published; keeping it anyway is what makes a diff
    /// between two runs of this crate readable.
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

    /// Authoritative DB duration (ms) for a spell key, or `None` when unknown.
    pub fn db_duration_for(&self, key: &str) -> Option<i64> {
        self.row_of(key).and_then(|s| s.duration_ms)
    }

    /// True when a spell KEY is illusion-flagged in the DB.
    pub fn is_illusion(&self, key: &str) -> bool {
        self.row_of(key).is_some_and(|s| s.illusion)
    }

    /// DOES THE SPELL DATABASE SAY THIS SPELL NEVER EXPIRES (JOS-215)?
    ///
    /// THE DISCRIMINATOR IS `durationText === 'Permanent'`, and `durationMs == null` ALONE IS NOT
    /// IT. Measured over the committed spells.json (1,926 rows): 62 rows state `Permanent`, every
    /// one of them Self and beneficial, and every one of them carries `durationMs: null` because the
    /// duration parser deliberately refuses the word. But 453 Self rows carry a null duration and the
    /// rest of them are `Instant` nukes, `Unlimited`, and clock forms an older scrape could not read
    /// — admitting on the null would open a permanent instance for every instant self-cast in the
    /// game. The wiki's own WORD is the fact; the null is an artefact of reading it.
    pub fn is_permanent(&self, key: &str) -> bool {
        self.row_of(key)
            .is_some_and(|s| s.duration_text.as_deref() == Some("Permanent"))
    }

    /// Append a mined duration sample for one caster. The DISPLAY NAME is re-read on every sample,
    /// not written once at mint (JOS-411).
    pub fn push_sample(&mut self, key: &str, caster: &str, spell: &str, sample: DurationSample) {
        self.row(key, caster, spell).samples.push(sample);
    }

    /// A LANDING SAID WHAT THIS LINE IS CALLED (JOS-411) — the same display-name write as
    /// `push_sample`, without a sample behind it.
    ///
    /// It exists because a mint is not the only moment the log states a rank, and on the
    /// crowd-control path it is the RARER one: the cast line is the only line in a mez's family that
    /// carries the numeral, while a sample is minted only from a CLEAN cycle — a mez the player's
    /// own nuke broke teaches the tab nothing. A row with no samples is a LEGAL row and always was.
    pub fn note_display_name(&mut self, key: &str, caster: &str, spell: &str) {
        self.row(key, caster, spell);
    }

    /// The (line, caster) row, minted if new, with its display name brought up to date.
    fn row(&mut self, key: &str, caster: &str, spell: &str) -> &mut SpellSamples {
        let lk = learn_key(key, caster);
        match self.samples.get_mut(&lk) {
            Some(_) => {
                // Two statements rather than one because the borrow of the row has to end before
                // `preferred_display_name` can read it back; the effect is the TS's one line.
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
    /// cycle early, so its span is a lower bound and not the duration (JOS-180).
    ///
    /// IT IS RETROACTIVE BECAUSE THE LOG IS. `<mob> has been awakened by <name>.` is printed AFTER
    /// the wear-off sentence it explains — measured over the owner's whole log, 1,472 of 1,472
    /// paired wakes follow their wear-off, in the same second — so the sample is always already
    /// minted by the time the cause arrives. The estimate is a MAX over both windows and does not
    /// move; what changes is only what this sample may EVICT later.
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
        // The DISTRIBUTION columns describe every cycle the model measured, censored or not: the
        // tab's n/median/min/max are a report on what was OBSERVED, and hiding the broken cycles
        // there would misdescribe the log. Only the ESTIMATE reads the censoring.
        //
        // A DEATH BOUND IS NOT A CYCLE AND IS NOT COUNTED (JOS-379). `n` is the number of land→fade
        // PAIRS and a bound has no fade in it — nothing ended, the mob simply stopped existing.
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
    /// MAX, not median/p75: samples are dominated by early terminations that read SHORT — a buff
    /// clicked off, a mez a nuke broke — and those never lift the max, so the max recovers a
    /// focus/AA-extended true duration that a central statistic stays dragged below. A WINDOW rather
    /// than all-time, because a focus effect that is later REMOVED genuinely shortens the duration
    /// and an old long observation has to be able to age out.
    ///
    /// WHY A CENSORED SAMPLE STILL COUNTS TOWARD THE MAX: it is a real observation, just a truncated
    /// one — the wake line proves the mez was still holding one instant before it, so the span is a
    /// LOWER BOUND. Discarding it outright would hand the DB floor back to exactly the spells
    /// JOS-126 was filed about. A lower bound is worth more than a wrong number, and MAX is the one
    /// estimator that can accept one safely.
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

    /// The most recent five CLEAN samples for this (line, caster), newest first — the same window
    /// the max walks on the uncensored side, handed out as a list because the below-floor overrule
    /// asks a question a max cannot answer: do the observations AGREE?
    ///
    /// LOWER BOUNDS ARE ABSENT BY CONSTRUCTION. They are lower bounds on a duration, not
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

    /// THE ONE ESTIMATOR — see this file's header for the three rules that compose it.
    ///
    /// TWO SMALL EXACTNESSES on the below-floor overrule. (1) The number it returns is the WHOLE
    /// window's max, not the clean cluster's — if a censored sample in the window is longer, the log
    /// proved the spell was still running at that instant and the estimate may never be drawn below
    /// a proven lower bound. (2) The comparison is STRICT, so an observation that merely EQUALS the
    /// floor changes nothing and stays 'db'.
    pub fn estimate_for(&self, key: &str, caster: &str) -> Estimate {
        let db_ms = self.db_duration_for(key);
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

    /// THE BUFF/DEBUFF CLASS OF A SPELL — from the spell's NATURE, and from nothing else (JOS-140
    /// ruling 8). A spell whose nature nobody states is NOT a debuff by assumption: it reads 'buff',
    /// and it is never resolved by looking at who it landed on. The removed fallback — a tally of
    /// the entity DISPOSITIONS a spell's fades had landed on — is what put `Resist Magic` (spellType
    /// `Resist Buff`, matching neither literal) on the DEBUFFS overlay when it landed on somebody
    /// the model was not holding as a pet.
    pub fn class_of(&self, key: &str) -> BuffClass {
        match self.row_of(key).map(|s| s.nature) {
            Some(Nature::Detrimental) => BuffClass::Debuff,
            _ => BuffClass::Buff,
        }
    }

    /// DOES THIS SPELL CALM ITS TARGET (JOS-213) — the second, orthogonal question, asked at the
    /// same seam and answered from the same place. `class_of` says whether the spell is a good thing
    /// or a bad thing; this says whether the thing it does happens to an ENEMY.
    pub fn calms_target(&self, key: &str) -> bool {
        self.row_of(key).is_some_and(|s| s.calms_target)
    }

    /// The snapshot's per-line stats record: every spell ever faded, with or without samples.
    ///
    /// It reports the SELF caster's numbers. The Buffs tab is a page about your own spells, and an
    /// allowlisted external's samples live under their own learner key precisely so they cannot be
    /// mistaken for yours.
    pub fn build_stats(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut stats = serde_json::Map::new();
        for key in &self.ever_faded {
            let st = match self.stat_for(key, SELF_CASTER) {
                Some(st) => st,
                None => {
                    let db_ms = self.db_duration_for(key);
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
                        estimate_ms: db_ms,
                        estimator_source: db_ms.map(|_| EstimatorSource::Db),
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
