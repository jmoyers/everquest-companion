//! `src/main/modules/consider.ts` — "what have I been sizing up, and what does it drop" (Task #63).
//!
//! ONE ROW PER MOB. A mob conned five times during one pull is one row with `cons: 5`, not five
//! rows — the real log does that constantly (the biggest run is a goblin magician conned nine times
//! inside thirty seconds), and five identical lines answer the question worse than one. The row
//! carries the MOST RECENT con's facts and a re-con moves it to the front, which is why the ring is
//! a `Vec` with a move-to-end rather than a `JsMap`: `insert` on an existing key would keep its
//! position, and this module deliberately does the opposite.
//!
//! HISTORY vs LIVE — deliberately DIFFERENT from the event feed one file over. The feed admits
//! nothing historical because a feed is a stream of things that just happened. This ring is a
//! STATE ("the mobs you've been conning"), so the startup replay DOES fold into it and the card is
//! populated the moment the app opens. What replay does NOT do is fire hundreds of wiki lookups:
//! enrichment is live-only plus a bounded backfill on the first wall-clock tick, and `knowledge` is
//! therefore ABSENT from every row in every golden — never an empty record meaning "we checked"
//! (law 1).
//!
//! THE OWN-LOOT INDEX, which this module OWNS the lifetime of, is folded here and published
//! nowhere. `mobLookup`'s shared `MobLootIndex` is fed by every `loot` event — historical included,
//! since your loot history is exactly what makes it useful — and reset on epoch, so that one owner
//! keeps it in step with the ring instead of a second bus subscription that could reset out of
//! phase. `foldArm.mts` passes a REAL one (`ownLoot: new MobLootIndex()`), which is why the loot
//! branch below is a fold rather than a skip; what it accumulates reaches `snapshot()` through
//! nothing, so the goldens constrain the COUNTS not at all and the branch is ported for its
//! REFUSALS, which are the part that could move the ring's own lifetime:
//!   * A DESTROY IS NEVER A DROP (JOS-401). `You successfully destroyed 38 Bone Chips.` rides the
//!     loot lane and names no mob; this index answers "what has this MOB handed me", so the row has
//!     nothing to say to it. The refusal is stated where the decision is made rather than inferred
//!     from a guard two files away.
//!   * A `loot` event RETURNS, so it can never reach the consider fold below it.
//!
//! THE PROBE IS REAL NOW (JOS-486), AND IT IS SYNCHRONOUS. `deps.lookupMob` arrives through
//! [`crate::EqModule::install_knowledge`] — installed by `engined`'s PRODUCTION construction and by
//! nothing else, so `foldArm.mts`'s world (the one all six goldens were recorded in, whose header
//! calls the two knowledge lookups absent outright) is still exactly this module with no lookup at
//! all. What changed is only what a LIVE con does when one IS installed: over there the answer may
//! be a wiki round trip, so the row is appended and `knowledge` lands later as its own delta; here
//! the committed corpus is an in-memory index in this very process, so a live con enriches inside
//! the same fold and the row is published complete. There is nothing to await and therefore no
//! out-of-band seq bump — the TS bumps `seq` on the async landing so `useModule`'s gap check accepts
//! a delta with no event behind it, and a bump here would put this module's published seq ahead of
//! the event it folded for no reader's benefit.
//!
//! WHAT A MISS DOES: nothing, here. The engine ships without a network stack (boundary verdict 5),
//! so a name the corpus lacks is recorded by the knowledge implementation and announced by the
//! INGEST as a `knowledgeMiss` frame; the app fetches and pushes the answer back with
//! `knowledge.define`. This module simply keeps whatever the local sources knew, which is what
//! `lookupMob` returns for a missing page anyway.
//!
//! THE BACKFILL IS PORTED WITH THE PROBE. `onTick` over there does one thing — probe the newest
//! [`CONSIDER_BACKFILL`] rows the replay left in the ring, on the FIRST live tick, which is the
//! module contract's "the historical replay is over" edge. A live engine ticks (`Fold::tick`, owner
//! ruling 22) and a historical fold never does (`fold_bytes` does not call it, and neither does the
//! oracle harness), so the equivalence law is untouched: the goldens still record `knowledge` absent
//! from every row.
//!
//! THE CON-CARD HOOK IS PORTED NOW (JOS-487), AND IT IS INVERTED. Over there `pipeline.ts` installs
//! `setConCardHook` and this module calls synchronously INTO Electron mid-fold; boundary verdict 2
//! makes it a server-emitted `world.conCard` frame instead, so what lives here is a HAND-BACK —
//! [`ConEvent`]s buffered on the live path and taken by the ingest, exactly the shape `take_fires`
//! and `take_derived` already are. Nothing about the RING moved: the card is a thing that happened
//! and the ring is a state, which is why the two are folded side by side rather than one from the
//! other.

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

