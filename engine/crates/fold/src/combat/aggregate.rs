//! Pure accumulation over a segment (encounter or zone session): per-source / per-category /
//! per-skill damage stats, accuracy and resist counters, the target ledger, healing annotations.
//! Routing decides which aggregate a line belongs to; this file only folds.
//!
//! The ledgers beside the damage half (`heal`, `procs`, `windows`, and `SourceStat`'s `mods` /
//! `rounds` / `round_acc`) fold on ingest because the encounter event ring is capped, truncated at
//! finalize and absent for zone sessions. None of them moves a damage total — every field is a
//! count or an index over damage already booked.
//!
//! `out` / `inc` / `targets` publish their iteration order, so they are `JsMap`s, never `HashMap`s.

use crate::combat::healing::HealAccum;
use crate::combat::procdetect::{add_spell_proc, SpellProcFold, SpellProcLane};
use crate::combat::procwindows::WindowAccum;
use crate::combat::rounds::{RoundAccum, SwingRecord};
use crate::jsmap::JsMap;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

/// The engine's internal damage record. Sourced from the canonical `damage` event, but with a
/// non-null attacker — caster-less other-player DoTs carry `attacker: null` and are dropped by the
/// caller before this is built.
///
/// Borrows the parser's bytes: nothing on the routing path retains the record, so whatever keeps a
/// name owns it at the point of retention. `skill` and `category` are `Cow` because the engine may
/// rewrite them (lane rename, derived taxonomy fallback); every other field is a slice of the
/// payload. The lifetime is the event's, not the engine's.
#[derive(Debug, Clone)]
pub struct DamageEvent<'a> {
    pub ts: i64,
    pub attacker: &'a str,
    pub target: &'a str,
    pub amount: i64,
    pub dtype: &'a str,
    pub dclass: Option<&'a str>,
    pub skill: Cow<'a, str>,
    pub crit: bool,
    /// Taxonomy category. Derived from dtype+modifiers when the event omits it, so aggregation
    /// always has an axis.
    pub category: Cow<'a, str>,
    /// Parsed paren-modifier tokens, e.g. `["Riposte", "Critical"]`.
    pub modifiers: &'a [&'a str],
    /// The un-conjugated melee verb (`strike`, `kick`), on melee/slay lines only. The join key
    /// between a swing and the active special attack.
    pub verb: Option<&'a str>,
}

/// The identity of a meter row. Bundled because the outgoing routing paths resolve all three once
/// and hand the same triple to every `Agg` method.
#[derive(Debug, Clone)]
pub struct SourceRef {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
}

/// `shared/combat.ts SourceKind`. An enum because exactly one transition between two kinds is legal
/// (`Other` → `Member`, see `reid`); every other kind is constant for a given row id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    You,
    Pet,
    Member,
    Other,
    AllyPet,
    Enemy,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::You => "you",
            SourceKind::Pet => "pet",
            SourceKind::Member => "member",
            SourceKind::Other => "other",
            SourceKind::AllyPet => "allyPet",
            SourceKind::Enemy => "enemy",
        }
    }
}

/// `shared/logEvents.ts MissType` — the six avoided-swing outcomes, in the order the breakdown is
/// serialized in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissType {
    Miss,
    Dodge,
    Parry,
    Riposte,
    Block,
    Absorb,
}

impl MissType {
    pub fn parse(s: &str) -> Option<MissType> {
        Some(match s {
            "miss" => MissType::Miss,
            "dodge" => MissType::Dodge,
            "parry" => MissType::Parry,
            "riposte" => MissType::Riposte,
            "block" => MissType::Block,
            "absorb" => MissType::Absorb,
            _ => return None,
        })
    }

    fn slot(self) -> usize {
        self as usize
    }

