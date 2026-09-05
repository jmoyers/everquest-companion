//! `src/main/modules/alerts.ts` — the alert evaluator.
//!
//! Two maps fold on REPLAY events as well as live ones, so they are complete the moment the
//! renderer hydrates: `spellLastCast` (spell display name with the rank suffix INTACT → newest
//! cast ts; nothing downstream of it decides whether an alert fires) and `poisonSlowSeen` (absent
//! until a slow is actually observed — an offer is never made from an assumption).
//!
//! FIRING IS LIVE-ONLY, gated one line above the matcher: replay must never make a sound. Defs
//! arrive only through `alerts.define`, so a world this crate builds itself has none. The matcher
//! is `alerts_rules.rs` and the early-warning schedule is `alerts_early.rs`; `on_tick` takes the
//! timer projection as a parameter, because a module here cannot borrow two modules the registry
//! is iterating.
//!
//! `spellLastCast` evicts the least recently cast, expressed as the first key in iteration order —
//! true only because every write deletes the key before re-inserting it.

use super::alerts_early::{BreakWatchers as _, EarlyWarnings};
use super::alerts_rules::{Fire, RuleSet};
use super::buff_timer_rows::BuffTimerRow;
use crate::event::Event;
use crate::jsmap::JsMap;
use crate::{Defines, EqModule};
use eqlog::jsstr::js_trim;
use serde::Serialize;
use serde_json::{json, Value};

/// Max distinct spell display names kept in the rank-recency map. A bound, not a policy: a
/// character's own cast vocabulary is well under 300 in the reference log.
const SPELL_CAST_CAP: usize = 400;

/// The observation the slow-poison offer is made from.
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
    /// Rank-preserving cast recency. See the header on why the iteration order matters.
    spell_last_cast: JsMap<i64>,
    poison_slow_seen: Option<PoisonSlowRecency>,
    /// The user's own definitions and the clocks they fire under. Empty until `alerts.define`
    /// pushes a set.
    rules: RuleSet,
    /// The state machine holding a warning between the landing that armed it and the deadline it
    /// speaks at.
    ///
    /// A sibling field of `rules` rather than a member of it, because of the borrow: `fire` needs
    /// `&mut` on both at once, and the heartbeat needs `&mut early` while reading `&rules`.
    early: EarlyWarnings,
    /// Fires accumulated since the ingest last drained them.
    pending: Vec<Fire>,
    /// The announce cursor — see [`crate::announce`].
    ///
    /// Only `defs`, `history`, `spellLastCast` and `poisonSlowSeen` are published; the compiled
    /// rules, cooldown clocks, armed warnings and pending queue are not. So a match swallowed by a
    /// cooldown, or taken by an early warning to speak later, changes nothing a client can read.
    ///
    /// `alerts.define` replaces the published `defs` and advances no log seq, so the cursor has to
    /// land strictly above the fold position to announce a change with no event behind it.
    announce: crate::announce::Announce,
}

impl AlertsModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// Runs for replay events as well as live ones: the map describes the character, not the
    /// session.
    fn note_cast(&mut self, ev: &Event) {
        if ev.kind() != "castBegin" {
            return;
        }
        let name = js_trim(ev.str("spell").unwrap_or_default());
        if name.is_empty() {
            return;
        }
        let ts = ev.ts();
        // A stamp that went backwards moves neither the recency nor the key's position: the
        // refusal is above the delete, not below it.
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
        // Past both refusals, so the published recency map really moved.
        self.announce.changed(self.seq);
    }

    /// `effect` is the unambiguous half of a poison proc: the two shared emotes are shared between
    /// strikes that AGREE on their effect, so 'slow' is Weakening Strike's landing and nothing else.
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
        self.announce.changed(self.seq);
    }
}