/// How many of the ring's newest rows get enriched when the live tail takes over — `CONSIDER_
/// BACKFILL`, verbatim.
///
/// A FULL RING WOULD BE FIFTY MOB PAGES, and over there that meant fifty wiki lookups on a cold
/// cache; the newest handful is what a user actually looks at right after opening the app, and
/// everything else resolves on hover. In this process the answer is a map read rather than a
/// request, so the etiquette argument no longer binds — but the NUMBER is kept because the behaviour
/// is what is being ported: a bound that silently became "all fifty" would be this module quietly
/// deciding something its twin decided differently.
pub const CONSIDER_BACKFILL: usize = 12;

/// `shared/mobKey.ts mobKey` — THE canonical identity key for a mob name.
///
/// `parseCommon.idKey`'s rule (trim + lowercase) plus two folds. The QUOTE FOLD is what lets one
/// mob be one key across three sources: the log writes ``Innoruuk`s Chosen`` with a backtick, the
/// wiki writes it with a typographic or a straight apostrophe. The COPY-NUMBER STRIP removes a
/// trailing ` (N)`, which is OURS and not the game's — `combat/world.ts label()` appends the spawn
/// generation when more than one instance of a name has been engaged, and a copy number is not part
/// of an identity. Only DIGITS are stripped: a parenthesized WORD is part of the name (the instance
/// tiers, "(Awakened)" and friends).
///
/// It does NOT strip the leading article, deliberately: "a giant rat" and "giant rat" are different
/// wiki pages and the log always prints the article, so keeping it is both honest and lossless.
pub fn mob_key(name: &str) -> String {
    static COPY: OnceLock<Regex> = OnceLock::new();
    static QUOTE: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let copy = COPY.get_or_init(|| Regex::new(&format!(r"{s}*\([0-9]+\)$", s = JS_S)).unwrap());
    let quote = QUOTE.get_or_init(|| Regex::new(r"[`\u{2019}\u{00b4}]").unwrap());
    let spaces = SPACES.get_or_init(|| Regex::new(&format!(r"{s}+", s = JS_S)).unwrap());
    // The TS chain, in its own order: trim, strip the copy number, lowercase, fold the quotes,
    // collapse the whitespace runs. Lowercasing BEFORE the quote fold is free (no quote has a
    // case) and is kept in place so the two files read the same.
    let a = copy.replace(js_trim(name), "");
    let b = a.to_lowercase();
    let c = quote.replace_all(&b, "'");
    spaces.replace_all(&c, " ").into_owned()
}

/// `adoptDisplay` — pick the display name to keep for a mob seen under two casings.
///
/// THE SAME RULE as `combat/world.ts adoptDisplay`: a lowercase-initial spelling is the mob's true
/// name ("a zol ghoul knight") and a sentence-start capital is an artifact of the line it appeared
/// in — and a consider line ALWAYS sentence-cases the leading article. So a lowercase spelling
/// wins, and otherwise the first one seen is kept.
fn adopt_display(current: Option<&str>, incoming: &str) -> String {
    let Some(current) = current else {
        return incoming.to_string();
    };
    if current == incoming {
        return current.to_string();
    }
    // `/^[a-z]/` — ASCII, as JS spells it.
    let lower_initial = |s: &str| s.starts_with(|c: char| c.is_ascii_lowercase());
    if lower_initial(incoming) || !lower_initial(current) {
        incoming.to_string()
    } else {
        current.to_string()
    }
}

/// `ConsiderRow`. Every optional field is `skip_serializing_if` because the golden was recorded
/// through `JSON.stringify`, which DROPS an `undefined` — a row conned before any zone line
/// carries no `zone` at all, and `knowledge` is absent from all six goldens.
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
    /// for the whole of every historical fold — never an empty record meaning "we checked" (law 1),
    /// which is exactly what all six goldens record.
    ///
    /// Enrichment is per-MOB rather than per-con: a re-con keeps whatever was already learned.
    #[serde(skip_serializing_if = "Option::is_none")]
    knowledge: Option<Value>,
}

