//! THE PROC-LEDGER SERIALIZATION (`src/main/combat/procViews.ts`) — one segment's `Agg` plus the
//! session state timeline, turned into the procs view the renderer draws.
//!
//! ADDITIVE ONLY (law 8). Everything here is a COUNT or an INDEX over damage the meter already
//! counted — `direct_damage` is read back out of the same `Agg` the bars come from, never accumulated
//! a second time. Not one damage total moves.
//!
//! ── THE FOUR COUNTING RULES, because collapsing any of them is how a proc meter starts lying ──
//!
//!   1. A POISON lane counts EMOTES, and reports tick damage separately. `Blood Siphon Strike` in one
//!      measured window is four emotes, fourteen DoT ticks for 658 and thirteen heal lines for 611 —
//!      three numbers, each correct for its own question, and none of them the sum of the others.
//!   2. A poison lane SUPPRESSES the spell-proc lane of the same name. `Asp Venom Strike` prints both
//!      an emote and a `poison damage by Asp Venom Strike` line for ONE proc; emitting both lanes
//!      would count that proc twice in the ppm headline.
//!   3. A SLAY lane's `direct_damage` is "damage on swings that PROCCED slay", NOT "damage slay
//!      added" — the swing was going to land anyway. The excess over an ordinary swing rides in
//!      `marginal_damage` with its assumption stated.
//!   4. A SPELL lane's `count` is the LARGER of its damage-line and heal-line firings, never their
//!      sum. One Lifetap Strike prints both, and adding them reported 24 firings for twelve.
//!
//! ── THE LINK FEED, AND THE TWO ORIGINS THAT DELIBERATELY HAVE NONE ───────────────────────────
//!
//! A lane's `linked` rows are filled from the per-state firing split the lane carries against the
//! per-state swing exposure the proc ledger carries — BOTH folded on ingest, because the event ring is
//! capped, truncated and absent entirely for zone sessions, so a link derived from it would be
//! silently wrong exactly where the sample is biggest.
//!
//! SPELL LANES ONLY. A POISON lane's link to its own coat is TAUTOLOGICAL — an Asp Venom Strike cannot
//! fire without asp venom on the blade, so `exclusive` there restates the mechanic instead of measuring
//! anything. A SLAY lane's count comes from the damage taxonomy rather than from a proc fold, and its
//! `direct_damage` is "damage on swings that procced" rather than damage the proc ADDED, so rolling it
//! up as a state's exact contribution would overstate it by a whole swing each. Both keep an EMPTY
//! list, which is the same discipline as everything else here: a number is absent when the sample
//! cannot support it, never zero-filled.

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

/// One lane of the shipped Task-#64 ledger (Strikes, poison damage, dispels).
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

/// A coat applied INSIDE this fight, stamped relative to the fight's own opening instant. Deliberately
/// not a `CoatSlot`: that shape carries an ABSOLUTE `sinceTs` and answers "when did this go on", while
/// this one answers "how far into the pull" — two different questions with two different keys.
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

/// Everything one procs view needs. A fight, the live zone aggregate and a frozen zone session differ
/// only in these fields.
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
    /// Present only for a FIGHT.
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

/// THE SOURCE-WINDOW INDEX: every state span this segment saw, with the active seconds it was open
/// for, resolvable by the two things that GRANT a proc. `unknown` is not an error state — it is the
/// answer for every item proc, every illusion-granted proc and any buff that predates the window.
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

/// The source window for a POISON lane: the coat spans of every poison whose roster grants one of the
/// lane's Strikes.
///
/// SUMMING those spans is a UNION and not a double count, and the roster is what makes it so: every
/// poison that grants a given Strike is mutually EXCLUSIVE with the others that grant it. All the
/// multi-granting poisons are UTILITY (Weakening Strike comes from Weakening, Binding, Neurotoxic and
/// Paralytic — one utility slot, so at most one is ever on), and every combat Strike is granted by
/// exactly one venom. So no two of the spans being added can overlap.
///
/// Unknown when NO granting coat has an observed span in this segment — the honest state for a coat
/// applied before the window opened with no priming session behind it.
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