    /// The log's own word for the outcome — a timeline instant's `detail`.
    pub fn as_str(self) -> &'static str {
        match self {
            MissType::Miss => "miss",
            MissType::Dodge => "dodge",
            MissType::Parry => "parry",
            MissType::Riposte => "riposte",
            MissType::Block => "block",
            MissType::Absorb => "absorb",
        }
    }
}

/// One avoided swing as the aggregate folds it. `verb` / `lane_skill` / `modifiers` / `target` are
/// the additive, amount-free inputs to the round grouper and the modifier tallies.
#[derive(Debug, Clone)]
pub struct MissFold {
    pub mtype: MissType,
    /// The accuracy lane the miss counts against — `Melee` for every avoided swing.
    pub skill: String,
    /// Un-conjugated verb off the miss line, when it named one.
    pub verb: Option<String>,
    /// The round lane's display name for that verb (special-attack renamed) — never the aggregation
    /// lane above, which stays `Melee`.
    pub lane_skill: Option<String>,
    pub modifiers: Vec<String>,
    pub target: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Default)]
pub struct SkillStat {
    pub name: String,
    pub total: i64,
    pub hits: i64,
    pub crits: i64,
    pub max: i64,
    /// Smallest landed amount on this lane; 0 = "no landed hit yet" (see `accrue_min`).
    pub min: i64,
    pub misses: i64,
    pub resists: i64,
}

fn new_skill(name: &str) -> SkillStat {
    SkillStat {
        name: name.to_string(),
        ..SkillStat::default()
    }
}

/// Fold a landed amount into a per-skill running minimum. 0 is the "nothing landed yet" sentinel:
/// `route()` drops `amount <= 0`, so every value reaching here is > 0 and a lane that only missed
/// or resisted keeps min 0.
fn accrue_min(prev: i64, amount: i64) -> i64 {
    if prev == 0 {
        amount
    } else {
        prev.min(amount)
    }
}

/// Per-category rollup within a source (drill-down level 2). Holds the category total plus its own
/// per-skill breakdown (level 3).
#[derive(Debug, Clone, Default)]
pub struct CategoryStat {
    pub category: String,
    pub total: i64,
    pub hits: i64,
    pub crits: i64,
    pub max: i64,
    pub resists: i64,
    pub by_skill: JsMap<SkillStat>,
}

/// One base modifier's tally on a source. Counts, plus the landed line's own amount re-read into
/// `total`.
///
/// The log prints 14 compound modifier forms which decompose over 8 bases (Critical, Riposte, Slay
/// Undead, Finishing Blow, Flurry, Rampage, Crippling Blow, Strikethrough). The parser decomposes;
/// this tallies the components.
///
/// `total` is an index, not a second accumulation — `add_to_source` already booked the amount into
/// the source, the category and the lane. Avoided swings carry no amount and contribute 0.
#[derive(Debug, Clone)]
pub struct ModifierTally {
    pub name: String,
    /// Annotated swings/casts — landed AND avoided.
    pub count: i64,
    /// Of those, how many carried no amount (an avoided swing).
    pub avoided: i64,
    pub total: i64,
}

/// The legacy melee-rounds heuristic: `skill_lower` → (`floor(ts/1000)` → hits in that bucket).
///
/// The buckets are the only state; the hits-per-round histogram is derived at view time and not
/// cached back, because a view build may not write to the aggregate. `HashMap` and not `JsMap`
/// because `finalize_rounds` counts the values and never publishes an order.
#[derive(Debug, Clone, Default)]
pub struct RoundsAccum {
    pub bucket: HashMap<String, HashMap<i64, i64>>,
}

fn accrue_round(r: &mut RoundsAccum, skill: &str, ts: i64) {
    let seconds = r.bucket.entry(skill.to_lowercase()).or_default();
    *seconds.entry(ts.div_euclid(1_000)).or_insert(0) += 1;
}

