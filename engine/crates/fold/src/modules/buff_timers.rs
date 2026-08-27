//! `src/main/modules/buffTimers.ts` — the CROWD-CONTROL half of the buffs/debuffs timer overlay
//! (JOS-89), and since JOS-140 a half of ONE model rather than a second one.
//!
//! WHY A SEPARATE MODULE, AND WHY IT IS THIS SMALL. `buffs.rs` already tracks buff INSTANCES per
//! (spell line, entity) — including debuffs on named mobs — with cast-anchored attribution,
//! candidate resolution, death/zone/charm censoring and the DB duration prior. The overlay reads all
//! of that straight off the buffs snapshot rather than folding a second copy, because a second fold
//! of the same events is exactly the two-models-with-different-reach scar world-model law 4 is made
//! of.
//!
//! What `buffs.rs` demonstrably does NOT hold is the mez itself. `<mob> has been mesmerized.` is
//! claimed by the CC classifier, which sits ABOVE the DB matcher in the parser's cascade, so it
//! never becomes a `buffApply` and never becomes an instance — the buffs model uses the event to
//! note the current hostile target and nothing more. That is the whole gap, and this module is the
//! whole fix: per-target holds, keyed by mob, so ONE AE mez landing on four enemies is four named
//! rows with four independent clocks.
//!
//! ── ITS PUBLISHED `seq` IS A REVISION COUNTER, NOT THE LAST EVENT'S (JOS-87) ───────────────────
//!
//! This is the one module in the whole registry whose snapshot `seq` is not `ev.seq`, and it is the
//! trap a port walks into: the goldens record 6, 106, 0, 0, 0 and 145 for the six slices, which are
//! not event ordinals at all. `useModule` dedupes with `if (d.seq <= knownSeq) return`, so a revision
//! counter only works when the state moves ONLY when an event moves it — and this module's does not:
//! `onTick` expires holds on a log that is idle, which is precisely when someone is watching a mez
//! run out. A delta that advanced no log seq would be dropped as a duplicate and the row would sit
//! on screen forever. So EVERY `rev += 1` in this file is a published number, and a port that
//! skipped one would fail the comparator on a slice whose holds are all empty.
//!
//! ── WHAT JOS-140 CHANGED ──────────────────────────────────────────────────────────────────────
//!
//! This module used to be DB-STATED BY DESIGN: a mez counted down from whatever spells.json states
//! and nothing could ever teach it otherwise. The committed DB has ONE row for the Mesmerization
//! line (24 s, the base rank's) and ZERO rows at rank VI or above — the scrape is classic-EQ data
//! that does not know the Legends re-tiering — while a 0.14.0 enchanter's Mesmerization VII really
//! runs 42–47 s. So the bar hit zero at 24 s and sat there overdue for another twenty seconds, on
//! every cast, forever. The root cause was not a broken learner: there was no learner on this path
//! at all. Three objects are now HANDED to this module by the wiring and every one of them was
//! previously duplicated here — the cast anchors, the learner, and the count-and-close rule.
//!
//! ── AN OFFLINE GAP CHANGES NOTHING HERE, AND THAT IS THE DESIGN (JOS-134) ──────────────────────
//!
//! `buffs.rs` folds that event to PAUSE your beneficial buffs: EQ freezes them with your character.
//! Everything this module holds is the other kind — a mez, a root, an ensnare, on somebody else —
//! and the world those mobs stand in does not stop when you camp. A hold keeps burning down in world
//! time, so its landings are left exactly where they are. It is an EXPLICIT no-op rather than an
//! absent case for one reason: the asymmetry looks like an oversight from inside this file, and the
//! next reader to notice it should find the answer here instead of "fixing" it. The early return
//! also keeps the derived event out of `last_event_ts`, which the primary `sessionStart` it restates
//! has already recorded.

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

/// How long an END is remembered. It exists so the PROJECTION can retire a matching active buff the
/// buffs model never clears, and so the overlay can flash a drop — both seconds-scale concerns. It
/// is not a history.
pub const CC_END_MEMORY_MS: i64 = 60_000;

