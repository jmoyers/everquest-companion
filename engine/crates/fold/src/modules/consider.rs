//! `src/main/modules/consider.ts` — what have I been sizing up, and what does it drop.
//!
//! ONE ROW PER MOB: a mob conned five times during one pull is one row with `cons: 5`, carrying the
//! MOST RECENT con's facts, and a re-con moves it to the front. That is why the ring is a `Vec` with
//! a move-to-end rather than a `JsMap`, whose `insert` would keep an existing key's position.
//!
//! THE RING IS A STATE, not a feed, so the startup replay DOES fold into it and the card is
//! populated the moment the app opens. What replay must not do is walk the corpus once per con:
//! enrichment is live-only plus a bounded backfill on the first tick, and `knowledge` is therefore
//! ABSENT from a row nothing has answered for — never an empty record meaning "we checked".
//!
//! THE OWN-LOOT INDEX is folded here, owned here, and published nowhere; it reaches a client only
//! through `knowledge.mob`'s `dropsSeen`, a join made on demand. One owner keeps it in step with the
//! ring rather than a second subscription that could reset out of phase. Its refusals are the part
//! that matters: a destroy names no mob and is not a drop, and a `loot` event returns before the
//! consider fold.
//!
//! THE KNOWLEDGE PROBE IS SYNCHRONOUS and arrives through [`crate::EqModule::install_knowledge`],
//! installed by `engined`'s production construction and by nothing else. The corpus is in this
//! process, so a live con enriches inside the same fold and the row is published complete — there is
//! nothing to await and so no out-of-band seq bump. A name the corpus lacks is announced by the
//! INGEST as a `knowledgeMiss`; the app fetches and pushes the answer back with `knowledge.define`.
//!
//! A CON CARD IS A HAND-BACK, not a callback: [`ConEvent`]s buffered on the live path and taken by
//! the ingest, the shape `take_fires` and `take_derived` already are. The card is a thing that
//! happened and the ring is a state, which is why the two are folded side by side.

use crate::event::Event;
use crate::knowledge::{Knowledge, OwnLoot, SeenDrop};
use crate::EqModule;
use eqlog::jsstr::{js_trim, JS_S};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

/// How many considered mobs the ring keeps. Oldest fall off the FRONT.
pub const CONSIDER_CAP: usize = 50;

/// How many of the ring's newest rows get enriched when the live tail takes over.
///
/// The newest handful is what a user looks at right after opening the app; everything else resolves
/// on hover. The number is the app's, kept verbatim: a bound that silently became "all fifty" would
/// be this module deciding something its twin decided differently.
pub const CONSIDER_BACKFILL: usize = 12;

/// The canonical identity key for a mob name: trim + lowercase, plus two folds.
///
/// The QUOTE FOLD lets one mob be one key across three sources — the log writes ``Innoruuk`s
/// Chosen`` with a backtick where the wiki writes a typographic or a straight apostrophe. The
/// COPY-NUMBER STRIP removes a trailing ` (N)`, which is ours and not the game's: `combat/world.ts
/// label()` appends the spawn generation when more than one instance of a name has been engaged, and
/// a copy number is not part of an identity. Only DIGITS are stripped — a parenthesized WORD is part
/// of the name (the instance tiers, "(Awakened)" and friends).
///
/// It does NOT strip the leading article: "a giant rat" and "giant rat" are different wiki pages and
/// the log always prints the article, so keeping it is honest and lossless.
pub fn mob_key(name: &str) -> String {
    static COPY: OnceLock<Regex> = OnceLock::new();
    static QUOTE: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let copy = COPY.get_or_init(|| Regex::new(&format!(r"{s}*\([0-9]+\)$", s = JS_S)).unwrap());
    let quote = QUOTE.get_or_init(|| Regex::new(r"[`\u{2019}\u{00b4}]").unwrap());
    let spaces = SPACES.get_or_init(|| Regex::new(&format!(r"{s}+", s = JS_S)).unwrap());
    // The TS chain in its own order: trim, strip the copy number, lowercase, fold the quotes,
    // collapse whitespace runs. Lowercasing before the quote fold is free and is kept in place so
    // the two files read the same.
    let a = copy.replace(js_trim(name), "");
    let b = a.to_lowercase();
    let c = quote.replace_all(&b, "'");
    spaces.replace_all(&c, " ").into_owned()
}

