//! Cast-anchored attribution — the one cast history both the buffs and the crowd-control modules
//! share. Pure apart from the times it is told about; no events, no clock.
//!
//! No bar without a cast line: EQ prints every landing sentence as a broadcast naming no caster
//! (`<mob> has been mesmerized.` alone is four spells in the committed DB), so the cast line is the
//! only thing separating your work from a stranger's.
//!
//! Three anchor forms. `You begin casting <S>.` and `<Name> begins casting <S>.` name the spell —
//! only the first carries a RANK. `You activate Quick Buff.` names a window rather than a spell, so
//! a landing it admits stays a family. The shared `Rc<RefCell<…>>` borrow never nests: the two
//! modules are adjacent in the wiring order and neither reaches into the other during a delivery.
//!
//! A FOURTH FORM, OFF BY DEFAULT (upstream issue #69): a weapon or item proc. EQ prints nothing
//! when an item procs — only the landing — so an Orb of Tishan's Tashania on a mob has no cast line
//! and was dropped on purpose. The evidence that stands in for the cast line comes from outside the
//! sentence: YOU swung at that mob inside `PROC_MELEE_WINDOW_MS`, and the spell is a combat effect
//! of an item the inventory dump says you hold. Both halves are required and the gate is a
//! preference (`buffTrust.define`, `procDebuffs`), because anyone's landing of the same sentence on
//! a mob you are hitting — a group-mate's cast, click or proc — reads the same; that residual is
//! what the user opts into. A SWING is a melee hit, a miss (procs fire on misses: measured over
//! the owner's log, 3.2% of 5,769 Puma Maw landings had only miss lines in window) or the damage
//! line of a held proc itself. The landing prints BEFORE its swing's own line (5,769 of 5,769 in
//! that log), so `buff_procs.rs` holds a refused landing for the swing that follows it.

use crate::jsmap::JsMap;
use crate::modules::buff_procs::SAME_SECOND_MS;
use crate::modules::buffs_shapes::{
    caster_key, caster_trusted, spell_key, OWN_CAST_WINDOW_MS, QUICK_BUFF_WINDOW_MS, SELF_CASTER,
};
use eqlog::jsstr::js_trim;
use eqlog::names::id_key;

/// How long after YOUR OWN swing at a mob a cast-less landing on it may still be a proc of the
/// weapon that swung. EQ stamps to the second and a proc lands in the swing's own second, so two
/// seconds is one second of slack; a melee round is longer than that only when you are not
/// swinging, which is when a landing is somebody else's.
pub const PROC_MELEE_WINDOW_MS: i64 = 2_000;

/// One remembered cast line. `display` is the ranked name exactly as the log spelled it; the map is
/// keyed by the rank-STRIPPED line, so a rank upgrade replaces its predecessor. `rank_changed`
/// records that two ranks of one line were cast in the same window — the landing cannot say which,
/// so it is refused as a sample.
#[derive(Debug, Clone)]
struct CastAnchor {
    display: String,
    ts: i64,
    caster: String,
    rank_changed: bool,
}

/// What admitted a landing, and by whom — the caller needs the caster to key the learner.
#[derive(Debug, Clone)]
pub struct Attribution {
    pub caster: String,
    /// The ranked display name from the cast line, when the anchor named a spell.
    pub display: Option<String>,
    /// When the line that admitted this landing was printed — the cast's own ts, or the Quick Buff
    /// activation's for an `unnamed` one. Stated here rather than re-derived from `last_cast_ts`,
    /// which is self-only and never written for an allowlisted external.
    pub ts: i64,
    /// True when the anchor cannot say which rank landed (two ranks inside one window).
    pub rank_changed: bool,
    /// True when the anchor named no spell at all (a Quick Buff burst) — so it cannot narrow.
    pub unnamed: bool,
}

/// The landing sentence carries no rank, so two ranks of one line in flight at once leaves nothing
/// that can say which landed. The flag refuses the SAMPLE; the row is still drawn.
fn is_rank_change(prev: Option<&CastAnchor>, display: &str, ts: i64, caster: &str) -> bool {
    match prev {
        None => false,
        Some(p) => p.caster == caster && p.display != display && ts - p.ts <= OWN_CAST_WINDOW_MS,
    }
}

