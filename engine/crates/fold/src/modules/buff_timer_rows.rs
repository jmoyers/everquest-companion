//! The timer-row projection: one fold over `buffs.active` and `buffTimers.holds`/`.ends`, producing
//! the rows the two floating timer windows draw. Pure — no Electron, no React, no clock.
//!
//! It lives in `fold` because two callers need it and only one of them is a view: the serve layer
//! cuts windows out of it, and the alerts evaluator needs the same rows to know when a running timer
//! ENDS — the early-warning offset is `started_ts + duration_ms - sec * 1000`.
//!
//! The rows carry no clock. Each carries its own `started_ts` and its own mode, and what a row reads
//! at an instant is a separate pure function ([`timer_reading`]), which is what lets a renderer tick
//! at 1 Hz without another round trip.
//!
//! One divergence, stated: the final tiebreak is a CODE POINT comparison, because a host collation
//! in the fold would make the answer a property of the machine. Two rows whose modes and end
//! instants are identical and whose names differ only by an accent therefore order differently here
//! than in the renderer. Every other term of the comparison is exact.

use eqlog::jsstr::js_trim;
use regex::Regex;
use std::sync::OnceLock;

use crate::modules::buff_timers::{CcEnd, CcHold};
use crate::modules::buffs_shapes::BuffClass;
use crate::modules::buffs_view::ActiveBuff;

/// How a row's time is read.
///
///   * `Countdown` — the estimator states a duration: a receding bar, `duration_ms` present.
///   * `Elapsed` — nobody states one: time counts up from the landing, `duration_ms` absent.
///   * `Permanent` — a spell that never expires: no timer at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerMode {
    Countdown,
    Elapsed,
    Permanent,
}

impl TimerMode {
    /// The wire spelling the renderer's union expects.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Countdown => "countdown",
            Self::Elapsed => "elapsed",
            Self::Permanent => "permanent",
        }
    }
}

/// Which of the two timer windows a row belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerSurface {
    Buffs,
    Debuffs,
}

impl TimerSurface {
    /// The overlay kind's own spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Buffs => "buffs",
            Self::Debuffs => "debuffs",
        }
    }
}

/// What kind of thing a row is about. `Cc` has no `ActiveBuff` behind it — it is a hold the CC
/// ledger owns, and it is the half that knows about break lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    /// A beneficial spell running on you or on somebody you buffed.
    Buff,
    /// A detrimental spell you put on something else.
    Debuff,
    Cc,
}

impl RowKind {
    /// The renderer's spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Buff => "buff",
            Self::Debuff => "debuff",
            Self::Cc => "cc",
        }
    }
}

/// Self rows render first, then one block per target. Presentation only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowGroup {
    /// On you.
    Zelf,
    /// On something else.
    Target,
}

impl RowGroup {
    /// The renderer's spelling. `self` is a Rust keyword, which is why the variant is not.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zelf => "self",
            Self::Target => "target",
        }
    }
}

/// One timer row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuffTimerRow {
    /// Stable across ticks so keys and selectors do not churn.
    pub id: String,
    pub kind: RowKind,
    /// The resolved spell name, or the candidate names joined when the landing sentence is shared.
    ///
    /// For a buff/debuff row this is the DB's own name; a CC hold's is the RANKED name off its cast
    /// line. The difference is deliberate — nothing downstream of a hold matches on the string, and
    /// the rank is wanted on exactly those rows.
    pub name: String,
    /// Display only: the ranked text the cast line spelled, when it differs from `name`.
    pub cast_name: Option<String>,
    /// Present only when the row is a FAMILY: every spell the line could be.
    pub candidates: Option<Vec<String>>,
    /// True when `name` is a family rather than a spell — drives the `~` chip.
    pub ambiguous: bool,
    pub group: RowGroup,
    /// Who it is on. Absent for a self row.
    pub target: Option<String>,
    pub target_key: Option<String>,
    /// True when `target` is the model's inference, never a name a sentence stated.
    pub inferred_target: bool,
    /// The event ts the instance landed. Not a wall clock: a BUFF's is shifted forward by an offline
    /// absence (EQ pauses buff timers while you are camped) and a DEBUFF's is not, so elapsed and
    /// remaining are the only honest readings and this must never be printed as a time of day.
    pub started_ts: i64,
    /// True when the spell CALMS its target — the one reason a `buff` row belongs to the debuffs
    /// window.
    pub calms_target: bool,
    pub mode: TimerMode,
    /// Only on `Countdown`, and only a number the shared estimator stated.
    pub duration_ms: Option<i64>,
    /// How many entities of this row's display name are holding it. `None` for the ordinary one;
    /// 2+ draws the count chip, and `started_ts` is then the OLDEST of them.
    pub count: Option<i64>,
    /// The allowlisted external who cast it; `None` for your own.
    pub caster: Option<String>,
}

