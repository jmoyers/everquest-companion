//! THE PPM ENGINE + THE MINUTE-WINDOW LEDGER (`src/main/combat/procWindows.ts`).
//!
//! Two things live here and they share a file because they share every constant:
//!
//!   1. `proc_rate` — the THREE denominators. All carried, none hidden, and every one of them ABSENT
//!      below its sample floor rather than 0 (law 5). `1 proc in a 2-second pull` is not `30 ppm`, and
//!      a meter that prints it once will print it forever.
//!   2. `WindowAccum` — the wall-clock-minute ledger the Tier-B counterfactual needs, plus the
//!      eligibility partition and the comparison itself.
//!
//! ACTIVE TIME IS REUSED, NEVER REDEFINED. `Encounter.active_ms` is Σ over consecutive ATTRIBUTED
//! damage hits of `min(gap, ACTIVE_MS)` with the first hit adding 0 (`routing.rs`). This ledger does
//! not recompute it: ingest hands it the exact per-hit delta the engine just accrued, so the two can
//! never drift.
//!
//! A CAVEAT THAT IS LABELED, NOT FIXED: `route()` accrues active time BEFORE the incoming/outgoing
//! split, so incoming damage extends active time too — a pull where you are being beaten on while
//! stunned accrues active seconds you did not swing in. Changing it would move `activeDps`, a SHIPPED
//! number. So the number keeps the meter's meaning and the UI states it; `per100Swings` exists
//! precisely because it has no such ambiguity.
//!
//! ── MEDIANS, NEVER MEANS (law 5) ─────────────────────────────────────────────────────────────
//!
//! One eight-minute boss window must not set the headline, and a mean over uncontrolled EQ content is
//! exactly the aggregate that lies. Every arm reports its median, its IQR and its own n, and the two
//! arms are never pooled. CONFOUNDS ARE DECLARED, NEVER CORRECTED: regression-adjusting an
//! observational comparison over content nobody randomised would manufacture confidence the data
//! cannot support, and the two confounds this ledger CANNOT test are declared as untested rather than
//! omitted — an omitted check reads as a passed one.

use std::collections::HashSet;

use crate::combat::collate::compare_names;
use crate::combat::procdetect::{lane_count, SpellProcLane};
use crate::combat::statetimeline::{state_key_of, StateKind, StateSpan};
use crate::jsmap::JsMap;
use serde::Serialize;

// ── Sample floors. Below each of these a number is ABSENT, never 0. ────────────────────────────

/// Below this much active time, `ppmActive` and `ppmWall` are absent.
pub const MIN_ACTIVE_SEC: f64 = 10.0;
/// Below this many logged swings, `per100Swings` is absent.
pub const MIN_SWINGS: i64 = 20;

/// THE RATE-AWARE EXPOSURE GATE, and the number is a count of PROCS, not of swings.
///
/// It REPLACES the plan's flat `MIN_INACTIVE_SWINGS = 200`, which contradicted the plan's own
/// narrative: `Instrument of Nife` — 289 inactive swings against 261,505 active ones — was required to
/// come out `inconclusive`, and 289 > 200 made it `exclusive`, the exact claim the plan spent a
/// section refusing to make.
///
/// A flat swing floor cannot express the judgement, because the judgement is not about swings. "It
/// never fired without it" is evidence only in proportion to how many firings the inactive arm SHOULD
/// have produced, so the gate is the lane's OWN observed rate projected onto the inactive exposure:
/// `expected = inactive_swings × (with_count / active_swings)`. On the real log the two named cases
/// then separate for the right reason — Nife's 289 inactive swings predict ~1.2 procs (seeing zero is
/// barely evidence ⇒ inconclusive) while a spellblade lane's 225 predict ~7.8 (seeing zero is a real
/// measurement ⇒ exclusive).
///
/// Three, not five or ten: below three expected firings a null result is ordinary luck (at λ = 3 a
/// Poisson zero still happens 5% of the time), and raising it further would silence the one genuine
/// exclusivity this log contains.
pub const MIN_EXPECTED_INACTIVE_PROCS: f64 = 3.0;

/// One wall-clock minute. Sixty seconds, chosen by MEASUREMENT rather than taste: on the real log,
/// minute windows yield 1,289 clean `inversion` windows against 324 clean `spellblade` ones — both
/// arms of the biggest comparison comfortably sampled, which a five-minute window would not achieve
/// for the smaller arm.
pub const WINDOW_MS: i64 = 60_000;

/// Memory bound, drop-oldest. A long zone session is a few hundred windows; this is four thousand,
/// i.e. ~2.8 days of continuous play, and exists only so an unbounded map cannot.
pub const WINDOW_CAP: usize = 4_000;

/// Per-window volume gates. A minute spent standing still is not evidence about anything, so it is
/// DISCARDED from both arms rather than counted as a zero.
pub const MIN_WINDOW_SWINGS: i64 = 10;
pub const MIN_WINDOW_ACTIVE_MS: i64 = 20_000;