#[derive(Default)]
pub struct CastAnchors {
    /// Newest anchor per rank-STRIPPED line key. Cleared by a fizzle/interrupt.
    by_line: JsMap<CastAnchor>,
    /// Newest ts this line was ever cast, whatever became of the cast — a different question from
    /// the anchor above, and kept separate deliberately. A fizzle retracts the ANCHOR (the cast did
    /// not land) but not the knowledge that the spell is in your book, which is what narrows a Quick
    /// Buff burst whose activation line names no spell.
    ever_cast: JsMap<i64>,
    /// ts of the last `You activate Quick Buff.` — the spell-less self anchor.
    quick_buff_ts: i64,
    /// The externals allowlist — caster KEYS, not display spellings. Empty by default: you and
    /// nobody else. Not cleared by `reset`, because it is a user preference rather than log state;
    /// the anchors it produced are cleared, because those are log state.
    externals: std::collections::HashSet<String>,
    /// The proc gate's switch. A preference like `externals`, so `reset` keeps it.
    proc_debuffs: bool,
    /// Spell keys of every combat effect on an item the player holds, from the app's read of the
    /// latest inventory dump. Empty without a dump, and an empty set is the gate closed: the
    /// catalog is never consulted on its own (`itemClickies.ts` measured why — absence from an
    /// 11,375-page scrape is not evidence).
    proc_spells: std::collections::HashSet<String>,
    /// Newest ts YOU landed a melee hit, per target key. Log state: cleared by `reset`.
    melee: JsMap<i64>,
}