/// The source window for a SPELL lane: the tracked proc buff that GRANTS it, when the catalog names
/// one and its span was observed here (`Instrument of Nife` → `Condemnation of Nife`).
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

/// The source-window half of a lane's rate input. THREE STATES, and the third is why this returns a
/// fragment rather than a window:
///   KNOWN   — a coat span or a tracked proc-buff span. The rate is over it, exactly.
///   UNKNOWN — a spell or poison lane whose granting span this segment never saw. The segment is
///             assumed, and `sourceAmbiguous` says so.
///   N/A     — a SLAY or AA lane (an innate ability, permanently owned, with no span at all) or a
///             CLICK lane (the source is an item the dump has just told us the player holds). There is
///             no span that could have been off, so flagging one ambiguous would invite a reader to
///             look for a window that does not exist. It divides by the segment, plainly and exactly.
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

/// One LANE's rates: divided by its source window when the model knows one, and honestly flagged when
/// it does not.
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

/// An emote label may name SEVERAL Strikes — `screams as poison burns their veins!` is Asp Venom
/// Strike OR Cobra Venom Strike, and the ledger keeps both in one ` / `-joined label (law 3: shared
/// messages are the norm; the count is exact, only the name is uncertain). Both candidates are joined
/// against the damage lanes and both suppress their spell-proc twin.
fn candidate_keys(label: &str) -> Vec<String> {
    label
        .split(" / ")
        .map(|n| spell_canon_key(n.trim()))
        .collect()
}

/// YOUR damage rows recorded under any of `keys` — THE one place a proc lane is matched against the
/// meter's own skill lanes. Both consumers read it (the lane's Tier-A damage and the is-a-proc join),
/// so "which rows is this lane" can never come to mean two things.
///
/// Names are matched rank-normalized AND proc-marker-stripped (law 2 at the counting boundary; the
/// origin split is a display decoration, so both halves of a split spell match) and returned RAW,
/// because the raw string is what the drill row is labelled with.
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

/// Damage delivered under a given skill name by YOU, read back out of the same aggregate the meter's
/// bars come from. An INDEX, never a second accumulation.
fn delivered_by(you: Option<&SourceStat>, keys: &[String]) -> i64 {
    skills_matching(you, keys).iter().map(|s| s.1).sum()
}

/// YOUR resists on the rows a lane covers. Same join, same aggregate, same discipline as
/// `delivered_by` — a lane and the drill row beneath it read one counter, not two.
fn resisted_by(you: Option<&SourceStat>, keys: &[String]) -> i64 {
    let Some(you) = you else { return 0 };
    you.by_skill
        .values()
        .filter(|s| keys.contains(&lane_canon_key(&s.name)))
        .map(|s| s.resists)
        .sum()
}

/// Healing recorded under a given skill name by the cast-less detector. Kept SEPARATE from damage: in
/// one measured window the tap returns MORE than it deals (474 healed against 458 dealt), so one can
/// never be derived from the other.
fn healed_by(agg: &Agg, keys: &[String]) -> i64 {
    agg.procs
        .spell_procs
        .iter()
        .filter(|(key, _)| keys.iter().any(|k| k == key))
        .map(|(_, lane)| lane.heal)
        .sum()
}