impl EqModule for AlertsModule {
    fn id(&self) -> &'static str {
        "alerts"
    }

    /// Defs persist across character switches — they are user prefs, not log state. The
    /// cast-recency map is character state, so it goes, and the replay that follows repopulates it.
    fn reset(&mut self) {
        self.seq = 0;
        self.announce.reset();
        self.spell_last_cast.clear();
        self.poison_slow_seen = None;
        // Only the per-character firing bookkeeping; the defs survive. `RuleSet::reset` says which
        // half goes.
        self.rules.reset();
        // A pending warning is about a debuff on a mob THIS character was fighting, and the replay
        // that follows re-arms nothing (a replay never fires).
        self.early.reset();
        self.pending.clear();
    }

    /// No `epoch` branch, deliberately, unlike every character-scoped module in cluster 2a: a
    /// rebirth behind the same name still casts the same spells, and the fires ledger is
    /// user-facing history. These maps span the launch boundary.
    fn on_event(&mut self, ev: &Event, live: bool) {
        self.seq = ev.seq();
        self.note_cast(ev);
        self.note_poison_slow(ev);
        // The boundary law, one gate above the matcher: replay must never make a sound. A
        // historical fold reaches no rule, spends no cooldown and writes no history.
        if !live {
            return;
        }
        // A fire is the only thing that writes the published history, so an empty batch is a rule
        // swallowed by a cooldown, taken by an early warning, or an event no rule wanted.
        let mut fired = self.rules.fire(ev, &mut self.early);
        if !fired.is_empty() {
            self.announce.changed(self.seq);
        }
        self.pending.append(&mut fired);
    }

    /// The one module that ever reads the timer projection, and only while it has something to
    /// measure against it: a warning armed and waiting, or a break-family def watching the rows.
    /// Asked one beat ahead so the projection is not built when nothing owes.
    fn wants_timer_rows(&self) -> bool {
        !self.early.idle() || self.rules.has_break_watchers()
    }

    /// The wall-clock heartbeat, and it exists for one thing: the early-warning offset, whose
    /// subject is a deadline that arrives while the log is idle. `timer_rows` is built once per
    /// beat by `Registry::tick` before any module's heartbeat, so every module reads the same rows.
    fn on_tick(&mut self, now_ms: i64, timer_rows: &[BuffTimerRow]) {
        for due in self.early.tick(now_ms, timer_rows, &self.rules) {
            if let Some(fire) = self.rules.fire_warning(&due, now_ms) {
                self.pending.push(fire);
                // A warning spoken by the heartbeat writes history with no line behind it. One the
                // def no longer wants, or a cooldown swallows, writes nothing and says nothing.
                self.announce.changed(self.seq);
            }
        }
    }

    /// The dirty bit: a cast that moved the recency map, a slow proc, a fire that wrote history, or
    /// a pushed def set. See the `announce` field.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        let mut state = json!({
            // From the settings store, never from the log.
            "defs": self.rules.defs(),
            // Written by a fire and by nothing else, so it is empty through any historical fold.
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

    /// The whole rule set, replaced. The payload is the defs ARRAY rather than a params object,
    /// because the family's knowledge IS the list; anything else leaves the previous set standing.
    fn define(&mut self, payload: &Value) {
        let Some(list) = payload.as_array() else {
            return;
        };
        self.rules.set_defs(list.clone());
        // The published `defs` just changed with no event behind it.
        self.announce.changed(self.seq);
    }
}

#[cfg(test)]
mod tests {
    use super::AlertsModule;
    use crate::event::Event;
    use crate::modules::buff_timer_rows::{BuffTimerRow, RowGroup, RowKind, TimerMode};
    use crate::{Defines, EqModule};
    use serde_json::json;

    /// `group:slow:mob`, copied verbatim out of `src/shared/alertGroups.ts` — the dev profile's own
    /// def. `buffFade` is where `classifyWornOff` routes a slow's
    /// `Your <X> spell has worn off of <mob>.`, and because `buffFade` IS an ending this def is
    /// BREAK-FAMILY: it arms from the row appearing rather than from its own match.
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

    /// One live countdown row for a slow on a mob, as `build_timer_rows` produces it.
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