/// Pick the display name to keep for a mob seen under two casings.
///
/// A lowercase-initial spelling is the mob's true name ("a zol ghoul knight"); a sentence-start
/// capital is an artifact of the line it appeared in, and a consider line always sentence-cases the
/// leading article. So a lowercase spelling wins, and otherwise the first one seen is kept.
fn adopt_display(current: Option<&str>, incoming: &str) -> String {
    let Some(current) = current else {
        return incoming.to_string();
    };
    if current == incoming {
        return current.to_string();
    }
    // ASCII, as the JS `/^[a-z]/` spells it.
    let lower_initial = |s: &str| s.starts_with(|c: char| c.is_ascii_lowercase());
    if lower_initial(incoming) || !lower_initial(current) {
        incoming.to_string()
    } else {
        current.to_string()
    }
}

/// Every optional field is `skip_serializing_if` because the shape it is checked against was
/// recorded through `JSON.stringify`, which DROPS an `undefined`: a row conned before any zone line
/// carries no `zone` at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsiderRow {
    id: String,
    mob: String,
    ts: i64,
    rare: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    level: Option<i64>,
    faction: String,
    difficulty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    zone: Option<String>,
    cons: i64,
    /// The mob's drop knowledge, once a lookup has answered for it. ABSENT until then, and absent
    /// for the whole of every historical fold — never an empty record meaning "we checked".
    ///
    /// Enrichment is per-MOB rather than per-con: a re-con keeps whatever was already learned.
    #[serde(skip_serializing_if = "Option::is_none")]
    knowledge: Option<Value>,
}

/// One live `/con`, as the con-card hook saw it.
///
/// A HAND-BACK rather than a callback, for the same ownership reason `take_fires` and `take_derived`
/// are: a module cannot hold a mutable reference to something the registry is iterating. It carries
/// the four facts the card is built from and nothing derived — deriving is the serve layer's job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConEvent {
    /// The `ts` of the con line — the LOG's own clock.
    pub ts: i64,
    /// The mob's display name, exactly as the line printed it. Uncapped and unfolded here: capping
    /// is a rendering guarantee and folding is an identity, and both belong to whoever builds the
    /// card rather than to the module that saw the line.
    pub mob: String,
    /// The level the con line stated, when it stated one.
    pub level: Option<i64>,
    /// The ` - a rare creature - ` infix was on the line.
    pub rare: bool,
    /// The zone the player was in — the module's own, which is why this is not simply the event.
    pub zone: Option<String>,
}

#[derive(Default)]
pub struct ConsiderModule {
    /// Newest LAST (the UI reverses it), one entry per mob key. A linear scan is `indexOf`'s own
    /// cost and the ring is capped at fifty.
    ring: Vec<ConsiderRow>,
    zone: Option<String>,
    seq: i64,
    /// The live cons folded since the last drain, in fold order, waiting for the ingest. Empty for a
    /// historical fold by construction — see `on_event`'s gate.
    cons: Vec<ConEvent>,
    /// The own-loot index's accumulation, kept because this module owns its lifetime. Published
    /// nowhere, read through [`EqModule::as_own_loot`].
    own_loot: OwnLootIndex,
    /// `deps.lookupMob`, or `None` in every construction but the production one.
    knowledge: Option<Arc<dyn Knowledge>>,
    /// The first live tick has run ⇒ the historical replay is over.
    backfilled: bool,
    /// The announce cursor — see [`crate::announce`].
    ///
    /// `self.ring` is the whole snapshot: the own-loot index is published nowhere and `zone` is the
    /// label the NEXT row will carry. So every `loot` line this module folds — most of what it sees
    /// on a farming session — changes real state that no client can read, and says nothing.
    ///
    /// The backfill announces too: `on_tick`'s first beat rewrites published rows with no event
    /// behind it, and `probe` bumps per row it actually fills, so an empty backfill is silent.
    announce: crate::announce::Announce,
}

/// The own-loot index: the note, the reset, and the read the mob knowledge join is built on.
///
/// Published in no snapshot — what it accumulates reaches a client through `knowledge.mob`'s
/// `dropsSeen`, a join made on demand rather than module state. Its refusals are the load-bearing
/// part: a destroy that reached this index would become a documented-looking drop on a mob card.
#[derive(Default)]
struct OwnLootIndex {
    /// mob key → LOWERCASED item key → (display spelling, count, newest ts).
    ///
    /// The display spelling kept is the first one recorded for that key. Insertion order is not
    /// published — see `drops_across` for the tiebreak that makes the read total without it.
    by_mob:
        std::collections::HashMap<String, std::collections::HashMap<String, (String, i64, i64)>>,
}

