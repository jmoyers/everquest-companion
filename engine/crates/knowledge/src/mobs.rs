//! "What does this thing drop", minus the network. Four sources, the first three local:
//!
//!   1. THE SCRAPED MOB CATALOG — the definitive drop table. The wiki's drop list is what the mob
//!      CAN drop and it is static content, so it is scraped once and committed, which is why a
//!      `/con` answers instantly and offline.
//!   2. YOUR OWN LOOT HISTORY, read through [`fold::knowledge::OwnLoot`]. Corroboration, not the
//!      drop table: it annotates a listed drop with a count, and contributes names of its own only
//!      for items the page does not list.
//!   3. THE QUEST CATALOG'S `relatedNpcs`, so a quest-relevant mob says so with no network at all.
//!   4. THE RUNTIME OVERLAY, where a `knowledge.define` lands.
//!
//! The alias boundary is AT THE LOOKUP and nowhere else. The log and the catalog can spell one
//! creature two ways (hyphen versus space), and the raid roster's `match` list is the one place in
//! the tree where two spellings are already STATED to be the same creature. This file reads that
//! statement and does no name arithmetic of its own — no folding rule applied to catalog mobs that
//! never asked for one. `display` is untouched throughout and is what the record reports as its
//! `name`, so a page reached by the log spelling reads back exactly what the log said (law 2).
//!
//! The era annotation runs on every read and is persisted nowhere. It attaches EVIDENCE — the item
//! page's era banner token and the zones that page named — and reaches no verdict: there is exactly
//! one era rule in this app, and a second opinion computed here would be the beginning of a third.

use serde_json::{json, Map, Value};

use crate::names::item_key;
use fold::knowledge::{OwnLoot, SeenDrop};
use fold::modules::consider::mob_key;

/// The scraped mob catalog — local source 1, the definitive drop table.
const MOBS_JSON: &str = include_str!("../../../../src/renderer/src/data/eqlegends/mobs.json");
/// The raid roster — the one place two spellings are stated to be one creature.
const BOSSES_JSON: &str = include_str!("../../../../src/renderer/src/data/eqlegends/bosses.json");

/// One creature, and every spelling the roster states for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// The name to ASK the catalog and the overlay with — the roster's own `name`, which is the
    /// spelling those sources use. Never what the card displays.
    pub canonical: String,
    /// Every `mob_key` this creature answers to, canonical key first.
    pub keys: Vec<String>,
    /// The roster stated more than one spelling for this creature.
    pub aliased: bool,
}

/// The catalog, keyed BOTH ways a mob can be named, and the alias table.
pub struct MobIndex {
    by_name: std::collections::HashMap<String, Value>,
    /// Every alias key of every multi-spelling roster target → its identity.
    identity_by_key: std::collections::HashMap<String, Identity>,
    /// Catalog display names in file order, for `knowledge.search`.
    names: Vec<String>,
}

impl MobIndex {
    /// Build both indexes off the committed bytes.
    ///
    /// The catalog is keyed TWICE: by the page's own `|name` (the in-game name a consider line
    /// prints) and then by the wiki PAGE TITLE, which is occasionally the only spelling. The
    /// page-title pass runs second and only fills gaps, so a real mob's own name can never be
    /// displaced by another page's title.
    #[must_use]
    pub fn build() -> Self {
        let file: Value = serde_json::from_str(MOBS_JSON).expect("mobs.json is not readable");
        let mobs = file["mobs"].as_array().cloned().unwrap_or_default();
        let mut by_name: std::collections::HashMap<String, Value> =
            std::collections::HashMap::with_capacity(mobs.len() * 2);
        let mut names: Vec<String> = Vec::with_capacity(mobs.len());
        for m in &mobs {
            if let Some(name) = m["name"].as_str() {
                let key = mob_key(name);
                if !key.is_empty() {
                    names.push(name.to_owned());
                    by_name.entry(key).or_insert_with(|| m.clone());
                }
            }
        }
        for m in &mobs {
            if let Some(page) = m["page"].as_str() {
                let key = mob_key(page);
                if !key.is_empty() {
                    by_name.entry(key).or_insert_with(|| m.clone());
                }
            }
        }
        Self {
            by_name,
            identity_by_key: build_identities(),
            names,
        }
    }

    /// The catalog's entry for a mob, or `None` when it has none.
    #[must_use]
    pub fn entry(&self, name: &str) -> Option<&Value> {
        self.by_name.get(&mob_key(name))
    }

