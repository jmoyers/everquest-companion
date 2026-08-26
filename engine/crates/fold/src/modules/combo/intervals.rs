//! `src/main/modules/comboIntervals.ts` — INTERVAL CONSTRUCTION. Observations + `/who` rows +
//! level dings + user corrections in, `ComboInterval[]` out. Pure.
//!
//! A LOADOUT SWAP PRINTS NOTHING. `grep -ci loadout` over 1.1M lines returns 37 hits and every one
//! is another player's chat. So every boundary here is INFERENCE, it is always a RANGE
//! `[startLo, startHi]` rather than an instant, and the detectors are ranked by how much the log
//! actually said:
//!
//!   who            two consecutive `/who` rows disagree. The game NAMED both loadouts; the swap is
//!                  somewhere between the rows. Hard, and nothing overrides it.
//!   levelDrop      a `Welcome to level N!` with N <= the previous ding. Displayed level is the
//!                  MINIMUM of the loadout's class levels, so a non-increasing ding is a swap —
//!                  note `<=`, not `<`: the real log has a genuine 11 → 11 REPEAT 0.9 h apart that
//!                  a strict-descent predicate misses. (`levelSeries.ts` keeps `<` on purpose and
//!                  is pinned by its own golden window — do not "fix" it.)
//!   evidenceShift  a class with sustained exclusive evidence goes silent and a different one
//!                  starts. This is what NARROWS a boundary: the Aug 2 swap is bracketed 33.9 h
//!                  apart by level dings and to ~60 min (last MNK Feign Death 00:57:55 → first ROG
//!                  Backstab 01:57:42) by the shift. Both fire for the same swap; the narrower
//!                  window wins and the other is recorded in `startAlso`.
//!
//! The one thing a `/who` row NEVER loses to is a narrower inferred window — hence the explicit
//! precedence in `resolve_group`.
//!
//! TWO PLACES HERE COMPARE BY IDENTITY over there (`b !== best` in `pick_boundary`, and
//! `host.also = …` mutating an element of an array a `filter` is holding references into). Both are
//! ported as INDEX arithmetic, because Rust will not hand out a reference into a vector and a
//! mutable borrow of it at once — same elements, same answer, no aliasing.

use super::evidence::ClassObservation;
use super::levels::{level_range, level_regressed_inside, LevelPoint, LevelStatements, WhoRow};
use super::score::{score_slots, stated_slots, ComboSlot};
use super::ClassAbbr;
use crate::jsmap::JsMap;
use serde::Serialize;

/// The tertiary slot unlocks at level 10 — a PRIOR, overridden by a `/who` row's own arity.
const TERTIARY_UNLOCK_LEVEL: i64 = 10;
/// § 4.5 R8: never bisect below this, or an ambiguous span thrashes into confetti.
const WINDOW_FLOOR_MS: i64 = 15 * 60_000;
/// Bound on shift bisection. The real log needs ONE cut; this is the runaway guard.
const MAX_SHIFT_CUTS: usize = 16;
const HOUR_MS: i64 = 3_600_000;

/// A user correction — the ONLY durable combo state (§ 7). Keyed by TIME, never by interval id: a
/// correction recomputes every interval and ids are recompute-unstable by design.
///
/// ABSENT IN THE BENCH WORLD. `foldArm.mts` installs no corrections provider and never calls
/// `setCorrections`, so every slice's list is empty and rules 2/`userLocked`/`userOverruled` are
/// unexercised by the corpus. Ported anyway because they are STRUCTURE rather than a guess: leaving
/// them out would make the first world that carries a correction diverge silently.
#[derive(Debug, Clone)]
pub struct ComboCorrection {
    pub start_ts: i64,
    /// `None` = "from `start_ts` onward", i.e. it applies to the open interval too.
    pub end_ts: Option<i64>,
    pub classes: Vec<ClassAbbr>,
    /// When the user set it — later corrections win over earlier overlapping ones.
    pub set_at: i64,
}

/// A contiguous span during which we believe the loadout did not change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboInterval {
    /// `ci<n>` in time order. NOT stable across a recompute.
    pub id: String,
    /// Best estimate of the start; always inside `[startLo, startHi]`.
    pub start_ts: i64,
    /// `null` = the open / current interval.
    pub end_ts: Option<i64>,
    pub start_lo: i64,
    pub start_hi: i64,
    pub end_lo: Option<i64>,
    pub end_hi: Option<i64>,
    /// The detector that produced the NARROWEST window for this boundary.
    pub start_reason: &'static str,
    /// Other detectors that fired for the SAME swap. Absent unless there were any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_also: Option<Vec<&'static str>>,
    /// 2 before the tertiary unlock, 3 after — a PRIOR, overridden by a `/who` row's own arity.
    pub expected_slots: usize,
    /// `len() == expected_slots`; unfilled positions are explicit UNKNOWN slots, never dropped.
    pub slots: Vec<ComboSlot>,
    /// Level range observed inside the interval (min-of-loadout semantics). `null`, not absent.
    pub level_lo: Option<i64>,
    pub level_hi: Option<i64>,
    /// How much evidence stands behind this interval, for the UI's "do we actually know" cue.
    pub evidence_count: usize,
    /// Set ONLY by a user correction; suppresses re-inference of these slots.
    pub user_locked: bool,
    /// A manual override applies here and the GAME contradicted it. Absent unless it happened —
    /// JOS-87's acceptance criterion is that autodetection never SILENTLY overwrites an override,
    /// and `/who` is the one path by which an override can still lose, so the loss is carried in
    /// the model rather than swallowed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_overruled: Option<bool>,
    /// Same serialization rule for the same reason (JOS-239): absent unless the span really did see
    /// the level go backwards, so no interval's JSON moves for a flag that does not apply to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level_regressed: Option<bool>,
}

