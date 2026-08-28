//! The proc-ledger serialization (`src/main/combat/procViews.ts`): one segment's `Agg` plus the
//! session state timeline, turned into the procs view the renderer draws.
//!
//! Additive only — every number here is a count or an index over damage the meter already counted.
//!
//! Four counting rules, because collapsing any of them makes a proc meter lie:
//!
//!   1. A poison lane counts emotes and reports tick damage and healing separately; the three are
//!      each correct for their own question and are never summed.
//!   2. A poison lane suppresses the spell-proc lane of the same name — one proc can print both an
//!      emote and a typed poison-damage line, and emitting both lanes counts it twice.
//!   3. A slay lane's `direct_damage` is damage on swings that procced slay, not damage slay added;
//!      the excess over an ordinary swing rides in `marginal_damage` with its assumption stated.
//!   4. A spell lane's `count` is the larger of its damage-line and heal-line firings, never the sum.
//!
//! A lane's `linked` rows come from the per-state firing split against the per-state swing exposure,
//! both folded on ingest. Spell lanes only: a poison lane's link to its own coat is tautological, and
//! a slay lane's `direct_damage` is not damage the proc added. Both keep an empty list rather than a
//! zero-filled one.

use crate::combat::aggregate::{Agg, SourceStat};
use crate::combat::collate::compare_names;
use crate::combat::encounter::{CoatSlot, Encounter};
use crate::combat::poisons::{is_slow_capable, POISONS};
use crate::combat::procbuffs::PROC_BUFF_CATALOG;
use crate::combat::procdetect::{is_castless_lane_name, lane_canon_key, lane_count};
use crate::combat::procwindows::{
    build_attribution_report, links_for, proc_rate, AttributionReport, LaneForDirect, ProcLink,
    ProcRateView, ProcSourceWindow, RateInput,
};
use crate::combat::state::EngineState;
use crate::combat::statetimeline::{state_key_of, StateKind, StateSpan};
use crate::jsmap::JsMap;
use eqlog::names::{id_key, spell_canon_key};
use serde::Serialize;
use std::collections::HashSet;

/// `(Finishing Blow)` — the modifier name the parser recombines by hand.
pub const FINISHING_BLOW: &str = "Finishing Blow";

/// One lane of the counting ledger (Strikes, poison damage, dispels).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcLane {
    pub name: String,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambiguous: Option<bool>,
}

/// A coat applied inside this fight, stamped relative to the fight's opening instant. Not a
/// `CoatSlot`: that shape carries an absolute `sinceTs` and answers "when did this go on", while
/// this one answers "how far into the pull".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoatMarkView {
    pub poison: String,
    pub t_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcLaneView {
    pub name: String,
    pub count: i64,
    pub origin: &'static str,
    pub rate: ProcRateView,
    pub direct_damage: i64,
    pub direct_heal: i64,
    pub pct_of_out: f64,
    pub dps_contribution: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resisted: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resist_pct: Option<f64>,
    pub linked: Vec<ProcLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambiguous: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marginal_damage: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcSkillTag {
    pub skill: String,
    pub lane: String,
    pub origin: &'static str,
    pub rate: ProcRateView,
    pub active_sec: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcsView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coat_at_engage: Option<CoatSlot>,
    pub combat_at_engage: Vec<CoatSlot>,
    pub slow_expected: bool,
    pub coats: Vec<CoatMarkView>,
    pub strikes: Vec<ProcLane>,
    pub strike_count: i64,
    pub slow_lands: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slow_land_ms: Option<i64>,
    pub poison_damage: Vec<ProcLane>,
    pub poison_damage_total: i64,
    pub dispels: Vec<ProcLane>,
    pub dispel_count: i64,
    pub stance_switches: i64,
    pub invocation_switches: i64,
    pub lanes: Vec<ProcLaneView>,
    pub overall: ProcRateView,
    pub proc_skills: Vec<ProcSkillTag>,
    pub states: Vec<StateSpan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribution: Option<AttributionReport>,
}

/// Everything one procs view needs. A fight, the live zone aggregate and a frozen zone session
/// differ only in these fields.
pub struct ProcsViewSpec<'a> {
    pub st: &'a EngineState,
    pub agg: &'a Agg,
    pub id: &'a str,
    /// `fight` or `zone`.
    pub kind: &'static str,
    pub duration_sec: f64,
    pub active_sec: f64,
    /// Segment span in absolute ms — the window the state spans are clipped to.
    pub start_ts: i64,
    pub end_ts: i64,
    /// Present only for a fight.
    pub enc: Option<&'a Encounter>,
}

