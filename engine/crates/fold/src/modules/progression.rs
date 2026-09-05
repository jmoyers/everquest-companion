//! `src/main/modules/progression.ts` — the range-queryable time series behind the leveling
//! analytics. Experience, CREDITED kills, WITNESSED kills, loot (an activity signal), the zone
//! timeline, the offline intervals and a mirror of the level/AA series, folded into ONE columnar
//! snapshot so `shared/progressionStats.rangeStats` has a single input.
//!
//! Not part of `leveling` because the contracts differ: `LevelingSnap` is deliberately UNCAPPED,
//! while this series grows at ~1.7k rows/day and must be capped — folding a drop-oldest ring into a
//! snapshot whose contract is "everything, forever" is a semantic trap. It duplicates ~220 level/AA
//! rows on purpose and duplicates no DERIVATION.
//!
//! `killTs` holds only kills the log attributes to YOU: your own killing blow, plus a bound pet's.
//! Measured against the experience lines of the same span that is a strong correlation and never an
//! identity (a group-mate's blow still pays party exp; grey kills pay nothing). Third-party kills go
//! to `witnessTs` and enter no rate, so a busy zone cannot inflate your farming.
//!
//! Pet binding mirrors the combat engine with the one distinction a world-model-less module can
//! make: SUMMONED pets persist across zones, CHARMED pets do not, so a zone line clears only the
//! charmed set. A charmed mob also sends the pet-claim tell, so a claim for a name already charmed
//! re-arms the charm rather than being promoted — otherwise one tell would credit that mob's kills
//! to you forever, in every zone.
//!
//! The experience join looks BACKWARD, and the direction is measured: over a full-log sweep the
//! slain line nearest an experience line is the one AFTER it, at a gap of 0-1 s, and not one
//! experience line in the log follows its kill inside 4 s. So a kill takes the most recent
//! UNCLAIMED line within `KILL_EXP_JOIN_MS` before it, the claim CONSUMES the line, and every kill
//! line consumes — witnessed ones included, or a group-mate's party experience would be handed to
//! your own next kill. A kill with no line in its window carries no exp at all, which the UI states
//! as such and never as 0% (law 1).
//!
//! Offline intervals are the one column that is a derived absence rather than a log line — the
//! `offlineGap` events `fold::session` synthesizes — and they are folded VERBATIM, with no merging
//! and no inference. `rangeStats` is the single place that decides what a logout means for idle
//! time, active time and every rate.
//!
//! The TS's pending-delta twin is absent: `flush_delta` is defaulted in this crate and no caller
//! reads it, so every published field comes off the live columns. `dropped` and `windowStart` are
//! published and are kept in full.

use crate::event::Event;
use crate::jsfn::starts_with_you_word;
use crate::EqModule;
use eqlog::names::id_key;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

/// Drop-oldest caps — a retention FLOOR, not a hard length (see `TRIM_BATCH`). At these caps the
/// columnar payload is ~124k numbers plus ~4k short strings, covering roughly 24 days of heavy
/// play. Deliberately not downsampled or bucketed: a mixed-resolution store makes every range query
/// lie about its own precision. Nothing is persisted — the store is rebuilt from the log at launch.
const EXP_CAP: usize = 40_000;
const KILL_CAP: usize = 40_000;
const WITNESS_CAP: usize = 20_000;
const LOOT_CAP: usize = 20_000;
/// Zone bands are the cheapest and most valuable column — this covers months.
const ZONE_CAP: usize = 4_000;
/// Like the zone bands but rarer by orders of magnitude; it exists only so no column here can grow
/// without a stated bound.
const OFFLINE_CAP: usize = 4_000;
/// The named recent-kills ring, capped by COUNT rather than by the column policy: it is a display
/// feed for a card that renders 25 rows, so 50 is one screenful of headroom.
const RECENT_KILL_CAP: usize = 50;

/// How much slack a full column is allowed before it is trimmed back to its cap.
///
/// Trimming the front of a 40k array costs a full memmove, so trimming on every sample past the cap
/// would make a long historical replay quadratic. The consequence, and the reason the caps are a
/// retention FLOOR: a column can transiently hold up to this many entries more than its cap, and it
/// never holds fewer.
const TRIM_BATCH: usize = 1024;

