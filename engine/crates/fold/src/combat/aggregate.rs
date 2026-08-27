//! The engine's AGGREGATION primitives — `src/main/combat/aggregate.ts`.
//!
//! Everything here is pure accumulation over a SEGMENT (an encounter or a zone session): per-source
//! / per-category / per-skill damage stats, the accuracy and resist counters, the target ledger and
//! the healing annotations. No engine state, no world model, no time — the state machine that
//! decides WHICH aggregate a line belongs to is `routing.rs`'s job, not this file's.
//!
//! ── EVERY COUNTER A SEGMENT CARRIES IS HERE (JOS-477 final stage) ──────────────────────────────
//!
//! `out` / `inc` / `targets` / `enemy_heal` / `inc_heal` and the per-skill / per-category breakdowns
//! are the damage half. Beside them sit the four ledgers that are read ONLY by a view builder and are
//! therefore folded on INGEST for exactly one reason: the encounter event ring is capped, truncated at
//! finalize and absent ENTIRELY for a zone session, so anything derived from it later would be
//! silently wrong precisely where the sample is biggest.
//!
//!   `heal`    the meter-grade healing + absorption ledger (`healing.rs`).
//!   `procs`   the proc ledger — Strikes, poison-typed lanes, dispel landings, coats, swing exposure
//!             per state, and the cast-less spell-proc lanes.
//!   `windows` the wall-clock-minute ledger the Tier-B counterfactual is computed from.
//!   `SourceStat::mods` / `rounds` / `round_acc` — the modifier tallies and the two round groupers.
//!
//! NOT ONE OF THEM MOVES A DAMAGE TOTAL. Every field is a COUNT or an INDEX over damage the meter has
//! already booked — `ModifierTally::total` re-reads the amount `add_to_source` just filed, it does not
//! accumulate a second copy — which is what keeps the whole superstructure inside law 8's tripwire.
//!
//! ── THE ORDER OF `out` IS PUBLISHED, AND SO IS `inc`'s ─────────────────────────────────────────
//!
//! `sourceViews.ts` turns both into ARRAYS, and array order is a claim the comparator checks — so
//! these are `JsMap`s (insertion-ordered, JS `Map` semantics) and never `HashMap`s. `targets`'s
//! order is published twice over: `encounter_name` reads its values and sorts by amount, and a sort
//! in JS is STABLE, so two targets that absorbed exactly the same damage are named in the order they
//! were first struck.

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
/// ── IT BORROWS THE PARSER'S OWN BYTES (JOS-506) ───────────────────────────────────────────────
///
/// This used to be eight `String`s and a `Vec<String>` built fresh for EVERY damage line in the log,
/// and then CLONED once more by `ingest_damage` at lane assignment. Nothing on the routing path
/// keeps the record: it is read, folded, and dropped inside one call. What DOES retain a name — a
/// meter row, a timeline instant, a modifier tally — owns it at the point of retention, which is
/// where the allocation belongs and where it was always happening anyway.
///
/// TWO FIELDS ARE `Cow` AND THE REST ARE PLAIN SLICES, and the split says exactly which of them the
/// engine can rewrite. `skill` is rewritten twice (the special-attack lane rename, and the cast-less
/// origin marker `lane_name_for` appends) and `category` is rewritten once (the derived fallback,
/// which answers with a `'static` taxonomy constant and so still allocates nothing). Everything else
/// is the parser's text verbatim, so it is a slice of the payload and cannot be anything else.
///
/// The lifetime is the EVENT's, not the engine's: a `DamageEvent` is valid for exactly the call that
/// built it, which is the same discipline `Event<'a>` itself carries.
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

/// The identity of a meter ROW. Bundled because the three always travel together — the outgoing
/// routing paths resolve them once and hand the same triple to every `Agg` method.
#[derive(Debug, Clone)]
pub struct SourceRef {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
}

/// `shared/combat.ts SourceKind`. Spelled as an enum rather than a string because exactly one
/// transition between two of them is legal (`Other` → `Member`, see `reid`) and an enum is what
/// makes "every other kind is a constant for a given row id" checkable.
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

/// `shared/logEvents.ts MissType` — the six avoided-swing outcomes, in the order `MISS_KEYS` lists
/// them (which is the order the breakdown is serialized in).
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

    /// The log's own word for the outcome — what a timeline instant's tooltip carries as its `detail`.
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

