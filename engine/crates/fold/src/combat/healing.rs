//! Healing + absorption: the meter-grade ledger (per healer, per spell, with crit / min / max /
//! overheal) and the serializable view over it.
//!
//! It lives on the same `Agg` the damage bars use, so a healing meter inherits fight / zone-session
//! selection, the finalized-zone-session freeze and the encounter history for free.
//!
//! The honesty rules (world-model law 6 — never say what the log cannot say):
//!
//!   * Overheal comes from the `for N (M) hit points` form only. EQ prints the parens exactly when
//!     raw > effective, so a plain line contributes 0 and the sum is a FLOOR.
//!   * The two `magical skin absorbs` families carry no amount. Counted, never valued.
//!   * A heal the log announces but never values (the monk's Mend) gets an `unstated` lane carrying
//!     a count and a total of 0. That 0 is the absence of a measurement, so it enters no sum.
//!   * A rune's amount is absorption GRANTED, not damage consumed. It ranks in the healing total but
//!     rides an `absorbed` lane for its whole life, and a rune has no overheal — none is invented.
//!   * Rune sources are not split. `You gain a rune for N points of absorption.` is the only
//!     rune-gain shape in the full log and it names no spell and no caster, so there is ONE
//!     absorption lane; the honest handle for a future split is the MESSAGE, never self-damage.
//!
//! `min` is ABSENT, never zero — a lane with no landed line has no `min` at all. Note the asymmetry
//! with the damage model's per-lane minimum: a 0-effective (fully overhealed) tick still LANDED a
//! line, so it participates here, unlike a whiff.

use crate::combat::collate::compare_names;
use crate::jsmap::JsMap;
use serde::Serialize;

/// Spell-less heal lines get one shared lane.
pub const UNSPECIFIED_SPELL: &str = "Unspecified";
/// Display name of the absorption lane.
pub const RUNE_LANE: &str = "Rune";
/// Row id of the self row — the row the absorption and unstated lanes attach to.
pub const SELF_ROW_ID: &str = "you";
/// Cap on serialized spell lanes per healer. It applies to the HEAL lanes only: absorption and
/// unstated lanes are appended after the cap, so a long tail of small heals cannot squeeze them out.
const SPELL_CAP: usize = 14;

/// One heal line, already attributed by the engine.
#[derive(Debug, Clone, Default)]
pub struct HealInput {
    /// Effective (landed) heal.
    pub amount: i64,
    /// Raw/pre-overheal amount, present only on the `(M)` lines.
    pub raw_amount: Option<i64>,
    pub spell: Option<String>,
    pub crit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealSourceKind {
    You,
    Pet,
    Other,
    Enemy,
}

impl HealSourceKind {
    fn as_str(self) -> &'static str {
        match self {
            HealSourceKind::You => "you",
            HealSourceKind::Pet => "pet",
            HealSourceKind::Other => "other",
            HealSourceKind::Enemy => "enemy",
        }
    }
}

#[derive(Debug, Clone)]
struct HealSpellStat {
    name: String,
    total: i64,
    count: i64,
    crits: i64,
    max: i64,
    min: Option<i64>,
    overheal: i64,
    full_overheal: i64,
}

fn new_spell(name: &str) -> HealSpellStat {
    HealSpellStat {
        name: name.to_string(),
        total: 0,
        count: 0,
        crits: 0,
        max: 0,
        min: None,
        overheal: 0,
        full_overheal: 0,
    }
}

#[derive(Debug, Clone)]
struct HealSourceStat {
    name: String,
    kind: HealSourceKind,
    total: i64,
    count: i64,
    crits: i64,
    max: i64,
    min: Option<i64>,
    overheal: i64,
    full_overheal: i64,
    by_spell: JsMap<HealSpellStat>,
}

fn new_source(name: &str, kind: HealSourceKind) -> HealSourceStat {
    HealSourceStat {
        name: name.to_string(),
        kind,
        total: 0,
        count: 0,
        crits: 0,
        max: 0,
        min: None,
        overheal: 0,
        full_overheal: 0,
        by_spell: JsMap::new(),
    }
}

/// The absorption counters. Amounts exist for runes only — the rest are counts by construction,
/// which is why only the rune lane can become a ledger row.
#[derive(Debug, Clone, Default)]
struct MitAccum {
    rune_total: i64,
    rune_count: i64,
    rune_max: i64,
    rune_min: Option<i64>,
    absorbed_swings: i64,
    absorbed_damage_shields: i64,
}

