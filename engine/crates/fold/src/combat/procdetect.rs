//! Proc detection: a spell effect line with no own cast line behind it (`combat/procDetect.ts`).
//!
//! The log prints `You begin casting <Spell>.` for every hand-cast and nothing at all when a weapon,
//! a buff-granted melee proc or the Spellblade invocation fires the same spell. So a cast-less
//! effect inside the measured 12 s window is a proc — an inference that may name a co-occurrence,
//! never a source, and is labeled as one everywhere it surfaces.
//!
//! A cast record is consumed, and a firing is identified by its instant: every landing at the same
//! second joins it, a landing at any later second needs a cast line of its own. The instant is the
//! unit because one firing legitimately prints several lines (an AoE nuke, a lifetap's damage plus
//! heal); a plain membership test would score every proc of a spammed spell as a cast. Honest limit:
//! EQ stamps to the second, so a proc in the same second as its own spell's cast landing is
//! invisible.
//!
//! Four refusals. DoT ticks and rain waves are cast-detached by construction — nothing in this game
//! procs a rain, so a cast-less wave is a wave whose cast line we did not see. HoT ticks run a
//! minute past a three-second cast. `You activate Quick Buff.` re-applies the player's memorized
//! buffs printing only the landings, so the heal side refuses those. An interrupt alone is not
//! evidence a cast failed: `You regain your concentration and continue your casting.` precedes every
//! real resumption, hence `resume()`; `forget` drops only an unclaimed record.
//!
//! The lane markers are display, never identity: origin decides the lane name, so a spell that both
//! casts and procs occupies two rows, and `lane_canon_key` strips the marker at every join.

use std::collections::{HashMap, HashSet};

use crate::jsmap::JsMap;
use eqlog::names::spell_canon_key;

/// The cast-attribution window, fixed at 12 s by a partition sweep over the real log. Do not change
/// it without re-running that sweep.
pub const PROC_CAST_WINDOW_MS: i64 = 12_000;

/// Memory bound on the recent-cast map. Entries older than the window are pruned on write; this is
/// the belt-and-braces cap for a pathological burst of distinct spell names.
pub const RECENT_CAST_CAP: usize = 512;

/// How long after `You activate Quick Buff.` a landing still belongs to that burst.
///
/// Measured: every burst-delivered buff landing in the log sits inside 5 s and the nearest true proc
/// sits at 5–10 s. It is the same window the buffs module uses, spelled again because `combat` may
/// not depend on `modules`.
pub const QUICK_BUFF_BURST_MS: i64 = 5_000;

/// `id_key` of the AA whose activation opens that burst.
pub const QUICK_BUFF_AA: &str = "quick buff";

/// What a cast-less lane's display name ends with. Never present in an EQ spell name.
pub const PROC_LANE_SUFFIX: &str = " · proc";

/// …and what a held-clicky lane's ends with. A second marker rather than a re-used one: proc and
/// click are different claims about the same log line, and only one is true.
pub const CLICK_LANE_SUFFIX: &str = " · click";

const LANE_SUFFIXES: [&str; 2] = [PROC_LANE_SUFFIX, CLICK_LANE_SUFFIX];

/// What the cast ledger can answer on its own: did one of your own cast lines explain this firing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CastVerdict {
    Cast,
    Proc,
}

/// Where a landed spell effect of yours came from.
///
/// `Click` is not something the cast ledger can see: an instant clicky prints exactly what a proc
/// prints, so it arrives as `Proc` and is promoted by `castless_kind` on evidence from outside the
/// log — the player's own inventory dump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpellOrigin {
    Cast,
    Proc,
    Click,
}

/// One `You begin casting <Spell>.`, and the firing it has already explained (if any).
#[derive(Debug, Clone, Copy)]
struct CastRecord {
    ts: i64,
    /// ts of the firing this cast explained; `None` until it explains one.
    claim_ts: Option<i64>,
}