/// EFFECT LANDINGS WITH NO DAMAGE LINE — the join that closed the reported defect.
///
/// `<mob>'s limbs move slower!` is the ONLY thing a Weakening Strike prints when it lands; its RESISTS
/// print the spell name like any other spell. So the drill built a lane for it entirely out of resists
/// and reported `0 landed · 34 resisted` for a proc that landed 562 times in the same log — while the
/// Procs tab, three inches away, counted every one of those emotes.
///
/// THE GATE IS EXACT RATHER THAN CONVENIENT: a strike lane contributes here ONLY when no row of the
/// meter's has LANDED A HIT under its name. Where a lane DOES land damage the firings are already
/// represented — Asp Venom Strike prints an emote AND a damage line for a single proc, and adding its
/// 424 emotes to its 96 damage hits would report 520 firings for at most 424.
///
/// `hits > 0`, NOT "a row exists": the row is exactly what a resist CREATES, and gating on its
/// existence would have left the defect in place on precisely the lanes that showed it.
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
        // THE OTHER HALF OF THE LANE'S RECORD. `count` is what landed; without this the ledger showed
        // only landings while the drill showed only resists, and the same Weakening Strike read
        // `90 landings` in one panel and `0 landed · 34 resisted` in the other.
        resisted: (s.resisted > 0).then_some(s.resisted),
        resist_pct: (s.resisted > 0).then(|| (s.resisted as f64 / attempts as f64) * 100.0),
        linked: s.linked,
        ambiguous: None,
        marginal_damage: None,
    }
}

/// ROGUE-POISON lanes. `count` is the EMOTE count and nothing else (rule 1).
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

/// CAST-LESS SPELL lanes, minus any name a poison emote already counted (rule 2).
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
                // A HELD CLICKY IS ITS OWN ORIGIN. Same counts, same denominators, same links — the
                // lane's whole record is unchanged; what moves is the WORD every surface prints over
                // it, because "proc" was a claim about a mechanism this firing does not have.
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

/// THE SLAY LANE (rule 3). One lane, from the taxonomy's own `slay` category — a Slay Undead proc rides
/// an ordinary swing and prints no spell line of its own.
///
/// Emitted only when it FIRED: a permanent 0-count row on every non-undead pull is noise, and the
/// absence is already visible in the melee category. `marginal_damage` subtracts the swing that would
/// have landed anyway, at THIS segment's mean melee hit.
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

