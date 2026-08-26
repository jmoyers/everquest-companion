//! THE ACTIVE-STATE TIMELINE — "what was on at time T", as an interval model with EVIDENCE on both
//! edges (`src/main/combat/stateTimeline.ts`).
//!
//! WHY IT LIVES IN THE COMBAT ENGINE. Three of the four kinds already have exactly one owner here:
//! `EngineState` owns the stance/invocation pair and the two-slot coat state, and the encounter's
//! stance spans are already a span list. A parallel service would fork state that has one owner
//! today, and forked state drifts.
//!
//! DELIBERATELY NOT MERGED with the encounter's own `stance_spans`: that list is consumed by the
//! shipped timeline view and sits inside the byte-identical regression surface. Two lists, one shared
//! writer (`procrouting::apply_stance`). This ring is SESSION-level and purely additive.
//!
//! LAW 1 IS THE SHAPE OF THIS FILE. The game prints a state's START (a stance commit, a coat line, a
//! buff landing). It almost never prints the END — the real log carries 97 `Instrument of Nife`
//! landings against ONE observed fade. So every edge is LABELED: only a line the game printed earns
//! `observed`; a replacing sibling is `inferred`; a severed boundary is `censored` and NEVER renders
//! as an end time.
//!
//! ── `active` IS A HASH SET AND THAT IS SAFE ───────────────────────────────────────────────────
//!
//! Over there it is a JS `Set`, whose iteration order is insertion order — and this crate's rule is
//! that a published array's order is a claim. This one is not published: every consumer either looks
//! a key UP (`swings_by_state`, `active_ms_by_state`, `by_state`) or folds the keys into another set
//! that is SORTED before it reaches a string (`co_state_confounds`). Checked rather than assumed, and
//! written down so nobody has to check it twice.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

/// Memory bound only — the whole 1.1M-line log produces ~700 stance and invocation commits, 6 coats
/// and 97 buff applies, so this is never reached in practice. Drop-oldest, like every other ring.
pub const STATE_SPAN_CAP: usize = 2_000;

/// `shared/procAnalytics.ts StateKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StateKind {
    Buff,
    Invocation,
    Stance,
    Coat,
}

impl StateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StateKind::Buff => "buff",
            StateKind::Invocation => "invocation",
            StateKind::Stance => "stance",
            StateKind::Coat => "coat",
        }
    }
}

/// `shared/procAnalytics.ts EdgeEvidence`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeEvidence {
    Observed,
    Inferred,
    Censored,
    Open,
}

/// The join key a window ledger / link join uses: one string per active state.
pub fn state_key_of(kind: StateKind, key: &str) -> String {
    format!("{}:{}", kind.as_str(), key)
}

/// The span as the payload carries it — `shared/procAnalytics.ts StateSpan`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSpan {
    pub kind: StateKind,
    pub key: String,
    pub name: String,
    pub start_ts: i64,
    /// ABSENT — never null — while the span is still open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ts: Option<i64>,
    pub start_evidence: EdgeEvidence,
    pub end_evidence: EdgeEvidence,
}

/// The engine-internal span record: the shared shape plus the EXCLUSIVITY GROUP, which is the whole
/// mechanism by which an unprinted end becomes an inferred one.
///
/// Groups, and why each is what it is:
///   `stance` / `invocation` — nine members each, mutually exclusive, so a new commit ENDS the
///                             previous span. The game prints no "your stance ends" line.
///   `coat:utility`          — one slot; a new utility coat replaces the old one.
///   `coat:combat:<line>`    — combat venoms STACK (wiki, Rogue page; proved by the real log), so each
///                             venom LINE is its own group and only a re-coat of the same line
///                             supersedes.
///   `buff:<key>`            — a re-apply supersedes its own span; unrelated buffs coexist.
///
/// `group` is engine-internal on purpose: `spans_overlapping` projects plain `StateSpan`s, so the
/// shared payload type never grows a field the renderer has no use for.
#[derive(Debug, Clone)]
struct SpanRecord {
    span: StateSpan,
    group: String,
}

