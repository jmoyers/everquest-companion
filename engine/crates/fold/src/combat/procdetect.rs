//! PROC DETECTION — "a spell effect line with no own cast line behind it" (`combat/procDetect.ts`).
//!
//! THE ONE INFERENCE IN THIS FEATURE, and it is labeled as one everywhere it surfaces. The log prints
//! `You begin casting <Spell>.` for every hand-cast the player makes, and prints NOTHING at all when a
//! weapon, a buff-granted melee proc or the Spellblade invocation fires the same spell. So a spell
//! effect with no own cast behind it, inside a stated window, is a proc — and the inference may name a
//! CO-OCCURRENCE, never a source.
//!
//! ── THE WINDOW IS MEASURED, NOT GUESSED ──────────────────────────────────────────────────────
//!
//! At 12 seconds the real log's partition is clean (rank-normalized sweep): every pure proc scores
//! cast = 0 (`Smiting Strike` 9,633 · `Lifetap Strike` 1,814 · `Condemnation of Nife` 1,096 ·
//! `Vampiric Embrace` 586 · `Ignite` 148 · `Dismiss Summoned` 23 · `Asp Venom Strike` 15) and every
//! hand-cast nuke scores proc = 0 (`Chaotic Feedback` 893 · `Sanity Warp` 502 · `Anarchy` 112 ·
//! `Strike` 90). The residual mixed lanes — `Discordant Mind` and `Siphon Life` — are GENUINELY mixed:
//! they are the player's gem-#1 spells and every cast-less firing of either happened under the
//! `spellblade` invocation.
//!
//! ── ONE CAST LINE EXPLAINS ONE FIRING, AND THE RECORD IS CONSUMED ────────────────────────────
//!
//! The first rule was "is there a cast of this spell in the last 12 seconds", which is a MEMBERSHIP
//! test — and a membership test cannot separate a spell you are SPAMMING from a proc that shares its
//! name. A cleric casting `Banish Undead` on a four-second cycle keeps the window permanently open, so
//! every weapon proc of the same effect scored as a cast and the proc rate read ZERO.
//!
//! So a cast record is CONSUMED, and a FIRING is identified by its INSTANT: every landing stamped at
//! the same second belongs to it, and a landing at any later second needs a cast line of its own or it
//! is a proc. The instant is the unit rather than the line because one firing legitimately prints
//! several lines — an AoE nuke prints one damage line per target inside one second, and a lifetap
//! prints a damage line AND a heal line.
//!
//! HONEST LIMIT, stated because the log's clock cannot do better: EQ stamps to the SECOND, so a proc
//! firing in the same second as its own spell's cast landing is absorbed into the cast and is
//! invisible. Refusing the second line instead would fabricate procs out of every AoE.
//!
//! ── THE FOUR REFUSALS, EACH A RULE WITH A SWEEP BEHIND IT ────────────────────────────────────
//!
//!   1. THE DoT GATE. A DoT tick is cast-DETACHED by construction, so it would misclassify as a proc
//!      the moment it arrived more than twelve seconds after its cast. Detection is gated to
//!      `dtype == "spell"`; `melee` and `ds` are not spell effects at all.
//!   2. THE RAIN GATE. A rain spell delivers a FIXED NUMBER OF WAVES from ONE cast, so its later waves
//!      are cast-less by construction too. The gate is the SPELL, not the timing: no item, buff or AA
//!      in this game fires a rain, so a cast-less rain wave is never a proc — it is a wave whose cast
//!      line we did not see. Before it existed, 126 of the 452 first-person rain lines in the owner's
//!      log wore a proc rate.
//!   3. THE HoT GATE, which is the DoT gate on the other side of the meter. Every one of `Ethereal
//!      Cleansing`'s 91 cast-less ticks is a `healed <target> over time for N` line, and its ticks run
//!      60+ seconds past a three-second cast.
//!   4. THE QUICK BUFF GATE. `You activate Quick Buff.` re-applies the player's memorized buffs and
//!      prints NO cast line for any of them — only the landings. Six buff spells account for 254
//!      phantom "procs" that way, and every one lands within five seconds of that activation. It
//!      suppresses the HEAL side ONLY: Quick Buff casts no nuke, so a damage-side gate would catch
//!      nothing and could only lose real procs.
//!
//! A CAST THAT NEVER RESOLVED EXPLAINS NOTHING. Measured over the whole 1.4M-line log: of 478 FIZZLES
//! not one is followed within 12 s by a landing of the same spell; of 1,030 INTERRUPTS, 1,019 are
//! followed by no landing at all and the 9 that ARE are ALL preceded by `You regain your concentration
//! and continue your casting.` So the interrupt alone is NOT evidence the cast failed — hence
//! `resume()`, which restores the record with its ORIGINAL cast ts. `forget` drops only an UNCLAIMED
//! record: once a cast has explained a firing it can no longer claim a later instant anyway, and
//! keeping it lets the REST of that instant's lines still join after a mid-burst resist line.
//!
//! ── THE TWO LANE MARKERS ARE DISPLAY, NEVER IDENTITY ─────────────────────────────────────────
//!
//! A spell that both CASTS and PROCS used to be one meter row, and the owner could not estimate the
//! proc rate without deliberately not casting. The origin now decides the LANE NAME, so the two land
//! in different rows of the same category and the split needs no new plumbing. `lane_canon_key` strips
//! the marker, so every join that matches a meter row to a spell still sees ONE spell — law 2,
//! canonicalize at the boundary, display raw.