/// Collapse the in-progress buckets into the hits-per-round histogram. Read-only, so calling it at
/// snapshot or finalize is safe and repeatable.
pub fn finalize_rounds(r: &RoundsAccum) -> Vec<i64> {
    let mut hist: Vec<i64> = Vec::new();
    for seconds in r.bucket.values() {
        for &hits in seconds.values() {
            let idx = (hits - 1).max(0) as usize;
            if hist.len() <= idx {
                hist.resize(idx + 1, 0);
            }
            hist[idx] += 1;
        }
    }
    hist
}

#[derive(Debug, Clone)]
pub struct SourceStat {
    pub name: String,
    pub kind: SourceKind,
    pub total: i64,
    pub hits: i64,
    pub crits: i64,
    pub ambiguous_hits: i64,
    pub ambiguous_total: i64,
    /// Avoided swings by this source, all outcomes.
    pub misses: i64,
    /// The six-slot breakdown, indexed by `MissType`.
    pub miss: [i64; 6],
    pub resists: i64,
    pub by_skill: JsMap<SkillStat>,
    pub by_category: JsMap<CategoryStat>,
    /// The legacy melee-rounds heuristic.
    pub rounds: RoundsAccum,
    /// Base-modifier tallies — see `ModifierTally`.
    pub mods: JsMap<ModifierTally>,
    /// Per (verb, swings-per-round) counters, built by the pure grouper in `rounds.rs`. It reads a
    /// swing's amount for the fan-out signature and stores none of it.
    pub round_acc: RoundAccum,
}

pub fn new_source(name: &str, kind: SourceKind) -> SourceStat {
    SourceStat {
        name: name.to_string(),
        kind,
        total: 0,
        hits: 0,
        crits: 0,
        ambiguous_hits: 0,
        ambiguous_total: 0,
        misses: 0,
        miss: [0; 6],
        resists: 0,
        by_skill: JsMap::new(),
        by_category: JsMap::new(),
        rounds: RoundsAccum::default(),
        mods: JsMap::new(),
        round_acc: RoundAccum::new(),
    }
}

/// A damage total booked against a named entity — the `targets`, `enemy_heal` and `inc_heal` shape.
#[derive(Debug, Clone)]
pub struct NamedTotal {
    pub name: String,
    pub amount: i64,
    /// Only `inc_heal` counts; the other two carry 0 and never publish it.
    pub count: i64,
}

/// A rogue-poison Strike lane. Keyed by the display name, ambiguity included — an emote shared by
/// two Strikes keeps both in one ` / `-joined label. The count is exact, the name may not be.
#[derive(Debug, Clone)]
pub struct StrikeLane {
    pub name: String,
    pub count: i64,
    pub ambiguous: bool,
}

/// A poison-typed damage lane. The game states the damage type on every typed spell line, so this
/// is printed fact rather than a name-matched guess. An index over damage already counted.
#[derive(Debug, Clone)]
pub struct PoisonLane {
    pub name: String,
    pub count: i64,
    pub total: i64,
}

/// A dispel landing lane. Every one is ambiguous by construction — each message tier is shared by
/// 2–3 spells.
#[derive(Debug, Clone)]
pub struct DispelLane {
    pub name: String,
    pub count: i64,
}

/// One coat applied inside a segment, in order.
#[derive(Debug, Clone)]
pub struct CoatMark {
    pub poison: String,
    pub ts: i64,
}

