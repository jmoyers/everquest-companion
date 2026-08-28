//! The crowd-control half of the buffs/debuffs timer overlay: per-target holds keyed by mob, so one
//! AE mez landing on four enemies is four named rows with four independent clocks.
//!
//! It is a separate module only because of what `buffs.rs` cannot see. `<mob> has been mesmerized.`
//! is claimed by the CC classifier, which sits ABOVE the DB matcher in the parser's cascade, so it
//! never becomes a `buffApply` and never becomes an instance. Everything else — the cast anchors,
//! the learner, the count-and-close rule — is HANDED to this module by the wiring rather than
//! duplicated, because a second fold of the same events is how two halves drift apart.
//!
//! Its published `seq` is a private REVISION COUNTER, not the last event's. Readers dedupe with
//! `seq <= known`, and `on_tick` expires holds while the log is idle — which is exactly when
//! somebody is watching a mez run out — so a delta advancing no log seq would be dropped as a
//! duplicate and the row would sit on screen forever. Every `rev += 1` here is a published number.
//!
//! An offline gap is an explicit no-op. Everything held here is on somebody else, and the world
//! those mobs stand in does not stop when you camp, so their landings stay where they are. It is
//! written out rather than left as an absent case because the asymmetry with `buffs.rs` looks like
//! an oversight from inside this file. The early return also keeps the derived event out of
//! `last_event_ts`, which the primary `sessionStart` it restates already recorded.

use crate::event::{Event, Key, Kind};
use crate::jsmap::JsMap;
use crate::modules::buff_anchors::Attribution;
use crate::modules::buff_landing::stated_duration;
use crate::modules::buff_landing::Candidate;
use crate::modules::buff_rounds::HoldGroup;
use crate::modules::buffs::SharedCore;
use crate::modules::buffs_shapes::{
    learning_record_cap_ms, spell_key, unwitnessed_timeout_ms, EstimatorSource, MAX_SAMPLE_MS,
    SELF_CASTER, SESSION_GAP_MS,
};
use crate::EqModule;
use eqlog::names::id_key;
use serde::Serialize;
use serde_json::{json, Value};
use std::rc::Rc;

/// How long an END is remembered — long enough for the projection to retire a matching active buff
/// the buffs model never clears, and for the overlay to flash a drop. It is not a history.
pub const CC_END_MEMORY_MS: i64 = 60_000;

/// How close a `<mob> has been awakened by <name>.` line must land to a mint to be about it.
///
/// One second, because EQ stamps are second-resolution and the pair is always inside one stamp.
/// Measured over the owner's whole log: of 1,518 wake lines, 1,472 share the exact second of that
/// mob's own wear-off, and in every one of those the wear-off comes first.
pub const WAKE_CENSOR_MS: i64 = 1_000;

/// The bound on a hold whose duration nobody states: the longest stated CC duration in the committed
/// spells.json (660 s, Ensnare). Past the longest hold the game's own data describes, a missing break
/// line is evidence we lost the thread rather than evidence the mob is still held.
pub const CC_UNKNOWN_CAP_MS: i64 = 660_000;

/// The three landing verbs whose hold ANY damage breaks — the holds a corpse cannot be about.
///
/// A mesmerized mob cannot be killed while mesmerized: the first point of damage wakes it and the
/// log says so before the corpse appears. So a mez that is killed is one whose break line already
/// closed the landing, and a death arriving while the hold stands is about another mob of that name.
///
/// `ensnared` is deliberately not a member: a snare does nothing to stop you killing what it is on,
/// so a corpse genuinely is that hold ending. Charm is the same from the other side and reaches this
/// module with no verb at all.
fn damage_breaks(verb: &str) -> bool {
    matches!(verb, "mesmerized" | "enthralled" | "entranced")
}

/// What the anchors made of one landing: the spell, whose it is, and what it can be learned from.
struct CcIdentity {
    resolved: bool,
    /// The rank-stripped LINE, or `""` for a family the anchors could not narrow.
    line_key: String,
    /// The RANKED display name from the cast line. Empty alongside an empty `line_key`.
    display: String,
    caster: String,
    /// Two ranks of this line were in flight at once, so no sample may be minted.
    rank_changed: bool,
}

