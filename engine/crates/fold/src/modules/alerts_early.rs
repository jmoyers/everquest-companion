//! THE EARLY-WARNING OFFSET, ENGINE-SIDE (JOS-216 + JOS-235, ported by JOS-492) —
//! `shared/earlyWarning.ts`'s pure rules and `main/modules/alertsEarlyWarning.ts`'s scheduler, in
//! one file because over there the split is an Electron boundary and here there is none.
//!
//! ── WHAT THE FEATURE IS, IN ONE PARAGRAPH ──────────────────────────────────────────────────────
//!
//! An alert that already fires when a debuff LANDS can instead fire N seconds before that debuff's
//! ESTIMATED END. It is an OFFSET ON AN EXISTING ALERT and not a new kind of alert: one option, one
//! number, and everything else — the sound, the cooldown, the trigger — is the alert the user
//! already wrote. IT ADDS NO DURATION TRACKING. The estimated end already exists as the timer-row
//! projection (`buff_timer_rows.rs`, landed by JOS-487 for exactly this), and a `Countdown` row
//! states `started_ts + duration_ms` — the same number the debuffs overlay draws its bar from.
//!
//! WHICH MEANS THE HONESTY LAW REACHES THIS SURFACE UNCHANGED: a row the model can put no honest
//! number on counts UP and has no `duration_ms`, so there is no end to count backwards from, and
//! such a landing arms NOTHING. Silence is the honest answer; inventing a duration to warn against
//! would be exactly the invented "remaining" that law forbids.
//!
//! ── WHY THIS COULD NOT BE PORTED BEFORE, AND WHAT CHANGED ──────────────────────────────────────
//!
//! JOS-482 compiled an `earlyWarnSec` def OUT (`alerts_rules.rs Rule::compile` answered `None`) and
//! argued the refusal at length: the fire needs a WALL-CLOCK HEARTBEAT and the buffs/buffTimers
//! projection, and this crate had neither wired into the alerts module — so a def carrying one was
//! refused rather than fired at the wrong instant, "a sound made a minute early being a wrong answer
//! wearing a right answer's clothes". Both halves have since landed: `Fold::tick` is the heartbeat
//! (JOS-481, owner ruling 22) and `build_timer_rows` is the projection (JOS-487). So the refusal is
//! gone and this is what replaces it.
//!
//! ── WHY AN ARM IS RESOLVED ON THE NEXT TICK AND NOT AT THE MATCH ───────────────────────────────
//!
//! The alerts module is registered BEFORE buffs and buffTimers (`WIRING_ORDER`), so at the instant a
//! mez landing matches an alert, the row that landing produces DOES NOT EXIST YET — the two modules
//! that build it have not folded the event. Looking the row up in `on_event` would find the PREVIOUS
//! state of the world every single time. So a match files an ARM REQUEST carrying what the landing
//! was about, and the next heartbeat — by which point every module has folded the same event —
//! resolves it against the projection. A resolution delay of up to a second is invisible on a
//! warning measured in tens of seconds, and it is the only ordering in which the answer is right.
//!
//! A request that finds no row within [`ARM_RESOLVE_WINDOW_MS`] is DROPPED, silently and on purpose:
//! it means the model states no countdown for that landing, and there is no honest end to count back
//! from.
//!
//! ── AND WHY CANCELLATION IS "THE ROW IS GONE" ──────────────────────────────────────────────────
//!
//! A pending warning must not fire when the debuff already broke — the mob died, a nuke woke it, you
//! zoned, someone dispelled it. Enumerating those endings here would be a second opinion about a
//! question the timer model already answers, and it would drift from it. Every one of them removes
//! the row from the projection, so the cancellation rule is one sentence: NO ROW, NO WARNING. It is
//! also self-correcting for endings nobody has thought of yet. The DEADLINE is re-read from the row
//! on every tick for the same reason: the learner can raise an estimate mid-hold, and a re-land moves
//! the landing.
//!
//! ── AND WHY A BREAK-FAMILY DEF ARMS FROM THE ROW INSTEAD (JOS-235) ─────────────────────────────
//!
//! Everything above describes a LANDING-triggered def, and it silences a break-triggered one
//! outright: the arming event and the ending are the SAME line, so the arm resolves against a world
//! that same event has already emptied and is dropped at the window without a sound. Net effect, and
//! it is the worst possible one: typing a number into "Warn early" DELETED the alert (found in
//! release testing with `earlyWarnSec: 90` on a breaks-for-Dazzle alert — no warning, and no break
//! alert).
//!
//! So a break-family def arms from the ROW APPEARING. The trigger keeps its ordinary meaning: the
//! break line still FIRES the alert. One landing yields exactly one firing, and which one depends on
//! what the world did — the hold survives to the deadline and the WARNING speaks (the at-break firing
//! for THAT landing is then swallowed), or the hold breaks early and the break fires normally. AN
//! EARLY BREAK MUST NEVER BE SILENT: every failure mode here degrades to "the alert behaves exactly
//! as it did before the offset existed".

