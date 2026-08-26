//! SEGMENT SERIALIZATION — turning a selected fight or zone session into the segment view the renderer
//! draws (`segmentViews.ts` + `sourceViews.ts` + `defenseViews.ts` + `roundViews.ts`).
//!
//! READ-ONLY OVER THE ENGINE, by design: selecting a fight or asking for a timeline must never be able
//! to finalize an encounter or move a point of damage. In Rust that is structural — `build_selected`
//! takes `&EngineState` — where over there it is a pinned invariant.
//!
//! ── A VIEW BUILD MAY NOT TOUCH THE AGGREGATE, AND THAT IS A SCAR ──────────────────────────────
//!
//! The values in the map handed to `source_views` are the engine's LIVE accumulators, so anything that
//! wrote into one of them would corrupt the fight, the zone session and every later snapshot,
//! permanently. That is not hypothetical: a deleted combine-pets fold did exactly this before it was
//! made to copy first. `with_landings` is the second thing that reshapes a row and it COPIES for the
//! same reason.
//!
//! ── THE COMBINE-PETS FOLD USED TO LIVE HERE AND IS GONE (owner ruling) ────────────────────────
//!
//! It merged each pet's lanes into a synthetic "You +pets" source with namespaced skill names and no
//! pet row at all — a SECOND presentation of the same numbers, alongside the renderer's own pet-row
//! layout, and the two disagreed on screen. "They should be using the same underlying api and
//! abstraction — if not, collapse." So: one abstraction, in the renderer, where a LAYOUT belongs; this
//! module emits exactly the engine's own attribution — you and each pet as their own authoritative
//! row. The fold's parameter is gone from every signature too: a flag no caller can pass is not a seam
//! a second fold can grow back in.
//!
//! ── `lands` IS A VIEW-TIME GRAFT, NEVER AN INGEST COUNTER ─────────────────────────────────────
//!
//! "Does this Strike have damage rows" is only answerable once every line of the segment is in, so the
//! effect-landing count is joined onto the `you` row HERE. The accumulator's own lane has no such
//! field — nothing on the ingest path could write it — which is why this file carries its own row
//! shape rather than reusing `SkillStat`.

use crate::combat::aggregate::{
    finalize_rounds, Agg, CategoryStat, SkillStat, SourceStat, MISS_KEYS,
};
use crate::combat::collate::compare_names;
use crate::combat::encounter::{encounter_name, Encounter, ACTIVE_MS};
use crate::combat::healing::{build_healing_view, HealingView};
use crate::combat::lifecycle::{zone_active_sec, zone_duration_sec};
use crate::combat::procdetect::lane_canon_key;
use crate::combat::procviews::{build_procs_view, effect_landings, ProcsView, ProcsViewSpec};
use crate::combat::rounds::round_confidence;
use crate::combat::state::EngineState;
use crate::jsmap::JsMap;
use serde::Serialize;

/// `shared/combat.ts CATEGORY_ORDER` — the stable UI ordering of the damage taxonomy.
const CATEGORY_ORDER: [&str; 5] = ["melee", "slay", "spell", "dot", "ds"];

fn category_rank(c: &str) -> usize {
    CATEGORY_ORDER
        .iter()
        .position(|&x| x == c)
        .unwrap_or(usize::MAX)
}

/// Per-skill cap in the drill, top level and per category alike — a small payload.
const SKILL_CAP: usize = 12;

/// The generic lane name the parser gives every weapon verb — a label to REPLACE, not to show four
/// times in one table (`slash`, `pierce`, `crush` and `hit` all answer "Melee").
const GENERIC_LANE: &str = "Melee";

// ── The view-local row shapes ─────────────────────────────────────────────────────────────────

/// A per-skill lane as the VIEW sees it: the accumulator's counters plus the effect-landing graft.
#[derive(Clone)]
struct SkillRow {
    name: String,
    total: i64,
    hits: i64,
    crits: i64,
    max: i64,
    /// Smallest LANDED amount; 0 = "no landed hit yet" (the accumulator's own sentinel).
    min: i64,
    misses: i64,
    resists: i64,
    /// Landings this lane recorded with NO damage line of its own — grafted here, never accumulated.
    lands: i64,
}

