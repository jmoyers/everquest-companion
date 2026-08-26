//! `src/main/modules/buffAnchors.ts` — CAST-ANCHORED ATTRIBUTION, as ONE object both halves of the
//! model share (JOS-140 rulings 2/3). Pure apart from the times it is told about; no events, no
//! clock.
//!
//! THE RULE IT ENFORCES, in the owner's words: NO BAR WITHOUT A CAST LINE. EQ prints every landing
//! sentence as a BROADCAST — `<mob> has been mesmerized.` and `<ally> is resistant to magic.` name
//! no caster, and the mez sentence alone is four spells in the committed DB — so in a crowded zone
//! the only thing separating your work from a stranger's is that you have a cast line and they do
//! not. Three field reports are what that costs when it is missing: phantom Focus Death bars on
//! pets from a sentence six spells share and none of them cast by the player; another enchanter's
//! mez filling the debuff window; a friendly buff filed as a debuff.
//!
//! WHY IT IS ONE OBJECT AND NOT TWO. Before JOS-140 the cast history existed TWICE — once in the
//! buffs module and once in the crowd-control one — folded from the same events, cleared on
//! different rules, and used to answer the same question. Two copies of an attribution rule is how
//! the two systems that ticket unified drifted apart. In this crate the sharing is an
//! `Rc<RefCell<…>>` held by both modules rather than a JavaScript reference, which is the same
//! object under a different spelling: the two are adjacent in the wiring order, neither reaches
//! into the other during a delivery, and the borrow therefore never nests.
//!
//! THE THREE ANCHOR FORMS. `You begin casting <S>.` and `<Name> begins casting <S>.` NAME the spell
//! (and the first is the only line in the whole family that carries a RANK); `You activate Quick
//! Buff.` names no spell at all — a WINDOW rather than a name. A landing the burst admits whose
//! sentence several spells share therefore stays a FAMILY: the anchor is evidence the player cast,
//! in whatever form the log states it, and it is still never a guess at WHICH spell.

use crate::jsmap::JsMap;
use crate::modules::buffs_shapes::{
    caster_key, caster_trusted, spell_key, OWN_CAST_WINDOW_MS, QUICK_BUFF_WINDOW_MS, SELF_CASTER,
};
use eqlog::jsstr::js_trim;

/// `CastAnchor` — one remembered cast line.
///
/// `display` is the RANKED name exactly as the log spelled it (`Mesmerization VII`). The map is
/// keyed by the rank-STRIPPED line, so a rank upgrade REPLACES its predecessor rather than
/// accumulating beside it, and `rank_changed` records that two different ranks of one line were cast
/// inside the same window — a landing under that condition cannot say which rank it is and is
/// refused as a sample (ruling 5).
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
    /// The RANKED display name from the cast line, when the anchor named a spell.
    pub display: Option<String>,
    /// WHEN THE LINE THAT ADMITTED THIS LANDING WAS PRINTED — the cast's own ts, or the Quick Buff
    /// activation's for an `unnamed` one (JOS-410). It is here rather than re-derived from
    /// `last_cast_ts` because that map is the WEAKER, SELF-ONLY signal and is never written for an
    /// allowlisted external, so a reader ranking anchors by it would silently rank every external
    /// cast last.
    pub ts: i64,
    /// True when the anchor cannot say which rank landed (two ranks inside one window).
    pub rank_changed: bool,
    /// True when the anchor named no spell at all (a Quick Buff burst) — so it cannot narrow.
    pub unnamed: bool,
}

/// TWO RANKS IN ONE WINDOW is a real ambiguity, not paranoia: the landing sentence carries no rank,
/// so a `Mesmerization III` and a `Mesmerization VII` both in flight leaves nothing that can say
/// which one landed. The flag rides forward so the SAMPLE is refused; the ROW is still drawn,
/// because which rank it is does not change that the mob is held.
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
    /// Newest ts this line was ever cast, WHATEVER became of the cast — the weaker signal, and a
    /// different question from the anchor above.
    ///
    /// An anchor says "a cast of yours is close enough to this landing to own it", so a fizzle
    /// RETRACTS it: the cast did not land, and nothing it might have resolved is ours. Knowing the
    /// spell is in your book is NOT retracted by fizzling it, and that is a real narrowing for a
    /// Quick Buff burst, whose activation line names no spell: `A cool breeze slips through your
    /// mind.` is Clarity plus siblings, and the one you have ever cast is the one you own. Merging
    /// the two maps made a single interrupted cast three seconds before a burst erase the knowledge
    /// the burst then needed — measured on `tests/fixtures/w17-priming.log`.
    ever_cast: JsMap<i64>,
    /// ts of the last `You activate Quick Buff.` — the spell-less self anchor.
    quick_buff_ts: i64,
    /// THE EXTERNALS ALLOWLIST (JOS-140, pushed since JOS-482) — caster KEYS, not display
    /// spellings. Empty is the shipped default and the world this crate constructs on its own: you
    /// and nobody else.
    ///
    /// IT IS NOT CLEARED BY `reset`, and that is the same rule the module's own `never_member` set
    /// obeys: it is a user PREFERENCE rather than log state, so a character switch does not
    /// withdraw it. The anchors it produced are cleared, because those are log state.
    externals: std::collections::HashSet<String>,
}

