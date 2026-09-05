//! `src/main/modules/roster.ts` plus its fan-out detector and the provenance ladder they share —
//! WHO YOU ARE GROUPED WITH.
//!
//! REGISTERED SECOND, and that is load-bearing: the combat engine pulls the roster through a seam
//! installed before it folds a line, so within one bus delivery the roster must already be advanced.
//! A join line and the very next damage line by that name then behave correctly in one pass.
//!
//! It never touches the parser — it reads events and writes nothing back onto the bus. What it does
//! is widen the engine's ADMISSION gate and narrow the meter's VIEW, so a wrong roster can HIDE a
//! row and can never corrupt a number.
//!
//! WHAT CLEARS IT: `epoch` (a rebirth means the group belonged to somebody else) and `selfLeave`
//! (the one line that says the group itself is over). `offlineGap` does NOT — EQ drops groups
//! silently on camp, so members are marked STALE rather than emptied, hiding a real member being the
//! worse error. `zone` does not either: a group survives zoning and the game says nothing when it
//! doesn't.
//!
//! THE RECOVERY RUNGS. EQ prints a join line ONCE, so a group formed before the app opened has none
//! left to replay. `confirmed` needs somebody to talk, which a quiet group never does. `buffed` is
//! a CONJUNCTION of two facts the log states outright: one Quick Buff burst naming recipients in a
//! single instant, and `You gain party experience!` earlier in the session (a group exists, naming
//! nobody). Measured against join lines on a 900k-line log, the burst alone admits two townside
//! hand-outs the party-exp requirement removes: 2 admissions, 2 correct, 0 false positives, stable
//! at every backward window from 2 minutes to 6 hours. So the gate is STICKY rather than windowed,
//! and BACKWARD-ONLY: a fact in hand beats a prediction.
//!
//! NEVER-A-MEMBER. A burst also lands on your own pets, and a pet in the roster would put a friendly
//! on the Group meter as a person and make the engine refuse a charmed mob for the rest of its life.
//! So the weakest rung is refused for the tailed character, every charmed mob and every claimed pet
//! — RETROACTIVELY for that rung only, because the claim tell routinely lands after you finished
//! buffing. `joined` / `stated` / `user` are never touched: those the game or the user said outright.

use crate::event::Event;
use crate::jsmap::JsMap;
use crate::EqModule;
use eqlog::names::id_key;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

/// Strongest first. A rank, not just a label: a weaker signal never overwrites a stronger one's
/// provenance.
fn source_rank(source: &str) -> i32 {
    match source {
        "user" => 4,
        "joined" => 3,
        "stated" => 2,
        "confirmed" => 1,
        _ => 0, // 'buffed'
    }
}

/// At least as authoritative as what is already there.
fn outranks(next: &str, cur: &str) -> bool {
    source_rank(next) >= source_rank(cur)
}