/// The healing half of an aggregate. Two independent ledgers mirroring the damage model's
/// out/incoming split: `friendly` is heals that landed on you, your pets or the player by name;
/// `hostile` is heals that landed on an engaged hostile, ranked by healer. Heals between third
/// parties are not collected — the log gives no faction for an arbitrary name.
#[derive(Debug, Clone, Default)]
pub struct HealAccum {
    friendly: JsMap<HealSourceStat>,
    hostile: JsMap<HealSourceStat>,
    mit: MitAccum,
    /// Amount-less heals by skill name → how many landed. A map rather than a single Mend counter so
    /// the ledger need not change shape if a second amount-less family appears.
    unstated: JsMap<i64>,
}

impl HealAccum {
    pub fn new() -> Self {
        HealAccum::default()
    }

    pub fn add_friendly(&mut self, key: &str, name: &str, kind: HealSourceKind, h: &HealInput) {
        add(&mut self.friendly, key, name, kind, h);
    }

    pub fn add_hostile(&mut self, key: &str, name: &str, h: &HealInput) {
        add(&mut self.hostile, key, name, HealSourceKind::Enemy, h);
    }

    /// One amount-less heal line. A count, and deliberately nothing else.
    pub fn add_unstated(&mut self, skill: &str) {
        let n = self.unstated.get(skill).copied().unwrap_or(0);
        self.unstated.insert(skill.to_string(), n + 1);
    }

    pub fn add_rune(&mut self, amount: i64) {
        let m = &mut self.mit;
        m.rune_total += amount;
        m.rune_count += 1;
        m.rune_max = m.rune_max.max(amount);
        m.rune_min = Some(match m.rune_min {
            Some(prev) => prev.min(amount),
            None => amount,
        });
    }

    pub fn add_absorbed_swing(&mut self) {
        self.mit.absorbed_swings += 1;
    }

    pub fn add_absorbed_damage_shield(&mut self) {
        self.mit.absorbed_damage_shields += 1;
    }
}

/// Track the smallest LANDED heal. A 0-effective (fully overhealed) tick still landed a line, so it
/// participates, unlike the damage model's min, which must never see a miss.
fn accrue_min(cur: Option<i64>, amount: i64) -> Option<i64> {
    Some(match cur {
        Some(prev) => prev.min(amount),
        None => amount,
    })
}

