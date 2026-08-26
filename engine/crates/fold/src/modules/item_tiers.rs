//! `src/main/modules/itemTiers.ts` — the per-item OBSERVED item level for the items the CURRENT
//! character has actually upgraded (Task #60).
//!
//! WHAT COUNTS AS EVIDENCE (law 1: messages over inference; unknown is never zero) — only MERGE
//! evidence, three shapes: an `itemMerge`; a loot with disposition `'combined'` (its `created` name
//! is the result); and an `itemMergeFailed` of reason `'mismatch'`, whose line quotes YOUR item's
//! name verbatim, tier suffix and all. Ordinary loot of a ` +N` drop is deliberately NOT evidence —
//! an unmerged drop is routinely auto-sold or destroyed on pickup.
//!
//! A DESTROY RETIRES NOTHING HERE (JOS-401): `tier` is the HIGHEST tier ever OBSERVED for a base
//! name, a fact about a merge that happened, never a claim about what is in your bags today.
//!
//! ABSENT MEANS UNKNOWN, NEVER TIER 0. A `'held'` first sighting with no tier creates no row at
//! all, and a row with no tier omits both `tier` and `lastTier` rather than writing zero.

use crate::event::Event;
use crate::jsfn::{item_base_name, item_tier_from_name, item_tier_key};
use crate::jsmap::JsMap;
use crate::EqModule;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemTierRow {
    key: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tier: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_tier: Option<i64>,
    merges: i64,
    first_at: i64,
    last_at: i64,
}

/// Whether an upgrade happened (`Merge`) or a line merely quoted an item we are holding (`Held`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum How {
    Merge,
    Held,
}

#[derive(Default)]
pub struct ItemTiersModule {
    rows: JsMap<ItemTierRow>,
    seq: i64,
}

impl ItemTiersModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one observation of `raw` (a display name that may carry ` +N`) at `ts`. A tier-less
    /// name advances nothing but the merge count.
    fn observe(&mut self, raw: &str, ts: i64, how: How) {
        let name = item_base_name(raw);
        if name.is_empty() {
            return;
        }
        let key = item_tier_key(raw);
        let tier = item_tier_from_name(raw);
        let Some(prev) = self.rows.get(&key).cloned() else {
            // A 'held' first sighting with no tier tells us nothing at all — skip it rather than
            // create an empty row (absent = unknown).
            if how == How::Held && tier.is_none() {
                return;
            }
            self.rows.insert(
                key.clone(),
                ItemTierRow {
                    key,
                    name,
                    tier,
                    last_tier: tier,
                    merges: i64::from(how == How::Merge),
                    first_at: ts,
                    last_at: ts,
                },
            );
            return;
        };
        let prev_tier = prev.tier;
        let prev_merges = prev.merges;
        let mut next = ItemTierRow {
            name,
            last_at: ts,
            merges: if how == How::Merge {
                prev_merges + 1
            } else {
                prev_merges
            },
            ..prev
        };
        if let Some(t) = tier {
            // THE HIGHEST EVER OBSERVED, not the latest: the owner levels several copies of the
            // same item in parallel, so "latest" would report +3 for a bag holding a +4.
            next.tier = Some(match prev_tier {
                None => t,
                Some(p) => p.max(t),
            });
            next.last_tier = Some(t);
        }
        self.rows.insert(key, next);
    }
}

impl EqModule for ItemTiersModule {
    fn id(&self) -> &'static str {
        "itemTiers"
    }

    fn reset(&mut self) {
        self.rows.clear();
        self.seq = 0;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth (Task #49): every merge before the boundary was performed by a
            // dead same-name character, and their upgrades are not in this character's bags.
            "epoch" => self.rows.clear(),
            // Tier-less results are SPELL-SCROLL merges (Roman rank), observedSpellRanks' half of
            // the same sentence. Still a merge we observed — recorded as one, with no tier.
            "itemMerge" => {
                let item = ev.str("item").unwrap_or_default().to_string();
                self.observe(&item, ev.ts(), How::Merge);
            }
            // Only the 'mismatch' shape names items; it is an inventory statement, not an upgrade,
            // so it never counts as a merge — it can only reveal a tier we hadn't seen.
            "itemMergeFailed" => {
                if ev.str("reason") == Some("mismatch") {
                    if let Some(target) = ev.str("target").map(str::to_string) {
                        // `ev.target &&` — an empty string is falsy over there.
                        if !target.is_empty() {
                            self.observe(&target, ev.ts(), How::Held);
                        }
                    }
                }
            }
            // `ev.disposition === 'combined' && ev.created` — the auto-merge-on-pickup line, whose
            // `created` name is the result, same as an `itemMerge`.
            "loot" if ev.str("disposition") == Some("combined") => {
                if let Some(created) = ev.str("created").map(str::to_string) {
                    if !created.is_empty() {
                        self.observe(&created, ev.ts(), How::Merge);
                    }
                }
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