/// The denominators every lane in a segment shares. Resolved once.
struct RateBase {
    active_sec: f64,
    duration_sec: f64,
    swings: i64,
    out_total: i64,
    sources: SourceWindows,
}

/// Every state span this segment saw, with the active seconds it was open for. `unknown` is not an
/// error state — it is the answer for every item proc and any buff that predates the window.
struct SourceWindows {
    active_sec_by_state: JsMap<f64>,
    name_by_state: JsMap<String>,
}

fn source_windows(spec: &ProcsViewSpec, states: &[StateSpan]) -> SourceWindows {
    let mut active_sec_by_state: JsMap<f64> = JsMap::new();
    for (key, ms) in spec.agg.procs.active_ms_by_state.iter() {
        active_sec_by_state.insert(key.to_string(), *ms as f64 / 1000.0);
    }
    let mut name_by_state: JsMap<String> = JsMap::new();
    for s in states {
        name_by_state.insert(state_key_of(s.kind, &s.key), s.name.clone());
    }
    SourceWindows {
        active_sec_by_state,
        name_by_state,
    }
}

/// The source window for a poison lane: the coat spans of every poison whose roster grants one of
/// the lane's Strikes.
///
/// Summing those spans is a union, not a double count: poisons that grant the same Strike are
/// mutually exclusive. Every multi-granting poison is utility, and only one utility coat can be on;
/// every combat Strike is granted by exactly one venom.
///
/// `None` when no granting coat has an observed span here — a coat applied before the window opened.
fn poison_source(label: &str, w: &SourceWindows) -> Option<ProcSourceWindow> {
    let strikes: HashSet<&str> = label.split(" / ").map(str::trim).collect();
    let mut sec = 0.0;
    let mut names: Vec<String> = Vec::new();
    for p in POISONS.iter() {
        if !p.strikes.iter().any(|s| strikes.contains(s)) {
            continue;
        }
        let key = state_key_of(StateKind::Coat, &id_key(p.name));
        let Some(&s) = w.active_sec_by_state.get(&key) else {
            continue;
        };
        if s <= 0.0 {
            continue;
        }
        sec += s;
        names.push(
            w.name_by_state
                .get(&key)
                .cloned()
                .unwrap_or_else(|| p.name.to_string()),
        );
    }
    (!names.is_empty()).then(|| ProcSourceWindow {
        active_sec: sec,
        name: names.join(" + "),
    })
}

/// The source window for a spell lane: the tracked proc buff that grants it, when the catalog names
/// one and its span was observed here (`Instrument of Nife` grants `Condemnation of Nife`).
fn spell_source(name: &str, w: &SourceWindows) -> Option<ProcSourceWindow> {
    let key = spell_canon_key(name);
    for b in PROC_BUFF_CATALOG.iter() {
        let Some(grants) = b.grants_proc else {
            continue;
        };
        if spell_canon_key(grants) != key {
            continue;
        }
        let state_key = state_key_of(StateKind::Buff, &id_key(b.name));
        if let Some(&sec) = w.active_sec_by_state.get(&state_key) {
            if sec > 0.0 {
                return Some(ProcSourceWindow {
                    active_sec: sec,
                    name: w
                        .name_by_state
                        .get(&state_key)
                        .cloned()
                        .unwrap_or_else(|| b.name.to_string()),
                });
            }
        }
    }
    None
}