/// The own-cast ledger. Rank-normalized because cast lines print the numeral (`Swift Like the Wind
/// I`) while effect lines are rank-less.
///
/// Only the player prints `You begin casting`, which is the gate this detector needs: a mob's or
/// another player's cast of the same spell never enters here and so can never explain away a proc.
#[derive(Debug, Default)]
pub struct RecentCasts {
    casts: HashMap<String, CastRecord>,
    /// The record `forget()` most recently dropped, held for a `resume()`.
    suspended: Option<(String, CastRecord)>,
}

impl RecentCasts {
    pub fn new() -> Self {
        RecentCasts::default()
    }

    /// Record an own-cast (`You begin casting <Spell>.` / `You begin singing <Song>.`).
    pub fn note(&mut self, spell: &str, ts: i64) {
        // Casting is serial: a new cast line means whatever was interrupted is over, so a pending
        // suspension cannot belong to the recovery that follows this one.
        self.suspended = None;
        self.casts
            .insert(spell_canon_key(spell), CastRecord { ts, claim_ts: None });
        if self.casts.len() > RECENT_CAST_CAP {
            self.prune(ts);
        }
    }

    /// A cast line that resolved to nothing (fizzle / interrupt / full resist). Dropped only while
    /// unclaimed — a record that already explained a firing is kept so the rest of that instant's
    /// lines can still join — and remembered so `resume()` can put it back.
    pub fn forget(&mut self, spell: &str) {
        let key = spell_canon_key(spell);
        let Some(rec) = self.casts.get(&key).copied() else {
            return;
        };
        if rec.claim_ts.is_some() {
            return;
        }
        self.casts.remove(&key);
        self.suspended = Some((key, rec));
    }

    /// `You regain your concentration and continue your casting.` — the record comes back with its
    /// original cast ts, because the window runs from when the cast began and the recovery does not
    /// restart it. The line names no spell; it need not, since only one cast can be in flight.
    pub fn resume(&mut self) {
        let Some((key, rec)) = self.suspended.take() else {
            return;
        };
        self.casts.entry(key).or_insert(rec);
    }

    /// The join, and it consumes: ask once per landed effect line, in log order. `Cast` when an
    /// in-window cast line explains this firing (claiming it, or matching the instant it already
    /// claimed), `Proc` otherwise.
    pub fn origin(&mut self, spell: &str, ts: i64) -> CastVerdict {
        let key = spell_canon_key(spell);
        let Some(rec) = self.casts.get_mut(&key) else {
            return CastVerdict::Proc;
        };
        // The window is closed at both ends, so a cast in the future relative to this line (an
        // out-of-order replay) is no cast at all.
        if !(0..=PROC_CAST_WINDOW_MS).contains(&(ts - rec.ts)) {
            return CastVerdict::Proc;
        }
        match rec.claim_ts {
            None => {
                rec.claim_ts = Some(ts);
                CastVerdict::Cast
            }
            Some(claimed) if claimed == ts => CastVerdict::Cast,
            Some(_) => CastVerdict::Proc,
        }
    }

    pub fn clear(&mut self) {
        self.casts.clear();
        self.suspended = None;
    }

    /// Drop cast records that can no longer explain anything.
    fn prune(&mut self, now: i64) {
        self.casts
            .retain(|_, rec| now - rec.ts <= PROC_CAST_WINDOW_MS);
    }
}

/// The meter lane a landing of `spell` belongs to, given where it came from.
pub fn lane_name_for(spell: &str, origin: SpellOrigin) -> String {
    match origin {
        SpellOrigin::Proc => format!("{spell}{PROC_LANE_SUFFIX}"),
        SpellOrigin::Click => format!("{spell}{CLICK_LANE_SUFFIX}"),
        SpellOrigin::Cast => spell.to_string(),
    }
}

/// True when a lane name carries either cast-less marker — "is this row one of the cast-less
/// halves".
pub fn is_castless_lane_name(lane: &str) -> bool {
    LANE_SUFFIXES.iter().any(|s| lane.ends_with(s))
}

/// A lane name with its cast-less marker removed — the spell the row is about.
pub fn base_lane_name(lane: &str) -> &str {
    for s in LANE_SUFFIXES {
        if let Some(stripped) = lane.strip_suffix(s) {
            return stripped;
        }
    }
    lane
}