/// Everything needed to open a span.
pub struct OpenState<'a> {
    pub kind: StateKind,
    /// Canonical join key — lowercased (law 2: canonicalize at boundaries).
    pub key: &'a str,
    /// Display name, raw casing.
    pub name: &'a str,
    pub ts: i64,
    /// Exclusivity group; `None` defaults to `<kind>:<key>` (self-exclusive: only a re-open of the
    /// same state supersedes).
    pub group: Option<String>,
}

/// The session-level span ring plus its LIVE open index.
#[derive(Debug, Default)]
pub struct StateTimeline {
    spans: Vec<SpanRecord>,
    /// `<kind>:<key>` of every open span. Read-only to callers; mutated here only.
    pub active: HashSet<String>,
    /// group → INDEX of the one OPEN span in that group. The exclusivity index.
    open: HashMap<String, usize>,
}

impl StateTimeline {
    pub fn new() -> Self {
        StateTimeline::default()
    }

    pub fn reset(&mut self) {
        self.spans.clear();
        self.active.clear();
        self.open.clear();
    }

    /// Open a span, closing whatever open span shares its exclusivity group as `inferred` — the only
    /// honest verdict when the game never printed an end. Callers that can be re-asserted with no
    /// state change already drop the no-op before reaching here, so this never accrues zero-width
    /// spans from re-commits.
    pub fn note_state(&mut self, a: &OpenState) {
        let group = a
            .group
            .clone()
            .unwrap_or_else(|| state_key_of(a.kind, a.key));
        if let Some(&prev) = self.open.get(&group) {
            self.finish(prev, a.ts, EdgeEvidence::Inferred);
        }
        self.spans.push(SpanRecord {
            span: StateSpan {
                kind: a.kind,
                key: a.key.to_string(),
                name: a.name.to_string(),
                start_ts: a.ts,
                end_ts: None,
                start_evidence: EdgeEvidence::Observed,
                end_evidence: EdgeEvidence::Open,
            },
            group: group.clone(),
        });
        if self.spans.len() > STATE_SPAN_CAP {
            self.drop_oldest();
        }
        self.open.insert(group, self.spans.len() - 1);
        self.active.insert(state_key_of(a.kind, a.key));
    }

    /// Close the open span for (kind, key) — the printed-end path. A close with nothing open is a
    /// no-op: the game can print a wears-off for a buff whose landing predates the replay, and
    /// fabricating a zero-width span for it would be an invention.
    pub fn close_state(&mut self, kind: StateKind, key: &str, ts: i64, evidence: EdgeEvidence) {
        let found = self
            .open
            .values()
            .copied()
            .find(|&i| self.spans[i].span.kind == kind && self.spans[i].span.key == key);
        if let Some(i) = found {
            self.finish(i, ts, evidence);
        }
    }

    /// Close EVERY open span in a group (the combat-coat dry line: it names the family, and the log
    /// CANNOT say which venom of a stack expired — law 6).
    pub fn close_group_prefix(&mut self, prefix: &str, ts: i64, evidence: EdgeEvidence) {
        let hits: Vec<usize> = self
            .open
            .values()
            .copied()
            .filter(|&i| self.spans[i].group.starts_with(prefix))
            .collect();
        for i in hits {
            self.finish(i, ts, evidence);
        }
    }

    /// A boundary severed every span: epoch, engine reset, player death. The end is UNKNOWABLE, so it
    /// is `censored` — never `observed`, and never a fabricated expiry. The spans stay in the ring
    /// (they describe real, observed intervals up to the cut); only their end evidence says the cut is
    /// where our knowledge stops.
    pub fn censor_all(&mut self, ts: i64) {
        let hits: Vec<usize> = self.open.values().copied().collect();
        for i in hits {
            self.finish(i, ts, EdgeEvidence::Censored);
        }
    }

    /// Spans that overlap `[from_ts, to_ts]`, projected to the shared payload shape. An OPEN span
    /// overlaps any window that ends after it started.
    pub fn spans_overlapping(&self, from_ts: i64, to_ts: i64) -> Vec<StateSpan> {
        self.spans
            .iter()
            .filter(|s| {
                let ends_after = s.span.end_ts.is_none_or(|e| e >= from_ts);
                ends_after && s.span.start_ts <= to_ts
            })
            .map(|s| s.span.clone())
            .collect()
    }

