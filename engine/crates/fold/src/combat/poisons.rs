//! The rogue poison roster, the half of it the FOLD needs.
//!
//! The parser's own tables carry the MESSAGES (coat lines, dry lines, Strike emotes). What they do
//! not carry is the roster's MECHANICS — which Strikes a poison grants, and which venoms replace
//! which — and the engine needs both: the coat stack is keyed on the replacement line, the rolling
//! time-to-slow sample is gated on the coat granting the slow Strike, and a poison lane's source
//! window is the union of the coat spans of every poison granting one of its Strikes.
//!
//! Two sources, neither guessed: the committed spell scrape for every message, and the wiki's Rogue
//! page for the two mechanics the messages cannot state.
//!
//! FOUR CONCURRENT COATS is not a slot count the game enforces — it falls out of the roster. The
//! per-spell wiki pages state the replacements, so the five combat venoms form exactly three
//! mutually-exclusive lines (asp, blood, stunning) plus the one utility slot. `line` is that
//! grouping; keying the stack on the NAME would let Cobra sit beside Asp for a fourth venom. The
//! owner's log has never carried a Cobra or Blood Draw coat line (both are above his level), so the
//! confirmation here is the wiki's wording rather than an observed three-at-a-time.
//!
//! A Strike emote names no caster (law 6). `<mob>'s limbs move slower!` is Weakening Strike's landing
//! message and nothing else's, but four poisons grant Weakening Strike, so a slow landing proves "a
//! rogue slow proc" and never which poison.

/// One coatable poison, reduced to the two fields the fold reads.
pub struct PoisonDef {
    /// DB spell name — the display name and the catalog key.
    pub name: &'static str,
    /// Strike names this poison grants (wiki Rogue page). Drives `is_slow_capable` and the poison
    /// lane's source window.
    pub strikes: &'static [&'static str],
    /// Combat venoms only: the mutually-exclusive line this venom belongs to. Two venoms sharing a
    /// line replace one another; venoms on different lines stack. Utility poisons leave it empty —
    /// they already share one slot.
    pub line: &'static str,
}

/// The roster — 15 utility + 5 combat, exactly the two lists on the wiki's Rogue page.
pub const POISONS: [PoisonDef; 20] = [
    // utility: one at a time, a new utility coat replaces the old.
    p("Weakening Poison", &["Weakening Strike"]),
    p("Hobbling Poison", &["Hobbling Strike"]),
    p("Concussive Poison", &["Concussive Strike"]),
    p("Befuddling Poison", &["Befuddling Strike"]),
    p("Grounding Poison", &["Grounding Strike"]),
    p("Clumsiness Poison", &["Clumsiness Strike"]),
    p("Banishing Poison", &["Banishing Strike"]),
    p("Fettering Poison", &["Grounding Strike", "Hobbling Strike"]),
    p("Binding Poison", &["Weakening Strike", "Hobbling Strike"]),
    p(
        "Neurotoxic Poison",
        &["Befuddling Strike", "Weakening Strike"],
    ),
    p(
        "Mind Wrack Poison",
        &["Concussive Strike", "Clumsiness Strike"],
    ),
    p(
        "Thought Drain Poison",
        &["Befuddling Strike", "Clumsiness Strike"],
    ),
    p(
        "Antimagic Poison",
        &["Concussive Strike", "Banishing Strike"],
    ),
    p(
        "Mage Bane Poison",
        &["Befuddling Strike", "Banishing Strike"],
    ),
    p(
        "Paralytic Poison",
        &["Weakening Strike", "Clumsiness Strike"],
    ),
    // combat: stack across lines, and a line's two members replace each other.
    v("Blood Siphon Venom", &["Blood Siphon Strike"], "blood"),
    v("Asp Venom", &["Asp Venom Strike"], "asp"),
    v("Stunning Venom", &["Stunning Strike"], "stunning"),
    v("Blood Draw Venom", &["Blood Draw Strike"], "blood"),
    v("Cobra Venom", &["Cobra Venom Strike"], "asp"),
];

const fn p(name: &'static str, strikes: &'static [&'static str]) -> PoisonDef {
    PoisonDef {
        name,
        strikes,
        line: "",
    }
}

const fn v(name: &'static str, strikes: &'static [&'static str], line: &'static str) -> PoisonDef {
    PoisonDef {
        name,
        strikes,
        line,
    }
}

/// The Strike that prints `<mob>'s limbs move slower!` — the ONE proc this feature measures a
/// time-to-land for. Named once so the parser, the engine and the UI cannot drift.
pub const SLOW_STRIKE: &str = "Weakening Strike";

/// The dispel family — the one non-poison effect the Procs tab counts. The complete set in the
/// committed spell DB whose landing message contains "dispelled", across three message tiers each
/// shared by several spells (law 3), so a lane is labeled with every candidate and flagged
/// ambiguous: the count is exact, the name is not.
///
/// NOT a rogue proc, and the UI must never imply otherwise: the rogue's own dispel proc (Banishing
/// Strike) prints a different line and lives in the Strike ledger. The list is a curated gate
/// because the raw message-driven landing stream is far too broad to tabulate.
pub const DISPEL_FAMILY: [&str; 7] = [
    "Cancel Magic",
    "Phobocancel",
    "Neutralize Magic",
    "Nullify Magic",
    "Beholder Dispel",
    "Pillage Enchantment",
    "Strip Enchantment",
];

pub fn is_dispel_family(name: &str) -> bool {
    DISPEL_FAMILY.contains(&name)
}

fn poison_by_name(poison: &str) -> Option<&'static PoisonDef> {
    POISONS.iter().find(|p| p.name == poison)
}

/// The exclusivity key for a coated poison — what the combat stack and the state timeline's
/// `coat:combat:<line>` group are keyed on. Falls back to the lowercased NAME for anything not in
/// the roster, so a future venom without a line becomes its own line rather than joining somebody
/// else's.
pub fn coat_line_key(poison: &str) -> String {
    match poison_by_name(poison) {
        Some(p) if !p.line.is_empty() => p.line.to_string(),
        _ => poison.to_lowercase(),
    }
}

/// True when coating this poison gives you a chance at the slow proc.
pub fn is_slow_capable(poison: &str) -> bool {
    poison_by_name(poison).is_some_and(|p| p.strikes.contains(&SLOW_STRIKE))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three lines, and the two upgrade venoms sit on the lines they replace.
    #[test]
    fn the_combat_stack_is_keyed_on_the_replacement_line() {
        assert_eq!(coat_line_key("Asp Venom"), "asp");
        assert_eq!(coat_line_key("Cobra Venom"), "asp");
        assert_eq!(coat_line_key("Blood Siphon Venom"), "blood");
        assert_eq!(coat_line_key("Blood Draw Venom"), "blood");
        assert_eq!(coat_line_key("Stunning Venom"), "stunning");
        // A utility poison has no line, so it is its own key — the utility slot is exclusive anyway.
        assert_eq!(coat_line_key("Neurotoxic Poison"), "neurotoxic poison");
        // …and so is anything the roster does not know.
        assert_eq!(coat_line_key("Some New Venom"), "some new venom");
    }

    /// Four poisons grant the slow Strike, which is why a slow landing never names one.
    #[test]
    fn slow_capability_is_a_property_of_four_poisons() {
        for name in [
            "Weakening Poison",
            "Binding Poison",
            "Neurotoxic Poison",
            "Paralytic Poison",
        ] {
            assert!(is_slow_capable(name), "{name}");
        }
        assert!(!is_slow_capable("Asp Venom"));
        assert!(!is_slow_capable("unknown"));
    }
}