/// The per-segment proc accumulator. Pure counters, incremented on ingest from lines the game
/// printed, so a downsampled or truncated timeline can never move a number here.
#[derive(Debug, Default)]
pub struct ProcAccum {
    pub strikes: JsMap<StrikeLane>,
    /// Weakening-Strike landings — broken out because it is the one we time.
    pub slow_lands: i64,
    /// Absolute ts of the first slow landing in this segment (0 = none).
    pub first_slow_ts: i64,
    pub poison_damage: JsMap<PoisonLane>,
    pub dispels: JsMap<DispelLane>,
    /// Your coats applied inside this segment, in order.
    pub coats: Vec<CoatMark>,
    pub stance_switches: i64,
    pub invocation_switches: i64,
    /// Your logged swing attempts here: melee + slay hits, plus your misses. The mechanical
    /// denominator for a chance-on-hit proc rate. The log does not distinguish main-hand from
    /// off-hand or double/triple attack, so this is swings as logged.
    pub swings: i64,
    /// `<kind>:<key>` → how many of those swings were logged while that state was open. The other
    /// half of a link: "it never fired without it" is evidence only in proportion to the swings
    /// there were without it.
    pub swings_by_state: JsMap<i64>,
    /// Ms of the meter's own active time that elapsed while a state was open — the PPM denominator
    /// for a lane whose source window is known. Folded from the same per-hit delta the window ledger
    /// receives, so the two cannot drift.
    pub active_ms_by_state: JsMap<i64>,
    /// Cast-less spell lanes, keyed by `spell_canon_key`. Their damage is already inside this
    /// segment's outgoing total — an index, never a second accumulation.
    pub spell_procs: JsMap<SpellProcLane>,
}

impl ProcAccum {
    /// Count one of your logged swing attempts against the states open when you made it. The total
    /// and the per-state split move together so no call site can update one without the other.
    pub fn add_swing(&mut self, active: &HashSet<String>) {
        self.swings += 1;
        for key in active {
            bump_state(&mut self.swings_by_state, key, 1);
        }
    }

    /// Charge one hit's active-time delta to every state open for it. Called on every folded damage
    /// line, incoming included, because that is what the meter's own `active_ms` counts — the two
    /// denominators must mean the same thing to be comparable.
    pub fn add_active_ms(&mut self, ms: i64, active: &HashSet<String>) {
        if ms <= 0 {
            return;
        }
        for key in active {
            bump_state(&mut self.active_ms_by_state, key, ms);
        }
    }

    pub fn add_spell_proc(&mut self, f: &SpellProcFold) {
        add_spell_proc(&mut self.spell_procs, f);
    }

    pub fn add_strike(&mut self, name: &str, ambiguous: bool, ts: i64, is_slow: bool) {
        if !self.strikes.contains_key(name) {
            self.strikes.insert(
                name.to_string(),
                StrikeLane {
                    name: name.to_string(),
                    count: 0,
                    ambiguous,
                },
            );
        }
        self.strikes.get_mut(name).expect("just inserted").count += 1;
        if is_slow {
            self.slow_lands += 1;
            if self.first_slow_ts == 0 {
                self.first_slow_ts = ts;
            }
        }
    }

    pub fn add_poison_damage(&mut self, skill: &str, amount: i64) {
        if !self.poison_damage.contains_key(skill) {
            self.poison_damage.insert(
                skill.to_string(),
                PoisonLane {
                    name: skill.to_string(),
                    count: 0,
                    total: 0,
                },
            );
        }
        let s = self.poison_damage.get_mut(skill).expect("just inserted");
        s.count += 1;
        s.total += amount;
    }

    pub fn add_dispel(&mut self, label: &str) {
        if !self.dispels.contains_key(label) {
            self.dispels.insert(
                label.to_string(),
                DispelLane {
                    name: label.to_string(),
                    count: 0,
                },
            );
        }
        self.dispels.get_mut(label).expect("just inserted").count += 1;
    }
}

fn bump_state(map: &mut JsMap<i64>, key: &str, by: i64) {
    let n = map.get(key).copied().unwrap_or(0);
    map.insert(key.to_string(), n + by);
}