use crate::event::Event;
use crate::jsmap::JsMap;
use crate::modules::buff_timer_rows::{
    timer_name_base, timer_name_key, BuffTimerRow, RowGroup, TimerMode,
};
use eqlog::jsstr::js_trim;
use eqlog::names::id_key;
use serde_json::{json, Value};

/// The bounds on the offset, in SECONDS — `shared/earlyWarning.ts`.
///
/// The floor is 1 because the model's own clock is a 1-second heartbeat: an offset finer than the
/// tick cannot be delivered, so promising it would be a lie in the UI. The ceiling is 120 because it
/// is past the longest thing anybody warns about early, and it refuses the typo that would arm a
/// warning before the spell had finished landing.
pub const MIN_EARLY_WARN_SEC: i64 = 1;
pub const MAX_EARLY_WARN_SEC: i64 = 120;

/// How long an unresolved arm request keeps looking for its row.
///
/// Generous by design and still short: the row it is waiting for is created by the SAME event that
/// armed it, so on the ordinary path it is already there on the first tick. Five seconds is the
/// slack for a heartbeat that was busy, not a window in which a row might still turn up.
pub const ARM_RESOLVE_WINDOW_MS: i64 = 5_000;

/// The most warnings held at once, across every alert. A BOUND, not a policy: an AE mez plus a chain
/// of adds can legitimately arm a dozen, and anything past this is a def matching something far
/// broader than its author meant. Oldest-armed goes first (insertion order) because it is the one
/// closest to having resolved or expired anyway.
pub const MAX_ARMED_WARNINGS: usize = 200;

/// The key separator — a NUL, which can appear in no alert id and in no row id, so an alert can
/// never collide with another alert's row. SPELLED AS AN ESCAPE and never written as a raw byte
/// (AGENTS.md: git calls such a file binary and diff/blame/grep go dark).
const KEY_SEP: char = '\u{0}';

/// A STORED OFFSET AS A NUMBER THIS APP WILL ACT ON, or `None` for "no warning" —
/// `normalizeEarlyWarnSec`, and it is the APP'S normalizer rather than a reading of it.
///
/// `None` IS THE DEFAULT AND THE FALLBACK, both of which mean the same thing: fire when the trigger
/// matches, which is what every alert written before this existed already did. A zero, a negative, a
/// NaN, a non-number and an absent key all land here, so nothing has to be migrated and a stranger's
/// shared bundle cannot arm a warning with a value this build would not have offered.
///
/// **IT IS THE FULL NORMALIZER NOW, WHICH IS A CHANGE OF MEANING RATHER THAN OF CODE** (JOS-492).
/// While an `earlyWarnSec` def was compiled OUT, `alerts_rules.rs` asked only "was one asked for at
/// all" and treated an out-of-range number as ABSENT — the conservative direction for a reader whose
/// only use for the answer was to REFUSE. Now that the engine honours the offset it has to CLAMP the
/// way the app clamps, or the two would fire at two different instants for the same def. That is
/// also what lifts the arm gate in `dataServer/alertsAudioRules.ts`.
#[must_use]
pub fn normalize_early_warn_sec(raw: Option<&Value>) -> Option<i64> {
    let n = raw?.as_f64()?;
    if !n.is_finite() {
        return None;
    }
    // `Math.round` — ROUND HALF UP, which is not `f64::round` (round half away from zero). They
    // differ only for negatives, and a negative is refused one line below either way; the
    // distinction is spelled out so a later reader does not "simplify" it.
    #[allow(clippy::cast_possible_truncation)]
    let sec = (n + 0.5).floor() as i64;
    if sec < MIN_EARLY_WARN_SEC {
        return None;
    }
    Some(sec.min(MAX_EARLY_WARN_SEC))
}

