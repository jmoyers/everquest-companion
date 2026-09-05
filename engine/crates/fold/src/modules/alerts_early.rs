//! The early-warning offset: `shared/earlyWarning.ts`'s pure rules plus
//! `main/modules/alertsEarlyWarning.ts`'s scheduler, in one file because the split over there is an
//! Electron boundary and here there is none.
//!
//! An alert that fires when a debuff LANDS can instead fire N seconds before that debuff's estimated
//! end. An offset on an existing alert, not a new kind of alert, and it adds no duration tracking:
//! the estimated end is the timer-row projection's, `started_ts + duration_ms`.
//!
//! THE HONESTY LAW REACHES THIS SURFACE UNCHANGED. A row the model can put no honest number on
//! counts up and has no `duration_ms`, so there is no end to count backwards from and such a landing
//! arms NOTHING.
//!
//! AN ARM RESOLVES ON THE NEXT TICK, NOT AT THE MATCH. The alerts module is registered before buffs
//! and buffTimers, so at the instant a landing matches, the row it produces does not exist yet;
//! looking it up in `on_event` would find the previous state of the world every time. A match files
//! an arm request, and the next heartbeat resolves it against the projection. One that finds no row
//! within [`ARM_RESOLVE_WINDOW_MS`] is dropped: the model states no countdown for that landing.
//!
//! CANCELLATION IS "THE ROW IS GONE". Every ending — death, dispel, zone, a nuke waking a mez —
//! removes the row, so NO ROW, NO WARNING covers endings nobody has thought of yet and cannot drift
//! from the timer model. The deadline is re-read every tick for the same reason: the learner can
//! raise an estimate mid-hold and a re-land moves the landing.
//!
//! A BREAK-FAMILY DEF ARMS FROM THE ROW APPEARING instead. Its arming event and its ending are the
//! same line, so arming from the match would resolve against a world that event has already emptied
//! and the alert would go silent altogether. The trigger keeps its ordinary meaning: one landing
//! yields exactly one firing — the warning speaks and the at-break firing is swallowed, or the hold
//! breaks early and the break fires normally. AN EARLY BREAK MUST NEVER BE SILENT.

use crate::event::Event;
use crate::jsmap::JsMap;
use crate::modules::buff_timer_rows::{
    timer_name_base, timer_name_key, BuffTimerRow, RowGroup, TimerMode,
};
use eqlog::jsstr::js_trim;
use eqlog::names::id_key;
use serde_json::{json, Value};

/// The bounds on the offset, in seconds.
///
/// The floor is 1 because the model's clock is a 1-second heartbeat: an offset finer than the tick
/// cannot be delivered, so promising it would be a lie in the UI. The ceiling is past the longest
/// thing anybody warns about early, and refuses the typo that would arm a warning before the spell
/// had finished landing.
pub const MIN_EARLY_WARN_SEC: i64 = 1;
pub const MAX_EARLY_WARN_SEC: i64 = 120;

/// How long an unresolved arm request keeps looking for its row. The row is created by the SAME
/// event that armed it, so this is slack for a heartbeat that was busy, not a window in which a row
/// might still turn up.
pub const ARM_RESOLVE_WINDOW_MS: i64 = 5_000;

/// The most warnings held at once, across every alert. A bound, not a policy: an AE mez plus a chain
/// of adds can legitimately arm a dozen. Oldest-armed goes first (insertion order), being the one
/// closest to having resolved or expired anyway.
pub const MAX_ARMED_WARNINGS: usize = 200;

/// A NUL, which can appear in no alert id and in no row id, so an alert can never collide with
/// another alert's row. Spelled as an escape and never as a raw byte: git would call the file binary
/// and diff/blame/grep would go dark.
const KEY_SEP: char = '\u{0}';

/// A stored offset as a number this app will act on, or `None` for "no warning" — the APP's
/// normalizer rather than a reading of it, because the two would otherwise fire at two different
/// instants for the same def.
///
/// `None` is both the default and the fallback, and they mean the same thing: fire when the trigger
/// matches. A zero, a negative, a NaN, a non-number and an absent key all land there, so nothing has
/// to be migrated and a stranger's shared bundle cannot arm a warning this build would not offer.
#[must_use]
pub fn normalize_early_warn_sec(raw: Option<&Value>) -> Option<i64> {
    let n = raw?.as_f64()?;
    if !n.is_finite() {
        return None;
    }
    // `Math.round` is round half UP, not `f64::round`'s round half away from zero. They differ only
    // for negatives, which the next line refuses anyway — spelled out so nobody "simplifies" it.
    #[allow(clippy::cast_possible_truncation)]
    let sec = (n + 0.5).floor() as i64;
    if sec < MIN_EARLY_WARN_SEC {
        return None;
    }
    Some(sec.min(MAX_EARLY_WARN_SEC))
}

/// True when a row states an end at all — the only rows an early warning can be measured against.
fn has_stated_end(row: &BuffTimerRow) -> bool {
    row.mode == TimerMode::Countdown && row.duration_ms.is_some_and(|ms| ms > 0)
}

/// Every spell name a row answers to, rank-stripped and folded (its own, plus its family).
fn row_name_keys(row: &BuffTimerRow) -> Vec<String> {
    let mut out = vec![timer_name_key(&row.name)];
    for c in row.candidates.iter().flatten() {
        out.push(timer_name_key(c));
    }
    out
}

/// What a landing was about — the half of the arming event that decides which timer row it made.
///
/// `target_key` is the canonical entity the spell landed on; absent means the PLAYER, and the two
/// are exclusive because the projection's `group` is exactly that distinction.
///
/// `spell_names` is EVERY name the line could be, not a name: the landing sentences this feature is
/// aimed at are shared across whole spell families, so the event's `spell` field is a best-effort
/// pick and `candidates` carries the truth. Both go in, and the match accepts any of them.
#[derive(Debug, Clone, Default)]
pub struct EarlyWarnSubject {
    pub target_key: Option<String>,
    pub spell_names: Vec<String>,
}