/// `spell_canon_key` for a meter lane: the marker is display, so both halves of a split key to the
/// one spell they are firings of.
pub fn lane_canon_key(lane: &str) -> String {
    spell_canon_key(base_lane_name(lane))
}

/// The rain roster: spells that deliver several waves from one cast. Display spellings only — no
/// spell correction currently renames one of these, so a corrected spelling would have to be added
/// here if one ever does.
const RAIN_SPELLS: [&str; 23] = [
    "Avalanche",
    "Blizzard",
    "Cascade of Hail",
    "Energy Storm",
    "Firestorm",
    "Frost Storm",
    "Gale of Poison",
    "Icestrike",
    "Lava Storm",
    "Lightning Storm",
    "Manastorm",
    "Pogonip",
    "Poison Storm",
    "Rain of Blades",
    "Rain of Fire",
    "Rain of Lava",
    "Rain of Spikes",
    "Rain of Swords",
    "Sirocco",
    "Tears of Druzzil",
    "Tears of Prexus",
    "Tears of Solusek",
    "Torrent of Poison",
];

/// True when a spell delivers its damage in waves from one cast. Rank-blind, because a damage line
/// prints the rank-less name while the cast line may carry the numeral.
pub fn is_rain_spell(spell: &str) -> bool {
    let key = spell_canon_key(spell);
    RAIN_SPELLS.iter().any(|r| spell_canon_key(r) == key)
}

/// Damage lines eligible for cast-less detection: spell effects that are not rain waves.
pub fn proc_eligible_damage(dtype: &str, skill: &str) -> bool {
    dtype == "spell" && !is_rain_spell(skill)
}

/// The one place a cast-less firing becomes a click.
///
/// `held` is the set of canonical spell keys the player owns an instant clicky for, empty for a
/// character with no inventory dump — and an empty set makes this the identity function. The
/// catalog is deliberately not used as a fallback: a sweep showed it relabels real procs.
///
/// A `Cast` verdict is never promoted: a cast line is direct evidence of a hand-cast, and owning a
/// clicky for the same spell says nothing against it.
pub fn castless_kind(verdict: CastVerdict, spell: &str, held: &HashSet<String>) -> SpellOrigin {
    match verdict {
        CastVerdict::Proc if held.contains(&spell_canon_key(spell)) => SpellOrigin::Click,
        CastVerdict::Proc => SpellOrigin::Proc,
        CastVerdict::Cast => SpellOrigin::Cast,
    }
}

/// One proc whose entire printed footprint is a landing sentence about you. Fields are copied
/// verbatim from `spells.json`.
pub struct SelfLandingProcDef {
    /// DB spell name, display casing — the lane this firing is counted under.
    pub name: &'static str,
}

/// A curated registry, not a stub: a row is earned when a real log shows its sentence firing
/// cast-less inside combat and that sentence is unique in the spell DB, so the count can be
/// attributed to one name. `Blessing of the Theurgist` prints neither a damage nor a heal line —
/// its whole footprint is `The power of your god fills you.`
pub const SELF_LANDING_PROCS: [SelfLandingProcDef; 1] = [SelfLandingProcDef {
    name: "Blessing of the Theurgist",
}];

/// The registry entry a landing's candidate list names, or `None`.
///
/// Unambiguous or nothing, stricter than the proc-buff gate: that one opens a span, where a wrong
/// pick mislabels a co-occurrence; this one adds a count to a named lane, where a wrong pick invents
/// firings under somebody else's spell.
pub fn self_landing_proc_in(candidates: &[String]) -> Option<&'static SelfLandingProcDef> {
    if candidates.len() != 1 {
        return None;
    }
    let key = spell_canon_key(&candidates[0]);
    SELF_LANDING_PROCS
        .iter()
        .find(|p| spell_canon_key(p.name) == key)
}

/// Everything the heal side of the inference needs to judge one line.
pub struct HealProcInput<'a> {
    pub spell: &'a str,
    pub ts: i64,
    /// The line said `over time` — a HoT tick.
    pub over_time: bool,
    /// ts of the last `You activate Quick Buff.`, or 0 when none has been seen.
    pub quick_buff_ts: i64,
}