/// What a row reads right now. `fraction` is 1 at the landing and 0 at or after the stated end.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimerReading {
    /// How long since the landing, never negative.
    pub elapsed_ms: i64,
    /// Present only for a countdown; clamped at 0 — a countdown never reads negative.
    pub remaining_ms: Option<i64>,
    /// Bar fill in [0,1]: remaining share for a countdown, 0 for elapsed/permanent (no bar).
    pub fraction: f64,
    /// True when a countdown has run past its stated end and the log has not yet cleared it.
    pub overdue: bool,
}

/// Read one row against an instant. The clock is always the caller's; nothing here reads one.
#[must_use]
pub fn timer_reading(row: &BuffTimerRow, now_ms: i64) -> TimerReading {
    let elapsed_ms = (now_ms - row.started_ts).max(0);
    let Some(duration) = row.duration_ms.filter(|d| *d > 0) else {
        return TimerReading {
            elapsed_ms,
            remaining_ms: None,
            fraction: 0.0,
            overdue: false,
        };
    };
    if row.mode != TimerMode::Countdown {
        return TimerReading {
            elapsed_ms,
            remaining_ms: None,
            fraction: 0.0,
            overdue: false,
        };
    }
    let left = duration - elapsed_ms;
    #[expect(
        clippy::cast_precision_loss,
        reason = "a bar fill: the ratio of two millisecond counts, drawn at pixel resolution"
    )]
    let fraction = (left as f64 / duration as f64).clamp(0.0, 1.0);
    TimerReading {
        elapsed_ms,
        remaining_ms: Some(left.max(0)),
        fraction,
        overdue: left <= 0,
    }
}

/// When a running countdown ends, on the log's own clock — or `None` for a row stating no duration.
///
/// The early-warning fire instant is this minus the user's offset. It is spelled here rather than in
/// the alerts evaluator so the instant a row ends has one definition on this side of the boundary.
#[must_use]
pub fn timer_ends_at(row: &BuffTimerRow) -> Option<i64> {
    if row.mode != TimerMode::Countdown {
        return None;
    }
    row.duration_ms.map(|d| row.started_ts + d)
}

/// The rank tail a spell name may carry.
fn rank_tail() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i) (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$").unwrap())
}

/// A row's spell name folded to its FAMILY, case kept.
///
/// This is the spelling a wear-off line prints: a row's name comes from the ranked cast line, and
/// `Your <X> spell has worn off of <mob>.` is rank-less (measured: 3,382 of 3,383 over the owner's
/// whole log). Casing is kept because a firing alert speaks the name.
#[must_use]
pub fn timer_name_base(name: &str) -> String {
    js_trim(&rank_tail().replace(js_trim(name), "")).to_owned()
}

/// The same fold, case-folded. What row ids are built from.
#[must_use]
pub fn timer_name_key(name: &str) -> String {
    timer_name_base(name).to_lowercase()
}