// ── the rows a landing can be measured against ─────────────────────────────────────────────────

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

/// WHAT A LANDING WAS ABOUT — the half of the arming event that decides which timer row it made.
///
/// `target_key` is the canonical (`id_key`'d) entity the spell landed on; absent means the PLAYER,
/// and the two are exclusive because the projection's `group` is exactly that distinction.
///
/// `spell_names` is EVERY name the line could be, not a name (JOS-84's law): the landing sentences
/// this feature is aimed at are shared across whole spell families, so the event's `spell` field is
/// a documented best-effort pick and `candidates` carries the truth. Both go in, and the match
/// accepts any of them.
#[derive(Debug, Clone, Default)]
pub struct EarlyWarnSubject {
    pub target_key: Option<String>,
    pub spell_names: Vec<String>,
}

/// THE ROW A LANDING IS TRACKED BY, or `None` when the model states no end for it.
///
/// THE RULE, in the order it is applied, and its honest limit stated with it:
///
///  1. Only rows with a STATED end. A count-up row arms nothing.
///  2. The row must be on the subject's entity — the mob the line named, or the player.
///  3. If ANY of those rows answers to one of the subject's spell names, only those rows are
///     considered. Rank-stripped and case-folded on both sides, because the row's name comes from
///     the CAST line (`Mesmerization VII` — the only line in the family that carries a rank) while
///     the arming event's names come from the DB candidates for a landing sentence that carries
///     none. A subject whose names match nothing on that entity falls back to ALL of them rather
///     than to nothing: the parser's candidate list is DB-derived, and a row the model resolved from
///     the player's own cast history is the better answer when the two disagree.
///  4. Of what is left, the MOST RECENT landing — the largest `started_ts`. The arming event is the
///     line that produced the row, so on the ordinary path there is exactly one and this picks it.
///
/// THE LIMIT: two different debuffs landing on one mob in the same second, whose sentences name no
/// spell this build can tell apart, are one entity with two rows and step 4 takes the newer. That is
/// a warning about the wrong one of two things the user is holding on that mob — never a warning
/// about a mob they are not fighting.
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
    // `reduce((best, r) => r.startedTs > best.startedTs ? r : best)` — STRICTLY greater, so a tie
    // keeps the EARLIER row and the answer does not depend on a sort's stability.
    pool.iter().copied().reduce(|best, r| {
        if r.started_ts > best.started_ts {
            r
        } else {
            best
        }
    })
}

/// WHEN THE WARNING FOR THIS ROW IS DUE — the row's estimated end minus the offset.
///
/// Re-read on every tick rather than computed once at the landing, because both halves move: the
/// learner can raise the estimate mid-hold and a re-land moves `started_ts`. A warning that fixed its
/// own deadline at the landing would go on describing a countdown the app had already corrected.
#[must_use]
pub fn early_warn_fire_at(row: &BuffTimerRow, sec: i64) -> Option<i64> {
    if !has_stated_end(row) {
        return None;
    }
    Some(row.started_ts + row.duration_ms? - sec * 1000)
}

// ── the break family ───────────────────────────────────────────────────────────────────────────

/// The event kinds whose arrival means a tracked row has ENDED — measured against the parser rather
/// than assumed.
///
///   * `Cc` — a mez/root spell's wear-off, `refresh: true` (the `ccSpell` roster).
///   * `Uncharm` — a charm spell's wear-off (the `charmSpell` roster, tested first).
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