use std::collections::{HashMap, HashSet};

use crate::jsmap::JsMap;
use eqlog::names::spell_canon_key;

/// The cast-attribution window. See the header for the measurement that fixes it at 12 s; do not
/// change it without re-running that partition against the real log.
pub const PROC_CAST_WINDOW_MS: i64 = 12_000;

/// Memory bound on the recent-cast map. Entries older than the window are pruned on write; this is
/// the belt-and-braces cap for a pathological burst of distinct spell names.
pub const RECENT_CAST_CAP: usize = 512;

/// How long after `You activate Quick Buff.` a landing still belongs to that burst.
///
/// FIVE SECONDS, and the number is not this file's invention: it is the SAME window the buffs module
/// uses to mark a burst's message-driven applies confident. Spelled again here rather than imported
/// because `combat` may not depend on `modules`, and MEASURED like the cast window — all 254 of the
/// log's burst-delivered buff landings sit inside it, and the nearest true proc sits at 5–10 s.
pub const QUICK_BUFF_BURST_MS: i64 = 5_000;

/// `id_key` of the AA whose activation opens that burst.
pub const QUICK_BUFF_AA: &str = "quick buff";

/// What a cast-less lane's display name ends with. Never present in an EQ spell name.
pub const PROC_LANE_SUFFIX: &str = " · proc";

/// …and what a HELD-CLICKY lane's ends with. A SECOND marker rather than a re-used one, because the
/// reporter's whole complaint was that the app was calling their bow click a proc: `Firestrike · proc`
/// and `Firestrike · click` are different claims about the same log line, and only one is true.
pub const CLICK_LANE_SUFFIX: &str = " · click";

const LANE_SUFFIXES: [&str; 2] = [PROC_LANE_SUFFIX, CLICK_LANE_SUFFIX];

/// What the CAST LEDGER can answer on its own: did one of your own cast lines explain this firing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CastVerdict {
    Cast,
    Proc,
}

/// Where a landed spell effect of YOURS came from.
///
/// `Click` is NOT a third thing the cast ledger can see: an instant clicky prints exactly what a proc
/// prints (one effect line, no cast line), so it arrives here as `Proc` and is promoted by
/// `castless_kind` on evidence from OUTSIDE the log — the player's own inventory dump.
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

