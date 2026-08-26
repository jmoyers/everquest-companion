//! `src/main/modules/classUnlocks.ts` — the classes this character may run as a primary, as the
//! LOG stated them, in the order it stated them.
//!
//! DEDUPED BY CLASS, FIRST SIGHTING WINS (law 2: keys are case-folded, displays are raw). The
//! achievement fires once per class per character, so a second row would mean a re-scan read the
//! same line — and keeping the FIRST instant is what makes the timestamp worth carrying.

use crate::event::Event;
use crate::EqModule;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassUnlockRow {
    ts: i64,
    class_name: String,
}

#[derive(Default)]
pub struct ClassUnlocksModule {
    unlocks: Vec<ClassUnlockRow>,
    seen: HashSet<String>,
    seq: i64,
}

impl ClassUnlocksModule {
    pub fn new() -> Self {
        Self::default()
    }
}

impl EqModule for ClassUnlocksModule {
    fn id(&self) -> &'static str {
        "classUnlocks"
    }

    fn reset(&mut self) {
        self.unlocks.clear();
        self.seen.clear();
        self.seq = 0;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        if ev.kind() == "epoch" {
            self.unlocks.clear();
            self.seen.clear();
            return;
        }
        if ev.kind() != "classUnlock" {
            return;
        }
        let name = ev.str("className").unwrap_or_default();
        if !self.seen.insert(name.to_lowercase()) {
            return;
        }
        self.unlocks.push(ClassUnlockRow {
            ts: ev.ts(),
            class_name: name.to_string(),
        });
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.unlocks })
    }
}
