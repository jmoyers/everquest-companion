//! `src/main/modules/character.ts` — the active CharacterRef, the current zone, and WHAT LEVEL YOU
//! ARE. Three facts on one transport so a view can subscribe to "who am I / where am I / what am I"
//! without a bespoke channel.
//!
//! THE REF IS PUSHED IN, NOT FOLDED. `index.ts` resolves which log to tail and calls
//! `setCharacter(ref)`; zone and level come off the stream. Here the ref is a CONSTRUCTION input
//! (`ClusterDeps::character`), derived from the log's own filename exactly as the golden recorder
//! does it (`goldenOracle.mts characterOf`) — `eqlog_<Name>_<server>.<slice>.txt`. It is the one
//! field in this cluster whose value is a fact about the RUN rather than about the log's contents,
//! which is why it travels as a parameter and not as a constant.
//!
//! THE LEVEL FACT (JOS-192): latest statement wins, `/who` breaks a tie, and it NEVER enters the
//! ding series. A `/who` row is not a level-up — putting it in `leveling` or `progression` would
//! fabricate a ding, and the chart, the per-level history and the next-level projection are all
//! anchored on that series. "What level am I right now" is a fact about the CHARACTER.
//!
//! AND ITS `seq` IS ITS OWN REVISION, NOT THE LAST EVENT'S — the JOS-87 rule. `useModule` dedupes
//! with `d.seq <= knownSeq`, so a module whose state can move WITHOUT a log event needs a counter
//! of its own; this one has always had such an input (`setCharacter` advanced no seq), and a `/who`
//! typed to correct a wrong loadout is usually the only line the log produces for minutes. The
//! counter never resets: a seq that went backwards is a re-hydration signal to an overlay and a
//! permanently-dropped delta to the main window, and neither is wanted here.
//!
//! WHAT `reset()` KEEPS: the ref. `reset()` runs on (re)load and the ref is set by index.ts right
//! before/after it; everything LOG-DERIVED clears, because a rescan re-folds it and a character
//! switch must not carry the previous character's zone or level into the new one.

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

/// `laterStatement` — LATEST WINS, `/who` breaks a tie. Total, so the winner is decided by the
/// rule rather than by arrival order; the TS relies on identity to tell "held won" from "next won",
/// which is spelled here as an explicit bool.
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
    /// See the header: the module's OWN revision, monotonic for the life of the process.
    rev: i64,
    /// The ref waiting for the FIRST reset, and the DOUBLE option is the point: the outer one is
    /// "has `setCharacter` been called yet", the inner one is the ref it was called WITH. The
    /// composition root always makes that call — with a null ref if it has no character — and the
    /// call itself moves the revision, so a `None` ref and no call at all are two different
    /// published seqs. See `reset`.
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

    /// Fold one statement in. Nothing moves when the statement already held WINS — the
    /// same-second ding behind a `/who`. A row RESTATING a level you already dinged to does move,
    /// because the level is not the whole fact: the AGE of the statement is what the surfaces
    /// hedge on, and "your own /who said 50 four seconds ago" is a different thing to know than
    /// "your last level-up said 50 three days ago".
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
        // AND THE CONSTRUCTION REF LANDS HERE, ONCE — because `rev` IS the published `seq` and
        // the order of the two bumps is observable. Over there the composition root spends them
        // as `registry.reset()` then `modules.character.setCharacter(ref)`, in that order and
        // once (`foldArm.mts construct`, `pipeline.ts`); a Rust cluster is built BEFORE
        // `Fold::new` resets it, so applying the parameter in the constructor would spend the
        // second bump first and every published seq would be right by accident and wrong in
        // order. Draining it on the first reset puts both bumps back where the golden recorded
        // them.
        if let Some(character) = self.pending.take() {
            self.set_character(character);
        }
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        match ev.kind() {
            "epoch" => {
                // Character rebirth: the level and zone of the wiped character say nothing about
                // this one. The ref is index.ts's and stays.
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

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.rev)
    }

    fn snapshot(&self) -> Value {
        // `character` publishes NULL when absent (the TS field is `CharacterRef | null`), while
        // `zone`/`level` are `undefined` and are DROPPED by `JSON.stringify`. Three fields, two
        // different absences, and the golden records the difference.
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
