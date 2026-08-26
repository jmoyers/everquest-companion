//! WHO ELSE IS IN THIS FIGHT — the evidence-accreting classifier behind the record-everything meter
//! (`src/main/combat/otherCombatants.ts`), plus the ACTIVE-SPECIAL-ATTACK lane state beside it.
//!
//! ── THE RULING IT IMPLEMENTS (owner, 2026-08-20) ───────────────────────────────────────────────
//!
//! "Everyone" means ANY fight the log can see shows up — participation not required. Recording used
//! to END at admission: `classify()`'s last rule was "attacker not you/pet, target not you →
//! ignore", so with an empty roster snapshot nobody but you and your pet was ever recorded, and the
//! Everyone scope could not show what nothing had recorded. This is the widening: a combatant the
//! log names, that none of the app's stronger models claims, gets its own recorded row, and SCOPE
//! filters at display time.
//!
//! ── IT IS A REFUSAL LADDER, NOT AN INFERENCE ───────────────────────────────────────────────────
//!
//! Nothing here decides that a name is a PERSON — the log cannot say that. What it decides is far
//! narrower: whether any model with better evidence has already claimed the name. Every rung is
//! something the log STATED — it is or was one of your pets; a charm broadcast has named it; it said
//! a pet sentence or named someone its leader; YOU have landed damage on it; it has landed damage on
//! YOU; it is bound as somebody else's charm pet — and only then is the NAME SHAPE asked. Shape is
//! the weakest thing in the ladder and is deliberately last: it refuses every article-led mob name,
//! which is what makes the ladder cheap, but on its own it would admit a single-word proper-named
//! mob.
//!
//! THE HONEST LIMIT, stated here rather than discovered in a bug report: an UNBOUND stranger's
//! SUMMONED PET is indistinguishable from a player by name alone — EQ generates pet names from the
//! same one-word proper-name grammar it gives players. Measured on the owner's 2,192,988-line log:
//! of 608 distinct names this ladder records, a visible minority are other people's pets. That is
//! why nothing here is called a "player": a recorded row says THE LOG NAMED THIS COMBATANT DEALING
//! THIS DAMAGE, which is true of a person and of their pet alike, and the `other` source kind says
//! exactly that and no more.

use crate::combat::spellfacts::is_player_shaped_name;
use crate::jsmap::JsMap;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct OtherCombatants {
    /// nameKey → is it shaped like a player? Cached because the SHAPE of a name cannot change and
    /// the question is asked on every mob-vs-mob line a busy raid log carries.
    shapes: HashMap<String, bool>,
    /// Names a STRONGER MODEL has claimed as a pet — yours, somebody else's, or self-declared.
    /// Absolute and permanent for the session: the pet models are authoritative for pet attribution,
    /// so once one of them speaks this ladder never books the name again and the row it already
    /// booked is RETRACTED.
    pets: HashSet<String>,
    /// Names that have LANDED DAMAGE ON YOU while shaped like a player.
    ///
    /// THE ONE RUNG THAT IS NEW, AND THE ONE THAT NEEDED MEASURING, because world-model law 4 says
    /// the WIDER version is wrong ("being hit is something that HAPPENS to you; hitting is something
    /// you DO"). That law is about `note_player`, where a bad refusal DELETES real damage; here a
    /// bad refusal only HIDES a row, so the trade differs — but it was measured anyway, twice:
    ///
    ///   * "it hit YOU" — 24 names on the owner's 2.19M-line log, every one of them a real
    ///     single-word-named mob (Najena, Drelzna, Lockjaw, Gorgalosk, Bzzazzt, …). ZERO players.
    ///   * "it hit anything of OURS" — MEASURED WRONG on the same log: 59 real players marked as
    ///     mobs, because other people in the zone attack the mob YOU have charmed. Not shipped,
    ///     recorded here so it is not re-derived.
    ///
    /// AND IT YIELDS TO THE HEAL STREAM (`clear_hostile`): a heal landing on you cannot come from a
    /// mob, so it outranks a swing at you.
    hostiles: HashSet<String>,
    /// Recorded name keys → the log's own spelling (world-model law 2: canonical key, raw display).
    /// Insertion-ordered because `names()` publishes it.
    seen: JsMap<String>,
}

impl OtherCombatants {
    pub fn new() -> Self {
        OtherCombatants::default()
    }

    pub fn reset(&mut self) {
        self.shapes.clear();
        self.pets.clear();
        self.hostiles.clear();
        self.seen.clear();
    }

