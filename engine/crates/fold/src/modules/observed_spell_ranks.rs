//! `src/main/modules/observedSpellRanks.ts` — which rank of each spell line this character has
//! actually been observed to hold (JOS-446).
//!
//! TWO WITNESSES, AND THE ASYMMETRY BETWEEN THEM IS THE DESIGN.
//!   1. THE MERGE LINE proves the MOMENT OF LEVELLING — the same sentence `itemTiers` reads, whose
//!      rank-suffixed half carries no ` +N` and is this module's.
//!   2. A CAST AT A RANK proves POSSESSION — `You begin casting X IV.` and `<mob> resisted your
//!      X IV!` are the two families that keep the numeral. They are undated as acquisitions and
//!      are the ONLY witness for a rank levelled before the log began.
//!
//! UNION, HIGHEST WINS. `rank` is the max over both; `mergedRank`/`castRank` keep the halves apart
//! and each appears only once its own witness has spoken. A LOWER later observation never lowers
//! anything — ranks do not downgrade (the owner's ruling, AGENTS.md).
//!
//! THE MERGE LANE NEEDS THE CATALOG; THE CAST LANE DOES NOT. A merge names an ITEM, and an item
//! whose name ends in a roman numeral is not a spell, so a merge is admitted only when its base
//! joins the catalog. A cast names a spell BY CONSTRUCTION — the measured case is `Lay on Hands`,
//! which the wiki scrape carries no page for and which the owner casts at rank IX.
//!
//! UNSUFFIXED NAMES ARE NOT EVIDENCE. Rank 1 is the default state, not an observation, so folding
//! `You begin casting Clarity.` would mint a row for every spell ever cast.
//!
//! THE TWO KEY FOLDS ARE DIFFERENT ON PURPOSE. The row key is `spellCanonKey` (case-SENSITIVE rank
//! tail, `parseCommon.ts`); the catalog probe is `spellDb.byKey`, which is keyed by the DB's own
//! case-INSENSITIVE `canonKey`. `wiring.ts` composes them exactly this way — `knownSpell: (key) =>
//! spellDb.byKey.has(key)` over a `spellCanonKey` — so the port does too, rather than "tidying"
//! the two folds into one.

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
    /// `ObservedSpellRanksDeps.knownSpell`. An EMPTY set is the TS's absent-dependency default:
    /// no merge is ever admitted, which withholds a claim rather than inventing spells out of
    /// item names.
    known_spell: HashSet<String>,
}

impl ObservedSpellRanksModule {
    pub fn new(known_spell: HashSet<String>) -> Self {
        ObservedSpellRanksModule {
            rows: JsMap::new(),
            seq: 0,
            known_spell,
        }
    }

    /// Fold one observation of `raw` (a display name that may carry a roman numeral) at `ts`.
    ///
    /// An UNSUFFIXED name is not evidence and returns immediately, so this is also the cheap exit
    /// for the overwhelming majority of casts and for every ` +N` item merge.
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
        // `base` keeps the raw casing and punctuation the LOG used while the key is the lowercased
        // fold. The FIRST spelling seen wins and is never rewritten: the log outranks the wiki on
        // names (the JOS-440 ruling), so a later sighting has nothing to improve.
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
    }
}

impl EqModule for ObservedSpellRanksModule {
    fn id(&self) -> &'static str {
        "observedSpellRanks"
    }

    fn reset(&mut self) {
        self.rows.clear();
        self.seq = 0;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth: every rank before the boundary belongs to the dead beta character.
            "epoch" => self.rows.clear(),
            // A ` +N` result is an item level (itemTiers owns it) and carries no numeral, so it
            // falls out of `observe` on the rank test without needing a second check here.
            "itemMerge" => {
                let item = ev.str("item").unwrap_or_default().to_string();
                self.observe(&item, ev.ts(), Witness::Merge);
            }
            "castBegin" => {
                let spell = ev.str("spell").unwrap_or_default().to_string();
                self.observe(&spell, ev.ts(), Witness::Cast);
            }
            // `<target> resisted your <Spell> <rank>!` — YOUR cast, named with its numeral. The
            // other two resist shapes are somebody else's spell, and a stranger casting rank VI
            // says nothing about what you own.
            "resist" if !ev.bool("incoming") && ev.str("caster") == Some("you") => {
                let spell = ev.str("spell").unwrap_or_default().to_string();
                self.observe(&spell, ev.ts(), Witness::Cast);
            }
            _ => {}
        }
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.rows })
    }
}