/// Per-arm sample gate for a Tier-B estimate. Below this the verdict is `insufficient-sample`, naming
/// which arm is short.
pub const MIN_ARM_WINDOWS: usize = 20;

/// A co-state is declared a confound when its active fraction differs between the arms by more than
/// this (20 percentage points).
pub const CO_STATE_GAP: f64 = 0.2;

/// The sentence, verbatim, for every effect with no per-hit marker — which per the wiki is 17 of the
/// 18 stances and invocations. It rides the row WHATEVER the verdict is: an `estimate` for a stance is
/// still an estimate ABOUT something the log never marks.
const NO_PER_HIT_MARKER_NOTE: &str = "A stance that boosts base melee has no per-hit marker in the log. Nothing distinguishes a swing under Offensive from a swing under Balanced except the swing\u{2019}s number - and the mob, your level and your gear all changed too. The window comparison is the closest honest answer, and it is an estimate.";

/// Neither is recorded in the minute ledger, so neither can be tested. DECLARED, because a confound
/// list that silently omits the checks it could not run reads as a clean bill.
const UNTESTED_CONFOUNDS: &str =
    "not tested - level drift and mob mix are not carried in the minute ledger";

/// Kept SHORT on purpose: it rides every effect row of a 4×/sec snapshot, and a paragraph repeated
/// twenty-five times is payload, not honesty.
const DIRECT_NOTE: &str =
    "No lane is attributed to this state; the exact per-lane numbers are in the lane list.";

// ── The window ledger ─────────────────────────────────────────────────────────────────────────

/// One minute of combat, as the counterfactual sees it.
#[derive(Debug, Clone)]
pub struct ProcWindow {
    /// `floor(ts / WINDOW_MS)` — the window's identity.
    pub minute: i64,
    /// Capped-gap active time accrued in this window, using the ENGINE's own per-hit delta.
    pub active_ms: i64,
    /// YOUR swing attempts: melee + slay hits, plus your misses.
    pub swings: i64,
    /// YOUR outgoing damage.
    pub out_damage: i64,
    /// Of that, the damage carried by detected proc lines.
    pub proc_damage: i64,
    /// The exclusivity GROUPS the commits inside this minute belonged to. The purity gate is
    /// per-STATE, so a bare count cannot implement it — an unrelated coat swap must not disqualify a
    /// window from the stance comparison.
    pub transition_groups: HashSet<String>,
    /// `<kind>:<key>` of every state observed active at a combat event in this window. Sampled at
    /// accrual points on purpose: a state that was only ever on during a lull nobody swung in has no
    /// bearing on a comparison of swinging minutes.
    pub state_keys: HashSet<String>,
}

/// One fold into the ledger. Every field optional because the three producers (damage, swing, commit)
/// each move a different subset.
#[derive(Debug, Default)]
pub struct WindowFold {
    pub ts: i64,
    /// The EXACT per-hit active-time delta the engine just accrued (never recomputed here).
    pub active_delta_ms: i64,
    pub out_damage: i64,
    pub proc_damage: i64,
    pub swings: i64,
}

/// The minute-window ledger. Lives on `Agg`, for the same reason the healing and proc ledgers do: an
/// encounter and a FINALIZED zone session inherit it frozen, for free, and every number is folded on
/// INGEST so nothing here can ever depend on a capped or truncated event ring.
#[derive(Debug, Default)]
pub struct WindowAccum {
    /// Keyed by minute, INSERTION-ORDERED because the drop-oldest cap evicts the first key inserted.
    windows: JsMap<ProcWindow>,
}

impl WindowAccum {
    pub fn new() -> Self {
        WindowAccum::default()
    }

    /// Fold combat activity into the window covering `f.ts`.
    pub fn fold(&mut self, f: &WindowFold, active: &HashSet<String>) {
        let w = self.ensure(f.ts, active);
        w.active_ms += f.active_delta_ms;
        w.out_damage += f.out_damage;
        w.proc_damage += f.proc_damage;
        w.swings += f.swings;
    }

    /// Record a state commit. The window it lands in is IMPURE for that state's group — the boundary
    /// carries the reuse timer, the re-buff burst and the mid-window re-target, which is precisely the
    /// confound the purity gate exists to exclude.
    pub fn note_transition(&mut self, ts: i64, group: &str, active: &HashSet<String>) {
        let w = self.ensure(ts, active);
        w.transition_groups.insert(group.to_string());
        for k in active {
            w.state_keys.insert(k.clone());
        }
    }

    /// Windows in ascending minute order.
    pub fn list(&self) -> Vec<&ProcWindow> {
        let mut out: Vec<&ProcWindow> = self.windows.values().collect();
        out.sort_by_key(|w| w.minute);
        out
    }