/// One detected swap: it happened somewhere in `[lo, hi]`; `at` is where we cut.
#[derive(Debug, Clone)]
pub struct Boundary {
    pub lo: i64,
    pub hi: i64,
    /// Best estimate — always `hi` from a detector: the new loadout is only PROVEN at the arriving
    /// evidence.
    pub at: i64,
    pub reason: &'static str,
    /// Other detectors that fired for the same swap.
    pub also: Option<Vec<&'static str>>,
}

pub struct IntervalInput<'a> {
    pub observations: &'a [ClassObservation],
    pub who_rows: &'a [WhoRow],
    pub levels: &'a [LevelPoint],
    pub corrections: &'a [ComboCorrection],
}

// ─────────────────────────────────────────────────────────────────── detectors

/// Consecutive `/who` rows that disagree, MINUS the swaps something sharper already dated.
///
/// A `/who` pair only bounds the swap by "somewhere between these two rows", which in this log runs
/// to three hours and to 33 hours elsewhere. So: the disagreement is PROOF that a swap happened,
/// but if any already-detected boundary falls inside `(prev, row]` then that boundary IS this swap,
/// dated better, and adding a second one here would split the same event twice.
///
/// The FIRST row never opens one: with no earlier statement there is nothing to disagree with, and
/// splitting there would manufacture an empty interval in front of every anchored span.
pub fn who_boundaries(rows: &[WhoRow], dated: &[Boundary]) -> Vec<Boundary> {
    let mut out = Vec::new();
    for i in 1..rows.len() {
        let prev = &rows[i - 1];
        let row = &rows[i];
        if prev.classes == row.classes {
            continue;
        }
        if dated.iter().any(|b| b.at > prev.ts && b.at <= row.ts) {
            continue;
        }
        out.push(Boundary {
            lo: prev.ts,
            hi: row.ts,
            at: row.ts,
            reason: "who",
            also: None,
        });
    }
    out
}

/// A `/who` ROW THAT CONTRADICTS THE EVIDENCE BEHIND IT — the swap cut nothing else can see
/// (JOS-192).
///
/// THE DEFECT THIS EXISTS FOR. `who_boundaries` needs TWO rows to disagree, and the log has eleven
/// rows in 1.1M lines. Inside a slice nothing else cut, `slots_for` rule 1 takes the LAST `/who`
/// row and states the WHOLE slice with it — so a player who swaps, sees the app naming the trio
/// they left, and types `/who` to correct it has their correction applied BACKWARDS over every hour
/// the slice already covered.
///
/// THE RULE. A `/who` row states the loadout AT ITS OWN TIMESTAMP and nowhere else. When the
/// evidence in front of it inside its own segment SUSTAINS a class the row does not name, the game
/// and the log disagree about the same span, which can only mean a swap happened between them.
///
/// WHY DEPARTURE ALONE, when `reinstated_drops` demands departure AND arrival: that rule compares
/// evidence to evidence across a ding, where "everything looks departed" right after the cut simply
/// because no time has passed. This one compares evidence to a STATEMENT.
pub fn who_shift_boundaries(
    observations: &[ClassObservation],
    rows: &[WhoRow],
    dated: &[Boundary],
    first_ts: i64,
) -> Vec<Boundary> {
    let mut out: Vec<Boundary> = Vec::new();
    // A row is a statement, never a score (§ 4.4) — a single-class row would otherwise draw an
    // exclusive span for itself.
    let evidence: Vec<&ClassObservation> =
        observations.iter().filter(|o| o.source != "who").collect();
    for row in rows {
        let placed_ats: Vec<i64> = dated.iter().chain(out.iter()).map(|b| b.at).collect();
        if placed_ats.contains(&row.ts) {
            continue;
        }
        let before: Vec<i64> = placed_ats
            .iter()
            .copied()
            .filter(|&at| at <= row.ts)
            .collect();
        let from = before.iter().copied().max().unwrap_or(first_ts);
        if row.ts <= from {
            continue;
        }
        let window: Vec<ClassObservation> = evidence
            .iter()
            .filter(|o| o.ts >= from && o.ts < row.ts)
            .map(|o| (*o).clone())
            .collect();
        let departed: Vec<Span> = exclusive_spans(&window)
            .into_iter()
            .filter(|s| !row.classes.contains(&s.cls))
            .collect();
        if departed.is_empty() {
            continue;
        }
        // The window opens no earlier than the last word of a class that is gone — the same honest
        // left edge `reinstated_drops` uses — and closes at the row, which is where the game spoke.
        let lo = departed.iter().map(|s| s.last).fold(from, i64::max);
        out.push(Boundary {
            lo,
            hi: row.ts,
            at: row.ts,
            reason: "who",
            also: None,
        });
    }
    out
}