/// Which provenance rung each membership-bearing `change` writes.
fn change_source(change: &str) -> Option<&'static str> {
    match change {
        "join" => Some("joined"),
        "leader" => Some("stated"),
        "confirm" => Some("confirmed"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterMember {
    /// Canonical (lowercased) identity key.
    key: String,
    /// Display name, spelled the way the log spelled it.
    name: String,
    source: &'static str,
    since_ts: i64,
    last_confirmed_ts: i64,
    /// An offline gap has passed with no signal since. A stale member is rendered dimmed and
    /// STILL PASSES the allowlist.
    stale: bool,
}

/// The one action that makes EQ Legends enumerate, by name and in a single instant, the people your
/// buffs reach.
///
/// MEASURED on a 900k-line log: 83 casts print two or more `You healed <X> … by <Spell>.` lines in
/// the same second for the same spell, and all 83 fall within 15 s of a `You activate Quick Buff.`
/// line, without exception. The wiki DB would have lied here — it calls three of those spells
/// "Single Friendly (or Self)".
///
/// The bucket is keyed on the log's SECOND rather than a tolerance window: every line of a burst
/// carries the identical timestamp, so a wider window could only merge casts the game kept apart.
/// HoT ticks are excluded — a tick is cast-detached, so two unrelated single-target HoTs could tick
/// in the same second and look exactly like one cast reaching both.
#[derive(Default)]
struct BuffFanOut {
    bucket: Option<Bucket>,
}

struct Bucket {
    ts: i64,
    /// Canonical spell key — two casts of two different spells in one second are two casts.
    spell: String,
    /// Display names in ARRIVAL order, deduped by canonical key. The order is published (the
    /// second target reports both names), so it is a `JsMap` and not a set.
    names: JsMap<String>,
    /// True once reported: later arrivals in the same cast report only themselves, so a 4-name
    /// burst does not re-announce the first two three times.
    announced: bool,
}

impl BuffFanOut {
    fn reset(&mut self) {
        self.bucket = None;
    }

    /// The display names this line newly proves were reached by one cast of yours, or `None`.
    fn on_heal(&mut self, ev: &Event) -> Option<Vec<String>> {
        if ev.bool("overTime") {
            return None;
        }
        let spell = ev.str("spell")?;
        let healer = ev.str("healer")?;
        // Only your OWN casts: another player's group buff enumerates THEIR group, and
        // `<X> healed <Y>` lines are printed for everyone in earshot.
        if healer.to_lowercase() != "you" {
            return None;
        }
        let key = spell.to_lowercase();
        let target = ev.str("target").unwrap_or_default().to_string();
        let fresh = match &self.bucket {
            Some(b) => b.ts != ev.ts() || b.spell != key,
            None => true,
        };
        if fresh {
            self.bucket = Some(Bucket {
                ts: ev.ts(),
                spell: key,
                names: JsMap::new(),
                announced: false,
            });
        }
        let b = self.bucket.as_mut().expect("just set");
        let name_key = target.to_lowercase();
        if b.names.contains_key(&name_key) {
            return None;
        }
        b.names.insert(name_key, target.clone());
        if b.names.len() < 2 {
            return None;
        }
        if b.announced {
            return Some(vec![target]);
        }
        b.announced = true;
        Some(b.names.values().cloned().collect())
    }
}

#[derive(Default)]
pub struct RosterModule {
    /// The log-derived roster, keyed canonically. INSERTION ORDER IS JOIN ORDER, which is what the
    /// published `members` array carries — a `JsMap`, never a hash.
    log: JsMap<RosterMember>,
    /// Every key admitted since the last epoch/self-leave. Wider than the roster on purpose, and a
    /// user REMOVE must never shrink it; not published, so its order is free.
    admitted_keys: JsMap<String>,
    /// Any group signal at all this epoch — the "no roster yet" vs "solo" distinction.
    seen: bool,
    last_signal_ts: i64,
    seq: i64,
    /// The announce cursor — see [`crate::announce`].
    ///
    /// Only `members`, `seen` and `lastSignalTs` are published; `admitted_keys`, `party_exp`,
    /// `never_member`, `fan_out` and `self_key` are how a name earns its way onto the roster and
    /// appear nowhere a client can read. So the party-experience line, which puts no name on the
    /// roster and never sets `seen`, mutates real state and publishes nothing.
    ///
    /// `roster.define` replaces the edit list that `effective()` folds into `members` and advances
    /// no log seq, so the cursor has to land strictly above the fold position to carry a change no
    /// event caused.
    announce: crate::announce::Announce,
    fan_out: BuffFanOut,
    /// The party-experience gate. Sticky rather than windowed; it gates the `buffed` rung and
    /// nothing else, never puts a name on the roster and never sets `seen` — a fact that names
    /// nobody must not flip the Group scope out of its show-everyone fallback.
    party_exp: bool,
    /// Canonical keys the weakest rung refuses: the tailed character, charmed mobs, claimed pets.
    never_member: HashSet<String>,
    /// The tailed character's own key, installed at construction when the session knows it.
    self_key: String,
    /// The user's own edits, via `roster.define`. Empty in every world constructed without a push.
    edits: Vec<RosterEdit>,
    /// The ts of the last epoch boundary, and of the last `You have been removed from the group.`
    /// An edit older than either described a character or a group that no longer exists — see
    /// [`RosterModule::live_edits`]. Kept as instants rather than by clearing the list, because the
    /// list is the APP's and the fold does not get to edit it.
    epoch_ts: i64,
    left_ts: i64,
}

/// One persisted user edit.
#[derive(Debug, Clone)]
pub struct RosterEdit {
    key: String,
    name: String,
    /// True for `add`, false for `remove`. A closed pair, so a bool rather than a second enum.
    add: bool,
    set_at: i64,
}

impl RosterEdit {
    /// Read one pushed edit. `None` for anything that is not the shape the store writes: refused
    /// whole, never silently repaired.
    fn read(v: &Value) -> Option<RosterEdit> {
        let action = v.get("action")?.as_str()?;
        let key = v.get("key")?.as_str()?;
        if key.is_empty() {
            return None;
        }
        Some(RosterEdit {
            key: key.to_owned(),
            name: v.get("name")?.as_str()?.to_owned(),
            add: match action {
                "add" => true,
                "remove" => false,
                _ => return None,
            },
            set_at: v.get("setAt")?.as_i64()?,
        })
    }
}

impl RosterModule {
    pub fn new(self_name: Option<&str>) -> Self {
        RosterModule {
            self_key: self_name.map(id_key).unwrap_or_default(),
            ..Default::default()
        }
    }

    /// A name the log has shown to be a PET. The refusal reaches BACKWARD into a roster the burst
    /// got in ahead of; a `joined`/`stated`/`user` member is left alone, because that is a
    /// statement the game or the user made outright and this rule may not overrule it.
    fn refuse_pet(&mut self, name: &str) {
        let key = id_key(name);
        if self.never_member.contains(&key) {
            return;
        }
        self.never_member.insert(key.clone());
        // The refusal is knowledge about a NAME and is not published. Only evicting a member the
        // weakest rung had already admitted changes the roster anybody can read.
        if self.log.get(&key).map(|m| m.source) == Some("buffed") {
            self.log.remove(&key);
            self.admitted_keys.remove(&key);
            self.announce.changed(self.seq);
        }
    }

    /// One `heal` line through the fan-out detector. A burst proves RECIPIENTS; the gate proves a
    /// group exists to receive them. Both, or nothing.
    fn fold_heal(&mut self, ev: &Event) {
        let Some(reached) = self.fan_out.on_heal(ev) else {
            return;
        };
        if !self.party_exp {
            return;
        }
        for name in reached {
            let key = id_key(&name);
            if key == self.self_key || key == "you" || self.never_member.contains(&key) {
                continue;
            }
            // A burst comes WITH NAMES, unlike the party-exp line, and a roster with names in it is
            // what `seen` is for.
            self.seen = true;
            self.last_signal_ts = self.last_signal_ts.max(ev.ts());
            self.add(&key, &name, "buffed", ev.ts());
            self.announce.changed(self.seq);
        }
    }

    fn fold_group(&mut self, ev: &Event) {
        // Every group line is a published change, the usually-declined invite and the `selfJoin`
        // that names nobody included: both set `seen` and `lastSignalTs`, which are in the snapshot.
        self.announce.changed(self.seq);
        // An INVITE is not a membership fact — it may be declined — but it proves a group is in
        // play, so it counts as a signal: "no roster yet" is more honest than a silent Everyone.
        self.seen = true;
        self.last_signal_ts = self.last_signal_ts.max(ev.ts());
        let change = ev.str("change").unwrap_or_default();
        if change == "invite" || change == "selfJoin" {
            return;
        }
        if change == "selfLeave" {
            self.log.clear();
            self.admitted_keys.clear();
            // …and every user edit written before the group ended described THAT group.
            self.left_ts = ev.ts();
            // The group itself is over, so the licence to read a future burst as membership is too.
            self.party_exp = false;
            self.fan_out.reset();
            return;
        }
        let Some(name) = ev.str("name") else {
            return;
        };
        let name = name.to_string();
        let key = id_key(&name);
        if change == "leave" {
            self.log.remove(&key);
            // Not removed from `admitted_keys`: their recorded damage stays real and the Everyone
            // scope must keep showing it. Only a self-leave or an epoch resets admission.
            return;
        }
        let Some(source) = change_source(change) else {
            return;
        };
        self.add(&key, &name, source, ev.ts());
    }

    /// Add or re-assert one member. Provenance only ever moves UP the ladder.
    fn add(&mut self, key: &str, name: &str, source: &'static str, ts: i64) {
        self.admitted_keys.insert(key.to_string(), name.to_string());
        let Some(cur) = self.log.get_mut(key) else {
            self.log.insert(
                key.to_string(),
                RosterMember {
                    key: key.to_string(),
                    name: name.to_string(),
                    source,
                    since_ts: ts,
                    last_confirmed_ts: ts,
                    stale: false,
                },
            );
            return;
        };
        cur.last_confirmed_ts = cur.last_confirmed_ts.max(ts);
        // Any fresh signal ends staleness: the group demonstrably still exists.
        cur.stale = false;
        if outranks(source, cur.source) {
            cur.source = source;
        }
        // The log's own spelling wins on a re-assert: a name typed lowercase into an invite is not
        // how the game spells it in the join line.
        if name != key {
            cur.name = name.to_string();
        }
    }

    /// The persisted edits that STILL APPLY: written after the last epoch AND after the last
    /// self-leave. Everything older described a character or a group that is gone.
    fn live_edits(&self) -> impl Iterator<Item = &RosterEdit> {
        let (epoch_ts, left_ts) = (self.epoch_ts, self.left_ts);
        self.edits
            .iter()
            .filter(move |e| e.set_at >= epoch_ts && e.set_at > left_ts)
    }

    /// The effective roster: the log's roster, PLUS your adds, MINUS your removes.
    ///
    /// User edits are a LAYER over the log rather than a mutation of it, which is what makes them
    /// stick the way the user means: a later join line cannot undo a remove, and a later leave line
    /// cannot undo an add. Undoing an edit is the user's own job.
    ///
    /// An add for somebody the log already named keeps their real join time and gains the top
    /// provenance rung — a stronger claim about the same person, not a different person.
    fn effective(&self) -> Vec<RosterMember> {
        if self.live_edits().next().is_none() {
            return self.log.values().cloned().collect();
        }
        let mut out: JsMap<RosterMember> = JsMap::new();
        for m in self.log.values() {
            out.insert(m.key.clone(), m.clone());
        }
        for e in self.live_edits() {
            if !e.add {
                out.remove(&e.key);
                continue;
            }
            if let Some(cur) = out.get_mut(&e.key) {
                cur.source = "user";
                continue;
            }
            out.insert(
                e.key.clone(),
                RosterMember {
                    key: e.key.clone(),
                    name: e.name.clone(),
                    source: "user",
                    since_ts: e.set_at,
                    last_confirmed_ts: e.set_at,
                    stale: false,
                },
            );
        }
        out.into_values()
    }
}

impl EqModule for RosterModule {
    fn id(&self) -> &'static str {
        "roster"
    }

    fn reset(&mut self) {
        self.log.clear();
        self.admitted_keys.clear();
        self.seen = false;
        self.last_signal_ts = 0;
        self.seq = 0;
        self.announce.reset();
        self.party_exp = false;
        self.fan_out.reset();
        // The never-a-member set is NOT cleared with the roster: it is knowledge about which names
        // are PETS, and a pet does not stop being one because the character was reborn. `self_key`
        // outlives it for the same reason.
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            "epoch" => {
                // Character rebirth: this group belonged to the wiped character. Everything goes,
                // the persisted edits included — and they go by DATE rather than by deletion,
                // because the list belongs to the app and the fold does not get to edit it.
                self.reset();
                self.epoch_ts = ev.ts();
                // Off `ev.seq()`, not `self.seq`, which the reset just zeroed: a cursor bumped off
                // the zeroed field would land BELOW the seq a client still holds from the wiped
                // character's snapshot, and the group would be cleared here and left on screen
                // there.
                self.announce.changed(ev.seq());
            }
            "offlineGap" => {
                // The world stopped being observable. Nothing SAID the group broke — EQ never does
                // — so every member is marked stale rather than removed, and stays in the
                // allowlist.
                let from_ts = ev.int("fromTs").unwrap_or(0);
                // `stale` is a published field, so a member flipping it is a change a client draws.
                // Counted rather than assumed: a gap with an empty roster, or one every member was
                // already stale through, publishes nothing.
                let mut flipped = false;
                for m in self.log.values_mut() {
                    if m.last_confirmed_ts <= from_ts && !m.stale {
                        m.stale = true;
                        flipped = true;
                    }
                }
                if flipped {
                    self.announce.changed(self.seq);
                }
                self.party_exp = false;
                self.fan_out.reset();
            }
            // `You gain party experience!` — the game's own statement that you are in a group right
            // now. IT NAMES NOBODY, so it opens the gate and touches nothing else.
            "expGain" => {
                if ev.bool("party") {
                    self.party_exp = true;
                }
            }
            "charm" | "uncharm" => self.refuse_pet(ev.str("mob").unwrap_or_default()),
            "petClaim" => self.refuse_pet(ev.str("name").unwrap_or_default()),
            "heal" => self.fold_heal(ev),
            "group" => self.fold_group(ev),
            _ => {}
        }
    }

    /// The dirty bit: a group line, a heal burst that reached a name, a pet evicted from the weakest
    /// rung, a gap that staled somebody, or a rebirth. See the `announce` field.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        // With no edits pushed this is the log's map in join order, verbatim.
        let members = self.effective();
        json!({
            "seq": self.seq,
            "state": {
                "members": members,
                "seen": self.seen,
                "lastSignalTs": self.last_signal_ts,
            }
        })
    }

    /// The pull seam, answered by this module and by no other — one method, no downcast.
    fn as_roster(&self) -> Option<&dyn crate::combat::RosterSource> {
        Some(self)
    }

    fn as_defines(&mut self) -> Option<&mut dyn crate::Defines> {
        Some(self)
    }
}