    fn ensure(&mut self, ts: i64, active: &HashSet<String>) -> &mut ProcWindow {
        let minute = ts.div_euclid(WINDOW_MS);
        let key = minute.to_string();
        if self.windows.contains_key(&key) {
            let w = self.windows.get_mut(&key).expect("present");
            // A state can turn on mid-window; the set is a UNION over the window, not a snapshot.
            for k in active {
                w.state_keys.insert(k.clone());
            }
            return w;
        }
        self.windows.insert(
            key.clone(),
            ProcWindow {
                minute,
                active_ms: 0,
                swings: 0,
                out_damage: 0,
                proc_damage: 0,
                transition_groups: HashSet::new(),
                state_keys: active.clone(),
            },
        );
        if self.windows.len() > WINDOW_CAP {
            let oldest = self.windows.keys().next().map(str::to_string);
            if let Some(k) = oldest {
                self.windows.remove(&k);
            }
        }
        self.windows.get_mut(&key).expect("just inserted")
    }
}

// ── The eligibility partition ─────────────────────────────────────────────────────────────────

/// The two arms of a matched-window comparison, plus the bookkeeping that makes the verdict auditable.
pub struct WindowArms<'a> {
    /// Windows where the state was on for the whole minute.
    pub active: Vec<&'a ProcWindow>,
    /// Windows where it was off for the whole minute.
    pub inactive: Vec<&'a ProcWindow>,
}

/// The exclusivity group a projected span commits under. COATS collapse to the family prefix: the
/// shared span shape cannot say utility from combat (law 6 — the dry line names a family, never a
/// venom).
pub fn group_of(kind: StateKind, key: &str) -> String {
    match kind {
        StateKind::Stance | StateKind::Invocation => kind.as_str().to_string(),
        StateKind::Coat => "coat:".to_string(),
        StateKind::Buff => format!("buff:{key}"),
    }
}

/// Split the ledger into the two arms for ONE state, applying both eligibility gates:
///
///   1. PURITY — no commit of that state's exclusivity group landed inside the window. A window
///      containing a switch is DISCARDED, not split: the boundary is the confound.
///   2. VOLUME — `swings >= MIN_WINDOW_SWINGS` and `active_ms >= MIN_WINDOW_ACTIVE_MS`.
///
/// `group` is matched as a PREFIX. Exact match is the normal case; the prefix exists for COATS, whose
/// groups are `coat:utility` and `coat:combat:<line>` and whose projected span cannot say which of the
/// two it was. A coat study therefore reads `coat:` and any coat commit disqualifies the minute — it
/// discards MORE windows than a per-venom rule would, which is the safe direction for a purity gate.
pub fn partition_windows<'a>(
    windows: &[&'a ProcWindow],
    state_key: &str,
    group: &str,
) -> WindowArms<'a> {
    let mut arms = WindowArms {
        active: Vec::new(),
        inactive: Vec::new(),
    };
    for w in windows {
        if w.transition_groups.iter().any(|g| g.starts_with(group)) {
            continue;
        }
        if w.swings < MIN_WINDOW_SWINGS || w.active_ms < MIN_WINDOW_ACTIVE_MS {
            continue;
        }
        if w.state_keys.contains(state_key) {
            arms.active.push(w);
        } else {
            arms.inactive.push(w);
        }
    }
    arms
}

/// Windows that clear the VOLUME gates alone. State-independent, so it is the honest denominator for
/// the report's `windowsEligible` — purity is decided per state.
pub fn volume_eligible(windows: &[&ProcWindow]) -> usize {
    windows
        .iter()
        .filter(|w| w.swings >= MIN_WINDOW_SWINGS && w.active_ms >= MIN_WINDOW_ACTIVE_MS)
        .count()
}

// ── The three denominators ────────────────────────────────────────────────────────────────────

/// How long the thing that FIRES a lane was actually present, and what it was called.
///
/// A proc cannot fire while its source is off: a rogue Strike needs the coat on the blades, an
/// aura-granted proc needs the aura up. `ppmActive` over the whole segment therefore answers a
/// question nobody asked, and the answer is systematically low.
pub struct ProcSourceWindow {
    pub active_sec: f64,
    pub name: String,
}