    fn finish(&mut self, idx: usize, ts: i64, evidence: EdgeEvidence) {
        let rec = &mut self.spans[idx];
        rec.span.end_ts = Some(ts);
        rec.span.end_evidence = evidence;
        let group = rec.group.clone();
        let key = state_key_of(rec.span.kind, &rec.span.key);
        self.open.remove(&group);
        self.active.remove(&key);
    }

    /// Drop-oldest under the cap. A dropped span may still be the OPEN one for its group (a permanent
    /// buff outliving 2,000 later commits), so the open index is REPAIRED rather than left pointing at
    /// a record no longer in the ring.
    fn drop_oldest(&mut self) {
        if self.spans.is_empty() {
            return;
        }
        let gone = self.spans.remove(0);
        if self.open.get(&gone.group) == Some(&0) {
            self.open.remove(&gone.group);
            self.active
                .remove(&state_key_of(gone.span.kind, &gone.span.key));
        }
        for i in self.open.values_mut() {
            *i = i.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open<'a>(kind: StateKind, key: &'a str, ts: i64, group: Option<&str>) -> OpenState<'a> {
        OpenState {
            kind,
            key,
            name: key,
            ts,
            group: group.map(str::to_string),
        }
    }

    /// A REPLACING SIBLING ends the previous span as `inferred` — the game never prints a stance end.
    #[test]
    fn a_new_commit_infers_the_end_of_the_one_it_replaced() {
        let mut t = StateTimeline::new();
        t.note_state(&open(StateKind::Stance, "offensive", 1_000, Some("stance")));
        t.note_state(&open(StateKind::Stance, "defensive", 2_000, Some("stance")));
        let spans = t.spans_overlapping(0, 9_999);
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].end_ts, Some(2_000));
        assert_eq!(spans[0].end_evidence, EdgeEvidence::Inferred);
        assert_eq!(spans[1].end_evidence, EdgeEvidence::Open);
        assert_eq!(t.active.len(), 1);
        assert!(t.active.contains("stance:defensive"));
    }

    /// VENOMS ON DIFFERENT LINES STACK — different groups coexist, and a family close reaches both.
    #[test]
    fn coat_lines_stack_and_a_family_dry_closes_the_whole_stack() {
        let mut t = StateTimeline::new();
        t.note_state(&open(
            StateKind::Coat,
            "asp venom",
            1_000,
            Some("coat:combat:asp"),
        ));
        t.note_state(&open(
            StateKind::Coat,
            "stunning venom",
            1_100,
            Some("coat:combat:stunning"),
        ));
        assert_eq!(t.active.len(), 2);
        t.close_group_prefix("coat:combat:", 5_000, EdgeEvidence::Inferred);
        assert!(t.active.is_empty());
        for s in t.spans_overlapping(0, 9_999) {
            assert_eq!(s.end_evidence, EdgeEvidence::Inferred);
        }
    }

    /// A CLOSE WITH NOTHING OPEN IS A NO-OP — never a fabricated zero-width span.
    #[test]
    fn closing_a_state_that_was_never_opened_invents_nothing() {
        let mut t = StateTimeline::new();
        t.close_state(
            StateKind::Buff,
            "instrument of nife",
            1_000,
            EdgeEvidence::Observed,
        );
        assert!(t.spans_overlapping(0, 9_999).is_empty());
    }

    /// AN OPEN SPAN OVERLAPS ANY WINDOW THAT ENDS AFTER IT STARTED, and a closed one only its own span.
    #[test]
    fn overlap_treats_an_open_span_as_unbounded() {
        let mut t = StateTimeline::new();
        t.note_state(&open(StateKind::Buff, "nife", 1_000, None));
        assert_eq!(t.spans_overlapping(50_000, 60_000).len(), 1);
        t.censor_all(2_000);
        assert!(t.spans_overlapping(50_000, 60_000).is_empty());
        assert_eq!(
            t.spans_overlapping(0, 1_500)[0].end_evidence,
            EdgeEvidence::Censored
        );
    }
}