/// The landings of one (spell line, mob name), plus the bookkeeping the snapshot does not carry.
/// One of these is one row.
struct Held {
    /// Canonical mob key — the entity half of the identity.
    entity_key: String,
    /// The mob's display name, raw from the log.
    target: String,
    /// The rank-stripped spell LINE, when the anchor resolved one. Empty for a family row.
    line_key: String,
    /// The RANKED display name from the cast line, when one resolved.
    spell: Option<String>,
    candidates: Vec<String>,
    /// Whose cast: 'self' or an allowlisted external.
    caster: String,
    duration_ms: Option<i64>,
    source: Option<EstimatorSource>,
    /// True when the landing sentence was one of the damage-breaking verbs — a hold whose mob cannot
    /// be damaged without waking it, so no death line may close a landing of this row.
    mez: bool,
    group: HoldGroup,
}

/// A culled landing the model still remembers, so a late break line can be measured against it.
///
/// It breaks a trap: a sample can only be minted through a LIVE hold, and a hold is culled at
/// estimate + grace, so once a run of break-shortened cycles drags the learned number below the real
/// duration every full-length hold is culled BEFORE its wear-off arrives and the estimate can never
/// climb back out.
///
/// It is a MEMORY, not a hold. The row still dies on schedule: nothing comes back on screen, no
/// `ends` entry is invented, and the projection sees what it saw before. All that survives the cull
/// is the landing's start time and its `clean` flag. The join window is DB-floor-scale on purpose —
/// remembering for the culled schedule would be circular, since that schedule is the underestimate.
struct LateJoin {
    entity_key: String,
    caster: String,
    /// The ranked display name, for the sample's label.
    spell: String,
    /// When the landing happened. The span a late break measures is `break_ts - started_ts`.
    started_ts: i64,
    /// The last event ts at which this memory may still be joined.
    joinable_until: i64,
}

/// One sample this module just minted, kept only long enough for a wake line to annotate it.
struct RecentMint {
    entity_key: String,
    line_key: String,
    caster: String,
    ts: i64,
}

/// The row the snapshot publishes. Every optional is skipped when absent, which the goldens pin.
/// Public because `buff_timer_rows` folds these with `buffs.active` into the timer windows' rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcHold {
    /// The held entity's canonical key.
    pub key: String,
    /// Its display name.
    pub target: String,
    /// When the hold landed. The OLDEST of them when `count` is 2+.
    pub started_ts: i64,
    /// The resolved spell, when the model narrowed the landing sentence to one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spell: Option<String>,
    /// Every spell the sentence could have been. Empty once `spell` is known.
    pub candidates: Vec<String>,
    /// The estimator's duration, or `None` for a hold that counts up.
    pub duration_ms: Option<i64>,
    /// Where that duration came from. Read by the Buffs tab, never by the bars.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<EstimatorSource>,
    /// How many entities of this display name are held. Absent for the ordinary one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    /// The allowlisted external who cast it; absent for your own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caster: Option<String>,
}

/// One recorded END of a hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcEnd {
    /// The entity whose hold ended.
    pub key: String,
    /// When, on the log's own clock.
    pub ts: i64,
    /// Which spell, when the break line named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spell: Option<String>,
}

pub struct BuffTimersModule {
    core: SharedCore,
    holds: JsMap<Held>,
    ends: Vec<CcEnd>,
    /// Culled landings a late break line may still be measured against.
    culled: JsMap<LateJoin>,
    /// Samples minted within the last [`WAKE_CENSOR_MS`], awaiting a possible wake annotation.
    recent_mints: Vec<RecentMint>,
    last_event_ts: i64,
    /// Our own revision, not the last event's seq — see the module header.
    rev: i64,
}

impl BuffTimersModule {
    pub fn new(core: SharedCore) -> Self {
        BuffTimersModule {
            core,
            holds: JsMap::new(),
            ends: Vec::new(),
            culled: JsMap::new(),
            recent_mints: Vec::new(),
            last_event_ts: 0,
            rev: 0,
        }
    }