    /// Is `name` shaped the way EQ spells a one-word proper name? Cached per key.
    pub fn shaped(&mut self, name: &str, key: &str) -> bool {
        if let Some(&hit) = self.shapes.get(key) {
            return hit;
        }
        let v = is_player_shaped_name(name);
        self.shapes.insert(key.to_string(), v);
        v
    }

    /// A stronger model claimed this name as a pet. Returns true the FIRST time, so the caller knows
    /// whether there is a row to retract.
    pub fn note_pet(&mut self, key: &str) -> bool {
        if key.is_empty() || self.pets.contains(key) {
            return false;
        }
        self.pets.insert(key.to_string());
        true
    }

    pub fn is_pet(&self, key: &str) -> bool {
        self.pets.contains(key)
    }

    /// It landed damage on you (see `hostiles`).
    pub fn note_hostile(&mut self, key: &str) {
        if !key.is_empty() {
            self.hostiles.insert(key.to_string());
        }
    }

    /// The heal stream named it a player, which outranks a swing at you (see `hostiles`).
    pub fn clear_hostile(&mut self, key: &str) {
        self.hostiles.remove(key);
    }

    pub fn is_hostile(&self, key: &str) -> bool {
        self.hostiles.contains(key)
    }

    /// Remember that this name has a recorded row, and how the log spells it.
    pub fn note(&mut self, key: &str, display: &str) {
        if !self.seen.contains_key(key) {
            self.seen.insert(key.to_string(), display.to_string());
        }
    }

    /// True once this name has booked at least one recorded row.
    pub fn is_recorded(&self, key: &str) -> bool {
        self.seen.contains_key(key)
    }

    /// The log's spelling for a recorded name — the meter row's label when the roster has none.
    pub fn name_of(&self, key: &str) -> Option<&str> {
        self.seen.get(key).map(String::as_str)
    }

    /// A recorded row was retracted — the name stops being one of ours to display.
    pub fn forget(&mut self, key: &str) {
        self.seen.remove(key);
    }
}

/// WHICH SPECIAL ATTACK IS LIVE IN EACH VERB LANE — `src/main/combat/specialAttacks.ts`.
///
/// EQ Legends' upgraded specials never announce themselves in the damage line. The game states the
/// switch ONCE — `You will now use Dragon Punch instead of Eagle Strike while attacking.` — and from
/// then on every one of those specials lands as the GENERIC verb `strike`. The damage was always
/// COUNTED; what could not exist was a Dragon Punch ROW. This supplies the missing half: the log's
/// own statement of which special is live, joined to the swing by VERB.
///
/// ── THE LANES, AND WHY EXACTLY THESE TWO ───────────────────────────────────────────────────────
///
/// A lane earns a row only when its generic verb is EXCLUSIVE to the chain, and both were measured
/// on the owner's own bytes:
///
///   `strike` → Tiger Claw → Eagle Strike → Dragon Punch → Tail Rake. The player's first-ever
///     `You strike …` line is THREE SECONDS after `You will now use Tiger Claw …`; across nine
///     prior days and hundreds of thousands of swings he never once "struck". `Tail Rake` (JOS-102)
///     shares Dragon Punch's SEAT rather than following it — both are MNK level 25 in the scraped
///     class table and both displace Eagle Strike — so the chain is four names and three rungs.
///   `kick` → Kick → Round Kick → Flying Kick. The skill-up stream partitions PERFECTLY by era:
///     296/296, 190/190, 254/255 ticks inside their own lane's era, with the Aug 02 loadout swap as
///     the control.
///
/// THE LANE THAT DID NOT EARN A ROW, which is the point of measuring: `You will now use Slam instead
/// of Bash while attacking.` is a real state line and Slam never prints a `slam` verb (0 lines,
/// against 39,900 `bash`), so the shield lane looks structurally identical. THE EVIDENCE REFUSES IT:
/// 185 `You have become better at Bash!` ticks fire DURING Slam eras and there is no `better at
/// Slam!` line anywhere. A documented non-distinguishable beats a plausible guess.
///
/// SKILL-UPS ARE NOT AN INPUT — `better at Tiger Claw!` keeps ticking 111 times after Tiger Claw was
/// replaced, so inferring the live special from them would have relabelled Dragon Punch swings.
/// State comes from the state line.
///
/// PRE-STATE IS HONEST BY OMISSION: until a `You will now use` line has been seen for a lane this
/// answers nothing and the parser's ordinary skill name stands. It never seeds a lane from the
/// table's first entry, so it cannot claim a special the log has not stated the character has.
///
/// SELF ONLY. The state line has no third-person grammar, so nothing here can ever be known about a
/// mob, a pet or another player; the caller gates on the attacker being You.
#[derive(Default)]
pub struct SpecialAttacks {
    /// verb lane → the special the log last SAID was active there.
    active: HashMap<String, String>,
}

