//! `src/main/modules/character.ts` — the active CharacterRef, the current zone and the current
//! level, on one transport.
//!
//! The ref is pushed in, not folded: a construction input (`ClusterDeps::character`) derived from
//! the log's filename, so it states a fact about the RUN rather than about the log's contents.
//! `reset()` keeps it; everything log-derived clears.
//!
//! The level is the latest statement with `/who` breaking a tie, and it never enters the ding
//! series — a `/who` row is not a level-up, and the chart, the per-level history and the projection
//! are all anchored on that series.
//!
//! `seq` is this module's own revision, monotonic and never reset: state here moves without a log
//! event (`set_character`), and `useModule` dedupes with `d.seq <= knownSeq`.

use crate::event::Event;
use crate::EqModule;
use serde::Serialize;
use serde_json::{json, Value};

/// `shared/currentLevel.ts LevelStatement`.
#[derive(Debug, Clone, Serialize)]
pub struct LevelStatement {
    level: i64,
    /// LOG timestamp of the line that stated it (not a wall clock).
    ts: i64,
    source: &'static str,
}

/// `laterStatement` — latest wins, `/who` breaks a tie. Total, so the winner is decided by the rule
/// rather than by arrival order.
fn next_wins(held: &LevelStatement, next: &LevelStatement) -> bool {
    if next.ts > held.ts {
        return true;
    }
    if next.ts < held.ts {
        return false;
    }
    next.source == "who"
}

#[derive(Default)]
pub struct CharacterModule {
    /// The `CharacterRef` as JSON, or `None` for the null the snapshot publishes.
    character: Option<Value>,
    zone: Option<String>,
    level: Option<LevelStatement>,
    /// The module's own revision, monotonic for the life of the process. See the header.
    rev: i64,
    /// The ref waiting for the first reset. The double option is the point: the outer is "has
    /// `set_character` been called yet", the inner is the ref it was called with — and the call
    /// itself moves the revision, so a `None` ref and no call at all publish different seqs.
    pending: Option<Option<Value>>,
}

impl CharacterModule {
    pub fn new(character: Option<Value>) -> Self {
        CharacterModule {
            character: None,
            zone: None,
            level: None,
            rev: 0,
            pending: Some(character),
        }
    }

    /// `setCharacter` — called by index.ts when the tailed character changes.
    pub fn set_character(&mut self, character: Option<Value>) {
        self.character = character;
        self.rev += 1;
    }

    /// Fold one statement in. A row restating a level you already dinged to still moves the
    /// revision: the age of the statement is part of the fact, and the surfaces hedge on it.
    fn state_level(&mut self, next: LevelStatement) {
        if let Some(held) = &self.level {
            if !next_wins(held, &next) {
                return;
            }
        }
        self.level = Some(next);
        self.rev += 1;
    }
}

impl EqModule for CharacterModule {
    fn id(&self) -> &'static str {
        "character"
    }

    fn reset(&mut self) {
        // The ref survives; see the header.
        self.zone = None;
        self.level = None;
        self.rev += 1;
        // The construction ref lands here, once: `rev` IS the published `seq`, so the ORDER of the
        // two bumps is observable, and the composition root spends them as reset-then-setCharacter.
        // A cluster built before `Fold::new` resets it would spend them the other way round.
        if let Some(character) = self.pending.take() {
            self.set_character(character);
        }
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        match ev.kind() {
            "epoch" => {
                // Character rebirth: the wiped character's level and zone say nothing about this
                // one. The ref is pushed in and stays.
                self.zone = None;
                self.level = None;
                self.rev += 1;
            }
            "zone" => {
                let zone = ev.str("zone").map(str::to_string);
                if zone != self.zone {
                    self.zone = zone;
                    self.rev += 1;
                }
            }
            "level" => self.state_level(LevelStatement {
                level: ev.int("level").unwrap_or(0),
                ts: ev.ts(),
                source: "ding",
            }),
            "selfWho" => self.state_level(LevelStatement {
                level: ev.int("level").unwrap_or(0),
                ts: ev.ts(),
                source: "who",
            }),
            _ => {}
        }
    }

    /// The same cursor `snapshot` publishes, without building the state to read it.
    fn published_seq(&self) -> Option<i64> {
        Some(self.rev)
    }

    fn snapshot(&self) -> Value {
        // Three fields, two different absences: `character` publishes null (the TS field is
        // `CharacterRef | null`) while `zone`/`level` are `undefined` and `JSON.stringify` drops
        // them.
        let mut state = serde_json::Map::new();
        state.insert(
            "character".to_string(),
            self.character.clone().unwrap_or(Value::Null),
        );
        if let Some(zone) = &self.zone {
            state.insert("zone".to_string(), json!(zone));
        }
        if let Some(level) = &self.level {
            state.insert("level".to_string(), serde_json::to_value(level).expect("a"));
        }
        json!({ "seq": self.rev, "state": Value::Object(state) })
    }
}