fn add(m: &mut JsMap<HealSourceStat>, key: &str, name: &str, kind: HealSourceKind, h: &HealInput) {
    if !m.contains_key(key) {
        m.insert(key.to_string(), new_source(name, kind));
    }
    let s = m.get_mut(key).expect("just inserted");
    if s.name != name {
        s.name = name.to_string();
    }
    // A healer can later be reclassified (a charmed mob becomes your pet); the latest attribution
    // wins, matching how the damage model relabels a source.
    s.kind = kind;
    // EQ omits the parens whenever nothing was wasted, so a plain line's raw == effective.
    let raw = h.raw_amount.unwrap_or(h.amount);
    let over = (raw - h.amount).max(0);
    s.total += h.amount;
    s.count += 1;
    if h.crit {
        s.crits += 1;
    }
    s.max = s.max.max(h.amount);
    s.min = accrue_min(s.min, h.amount);
    s.overheal += over;
    if h.amount == 0 {
        s.full_overheal += 1;
    }
    // Absent, blank and whitespace-only spell names all fall to the one shared lane; a nullish check
    // would let `''` through as a lane of its own.
    let trimmed = h.spell.as_deref().map(str::trim).unwrap_or("");
    let spell_name = if trimmed.is_empty() {
        UNSPECIFIED_SPELL
    } else {
        trimmed
    };
    if !s.by_spell.contains_key(spell_name) {
        s.by_spell
            .insert(spell_name.to_string(), new_spell(spell_name));
    }
    let sp = s.by_spell.get_mut(spell_name).expect("just inserted");
    sp.total += h.amount;
    sp.count += 1;
    if h.crit {
        sp.crits += 1;
    }
    sp.max = sp.max.max(h.amount);
    sp.min = accrue_min(sp.min, h.amount);
    sp.overheal += over;
    if h.amount == 0 {
        sp.full_overheal += 1;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealSpellView {
    pub name: String,
    pub total: i64,
    pub pct: f64,
    pub count: i64,
    pub crits: i64,
    pub max: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    pub overheal: i64,
    pub full_overheal: i64,
    pub classification: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealSourceView {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub total: i64,
    pub absorbed_total: i64,
    pub hps: f64,
    pub pct: f64,
    pub count: i64,
    pub unstated_count: i64,
    pub crits: i64,
    pub crit_pct: f64,
    pub max: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    pub overheal: i64,
    pub overheal_pct: f64,
    pub full_overheal: i64,
    pub spells: Vec<HealSpellView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MitigationView {
    pub rune_total: i64,
    pub rune_count: i64,
    pub rune_max: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rune_min: Option<i64>,
    pub absorbed_swings: i64,
    pub absorbed_damage_shields: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealingView {
    pub healers: Vec<HealSourceView>,
    pub total: i64,
    pub hps: f64,
    pub restored_total: i64,
    pub absorbed_total: i64,
    pub overheal: i64,
    pub enemy_healers: Vec<HealSourceView>,
    pub enemy_total: i64,
    pub mitigation: MitigationView,
}

fn heal_lanes(s: &HealSourceStat) -> Vec<HealSpellView> {
    let mut rows: Vec<&HealSpellStat> = s.by_spell.values().collect();
    rows.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then(b.count.cmp(&a.count))
            .then_with(|| compare_names(&a.name, &b.name))
    });
    rows.into_iter()
        .take(SPELL_CAP)
        .map(|r| HealSpellView {
            name: r.name.clone(),
            total: r.total,
            pct: 0.0,
            count: r.count,
            crits: r.crits,
            max: r.max,
            min: r.min,
            overheal: r.overheal,
            full_overheal: r.full_overheal,
            classification: "restored",
        })
        .collect()
}

/// The rune grants as one drill lane. No crits and no overheal: the log never says a shield expired
/// unused, so "wasted absorption" would be an invention.
fn rune_lane(m: &MitAccum) -> Option<HealSpellView> {
    if m.rune_count == 0 {
        return None;
    }
    Some(HealSpellView {
        name: RUNE_LANE.to_string(),
        total: m.rune_total,
        pct: 0.0,
        count: m.rune_count,
        crits: 0,
        max: m.rune_max,
        min: m.rune_min,
        overheal: 0,
        full_overheal: 0,
        classification: "absorbed",
    })
}

/// The amount-less heal lanes. Every field that would be a claim about SIZE stays 0, and `min` is
/// absent rather than zero. `count` is the entire content of the lane, as of the line.
fn unstated_lanes(m: &JsMap<i64>) -> Vec<HealSpellView> {
    let mut rows: Vec<(&str, i64)> = m.iter().map(|(k, v)| (k, *v)).collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| compare_names(a.0, b.0)));
    rows.into_iter()
        .map(|(name, count)| HealSpellView {
            name: name.to_string(),
            total: 0,
            pct: 0.0,
            count,
            crits: 0,
            max: 0,
            min: None,
            overheal: 0,
            full_overheal: 0,
            classification: "unstated",
        })
        .collect()
}

/// One flat ranked list — heals and absorption together, biggest first, each lane keeping its
/// classification so the two are never confused. Deliberately not grouped into sections.
fn rank_lanes(mut lanes: Vec<HealSpellView>) -> Vec<HealSpellView> {
    lanes.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then(b.count.cmp(&a.count))
            .then_with(|| compare_names(&a.name, &b.name))
    });
    let max = lanes.iter().map(|r| r.total).max().unwrap_or(0).max(1) as f64;
    for l in &mut lanes {
        l.pct = (l.total as f64 / max) * 100.0;
    }
    lanes
}