    /// Resolve any spelling to the one identity the roster states, or to itself when the roster has
    /// never heard of it.
    ///
    /// Total and allocation-light: an unaliased name — nearly every mob — gets a trivial identity
    /// whose `canonical` is the name it was handed, so every downstream read is the read it was
    /// before aliases existed.
    #[must_use]
    pub fn identity(&self, name: &str) -> Identity {
        let key = mob_key(name);
        if let Some(known) = self.identity_by_key.get(&key) {
            return known.clone();
        }
        Identity {
            canonical: name.to_owned(),
            keys: if key.is_empty() {
                Vec::new()
            } else {
                vec![key]
            },
            aliased: false,
        }
    }

    /// Every catalog display name, for the search surface.
    #[must_use]
    pub fn names(&self) -> &[String] {
        &self.names
    }
}

/// Read the roster's own statement that two spellings are one creature.
///
/// Targets whose spellings all collapse to ONE key are skipped entirely: they never enter the map,
/// so `identity` hands back the trivial identity and every caller runs the path it ran before. A key
/// claimed by two targets keeps the first — silently merging two creatures on a later scrape is not
/// something this boundary should be able to do by accident.
fn build_identities() -> std::collections::HashMap<String, Identity> {
    let file: Value = serde_json::from_str(BOSSES_JSON).expect("bosses.json is not readable");
    let mut by_key: std::collections::HashMap<String, Identity> = std::collections::HashMap::new();
    for t in file["targets"].as_array().unwrap_or(&Vec::new()) {
        let Some(name) = t["name"].as_str() else {
            continue;
        };
        let mut keys: Vec<String> = Vec::new();
        let spellings = std::iter::once(name).chain(
            t["match"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str),
        );
        for spelling in spellings {
            let k = mob_key(spelling);
            if !k.is_empty() && !keys.contains(&k) {
                keys.push(k);
            }
        }
        if keys.len() < 2 {
            continue;
        }
        let id = Identity {
            canonical: name.to_owned(),
            keys: keys.clone(),
            aliased: true,
        };
        for k in keys {
            by_key.entry(k).or_insert_with(|| id.clone());
        }
    }
    by_key
}

/// mob key → the quests that name it under "Related NPCs".
pub type MobQuestIndex = std::collections::HashMap<String, Vec<Value>>;

/// Build the `relatedNpcs` cross-ref off the already-parsed quest catalog.
#[must_use]
pub fn quests_by_mob(quests: &[Value]) -> MobQuestIndex {
    let mut by_mob: MobQuestIndex = MobQuestIndex::new();
    for q in quests {
        for npc in q["relatedNpcs"].as_array().into_iter().flatten() {
            let Some(npc) = npc.as_str() else { continue };
            let key = mob_key(npc);
            if key.is_empty() {
                continue;
            }
            let uses = by_mob.entry(key).or_default();
            if uses.iter().any(|u| u["quest"] == q["name"]) {
                continue;
            }
            let mut row = json!({ "quest": q["name"] });
            for (field, from) in [("page", "page"), ("giver", "giver"), ("zone", "startZone")] {
                if let Some(v) = q[from].as_str() {
                    row[field] = json!(v);
                }
            }
            uses.push(row);
        }
    }
    by_mob
}

/// The quests the local catalog ties to this CREATURE, under every spelling the roster states for
/// it. De-duped by quest name.
fn identity_quests(index: &MobQuestIndex, id: &Identity) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for key in &id.keys {
        for q in index.get(key).into_iter().flatten() {
            let name = q["quest"].as_str().unwrap_or_default().to_lowercase();
            if !merged
                .iter()
                .any(|x| x["quest"].as_str().unwrap_or_default().to_lowercase() == name)
            {
                merged.push(q.clone());
            }
        }
    }
    merged
}