/// verb → the ordered chain of specials that print with it. Order is the observed progression;
/// nothing reads it as an ordering, and NOTHING may use it to guess the next special — membership is
/// the whole contract.
const LANES: [(&str, &[&str]); 2] = [
    (
        "strike",
        &["Tiger Claw", "Eagle Strike", "Dragon Punch", "Tail Rake"],
    ),
    ("kick", &["Kick", "Round Kick", "Flying Kick"]),
];

/// The verb lane a special attack belongs to, or `None` for one we have no evidence about (Smite,
/// Backstab, Frenzy — which print their own verb and need no attribution — and Bash/Slam).
pub fn lane_of_special(skill: &str) -> Option<&'static str> {
    let want = skill.trim().to_lowercase();
    LANES.iter().find_map(|(verb, skills)| {
        skills
            .iter()
            .any(|s| s.to_lowercase() == want)
            .then_some(*verb)
    })
}

impl SpecialAttacks {
    pub fn new() -> Self {
        SpecialAttacks::default()
    }

    pub fn reset(&mut self) {
        self.active.clear();
    }

    /// Fold one `You will now use …` line in. Returns the lane it moved, or `None` when the named
    /// special belongs to no lane we have evidence for.
    ///
    /// `replaces` is NOT consulted. Using it to infer a lane would be exactly the guess this module
    /// refuses: the bare GRANT form carries no `replaces` at all, so a `replaces`-driven model would
    /// be blind to the one shape that RESETS a lane.
    pub fn note(&mut self, skill: &str) -> Option<&'static str> {
        let lane = lane_of_special(skill)?;
        self.active
            .insert(lane.to_string(), skill.trim().to_string());
        Some(lane)
    }

    /// The lane label for a swing that printed `verb`, or `None` to leave the parser's ordinary
    /// skill name alone — for every verb with no lane AND for a lane the log has not spoken about.
    pub fn lane_skill(&self, verb: Option<&str>) -> Option<&str> {
        self.active.get(verb?).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ladder_remembers_a_row_once_and_gives_the_logs_own_spelling() {
        let mut o = OtherCombatants::new();
        o.note("scooba", "Scooba");
        o.note("scooba", "SCOOBA");
        assert_eq!(o.name_of("scooba"), Some("Scooba"));
        assert!(o.is_recorded("scooba"));
        o.forget("scooba");
        assert!(!o.is_recorded("scooba"));
    }

    /// A stronger model claiming the name reports the FIRST claim only, so the caller retracts once.
    #[test]
    fn a_pet_claim_reports_itself_exactly_once() {
        let mut o = OtherCombatants::new();
        assert!(o.note_pet("vebarn"));
        assert!(!o.note_pet("vebarn"));
        assert!(!o.note_pet(""));
        assert!(o.is_pet("vebarn"));
    }

    /// The hostile rung yields to the heal stream — a heal landing on you cannot come from a mob.
    #[test]
    fn a_heal_outranks_a_swing_at_you() {
        let mut o = OtherCombatants::new();
        o.note_hostile("sonista");
        assert!(o.is_hostile("sonista"));
        o.clear_hostile("sonista");
        assert!(!o.is_hostile("sonista"));
    }

    /// A lane is silent until the log states one, and the special's own name is what it then says.
    #[test]
    fn a_lane_answers_nothing_until_the_log_states_it() {
        let mut s = SpecialAttacks::new();
        assert_eq!(s.lane_skill(Some("strike")), None);
        assert_eq!(s.note("Dragon Punch"), Some("strike"));
        assert_eq!(s.lane_skill(Some("strike")), Some("Dragon Punch"));
        // The Iksar arm of the same chain occupies the same lane.
        assert_eq!(s.note("Tail Rake"), Some("strike"));
        assert_eq!(s.lane_skill(Some("strike")), Some("Tail Rake"));
        // Slam belongs to no lane the evidence supports.
        assert_eq!(s.note("Slam"), None);
        assert_eq!(s.lane_skill(Some("bash")), None);
    }
}