/// The rank a row may print — the numeral off the cast line, or nothing.
///
/// Two refusals. The two strings must fold to the SAME line, or the chip would be a rank belonging
/// to another spell; and a `cast_name` with no rank tail yields nothing, because "the cast line
/// spelled it differently" is not by itself a rank.
#[must_use]
pub fn row_rank_label(name: &str, cast_name: Option<&str>) -> Option<String> {
    let cast = cast_name?;
    if timer_name_key(cast) != timer_name_key(name) {
        return None;
    }
    let trimmed = js_trim(cast);
    rank_tail()
        .find(trimmed)
        .map(|m| js_trim(m.as_str()).to_uppercase())
}

/// Canonical entity key.
fn entity_key_of(name: &str) -> String {
    js_trim(name).to_lowercase()
}

/// Which window a row belongs to — the whole split, as one function.
///
/// `buff` goes to the buffs window and `debuff`/`cc` to the debuffs window. `group` is NOT the
/// discriminator: a Symbol on your pet and a Valor on the cleric you buffed are `group: target` and
/// are still buffs. The one exception is a spell that CALMS its target — a Pacify is beneficial in
/// the committed catalog, so its class is `buff`, but the aggro clock belongs beside the other
/// mob-state timers. Nothing here may read `group`, `target` or `disposition`: an ally is a named
/// target and so is a mob, and a friendly buff on somebody the model lost track of is not a debuff.
#[must_use]
pub fn timer_row_surface(row: &BuffTimerRow) -> TimerSurface {
    if row.kind == RowKind::Buff && !row.calms_target {
        TimerSurface::Buffs
    } else {
        TimerSurface::Debuffs
    }
}

/// The row a CC hold projects to.
fn cc_row(h: &CcHold) -> BuffTimerRow {
    let family = if h.candidates.is_empty() {
        "Crowd control".to_owned()
    } else {
        h.candidates.join(" / ")
    };
    let id_tail = match &h.spell {
        Some(spell) => timer_name_key(spell),
        None => h
            .candidates
            .iter()
            .map(|c| timer_name_key(c))
            .collect::<Vec<_>>()
            .join("+"),
    };
    BuffTimerRow {
        id: format!("cc|{}|{id_tail}", h.key),
        kind: RowKind::Cc,
        name: h.spell.clone().unwrap_or(family),
        cast_name: None,
        candidates: h.spell.is_none().then(|| h.candidates.clone()),
        ambiguous: h.spell.is_none(),
        group: RowGroup::Target,
        target: Some(h.target.clone()),
        target_key: Some(h.key.clone()),
        inferred_target: false,
        started_ts: h.started_ts,
        calms_target: false,
        mode: if h.duration_ms.is_some() {
            TimerMode::Countdown
        } else {
            TimerMode::Elapsed
        },
        duration_ms: h.duration_ms,
        count: h.count.filter(|c| *c > 1),
        caster: h.caster.clone(),
    }
}

/// Only the estimator's duration — max(DB floor, recent observed max) — earns a receding countdown.
/// A permanent buff never counts down, and a buff the model can put no honest number on counts UP
/// carrying no duration at all, so nothing downstream can draw a bar from it.
fn timer_mode_of(b: &ActiveBuff) -> (TimerMode, Option<i64>) {
    if b.permanent == Some(true) {
        return (TimerMode::Permanent, None);
    }
    match b.overlay_duration_ms.filter(|d| *d > 0) {
        Some(d) => (TimerMode::Countdown, Some(d)),
        None => (TimerMode::Elapsed, None),
    }
}