/// The per-segment aggregate. Keyed by instance id (or `you` / `pet:<instanceId>` / `member:<key>` /
/// `allypet:<charmer>:<pet>`); `name` holds the display spelling, refreshed on every arrival because
/// the log's latest spelling wins.
#[derive(Debug, Default)]
pub struct Agg {
    pub out: JsMap<SourceStat>,
    pub inc: JsMap<SourceStat>,
    pub targets: JsMap<NamedTotal>,
    /// Healing received by hostile instances engaged here (instanceId → total).
    pub enemy_heal: JsMap<NamedTotal>,
    /// Healing received by You / your pets: healerKey → { name, total, count }.
    pub inc_heal: JsMap<NamedTotal>,
    /// The meter-grade healing + absorption ledger. On the same aggregate as the damage bars so the
    /// healing overlays inherit fight / zone-session selection, the finalized freeze and the
    /// encounter history for free. `enemy_heal` / `inc_heal` above are untouched by it.
    pub heal: HealAccum,
    /// Proc ledger — Strikes, poison-typed lanes, non-damage spell landings on engaged mobs, and the
    /// stance/coat bookkeeping. On the `Agg` for the same reason the healing ledger is.
    pub procs: ProcAccum,
    /// The minute-window ledger the Tier-B counterfactual is computed from. On the `Agg` for the
    /// same reason again: a finalized zone session inherits it frozen.
    pub windows: WindowAccum,
}

impl Agg {
    pub fn new() -> Self {
        Agg::default()
    }

    /// Sum of a source map's totals — the DPS numerator for a segment.
    pub fn sum(map: &JsMap<SourceStat>) -> i64 {
        map.values().map(|s| s.total).sum()
    }

    pub fn sum_heal(map: &JsMap<NamedTotal>) -> i64 {
        map.values().map(|t| t.amount).sum()
    }

    /// True when this aggregate recorded nothing at all — the drop rule `finalize_current` and
    /// `finalize_zone_session` are gated on, so a shell opened by a mez that somebody else killed
    /// never reaches the history or the zone-session picker.
    ///
    /// Map emptiness, not a total: a miss creates a source row with no damage, and that encounter is
    /// kept because the hit-rate is real even when the damage is zero.
    pub fn is_empty(&self) -> bool {
        self.out.is_empty() && self.inc.is_empty()
    }

    /// Re-state a row's identity from the ref that just arrived: latest display name wins, and the
    /// kind may make exactly one transition, `Other` → `Member`, so a combatant the roster admits
    /// mid-fight re-labels its bar instead of splitting into two.
    ///
    /// One-way on purpose: the roster's admission set is cleared by a self-leave, and what a fight's
    /// damage was must not change when the group ends.
    fn reid(s: &mut SourceStat, r: &SourceRef) {
        if s.name != r.name {
            s.name = r.name.clone();
        }
        if s.kind == SourceKind::Other && r.kind == SourceKind::Member {
            s.kind = SourceKind::Member;
        }
    }

    fn out_row(&mut self, r: &SourceRef) -> &mut SourceStat {
        if !self.out.contains_key(&r.id) {
            self.out.insert(r.id.clone(), new_source(&r.name, r.kind));
        }
        let s = self.out.get_mut(&r.id).expect("just inserted");
        Agg::reid(s, r);
        s
    }

    fn inc_row(&mut self, id: &str, name: &str) -> &mut SourceStat {
        if !self.inc.contains_key(id) {
            self.inc
                .insert(id.to_string(), new_source(name, SourceKind::Enemy));
        }
        self.inc.get_mut(id).expect("just inserted")
    }

    /// Drop a recorded row. The one caller is `retract_other`: a name a stronger model has just
    /// claimed as a pet must not keep a second bar beside the pet's own. Safe because an `Other` row
    /// enters no you/pet total and no target/engaged set.
    pub fn drop_out(&mut self, id: &str) -> bool {
        self.out.remove(id)
    }

    pub fn add_out(&mut self, r: &SourceRef, ev: &DamageEvent<'_>, ambiguous: bool) {
        add_to_source(self.out_row(r), ev, ambiguous);
    }

    pub fn add_inc(&mut self, id: &str, name: &str, ev: &DamageEvent<'_>) {
        add_to_source(self.inc_row(id, name), ev, false);
    }