impl CastAnchors {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.by_line.clear();
        self.ever_cast.clear();
        self.quick_buff_ts = 0;
        self.melee.clear();
    }

    /// `You begin casting <S>.` / `You begin singing <S>.` — the self anchor.
    pub fn note_self_cast(&mut self, spell: &str, ts: i64) {
        self.note(spell, ts, SELF_CASTER.to_string());
    }

    /// Replace the externals allowlist, whole. A name added mid-session anchors the very next cast;
    /// nothing already landed is retro-admitted, which is why `by_line` is untouched.
    pub fn set_trust(&mut self, externals: impl IntoIterator<Item = String>) {
        self.externals = externals.into_iter().map(|n| caster_key(&n)).collect();
    }

    /// Replace the proc gate, whole: the switch and the held combat effects, as DISPLAY names the
    /// app read off the item catalog, keyed here so the app's key rule never has to match this one.
    pub fn set_proc_trust(&mut self, enabled: bool, spells: impl IntoIterator<Item = String>) {
        self.proc_debuffs = enabled;
        self.proc_spells = spells.into_iter().map(|s| spell_key(&s)).collect();
    }

    /// A swing YOU made at `target` — the swing a proc rides on.
    pub fn note_melee(&mut self, target: &str, ts: i64) {
        self.melee.insert(id_key(target), ts);
    }

    /// Switched on, and this spell is a combat effect of something you hold.
    pub fn is_held_proc(&self, spell: &str) -> bool {
        self.proc_debuffs && self.proc_spells.contains(&spell_key(spell))
    }

    /// Could the gate ever vouch for a landing with these candidates, given a swing? The test
    /// `buff_procs.rs` asks before holding a refused landing for one.
    pub fn proc_possible<'a>(&self, names: impl IntoIterator<Item = &'a str>) -> bool {
        names.into_iter().any(|n| self.is_held_proc(n))
    }

    /// The proc gate for ONE spell: switched on, a combat effect of something you hold, and a swing
    /// of yours at `target` inside the window. It says nothing about uniqueness — the landing gate
    /// asks per candidate and refuses a sentence two held procs could both explain.
    ///
    /// The swing may also come up to `SAME_SECOND_MS` AFTER the landing: that is the held landing
    /// `buff_procs.rs` replays at its own ts once the swing that follows it arrives, one second
    /// boundary later at most. A landing folded live never sees a later swing here — the swing has
    /// not been read yet — so the slack only reaches the replay (and a log clock stepping back).
    pub fn proc_evidence(&self, spell: &str, target: &str, ts: i64) -> bool {
        if !self.is_held_proc(spell) {
            return false;
        }
        self.melee
            .get(&id_key(target))
            .is_some_and(|&hit| hit - ts <= SAME_SECOND_MS && ts - hit <= PROC_MELEE_WINDOW_MS)
    }

    /// Trusted against this world's allowlist: you, plus whoever the user named.
    fn trusted(&self, caster: &str) -> bool {
        caster_trusted(caster) || self.externals.contains(&caster_key(caster))
    }

    /// `<Name> begins casting <S>.` — recorded ONLY for a caster on the externals allowlist. An
    /// anchor from anybody else is the stranger's-buff case the gate exists to refuse.
    pub fn note_other_cast(&mut self, caster: &str, spell: &str, ts: i64) {
        if !self.trusted(caster) {
            return;
        }
        self.note(spell, ts, caster_key(caster));
    }

    fn note(&mut self, spell: &str, ts: i64, caster: String) {
        let key = spell_key(spell);
        let display = js_trim(spell).to_string();
        let rank_changed = is_rank_change(self.by_line.get(&key), &display, ts, &caster);
        let is_self = caster == SELF_CASTER;
        self.by_line.insert(
            key.clone(),
            CastAnchor {
                display,
                ts,
                caster,
                rank_changed,
            },
        );
        // Self only: an external's cast says nothing about what is in YOUR spellbook, and this map
        // exists to narrow a burst of yours.
        if is_self && self.ever_cast.get(&key).is_none_or(|&prev| ts > prev) {
            self.ever_cast.insert(key, ts);
        }
    }

    /// `You activate Quick Buff.` — a self anchor that names a window rather than a spell.
    pub fn note_quick_buff(&mut self, ts: i64) {
        self.quick_buff_ts = ts;
    }

    /// A fizzle/interrupt: the cast did not land, so nothing it might have resolved is ours.
    pub fn clear_cast(&mut self, spell: &str) {
        self.by_line.remove(&spell_key(spell));
    }

    fn in_quick_buff_burst(&self, ts: i64) -> bool {
        self.quick_buff_ts > 0
            && ts >= self.quick_buff_ts
            && ts - self.quick_buff_ts <= QUICK_BUFF_WINDOW_MS
    }

    /// The gate: what, if anything, admits a landing of `spell` at `ts`?
    ///
    /// A named anchor wins — it says who cast it, which rank, and therefore which learner key the
    /// sample belongs to. Failing that, a Quick Buff burst admits the landing as yours but
    /// `unnamed`, which the caller must not treat as narrowing. An unanchored landing produces
    /// nothing.
    pub fn attribute(&self, spell: &str, ts: i64) -> Option<Attribution> {
        if let Some(a) = self.by_line.get(&spell_key(spell)) {
            // Re-checked against the CURRENT allowlist, so a name the user just removed stops
            // anchoring immediately rather than at the next cast.
            if ts >= a.ts && ts - a.ts <= OWN_CAST_WINDOW_MS && self.trusted(&a.caster) {
                return Some(Attribution {
                    caster: a.caster.clone(),
                    display: Some(a.display.clone()),
                    ts: a.ts,
                    rank_changed: a.rank_changed,
                    unnamed: false,
                });
            }
        }
        if self.in_quick_buff_burst(ts) {
            return Some(Attribution {
                caster: SELF_CASTER.to_string(),
                display: None,
                ts: self.quick_buff_ts,
                rank_changed: false,
                unnamed: true,
            });
        }
        None
    }

    /// True when this exact spell has a NAMED anchor in window — the candidate-narrowing test.
    pub fn named_anchor_for(&self, spell: &str, ts: i64) -> Option<Attribution> {
        self.attribute(spell, ts).filter(|a| !a.unnamed)
    }

    /// The newest ts YOU ever cast this line — the ambiguous-apply recency tiebreak.
    pub fn last_cast_ts(&self, spell: &str) -> Option<i64> {
        self.ever_cast.get(&spell_key(spell)).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fizzle retracts the anchor and leaves the ever-cast knowledge standing — the property the
    /// burst narrowing depends on.
    #[test]
    fn a_fizzle_retracts_the_anchor_and_not_the_knowledge() {
        let mut a = CastAnchors::new();
        a.note_self_cast("Clarity II", 1000);
        assert!(a.named_anchor_for("Clarity", 2000).is_some());
        a.clear_cast("Clarity");
        assert!(a.named_anchor_for("Clarity", 2000).is_none());
        assert_eq!(a.last_cast_ts("Clarity"), Some(1000));
    }

    /// The window is one-sided: a landing before its cast is not that cast's, and one past the
    /// window is nobody's.
    #[test]
    fn the_own_cast_window_looks_forward_only() {
        let mut a = CastAnchors::new();
        a.note_self_cast("Mesmerization VII", 10_000);
        assert!(a.named_anchor_for("Mesmerization", 9_999).is_none());
        assert!(a.named_anchor_for("Mesmerization", 20_000).is_some());
        assert!(a.named_anchor_for("Mesmerization", 20_001).is_none());
    }

    /// Two ranks of one line in the window flag the ambiguity, and the row is still admitted.
    #[test]
    fn two_ranks_in_one_window_are_flagged_rather_than_guessed() {
        let mut a = CastAnchors::new();
        a.note_self_cast("Mesmerization III", 1000);
        a.note_self_cast("Mesmerization VII", 5000);
        let at = a.named_anchor_for("Mesmerization", 6000).expect("anchored");
        assert!(at.rank_changed);
        assert_eq!(at.display.as_deref(), Some("Mesmerization VII"));
    }

    /// The burst admits a landing as yours and names no spell, which keeps a family a family.
    #[test]
    fn a_quick_buff_burst_admits_without_naming() {
        let mut a = CastAnchors::new();
        a.note_quick_buff(1000);
        let at = a.attribute("Resist Magic", 3000).expect("admitted");
        assert!(at.unnamed);
        assert_eq!(at.caster, SELF_CASTER);
        assert!(a.named_anchor_for("Resist Magic", 3000).is_none());
        assert!(a.attribute("Resist Magic", 6001).is_none());
    }

    /// A stranger's cast anchors nothing under the default (empty) allowlist.
    #[test]
    fn an_untrusted_external_cast_anchors_nothing() {
        let mut a = CastAnchors::new();
        a.note_other_cast("Dranix", "Clarity", 1000);
        assert!(a.attribute("Clarity", 2000).is_none());
        assert_eq!(a.last_cast_ts("Clarity"), None);
    }

    /// The proc gate needs all three: the switch, the held item, and your own swing in window.
    #[test]
    fn a_proc_needs_the_switch_the_held_item_and_a_swing_in_window() {
        let mut a = CastAnchors::new();
        a.note_melee("a Kunark goblin", 1000);
        // Shipped default: nothing held, switch off.
        assert!(!a.proc_evidence("Tashania", "a Kunark goblin", 1500));
        // The held item alone is not the switch.
        a.set_proc_trust(false, ["Tashania".to_string()]);
        assert!(!a.proc_evidence("Tashania", "a Kunark goblin", 1500));
        a.set_proc_trust(true, ["Tashania".to_string()]);
        assert!(a.proc_evidence("Tashania", "a Kunark goblin", 1500));
        assert!(
            a.proc_evidence("Tashania", "A Kunark Goblin", 3000),
            "the target key is case-folded"
        );
        // A landing before its swing, inside one second boundary: the replay of a held landing.
        assert!(a.proc_evidence("Tashania", "a Kunark goblin", 1000 - SAME_SECOND_MS));
        // A spell the held items do not proc, a mob you did not swing at, a stale swing, and a
        // landing further before the swing than that: none of them.
        assert!(!a.proc_evidence("Tashani", "a Kunark goblin", 1500));
        assert!(!a.proc_evidence("Tashania", "a froglok", 1500));
        assert!(!a.proc_evidence(
            "Tashania",
            "a Kunark goblin",
            1000 + PROC_MELEE_WINDOW_MS + 1
        ));
        assert!(!a.proc_evidence("Tashania", "a Kunark goblin", 1000 - SAME_SECOND_MS - 1));
    }

    /// `reset` clears the swings, which are log state, and keeps the gate, which is a preference.
    #[test]
    fn reset_forgets_the_swings_and_keeps_the_gate() {
        let mut a = CastAnchors::new();
        a.set_proc_trust(true, ["Tashania".to_string()]);
        a.note_melee("a Kunark goblin", 1000);
        a.reset();
        assert!(!a.proc_evidence("Tashania", "a Kunark goblin", 1500));
        a.note_melee("a Kunark goblin", 2000);
        assert!(a.proc_evidence("Tashania", "a Kunark goblin", 2500));
    }
}
