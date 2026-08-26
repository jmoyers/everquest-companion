//! `src/main/modules/spellSets.ts` — what is in your gems, and which named set holds it (JOS-391).
//!
//! A SAVE IS AN INSTANT, A LOAD IS A BURST. `Spell set primary saved.` is a photograph: the set's
//! definition becomes the memorized state at that instant. `Spell set dam loaded.` is a starting
//! pistol — measured in the owner's log, the load line is followed in the SAME SECOND by ten
//! `You forget` lines and the memorizes trickle in over ten seconds — so a load opens a PENDING
//! window and the definition is taken when the burst SETTLES.
//!
//! SETTLE = 10 s with no memorize/forget/begin line, OR the next spell-set line, whichever comes
//! first. Both halves are needed; that file's header carries the log span that proves it.
//!
//! THE CLOCK IS THE LOG'S, and EVERY event advances it — a chat line at `load + 11s` is proof that
//! eleven seconds passed with no gem activity. `on_tick` does the same from the wall clock for a
//! live log that falls silent — driven since JOS-481 by `Fold::tick` engine-side as well as by the
//! app's own heartbeat — and it is never called on a historical fold, which is what keeps the
//! goldens a function of the bytes. Reading a wall clock anywhere else in this crate is forbidden
//! outright (ruling 18).
//!
//! THE MEMORIZED MAP'S ORDER IS PUBLISHED. `memorized` and every set's `spells` are
//! `[...map.values()]`, so the map's INSERTION order is the serialized array's — see `jsmap.rs`.
//!
//! ONE QUIRK PORTED VERBATIM: the epoch branch calls the module's own `reset()`, which zeroes
//! `seq` AFTER the `seq = ev.seq` at the top of `onEvent`. So this module — alone in the cluster —
//! reports seq 0 between the epoch event and the next event it folds. It is faithful, not a bug to
//! tidy: a golden recorded from a log whose LAST event trips the boundary would pin exactly that.

use crate::event::Event;
use crate::jsfn::memo_key;
use crate::jsmap::JsMap;
use crate::EqModule;
use eqlog::jsstr::js_trim;
use serde::Serialize;
use serde_json::{json, Value};

/// `SETTLE_MS` — no memorize or forget line for this long and a load's burst is over. Measured.
const SETTLE_MS: i64 = 10_000;

/// `SPELL_SETS_SHAPE_VERSION`.
const SPELL_SETS_SHAPE_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellSetDef {
    spells: Vec<String>,
    observed_at: i64,
    /// `'saved'` or `'loaded'` — which line defined it.
    source: &'static str,
}

/// A `loaded` line whose burst has not finished yet.
struct PendingLoad {
    set: String,
    /// The last memorize/forget/begin line seen since the load — the settle clock's anchor.
    last_activity_ts: i64,
}

#[derive(Default)]
pub struct SpellSetsModule {
    memorized: JsMap<String>,
    sets: JsMap<SpellSetDef>,
    pending: Option<PendingLoad>,
    seq: i64,
}

impl SpellSetsModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// A finished memorize loads the gem; a begin line only proves the player is still working.
    fn on_memorize(&mut self, ts: i64, spell: &str, done: bool) {
        self.note_activity(ts);
        if !done {
            return;
        }
        self.memorized
            .insert(memo_key(spell), js_trim(spell).to_string());
    }

    fn on_forget(&mut self, ts: i64, spell: &str) {
        self.note_activity(ts);
        self.memorized.remove(&memo_key(spell));
    }

    /// Gem activity keeps an open load window open.
    fn note_activity(&mut self, ts: i64) {
        if let Some(p) = self.pending.as_mut() {
            p.last_activity_ts = ts;
        }
    }

    /// A spell-set line CLOSES any open load first (the "whichever comes first" half of the settle
    /// rule) and then does its own work.
    fn on_spell_set(&mut self, ts: i64, set: &str, action: &str) {
        self.settle_now(ts);
        match action {
            "saved" => self.define(set.to_string(), ts, "saved"),
            "deleted" => {
                self.sets.remove(set);
            }
            // `loaded`: the bar is about to be rewritten. Nothing changes until the burst settles —
            // until then the set is still its PREVIOUS definition, which is the only reading that
            // never states something false.
            _ => {
                self.pending = Some(PendingLoad {
                    set: set.to_string(),
                    last_activity_ts: ts,
                })
            }
        }
    }

    /// Replace a set's definition with the memorized state right now.
    fn define(&mut self, set: String, ts: i64, source: &'static str) {
        let spells: Vec<String> = self.memorized.values().cloned().collect();
        self.sets.insert(
            set,
            SpellSetDef {
                spells,
                observed_at: ts,
                source,
            },
        );
    }

    /// Close an open load window if the log has been quiet long enough.
    fn settle_if_idle(&mut self, ts: i64) {
        let idle = self
            .pending
            .as_ref()
            .is_some_and(|p| ts - p.last_activity_ts >= SETTLE_MS);
        if idle {
            self.settle_now(ts);
        }
    }

    /// Close an open load window NOW, recording the bar as it stands.
    ///
    /// `observedAt` is the SETTLE time rather than the load line's: the definition describes the
    /// bar at the moment it was read.
    fn settle_now(&mut self, ts: i64) {
        let Some(open) = self.pending.take() else {
            return;
        };
        self.define(open.set, ts, "loaded");
    }

    fn state(&self) -> Value {
        let memorized: Vec<&String> = self.memorized.values().collect();
        json!({
            "v": SPELL_SETS_SHAPE_VERSION,
            "memorized": memorized,
            "sets": self.sets
        })
    }
}

impl EqModule for SpellSetsModule {
    fn id(&self) -> &'static str {
        "spellSets"
    }

    fn reset(&mut self) {
        self.memorized.clear();
        self.sets.clear();
        self.pending = None;
        self.seq = 0;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        if ev.kind() == "epoch" {
            // A rebirth behind the same name is a different character's bar. See the header on
            // what this does to `seq`.
            self.reset();
            return;
        }
        let ts = ev.ts();
        self.settle_if_idle(ts);
        match ev.kind() {
            "spellMemorize" => {
                let spell = ev.str("spell").unwrap_or_default().to_string();
                self.on_memorize(ts, &spell, ev.bool("done"));
            }
            "spellForget" => {
                let spell = ev.str("spell").unwrap_or_default().to_string();
                self.on_forget(ts, &spell);
            }
            "spellSet" => {
                let set = ev.str("set").unwrap_or_default().to_string();
                let action = ev.str("action").unwrap_or_default().to_string();
                self.on_spell_set(ts, &set, &action);
            }
            _ => {}
        }
    }

    /// The wall-clock half of the settle rule. Never called on a historical fold.
    fn on_tick(&mut self, now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        self.settle_if_idle(now_ms);
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.state() })
    }
}