/// ONE LIVE `/con`, AS THE CON-CARD HOOK SAW IT (JOS-487, boundary verdict 2).
///
/// THE SEAM THE HEADER SAID WAS NOT PORTED, now ported the only way this crate can port it. Over
/// there `pipeline.ts` installs `considerModule.setConCardHook((ev, zone) => …)` and the module
/// calls INTO Electron mid-fold; the verdict inverts that, so this is a HAND-BACK rather than a
/// callback — the same shape `take_fires` and `take_derived` already are, and for the same
/// ownership reason: a module cannot hold a mutable reference to something the registry is
/// iterating. It carries the four facts the card is built from and nothing derived, because
/// deriving is the serve layer's job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConEvent {
    /// The `ts` of the con line — THE LOG'S OWN CLOCK.
    pub ts: i64,
    /// The mob's display name, exactly as the line printed it. Uncapped and unfolded here: capping
    /// is a rendering guarantee and folding is an identity, and both belong to whoever builds the
    /// card rather than to the module that saw the line.
    pub mob: String,
    /// The level the con line stated, when it stated one.
    pub level: Option<i64>,
    /// The ` - a rare creature - ` infix was on the line.
    pub rare: bool,
    /// The zone the player was in — the module's own, which is the second argument the TS hook
    /// takes and the reason this is not simply the event.
    pub zone: Option<String>,
}

#[derive(Default)]
pub struct ConsiderModule {
    /// Newest LAST (the UI reverses it), one entry per mob key. A linear scan is `indexOf`'s own
    /// cost and the ring is capped at fifty.
    ring: Vec<ConsiderRow>,
    zone: Option<String>,
    seq: i64,
    /// THE LIVE CONS FOLDED SINCE THE LAST DRAIN, in fold order, waiting for the ingest to take
    /// them. Structurally empty for a historical fold — see [`ConEvent`] and `on_event`'s gate.
    cons: Vec<ConEvent>,
    /// The shared own-loot index's ACCUMULATION, kept because this module owns its lifetime. It is
    /// published nowhere, and it is READ through [`EqModule::as_own_loot`] — see the header.
    own_loot: OwnLootIndex,
    /// `deps.lookupMob`, or `None` in every construction but the production one. See the header.
    knowledge: Option<Arc<dyn Knowledge>>,
    /// The first live tick has run ⇒ the historical replay is over (`backfilled`).
    backfilled: bool,
}

/// `mobLookupParse.ts MobLootIndex` — the note, the reset, and (since JOS-486) the READ that the
/// mob knowledge join is built on.
///
/// It is still published in no snapshot: what it accumulates reaches a client through
/// `knowledge.mob`'s `dropsSeen`, which is a JOIN made on demand rather than module state. That is
/// why the goldens constrain its counts not at all and why the branch was originally ported for its
/// REFUSALS — and why those refusals matter more now, not less: a destroy that reached this index
/// would become a documented-looking drop on a mob card.
#[derive(Default)]
struct OwnLootIndex {
    /// mob key → LOWERCASED item key → (display spelling, count, newest ts).
    ///
    /// The item key is folded exactly as `MobLootIndex.note` folds it (`item.trim().toLowerCase()`)
    /// and the DISPLAY spelling kept is the first one recorded for that key, which is the sentence
    /// `note()` writes over there. Insertion order is not published — see `drops_across` for the
    /// tiebreak that makes the read total without it.
    by_mob:
        std::collections::HashMap<String, std::collections::HashMap<String, (String, i64, i64)>>,
}

impl OwnLootIndex {
    fn reset(&mut self) {
        self.by_mob.clear();
    }

    /// `note(item, source, ts, count)` — a row with NO SOURCE is refused, which is what makes every
    /// drop-rate surface built on this index structurally immune to the destroy line. An EMPTY item
    /// is refused for the same reason the TS refuses it (`if (!item || !source) return`): a nameless
    /// row is not a drop.
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

/// THE READ SIDE, for the knowledge join — `MobLootIndex.dropsAcross`.
///
/// Most-looted first, ties broken by recency, over the union of every spelling one creature answers
/// to. Counts ADD and `lastTs` takes the later, because two spellings of one corpse's owner are one
/// mob's history; the DISPLAY spelling kept is the first the index recorded for that item, which is
/// what `note()` already decides within a single key.
///
/// A SINGLE SPELLING IS NOT A SPECIAL CASE HERE, unlike over there: the TS short-circuits to
/// `drops()` to guarantee a byte-identical path for the 7.9k unaliased mobs, and the merge below IS
/// that path for one key — one map read, one sort, no allocation the single-key form would not make.
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
        // `b.count - a.count || b.lastTs - a.lastTs`, and then BY NAME. The TS sort is over a
        // `Map`'s insertion order, which is deterministic there and is not here (`by_mob` is a
        // `HashMap`), so the third term is what makes this answer the same answer twice.
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

    /// THE LIVE CONS THIS MODULE SAW SINCE THE LAST DRAIN (JOS-487). See [`ConEvent`].
    pub fn take_cons(&mut self) -> Vec<ConEvent> {
        std::mem::take(&mut self.cons)
    }