/// The source-window half of a lane's rate input. Three outcomes:
///   known   — a coat span or a tracked proc-buff span; the rate is over it exactly.
///   unknown — a spell or poison lane whose granting span this segment never saw; the segment is
///             assumed and `sourceAmbiguous` says so.
///   n/a     — a slay, aa or click lane. There is no span that could have been off, so flagging one
///             ambiguous would send a reader looking for a window that does not exist.
fn source_input(origin: &str, label: &str, w: &SourceWindows) -> (Option<ProcSourceWindow>, bool) {
    if origin == "slay" || origin == "aa" || origin == "click" {
        return (None, false);
    }
    let source = if origin == "poison" {
        poison_source(label, w)
    } else {
        spell_source(label, w)
    };
    match source {
        Some(s) => (Some(s), false),
        None => (None, true),
    }
}

fn rate_base(spec: &ProcsViewSpec, states: &[StateSpan]) -> RateBase {
    RateBase {
        active_sec: spec.active_sec,
        duration_sec: spec.duration_sec,
        swings: spec.agg.procs.swings,
        out_total: Agg::sum(&spec.agg.out),
        sources: source_windows(spec, states),
    }
}

/// One lane's rates: divided by its source window when the model knows one, flagged when it does
/// not.
fn lane_rate(count: i64, b: &RateBase, origin: &str, label: &str) -> ProcRateView {
    let (source, source_unknown) = source_input(origin, label, &b.sources);
    proc_rate(&RateInput {
        count,
        active_sec: b.active_sec,
        duration_sec: b.duration_sec,
        swings: b.swings,
        source,
        source_unknown,
    })
}

/// An emote label may name several Strikes — one emote sentence is shared by two venoms — and the
/// ledger keeps both in one ` / `-joined label. Every candidate is joined against the damage lanes
/// and every candidate suppresses its spell-proc twin.
fn candidate_keys(label: &str) -> Vec<String> {
    label
        .split(" / ")
        .map(|n| spell_canon_key(n.trim()))
        .collect()
}

/// Your damage rows recorded under any of `keys` — the one place a proc lane is matched against the
/// meter's own skill lanes, so "which rows is this lane" cannot come to mean two things.
///
/// Names are matched rank-normalized and proc-marker-stripped, so both halves of a split spell
/// match, and returned raw because the raw string is what the drill row is labelled with.
fn skills_matching<'a>(you: Option<&'a SourceStat>, keys: &[String]) -> Vec<(&'a str, i64, i64)> {
    let mut out = Vec::new();
    let Some(you) = you else { return out };
    for s in you.by_skill.values() {
        if keys.contains(&lane_canon_key(&s.name)) {
            out.push((s.name.as_str(), s.total, s.hits));
        }
    }
    out
}

/// Damage delivered under a given skill name by you, read back out of the same aggregate the bars
/// come from. An index, never a second accumulation.
fn delivered_by(you: Option<&SourceStat>, keys: &[String]) -> i64 {
    skills_matching(you, keys).iter().map(|s| s.1).sum()
}

/// Your resists on the rows a lane covers. Same join and same aggregate as `delivered_by`, so a lane
/// and the drill row beneath it read one counter and not two.
fn resisted_by(you: Option<&SourceStat>, keys: &[String]) -> i64 {
    let Some(you) = you else { return 0 };
    you.by_skill
        .values()
        .filter(|s| keys.contains(&lane_canon_key(&s.name)))
        .map(|s| s.resists)
        .sum()
}

/// Healing recorded under a given skill name by the cast-less detector. Kept separate from damage: a
/// tap can return more than it deals, so neither can be derived from the other.
fn healed_by(agg: &Agg, keys: &[String]) -> i64 {
    agg.procs
        .spell_procs
        .iter()
        .filter(|(key, _)| keys.iter().any(|k| k == key))
        .map(|(_, lane)| lane.heal)
        .sum()
}

