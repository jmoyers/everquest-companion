//! ============================================================================
//! `world.conCard` — THE CON CARD, RESOLVED SERVER-SIDE (JOS-487, boundary verdict 2).
//! ============================================================================
//!
//! The census found the fold calling SYNCHRONOUSLY INTO ELECTRON: `considerModule.setConCardHook`
//! is installed by `pipeline.ts`, and every live `/con` runs `main/conCard.ts noteConsider` inside
//! the fold's own delivery — a knowledge lookup, a resist profile and an overlay send, on the
//! thread that is parsing the log. Verdict 2 inverts it: the engine emits a FULLY RESOLVED card and
//! main only opens the window.
//!
//! This file is the resolution. It takes the four facts the module saw (`fold::…::ConEvent`) and
//! produces the card `shared/conCard.ts ConCardPayload` describes, field for field.
//!
//! ── WHAT IS RESOLVED HERE, AND WHAT IS HONESTLY NOT ────────────────────────────────────────────
//!
//! **The header is whole**: the queue identity (`mobKey`), the display name (whitespace-collapsed
//! and capped — a rendering guarantee, not taste), the level the con line stated, the zone, the
//! rare infix, and the instant on the log's own clock.
//!
//! **The resist chips are the EMPTY five, and `spellData` is false.** That is not a stub and it is
//! not a placeholder: it is the branch `mobResistProfile` itself takes app-side when the client's
//! `spells_us.txt` has not been read —
//!
//! ```text
//! const axes = spells ? RESIST_AXES.map(axis => axisRow(...)) : RESIST_AXES.map(axis => ({ … n: 0 }))
//! return { …, spellDataAvailable: spells !== null }
//! ```
//!
//! — five empty axes and the flag down, which is exactly what the card draws today on the first
//! `/con` of a session before the table has finished loading. The engine cannot take the other
//! branch yet, and the reason is a NAMED GAP rather than an oversight: the client spell table's
//! parse is **boundary verdict 7** and the cutover ledger's item 6, still open, and without it
//! there is no axis for a spell, no resist adjust, and therefore no estimate to fit. Everything
//! downstream of it — the posterior, the interval, the benchmark, the band — is a second body of
//! work (`shared/resistModel.ts`, `resistFit.ts`, `resistFormula.ts`) that has not moved either.
//!
//! **So the con-card CUTOVER is blocked on the spell table, and this frame is not.** The shape is
//! final, the header is real, and the day the table lands engine-side the chips fill in with no
//! protocol change — which is the whole reason the chip type is on the wire in full rather than
//! left open.
//!
//! ── WHAT MOVED IN JOS-496, AND THE RULING THAT SHAPES WHAT IS LEFT ─────────────────────────────
//!
//! THE OVERLAY NOW OPENS ON THIS FRAME. The sentence above used to end "nothing in this ticket moves
//! the overlay"; JOS-496 moved it. Under serve the app does not install its own con-card hook at all
//! — so the census finding verdict 2 names (the fold calling synchronously into Electron, on the
//! thread parsing the log) is ended — and `main/dataServer/conCardServe.ts` opens the window on what
//! this file resolves.
//!
//! THE CHIPS ARE STILL NOT OURS, and the app joins its own rather than carrying these five across.
//! That is not the app ignoring the engine: five empty chips reaching a real overlay would make
//! every card under serve read "nothing seen yet" forever, while the app holds a ledger that can
//! answer. `main/conCard.ts noteEngineConCard` states the trade at the join and loses the join
//! rather than growing one when the chips become real here.
//!
//! AND THE ROUTE TO THAT DAY IS RULED (integrator, 2026-08-25). The tempting reading of verdict 8 —
//! the engine parses the table and SERVES it to the app, whose worker retires — is closed. MEASURED:
//! the owner's own parsed table is 48,252 entries and 6.13 MiB of JSON, against an 8 MiB frame
//! ceiling, on one machine, against a table that grows with every client patch. A single reply at
//! 77% of a hard limit is a design with a date on it. So: **this process parses `spells_us.txt`
//! INTERNALLY, for its own joins — these chips first — and app consumers move to per-spell
//! `knowledge.spell` queries. No bulk frame, ever.** The path derives from the attach log's install
//! directory (`…/Logs/..`), so nothing on the wire has to change for it.
//!
//! ── TWO OF THE APP'S THREE REFUSALS STAY WHERE THEY ARE, AND BOTH ABSENCES ARE ARGUED ──────────
//!
//! `main/conCard.ts` refuses a card in three cases. The third — **never for a historical line** —
//! is enforced structurally one layer down (`ConsiderModule::on_event` only pushes when `live`), so
//! a startup replay of a month of logs emits nothing.
//!
//! The **re-open suppression** ("never twice inside a minute of a CLOSE") is not here and should not
//! be. It is a fact about the PERSON, measured on the wall clock they live on — the app's own note
//! says so at length, because EQ stamps to the second and a log-clock comparison put the card
//! straight back up in the e2e — and its only input is a window event (`con:card-closed`) that
//! never reaches the fold. It stays with the window that owns it.
//!
//! The **player refusal** (`conCardIsPlayer`) is the one worth reading twice, and SINCE JOS-492 IT
//! IS HERE. It is `isPlayerShapedName(name) && !knownMob(name)`: EQ gives players one capitalized
//! word with no space and gives mobs an article plus a noun phrase, and the committed mob catalog
//! is what rescues the proper-named NPCs that shape would otherwise condemn — Innoruuk, Blugurg,
//! Sheldon. JOS-487 had the first half and not the second and therefore applied NEITHER, because
//! the name-shape test alone would have refused a card for every proper-named NPC the app draws one
//! for today — a regression wearing a port's clothes.
//!
//! The second half is the KNOWLEDGE surface, and it landed (JOS-486): the corpus is in this
//! process, shared by the ingest thread and every connection thread, and it answers
//! [`fold::knowledge::Knowledge::known_mob`] straight off the committed index. So [`card`] takes it
//! and refuses, and the two sides now make the same decision from the same two facts.
//!
//! IT ASKS `known_mob` AND NOT `mob`, and that distinction is the whole reason the method exists.
//! `mob()` is a LOOKUP: a name it cannot answer is written to the miss ledger and announced, so the
//! app goes and fetches a wiki page for it. This question is asked about every proper-named thing
//! the player cons — and the entire point of asking is that some of those are PEOPLE. Routing it
//! through `mob()` would have this process announce another player's character name as something to
//! scrape. `known_mob` reads the catalog, announces nothing, and builds no record.
//!
//! THE RESIDUAL IS THE APP'S OWN, restated rather than newly incurred: a proper-named NPC the
//! catalog has never heard of gets no card. It is the safe direction — a card that fails to appear
//! costs a keystroke, and a card over another player's head is the thing the owner asked never to
//! happen. The app's `looksLikePlayer` gate still stands in front of the overlay window and now
//! refuses exactly the same names this does, which is a DOUBLE gate rather than a divergence:
//! neither side can admit what the other refuses.

