//! The two tables the cascade matches against by equality rather than by pattern: the poison roster
//! and the consider-faction ladder.
//!
//! Both keep their source order, because both orders are semantic — the consider alternation is
//! built from the ladder in ladder order, and a poison proc's first strike is the name the event
//! carries.

/// The exact `You coat your blades …` line to (poison name, group). Only the three fields a coat
/// event carries are kept; the roster's levels and exclusivity lines are model facts the parser
/// never reads.
pub const POISON_BY_COAT_MSG: [(&str, &str, &str); 20] = [
    (
        "You coat your blades in a weak paralytic.",
        "Weakening Poison",
        "utility",
    ),
    (
        "You coat your blades in a thick venom.",
        "Hobbling Poison",
        "utility",
    ),
    (
        "You coat your blades with a potent venom.",
        "Concussive Poison",
        "utility",
    ),
    (
        "You coat your blades in a mind numbing poison.",
        "Befuddling Poison",
        "utility",
    ),
    (
        "You coat your blades in a tar-like poison.",
        "Grounding Poison",
        "utility",
    ),
    (
        "You coat your blades in a numbing poison.",
        "Clumsiness Poison",
        "utility",
    ),
    (
        "You coat your blades with a magical poison.",
        "Banishing Poison",
        "utility",
    ),
    (
        "You coat your blades in a fettering poison.",
        "Fettering Poison",
        "utility",
    ),
    (
        "You coat your blades in a binding poison.",
        "Binding Poison",
        "utility",
    ),
    (
        "You coat your blades in a neurotoxic poison.",
        "Neurotoxic Poison",
        "utility",
    ),
    (
        "You coat your blades in a mind wracking poison.",
        "Mind Wrack Poison",
        "utility",
    ),
    (
        "You coat your blades in a thought draining poison.",
        "Thought Drain Poison",
        "utility",
    ),
    (
        "You coat your blades in antimagic poison.",
        "Antimagic Poison",
        "utility",
    ),
    (
        "You coat your blades in mage bane poison.",
        "Mage Bane Poison",
        "utility",
    ),
    (
        "You coat your blades in a paralytic poison.",
        "Paralytic Poison",
        "utility",
    ),
    (
        "You coat your blades in a siphoning poison.",
        "Blood Siphon Venom",
        "combat",
    ),
    ("You coat your blades in asp venom.", "Asp Venom", "combat"),
    (
        "You coat your blades with a stunning agent.",
        "Stunning Venom",
        "combat",
    ),
    (
        "You coat your blades in a drawing poison.",
        "Blood Draw Venom",
        "combat",
    ),
    (
        "You coat your blades in cobra venom.",
        "Cobra Venom",
        "combat",
    ),
];

/// The two wears-off lines, split by group.
pub const POISON_DRY_MSG: [(&str, &str); 2] = [
    ("The poison dries from the blade.", "utility"),
    ("The venom drips away.", "combat"),
];

pub struct PoisonProc {
    pub suffix: &'static str,
    pub strikes: &'static [&'static str],
    pub effect: &'static str,
}

/// A Strike's landing emote, by the suffix that identifies it.
pub const POISON_PROCS: [PoisonProc; 10] = [
    PoisonProc {
        suffix: "'s limbs move slower!",
        strikes: &["Weakening Strike"],
        effect: "slow",
    },
    PoisonProc {
        suffix: "'s fingers slow down.",
        strikes: &["Clumsiness Strike"],
        effect: "spellSlow",
    },
    PoisonProc {
        suffix: "'s blessings wither!",
        strikes: &["Banishing Strike"],
        effect: "dispel",
    },
    PoisonProc {
        suffix: "'s feet won't budge!",
        strikes: &["Grounding Strike"],
        effect: "root",
    },
    PoisonProc {
        suffix: "stumbles, clutching their head!",
        strikes: &["Befuddling Strike"],
        effect: "manaDrain",
    },
    PoisonProc {
        suffix: "begins to sway!",
        strikes: &["Stunning Strike"],
        effect: "stun",
    },
    PoisonProc {
        suffix: "blinks, looking confused!",
        strikes: &["Concussive Strike"],
        effect: "interrupt",
    },
    PoisonProc {
        suffix: "starts limping!",
        strikes: &["Hobbling Strike"],
        effect: "snare",
    },
    PoisonProc {
        suffix: "begins to bleed profusely!",
        strikes: &["Blood Siphon Strike", "Blood Draw Strike"],
        effect: "dot",
    },
    PoisonProc {
        suffix: "screams as poison burns their veins!",
        strikes: &["Asp Venom Strike", "Cobra Venom Strike"],
        effect: "damage",
    },
];

/// Phrase to rung, friendliest first. The parser builds its alternation from this list in this
/// order, and a rung the ladder does not carry makes the line decline rather than mis-split a mob
/// name.
pub const CONSIDER_FACTION_RUNGS: [(&str, &str); 9] = [
    ("regards you as an ally", "ally"),
    ("looks upon you warmly", "warmly"),
    ("kindly considers you", "kindly"),
    ("judges you amiably", "amiably"),
    ("regards you indifferently", "indifferent"),
    ("looks your way apprehensively", "apprehensive"),
    ("glowers at you dubiously", "dubious"),
    ("glares at you threateningly", "threatening"),
    ("scowls at you, ready to attack", "scowls"),
];