/// The row an `ActiveBuff` projects to.
fn buff_row(b: &ActiveBuff) -> BuffTimerRow {
    let target_key = if b.is_self {
        None
    } else {
        Some(
            b.target
                .as_deref()
                .map_or_else(|| "unknown".to_owned(), entity_key_of),
        )
    };
    let (mode, duration_ms) = timer_mode_of(b);
    BuffTimerRow {
        id: format!(
            "{}|{}|{}",
            if b.is_self { "self" } else { "target" },
            target_key.as_deref().unwrap_or("self"),
            timer_name_key(&b.spell)
        ),
        kind: match b.cls {
            BuffClass::Buff => RowKind::Buff,
            BuffClass::Debuff => RowKind::Debuff,
        },
        name: b.spell.clone(),
        // A raw string comparison rather than a folded one: the chip exists to show a DIFFERENCE.
        cast_name: b.cast_name.clone().filter(|c| *c != b.spell),
        candidates: b.candidates.clone(),
        ambiguous: b.candidates.is_some(),
        group: if b.is_self {
            RowGroup::Zelf
        } else {
            RowGroup::Target
        },
        target: (!b.is_self).then(|| {
            b.target
                .clone()
                .unwrap_or_else(|| "unknown target".to_owned())
        }),
        target_key,
        inferred_target: b.inferred_target == Some(true),
        started_ts: b.started_ts,
        calms_target: b.calms_target == Some(true),
        mode,
        duration_ms,
        count: b.count.filter(|c| *c > 1),
        caster: b.caster.clone(),
    }
}

/// True when the CC ledger has recorded an END for this active instance at or after it landed.
///
/// `Your <mez> spell has worn off of <mob>.` routes to the CC half rather than to `buffFade`, so the
/// buffs model never clears the instance and it would linger to the 90-minute hygiene cap.
/// Correcting it in the instance store would also mint a land→fade duration sample, so the
/// correction lives in the projection and is exactly one rule wide.
fn ended_by_cc(b: &ActiveBuff, ends: &[CcEnd]) -> bool {
    if b.is_self {
        return false;
    }
    let Some(target) = b.target.as_deref() else {
        return false;
    };
    let key = entity_key_of(target);
    let spell = timer_name_key(&b.spell);
    ends.iter().any(|e| {
        e.key == key
            && e.ts >= b.started_ts
            && e.spell
                .as_deref()
                .is_none_or(|s| timer_name_key(s) == spell)
    })
}

/// Soonest-to-expire first; countdowns ahead of count-ups; then oldest first, then by name.
///
/// Rows with no number go AFTER the timed ones: a row counting up cannot be placed on a
/// soonest-to-expire axis at all, so putting it above a bar about to break would be sorting by a
/// number it does not have. Permanent rows come last, one step further. The final term is a code
/// point comparison — see the module header for the divergence.
#[must_use]
pub fn compare_rows(a: &BuffTimerRow, b: &BuffTimerRow) -> std::cmp::Ordering {
    let rank = |r: &BuffTimerRow| match r.mode {
        TimerMode::Countdown => 0,
        TimerMode::Elapsed => 1,
        TimerMode::Permanent => 2,
    };
    let by_rank = rank(a).cmp(&rank(b));
    if by_rank != std::cmp::Ordering::Equal {
        return by_rank;
    }
    if a.mode == TimerMode::Countdown && b.mode == TimerMode::Countdown {
        let ea = a.started_ts + a.duration_ms.unwrap_or(0);
        let eb = b.started_ts + b.duration_ms.unwrap_or(0);
        if ea != eb {
            return ea.cmp(&eb);
        }
    } else if a.started_ts != b.started_ts {
        return a.started_ts.cmp(&b.started_ts);
    }
    a.name.cmp(&b.name)
}

