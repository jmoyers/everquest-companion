//! `src/main/modules/combo.ts` — which classes was this character running, and when did that
//! change? The `EqModule` shell only; the thinking lives in four pure siblings mirroring the TS's
//! own files: `evidence` (intake + the committed class tables), `score` (presence · exclusivity ·
//! sustain), `levels` (dings against `/who` rows) and `intervals` (detectors and assembly).
//!
//! EQ Legends runs up to three classes at once, the displayed level is the MINIMUM of their levels,
//! and a loadout swap is never logged. So the app either infers the combo and labels it inferred,
//! or it says nothing at all.
//!
//! Registered first, so within one bus delivery every later module (and the combat engine) sees an
//! already-advanced combo state. It consumes and emits no derived events.
//!
//! Intervals are recomputed from scratch whenever anything changes — a `/who` row or a user
//! correction re-labels an arbitrary span — so interval ids are snapshot-scoped.
//!
//! `seq` is this module's own revision: a correction changes every interval and advances no log
//! seq, and `useModule` dedupes deltas with `d.seq <= knownSeq`.

pub mod evidence;
pub mod intervals;
pub mod levels;
pub mod score;

use crate::event::Event;
use crate::EqModule;
use evidence::{class_observation, tables_ready, who_classes, ClassObservation, SpellClassIndex};
use intervals::{build_intervals, ComboCorrection, IntervalInput};
use levels::{LevelPoint, WhoRow};
use serde_json::{json, Value};

/// The 16 EQ Legends classes, by their `/who` three-letter code. Note SHD, not SHK: the wiki spells
/// the class both "Shadow Knight" and "Shadowknight" and both canonicalize here.
pub type ClassAbbr = &'static str;

/// Every class code, sorted — the closed set behind `as_class_abbr` and an unknown slot's
/// candidate list.
pub const CLASS_ABBRS: &[ClassAbbr] = &[
    "BER", "BRD", "BST", "CLR", "DRU", "ENC", "MAG", "MNK", "NEC", "PAL", "RNG", "ROG", "SHD",
    "SHM", "WAR", "WIZ",
];

/// `shared/classCombo.ts MAX_COMBO_SLOTS` — EQ Legends runs up to three classes at once.
pub const MAX_COMBO_SLOTS: usize = 3;

/// `isClassAbbr` as a narrowing rather than a predicate: an unknown code is dropped, never coerced.
/// Answering the `'static` spelling keeps every candidate list downstream a plain `&str` compare.
pub fn as_class_abbr(v: &str) -> Option<ClassAbbr> {
    CLASS_ABBRS.iter().copied().find(|c| *c == v)
}

pub struct ComboModule {
    observations: Vec<ClassObservation>,
    who_rows: Vec<WhoRow>,
    levels: Vec<LevelPoint>,
    corrections: Vec<ComboCorrection>,
    /// `epochDetector.ts LAUNCH_MS` — a correction older than the launch describes the wiped beta
    /// character that shares this log file. A correction is the one combo state outliving a replay.
    launch_ms: i64,
    /// The spell → class table, built once from the parser's own DB (see `evidence.rs`).
    spell_classes: SpellClassIndex,
    /// The revision — see the header. Never a LogEvent seq.
    rev: i64,
}

impl ComboModule {
    pub fn new(spell_classes: SpellClassIndex, launch_ms: i64) -> Self {
        ComboModule {
            observations: Vec::new(),
            who_rows: Vec::new(),
            levels: Vec::new(),
            corrections: Vec::new(),
            launch_ms,
            spell_classes,
            rev: 0,
        }
    }

    /// Anything that can change what the intervals will be goes through here: an observation, a
    /// level ding, a reset, a correction written or withdrawn. It advances the revision the
    /// transport dedupes on, so no state change can go untold.
    ///
    /// The TS's memo of the built intervals is deliberately not ported: `build_intervals` is a pure
    /// total function of the four inputs, so a cache would be a second place for the answer to live.
    fn mark_stale(&mut self) {
        self.rev += 1;
    }
}

