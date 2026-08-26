//! `main/itemLookup.ts` — "what's this lore/quest item for", minus the network.
//!
//! ── THE THREE SOURCES, AND WHICH ONE IS PRIMARY ────────────────────────────────────────────────
//!
//! 0. THE COMMITTED ITEM DATABASE IS PRIMARY (`src/main/data/items.json`, 11,288 pages, 8.75 MB).
//!    A DB hit short-circuits everything after it — no overlay read, no miss, no announcement.
//! 1. LOCAL-FIRST CROSS-REFS, merged into whatever answers: the scraped Plane of Sky dataset
//!    (posky.json), which carries per-item island/giver detail no item page states, and the scraped
//!    wiki QUEST CATALOG (quests.json), which is built from the quest pages rather than the item
//!    pages and is therefore the answer for every classic turn-in item whose own page never listed a
//!    quest.
//! 2. THE RUNTIME OVERLAY takes the place of the userData cache AND the wiki fallback: a name the
//!    corpus lacks is a MISS, the app fetches it (boundary verdict 5 — the wiki fetch stays app-side
//!    in v1 and the engine ships without a network stack), and `knowledge.define` pushes the answer
//!    back here. See `lib.rs`.
//!
//! ── THE JSON IS READ, NOT COPIED, AND IT IS READ ONCE ──────────────────────────────────────────
//!
//! `include_str!` straight out of `src/main/data/`, exactly as `eqlog` reads `spells.json` and
//! `fold` reads `mobs.json` — one copy of each file in the tree, so a re-scrape reaches every reader
//! at once. The parse is behind a `OnceLock` for the same reason the three TypeScript indexes are
//! built on first use (JOS-371, measured there at 41.8 ms of parse for a graph nothing had asked
//! anything of yet): an attach must not pay for a corpus no client has queried.
//!
//! ── THE RECORD IS THE `ItemKnowledge` FIELDS AND IS NOT RE-TYPED ───────────────────────────────
//!
//! `itemsDb.ts` says it in as many words: "A record is *literally* the `ItemKnowledge` fields
//! `parseItemWikitext` produces — no projection, no renaming, so the lookup path needs no
//! translation layer." Mirroring twenty-odd fields (including a nested stat block, recipe lists and
//! craft trees) into Rust structs would be a translation layer whose only job is to lose a field
//! the day the scraper grows one. The entry is carried as `serde_json::Value` and the only thing
//! this file does to it is `knowledgeFromDb`'s defaults — which is the one place the compact form
//! is expanded over there too.

use serde_json::{json, Map, Value};

use crate::names::{item_key, normalize_item_name, quest_item_key};

/// The COMMITTED wiki item database — the PRIMARY source.
const ITEMS_JSON: &str = include_str!("../../../../src/main/data/items.json");
/// The scraped Plane of Sky dataset — LOCAL 1 for an item's quest uses.
const POSKY_JSON: &str = include_str!("../../../../src/renderer/src/data/eqlegends/posky.json");
/// The scraped wiki quest catalog — LOCAL 2, and the item→quest index below is built from it.
const QUESTS_JSON: &str = include_str!("../../../../src/renderer/src/data/eqlegends/quests.json");

/// How many reward names a `required` use carries — `MAX_ATTACHED_REWARDS`.
const MAX_ATTACHED_REWARDS: usize = 4;

/// The committed corpus, keyed by [`item_key`] — the file's `items` map is ALREADY that index
/// (`itemsDb.ts` writes those keys), so there is nothing to build.
pub type ItemDb = Map<String, Value>;

/// Parse `items.json` and hand back its `items` map.
#[must_use]
pub fn load_item_db() -> ItemDb {
    let file: Value = serde_json::from_str(ITEMS_JSON).expect("items.json is not readable");
    match file {
        Value::Object(mut o) => match o.remove("items") {
            Some(Value::Object(items)) => items,
            _ => Map::new(),
        },
        _ => Map::new(),
    }
}

/// item key → the quests that use it, from BOTH local catalogs, in the order `localKnowledge`
/// consults them: posky FIRST (it carries the island/giver detail), then the quest catalog, deduped
/// by quest identity.
pub type QuestUseIndex = std::collections::HashMap<String, Vec<Value>>;

/// `poskyByItem()` — index the Plane of Sky dataset by item key → the quests that require it.
#[must_use]
fn posky_by_item() -> QuestUseIndex {
    let file: Value = serde_json::from_str(POSKY_JSON).expect("posky.json is not readable");
    let mut built: QuestUseIndex = QuestUseIndex::new();
    for q in file["quests"].as_array().unwrap_or(&Vec::new()) {
        let class_name = q["className"].as_str().unwrap_or_default();
        let name = q["name"].as_str().unwrap_or_default();
        // De-dupe by quest IDENTITY (className + name) — the same item appears under many quests.
        let quest = format!("{class_name} · {name}");
        for it in q["items"].as_array().unwrap_or(&Vec::new()) {
            let Some(item) = it["name"].as_str() else {
                continue;
            };
            let uses = built.entry(item_key(item)).or_default();
            if uses.iter().any(|u| u["quest"] == quest.as_str()) {
                continue;
            }
            let mut use_row = json!({ "quest": quest, "page": q["source"], "source": "posky" });
            if let Some(giver) = q["giver"].as_str() {
                use_row["giver"] = json!(giver);
            }
            uses.push(use_row);
        }
    }
    built
}