use protocol::generated::{
    ConCardChip, ConCardMessage, ConCardMessageKind, ResistAxis, ResistEmpirical,
};

use fold::knowledge::Knowledge;
use fold::modules::consider::{mob_key, ConEvent};
use fold::modules::resist::world::is_player_shaped_name;

/// How long a mob name this engine will put on a card.
///
/// `shared/conCard.ts MAX_NAME_CHARS`. A rendering guarantee rather than taste: a 40 kB mob name
/// cannot push a card off the screen. CHARACTERS, not bytes — `slice` over there counts UTF-16 code
/// units and this counts scalar values, which agree for every name EQ prints and would differ only
/// for astral characters the game has none of.
const MAX_NAME_CHARS: usize = 96;

/// THE FIVE AXES, in display order. `shared/resistTypes.ts RESIST_AXES`, and the order is part of
/// the contract: every surface shows all five in this order, because "we have not seen fire cast on
/// this" and "fire is fine" are different statements and a missing chip says neither.
const AXES: [ResistAxis; 5] = [
    ResistAxis::Magic,
    ResistAxis::Fire,
    ResistAxis::Cold,
    ResistAxis::Poison,
    ResistAxis::Disease,
];

/// `cappedName` — whitespace-collapsed, trimmed, capped.
#[must_use]
pub fn capped_name(name: &str) -> String {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_NAME_CHARS).collect()
}