    pub fn add_out_miss(&mut self, r: &SourceRef, m: &MissFold) {
        add_miss_to_source(self.out_row(r), m);
    }

    pub fn add_inc_miss(&mut self, id: &str, name: &str, m: &MissFold) {
        add_miss_to_source(self.inc_row(id, name), m);
    }

    pub fn add_out_resist(&mut self, r: &SourceRef, spell: &str, category: &str) {
        add_resist_to_source(self.out_row(r), spell, category);
    }

    pub fn add_inc_resist(&mut self, id: &str, name: &str, spell: &str, category: &str) {
        add_resist_to_source(self.inc_row(id, name), spell, category);
    }

    pub fn add_enemy_heal(&mut self, id: &str, name: &str, amount: i64) {
        bump(&mut self.enemy_heal, id, name, amount, false);
    }

    pub fn add_inc_heal(&mut self, healer_key: &str, name: &str, amount: i64) {
        bump(&mut self.inc_heal, healer_key, name, amount, true);
    }

    pub fn bump_target(&mut self, id: &str, name: &str, amount: i64) {
        bump(&mut self.targets, id, name, amount, false);
    }
}

fn bump(map: &mut JsMap<NamedTotal>, id: &str, name: &str, amount: i64, counted: bool) {
    if !map.contains_key(id) {
        map.insert(
            id.to_string(),
            NamedTotal {
                name: name.to_string(),
                amount: 0,
                count: 0,
            },
        );
    }
    let t = map.get_mut(id).expect("just inserted");
    t.amount += amount;
    if counted {
        t.count += 1;
    }
}

fn add_to_source(src: &mut SourceStat, ev: &DamageEvent<'_>, ambiguous: bool) {
    src.total += ev.amount;
    src.hits += 1;
    if ev.crit {
        src.crits += 1;
    }
    if ambiguous {
        src.ambiguous_hits += 1;
        src.ambiguous_total += ev.amount;
    }
    {
        let s = lane(&mut src.by_skill, &ev.skill);
        s.total += ev.amount;
        s.hits += 1;
        if ev.crit {
            s.crits += 1;
        }
        s.max = s.max.max(ev.amount);
        s.min = accrue_min(s.min, ev.amount);
    }
    add_to_category(src, ev);
    add_swing_counters(src, ev);
}

/// The count-only counters a landed swing feeds: the melee-rounds heuristic, the base modifier
/// tallies, and the attack-round grouper. None of them touches `src.total`, a category total or a
/// lane total.
fn add_swing_counters(src: &mut SourceStat, ev: &DamageEvent<'_>) {
    let is_swing = ev.category == "melee" || ev.category == "slay";
    // Only melee/slay hits cluster into rounds; spells and DoTs are single applications.
    if is_swing {
        accrue_round(&mut src.rounds, &ev.skill, ev.ts);
    }
    tally_modifiers(src, ev.modifiers, false, ev.amount);
    // A swing is a melee/slay line that named its verb — the round grouper's join key. Spells, DoTs
    // and damage shields name no verb and are not swings.
    if is_swing {
        if let Some(verb) = ev.verb {
            src.round_acc.add(&SwingRecord {
                ts: ev.ts,
                verb,
                skill: ev.skill.as_ref(),
                target: ev.target,
                amount: ev.amount,
                avoided: false,
                modifiers: ev.modifiers,
            });
        }
    }
}

/// Fold the decomposed base modifiers of one line into a source's tallies. An avoided swing passes
/// amount 0 and is the only caller that may.
fn tally_modifiers<S: AsRef<str>>(src: &mut SourceStat, mods: &[S], avoided: bool, amount: i64) {
    for name in mods {
        let name = name.as_ref();
        if !src.mods.contains_key(name) {
            src.mods.insert(
                name.to_string(),
                ModifierTally {
                    name: name.to_string(),
                    count: 0,
                    avoided: 0,
                    total: 0,
                },
            );
        }
        let t = src.mods.get_mut(name).expect("just inserted");
        t.count += 1;
        if avoided {
            t.avoided += 1;
        } else {
            t.total += amount;
        }
    }
}