/// What a rate needs.
#[derive(Default)]
pub struct RateInput {
    pub count: i64,
    /// The SEGMENT's active time (the meter's own definition).
    pub active_sec: f64,
    pub duration_sec: f64,
    pub swings: i64,
    /// The lane's SOURCE window, when one is modeled.
    pub source: Option<ProcSourceWindow>,
    /// The caller is a LANE whose source window it could not resolve. The segment's own active time is
    /// used and `sourceAmbiguous` is set, so the assumption travels with the number. Distinct from
    /// passing NEITHER field, which is what the OVERALL headline does: "every proc in this selection
    /// per minute of it" is a question about the selection, so the segment is not an assumption there
    /// — it is the subject.
    pub source_unknown: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcRateView {
    pub count: i64,
    pub swings: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ambiguous: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ppm_active: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ppm_wall: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per100_swings: Option<f64>,
}

/// The three denominators, each ABSENT below its floor.
///
/// `count` and `swings` are always present and always exact — they are counts of lines the game
/// printed. Only the RATES can be missing, and they are missing precisely when dividing would
/// manufacture a number the sample cannot support.
///
/// `ppmActive` divides by the SOURCE window when one is known and by the segment otherwise, and says
/// which it did. The floor applies to whichever denominator is actually USED — a coat that was on for
/// four seconds of a ten-minute session yields no rate at all, which is the honest answer and not a
/// 15-ppm headline. The window is DECLARED whether or not it clears the floor, because the absence
/// message has to be able to say "this coat was on for 4 seconds".
///
/// `ppmWall` and `per100Swings` are unchanged by the source window: wall clock is wall clock, and
/// swings are the mechanical denominator whose whole virtue is having no window ambiguity in it.
pub fn proc_rate(i: &RateInput) -> ProcRateView {
    let mut view = ProcRateView {
        count: i.count,
        swings: i.swings,
        source_sec: None,
        source_name: None,
        source_ambiguous: None,
        ppm_active: None,
        ppm_wall: None,
        per100_swings: None,
    };
    let sec = match &i.source {
        Some(s) => s.active_sec,
        None => i.active_sec,
    };
    if let Some(s) = &i.source {
        view.source_sec = Some(sec);
        view.source_name = Some(s.name.clone());
    } else if i.source_unknown {
        view.source_sec = Some(sec);
        view.source_ambiguous = Some(true);
    }
    if sec >= MIN_ACTIVE_SEC {
        view.ppm_active = Some(i.count as f64 / (sec / 60.0));
        if i.duration_sec > 0.0 {
            view.ppm_wall = Some(i.count as f64 / (i.duration_sec / 60.0));
        }
    }
    if i.swings >= MIN_SWINGS {
        view.per100_swings = Some((100 * i.count) as f64 / i.swings as f64);
    }
    view
}

// ── Links ─────────────────────────────────────────────────────────────────────────────────────

/// Co-occurrence counts + BOTH swing exposures. The active-side count is what turns the gate from a
/// flat swing floor into the lane's own observed rate.
pub struct LinkInput {
    pub with_count: i64,
    pub without_count: i64,
    /// YOUR swing attempts logged while the state was ACTIVE — the denominator of the lane's own proc
    /// rate, and the only reason this classifier can tell a rare proc from a common one.
    pub active_swings: i64,
    /// YOUR swing attempts logged while the state was INACTIVE — the exposure the claim rests on.
    pub inactive_swings: i64,
}

/// How many firings the INACTIVE arm was worth, in procs. `max` of two estimates, and neither may be
/// dropped: what the arm ACTUALLY produced (direct observation beats any model) and what the active
/// arm's own rate PREDICTS for that many swings (the only estimate available in the case that matters,
/// `without_count == 0`, where the whole question is whether the zero means anything).
pub fn expected_inactive_procs(i: &LinkInput) -> f64 {
    let rate = if i.active_swings > 0 {
        i.with_count as f64 / i.active_swings as f64
    } else {
        0.0
    };
    f64::max(i.without_count as f64, i.inactive_swings as f64 * rate)
}

/// Classify a link. THE DEFAULT IS `inconclusive`, and that is the point: a lane that never fired
/// without a state is only evidence when the inactive arm had a real chance to produce firings.
/// Concentration alone can never reach `exclusive` — a 100% concentration measured against 36 swings
/// of exposure is not a measurement.
pub fn link_strength(i: &LinkInput) -> &'static str {
    let total = i.with_count + i.without_count;
    if total == 0 {
        return "inconclusive";
    }
    if expected_inactive_procs(i) < MIN_EXPECTED_INACTIVE_PROCS {
        return "inconclusive";
    }
    if i.without_count == 0 {
        return "exclusive";
    }
    if i.with_count as f64 / total as f64 >= 0.8 {
        "correlated"
    } else {
        "weak"
    }
}

