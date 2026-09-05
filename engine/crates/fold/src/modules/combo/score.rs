//! `src/main/modules/comboScore.ts` — scoring. Observations in, slots out. Pure.
//!
//! What does NOT work, measured, so nobody re-tries it: ranking classes by how often they are
//! named. A frequency model against every `/who` anchor in a real log returns the same one class
//! for every window, because a player casts some classes' spells constantly and every shared heal
//! props three more up. Volume is not truth.
//!
//! What does work: presence · exclusivity · sustain, over DISTINCT LABELS.
//!   exclusive(c)  distinct labels whose candidate set is exactly {c}
//!   support(c)    Σ over distinct labels naming c of weight / |candidates|
//!   sustain(c)    distinct 1-hour buckets holding any evidence for c
//! A hundred Backstab skill-ups count once for "ROG is present"; a second point is earned by a
//! DIFFERENT rogue label.
//!
//! The model says "I don't know" out loud. A resolved slot holds one candidate; a slot the evidence
//! can only narrow to {CLR,PAL} holds both — CLR is measured never to be exclusively evidenced,
//! because its whole low-level book is shared with PAL — and a slot with nothing behind it holds
//! all 16 at confidence 0.
//!
//! Order is a claim in two places here, so both use insertion-ordered maps: a class's `labels`
//! become the published `because` list, and the residual clusters are ranked by a comparator that
//! is NOT total, so the map's own order breaks the tie as JS's stable sort over a `Map` does.

use super::evidence::ClassObservation;
use super::{ClassAbbr, CLASS_ABBRS};
use crate::jsmap::JsMap;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

const HOUR_MS: i64 = 3_600_000;

/// How many distinct hourly buckets an EXCLUSIVE label must span before it counts as exclusivity.
///
/// `sustain` cannot be the guard against a one-off: it counts buckets holding ANY evidence for the
/// class, and invocations shared across a dozen classes let every class clear it. This is the bar
/// the interval builder already uses to decide a class was PRESENT — evidence in two distinct hours
/// — restated per LABEL, which is the level strays live at. A class whose only exclusive names each
/// appeared once has not been evidenced, it has been glimpsed.
const EXCLUSIVE_BUCKETS: usize = 2;

/// One slot's knowledge. `candidates` is the SET of classes still consistent with the evidence; the
/// slot is RESOLVED only when it holds exactly one. A 3-slot combo where two resolve and one holds
/// {CLR,PAL} is the normal, honest state.
#[derive(Debug, Clone, Serialize)]
pub struct ComboSlot {
    /// 1 = resolved; >1 = ambiguous; 16 = unknown. Sorted and deduped.
    pub candidates: Vec<ClassAbbr>,
    pub confidence: f64,
    pub provenance: &'static str,
    /// Evidence keys that produced this slot, strongest first, capped at 8 (`skill:Frenzy`).
    pub because: Vec<String>,
}

/// A class's standing in one window.
#[derive(Debug, Clone)]
pub struct ClassScore {
    pub cls: ClassAbbr,
    pub exclusive: i64,
    /// Distinct hourly buckets holding EXCLUSIVE evidence for this class — how far across the
    /// window the class's unambiguous evidence reaches, rather than how many names it went by. See
    /// `by_strength` for why this and not `exclusive` decides admission.
    pub spread: usize,
    pub support: f64,
    pub sustain: usize,
    /// The distinct labels naming it — the slot's `because`.
    pub labels: Vec<String>,
}

/// A distinct label, folded across every occurrence of it in the window.
struct LabelFold {
    display: String,
    candidates: Vec<ClassAbbr>,
    weight: f64,
    buckets: HashSet<i64>,
}

/// Fold observations into DISTINCT labels. `source:label` is the key — a stance and a spell may
/// share a word, and they are not the same evidence.
fn fold_labels(observations: &[ClassObservation]) -> Vec<LabelFold> {
    let mut by_key: JsMap<LabelFold> = JsMap::new();
    for o in observations {
        if o.source == "who" {
            continue; // /who OVERRIDES, it never scores (§ 4.4)
        }
        let key = format!("{}:{}", o.source, o.label);
        if let Some(seen) = by_key.get_mut(&key) {
            seen.buckets.insert(o.ts.div_euclid(HOUR_MS));
            continue;
        }
        let display = format!(
            "{}:{}",
            if o.source == "skillUp" {
                "skill"
            } else {
                o.source
            },
            o.label
        );
        by_key.insert(
            key,
            LabelFold {
                display,
                candidates: o.candidates.clone(),
                weight: o.weight,
                buckets: HashSet::from([o.ts.div_euclid(HOUR_MS)]),
            },
        );
    }
    by_key.into_values()
}

