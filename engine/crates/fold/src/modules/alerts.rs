//! `src/main/modules/alerts.ts` — the alert evaluator, folded for the two maps it keeps that have
//! NOTHING to do with firing.
//!
//! ── WHAT A FOLD OF THIS MODULE IS, AND WHAT IT IS NOT ──────────────────────────────────────────
//!
//! Over there this is a 900-line matcher: compiled `event`/`raw`/composite triggers, per-alert and
//! per-target cooldown clocks, capture groups, the `{target}` auto token, and the JOS-216
//! early-warning offset. NONE of it can run during a fold, and both reasons are structural rather
//! than incidental:
//!
//!   1. `onEvent` fires on LIVE events only — `if (!live) return`, the line above the loop — and
//!      the comment beside it is the law: "replay must never make a sound". `Fold` delivers
//!      `live: false` from the first byte to the last.
//!   2. THE DEF LIST IS EMPTY IN THIS WORLD. Alert defs are user preferences the settings store
//!      owns, and `foldArm.mts` injects none (`deps.alertDefs ?? []`), so `compiled` is empty and
//!      every loop over it is a no-op. That is what the goldens recorded: `defs: []` on all six
//!      slices, and `history: {}` beside it, because a history entry is written only by a fire.
//!
//! WHAT DOES FOLD, on replay events exactly as on live ones, is the pair of maps the file itself
//! flags as "recorded for REPLAY events too … so the map is complete the moment the renderer
//! hydrates". They are the whole of this port:
//!
//!   * `spellLastCast` — spell DISPLAY name (rank suffix INTACT: "Mesmerization III") → the newest
//!     ts you were seen to begin casting it. Rank-SENSITIVE on purpose and the one map in the alert
//!     system that stays so: it answers "which rank am I actually using", which is a question about
//!     ranks, and nothing downstream of it decides whether an alert fires. `castBegin` is the one
//!     event family that keeps the numeral — fizzle, interrupt and every wear-off line drop it.
//!   * `poisonSlowSeen` — the rogue slow-poison recency the "alert when a mob gets slowed?" offer
//!     is made from. Null until a slow has actually been observed: an offer is never made from an
//!     assumption about what class you are playing beside.
//!
//! ── THE TWO SEAMS THE WIRING INSTALLS, AND WHY NEITHER APPEARS BELOW ───────────────────────────
//!
//! `wiring.ts` line 228 hands this module a LAZY PULL — `setTimerRows(() => buildTimerRows(buffs
//! .snapshot().state, buffTimers.snapshot().state))` — which reaches across two modules registered
//! AFTER it and rebuilds the timer projection mid-fold. It is called from `onTick` and from
//! nowhere else, at most once per heartbeat and only while an early warning is actually armed; a
//! warning can only be armed by a LIVE MATCH against a compiled DEF. So the pull is not
//! reproduced here, and the reason it is safe not to is the same fact twice: no defs, no live.
//!
//! SINCE JOS-481 A LIVE ENGINE DOES TICK (`Fold::tick`, owner ruling 22), and SINCE JOS-492 THIS
//! MODULE HAS AN `on_tick` AND THE PULL HAS A HOME. The seam is INVERTED rather than reproduced:
//! `Registry::tick` builds the projection ONCE per beat, before any module's heartbeat runs, and
//! hands it down as a parameter — because a module here cannot hold an interior-mutable handle on
//! two modules the registry is iterating, which was the real structural cost this comment used to
//! decline to pay. THE INSTANT IS THE SAME ONE the lazy pull would have read at: over there the
//! alerts module is registered BEFORE buffs and buffTimers, so its heartbeat runs before theirs and
//! the rows it pulls are the ones the beat started with.
//!
//! ── …AND SINCE JOS-482 THE MATCHER IS HERE AFTER ALL ──────────────────────────────────────────
//!
//! Both reasons above have been removed, one by each half of the cutover. `alerts.define` pushes
//! the user's own definitions in (boundary verdict 3: the store stays persistence truth, and the
//! engine never reads a settings file), and the LIVE TAIL delivers `live: true`. So `set_defs`
//! exists, the evaluator lives in `alerts_rules.rs`, and a live match leaves a [`Fire`] for the
//! ingest to put on the wire — owner ruling 22, which reduces the app-side alert system to
//! receive-fire-make-sound.
//!
//! **NOTHING ABOUT A HISTORICAL FOLD MOVED.** `on_event`'s live gate is where the TS keeps it, one
//! line above the loop, and the world this crate constructs by default still pushes no defs at all
//! — so the six-slice oracle sees the identical `defs: []` / `history: {}` it always has. The two
//! maps below are still the only thing a replay writes.
//!
//! ── …AND SINCE JOS-492 THE OFFSET IS HONOURED TOO ─────────────────────────────────────────────
//!
//! JOS-482 compiled an `earlyWarnSec` def OUT and said why: a fire the app MOVES needs a wall clock
//! and the timer projection, and this crate had neither wired in. Both landed, so the def is
//! compiled like any other, a match ARMS instead of sounding, and [`AlertsModule::on_tick`] delivers
//! the warning at the row's stated end minus the offset. `alerts_early.rs` is the schedule and its
//! header is the argument; what lives HERE is the two fields and the one heartbeat.
//!
//! STILL NOTHING ABOUT A HISTORICAL FOLD MOVED, and now for two structural reasons rather than one:
//! the live gate is where it was, and `fold_bytes` cannot call a tick at all.
//!
//! ── THE EVICTION IS THE ONLY PLACE MAP ORDER IS LOAD-BEARING ───────────────────────────────────
//!
//! `spellLastCast` is capped at 400 names and evicts the LEAST RECENTLY CAST, which is expressed as
//! "the first key in iteration order" — and it stays true only because every write DELETES the key
//! before re-inserting it, moving it to the tail. That is a JS `Map` insertion-order rule and it is
//! `JsMap`'s whole reason for existing. The published object's KEY order is not a claim (the bar is
//! deep equality), but WHICH KEY the cap threw away certainly is.