/// `shared/kills.ts KILL_EXP_JOIN_MS` — how far BACK a kill may reach for its experience line.
const KILL_EXP_JOIN_MS: i64 = 2500;

/// A named row for a credited kill — a display duplicate; no statistic reads it. Public because
/// `kills.recent` is a view over this ring, and a view reads the module's own rows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressionKill {
    /// When, on the log's own clock.
    pub ts: i64,
    /// The mob's raw display name — what the deep link into the Mobs surface is built from.
    pub name: String,
    /// `0` for your own killing blow, `1` for a bound pet's.
    pub credit: i64,
    /// Raw zone name, or `''` before the first zone line — the same "unknown, never fabricated"
    /// rule the -1 zone index states in the column.
    pub zone: String,
    /// Bitfield: `1` the exp line stated no percentage, `2` it was party exp. Absent means there
    /// was no exp line at all, which is a different sentence from "an exp line that said nothing".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_flag: Option<i64>,
    /// The percentage the line stated, when it stated one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_pct: Option<f64>,
}

/// An experience line waiting to be claimed by the kill line that follows it.
#[derive(Clone, Copy)]
struct PendingExp {
    ts: i64,
    pct: Option<f64>,
    party: bool,
}

/// `ProgressionSnap` — the published columns, index-aligned in groups.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snap {
    exp_ts: Vec<i64>,
    exp_pct: Vec<f64>,
    exp_flag: Vec<i64>,
    kill_ts: Vec<i64>,
    kill_zone: Vec<i64>,
    kill_credit: Vec<i64>,
    witness_ts: Vec<i64>,
    recent_kills: Vec<ProgressionKill>,
    loot_ts: Vec<i64>,
    zone_start: Vec<i64>,
    zone_end: Vec<i64>,
    zone_name: Vec<String>,
    offline_start: Vec<i64>,
    offline_end: Vec<i64>,
    offline_camped: Vec<i64>,
    level_ts: Vec<i64>,
    level_value: Vec<i64>,
    aa_gain_ts: Vec<i64>,
    aa_gain_amount: Vec<i64>,
    last_ts: i64,
    window_start: i64,
    dropped: i64,
}

/// Cumulative drops per capped column — feeds `windowStart`.
#[derive(Default)]
struct DropFront {
    exp: i64,
    kill: i64,
    witness: i64,
    loot: i64,
    zone: i64,
    offline: i64,
}

#[derive(Default)]
pub struct ProgressionModule {
    s: Snap,
    seq: i64,
    dropped_by: DropFront,
    /// Summoned pets (pet-claim tells, never charmed). They follow you through a zone line.
    claimed: HashSet<String>,
    /// Pets bound right now by charm. Charm cannot survive a zone transition (law 4).
    charmed: HashSet<String>,
    /// Every name ever charmed this epoch — a charmed mob tells you it is your pet too, and that
    /// claim must never promote it to a zone-surviving summoned pet.
    ever_charmed: HashSet<String>,
    pending_exp: Option<PendingExp>,
    /// The announce cursor — see [`crate::announce`]. It moves on the `Snap::last_ts` advance as
    /// well as on every column push: `last_ts` is a published field that `zoneBands.ts` clamps the
    /// open zone interval's right edge to, so announcing only on rows would under-announce and a
    /// client would draw a band that stopped growing.
    ///
    /// That bump stays cheap because EQ stamps its log to the SECOND, so a busy combat second is
    /// dozens of lines and exactly one `last_ts` advance. The three pet arms, which mutate binding
    /// sets nobody can read, say nothing on their own.
    announce: crate::announce::Announce,
}

/// Drop-oldest across parallel columns that must stay index-aligned. Returns how many leading
/// entries went (0 while the column is still inside `cap + TRIM_BATCH`).
///
/// The length decision is made once here and each caller applies the same `drop` to its own
/// columns, because the borrow checker will not hand out several `&mut` fields through one slice.
fn cap_drop(cap: usize, len: usize) -> usize {
    if len < cap + TRIM_BATCH {
        0
    } else {
        len - cap
    }
}