/// The row a landing is tracked by, or `None` when the model states no end for it.
///
///  1. Only rows with a STATED end. A count-up row arms nothing.
///  2. The row must be on the subject's entity — the mob the line named, or the player.
///  3. If any of those rows answers to one of the subject's spell names, only those are considered.
///     Rank-stripped and case-folded on both sides: the row's name comes from the CAST line (the
///     only line in the family carrying a rank) while the arming event's names come from the DB
///     candidates for a landing sentence that carries none. Names that match nothing on that entity
///     fall back to ALL of them rather than to nothing — a row the model resolved from the player's
///     own cast history beats a DB-derived candidate list when the two disagree.
///  4. Of what is left, the most recent landing.
///
/// THE LIMIT: two indistinguishable debuffs landing on one mob in the same second are two rows and
/// step 4 takes the newer — a warning about the wrong one of two things the user is holding on that
/// mob, never a warning about a mob they are not fighting.
#[must_use]
pub fn early_warn_row_for<'a>(
    rows: &'a [BuffTimerRow],
    subject: &EarlyWarnSubject,
) -> Option<&'a BuffTimerRow> {
    let on_subject: Vec<&BuffTimerRow> = rows
        .iter()
        .filter(|r| {
            has_stated_end(r)
                && match &subject.target_key {
                    None => r.group == RowGroup::Zelf,
                    Some(key) => r.target_key.as_deref() == Some(key.as_str()),
                }
        })
        .collect();
    if on_subject.is_empty() {
        return None;
    }
    let wanted: Vec<String> = subject
        .spell_names
        .iter()
        .map(|n| timer_name_key(n))
        .collect();
    let named: Vec<&BuffTimerRow> = if wanted.is_empty() {
        Vec::new()
    } else {
        on_subject
            .iter()
            .copied()
            .filter(|r| row_name_keys(r).iter().any(|k| wanted.contains(k)))
            .collect()
    };
    let pool = if named.is_empty() {
        &on_subject
    } else {
        &named
    };
    // Strictly greater, so a tie keeps the EARLIER row and the answer does not depend on a sort's
    // stability.
    pool.iter().copied().reduce(|best, r| {
        if r.started_ts > best.started_ts {
            r
        } else {
            best
        }
    })
}

/// When the warning for this row is due — the row's estimated end minus the offset.
///
/// Re-read on every tick rather than fixed at the landing, because both halves move: the learner can
/// raise the estimate mid-hold and a re-land moves `started_ts`.
#[must_use]
pub fn early_warn_fire_at(row: &BuffTimerRow, sec: i64) -> Option<i64> {
    if !has_stated_end(row) {
        return None;
    }
    Some(row.started_ts + row.duration_ms? - sec * 1000)
}

/// The event kinds whose arrival means a tracked row has ENDED — measured against the parser rather
/// than assumed.
///
///   * `Cc` — a mez/root spell's wear-off, `refresh: true`.
///   * `Uncharm` — a charm spell's wear-off.
///   * `BuffFade` — everything else that wore off a NAMED target: a slow, a Largo, a Pacify.
///   * `BuffWearOff` — a shared-message wear-off ON YOU (`Your speed returns.`).
///   * `BuffExpired` — the buffs module's derived, resolved "wore off you / your pet".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakKind {
    Cc,
    Uncharm,
    BuffFade,
    BuffWearOff,
    BuffExpired,
}

impl BreakKind {
    /// The parser's own spelling of this kind.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cc => "cc",
            Self::Uncharm => "uncharm",
            Self::BuffFade => "buffFade",
            Self::BuffWearOff => "buffWearOff",
            Self::BuffExpired => "buffExpired",
        }
    }

    fn from_str(kind: &str) -> Option<Self> {
        match kind {
            "cc" => Some(Self::Cc),
            "uncharm" => Some(Self::Uncharm),
            "buffFade" => Some(Self::BuffFade),
            "buffWearOff" => Some(Self::BuffWearOff),
            "buffExpired" => Some(Self::BuffExpired),
            _ => None,
        }
    }
}

/// The break kind one primitive condition watches for, or `None` when it is not a break condition.
///
/// THE `cc` KIND CARRIES BOTH HALVES, so it has to be read rather than listed: the same event is the
/// application (`a turmoil toad has been mesmerized.`) and the break (`Your Dazzle spell has worn
/// off of a turmoil toad.`). Either of two constraints separates them:
///
///   `refresh` — present and 'true' only on the break shape.
///   `spell`   — the application sentence carries `candidates` and no `spell` field at all, and an
///               absent field is a no-match before the candidate widening is consulted. So a `cc`
///               condition constraining `spell` can only fire on a break. That matters because the
///               alert editor keeps only the FIRST `where` entry, so a stored `{spell, refresh}`
///               def comes back out of the dialog as `{spell}` alone and must still read as a break.
///
/// A bare `{kind: 'cc'}` matches the application too and stays a landing-family def.
fn break_kind_of(t: &Value, accepts_true: &dyn Fn(&str) -> bool) -> Option<BreakKind> {
    if t.get("type").and_then(Value::as_str) != Some("event") {
        return None;
    }
    let kind = BreakKind::from_str(t.get("kind").and_then(Value::as_str)?)?;
    if kind != BreakKind::Cc {
        return Some(kind);
    }
    let empty = serde_json::Map::new();
    let wh = t.get("where").and_then(Value::as_object).unwrap_or(&empty);
    if wh.contains_key("spell") {
        return Some(BreakKind::Cc);
    }
    let refresh = wh.get("refresh")?.as_str()?;
    accepts_true(refresh).then_some(BreakKind::Cc)
}

/// The break kinds a def watches for — empty when it is not a break-family def at all.
///
/// EVERY condition must be a break condition, and there must be at least one. A `raw` or `app`
/// condition is therefore never break-family: this file cannot build a hypothetical log line for a
/// pattern to match, and a renderer-evaluated app signal never sees an event. A mixed composite
/// keeps the landing behaviour rather than half of each.
///
/// A LIST because the `wearsOff` template is an `any` composite over `buffExpired` + `buffWearOff`,
/// and both halves have to be probed.
#[must_use]
pub fn break_trigger_kinds(trigger: &Value, accepts_true: &dyn Fn(&str) -> bool) -> Vec<BreakKind> {
    let single = [trigger.clone()];
    let conds: &[Value] = match trigger.get("conditions").and_then(Value::as_array) {
        Some(list) => list,
        None => &single,
    };
    let mut out: Vec<BreakKind> = Vec::new();
    if conds.is_empty() {
        return out;
    }
    for c in conds {
        let Some(kind) = break_kind_of(c, accepts_true) else {
            return Vec::new();
        };
        if !out.contains(&kind) {
            out.push(kind);
        }
    }
    out
}

