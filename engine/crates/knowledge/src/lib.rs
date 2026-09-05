//! The committed corpora, engine-side: the item, mob, quest and Plane of Sky datasets the app ships,
//! indexed once and queried on demand behind `knowledge.item/mob/spell/search`.
//!
//! THE WIKI FETCH IS NOT HERE. The engine ships without a network stack, so resolution is:
//!
//!   1. the committed corpus, which answers the overwhelming majority and short-circuits the rest;
//!   2. the runtime overlay — answers the app has already fetched and pushed back with
//!      `knowledge.define`;
//!   3. a MISS, recorded here, drained at a boundary and announced as a `knowledgeMiss` frame. The
//!      app fetches under its own scrape throttle and cooldown, and pushes the answer in.
//!
//! Each name is announced AT MOST ONCE per process: a stacked loot burst probes one name many times
//! and the app must not be asked to fetch it many times.
//!
//! Every index is built on first use. `include_str!` puts the bytes in the binary and nothing is
//! parsed until something asks, because an attach must not pay for a corpus no client has queried.
//!
//! `knowledge.spell` answers off `eqlog`'s effective spell DB and states exactly the fields that DB
//! carries. It deliberately does NOT carry the derived effect classes, the rank lineage or the
//! focus/level-dependent metrics: those need inputs this engine does not have, and half a card is a
//! wrong answer wearing a right one's clothes. A named gap, stated in the schema beside the op.

pub mod items;
pub mod mobs;
pub mod names;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use serde_json::{json, Map, Value};

use fold::knowledge::{Answer, Knowledge, Miss, OwnLoot};
use fold::modules::consider::mob_key;
use items::{display_of, knowledge_from_db, load_item_db, load_quests, merge_local, LocalQuests};
use mobs::{
    annotate_drop_eras, knowledge_from_catalog, merge_local_knowledge, quests_by_mob, MobIndex,
    MobQuestIndex,
};
use names::item_key;

/// The two corpora a `knowledge.define` may push into, and the two a miss may name.
///
/// Spells are not one of them. The item and mob corpora have an app-side FETCHER behind them, so a
/// name they lack is a question somebody can answer; the spell catalog is committed with no live
/// fallback anywhere in the app, so announcing a missing spell would ask the app to do something it
/// has no code for.
pub const FETCHABLE_DOMAINS: &[&str] = &["item", "mob"];

/// How many hits `knowledge.search` returns when the caller names no limit, and the most it returns
/// however large a limit it names.
///
/// A cap rather than a page: search is a type-ahead read by a human scanning a short list. The
/// window/offset machinery belongs to `view.subscribe`, where a list is the product.
pub const SEARCH_DEFAULT_LIMIT: usize = 20;
/// See [`SEARCH_DEFAULT_LIMIT`].
pub const SEARCH_MAX_LIMIT: usize = 100;

/// The process's one corpus: one instance shared by the ingest thread (the fold's own probes) and by
/// every connection thread (the `knowledge.*` ops). One overlay, one miss ledger, and the loot index
/// read through a seam rather than shared.
#[derive(Default)]
pub struct Corpus {
    items: OnceLock<Map<String, Value>>,
    quests: OnceLock<Vec<Value>>,
    local_quests: OnceLock<LocalQuests>,
    mob_index: OnceLock<MobIndex>,
    mob_quests: OnceLock<MobQuestIndex>,
    /// domain → key → the record the app pushed. See [`Corpus::define`].
    overlay: RwLock<HashMap<&'static str, HashMap<String, Value>>>,
    /// Names this process could not answer, waiting to be announced.
    pending: Mutex<Vec<Miss>>,
    /// Names already announced — the at-most-once law.
    announced: Mutex<HashSet<(String, String)>>,
}

/// The process's corpus, built lazily and shared. A respawn is a launch, so there is no state to
/// restore and no way to make a second one by accident.
#[must_use]
pub fn shared() -> Arc<Corpus> {
    static CORPUS: OnceLock<Arc<Corpus>> = OnceLock::new();
    Arc::clone(CORPUS.get_or_init(|| Arc::new(Corpus::default())))
}