/// ONE AVOIDED SWING as the aggregate folds it. `skill` stays `Melee` for every miss — that is the
/// shipped accuracy lane and it does not move — while `verb` / `lane_skill` / `modifiers` / `target`
/// are the additive, amount-free inputs to the round grouper and the modifier tallies.
#[derive(Debug, Clone)]
pub struct MissFold {
    pub mtype: MissType,
    /// The lane the miss counts against — `Melee` for every avoided swing, as shipped.
    pub skill: String,
    /// Un-conjugated verb off the miss line, when it named one.
    pub verb: Option<String>,
    /// The ROUND lane's display name for that verb (special-attack renamed) — never the aggregation
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
    /// Smallest LANDED amount on this lane; 0 = "no landed hit yet" (see `accrue_min`).
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

/// Fold a LANDED amount into a per-skill running minimum. 0 is the "nothing landed yet" sentinel:
/// `route()` drops `amount <= 0`, so every value reaching here is > 0 and a lane that only ever
/// missed or resisted keeps min 0 — never a fabricated "min 3 → min 0" from a whiff.
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

/// ONE BASE MODIFIER'S TALLY on a source (a STATED stat). COUNTS, plus the landed line's own amount
/// re-read into `total`.
///
/// The 14 compound forms the log actually prints decompose over 8 BASES (measured, full log: Critical
/// 31,653 · Riposte 16,841 · Slay Undead 1,980 · Finishing Blow 1,107 · Flurry 241 · Rampage 208 ·
/// Crippling Blow 9 · Strikethrough 1, plus six compounds). The parser does the decomposition; this
/// tallies the COMPONENTS.
///
/// `total` IS AN INDEX, NOT A SECOND ACCUMULATION: `add_to_source` has already booked the amount into
/// the source, the category and the lane, and this reads it back out. Avoided swings contribute 0 by
/// construction — they carry no amount at all — which is what keeps law 8's tripwire intact.
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
/// THE ONLY state; the hits-per-round histogram is derived from it at view time and deliberately not
/// cached back — a view build may not write to the aggregate. NESTED rather than keyed on
/// `<skill>|<second>` because nothing has ever read the key, so the composite string was pure
/// per-swing allocation on the hottest line in the fold. A `HashMap` is right here where every other
/// map in this file is a `JsMap`: `finalize_rounds` counts the VALUES and never publishes an order.
#[derive(Debug, Clone, Default)]
pub struct RoundsAccum {
    pub bucket: HashMap<String, HashMap<i64, i64>>,
}

/// Fold a melee/slay hit into the rounds heuristic: bump the (skill, second) bucket.
fn accrue_round(r: &mut RoundsAccum, skill: &str, ts: i64) {
    let seconds = r.bucket.entry(skill.to_lowercase()).or_default();
    *seconds.entry(ts.div_euclid(1_000)).or_insert(0) += 1;
}

/// Collapse the in-progress buckets into the hits-per-round histogram. PURE: the buckets are the
/// source of truth and this only reads them, so calling it at snapshot or finalize is safe, repeatable
/// and cheap (buckets ≈ #seconds).
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
    /// Base-modifier tallies. Counts (plus the index above) — see `ModifierTally`.
    pub mods: JsMap<ModifierTally>,
    /// ATTACK-ROUND STRUCTURE — per (verb, swings-per-round) counters, built by the pure grouper in
    /// `rounds.rs`. Additive and amount-free: it reads a swing's amount for the fan-out signature and
    /// stores none of it.
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

/// A ROGUE-POISON STRIKE lane. Keyed by the DISPLAY name we show, ambiguity included — an emote shared
/// by two Strikes keeps BOTH in one ` / `-joined label (law 3: the count is exact, the name is not).
#[derive(Debug, Clone)]
pub struct StrikeLane {
    pub name: String,
    pub count: i64,
    pub ambiguous: bool,
}

/// A POISON-TYPED damage lane. The game states the damage TYPE on every typed spell line, so this is a
/// fact the log printed rather than a name-matched guess. An INDEX over damage already counted.
#[derive(Debug, Clone)]
pub struct PoisonLane {
    pub name: String,
    pub count: i64,
    pub total: i64,
}

/// A DISPEL landing lane. Every one is ambiguous by construction — each message tier is shared by 2–3
/// spells.
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

/// The per-segment PROC accumulator. Pure counters — every one incremented on ingest from a line the
/// game actually printed, so a downsampled or truncated timeline can never move a number here.
#[derive(Debug, Default)]
pub struct ProcAccum {
    pub strikes: JsMap<StrikeLane>,
    /// Weakening-Strike landings — broken out because it is the one we time.
    pub slow_lands: i64,
    /// Absolute ts of the FIRST slow landing in this segment (0 = none).
    pub first_slow_ts: i64,
    pub poison_damage: JsMap<PoisonLane>,
    pub dispels: JsMap<DispelLane>,
    /// YOUR coats applied inside this segment, in order.
    pub coats: Vec<CoatMark>,
    pub stance_switches: i64,
    pub invocation_switches: i64,
    /// YOUR logged swing attempts in this segment: melee + slay hits, plus your misses. The MECHANICAL
    /// denominator for a chance-on-hit proc rate, and the only one of the three with no active-time
    /// ambiguity. Main-hand vs off-hand and double/triple attack are undistinguishable in this log
    /// (law 6), so this is swings-AS-LOGGED. A COUNT, never an amount.
    pub swings: i64,
    /// THE SWING EXPOSURE PER STATE: `<kind>:<key>` → how many of those swings were logged while that
    /// state was open. The other half of a link — "it never fired without it" is evidence only in
    /// proportion to how many swings there WERE without it.
    pub swings_by_state: JsMap<i64>,
    /// THE ACTIVE-TIME EXPOSURE PER STATE: ms of the meter's own active time that elapsed while a
    /// state was open. The PPM denominator for any lane whose SOURCE window is known — a poison Strike
    /// can only fire while its coat is on the blades. Folded from the SAME per-hit delta the window
    /// ledger receives, so it can no more drift from `activeSec` than that ledger can.
    pub active_ms_by_state: JsMap<i64>,
    /// CAST-LESS SPELL lanes, keyed by `spell_canon_key`. The damage they carry is ALREADY inside this
    /// segment's outgoing total — an INDEX, never a second accumulation.
    pub spell_procs: JsMap<SpellProcLane>,
}

impl ProcAccum {
    /// Count one of YOUR logged swing attempts, against the states open when you made it. Both numbers
    /// move together on purpose: a total and a per-state split that could be updated independently
    /// would drift the moment one call site forgot the other.
    pub fn add_swing(&mut self, active: &HashSet<String>) {
        self.swings += 1;
        for key in active {
            bump_state(&mut self.swings_by_state, key, 1);
        }
    }