/// A non-increasing level ding. The window is honestly WIDE — the Aug 2 swap's is 33.9 h — and the
/// UI is expected to draw it as a range.
pub fn level_drop_boundaries(levels: &[LevelPoint]) -> Vec<Boundary> {
    let mut out = Vec::new();
    for i in 1..levels.len() {
        let prev = levels[i - 1];
        let ding = levels[i];
        if ding.level > prev.level {
            continue;
        }
        out.push(Boundary {
            lo: prev.ts,
            hi: ding.ts,
            at: ding.ts,
            reason: "levelDrop",
            also: None,
        });
    }
    out
}

/// A class's exclusive-evidence span, for classes the window actually stands behind.
#[derive(Debug, Clone)]
struct Span {
    cls: ClassAbbr,
    first: i64,
    last: i64,
}

/// Classes carrying SUSTAINED EXCLUSIVE evidence — ≥2 distinct hourly buckets of observations that
/// name that class and nothing else.
///
/// A STRICTER bar than admission on purpose. Admission's `sustain` counts every bucket holding ANY
/// evidence for the class, twelve-class invocations included; that is the right question for "is
/// this class in the loadout" and the WRONG one for "when was this class present", where a shared
/// invocation would smear a class across the whole log and MANUFACTURE boundaries.
///
/// Insertion-ordered, because `cut_once`'s two reductions keep the FIRST element on a tie.
fn exclusive_spans(observations: &[ClassObservation]) -> Vec<Span> {
    struct Acc {
        span: Span,
        buckets: std::collections::HashSet<i64>,
    }
    let mut spans: JsMap<Acc> = JsMap::new();
    for o in observations {
        if o.candidates.len() != 1 {
            continue;
        }
        let cls = o.candidates[0];
        let bucket = o.ts.div_euclid(HOUR_MS);
        if let Some(acc) = spans.get_mut(cls) {
            acc.span.first = acc.span.first.min(o.ts);
            acc.span.last = acc.span.last.max(o.ts);
            acc.buckets.insert(bucket);
            continue;
        }
        spans.insert(
            cls.to_string(),
            Acc {
                span: Span {
                    cls,
                    first: o.ts,
                    last: o.ts,
                },
                buckets: std::collections::HashSet::from([bucket]),
            },
        );
    }
    spans
        .into_values()
        .into_iter()
        .filter(|a| a.buckets.len() >= 2)
        .map(|a| a.span)
        .collect()
}

/// ONE cut inside a window, or `None`.
///
/// The window is OVER-DETERMINED when more classes carry sustained exclusive evidence than a
/// loadout can hold. The swap is then bounded below by the EARLIEST departure (the first class to
/// fall silent) and above by the EARLIEST arrival after it. Earliest on both ends is what makes the
/// window narrow AND honest: anything before the departure is still the old loadout, anything from
/// the first arrival on is provably the new one.
fn cut_once(observations: &[ClassObservation], expected_slots: usize) -> Option<Boundary> {
    let spans = exclusive_spans(observations);
    if spans.len() <= expected_slots {
        return None;
    }
    // `reduce((a, b) => b.last < a.last ? b : a)` — a STRICT `<`, so the first minimum wins.
    let departing = spans
        .iter()
        .reduce(|a, b| if b.last < a.last { b } else { a })?
        .clone();
    let arrivals: Vec<&Span> = spans.iter().filter(|s| s.first > departing.last).collect();
    let arriving = arrivals
        .into_iter()
        .reduce(|a, b| if b.first < a.first { b } else { a })?;
    if arriving.first - departing.last < 0 {
        return None;
    }
    Some(Boundary {
        lo: departing.last,
        hi: arriving.first,
        at: arriving.first,
        reason: "evidenceShift",
        also: None,
    })
}