/// `with / (with + without)`, 0 when the lane never fired at all — never NaN, because a 0/0 that
/// reaches a percentage formatter is how a meter prints "NaN%".
pub fn concentration_of(with_count: i64, without_count: i64) -> f64 {
    let total = with_count + without_count;
    if total == 0 {
        0.0
    } else {
        with_count as f64 / total as f64
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcLink {
    pub kind: StateKind,
    pub key: String,
    pub name: String,
    pub with_count: i64,
    pub without_count: i64,
    pub concentration: f64,
    pub inactive_swings: i64,
    pub strength: &'static str,
}

// ── TIER B ────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginalEstimate {
    pub n_active: usize,
    pub n_inactive: usize,
    pub med_dps_active: f64,
    pub med_dps_inactive: f64,
    pub iqr_active: [f64; 2],
    pub iqr_inactive: [f64; 2],
    pub delta_dps: f64,
    pub delta_pct: f64,
    pub med_proc_dps_active: f64,
    pub med_proc_dps_inactive: f64,
    pub med_dmg_per_swing_active: f64,
    pub med_dmg_per_swing_inactive: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectView {
    pub damage: i64,
    pub heal: i64,
    pub hits: i64,
    pub dps_contribution: f64,
    pub lanes: Vec<String>,
}

fn no_direct() -> DirectView {
    DirectView {
        damage: 0,
        heal: 0,
        hits: 0,
        dps_contribution: 0.0,
        lanes: Vec::new(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectAttribution {
    pub kind: StateKind,
    pub key: String,
    pub name: String,
    pub direct: DirectView,
    pub verdict: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marginal: Option<MarginalEstimate>,
    pub confounds: Vec<String>,
    pub note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionReport {
    pub session_id: String,
    pub window_sec: i64,
    pub windows_total: usize,
    pub windows_eligible: usize,
    pub effects: Vec<EffectAttribution>,
}

/// Linear-interpolated quantile (the PERCENTILE.INC / type-7 definition) over an ASCENDING slice. One
/// definition, stated, so the IQR the UI prints is reproducible.
fn quantile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = p * (sorted.len() - 1) as f64;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo as f64)
    }
}

/// The three per-window statistics of one arm, each sorted ascending. Kept SEPARATE on purpose: on the
/// real log spellblade moves proc damage ~40% while leaving damage-per-swing flat, and one blended
/// headline would hide the entire mechanism.
struct ArmSeries {
    dps: Vec<f64>,
    proc_dps: Vec<f64>,
    per_swing: Vec<f64>,
}

fn series_of(ws: &[&ProcWindow]) -> ArmSeries {
    let mut s = ArmSeries {
        dps: Vec::new(),
        proc_dps: Vec::new(),
        per_swing: Vec::new(),
    };
    for w in ws {
        let sec = w.active_ms as f64 / 1000.0;
        if sec > 0.0 {
            s.dps.push(w.out_damage as f64 / sec);
            s.proc_dps.push(w.proc_damage as f64 / sec);
        }
        if w.swings > 0 {
            s.per_swing.push(w.out_damage as f64 / w.swings as f64);
        }
    }
    let asc = |v: &mut Vec<f64>| v.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    asc(&mut s.dps);
    asc(&mut s.proc_dps);
    asc(&mut s.per_swing);
    s
}

/// The matched-window comparison. Both arms' n's ride along: a delta with one n hidden is a precision
/// claim, and the renderer needs both to draw the estimate as a RANGE.
fn marginal_of(arms: &WindowArms) -> MarginalEstimate {
    let a = series_of(&arms.active);
    let i = series_of(&arms.inactive);
    let med_a = quantile(&a.dps, 0.5);
    let med_i = quantile(&i.dps, 0.5);
    MarginalEstimate {
        n_active: arms.active.len(),
        n_inactive: arms.inactive.len(),
        med_dps_active: med_a,
        med_dps_inactive: med_i,
        iqr_active: [quantile(&a.dps, 0.25), quantile(&a.dps, 0.75)],
        iqr_inactive: [quantile(&i.dps, 0.25), quantile(&i.dps, 0.75)],
        delta_dps: med_a - med_i,
        delta_pct: if med_i > 0.0 {
            ((med_a - med_i) / med_i) * 100.0
        } else {
            0.0
        },
        med_proc_dps_active: quantile(&a.proc_dps, 0.5),
        med_proc_dps_inactive: quantile(&i.proc_dps, 0.5),
        med_dmg_per_swing_active: quantile(&a.per_swing, 0.5),
        med_dmg_per_swing_inactive: quantile(&i.per_swing, 0.5),
    }
}

/// `${Math.round(f * 100)}%` — round-half-UP, which is not `f64::round`. Every value here is a
/// non-negative fraction so the two agree on this input; the distinction is written down because a
/// negative would split them.
fn pct(f: f64) -> String {
    format!("{}%", (f * 100.0 + 0.5).floor() as i64)
}

fn fraction_active(ws: &[&ProcWindow], key: &str) -> f64 {
    if ws.is_empty() {
        return 0.0;
    }
    let n = ws.iter().filter(|w| w.state_keys.contains(key)).count();
    n as f64 / ws.len() as f64
}

/// Every OTHER tracked state whose presence differs materially between the arms. This is the one
/// confound the ledger can actually measure, and it is the one that matters most: a "spellblade adds
/// 90 dps" that is really "you happened to be in offensive stance for those minutes" is the failure
/// mode this list exists to expose.
fn co_state_confounds(arms: &WindowArms, self_key: &str) -> Vec<String> {
    let mut keys: HashSet<&str> = HashSet::new();
    for w in arms.active.iter().chain(arms.inactive.iter()) {
        for k in &w.state_keys {
            keys.insert(k.as_str());
        }
    }
    keys.remove(self_key);
    // `[...keys].sort()` — JS's default comparator is lexicographic over UTF-16 code units, which for
    // these ASCII `<kind>:<key>` strings is byte order.
    let mut sorted: Vec<&str> = keys.into_iter().collect();
    sorted.sort_unstable();
    let mut out = Vec::new();
    for k in sorted {
        let fa = fraction_active(&arms.active, k);
        let fi = fraction_active(&arms.inactive, k);
        if (fa - fi).abs() <= CO_STATE_GAP {
            continue;
        }
        out.push(format!(
            "co-state - {k} was active in {} of active windows but {} of inactive ones",
            pct(fa),
            pct(fi)
        ));
    }
    out
}

/// True when the arms are temporally separated — every window of one precedes every window of the
/// other. Gear, level and content all drift with time, so a separated comparison is a before/after,
/// not a controlled one.
fn separated(a: &[&ProcWindow], b: &[&ProcWindow]) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let (a_min, a_max) = (
        a.iter().map(|w| w.minute).min().expect("non-empty"),
        a.iter().map(|w| w.minute).max().expect("non-empty"),
    );
    let (b_min, b_max) = (
        b.iter().map(|w| w.minute).min().expect("non-empty"),
        b.iter().map(|w| w.minute).max().expect("non-empty"),
    );
    a_max < b_min || b_max < a_min
}

/// The declared confound list. NOTHING here adjusts a number.
///
/// `zone-mix` is deliberately absent and its absence is not an oversight: the ledger lives on the
/// `Agg`, and a zone change starts a new `Agg`, so every window in a report is from ONE zone by
/// construction.
fn declare_confounds(arms: &WindowArms, self_key: &str) -> Vec<String> {
    let mut out = co_state_confounds(arms, self_key);
    if separated(&arms.active, &arms.inactive) {
        out.push(
            "not-interleaved - the two arms do not overlap in time; gear, level and content all drift with it"
                .to_string(),
        );
    }
    out.push(UNTESTED_CONFOUNDS.to_string());
    out
}

/// A Tier-A roll-up plus the states it CANNOT be told apart from.
pub struct DirectRollup {
    pub direct: DirectView,
    /// Display names of the other states the same lanes fired exclusively under. Two states switched
    /// on together own one body of evidence between them, and BOTH rows must say so.
    pub shared: Vec<String>,
}

/// One lane as the Tier-A roll-up reads it — the three fields `directFor` sums plus the links.
pub struct LaneForDirect<'a> {
    pub name: &'a str,
    pub direct_damage: i64,
    pub direct_heal: i64,
    pub dps_contribution: f64,
    pub linked: &'a [ProcLink],
}

/// THE TIER-A ROLL-UP: every lane whose link to this state came back `exclusive`.
///
/// `exclusive` is not "100% of firings were under it" — that is `concentration`, and it is worth
/// nothing on its own. It is the rate-aware gate in `link_strength`: the lane's own observed rate,
/// projected onto the swings logged WITHOUT the state, predicted at least
/// `MIN_EXPECTED_INACTIVE_PROCS` firings, and none happened. Only then is the lane's damage that
/// state's damage, exactly, with no window comparison needed at all.
///
/// `damage` / `heal` are the lane's WHOLE totals and that is not a shortcut: `without_count == 0` is
/// what `exclusive` MEANS, so every firing the lane had happened with the state on.
///
/// It remains a CO-OCCURRENCE (law 1). The log never names what fired a proc, so this measures "these
/// firings all happened with X on", never "X fired them".
pub fn direct_for(lanes: &[LaneForDirect], state_key: &str) -> Option<DirectRollup> {
    let mut d = no_direct();
    let mut shared: Vec<String> = Vec::new();
    for l in lanes {
        let link = l
            .linked
            .iter()
            .find(|k| state_key_of(k.kind, &k.key) == state_key);
        let Some(link) = link else { continue };
        if link.strength != "exclusive" {
            continue;
        }
        d.damage += l.direct_damage;
        d.heal += l.direct_heal;
        d.hits += link.with_count;
        d.dps_contribution += l.dps_contribution;
        d.lanes.push(l.name.to_string());
        for other in l.linked {
            if other.strength == "exclusive" && state_key_of(other.kind, &other.key) != state_key {
                let n = other.name.clone();
                if !shared.contains(&n) {
                    shared.push(n);
                }
            }
        }
    }
    if d.lanes.is_empty() {
        return None;
    }
    shared.sort_unstable();
    Some(DirectRollup { direct: d, shared })
}

/// The confound a shared roll-up declares. Two states committed together leave the same lane exclusive
/// to BOTH, and each row reports the full damage — so each must name the other, or two rows silently
/// claim one body of evidence twice.
fn shared_confound(shared: &[String]) -> String {
    format!(
        "co-exclusive - {} {} active for exactly the same firings; the log cannot say which state the proc belongs to",
        shared.join(", "),
        if shared.len() > 1 { "were" } else { "was" }
    )
}

/// The measured row's own note. Names the lanes so the number is auditable, and states the
/// co-occurrence limit so it cannot travel without it.
fn measured_note(d: &DirectView) -> String {
    format!(
        "{} firings of {} landed only while this state was active, for {} damage and {} healing - counted, not estimated. A co-occurrence: the log never names what fired a proc.",
        d.hits,
        d.lanes.join(", "),
        d.damage,
        d.heal
    )
}

fn short_verdict(n_a: usize, n_i: usize) -> &'static str {
    if n_a > 0 && n_i > 0 {
        "insufficient-sample"
    } else {
        "not-observable"
    }
}