use super::alerts_early::{BreakWatchers as _, EarlyWarnings};
use super::alerts_rules::{Fire, RuleSet};
use super::buff_timer_rows::BuffTimerRow;
use crate::event::Event;
use crate::jsmap::JsMap;
use crate::{Defines, EqModule};
use eqlog::jsstr::js_trim;
use serde::Serialize;
use serde_json::{json, Value};

/// `SPELL_CAST_CAP` — max distinct spell display names kept in the rank-recency map. A character's
/// own cast vocabulary is well under 300 in the reference log; the cap is a bound, not a policy.
const SPELL_CAST_CAP: usize = 400;

/// `PoisonSlowRecency` — the observation the slow-poison offer is made from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PoisonSlowRecency {
    last_at: i64,
    count: i64,
    last_target: String,
}

#[derive(Default)]
pub struct AlertsModule {
    seq: i64,
    /// RANK-PRESERVING cast recency. See the header on why the iteration order matters.
    spell_last_cast: JsMap<i64>,
    poison_slow_seen: Option<PoisonSlowRecency>,
    /// THE USER'S OWN DEFINITIONS AND THE CLOCKS THEY FIRE UNDER (JOS-482). Empty until
    /// `alerts.define` pushes a set, which is every world this crate constructs on its own.
    rules: RuleSet,
    /// THE ARMED EARLY WARNINGS (JOS-216/JOS-235, ported by JOS-492) — the state machine that holds
    /// a warning between the landing that armed it and the deadline it speaks at.
    ///
    /// A SIBLING FIELD OF `rules` RATHER THAN A MEMBER OF IT, and the reason is the borrow: `fire`
    /// needs `&mut` on both at once (a match arms), and the heartbeat needs `&mut early` while
    /// reading `&rules` (a break watch asks the def's own matcher). Two fields of this struct are
    /// two disjoint borrows; one field inside the other is not.
    early: EarlyWarnings,
    /// Fires accumulated since the ingest last drained them — `pending`, one indirection out.
    pending: Vec<Fire>,
}