/// Effect landings with no damage line. Some Strikes print only an emote when they land (`<mob>'s
/// limbs move slower!`) while their resists print the spell name like any other spell, so without
/// this join the drill builds a lane for them out of resists alone.
///
/// A strike lane contributes only when no meter row has landed a hit under its name: where a lane
/// does land damage its firings are already represented, and adding the emotes would double-count.
/// The gate is `hits > 0` and not "a row exists", because a resist is exactly what creates the row.
pub fn effect_landings(agg: &Agg) -> JsMap<(String, i64)> {
    let you = agg.out.get("you");
    let mut out: JsMap<(String, i64)> = JsMap::new();
    for s in agg.procs.strikes.values() {
        let keys = candidate_keys(&s.name);
        if skills_matching(you, &keys).iter().any(|r| r.2 > 0) {
            continue;
        }
        out.insert(keys[0].clone(), (s.name.clone(), s.count));
    }
    out
}

/// One lane, with its rates and its Tier-A numbers. `damage` and `heal` are kept apart all the way
/// down, for the reason `healed_by` states.
struct LaneSpec<'a> {
    name: &'a str,
    origin: &'static str,
    count: i64,
    damage: i64,
    heal: i64,
    resisted: i64,
    linked: Vec<ProcLink>,
}

fn lane(s: LaneSpec, b: &RateBase) -> ProcLaneView {
    let attempts = s.count + s.resisted;
    ProcLaneView {
        name: s.name.to_string(),
        count: s.count,
        origin: s.origin,
        rate: lane_rate(s.count, b, s.origin, s.name),
        direct_damage: s.damage,
        direct_heal: s.heal,
        pct_of_out: if b.out_total > 0 {
            (s.damage as f64 / b.out_total as f64) * 100.0
        } else {
            0.0
        },
        dps_contribution: if b.active_sec > 0.0 {
            s.damage as f64 / b.active_sec
        } else {
            0.0
        },
        // The other half of the lane's record: `count` is what landed, this is what did not.
        resisted: (s.resisted > 0).then_some(s.resisted),
        resist_pct: (s.resisted > 0).then(|| (s.resisted as f64 / attempts as f64) * 100.0),
        linked: s.linked,
        ambiguous: None,
        marginal_damage: None,
    }
}

/// Rogue-poison lanes. `count` is the emote count and nothing else (rule 1).
fn poison_lanes(spec: &ProcsViewSpec, you: Option<&SourceStat>, b: &RateBase) -> Vec<ProcLaneView> {
    let mut out: Vec<ProcLaneView> = Vec::new();
    for s in spec.agg.procs.strikes.values() {
        let keys = candidate_keys(&s.name);
        let mut l = lane(
            LaneSpec {
                name: &s.name,
                origin: "poison",
                count: s.count,
                damage: delivered_by(you, &keys),
                heal: healed_by(spec.agg, &keys),
                resisted: resisted_by(you, &keys),
                linked: Vec::new(),
            },
            b,
        );
        if s.ambiguous {
            l.ambiguous = Some(true);
        }
        out.push(l);
    }
    out.sort_by(|x, y| {
        y.count
            .cmp(&x.count)
            .then_with(|| compare_names(&x.name, &y.name))
    });
    out
}

/// Cast-less spell lanes, minus any name a poison emote already counted (rule 2).
fn spell_lanes(
    spec: &ProcsViewSpec,
    b: &RateBase,
    covered: &HashSet<String>,
    states: &[StateSpan],
) -> Vec<ProcLaneView> {
    let you = spec.agg.out.get("you");
    let swings = spec.agg.procs.swings;
    let mut out: Vec<ProcLaneView> = Vec::new();
    for (key, l) in spec.agg.procs.spell_procs.iter() {
        if covered.contains(key) {
            continue;
        }
        out.push(lane(
            LaneSpec {
                // A held clicky is its own origin: same counts, same denominators, same links. Only
                // the word changes, because "proc" claims a mechanism this firing does not have.
                name: &l.name,
                origin: if l.click { "click" } else { "spell" },
                count: lane_count(l),
                damage: l.damage,
                heal: l.heal,
                resisted: resisted_by(you, &[key.to_string()]),
                linked: links_for(l, states, &spec.agg.procs.swings_by_state, swings),
            },
            b,
        ));
    }
    out.sort_by(|x, y| {
        y.count
            .cmp(&x.count)
            .then_with(|| compare_names(&x.name, &y.name))
    });
    out
}

