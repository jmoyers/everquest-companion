//! `src/main/modules/eventFeed.ts` — the live "things worth noticing" ring behind the events
//! overlay (Task #59), and the one module in cluster 2c whose whole argument is a REFUSAL.
//!
//! THE HYDRATION RULE IS THE MODULE (AGENTS.md "Celebrations"). A startup replay must not spam the
//! feed with hours-old events, and rather than seed a baseline and diff against it, this module
//! simply admits nothing historical: `onEvent` writes the seq and returns the instant `live` is
//! false. The ring therefore starts EMPTY and only ever holds what the tail observed. That is the
//! silent baseline, expressed as "nothing historical is admitted" — and it is why all six goldens
//! record this module's state as `[]` while its `seq` is the last event of the slice. THE GOLDENS
//! ARE UNTOUCHED BY JOS-486 FOR EXACTLY THAT REASON: the oracle folds `live: false` from the first
//! byte to the last (`fold_bytes`), so every line below the gate is unreachable to it whether or
//! not a knowledge lookup is installed.
//!
//! ── TWO OF THE FOUR SOURCES ARE REAL NOW (JOS-486) ─────────────────────────────────────────────
//!
//!   * THE LOOT SOURCE was structurally absent, not skipped: it admits a row only through
//!     `deps.lookupItem`, and the world the goldens were recorded in injects none (`foldArm.mts
//!     construct` passes `lookupItem` nowhere, and that file's header says so: "the two knowledge
//!     lookups are absent"). It arrives here through [`crate::EqModule::install_knowledge`],
//!     installed by `engined`'s PRODUCTION construction and by nothing else. Over there the probe is
//!     a promise and the row lands on a later flush; here the committed corpus is an in-memory index
//!     in this process, so a notable pickup is admitted inside the same fold. The ADMISSION RULE is
//!     unchanged and is the shared predicate's: lore, quest-flagged, or used by at least one known
//!     quest (`shared/itemKnowledge.ts isNotableKnowledge`) — a recipe ingredient is not notable,
//!     because every bone chip in the game is one.
//!   * THE CONSIDER SOURCE needed no lookup at all (the log line already carries every field of the
//!     row) and needed two things this crate did not have: the 10 s per-mob anti-spam window and the
//!     difficulty-clause table. Both are ported below.
//!
//! THE OTHER TWO REMAIN OFF THE BUS. `noteAlertFire` and `report` arrive out of band from main and
//! the renderer; the first is boundary verdict 4's `alerts.fires` stream (the engine SENDS fires
//! rather than folding them into a ring — JOS-482), and the second is a renderer detector. Neither
//! is a fold's to reproduce, and a module that invented either would be inventing a row.

use crate::event::Event;
use crate::knowledge::Knowledge;
use crate::EqModule;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// How many entries the feed keeps. Oldest fall off the back.
pub const FEED_CAP: usize = 100;

/// CONSIDER ANTI-SPAM WINDOW — `CONSIDER_FEED_DEDUPE_MS`, verbatim.
///
/// Re-conning the same mob inside this window appends NO second feed row. The real log makes this
/// mandatory rather than decorative: conning is a reflex, and the same mob routinely appears two or
/// three times a second or two apart (Guard V`Lex at 18:56:38 / :44 / :45; Karam Dragonforge four
/// times in 25 seconds). The window is per MOB and it lives HERE rather than in the consider module,
/// because that ring already collapses repeats structurally (one row per mob) — the feed is the only
/// surface a burst could actually spam.
pub const CONSIDER_FEED_DEDUPE_MS: i64 = 10_000;

/// The difficulty clause → a short label for a dense row — `CONSIDER_DIFFICULTY_SHORT`, verbatim.
///
/// Keys are the phrases observed in the full-log sweep, with the gendered pronoun folded onto the
/// neuter form by [`difficulty_short`]. A phrase nobody has seen returns nothing and the caller
/// shows the VERBATIM clause — never a guessed tier, and deliberately no numeric ordering, which
/// the log does not state.
const CONSIDER_DIFFICULTY_SHORT: &[(&str, &str)] = &[
    ("what would you like your tombstone to say?", "suicide"),
    (
        "looks like it would wipe the floor with you!",
        "wipes the floor",
    ),
    ("it appears to be quite formidable.", "formidable"),
    ("looks like quite a gamble.", "a gamble"),
    ("looks kind of dangerous.", "dangerous"),
    (
        "you would probably win this fight... it's not certain though.",
        "probably win",
    ),
    (
        "looks quite risky, but might be worth a try.",
        "worth a try",
    ),
    ("looks kind of risky, but you might win.", "might win"),
    ("looks kind of risky... you might win.", "might win"),
    ("you could probably win this fight.", "likely win"),
    ("looks like a reasonably safe opponent.", "safe"),
];