    /// Charge one hit's active-time delta to every state that was open for it. Called on EVERY folded
    /// damage line, incoming included, because that is precisely what the meter's own `active_ms`
    /// counts — the two denominators have to mean the same thing to be comparable.
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

/// The per-segment aggregate. Keyed by INSTANCE id (or `you` / `pet:<instanceId>` /
/// `member:<key>` / `allypet:<charmer>:<pet>`); `name` holds the display spelling, refreshed on every
/// arrival because the log's latest spelling wins (world-model law 2).
#[derive(Debug, Default)]
pub struct Agg {
    pub out: JsMap<SourceStat>,
    pub inc: JsMap<SourceStat>,
    pub targets: JsMap<NamedTotal>,
    /// Healing received by hostile instances engaged here (instanceId → total).
    pub enemy_heal: JsMap<NamedTotal>,
    /// Healing received by You / your pets: healerKey → { name, total, count }.
    pub inc_heal: JsMap<NamedTotal>,
    /// The meter-grade HEALING + ABSORPTION ledger. On the SAME aggregate as the damage bars, so the
    /// healing overlays inherit fight / zone-session selection, the finalized freeze and the encounter
    /// history without any parallel machinery. ADDITIVE: `enemy_heal` / `inc_heal` above are untouched.
    pub heal: HealAccum,
    /// PROC LEDGER — Strikes, poison-typed lanes, non-damage spell landings on engaged mobs, and the
    /// stance/coat bookkeeping. On the `Agg` for the same reason the healing ledger is.
    pub procs: ProcAccum,
    /// THE MINUTE-WINDOW LEDGER — the matched-window sample the Tier-B counterfactual is computed
    /// from. On the `Agg` for the third time and for the third identical reason: a finalized zone
    /// session inherits it FROZEN, so "how much DPS did X add this session" survives the zone change
    /// that produced it.
    pub windows: WindowAccum,
}

impl Agg {
    pub fn new() -> Self {
        Agg::default()
    }

    /// Sum of a source map's totals — `sumMap`. The DPS numerator for a segment.
    pub fn sum(map: &JsMap<SourceStat>) -> i64 {
        map.values().map(|s| s.total).sum()
    }

    /// Sum of a heal map's amounts — `sumHeal`.
    pub fn sum_heal(map: &JsMap<NamedTotal>) -> i64 {
        map.values().map(|t| t.amount).sum()
    }

    /// True when this aggregate recorded nothing at all. THE DROP RULE both `finalize_current` and
    /// `finalize_zone_session` are gated on: a CC application or a lone miss can open an encounter
    /// that never accrues attributed damage — a mez lands and somebody else kills the mob — and a
    /// 0-damage shell must not pollute the history or the zone-session picker.
    ///
    /// IT IS `out.size === 0 && inc.size === 0`, NOT A TOTAL. A miss creates a source row with no
    /// damage on it, and such an encounter is deliberately KEPT: the hit-rate is real even when the
    /// damage is zero.
    pub fn is_empty(&self) -> bool {
        self.out.is_empty() && self.inc.is_empty()
    }