    /// THE CHANGE SIGNAL — the last event folded, coarse like `buffs`' (this module keeps no
    /// revision counter). It never misses a change to the ring.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.seq
    }

    /// ASK THE KNOWLEDGE LOOKUP ABOUT ONE ROW — `probe`, minus the promise.
    ///
    /// Three refusals, all of them the TS's: no lookup installed (every construction but the
    /// production one), a row that already carries knowledge (enrichment is per-MOB, and a re-con
    /// keeps what was learned), and — implicitly — a row that has fallen off the ring, which cannot
    /// happen here because the answer is not in flight across any await.
    ///
    /// IT ASKS WITH THE ROW'S DISPLAY NAME, exactly as `probe` does (`lookup(row.mob)`), because the
    /// alias boundary lives inside `lookupMob` and the display name is what the log said.
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
        // LIVE cons enrich immediately; historical ones wait for the bounded backfill on the first
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
        self.own_loot.reset();
        // A CARD FOR THE WORLD THAT JUST ENDED IS NOT A CARD (JOS-487). Anything the ingest had not
        // drained by the time a rebirth or a character switch landed describes a creature the player
        // was sizing up in a world nobody is looking at any more.
        self.cons.clear();
        // `backfilled = false` — a character (re)load is a new replay, and the tick that follows it
        // is the new replay's "the history is over" edge. The LOOKUP is not cleared: it is a handle
        // on committed data, not on this character's world.
        self.backfilled = false;
    }

    /// `live` DECIDES TWO THINGS NOW, and they are different things. JOS-486 reads it to keep the
    /// knowledge PROBE off the replay path; JOS-487 reads it for the CON CARD, because a card is a
    /// thing that happens and the third of `main/conCard.ts`'s three refusals is that a historical
    /// line never draws one. Both refusals are structural here: a startup replay of a month of logs
    /// can reach neither.
    fn on_event(&mut self, ev: &Event, live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth (Task #49): everything before the boundary belongs to a dead
            // same-name character — including the loot history the own-loot index is built from,
            // which would otherwise credit this character with drops it never saw. Note the ZONE
            // is NOT cleared: the character is standing where they were standing.
            "epoch" => {
                self.ring.clear();
                self.own_loot.reset();
            }
            "zone" => self.zone = ev.str("zone").map(str::to_string),
            "loot" => {
                // A destroy names no mob and is not a drop — see the header.
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
                // THE CON CARD'S OWN LINE (JOS-487), and it is beside the fold rather than inside it
                // because the two answer different questions: `fold_consider` maintains a STATE (the
                // mobs you have been conning, history included) while this is a thing that HAPPENED.
                // The zone is the module's own, which is the second argument the TS hook takes.
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

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    /// THE FIRST LIVE TICK IS "THE HISTORICAL REPLAY IS OVER" — `onTick`, verbatim in shape.
    ///
    /// A historical fold never reaches here (`fold_bytes` calls no tick and neither does the oracle
    /// harness), so every golden still records `knowledge` absent from every row. `_now_ms` is
    /// unused deliberately: this is an EDGE, not a clock reading — the module wants to know that the
    /// tail has taken over, and the number that says so is not read.
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

    /// THE CON-CARD SEAM (JOS-487). See `EqModule::take_cons`.
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

    /// A lookup that answers everything and REMEMBERS WHO ASKED. What it answers with does not
    /// matter here — the corpus is `knowledge`'s to prove — but whether it was called at all is the
    /// whole of the oracle's claim.
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
        /// This double stands in for a CATALOG, so it says yes — and the point of it saying so
        /// here is that nothing on this module's path asks. The con-card refusal reads it, and
        /// that refusal lives one layer up (`engined::concard`).
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
        // THE GOLDEN'S OWN CLAIM. `foldArm.mts` injects no `lookupMob`, so every recorded snapshot
        // has `knowledge` missing from every consider row — never an empty record meaning "we
        // checked" (law 1). This is the parity construction, and it is the DEFAULT one.
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
        // Enrichment is per-MOB, not per-con — the TS carries `knowledge: prev?.knowledge` for
        // exactly this, and `probe` returns early on a row that already has one.
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
        // `onTick`'s whole job: the replay is over, so enrich what the user is about to look at.
        // Bounded at CONSIDER_BACKFILL, and once — the second tick does nothing.
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
        // A DESTROY NAMES NO MOB AND IS NOT A DROP (JOS-401) — and it is refused here, at the
        // decision, rather than inferred from a guard two files away.
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
        // The JOS-142 read: the index files a drop under the corpse's LOG name and a boss card asks
        // with the ROSTER name. Counts ADD and `lastTs` takes the later.
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
