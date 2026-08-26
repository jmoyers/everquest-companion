//! `src/main/modules/buffsMining.ts` — WHICH LOG LINES ARE OFFERED TO THE MESSAGE-OVERLAY MINER,
//! and the cache that stops the served overlay from being rebuilt on every snapshot.
//!
//! IT MINES THE SAME WAY IN REPLAY AND LIVE, which is what makes the overlay a FOLD rather than a
//! session artifact — and therefore what makes it reproducible here at all.
//!
//! THE DIRTY-CACHE IS DELIBERATELY ABSENT, and it is a scope statement rather than an omission. Over
//! there `build()` is memoized behind a `dirty` flag because the LIVE app asks for a snapshot
//! repeatedly and the aggregate is a walk over every bucket and every message. A `Fold` takes
//! exactly one snapshot, at the end, so the cache would save nothing and would cost this file the
//! interior mutability that `EqModule::snapshot(&self)` otherwise never needs. A cached answer and a
//! rebuilt one are the same value by construction — the flag is set by an OBSERVATION and by nothing
//! else — so dropping it changes no output. Phase 3's live tail is where it comes back.

use crate::event::Event;
use crate::message_overlay::{message_text_of, MessageOverlayMiner, SeedMessage};
use crate::spell_facts::{looks_landing_message, SpellFacts};
use serde_json::Value;

pub struct OverlayMining {
    miner: MessageOverlayMiner,
}

impl OverlayMining {
    /// Seeded warm with the committed baseline, so a fresh install benefits from the shipped
    /// counts. EACH SEED CARRIES ITS SOURCE KEY (JOS-231): the bucket a log is filed under is what
    /// lets `begin_source` replace it when that log is folded again, instead of the fold
    /// accumulating on top of its own previous output.
    pub fn new(facts: SpellFacts, seeds: &[(&str, Vec<SeedMessage>)]) -> Self {
        let mut miner = MessageOverlayMiner::new(facts);
        for (key, counts) in seeds {
            miner.merge(counts, key);
        }
        OverlayMining { miner }
    }

    /// A log is about to be folded from its first byte — file what it teaches under `key` and drop
    /// whatever that key held.
    pub fn begin_source(&mut self, key: &str) {
        self.miner.begin_source(key);
    }

    /// Offer one event to the miner. A `castBegin` is the association ANCHOR; the message-bearing
    /// events (buffApply / spellEmote = landing, buffWearOff / illusionFade / buffFade = wears-off)
    /// are candidate messages associated to the nearest anchor within the window.
    pub fn observe(&mut self, ev: &Event) {
        match ev.kind() {
            "castBegin" => {
                let spell = ev.str("spell").unwrap_or_default().to_string();
                self.miner.observe_cast(&spell, ev.ts());
            }
            "buffApply" | "spellEmote" => self.note(ev, "landing"),
            "buffWearOff" | "illusionFade" | "buffFade" => self.note(ev, "wearsOff"),
            // The AA potion quaff is a LANDING message the leveling analytics now claim as their own
            // kind. It fell through here as `unknown` before that rule existed and the overlay
            // learned it as a verified Bottle of Alternate Adventure landing (it is absent from
            // spells.json, so the DB table never had it) — so it keeps the same miner path, and the
            // learned overlay is byte-identical to what it was.
            "aaPotion" | "unknown" => {
                // A line the parser classified as NOTHING but that could be an un-catalogued landing
                // message — Symbol of Pinzarn's real "The symbol of Pinzarn flashes before your
                // eyes.", whose wiki `msg_cast_on_you` is WRONG, so the DB table never matched it.
                // Only flavor-SHAPED lines are fed; the unambiguous-anchor and count rules in the
                // miner discard coincidental pairings, so a wrong candidate never verifies.
                let t = message_text_of(ev.raw()).to_string();
                if looks_landing_message(&t) {
                    self.miner.observe_message(&t, ev.ts(), "landing");
                }
            }
            _ => {}
        }
    }

    fn note(&mut self, ev: &Event, role: &'static str) {
        let text = message_text_of(ev.raw()).to_string();
        self.miner.observe_message(&text, ev.ts(), role);
    }

    /// SEED ONE PERSISTED BUCKET (JOS-496 item 3) — `overlayPersistence.loadUserSources()`'s
    /// output, one source at a time, through the same `merge` the committed baseline arrives by.
    ///
    /// SEPARATE FROM `new` ON PURPOSE. The baseline is a fact about COMMITTED DATA and is compiled
    /// in; the user register is a file, and a construction that could reach one would be a
    /// construction the six-slice oracle could not reproduce. So the constructor keeps the seed it
    /// has always had and this is the extra act, made by the one caller that has been handed a
    /// state directory.
    pub fn seed(&mut self, key: &str, counts: &[SeedMessage]) {
        self.miner.merge(counts, key);
    }

    /// The persistence view — every bucket's raw counts, filed under the source that produced them.
    pub fn register(&self) -> crate::message_overlay::OverlayRegister {
        self.miner.register()
    }

    /// The served overlay.
    pub fn build(&self) -> Value {
        self.miner.build()
    }
}