/// Short label for a difficulty clause, or `None` when nobody has seen the phrase.
///
/// `\b(?:he|she)\b → it` and a whitespace collapse, spelled without a regex because both are word
/// operations on an ASCII table: the JS `\b` is between a word character and a non-word one, which
/// for this table is exactly "the whole token is `he` or `she`".
#[must_use]
pub fn difficulty_short(difficulty: &str) -> Option<&'static str> {
    let folded = difficulty
        .trim()
        .to_lowercase()
        .split_whitespace()
        .map(|word| {
            // The word boundary is around the LETTERS, so trailing punctuation stays put:
            // `she.` folds to `it.` exactly as the JS replace does.
            let head: String = word.chars().take_while(char::is_ascii_alphabetic).collect();
            if head == "he" || head == "she" {
                format!("it{}", &word[head.len()..])
            } else {
                word.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    CONSIDER_DIFFICULTY_SHORT
        .iter()
        .find(|(phrase, _)| *phrase == folded)
        .map(|(_, short)| *short)
}

/// The consider context of a `con` row — `FeedConsider`, carried structurally so the overlay can
/// draw the faction rung rather than re-deriving it from prose.
#[derive(Debug, Clone, Serialize)]
pub struct FeedConsider {
    /// The faction rung the con line printed.
    pub faction: String,
    /// The level it stated, when it stated one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<i64>,
    /// The rare infix was on the line.
    pub rare: bool,
    /// VERBATIM difficulty clause.
    pub difficulty: String,
}

/// One row of the feed — `FeedEvent`. Every optional field is `skip_serializing_if` because the
/// golden was recorded through `JSON.stringify`, which DROPS an `undefined`.
#[derive(Debug, Clone, Serialize)]
pub struct FeedEvent {
    /// `f1`, `f2`, … — monotonic per session, the React key and the dedupe handle.
    pub id: String,
    /// Which of the feed's four kinds this is.
    pub kind: &'static str,
    /// When, on the log's own clock.
    pub ts: i64,
    /// The line the overlay draws.
    pub title: String,
    /// The second line, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The wiki page this row deep-links to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// The consider context, on a `con` row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub con: Option<FeedConsider>,
}

#[derive(Default)]
pub struct EventFeedModule {
    /// Newest LAST (the UI reverses it). Never grows on a historical fold — see the header.
    ring: Vec<FeedEvent>,
    seq: i64,
    id_counter: i64,
    /// mob name (trimmed, lowercased) → the ts of the last con ADMITTED. See
    /// [`CONSIDER_FEED_DEDUPE_MS`].
    last_con: HashMap<String, i64>,
    /// `deps.lookupItem`, or `None` in every construction but the production one.
    knowledge: Option<Arc<dyn Knowledge>>,
}

impl EventFeedModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// THE FEED PULL SEAM (JOS-487) — the ring as the module keeps it, OLDEST FIRST. The view
    /// reverses it, as the overlay does.
    ///
    /// IT HAS SOMETHING IN IT NOW, and that is JOS-486 landing rather than this seam changing: the
    /// loot source's item probe is a real in-process lookup, so a live loot line puts a row here.
    /// The seam was written when the ring could still only ever be empty, and the argument that
    /// justified it then is the one that still holds — the PROJECTION over a ring is a pure function
    /// and is pinned against a hand-built one, so a broken cell fails a test whether or not a fold
    /// can produce the entry it mangled.
    #[must_use]
    pub fn ring(&self) -> &[FeedEvent] {
        &self.ring
    }

    /// THE CHANGE SIGNAL — the module's published `seq`, which this module bumps on every APPEND as
    /// well as on every event (see `append` below). Coarse in the same way `buffs`' is, and for the
    /// same reason: there is no separate revision counter to read.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.seq
    }

    /// Append one row and bump the seq.
    ///
    /// THE SEQ BUMP IS THE TS's AND IT IS NOT AN ACCIDENT. Over there an append carries no fresh
    /// `LogEvent` seq (the loot probe resolves asynchronously, alert fires and renderer reports
    /// arrive out of band), so the module bumps its own so `useModule`'s gap check — a delta's seq
    /// must EXCEED the known one — accepts the delta. It is kept even where this crate's append is
    /// synchronous, because the number a module publishes is the module's own contract and a fold
    /// that quietly published a different one would be a divergence nobody could see.
    fn append(&mut self, row: FeedEvent) {
        self.id_counter += 1;
        let row = FeedEvent {
            id: format!("f{}", self.id_counter),
            ..row
        };
        self.ring.push(row);
        while self.ring.len() > FEED_CAP {
            self.ring.remove(0);
        }
        self.seq += 1;
    }

    /// Append a consider row, unless the same mob was already admitted inside the anti-spam window.
    ///
    /// NO LOOKUP GATES ADMISSION — every field came straight off the log line, so the row is honest
    /// with no corpus read at all. What the mob DROPS is the hover card's job, answered by
    /// `knowledge.mob`. `page` is deliberately absent: the wiki page is not known at this point and
    /// a fabricated link is worse than none.
    fn note_consider(&mut self, ev: &Event) {
        let mob = ev.str("mob").unwrap_or_default();
        let ts = ev.ts();
        let key = mob.trim().to_lowercase();
        if let Some(last) = self.last_con.get(&key) {
            if ts - last < CONSIDER_FEED_DEDUPE_MS {
                return;
            }
        }
        self.last_con.insert(key, ts);
        let level = ev.int("level");
        let rare = ev.bool("rare");
        let difficulty = ev.str("difficulty").unwrap_or_default().to_string();
        // `Lvl 38 · suicide`, with a `· rare` marker when the line carried the rare-creature infix.
        // An unrecognized clause falls back to the VERBATIM clause rather than a guessed label.
        let mut bits: Vec<String> = Vec::new();
        if let Some(level) = level {
            bits.push(format!("Lvl {level}"));
        }
        bits.push(
            difficulty_short(&difficulty)
                .map_or_else(|| difficulty.clone(), std::borrow::ToOwned::to_owned),
        );
        if rare {
            bits.push("rare".to_owned());
        }
        self.append(FeedEvent {
            id: String::new(),
            kind: "con",
            ts,
            title: mob.to_owned(),
            detail: Some(bits.join(" · ")),
            page: None,
            con: Some(FeedConsider {
                faction: ev.str("faction").unwrap_or_default().to_string(),
                level,
                rare,
                difficulty,
            }),
        });
    }

    /// Probe a freshly-looted item and append a row IFF it is notable — `probeLoot`.
    ///
    /// A DESTROY IS ADMITTED AND SAYS SO (JOS-401). The row is still worth noticing — a lore or
    /// quest item leaving your bags is exactly the kind of thing this ring is for — but it is not a
    /// pickup, so it never borrows the `from <mob>` caption a loot row wears. The detail is the
    /// whole difference, because that caption is all a feed row ever says about how the item moved.
    fn probe_loot(&mut self, ev: &Event) {
        let Some(knowledge) = self.knowledge.clone() else {
            return;
        };
        let item = ev.str("item").unwrap_or_default();
        if item.is_empty() {
            return;
        }
        let destroyed = ev.str("disposition") == Some("destroyed");
        let source = ev.str("source");
        let answer = knowledge.item(item);
        if !is_notable(&answer.record) {
            return;
        }
        let title = answer
            .record
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .unwrap_or(item)
            .to_owned();
        let detail = if destroyed {
            Some("destroyed".to_owned())
        } else {
            source.map(|mob| format!("from {mob}"))
        };
        self.append(FeedEvent {
            id: String::new(),
            kind: "loot",
            ts: ev.ts(),
            title,
            detail,
            page: answer
                .record
                .get("page")
                .and_then(Value::as_str)
                .map(str::to_owned),
            con: None,
        });
    }
}