/// THE OWN-CAST LEDGER. Rank-normalized (`spell_canon_key`) because casts print `Swift Like the Wind
/// I` while effect lines are rank-less — law 2, at the COUNTING boundary.
///
/// Only the PLAYER prints `You begin casting`, which is exactly the gate this detector needs: a mob's
/// or another player's cast of the same spell never enters here and so can never explain away one of
/// our procs.
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
        // Casting is SERIAL — a new cast line means whatever was interrupted is over, so a pending
        // suspension can never belong to the recovery that follows this one.
        self.suspended = None;
        self.casts
            .insert(spell_canon_key(spell), CastRecord { ts, claim_ts: None });
        if self.casts.len() > RECENT_CAST_CAP {
            self.prune(ts);
        }
    }

    /// A cast line that resolved to NOTHING (fizzle / interrupt / full resist). Dropped only while
    /// UNCLAIMED, and remembered so `resume()` can put it back.
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

    /// `You regain your concentration and continue your casting.` — the interrupted cast is back on,
    /// so the record it lost comes back with its ORIGINAL cast ts (the window is measured from when
    /// the cast began, and the recovery does not restart it). The line names no spell; it does not
    /// have to, because only one cast can be in flight.
    pub fn resume(&mut self) {
        let Some((key, rec)) = self.suspended.take() else {
            return;
        };
        self.casts.entry(key).or_insert(rec);
    }

    /// THE JOIN, and it CONSUMES: ask this once per landed effect line, in log order. `Cast` when an
    /// in-window cast line explains this firing (claiming it if it had not claimed one yet, or
    /// matching the instant it already claimed), `Proc` otherwise.
    ///
    /// A cast in the FUTURE relative to this line is treated as no cast at all: the window is
    /// `0 <= ts - cast_ts <= PROC_CAST_WINDOW_MS`.
    pub fn origin(&mut self, spell: &str, ts: i64) -> CastVerdict {
        let key = spell_canon_key(spell);
        let Some(rec) = self.casts.get_mut(&key) else {
            return CastVerdict::Proc;
        };
        // A cast in the FUTURE relative to this line (possible only on an out-of-order replay) is
        // treated as no cast at all — the window is closed at BOTH ends.
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

/// True when a lane name carries EITHER cast-less marker — the join every consumer of the split
/// actually wants ("is this row one of the cast-less halves").
pub fn is_castless_lane_name(lane: &str) -> bool {
    LANE_SUFFIXES.iter().any(|s| lane.ends_with(s))
}

/// A lane name with its cast-less marker removed — the SPELL the row is about.
pub fn base_lane_name(lane: &str) -> &str {
    for s in LANE_SUFFIXES {
        if let Some(stripped) = lane.strip_suffix(s) {
            return stripped;
        }
    }
    lane
}

/// `spell_canon_key` for a METER LANE: the marker is display, so both halves of a split key to the one
/// spell they are both firings of.
pub fn lane_canon_key(lane: &str) -> String {
    spell_canon_key(base_lane_name(lane))
}

/// THE RAIN ROSTER — 23 spells, each of which delivers several waves from one cast (see gate 2 in the
/// header; `src/main/data/rainSpells.ts` carries the per-page quote that fixes each row).
///
/// The TS roster additionally keys every CORRECTED spelling, because the corrections overlay can
/// rename a row and the parser only ever sees the LOG's spelling. Nothing in today's rain family is
/// corrected — checked against `spellCorrectionsList.ts`, which mentions none of these 23 names — so
/// the display names alone are the whole key set here, and this note is the pointer to re-check if a
/// correction ever lands on one.
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

/// True when a spell delivers its damage in WAVES from one cast. Rank-blind, because a damage line
/// prints the rank-less name while the cast line may carry the numeral.
pub fn is_rain_spell(spell: &str) -> bool {
    let key = spell_canon_key(spell);
    RAIN_SPELLS.iter().any(|r| spell_canon_key(r) == key)
}

/// Damage lines eligible for cast-less detection. A function rather than a set so neither exclusion
/// can be extended without reading what it costs (gates 1 and 2 in the header).
pub fn proc_eligible_damage(dtype: &str, skill: &str) -> bool {
    dtype == "spell" && !is_rain_spell(skill)
}

/// THE ONE PLACE A CAST-LESS FIRING BECOMES A CLICK.
///
/// `held` is the set of canonical spell keys the player owns an INSTANT clicky for. It is EMPTY for a
/// character who has never written an inventory dump, and an empty set makes this the IDENTITY
/// FUNCTION — the behaviour that shipped before this gate, kept deliberately rather than replaced by a
/// catalog guess (the catalog was swept and it relabels 148 real procs).
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

/// One proc whose entire printed footprint is a landing sentence about YOU. Every field is copied
/// VERBATIM from `spells.json`; nothing here is invented.
pub struct SelfLandingProcDef {
    /// DB spell name, display casing — the lane this firing is counted under.
    pub name: &'static str,
}

/// v1 is ONE entry, which is the state of the evidence and not a stub.
///
/// `Blessing of the Theurgist` prints NEITHER a damage line nor a heal line — its entire footprint is
/// `The power of your god fills you.`, which the shipped DB matches EXACTLY once across all 1,926
/// rows. Six firings inside 8m23s of one continuous grind, each between the reporter's own swings, no
/// cast line anywhere in the slice, and the DB row says the spell is cast by NPCs only. The registry
/// is CURATED at that bar: a row is earned when a real log shows its sentence firing cast-less inside
/// combat AND the sentence is unique in the DB so the count can be attributed to one name.
pub const SELF_LANDING_PROCS: [SelfLandingProcDef; 1] = [SelfLandingProcDef {
    name: "Blessing of the Theurgist",
}];

/// The registry entry a landing's candidate list names, or `None`.
///
/// UNAMBIGUOUS OR NOTHING, and deliberately stricter than the proc-buff gate, which takes the first
/// catalog name it finds: that one opens a SPAN, where a wrong pick mislabels a co-occurrence; this
/// one adds a COUNT to a NAMED LANE, where a wrong pick invents firings under somebody else's spell.
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

/// True when a heal line of YOURS is a cast-less proc — the heal half of the inference, with both of
/// its exclusions in one place so neither can be applied at one call site and forgotten at another.
///
/// CONSUMING, like the damage side, and deliberately sharing one claim with it: a lifetap's damage
/// line and heal line are one firing at one instant, so whichever arrives first claims the cast and
/// the other matches the instant it claimed.
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

// ── THE LANES ─────────────────────────────────────────────────────────────────────────────────

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

/// ONE FIRING CAN PRINT TWO LINES, and counting both is how a tap lane starts reporting double.
///
/// `Lifetap Strike` fires once and the game prints a damage line AND a heal line — two events, one
/// proc. A single counter bumped from both ingest paths read 24 for one window's twelve firings.
///
/// So the sides are counted SEPARATELY and the lane's count is `max` of them, never the sum: a
/// damage-only proc counts its damage lines, a heal-only proc still counts once, and a tap that prints
/// both counts each firing exactly once. `max` and not `damage` alone precisely because of the second
/// case and because a tick can print no heal line at all (14 ticks, 13 heals in one measured window) —
/// the larger side is the number of firings we actually observed.
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

/// One accumulated proc lane of `origin: spell`: exact counts and the damage/healing those lines
/// carried. Keyed by `spell_canon_key`, displayed by the raw name we first saw.
#[derive(Debug, Clone)]
pub struct SpellProcLane {
    pub name: String,
    pub hits: LaneSides,
    pub damage: i64,
    pub heal: i64,
    /// TRUE when this lane's firings were attributed to a clicky the player HOLDS. A property of the
    /// LANE and not of each fold, because the held set is fixed for a session: every cast-less firing
    /// of one spell gets the same answer, and a lane that ever saw a click fold is a click lane.
    pub click: bool,
    /// THE PER-STATE FIRING SPLIT, folded on INGEST because it can never be folded later: the
    /// encounter event ring is capped, truncated on finalize, and absent ENTIRELY for zone sessions,
    /// so a link derived from it would be silently wrong exactly where the sample is biggest.
    ///
    /// States OVERLAP, so these never sum to the lane count and are not meant to: each entry answers
    /// one question, "how many of this lane's firings happened with X on".
    pub by_state: JsMap<LaneSides>,
}

/// One lane's firings, the number every rate and every link is built from.
pub fn lane_count(l: &SpellProcLane) -> i64 {
    sides_count(Some(&l.hits))
}

/// Everything one detected proc contributes. A firing whose only line was a LANDING sentence has NO
/// amount at all, and that absence is the `healUnstated` discipline applied to this ledger: an
/// `amount: 0` would enter the lane's damage total as a measurement reading "it did nothing", when the
/// truth is that nothing was measured.
pub struct SpellProcFold<'a> {
    pub spell: &'a str,
    pub side: ProcSide,
    /// `Some` on a measured (damage/heal) fold, `None` on a landing.
    pub amount: Option<i64>,
    /// `<kind>:<key>` of every state open at the firing instant. Not optional — a firing with no state
    /// open folds an EMPTY set, which is a real observation ("nothing was on"), not a missing argument.
    pub active: &'a HashSet<String>,
    pub click: bool,
}

