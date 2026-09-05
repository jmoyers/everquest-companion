//! `src/main/modules/loot.ts` — the self-loot history: a `LootEvent` tagged with the zone it
//! happened in, append-only.
//!
//! A destroy rides the same row shape as every other disposition, which is why it was given a
//! disposition rather than an event kind. This module takes no position on what any of them mean.
//!
//! Every optional field is omitted when absent, never written as `null`: the published shape came
//! through `JSON.stringify`, which drops a key whose value is `undefined`. `zone` is the module's
//! own state (the last zone line seen) and is absent for rows folded before the scan reached one.

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

/// Read-only accessors, for the view layer and nothing else.
///
/// A view reads these rather than the published JSON: `snapshot()` serializes the whole ledger into
/// a fresh `Value` tree, so re-deriving a window from one would pay for every row in the log to
/// draw fifty, on every service of a subscription. Nothing here is new state — these are the fields
/// `snapshot()` already publishes, named.
impl LootRow {
    /// The loot's own instant, in epoch millis — the log's clock.
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
    /// How a reader knows the ledger moved, without reading it. Bumped on every push and clear, and
    /// absent from `snapshot()`, so nothing published can see it.
    ///
    /// A length would nearly do — this vector only grows or empties — but a rebirth that clears 500
    /// rows and folds 500 more between two services would leave the length where it was, and the
    /// view would serve a dead character's window. A counter cannot do that.
    revision: u64,
    /// The announce cursor — see [`crate::announce`]. It follows the same two arms `revision` does,
    /// which are the only ones that touch `self.loot`.
    announce: crate::announce::Announce,
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
        self.announce.reset();
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth: loot before the boundary is a dead same-name character's. `zone`
            // is kept — it is world state, not character-scoped.
            "epoch" => {
                self.loot.clear();
                self.revision += 1;
                self.announce.changed(self.seq);
            }
            // Not a change to published state: `zone` is the label the NEXT row will carry, and
            // `snapshot()` publishes `self.loot` alone.
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
                self.announce.changed(self.seq);
            }
            _ => {}
        }
    }

    /// The view layer's door onto this module — see [`crate::EqModule::as_loot`].
    fn as_loot(&self) -> Option<&LootModule> {
        Some(self)
    }

    /// Moves when the LEDGER moved, not when the log did. See the `announce` field.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.loot })
    }
}