/// True when a heal line of yours is a cast-less proc, with both exclusions in one place so neither
/// can be applied at one call site and forgotten at another.
///
/// Consuming, and sharing one claim with the damage side: a lifetap's damage and heal lines are one
/// firing at one instant, so whichever arrives first claims the cast and the other matches it.
pub fn is_castless_heal(recent: &mut RecentCasts, h: &HealProcInput) -> bool {
    if h.over_time {
        return false;
    }
    let burst = h.ts - h.quick_buff_ts;
    if h.quick_buff_ts > 0 && (0..=QUICK_BUFF_BURST_MS).contains(&burst) {
        return false;
    }
    recent.origin(h.spell, h.ts) == CastVerdict::Proc
}

/// Which line carried one firing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcSide {
    Damage,
    Heal,
    Landing,
}

impl ProcSide {
    fn slot(self) -> usize {
        self as usize
    }
}

/// One firing can print two lines: a lifetap prints a damage line and a heal line for one proc.
///
/// So the sides are counted separately and a lane's count is `max` of them, never the sum. `max`
/// rather than the damage side alone because a heal-only proc must still count, and because a tap
/// can print a damage line with no heal line — the larger side is the number of firings observed.
#[derive(Debug, Clone, Copy, Default)]
pub struct LaneSides([i64; 3]);

impl LaneSides {
    pub fn damage(&self) -> i64 {
        self.0[ProcSide::Damage.slot()]
    }
    pub fn heal(&self) -> i64 {
        self.0[ProcSide::Heal.slot()]
    }
    pub fn landing(&self) -> i64 {
        self.0[ProcSide::Landing.slot()]
    }
    fn bump(&mut self, side: ProcSide) {
        self.0[side.slot()] += 1;
    }
}

/// Firings across the sides: `max`, never the sum.
pub fn sides_count(s: Option<&LaneSides>) -> i64 {
    s.map_or(0, |s| s.damage().max(s.heal()).max(s.landing()))
}

/// One accumulated proc lane: exact counts and the damage/healing those lines carried. Keyed by
/// `spell_canon_key`, displayed by the raw name first seen.
#[derive(Debug, Clone)]
pub struct SpellProcLane {
    pub name: String,
    pub hits: LaneSides,
    pub damage: i64,
    pub heal: i64,
    /// True when this lane's firings were attributed to a clicky the player holds. A property of the
    /// lane, not of each fold: the held set is fixed for a session, so every cast-less firing of one
    /// spell gets the same answer.
    pub click: bool,
    /// The per-state firing split, folded on ingest because the encounter event ring is capped,
    /// truncated on finalize and absent for zone sessions.
    ///
    /// States overlap, so these never sum to the lane count: each entry answers only "how many of
    /// this lane's firings happened with X on".
    pub by_state: JsMap<LaneSides>,
}

/// One lane's firings, the number every rate and every link is built from.
pub fn lane_count(l: &SpellProcLane) -> i64 {
    sides_count(Some(&l.hits))
}

/// Everything one detected proc contributes. A firing whose only line was a landing sentence has no
/// amount: `None` rather than 0, because 0 would enter the lane's total as a measurement reading "it
/// did nothing" when nothing was measured.
pub struct SpellProcFold<'a> {
    pub spell: &'a str,
    pub side: ProcSide,
    /// `Some` on a measured (damage/heal) fold, `None` on a landing.
    pub amount: Option<i64>,
    /// `<kind>:<key>` of every state open at the firing instant. Not optional — an empty set is a
    /// real observation ("nothing was on"), not a missing argument.
    pub active: &'a HashSet<String>,
    pub click: bool,
}

