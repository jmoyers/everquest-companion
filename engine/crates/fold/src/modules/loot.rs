//! `src/main/modules/loot.ts` — the self-loot history: a `LootEvent` tagged with the zone it
//! happened in, append-only.
//!
//! IT CARRIES THE DESTROY UNCHANGED (JOS-401): `disposition: 'destroyed'` rides the same row shape
//! as every other disposition, which is the whole reason a destroy was given a disposition instead
//! of an event kind. This module takes NO position on what any of them mean.
//!
//! EVERY OPTIONAL FIELD IS OMITTED WHEN ABSENT, never written as `null` — `JSON.stringify` drops a
//! key whose value is `undefined`, and the golden was recorded through it, so a row with no
//! `source` has no `source` key at all. `zone` is the module's OWN state (the last zone line seen)
//! and is absent for every row folded before the scan reached one.

use crate::event::Event;
use crate::EqModule;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct LootRow {
    ts: i64,
    item: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disposition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created: Option<String>,
}

/// READ-ONLY ACCESSORS, for the view layer and nothing else (JOS-480).
///
/// `loot.ledger` is the first product view source, and it reads THESE rather than the module's
/// published JSON. That is not an optimization dressed as a design: `snapshot()` serializes the
/// whole ledger into a fresh `serde_json::Value` tree, and a view that re-derived its window from
/// one would pay for every row in the log to draw fifty of them — every time a subscription is
/// serviced. Reading the rows directly costs the window and nothing else.
///
/// NOTHING HERE IS MUTABLE and nothing here is new state: these are the fields `snapshot()` already
/// publishes, named. The published shape is untouched, so the six-slice oracle is untouched.
impl LootRow {
    /// The loot's own instant, in epoch millis — THE LOG'S clock.
    #[must_use]
    pub fn ts(&self) -> i64 {
        self.ts
    }
    /// The item's name, as the line spelled it.
    #[must_use]
    pub fn item(&self) -> &str {
        &self.item
    }
    /// The corpse or container the line named, when it named one.
    #[must_use]
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }
    /// The zone the module was standing in when the row was folded. Absent for rows folded before
    /// the scan reached a zone line.
    #[must_use]
    pub fn zone(&self) -> Option<&str> {
        self.zone.as_deref()
    }
    /// Where a looted-and-routed item went (`sold`, `destroyed`, `combined`, a storage name).
    /// Absent means ordinary kept loot.
    #[must_use]
    pub fn disposition(&self) -> Option<&str> {
        self.disposition.as_deref()
    }
    /// The stack size the line stated, when it stated one.
    #[must_use]
    pub fn count(&self) -> Option<i64> {
        self.count
    }
    /// What a `combined` row produced.
    #[must_use]
    pub fn created(&self) -> Option<&str> {
        self.created.as_deref()
    }
}

#[derive(Default)]
pub struct LootModule {
    loot: Vec<LootRow>,
    zone: Option<String>,
    seq: i64,
    /// HOW A READER KNOWS THE LEDGER MOVED, without reading it (JOS-480).
    ///
    /// Bumped on every push and on every clear, and it is NOT module state: it is absent from
    /// `snapshot()`, so no golden and no oracle can see it. A length would nearly do — this vector
    /// only ever grows or empties — but "nearly" is the word that makes a change signal wrong: a
    /// rebirth boundary that clears 500 rows and folds 500 more between two services of a
    /// subscription would leave the length exactly where it was, and the view would serve a dead
    /// character's window as if nothing had happened. A counter cannot do that.
    revision: u64,
}

impl LootModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// The ledger, oldest first — the order the rows were folded in. See [`LootRow`]'s accessors.
    #[must_use]
    pub fn rows(&self) -> &[LootRow] {
        &self.loot
    }

    /// A monotonic signal that moves whenever the ledger could have changed. See the field.
    #[must_use]
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

impl EqModule for LootModule {
    fn id(&self) -> &'static str {
        "loot"
    }

    fn reset(&mut self) {
        self.loot.clear();
        self.zone = None;
        self.seq = 0;
        self.revision += 1;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth (Task #49): loot before the boundary is a dead same-name
            // character's. `zone` is KEPT — it is world state, not character-scoped.
            "epoch" => {
                self.loot.clear();
                self.revision += 1;
            }
            "zone" => self.zone = ev.str("zone").map(str::to_string),
            "loot" => {
                self.loot.push(LootRow {
                    ts: ev.ts(),
                    item: ev.str("item").unwrap_or_default().to_string(),
                    source: ev.str("source").map(str::to_string),
                    zone: self.zone.clone(),
                    disposition: ev.str("disposition").map(str::to_string),
                    count: ev.int("count"),
                    created: ev.str("created").map(str::to_string),
                });
                self.revision += 1;
            }
            _ => {}
        }
    }

    /// The view layer's door onto this module — see [`crate::EqModule::as_loot`].
    fn as_loot(&self) -> Option<&LootModule> {
        Some(self)
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.loot })
    }
}