/// The break kind ONE primitive condition watches for, or `None` when it is not a break condition.
///
/// THE `cc` KIND CARRIES BOTH HALVES and so has to be read rather than listed: the same event is the
/// application (`a turmoil toad has been mesmerized.`) and the break (`Your Dazzle spell has worn off
/// of a turmoil toad.`). Two things separate them, and a def only has to state either:
///
///   `refresh` — present and 'true' ONLY on the break shape. What both `breaks` templates pin.
///   `spell`   — the APPLICATION SENTENCE NAMES NO SPELL. It carries `candidates` and no `spell`
///               field at all, and an absent field is a no-match before the JOS-84 candidate widening
///               is ever consulted. So a `cc` condition that constrains `spell` can only ever fire on
///               a break, whether or not it also says `refresh`. That is not a nicety: the alert
///               EDITOR keeps only the FIRST `where` entry of a condition, so a stored
///               `{spell, refresh}` breaks def that has been through the dialog comes back out as
///               `{spell}` alone — and it still fires only on breaks, so it must still be read as one.
///
/// A bare `{kind: 'cc'}` with no such constraint matches the APPLICATION too and stays a
/// landing-family def, which is what keeps JOS-216's behaviour byte-for-byte for every def written
/// before this existed.
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

/// THE BREAK KINDS A DEF WATCHES FOR — empty when it is not a break-family def at all.
///
/// EVERY condition must be a break condition, and there must be at least one. A def with a `raw` or
/// an `app` condition is therefore never break-family, which is the honest answer twice over: this
/// file cannot build a hypothetical LOG LINE for a pattern to match (the probe below builds a
/// projected sentence, deliberately not a log-shaped one), and a renderer-evaluated app signal never
/// sees an event at all. A MIXED composite (one landing condition, one break condition) keeps
/// JOS-216's landing behaviour rather than half of each.
///
/// It returns a LIST because the `wearsOff` suggestion template is an `any` composite over
/// `buffExpired` + `buffWearOff`, and both halves have to be probed.
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
/// An unambiguous row answers to its own name; a FAMILY row (JOS-84: one landing sentence, four
/// spells) answers to every candidate, because the log itself has not said which one it is and the
/// break line will name exactly one of them. Ranks are stripped and the list is deduped
/// case-insensitively, FIRST SPELLING WINS.
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
/// model, and the recent-fires panel says so. It still names the two things the user needs in order
/// to tell one warning from another — the spell, and which mob it is on.
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

/// WHAT A BREAK OF THIS ROW WOULD LOOK LIKE — the seam, stated in one place.
///
/// A def's `where` is written against the shape of the BREAK EVENT, so the only honest way to ask
/// "would this def announce the break of this row" is to ask the def's own matcher, with the event it
/// was written for. Re-implementing the question — "compare the def's spell key to the row's name" —
/// would be a second matcher beside the real one: it would have to re-derive regex specs, the
/// candidate widening and the field-absence rule, and it would drift the first time any of them
/// changed.
///
/// SO THE PROBE IS A FABRICATION, AND HERE IS ITS ENTIRE BLAST RADIUS. It is built here, handed to
/// the rule's own matcher, and dropped. It is never delivered on the bus, never folded by any module,
/// never counted, and never learned from. Nothing downstream can mistake it for a line the game
/// printed, because `raw` is deliberately NOT log-shaped: it is a projection sentence, which is also
/// what the recent-fires panel shows for such a firing.
///
/// THE FIELDS ARE THE MEASURED ONES, per kind:
///   `cc`          `{ mob, spell, refresh: true }`  — no candidates: the BREAK shape carries none.
///   `uncharm`     `{ mob, spell }`                 — no refresh; a charm break never carries one.
///   `buffFade`    `{ spell, target }`              — `target` omitted for a row on you.
///   `buffWearOff` `{ spell, candidates, target: 'self' }` — self rows only.
///   `buffExpired` `{ spell, target }`              — 'self' for a self row, else the entity's name.
///
/// A kind that cannot describe this row yields NOTHING (a `cc` break names a mob, so it can say
/// nothing about a buff on you), which is a def that arms no warning and still fires at the break.
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

/// THE IDENTITY A WARNING AND ITS BREAK SHARE — `<entity>|<spell family>`, folded on both sides.
///
/// It is what lets the at-break firing be suppressed for a landing whose warning already spoke,
/// WITHOUT the alerts module having to re-derive a timer row id from a break line (that id scheme
/// belongs to `build_timer_rows`, and a second copy of it here is the drift this file is trying not
/// to be). A row contributes one key per name it answers to; an event contributes one per name it
/// could be, and any overlap is the same hold.
///
/// RANK-BLIND BY CONSTRUCTION, and it has to be: the row's name comes from the ranked CAST line while
/// the break line prints the bare name, so an identity that kept the numeral would match nothing it
/// was built to match.
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