/// How close a `<mob> has been awakened by <name>.` line must land to a mint to be talking about it
/// (JOS-180).
///
/// ONE SECOND, because EQ stamps are second-resolution and the pair is always inside one stamp.
/// MEASURED over the owner's whole log: of 1,518 wake lines, 1,472 share the exact second of that
/// mob's own wear-off, and in all 1,472 the wear-off comes FIRST (1,462 of them on the very next
/// line). The one wake 27 s from a wear-off belongs to a different cycle of the same mob name, and 45
/// more have no wear-off within 30 s at all — a hold somebody else was maintaining.
pub const WAKE_CENSOR_MS: i64 = 1_000;

/// The bound on a hold whose duration NOBODY states: the LONGEST stated CC duration in the committed
/// spells.json (660 s, Ensnare) rather than a number somebody liked. Past the longest hold the
/// game's own data describes, the absence of a break line is evidence we lost the thread, not
/// evidence the mob is still held.
pub const CC_UNKNOWN_CAP_MS: i64 = 660_000;

/// THE HOLDS A CORPSE CANNOT BE ABOUT (JOS-228) — the three landing verbs whose hold ANY damage
/// breaks.
///
/// A mesmerized mob cannot be killed while it is mesmerized: the first point of damage wakes it, and
/// the log SAYS SO before the corpse ever appears (the wake measurement above). So a mez that is
/// killed is a mez whose BREAK line closed the landing already, and a death line arriving while the
/// hold still stands is, by construction, about ANOTHER mob of that name.
///
/// `ensnared` is deliberately not a member and is the reason this is a set rather than "every CC
/// hold": a snare is a movement debuff that does nothing to stop you killing what it is on, so a
/// corpse genuinely is that hold ending. Charm is the same story from the other side — a charmed pet
/// dies as often as anything else — and reaches this module with no verb at all.
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
    /// Two ranks of this line were in flight at once, so no sample may be minted (ruling 5).
    rank_changed: bool,
}