/// The slay lane (rule 3), from the taxonomy's own `slay` category — a Slay Undead proc rides an
/// ordinary swing and prints no spell line of its own.
///
/// Emitted only when it fired; a permanent 0-count row on every non-undead pull is noise.
/// `marginal_damage` subtracts the swing that would have landed anyway, at this segment's mean melee
/// hit.
fn slay_lanes(you: Option<&SourceStat>, b: &RateBase) -> Vec<ProcLaneView> {
    let Some(slay) = you.and_then(|y| y.by_category.get("slay")) else {
        return Vec::new();
    };
    if slay.hits == 0 {
        return Vec::new();
    }
    let melee = you.and_then(|y| y.by_category.get("melee"));
    let mean_melee = match melee {
        Some(m) if m.hits > 0 => m.total as f64 / m.hits as f64,
        _ => 0.0,
    };
    let mut l = lane(
        LaneSpec {
            name: "Slay Undead",
            origin: "slay",
            count: slay.hits,
            damage: slay.total,
            heal: 0,
            resisted: 0,
            linked: Vec::new(),
        },
        b,
    );
    l.marginal_damage = Some(slay.total as f64 - slay.hits as f64 * mean_melee);
    vec![l]
}

/// The Finishing Blow lane — the other swing-borne AA. The modifier has always been parsed and
/// tallied on the source's `mods`, but the drill groups by skill, so the damage sits invisibly
/// spread across Slash / Bash / Strike. This gives that counted fact a surface.
///
/// It is not a category, where Slay Undead is one: a category moves the damage out of `melee`, and
/// Finishing Blow's damage IS a weapon swing's, so moving it would change every melee mean and swing
/// denominator to fix a listing problem.
///
/// Its baseline differs from the slay lane's by one subtraction. Slay swings left the melee
/// category, so `melee` there is already the ordinary body; Finishing Blow swings did not, so the
/// swings the proc rode are subtracted out before the mean is taken.
fn finishing_blow_lanes(you: Option<&SourceStat>, b: &RateBase) -> Vec<ProcLaneView> {
    let Some(t) = you.and_then(|y| y.mods.get(FINISHING_BLOW)) else {
        return Vec::new();
    };
    // `count` includes avoided swings; the miss family only carries single-word modifiers, so this
    // subtraction is a guard and not a correction.
    let hits = t.count - t.avoided;
    if hits <= 0 {
        return Vec::new();
    }
    let melee = you.and_then(|y| y.by_category.get("melee"));
    // The ordinary body: this category minus the swings this proc rode. Clamped because a compound
    // carrying both `Slay Undead` and `Finishing Blow` would book under `slay` while the tally still
    // counted it here. No such line has appeared in a swept log, but a negative baseline is worse.
    let plain_hits = (melee.map_or(0, |m| m.hits) - hits).max(0);
    let plain_total = (melee.map_or(0, |m| m.total) - t.total).max(0);
    let mean_melee = if plain_hits > 0 {
        plain_total as f64 / plain_hits as f64
    } else {
        0.0
    };
    let mut l = lane(
        LaneSpec {
            name: FINISHING_BLOW,
            origin: "aa",
            count: hits,
            damage: t.total,
            heal: 0,
            resisted: 0,
            linked: Vec::new(),
        },
        b,
    );
    l.marginal_damage = Some(t.total as f64 - hits as f64 * mean_melee);
    vec![l]
}