/// Evidence-shift boundaries inside one hard segment, found by BISECTING until every sub-window
/// holds at most `expected_slots` sustained classes. On hitting the 15-minute floor while still
/// over-determined we DO NOT split — an honest "we can't tell" beats a fabricated boundary; the
/// interval keeps its candidates wide and `startAlso` records `overDetermined`.
pub fn evidence_shift_boundaries(
    observations: &[ClassObservation],
    expected_slots: usize,
) -> Vec<Boundary> {
    let mut out: Vec<Boundary> = Vec::new();
    let mut queue: std::collections::VecDeque<Vec<ClassObservation>> =
        std::collections::VecDeque::new();
    queue.push_back(observations.to_vec());
    while !queue.is_empty() && out.len() < MAX_SHIFT_CUTS {
        let Some(window) = queue.pop_front() else {
            continue;
        };
        if window.is_empty() {
            continue;
        }
        let span = window[window.len() - 1].ts - window[0].ts;
        if span < WINDOW_FLOOR_MS {
            continue;
        }
        let Some(cut) = cut_once(&window, expected_slots) else {
            continue;
        };
        let (lo, hi) = (cut.lo, cut.hi);
        out.push(cut);
        queue.push_back(window.iter().filter(|o| o.ts <= lo).cloned().collect());
        queue.push_back(window.iter().filter(|o| o.ts >= hi).cloned().collect());
    }
    out.sort_by_key(|b| b.at);
    out
}

// ─────────────────────────────────────────────────────────────────── assembly

/// Windows that OVERLAP describe the same swap, and the NARROWEST of them is the answer. The Aug 2
/// level ding says "somewhere in these 33.9 hours" and the evidence shift says "somewhere in these
/// 60 minutes", about the same event — so the shift wins the window and the ding is recorded in
/// `also` rather than thrown away.
///
/// The CUT itself is the EARLIEST `at` any detector in the group offers (clamped into the winning
/// window). `at` is where the new interval OPENS, so taking the earliest keeps a `/who` row on the
/// far side of a narrower inferred boundary inside the interval it describes.
fn pick_boundary(group: &[Boundary]) -> Boundary {
    // `reduce((a, b) => b.hi - b.lo < a.hi - a.lo ? b : a)` — first narrowest wins.
    let mut best = 0usize;
    for i in 1..group.len() {
        if group[i].hi - group[i].lo < group[best].hi - group[best].lo {
            best = i;
        }
    }
    let earliest = group.iter().map(|b| b.at).min().unwrap_or(group[best].at);
    let at = earliest.max(group[best].lo).min(group[best].hi);
    // `{...best, at}` carries `best.also` through; the overwrite below only happens when this
    // group had something else in it.
    let mut merged = group[best].clone();
    merged.at = at;
    let mut also: Vec<&'static str> = Vec::new();
    for (i, b) in group.iter().enumerate() {
        if i != best && !also.contains(&b.reason) {
            also.push(b.reason);
        }
    }
    if !also.is_empty() {
        merged.also = Some(also);
    }
    merged
}

/// The window an absorbed drop is judged against: from the boundary that swallowed it to the next
/// cut after it (or the end of the evidence).
fn absorbed_window(drop: &Boundary, dated: &[Boundary], end: i64) -> Option<(i64, i64)> {
    let from = dated
        .iter()
        .filter(|b| b.at <= drop.at)
        .map(|b| b.at)
        .max()?;
    let to = dated
        .iter()
        .filter(|b| b.at > drop.at)
        .map(|b| b.at)
        .min()
        .unwrap_or(end);
    Some((from, to))
}