impl AlertsModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// `noteCast` — runs for replay events as well as live ones; the map describes the CHARACTER,
    /// not the session.
    fn note_cast(&mut self, ev: &Event) {
        if ev.kind() != "castBegin" {
            return;
        }
        let name = js_trim(ev.str("spell").unwrap_or_default());
        if name.is_empty() {
            return;
        }
        let ts = ev.ts();
        // An out-of-order line (a stamp that went backwards) does not move the recency, and it
        // does not move the key's position either — the TS returns before the delete.
        if self
            .spell_last_cast
            .get(name)
            .is_some_and(|&prev| prev >= ts)
        {
            return;
        }
        // Re-insert so the iteration order stays least-recent-first for the eviction below.
        self.spell_last_cast.remove(name);
        self.spell_last_cast.insert(name.to_string(), ts);
        if self.spell_last_cast.len() > SPELL_CAST_CAP {
            let oldest = self
                .spell_last_cast
                .iter()
                .next()
                .map(|(k, _)| k.to_string());
            if let Some(k) = oldest {
                self.spell_last_cast.remove(&k);
            }
        }
    }

    /// `notePoisonSlow`. `effect` is the unambiguous half of a poison proc: the two shared emotes
    /// are shared between strikes that AGREE on their effect, so 'slow' is exactly Weakening
    /// Strike's landing and nothing else.
    fn note_poison_slow(&mut self, ev: &Event) {
        if ev.kind() != "poisonProc" || ev.str("effect") != Some("slow") {
            return;
        }
        let ts = ev.ts();
        let target = ev.str("target").unwrap_or_default().to_string();
        let prev_last_at = self.poison_slow_seen.as_ref().map_or(0, |p| p.last_at);
        let last_target = if ts >= prev_last_at {
            target.clone()
        } else {
            self.poison_slow_seen
                .as_ref()
                .map_or(target.clone(), |p| p.last_target.clone())
        };
        self.poison_slow_seen = Some(PoisonSlowRecency {
            last_at: prev_last_at.max(ts),
            count: self.poison_slow_seen.as_ref().map_or(0, |p| p.count) + 1,
            last_target,
        });
    }
}

impl EqModule for AlertsModule {
    fn id(&self) -> &'static str {
        "alerts"
    }

    /// Defs persist across character switches (they are user prefs, not log state); only the
    /// per-character bookkeeping resets. The cast-recency map IS character state — a different
    /// character casts different ranks — so it goes with it, and the replay that follows
    /// repopulates it.
    fn reset(&mut self) {
        self.seq = 0;
        self.spell_last_cast.clear();
        self.poison_slow_seen = None;
        // Only the per-character firing bookkeeping — the DEFS survive, exactly as the TS's do:
        // they are user preferences, not log state, and the app does not re-push them for a
        // rebirth. `RuleSet::reset` says which half goes.
        self.rules.reset();
        // A pending warning is about a debuff on a mob THIS character was fighting; the next
        // character is not fighting it, and the replay that follows will re-arm nothing (a replay
        // never fires).
        self.early.reset();
        self.pending.clear();
    }

    /// NOTE WHAT IS NOT HERE: no `epoch` branch. The TS has none either, and it is a deliberate
    /// difference from every character-scoped module in cluster 2a — a rebirth behind the same
    /// name still casts the same spells, and the fires ledger is user-facing history. So this
    /// module's maps span the launch boundary, which the goldens pin on the two slices that cross
    /// it.
    fn on_event(&mut self, ev: &Event, live: bool) {
        self.seq = ev.seq();
        self.note_cast(ev);
        self.note_poison_slow(ev);
        // `if (!live) return`, above the matcher loop — THE BOUNDARY LAW, in the one place the TS
        // keeps it: replay must never make a sound. A historical fold therefore reaches no rule,
        // spends no cooldown and writes no history, which is what keeps the six-slice oracle
        // looking at the module it always looked at.
        if !live {
            return;
        }
        self.pending
            .append(&mut self.rules.fire(ev, &mut self.early));
    }

    /// THE WALL-CLOCK HEARTBEAT — `onTick`, and it exists for ONE thing: the early-warning offset,
    /// whose whole subject is a deadline that arrives WHILE THE LOG IS IDLE, which is exactly when a
    /// player is watching a mez run down.
    ///
    /// `timer_rows` IS THE `setTimerRows` SEAM, INVERTED. Over there `wiring.ts` hands this module a
    /// LAZY PULL — `() => buildTimerRows(buffs.snapshot().state, buffTimers.snapshot().state)` —
    /// which reaches across two modules registered AFTER it and rebuilds the projection mid-tick. A
    /// module here cannot hold a handle on two modules the registry owns, so the REGISTRY builds the
    /// rows once per beat and hands them down (`Registry::tick`).
    ///
    /// AND THE INSTANT IS THE SAME ONE, which is the part that matters. The rows are built BEFORE any
    /// module's `on_tick` runs, and over there the alerts module is registered before buffs and
    /// buffTimers — so its heartbeat runs before theirs and the lazy pull reads exactly the state
    /// this beat started with, hygiene sweep not yet applied. Same rows, same beat.
    ///
    /// NOTHING IS READ WHEN NOTHING OWES: `EarlyWarnings::tick` returns immediately when nothing is
    /// armed and no def is watching, which is every beat of an ordinary session.
    /// THE ONE MODULE THAT EVER READS THE PROJECTION, and only while it has something to measure
    /// against it: a warning armed and waiting, or a break-family def watching the rows themselves.
    /// See [`crate::EqModule::wants_timer_rows`] — this is the TS's "only while an early warning is
    /// actually armed", asked one beat ahead.
    fn wants_timer_rows(&self) -> bool {
        !self.early.idle() || self.rules.has_break_watchers()
    }

    fn on_tick(&mut self, now_ms: i64, timer_rows: &[BuffTimerRow]) {
        for due in self.early.tick(now_ms, timer_rows, &self.rules) {
            if let Some(fire) = self.rules.fire_warning(&due, now_ms) {
                self.pending.push(fire);
            }
        }
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        let mut state = json!({
            // The user's alert definitions, which arrive from the settings store (`alerts.define`)
            // and never from the log. Empty in every world constructed without a push.
            "defs": self.rules.defs(),
            // Per-alert ring of recent fires. Written by a FIRE and by nothing else, so it is empty
            // through any historical fold.
            "history": self.rules.history(),
            "spellLastCast": self.spell_last_cast,
        });
        // Omitted rather than null: an absent key is the honest encoding of "no slow has ever been
        // observed for this character".
        if let Some(p) = &self.poison_slow_seen {
            state["poisonSlowSeen"] = serde_json::to_value(p).expect("a plain record");
        }
        json!({ "seq": self.seq, "state": state })
    }

    fn as_defines(&mut self) -> Option<&mut dyn Defines> {
        Some(self)
    }

    fn take_fires(&mut self) -> Vec<Fire> {
        std::mem::take(&mut self.pending)
    }
}