impl EqModule for ComboModule {
    fn id(&self) -> &'static str {
        "combo"
    }

    fn reset(&mut self) {
        self.observations.clear();
        self.who_rows.clear();
        self.levels.clear();
        self.mark_stale();
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        if ev.kind() == "epoch" {
            // Character rebirth: observations before the boundary belong to a dead character. Note
            // what is deliberately absent — a level-regression epoch trigger. A level drop is a
            // loadout swap, which is the whole point of this module.
            let launch_ms = self.launch_ms;
            self.reset();
            self.corrections.retain(|c| c.start_ts >= launch_ms);
            return;
        }
        if ev.kind() == "level" {
            self.levels.push(LevelPoint {
                ts: ev.ts(),
                level: ev.int("level").unwrap_or(0),
            });
            self.mark_stale();
            return;
        }
        if ev.kind() == "selfWho" {
            let classes = who_classes(ev);
            if !classes.is_empty() {
                self.who_rows.push(WhoRow {
                    ts: ev.ts(),
                    seq: ev.seq(),
                    classes,
                    level: ev.int("level").unwrap_or(0),
                });
            }
        }
        let Some(observation) = class_observation(&self.spell_classes, ev) else {
            return;
        };
        self.observations.push(observation);
        self.mark_stale();
    }

    /// The same cursor `snapshot` publishes, without building the state to read it.
    fn published_seq(&self) -> Option<i64> {
        Some(self.rev)
    }

    fn snapshot(&self) -> Value {
        let intervals = build_intervals(&IntervalInput {
            observations: &self.observations,
            who_rows: &self.who_rows,
            levels: &self.levels,
            corrections: &self.corrections,
        });
        // `current` is the last interval, or null — the same object, never a second reading.
        let current = intervals.last().cloned();
        json!({
            "seq": self.rev,
            "state": {
                "intervals": intervals,
                "current": current,
                // Data availability, not health: an empty stance table would silently turn every
                // inference into an unknown slot, so the UI says "not ready" instead.
                "ready": tables_ready(),
            }
        })
    }

    fn as_defines(&mut self) -> Option<&mut dyn crate::Defines> {
        Some(self)
    }
}

impl crate::Defines for ComboModule {
    fn family(&self) -> &'static str {
        "combo"
    }

    /// `comboModule.setCorrectionsProvider(…)`'s answer, pushed.
    ///
    /// It must mark stale: a correction re-labels an arbitrary span and advances no log seq, so a
    /// reader deduping on `seq` would drop the very push that carries it.
    ///
    /// A correction is refused whole, never filtered: one to three distinct class codes out of the
    /// closed set, a start at or after the launch epoch, and an end that is either absent or not
    /// before the start. The engine is a second door onto state `ipc/combo.ts` validates too.
    fn define(&mut self, payload: &Value) {
        let Some(list) = payload.as_array() else {
            return;
        };
        let launch_ms = self.launch_ms;
        self.corrections = list
            .iter()
            .filter_map(|c| read_correction(c, launch_ms))
            .collect();
        self.mark_stale();
    }
}

/// One pushed `ComboCorrection`, validated. See [`crate::Defines`]'s impl above for the rule.
fn read_correction(v: &Value, launch_ms: i64) -> Option<ComboCorrection> {
    let start_ts = v.get("startTs")?.as_i64()?;
    if start_ts < launch_ms {
        return None;
    }
    let end_ts = match v.get("endTs") {
        None | Some(Value::Null) => None,
        Some(end) => {
            let end = end.as_i64()?;
            if end < start_ts {
                return None;
            }
            Some(end)
        }
    };
    let raw = v.get("classes")?.as_array()?;
    if raw.is_empty() || raw.len() > MAX_COMBO_SLOTS {
        return None;
    }
    let mut classes: Vec<ClassAbbr> = Vec::new();
    for c in raw {
        let abbr = as_class_abbr(c.as_str()?)?;
        // Deduped by refusal, not by filtering: `[ENC, ENC]` is not a one-class loadout, it is a
        // payload the app's own validator would have rejected.
        if classes.contains(&abbr) {
            return None;
        }
        classes.push(abbr);
    }
    Some(ComboCorrection {
        start_ts,
        end_ts,
        classes,
        set_at: v.get("setAt")?.as_i64()?,
    })
}