/// Category rollup: the same skill breakdown, partitioned by taxonomy category so a source can be
/// opened into melee/slay/spell/dot/ds.
fn add_to_category(src: &mut SourceStat, ev: &DamageEvent<'_>) {
    if !src.by_category.contains_key(ev.category.as_ref()) {
        src.by_category.insert(
            ev.category.to_string(),
            CategoryStat {
                category: ev.category.to_string(),
                ..CategoryStat::default()
            },
        );
    }
    let c = src
        .by_category
        .get_mut(ev.category.as_ref())
        .expect("just inserted");
    c.total += ev.amount;
    c.hits += 1;
    if ev.crit {
        c.crits += 1;
    }
    c.max = c.max.max(ev.amount);
    let cs = lane(&mut c.by_skill, &ev.skill);
    cs.total += ev.amount;
    cs.hits += 1;
    if ev.crit {
        cs.crits += 1;
    }
    cs.max = cs.max.max(ev.amount);
    cs.min = accrue_min(cs.min, ev.amount);
}

/// Fold a miss (avoided swing) into a source's accuracy stats. The lane is created lazily, which is
/// what makes an encounter of nothing but whiffs a real encounter rather than an empty one.
fn add_miss_to_source(src: &mut SourceStat, m: &MissFold) {
    src.misses += 1;
    src.miss[m.mtype.slot()] += 1;
    lane(&mut src.by_skill, &m.skill).misses += 1;
    // A miss line can carry an annotation (`… but miss! (Flurry)`), and roughly half the log's
    // flurry annotations are on miss lines, so counting only landed ones would halve the stat.
    tally_modifiers(src, &m.modifiers, true, 0);
    if let Some(verb) = &m.verb {
        src.round_acc.add(&SwingRecord {
            ts: m.ts,
            verb,
            skill: m.lane_skill.as_deref().unwrap_or(&m.skill),
            target: &m.target,
            amount: 0,
            avoided: true,
            modifiers: &m.modifiers,
        });
    }
}

/// Fold a spell resist into a source's stats — the caster-side analogue of a miss. It carries no
/// damage, so only the resist counters move. The lane is created lazily, so a spell that was always
/// resisted still shows a row (0 hits / N resists).
fn add_resist_to_source(src: &mut SourceStat, spell: &str, category: &str) {
    src.resists += 1;
    lane(&mut src.by_skill, spell).resists += 1;
    if !src.by_category.contains_key(category) {
        src.by_category.insert(
            category.to_string(),
            CategoryStat {
                category: category.to_string(),
                ..CategoryStat::default()
            },
        );
    }
    let c = src.by_category.get_mut(category).expect("just inserted");
    c.resists += 1;
    lane(&mut c.by_skill, spell).resists += 1;
}

/// The six avoided-swing slots, in serialization order. A list so merge and rate loops iterate
/// instead of naming five fields and missing the sixth.
pub const MISS_KEYS: [usize; 6] = [0, 1, 2, 3, 4, 5];