impl SkillRow {
    fn of(s: &SkillStat) -> SkillRow {
        SkillRow {
            name: s.name.clone(),
            total: s.total,
            hits: s.hits,
            crits: s.crits,
            max: s.max,
            min: s.min,
            misses: s.misses,
            resists: s.resists,
            lands: 0,
        }
    }

    fn new(name: &str) -> SkillRow {
        SkillRow {
            name: name.to_string(),
            total: 0,
            hits: 0,
            crits: 0,
            max: 0,
            min: 0,
            misses: 0,
            resists: 0,
            lands: 0,
        }
    }
}

#[derive(Clone)]
struct CatRow {
    category: String,
    total: i64,
    hits: i64,
    crits: i64,
    max: i64,
    resists: i64,
    by_skill: JsMap<SkillRow>,
}

impl CatRow {
    fn of(c: &CategoryStat) -> CatRow {
        let mut by_skill = JsMap::new();
        for (k, v) in c.by_skill.iter() {
            by_skill.insert(k.to_string(), SkillRow::of(v));
        }
        CatRow {
            category: c.category.clone(),
            total: c.total,
            hits: c.hits,
            crits: c.crits,
            max: c.max,
            resists: c.resists,
            by_skill,
        }
    }

    fn new(category: &str) -> CatRow {
        CatRow {
            category: category.to_string(),
            total: 0,
            hits: 0,
            crits: 0,
            max: 0,
            resists: 0,
            by_skill: JsMap::new(),
        }
    }
}

/// One source, projected into the view's own row shape. A COPY, always: see the header.
struct SourceRows {
    by_skill: JsMap<SkillRow>,
    by_category: JsMap<CatRow>,
}

fn project(s: &SourceStat) -> SourceRows {
    let mut by_skill = JsMap::new();
    for (k, v) in s.by_skill.iter() {
        by_skill.insert(k.to_string(), SkillRow::of(v));
    }
    let mut by_category = JsMap::new();
    for (k, v) in s.by_category.iter() {
        by_category.insert(k.to_string(), CatRow::of(v));
    }
    SourceRows {
        by_skill,
        by_category,
    }
}

/// Return a COPY of `s`'s lanes carrying the effect landings.
///
/// A lane the RESISTS already created (Weakening Strike, 0 hits / 34 resists) simply gains its
/// `lands`; a lane with landings and no resists at all is CREATED, in the `spell` category — the same
/// category a resist lands in, and the one that means "a detrimental spell of yours". Its total is 0,
/// so it sorts to the bottom of the ranked list, which is where a row with no damage belongs.
///
/// `lane_canon_key`, not `spell_canon_key`: a cast-less lane carries the origin marker in its name, and
/// a landing belongs to the SPELL either half of a split is about.
fn with_landings(s: &SourceStat, lands: &JsMap<(String, i64)>) -> SourceRows {
    let mut rows = project(s);
    let mut spell = match rows.by_category.get("spell") {
        Some(c) => c.clone(),
        None => CatRow::new("spell"),
    };
    let mut by_key: JsMap<String> = JsMap::new();
    for (k, v) in rows.by_skill.iter() {
        by_key.insert(lane_canon_key(&v.name), k.to_string());
    }
    for (key, (raw_name, count)) in lands.iter() {
        let name = by_key.get(key).cloned().unwrap_or_else(|| raw_name.clone());
        for m in [&mut rows.by_skill, &mut spell.by_skill] {
            if !m.contains_key(&name) {
                m.insert(name.clone(), SkillRow::new(&name));
            }
            m.get_mut(&name).expect("just inserted").lands += count;
        }
    }
    rows.by_category.insert("spell".to_string(), spell);
    rows
}