impl Corpus {
    /// A fresh, unshared corpus, for tests that want their own overlay and miss ledger. The indexes
    /// are parsed per instance, which is why production uses [`shared`].
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn items(&self) -> &Map<String, Value> {
        self.items.get_or_init(load_item_db)
    }

    fn quests(&self) -> &Vec<Value> {
        self.quests.get_or_init(load_quests)
    }

    fn local_quests(&self) -> &LocalQuests {
        self.local_quests
            .get_or_init(|| LocalQuests::build(self.quests()))
    }

    fn mob_index(&self) -> &MobIndex {
        self.mob_index.get_or_init(MobIndex::build)
    }

    fn mob_quests(&self) -> &MobQuestIndex {
        self.mob_quests.get_or_init(|| quests_by_mob(self.quests()))
    }

    /// Take one pushed answer — `knowledge.define`.
    ///
    /// Every other `*.define` carries the WHOLE set; this one cannot, because the set is the wiki:
    /// unbounded, not owned by the app, and learned one entry at a time in answer to one miss.
    ///
    /// It keeps the part of that law the law is for: idempotent and order-independent per key, so a
    /// crash-respawn stays trivial (the overlay is empty, every name misses again, the app answers
    /// again) and the input is still hash-friendly as a set of (key, entry) pairs. What it gives up
    /// is DELETE, which nothing asks for.
    ///
    /// It survives an attach: this is what the APP has told the process about committed data, not
    /// what a generation folded.
    pub fn define(&self, domain: &str, name: &str, entry: &Value) -> bool {
        let Some(domain) = fetchable(domain) else {
            return false;
        };
        let key = key_for(domain, name);
        if key.is_empty() {
            return false;
        }
        if let Ok(mut overlay) = self.overlay.write() {
            overlay
                .entry(domain)
                .or_default()
                .insert(key, entry.clone());
        }
        true
    }

    /// How many entries the overlay holds for one domain — the diagnostic a `perf` row or a test
    /// reads, never a wire field.
    #[must_use]
    pub fn overlay_size(&self, domain: &str) -> usize {
        self.overlay
            .read()
            .ok()
            .and_then(|o| o.get(domain).map(HashMap::len))
            .unwrap_or(0)
    }

    fn overlay_entry(&self, domain: &'static str, key: &str) -> Option<Value> {
        self.overlay.read().ok()?.get(domain)?.get(key).cloned()
    }

    /// Record one name this process could not answer, at most once ever.
    fn note_miss(&self, domain: &str, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        let Ok(mut announced) = self.announced.lock() else {
            return;
        };
        if !announced.insert((domain.to_owned(), name.to_owned())) {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.push(Miss {
                domain: domain.to_owned(),
                name: name.to_owned(),
            });
        }
    }

    /// One spell, from the effective catalog — `knowledge.spell`.
    ///
    /// Every field is copied across ONLY IF THE DB STATES IT (law 1), so an absent wiki field stays
    /// absent and the card never has to decide what a missing duration looks like.
    ///
    /// EXACT NAME MATCH ONLY, a stated limit rather than a bug: answering `Rune III` with `Rune`'s
    /// numbers needs the lineage block that would say out loud they are the line's, which is the
    /// named gap in the crate header. Without it, `found: false` is the honest answer.
    #[must_use]
    pub fn spell(&self, name: &str) -> Answer {
        let queried = name.trim();
        let db = eqlog::spelldb::shared();
        let wanted = queried.to_lowercase();
        let Some(entry) = db
            .spells
            .iter()
            .find(|s| s.name.trim().to_lowercase() == wanted)
        else {
            return Answer {
                record: json!({ "queried": queried, "found": false, "illusion": false }),
                found: false,
            };
        };
        let mut record = json!({
            "queried": queried,
            "name": entry.name,
            "found": true,
            "illusion": entry.illusion,
        });
        let mut state = |key: &str, value: Value| {
            if !value.is_null() {
                record[key] = value;
            }
        };
        state("durationText", json!(entry.duration_text));
        state("durationMs", json!(entry.duration_ms));
        state("targetType", json!(entry.target_type));
        state("spellType", json!(entry.spell_type));
        state("classes", json!(entry.classes));
        state("msgCastOnYou", json!(entry.msg_cast_on_you));
        state("msgCastOnOther", json!(entry.msg_cast_on_other));
        state("msgWearsOff", json!(entry.msg_wears_off));
        state("effects", json!(entry.effects));
        Answer {
            record,
            found: true,
        }
    }