/// LEVEL DINGS THE MERGE SWALLOWED, PUT BACK WHEN THE EVIDENCE SAYS THEY WERE A SECOND SWAP.
///
/// `level_drop_boundaries` dates a ding's swap as "somewhere between the previous ding and this
/// one" — and after a swap that previous ding is by construction in the PREVIOUS era, so the window
/// routinely reaches back across an earlier swap. `merge_boundaries` then reads that overlap as
/// "these two detectors describe the same event", keeps the narrower one, and the ding's CUT is
/// gone. MEASURED on the live log: the swap into a wizard loadout dinged at Aug 06 19:31:23 and its
/// window opened at the previous ding on Aug 04 20:57:35 — 46.6 h earlier, swallowing the Aug 04
/// 23:38:01 evidence shift that was itself a real swap.
///
/// THE DISCRIMINATOR IS THE EVIDENCE, NEVER THE CLOCK, and it is the same test an evidence shift
/// already has to pass: a class with sustained exclusive evidence GOES SILENT and a different one
/// STARTS. Requiring BOTH directions is what keeps it conservative — right after a ding everything
/// looks "departed" simply because no time has passed.
///
/// THE SECOND ARM (JOS-239) needs no clock constant. The question a merge answers is "are these two
/// detectors describing ONE event?", and the honest disqualifier is that the stretch between them
/// is an ERA IN ITS OWN RIGHT: it sustains a FULL LOADOUT's worth of exclusive evidence, by the
/// same ≥2-bucket bar everything else uses, inside a span the model has already declared
/// over-determined. The departure test silently un-fixed itself as the log grew — `absorbed_window`
/// runs to the END of the observations, so "MNK left" was a question asked over all of recorded
/// history, and the owner swapped BACK into PAL/MNK/ENC 40.1 h later.
pub fn reinstated_drops(
    observations: &[ClassObservation],
    drops: &[Boundary],
    dated: &[Boundary],
    expected_slots: usize,
) -> Vec<Boundary> {
    if observations.is_empty() {
        return Vec::new();
    }
    let end = observations[observations.len() - 1].ts + 1;
    let mut out = Vec::new();
    let pick = |from: i64, to: i64| -> Vec<ClassObservation> {
        observations
            .iter()
            .filter(|o| o.ts >= from && o.ts < to)
            .cloned()
            .collect()
    };
    for drop in drops {
        if dated.iter().any(|b| b.at == drop.at) {
            continue;
        }
        let Some((from, to)) = absorbed_window(drop, dated, end) else {
            continue;
        };
        let was = exclusive_spans(&pick(from, drop.at));
        let now = exclusive_spans(&pick(drop.at, to));
        let departed: Vec<&Span> = was
            .iter()
            .filter(|s| !now.iter().any(|n| n.cls == s.cls))
            .collect();
        let arrived = now.iter().any(|n| !was.iter().any(|s| s.cls == n.cls));
        let swapped = !departed.is_empty() && arrived;
        // The absorbed stretch is a loadout era of its own, inside a span the model cannot explain.
        let own_era = was.len() >= expected_slots;
        let over_determined = exclusive_spans(&pick(from, to)).len() > expected_slots;
        if !swapped && !(own_era && over_determined) {
            continue;
        }
        // The ding is the cut (the log spoke there); the window opens no earlier than the last
        // evidence of a class that is gone, which is the narrowest honest left edge available.
        let lo = departed.iter().map(|s| s.last).fold(from, i64::max);
        out.push(Boundary {
            lo,
            hi: drop.at,
            at: drop.at,
            reason: "levelDrop",
            also: Some(vec!["evidenceShift"]),
        });
    }
    out
}

/// ONE GROUP OF OVERLAPPING WINDOWS, RESOLVED — and a `/who` cut is never what gets resolved away
/// (JOS-287).
///
/// THE DEFECT THIS EXISTS FOR. `pick_boundary` answers "these detectors describe one swap" by
/// keeping the NARROWEST window and cutting at the EARLIEST `at`. Applied to a group that contains
/// `/who` cuts that is a LIE about the log, and the live log proved it: the Aug 12 re-roll dinged
/// non-increasing (50 → 10), so the level-drop window opened at the previous ding SIX DAYS earlier
/// and overlapped all four `/who` cuts inside it. One boundary came out where there were four, and
/// the slice in front of it held two rows that contradict each other — so `slots_for` rule 1 took
/// the LAST of them and stated a loadout the owner had typed on Aug 10 BACKWARDS across a swap.
///
/// THE RULE. A `/who` row is ground truth AT ITS TIMESTAMP. Two rows are two statements, never one
/// event, and no window drawn by inference may move, merge or delete the cut a row makes.
fn resolve_group(group: &[Boundary]) -> Vec<Boundary> {
    if !group.iter().any(|b| b.reason == "who") {
        return vec![pick_boundary(group)];
    }
    // Rows landing on the SAME instant are one statement and keep the narrowest window between
    // them. Insertion-ordered, so the surviving cuts come out in first-seen order before the sort.
    let mut by_instant: JsMap<Vec<Boundary>> = JsMap::new();
    for b in group.iter().filter(|b| b.reason == "who") {
        let key = b.at.to_string();
        if let Some(list) = by_instant.get_mut(&key) {
            list.push(b.clone());
        } else {
            by_instant.insert(key, vec![b.clone()]);
        }
    }
    let mut kept: Vec<Boundary> = by_instant
        .into_values()
        .iter()
        .map(|list| pick_boundary(list))
        .collect();
    let mut undated: Vec<Boundary> = Vec::new();
    for b in group {
        if b.reason == "who" {
            continue;
        }
        // Corroboration goes on the row cut NEAREST the detector's own date — the one it was
        // describing — so `startAlso` still says which detectors agreed about that swap.
        let mut host: Option<usize> = None;
        for (i, k) in kept.iter().enumerate() {
            if !(k.at > b.lo && k.at <= b.hi) {
                continue;
            }
            let better = match host {
                None => true,
                Some(h) => (k.at - b.at).abs() < (kept[h].at - b.at).abs(),
            };
            if better {
                host = Some(i);
            }
        }
        let Some(h) = host else {
            undated.push(b.clone());
            continue;
        };
        let mut also = kept[h].also.clone().unwrap_or_default();
        for reason in std::iter::once(b.reason).chain(b.also.clone().unwrap_or_default()) {
            if !also.contains(&reason) {
                also.push(reason);
            }
        }
        kept[h].also = Some(also);
    }
    kept.extend(merge_boundaries(&undated));
    kept.sort_by_key(|b| b.at);
    kept
}