/// `questItemIndex.ts buildQuestItemIndex` — the quest catalog, indexed item-first, from BOTH sides
/// of a quest: its turn-in/collectible items (`required`) and the items it hands out (`reward`).
///
/// A `required` use also carries the quest's REWARD names, which closes the one-hop gap the card
/// needs — "you looted a Guard Bracelet; it's a turn-in for Corrupt Guards, which pays a Bunker
/// Battle Blade" — without a second lookup. Only a TURN-IN has an outcome to name: a reward-role use
/// IS the outcome, and listing the quest's rewards there would repeat the item back to itself.
#[must_use]
fn quests_by_item(quests: &[Value]) -> QuestUseIndex {
    let mut by_item: QuestUseIndex = QuestUseIndex::new();
    for q in quests {
        let empty = Vec::new();
        let rewards = q["rewards"].as_array().unwrap_or(&empty);
        // Computed once per quest, not per item: every required item of a quest shares its outcome.
        // Blank names are dropped rather than rendered as empty chips.
        let reward_names: Vec<&str> = rewards
            .iter()
            .filter_map(|r| r["name"].as_str())
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .take(MAX_ATTACHED_REWARDS)
            .collect();
        let add = |item: &str, role: &str, by_item: &mut QuestUseIndex| {
            let uses = by_item.entry(quest_item_key(item)).or_default();
            if uses
                .iter()
                .any(|u| u["page"] == q["page"] && u["role"] == role)
            {
                return;
            }
            let mut use_row =
                json!({ "quest": q["name"], "page": q["page"], "source": "quests", "role": role });
            if let Some(giver) = q["giver"].as_str() {
                use_row["giver"] = json!(giver);
            }
            if let Some(zone) = q["startZone"].as_str() {
                use_row["zone"] = json!(zone);
            }
            if role == "required" && !reward_names.is_empty() {
                use_row["rewards"] = json!(reward_names);
            }
            uses.push(use_row);
        };
        for it in q["requiredItems"].as_array().unwrap_or(&empty) {
            if let Some(name) = it.as_str() {
                add(name, "required", &mut by_item);
            }
        }
        for r in rewards {
            if let Some(name) = r["name"].as_str() {
                add(name, "reward", &mut by_item);
            }
        }
    }
    by_item
}

/// The scraped quest catalog's `quests` array. Read once and handed to both index builders — the
/// mob side (`relatedNpcs`) and the item side — because it is one 596 KB parse.
#[must_use]
pub fn load_quests() -> Vec<Value> {
    let file: Value = serde_json::from_str(QUESTS_JSON).expect("quests.json is not readable");
    file["quests"].as_array().cloned().unwrap_or_default()
}

/// Both local item→quest indexes, built once.
pub struct LocalQuests {
    posky: QuestUseIndex,
    quests: QuestUseIndex,
}

impl LocalQuests {
    #[must_use]
    pub fn build(quests: &[Value]) -> Self {
        Self {
            posky: posky_by_item(),
            quests: quests_by_item(quests),
        }
    }

    /// `localKnowledge(name)` — the Plane of Sky dataset FIRST, then the wiki quest catalog, deduped
    /// by quest identity. Empty when neither local source knows this item (never an empty claim).
    #[must_use]
    pub fn for_item(&self, name: &str) -> Vec<Value> {
        let key = item_key(name);
        let posky = self.posky.get(&key);
        let quests = self.quests.get(&key);
        if posky.is_none() && quests.is_none() {
            return Vec::new();
        }
        let mut uses: Vec<Value> = posky.cloned().unwrap_or_default();
        for u in quests.into_iter().flatten() {
            let nu = quest_identity(u["quest"].as_str().unwrap_or_default());
            if !uses
                .iter()
                .any(|x| quest_identity(x["quest"].as_str().unwrap_or_default()) == nu)
            {
                uses.push(u.clone());
            }
        }
        uses
    }
}

