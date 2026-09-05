//! Who else is in this fight: the evidence-accreting classifier behind the record-everything meter,
//! plus the active-special-attack lane state beside it.
//!
//! Any combatant the log names gets a recorded row unless one of the app's stronger models claims
//! the name; SCOPE filters at display time rather than at admission.
//!
//! It is a refusal ladder, not an inference. Nothing here decides that a name is a PERSON — the log
//! cannot say that. Every rung is something the log stated (it is or was one of your pets, a charm
//! broadcast named it, it said a pet sentence, you damaged it, it damaged you, it is somebody else's
//! charm pet) and only then is the NAME SHAPE asked. Shape is the weakest rung and is deliberately
//! last: it refuses every article-led mob name, but alone it would admit a proper-named mob.
//!
//! The honest limit: an unbound stranger's SUMMONED PET is indistinguishable from a player by name
//! alone, because EQ generates pet names from the same one-word proper-name grammar. That is why
//! nothing here is called a "player" — a recorded row says only that the log named this combatant
//! dealing this damage, and the `other` source kind says exactly that and no more.

use crate::combat::spellfacts::is_player_shaped_name;
use crate::jsmap::JsMap;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct OtherCombatants {
    /// nameKey → is it shaped like a player? Cached because the SHAPE of a name cannot change and
    /// the question is asked on every mob-vs-mob line a busy raid log carries.
    shapes: HashMap<String, bool>,
    /// Names a stronger model has claimed as a pet — yours, somebody else's, or self-declared. The
    /// pet models are authoritative for pet attribution, so once one speaks this ladder never books
    /// the name again and any row it already booked is retracted. Permanent for the session.
    pets: HashSet<String>,
    /// Names that have landed damage ON YOU while shaped like a player.
    ///
    /// The rung is deliberately this narrow. The wider "it hit anything of OURS" was measured wrong
    /// on the owner's full log — dozens of real players marked as mobs, because other people in the
    /// zone attack the mob YOU have charmed.
    ///
    /// It yields to the heal stream (`clear_hostile`): a heal landing on you cannot come from a mob,
    /// so it outranks a swing at you.
    hostiles: HashSet<String>,
    /// Recorded name keys → the log's own spelling (law 2: canonical key, raw display).
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

/// Which special attack is live in each verb lane.
///
/// Upgraded specials never announce themselves in the damage line. The game states the switch ONCE —
/// `You will now use Dragon Punch instead of Eagle Strike while attacking.` — and from then on every
/// one of those specials lands as the generic verb `strike`. The damage was always counted; what
/// could not exist was a Dragon Punch row. This joins the log's own state line to the swing by VERB.
///
/// A lane earns a row only when its generic verb is EXCLUSIVE to the chain, and only two are:
/// `strike` and `kick`. `You will now use Slam instead of Bash while attacking.` is a real state
/// line, but Slam never prints a `slam` verb and Bash skill-ups keep ticking through Slam eras, so
/// the shield lane is not distinguishable and gets no row.
///
/// Skill-ups are not an input: `better at Tiger Claw!` keeps ticking long after Tiger Claw was
/// replaced, so inferring the live special from them would relabel Dragon Punch swings. State comes
/// from the state line.
///
/// Pre-state is honest by omission: until a `You will now use` line has been seen for a lane this
/// answers nothing and the parser's ordinary skill name stands. A lane is never seeded from the
/// table's first entry, so it cannot claim a special the log has not stated the character has.
///
/// SELF ONLY. The state line has no third-person grammar, so nothing here can ever be known about a
/// mob, a pet or another player; the caller gates on the attacker being You.
#[derive(Default)]
pub struct SpecialAttacks {
    /// verb lane → the special the log last SAID was active there.
    active: HashMap<String, String>,
}

/// verb → the specials that print with it. The order is the observed progression, but nothing reads
/// it as an ordering and nothing may use it to guess the next special: membership is the contract.
const LANES: [(&str, &[&str]); 2] = [
    (
        "strike",
        &["Tiger Claw", "Eagle Strike", "Dragon Punch", "Tail Rake"],
    ),
    ("kick", &["Kick", "Round Kick", "Flying Kick"]),
];

/// The verb lane a special attack belongs to, or `None` for one with no evidence behind it (Smite,
/// Backstab and Frenzy print their own verb and need no attribution; Bash/Slam is the refused lane).
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
    /// special belongs to no lane there is evidence for.
    ///
    /// `replaces` is deliberately not consulted: the bare GRANT form carries no `replaces` at all,
    /// so a `replaces`-driven model would be blind to the one shape that RESETS a lane.
    pub fn note(&mut self, skill: &str) -> Option<&'static str> {
        let lane = lane_of_special(skill)?;
        self.active
            .insert(lane.to_string(), skill.trim().to_string());
        Some(lane)
    }

    /// The lane label for a swing that printed `verb`, or `None` to leave the parser's ordinary
    /// skill name alone — for a verb with no lane, and for a lane the log has not spoken about.
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

    /// A stronger model claiming the name reports the first claim only, so the caller retracts once.
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
        // Tail Rake shares Dragon Punch's seat rather than following it, so it is the same lane.
        assert_eq!(s.note("Tail Rake"), Some("strike"));
        assert_eq!(s.lane_skill(Some("strike")), Some("Tail Rake"));
        // Slam belongs to no lane the evidence supports.
        assert_eq!(s.note("Slam"), None);
        assert_eq!(s.lane_skill(Some("bash")), None);
    }
}