/// Every spell name a running row could be announced under, as the wear-off line would print it.
///
/// An unambiguous row answers to its own name; a family row (one landing sentence, four spells)
/// answers to every candidate, because the log has not said which one it is and the break line will
/// name exactly one. Ranks stripped, deduped case-insensitively, first spelling wins.
#[must_use]
pub fn row_break_names(row: &BuffTimerRow) -> Vec<String> {
    let own = [row.name.clone()];
    let raw: &[String] = match &row.candidates {
        Some(list) if !list.is_empty() => list,
        _ => &own,
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for n in raw {
        let base = timer_name_base(n);
        let key = base.to_lowercase();
        if base.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(base);
    }
    out
}

/// The projected sentence a break-armed firing carries as its matched text.
///
/// NOT a log line, on purpose (see [`break_probes`]): this firing is a projection off the timer
/// model. It still names the two things that tell one warning from another — the spell, and the mob.
#[must_use]
pub fn break_probe_text(row: &BuffTimerRow, spell: &str) -> String {
    if row.group == RowGroup::Zelf {
        format!("{spell} is about to wear off")
    } else {
        format!(
            "{spell} on {} is about to end",
            row.target.as_deref().unwrap_or("unknown target")
        )
    }
}

/// One hypothetical break, ready to be offered to a def's own matcher.
pub struct BreakProbe {
    /// The event a break of this row would be, as the parser would emit it.
    pub ev: Event<'static>,
    /// The spell name this probe stands for — what the break line prints.
    pub spell: String,
}

/// What a break of this row would look like — the seam, stated in one place.
///
/// A def's `where` is written against the shape of the BREAK EVENT, so the only honest way to ask
/// "would this def announce the break of this row" is to ask the def's own matcher with the event it
/// was written for. Re-implementing the question would be a second matcher beside the real one,
/// re-deriving regex specs, the candidate widening and the field-absence rule, and it would drift.
///
/// THE PROBE IS A FABRICATION, AND THIS IS ITS ENTIRE BLAST RADIUS: built here, handed to the rule's
/// matcher, dropped. Never on the bus, never folded, never counted, never learned from. Its `raw` is
/// deliberately not log-shaped, so nothing downstream can mistake it for a line the game printed.
///
/// THE FIELDS ARE THE MEASURED ONES, per kind:
///   `cc`          `{ mob, spell, refresh: true }`  — no candidates: the BREAK shape carries none.
///   `uncharm`     `{ mob, spell }`                 — no refresh; a charm break never carries one.
///   `buffFade`    `{ spell, target }`              — `target` omitted for a row on you.
///   `buffWearOff` `{ spell, candidates, target: 'self' }` — self rows only.
///   `buffExpired` `{ spell, target }`              — 'self' for a self row, else the entity's name.
///
/// A kind that cannot describe this row yields NOTHING (a `cc` break names a mob, so it can say
/// nothing about a buff on you) — a def that arms no warning and still fires at the break.
#[must_use]
pub fn break_probes(kind: BreakKind, row: &BuffTimerRow, ts: i64) -> Vec<BreakProbe> {
    let zelf = row.group == RowGroup::Zelf;
    let target = row.target.clone().unwrap_or_default();
    if !zelf && target.is_empty() {
        return Vec::new();
    }
    row_break_names(row)
        .into_iter()
        .filter_map(|spell| {
            let raw = break_probe_text(row, &spell);
            let v = probe_event(kind, zelf, &target, &spell, ts, &raw)?;
            Some(BreakProbe {
                ev: Event::from_value(v),
                spell,
            })
        })
        .collect()
}

/// The per-kind shape, split out so [`break_probes`] stays one idea.
fn probe_event(
    kind: BreakKind,
    zelf: bool,
    target: &str,
    spell: &str,
    ts: i64,
    raw: &str,
) -> Option<Value> {
    let k = kind.as_str();
    match kind {
        BreakKind::Cc => (!zelf).then(|| {
            json!({ "kind": k, "ts": ts, "seq": 0, "raw": raw, "mob": target, "spell": spell, "refresh": true })
        }),
        BreakKind::Uncharm => (!zelf).then(|| {
            json!({ "kind": k, "ts": ts, "seq": 0, "raw": raw, "mob": target, "spell": spell })
        }),
        BreakKind::BuffFade => Some(if zelf {
            json!({ "kind": k, "ts": ts, "seq": 0, "raw": raw, "spell": spell })
        } else {
            json!({ "kind": k, "ts": ts, "seq": 0, "raw": raw, "spell": spell, "target": target })
        }),
        BreakKind::BuffWearOff => zelf.then(|| {
            json!({ "kind": k, "ts": ts, "seq": 0, "raw": raw, "spell": spell, "candidates": [spell], "target": "self" })
        }),
        BreakKind::BuffExpired => Some(json!({
            "kind": k, "ts": ts, "seq": 0, "raw": raw, "spell": spell,
            "target": if zelf { "self" } else { target }
        })),
    }
}

/// The identity a warning and its break share — `<entity>|<spell family>`, folded on both sides.
///
/// It lets the at-break firing be suppressed for a landing whose warning already spoke, without the
/// alerts module re-deriving a timer row id from a break line — that id scheme belongs to
/// `build_timer_rows`. A row contributes one key per name it answers to, an event one per name it
/// could be, and any overlap is the same hold.
///
/// RANK-BLIND BY CONSTRUCTION: the row's name comes from the ranked cast line while the break line
/// prints the bare name, so an identity keeping the numeral would match nothing it was built for.
#[must_use]
pub fn break_identity_keys(entity_key: &str, names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in names {
        let key = format!("{entity_key}|{}", timer_name_key(n));
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// The identity keys a live row would be broken under. `'self'` is the entity key for a row on the
/// player — the model's own word for it, and the one `buffWearOff`/`buffExpired` already spell in
/// their `target` field.
#[must_use]
pub fn row_break_identity(row: &BuffTimerRow) -> Vec<String> {
    let entity = if row.group == RowGroup::Zelf {
        "self".to_owned()
    } else {
        row.target_key
            .clone()
            .or_else(|| row.target.clone())
            .unwrap_or_default()
    };
    break_identity_keys(&entity, &row_break_names(row))
}

/// What a landing was about, from the event that carried it.
///
/// The entity is read dynamically from `mob` (the CC/charm families) then `target` (the buff
/// families), because these are fields of some event shapes and not others. `buffApply` spells a
/// self-landing as the literal 'self', the model's word for the player, so it maps to NO entity key
/// rather than to a mob called self. The loop breaks on the first non-empty field, even when that
/// field maps to nothing.
///
/// `spell_names` is handed in: the caller has already resolved which names this event can answer to,
/// and re-deriving them would be a second copy of that rule.
#[must_use]
pub fn early_warn_subject(ev: &Event, spell_names: &[String]) -> EarlyWarnSubject {
    let mut target_key = None;
    for field in ["mob", "target"] {
        let Some(v) = ev.str(field) else { continue };
        let t = js_trim(v);
        if t.is_empty() {
            continue;
        }
        if t.to_lowercase() != "self" {
            target_key = Some(id_key(t));
        }
        break;
    }
    EarlyWarnSubject {
        target_key,
        spell_names: spell_names.to_vec(),
    }
}

/// The identity a break event carries — the other half of [`row_break_identity`].
///
/// The entity is read the same dynamic way [`early_warn_subject`] reads it, but 'self' is KEPT as
/// the literal key rather than mapped away, because a row on the player is what it has to match.
///
/// THE EVENT'S OWN `spell` IS READ HERE rather than taken from the caller's list, because that list
/// is the SPEECH one and claims only the kinds a spoken alert names a spell for — `uncharm` is not
/// one, so a charm break would arrive with no name at all. The question is "which hold ended", not
/// "what should the alert say", and every break sentence names it.
#[must_use]
pub fn break_event_identity(ev: &Event, spell_names: &[String]) -> Vec<String> {
    let mut entity = "self".to_owned();
    for field in ["mob", "target"] {
        let Some(v) = ev.str(field) else { continue };
        let t = js_trim(v);
        if t.is_empty() {
            continue;
        }
        entity = if t.to_lowercase() == "self" {
            "self".to_owned()
        } else {
            id_key(t)
        };
        break;
    }
    let mut names: Vec<String> = Vec::new();
    if let Some(s) = ev.str("spell") {
        if !js_trim(s).is_empty() {
            names.push(s.to_owned());
        }
    }
    names.extend_from_slice(spell_names);
    break_identity_keys(&entity, &names)
}

/// The firing an armed warning will make, built at match time so it says what the LANDING matched.
///
/// `alert_id` is not on the `Fire` frame and is carried anyway, because a warning armed for a minute
/// has to re-read its own def when it comes due: an alert deleted or switched off must not speak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArmedFire {
    pub alert_id: String,
    pub rule: String,
    pub sound: String,
    pub message: String,
    /// The words the arming match took, carried across the wait rather than re-resolved at delivery.
    /// The event is long gone by the time the heartbeat speaks, and on a break-family arm there was
    /// never an event to ask.
    pub captures: Option<crate::modules::alerts_captures::CaptureMap>,
    /// The spell this warning is about, frozen at the arm for the same reason.
    pub spell: Option<String>,
}

/// One armed warning as the caller files it.
#[derive(Debug, Clone)]
pub struct EarlyWarnArm {
    /// The offset in seconds, already normalized.
    pub sec: i64,
    /// The cooldown clock this firing belongs to — computed from the ARMING event, spent at the fire.
    pub cooldown_key: String,
    /// Which landing this is, so the row can be found once the world has folded it.
    pub subject: EarlyWarnSubject,
    /// Event ts (ms) of the landing — the clock the resolve window is measured on.
    pub ts: i64,
    /// The firing this warning will make.
    pub fired: ArmedFire,
}

/// A warning that has come due: the firing to make, and the clock to spend for it.
#[derive(Debug, Clone)]
pub struct EarlyWarnDue {
    pub cooldown_key: String,
    pub fired: ArmedFire,
    /// When the thing this warning is early for is due — the watched row's stated end.
    ///
    /// Computed as `fire instant + sec * 1000` rather than re-read off the row; the two are the same
    /// number by construction, and adding the offset back is the honest expression of what this
    /// field means.
    pub due_at: i64,
}

/// An arm that has found its row. `row_id` is the whole identity — its absence is the cancellation.
#[derive(Debug, Clone)]
struct Armed {
    arm: EarlyWarnArm,
    row_id: String,
}

/// One landing being watched: which row, which landing of it, and whether the warning has spoken.
#[derive(Debug, Clone)]
struct BreakWatch {
    alert_id: String,
    row_id: String,
    /// The row's `started_ts` when this watch was filed — a LATER one is a new landing, and re-arms.
    landed_ts: i64,
    sec: i64,
    cooldown_key: String,
    fired: ArmedFire,
    /// `<entity>|<spell family>` for every name this row answers to.
    identity: Vec<String>,
    /// True once the early warning has fired for this landing — the at-break firing is then spent.
    spoken: bool,
}

/// Where a break-family def's probe comes from.
///
/// A trait rather than a closure, for ownership: the scheduler and the rule set are two FIELDS of
/// the alerts module, so the scheduler is handed the rule set by reference and the two borrows stay
/// disjoint. A boxed closure capturing the rule set would borrow the object the caller still holds.
///
/// Matching an alert is the rule set's job and there must be exactly one implementation of it, so
/// this is a seam and not a second matcher.
pub trait BreakWatchers {
    /// The break-family defs that want to be told about live rows — `(alert_id, sec)` each.
    ///
    /// Rebuilt each tick rather than cached with the compile, because `enabled` and the offset can
    /// change under it and the list is at most a handful of defs. When it is empty the scheduler
    /// does not read the timer projection at all.
    fn break_watchers(&self) -> Vec<(String, i64)>;

    /// Whether [`Self::break_watchers`] would answer with anything — the same question without the
    /// allocation, asked once per beat to decide whether the timer projection is built at all.
    fn has_break_watchers(&self) -> bool;

    /// Would this def announce the break of this row — asked of the def's OWN matcher. The firing it
    /// hands back is built like an ordinary one, on the cooldown clock the real break would choose.
    fn probe_break(
        &self,
        alert_id: &str,
        row: &BuffTimerRow,
        now_ms: i64,
    ) -> Option<(ArmedFire, String)>;
}

/// The armed early warnings, advanced by the alerts module's heartbeat.
#[derive(Default)]
pub struct EarlyWarnings {
    /// Arms still looking for their row (see the header on why this is not resolved at match time).
    pending: Vec<EarlyWarnArm>,
    /// Warnings tracking a live row, keyed `<alertId>\0<rowId>` — one per alert per row.
    armed: JsMap<Armed>,
    /// Break-family watches, keyed the same way. Filed from the ROW APPEARING rather than from an
    /// event, and kept after the warning speaks so the break line it pre-empted can be suppressed.
    breaks: JsMap<BreakWatch>,
}

impl EarlyWarnings {
    pub fn reset(&mut self) {
        self.pending.clear();
        self.armed.clear();
        self.breaks.clear();
    }

    /// True when nothing is waiting — the caller skips reading the projection entirely.
    #[must_use]
    pub fn idle(&self) -> bool {
        self.pending.is_empty() && self.armed.is_empty() && self.breaks.is_empty()
    }

    /// File a warning for a landing that just matched an alert with an offset.
    pub fn arm(&mut self, req: EarlyWarnArm) {
        self.pending.push(req);
        if self.pending.len() > MAX_ARMED_WARNINGS {
            self.pending.remove(0);
        }
    }

    /// True when the at-break firing for a landing this alert already warned about is spent.
    ///
    /// A watch is CONSUMED by the break it pre-empted (one landing, one firing), so a re-land on the
    /// same mob can warn again; and a break with no matching spoken watch is suppressed by nothing.
    pub fn break_spoken(&mut self, alert_id: &str, identity: &[String]) -> bool {
        let hit = self.breaks.iter().find_map(|(key, w)| {
            (w.spoken && w.alert_id == alert_id && w.identity.iter().any(|k| identity.contains(k)))
                .then(|| key.to_owned())
        });
        match hit {
            Some(key) => {
                self.breaks.remove(&key);
                true
            }
            None => false,
        }
    }

    /// Advance to `now_ms`: resolve what can be resolved, cancel what has ended, and hand back the
    /// warnings that have come due. The projection is read by the caller and handed in, and the
    /// caller skips the whole call when [`Self::idle`] and no def is watching.
    pub fn tick(
        &mut self,
        now_ms: i64,
        rows: &[BuffTimerRow],
        watchers: &dyn BreakWatchers,
    ) -> Vec<EarlyWarnDue> {
        let watching = watchers.break_watchers();
        if self.idle() && watching.is_empty() {
            return Vec::new();
        }
        self.resolve(rows, now_ms);
        self.watch_breaks(rows, &watching, watchers, now_ms);
        let mut due = self.advance(rows, now_ms);
        due.append(&mut self.advance_breaks(rows, now_ms));
        due
    }

    /// Turn arm requests into armed warnings, discarding the ones the model states no end for.
    fn resolve(&mut self, rows: &[BuffTimerRow], now_ms: i64) {
        if self.pending.is_empty() {
            return;
        }
        let mut keep: Vec<EarlyWarnArm> = Vec::new();
        for p in std::mem::take(&mut self.pending) {
            let Some(row) = early_warn_row_for(rows, &p.subject) else {
                if now_ms - p.ts <= ARM_RESOLVE_WINDOW_MS {
                    keep.push(p);
                }
                continue;
            };
            // Re-arming the same (alert, row) replaces: a fresh landing on a row already being
            // watched is the same warning moved, never a second one.
            let key = format!("{}{KEY_SEP}{}", p.fired.alert_id, row.id);
            let row_id = row.id.clone();
            self.armed.remove(&key);
            self.armed.insert(key, Armed { arm: p, row_id });
            if self.armed.len() > MAX_ARMED_WARNINGS {
                let oldest = self.armed.keys().next().map(str::to_owned);
                if let Some(k) = oldest {
                    self.armed.remove(&k);
                }
            }
        }
        self.pending = keep;
    }

    /// Cancel the warnings whose row has gone, and collect the ones that are due.
    ///
    /// A deadline already in the past fires on this very tick — the honest degradation for an offset
    /// longer than the debuff (warn 30 s early on a 24 s mez): as early as the spell allows, rather
    /// than silently never arriving.
    fn advance(&mut self, rows: &[BuffTimerRow], now_ms: i64) -> Vec<EarlyWarnDue> {
        let mut due = Vec::new();
        let mut retire: Vec<String> = Vec::new();
        for (key, a) in self.armed.iter() {
            // No row: the hold ended, however it ended. Nothing left to warn about.
            let at = rows
                .iter()
                .find(|r| r.id == a.row_id)
                .and_then(|r| early_warn_fire_at(r, a.arm.sec));
            let Some(at) = at else {
                retire.push(key.to_owned());
                continue;
            };
            if now_ms < at {
                continue;
            }
            retire.push(key.to_owned());
            due.push(EarlyWarnDue {
                cooldown_key: a.arm.cooldown_key.clone(),
                fired: a.arm.fired.clone(),
                due_at: at + a.arm.sec * 1000,
            });
        }
        for key in retire {
            self.armed.remove(&key);
        }
        due
    }

    /// File a watch for every (def, live row) pair the def would announce the break of.
    ///
    /// A row is watched ONCE PER LANDING: `landed_ts` is the row's own clock, so a re-mez is a new
    /// landing and re-arms, while an unchanged row is left as it is — including after its warning
    /// has spoken, which is what stops a fired watch from re-arming a second later.
    ///
    /// A DEADLINE ALREADY IN THE PAST NEVER ARMS HERE, unlike the landing path where an overlong
    /// offset fires at once. The arming is the row's mere EXISTENCE, and rows are rebuilt from
    /// history on every character load — an overdue row would announce a hold that ended months ago
    /// the instant the fold landed. The break line still fires.
    fn watch_breaks(
        &mut self,
        rows: &[BuffTimerRow],
        watching: &[(String, i64)],
        watchers: &dyn BreakWatchers,
        now_ms: i64,
    ) {
        // Drop what is no longer watchable: the row is gone, or the alert was deleted, disabled, or
        // had its offset removed while a warning was pending.
        let dead: Vec<String> = self
            .breaks
            .iter()
            .filter(|(_, w)| {
                !rows.iter().any(|r| r.id == w.row_id)
                    || !watching.iter().any(|(id, _)| *id == w.alert_id)
            })
            .map(|(key, _)| key.to_owned())
            .collect();
        for key in dead {
            self.breaks.remove(&key);
        }
        for row in rows {
            for (alert_id, sec) in watching {
                self.watch_row(row, alert_id, *sec, watchers, now_ms);
            }
        }
    }

    /// One (def, row) pair — split out to keep [`Self::watch_breaks`] under the depth ceiling.
    fn watch_row(
        &mut self,
        row: &BuffTimerRow,
        alert_id: &str,
        sec: i64,
        watchers: &dyn BreakWatchers,
        now_ms: i64,
    ) {
        let key = format!("{alert_id}{KEY_SEP}{}", row.id);
        if self
            .breaks
            .get(&key)
            .is_some_and(|held| held.landed_ts >= row.started_ts && held.sec == sec)
        {
            return;
        }
        let Some(at) = early_warn_fire_at(row, sec) else {
            return;
        };
        if at <= now_ms {
            return;
        }
        let Some((fired, cooldown_key)) = watchers.probe_break(alert_id, row, now_ms) else {
            return;
        };
        self.breaks.remove(&key);
        self.breaks.insert(
            key,
            BreakWatch {
                alert_id: alert_id.to_owned(),
                row_id: row.id.clone(),
                landed_ts: row.started_ts,
                sec,
                cooldown_key,
                fired,
                identity: row_break_identity(row),
                spoken: false,
            },
        );
        if self.breaks.len() > MAX_ARMED_WARNINGS {
            let oldest = self.breaks.keys().next().map(str::to_owned);
            if let Some(k) = oldest {
                self.breaks.remove(&k);
            }
        }
    }

    /// The break warnings that have come due. A watch is NOT deleted when it fires — it stays,
    /// marked `spoken`, so the break line ending that same hold can be suppressed against it.
    /// [`Self::watch_breaks`] retires it the moment the row goes.
    fn advance_breaks(&mut self, rows: &[BuffTimerRow], now_ms: i64) -> Vec<EarlyWarnDue> {
        let mut due = Vec::new();
        for w in self.breaks.values_mut() {
            if w.spoken {
                continue;
            }
            let at = rows
                .iter()
                .find(|r| r.id == w.row_id)
                .and_then(|r| early_warn_fire_at(r, w.sec));
            let Some(at) = at else { continue };
            if now_ms < at {
                continue;
            }
            w.spoken = true;
            due.push(EarlyWarnDue {
                cooldown_key: w.cooldown_key.clone(),
                fired: w.fired.clone(),
                due_at: at + w.sec * 1000,
            });
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::buff_timer_rows::RowKind;

    /// A countdown row on a mob — the shape an early warning is measured against.
    fn debuff_row(spell: &str, target: &str, started: i64, duration: Option<i64>) -> BuffTimerRow {
        BuffTimerRow {
            id: format!("cc|{}|{}", target.to_lowercase(), timer_name_key(spell)),
            kind: RowKind::Debuff,
            name: spell.to_owned(),
            cast_name: None,
            candidates: None,
            ambiguous: false,
            group: RowGroup::Target,
            target: Some(target.to_owned()),
            target_key: Some(target.to_lowercase()),
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

    /// The same, on YOU — `group: self`, no target.
    fn self_row(spell: &str, started: i64, duration: Option<i64>) -> BuffTimerRow {
        BuffTimerRow {
            id: format!("self|self|{}", timer_name_key(spell)),
            group: RowGroup::Zelf,
            target: None,
            target_key: None,
            ..debuff_row(spell, "unused", started, duration)
        }
    }

    fn ev(line: &str) -> Event<'static> {
        Event::from_json(line).expect("a JSON object")
    }

    /// A scheduler with no break-family def watching — every landing-path test.
    struct NoWatchers;
    impl BreakWatchers for NoWatchers {
        fn break_watchers(&self) -> Vec<(String, i64)> {
            Vec::new()
        }
        fn has_break_watchers(&self) -> bool {
            false
        }
        fn probe_break(&self, _: &str, _: &BuffTimerRow, _: i64) -> Option<(ArmedFire, String)> {
            None
        }
    }

    fn armed_fire(id: &str) -> ArmedFire {
        ArmedFire {
            alert_id: id.to_owned(),
            rule: "Mez landed".to_owned(),
            sound: "classic/ding".to_owned(),
            message: "a turmoil toad has been mesmerized.".to_owned(),
            // This suite is about the SCHEDULE; a warning's words ride the arm without the scheduler
            // ever reading them, and are proven where they are decided, in `alerts_rules`.
            captures: None,
            spell: None,
        }
    }

    fn arm(id: &str, sec: i64, target: Option<&str>, names: &[&str], ts: i64) -> EarlyWarnArm {
        EarlyWarnArm {
            sec,
            cooldown_key: id.to_owned(),
            subject: EarlyWarnSubject {
                target_key: target.map(str::to_owned),
                spell_names: names.iter().map(|n| (*n).to_owned()).collect(),
            },
            ts,
            fired: armed_fire(id),
        }
    }

    #[test]
    fn the_deadline_is_the_rows_stated_end_minus_the_offset() {
        let row = debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000));
        assert_eq!(early_warn_fire_at(&row, 10), Some(1_000 + 48_000 - 10_000));
        // A count-up row states no end, so silence is the answer rather than an invented duration.
        let up = debuff_row("Dazzle", "a turmoil toad", 1_000, None);
        assert_eq!(early_warn_fire_at(&up, 10), None);
    }

    #[test]
    fn a_landing_is_tracked_by_the_newest_row_on_its_own_entity() {
        let rows = [
            debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000)),
            debuff_row("Dazzle", "a fire giant", 5_000, Some(48_000)),
            debuff_row("Languid Pace", "a turmoil toad", 3_000, Some(60_000)),
        ];
        // The mob the line named, and the most recent landing on it.
        let subject = EarlyWarnSubject {
            target_key: Some("a turmoil toad".to_owned()),
            spell_names: Vec::new(),
        };
        assert_eq!(
            early_warn_row_for(&rows, &subject).map(|r| r.name.as_str()),
            Some("Languid Pace")
        );
        // …and a named subject narrows to the rows that answer to that name, older or not.
        let named = EarlyWarnSubject {
            target_key: Some("a turmoil toad".to_owned()),
            spell_names: vec!["Dazzle".to_owned()],
        };
        assert_eq!(
            early_warn_row_for(&rows, &named).map(|r| r.name.as_str()),
            Some("Dazzle")
        );
    }

    /// A subject whose names match nothing falls back to all of them, never to nothing: a row the
    /// model resolved from the player's own cast history beats a DB-derived candidate list.
    #[test]
    fn an_unmatched_name_falls_back_to_the_entitys_rows() {
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];
        let subject = EarlyWarnSubject {
            target_key: Some("a turmoil toad".to_owned()),
            spell_names: vec!["Something Else Entirely".to_owned()],
        };
        assert!(early_warn_row_for(&rows, &subject).is_some());
    }

    /// A self landing and a mob landing are exclusive: the projection's `group` is exactly that
    /// distinction, and an absent `target_key` means the player.
    #[test]
    fn a_self_subject_never_matches_a_mobs_row() {
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];
        assert!(early_warn_row_for(&rows, &EarlyWarnSubject::default()).is_none());
        let mine = [self_row("Clarity", 1_000, Some(60_000))];
        assert!(early_warn_row_for(&mine, &EarlyWarnSubject::default()).is_some());
    }

    /// A row with no stated end is not a candidate at all — the honesty law, at the entry point.
    #[test]
    fn a_count_up_row_is_never_the_row_a_landing_is_tracked_by() {
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, None)];
        let subject = EarlyWarnSubject {
            target_key: Some("a turmoil toad".to_owned()),
            spell_names: Vec::new(),
        };
        assert!(early_warn_row_for(&rows, &subject).is_none());
    }

    #[test]
    fn an_arm_resolves_on_the_next_tick_and_speaks_at_its_deadline() {
        let mut early = EarlyWarnings::default();
        early.arm(arm("a1", 10, Some("a turmoil toad"), &["Dazzle"], 1_000));
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];

        // The resolve tick: the row exists now, so the arm attaches — and says nothing, because the
        // deadline is 38 seconds away.
        assert!(early.tick(2_000, &rows, &NoWatchers).is_empty());
        assert!(!early.idle(), "the warning is armed and waiting");

        // …and one second before the deadline it is still silent.
        assert!(early.tick(38_000, &rows, &NoWatchers).is_empty());

        // At the deadline it speaks, exactly once, and the schedule is then empty.
        let due = early.tick(39_000, &rows, &NoWatchers);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].fired.alert_id, "a1");
        assert_eq!(due[0].cooldown_key, "a1");
        assert!(early.idle(), "a warning that spoke is spent");
    }

    /// No row, no warning. Every ending removes the row, so this file needs no list of endings and
    /// cannot drift from the model that has one.
    #[test]
    fn a_warning_whose_row_has_gone_is_cancelled_rather_than_fired() {
        let mut early = EarlyWarnings::default();
        early.arm(arm("a1", 10, Some("a turmoil toad"), &["Dazzle"], 1_000));
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];
        early.tick(2_000, &rows, &NoWatchers);
        assert!(!early.idle());
        // The row is gone. Long past the deadline, nothing speaks.
        assert!(early.tick(99_000, &[], &NoWatchers).is_empty());
        assert!(early.idle());
    }

    /// The deadline is re-read every tick, because both halves move: the learner can raise an
    /// estimate mid-hold, and a re-land moves `started_ts`.
    #[test]
    fn a_re_stated_duration_moves_the_deadline_under_a_live_warning() {
        let mut early = EarlyWarnings::default();
        early.arm(arm("a1", 10, Some("a turmoil toad"), &["Dazzle"], 1_000));
        let short = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];
        early.tick(2_000, &short, &NoWatchers);
        // The learner beats the floor: the same row now states 90 s, so the moment that WOULD have
        // been due passes in silence.
        let long = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(90_000))];
        assert!(early.tick(39_000, &long, &NoWatchers).is_empty());
        assert_eq!(early.tick(81_000, &long, &NoWatchers).len(), 1);
    }

    /// An offset longer than the debuff fires at once: as early as the spell allows, rather than
    /// silently never arriving.
    #[test]
    fn an_overlong_offset_speaks_on_the_first_tick_it_can() {
        let mut early = EarlyWarnings::default();
        early.arm(arm("a1", 30, Some("a turmoil toad"), &["Dazzle"], 1_000));
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(24_000))];
        assert_eq!(early.tick(2_000, &rows, &NoWatchers).len(), 1);
    }

    /// An arm that never finds a row is dropped: the model states no countdown for that landing,
    /// so there is no honest end to count back from.
    #[test]
    fn an_arm_that_finds_no_row_is_dropped_at_the_window() {
        let mut early = EarlyWarnings::default();
        early.arm(arm("a1", 10, Some("a turmoil toad"), &["Dazzle"], 1_000));
        // Still looking, inside the window.
        early.tick(1_000 + ARM_RESOLVE_WINDOW_MS, &[], &NoWatchers);
        assert!(!early.idle());
        // Past it, forgotten.
        early.tick(1_000 + ARM_RESOLVE_WINDOW_MS + 1, &[], &NoWatchers);
        assert!(early.idle());
    }

    /// Re-arming the same (alert, row) replaces: a fresh landing on a row already being watched is
    /// the same warning moved, never a second one.
    #[test]
    fn a_re_land_on_a_watched_row_moves_the_warning_rather_than_adding_one() {
        let mut early = EarlyWarnings::default();
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];
        early.arm(arm("a1", 10, Some("a turmoil toad"), &["Dazzle"], 1_000));
        early.tick(2_000, &rows, &NoWatchers);
        early.arm(arm("a1", 10, Some("a turmoil toad"), &["Dazzle"], 3_000));
        early.tick(4_000, &rows, &NoWatchers);
        assert_eq!(
            early.tick(39_000, &rows, &NoWatchers).len(),
            1,
            "one warning, not two"
        );
    }

    #[test]
    fn a_landings_subject_reads_mob_then_target_and_maps_self_to_the_player() {
        let mez = ev(r#"{"kind":"cc","seq":1,"ts":1,"raw":"m","mob":"A Turmoil Toad"}"#);
        assert_eq!(
            early_warn_subject(&mez, &[]).target_key.as_deref(),
            Some("a turmoil toad"),
            "canonicalized, so two spellings are one entity"
        );
        let mine = ev(r#"{"kind":"buffApply","seq":1,"ts":1,"raw":"b","target":"self"}"#);
        assert!(
            early_warn_subject(&mine, &[]).target_key.is_none(),
            "'self' is the model's word for the player, not a mob called self"
        );
    }

    /// A warning and its break share an identity, rank-blind on both sides: the row's name comes
    /// from the ranked cast line while the break line prints the bare name.
    #[test]
    fn a_row_and_its_break_line_fold_to_the_same_identity() {
        let row = debuff_row("Mesmerization VII", "a turmoil toad", 1_000, Some(48_000));
        let brk = ev(
            r#"{"kind":"cc","seq":1,"ts":1,"raw":"b","mob":"a turmoil toad","spell":"Mesmerization","refresh":true}"#,
        );
        let from_row = row_break_identity(&row);
        let from_ev = break_event_identity(&brk, &[]);
        assert!(
            from_row.iter().any(|k| from_ev.contains(k)),
            "{from_row:?} vs {from_ev:?}"
        );
    }

    /// A self row's entity key is the literal 'self' — the word the buff families already spell in
    /// their own `target` field, which is what lets the two halves meet.
    #[test]
    fn a_self_rows_identity_is_the_word_the_wear_off_line_uses() {
        let row = self_row("Clarity", 1_000, Some(60_000));
        let brk = ev(
            r#"{"kind":"buffExpired","seq":1,"ts":1,"raw":"b","spell":"Clarity","target":"self"}"#,
        );
        assert!(row_break_identity(&row)
            .iter()
            .any(|k| break_event_identity(&brk, &[]).contains(k)));
    }

    /// Which triggers are endings. The `cc` kind carries both halves and has to be read: a bare
    /// `{kind:'cc'}` matches the application too and stays a landing-family def.
    #[test]
    fn a_trigger_is_a_break_only_when_it_can_only_be_one() {
        let accepts_true = |spec: &str| spec.eq_ignore_ascii_case("true");
        let brk = |t: Value| break_trigger_kinds(&t, &accepts_true);
        assert_eq!(
            brk(json!({"type":"event","kind":"uncharm"})),
            [BreakKind::Uncharm]
        );
        assert_eq!(
            brk(json!({"type":"event","kind":"buffFade"})),
            [BreakKind::BuffFade]
        );
        assert!(
            brk(json!({"type":"event","kind":"cc"})).is_empty(),
            "a bare cc is a landing"
        );
        assert_eq!(
            brk(json!({"type":"event","kind":"cc","where":{"refresh":"true"}})),
            [BreakKind::Cc]
        );
        assert_eq!(
            brk(json!({"type":"event","kind":"cc","where":{"spell":"Dazzle"}})),
            [BreakKind::Cc],
            "the application sentence names no spell, so a spell matcher can only be a break"
        );
        // A `raw` condition can describe no hypothetical line, and a mixed composite keeps the
        // landing behaviour rather than half of each.
        assert!(brk(json!({"type":"raw","regex":"anything"})).is_empty());
        assert!(brk(json!({
            "type": "any",
            "conditions": [
                {"type":"event","kind":"uncharm"},
                {"type":"event","kind":"buffApply"}
            ]
        }))
        .is_empty());
        // …and the `wearsOff` template's two halves are both probed, which is why this is a list.
        assert_eq!(
            brk(json!({
                "type": "any",
                "conditions": [
                    {"type":"event","kind":"buffExpired"},
                    {"type":"event","kind":"buffWearOff"}
                ]
            })),
            [BreakKind::BuffExpired, BreakKind::BuffWearOff]
        );
    }

    /// The probe is the measured shape per kind, and a kind that cannot describe this row yields
    /// nothing — a `cc` break names a mob, so it can say nothing about a buff on you.
    #[test]
    fn a_probe_is_the_break_event_this_row_would_produce() {
        let row = debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000));
        let probes = break_probes(BreakKind::Cc, &row, 9_000);
        assert_eq!(probes.len(), 1);
        assert_eq!(probes[0].spell, "Dazzle");
        assert_eq!(probes[0].ev.kind(), "cc");
        assert_eq!(probes[0].ev.str("mob"), Some("a turmoil toad"));
        assert!(probes[0].ev.bool("refresh"));
        // Not a log-shaped line, on purpose: this firing is a projection off the timer model.
        assert_eq!(
            probes[0].ev.raw(),
            "Dazzle on a turmoil toad is about to end"
        );
        // …and a self row has no `cc` break at all.
        assert!(break_probes(BreakKind::Cc, &self_row("Clarity", 1, Some(2)), 9).is_empty());
        // The self-only kind is the mirror of it.
        let mine = self_row("Clarity", 1_000, Some(60_000));
        assert_eq!(break_probes(BreakKind::BuffWearOff, &mine, 9_000).len(), 1);
        assert!(break_probes(BreakKind::BuffWearOff, &row, 9_000).is_empty());
    }

    /// A break-family watcher that says yes to everything, so the schedule is what is under test.
    struct AlwaysWatching(i64);
    impl BreakWatchers for AlwaysWatching {
        fn break_watchers(&self) -> Vec<(String, i64)> {
            vec![("a1".to_owned(), self.0)]
        }
        fn has_break_watchers(&self) -> bool {
            true
        }
        fn probe_break(
            &self,
            alert_id: &str,
            row: &BuffTimerRow,
            _now_ms: i64,
        ) -> Option<(ArmedFire, String)> {
            Some((
                ArmedFire {
                    alert_id: alert_id.to_owned(),
                    rule: "Slow wore off a mob".to_owned(),
                    sound: "classic/ding".to_owned(),
                    message: break_probe_text(row, &row.name),
                    captures: None,
                    // A stand-in for a def's own matcher; the real one puts the probe's spell on
                    // the arm (`RuleSet::probe_break`).
                    spell: None,
                },
                alert_id.to_owned(),
            ))
        }
    }

    #[test]
    fn a_break_family_def_arms_from_the_row_and_speaks_before_the_break() {
        let mut early = EarlyWarnings::default();
        let rows = [debuff_row(
            "Shiftless Deeds",
            "King Tranix",
            1_000,
            Some(60_000),
        )];
        let watchers = AlwaysWatching(5);

        // The row exists; the deadline is 55 s in. Nothing yet.
        assert!(early.tick(2_000, &rows, &watchers).is_empty());
        assert!(!early.idle(), "the row is watched");

        let due = early.tick(56_000, &rows, &watchers);
        assert_eq!(due.len(), 1);
        assert_eq!(
            due[0].fired.message,
            "Shiftless Deeds on King Tranix is about to end"
        );
        // A spoken watch is kept, not deleted: the break line at the end of this same hold has to
        // be suppressible against it. It also does not speak twice.
        assert!(early.tick(57_000, &rows, &watchers).is_empty());
        assert!(!early.idle());

        // …and the break arriving now is swallowed. One landing, one firing.
        let brk = ev(
            r#"{"kind":"buffFade","seq":1,"ts":61000,"raw":"b","spell":"Shiftless Deeds","target":"King Tranix"}"#,
        );
        assert!(early.break_spoken("a1", &break_event_identity(&brk, &[])));
        // The watch is consumed by the break it pre-empted, so a re-land can warn again.
        assert!(!early.break_spoken("a1", &break_event_identity(&brk, &[])));
    }

    /// An early break is never silent: the hold ends before the deadline, so no warning was ever
    /// spoken and nothing suppresses the at-break firing.
    #[test]
    fn a_hold_that_breaks_early_suppresses_nothing() {
        let mut early = EarlyWarnings::default();
        let rows = [debuff_row(
            "Shiftless Deeds",
            "King Tranix",
            1_000,
            Some(60_000),
        )];
        early.tick(2_000, &rows, &AlwaysWatching(5));
        let brk = ev(
            r#"{"kind":"buffFade","seq":1,"ts":20000,"raw":"b","spell":"Shiftless Deeds","target":"King Tranix"}"#,
        );
        assert!(
            !early.break_spoken("a1", &break_event_identity(&brk, &[])),
            "nothing spoke, so nothing is spent"
        );
    }

    /// A deadline already in the past never arms on the break path, unlike the landing path,
    /// because the arming here is the row's mere existence — and rows are rebuilt from history on
    /// every fold, so an overdue row would announce a hold that ended months ago.
    #[test]
    fn a_row_already_past_its_deadline_arms_no_break_warning() {
        let mut early = EarlyWarnings::default();
        let rows = [debuff_row(
            "Shiftless Deeds",
            "King Tranix",
            1_000,
            Some(60_000),
        )];
        assert!(early.tick(90_000, &rows, &AlwaysWatching(5)).is_empty());
        assert!(early.idle(), "nothing was armed at all");
    }

    /// A watch retires with its row, or with the def that wanted it.
    #[test]
    fn a_watch_dies_with_its_row_and_with_its_def() {
        let mut early = EarlyWarnings::default();
        let rows = [debuff_row(
            "Shiftless Deeds",
            "King Tranix",
            1_000,
            Some(60_000),
        )];
        early.tick(2_000, &rows, &AlwaysWatching(5));
        assert!(!early.idle());
        early.tick(3_000, &[], &AlwaysWatching(5));
        assert!(early.idle(), "the hold ended, however it ended");

        early.tick(4_000, &rows, &AlwaysWatching(5));
        assert!(!early.idle());
        // The alert was deleted, disabled, or had its offset removed while the watch was pending.
        early.tick(5_000, &rows, &NoWatchers);
        assert!(early.idle());
    }
}