/// `questIdentity` — quest identity for de-duping across sources: drop a `Class · ` prefix, fold the
/// pipes and whitespace runs, lowercase.
fn quest_identity(s: &str) -> String {
    // `/^[^·]*·\s*/` — everything up to and including the FIRST `·`, when there is one.
    let after = match s.find('·') {
        Some(at) => &s[at + '·'.len_utf8()..],
        None => s,
    };
    after
        .replace('|', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// `knowledgeFromDb(entry)` with `name` overridden by what the CALLER asked for.
///
/// The compact form omits `lore: false`, `quest: false` and `questUses: []` (pure weight for 11k
/// records) and stores `name` only when the page's `|itemname` differs from its title. All three
/// defaults are restored HERE, in one place, so no caller ever sees the compact form. `name` is the
/// requested DISPLAY name because every other path returns what the caller asked for, and a DB hit
/// must not be the one answer that renames the player's item.
#[must_use]
pub fn knowledge_from_db(entry: &Value, display: &str) -> Value {
    let mut out = entry.clone();
    let Some(map) = out.as_object_mut() else {
        return json!({ "name": display, "lore": false, "quest": false, "questUses": [] });
    };
    map.insert("name".to_owned(), json!(display));
    map.entry("lore").or_insert(json!(false));
    map.entry("quest").or_insert(json!(false));
    map.entry("questUses").or_insert(json!([]));
    out
}

/// `mergeLocal(base, local)` — merge the LOCAL associations into a knowledge record. Local wins on
/// identity, so an item page's own `|relatedquests` links only ADD quests we did not know.
///
/// The de-dupe compares with the class prefix stripped and matches when one normalized name
/// CONTAINS the other: posky labels a quest `Class · Quest Name` where the name often already
/// carries the class ("Paladin · Paladin Test of Love") while a wiki link label is the bare
/// "Paladin Test of Love".
#[must_use]
pub fn merge_local(base: Value, local: &[Value]) -> Value {
    if local.is_empty() {
        return base;
    }
    let mut uses: Vec<Value> = local.to_vec();
    let existing = base["questUses"].as_array().cloned().unwrap_or_default();
    for u in existing {
        let nu = quest_identity(u["quest"].as_str().unwrap_or_default());
        let known = uses.iter().any(|x| {
            let nx = quest_identity(x["quest"].as_str().unwrap_or_default());
            nx == nu || nx.contains(&nu) || nu.contains(&nx)
        });
        if !known {
            uses.push(u);
        }
    }
    let mut out = base;
    out["quest"] = json!(true);
    out["questUses"] = Value::Array(uses);
    out
}

/// The record for a name no committed source and no overlay entry carries.
///
/// `offline: true` RATHER THAN `notFound: true`, and the difference is law 1 at this seam. Over
/// there `notFound` means "the wiki lookup RAN and found no page" — a real negative, cached for
/// seven days. This engine has no network stack at all (boundary verdict 5), so it has not run any
/// lookup and cannot make that claim; `offline` is the app's own word for "the wiki could not be
/// consulted — local sources may still have answered", which is exactly true here and is the state
/// the renderer already treats as retryable. The retry is the `knowledgeMiss` frame: the app fetches
/// and pushes the answer back, and the next lookup is a hit.
#[must_use]
pub fn unanswered(display: &str, local: &[Value]) -> Value {
    merge_local(
        json!({
            "name": display,
            "lore": false,
            "quest": !local.is_empty(),
            "questUses": [],
            "offline": true,
        }),
        local,
    )
}

/// The display name a lookup answers with, for a name a caller handed in.
#[must_use]
pub fn display_of(name: &str) -> String {
    normalize_item_name(name)
}

#[cfg(test)]
mod tests {
    use super::{knowledge_from_db, merge_local, quest_identity, unanswered};
    use serde_json::json;

    #[test]
    fn the_compact_form_is_expanded_and_the_caller_keeps_its_own_spelling() {
        let entry = json!({ "page": "Cloak of Flames", "lore": true });
        let out = knowledge_from_db(&entry, "Cloak of Flames +4");
        assert_eq!(
            out["name"], "Cloak of Flames +4",
            "a DB hit never renames the player's item"
        );
        assert_eq!(out["lore"], true);
        assert_eq!(out["quest"], false, "the omitted default is restored");
        assert_eq!(out["questUses"], json!([]));
        assert_eq!(out["page"], "Cloak of Flames");
    }

    #[test]
    fn the_class_prefix_is_stripped_before_two_sources_are_compared() {
        assert_eq!(
            quest_identity("Paladin · Paladin Test of Love"),
            "paladin test of love"
        );
        assert_eq!(
            quest_identity("Paladin Test of Love"),
            "paladin test of love"
        );
    }

    #[test]
    fn a_local_association_makes_an_item_a_quest_item_and_never_lists_a_quest_twice() {
        let base = json!({
            "name": "Guard Bracelet", "lore": false, "quest": false,
            "questUses": [{ "quest": "Corrupt Guards", "source": "wiki" }]
        });
        let local = vec![json!({ "quest": "Guards · Corrupt Guards", "source": "quests" })];
        let out = merge_local(base, &local);
        assert_eq!(out["quest"], true);
        assert_eq!(
            out["questUses"].as_array().expect("uses").len(),
            1,
            "local wins on identity"
        );
        assert_eq!(out["questUses"][0]["source"], "quests");
    }

    #[test]
    fn an_unanswered_name_still_carries_what_the_local_sources_knew() {
        let local = vec![json!({ "quest": "Bard · Bard Test of Tone", "source": "posky" })];
        let out = unanswered("Wind Rune Meda", &local);
        assert_eq!(
            out["offline"], true,
            "the engine has no network — it did not look"
        );
        assert_eq!(
            out.get("notFound"),
            None,
            "and it therefore claims no negative"
        );
        assert_eq!(out["quest"], true);
        assert_eq!(out["questUses"].as_array().expect("uses").len(), 1);
    }
}