    /// A fresh `<mob> has been mesmerized|enthralled|entranced|ensnared.`
    ///
    /// The anchor gate: the sentence is a broadcast naming no caster, so a hold opens only when a
    /// cast line anchors it — the player's own, or an allowlisted external's. Without it a crowded
    /// zone fills this overlay with other enchanters' work.
    ///
    /// The narrowing: the parser hands over every spell the sentence could be and the MODEL resolves
    /// against the anchors. Exactly one anchored candidate means that spell, by its ranked name.
    /// More than one, or none, leaves the row a FAMILY, stating a duration only if every candidate
    /// agrees on one.
    fn apply(&mut self, mob: &str, ts: i64, verb: Option<&str>, cands: &[Candidate]) {
        let core_rc = Rc::clone(&self.core);
        let core = core_rc.borrow();
        // No candidates, or no anchored cast, means we cannot tell our own mez from a stranger's.
        // A Quick Buff burst is deliberately NOT an anchor here: it names no spell, and every
        // member of the crowd-control roster is a targeted cast with a cast line of its own.
        let own: Vec<Candidate> = cands
            .iter()
            .filter(|c| core.anchors.named_anchor_for(&c.name, ts).is_some())
            .cloned()
            .collect();
        if own.is_empty() {
            return;
        }
        let id = self.resolve_cc(&own, ts, &core);
        drop(core);
        // A fresh landing retires the memory of the old one: the next break sentence on this name
        // belongs to the live hold rather than to a landing the cull already gave up on.
        if !id.line_key.is_empty() {
            self.culled
                .remove(&format!("{}|{}", id_key(mob), id.line_key));
        }
        let key = self.ensure_hold(mob, &id, cands, &own);
        // The row remembers the strongest thing any of its landings said (`mez` never goes back to
        // false): if one sentence in this family stated a hold damage breaks, a corpse cannot be it.
        if verb.is_some_and(damage_breaks) {
            self.holds.get_mut(&key).expect("just ensured").mez = true;
            // A RESOLVED one also says the mob's other mez just ended. Only resolved: a family row
            // cannot name the line it would be overwriting, and "some mez landed" is not evidence
            // that a different one did.
            if !id.line_key.is_empty() {
                self.retire_overwritten(&key, ts);
            }
        }

        let mut core = core_rc.borrow_mut();
        // The Buffs tab lists every line the model has knowledge about, and a mez is one of them.
        if !id.line_key.is_empty() {
            core.stats.note_ever_faded(&id.line_key);
            core.stats.touch_last_seen(&id.line_key, ts);
            // The rank this cast named is the tab's too, recorded HERE because the cast line is the
            // only line in a mez's family carrying the numeral and a broken cycle mints nothing to
            // carry it.
            core.stats
                .note_display_name(&id.line_key, &id.caster, &id.display);
            self.holds.get_mut(&key).expect("held").spell = Some(id.display.clone());
        }

        // The duration the bar draws. Resolved: the shared estimator keyed on (line, caster).
        // Unresolved: the DB agreement rule alone, since there is no line to look a value up under.
        let est = if id.line_key.is_empty() {
            (stated_duration(&own), None)
        } else {
            let e = core.stats.estimate_for(&id.line_key, &id.caster);
            (e.ms, e.source)
        };
        drop(core);
        {
            let held = self.holds.get_mut(&key).expect("held");
            held.duration_ms = est.0;
            held.source = est.1;
            // A family, or a cast window holding two ranks of one line, can never say what it
            // measured.
            held.group
                .land(ts, id.line_key.is_empty() || id.rank_changed);
        }
        self.rev += 1;
    }

    /// Which spell (and whose) this landing is, from the anchored candidates. One anchored candidate
    /// resolves it outright; several are narrowed by the nearest completed cast; only a genuine tie
    /// leaves an empty `line_key`, this file's spelling of "a family, not a name".
    fn resolve_cc(
        &self,
        own: &[Candidate],
        ts: i64,
        core: &crate::modules::buffs::BuffsCore,
    ) -> CcIdentity {
        // The nearest completed cast wins. Casting is SERIAL — the game will not begin a second cast
        // while one is in flight, and a cast that dies retracts its own anchor — so the newest
        // anchor at or before a landing is the cast that just completed, and every older one in the
        // window has already had its own landing sentence printed.
        //
        // A tie stays a FAMILY: two different spells anchored at the same ts means the log printed
        // both cast lines in one second, which recency cannot separate.
        let mut best: Option<(&Candidate, Attribution)> = None;
        let mut tied = false;
        for cand in own {
            let Some(anchor) = core.anchors.named_anchor_for(&cand.name, ts) else {
                continue;
            };
            match &best {
                None => {
                    best = Some((cand, anchor));
                    tied = false;
                }
                Some((_, b)) if anchor.ts > b.ts => {
                    best = Some((cand, anchor));
                    tied = false;
                }
                Some((_, b)) if anchor.ts == b.ts => tied = true,
                _ => {}
            }
        }
        match (tied, best) {
            (false, Some((cand, anchor))) => CcIdentity {
                resolved: true,
                line_key: spell_key(&cand.name),
                display: anchor.display.unwrap_or_else(|| cand.name.clone()),
                caster: anchor.caster,
                rank_changed: anchor.rank_changed,
            },
            _ => CcIdentity {
                resolved: false,
                line_key: String::new(),
                display: String::new(),
                caster: SELF_CASTER.to_string(),
                rank_changed: false,
            },
        }
    }