/// `shared/itemKnowledge.ts isNotableKnowledge` — lore, quest-flagged, or used by at least one
/// known quest. Everything else is ordinary vendor trash.
///
/// TRADESKILL RECIPES DELIBERATELY DO NOT COUNT: this predicate drives the PUSH surfaces (the
/// pickups strip, this feed), and every bone chip and spider leg in the game is a recipe
/// ingredient. Recipes answer "what is it for" on the PULL surfaces instead.
fn is_notable(record: &Value) -> bool {
    let flag = |key: &str| record.get(key).and_then(Value::as_bool).unwrap_or(false);
    flag("lore")
        || flag("quest")
        || record
            .get("questUses")
            .and_then(Value::as_array)
            .is_some_and(|uses| !uses.is_empty())
}

impl EqModule for EventFeedModule {
    fn id(&self) -> &'static str {
        "eventFeed"
    }

    fn reset(&mut self) {
        // A character switch is a different world: drop the feed with the rest of the
        // character-scoped state. The LOOKUP is not cleared — it is a handle on committed data.
        self.ring.clear();
        self.seq = 0;
        self.id_counter = 0;
        self.last_con.clear();
    }

    /// `onEvent` records the seq of EVERY event and then returns unless `live`. That gate is the
    /// module — see the header — and it is the whole reason a knowledge lookup installed in
    /// production cannot move a single golden: the oracle folds nothing live.
    fn on_event(&mut self, ev: &Event, live: bool) {
        self.seq = ev.seq();
        if !live {
            return;
        }
        match ev.kind() {
            "consider" => self.note_consider(ev),
            "loot" => self.probe_loot(ev),
            _ => {}
        }
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.ring })
    }

    /// THE VIEW PULL SEAM (JOS-487). See `EqModule::as_event_feed`.
    fn as_event_feed(&self) -> Option<&EventFeedModule> {
        Some(self)
    }

    fn install_knowledge(&mut self, k: &Arc<dyn Knowledge>) {
        self.knowledge = Some(Arc::clone(k));
    }
}