/// The lane list, one pass per origin: poison, spell, slay, aa, each block sorted by count desc. The
/// two swing-borne AAs sit last because they are the rows whose `direct_damage` is not the damage
/// the proc added.
fn build_lanes(spec: &ProcsViewSpec, states: &[StateSpan]) -> Vec<ProcLaneView> {
    let b = rate_base(spec, states);
    let you = spec.agg.out.get("you");
    let poison = poison_lanes(spec, you, &b);
    let mut covered: HashSet<String> = HashSet::new();
    for l in &poison {
        for k in candidate_keys(&l.name) {
            covered.insert(k);
        }
    }
    // One entry per distinct `<kind>:<key>`, in the order the spans first appear.
    let mut seen: JsMap<StateSpan> = JsMap::new();
    for s in states {
        let k = state_key_of(s.kind, &s.key);
        if !seen.contains_key(&k) {
            seen.insert(k, s.clone());
        }
    }
    let link_states: Vec<StateSpan> = seen.values().cloned().collect();
    let mut out = poison;
    out.extend(spell_lanes(spec, &b, &covered, &link_states));
    out.extend(slay_lanes(you, &b));
    out.extend(finishing_blow_lanes(you, &b));
    out
}

/// The damage rows one lane covers.
///
/// A slay lane is a presentation exception: the aggregate's rows are the weapon names, and the drill
/// merges them into one row under the lane's name. Tagging the weapon rows instead would put a proc
/// rate on lanes that are mostly ordinary swings.
///
/// A cast-less lane narrows to the marked rows when any exist, so the proc rate does not land on the
/// hand-casts too — the confusion the origin split exists to end.
fn tagged_skills(you: Option<&SourceStat>, l: &ProcLaneView) -> Vec<String> {
    if l.origin == "slay" {
        return vec![l.name.clone()];
    }
    let rows = skills_matching(you, &candidate_keys(&l.name));
    let split: Vec<&(&str, i64, i64)> =
        rows.iter().filter(|s| is_castless_lane_name(s.0)).collect();
    let castless = l.origin == "spell" || l.origin == "click";
    if castless && !split.is_empty() {
        split.iter().map(|s| s.0.to_string()).collect()
    } else {
        rows.iter().map(|s| s.0.to_string()).collect()
    }
}

/// The is-a-proc join: one tag per (damage row, lane), so the drill marks exactly the rows the
/// ledger counts. It runs here because this is where both definitions of "proc" live — the Strike
/// ledger and the cast-less inference — and a second definition downstream is a future
/// disagreement.
///
/// Two absences are deliberate. Only your rows are tagged, since the lanes are folded from your
/// procs. And an `aa` lane is turned away: Finishing Blow rides a swing that stays in the `melee`
/// category, so no row IS the proc.
fn proc_skill_tags(spec: &ProcsViewSpec, lanes: &[ProcLaneView]) -> Vec<ProcSkillTag> {
    let you = spec.agg.out.get("you");
    let landed = effect_landings(spec.agg);
    let mut out = Vec::new();
    for l in lanes {
        if l.origin == "aa" {
            continue;
        }
        let mut skills = tagged_skills(you, l);
        // A damage-less strike (Weakening, Clumsiness and the like deal nothing) is its own row, so
        // the tag joins on the ledger's label the way a damage row's tag joins on its own.
        if skills.is_empty() && landed.contains_key(&candidate_keys(&l.name)[0]) {
            skills.push(l.name.clone());
        }
        for skill in skills {
            out.push(ProcSkillTag {
                skill,
                lane: l.name.clone(),
                origin: l.origin,
                rate: l.rate.clone(),
                active_sec: spec.active_sec,
            });
        }
    }
    out
}

/// The procs-per-minute headline, summed over the lanes it is built from so it cannot drift from the
/// rows beneath it.
///
/// It divides by the segment while every lane divides by its own source window: "how many procs did
/// this fight see per minute" is a question about the fight, and summing lanes measured over
/// disjoint windows would give a rate with no denominator. It carries no source fields, an absence
/// meaning "not applicable" where a lane's means "unknown".
///
/// A click lane is excluded: a button the player pressed is not a proc.
fn overall_rate(lanes: &[ProcLaneView], b: &RateBase) -> ProcRateView {
    proc_rate(&RateInput {
        count: lanes
            .iter()
            .map(|l| if l.origin == "click" { 0 } else { l.count })
            .sum(),
        active_sec: b.active_sec,
        duration_sec: b.duration_sec,
        swings: b.swings,
        source: None,
        source_unknown: false,
    })
}