/// The projection: self rows first, then one block per target with that target's rows together,
/// targets ordered by their soonest row.
///
/// A CC hold and an `ActiveBuff` can describe the same mez — a landing sentence the catalog matcher
/// saw becomes an `ActiveBuff` while its `<mob> has been …` siblings become holds. Where both exist
/// for one (mob, spell) the HOLD WINS: it is the half that knows about break lines.
#[must_use]
pub fn build_timer_rows(
    active: &[ActiveBuff],
    holds: &[CcHold],
    ends: &[CcEnd],
) -> Vec<BuffTimerRow> {
    let held_by_spell: std::collections::HashSet<String> = holds
        .iter()
        .filter_map(|h| {
            h.spell
                .as_deref()
                .map(|s| format!("{}|{}", h.key, timer_name_key(s)))
        })
        .collect();

    let mut rows: Vec<BuffTimerRow> = Vec::new();
    for b in active {
        if ended_by_cc(b, ends) {
            continue;
        }
        let row = buff_row(b);
        if row.group == RowGroup::Target
            && held_by_spell.contains(&format!(
                "{}|{}",
                row.target_key.as_deref().unwrap_or(""),
                timer_name_key(&row.name)
            ))
        {
            continue;
        }
        rows.push(row);
    }
    for h in holds {
        rows.push(cc_row(h));
    }

    let mut self_rows: Vec<BuffTimerRow> = Vec::new();
    // Insertion-ordered groups. The group order is re-sorted below, but two groups whose first rows
    // compare equal keep the order they were first seen in — which a map keyed by target would
    // silently change to alphabetical.
    let mut order: Vec<String> = Vec::new();
    let mut by_target: std::collections::HashMap<String, Vec<BuffTimerRow>> =
        std::collections::HashMap::new();
    for row in rows {
        if row.group == RowGroup::Zelf {
            self_rows.push(row);
            continue;
        }
        let key = row
            .target_key
            .clone()
            .unwrap_or_else(|| "unknown".to_owned());
        if !by_target.contains_key(&key) {
            order.push(key.clone());
        }
        by_target.entry(key).or_default().push(row);
    }
    self_rows.sort_by(compare_rows);

    let mut groups: Vec<Vec<BuffTimerRow>> = order
        .into_iter()
        .filter_map(|k| by_target.remove(&k))
        .map(|mut g| {
            g.sort_by(compare_rows);
            g
        })
        .collect();
    // A STABLE sort over the groups, which is what makes the insertion order above load-bearing.
    groups.sort_by(|a, b| compare_rows(&a[0], &b[0]));

    let mut out = self_rows;
    for g in groups {
        out.extend(g);
    }
    out
}