    /// A new mez on a mob retires the old one.
    ///
    /// EQ prints nothing when one mez-line spell replaces another on the same mob — no wear-off, no
    /// `awakened`, no notice of any kind — so the landing sentence is the only evidence there is,
    /// and it is enough: a mob holds ONE mez, so a mez-verb landing that resolved to a different
    /// line is that mob's previous mez ending.
    ///
    /// It closes one landing and contaminates the rest, as a death does to a snare row: a name is a
    /// name, so an overwrite cannot say which of the mobs we hold was re-mezzed. Oldest-first is
    /// also the one closest to expiring, which is the one a chain-mezzer re-mezzes on purpose.
    ///
    /// Nothing is learned from it and it records no `CcEnd`: the ends ledger exists to retire an
    /// active buff the buffs model never clears, and a hold carrying a mez verb can never have one,
    /// because those sentences are claimed above the DB matcher and never become `buffApply`.
    fn retire_overwritten(&mut self, landed_key: &str, ts: i64) {
        let landed_entity = self.holds.get(landed_key).expect("held").entity_key.clone();
        let victims: Vec<String> = self
            .holds
            .iter()
            .filter(|(k, h)| *k != landed_key && h.entity_key == landed_entity && h.mez)
            .map(|(k, _)| k.to_string())
            .collect();
        for key in victims {
            let (empty, memory) = {
                let held = self.holds.get_mut(&key).expect("named above");
                held.group.contaminate_all();
                held.group.close_oldest(ts);
                (
                    held.group.is_empty(),
                    format!("{}|{}", held.entity_key, held.line_key),
                )
            };
            self.culled.remove(&memory);
            if empty {
                self.holds.remove(&key);
            }
        }
    }

    /// The (mob, line) hold this landing belongs to, created on first sight.
    fn ensure_hold(
        &mut self,
        mob: &str,
        id: &CcIdentity,
        cands: &[Candidate],
        own: &[Candidate],
    ) -> String {
        let shown = sorted_names(cands);
        let key = format!(
            "{}|{}",
            id_key(mob),
            if id.line_key.is_empty() {
                shown.join("+").to_lowercase()
            } else {
                id.line_key.clone()
            }
        );
        if let Some(existing) = self.holds.get_mut(&key) {
            existing.target = mob.to_string();
            existing.caster = id.caster.clone();
            return key;
        }
        self.holds.insert(
            key.clone(),
            Held {
                entity_key: id_key(mob),
                target: mob.to_string(),
                line_key: id.line_key.clone(),
                spell: None,
                candidates: if id.resolved {
                    shown
                } else {
                    sorted_names(own)
                },
                caster: id.caster.clone(),
                duration_ms: None,
                source: None,
                mez: false,
                // Never a singleton: a mob is a NAME the world hands out more than once, and no
                // line separates two of them.
                group: HoldGroup::new(false),
            },
        );
        key
    }

    /// A break line said one of these ended — a mez/root wear-off, or a charm break.
    ///
    /// It closes the OLDEST landing of that (mob, spell) and mints a duration sample when that
    /// landing was a clean cycle. The row survives with one fewer on its count chip; only an empty
    /// group removes it.
    ///
    /// A death does not come here: it names a mob that stopped existing rather than a hold that
    /// ended.
    fn end(&mut self, entity_key: &str, ts: i64, spell: Option<&str>) {
        let line = spell.map(spell_key);
        let closed_any = self.close_live(entity_key, line.as_deref(), ts);
        // The late join runs only when nothing live was closed — a live hold is always the better
        // answer — and only for a break line that NAMES its spell, because a landing has to be
        // identified to be measured.
        if !closed_any {
            if let Some(line) = &line {
                self.late_join(entity_key, line, ts);
            }
        }
        // Recorded even when we held nothing: the projection uses it to retire an active buff the
        // buffs model does not clear, which can exist without a hold beside it.
        self.ends.push(CcEnd {
            key: entity_key.to_string(),
            ts,
            spell: spell.map(str::to_string),
        });
        self.rev += 1;
    }