/// Says WHICH arm is short and by how much — never a bare "not enough data".
fn short_note(n_a: usize, n_i: usize) -> String {
    if n_a == 0 && n_i == 0 {
        return "No minute of this session cleared the volume gates, so no comparison was attempted."
            .to_string();
    }
    if n_a == 0 {
        return format!(
            "This state was never active in an eligible minute ({n_i} inactive windows). No comparison is possible."
        );
    }
    if n_i == 0 {
        return format!(
            "This state was active in every one of the {n_a} eligible minutes. No comparison is possible - there is no control group."
        );
    }
    let short_arm = if n_a < n_i { "active" } else { "inactive" };
    let have = n_a.min(n_i);
    format!(
        "The {short_arm} arm has {have} eligible 60-second windows; {MIN_ARM_WINDOWS} are needed ({n_a} active / {n_i} inactive)."
    )
}

/// One state to attribute.
pub struct EffectInput<'a> {
    pub kind: StateKind,
    pub key: &'a str,
    pub name: &'a str,
    pub windows: &'a [&'a ProcWindow],
    /// TIER A, when a lane earned it. Present ⇒ the verdict is `measured` and no counterfactual is
    /// attempted, because none is needed.
    pub direct: Option<DirectRollup>,
}

/// One state's counterfactual verdict.
///
/// THE FOUR VERDICTS, and none may be rendered as another:
///   `estimate`            — both arms cleared `MIN_ARM_WINDOWS`; `marginal` present, confounds
///                           declared beside it, and the renderer draws it as a RANGE.
///   `insufficient-sample` — a real contrast exists (both arms have eligible windows) but at least one
///                           is short. The note says WHICH arm and by how much.
///   `not-observable`      — one arm is structurally empty: the state was on in every eligible minute,
///                           or off in every one. No comparison is possible at all. This is the RESULT,
///                           not a defect.
///   `measured`            — a state with an EXCLUSIVE proc lane behind it. An exact count, so it takes
///                           precedence over every window verdict: a measurement never yields to an
///                           estimate of the same thing.
pub fn attribute_effect(i: EffectInput) -> EffectAttribution {
    let state_key = state_key_of(i.kind, i.key);
    // The stance/invocation sentence rides the row WHATEVER the verdict is: an exclusive proc lane
    // measures that lane, and says nothing about the base-melee bonus the log never marks.
    let marker = match i.kind {
        StateKind::Stance | StateKind::Invocation => format!(" {NO_PER_HIT_MARKER_NOTE}"),
        _ => String::new(),
    };
    if let Some(rollup) = i.direct {
        let note = format!("{}{}", measured_note(&rollup.direct), marker);
        return EffectAttribution {
            kind: i.kind,
            key: i.key.to_string(),
            name: i.name.to_string(),
            direct: rollup.direct,
            verdict: "measured",
            marginal: None,
            confounds: if rollup.shared.is_empty() {
                Vec::new()
            } else {
                vec![shared_confound(&rollup.shared)]
            },
            note,
        };
    }
    let arms = partition_windows(i.windows, &state_key, &group_of(i.kind, i.key));
    let (n_a, n_i) = (arms.active.len(), arms.inactive.len());
    if n_a >= MIN_ARM_WINDOWS && n_i >= MIN_ARM_WINDOWS {
        return EffectAttribution {
            kind: i.kind,
            key: i.key.to_string(),
            name: i.name.to_string(),
            direct: no_direct(),
            verdict: "estimate",
            marginal: Some(marginal_of(&arms)),
            confounds: declare_confounds(&arms, &state_key),
            note: format!("{DIRECT_NOTE}{marker}"),
        };
    }
    EffectAttribution {
        kind: i.kind,
        key: i.key.to_string(),
        name: i.name.to_string(),
        direct: no_direct(),
        verdict: short_verdict(n_a, n_i),
        marginal: None,
        confounds: Vec::new(),
        note: format!("{} {DIRECT_NOTE}{marker}", short_note(n_a, n_i)),
    }
}

