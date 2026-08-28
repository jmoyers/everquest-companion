//! "What's this lore/quest item for", minus the network.
//!
//! Three sources, in order:
//!
//! 0. THE COMMITTED ITEM DATABASE is primary. A DB hit short-circuits everything after it — no
//!    overlay read, no miss, no announcement.
//! 1. LOCAL CROSS-REFS, merged into whatever answers: the scraped Plane of Sky dataset, which
//!    carries per-item island/giver detail no item page states, and the scraped wiki quest catalog,
//!    which is built from the QUEST pages and is therefore the answer for every turn-in item whose
//!    own page never listed a quest.
//! 2. THE RUNTIME OVERLAY, where a `knowledge.define` lands after the app has fetched a miss.
//!
//! The JSON is `include_str!`d out of the app's own data directories — one copy of each file in the
//! tree, so a re-scrape reaches every reader at once — and parsed behind a `OnceLock`, because an
//! attach must not pay for a corpus no client has queried (the item corpus alone measured ~42 ms of
//! parse and a ~20 MB retained graph).
//!
//! A record is LITERALLY the scraper's own fields: no projection, no renaming, no translation layer.
//! Mirroring twenty-odd fields into Rust structs would only lose one the day the scraper grows it,
//! so the entry stays a `serde_json::Value` and the sole thing done to it is restoring the compact
//! form's omitted defaults.

use serde_json::{json, Map, Value};

use crate::names::{item_key, normalize_item_name, quest_item_key};

/// The committed wiki item database — the primary source.
const ITEMS_JSON: &str = include_str!("../../../../src/main/data/items.json");
/// The scraped Plane of Sky dataset — local source 1 for an item's quest uses.
const POSKY_JSON: &str = include_str!("../../../../src/renderer/src/data/eqlegends/posky.json");
/// The scraped wiki quest catalog — local source 2; the item→quest index below is built from it.
const QUESTS_JSON: &str = include_str!("../../../../src/renderer/src/data/eqlegends/quests.json");

/// How many reward names a `required` use carries.
const MAX_ATTACHED_REWARDS: usize = 4;

/// The committed corpus, keyed by [`item_key`]. The file's `items` map is already that index, so
/// there is nothing to build.
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

/// item key → the quests that use it, from both local catalogs: posky FIRST (it carries the
/// island/giver detail), then the quest catalog, deduped by quest identity.
pub type QuestUseIndex = std::collections::HashMap<String, Vec<Value>>;

/// Index the Plane of Sky dataset by item key → the quests that require it.
#[must_use]
fn posky_by_item() -> QuestUseIndex {
    let file: Value = serde_json::from_str(POSKY_JSON).expect("posky.json is not readable");
    let mut built: QuestUseIndex = QuestUseIndex::new();
    for q in file["quests"].as_array().unwrap_or(&Vec::new()) {
        let class_name = q["className"].as_str().unwrap_or_default();
        let name = q["name"].as_str().unwrap_or_default();
        // De-dupe by quest identity (className + name): the same item appears under many quests.
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

/// The quest catalog, indexed item-first, from both sides of a quest: its turn-in/collectible items
/// (`required`) and the items it hands out (`reward`).
///
/// A `required` use also carries the quest's REWARD names, so the card can say what a turn-in pays
/// without a second lookup. Only a turn-in has an outcome to name: a reward-role use IS the outcome,
/// and listing the quest's rewards there would repeat the item back to itself.
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

/// The scraped quest catalog's `quests` array. Read once and handed to both index builders, the mob
/// side and the item side, because it is one parse.
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

    /// The Plane of Sky dataset FIRST, then the wiki quest catalog, deduped by quest identity.
    /// Empty when neither local source knows this item — never an empty claim.
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

/// Quest identity for de-duping across sources: drop a `Class · ` prefix, fold the pipes and
/// whitespace runs, lowercase.
fn quest_identity(s: &str) -> String {
    // Everything up to and including the FIRST `·`, when there is one.
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

/// A DB entry expanded into a knowledge record, with `name` overridden by what the CALLER asked for.
///
/// The committed form omits `lore: false`, `quest: false` and `questUses: []` as pure weight across
/// thousands of records. All three defaults are restored here, in one place, so no caller sees the
/// compact form. `name` is the requested display name, because a DB hit must not be the one answer
/// that renames the player's item.
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

/// Merge the LOCAL associations into a knowledge record. Local wins on identity, so an item page's
/// own related-quest links only ADD quests we did not know.
///
/// The de-dupe strips the class prefix and matches when one normalized name CONTAINS the other:
/// posky labels a quest `Class · Quest Name` where the name often already carries the class
/// ("Paladin · Paladin Test of Love"), while a wiki link label is the bare "Paladin Test of Love".
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
/// `offline: true` rather than `notFound: true` (law 1). `notFound` means "the wiki lookup RAN and
/// found no page", a real negative; this engine has no network stack, so it ran no lookup and cannot
/// claim one. `offline` means "the wiki could not be consulted, local sources may still have
/// answered", which is exactly true and is the state the renderer treats as retryable — and the
/// retry is the `knowledgeMiss` frame.
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
