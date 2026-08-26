//! `src/main/modules/combo.ts` — WHICH THREE CLASSES WAS THIS CHARACTER RUNNING, AND WHEN DID THAT
//! CHANGE? The `EqModule` shell only; the thinking lives in four PURE siblings that mirror the TS's
//! own four files one for one — `evidence` (intake + the two committed class tables),
//! `score` (presence · exclusivity · sustain), `levels` (reconciling dings against `/who` rows) and
//! `intervals` (the boundary detectors and the assembly).
//!
//! ONE MODULE, FIVE FILES, and that is the TS's factoring rather than a new one: `comboIntervals.ts`
//! sits at the repo's measured 400-code-line ceiling and `comboLevels.ts` exists because of it. A
//! single 900-line Rust file would be a different program to audit than the one it is a port of.
//!
//! WHY THE FEATURE EXISTS AT ALL. EQ Legends runs up to three classes at once, the displayed level
//! is the MINIMUM of their levels, and a loadout swap is NEVER logged — verified twice on full-log
//! sweeps. The character's own `/who` row states the loadout outright and there are ELEVEN of them
//! in 1.1M lines, none within 33 hours of the swap this log actually contains. So the app either
//! infers the combo and LABELS it inferred, or it says nothing at all.
//!
//! REGISTERED FIRST: within one bus delivery every later module (and the combat engine) then sees
//! an already-advanced combo state for the same event. It consumes no derived events and emits
//! none, so the position is purely additive.
//!
//! RECOMPUTE-FROM-SCRATCH, NOT PATCH-IN-PLACE. A `/who` row typed now re-labels the past hour and a
//! user correction re-labels an arbitrary span, so intervals are rebuilt from the retained
//! observations whenever anything changes. Interval ids are therefore snapshot-scoped.
//!
//! AND ITS `seq` IS ITS OWN REVISION — JOS-87, measured in the real app before it was fixed.
//! `useModule` dedupes deltas with `d.seq <= knownSeq`; every other module's state moves only when
//! an event moves it, so "the last event's seq" is a fine revision counter for them. THIS one has a
//! second input — a user correction, which changes every interval and advances no log seq — so a
//! correction written while the log is idle (exactly when a user is sitting in Preferences fixing a
//! wrong loadout) produced a delta the renderer dropped as a duplicate. The store had it, the model
//! had it, and the screen kept showing the detection that was wrong.
//!
//! THE CORRECTIONS PROVIDER IS ABSENT in the bench world, so `corrections` is empty on all six
//! slices; `intervals.rs` says what that leaves unexercised.

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

/// Every class code, SORTED — the closed set behind `as_class_abbr` and the candidate list of an
/// UNKNOWN slot.
pub const CLASS_ABBRS: &[ClassAbbr] = &[
    "BER", "BRD", "BST", "CLR", "DRU", "ENC", "MAG", "MNK", "NEC", "PAL", "RNG", "ROG", "SHD",
    "SHM", "WAR", "WIZ",
];

/// `shared/classCombo.ts MAX_COMBO_SLOTS` — EQ Legends runs up to three classes at once.
pub const MAX_COMBO_SLOTS: usize = 3;

/// `isClassAbbr` as a NARROWING rather than a predicate: an unknown code is dropped, never
/// coerced. Answering the `'static` spelling is what lets every candidate list downstream be a
/// plain `&str` compare instead of an owned string.
pub fn as_class_abbr(v: &str) -> Option<ClassAbbr> {
    CLASS_ABBRS.iter().copied().find(|c| *c == v)
}

pub struct ComboModule {
    observations: Vec<ClassObservation>,
    who_rows: Vec<WhoRow>,
    levels: Vec<LevelPoint>,
    corrections: Vec<ComboCorrection>,
    /// `epochDetector.ts LAUNCH_MS` — a correction older than the launch describes the BETA
    /// character that was wiped and shares this log file, and a correction is the one piece of
    /// combo state that outlives a replay.
    launch_ms: i64,
    /// The spell → class table, built once from the parser's own DB (see `evidence.rs`).
    spell_classes: SpellClassIndex,
    /// THE REVISION — see the header. Never a LogEvent seq.
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

    /// Anything that can change what the intervals will be goes through here: a new observation, a
    /// level ding, a character reset, a correction written or withdrawn. It advances the revision
    /// the transport dedupes on, so a state change the renderer is not told about — the defect this
    /// path was fixed for — cannot happen.
    ///
    /// The TS additionally sets a `stale` flag over a memo of the built intervals. THE MEMO IS NOT
    /// PORTED: `snapshot()` takes `&self` on this trait, `build_intervals` is a pure total function
    /// of the four inputs, and a historical fold asks for the snapshot ONCE. A cache that can only
    /// ever return what the recompute would return is a second place for the answer to live.
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
            // Character rebirth: every observation before the boundary belongs to a dead character
            // whose loadout has nothing to do with this one. NOTE what is deliberately NOT here — a
            // level-regression epoch trigger. A level drop is a LOADOUT SWAP, which is the entire
            // point of this module (epochDetector.ts says the same thing from the other side).
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

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
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
        // `current` — convenience: the last interval, or null. The same object, not a copy of a
        // different reading of it.
        let current = intervals.last().cloned();
        json!({
            "seq": self.rev,
            "state": {
                "intervals": intervals,
                "current": current,
                // Data availability, not health: an empty stance table would silently turn every
                // inference into an unknown slot, and the UI shows "not ready" instead of a wall of
                // dashes.
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

    /// `comboModule.setCorrectionsProvider(…)`'s answer, PUSHED (JOS-482).
    ///
    /// AND IT MARKS STALE, which is the half `ipc/combo.ts republish()` exists for and the half a
    /// define could quietly skip: a correction re-labels an arbitrary span and advances no log seq,
    /// so `useModule`'s `d.seq <= knownSeq` dedupe would drop the very push that carries it
    /// (JOS-87, measured in the running app before it was fixed). The revision IS this module's
    /// published `seq`, so bumping it here is what makes a correction written on an idle log
    /// visible at all.
    ///
    /// A CORRECTION IS REFUSED WHOLE, never filtered: one to three DISTINCT class codes out of the
    /// closed set, a start at or after the launch epoch (an older one describes the wiped beta
    /// character), and an end that is either absent or not before the start. That is `ipc/combo.ts`
    /// validating at its door, and the engine is a second door onto the same state.
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
        // Deduped by REFUSAL rather than by filtering — `[ENC, ENC]` is not a one-class loadout,
        // it is a payload the app's own validator would have rejected.
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