    /// Name search across every corpus this engine holds — `knowledge.search`.
    ///
    /// A lookup needs the exact name; a person types three letters. Hits rank EXACT, then PREFIX,
    /// then CONTAINS, and within a rank by name length then alphabetically, so the ranking is total
    /// and the same query twice is the same answer twice.
    ///
    /// The ranking is the ENGINE'S, not the client's: the renderer never sorts or filters domain
    /// data, so handing back an unordered bag would be handing back the work.
    #[must_use]
    pub fn search(&self, query: &str, domain: Option<&str>, limit: Option<usize>) -> Value {
        let needle = query.trim().to_lowercase();
        let limit = limit.unwrap_or(SEARCH_DEFAULT_LIMIT).min(SEARCH_MAX_LIMIT);
        if needle.is_empty() {
            return json!({ "query": query.trim(), "total": 0, "hits": [] });
        }
        let mut scored: Vec<(u8, usize, String, &'static str, Option<String>)> = Vec::new();
        let wants = |d: &str| domain.is_none_or(|only| only == d);
        if wants("item") {
            for (_, entry) in self.items() {
                let page = entry["page"].as_str();
                let name = entry["name"].as_str().or(page).unwrap_or_default();
                if let Some(rank) = rank_of(name, &needle) {
                    scored.push((
                        rank,
                        name.len(),
                        name.to_owned(),
                        "item",
                        page.map(str::to_owned),
                    ));
                }
            }
        }
        if wants("mob") {
            for name in self.mob_index().names() {
                if let Some(rank) = rank_of(name, &needle) {
                    let page = self
                        .mob_index()
                        .entry(name)
                        .and_then(|e| e["page"].as_str())
                        .map(str::to_owned);
                    scored.push((rank, name.len(), name.clone(), "mob", page));
                }
            }
        }
        if wants("quest") {
            for q in self.quests() {
                let name = q["name"].as_str().unwrap_or_default();
                if let Some(rank) = rank_of(name, &needle) {
                    scored.push((
                        rank,
                        name.len(),
                        name.to_owned(),
                        "quest",
                        q["page"].as_str().map(str::to_owned),
                    ));
                }
            }
        }
        if wants("spell") {
            for entry in &eqlog::spelldb::shared().spells {
                if let Some(rank) = rank_of(&entry.name, &needle) {
                    scored.push((rank, entry.name.len(), entry.name.clone(), "spell", None));
                }
            }
        }
        scored.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.cmp(&b.1))
                .then(a.2.cmp(&b.2))
                .then(a.3.cmp(b.3))
        });
        let total = scored.len();
        let hits: Vec<Value> = scored
            .into_iter()
            .take(limit)
            .map(|(_, _, name, domain, page)| {
                let mut hit = json!({ "domain": domain, "name": name });
                if let Some(page) = page {
                    hit["page"] = json!(page);
                }
                hit
            })
            .collect();
        // `total` is the MATCH count, not the hit count: the one number a caller cannot compute from
        // what it was handed.
        json!({ "query": query.trim(), "total": total, "hits": hits })
    }
}

/// EXACT (0), PREFIX (1), CONTAINS (2), or no match. Case-folded on both sides.
fn rank_of(name: &str, needle: &str) -> Option<u8> {
    let folded = name.to_lowercase();
    if folded == needle {
        return Some(0);
    }
    if folded.starts_with(needle) {
        return Some(1);
    }
    if folded.contains(needle) {
        return Some(2);
    }
    None
}

/// The domain as a `'static` name, or `None` for one this engine does not take pushes for.
fn fetchable(domain: &str) -> Option<&'static str> {
    FETCHABLE_DOMAINS
        .iter()
        .find(|known| **known == domain)
        .copied()
}

/// The overlay key for one domain — each domain's own canonical fold, never a shared one.
fn key_for(domain: &str, name: &str) -> String {
    if domain == "mob" {
        mob_key(name)
    } else {
        item_key(name)
    }
}