/// Per-class exclusivity / spread / support / sustain over a window's observations.
///
/// The returned map is insertion-ordered for the same reason `fold_labels` is: `labels` is
/// published. The scores themselves are then sorted by a TOTAL comparator, so their own order is
/// free.
pub fn score_classes(observations: &[ClassObservation]) -> JsMap<ClassScore> {
    let mut scores: JsMap<ClassScore> = JsMap::new();
    let mut buckets: HashMap<ClassAbbr, HashSet<i64>> = HashMap::new();
    let mut exclusive_buckets: HashMap<ClassAbbr, HashSet<i64>> = HashMap::new();
    for fold in fold_labels(observations) {
        let exclusive = fold.candidates.len() == 1;
        for cls in &fold.candidates {
            if !scores.contains_key(cls) {
                scores.insert(
                    (*cls).to_string(),
                    ClassScore {
                        cls,
                        exclusive: 0,
                        spread: 0,
                        support: 0.0,
                        sustain: 0,
                        labels: Vec::new(),
                    },
                );
            }
            let s = scores.get_mut(cls).expect("just inserted");
            if exclusive && fold.buckets.len() >= EXCLUSIVE_BUCKETS {
                s.exclusive += 1;
            }
            s.support += fold.weight / fold.candidates.len() as f64;
            s.labels.push(fold.display.clone());
            buckets.entry(cls).or_default().extend(fold.buckets.iter());
            // Spread counts every hour an unambiguous label put this class in the window, whether
            // or not that label cleared the two-bucket bar on its own: the bar makes a class
            // admissible at all, and spread is the reach of the whole body of exclusive evidence.
            if exclusive {
                exclusive_buckets
                    .entry(cls)
                    .or_default()
                    .extend(fold.buckets.iter());
            }
        }
    }
    for s in scores.values_mut() {
        s.sustain = buckets.get(&s.cls).map_or(0, HashSet::len);
        s.spread = exclusive_buckets.get(&s.cls).map_or(0, HashSet::len);
    }
    scores
}