/// Fold one detected proc into a lane map. Every fold bumps its own side of the count; only a
/// measured one moves an amount, and no fold moves a damage total the meter already owns.
pub fn add_spell_proc(lanes: &mut JsMap<SpellProcLane>, f: &SpellProcFold) {
    let key = spell_canon_key(f.spell);
    if !lanes.contains_key(&key) {
        lanes.insert(
            key.clone(),
            SpellProcLane {
                name: f.spell.to_string(),
                hits: LaneSides::default(),
                damage: 0,
                heal: 0,
                click: false,
                by_state: JsMap::new(),
            },
        );
    }
    let lane = lanes.get_mut(&key).expect("just inserted");
    if f.click {
        lane.click = true;
    }
    lane.hits.bump(f.side);
    match f.side {
        ProcSide::Damage => lane.damage += f.amount.unwrap_or(0),
        ProcSide::Heal => lane.heal += f.amount.unwrap_or(0),
        ProcSide::Landing => {}
    }
    for state_key in f.active {
        if !lane.by_state.contains_key(state_key) {
            lane.by_state
                .insert(state_key.clone(), LaneSides::default());
        }
        lane.by_state
            .get_mut(state_key)
            .expect("just inserted")
            .bump(f.side);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One cast explains one firing: a landing at a later instant is a proc, and every landing at
    /// the same instant still joins the cast (the AoE / lifetap case).
    #[test]
    fn a_cast_record_explains_one_instant_and_no_later_one() {
        let mut r = RecentCasts::new();
        r.note("Anarchy", 1_000);
        assert_eq!(r.origin("Anarchy", 1_000), CastVerdict::Cast);
        assert_eq!(r.origin("Anarchy", 1_000), CastVerdict::Cast);
        assert_eq!(r.origin("Anarchy", 2_000), CastVerdict::Proc);
    }

    /// The window is closed at both ends: a future cast is no cast at all.
    #[test]
    fn a_cast_outside_the_window_explains_nothing() {
        let mut r = RecentCasts::new();
        r.note("Anarchy", 20_000);
        assert_eq!(
            r.origin("Anarchy", 20_000 + PROC_CAST_WINDOW_MS + 1),
            CastVerdict::Proc
        );
        assert_eq!(r.origin("Anarchy", 19_000), CastVerdict::Proc);
    }

    /// A fizzle drops its record; a recovered interrupt gets it back with its original cast ts.
    #[test]
    fn forget_drops_an_unclaimed_record_and_resume_restores_it() {
        let mut r = RecentCasts::new();
        r.note("Siphon Life", 1_000);
        r.forget("Siphon Life");
        r.resume();
        assert_eq!(
            r.origin("Siphon Life", 1_000 + PROC_CAST_WINDOW_MS),
            CastVerdict::Cast
        );
        // …and a record that already explained a firing is not dropped, so the rest of that
        // instant's lines can still join after a mid-burst resist.
        r.note("Earthquake", 5_000);
        assert_eq!(r.origin("Earthquake", 5_000), CastVerdict::Cast);
        r.forget("Earthquake");
        assert_eq!(r.origin("Earthquake", 5_000), CastVerdict::Cast);
    }

    /// Rank-normalized at the counting boundary: the cast prints the numeral, the landing does not.
    #[test]
    fn the_join_is_rank_blind() {
        let mut r = RecentCasts::new();
        r.note("Swift Like the Wind I", 1_000);
        assert_eq!(r.origin("Swift Like the Wind", 1_000), CastVerdict::Cast);
    }

    /// The rain gate refuses a wave outright, whatever the cast ledger says.
    #[test]
    fn a_rain_wave_is_never_eligible() {
        assert!(proc_eligible_damage("spell", "Anarchy"));
        assert!(!proc_eligible_damage("spell", "Rain of Fire"));
        assert!(!proc_eligible_damage("dot", "Anarchy"));
    }

    /// An empty held set is the identity function — no lane name moves without a dump.
    #[test]
    fn the_clicky_promotion_needs_the_dump() {
        let empty: HashSet<String> = HashSet::new();
        assert_eq!(
            castless_kind(CastVerdict::Proc, "Firestrike", &empty),
            SpellOrigin::Proc
        );
        let held: HashSet<String> = [spell_canon_key("Firestrike")].into_iter().collect();
        assert_eq!(
            castless_kind(CastVerdict::Proc, "Firestrike", &held),
            SpellOrigin::Click
        );
        // …and a cast is never promoted.
        assert_eq!(
            castless_kind(CastVerdict::Cast, "Firestrike", &held),
            SpellOrigin::Cast
        );
    }

    /// The lane count is `max`, never the sum — one tap firing prints two lines.
    #[test]
    fn a_tap_that_prints_both_sides_counts_each_firing_once() {
        let mut lanes: JsMap<SpellProcLane> = JsMap::new();
        let active: HashSet<String> = ["invocation:spellblade".to_string()].into_iter().collect();
        for _ in 0..12 {
            add_spell_proc(
                &mut lanes,
                &SpellProcFold {
                    spell: "Lifetap Strike",
                    side: ProcSide::Damage,
                    amount: Some(10),
                    active: &active,
                    click: false,
                },
            );
            add_spell_proc(
                &mut lanes,
                &SpellProcFold {
                    spell: "Lifetap Strike",
                    side: ProcSide::Heal,
                    amount: Some(9),
                    active: &active,
                    click: false,
                },
            );
        }
        let lane = lanes.values().next().expect("one lane");
        assert_eq!(lane_count(lane), 12);
        assert_eq!(lane.damage, 120);
        assert_eq!(lane.heal, 108);
        assert_eq!(sides_count(lane.by_state.get("invocation:spellblade")), 12);
    }

    /// A landing fold moves no amount — the count is the whole observation.
    #[test]
    fn a_landing_only_proc_carries_a_count_and_nothing_else() {
        let mut lanes: JsMap<SpellProcLane> = JsMap::new();
        let active: HashSet<String> = HashSet::new();
        add_spell_proc(
            &mut lanes,
            &SpellProcFold {
                spell: "Blessing of the Theurgist",
                side: ProcSide::Landing,
                amount: None,
                active: &active,
                click: false,
            },
        );
        let lane = lanes.values().next().expect("one lane");
        assert_eq!(lane_count(lane), 1);
        assert_eq!(lane.damage, 0);
        assert_eq!(lane.heal, 0);
    }

    /// The marker is display: both halves of a split key to one spell.
    #[test]
    fn the_lane_marker_is_stripped_at_every_join() {
        assert_eq!(
            lane_name_for("Puma Maw", SpellOrigin::Proc),
            "Puma Maw · proc"
        );
        assert_eq!(lane_name_for("Puma Maw", SpellOrigin::Cast), "Puma Maw");
        assert!(is_castless_lane_name("Puma Maw · click"));
        assert!(!is_castless_lane_name("Puma Maw"));
        assert_eq!(
            lane_canon_key("Puma Maw · proc"),
            spell_canon_key("Puma Maw")
        );
    }

    /// The two heal refusals: a HoT tick and a Quick Buff burst landing are never procs.
    #[test]
    fn the_heal_side_refuses_hot_ticks_and_quick_buff_bursts() {
        let mut r = RecentCasts::new();
        assert!(!is_castless_heal(
            &mut r,
            &HealProcInput {
                spell: "Ethereal Cleansing",
                ts: 1_000,
                over_time: true,
                quick_buff_ts: 0
            }
        ));
        assert!(!is_castless_heal(
            &mut r,
            &HealProcInput {
                spell: "Valor",
                ts: 4_000,
                over_time: false,
                quick_buff_ts: 1_000
            }
        ));
        assert!(is_castless_heal(
            &mut r,
            &HealProcInput {
                spell: "Lifetap Strike",
                ts: 9_000,
                over_time: false,
                quick_buff_ts: 1_000
            }
        ));
    }

    /// Unambiguous or nothing: a two-candidate list counts no firing.
    #[test]
    fn a_self_landing_proc_needs_a_one_element_candidate_list() {
        assert!(self_landing_proc_in(&["Blessing of the Theurgist".to_string()]).is_some());
        assert!(self_landing_proc_in(&[
            "Blessing of the Theurgist".to_string(),
            "Something Else".to_string()
        ])
        .is_none());
    }
}