/// WHAT A LANDING WAS ABOUT, from the event that carried it.
///
/// The entity is read dynamically from `mob` (the CC/charm families) then `target` (the buff
/// families) — the same arbitrary-field access a `where` matcher has always done, because these are
/// fields of some event shapes and not others. `buffApply` spells a self-landing as the literal
/// string 'self', which is the model's own word for "the player" and is why it maps to NO entity key
/// rather than to a mob called self. THE LOOP BREAKS ON THE FIRST NON-EMPTY FIELD, even when that
/// field maps to nothing.
///
/// `spell_names` is handed in rather than derived here: the caller has already resolved which names
/// this event can answer to (the JOS-84 candidate widening), and re-deriving them would be a second
/// copy of that rule.
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

/// THE IDENTITY A BREAK EVENT CARRIES — the other half of [`row_break_identity`].
///
/// The entity is read the same dynamic way [`early_warn_subject`] reads it, and 'self' is KEPT as
/// the literal key rather than mapped away, because a row on the player is exactly what it has to
/// match.
///
/// THE EVENT'S OWN `spell` IS READ HERE rather than taken from the caller's list, because the
/// caller's list is the SPEECH one and that table deliberately claims only the kinds a spoken alert
/// names a spell for — `uncharm` is not one of them, so a charm break arrived with no name at all and
/// no warning of it could ever have been matched to its own break line. This question is not "what
/// should the alert say", it is "which hold ended", and every break sentence in the three families
/// names it.
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

// ── the scheduler ──────────────────────────────────────────────────────────────────────────────

/// THE FIRING AN ARMED WARNING WILL MAKE, built at match time so it says what the LANDING matched.
///
/// It is the alert's identity plus the three fields a `Fire` frame carries. `alert_id` is not on the
/// frame and is carried anyway, because the warning has to re-read its own def when it comes due —
/// a warning can be armed for a minute, and an alert the user deleted or switched off in the
/// meantime must not speak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArmedFire {
    pub alert_id: String,
    pub rule: String,
    pub sound: String,
    pub message: String,
    /// THE WORDS THE ARMING MATCH TOOK (JOS-500), carried across the wait rather than re-resolved at
    /// delivery. A warning can be armed for a minute and the event it armed on is long gone by the
    /// time the heartbeat speaks; asking the world again would be a second answer to a question the
    /// match already answered, and on a break-family arm there is no event left to ask at all.
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
    /// WHEN THE THING THIS WARNING IS EARLY FOR IS DUE (JOS-378) — the watched row's stated end.
    ///
    /// COMPUTED AS `fire instant + sec * 1000` rather than re-read off the row, and the two are the
    /// same number by construction ([`early_warn_fire_at`] is `started + duration - sec * 1000`).
    /// Adding the offset back is the honest expression of what this field MEANS — the deadline the
    /// lead time was measured backwards from — and it is what the retired evaluator wrote in the
    /// same place, so the app receives the identical number under either.
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

/// WHERE A BREAK-FAMILY DEF'S PROBE COMES FROM.
///
/// A TRAIT RATHER THAN A CLOSURE, and the reason is ownership rather than taste. Over there the
/// watcher carries `probe: (row) => …` closed over the alerts module itself; here the scheduler and
/// the rule set are two FIELDS of that module, so the scheduler is handed the rule set by reference
/// and the two borrows stay disjoint. A boxed closure capturing the rule set would borrow the very
/// object the caller is also holding.
///
/// MATCHING AN ALERT IS THE RULE SET'S JOB AND THERE MUST BE EXACTLY ONE IMPLEMENTATION OF IT — see
/// the fabrication note on [`break_probes`]. That is why this is a seam and not a second matcher.
pub trait BreakWatchers {
    /// The break-family defs that want to be told about live rows — `(alert_id, sec)` each.
    ///
    /// Rebuilt each tick rather than cached with the compile, because `enabled` and the offset can
    /// change under it and the list is at most a handful of defs. When it is EMPTY (the
    /// overwhelmingly common case) the scheduler does not read the timer projection at all.
    fn break_watchers(&self) -> Vec<(String, i64)>;

