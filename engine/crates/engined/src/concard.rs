//! The con card, resolved in this process: the engine emits a fully resolved card and the app only
//! opens the window. This file takes the facts the consider module saw and produces the card payload
//! field for field.
//!
//! The header is whole; the resist chips are the empty five and `spellData` is false. That is not a
//! stub — it is the branch the app itself takes when the client's `spells_us.txt` has not been read,
//! and the flag beside them is what tells the card why.
//!
//! Three refusals in three places. A historical line is refused one layer down: the consider module
//! only pushes when `live`, so a startup replay emits nothing. The re-open suppression stays with
//! the window that owns it — it is a fact about the PERSON, measured on the wall clock they live on,
//! and its only input is a window event the fold never sees. The player refusal is here:
//! `is_player_shaped_name(name) && !known_mob(name)`, because EQ gives players one capitalized word
//! and mobs an article plus a noun phrase, and the committed mob catalog is what rescues the
//! proper-named NPCs that shape alone would condemn.
//!
//! It asks `known_mob` and not `mob`: a lookup writes the name to the miss ledger and announces it,
//! and this question is asked about names that are very often people.
//!
//! The residual is deliberate: a proper-named NPC the catalog has never heard of gets no card. A
//! card that fails to appear costs a keystroke; a card over another player's head must never happen.
//!
//! The spell table is parsed inside this process for its own joins and never served as a bulk frame:
//! measured at 48,252 entries and 6.13 MiB of JSON against an 8 MiB frame ceiling, on a table that
//! grows with every client patch. App consumers ask per-spell `knowledge.spell` queries instead.

use protocol::generated::{
    ConCardChip, ConCardMessage, ConCardMessageKind, ResistAxis, ResistEmpirical,
};

use fold::knowledge::Knowledge;
use fold::modules::consider::{mob_key, ConEvent};
use fold::modules::resist::world::is_player_shaped_name;

/// How long a mob name this engine will put on a card.
///
/// A rendering guarantee rather than taste: a 40 kB mob name cannot push a card off the screen.
/// Characters, not bytes — the app counts UTF-16 code units and this counts scalar values, which
/// agree for every name EQ prints.
const MAX_NAME_CHARS: usize = 96;

/// The five axes, in display order, which is part of the contract: every surface shows all five,
/// because "we have not seen fire cast on this" and "fire is fine" are different statements and a
/// missing chip says neither.
const AXES: [ResistAxis; 5] = [
    ResistAxis::Magic,
    ResistAxis::Fire,
    ResistAxis::Cold,
    ResistAxis::Poison,
    ResistAxis::Disease,
];

/// The display name: whitespace-collapsed, trimmed, capped.
#[must_use]
pub fn capped_name(name: &str) -> String {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_NAME_CHARS).collect()
}

/// The empty chip for one axis.
///
/// Every number is a real zero and the three optional members are absent: nothing has been observed
/// on this axis, so a chip carrying a tag would be the model inventing an answer.
fn blank_chip(axis: ResistAxis) -> ConCardChip {
    ConCardChip {
        axis,
        tag: None,
        benchmark: None,
        pinned: false,
        empirical: ResistEmpirical {
            total: 0,
            resisted: 0,
        },
        npc_only: false,
        n: 0,
        n_total: 0,
        fit: None,
    }
}

/// The five chips this engine can honestly state. See the module header for why they are empty.
#[must_use]
pub fn chips() -> Vec<ConCardChip> {
    AXES.into_iter().map(blank_chip).collect()
}

/// Is the thing the player just conned a person?
///
/// The `known_mob` half is handed in so the rule can be driven from a test without a corpus, and so
/// the one line that knows where the catalog lives stays at the call site. `is_player_shaped_name`
/// is the fold's existing port rather than a second spelling of the two regexes.
#[must_use]
pub fn con_card_is_player(name: &str, known_mob: impl Fn(&str) -> bool) -> bool {
    is_player_shaped_name(name) && !known_mob(name)
}