/// The landings of one (spell line, mob name), plus the bookkeeping the snapshot does not carry.
/// ONE OF THESE IS ONE ROW.
struct Held {
    /// Canonical mob key (`idKey`) — the entity half of the identity.
    entity_key: String,
    /// The mob's display name, raw from the log (world-model law 2).
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

/// A CULLED LANDING THE MODEL STILL REMEMBERS — the late-join memory (JOS-180).
///
/// THE TRAP IT EXISTS TO BREAK, measured on the owner's bytes 2026-08-09. A CC duration sample can
/// only be minted through a LIVE hold, and a hold is culled at estimate + grace. So the instant a run
/// of break-shortened cycles drags the learned number below the real duration, every full-length hold
/// is culled BEFORE its wear-off arrives, the wear-off closes nothing, and the estimate can never
/// climb back out. Dazzle IV: real duration 136 s, learned 100 s from breaks, hold culled at 115 s,
/// the first witnessed full cycle in the whole log destroyed 21 s later by its own bar.
///
/// WHAT IT IS AND — LOUDLY — WHAT IT IS NOT. It is a MEMORY, not a hold. The ROW still dies on
/// schedule: the anti-squatting rule is the owner's ruling from live testing and is untouched, so
/// nothing on screen comes back, no `ends` entry is invented, and the projection sees exactly what it
/// saw before. All that survives the cull is the landing's START TIME and its `clean` flag.
///
/// THE JOIN WINDOW IS DB-FLOOR-SCALE, and that is the point: remembering for the CULLED schedule
/// would be circular, because that schedule is the underestimate.
struct LateJoin {
    entity_key: String,
    caster: String,
    /// The RANKED display name, for the sample's label.
    spell: String,
    /// When the landing happened. The span a late break measures is `breakTs - startedTs`.
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

/// The row the snapshot publishes. Every optional is skipped when absent — the golden was recorded
/// through `JSON.stringify`.
///
/// PUBLIC SINCE JOS-487, and the visibility is the whole of the change: `buff_timer_rows` folds
/// these together with `buffs.active` into the rows the two timer windows draw, exactly as
/// `shared/buffTimers.ts` does over there. Nothing about how a hold is built moved.
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
    /// Every spell the sentence could have been (JOS-84). Empty once `spell` is known.
    pub candidates: Vec<String>,
    /// The estimator's duration, or `None` for a hold that counts up.
    pub duration_ms: Option<i64>,
    /// Where that duration came from. Read by the Buffs tab, never by the bars (JOS-379).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<EstimatorSource>,
    /// How many entities of this display name are held. Absent for the ordinary one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    /// The allowlisted external who cast it; absent for your own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caster: Option<String>,
}

/// One recorded END of a hold. Public for [`CcHold`]'s reason.
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
    /// Samples minted within the last {@link WAKE_CENSOR_MS}, awaiting a possible wake annotation.
    recent_mints: Vec<RecentMint>,
    last_event_ts: i64,
    /// OUR OWN REVISION, NOT THE LAST EVENT'S seq — see the module header.
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
    /// THE ANCHOR GATE (JOS-140 ruling 2). The sentence is a BROADCAST and names no caster, so a
    /// hold is opened only when a cast line anchors it — the player's own, or an allowlisted
    /// external's. This is the identical ruling the encounter model already makes ("a stranger's
    /// crowd control is an observation about the room, not an event in our fight"). Without it a
    /// crowded zone fills this overlay with other enchanters' work.
    ///
    /// THE NARROWING is JOS-84's law: the parser hands over every spell the sentence could be, and
    /// the MODEL resolves against the anchors. Exactly one anchored candidate ⇒ that spell, by its
    /// RANKED name (the cast line is the only line in the family that carries a rank). More than
    /// one, or none ⇒ the row stays a FAMILY and states a duration only if every candidate agrees on
    /// one.
    fn apply(&mut self, mob: &str, ts: i64, verb: Option<&str>, cands: &[Candidate]) {
        let core_rc = Rc::clone(&self.core);
        let core = core_rc.borrow();
        // No DB (so no candidates at all) means we cannot tell our own mez from a stranger's, and
        // the honest answer to "whose is it?" is not to guess. No anchored cast means the same
        // thing. (A Quick Buff burst is deliberately NOT an anchor here: it names no spell, and
        // every member of the crowd-control roster is a targeted cast with a cast line of its own.)
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
        // A FRESH LANDING RETIRES THE MEMORY OF THE OLD ONE (JOS-180). Whatever that mob was holding
        // before, this line proves it is holding this now, and the next break sentence on this name
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
            // …and a RESOLVED one says the mob's OTHER mez just ended (JOS-410). Only resolved: a
            // family row cannot name the line it would be overwriting, and "some mez landed" is not
            // evidence that a different one did.
            if !id.line_key.is_empty() {
                self.retire_overwritten(&key, ts);
            }
        }

        let mut core = core_rc.borrow_mut();
        // The Buffs TAB lists every line the model has knowledge about, and a mez is now one of them
        // — JOS-126's reporter could not see the learned number anywhere, because the CC path never
        // touched the learner at all.
        if !id.line_key.is_empty() {
            core.stats.note_ever_faded(&id.line_key);
            core.stats.touch_last_seen(&id.line_key, ts);
            // …AND THE RANK THIS CAST NAMED IS THE TAB'S TOO (JOS-411). The hold has always taken its
            // ranked name from the anchored cast; the tab's stats record used to keep whatever rank
            // was equipped the first time a cycle happened to close. It is done HERE because the cast
            // line is the only line in a mez's family that carries the numeral at all, and a broken
            // cycle mints nothing to carry it.
            core.stats
                .note_display_name(&id.line_key, &id.caster, &id.display);
            self.holds.get_mut(&key).expect("held").spell = Some(id.display.clone());
        }

