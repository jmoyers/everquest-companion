//! `src/main/modules/observedSpellRanks.ts` — which rank of each spell line this character has
//! actually been observed to hold.
//!
//! Two witnesses, and the asymmetry between them is the design. A MERGE line proves the moment of
//! levelling — the same sentence `itemTiers` reads, whose rank-suffixed half is this module's. A
//! CAST at a rank proves possession: `You begin casting X IV.` and `<mob> resisted your X IV!` are
//! the two families that keep the numeral, and they are the only witness for a rank levelled before
//! the log began.
//!
//! Union, highest wins. `rank` is the max over both; `mergedRank`/`castRank` keep the halves apart,
//! each appearing only once its own witness has spoken. A lower later observation never lowers
//! anything — ranks do not downgrade.
//!
//! The merge lane needs the catalog, the cast lane does not: a merge names an ITEM, and an item
//! ending in a roman numeral need not be a spell, while a cast names a spell by construction. Some
//! castable abilities (`Lay on Hands`) have no wiki page at all.
//!
//! Unsuffixed names are not evidence — rank 1 is the default state, so folding `You begin casting
//! Clarity.` would mint a row for every spell ever cast.
//!
//! The two key folds differ on purpose: the row key is `spellCanonKey` (case-SENSITIVE rank tail)
//! while the catalog probe is `spellDb.byKey`, keyed by the DB's case-INSENSITIVE `canonKey`.
//! `wiring.ts` composes them exactly that way, so the port does too.

use crate::event::Event;
use crate::jsfn::parse_spell_rank;
use crate::jsmap::JsMap;
use crate::EqModule;
use eqlog::names::spell_canon_key;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedSpellRankRow {
    key: String,
    name: String,
    rank: i64,
    merges: i64,
    first_at: i64,
    last_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    merged_rank: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cast_rank: Option<i64>,
}

/// Which witness an observation came from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Witness {
    Merge,
    Cast,
}

pub struct ObservedSpellRanksModule {
    rows: JsMap<ObservedSpellRankRow>,
    seq: i64,
    /// `ObservedSpellRanksDeps.knownSpell`. An empty set is the absent-dependency default: no merge
    /// is admitted, withholding a claim rather than inventing spells out of item names.
    known_spell: HashSet<String>,
    /// The announce cursor — see [`crate::announce`]. Bumped inside `observe`, past its refusals.
    announce: crate::announce::Announce,
}

impl ObservedSpellRanksModule {
    pub fn new(known_spell: HashSet<String>) -> Self {
        ObservedSpellRanksModule {
            rows: JsMap::new(),
            seq: 0,
            known_spell,
            announce: crate::announce::Announce::default(),
        }
    }

    /// Fold one observation of `raw` (a display name that may carry a roman numeral) at `ts`. An
    /// unsuffixed name is not evidence and returns immediately, which is also the cheap exit for
    /// most casts and for every ` +N` item merge.
    fn observe(&mut self, raw: &str, ts: i64, how: Witness) {
        let parsed = parse_spell_rank(raw);
        if !parsed.suffixed || parsed.base.is_empty() {
            return;
        }
        let key = spell_canon_key(raw);
        if key.is_empty() {
            return;
        }
        if how == Witness::Merge && !self.known_spell.contains(&key) {
            return;
        }
        let prev = self.rows.get(&key).cloned();
        // `base` keeps the raw casing and punctuation the log used; the key is the lowercased fold.
        // The first spelling seen wins and is never rewritten — the log outranks the wiki on names.
        let mut next = match prev.clone() {
            Some(p) => ObservedSpellRankRow { last_at: ts, ..p },
            None => ObservedSpellRankRow {
                key: key.clone(),
                name: parsed.base,
                rank: 0,
                merges: 0,
                first_at: ts,
                last_at: ts,
                merged_rank: None,
                cast_rank: None,
            },
        };
        if how == Witness::Merge {
            next.merges += 1;
            next.merged_rank = Some(
                prev.and_then(|p| p.merged_rank)
                    .unwrap_or(0)
                    .max(parsed.rank),
            );
        } else {
            next.cast_rank = Some(prev.and_then(|p| p.cast_rank).unwrap_or(0).max(parsed.rank));
        }
        next.rank = next.rank.max(parsed.rank);
        self.rows.insert(key, next);
        // `last_at` is this sighting's instant, so a row that reaches here is always rewritten.
        self.announce.changed(self.seq);
    }
}

impl EqModule for ObservedSpellRanksModule {
    fn id(&self) -> &'static str {
        "observedSpellRanks"
    }

    fn reset(&mut self) {
        self.rows.clear();
        self.seq = 0;
        self.announce.reset();
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth: every rank before the boundary belongs to the dead beta character.
            "epoch" => {
                self.rows.clear();
                self.announce.changed(self.seq);
            }
            // A ` +N` result is an item level (itemTiers owns it) and carries no numeral, so it
            // falls out of `observe` on the rank test with no second check here.
            "itemMerge" => {
                let item = ev.str("item").unwrap_or_default().to_string();
                self.observe(&item, ev.ts(), Witness::Merge);
            }
            "castBegin" => {
                let spell = ev.str("spell").unwrap_or_default().to_string();
                self.observe(&spell, ev.ts(), Witness::Cast);
            }
            // `<target> resisted your <Spell> <rank>!` — your cast, named with its numeral. The
            // other two resist shapes are somebody else's spell and say nothing about what you own.
            "resist" if !ev.bool("incoming") && ev.str("caster") == Some("you") => {
                let spell = ev.str("spell").unwrap_or_default().to_string();
                self.observe(&spell, ev.ts(), Witness::Cast);
            }
            _ => {}
        }
    }

    /// Moves on a rank sighting that reached the map. See the `announce` field.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.rows })
    }
}