    /// Close the LIVE holds this ending applies to. Returns whether it found any, which is what
    /// decides between the ordinary path and the late join.
    fn close_live(&mut self, entity_key: &str, line: Option<&str>, ts: i64) -> bool {
        let mut closed_any = false;
        let keys: Vec<String> = self.holds.iter().map(|(k, _)| k.to_string()).collect();
        for key in keys {
            let Some(held) = self.holds.get(&key) else {
                continue;
            };
            if held.entity_key != entity_key {
                continue;
            }
            // A named break line closes only the matching LINE; an anonymous one (a charm break with
            // no spell on it) closes every hold on that mob.
            if let Some(line) = line {
                if !held.line_key.is_empty() && held.line_key != line {
                    continue;
                }
            }
            self.close_one(&key, ts);
            closed_any = true;
            if self.holds.get(&key).is_some_and(|h| h.group.is_empty()) {
                self.holds.remove(&key);
            }
            self.rev += 1;
        }
        closed_any
    }

    /// Close this hold's OLDEST landing, minting a sample when that landing was a clean cycle. Only
    /// a break line reaches here.
    fn close_one(&mut self, key: &str, ts: i64) {
        let Some(held) = self.holds.get_mut(key) else {
            return;
        };
        let closed = held.group.close_oldest(ts);
        let Some(sample) = closed.and_then(|c| c.sample_ms) else {
            return;
        };
        if sample <= 0 || sample > MAX_SAMPLE_MS {
            return;
        }
        let held = self.holds.get(key).expect("present");
        let display = held
            .spell
            .clone()
            .or_else(|| held.candidates.first().cloned())
            .unwrap_or_else(|| held.line_key.clone());
        let at = RecentMint {
            entity_key: held.entity_key.clone(),
            line_key: held.line_key.clone(),
            caster: held.caster.clone(),
            ts,
        };
        self.mint_sample(at, display, sample, false);
    }

    /// Record one duration sample and re-read every bar it could move.
    ///
    /// The mint is remembered for [`WAKE_CENSOR_MS`] so the wake line that follows a break can find
    /// the sample it explains. It is a method rather than two lines inside `close_one` because the
    /// late-join path mints too, and both have to be annotatable or the censoring would depend on
    /// which route the sample took.
    fn mint_sample(&mut self, at: RecentMint, display: String, sample_ms: i64, _late: bool) {
        {
            let core_rc = Rc::clone(&self.core);
            let mut core = core_rc.borrow_mut();
            core.stats.push_sample(
                &at.line_key,
                &at.caster,
                &display,
                crate::modules::buffs_shapes::DurationSample {
                    ms: sample_ms,
                    ts: at.ts,
                    censored: false,
                    death_bound: false,
                },
            );
        }
        let (line_key, caster) = (at.line_key.clone(), at.caster.clone());
        self.recent_mints.push(at);
        // Re-read the estimate for every live hold of this line: a sample that just beat the DB
        // floor must move the bars that are still counting, not only the next cast's.
        self.restat_line(&line_key, &caster);
    }

    /// A break line for a mob whose hold the cull already took — measure it against the landing this
    /// module still remembers.
    ///
    /// It mints through the same cleanliness rules and adds none of its own: only a landing that was
    /// `clean` when culled is remembered at all. The memory is CONSUMED whether or not the span
    /// turns out usable, because a second break sentence for the same landing is not a second
    /// observation of it.
    fn late_join(&mut self, entity_key: &str, line_key: &str, ts: i64) {
        let key = format!("{entity_key}|{line_key}");
        let Some(mem) = self.culled.get(&key) else {
            return;
        };
        let (joinable_until, started_ts, caster, spell) = (
            mem.joinable_until,
            mem.started_ts,
            mem.caster.clone(),
            mem.spell.clone(),
        );
        self.culled.remove(&key);
        if ts > joinable_until {
            return;
        }
        let span = ts - started_ts;
        if span <= 0 || span > MAX_SAMPLE_MS {
            return;
        }
        self.mint_sample(
            RecentMint {
                entity_key: entity_key.to_string(),
                line_key: line_key.to_string(),
                caster,
                ts,
            },
            spell,
            span,
            true,
        );
    }