/// Did a pushed record claim a real negative? A `notFound` push is the app saying "I looked and the
/// wiki has no page" — an ANSWER, which stops the engine announcing that name again, but not a
/// `found`.
fn overlay_found(entry: &Value) -> bool {
    !entry["notFound"].as_bool().unwrap_or(false)
}

impl Knowledge for Corpus {
    /// The committed DB, then the overlay, then a miss. Local sources are merged into whichever
    /// answers, because they say something about the item's USES that no item page states.
    fn item(&self, name: &str) -> Answer {
        let display = display_of(name);
        let local = self.local_quests().for_item(name);
        let key = item_key(name);
        // Primary: the committed database. Answered here, an item costs no overlay read and no
        // announcement, so a miss describes only names the corpus lacks.
        if let Some(entry) = self.items().get(&key) {
            let mut record = merge_local(knowledge_from_db(entry, &display), &local);
            // `cached: true` because this is knowledge we already had, not a fresh lookup.
            record["cached"] = json!(true);
            return Answer {
                record,
                found: true,
            };
        }
        if let Some(entry) = self.overlay_entry("item", &key) {
            let found = overlay_found(&entry);
            let mut record = merge_local(knowledge_from_db(&entry, &display), &local);
            record["cached"] = json!(true);
            return Answer { record, found };
        }
        // Asked with the DISPLAY name: that is what the app's fetch will search the wiki for, and a
        // folded key is not a name.
        self.note_miss("item", &display);
        Answer {
            record: items::unanswered(&display, &local),
            found: false,
        }
    }

    fn identity_keys(&self, mob: &str) -> Vec<String> {
        self.mob_index().identity(mob.trim()).keys
    }

    /// The catalog, then the overlay, then a miss; the local half merged on top of whichever
    /// answered, and the era evidence attached at the one confluence all exits pass through.
    fn mob(&self, name: &str, loot: &dyn OwnLoot) -> Answer {
        let display = name.trim();
        let id = self.mob_index().identity(display);
        // What the catalog and the overlay are asked. Identical to `display` for every mob the
        // roster does not spell two ways, which is nearly all of them.
        let ask = id.canonical.clone();
        let (base, found) = if let Some(entry) = self.mob_index().entry(&ask) {
            (knowledge_from_catalog(display, entry), true)
        } else if let Some(entry) = self.overlay_entry("mob", &mob_key(&ask)) {
            let found = overlay_found(&entry);
            let mut record = entry;
            record["name"] = json!(display);
            record["cached"] = json!(true);
            (record, found)
        } else {
            // Asked with the CANONICAL name: the roster's spelling is the one the wiki and the
            // catalog use.
            self.note_miss("mob", &ask);
            (mobs::unanswered(display), false)
        };
        let merged = merge_local_knowledge(base, &id, self.mob_quests(), loot);
        Answer {
            record: annotate_drop_eras(merged, self.items()),
            found,
        }
    }

    /// The committed catalog, and NOTHING ELSE: no overlay read, no alias resolution, and — the
    /// load-bearing half — no miss. See [`Knowledge::known_mob`].
    fn known_mob(&self, name: &str) -> bool {
        self.mob_index().entry(name.trim()).is_some()
    }