/// Collapse overlapping candidates into one boundary each, in time order. Windows that merely TOUCH
/// (one ends exactly where the next begins) are separate swaps, not one. A `/who` cut is never
/// collapsed away — see `resolve_group`.
pub fn merge_boundaries(candidates: &[Boundary]) -> Vec<Boundary> {
    let mut sorted = candidates.to_vec();
    sorted.sort_by(|a, b| a.lo.cmp(&b.lo).then_with(|| a.hi.cmp(&b.hi)));
    let mut out: Vec<Boundary> = Vec::new();
    let mut group: Vec<Boundary> = Vec::new();
    let mut group_hi = i64::MIN;
    for b in sorted {
        if !group.is_empty() && b.lo >= group_hi {
            out.extend(resolve_group(&group));
            group.clear();
        }
        group_hi = group_hi.max(b.hi);
        group.push(b);
    }
    if !group.is_empty() {
        out.extend(resolve_group(&group));
    }
    out.sort_by_key(|b| b.at);
    out
}

/// Split observations at hard cut points so shift detection never reasons across a swap the log
/// already announced.
fn hard_segments(
    observations: &[ClassObservation],
    hard: &[Boundary],
) -> Vec<Vec<ClassObservation>> {
    if hard.is_empty() {
        return vec![observations.to_vec()];
    }
    let mut cuts: Vec<i64> = hard.iter().map(|b| b.at).collect();
    cuts.sort_unstable();
    let mut segments: Vec<Vec<ClassObservation>> = vec![Vec::new(); cuts.len() + 1];
    for o in observations {
        let mut i = 0;
        while i < cuts.len() && o.ts >= cuts[i] {
            i += 1;
        }
        segments[i].push(o.clone());
    }
    segments
}

/// Every raw slice of the timeline, before scoring: `[start, end)` plus the boundary that made it.
struct Slice {
    start: Boundary,
    end: Option<i64>,
    observations: Vec<ClassObservation>,
}

fn slice_timeline(
    observations: &[ClassObservation],
    boundaries: &[Boundary],
    first_ts: i64,
) -> Vec<Slice> {
    let mut opens: Vec<Boundary> = vec![Boundary {
        lo: first_ts,
        hi: first_ts,
        at: first_ts,
        reason: "logStart",
        also: None,
    }];
    opens.extend(boundaries.iter().cloned());
    (0..opens.len())
        .map(|i| {
            let end = opens.get(i + 1).map(|b| b.at);
            let start = opens[i].clone();
            let at = start.at;
            Slice {
                start,
                end,
                observations: observations
                    .iter()
                    .filter(|o| o.ts >= at && end.is_none_or(|e| o.ts < e))
                    .cloned()
                    .collect(),
            }
        })
        .collect()
}

/// How much of `[start, end)` a correction covers. Both edges open ⇒ `i64::MAX` — the TS's
/// `Infinity`, which only ever ends up compared against another overlap.
fn overlap_ms(c: &ComboCorrection, start: i64, end: Option<i64>) -> i64 {
    let hi = match (c.end_ts, end) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => i64::MAX,
    };
    hi.saturating_sub(c.start_ts.max(start))
}

/// The correction that governs a SLICE, or `None`. TWO RULES, in order.
///
///   1. A correction COVERING the slice's start wins — the original rule, unchanged.
///   2. Otherwise the correction OVERLAPPING the slice most wins.
///
/// Rule 2 exists because boundaries MOVE under a standing override: a correction is written against
/// the interval the user was looking at and intervals are rebuilt from scratch on every fold, so a
/// cut that existed when the user pressed Save can be gone one event later. When that happens the
/// slice covering *now* begins BEFORE the correction, rule 1 misses, and under the old code the
/// override vanished with no UI event. Greatest-overlap is the conservative repair; ties fall back
/// to latest `set_at`.
pub fn correction_for_slice<'a>(
    corrections: &'a [ComboCorrection],
    start: i64,
    end: Option<i64>,
) -> Option<&'a ComboCorrection> {
    // `laterOf`: `b.setAt >= a.setAt ? b : a` — the LAST of equal `set_at` wins.
    let later_of = |a: &'a ComboCorrection, b: &'a ComboCorrection| -> &'a ComboCorrection {
        if b.set_at >= a.set_at {
            b
        } else {
            a
        }
    };
    let covering: Vec<&ComboCorrection> = corrections
        .iter()
        .filter(|c| start >= c.start_ts && c.end_ts.is_none_or(|e| start <= e))
        .collect();
    if !covering.is_empty() {
        return covering.into_iter().reduce(later_of);
    }
    let overlapping: Vec<&ComboCorrection> = corrections
        .iter()
        .filter(|c| overlap_ms(c, start, end) > 0)
        .collect();
    overlapping.into_iter().reduce(|a, b| {
        let da = overlap_ms(a, start, end);
        let db = overlap_ms(b, start, end);
        if db > da {
            b
        } else if db < da {
            a
        } else {
            later_of(a, b)
        }
    })
}