    /// Whether [`Self::break_watchers`] would answer with anything — the same question without the
    /// allocation, asked once per beat to decide whether the timer projection is built at all.
    fn has_break_watchers(&self) -> bool;

    /// Would this def announce the break of this row — asked of the def's OWN matcher. The firing it
    /// hands back is built exactly like an ordinary one, on the same cooldown clock the REAL break
    /// event would have chosen.
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
    /// BREAK-FAMILY watches, keyed the same way. Filed from the ROW APPEARING rather than from an
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

    /// THE AT-BREAK FIRING FOR A LANDING THIS ALERT ALREADY WARNED ABOUT — true when it is spent.
    ///
    /// A watch is CONSUMED by the break it pre-empted (one landing, one firing), so a RE-LAND on the
    /// same mob arms and can warn again; and a break with no matching spoken watch — the mob broke
    /// early, the def never armed, the process restarted — is not suppressed by anything, which is
    /// the ticket's whole point: an early break is never silent.
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
    /// warnings that have come due.
    ///
    /// THE PROJECTION IS READ BY THE CALLER AND HANDED IN — which is the one shape difference from
    /// the TypeScript, where the module holds a lazy pull closure. `Registry::tick` builds the rows
    /// ONCE per beat, BEFORE any module's `on_tick` runs, which is exactly the instant the lazy pull
    /// would have read them at: over there the alerts module is registered before buffs and
    /// buffTimers, so its heartbeat runs before theirs and the rows it pulls are the ones this beat
    /// started with.
    ///
    /// NOTHING IS BUILT WHEN NOTHING OWES: the caller skips the whole call when [`Self::idle`] and no
    /// def is watching.
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
            // Re-arming the same (alert, row) REPLACES: a fresh landing on a row already being
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
    /// A deadline ALREADY IN THE PAST fires on this very tick, which is the honest degradation for an
    /// offset longer than the debuff (warn 30 s early on a 24 s mez): the warning is as early as the
    /// spell allows, rather than silently never arriving.
    fn advance(&mut self, rows: &[BuffTimerRow], now_ms: i64) -> Vec<EarlyWarnDue> {
        let mut due = Vec::new();
        let mut retire: Vec<String> = Vec::new();
        for (key, a) in self.armed.iter() {
            // NO ROW: the hold ended — a break line, a death, a zone, a cull. Nothing left to warn
            // about.
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
    /// A row is watched ONCE PER LANDING: `landed_ts` is the row's own clock, so a re-mez (which
    /// moves `started_ts` on the same row id) is a new landing and re-arms, while an unchanged row is
    /// left exactly as it is — including after its warning has spoken, which is what stops a fired
    /// watch from immediately re-arming and speaking again a second later.
    ///
    /// AND A DEADLINE ALREADY IN THE PAST NEVER ARMS. This is the one place the break family reads
    /// differently from the landing path, where an overlong offset fires at once. Here the arming is
    /// the row's mere EXISTENCE: rows are rebuilt from history on every character load, so an
    /// already-overdue row would announce a hold that ended months ago the instant the fold landed. A
    /// warning whose moment has passed simply does not happen, and the break line still fires.
    fn watch_breaks(
        &mut self,
        rows: &[BuffTimerRow],
        watching: &[(String, i64)],
        watchers: &dyn BreakWatchers,
        now_ms: i64,
    ) {
        // Drop what is no longer watchable: the row is gone (the hold ended, however it ended), or
        // the alert was deleted, disabled, or had its offset removed while a warning was pending.
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

    /// The break warnings that have come due. A watch is NOT deleted when it fires — it stays, marked
    /// `spoken`, so the break line arriving at the end of that same hold can be suppressed against it.
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

    /// A COUNTDOWN ROW ON A MOB — the shape an early warning is measured against.
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
            // This suite is about the SCHEDULE — when a warning arms, cancels and comes due — and a
            // warning's words ride the arm without the scheduler ever reading them. The speech half
            // is proven where it is decided, in `alerts_rules`.
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

    // ── the offset itself ─────────────────────────────────────────────────────────────────────

    #[test]
    fn the_deadline_is_the_rows_stated_end_minus_the_offset() {
        let row = debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000));
        assert_eq!(early_warn_fire_at(&row, 10), Some(1_000 + 48_000 - 10_000));
        // A COUNT-UP ROW STATES NO END, so there is nothing to count backwards from and the honest
        // answer is silence rather than an invented duration.
        let up = debuff_row("Dazzle", "a turmoil toad", 1_000, None);
        assert_eq!(early_warn_fire_at(&up, 10), None);
    }

    // ── which row a landing is tracked by ─────────────────────────────────────────────────────

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
        // …and a NAMED subject narrows to the rows that answer to that name, older or not.
        let named = EarlyWarnSubject {
            target_key: Some("a turmoil toad".to_owned()),
            spell_names: vec!["Dazzle".to_owned()],
        };
        assert_eq!(
            early_warn_row_for(&rows, &named).map(|r| r.name.as_str()),
            Some("Dazzle")
        );
    }