/// The empty chip for one axis — `shared/conCard.ts blankChip`, verbatim.
///
/// EVERY NUMBER IS A REAL ZERO and the three optional members are absent: nothing has been observed
/// on this axis, so there is no band, no benchmark and no fit. A chip that carried a tag off zero
/// observations would be the model inventing an answer.
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

/// The five chips this engine can honestly state. See the module header for why they are the empty
/// ones and for what has to land before they are not.
#[must_use]
pub fn chips() -> Vec<ConCardChip> {
    AXES.into_iter().map(blank_chip).collect()
}

/// IS THE THING THE PLAYER JUST CONNED A PERSON? — `shared/conCard.ts conCardIsPlayer`, verbatim.
///
/// Written with the `known_mob` half handed in exactly as the TypeScript hands it in, so the rule
/// can be driven from a test without a corpus and so the one line that knows WHERE the catalog
/// lives stays at the call site. `is_player_shaped_name` is the fold's existing port of
/// `shared/playerShape.ts` (`modules::resist::world`) rather than a second spelling of the two
/// regexes — the README's rule, and the two questions are the same question.
#[must_use]
pub fn con_card_is_player(name: &str, known_mob: impl Fn(&str) -> bool) -> bool {
    is_player_shaped_name(name) && !known_mob(name)
}