/// A catalog entry → the WIKI half of a knowledge record.
///
/// The catalog is compact by design (names only), so a per-drop `rarity` is simply ABSENT here; a
/// live fallback is where one would come from, and a made-up rarity would not be honest.
#[must_use]
pub fn knowledge_from_catalog(display: &str, entry: &Value) -> Value {
    let mut out = json!({ "name": display, "page": entry["page"], "cached": true });
    if let Some(level) = entry["level"].as_str().filter(|s| !s.is_empty()) {
        out["levelText"] = json!(level);
    }
    let zones: Vec<&str> = entry["zones"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !zones.is_empty() {
        out["zone"] = json!(zones.join(", "));
    }
    let drops: Vec<Value> = entry["drops"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|item| json!({ "item": item }))
        .collect();
    if !drops.is_empty() {
        out["dropsWiki"] = Value::Array(drops);
    }
    out
}

/// Attach the two LOCAL sources to a record, on EVERY read.
///
/// Never baked into anything persisted: your own loot history changes with every corpse, and the
/// quest catalog ships with the app, so remembering either would immediately be stale.
///
/// It reads by IDENTITY rather than by the one name the caller happened to hold — the own-loot index
/// files a drop under the corpse's LOG name while a boss card asks with the ROSTER name. What comes
/// back is still `dropsSeen`, so alias-gathered loot is never dressed up as documented drops.
#[must_use]
pub fn merge_local_knowledge(
    base: Value,
    id: &Identity,
    quests: &MobQuestIndex,
    loot: &dyn OwnLoot,
) -> Value {
    let mut out = base;
    let seen = loot.drops_across(&id.keys);
    if seen.is_empty() {
        if let Some(map) = out.as_object_mut() {
            map.remove("dropsSeen");
        }
    } else {
        out["dropsSeen"] = Value::Array(seen.iter().map(seen_drop).collect());
    }
    let local = identity_quests(quests, id);
    if !local.is_empty() {
        // The page's own related-quest links and the catalog's `relatedNpcs` are two views of one
        // relation, so de-dupe by quest name; local wins, because it carries the giver and zone.
        let mut merged = local;
        for u in out["quests"].as_array().cloned().unwrap_or_default() {
            let name = u["quest"].as_str().unwrap_or_default().to_lowercase();
            if !merged
                .iter()
                .any(|x| x["quest"].as_str().unwrap_or_default().to_lowercase() == name)
            {
                merged.push(u);
            }
        }
        out["quests"] = Value::Array(merged);
    }
    out
}

/// One seen drop, on the wire.
fn seen_drop(d: &SeenDrop) -> Value {
    json!({ "item": d.item, "count": d.count, "lastTs": d.last_ts })
}

/// The drop list, carrying what each ITEM PAGE says about its era.
///
/// A drop the corpus has no page for comes back unchanged, and so does a page that states neither an
/// era banner nor a drop zone: absent is the honest answer and the renderer draws it as `era?`
/// rather than as a verdict. `dropsSeen` is deliberately untouched — those are items YOU pulled off
/// this corpse, a fact about your own play and not a claim about what the server ships.
#[must_use]
pub fn annotate_drop_eras(mut record: Value, items: &Map<String, Value>) -> Value {
    let Some(drops) = record["dropsWiki"].as_array() else {
        return record;
    };
    if drops.is_empty() {
        return record;
    }
    let annotated: Vec<Value> = drops
        .iter()
        .map(|drop| annotate_drop(drop, items))
        .collect();
    record["dropsWiki"] = Value::Array(annotated);
    record
}

/// One drop, annotated. Only the ZONE half of the page's drop-source list is era evidence, and a
/// zone named by several of its mobs is one zone. Order is the page's, which no fold depends on.
fn annotate_drop(drop: &Value, items: &Map<String, Value>) -> Value {
    let Some(item) = drop["item"].as_str() else {
        return drop.clone();
    };
    let Some(entry) = items.get(&item_key(item)) else {
        return drop.clone();
    };
    let mut zones: Vec<&str> = Vec::new();
    for source in entry["dropsFrom"].as_array().into_iter().flatten() {
        if let Some(zone) = source["zone"].as_str() {
            if !zones.contains(&zone) {
                zones.push(zone);
            }
        }
    }
    let era = entry["eraTag"].as_str();
    if era.is_none() && zones.is_empty() {
        return drop.clone();
    }
    let mut out = drop.clone();
    if let Some(era) = era {
        out["eraTag"] = json!(era);
    }
    if !zones.is_empty() {
        out["eraZones"] = json!(zones);
    }
    out
}

/// The record for a mob no committed source and no overlay entry carries.
///
/// `offline: true` for the reason `items::unanswered` states: this engine ran no lookup, so it
/// cannot claim the real negative `notFound` means. The local half is merged on top by the caller.
#[must_use]
pub fn unanswered(display: &str) -> Value {
    json!({ "name": display, "cached": false, "offline": true })
}

#[cfg(test)]
mod tests {
    use super::{
        annotate_drop_eras, knowledge_from_catalog, merge_local_knowledge, quests_by_mob, Identity,
    };
    use fold::knowledge::{NoOwnLoot, OwnLoot, SeenDrop};
    use serde_json::{json, Map, Value};

    struct Looted(Vec<SeenDrop>);
    impl OwnLoot for Looted {
        fn drops_across(&self, _spellings: &[String]) -> Vec<SeenDrop> {
            self.0.clone()
        }
    }

    fn id(name: &str) -> Identity {
        Identity {
            canonical: name.to_owned(),
            keys: vec![name.to_lowercase()],
            aliased: false,
        }
    }

    #[test]
    fn a_catalog_entry_states_only_what_the_page_states() {
        let entry = json!({
            "page": "A zol ghoul knight", "name": "a zol ghoul knight",
            "level": "36-40", "zones": ["Lower Guk"], "drops": ["Amber"]
        });
        let out = knowledge_from_catalog("A zol ghoul knight", &entry);
        assert_eq!(out["levelText"], "36-40");
        assert_eq!(out["zone"], "Lower Guk");
        assert_eq!(out["dropsWiki"][0], json!({ "item": "Amber" }));
        assert_eq!(
            out["dropsWiki"][0].get("rarity"),
            None,
            "the catalog states no rarity"
        );

        // A merchant page states no loot at all and comes back with no drop list rather than an
        // empty one — reading a vendor's stock as loot would be a claim the page does not make.
        let merchant = json!({ "page": "Key Master", "name": "Key Master" });
        let out = knowledge_from_catalog("Key Master", &merchant);
        assert_eq!(out.get("dropsWiki"), None);
        assert_eq!(out.get("levelText"), None);
    }

    #[test]
    fn your_own_loot_is_attached_as_its_own_list_and_never_as_drops() {
        let base = knowledge_from_catalog(
            "a sand giant",
            &json!({ "page": "A sand giant", "drops": ["Amber"] }),
        );
        let loot = Looted(vec![SeenDrop {
            item: "Giant Toe".into(),
            count: 3,
            last_ts: 7,
        }]);
        let out = merge_local_knowledge(
            base,
            &id("a sand giant"),
            &super::MobQuestIndex::new(),
            &loot,
        );
        assert_eq!(out["dropsWiki"].as_array().expect("wiki drops").len(), 1);
        assert_eq!(
            out["dropsSeen"][0],
            json!({ "item": "Giant Toe", "count": 3, "lastTs": 7 })
        );
    }

    #[test]
    fn a_mob_you_have_never_looted_carries_no_drops_seen_key_at_all() {
        let base =
            json!({ "name": "a sand giant", "cached": true, "dropsSeen": [{ "item": "stale" }] });
        let out = merge_local_knowledge(
            base,
            &id("a sand giant"),
            &super::MobQuestIndex::new(),
            &NoOwnLoot,
        );
        assert_eq!(out.get("dropsSeen"), None, "absent, never an empty claim");
    }

    #[test]
    fn the_quest_cross_ref_is_read_off_related_npcs() {
        let quests = vec![json!({
            "name": "Corrupt Guards", "page": "Corrupt Guards", "giver": "Vhalen", "startZone": "Qeynos",
            "relatedNpcs": ["A Corrupt Qeynos Guard", "a corrupt qeynos guard"]
        })];
        let index = quests_by_mob(&quests);
        let base = json!({ "name": "a corrupt qeynos guard", "cached": true });
        let out = merge_local_knowledge(
            base,
            &Identity {
                canonical: "a corrupt qeynos guard".into(),
                keys: vec!["a corrupt qeynos guard".into()],
                aliased: false,
            },
            &index,
            &NoOwnLoot,
        );
        let uses = out["quests"].as_array().expect("quests");
        assert_eq!(uses.len(), 1, "two spellings of one NPC are one quest use");
        assert_eq!(uses[0]["giver"], "Vhalen");
        assert_eq!(uses[0]["zone"], "Qeynos");
    }

    #[test]
    fn the_era_annotation_attaches_evidence_and_reaches_no_verdict() {
        let mut items = Map::new();
        items.insert(
            "brain of cazic thule".to_owned(),
            json!({ "page": "Brain of Cazic Thule", "eraTag": "FearHateRevamp",
                    "dropsFrom": [{ "mob": "Cazic Thule", "zone": "Plane of Fear" }, { "mob": "x", "zone": "Plane of Fear" }] }),
        );
        let record = json!({ "name": "Cazic-Thule", "cached": true,
                             "dropsWiki": [{ "item": "Brain of Cazic Thule" }, { "item": "Amber" }] });
        let out = annotate_drop_eras(record, &items);
        assert_eq!(out["dropsWiki"][0]["eraTag"], "FearHateRevamp");
        assert_eq!(
            out["dropsWiki"][0]["eraZones"],
            json!(["Plane of Fear"]),
            "deduped"
        );
        assert_eq!(
            out["dropsWiki"][1].get("eraTag"),
            None,
            "an item the corpus lacks is unchanged"
        );
        // No verdict of any kind is written.
        assert_eq!(out["dropsWiki"][0].get("outOfEra"), None);
        let _: &Value = &out;
    }
}