#[cfg(test)]
mod tests {
    use super::{difficulty_short, is_notable, EventFeedModule, CONSIDER_FEED_DEDUPE_MS};
    use crate::event::Event;
    use crate::knowledge::{Answer, Knowledge, Miss, OwnLoot};
    use crate::EqModule;
    use serde_json::{json, Value};
    use std::sync::Arc;

    /// A lookup that answers from a table. It is the SHAPE of the production answer that matters
    /// here — the corpus itself is `knowledge`'s to prove, and this crate must not be able to reach
    /// it (that is the dependency direction the seam exists for).
    struct Table(Vec<(&'static str, Value)>);

    impl Knowledge for Table {
        fn item(&self, name: &str) -> Answer {
            match self.0.iter().find(|(key, _)| *key == name) {
                Some((_, record)) => Answer {
                    record: record.clone(),
                    found: true,
                },
                None => Answer {
                    record: json!({ "name": name, "lore": false, "quest": false, "questUses": [], "cached": false, "notFound": true }),
                    found: false,
                },
            }
        }
        fn identity_keys(&self, mob: &str) -> Vec<String> {
            vec![mob.to_lowercase()]
        }
        fn mob(&self, name: &str, _loot: &dyn OwnLoot) -> Answer {
            Answer {
                record: json!({ "name": name, "cached": true }),
                found: true,
            }
        }
        /// Every name this table is asked about is a mob, and nothing on the feed's path asks.
        fn known_mob(&self, _name: &str) -> bool {
            true
        }
        fn take_misses(&self) -> Vec<Miss> {
            Vec::new()
        }
    }

    fn state(module: &EventFeedModule) -> Vec<Value> {
        module.snapshot()["state"]
            .as_array()
            .expect("an array")
            .clone()
    }

    fn ev(json: &str) -> Event<'static> {
        Event::from_json(json).expect("a JSON object")
    }

    fn loot(seq: i64, item: &str) -> String {
        format!(
            r#"{{"kind":"loot","item":"{item}","source":"a sand giant","seq":{seq},"ts":1787181707000,"raw":"x"}}"#
        )
    }

    #[test]
    fn a_historical_fold_admits_nothing_however_notable_the_item() {
        // THE GOLDEN'S OWN CLAIM, pinned against the one change that could have broken it: a real
        // lookup installed. The oracle folds `live: false` from the first byte to the last.
        let mut feed = EventFeedModule::new();
        feed.install_knowledge(&(Arc::new(Table(vec![(
            "Rune of Al'Kabor",
            json!({ "name": "Rune of Al'Kabor", "lore": true, "quest": true, "questUses": [], "page": "Rune of Al'Kabor" }),
        )])) as Arc<dyn Knowledge>));
        feed.on_event(&ev(&loot(1, "Rune of Al'Kabor")), false);
        assert!(state(&feed).is_empty());
        assert_eq!(feed.snapshot()["seq"], 1, "the seq is still every event's");
    }

    #[test]
    fn a_live_notable_pickup_is_admitted_and_an_ordinary_one_is_not() {
        let mut feed = EventFeedModule::new();
        feed.install_knowledge(&(Arc::new(Table(vec![(
            "Rune of Al'Kabor",
            json!({ "name": "Rune of Al'Kabor", "lore": true, "quest": true, "questUses": [], "page": "Rune of Al'Kabor" }),
        )])) as Arc<dyn Knowledge>));
        feed.on_event(&ev(&loot(1, "Bone Chips")), true);
        assert!(state(&feed).is_empty(), "vendor trash is not notable");
        feed.on_event(&ev(&loot(2, "Rune of Al'Kabor")), true);
        let rows = state(&feed);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "f1");
        assert_eq!(rows[0]["kind"], "loot");
        assert_eq!(rows[0]["detail"], "from a sand giant");
        assert_eq!(rows[0]["page"], "Rune of Al'Kabor");
    }

