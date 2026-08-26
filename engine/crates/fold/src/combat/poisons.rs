//! THE ROGUE POISON ROSTER, the half of `src/shared/poisons.ts` the FOLD needs.
//!
//! `eqlog::parse::data` already carries the three tables the PARSER matches against (the coat lines,
//! the two dry lines and the Strike emotes). What it deliberately does not carry is the roster's own
//! MECHANICS — which Strikes a poison grants, and which venoms replace which — because a parser has
//! no use for either. The engine does: the coat stack is keyed on the replacement LINE, the rolling
//! time-to-slow sample is gated on the coat granting the slow Strike, and a poison lane's source
//! window is the union of the coat spans of every poison that grants one of its Strikes.
//!
//! TWO SOURCES, both authoritative, neither guessed: `spells.json` (the committed eqlwiki scrape) for
//! every message, and https://eqlwiki.com/Rogue for the two mechanics the messages cannot state.
//!
//! ── FOUR CONCURRENT COATS, AND WHY IT IS FOUR ────────────────────────────────────────────────
//!
//! The cap is NOT a slot count the game enforces — it falls out of the roster, and the per-spell wiki
//! pages say so in their own words: Cobra Venom "replaces" Asp Venom, Blood Draw Venom "replaces"
//! Blood Siphon Venom, and Stunning Venom "stacks with all other combat poisons" with no exception.
//! So the five combat venoms form exactly THREE mutually-exclusive LINES — asp, blood, stunning — and
//! at most one member of each can be on the blades. Three combat + the one utility slot = four.
//! `line` is that grouping; keying the stack on the NAME would let Cobra sit beside Asp for a fourth
//! simultaneous venom.
//!
//! WHAT THE PLAYER'S LOG CANNOT SHOW, said rather than claimed: this character is level 45 and both
//! upgrade venoms are level 46, so the log has never carried a Cobra or Blood Draw coat line. Every
//! observed venom burst is asp + siphoning + stunning — consistent with the model, but the
//! CONFIRMATION is the wiki's replacement wording, not the log's three-at-a-time.
//!
//! ── WHAT THE LOG CANNOT SAY (law 6) ─────────────────────────────────────────────────────────
//!
//! A Strike emote names no caster. `<mob>'s limbs move slower!` is Weakening Strike's landing message
//! and nothing else's, but FOUR poisons grant Weakening Strike — Weakening, Binding, Neurotoxic and
//! Paralytic — so a slow landing proves "a rogue slow proc", never "your Neurotoxic".

/// One coatable poison, reduced to the two fields the fold reads.
pub struct PoisonDef {
    /// DB spell name — the display name and the catalog key.
    pub name: &'static str,
    /// Strike names this poison grants (wiki Rogue page). Drives `is_slow_capable` and the poison
    /// lane's source window.
    pub strikes: &'static [&'static str],
    /// COMBAT venoms only: the mutually-exclusive LINE this venom belongs to. Two venoms sharing a
    /// line replace one another; venoms on different lines stack. Utility poisons leave it empty —
    /// they already share ONE slot, so a line would say nothing.
    pub line: &'static str,
}

/// THE ROSTER — 15 utility + 5 combat, exactly the two lists on the wiki's Rogue page.
pub const POISONS: [PoisonDef; 20] = [
    // ── utility (ONE at a time; a new utility coat replaces the old) ──────────────────────────
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
    // ── combat (STACK across lines; a line's two members REPLACE each other) ──────────────────
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

/// THE DISPEL FAMILY — the one non-poison effect the Procs tab counts. These seven are the complete
/// set in the committed spell DB whose landing message contains "dispelled", landing in exactly three
/// message tiers, each shared by 2–3 spells (law 3), so a lane is labeled with EVERY candidate and
/// flagged ambiguous: the count is exact, the name is not.
///
/// NOT A ROGUE PROC, and the UI must never imply otherwise. The rogue's own dispel proc (Banishing
/// Strike) prints a completely different line — `<mob>'s blessings wither!` — which is in the Strike
/// ledger, not this one. This list is a CURATED gate on purpose: the raw message-driven landing stream
/// is far too broad to tabulate (one lifetap landing message resolves to 36 candidate spells).
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

/// The exclusivity key for a COATED poison — what the combat stack and the state timeline's
/// `coat:combat:<line>` group are keyed on. Falls back to the lowercased NAME for anything not in the
/// roster, so a future venom without a line is honestly treated as its own line rather than silently
/// folded onto somebody else's.
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

    /// THREE LINES, and the two upgrade venoms sit on the lines they replace.
    #[test]
    fn the_combat_stack_is_keyed_on_the_replacement_line() {
        assert_eq!(coat_line_key("Asp Venom"), "asp");
        assert_eq!(coat_line_key("Cobra Venom"), "asp");
        assert_eq!(coat_line_key("Blood Siphon Venom"), "blood");
        assert_eq!(coat_line_key("Blood Draw Venom"), "blood");
        assert_eq!(coat_line_key("Stunning Venom"), "stunning");
        // A UTILITY poison has no line, so it is its own key — the utility slot is exclusive anyway.
        assert_eq!(coat_line_key("Neurotoxic Poison"), "neurotoxic poison");
        // …and so is anything the roster does not know.
        assert_eq!(coat_line_key("Some New Venom"), "some new venom");
    }

    /// FOUR POISONS GRANT THE SLOW STRIKE, which is exactly why a slow landing never names one.
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