/// Build the card one live `/con` deserves, or `None` when the line names nothing — or names
/// somebody.
///
/// TWO REFUSALS, and they are `noteConsider`'s first two in its own order:
///
///   * AN EMPTY MOB KEY (`if (!key) return false`): a con line whose creature name folds to nothing
///     has no queue identity, so there is no card to refresh and no card to open.
///   * A PERSON (owner scope: never a card over another player). See [`con_card_is_player`] and the
///     module header for which half of it moved and why the other one waited for the corpus.
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
        // ABSENT RATHER THAN FALSE, which is the app payload's own shape: `if (ev.rare)
        // payload.rare = true`, and `JSON.stringify` drops the key otherwise.
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

    /// THE REAL COMMITTED CORPUS, not a double. Every claim below about which names the catalog
    /// rescues is a claim about the bytes this repo ships — the same bar `knowledge`'s own suite
    /// holds itself to, and the only bar under which "Blugurg is a mob" means anything.
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
        // THE THREE FOLDS `mobKey` MAKES, each of which is what stops one creature becoming two
        // cards: the quote fold, the copy-number strip, and the case fold.
        let a = card(&con("Innoruuk`s Chosen"), &*corpus()).expect("a card");
        let b = card(&con("innoruuk's chosen (2)"), &*corpus()).expect("a card");
        assert_eq!(a.id, b.id);
        // …and the DISPLAY name is untouched by any of it.
        assert_eq!(a.name, "Innoruuk`s Chosen");
    }

    #[test]
    fn a_line_that_names_nothing_gets_no_card() {
        assert!(card(&con(""), &*corpus()).is_none());
        assert!(card(&con("   "), &*corpus()).is_none());
    }

    // ── the player refusal (JOS-492) ──────────────────────────────────────────────────────────

    /// THE OWNER'S SCOPE: never a card over another player's head. A player-shaped name the
    /// catalog has never heard of is a person, and gets nothing.
    #[test]
    fn a_player_shaped_name_the_catalog_does_not_know_gets_no_card() {
        // The measured pair from the committed fixtures: `Lasershark regards you indifferently`
        // is a PLAYER and the con ladder cannot tell — a faction rung is about standing, not
        // species, so nothing on the line answers this.
        assert!(card(&con("Lasershark"), &*corpus()).is_none());
        assert!(card(&con("Primitive"), &*corpus()).is_none());
    }

    /// …AND A PROPER-NAMED NPC THE CATALOG KNOWS STILL GETS ONE. This is the half JOS-487 had to
    /// wait for, and it is the whole reason the shape test could not ship alone: 954 of the
    /// committed catalog's rows carry a name `isPlayerShapedName` would condemn (MEASURED against
    /// the shipped `mobs.json`, JOS-492), and every one of them draws a card today.
    ///
    /// A NOTE ON THE APP'S OWN EXAMPLE LIST, because a reader will find the difference. The
    /// docstring on `conCardIsPlayer` names `Innoruuk`, `Blugurg` and `Sheldon` as the NPCs the
    /// catalog rescues. `Innoruuk` is a catalog row and is rescued. `Blugurg` IS NOT IN THE CATALOG
    /// AT ALL — the string does not appear in `mobs.json` — so the app refuses its card too, and
    /// has always refused it. That is not a bug on either side: it is exactly the residual both
    /// files state ("a proper-named NPC the catalog has never heard of gets no card"), with one of
    /// the prose examples having drifted from the data. This test is written against names that
    /// were checked rather than against the sentence.
    #[test]
    fn a_proper_named_npc_the_catalog_knows_still_gets_a_card() {
        for name in ["Innoruuk", "Aaryonar", "Abigail"] {
            let card = card(&con(name), &*corpus())
                .unwrap_or_else(|| panic!("{name} is in the committed catalog and gets a card"));
            assert_eq!(card.name, name);
        }
    }

    /// …AND THE RESIDUAL, PINNED SO IT IS A CHOICE RATHER THAN A SURPRISE. `Blugurg` is a mob and
    /// the catalog does not hold it, so it is read as a person and gets nothing. The direction is
    /// the owner's: a card that fails to appear costs a keystroke, and a card over another
    /// player's head is the thing that must never happen.
    #[test]
    fn a_proper_named_npc_the_catalog_has_never_heard_of_is_read_as_a_person() {
        assert!(card(&con("Blugurg"), &*corpus()).is_none());
    }

    /// AN ORDINARY MOB IS NEVER EVEN ASKED ABOUT — the article-plus-noun-phrase shape fails the
    /// first half, so the catalog is not consulted and a creature nobody has scraped still draws.
    #[test]
    fn an_article_named_creature_needs_no_catalog_at_all() {
        assert!(!con_card_is_player("a fire giant warlord", |_| false));
        assert!(!con_card_is_player("A Fire Giant Warlord", |_| false));
        // …and the rule itself, with both halves stated: shape alone is not the answer.
        assert!(con_card_is_player("Lasershark", |_| false));
        assert!(!con_card_is_player("Lasershark", |_| true));
    }

    /// THE MISS LEDGER IS NEVER TOUCHED. This is the reason `known_mob` exists rather than
    /// `mob(…).found`: the refusal is asked about names that are very often PEOPLE, and a lookup
    /// would announce them for the app to go and scrape.
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
        // …and the whitespace collapse happens BEFORE the cap, so a name padded with runs of
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
            // THE EMPTY CELL, not a fabricated one: no band, no benchmark, no fit, and every count
            // a real zero. See the module header for what has to land before this changes.
            assert!(chip.tag.is_none());
            assert!(chip.benchmark.is_none());
            assert!(chip.fit.is_none());
            assert_eq!(chip.n, 0);
            assert_eq!(chip.n_total, 0);
            assert!(!chip.pinned);
            assert!(!chip.npc_only);
        }
        // …and the flag that tells the card WHY, which is the whole reason five empty chips are not
        // five lies.
        assert!(
            !card(&con("a fire giant warlord"), &*corpus())
                .expect("a card")
                .spell_data
        );
    }
}