impl Defines for AlertsModule {
    fn family(&self) -> &'static str {
        "alerts"
    }

    /// `alertsModule.setDefs(list)` — the whole rule set, replaced. The payload is the `defs` ARRAY
    /// rather than the request's params object, because the family's knowledge IS the list; a
    /// payload that is not one leaves the previous set standing.
    fn define(&mut self, payload: &Value) {
        let Some(list) = payload.as_array() else {
            return;
        };
        self.rules.set_defs(list.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::AlertsModule;
    use crate::event::Event;
    use crate::modules::buff_timer_rows::{BuffTimerRow, RowGroup, RowKind, TimerMode};
    use crate::{Defines, EqModule};
    use serde_json::json;

    /// THE OWNER'S OWN DEF, COPIED OUT OF `src/shared/alertGroups.ts` — `group:slow:mob`, the one
    /// the dev profile carries with `earlyWarnSec: 5` and the acceptance case this ticket names.
    ///
    /// The trigger is verbatim: `buffFade` (which is what `classifyWornOff` routes a slow's
    /// `Your <X> spell has worn off of <mob>.` to) with the SLOW ROSTER regex on `spell`, the two
    /// bard bindings included, and the optional rank tail JOS-276 put on every roster pattern. The
    /// cooldown is the def's own 5000 ms.
    ///
    /// NOTE WHICH PATH IT TAKES: `buffFade` IS an ending, so this def is BREAK-FAMILY (JOS-235) and
    /// arms from the ROW APPEARING rather than from its own match — which is exactly the case that
    /// used to delete the alert outright, and the reason that half had to be ported with the other.
    fn slow_wore_off_a_mob(early_warn_sec: Option<i64>) -> serde_json::Value {
        const SLOW_SPELLS_MOB: &str = concat!(
            "/^(Languid Pace|Tepid Deeds|Shiftless Deeds|Forlorn Deeds|Drowsy|Walking Sleep|",
            "Tagar.s Insects|Togor.s Insects|Turgur.s Insects|Tigir.s Insects|",
            "Largo.s Melodic Binding|Largo.s Assonant Binding)",
            "(?: (?:I|II|III|IV|V|VI|VII|VIII|IX|X))?$/"
        );
        let mut def = json!({
            "id": "group:slow:mob",
            "name": "Slow wore off a mob",
            "enabled": true,
            "cooldownMs": 5000,
            "sound": { "packId": "alan-rickman", "soundId": "slow-expired" },
            "trigger": { "type": "event", "kind": "buffFade", "where": { "spell": SLOW_SPELLS_MOB } }
        });
        if let Some(sec) = early_warn_sec {
            def["earlyWarnSec"] = json!(sec);
        }
        def
    }

    /// One live countdown row for a slow on a mob — what `build_timer_rows` produces for
    /// `Your Shiftless Deeds spell has worn off of King Tranix.`'s landing.
    fn slow_row(started: i64, duration: Option<i64>) -> BuffTimerRow {
        BuffTimerRow {
            id: "debuff|king tranix|shiftless deeds".to_owned(),
            kind: RowKind::Debuff,
            name: "Shiftless Deeds".to_owned(),
            cast_name: None,
            candidates: None,
            ambiguous: false,
            group: RowGroup::Target,
            target: Some("King Tranix".to_owned()),
            target_key: Some("king tranix".to_owned()),
            inferred_target: false,
            started_ts: started,
            calms_target: false,
            mode: if duration.is_some() {
                TimerMode::Countdown
            } else {
                TimerMode::Elapsed
            },
            duration_ms: duration,
            count: None,
            caster: None,
        }
    }

    fn ev(line: &str) -> Event {
        Event::from_json(line).expect("a JSON object")
    }

    /// The real wear-off line, as `classifyWornOff` routes it.
    const WORE_OFF: &str = r#"{"kind":"buffFade","seq":9,"ts":61000,"raw":"Your Shiftless Deeds spell has worn off of King Tranix.","spell":"Shiftless Deeds","target":"King Tranix"}"#;

    fn module(early_warn_sec: Option<i64>) -> AlertsModule {
        let mut m = AlertsModule::new();
        m.define(&json!([slow_wore_off_a_mob(early_warn_sec)]));
        m
    }

    /// THE ACCEPTANCE CASE (JOS-492): the dev profile's `group:slow:mob` with `earlyWarnSec: 5`
    /// ARMS off the timer projection and makes an EARLY fire, five seconds before the row's stated
    /// end — where JOS-482 compiled the def out and made no sound at all.
    #[test]
    fn the_owners_slow_alert_with_an_offset_arms_and_fires_early() {
        let mut m = module(Some(5));
        let rows = [slow_row(1_000, Some(60_000))];

        // The heartbeat sees the live row and files a watch. 55 s to go, so nothing sounds.
        m.on_tick(2_000, &rows);
        assert!(m.take_fires().is_empty());
        // …and one second short of the deadline, still nothing.
        m.on_tick(55_000, &rows);
        assert!(m.take_fires().is_empty());

        // FIVE SECONDS BEFORE THE STATED END, IT SPEAKS.
        m.on_tick(56_000, &rows);
        let fires = m.take_fires();
        assert_eq!(fires.len(), 1, "an early warning fired");
        assert_eq!(fires[0].rule, "Slow wore off a mob");
        assert_eq!(fires[0].sound, "alan-rickman/slow-expired");
        // The matched text is the PROJECTION sentence, because no line has been printed — the
        // truth, rather than a sentence the log never carried.
        assert_eq!(
            fires[0].message,
            "Shiftless Deeds on King Tranix is about to end"
        );
        // `at` IS THE HEARTBEAT'S INSTANT. An early warning has no matching event; its whole
        // subject is a deadline that arrives while the log is idle. The TS stamps `ts: nowMs` in
        // the same place, so the app receives the identical number under either evaluator.
        assert_eq!(fires[0].at, 56_000);

        // It does not speak twice for one landing.
        m.on_tick(57_000, &rows);
        assert!(m.take_fires().is_empty());

        // …AND THE BREAK LINE THAT FOLLOWS IS SWALLOWED, because the alert already spoke for this
        // landing. One landing, one firing (JOS-235).
        m.on_event(&ev(WORE_OFF), true);
        assert!(m.take_fires().is_empty());
    }

    /// …AND AN EARLY BREAK IS NEVER SILENT. The hold ends before the deadline, no warning ever
    /// spoke, so the wear-off line fires the alert exactly as it did before the offset existed.
    #[test]
    fn a_slow_that_breaks_early_still_fires_at_the_break() {
        let mut m = module(Some(5));
        let rows = [slow_row(1_000, Some(60_000))];
        m.on_tick(2_000, &rows);
        assert!(m.take_fires().is_empty());
        m.on_event(&ev(WORE_OFF), true);
        let fires = m.take_fires();
        assert_eq!(fires.len(), 1, "the break is not suppressed by a silence");
        assert_eq!(
            fires[0].message,
            "Your Shiftless Deeds spell has worn off of King Tranix."
        );
        assert_eq!(fires[0].at, 61_000, "a real line is stamped by the LOG");
    }

    /// THE SAME DEF WITHOUT AN OFFSET IS UNTOUCHED — a heartbeat arms nothing, and the wear-off
    /// line fires at the wear-off. This is what every alert written before JOS-216 does, and the
    /// whole of what "the offset MOVES the one fire" means.
    #[test]
    fn the_same_def_without_an_offset_fires_at_the_line() {
        let mut m = module(None);
        let rows = [slow_row(1_000, Some(60_000))];
        m.on_tick(56_000, &rows);
        assert!(m.take_fires().is_empty(), "no offset, nothing to arm");
        m.on_event(&ev(WORE_OFF), true);
        assert_eq!(m.take_fires().len(), 1);
    }

    /// A ROW THE MODEL PUTS NO HONEST NUMBER ON ARMS NOTHING — the honesty law reaching this
    /// surface unchanged. There is no end to count backwards from, so silence is the answer and
    /// the break line still fires.
    #[test]
    fn a_count_up_row_arms_no_warning() {
        let mut m = module(Some(5));
        let rows = [slow_row(1_000, None)];
        m.on_tick(2_000, &rows);
        m.on_tick(999_000, &rows);
        assert!(m.take_fires().is_empty());
        m.on_event(&ev(WORE_OFF), true);
        assert_eq!(m.take_fires().len(), 1);
    }

    /// A HISTORICAL FOLD REACHES NONE OF IT. The boundary law is one gate above the matcher, and
    /// the heartbeat is a door `fold_bytes` cannot open — so the six-slice oracle sees the module
    /// it always saw, offsets or not.
    #[test]
    fn a_replayed_wear_off_neither_fires_nor_arms() {
        let mut m = module(Some(5));
        m.on_event(&ev(WORE_OFF), false);
        assert!(m.take_fires().is_empty());
        // …and nothing was armed either, so a later tick has nothing to deliver.
        m.on_tick(999_000, &[slow_row(1_000, Some(60_000))]);
        assert!(m.take_fires().is_empty());
    }

    /// THE PROJECTION IS ONLY BUILT WHEN SOMETHING WILL READ IT — the laziness the TS's pull has by
    /// construction and this had to state (`crate::EqModule::wants_timer_rows`). An ordinary session
    /// has no def carrying an offset, so no beat of it folds `buffs.active` and the CC ledger at all.
    #[test]
    fn a_module_with_no_offset_never_asks_for_the_timer_projection() {
        use crate::EqModule as _;
        let m = module(None);
        assert!(!m.wants_timer_rows(), "no offset, nothing to measure");

        // …a break-family def with an offset watches the ROWS themselves, so it asks from the
        // moment it is pushed — before anything has been armed.
        let watching = module(Some(5));
        assert!(watching.wants_timer_rows());

        // …and a module with NO defs at all — every world this crate constructs on its own — is the
        // first case again, which is what keeps a historical fold's cost exactly what it was.
        assert!(!AlertsModule::new().wants_timer_rows());
    }

    /// A CHARACTER SWITCH FORGETS THE ARMED WARNINGS: they are about a debuff on a mob THIS
    /// character was fighting, and the next one is not fighting it.
    #[test]
    fn a_reset_drops_the_armed_warnings_and_keeps_the_defs() {
        let mut m = module(Some(5));
        let rows = [slow_row(1_000, Some(60_000))];
        m.on_tick(2_000, &rows);
        m.reset();
        // The deadline the dropped warning would have spoken at. Nothing does — and nothing arms
        // in its place either, because a row already past its deadline never arms on the break
        // path (a fold rebuilds rows from history, and an overdue one would announce a hold that
        // ended long ago the instant the engine went live).
        m.on_tick(56_000, &rows);
        assert!(
            m.take_fires().is_empty(),
            "the warning went with the character"
        );
        // The DEFS stay — they are user preferences, not log state, and the app does not re-push
        // them for a rebirth — so the alert still fires at its own trigger.
        m.on_event(&ev(WORE_OFF), true);
        assert_eq!(m.take_fires().len(), 1);
    }
}