impl OwnLootIndex {
    fn reset(&mut self) {
        self.by_mob.clear();
    }

    /// A row with NO SOURCE is refused, which is what makes every drop-rate surface built on this
    /// index structurally immune to the destroy line. An EMPTY item is refused too: a nameless row
    /// is not a drop.
    fn note(&mut self, item: &str, source: Option<&str>, ts: i64, count: i64) {
        let Some(source) = source else { return };
        if item.trim().is_empty() {
            return;
        }
        let entry = self
            .by_mob
            .entry(mob_key(source))
            .or_default()
            .entry(item.trim().to_lowercase())
            .or_insert_with(|| (item.trim().to_string(), 0, 0));
        entry.1 += count;
        entry.2 = entry.2.max(ts);
    }
}

/// The read side, for the knowledge join.
///
/// Most-looted first, ties broken by recency, over the union of every spelling one creature answers
/// to. Counts ADD and `lastTs` takes the later, because two spellings of one corpse's owner are one
/// mob's history.
///
/// A single spelling is not a special case here, unlike the TS, which short-circuits: the merge
/// below IS that path for one key — one map read, one sort, no extra allocation.
impl OwnLoot for OwnLootIndex {
    fn drops_across(&self, spellings: &[String]) -> Vec<SeenDrop> {
        let mut merged: std::collections::HashMap<String, SeenDrop> =
            std::collections::HashMap::new();
        for spelling in spellings {
            let Some(items) = self.by_mob.get(&mob_key(spelling)) else {
                continue;
            };
            for (key, (display, count, last_ts)) in items {
                let row = merged.entry(key.clone()).or_insert_with(|| SeenDrop {
                    item: display.clone(),
                    count: 0,
                    last_ts: 0,
                });
                row.count += count;
                row.last_ts = row.last_ts.max(*last_ts);
            }
        }
        let mut out: Vec<SeenDrop> = merged.into_values().collect();
        // Count, then recency, then BY NAME. The TS sort falls back to a `Map`'s insertion order,
        // which `by_mob` (a `HashMap`) does not have — so the third term is what makes this answer
        // the same answer twice.
        out.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then(b.last_ts.cmp(&a.last_ts))
                .then(a.item.cmp(&b.item))
        });
        out
    }
}

impl ConsiderModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// The live cons this module saw since the last drain. See [`ConEvent`].
    pub fn take_cons(&mut self) -> Vec<ConEvent> {
        std::mem::take(&mut self.cons)
    }

    /// The change signal: the last event folded. Coarse — this module keeps no revision counter —
    /// but it never misses a change to the ring.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.seq
    }

    /// Ask the knowledge lookup about one row.
    ///
    /// Two refusals: no lookup installed (every construction but the production one), and a row that
    /// already carries knowledge (enrichment is per-MOB, so a re-con keeps what was learned). The
    /// TS's third — a row that fell off the ring — cannot happen without an await.
    ///
    /// It asks with the row's DISPLAY name, because the alias boundary lives inside the lookup and
    /// the display name is what the log said.
    fn probe(&mut self, index: usize) {
        let Some(knowledge) = self.knowledge.clone() else {
            return;
        };
        let Some(row) = self.ring.get(index) else {
            return;
        };
        if row.knowledge.is_some() {
            return;
        }
        let answer = knowledge.mob(&row.mob.clone(), &self.own_loot);
        if let Some(row) = self.ring.get_mut(index) {
            row.knowledge = Some(answer.record);
            self.announce.changed(self.seq);
        }
    }

    /// Fold ONE `consider` line into the ring: upsert the mob's single row (moving it to the front
    /// and bumping `cons`), then evict past the cap.
    fn fold_consider(&mut self, ev: &Event, live: bool) {
        let mob = ev.str("mob").unwrap_or_default();
        let id = mob_key(mob);
        if id.is_empty() {
            return;
        }
        let prev = self.ring.iter().position(|r| r.id == id);
        let (display, cons, held) = match prev {
            Some(i) => (
                adopt_display(Some(&self.ring[i].mob), mob),
                self.ring[i].cons + 1,
                self.ring[i].knowledge.clone(),
            ),
            None => (adopt_display(None, mob), 1, None),
        };
        let row = ConsiderRow {
            id,
            mob: display,
            ts: ev.ts(),
            rare: ev.bool("rare"),
            level: ev.int("level"),
            faction: ev.str("faction").unwrap_or_default().to_string(),
            difficulty: ev.str("difficulty").unwrap_or_default().to_string(),
            zone: self.zone.clone(),
            cons,
            // Enrichment is per-MOB, not per-con: a re-con keeps whatever was already learned.
            knowledge: held,
        };
        if let Some(i) = prev {
            self.ring.remove(i);
        }
        self.ring.push(row);
        while self.ring.len() > CONSIDER_CAP {
            self.ring.remove(0);
        }
        self.announce.changed(self.seq);
        // Live cons enrich immediately; historical ones wait for the bounded backfill on the first
        // tick, so a startup replay of a month of logs never walks the corpus once per con.
        if live {
            self.probe(self.ring.len() - 1);
        }
    }
}