    /// A mob of this name died, and "which one?" is answered per hold.
    ///
    /// The landing VERB decides. A mez is protected — see [`damage_breaks`] — so a corpse sharing
    /// its name cannot close it. A snare or a charm has no such protection and a corpse genuinely
    /// does end it, so those keep the count-chip rule: one landing closes, the oldest, and only an
    /// empty group removes the row.
    ///
    /// A death still does two things to a mez row: it CONTAMINATES the whole group (the group has
    /// lost track of which mob of that name is which) and it forgets the culled memories for that
    /// name.
    ///
    /// It records no `CcEnd`. An end with no spell on it matches every active buff on that entity in
    /// the projection, so a death that closed a snare would blank a slow row the buffs model had
    /// deliberately kept standing.
    fn on_mob_death(&mut self, entity_key: &str, ts: i64) {
        let mut changed = false;
        let keys: Vec<String> = self.holds.iter().map(|(k, _)| k.to_string()).collect();
        for key in keys {
            let Some(held) = self.holds.get_mut(&key) else {
                continue;
            };
            if held.entity_key != entity_key {
                continue;
            }
            held.group.contaminate_all();
            if held.mez {
                continue;
            }
            held.group.close_oldest(ts);
            if held.group.is_empty() {
                self.holds.remove(&key);
            }
            changed = true;
        }
        self.forget_culled(entity_key);
        if changed {
            self.rev += 1;
        }
    }

    /// Every remembered landing on one mob is forgotten (a death, and nothing else calls it).
    fn forget_culled(&mut self, entity_key: &str) {
        let dead: Vec<String> = self
            .culled
            .iter()
            .filter(|(_, m)| m.entity_key == entity_key)
            .map(|(k, _)| k.to_string())
            .collect();
        for k in dead {
            self.culled.remove(&k);
        }
    }

    /// `<mob> has been awakened by <name>.` — mark whatever this mob's break just minted as censored.
    ///
    /// It ends nothing: the wear-off line preceding it in the same second already did, and closing a
    /// second landing here would delete a hold on another mob of that name. Nothing displays
    /// differently either, since the estimate is a MAX over both sample windows. What changes is
    /// that a censored sample can no longer evict a full-length one.
    fn censor_wake(&mut self, entity_key: &str, ts: i64) {
        let candidates: Vec<(String, String, i64)> = self
            .recent_mints
            .iter()
            .filter(|m| m.entity_key == entity_key && ts - m.ts <= WAKE_CENSOR_MS && ts >= m.ts)
            .map(|m| (m.line_key.clone(), m.caster.clone(), m.ts))
            .collect();
        for (line_key, caster, at) in candidates {
            let censored = {
                let core_rc = Rc::clone(&self.core);
                let mut core = core_rc.borrow_mut();
                core.stats.censor_sample_at(&line_key, &caster, at)
            };
            if !censored {
                continue;
            }
            self.restat_line(&line_key, &caster);
            self.rev += 1;
        }
    }

    /// Re-read the estimator for every live hold of one (line, caster) after a sample landed.
    fn restat_line(&mut self, line_key: &str, caster: &str) {
        if line_key.is_empty() {
            return;
        }
        let est = {
            let core_rc = Rc::clone(&self.core);
            let core = core_rc.borrow();
            core.stats.estimate_for(line_key, caster)
        };
        for held in self.holds.values_mut() {
            if held.line_key == line_key && held.caster == caster {
                held.duration_ms = est.ms;
                held.source = est.source;
            }
        }
    }

    /// Drop landings nothing ended and ends nobody needs any more.
    fn sweep(&mut self, now_ms: i64) {
        let keys: Vec<String> = self.holds.iter().map(|(k, _)| k.to_string()).collect();
        for key in keys {
            // The unwitnessed-expiry cull: a hold whose countdown ran out and whose break line never
            // arrived (you died, you zoned, the mob wandered off) is dropped rather than left
            // squatting at 0 s. It mints nothing and records no end, because nothing was observed.
            let (life, dropped) = {
                let Some(held) = self.holds.get_mut(&key) else {
                    continue;
                };
                let life = match held.duration_ms {
                    Some(ms) => ms + unwitnessed_timeout_ms(held.source),
                    None => CC_UNKNOWN_CAP_MS,
                };
                (life, held.group.drop_expired(now_ms - life))
            };
            if !dropped.is_empty() {
                self.remember(&key, &dropped, life);
                self.rev += 1;
            }
            if self.holds.get(&key).is_some_and(|h| h.group.is_empty()) {
                self.holds.remove(&key);
            }
        }
        self.sweep_memories(now_ms);
        if !self.ends.is_empty() {
            let before = self.ends.len();
            self.ends.retain(|e| now_ms - e.ts <= CC_END_MEMORY_MS);
            if self.ends.len() != before {
                self.rev += 1;
            }
        }
    }