/// What `slots_for` decided, and how much of it the user is responsible for.
struct SlotDecision {
    slots: Vec<ComboSlot>,
    expected_slots: usize,
    /// The user's override is what is on screen — inference must not touch these slots.
    provenance_lock: bool,
    /// The user's override applies here and a `/who` row inside the span said otherwise.
    overruled: bool,
}

/// Slots for one slice, in authority order (§ 4.4):
///   1. the LAST `/who` row inside it — the game named the loadout for this very span, so it wins
///      even over a user correction (a correction on an anchored span is the user being wrong, and
///      it is the GAME that just spoke),
///   2. a user override governing it,
///   3. inference.
///
/// A `/who` row also sets `expectedSlots` from its own arity, which is ground truth about
/// CARDINALITY, not just membership. Rule 1 is the only way an explicit override loses, so when it
/// fires against a live override the interval carries `userOverruled` and the surface says so —
/// silence there is what JOS-87 forbids, not the precedence itself.
fn slots_for(slice: &Slice, input: &IntervalInput, prior: usize) -> SlotDecision {
    let at = slice.start.at;
    // `rows[rows.length - 1]` — the LAST row inside the slice, which is rule 1.
    let row = input
        .who_rows
        .iter()
        .rfind(|r| r.ts >= at && slice.end.is_none_or(|e| r.ts < e));
    let correction = correction_for_slice(input.corrections, at, slice.end);
    if let Some(row) = row {
        return SlotDecision {
            slots: stated_slots(&row.classes, "who"),
            expected_slots: if row.classes.len() == 2 { 2 } else { 3 },
            provenance_lock: false,
            overruled: correction.is_some_and(|c| c.classes != row.classes),
        };
    }
    if let Some(c) = correction {
        return SlotDecision {
            slots: stated_slots(&c.classes, "user"),
            expected_slots: if c.classes.len() == 2 { 2 } else { 3 },
            provenance_lock: true,
            overruled: false,
        };
    }
    SlotDecision {
        slots: score_slots(&slice.observations, prior),
        expected_slots: prior,
        provenance_lock: false,
        overruled: false,
    }
}

fn to_interval(slice: &Slice, input: &IntervalInput, index: usize) -> ComboInterval {
    let statements = LevelStatements {
        levels: input.levels,
        who_rows: input.who_rows,
    };
    let (level_lo, level_hi) = level_range(&statements, slice.start.at, slice.end);
    let prior: usize = if level_lo.is_some_and(|l| l < TERTIARY_UNLOCK_LEVEL) {
        2
    } else {
        3
    };
    let decision = slots_for(slice, input, prior);
    let last_ts = slice.observations.last().map(|o| o.ts);
    let mut interval = ComboInterval {
        id: format!("ci{}", index + 1),
        start_ts: slice.start.at,
        end_ts: slice.end,
        start_lo: slice.start.lo,
        start_hi: slice.start.hi,
        // An OPEN interval has not ended, so `endHi` stays null — but `endLo` is honest and useful:
        // it is the last moment we HAVE evidence for. A closed interval's end is the next cut.
        end_lo: slice.end.or(last_ts),
        end_hi: slice.end,
        start_reason: slice.start.reason,
        start_also: None,
        expected_slots: decision.expected_slots,
        slots: decision.slots,
        level_lo,
        level_hi,
        evidence_count: slice.observations.len(),
        user_locked: decision.provenance_lock,
        user_overruled: decision.overruled.then_some(true),
        level_regressed: level_regressed_inside(&statements, slice.start.at, slice.end)
            .then_some(true),
    };
    let mut also = slice.start.also.clone().unwrap_or_default();
    // The window could not be split further and still names more classes than a loadout holds: say
    // so rather than silently dropping the surplus (§ 4.5's floor rule).
    if exclusive_spans(&slice.observations).len() > interval.expected_slots {
        also.push("overDetermined");
    }
    if !also.is_empty() {
        let mut deduped: Vec<&'static str> = Vec::new();
        for r in also {
            if !deduped.contains(&r) {
                deduped.push(r);
            }
        }
        interval.start_also = Some(deduped);
    }
    interval
}

/// Two intervals that resolve to the SAME classes across a SOFT boundary were never two.
fn mergeable(a: &ComboInterval, b: &ComboInterval) -> bool {
    if matches!(b.start_reason, "who" | "levelDrop" | "user") {
        return false;
    }
    // A locked span is the user's statement and an overruled one carries a notice they have to see;
    // collapsing either into a neighbour would delete the thing the row exists to say.
    if a.user_locked || b.user_locked {
        return false;
    }
    if a.user_overruled == Some(true) || b.user_overruled == Some(true) {
        return false;
    }
    let key = |i: &ComboInterval| -> String {
        let mut parts: Vec<String> = i.slots.iter().map(|s| s.candidates.join("|")).collect();
        parts.sort();
        parts.join("/")
    };
    key(a) == key(b)
}