impl EqModule for ConsiderModule {
    fn id(&self) -> &'static str {
        "consider"
    }

    fn reset(&mut self) {
        self.ring.clear();
        self.zone = None;
        self.seq = 0;
        self.announce.reset();
        self.own_loot.reset();
        // A card for the world that just ended is not a card: anything undrained when a rebirth or
        // switch landed describes a creature nobody is looking at any more.
        self.cons.clear();
        // A character (re)load is a new replay, so the tick that follows is the new replay's "the
        // history is over" edge. The LOOKUP is not cleared: it is a handle on committed data, not on
        // this character's world.
        self.backfilled = false;
    }

    /// `live` decides two different things: it keeps the knowledge PROBE off the replay path, and
    /// it keeps the CON CARD off it — a card is a thing that happens, and a historical line never
    /// draws one.
    fn on_event(&mut self, ev: &Event, live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth: everything before the boundary belongs to a dead same-name
            // character, the loot history included, which would otherwise credit this character
            // with drops it never saw. The ZONE is not cleared: the character has not moved.
            "epoch" => {
                self.ring.clear();
                self.own_loot.reset();
                self.announce.changed(self.seq);
            }
            // Neither of the next two publishes anything: `zone` is the label the next row carries,
            // and the own-loot index appears in no snapshot.
            "zone" => self.zone = ev.str("zone").map(str::to_string),
            "loot" => {
                // `You successfully destroyed 38 Bone Chips.` rides the loot lane and names no mob,
                // and this index answers "what has this MOB handed me". Refused at the decision.
                if ev.str("disposition") == Some("destroyed") {
                    return;
                }
                // Stacked loots add their COUNT, not 1.
                self.own_loot.note(
                    ev.str("item").unwrap_or_default(),
                    ev.str("source"),
                    ev.ts(),
                    ev.int("count").unwrap_or(1),
                );
            }
            "consider" => {
                self.fold_consider(ev, live);
                // Beside the fold rather than inside it, because the two answer different questions:
                // `fold_consider` maintains a state, and this is a thing that happened.
                if live {
                    self.cons.push(ConEvent {
                        ts: ev.ts(),
                        mob: ev.str("mob").unwrap_or_default().to_owned(),
                        level: ev.int("level"),
                        rare: ev.bool("rare"),
                        zone: self.zone.clone(),
                    });
                }
            }
            _ => {}
        }
    }

    /// The dirty bit: a con that reached the ring, a backfill that enriched a row, or a rebirth.
    /// See the `announce` field.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    /// The first live tick is "the historical replay is over". A historical fold never reaches here,
    /// so `knowledge` stays absent from every row it produced. `_now_ms` is unused deliberately:
    /// this is an EDGE, not a clock reading.
    fn on_tick(&mut self, _now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        if self.backfilled {
            return;
        }
        self.backfilled = true;
        let from = self.ring.len().saturating_sub(CONSIDER_BACKFILL);
        for index in from..self.ring.len() {
            self.probe(index);
        }
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.ring })
    }

    /// The con-card seam. See [`ConsiderModule::take_cons`].
    fn take_cons(&mut self) -> Vec<ConEvent> {
        Self::take_cons(self)
    }

    fn as_own_loot(&self) -> Option<&dyn OwnLoot> {
        Some(&self.own_loot)
    }

    fn install_knowledge(&mut self, k: &Arc<dyn Knowledge>) {
        self.knowledge = Some(Arc::clone(k));
    }
}