    /// A SUBJECT WHOSE NAMES MATCH NOTHING FALLS BACK TO ALL OF THEM, never to nothing: the
    /// parser's candidate list is DB-derived, and a row the model resolved from the player's own
    /// cast history is the better answer when the two disagree.
    #[test]
    fn an_unmatched_name_falls_back_to_the_entitys_rows() {
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];
        let subject = EarlyWarnSubject {
            target_key: Some("a turmoil toad".to_owned()),
            spell_names: vec!["Something Else Entirely".to_owned()],
        };
        assert!(early_warn_row_for(&rows, &subject).is_some());
    }

    /// A SELF LANDING AND A MOB LANDING ARE EXCLUSIVE — the projection's `group` is exactly that
    /// distinction, and an absent `target_key` means the player.
    #[test]
    fn a_self_subject_never_matches_a_mobs_row() {
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];
        assert!(early_warn_row_for(&rows, &EarlyWarnSubject::default()).is_none());
        let mine = [self_row("Clarity", 1_000, Some(60_000))];
        assert!(early_warn_row_for(&mine, &EarlyWarnSubject::default()).is_some());
    }

    /// A ROW WITH NO STATED END IS NOT A CANDIDATE AT ALL — the honesty law, at the entry point.
    #[test]
    fn a_count_up_row_is_never_the_row_a_landing_is_tracked_by() {
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, None)];
        let subject = EarlyWarnSubject {
            target_key: Some("a turmoil toad".to_owned()),
            spell_names: Vec::new(),
        };
        assert!(early_warn_row_for(&rows, &subject).is_none());
    }

    // ── the landing path, end to end ──────────────────────────────────────────────────────────

    #[test]
    fn an_arm_resolves_on_the_next_tick_and_speaks_at_its_deadline() {
        let mut early = EarlyWarnings::default();
        early.arm(arm("a1", 10, Some("a turmoil toad"), &["Dazzle"], 1_000));
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000))];

        // THE RESOLVE TICK. The row exists now (the modules that build it have folded the landing),
        // so the arm attaches — and says nothing, because the deadline is 38 seconds away.
        assert!(early.tick(2_000, &rows, &NoWatchers).is_empty());
        assert!(!early.idle(), "the warning is armed and waiting");

        // …and one second before the deadline it is still silent.
        assert!(early.tick(38_000, &rows, &NoWatchers).is_empty());

        // AT THE DEADLINE IT SPEAKS, exactly once, and the schedule is then empty.
        let due = early.tick(39_000, &rows, &NoWatchers);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].fired.alert_id, "a1");
        assert_eq!(due[0].cooldown_key, "a1");
        assert!(early.idle(), "a warning that spoke is spent");
    }

    /// NO ROW, NO WARNING — the one-sentence cancellation rule. The hold ended somehow (a break, a
    /// death, a zone, a dispel) and every one of those removes the row, so this file needs no list
    /// of endings and cannot drift from the model that has one.
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

    /// THE DEADLINE IS RE-READ EVERY TICK, because both halves move: the learner can raise an
    /// estimate mid-hold, and a re-land moves `started_ts`. A warning that fixed its own deadline
    /// at the landing would be describing a countdown the model had already corrected.
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

    /// AN OFFSET LONGER THAN THE DEBUFF FIRES AT ONCE — the honest degradation for "warn me 30 s
    /// early" on a 24 s mez. As early as the spell allows, rather than silently never arriving.
    #[test]
    fn an_overlong_offset_speaks_on_the_first_tick_it_can() {
        let mut early = EarlyWarnings::default();
        early.arm(arm("a1", 30, Some("a turmoil toad"), &["Dazzle"], 1_000));
        let rows = [debuff_row("Dazzle", "a turmoil toad", 1_000, Some(24_000))];
        assert_eq!(early.tick(2_000, &rows, &NoWatchers).len(), 1);
    }

    /// AN ARM THAT NEVER FINDS A ROW IS DROPPED, silently and on purpose: the model states no
    /// countdown for that landing, and there is no honest end to count back from.
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

    /// RE-ARMING THE SAME (ALERT, ROW) REPLACES: a fresh landing on a row already being watched is
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

    // ── the subject and the identity ──────────────────────────────────────────────────────────

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

    /// A WARNING AND ITS BREAK SHARE AN IDENTITY, and it is rank-blind on both sides — the row's
    /// name comes from the ranked cast line while the break line prints the bare name.
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

    /// A SELF ROW'S ENTITY KEY IS THE LITERAL 'self' — the one the buff families already spell in
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

    // ── the break family ──────────────────────────────────────────────────────────────────────

    /// WHICH TRIGGERS ARE ENDINGS. The `cc` kind carries BOTH halves and has to be READ: a bare
    /// `{kind:'cc'}` matches the application too and stays a landing-family def, which is what
    /// keeps JOS-216's behaviour byte-for-byte for every def written before JOS-235 existed.
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
        // A `raw` condition can describe no hypothetical line, and a MIXED composite keeps the
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
        // …and the `wearsOff` template's two halves are both probed, which is why this is a LIST.
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

    /// THE PROBE IS THE MEASURED SHAPE PER KIND, and a kind that cannot describe this row yields
    /// NOTHING — a `cc` break names a mob, so it can say nothing about a buff on you.
    #[test]
    fn a_probe_is_the_break_event_this_row_would_produce() {
        let row = debuff_row("Dazzle", "a turmoil toad", 1_000, Some(48_000));
        let probes = break_probes(BreakKind::Cc, &row, 9_000);
        assert_eq!(probes.len(), 1);
        assert_eq!(probes[0].spell, "Dazzle");
        assert_eq!(probes[0].ev.kind(), "cc");
        assert_eq!(probes[0].ev.str("mob"), Some("a turmoil toad"));
        assert!(probes[0].ev.bool("refresh"));
        // NOT A LOG-SHAPED LINE, on purpose: this firing is a projection off the timer model, and
        // the recent-fires panel says so.
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

    /// A break-family watcher that says yes to everything, so the SCHEDULE is what is under test.
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
                    // The FAKE watcher's probe, which stands in for a def's own matcher here — the
                    // real one puts the probe's spell on the arm (`RuleSet::probe_break`).
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
        // A SPOKEN WATCH IS KEPT, not deleted — the break line at the end of this same hold has to
        // be suppressible against it. It also does not speak twice.
        assert!(early.tick(57_000, &rows, &watchers).is_empty());
        assert!(!early.idle());

        // …and the break arriving now is SWALLOWED, because the alert already spoke for this
        // landing. One landing, one firing.
        let brk = ev(
            r#"{"kind":"buffFade","seq":1,"ts":61000,"raw":"b","spell":"Shiftless Deeds","target":"King Tranix"}"#,
        );
        assert!(early.break_spoken("a1", &break_event_identity(&brk, &[])));
        // The watch is CONSUMED by the break it pre-empted, so a re-land can warn again.
        assert!(!early.break_spoken("a1", &break_event_identity(&brk, &[])));
    }

    /// AN EARLY BREAK IS NEVER SILENT — the whole ticket. The hold ends before the deadline, so no
    /// warning was ever spoken and nothing suppresses the at-break firing.
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

    /// A DEADLINE ALREADY IN THE PAST NEVER ARMS ON THE BREAK PATH — the one place it reads
    /// differently from the landing path, and the reason is that the arming here is the row's mere
    /// EXISTENCE. Rows are rebuilt from history on every fold, so an already-overdue row would
    /// announce a hold that ended months ago the instant the engine went live.
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

    /// AND A WATCH RETIRES WITH ITS ROW, or with the def that wanted it.
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