// ── Serialized shapes ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    name: String,
    total: i64,
    pct: f64,
    hits: i64,
    crits: i64,
    max: i64,
    /// Meaningful only over LANDED hits: a lane that only ever missed or resisted has no smallest hit
    /// to report, and emitting 0 would read as "landed a 0-damage hit".
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<i64>,
    misses: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    resists: Option<i64>,
    /// ABSENT, never 0: absent means "no landing evidence exists for this lane", which is the truth for
    /// a hand-cast stun that prints nothing when it lands, and is why the UI must decline to state a
    /// resist rate for one rather than print 100%.
    #[serde(skip_serializing_if = "Option::is_none")]
    lands: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryView {
    category: String,
    total: i64,
    pct: f64,
    hits: i64,
    crits: i64,
    crit_pct: f64,
    max: i64,
    resists: i64,
    resist_pct: f64,
    skills: Vec<SkillView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissBreakdown {
    miss: i64,
    dodge: i64,
    parry: i64,
    riposte: i64,
    block: i64,
    absorb: i64,
}

impl MissBreakdown {
    fn of(m: &[i64; 6]) -> MissBreakdown {
        MissBreakdown {
            miss: m[0],
            dodge: m[1],
            parry: m[2],
            riposte: m[3],
            block: m[4],
            absorb: m[5],
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatesView {
    miss: f64,
    dodge: f64,
    parry: f64,
    riposte: f64,
    block: f64,
    absorb: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundsView {
    total_rounds: i64,
    avg_hits_per_round: f64,
    max_hits_in_round: i64,
    multi_hit_rounds: i64,
    /// `histogram[k-1]` = rounds that landed exactly k hits.
    histogram: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundLaneView {
    verb: String,
    label: String,
    rounds: i64,
    buckets: Vec<i64>,
    multi_rounds: i64,
    multi_pct: f64,
    fanned_rounds: i64,
    confidence: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModifierTallyView {
    name: String,
    count: i64,
    avoided: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedView {
    frenzy: i64,
    riposte: i64,
    flurry: i64,
    rampage: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRoundsView {
    lanes: Vec<RoundLaneView>,
    primary_rounds: i64,
    excluded: ExcludedView,
    modifiers: Vec<ModifierTallyView>,
    ripostes_given: i64,
    riposte_landed: i64,
    riposte_damage: i64,
    ripostes_taken: i64,
    rampages_taken: i64,
    flurries: i64,
    flurry_pct: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    id: String,
    name: String,
    kind: &'static str,
    total: i64,
    dps: f64,
    pct: f64,
    hits: i64,
    crits: i64,
    crit_pct: f64,
    ambiguous_hits: i64,
    ambiguous_total: i64,
    misses: i64,
    hit_pct: f64,
    miss_breakdown: MissBreakdown,
    resists: i64,
    resist_pct: f64,
    skills: Vec<SkillView>,
    categories: Vec<CategoryView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rounds: Option<RoundsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    round_stats: Option<SourceRoundsView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiposteView {
    events: i64,
    swings: i64,
    hits: i64,
    damage: i64,
    pct_of_swing_damage: f64,
    taken: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefenseView {
    swings: i64,
    hits: i64,
    avoided: MissBreakdown,
    avoided_total: i64,
    avoided_pct: f64,
    defended: i64,
    defended_pct: f64,
    rates: RatesView,
    riposte: RiposteView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealerView {
    name: String,
    total: i64,
    count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentView {
    id: String,
    kind: &'static str,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    zone: Option<String>,
    duration_sec: f64,
    active: bool,
    active_sec: f64,
    out_total: i64,
    out_dps: f64,
    active_dps: f64,
    entities: Vec<SourceView>,
    in_total: i64,
    in_dps: f64,
    incoming: Vec<SourceView>,
    defense: DefenseView,
    enemy_heal_total: i64,
    incoming_heal_total: i64,
    incoming_healers: Vec<HealerView>,
    healing: HealingView,
    procs: ProcsView,
}

// ── sourceViews.ts ────────────────────────────────────────────────────────────────────────────

fn skill_view(k: &SkillRow, sk_max: i64) -> SkillView {
    SkillView {
        name: k.name.clone(),
        total: k.total,
        pct: (k.total as f64 / sk_max as f64) * 100.0,
        hits: k.hits,
        crits: k.crits,
        max: k.max,
        min: (k.hits > 0).then_some(k.min),
        misses: k.misses,
        resists: (k.resists != 0).then_some(k.resists),
        lands: (k.lands != 0).then_some(k.lands),
    }
}

/// Rank per-skill lanes for the drill. Damage first, exactly as shipped; the tiebreak only ever
/// reorders rows that carry NO damage at all — among a source's zero-damage lanes (effect procs,
/// resist-only spells) the one with the most observations is the one worth the scarce slot under the
/// 12-row cap. It cannot move a row that has damage.
fn rank_skills(rows: &JsMap<SkillRow>) -> Vec<&SkillRow> {
    let mut v: Vec<&SkillRow> = rows.values().collect();
    v.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then((b.lands + b.resists).cmp(&(a.lands + a.resists)))
    });
    v
}

fn max_total(rows: &JsMap<SkillRow>) -> i64 {
    rows.values().map(|k| k.total).max().unwrap_or(0).max(1)
}

/// Build the per-category drill-down views. Ordered by `CATEGORY_ORDER` (the stable UI ordering); each
/// carries its own per-skill breakdown capped at the same 12 rows.
fn category_views(by_cat: &JsMap<CatRow>) -> Vec<CategoryView> {
    let cat_max = by_cat.values().map(|c| c.total).max().unwrap_or(0).max(1) as f64;
    let mut cats: Vec<&CatRow> = by_cat.values().collect();
    cats.sort_by_key(|c| category_rank(&c.category));
    cats.into_iter()
        .map(|c| {
            let sk_max = max_total(&c.by_skill);
            let casts = c.hits + c.resists;
            CategoryView {
                category: c.category.clone(),
                total: c.total,
                pct: (c.total as f64 / cat_max) * 100.0,
                hits: c.hits,
                crits: c.crits,
                crit_pct: if c.hits > 0 {
                    (c.crits as f64 / c.hits as f64) * 100.0
                } else {
                    0.0
                },
                max: c.max,
                resists: c.resists,
                resist_pct: if casts > 0 {
                    (c.resists as f64 / casts as f64) * 100.0
                } else {
                    0.0
                },
                skills: rank_skills(&c.by_skill)
                    .into_iter()
                    .take(SKILL_CAP)
                    .map(|k| skill_view(k, sk_max))
                    .collect(),
            }
        })
        .collect()
}

/// Build the melee-rounds heuristic view. Collapses the (skill, second) buckets into a
/// hits-per-round histogram and summary. HONEST framing: the log never records double or triple
/// attack, so this counts hits landed in the same second — a cluster proxy, exposed as a distribution,
/// never a fabricated multi-attack certainty.
fn rounds_view(s: &SourceStat) -> Option<RoundsView> {
    let hist = finalize_rounds(&s.rounds);
    let total_rounds: i64 = hist.iter().sum();
    if total_rounds == 0 {
        return None;
    }
    let total_hits: i64 = hist
        .iter()
        .enumerate()
        .map(|(i, n)| n * (i as i64 + 1))
        .sum();
    Some(RoundsView {
        total_rounds,
        avg_hits_per_round: total_hits as f64 / total_rounds as f64,
        max_hits_in_round: hist.len() as i64,
        multi_hit_rounds: hist.iter().skip(1).sum(),
        histogram: hist,
    })
}

/// Title-case a verb for display (`backstab` → `Backstab`).
fn title_verb(verb: &str) -> String {
    let mut c = verb.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// The row label for a verb lane. A special-attack lane the log NAMED wins ("Flying Kick"); a weapon
/// verb falls back to the verb itself, because the parser's answer for all of them is the same word and
/// a table of four "Melee" rows would be unreadable.
fn round_lane_label(verb: &str, skill: &str) -> String {
    if skill.is_empty() || skill == GENERIC_LANE {
        title_verb(verb)
    } else {
        skill.to_string()
    }
}

fn tally_of(mods: &[ModifierTallyView], name: &str) -> i64 {
    mods.iter()
        .find(|m| m.name.to_lowercase() == name)
        .map_or(0, |m| m.count)
}

/// Build one source's Rounds payload, or `None` when the source has nothing to say — no rounds AND no
/// annotations. `None` rather than an empty shell so a spell-only source (or a mob that only ever cast)
/// shows no panel instead of a row of zeroes.
///
/// `taken` is the segment-level INCOMING annotation count, resolved by the caller because it is NOT a
/// property of this source's own rows: a `(Riposte)` counter aimed at you is booked on the MOB that
/// swung it.
fn round_stats_view(s: &SourceStat, taken: (i64, i64)) -> Option<SourceRoundsView> {
    // One base modifier's tally, ranked by count desc then name (stable across snapshots).
    let mut modifiers: Vec<ModifierTallyView> = s
        .mods
        .values()
        .map(|m| ModifierTallyView {
            name: m.name.clone(),
            count: m.count,
            avoided: m.avoided,
        })
        .collect();
    modifiers.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| compare_names(&a.name, &b.name))
    });
    let tallies = s.round_acc.snapshot();
    if tallies.is_empty() && modifiers.is_empty() {
        return None;
    }
    let mut lanes: Vec<RoundLaneView> = tallies
        .iter()
        .map(|t| RoundLaneView {
            verb: t.verb.clone(),
            label: round_lane_label(&t.verb, &t.skill),
            rounds: t.rounds,
            buckets: t.buckets.to_vec(),
            multi_rounds: t.multi_rounds,
            multi_pct: if t.rounds > 0 {
                (t.multi_rounds as f64 / t.rounds as f64) * 100.0
            } else {
                0.0
            },
            fanned_rounds: t.fanned_rounds,
            confidence: round_confidence(&t.verb),
        })
        .collect();
    lanes.sort_by(|a, b| {
        b.rounds
            .cmp(&a.rounds)
            .then_with(|| compare_names(&a.label, &b.label))
    });
    let primary_rounds: i64 = lanes.iter().map(|l| l.rounds).sum();
    let flurries = tally_of(&modifiers, "flurry");
    // THE RIPOSTE COUNTER-SWING, read off the accumulator rather than off `modifiers`: the view shape
    // is counts-only on the wire and stays that way, so the landed count and the damage come from the
    // raw tally. The key is the log's own spelling (`Riposte`) because that is what the parser emits —
    // the lowercase lookup above is a display-side convenience and not the storage key.
    let (riposte_landed, riposte_damage) = s
        .mods
        .get("Riposte")
        .map_or((0, 0), |t| (t.count - t.avoided, t.total));
    Some(SourceRoundsView {
        primary_rounds,
        excluded: ExcludedView {
            frenzy: s.round_acc.excluded[0],
            riposte: s.round_acc.excluded[1],
            flurry: s.round_acc.excluded[2],
            rampage: s.round_acc.excluded[3],
        },
        ripostes_given: tally_of(&modifiers, "riposte"),
        riposte_landed,
        riposte_damage,
        ripostes_taken: taken.0,
        rampages_taken: taken.1,
        flurries,
        flurry_pct: if primary_rounds > 0 {
            (flurries as f64 / primary_rounds as f64) * 100.0
        } else {
            0.0
        },
        modifiers,
        lanes,
    })
}

/// The segment's INCOMING annotation totals — what was done TO you. Summed over every incoming row
/// because the engine books an annotation on the source that SWUNG it, and "taken" is the same fact
/// read from the other end. Incoming means the defender is You by construction of `classify`, so this
/// needs no further gating.
fn taken_annotations(inc: &JsMap<SourceStat>) -> (i64, i64) {
    let mut riposte = 0;
    let mut rampage = 0;
    for s in inc.values() {
        riposte += s.mods.get("Riposte").map_or(0, |t| t.count);
        rampage += s.mods.get("Rampage").map_or(0, |t| t.count);
    }
    (riposte, rampage)
}

/// Serialize a frozen source map into the snapshot's source views.
///
/// `lands` is grafted onto the `you` row ONLY — an INCOMING view has no proc ledger behind it, and a
/// mob's slow landing on you is not a lane of yours. `taken` likewise reaches only the `you` row.
fn source_views(
    map: &JsMap<SourceStat>,
    duration_sec: f64,
    lands: Option<&JsMap<(String, i64)>>,
    taken: Option<(i64, i64)>,
) -> Vec<SourceView> {
    let graft = lands.filter(|l| !l.is_empty());
    let row_max = map.values().map(|s| s.total).max().unwrap_or(0).max(1) as f64;
    let mut out: Vec<SourceView> = map
        .iter()
        .map(|(id, s)| {
            let rows = match graft {
                Some(l) if id == "you" => with_landings(s, l),
                _ => project(s),
            };
            let sk_max = max_total(&rows.by_skill);
            let swings = s.hits + s.misses;
            // Resist rate is over CAST attempts of detrimental spells: landed spell/dot hits plus
            // resists. Melee, slay and damage-shield hits cannot be resisted, so they are excluded from
            // the base.
            let spell_hits = rows.by_category.get("spell").map_or(0, |c| c.hits)
                + rows.by_category.get("dot").map_or(0, |c| c.hits);
            let casts = spell_hits + s.resists;
            SourceView {
                id: id.to_string(),
                name: s.name.clone(),
                kind: s.kind.as_str(),
                total: s.total,
                dps: s.total as f64 / duration_sec,
                pct: (s.total as f64 / row_max) * 100.0,
                hits: s.hits,
                crits: s.crits,
                crit_pct: if s.hits > 0 {
                    (s.crits as f64 / s.hits as f64) * 100.0
                } else {
                    0.0
                },
                ambiguous_hits: s.ambiguous_hits,
                ambiguous_total: s.ambiguous_total,
                misses: s.misses,
                hit_pct: if swings > 0 {
                    (s.hits as f64 / swings as f64) * 100.0
                } else {
                    100.0
                },
                miss_breakdown: MissBreakdown::of(&s.miss),
                resists: s.resists,
                resist_pct: if casts > 0 {
                    (s.resists as f64 / casts as f64) * 100.0
                } else {
                    0.0
                },
                skills: rank_skills(&rows.by_skill)
                    .into_iter()
                    .take(SKILL_CAP)
                    .map(|k| skill_view(k, sk_max))
                    .collect(),
                categories: category_views(&rows.by_category),
                rounds: rounds_view(s),
                round_stats: round_stats_view(
                    s,
                    if id == "you" {
                        taken.unwrap_or((0, 0))
                    } else {
                        (0, 0)
                    },
                ),
            }
        })
        .collect();
    // `sort((a, b) => b.total - a.total)` — total DESC, and STABLE, so two rows with the same total
    // keep the order the aggregate recorded them in.
    out.sort_by_key(|s| std::cmp::Reverse(s.total));
    out
}

// ── defenseViews.ts ───────────────────────────────────────────────────────────────────────────

/// The two categories a weapon SWING lands in (a Slay Undead proc rides an ordinary swing).
const SWING_CATEGORIES: [&str; 2] = ["melee", "slay"];

/// Landed weapon-swing hits in one row — melee + slay, never the spell/dot/ds lanes.
fn swing_hits(s: &SourceStat) -> i64 {
    SWING_CATEGORIES
        .iter()
        .map(|c| s.by_category.get(c).map_or(0, |x| x.hits))
        .sum()
}

/// Landed weapon-swing DAMAGE in one row — the denominator riposte damage is a share of.
fn swing_damage(s: &SourceStat) -> i64 {
    SWING_CATEGORIES
        .iter()
        .map(|c| s.by_category.get(c).map_or(0, |x| x.total))
        .sum()
}

/// Build the segment's DEFENSIVE view.
///
/// NOTHING IS PARSED OR COUNTED HERE THAT WAS NOT ALREADY COUNTED. Every figure is a re-reading of
/// counters the ingest path has folded for a long time: the miss breakdown on the INCOMING rows (an
/// avoided swing is booked on the mob that swung it — the defender is You by construction of
/// `classify`, so summing the incoming rows IS your defence) and the `(Riposte)` tally on your OWN row.
/// That is why this whole block moves no damage total: the one amount it reads is an INDEX over damage
/// the melee lanes already booked.
///
/// THE DENOMINATOR IS SWINGS AT YOU, AND ONLY SWINGS (law 5 — a rate whose denominator is wrong is a
/// lie, not an approximation). Melee + slay hits, because those are the two categories a weapon swing
/// lands in; a mob's nuke, DoT tick or damage shield is not a swing and cannot be blocked, so including
/// it would silently deflate every rate here in exactly the fights with a caster in them.
///
/// THE FOUR ACTIVE DEFENCES. A mob's own `misses!` and your rune's `absorb` are deliberately NOT among
/// them: neither is a skill of yours, and folding either in would flatter every rate.
fn build_defense_view(
    inc: &JsMap<SourceStat>,
    you: Option<&SourceStat>,
    taken: i64,
) -> DefenseView {
    let mut avoided = [0i64; 6];
    let mut hits = 0;
    for s in inc.values() {
        for k in MISS_KEYS {
            avoided[k] += s.miss[k];
        }
        hits += swing_hits(s);
    }
    let avoided_total: i64 = avoided.iter().sum();
    let swings = hits + avoided_total;
    let defended = avoided[4] + avoided[2] + avoided[1] + avoided[3];
    let rate = |n: i64| -> f64 {
        if swings > 0 {
            (n as f64 / swings as f64) * 100.0
        } else {
            0.0
        }
    };
    // YOUR RIPOSTE, both halves. `events` comes from the incoming avoidance breakdown; everything else
    // comes from the `(Riposte)` annotation on your own swings, which is a DIFFERENT fact — Double
    // Riposte fires more counters than events, so the two are reported side by side and never
    // reconciled into one number.
    let t = you.and_then(|y| y.mods.get("Riposte"));
    let r_swings = t.map_or(0, |t| t.count);
    let r_avoided = t.map_or(0, |t| t.avoided);
    let damage = t.map_or(0, |t| t.total);
    let base = you.map_or(0, swing_damage);
    DefenseView {
        swings,
        hits,
        avoided: MissBreakdown::of(&avoided),
        avoided_total,
        avoided_pct: rate(avoided_total),
        defended,
        defended_pct: rate(defended),
        rates: RatesView {
            miss: rate(avoided[0]),
            dodge: rate(avoided[1]),
            parry: rate(avoided[2]),
            riposte: rate(avoided[3]),
            block: rate(avoided[4]),
            absorb: rate(avoided[5]),
        },
        riposte: RiposteView {
            events: avoided[3],
            swings: r_swings,
            hits: r_swings - r_avoided,
            damage,
            pct_of_swing_damage: if base > 0 {
                (damage as f64 / base as f64) * 100.0
            } else {
                0.0
            },
            taken,
        },
    }
}

// ── segmentViews.ts ───────────────────────────────────────────────────────────────────────────

/// Everything a segment view needs about the segment it describes. Bundled because a fight, the live
/// zone aggregate and a frozen zone session differ only in these fields.
struct ViewSpec<'a> {
    id: String,
    kind: &'static str,
    name: String,
    zone: Option<String>,
    agg: &'a Agg,
    duration_sec: f64,
    active_sec: f64,
    active: bool,
    st: &'a EngineState,
    /// Segment span in absolute ms (first/last attributed damage). The proc view clips the state spans
    /// to it; a segment that saw no damage carries 0/0 and reports no spans.
    start_ts: i64,
    end_ts: i64,
    /// Present only for a FIGHT.
    enc: Option<&'a Encounter>,
}

fn build_view(spec: ViewSpec) -> SegmentView {
    let agg = spec.agg;
    let duration_sec = spec.duration_sec;
    // THE EFFECT-LANDING GRAFT. The proc ledger's own count of landings that no damage row represents,
    // handed to the OUTGOING view — which is what lets a Weakening Strike row say
    // `0 dmg · 562 landed · 34 resisted` instead of `0 landed`. The INCOMING view gets nothing: a mob
    // slowing you is not a lane of yours.
    //
    // RIPOSTE/RAMPAGE TAKEN are booked on the MOB that swung the annotated counter and read here from
    // the other end. They can only be resolved where both maps are in scope, which is exactly here.
    let taken = taken_annotations(&agg.inc);
    let lands = effect_landings(agg);
    let entities = source_views(&agg.out, duration_sec, Some(&lands), Some(taken));
    let incoming = source_views(&agg.inc, duration_sec, None, None);
    let out_total: i64 = entities.iter().map(|e| e.total).sum();
    let in_total: i64 = incoming.iter().map(|e| e.total).sum();
    let mut incoming_healers: Vec<HealerView> = agg
        .inc_heal
        .values()
        .map(|h| HealerView {
            name: h.name.clone(),
            total: h.amount,
            count: h.count,
        })
        .collect();
    incoming_healers.sort_by_key(|h| std::cmp::Reverse(h.total));
    SegmentView {
        out_dps: out_total as f64 / duration_sec,
        active_dps: out_total as f64 / f64::max(1.0, spec.active_sec),
        in_dps: in_total as f64 / duration_sec,
        // YOUR DEFENCE — the incoming rows read from the other end, plus your own `(Riposte)`
        // counter-swings. Built from the SAME frozen aggregate as the bars above it, so a finalized
        // zone session (which keeps no event ring at all) reports it exactly.
        defense: build_defense_view(&agg.inc, agg.out.get("you"), taken.0),
        enemy_heal_total: Agg::sum_heal(&agg.enemy_heal),
        incoming_heal_total: incoming_healers.iter().map(|h| h.total).sum(),
        healing: build_healing_view(&agg.heal, duration_sec),
        procs: build_procs_view(&ProcsViewSpec {
            st: spec.st,
            agg,
            id: &spec.id,
            kind: spec.kind,
            duration_sec,
            active_sec: spec.active_sec,
            start_ts: spec.start_ts,
            end_ts: spec.end_ts,
            enc: spec.enc,
        }),
        id: spec.id,
        kind: spec.kind,
        name: spec.name,
        zone: spec.zone,
        duration_sec,
        active: spec.active,
        active_sec: spec.active_sec,
        out_total,
        entities,
        in_total,
        incoming,
        incoming_healers,
    }
}

/// THE ONE WORD A ZONE SESSION IS CALLED BY. A stay the WORLD ended is that zone's `overall`; a stay
/// the USER ended with the app-wide "New session" mark is that zone's `session`, which is the word loot
/// and leveling already print for the very same click. One concept, one vocabulary, decided FROM THE
/// RECORD so the picker, the overlay header and the panel crumb can never disagree about it.
fn zone_session_word(closed_by: crate::combat::encounter::ZoneSessionClose) -> &'static str {
    match closed_by {
        crate::combat::encounter::ZoneSessionClose::Mark => "session",
        crate::combat::encounter::ZoneSessionClose::Zone => "overall",
    }
}

/// Build the selected segment's view, or `None` when the id resolves to nothing at all — which is the
/// honest answer for a session with no fights in it.
pub fn build_selected(st: &EngineState, id: &str, now: i64) -> Option<SegmentView> {
    if id == "zone" {
        let z_dur = zone_duration_sec(st);
        return Some(build_view(ViewSpec {
            id: "zone".to_string(),
            kind: "zone",
            name: format!("{} - overall", st.zone.as_deref().unwrap_or("Session")),
            zone: st.zone.clone(),
            agg: &st.zone_agg,
            duration_sec: z_dur,
            active_sec: f64::min(z_dur, zone_active_sec(st)),
            active: false,
            st,
            start_ts: st.zone_start_ts,
            end_ts: st.zone_last_ts,
            enc: None,
        }));
    }
    // A finalized zone SESSION: rebuild its full breakdown from the frozen aggregate.
    if let Some(zs) = st.zone_history.iter().find(|z| z.id == id) {
        let z_dur = f64::max(1.0, zs.finalized_ms as f64 / 1000.0);
        return Some(build_view(ViewSpec {
            id: zs.id.clone(),
            kind: "zone",
            name: format!("{} - {}", zs.zone, zone_session_word(zs.closed_by)),
            zone: Some(zs.zone.clone()),
            agg: &zs.agg,
            duration_sec: z_dur,
            active_sec: f64::min(z_dur, zs.active_ms as f64 / 1000.0),
            active: false,
            st,
            start_ts: zs.start_ts,
            end_ts: zs.last_ts,
            enc: None,
        }));
    }
    let is_current = st.current.as_ref().is_some_and(|e| e.id == id);
    let e = match &st.current {
        Some(cur) if cur.id == id => Some(cur),
        _ => st.history.iter().find(|h| h.id == id),
    }?;
    let dur = f64::max(1.0, (e.last_ts - e.start_ts) as f64 / 1000.0);
    Some(build_view(ViewSpec {
        id: e.id.clone(),
        kind: "fight",
        name: encounter_name(e, is_current),
        zone: e.zone.clone(),
        agg: &e.agg,
        duration_sec: dur,
        active_sec: f64::min(dur, e.active_ms as f64 / 1000.0),
        active: is_current && now - e.last_ts < ACTIVE_MS,
        st,
        start_ts: e.start_ts,
        end_ts: e.last_ts,
        enc: Some(e),
    }))
}