/// The row order one window draws — the presentation choice on top of [`build_timer_rows`], which
/// stays the model's order because both windows are folded from it. Grouping by target hands the
/// projection back untouched; otherwise the same rows are re-sorted into one flat soonest-first
/// list, which is what the debuffs window opens on.
#[must_use]
pub fn order_timer_rows(rows: &[BuffTimerRow], group_by_target: bool) -> Vec<BuffTimerRow> {
    let mut out = rows.to_vec();
    if !group_by_target {
        out.sort_by(compare_rows);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        build_timer_rows, order_timer_rows, row_rank_label, timer_ends_at, timer_name_base,
        timer_name_key, timer_reading, timer_row_surface, RowGroup, RowKind, TimerMode,
        TimerSurface,
    };
    use crate::modules::buff_timers::{CcEnd, CcHold};
    use crate::modules::buffs_shapes::BuffClass;
    use crate::modules::buffs_view::ActiveBuff;

    fn buff(spell: &str, started: i64, duration: Option<i64>) -> ActiveBuff {
        ActiveBuff {
            spell: spell.to_owned(),
            cast_name: None,
            cls: BuffClass::Buff,
            calms_target: None,
            is_self: true,
            disposition: None,
            started_ts: started,
            estimated_ms: duration,
            p25: None,
            p75: None,
            n: 0,
            target: None,
            inferred_target: None,
            duration_source: None,
            overlay_duration_ms: duration,
            overlay_source: None,
            permanent: None,
            permanent_source: None,
            message_driven: None,
            count: None,
            caster: None,
            candidates: None,
        }
    }

    fn hold(key: &str, target: &str, spell: Option<&str>, started: i64) -> CcHold {
        CcHold {
            key: key.to_owned(),
            target: target.to_owned(),
            started_ts: started,
            spell: spell.map(str::to_owned),
            candidates: Vec::new(),
            duration_ms: Some(48_000),
            source: None,
            count: None,
            caster: None,
        }
    }

    #[test]
    fn a_name_folds_to_its_family_and_the_rank_chip_is_the_difference() {
        assert_eq!(timer_name_base("Mesmerization VII"), "Mesmerization");
        assert_eq!(timer_name_key("Mesmerization VII"), "mesmerization");
        // The rank chip is only the DIFFERENCE between two spellings of one spell.
        assert_eq!(
            row_rank_label("Mesmerization", Some("Mesmerization vii")).as_deref(),
            Some("VII")
        );
        // A cast name folding to a different spell yields nothing.
        assert_eq!(row_rank_label("Mesmerization", Some("Enthrall II")), None);
        // A cast name with no rank tail is not a rank.
        assert_eq!(row_rank_label("Clarity", Some("clarity")), None);
        // A name that IS a numeral keeps it: the pattern needs a space before the tail.
        assert_eq!(timer_name_base("V"), "V");
    }

    #[test]
    fn a_stated_duration_counts_down_and_everything_else_counts_up() {
        let rows = build_timer_rows(
            &[
                buff("Clarity", 1_000, Some(60_000)),
                buff("Levitate", 2_000, None),
            ],
            &[],
            &[],
        );
        assert_eq!(rows.len(), 2);
        // The countdown ranks ahead of the count-up whatever their landings said.
        assert_eq!(rows[0].name, "Clarity");
        assert_eq!(rows[0].mode, TimerMode::Countdown);
        assert_eq!(rows[0].duration_ms, Some(60_000));
        assert_eq!(rows[1].mode, TimerMode::Elapsed);
        assert_eq!(rows[1].duration_ms, None, "a count-up carries no number");

        // The end instant is the half early warning needs.
        assert_eq!(timer_ends_at(&rows[0]), Some(61_000));
        assert_eq!(timer_ends_at(&rows[1]), None);
    }

    #[test]
    fn a_permanent_row_has_no_clock_and_sorts_last() {
        let mut perm = buff("Illusion: Wood Elf", 500, None);
        perm.permanent = Some(true);
        let rows = build_timer_rows(&[perm, buff("Levitate", 9_000, None)], &[], &[]);
        assert_eq!(rows[0].name, "Levitate");
        assert_eq!(rows[1].mode, TimerMode::Permanent);
        assert_eq!(timer_ends_at(&rows[1]), None);
    }

    #[test]
    fn a_reading_is_the_rows_own_numbers_against_a_clock_the_caller_brought() {
        let rows = build_timer_rows(&[buff("Clarity", 1_000, Some(60_000))], &[], &[]);
        let half = timer_reading(&rows[0], 31_000);
        assert_eq!(half.elapsed_ms, 30_000);
        assert_eq!(half.remaining_ms, Some(30_000));
        assert!((half.fraction - 0.5).abs() < 1e-9);
        assert!(!half.overdue);
        // A countdown never reads negative; it reads overdue.
        let past = timer_reading(&rows[0], 200_000);
        assert_eq!(past.remaining_ms, Some(0));
        assert!(past.overdue);
        // A clock behind the landing is clamped rather than negative.
        assert_eq!(timer_reading(&rows[0], 0).elapsed_ms, 0);
    }

    #[test]
    fn a_hold_wins_over_the_active_instance_describing_the_same_mez() {
        // One mez seen twice: the catalog matcher made an ActiveBuff of the landing sentence and
        // the CC ledger made a hold of its sibling.
        let mut mez = buff("Mesmerization", 1_000, Some(96_000));
        mez.is_self = false;
        mez.cls = BuffClass::Debuff;
        mez.target = Some("a sand giant".to_owned());
        let rows = build_timer_rows(
            &[mez],
            &[hold(
                "a sand giant",
                "a sand giant",
                Some("Mesmerization"),
                1_000,
            )],
            &[],
        );
        assert_eq!(rows.len(), 1, "one row, not two");
        assert_eq!(rows[0].kind, RowKind::Cc);
        assert_eq!(rows[0].target_key.as_deref(), Some("a sand giant"));
    }

    #[test]
    fn a_cc_end_clears_an_instance_the_buffs_model_never_heard_about() {
        let mut mez = buff("Mesmerization", 1_000, Some(96_000));
        mez.is_self = false;
        mez.cls = BuffClass::Debuff;
        mez.target = Some("A Sand Giant".to_owned());
        let ends = [CcEnd {
            key: "a sand giant".to_owned(),
            ts: 5_000,
            spell: Some("Mesmerization VII".to_owned()),
        }];
        assert!(build_timer_rows(&[mez.clone()], &[], &ends).is_empty());
        // An end BEFORE the landing is a different hold and clears nothing.
        let earlier = [CcEnd {
            key: "a sand giant".to_owned(),
            ts: 500,
            spell: None,
        }];
        assert_eq!(build_timer_rows(&[mez], &[], &earlier).len(), 1);
    }

    #[test]
    fn self_rows_come_first_and_targets_arrive_in_blocks() {
        let mut on_pet = buff("Symbol of Ryltan", 1_000, Some(30_000));
        on_pet.is_self = false;
        on_pet.target = Some("Gybartik".to_owned());
        let mut on_ally = buff("Valor", 1_000, Some(10_000));
        on_ally.is_self = false;
        on_ally.target = Some("Rowel".to_owned());
        let rows = build_timer_rows(
            &[on_pet, on_ally, buff("Clarity", 4_000, Some(90_000))],
            &[],
            &[],
        );
        assert_eq!(rows[0].group, RowGroup::Zelf);
        assert_eq!(rows[0].name, "Clarity");
        // Groups are ordered by their SOONEST row, so Rowel's 10 s Valor pulls that block first.
        assert_eq!(rows[1].target_key.as_deref(), Some("rowel"));
        assert_eq!(rows[2].target_key.as_deref(), Some("gybartik"));

        // The flat order is the same rows sorted soonest-first, blocks ignored.
        let flat = order_timer_rows(&rows, false);
        assert_eq!(
            flat.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["Valor", "Symbol of Ryltan", "Clarity"]
        );
        // Grouping by target hands the projection back untouched.
        assert_eq!(order_timer_rows(&rows, true), rows);
    }

    #[test]
    fn a_calm_line_is_the_one_buff_that_belongs_to_the_debuffs_window() {
        let mut pacify = buff("Pacify", 1_000, Some(60_000));
        pacify.is_self = false;
        pacify.target = Some("an icy terror".to_owned());
        pacify.calms_target = Some(true);
        let rows = build_timer_rows(&[pacify], &[], &[]);
        assert_eq!(rows[0].kind, RowKind::Buff);
        assert_eq!(timer_row_surface(&rows[0]), TimerSurface::Debuffs);
        // An ordinary buff on the very same kind of target is still a BUFF row: nothing here reads
        // `group`, `target` or `disposition`.
        let mut valor = buff("Valor", 1_000, Some(60_000));
        valor.is_self = false;
        valor.target = Some("an icy terror".to_owned());
        let rows = build_timer_rows(&[valor], &[], &[]);
        assert_eq!(timer_row_surface(&rows[0]), TimerSurface::Buffs);
    }

    #[test]
    fn an_unresolved_hold_is_a_family_and_says_so() {
        let mut h = hold("a sand giant", "a sand giant", None, 1_000);
        h.candidates = vec!["Mesmerize".to_owned(), "Mesmerization".to_owned()];
        h.duration_ms = None;
        let rows = build_timer_rows(&[], &[h], &[]);
        assert_eq!(rows[0].name, "Mesmerize / Mesmerization");
        assert!(rows[0].ambiguous);
        assert_eq!(rows[0].mode, TimerMode::Elapsed);
        assert_eq!(rows[0].id, "cc|a sand giant|mesmerize+mesmerization");

        // A hold with no candidates at all still draws something readable.
        let mut bare = hold("a sand giant", "a sand giant", None, 1_000);
        bare.candidates = Vec::new();
        let rows = build_timer_rows(&[], &[bare], &[]);
        assert_eq!(rows[0].name, "Crowd control");
    }
}