impl ProgressionModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// The recent-kills pull seam — the ring the Overview's kill feed draws, oldest first as the
    /// module keeps it. The view reverses it; a module that reversed for a view would have an
    /// opinion about who is reading.
    #[must_use]
    pub fn recent_kills(&self) -> &[ProgressionKill] {
        &self.s.recent_kills
    }

    /// The level column — `(ts, level)` pairs, in fold order. Uncapped, because the chart needs
    /// every ding; ~5k rows a year including the AA column beside it.
    pub fn levels(&self) -> impl Iterator<Item = (i64, i64)> + '_ {
        self.s
            .level_ts
            .iter()
            .copied()
            .zip(self.s.level_value.iter().copied())
    }

    /// The AA column — `(ts, amount)` pairs, in fold order.
    pub fn aa_gains(&self) -> impl Iterator<Item = (i64, i64)> + '_ {
        self.s
            .aa_gain_ts
            .iter()
            .copied()
            .zip(self.s.aa_gain_amount.iter().copied())
    }

    /// The view layer's change signal — `foldsink::source_revision`, and deliberately NOT the
    /// announce cursor. The two answer different questions: this one decides whether a SUBSCRIPTION
    /// re-cuts a window of tens of rows on the ingest thread, and over-reports cheaply; the announce
    /// cursor decides whether a RENDERER re-fetches a snapshot and re-renders a tree. One number
    /// would tie a view's correctness to an audit done for the other reader's sake.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.seq
    }

    /// A pet addressed you as master. For a name never seen charmed this is the only binding signal
    /// a random-named SUMMONED pet gets, and summoned pets follow you across zones, so it binds
    /// permanently. For a name we HAVE seen charmed it is a charmed mob restating a relationship a
    /// zone line ends, so it re-arms the charmed set instead.
    fn on_claim(&mut self, key: String) {
        if self.ever_charmed.contains(&key) {
            self.charmed.insert(key);
        } else {
            self.claimed.insert(key);
        }
    }

    fn push_exp(&mut self, ts: i64, pct: Option<f64>, party: bool) {
        // A line that stated no pct is stored as -1 plus flag bit 1 — never 0.
        let flag = i64::from(pct.is_none()) | if party { 2 } else { 0 };
        self.s.exp_ts.push(ts);
        self.s.exp_pct.push(pct.unwrap_or(-1.0));
        self.s.exp_flag.push(flag);
        // Offer it to the kill line that follows. An unclaimed older line is simply replaced: two
        // experience lines with no kill between them means the first one's kill never printed, and
        // a stale line handed to a later kill is a fabricated attribution.
        self.pending_exp = Some(PendingExp { ts, pct, party });
        self.trim();
        self.announce.changed(self.seq);
    }

    /// The experience line this kill line claims, or `None`. Claiming CONSUMES it.
    fn take_exp(&mut self, ts: i64) -> Option<PendingExp> {
        let p = self.pending_exp.take()?;
        if ts < p.ts || ts - p.ts > KILL_EXP_JOIN_MS {
            return None;
        }
        Some(p)
    }

    /// Self kill / bound-pet kill (credited) vs everybody else's (witnessed).
    fn on_death(&mut self, ev: &Event) {
        let ts = ev.ts();
        let exp = self.take_exp(ts);
        let name = ev.str("name").unwrap_or_default().to_string();
        if ev.bool("bySelf") {
            self.push_kill(ts, 0, &name, exp);
            return;
        }
        // `X has been slain by You` is the third-person twin of the self shape, so counting it
        // would double every one of your own kills (`reducers.ts isCountedKill`, same rule).
        let killer = ev.str("killer").unwrap_or_default();
        if killer.is_empty() || starts_with_you_word(killer) {
            return;
        }
        let k = id_key(killer);
        if self.claimed.contains(&k) || self.charmed.contains(&k) {
            self.push_kill(ts, 1, &name, exp);
            return;
        }
        self.s.witness_ts.push(ts);
        self.trim();
        self.announce.changed(self.seq);
    }

    fn push_kill(&mut self, ts: i64, credit: i64, name: &str, exp: Option<PendingExp>) {
        // -1 before the first zone line: unknown zone, never a fabricated one.
        let zone = self.s.zone_start.len() as i64 - 1;
        self.s.kill_ts.push(ts);
        self.s.kill_zone.push(zone);
        self.s.kill_credit.push(credit);
        self.push_kill_row(ts, credit, name, exp);
        self.trim();
        self.announce.changed(self.seq);
    }

    fn push_kill_row(&mut self, ts: i64, credit: i64, name: &str, exp: Option<PendingExp>) {
        let mut row = ProgressionKill {
            ts,
            name: name.to_string(),
            credit,
            zone: self.s.zone_name.last().cloned().unwrap_or_default(),
            exp_flag: None,
            exp_pct: None,
        };
        if let Some(e) = exp {
            row.exp_flag = Some(i64::from(e.pct.is_none()) | if e.party { 2 } else { 0 });
            row.exp_pct = e.pct;
        }
        self.s.recent_kills.push(row);
        // Drop-oldest by COUNT, exactly — a 50-entry splice needs no TRIM_BATCH slack — and
        // deliberately outside the trim path: this ring's churn must not move `dropped`.
        if self.s.recent_kills.len() > RECENT_KILL_CAP {
            let over = self.s.recent_kills.len() - RECENT_KILL_CAP;
            self.s.recent_kills.drain(0..over);
        }
    }

    /// A derived absence: the character was out of the world between two known instants. Both edges
    /// arrive stated (the detector emits the gap at the login line that ended it), so this is a
    /// plain append and there is no open-ended offline interval. Non-positive spans are dropped —
    /// an interval covering no time is not evidence of anything.
    ///
    /// Note what is deliberately not done here: no zone interval is closed and no idle bookkeeping
    /// happens. The columns stay a record of what the log said.
    fn push_offline(&mut self, from_ts: i64, to_ts: i64, camped: bool) {
        if to_ts <= from_ts {
            return;
        }
        self.s.offline_start.push(from_ts);
        self.s.offline_end.push(to_ts);
        self.s.offline_camped.push(i64::from(camped));
        self.trim();
        self.announce.changed(self.seq);
    }

    /// Close the open interval at the new zone's start, then open the next one.
    fn on_zone(&mut self, ts: i64, zone: &str) {
        let n = self.s.zone_start.len();
        if n > 0 && self.s.zone_end[n - 1] == 0 {
            self.s.zone_end[n - 1] = ts;
        }
        self.s.zone_start.push(ts);
        self.s.zone_end.push(0);
        self.s.zone_name.push(zone.to_string());
        // Charm cannot survive a zone transition; a summoned pet does (law 4).
        self.charmed.clear();
        self.trim();
        self.announce.changed(self.seq);
    }

    /// Enforce every cap, then re-derive the retention floor.
    fn trim(&mut self) {
        let n = cap_drop(EXP_CAP, self.s.exp_ts.len());
        if n > 0 {
            self.s.exp_ts.drain(0..n);
            self.s.exp_pct.drain(0..n);
            self.s.exp_flag.drain(0..n);
            self.dropped_by.exp += n as i64;
            self.s.dropped += n as i64;
        }
        let n = cap_drop(KILL_CAP, self.s.kill_ts.len());
        if n > 0 {
            self.s.kill_ts.drain(0..n);
            self.s.kill_zone.drain(0..n);
            self.s.kill_credit.drain(0..n);
            self.dropped_by.kill += n as i64;
            self.s.dropped += n as i64;
        }
        let n = cap_drop(WITNESS_CAP, self.s.witness_ts.len());
        if n > 0 {
            self.s.witness_ts.drain(0..n);
            self.dropped_by.witness += n as i64;
            self.s.dropped += n as i64;
        }
        let n = cap_drop(LOOT_CAP, self.s.loot_ts.len());
        if n > 0 {
            self.s.loot_ts.drain(0..n);
            self.dropped_by.loot += n as i64;
            self.s.dropped += n as i64;
        }
        let n = cap_drop(ZONE_CAP, self.s.zone_start.len());
        if n > 0 {
            self.s.zone_start.drain(0..n);
            self.s.zone_end.drain(0..n);
            self.s.zone_name.drain(0..n);
            // `killZone` is an index into `zoneName`, so a front-drop shifts every one of them. A
            // kill whose zone aged out becomes -1 (unknown), never a WRONG zone.
            let drop = n as i64;
            for z in &mut self.s.kill_zone {
                *z = (*z - drop).max(-1);
            }
            self.dropped_by.zone += drop;
            self.s.dropped += drop;
        }
        let n = cap_drop(OFFLINE_CAP, self.s.offline_start.len());
        if n > 0 {
            self.s.offline_start.drain(0..n);
            self.s.offline_end.drain(0..n);
            self.s.offline_camped.drain(0..n);
            self.dropped_by.offline += n as i64;
            self.s.dropped += n as i64;
        }
        self.recompute_window();
    }

    /// The retention floor: 0 while nothing has aged out, else the max first-timestamp across the
    /// columns that HAVE dropped. Below that instant the record is partial and any rate over it
    /// would silently under-count; `clipped` is exactly "the selection reaches below this".
    fn recompute_window(&mut self) {
        let mut w = 0;
        let pairs: [(i64, Option<i64>); 6] = [
            (self.dropped_by.exp, self.s.exp_ts.first().copied()),
            (self.dropped_by.kill, self.s.kill_ts.first().copied()),
            (self.dropped_by.witness, self.s.witness_ts.first().copied()),
            (self.dropped_by.loot, self.s.loot_ts.first().copied()),
            (self.dropped_by.zone, self.s.zone_start.first().copied()),
            (
                self.dropped_by.offline,
                self.s.offline_start.first().copied(),
            ),
        ];
        for (dropped, first) in pairs {
            if dropped > 0 {
                if let Some(f) = first {
                    w = w.max(f);
                }
            }
        }
        self.s.window_start = w;
    }

    fn clear(&mut self) {
        self.s = Snap::default();
        self.dropped_by = DropFront::default();
        self.claimed.clear();
        self.charmed.clear();
        self.ever_charmed.clear();
        self.pending_exp = None;
    }

    fn fold(&mut self, ev: &Event) {
        match ev.kind() {
            "expGain" => self.push_exp(ev.ts(), ev.f64("pct"), ev.bool("party")),
            "death" => self.on_death(ev),
            "zone" => self.on_zone(ev.ts(), ev.str("zone").unwrap_or_default()),
            "offlineGap" => self.push_offline(
                ev.int("fromTs").unwrap_or(0),
                ev.int("toTs").unwrap_or(0),
                ev.bool("camped"),
            ),
            "loot" => {
                // A destroy counts here: `lootTs` is timestamps only, an ACTIVITY signal for the
                // idle heuristic and the zone bands, never a drop count. Emptying your bags is you
                // at the keyboard, so excluding it would manufacture idle time out of real play.
                self.s.loot_ts.push(ev.ts());
                self.trim();
                self.announce.changed(self.seq);
            }
            "level" => {
                // Uncapped (with aaGain): ~5k rows/year, and the chart needs every ding.
                self.s.level_ts.push(ev.ts());
                self.s.level_value.push(ev.int("level").unwrap_or(0));
                self.announce.changed(self.seq);
            }
            "aaGain" => {
                self.s.aa_gain_ts.push(ev.ts());
                self.s.aa_gain_amount.push(ev.int("amount").unwrap_or(0));
                self.announce.changed(self.seq);
            }
            // The three pet arms publish nothing: they move the claimed/charmed/ever-charmed sets,
            // which decide whether a LATER kill is credited or witnessed and appear in no snapshot.
            "petClaim" => self.on_claim(id_key(ev.str("name").unwrap_or_default())),
            "charm" => {
                let key = id_key(ev.str("mob").unwrap_or_default());
                self.charmed.insert(key.clone());
                self.ever_charmed.insert(key);
            }
            "uncharm" => {
                self.charmed
                    .remove(&id_key(ev.str("mob").unwrap_or_default()));
            }
            _ => {}
        }
    }
}

impl EqModule for ProgressionModule {
    fn id(&self) -> &'static str {
        "progression"
    }

    fn reset(&mut self) {
        self.clear();
        self.seq = 0;
        self.announce.reset();
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        // Character rebirth: everything before the boundary belongs to a dead same-name character
        // and would contaminate every rate. Note the early return — `lastTs` is not advanced by
        // the boundary event itself.
        if ev.kind() == "epoch" {
            self.clear();
            self.announce.changed(self.seq);
            return;
        }
        if ev.ts() > self.s.last_ts {
            self.s.last_ts = ev.ts();
            // A published field moved — see the `announce` field for why this bump is owed. Every
            // column push below bumps for itself.
            self.announce.changed(self.seq);
        }
        self.fold(ev);
    }

    /// Moves on a column push, a rebirth, or the log's clock advancing. See the `announce` field.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.s })
    }

    /// The view pull seam. See `EqModule::as_progression`.
    fn as_progression(&self) -> Option<&ProgressionModule> {
        Some(self)
    }
}