#[cfg(test)]
mod tests {
    use super::{ConsiderModule, CONSIDER_BACKFILL};
    use crate::event::Event;
    use crate::knowledge::{Answer, Knowledge, Miss, OwnLoot, SeenDrop};
    use crate::EqModule;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    /// A lookup that answers everything and remembers who asked. What it answers with does not
    /// matter here; whether it was called at all is the claim.
    #[derive(Default)]
    struct Recorder {
        asked: Mutex<Vec<String>>,
    }

    impl Knowledge for Recorder {
        fn item(&self, name: &str) -> Answer {
            Answer {
                record: json!({ "name": name }),
                found: true,
            }
        }
        fn identity_keys(&self, mob: &str) -> Vec<String> {
            vec![super::mob_key(mob)]
        }
        fn mob(&self, name: &str, loot: &dyn OwnLoot) -> Answer {
            self.asked
                .lock()
                .expect("the recorder")
                .push(name.to_owned());
            let seen = loot.drops_across(&self.identity_keys(name));
            Answer {
                record: json!({ "name": name, "dropsSeen": seen.len() }),
                found: true,
            }
        }
        /// Stands in for a catalog, so it says yes — and the point is that nothing on this module's
        /// path asks. The con-card refusal that reads it lives one layer up (`engined::concard`).
        fn known_mob(&self, _name: &str) -> bool {
            true
        }
        fn take_misses(&self) -> Vec<Miss> {
            Vec::new()
        }
    }