    /// File the CLEAN landings a cull just dropped, so a late break line can still find them.
    ///
    /// Only clean ones: a contaminated landing could not have minted on the live path either.
    /// `line_key` is necessarily non-empty for a clean landing (`apply` contaminates every family
    /// row), so the memory can always be keyed by (entity, line).
    fn remember(
        &mut self,
        key: &str,
        dropped: &[crate::modules::buff_rounds::Hold],
        live_life_ms: i64,
    ) {
        let db_ms = {
            let core_rc = Rc::clone(&self.core);
            let core = core_rc.borrow();
            let held = self.holds.get(key).expect("present");
            core.stats.db_duration_for(&held.line_key)
        };
        // The learning-record schedule: 3x the DB floor, never shorter than the one the row actually
        // had. Same rule and same function as the buffs half's orphaned open record.
        let window = live_life_ms.max(learning_record_cap_ms(db_ms, CC_UNKNOWN_CAP_MS));
        let held = self.holds.get(key).expect("present");
        let (entity_key, line_key, caster) = (
            held.entity_key.clone(),
            held.line_key.clone(),
            held.caster.clone(),
        );
        let spell = held
            .spell
            .clone()
            .or_else(|| held.candidates.first().cloned())
            .unwrap_or_else(|| held.line_key.clone());
        for h in dropped {
            if !h.clean {
                continue;
            }
            self.culled.insert(
                format!("{entity_key}|{line_key}"),
                LateJoin {
                    entity_key: entity_key.clone(),
                    caster: caster.clone(),
                    spell: spell.clone(),
                    started_ts: h.started_ts,
                    joinable_until: h.started_ts + window,
                },
            );
        }
    }

    /// Retire memories past their join window, and mints too old for a wake line to be about.
    fn sweep_memories(&mut self, now_ms: i64) {
        let dead: Vec<String> = self
            .culled
            .iter()
            .filter(|(_, m)| now_ms > m.joinable_until)
            .map(|(k, _)| k.to_string())
            .collect();
        for k in dead {
            self.culled.remove(&k);
        }
        if !self.recent_mints.is_empty() {
            self.recent_mints
                .retain(|m| now_ms - m.ts <= WAKE_CENSOR_MS);
        }
    }

    /// You left them behind. The memories go too: a landing you left behind is one whose break line
    /// you will never see.
    fn clear_holds(&mut self) {
        self.culled.clear();
        if self.holds.is_empty() {
            return;
        }
        self.holds.clear();
        self.rev += 1;
    }

    fn clear_all(&mut self) {
        let had = !self.holds.is_empty() || !self.ends.is_empty();
        self.holds.clear();
        self.ends.clear();
        self.culled.clear();
        self.recent_mints.clear();
        if had {
            self.rev += 1;
        }
    }

    fn dispatch(&mut self, ev: &Event) {
        match ev.kind_of() {
            Kind::Cc => {
                let mob = ev.str(Key::Mob).unwrap_or_default().to_string();
                if ev.bool(Key::Refresh) {
                    self.end(&id_key(&mob), ev.ts(), ev.str(Key::Spell));
                } else {
                    self.apply(&mob, ev.ts(), ev.str(Key::Verb), &cc_candidates(ev));
                }
            }
            // Charm is a detrimental hold in the same shape as a mez: the same call, the same anchor
            // gate, the same learner. It is NOT a claim about the entity's disposition — the charmed
            // mob is your pet and simultaneously carries this hold, so it appears in both windows.
            Kind::Charm => {
                let mob = ev.str(Key::Mob).unwrap_or_default().to_string();
                self.apply(&mob, ev.ts(), None, &cc_candidates(ev));
            }
            // The break annotation ends nothing — the wear-off line preceding it in the same second
            // already did, and closing a second landing here would delete another mob's hold.
            Kind::CcWake => {
                self.censor_wake(&id_key(ev.str(Key::Mob).unwrap_or_default()), ev.ts())
            }
            // Charm and CC break through the same sentence family. The line NAMES the charm spell,
            // so it closes that line's hold and leaves a mez on the same mob alone.
            Kind::Uncharm => self.end(
                &id_key(ev.str(Key::Mob).unwrap_or_default()),
                ev.ts(),
                ev.str(Key::Spell),
            ),
            // Every death shape, on the name that DIED and never on the killer. The parser already
            // unified them into one event, so there is nothing to branch on here.
            Kind::Death => {
                self.on_mob_death(&id_key(ev.str(Key::Name).unwrap_or_default()), ev.ts())
            }
            Kind::Zone => self.clear_holds(),
            _ => {}
        }
    }