/// Post-pass for the merge rule (§ 4.5): a soft boundary between identical slot sets was noise.
fn collapse(intervals: Vec<ComboInterval>) -> Vec<ComboInterval> {
    let mut out: Vec<ComboInterval> = Vec::new();
    for interval in intervals {
        if let Some(prev) = out.last_mut() {
            if mergeable(prev, &interval) {
                prev.end_ts = interval.end_ts;
                prev.end_lo = interval.end_lo;
                prev.end_hi = interval.end_hi;
                prev.evidence_count += interval.evidence_count;
                // `Math.max(prev.levelHi ?? -Infinity, interval.levelHi ?? -Infinity)`, with the
                // `-Infinity` result folded back to null: two intervals that both state nothing
                // still state nothing.
                prev.level_hi = match (prev.level_hi, interval.level_hi) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (Some(a), None) => Some(a),
                    (None, Some(b)) => Some(b),
                    (None, None) => None,
                };
                continue;
            }
        }
        let mut next = interval;
        next.id = format!("ci{}", out.len() + 1);
        out.push(next);
    }
    out
}

/// THE WHOLE PASS. Observations MUST arrive in seq order (the module keeps them that way).
///
/// It recomputes FROM SCRATCH every time, deliberately (§ 4.5): a `/who` typed an hour from now, or
/// a user correction, retroactively re-labels the past, and patching intervals in place would leave
/// a stale id pointing at a span that no longer exists. Ids are therefore snapshot-scoped.
pub fn build_intervals(input: &IntervalInput) -> Vec<ComboInterval> {
    let mut observations = input.observations.to_vec();
    observations.sort_by_key(|o| o.seq);
    if observations.is_empty() {
        return Vec::new();
    }
    let input = IntervalInput {
        observations: &observations,
        who_rows: input.who_rows,
        levels: input.levels,
        corrections: input.corrections,
    };
    // Level dings FIRST (the log SAYS a swap happened), then the evidence shift inside each segment
    // they cut — a shift is only meaningful within one announced era. `/who` disagreements come
    // LAST because they only fire where nothing sharper already cut.
    let drops = level_drop_boundaries(input.levels);
    let mut shifts: Vec<Boundary> = Vec::new();
    for segment in hard_segments(&observations, &merge_boundaries(&drops)) {
        // The prior is enough here: a 2-slot era simply cannot be over-determined at 3.
        shifts.extend(evidence_shift_boundaries(&segment, 3));
    }
    let mut all = drops.clone();
    all.extend(shifts);
    let merged = merge_boundaries(&all);
    // …and put back any ding the merge swallowed that the evidence says was its OWN swap. After the
    // merge rather than inside it because the test needs the observations, and because it may only
    // ever ADD a cut the merge deleted.
    let mut with_reinstated = merged.clone();
    with_reinstated.extend(reinstated_drops(&observations, &drops, &merged, 3));
    let dated = merge_boundaries(&with_reinstated);
    // …then the two `/who` rules, NARROW FIRST. `who_shift_boundaries` cuts at a row the evidence
    // behind it contradicts — a swap the log otherwise never dates. Its cuts are handed to
    // `who_boundaries` as already-dated, so a disagreement between two rows that the row-level rule
    // has just placed does not open a second, three-hours-wide boundary for the same swap.
    let shifted = who_shift_boundaries(&observations, input.who_rows, &dated, observations[0].ts);
    let mut candidates = dated.clone();
    candidates.extend(shifted.clone());
    let mut dated_and_shifted = dated.clone();
    dated_and_shifted.extend(shifted);
    candidates.extend(who_boundaries(input.who_rows, &dated_and_shifted));
    let placed = merge_boundaries(&candidates);
    // THE TRIPWIRE LAW, MADE STRUCTURAL (JOS-287). `who_boundaries` stands down when something
    // already-dated cuts between two disagreeing rows — but it is handed the CANDIDATES, and an
    // inferred candidate can still be absorbed by the merge that follows (a `/who` cut cannot).
    // Asking the same question again of the boundaries that actually SURVIVED closes that: every
    // adjacent pair of rows that disagree ends up with a cut between them, so no slice can hold two
    // contradictory rows. Nothing merges these — a row is ground truth at its timestamp, full stop.
    let mut boundaries = placed.clone();
    boundaries.extend(who_boundaries(input.who_rows, &placed));
    boundaries.sort_by_key(|b| b.at);
    boundaries.retain(|b| b.at > observations[0].ts);
    let slices = slice_timeline(&observations, &boundaries, observations[0].ts);
    let built: Vec<ComboInterval> = slices
        .iter()
        .enumerate()
        .map(|(i, slice)| to_interval(slice, &input, i))
        .collect();
    collapse(built)
}