/// THE FINISHING-BLOW LANE — the other swing-borne AA, and the one that was listed NOWHERE.
///
/// The report was exactly right and its analogy was exactly right. `(Finishing Blow)` has been parsed
/// since the modifier tallies existed and its damage has been counted on the source's `mods` all
/// along. What was missing is that NOTHING RENDERED THAT MAP: the drill groups by skill, so the damage
/// is really there but spread invisibly across Slash / Bash / Strike. The honest description of the
/// defect is not "unparsed" — it is a counted fact with no surface. This gives it one.
///
/// WHY IT IS NOT A CATEGORY, where Slay Undead is one: a category MOVES the damage out of `melee`, and
/// Slay Undead's move had a mechanism behind it. Finishing Blow's damage IS a weapon swing's — bigger,
/// from the same swing — and pulling ~1,600 melee lines into a category of their own would change
/// every melee mean, the swing denominators and the drill's shape to fix a LISTING problem.
///
/// THE BASELINE differs from the slay lane's by one subtraction. Slay swings LEFT the melee category,
/// so `melee` there is already the ordinary body. Finishing Blow swings did NOT, so `melee` here still
/// contains them, and it is the mean of the swings the proc did NOT ride that the excess is meaningful
/// against (measured whole-log: 66.3 ordinary against 167.8 with the modifier).
fn finishing_blow_lanes(you: Option<&SourceStat>, b: &RateBase) -> Vec<ProcLaneView> {
    let Some(t) = you.and_then(|y| y.mods.get(FINISHING_BLOW)) else {
        return Vec::new();
    };
    // `count` includes avoided swings; the miss family only ever carries single-word modifiers, so this
    // subtraction is a guard and not a correction.
    let hits = t.count - t.avoided;
    if hits <= 0 {
        return Vec::new();
    }
    let melee = you.and_then(|y| y.by_category.get("melee"));
    // The ORDINARY body: this category minus the swings this proc rode. Both terms are CLAMPED because
    // a compound carrying BOTH `Slay Undead` and `Finishing Blow` would book its damage under `slay`
    // while the tally still counted it here. Zero such lines exist in any log swept so far (0 of
    // 1,729), and a negative baseline is not worth risking on that.
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

/// The lane list, in one pass per origin. Order: poison, then spell, then slay, then aa — the order the
/// questions get asked, with each block sorted by count desc. The two swing-borne AAs sit together at
/// the end because they are the two rows whose `direct_damage` is not the damage the proc added.
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
/// A SLAY lane is the exception and it is a PRESENTATION one: a Slay Undead proc rides an ordinary
/// weapon swing, so the aggregate's rows are the WEAPON names and the drill merges them into a single
/// row labelled with the lane's own name. That merged row is what carries the rate; tagging the weapon
/// rows instead would put a proc rate on lanes that are mostly ordinary swings.
///
/// THE SPLIT: a `spell` lane counts the CAST-LESS firings of that spell, and those now have a meter row
/// of their own. Tagging every row the spell occupies would put the proc rate on the hand-casts too,
/// which is the exact confusion the split exists to end. When the spell only ever procced there is one
/// row and it carries the marker, so this narrows nothing; the filter therefore applies only once a
/// marked row exists.
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

/// THE IS-A-PROC JOIN. One tag per (damage row, lane), so the drill can say `proc · 3.1 ppm` on exactly
/// the rows the ledger already counts — and on no others.
///
/// It runs HERE because this is where both definitions of "proc" live: the Strike ledger is the poison
/// roster matched exactly and the spell-proc ledger is the cast-less inference. Deriving it again
/// downstream would be a second definition, and a second definition is a future disagreement.
///
/// TWO ABSENCES ARE DELIBERATE: only YOUR rows are tagged (the lanes are folded from your procs, so
/// tagging a pet's row with them would attribute your blades to the pet), and an `aa` lane is turned
/// away outright — Finishing Blow rides a swing and keeps it in the `melee` category, so there is NO
/// row that IS the proc, and both ways to tag it anyway are worse than not tagging it.
///
/// AND ONE WAS OVERTURNED: a lane with no damage row used to produce no tag, which cost the owner the
/// four Strikes they actually care about (Weakening, Clumsiness, Stunning and Banishing deal nothing at
/// all). A damage-less lane with landings now gets its tag AND its row.
fn proc_skill_tags(spec: &ProcsViewSpec, lanes: &[ProcLaneView]) -> Vec<ProcSkillTag> {
    let you = spec.agg.out.get("you");
    let landed = effect_landings(spec.agg);
    let mut out = Vec::new();
    for l in lanes {
        if l.origin == "aa" {
            continue;
        }
        let mut skills = tagged_skills(you, l);
        // A damage-less strike is its OWN row now: the ledger's label is what the drill names it, so
        // the tag joins on that name exactly the way a damage row's tag joins on its own.
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

/// The "procs per minute" headline: an IDENTITY over the lanes it is built from, so it cannot drift
/// from the rows beneath it.
///
/// OVER THE SEGMENT, deliberately, while every lane below it divides by its own source window. "How
/// many procs did this fight see per minute" is a question about the FIGHT, and summing lanes measured
/// over disjoint windows would produce a rate with no denominator at all. So this one keeps the segment
/// and carries no source fields — an absence that means "not applicable", where a lane's absence means
/// "unknown".
///
/// AND A CLICK LANE IS NOT IN IT. This number is printed as `N procs · X ppm`, and a button the player
/// pressed is not a proc.
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
/// `enc` is present only for a FIGHT: coats-at-engage and the engage-relative timings are questions
/// about one pull's opening instant, and a zone session (many pulls, many coat swaps) has no such
/// instant. So a zone view reports the counts and honestly reports NO `slowLandMs` and no coats, rather
/// than measuring from an arbitrary zero.
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
        // TIER B IS OVERALL-SCOPE ONLY. A single pull has no inactive sample, so offering a per-fight
        // counterfactual would be an invitation to read one minute of noise as an effect.
        attribution,
    }
}