    /// RE-STATE a row's identity from the ref that just arrived. The display name has always been
    /// refreshed this way (world-model law 2).
    ///
    /// THE KIND MOVES TOO, and ONE transition is allowed: `Other` → `Member`. A combatant recorded
    /// before your group learned their name is `Other`; the moment the roster admits them the SAME
    /// row starts arriving as `Member` and the bar re-labels itself without splitting.
    ///
    /// IT IS ONE-WAY ON PURPOSE: the roster's admission set is cleared by a self-leave, so a
    /// free-running assignment would let the last line of a session decide what a fight two minutes
    /// earlier was. What this fight's damage WAS does not change when the group ends.
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

    /// DROP a recorded row. The one caller is `retract_other`: a name a stronger model has just
    /// claimed as a pet must not keep a second bar beside the pet's own. Safe by construction — an
    /// `Other` row is additive (it enters no you/pet total and no target/engaged set), so removing it
    /// can move nothing that existed before it did.
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

/// The COUNT-ONLY counters a landed swing feeds: the legacy melee-rounds heuristic, the base modifier
/// tallies, and the attack-round grouper. Not one of them touches `src.total`, a category total or a
/// lane total — which is exactly why adding them moved no damage number anywhere in the engine.
fn add_swing_counters(src: &mut SourceStat, ev: &DamageEvent<'_>) {
    let is_swing = ev.category == "melee" || ev.category == "slay";
    // Only melee/slay hits cluster into "rounds" (spells and DoTs are single applications).
    if is_swing {
        accrue_round(&mut src.rounds, &ev.skill, ev.ts);
    }
    tally_modifiers(src, ev.modifiers, false, ev.amount);
    // A SWING is a melee/slay line that named its VERB — the join key the round grouper is keyed on.
    // Spells, DoTs and damage shields name no verb and are not swings.
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

/// Fold the decomposed base modifiers of one line into a source's tallies. COUNTS, plus the landed
/// line's own amount re-read into `total`. An avoided swing passes 0 and is the only caller that may.
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

/// Category rollup (drill-down level 2/3): the same skill breakdown, partitioned by taxonomy
/// category so a source can be opened into melee/slay/spell/dot/ds.
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
    // ── ADDITIVE, AMOUNT-FREE. An avoided swing carries no amount, so none of this can move a total;
    // it is the same first-class-but-damage-free treatment misses already get (law 8). A miss line
    // names its verb and CAN carry an annotation (`… but miss! (Flurry)`), and 123 of the log's 253
    // flurry annotations are on miss lines — counting only landed ones would halve the stat.
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

/// Fold a spell RESIST into a source's stats — the caster-side analogue of a miss. It attaches to
/// the resisted spell's lane in the given taxonomy category. It carries no damage, so only the
/// resist COUNTERS move and the source's damage total is byte-for-byte unchanged (the tripwire). The
/// lane is created lazily, so a spell that was ALWAYS resisted still shows a row (0 hits / N resists
/// → 0% land).
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

/// `MISS_KEYS` — the six avoided-swing slots, in the order the breakdown is SERIALIZED in. Spelled as
/// a list rather than named six times, so a merge or a rate loop iterates it instead of naming five
/// fields and silently missing the sixth.
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

    /// The per-lane MINIMUM uses 0 as "nothing landed yet", so a lane that only whiffed keeps 0 and
    /// never reports a fabricated minimum.
    #[test]
    fn the_lane_minimum_treats_zero_as_no_landed_hit_yet() {
        let mut a = Agg::new();
        a.add_out(&you(), &hit("Melee", 30, false), false);
        a.add_out(&you(), &hit("Melee", 12, false), false);
        let s = a.out.get("you").expect("row");
        assert_eq!(s.by_skill.get("Melee").expect("lane").min, 12);
        assert_eq!(s.by_skill.get("Melee").expect("lane").max, 30);
    }

    /// A MISS CREATES A ROW, which is exactly why the drop rule reads map SIZE and not a total: an
    /// encounter of nothing but whiffs has a real hit-rate and must not be discarded.
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

    /// A RESIST MOVES NO DAMAGE TOTAL — the tripwire — and still opens the lane it was resisted on.
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

    /// The ONE legal kind transition is `Other` → `Member`, and it is one-way.
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
        // …and the whole time it is ONE row, one id, one total.
        assert_eq!(a.out.len(), 1);
        assert_eq!(Agg::sum(&a.out), 30);
    }

    /// `inc_heal` is the one named-total map that COUNTS as well as sums.
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