    fn take_misses(&self) -> Vec<Miss> {
        self.pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::{shared, Corpus, SEARCH_MAX_LIMIT};
    use fold::knowledge::{Knowledge, NoOwnLoot, OwnLoot, SeenDrop};
    use serde_json::json;

    struct Looted(Vec<SeenDrop>);
    impl OwnLoot for Looted {
        fn drops_across(&self, _spellings: &[String]) -> Vec<SeenDrop> {
            self.0.clone()
        }
    }

    #[test]
    fn the_committed_item_corpus_answers_a_real_item_with_no_miss() {
        // Against the committed bytes, not a fixture: the claim under test is that the shipped
        // corpus is readable from Rust and keys the way the app keys it.
        let corpus = Corpus::new();
        let answer = corpus.item("Cloak of Flames");
        assert!(answer.found, "the corpus holds Cloak of Flames");
        assert_eq!(answer.record["name"], "Cloak of Flames");
        assert_eq!(answer.record["cached"], true);
        assert!(answer.record["page"].is_string());
        assert!(
            corpus.take_misses().is_empty(),
            "a DB hit announces nothing"
        );
    }

    #[test]
    fn the_item_level_suffix_resolves_to_the_same_page_and_keeps_the_players_spelling() {
        let corpus = Corpus::new();
        let plain = corpus.item("Cloak of Flames");
        let upgraded = corpus.item("Cloak of Flames +4");
        assert!(upgraded.found);
        assert_eq!(upgraded.record["page"], plain.record["page"]);
        assert_eq!(
            upgraded.record["name"], "Cloak of Flames",
            "the display name is the +N-stripped base, which is what normalizeItemName answers"
        );
    }

    #[test]
    fn a_name_no_corpus_holds_is_announced_exactly_once_and_still_answers() {
        let corpus = Corpus::new();
        let answer = corpus.item("A Thing That Does Not Exist");
        assert!(!answer.found);
        assert_eq!(answer.record["offline"], true);
        assert_eq!(answer.record["questUses"], json!([]));
        let misses = corpus.take_misses();
        assert_eq!(misses.len(), 1);
        assert_eq!(misses[0].domain, "item");
        assert_eq!(misses[0].name, "A Thing That Does Not Exist");

        // …and asking again announces nothing: the app is asked to fetch a name once.
        let _ = corpus.item("A Thing That Does Not Exist");
        assert!(corpus.take_misses().is_empty());
    }

    #[test]
    fn a_pushed_answer_turns_the_next_lookup_into_a_hit() {
        let corpus = Corpus::new();
        assert!(!corpus.item("A Thing That Does Not Exist").found);
        assert_eq!(corpus.take_misses().len(), 1);
        assert!(corpus.define(
            "item",
            "A Thing That Does Not Exist",
            &json!({ "page": "A Thing", "lore": true, "summary": "pushed by the app" }),
        ));
        let answer = corpus.item("A Thing That Does Not Exist");
        assert!(answer.found);
        assert_eq!(answer.record["lore"], true);
        assert_eq!(answer.record["summary"], "pushed by the app");
        assert_eq!(answer.record["name"], "A Thing That Does Not Exist");
        assert_eq!(
            answer.record["quest"], false,
            "the omitted default is restored"
        );
        assert!(corpus.take_misses().is_empty());
        assert_eq!(corpus.overlay_size("item"), 1);
    }

    #[test]
    fn a_define_is_idempotent_and_a_domain_with_no_fetcher_is_refused() {
        let corpus = Corpus::new();
        let entry = json!({ "page": "A Thing" });
        assert!(corpus.define("item", "A Thing", &entry));
        assert!(corpus.define("item", "A Thing", &entry));
        assert_eq!(
            corpus.overlay_size("item"),
            1,
            "the same push twice is one entry"
        );
        assert!(
            !corpus.define("spell", "Complete Heal", &entry),
            "no app-side fetcher"
        );
        assert!(!corpus.define("quest", "Corrupt Guards", &entry));
    }

    #[test]
    fn a_pushed_negative_is_an_answer_and_stops_the_asking() {
        let corpus = Corpus::new();
        assert!(corpus.define(
            "item",
            "Nothing At All",
            &json!({ "page": "", "notFound": true })
        ));
        let answer = corpus.item("Nothing At All");
        assert!(!answer.found, "a real negative is not a find");
        assert!(
            corpus.take_misses().is_empty(),
            "but it is an ANSWER, so nobody is asked again"
        );
    }

    #[test]
    fn the_committed_mob_catalog_answers_a_con_with_the_drop_table() {
        let corpus = Corpus::new();
        let answer = corpus.mob("a sand giant", &NoOwnLoot);
        assert!(answer.found, "the catalog holds a sand giant");
        assert_eq!(
            answer.record["name"], "a sand giant",
            "the log's own spelling is kept"
        );
        assert!(answer.record["page"].is_string());
        assert!(corpus.take_misses().is_empty());
    }

    #[test]
    fn your_own_loot_joins_the_mob_answer_through_the_folds_index() {
        let corpus = Corpus::new();
        let loot = Looted(vec![SeenDrop {
            item: "Giant Toe".into(),
            count: 3,
            last_ts: 7,
        }]);
        let answer = corpus.mob("a sand giant", &loot);
        assert_eq!(answer.record["dropsSeen"][0]["count"], 3);
        // …and the same mob with no history carries no such key at all.
        let bare = corpus.mob("a sand giant", &NoOwnLoot);
        assert_eq!(bare.record.get("dropsSeen"), None);
    }

    #[test]
    fn the_roster_is_what_says_two_spellings_are_one_creature() {
        // The log spells this god with a HYPHEN and the catalog with a SPACE; `bosses.json` is the
        // only committed statement that they are one creature.
        let corpus = Corpus::new();
        let keys = corpus.identity_keys("Cazic-Thule");
        assert!(
            keys.len() > 1,
            "the roster states more than one spelling: {keys:?}"
        );
        let answer = corpus.mob("Cazic-Thule", &NoOwnLoot);
        assert!(answer.found, "reached by the LOG spelling");
        assert_eq!(
            answer.record["name"], "Cazic-Thule",
            "and it reads back what the log said"
        );
        // An unaliased mob is one key — the unchanged path for the rest of the catalog.
        assert_eq!(
            corpus.identity_keys("a sand giant"),
            vec!["a sand giant".to_owned()]
        );
    }

    #[test]
    fn a_mob_the_catalog_lacks_is_announced_under_the_name_the_wiki_would_be_asked() {
        let corpus = Corpus::new();
        let answer = corpus.mob("a creature nobody scraped", &NoOwnLoot);
        assert!(!answer.found);
        assert_eq!(answer.record["offline"], true);
        let misses = corpus.take_misses();
        assert_eq!(misses.len(), 1);
        assert_eq!(misses[0].domain, "mob");
        assert_eq!(misses[0].name, "a creature nobody scraped");
    }

    #[test]
    fn the_spell_surface_answers_off_the_effective_catalog() {
        let corpus = Corpus::new();
        let answer = corpus.spell("Complete Heal");
        assert!(answer.found);
        assert_eq!(answer.record["name"], "Complete Heal");
        assert_eq!(answer.record["queried"], "Complete Heal");
        assert!(answer.record["illusion"] == false);
        // The named gap, pinned so it cannot appear by accident and go unexplained.
        assert_eq!(answer.record.get("metrics"), None);
        assert_eq!(answer.record.get("effectClasses"), None);
        assert_eq!(answer.record.get("lineage"), None);
        // A name the catalog does not carry is an answer, not an error, and announces nothing —
        // there is no app-side spell fetcher to announce it to.
        let missing = corpus.spell("Spell Of Nothing");
        assert!(!missing.found);
        assert_eq!(missing.record["queried"], "Spell Of Nothing");
        assert!(corpus.take_misses().is_empty());
    }

    #[test]
    fn search_ranks_exact_first_and_reports_the_whole_match_count() {
        let corpus = Corpus::new();
        let out = corpus.search("Cloak of Flames", None, None);
        assert_eq!(
            out["hits"][0]["name"], "Cloak of Flames",
            "exact before prefix before contains"
        );
        assert_eq!(out["hits"][0]["domain"], "item");
        assert!(out["total"].as_u64().expect("a total") >= 1);

        // The domain filter is a filter, not a hint.
        let mobs = corpus.search("giant", Some("mob"), Some(5));
        assert!(mobs["hits"].as_array().expect("hits").len() <= 5);
        for hit in mobs["hits"].as_array().expect("hits") {
            assert_eq!(hit["domain"], "mob");
        }

        // An empty query is an empty answer rather than the whole corpus.
        assert_eq!(corpus.search("   ", None, None)["total"], 0);
    }

    #[test]
    fn a_search_limit_cannot_be_talked_above_the_cap() {
        let corpus = Corpus::new();
        let out = corpus.search("a", None, Some(100_000));
        assert!(out["hits"].as_array().expect("hits").len() <= SEARCH_MAX_LIMIT);
    }

    #[test]
    fn the_process_corpus_is_one_corpus() {
        assert!(std::sync::Arc::ptr_eq(&shared(), &shared()));
    }
}