/// Fold one detected proc into a lane map. Every fold bumps its own side of the count; only a MEASURED
/// one moves an amount, and no fold on any side ever moves a damage total the meter already owns.
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

    /// ONE CAST EXPLAINS ONE FIRING: the second landing at a LATER instant is a proc, and every
    /// landing at the SAME instant still joins the cast (the AoE / lifetap case).
    #[test]
    fn a_cast_record_explains_one_instant_and_no_later_one() {
        let mut r = RecentCasts::new();
        r.note("Anarchy", 1_000);
        assert_eq!(r.origin("Anarchy", 1_000), CastVerdict::Cast);
        assert_eq!(r.origin("Anarchy", 1_000), CastVerdict::Cast);
        assert_eq!(r.origin("Anarchy", 2_000), CastVerdict::Proc);
    }

    /// THE WINDOW IS 12 SECONDS AND A FUTURE CAST IS NO CAST AT ALL.
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

    /// A FIZZLE DROPS ITS RECORD; A RECOVERED INTERRUPT GETS IT BACK, with its ORIGINAL cast ts.
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
        // …and a record that has ALREADY explained a firing is not dropped, so the rest of that
        // instant's lines can still join after a mid-burst resist.
        r.note("Earthquake", 5_000);
        assert_eq!(r.origin("Earthquake", 5_000), CastVerdict::Cast);
        r.forget("Earthquake");
        assert_eq!(r.origin("Earthquake", 5_000), CastVerdict::Cast);
    }

    /// RANK-NORMALIZED at the counting boundary: the cast prints the numeral, the landing does not.
    #[test]
    fn the_join_is_rank_blind() {
        let mut r = RecentCasts::new();
        r.note("Swift Like the Wind I", 1_000);
        assert_eq!(r.origin("Swift Like the Wind", 1_000), CastVerdict::Cast);
    }

    /// THE RAIN GATE refuses a wave outright, whatever the cast ledger says.
    #[test]
    fn a_rain_wave_is_never_eligible() {
        assert!(proc_eligible_damage("spell", "Anarchy"));
        assert!(!proc_eligible_damage("spell", "Rain of Fire"));
        assert!(!proc_eligible_damage("dot", "Anarchy"));
    }

    /// AN EMPTY HELD SET IS THE IDENTITY FUNCTION — not one lane name moves without a dump.
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
        // …and a CAST is never promoted.
        assert_eq!(
            castless_kind(CastVerdict::Cast, "Firestrike", &held),
            SpellOrigin::Cast
        );
    }

    /// THE LANE COUNT IS `max`, NEVER THE SUM — one tap firing prints two lines.
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

    /// A LANDING FOLD MOVES NO AMOUNT — the count is the whole observation.
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

    /// The marker is DISPLAY: both halves of a split key to one spell.
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

    /// THE TWO HEAL REFUSALS: a HoT tick and a Quick Buff burst landing are never procs.
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

    /// UNAMBIGUOUS OR NOTHING: a two-candidate list counts no firing.
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