    fn ev(line: &str) -> Event<'static> {
        Event::from_json(line).expect("a JSON object")
    }

    /// The real wear-off line, as `classifyWornOff` routes it.
    const WORE_OFF: &str = r#"{"kind":"buffFade","seq":9,"ts":61000,"raw":"Your Shiftless Deeds spell has worn off of King Tranix.","spell":"Shiftless Deeds","target":"King Tranix"}"#;

    fn module(early_warn_sec: Option<i64>) -> AlertsModule {
        let mut m = AlertsModule::new();
        m.define(&json!([slow_wore_off_a_mob(early_warn_sec)]));
        m
    }

    /// A def with `earlyWarnSec: 5` arms off the timer projection and fires five seconds before the
    /// row's stated end.
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

        // Five seconds before the stated end, it speaks.
        m.on_tick(56_000, &rows);
        let fires = m.take_fires();
        assert_eq!(fires.len(), 1, "an early warning fired");
        assert_eq!(fires[0].rule, "Slow wore off a mob");
        assert_eq!(fires[0].sound, "alan-rickman/slow-expired");
        // The matched text is the projection sentence, because no line has been printed.
        assert_eq!(
            fires[0].message,
            "Shiftless Deeds on King Tranix is about to end"
        );
        // `at` is the heartbeat's instant: an early warning has no matching event.
        assert_eq!(fires[0].at, 56_000);
        // `dueAt` is the row's stated end, 1,000 + 60,000 — the gap between the two is the five
        // seconds the def asked for.
        assert_eq!(fires[0].due_at, Some(61_000));
        // The spoken spell is the probe's rank-less name: the name the alert matched on is the
        // name it should say.
        assert_eq!(fires[0].spell.as_deref(), Some("Shiftless Deeds"));

        // It does not speak twice for one landing.
        m.on_tick(57_000, &rows);
        assert!(m.take_fires().is_empty());

        // …and the break line that follows is swallowed. One landing, one firing.
        m.on_event(&ev(WORE_OFF), true);
        assert!(m.take_fires().is_empty());
    }

    /// An early warning speaks the mob it armed on, on the path where that is hardest: a
    /// break-family def has no event to ask, so `{target}` comes off the probe's hypothetical
    /// event and is frozen on the arm rather than re-resolved at delivery.
    #[test]
    fn an_early_warning_speaks_the_mob_it_armed_on() {
        let mut def = slow_wore_off_a_mob(Some(5));
        def["speech"] = json!({ "mode": "custom", "phrase": "Slow breaking on {target}" });
        let mut m = AlertsModule::new();
        m.define(&json!([def]));
        let rows = [slow_row(1_000, Some(60_000))];

        m.on_tick(2_000, &rows);
        m.on_tick(56_000, &rows);
        let fires = m.take_fires();
        assert_eq!(fires.len(), 1);
        let captures = fires[0].captures.as_ref().expect("the probe's subject");
        assert_eq!(
            captures.get("target").map(String::as_str),
            Some("King Tranix")
        );
    }

    /// An early break is never silent: the hold ends before the deadline, no warning spoke, so the
    /// wear-off line fires the alert exactly as it would with no offset.
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

    /// The same def without an offset is untouched: a heartbeat arms nothing and the wear-off line
    /// fires at the wear-off. The offset MOVES the one fire; it does not add a second.
    #[test]
    fn the_same_def_without_an_offset_fires_at_the_line() {
        let mut m = module(None);
        let rows = [slow_row(1_000, Some(60_000))];
        m.on_tick(56_000, &rows);
        assert!(m.take_fires().is_empty(), "no offset, nothing to arm");
        m.on_event(&ev(WORE_OFF), true);
        assert_eq!(m.take_fires().len(), 1);
    }

    /// A row the model puts no honest number on arms nothing: there is no end to count backwards
    /// from, so silence is the answer and the break line still fires.
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

    /// A historical fold reaches none of it: the boundary law is one gate above the matcher, and
    /// `fold_bytes` cannot call a tick at all.
    #[test]
    fn a_replayed_wear_off_neither_fires_nor_arms() {
        let mut m = module(Some(5));
        m.on_event(&ev(WORE_OFF), false);
        assert!(m.take_fires().is_empty());
        // …and nothing was armed either, so a later tick has nothing to deliver.
        m.on_tick(999_000, &[slow_row(1_000, Some(60_000))]);
        assert!(m.take_fires().is_empty());
    }

    /// The projection is only built when something will read it. An ordinary session has no def
    /// carrying an offset, so no beat of it folds `buffs.active` and the CC ledger at all.
    #[test]
    fn a_module_with_no_offset_never_asks_for_the_timer_projection() {
        use crate::EqModule as _;
        let m = module(None);
        assert!(!m.wants_timer_rows(), "no offset, nothing to measure");

        // …a break-family def with an offset watches the ROWS themselves, so it asks from the
        // moment it is pushed — before anything has been armed.
        let watching = module(Some(5));
        assert!(watching.wants_timer_rows());

        // …and a module with no defs at all — every world this crate constructs on its own.
        assert!(!AlertsModule::new().wants_timer_rows());
    }

    /// A character switch forgets the armed warnings: they are about a debuff on a mob THIS
    /// character was fighting.
    #[test]
    fn a_reset_drops_the_armed_warnings_and_keeps_the_defs() {
        let mut m = module(Some(5));
        let rows = [slow_row(1_000, Some(60_000))];
        m.on_tick(2_000, &rows);
        m.reset();
        // The deadline the dropped warning would have spoken at. Nothing arms in its place either:
        // a row already past its deadline never arms on the break path.
        m.on_tick(56_000, &rows);
        assert!(
            m.take_fires().is_empty(),
            "the warning went with the character"
        );
        // The defs stay, so the alert still fires at its own trigger.
        m.on_event(&ev(WORE_OFF), true);
        assert_eq!(m.take_fires().len(), 1);
    }
}