fn lane<'a>(map: &'a mut JsMap<SkillStat>, name: &str) -> &'a mut SkillStat {
    if !map.contains_key(name) {
        map.insert(name.to_string(), new_skill(name));
    }
    map.get_mut(name).expect("just inserted")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(skill: &str, amount: i64, crit: bool) -> DamageEvent<'_> {
        DamageEvent {
            ts: 0,
            attacker: "You",
            target: "a bat",
            amount,
            dtype: "melee",
            dclass: None,
            skill: skill.into(),
            crit,
            category: "melee".into(),
            modifiers: &[],
            verb: None,
        }
    }

    fn you() -> SourceRef {
        SourceRef {
            id: "you".into(),
            name: "You".into(),
            kind: SourceKind::You,
        }
    }

    /// The per-lane minimum uses 0 as "nothing landed yet".
    #[test]
    fn the_lane_minimum_treats_zero_as_no_landed_hit_yet() {
        let mut a = Agg::new();
        a.add_out(&you(), &hit("Melee", 30, false), false);
        a.add_out(&you(), &hit("Melee", 12, false), false);
        let s = a.out.get("you").expect("row");
        assert_eq!(s.by_skill.get("Melee").expect("lane").min, 12);
        assert_eq!(s.by_skill.get("Melee").expect("lane").max, 30);
    }

    /// A miss creates a row, which is why the drop rule reads map size and not a total.
    #[test]
    fn an_encounter_of_pure_misses_is_not_empty() {
        let mut a = Agg::new();
        assert!(a.is_empty());
        a.add_out_miss(
            &you(),
            &MissFold {
                mtype: MissType::Dodge,
                skill: "Melee".into(),
                verb: None,
                lane_skill: None,
                modifiers: Vec::new(),
                target: "a bat".into(),
                ts: 0,
            },
        );
        assert!(!a.is_empty());
        assert_eq!(Agg::sum(&a.out), 0);
        let s = a.out.get("you").expect("row");
        assert_eq!(s.misses, 1);
        assert_eq!(s.miss[MissType::Dodge as usize], 1);
    }

    /// A resist moves no damage total and still opens the lane it was resisted on.
    #[test]
    fn a_resist_opens_a_lane_and_moves_no_total() {
        let mut a = Agg::new();
        a.add_out(&you(), &hit("Melee", 30, false), false);
        a.add_out_resist(&you(), "Cajoling Whispers", "spell");
        let s = a.out.get("you").expect("row");
        assert_eq!(s.total, 30);
        assert_eq!(s.resists, 1);
        assert_eq!(s.by_skill.get("Cajoling Whispers").expect("lane").hits, 0);
        assert_eq!(
            s.by_skill.get("Cajoling Whispers").expect("lane").resists,
            1
        );
    }

    /// The one legal kind transition is `Other` → `Member`, and it is one-way.
    #[test]
    fn a_recorded_row_upgrades_to_member_and_never_back() {
        let mut a = Agg::new();
        let other = SourceRef {
            id: "member:dranix".into(),
            name: "Dranix".into(),
            kind: SourceKind::Other,
        };
        let member = SourceRef {
            kind: SourceKind::Member,
            ..other.clone()
        };
        a.add_out(&other, &hit("Melee", 10, false), false);
        assert_eq!(
            a.out.get("member:dranix").expect("row").kind,
            SourceKind::Other
        );
        a.add_out(&member, &hit("Melee", 10, false), false);
        assert_eq!(
            a.out.get("member:dranix").expect("row").kind,
            SourceKind::Member
        );
        a.add_out(&other, &hit("Melee", 10, false), false);
        assert_eq!(
            a.out.get("member:dranix").expect("row").kind,
            SourceKind::Member
        );
        // …and the whole time it is one row, one id, one total.
        assert_eq!(a.out.len(), 1);
        assert_eq!(Agg::sum(&a.out), 30);
    }

    /// `inc_heal` is the one named-total map that counts as well as sums.
    #[test]
    fn only_the_incoming_heal_ledger_counts_its_lines() {
        let mut a = Agg::new();
        a.add_inc_heal("dranix", "Dranix", 100);
        a.add_inc_heal("dranix", "Dranix", 50);
        a.add_enemy_heal("a bat#1", "a bat", 20);
        assert_eq!(a.inc_heal.get("dranix").expect("row").count, 2);
        assert_eq!(a.inc_heal.get("dranix").expect("row").amount, 150);
        assert_eq!(a.enemy_heal.get("a bat#1").expect("row").count, 0);
        assert_eq!(Agg::sum_heal(&a.enemy_heal), 20);
    }
}