impl crate::Defines for RosterModule {
    fn family(&self) -> &'static str {
        "roster"
    }

    /// The whole edit list, replaced.
    ///
    /// A PUSH rather than the TS's pull, because of the process boundary: over there a provider
    /// re-asks the store on every read, so a character switch needs no notification. The engine has
    /// no store to ask, so the app pushes on connect and on every write — and because a define is a
    /// full-set replace, a switch is one push and not a reconciliation.
    fn define(&mut self, payload: &Value) {
        let Some(list) = payload.as_array() else {
            return;
        };
        self.edits = list.iter().filter_map(RosterEdit::read).collect();
        // `effective()` folds these into the published `members`, so a pushed edit list is a
        // published change with no event behind it.
        self.announce.changed(self.seq);
    }
}

/// The combat engine does not FOLD a roster, it ASKS this module for one, during the same delivery
/// and after this module has advanced for the line. That is why `roster` is registered second, and
/// why there is exactly one membership ladder in this crate: two spellings of "who is in your group"
/// are two answers.
///
/// `combat::RosterMember` is a NARROWER shape than the one this module publishes, because it rides
/// the combat snapshot and the meter does not draw `lastConfirmedTs` or `stale`. Both are built from
/// the same map in the same order, so the two readings can disagree about nothing.
impl crate::combat::RosterSource for RosterModule {
    fn snap(&self) -> crate::combat::RosterSnap {
        crate::combat::RosterSnap {
            members: self
                .effective()
                .iter()
                .map(|m| crate::combat::RosterMember {
                    key: m.key.clone(),
                    name: m.name.clone(),
                    source: m.source.to_string(),
                    since_ts: m.since_ts,
                })
                .collect(),
            seen: self.seen,
            last_signal_ts: self.last_signal_ts,
        }
    }

    fn members(&self) -> Vec<String> {
        self.effective().into_iter().map(|m| m.key).collect()
    }

    /// Wider than `members`, and it never shrinks within an epoch: a member who left an hour ago is
    /// still the person whose row carries that fight's damage, which is what lets a recorded row's
    /// kind upgrade from `'other'` to `'member'` MONOTONICALLY.
    ///
    /// A user ADD joins it and a user REMOVE does not leave it — the same asymmetry, for the same
    /// reason: the meter's Everyone scope still has to show the damage a removed name really did.
    fn admitted(&self) -> Vec<String> {
        let mut out: Vec<String> = self.admitted_keys.keys().map(str::to_string).collect();
        for e in self.live_edits() {
            if e.add && !out.contains(&e.key) {
                out.push(e.key.clone());
            }
        }
        out
    }
}