impl CastAnchors {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.by_line.clear();
        self.ever_cast.clear();
        self.quick_buff_ts = 0;
    }

    /// `You begin casting <S>.` / `You begin singing <S>.` — the self anchor.
    pub fn note_self_cast(&mut self, spell: &str, ts: i64) {
        self.note(spell, ts, SELF_CASTER.to_string());
    }

    /// REPLACE THE EXTERNALS ALLOWLIST — `buffsModule.setTrust(next)`, whole (JOS-482).
    ///
    /// UNLIKE the graphics switches, this DOES bring the running session into line: a name added
    /// mid-session anchors the very next cast rather than the next launch. What it does NOT do is
    /// retro-admit anything that already landed — a landing was either anchored when it arrived or
    /// it was not, and rewriting the past would be a second opinion about a decision the log has
    /// already settled. Nothing here touches `by_line`, which is exactly that guarantee.
    pub fn set_trust(&mut self, externals: impl IntoIterator<Item = String>) {
        self.externals = externals.into_iter().map(|n| caster_key(&n)).collect();
    }

    /// `casterTrusted` against THIS world's allowlist: you, plus whoever the user named.
    fn trusted(&self, caster: &str) -> bool {
        caster_trusted(caster) || self.externals.contains(&caster_key(caster))
    }

    /// `<Name> begins casting <S>.` — recorded ONLY for a caster on the externals allowlist. An
    /// anchor from anybody else is exactly the stranger's-buff case the gate exists to refuse, and
    /// keeping it would make the refusal a matter of who asked later.
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
        // SELF ONLY. An external's cast tells you nothing about what is in YOUR spellbook, and this
        // map's only job is narrowing a burst of yours.
        if is_self && self.ever_cast.get(&key).is_none_or(|&prev| ts > prev) {
            self.ever_cast.insert(key, ts);
        }
    }

    /// `You activate Quick Buff.` — a self anchor that names a WINDOW rather than a spell.
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

    /// THE GATE. What, if anything, admits a landing of `spell` at `ts`?
    ///
    /// A NAMED anchor wins: it says who cast it, which rank, and therefore which learner key the
    /// sample belongs to. Failing that, a Quick Buff burst admits the landing as YOURS but
    /// `unnamed`, because the activation line names no spell — the caller must not treat that as
    /// narrowing. Nothing else admits anything (ruling 3: an unanchored landing produces nothing).
    pub fn attribute(&self, spell: &str, ts: i64) -> Option<Attribution> {
        if let Some(a) = self.by_line.get(&spell_key(spell)) {
            // The anchor is re-checked against the CURRENT allowlist, which is what makes a name
            // the user just REMOVED stop anchoring immediately rather than at the next cast.
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

    /// A fizzle retracts the ANCHOR and leaves the ever-cast knowledge standing — the priming
    /// property the burst narrowing depends on.
    #[test]
    fn a_fizzle_retracts_the_anchor_and_not_the_knowledge() {
        let mut a = CastAnchors::new();
        a.note_self_cast("Clarity II", 1000);
        assert!(a.named_anchor_for("Clarity", 2000).is_some());
        a.clear_cast("Clarity");
        assert!(a.named_anchor_for("Clarity", 2000).is_none());
        assert_eq!(a.last_cast_ts("Clarity"), Some(1000));
    }

    /// The window is one-sided: a landing BEFORE its cast is not that cast's, and one more than ten
    /// seconds after it is nobody's.
    #[test]
    fn the_own_cast_window_looks_forward_only() {
        let mut a = CastAnchors::new();
        a.note_self_cast("Mesmerization VII", 10_000);
        assert!(a.named_anchor_for("Mesmerization", 9_999).is_none());
        assert!(a.named_anchor_for("Mesmerization", 20_000).is_some());
        assert!(a.named_anchor_for("Mesmerization", 20_001).is_none());
    }

    /// Two ranks of one line inside the window flag the ambiguity the landing sentence cannot
    /// resolve — and the ROW is still admitted.
    #[test]
    fn two_ranks_in_one_window_are_flagged_rather_than_guessed() {
        let mut a = CastAnchors::new();
        a.note_self_cast("Mesmerization III", 1000);
        a.note_self_cast("Mesmerization VII", 5000);
        let at = a.named_anchor_for("Mesmerization", 6000).expect("anchored");
        assert!(at.rank_changed);
        assert_eq!(at.display.as_deref(), Some("Mesmerization VII"));
    }

    /// The burst admits a landing as YOURS and names no spell, which is what keeps a family a
    /// family.
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

    /// A stranger's cast anchors NOTHING under the shipped default allowlist.
    #[test]
    fn an_untrusted_external_cast_anchors_nothing() {
        let mut a = CastAnchors::new();
        a.note_other_cast("Dranix", "Clarity", 1000);
        assert!(a.attribute("Clarity", 2000).is_none());
        assert_eq!(a.last_cast_ts("Clarity"), None);
    }
}