/// Admission ranking: SPREAD first, exclusive-label count as the tie-break, then support.
/// Deterministic (code last).
///
/// Spread rather than label count, because `exclusive` counts distinct NAMES — a property of the
/// class's spellbook, not of how long it was in the loadout. A caster emptying four nukes into one
/// evening scores 4; a paladin laying hands and summoning a steed across five days scores 2, so raw
/// label count admits the evening's visitor over the class that was running the whole time.
///
/// What this does NOT fix: spread is measured inside one interval, so it says nothing about stale
/// classes surviving a swap — that is the boundary's job. Where a boundary is MISSING, spread
/// actively prefers the older loadout, because weeks of it outreach one fresh evening.
fn by_strength(a: &ClassScore, b: &ClassScore) -> std::cmp::Ordering {
    b.spread
        .cmp(&a.spread)
        .then_with(|| b.exclusive.cmp(&a.exclusive))
        // Every value here is a finite sum of weight/|candidates|, so `partial_cmp` can only be
        // `None` for a NaN that cannot arise.
        .then_with(|| {
            b.support
                .partial_cmp(&a.support)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        // The codes are three ASCII uppercase letters, where ICU collation and byte order agree,
        // and this last key is what makes the comparator TOTAL.
        .then_with(|| a.cls.cmp(b.cls))
}

/// The classes ADMITTED to the combo: at least one exclusive label AND evidence in at least two
/// hourly buckets, strongest first, capped at `expected_slots`.
///
/// `sustain >= 2` is not what rejects item clickies — that happens at intake. It earns its place by
/// rejecting a class named by one exclusive label inside a single hour, which is what a genuinely
/// stray observation looks like.
pub fn admitted(scores: &JsMap<ClassScore>, expected_slots: usize) -> Vec<ClassScore> {
    let mut out: Vec<ClassScore> = scores
        .values()
        .filter(|s| s.exclusive >= 1 && s.sustain >= 2)
        .cloned()
        .collect();
    out.sort_by(by_strength);
    out.truncate(expected_slots);
    out
}

/// § 4.3's ladder, for a slot resolved by inference.
fn resolved_confidence(s: &ClassScore) -> f64 {
    if s.exclusive >= 2 {
        return 0.9;
    }
    if s.sustain >= 3 {
        0.75
    } else {
        0.5
    }
}

/// An AMBIGUOUS cluster: labels that name none of the admitted classes, intersected.
struct Cluster {
    candidates: Vec<ClassAbbr>,
    support: f64,
    labels: Vec<String>,
}

/// Residual clustering (§ 4.3 step 2). Labels already explained by an admitted class are dropped —
/// a {CLR,PAL} cast with PAL admitted explains itself and yields no new slot. What is left is
/// grouped by EXACT candidate set and ranked by total support.
///
/// Deliberate deviation from the design, which said to intersect overlapping clusters greedily.
/// Intersection can exclude the truth, because two shared labels need not describe the SAME slot,
/// so intersecting them is an assumption rather than a narrowing — it has produced slots that do
/// not contain the class the `/who` row names. Grouping by exact set can never remove a candidate
/// some single piece of evidence did not already remove. The one safe fold is kept: a broader group
/// whose set CONTAINS a stronger group's is consistent with it and lends it support.
fn cluster_residual(folds: Vec<LabelFold>, admitted_set: &HashSet<ClassAbbr>) -> Vec<Cluster> {
    let mut groups: JsMap<Cluster> = JsMap::new();
    // A residual exclusive label is a class that FAILED admission — one stray cast in one hour. It
    // gets no slot and no group: seeding one would resolve, through the back door, exactly the
    // class the admission rule just refused.
    for fold in folds {
        if fold.candidates.len() < 2 || fold.candidates.iter().any(|c| admitted_set.contains(c)) {
            continue;
        }
        let key = fold.candidates.join("|");
        let share = fold.weight / fold.candidates.len() as f64;
        if let Some(group) = groups.get_mut(&key) {
            group.support += share;
            group.labels.push(fold.display);
            continue;
        }
        groups.insert(
            key,
            Cluster {
                candidates: fold.candidates,
                support: share,
                labels: vec![fold.display],
            },
        );
    }
    let mut ranked = groups.into_values();
    // Not a total order, and both JS's sort and `sort_by` are stable, so ties keep insertion order.
    ranked.sort_by(|a, b| {
        b.support
            .partial_cmp(&a.support)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // An index walk, because the TS closure reads and writes the same array it is filtering.
    let mut keep = vec![true; ranked.len()];
    for i in 0..ranked.len() {
        let stronger = (0..i).find(|&j| {
            keep_or_not(&ranked[j], &ranked[i]) // j's set ⊆ i's set
        });
        let Some(j) = stronger else { continue };
        keep[i] = false;
        let support = ranked[i].support;
        let labels = std::mem::take(&mut ranked[i].labels);
        ranked[j].support += support;
        ranked[j].labels.extend(labels);
    }
    ranked
        .into_iter()
        .zip(keep)
        .filter_map(|(g, k)| k.then_some(g))
        .collect()
}

/// `g.candidates.every((c) => group.candidates.includes(c))` — the earlier (stronger) group's set
/// is contained in this one's.
fn keep_or_not(stronger: &Cluster, group: &Cluster) -> bool {
    stronger
        .candidates
        .iter()
        .all(|c| group.candidates.contains(c))
}

/// An explicit UNKNOWN slot: all 16 candidates, zero confidence, no story. Never a guess.
pub fn unknown_slot() -> ComboSlot {
    ComboSlot {
        candidates: CLASS_ABBRS.to_vec(),
        confidence: 0.0,
        provenance: "inferred",
        because: Vec::new(),
    }
}

/// A slot the log (or the user) STATED: resolved, confidence 1.0, no inference involved.
pub fn stated_slots(classes: &[ClassAbbr], provenance: &'static str) -> Vec<ComboSlot> {
    classes
        .iter()
        .map(|c| ComboSlot {
            candidates: vec![c],
            confidence: 1.0,
            provenance,
            because: vec![provenance.to_string()],
        })
        .collect()
}

/// Observations → slots (§ 4.2-4.3). Always returns exactly `expected_slots` entries: admitted
/// classes first, then ambiguous clusters, then explicit unknowns. Shorter is never returned — "we
/// found two of three" is a statement the UI has to be able to make.
pub fn score_slots(observations: &[ClassObservation], expected_slots: usize) -> Vec<ComboSlot> {
    let scores = score_classes(observations);
    let admit = admitted(&scores, expected_slots);
    let mut slots: Vec<ComboSlot> = admit
        .iter()
        .map(|s| ComboSlot {
            candidates: vec![s.cls],
            confidence: resolved_confidence(s),
            provenance: "inferred",
            because: s.labels.iter().take(8).cloned().collect(),
        })
        .collect();
    let admitted_set: HashSet<ClassAbbr> = admit.iter().map(|s| s.cls).collect();
    for cluster in cluster_residual(fold_labels(observations), &admitted_set) {
        if slots.len() >= expected_slots {
            break;
        }
        if cluster.candidates.is_empty() {
            continue;
        }
        let mut candidates = cluster.candidates;
        candidates.sort_unstable();
        slots.push(ComboSlot {
            candidates,
            // "we know the SET, not the member" — a two-way ambiguity is worth 0.3, not 0.6.
            confidence: 0.6 / cluster.labels.len().max(1) as f64,
            provenance: "inferred",
            because: cluster.labels.into_iter().take(8).collect(),
        });
    }
    while slots.len() < expected_slots {
        slots.push(unknown_slot());
    }
    slots.truncate(expected_slots);
    slots
}