        // THE DURATION the bar draws. Resolved ⇒ the shared estimator, keyed on (line, caster): the
        // DB row is the FLOOR and this caster's own clean observations extend it. Unresolved ⇒ the
        // DB agreement rule alone, because there is no line to look a learned value up under.
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
            // A FAMILY, or a cast window holding two ranks of one line, can never say what it
            // measured.
            held.group
                .land(ts, id.line_key.is_empty() || id.rank_changed);
        }
        self.rev += 1;
    }

    /// Which spell (and whose) this landing is, from the anchored candidates. ONE anchored candidate
    /// resolves it outright; several are narrowed by the nearest completed cast, and only a genuine
    /// TIE leaves an empty `line_key` — this file's spelling of "a family, not a name".
    fn resolve_cc(
        &self,
        own: &[Candidate],
        ts: i64,
        core: &crate::modules::buffs::BuffsCore,
    ) -> CcIdentity {
        // THE NEAREST COMPLETED CAST WINS (JOS-410). Casting is SERIAL: the game will not begin a
        // second cast while one is in flight, and a cast that dies retracts its own anchor. So the
        // NEWEST anchor at or before a landing is the cast that just COMPLETED, and every older one
        // in the window is a cast whose own landing sentence has already been printed. That is a
        // fact about the log's ordering rather than a preference between two spells.
        //
        // A TIE STAYS A FAMILY: two DIFFERENT spells anchored at the same ts means the log printed
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

    /// A NEW MEZ ON A MOB RETIRES THE OLD ONE (JOS-410, owner ruling 2026-08-19).
    ///
    /// THE DEFECT, reported verbatim: *"Once Mesmerize is overwritten the debuff window still tracks
    /// it."* EQ prints NOTHING when one mez-line spell replaces another on the same mob — no
    /// wear-off, no `awakened`, no notice of any kind — so the old hold counted its stated duration
    /// down to zero and then squatted there until the unwitnessed-expiry cull got to it a minute
    /// later. The landing sentence itself is the only evidence the game gives, and it is enough: a
    /// mob holds ONE mez, so a mez-verb landing that resolved to a different line is that mob's
    /// previous mez ending.
    ///
    /// IT CLOSES ONE LANDING AND CONTAMINATES THE REST, exactly as a death does to a snare row: a
    /// name is a name, so an overwrite on `a spiroc banisher` cannot say WHICH of the three we hold
    /// was re-mezzed. Oldest-first is the likeliest one twice over here — it is the closest to
    /// expiring, which is the one a chain-mezzer re-mezzes on purpose.
    ///
    /// NOTHING IS LEARNED FROM IT, and it records no `CcEnd`. The ends ledger exists to retire an
    /// active buff the buffs model never clears, and a hold carrying a mez VERB can never have one:
    /// those four sentences are claimed ABOVE the DB matcher, so they become `cc` events and never
    /// `buffApply`. There is nothing on the other side to correct.
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
                // NEVER a singleton: a mob is a NAME the world hands out more than once, and
                // separating two of them is one of world-model law 6's documented
                // non-distinguishables.
                group: HoldGroup::new(false),
            },
        );
        key
    }

    /// A BREAK LINE said one of these ended — a mez/root wear-off, or a charm break.
    ///
    /// It closes the OLDEST landing of that (mob, spell) and MINTS a duration sample when that
    /// landing was a clean cycle. The row survives with one fewer on its count chip; only an empty
    /// group removes it.
    ///
    /// A DEATH NO LONGER COMES HERE (JOS-228). It is not a break line at all: it names a mob that
    /// stopped existing rather than a hold that ended.
    fn end(&mut self, entity_key: &str, ts: i64, spell: Option<&str>) {
        let line = spell.map(spell_key);
        let closed_any = self.close_live(entity_key, line.as_deref(), ts);
        // THE LATE JOIN (JOS-180). Only when NOTHING live was closed — a live hold is always the
        // better answer, and preferring it is what keeps this from ever competing with the ordinary
        // path. Only for a break line that NAMES its spell, because a landing has to be identified
        // to be measured.
        if !closed_any {
            if let Some(line) = &line {
                self.late_join(entity_key, line, ts);
            }
        }
        // Recorded even when we held nothing: that is a real CC break, and the projection uses it to
        // retire an active buff the buffs model does not clear, which can exist without a hold
        // beside it.
        self.ends.push(CcEnd {
            key: entity_key.to_string(),
            ts,
            spell: spell.map(str::to_string),
        });
        self.rev += 1;
    }

    /// Close the LIVE holds this ending applies to. Returns whether it found any — which is what
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
    /// a break line reaches here since JOS-228.
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
    /// The mint is REMEMBERED for {@link WAKE_CENSOR_MS} so the wake line that follows a break —
    /// always afterwards, always in the same second — can find the sample it explains. That is the
    /// only reason this is a method rather than two lines inside `close_one`: the late-join path
    /// mints too, and both have to be annotatable or the censoring would depend on which route the
    /// sample took.
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
    /// module still remembers (JOS-180).
    ///
    /// IT MINTS THROUGH THE SAME CLEANLINESS RULES and adds none of its own: only a landing that was
    /// `clean` when it was culled is ever remembered, so a family that never narrowed, a round of
    /// two, a refresh, a rank change and a contaminated group are all refused here exactly as they
    /// are on the live path. The memory is CONSUMED whether or not the span turns out to be usable —
    /// a second break sentence for the same landing is not a second observation of it.
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

    /// A MOB OF THIS NAME DIED — and the honest answer to "which one?" is a per-hold ruling
    /// (JOS-228).
    ///
    /// THE DEFECT, owner-reported and urgent: mez one mob, kill the one standing next to it that
    /// happens to share its name, and the mez bar vanished — at the exact moment a chain-mezzing
    /// player needs it. The name is all the log gives, so the death line and the hold line are
    /// indistinguishable strings, and this module closed a landing on the strength of that alone.
    ///
    /// WHAT DECIDES IT IS THE LANDING VERB, which is evidence rather than taste. A snare or a charm
    /// has no such protection and a corpse genuinely does end it, so those keep the count-chip rule:
    /// ONE landing closes, the oldest, and only an empty group removes the row.
    ///
    /// TWO THINGS A DEATH STILL DOES TO A MEZ ROW: it CONTAMINATES the whole group (a same-named
    /// death means the group has lost track of which mob of that name is which, so nothing standing
    /// in it may ever be minted), and it FORGETS the culled memories for that name.
    ///
    /// AND IT RECORDS NO `CcEnd`. An end with no spell on it matches EVERY active buff on that
    /// entity in the projection, so a death that closed a snare used to blank the slow row the buffs
    /// model had deliberately kept standing at one fewer on its own count chip — one model overruling
    /// the other about a fact the other had already settled correctly.
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
    /// It ENDS NOTHING: the wear-off line that precedes it in the same second already did, and
    /// closing a second landing here would delete a hold on another mob of that name. Nothing is
    /// displayed differently either — the estimate is a MAX over both sample windows, so the number
    /// does not move today. What moves is tomorrow: a censored sample can no longer evict a
    /// full-length one.
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
            // THE UNWITNESSED-EXPIRY CULL. A hold whose countdown ran out and whose break line never
            // arrived — you died, you zoned, the mob wandered off — is dropped rather than left
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

    /// File the CLEAN landings a cull just dropped, so a break line arriving late can still find
    /// them.
    ///
    /// Only clean ones: a contaminated landing could not have minted on the live path either, and
    /// remembering it would be a second, laxer set of rules for the same question. `line_key` is
    /// necessarily non-empty for a clean landing — `apply` contaminates every family row — so the
    /// memory can always be keyed by (entity, line).
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
        // The LEARNING-RECORD schedule (JOS-203): 3x the DB floor, never shorter than the one the row
        // actually had. Same rule, same function, as the buffs half's orphaned open record.
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

    /// You left them behind (world-model law 4's censor). The memories go with them: a landing you
    /// left behind is one whose break line you will never see.
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
            // CHARM IS A DETRIMENTAL HOLD, IN THE SAME SHAPE AS A MEZ (JOS-140, owner amendment
            // 2026-08-09). `<mob> has been charmed.` is claimed by the charm classifier above the CC
            // one, so before this it opened nothing anywhere and there was no charm countdown at all
            // — for an enchanter, charm-break timing is the whole game. It is the same call, the same
            // anchor gate, the same learner. WHAT IT IS NOT is a claim about the entity's
            // DISPOSITION: the charmed mob is your pet and simultaneously carries this detrimental
            // hold, so it legitimately appears in BOTH windows.
            Kind::Charm => {
                let mob = ev.str(Key::Mob).unwrap_or_default().to_string();
                self.apply(&mob, ev.ts(), None, &cc_candidates(ev));
            }
            // THE BREAK ANNOTATION (JOS-180). It ENDS NOTHING — the wear-off line that precedes it in
            // the same second already did, and closing a second landing here would delete a hold on
            // another mob of that name.
            Kind::CcWake => {
                self.censor_wake(&id_key(ev.str(Key::Mob).unwrap_or_default()), ev.ts())
            }
            // Charm and CC break through the SAME sentence family; a charm break on a mob we were
            // also holding is that hold ending too. The line NAMES the charm spell, so it closes that
            // line's hold and leaves a mez on the same mob alone.
            Kind::Uncharm => self.end(
                &id_key(ev.str(Key::Mob).unwrap_or_default()),
                ev.ts(),
                ev.str(Key::Spell),
            ),
            // EVERY death shape, on the name that DIED and never on the killer (JOS-156). The parser
            // already unified the three into one event, so there is nothing to branch on here.
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

    /// THE CC-HOLD PULL SEAM (JOS-487) — every live hold, oldest first, in the module's own shape.
    ///
    /// Split out of [`Self::build_snap`] rather than duplicated: the timer-row projection wants the
    /// TYPED rows and the snapshot wants them as JSON, and building them twice would be two answers
    /// waiting to disagree about which holds are live. Same argument `loot`'s `rows()` makes — a
    /// view that read `snapshot()` would serialize the whole thing to draw a window of it.
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

    /// The recorded ENDS, which is the half of the projection's dedupe the buffs model cannot see.
    #[must_use]
    pub fn ends(&self) -> &[CcEnd] {
        &self.ends
    }

    /// THE CHANGE SIGNAL — the same private revision counter this module publishes as its `seq`
    /// (JOS-87), read by the view layer's cost model and by the module dirty bit.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.rev
    }
}