/// A ledger row. `pct` / `hps` are placeholders — they are relative to the final row set, so
/// `rank_rows` fills them in last.
///
/// `extra_lanes` carries the absorption and unstated lanes onto the row they belong to. The row's
/// HEADLINE stats stay about restored healing only (law 5): `total` is the combined ranking figure
/// and `absorbedTotal` says how much of it is absorption.
fn to_view(key: &str, s: &HealSourceStat, extra_lanes: Vec<HealSpellView>) -> HealSourceView {
    let absorbed_total: i64 = extra_lanes
        .iter()
        .filter(|l| l.classification == "absorbed")
        .map(|l| l.total)
        .sum();
    // Summed off the lanes rather than tracked a second time on the row, so the two cannot disagree.
    let unstated_count: i64 = extra_lanes
        .iter()
        .filter(|l| l.classification == "unstated")
        .map(|l| l.count)
        .sum();
    let mut spells = heal_lanes(s);
    spells.extend(extra_lanes);
    HealSourceView {
        id: key.to_string(),
        name: s.name.clone(),
        kind: s.kind.as_str(),
        total: s.total + absorbed_total,
        absorbed_total,
        hps: 0.0,
        pct: 0.0,
        count: s.count,
        unstated_count,
        crits: s.crits,
        crit_pct: if s.count > 0 {
            (s.crits as f64 / s.count as f64) * 100.0
        } else {
            0.0
        },
        max: s.max,
        min: s.min,
        overheal: s.overheal,
        // Relative to restored healing, never to the combined total: absorption in the denominator
        // would deflate a healer's overheal rate.
        overheal_pct: if s.total + s.overheal > 0 {
            (s.overheal as f64 / (s.total + s.overheal) as f64) * 100.0
        } else {
            0.0
        },
        full_overheal: s.full_overheal,
        spells: rank_lanes(spells),
    }
}

/// Sort the final row set and derive the two scope-relative figures (bar fill + rate).
fn rank_rows(mut rows: Vec<HealSourceView>, duration_sec: f64) -> Vec<HealSourceView> {
    rows.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then(b.count.cmp(&a.count))
            .then_with(|| compare_names(&a.name, &b.name))
    });
    let max = rows.iter().map(|r| r.total).max().unwrap_or(0).max(1) as f64;
    let dur = f64::max(1.0, duration_sec);
    for r in &mut rows {
        r.pct = (r.total as f64 / max) * 100.0;
        r.hps = r.total as f64 / dur;
    }
    rows
}

fn source_views(m: &JsMap<HealSourceStat>, duration_sec: f64) -> Vec<HealSourceView> {
    rank_rows(
        m.iter().map(|(k, s)| to_view(k, s, Vec::new())).collect(),
        duration_sec,
    )
}

fn mitigation_view(m: &MitAccum) -> MitigationView {
    MitigationView {
        rune_total: m.rune_total,
        rune_count: m.rune_count,
        rune_max: m.rune_max,
        rune_min: m.rune_min,
        absorbed_swings: m.absorbed_swings,
        absorbed_damage_shields: m.absorbed_damage_shields,
    }
}