/// Build the card one live `/con` deserves, or `None` when the line names nothing — or names
/// somebody.
///
/// Two refusals: a creature name that folds to an empty mob key has no queue identity, so there is
/// no card to refresh and none to open; and a person never gets one. See [`con_card_is_player`].
#[must_use]
pub fn card(ev: &ConEvent, knowledge: &dyn Knowledge) -> Option<ConCardMessage> {
    let id = mob_key(&ev.mob);
    if id.is_empty() {
        return None;
    }
    if con_card_is_player(&ev.mob, |n| knowledge.known_mob(n)) {
        return None;
    }
    Some(ConCardMessage {
        kind: ConCardMessageKind::ConCard,
        at: ev.ts,
        id,
        name: capped_name(&ev.mob),
        level: ev.level,
        zone: ev.zone.clone(),
        // Absent rather than false, which is the app payload's own shape.
        rare: ev.rare.then_some(true),
        chips: chips(),
        spell_data: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{capped_name, card, chips, con_card_is_player, MAX_NAME_CHARS};
    use fold::modules::consider::ConEvent;
    use protocol::generated::ResistAxis;

    /// The real committed corpus, not a double: every claim below about which names the catalog
    /// rescues is a claim about the bytes this repo ships.
    fn corpus() -> std::sync::Arc<knowledge::Corpus> {
        crate::foldsink::corpus()
    }

    fn con(mob: &str) -> ConEvent {
        ConEvent {
            ts: 1_787_181_707_000,
            mob: mob.to_owned(),
            level: Some(52),
            rare: false,
            zone: Some("Nagafen's Lair".to_owned()),
        }
    }

    #[test]
    fn the_card_carries_the_header_the_overlay_draws() {
        let card = card(&con("a fire giant warlord"), &*corpus()).expect("a card");
        assert_eq!(card.id, "a fire giant warlord");
        assert_eq!(card.name, "a fire giant warlord");
        assert_eq!(card.level, Some(52));
        assert_eq!(card.zone.as_deref(), Some("Nagafen's Lair"));
        assert_eq!(card.rare, None, "absent rather than false");
        assert_eq!(card.at, 1_787_181_707_000);
    }

    #[test]
    fn the_rare_infix_is_present_only_when_it_was_on_the_line() {
        let mut ev = con("a lava guardian");
        ev.rare = true;
        assert_eq!(card(&ev, &*corpus()).expect("a card").rare, Some(true));
    }

    #[test]
    fn the_queue_identity_is_the_mob_key_so_a_recon_refreshes_one_card() {
        // The three folds `mob_key` makes, each of which stops one creature becoming two cards: the
        // quote fold, the copy-number strip, and the case fold.
        let a = card(&con("Innoruuk`s Chosen"), &*corpus()).expect("a card");
        let b = card(&con("innoruuk's chosen (2)"), &*corpus()).expect("a card");
        assert_eq!(a.id, b.id);
        // …and the display name is untouched by any of it.
        assert_eq!(a.name, "Innoruuk`s Chosen");
    }

    #[test]
    fn a_line_that_names_nothing_gets_no_card() {
        assert!(card(&con(""), &*corpus()).is_none());
        assert!(card(&con("   "), &*corpus()).is_none());
    }

    /// Never a card over another player's head: a player-shaped name the catalog has never heard of
    /// is a person, and gets nothing.
    #[test]
    fn a_player_shaped_name_the_catalog_does_not_know_gets_no_card() {
        // The con ladder cannot tell a player from a mob — a faction rung is about standing, not
        // species, so nothing on the line answers this.
        assert!(card(&con("Lasershark"), &*corpus()).is_none());
        assert!(card(&con("Primitive"), &*corpus()).is_none());
    }

    /// …and a proper-named NPC the catalog knows still gets one — the half the shape test could not
    /// ship without: 954 of the committed catalog's rows carry a name `is_player_shaped_name` would
    /// condemn, and every one of them draws a card today.
    #[test]
    fn a_proper_named_npc_the_catalog_knows_still_gets_a_card() {
        for name in ["Innoruuk", "Aaryonar", "Abigail"] {
            let card = card(&con(name), &*corpus())
                .unwrap_or_else(|| panic!("{name} is in the committed catalog and gets a card"));
            assert_eq!(card.name, name);
        }
    }

    /// The residual, pinned so it is a choice rather than a surprise: `Blugurg` is a mob the catalog
    /// does not hold, so it is read as a person and gets nothing. A card that fails to appear costs
    /// a keystroke; a card over another player's head must never happen.
    #[test]
    fn a_proper_named_npc_the_catalog_has_never_heard_of_is_read_as_a_person() {
        assert!(card(&con("Blugurg"), &*corpus()).is_none());
    }

    /// An ordinary mob is never even asked about: the article-plus-noun-phrase shape fails the first
    /// half, so the catalog is not consulted and a creature nobody has scraped still draws.
    #[test]
    fn an_article_named_creature_needs_no_catalog_at_all() {
        assert!(!con_card_is_player("a fire giant warlord", |_| false));
        assert!(!con_card_is_player("A Fire Giant Warlord", |_| false));
        // …and the rule itself, with both halves stated: shape alone is not the answer.
        assert!(con_card_is_player("Lasershark", |_| false));
        assert!(!con_card_is_player("Lasershark", |_| true));
    }

    /// The miss ledger is never touched — the reason `known_mob` exists rather than `mob(…).found`:
    /// the refusal is asked about names that are very often people, and a lookup would announce them
    /// for the app to go and scrape.
    #[test]
    fn refusing_a_players_card_announces_nothing_to_fetch() {
        use fold::knowledge::Knowledge as _;
        let corpus = corpus();
        // Drain whatever an earlier probe in this process left behind — the ledger is per corpus
        // and `shared()` hands out one.
        let _drained = corpus.take_misses();
        assert!(card(&con("Lasershark"), &*corpus).is_none());
        assert!(
            corpus.take_misses().is_empty(),
            "a refusal must never send this process off to scrape a person's name"
        );
    }

    #[test]
    fn a_hostile_name_cannot_push_the_card_off_the_screen() {
        let long = "a ".to_owned() + &"giant ".repeat(400);
        let card = card(&con(&long), &*corpus()).expect("a card");
        assert_eq!(card.name.chars().count(), MAX_NAME_CHARS);
        // …and the whitespace collapse happens before the cap, so a name padded with runs of
        // spaces does not spend its budget on them.
        assert_eq!(capped_name("  a   fire   giant  "), "a fire giant");
    }

    #[test]
    fn the_chips_are_the_five_empty_ones_in_display_order() {
        let chips = chips();
        assert_eq!(
            chips.iter().map(|c| c.axis).collect::<Vec<_>>(),
            [
                ResistAxis::Magic,
                ResistAxis::Fire,
                ResistAxis::Cold,
                ResistAxis::Poison,
                ResistAxis::Disease
            ]
        );
        for chip in &chips {
            // The empty cell, not a fabricated one: no band, no benchmark, no fit, every count a
            // real zero.
            assert!(chip.tag.is_none());
            assert!(chip.benchmark.is_none());
            assert!(chip.fit.is_none());
            assert_eq!(chip.n, 0);
            assert_eq!(chip.n_total, 0);
            assert!(!chip.pinned);
            assert!(!chip.npc_only);
        }
        // …and the flag that tells the card why, which is why five empty chips are not five lies.
        assert!(
            !card(&con("a fire giant warlord"), &*corpus())
                .expect("a card")
                .spell_data
        );
    }
}