/// `cc.candidates` / `charm.candidates` — `[{ name, durationMs }]`, with NO illusion flag (the CC
/// broadcast's candidate shape is the narrower of the two).
fn cc_candidates(ev: &Event) -> Vec<Candidate> {
    ev.candidates(Key::Candidates)
        .into_iter()
        .map(|(name, duration_ms, _)| Candidate {
            name,
            duration_ms,
            // NOT the event's flag — this shape carries none, and the reader that walked the
            // `Value` defaulted it here for the same reason.
            illusion: false,
        })
        .collect()
}

/// `cands.map(c => c.name).sort((a, b) => a.localeCompare(b))`.
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
        // AN OFFLINE GAP CHANGES NOTHING HERE — see the module header for the ruling and for why the
        // early return is written out rather than left as an absent case.
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

    /// The wall-clock heartbeat: a hold expires while the log is idle, which is exactly when a player
    /// is staring at the bar waiting for it. Never called on a historical fold.
    fn on_tick(&mut self, now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        self.sweep(now_ms);
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.rev)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.rev, "state": self.build_snap() })
    }

    /// THE VIEW PULL SEAM (JOS-487). See `EqModule::as_buff_timers`.
    fn as_buff_timers(&self) -> Option<&BuffTimersModule> {
        Some(self)
    }
}