/// The per-segment proc ledger plus the proc-analytics superset, built entirely from the frozen
/// aggregate and the session state timeline.
///
/// `enc` is present only for a fight: coats-at-engage and the engage-relative timings are questions
/// about one pull's opening instant, and a zone session has no such instant. A zone view therefore
/// reports no `slowLandMs` and no coats rather than measuring from an arbitrary zero.
pub fn build_procs_view(spec: &ProcsViewSpec) -> ProcsView {
    let p = &spec.agg.procs;
    let mut strikes: Vec<ProcLane> = p
        .strikes
        .values()
        .map(|s| ProcLane {
            name: s.name.clone(),
            count: s.count,
            total: None,
            ambiguous: s.ambiguous.then_some(true),
        })
        .collect();
    strikes.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| compare_names(&a.name, &b.name))
    });
    let mut poison_damage: Vec<ProcLane> = p
        .poison_damage
        .values()
        .map(|s| ProcLane {
            name: s.name.clone(),
            count: s.count,
            total: Some(s.total),
            ambiguous: None,
        })
        .collect();
    poison_damage.sort_by(|a, b| {
        b.total
            .unwrap_or(0)
            .cmp(&a.total.unwrap_or(0))
            .then_with(|| compare_names(&a.name, &b.name))
    });
    let mut dispels: Vec<ProcLane> = p
        .dispels
        .values()
        .map(|s| ProcLane {
            name: s.name.clone(),
            count: s.count,
            total: None,
            ambiguous: Some(true),
        })
        .collect();
    dispels.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| compare_names(&a.name, &b.name))
    });

    let coat_at_engage = spec.enc.and_then(|e| e.coat_at_engage.clone());
    let start = spec.enc.map_or(0, |e| e.start_ts);
    let states = spec
        .st
        .state_timeline
        .spans_overlapping(spec.start_ts, spec.end_ts);
    let b = rate_base(spec, &states);
    let lanes = build_lanes(spec, &states);
    let attribution = (spec.kind == "zone").then(|| {
        let for_direct: Vec<LaneForDirect> = lanes
            .iter()
            .map(|l| LaneForDirect {
                name: &l.name,
                direct_damage: l.direct_damage,
                direct_heal: l.direct_heal,
                dps_contribution: l.dps_contribution,
                linked: &l.linked,
            })
            .collect();
        build_attribution_report(spec.id, &spec.agg.windows.list(), &states, &for_direct)
    });
    ProcsView {
        slow_expected: coat_at_engage
            .as_ref()
            .is_some_and(|c| is_slow_capable(&c.poison)),
        combat_at_engage: spec
            .enc
            .map(|e| e.combat_at_engage.clone())
            .unwrap_or_default(),
        coats: spec
            .enc
            .map(|_| {
                p.coats
                    .iter()
                    .map(|c| CoatMarkView {
                        poison: c.poison.clone(),
                        t_ms: (c.ts - start).max(0),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        coat_at_engage,
        strike_count: strikes.iter().map(|l| l.count).sum(),
        slow_lands: p.slow_lands,
        slow_land_ms: (spec.enc.is_some() && p.first_slow_ts > 0)
            .then(|| (p.first_slow_ts - start).max(0)),
        poison_damage_total: poison_damage.iter().map(|l| l.total.unwrap_or(0)).sum(),
        dispel_count: dispels.iter().map(|l| l.count).sum(),
        strikes,
        poison_damage,
        dispels,
        stance_switches: p.stance_switches,
        invocation_switches: p.invocation_switches,
        overall: overall_rate(&lanes, &b),
        proc_skills: proc_skill_tags(spec, &lanes),
        lanes,
        states,
        // Tier B is zone-scope only: a single pull has no inactive sample, so a per-fight
        // counterfactual would invite reading one minute of noise as an effect.
        attribution,
    }
}