    #[test]
    fn with_no_lookup_installed_the_loot_source_is_structurally_off() {
        // The parity construction, exactly: a module nobody installed a lookup into.
        let mut feed = EventFeedModule::new();
        feed.on_event(&ev(&loot(1, "Rune of Al'Kabor")), true);
        assert!(state(&feed).is_empty());
    }

    #[test]
    fn a_destroy_says_so_and_never_borrows_the_from_caption() {
        let mut feed = EventFeedModule::new();
        feed.install_knowledge(
            &(Arc::new(Table(vec![(
                "Bone Chips",
                json!({ "name": "Bone Chips", "lore": false, "quest": true, "questUses": [] }),
            )])) as Arc<dyn Knowledge>),
        );
        feed.on_event(
            &ev(
                r#"{"kind":"loot","item":"Bone Chips","disposition":"destroyed","seq":3,"ts":1787181707000,"raw":"x"}"#,
            ),
            true,
        );
        let rows = state(&feed);
        assert_eq!(rows[0]["detail"], "destroyed");
    }

    #[test]
    fn a_re_con_inside_the_window_appends_nothing() {
        let mut feed = EventFeedModule::new();
        let con = |seq: i64, ts: i64| {
            format!(
                r#"{{"kind":"consider","mob":"Guard V`Lex","rare":false,"level":38,"faction":"dubious","difficulty":"What would you like your tombstone to say?","seq":{seq},"ts":{ts},"raw":"x"}}"#
            )
        };
        feed.on_event(&ev(&con(1, 1_000_000)), true);
        feed.on_event(&ev(&con(2, 1_000_000 + CONSIDER_FEED_DEDUPE_MS - 1)), true);
        assert_eq!(state(&feed).len(), 1, "the burst is one row");
        feed.on_event(&ev(&con(3, 1_000_000 + CONSIDER_FEED_DEDUPE_MS)), true);
        let rows = state(&feed);
        assert_eq!(rows.len(), 2, "a genuine re-con later in the pull is a row");
        assert_eq!(rows[0]["detail"], "Lvl 38 · suicide");
        assert_eq!(rows[0]["con"]["faction"], "dubious");
    }

    #[test]
    fn an_unrecognized_difficulty_clause_falls_back_to_the_verbatim_one() {
        assert_eq!(
            difficulty_short("Looks like SHE would wipe the floor with you!"),
            Some("wipes the floor"),
            "the gendered variants fold onto the neuter key"
        );
        assert_eq!(
            difficulty_short("  He appears to be quite formidable. "),
            Some("formidable")
        );
        assert_eq!(difficulty_short("regards you with something new."), None);
    }

    #[test]
    fn notability_is_the_shared_predicate_and_a_recipe_is_not_notable() {
        assert!(is_notable(
            &json!({ "lore": true, "quest": false, "questUses": [] })
        ));
        assert!(is_notable(
            &json!({ "lore": false, "quest": true, "questUses": [] })
        ));
        assert!(is_notable(
            &json!({ "lore": false, "quest": false, "questUses": [{ "quest": "x" }] })
        ));
        assert!(!is_notable(
            &json!({ "lore": false, "quest": false, "questUses": [], "recipes": [{ "recipe": "Gnome Kabobs" }] })
        ));
    }
}