const KIND_ORDER: [StateKind; 4] = [
    StateKind::Buff,
    StateKind::Invocation,
    StateKind::Stance,
    StateKind::Coat,
];

fn kind_rank(k: StateKind) -> usize {
    KIND_ORDER
        .iter()
        .position(|&x| x == k)
        .unwrap_or(usize::MAX)
}

/// The Tier-B report for one zone session. EVERY state observed gets a row, including — and especially
/// — the ones whose honest answer is "no comparison is possible": omitting them would leave the UI
/// looking like the feature simply had nothing to say about stances, when what it has to say is that
/// the log never marks them.
pub fn build_attribution_report(
    session_id: &str,
    windows: &[&ProcWindow],
    states: &[StateSpan],
    lanes: &[LaneForDirect],
) -> AttributionReport {
    // First appearance wins, in the order the spans appear — a JS `Map`'s insertion order.
    let mut seen: JsMap<usize> = JsMap::new();
    for (i, s) in states.iter().enumerate() {
        let k = state_key_of(s.kind, &s.key);
        if !seen.contains_key(&k) {
            seen.insert(k, i);
        }
    }
    let mut effects: Vec<EffectAttribution> = seen
        .iter()
        .map(|(k, &i)| {
            let s = &states[i];
            attribute_effect(EffectInput {
                kind: s.kind,
                key: &s.key,
                name: &s.name,
                windows,
                direct: direct_for(lanes, k),
            })
        })
        .collect();
    effects.sort_by(|a, b| {
        kind_rank(a.kind)
            .cmp(&kind_rank(b.kind))
            .then_with(|| compare_names(&a.name, &b.name))
    });
    AttributionReport {
        session_id: session_id.to_string(),
        window_sec: WINDOW_MS / 1000,
        windows_total: windows.len(),
        windows_eligible: volume_eligible(windows),
        effects,
    }
}