    fn build_snap(&self) -> Value {
        json!({ "holds": self.holds(), "ends": self.ends })
    }

    /// Every live hold, oldest first, in the module's own shape.
    ///
    /// Split out of [`Self::build_snap`] rather than duplicated: the timer-row projection wants the
    /// typed rows and the snapshot wants them as JSON, and building them twice would be two answers
    /// waiting to disagree about which holds are live.
    #[must_use]
    pub fn holds(&self) -> Vec<CcHold> {
        let mut holds: Vec<CcHold> = Vec::new();
        for h in self.holds.values() {
            if h.group.is_empty() {
                continue;
            }
            let count = h.group.count() as i64;
            holds.push(CcHold {
                key: h.entity_key.clone(),
                target: h.target.clone(),
                started_ts: h.group.oldest_ts(),
                spell: h.spell.clone(),
                candidates: h.candidates.clone(),
                duration_ms: h.duration_ms,
                source: h.source,
                count: (count > 1).then_some(count),
                caster: (h.caster != SELF_CASTER).then(|| h.caster.clone()),
            });
        }
        holds.sort_by_key(|h| h.started_ts);
        holds
    }

    /// The recorded ENDS — the half of the projection's dedupe the buffs model cannot see.
    #[must_use]
    pub fn ends(&self) -> &[CcEnd] {
        &self.ends
    }

    /// The change signal: the same private revision counter this module publishes as its `seq`.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.rev
    }
}

/// The CC/charm broadcast's candidate shape, which carries no illusion flag.
fn cc_candidates(ev: &Event) -> Vec<Candidate> {
    ev.candidates(Key::Candidates)
        .into_iter()
        .map(|(name, duration_ms, _)| Candidate {
            name,
            duration_ms,
            // Not the event's flag: this shape carries none.
            illusion: false,
        })
        .collect()
}

/// Candidate names, ordered by [`crate::modules::buff_landing::compare_names`].
fn sorted_names(cands: &[Candidate]) -> Vec<String> {
    let mut names: Vec<String> = cands.iter().map(|c| c.name.clone()).collect();
    names.sort_by(|a, b| crate::modules::buff_landing::compare_names(a, b));
    names
}

impl EqModule for BuffTimersModule {
    fn id(&self) -> &'static str {
        "buffTimers"
    }

    fn reset(&mut self) {
        self.holds.clear();
        self.ends.clear();
        self.culled.clear();
        self.recent_mints.clear();
        self.last_event_ts = 0;
        self.rev = 0;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        // A 30-minute event-time hole is past any hold this module can carry (the same boundary the
        // buffs model uses), and a character epoch is a different character entirely.
        if ev.kind() == "epoch" {
            self.clear_all();
            return;
        }
        // An offline gap changes nothing here — see the module header.
        if ev.kind() == "offlineGap" {
            return;
        }
        let ts = ev.ts();
        if self.last_event_ts > 0 && ts - self.last_event_ts >= SESSION_GAP_MS {
            self.clear_all();
        }
        self.last_event_ts = ts;
        self.sweep(ts);
        self.dispatch(ev);
    }

    /// The wall-clock heartbeat: a hold expires while the log is idle, which is exactly when a
    /// player is staring at the bar waiting for it. Never called on a historical fold.
    fn on_tick(&mut self, now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        self.sweep(now_ms);
    }

    /// The dirty bit — the same cursor `snapshot` publishes, without building the state to read it.
    fn published_seq(&self) -> Option<i64> {
        Some(self.rev)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.rev, "state": self.build_snap() })
    }

    /// The view pull seam. See `EqModule::as_buff_timers`.
    fn as_buff_timers(&self) -> Option<&BuffTimersModule> {
        Some(self)
    }
}