    fn ev(json: &str) -> Event<'static> {
        Event::from_json(json).expect("a JSON object")
    }

    fn con(seq: i64, mob: &str) -> String {
        format!(
            r#"{{"kind":"consider","mob":"{mob}","rare":false,"level":38,"faction":"dubious","difficulty":"Looks kind of dangerous.","seq":{seq},"ts":1787181707000,"raw":"x"}}"#
        )
    }

    fn rows(module: &ConsiderModule) -> Vec<Value> {
        module.snapshot()["state"]
            .as_array()
            .expect("an array")
            .clone()
    }

    #[test]
    fn with_no_lookup_installed_knowledge_is_absent_from_every_row() {
        // The default construction has no lookup, so `knowledge` is missing from every row — never
        // an empty record meaning "we checked".
        let mut module = ConsiderModule::new();
        module.on_event(&ev(&con(1, "a sand giant")), false);
        module.on_event(&ev(&con(2, "a sand giant")), true);
        module.on_tick(1_787_181_708_000, &[]);
        for row in rows(&module) {
            assert_eq!(row.get("knowledge"), None, "{row}");
        }
    }

    #[test]
    fn a_live_con_enriches_inside_the_same_fold_and_a_historical_one_does_not() {
        let recorder = Arc::new(Recorder::default());
        let mut module = ConsiderModule::new();
        module.install_knowledge(&(Arc::clone(&recorder) as Arc<dyn Knowledge>));

        module.on_event(&ev(&con(1, "a hill giant")), false);
        assert_eq!(
            rows(&module)[0].get("knowledge"),
            None,
            "a replay probes nothing"
        );
        assert!(recorder.asked.lock().expect("the recorder").is_empty());

        module.on_event(&ev(&con(2, "a sand giant")), true);
        let rows = rows(&module);
        assert_eq!(rows[1]["knowledge"]["name"], "a sand giant");
        assert_eq!(
            *recorder.asked.lock().expect("the recorder"),
            vec!["a sand giant".to_owned()],
            "asked with the row's DISPLAY name"
        );
    }

    #[test]
    fn a_re_con_keeps_what_was_learned_and_asks_nothing_twice() {
        // Enrichment is per-MOB, not per-con: the row carries the previous knowledge forward and
        // `probe` returns early on a row that already has one.
        let recorder = Arc::new(Recorder::default());
        let mut module = ConsiderModule::new();
        module.install_knowledge(&(Arc::clone(&recorder) as Arc<dyn Knowledge>));
        module.on_event(&ev(&con(1, "a sand giant")), true);
        module.on_event(&ev(&con(2, "a sand giant")), true);
        let rows = rows(&module);
        assert_eq!(rows.len(), 1, "one row per mob");
        assert_eq!(rows[0]["cons"], 2);
        assert!(rows[0]["knowledge"].is_object());
        assert_eq!(recorder.asked.lock().expect("the recorder").len(), 1);
    }

    #[test]
    fn the_first_live_tick_backfills_the_newest_rows_and_only_the_newest() {
        // The replay is over, so enrich what the user is about to look at. Bounded at
        // CONSIDER_BACKFILL, and once — the second tick does nothing.
        let recorder = Arc::new(Recorder::default());
        let mut module = ConsiderModule::new();
        module.install_knowledge(&(Arc::clone(&recorder) as Arc<dyn Knowledge>));
        for seq in 0..(CONSIDER_BACKFILL as i64 + 5) {
            module.on_event(&ev(&con(seq, &format!("mob number {seq}"))), false);
        }
        assert!(recorder.asked.lock().expect("the recorder").is_empty());

        module.on_tick(1_787_181_708_000, &[]);
        assert_eq!(
            recorder.asked.lock().expect("the recorder").len(),
            CONSIDER_BACKFILL,
            "the newest handful, not the whole ring"
        );
        let rows = rows(&module);
        assert_eq!(
            rows[0].get("knowledge"),
            None,
            "the oldest rows resolve on demand"
        );
        assert!(rows[rows.len() - 1]["knowledge"].is_object());

        module.on_tick(1_787_181_709_000, &[]);
        assert_eq!(
            recorder.asked.lock().expect("the recorder").len(),
            CONSIDER_BACKFILL,
            "the edge is an edge"
        );
    }

    #[test]
    fn the_own_loot_index_reads_back_what_it_folded_and_refuses_a_destroy() {
        let mut module = ConsiderModule::new();
        let loot = |seq: i64, item: &str, source: &str, count: i64, ts: i64| {
            format!(
                r#"{{"kind":"loot","item":"{item}","source":"{source}","count":{count},"seq":{seq},"ts":{ts},"raw":"x"}}"#
            )
        };
        module.on_event(&ev(&loot(1, "Giant Toe", "a sand giant", 2, 100)), false);
        module.on_event(&ev(&loot(2, "giant toe", "A Sand Giant", 1, 300)), false);
        module.on_event(&ev(&loot(3, "Amber", "a sand giant", 1, 200)), false);
        // A destroy names no mob and is not a drop.
        module.on_event(
            &ev(
                r#"{"kind":"loot","item":"Bone Chips","disposition":"destroyed","count":38,"seq":4,"ts":400,"raw":"x"}"#,
            ),
            false,
        );

        let index = module.as_own_loot().expect("consider owns the index");
        let seen = index.drops_across(&["a sand giant".to_owned()]);
        assert_eq!(
            seen,
            vec![
                SeenDrop {
                    item: "Giant Toe".into(),
                    count: 3,
                    last_ts: 300
                },
                SeenDrop {
                    item: "Amber".into(),
                    count: 1,
                    last_ts: 200
                },
            ],
            "case-folded onto one key, counts added, newest ts kept, most-looted first"
        );
        assert!(index
            .drops_across(&["nothing at all".to_owned()])
            .is_empty());

        // …and a character rebirth drops the history with the ring: it belonged to a dead
        // same-name character.
        module.on_event(&ev(r#"{"kind":"epoch","seq":5,"ts":500,"raw":"x"}"#), false);
        assert!(module
            .as_own_loot()
            .expect("the index")
            .drops_across(&["a sand giant".to_owned()])
            .is_empty());
    }

    #[test]
    fn the_union_across_two_spellings_is_one_creatures_history() {
        // The index files a drop under the corpse's LOG name while a boss card asks with the ROSTER
        // name. Counts ADD and `lastTs` takes the later.
        let mut module = ConsiderModule::new();
        for (seq, source, ts) in [(1_i64, "Cazic-Thule", 100_i64), (2, "Cazic Thule", 400)] {
            module.on_event(
                &ev(&format!(
                    r#"{{"kind":"loot","item":"Glowing Black Stone","source":"{source}","seq":{seq},"ts":{ts},"raw":"x"}}"#
                )),
                false,
            );
        }
        let index = module.as_own_loot().expect("the index");
        let seen = index.drops_across(&["cazic thule".to_owned(), "cazic-thule".to_owned()]);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].count, 2);
        assert_eq!(seen[0].last_ts, 400);
    }
}