/// The per-state firing counts one lane contributes to a link row.
pub fn links_for(
    lane: &SpellProcLane,
    states: &[StateSpan],
    swings_by_state: &JsMap<i64>,
    swings: i64,
) -> Vec<ProcLink> {
    let count = lane_count(lane);
    states
        .iter()
        .map(|s| {
            let key = state_key_of(s.kind, &s.key);
            let with_count = crate::combat::procdetect::sides_count(lane.by_state.get(&key));
            let without_count = (count - with_count).max(0);
            let active_swings = swings_by_state.get(&key).copied().unwrap_or(0);
            let inactive_swings = (swings - active_swings).max(0);
            ProcLink {
                kind: s.kind,
                key: s.key.clone(),
                name: s.name.clone(),
                with_count,
                without_count,
                concentration: concentration_of(with_count, without_count),
                inactive_swings,
                strength: link_strength(&LinkInput {
                    with_count,
                    without_count,
                    active_swings,
                    inactive_swings,
                }),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EVERY RATE IS ABSENT BELOW ITS FLOOR — `1 proc in a 2-second pull` is not `30 ppm`.
    #[test]
    fn a_rate_below_its_sample_floor_is_absent_rather_than_huge() {
        let v = proc_rate(&RateInput {
            count: 1,
            active_sec: 2.0,
            duration_sec: 2.0,
            swings: 3,
            ..RateInput::default()
        });
        assert!(v.ppm_active.is_none());
        assert!(v.ppm_wall.is_none());
        assert!(v.per100_swings.is_none());
        assert_eq!(v.count, 1);
        assert_eq!(v.swings, 3);
    }

    /// THE SOURCE WINDOW IS DECLARED EVEN WHEN IT FAILS THE FLOOR, so the absence message can quote it.
    #[test]
    fn a_short_source_window_is_stated_and_still_yields_no_rate() {
        let v = proc_rate(&RateInput {
            count: 3,
            active_sec: 600.0,
            duration_sec: 600.0,
            swings: 100,
            source: Some(ProcSourceWindow {
                active_sec: 4.0,
                name: "Neurotoxic Poison".into(),
            }),
            source_unknown: false,
        });
        assert_eq!(v.source_sec, Some(4.0));
        assert_eq!(v.source_name.as_deref(), Some("Neurotoxic Poison"));
        assert!(v.ppm_active.is_none());
        assert!(v.per100_swings.is_some());
    }

    /// CONCENTRATION ALONE NEVER REACHES `exclusive`.
    #[test]
    fn a_perfect_concentration_at_no_exposure_stays_inconclusive() {
        assert_eq!(
            link_strength(&LinkInput {
                with_count: 1_084,
                without_count: 0,
                active_swings: 261_505,
                inactive_swings: 289,
            }),
            "inconclusive"
        );
        assert_eq!(
            link_strength(&LinkInput {
                with_count: 14,
                without_count: 0,
                active_swings: 406,
                inactive_swings: 225,
            }),
            "exclusive"
        );
    }

    /// THE PURITY GATE DISCARDS THE BOUNDARY MINUTE, prefix-matched for coats.
    #[test]
    fn a_window_with_a_commit_of_the_group_is_discarded() {
        let mut w = WindowAccum::new();
        let active: HashSet<String> = ["stance:offensive".into()].into_iter().collect();
        w.fold(
            &WindowFold {
                ts: 0,
                active_delta_ms: MIN_WINDOW_ACTIVE_MS,
                swings: MIN_WINDOW_SWINGS,
                ..WindowFold::default()
            },
            &active,
        );
        let list = w.list();
        assert_eq!(
            partition_windows(&list, "stance:offensive", "stance")
                .active
                .len(),
            1
        );
        w.note_transition(0, "coat:utility", &active);
        let list = w.list();
        assert_eq!(
            partition_windows(&list, "stance:offensive", "coat:")
                .active
                .len(),
            0
        );
        assert_eq!(
            partition_windows(&list, "stance:offensive", "stance")
                .active
                .len(),
            1
        );
    }

    /// THE TYPE-7 QUANTILE, stated so the IQR is reproducible.
    #[test]
    fn the_quantile_is_linear_interpolated() {
        let s = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(quantile(&s, 0.5), 2.5);
        assert_eq!(quantile(&s, 0.25), 1.75);
        assert!(quantile(&[], 0.5) == 0.0);
    }
}