/// Serialize an accumulator into the snapshot's healing view.
///
/// The rune lane attaches to the self row so a drill-down is one flat ranked list of everything that
/// kept you up. The self row is SYNTHESIZED when it does not exist: absorption with no heals is a
/// real segment, and so is an unstated heal with no valued heal beside it.
///
/// `You gain a rune for N points of absorption.` names no caster, so "you granted it" is not
/// something the log says. It rides your own sustain row because the line is addressed to you, and
/// it is labeled as absorption everywhere it appears rather than merged (law 1).
///
/// The enemy ledger gets no absorption: runes are yours, and a mob's own shield is a miss.
pub fn build_healing_view(acc: &HealAccum, duration_sec: f64) -> HealingView {
    let mut extras: Vec<HealSpellView> = Vec::new();
    if let Some(rune) = rune_lane(&acc.mit) {
        extras.push(rune);
    }
    extras.extend(unstated_lanes(&acc.unstated));

    let mut rows: Vec<HealSourceView> = Vec::new();
    let mut self_seen = false;
    for (key, s) in acc.friendly.iter() {
        let is_self = key == SELF_ROW_ID;
        if is_self {
            self_seen = true;
        }
        let e = if is_self { extras.clone() } else { Vec::new() };
        rows.push(to_view(key, s, e));
    }
    if !extras.is_empty() && !self_seen {
        rows.push(to_view(
            SELF_ROW_ID,
            &new_source("You", HealSourceKind::You),
            extras,
        ));
    }
    let healers = rank_rows(rows, duration_sec);
    let enemy_healers = source_views(&acc.hostile, duration_sec);
    let total: i64 = healers.iter().map(|h| h.total).sum();
    let absorbed_total: i64 = healers.iter().map(|h| h.absorbed_total).sum();
    HealingView {
        total,
        hps: total as f64 / f64::max(1.0, duration_sec),
        restored_total: total - absorbed_total,
        absorbed_total,
        overheal: healers.iter().map(|h| h.overheal).sum(),
        enemy_total: enemy_healers.iter().map(|h| h.total).sum(),
        healers,
        enemy_healers,
        mitigation: mitigation_view(&acc.mit),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heal(amount: i64, raw: Option<i64>, spell: &str) -> HealInput {
        HealInput {
            amount,
            raw_amount: raw,
            spell: Some(spell.to_string()),
            crit: false,
        }
    }

    /// Overheal is a floor: only the parenthesised form contributes, a plain line contributes 0.
    #[test]
    fn overheal_comes_only_from_the_parenthesised_form() {
        let mut a = HealAccum::new();
        a.add_friendly(
            "you",
            "You",
            HealSourceKind::You,
            &heal(100, None, "Healing"),
        );
        a.add_friendly(
            "you",
            "You",
            HealSourceKind::You,
            &heal(40, Some(120), "Healing"),
        );
        let v = build_healing_view(&a, 10.0);
        assert_eq!(v.healers[0].overheal, 80);
        assert_eq!(v.healers[0].total, 140);
        assert_eq!(v.overheal, 80);
    }

    /// A rune is absorption, not restoration: it ranks in the total, rides an `absorbed` lane, and
    /// never touches the row's heal stats.
    #[test]
    fn a_rune_lane_rides_the_self_row_without_moving_its_heal_stats() {
        let mut a = HealAccum::new();
        a.add_rune(394);
        let v = build_healing_view(&a, 10.0);
        assert_eq!(v.healers.len(), 1);
        let row = &v.healers[0];
        assert_eq!(row.id, "you");
        assert_eq!(row.count, 0);
        assert_eq!(row.total, 394);
        assert_eq!(row.absorbed_total, 394);
        assert_eq!(v.restored_total, 0);
        assert_eq!(row.spells[0].classification, "absorbed");
        // …and the row's own `min` is ABSENT, because nothing was restored.
        assert!(row.min.is_none());
    }

    /// An unstated heal is a count and nothing else: total 0, no min, and it enters no sum.
    #[test]
    fn an_unstated_lane_carries_a_count_and_no_measurement() {
        let mut a = HealAccum::new();
        a.add_unstated("Mend");
        let v = build_healing_view(&a, 10.0);
        let row = &v.healers[0];
        assert_eq!(row.unstated_count, 1);
        assert_eq!(row.total, 0);
        assert_eq!(v.total, 0);
        let lane = &row.spells[0];
        assert_eq!(lane.classification, "unstated");
        assert_eq!(lane.count, 1);
        assert!(lane.min.is_none());
    }

    /// A spell-less line falls to one shared lane, and so does a whitespace-only name.
    #[test]
    fn a_nameless_heal_falls_to_the_one_shared_lane() {
        let mut a = HealAccum::new();
        a.add_friendly(
            "you",
            "You",
            HealSourceKind::You,
            &HealInput {
                amount: 10,
                ..HealInput::default()
            },
        );
        a.add_friendly(
            "you",
            "You",
            HealSourceKind::You,
            &HealInput {
                amount: 5,
                spell: Some("   ".into()),
                ..HealInput::default()
            },
        );
        let v = build_healing_view(&a, 10.0);
        assert_eq!(v.healers[0].spells.len(), 1);
        assert_eq!(v.healers[0].spells[0].name, UNSPECIFIED_SPELL);
        assert_eq!(v.healers[0].spells[0].count, 2);
    }

    /// A fully overhealed tick still LANDED, so it moves `min` to 0 — the opposite of the damage
    /// model's rule, and deliberately so.
    #[test]
    fn a_zero_effective_heal_still_counts_as_a_landed_line() {
        let mut a = HealAccum::new();
        a.add_friendly(
            "you",
            "You",
            HealSourceKind::You,
            &heal(20, None, "Regeneration"),
        );
        a.add_friendly(
            "you",
            "You",
            HealSourceKind::You,
            &heal(0, Some(20), "Regeneration"),
        );
        let v = build_healing_view(&a, 10.0);
        assert_eq!(v.healers[0].min, Some(0));
        assert_eq!(v.healers[0].full_overheal, 1);
    }
}
