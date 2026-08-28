//! Log lines in, pooled resist observations out.
//!
//! The published state is two integers, and this module is a pull rather than a push: the ledger is
//! ~700 kB and its only consumer wants one mob at a time, so `flush_delta` stays `None`, the mob
//! page asks a separate IPC, and `snapshot()` carries counts for diagnostics. Those counts are an
//! unforgiving surface — every term of `ledger.rs row_key` is load-bearing, so one wrong mob level
//! or ISO week splits or merges a row and the count moves.
//!
//! It does not reset at an epoch boundary. What a mob resists is game knowledge, not
//! character-scoped state, and a rebirth does not unlearn it; the per-character bucket still means
//! a re-fold replaces that character's contribution and nothing else.
//!
//! No wall clock reaches a historical fold, so `settle` is never called during one and the
//! end-of-fold state deliberately holds a deferred landing that arrived within `LAND_DEFER_MS` of
//! the last event, and a song's last open pulse with its interpolation unemitted. A port that
//! "helpfully" settled at the end would move every recorded number in the same direction.
//!
//! How each outcome is earned:
//!
//!   Resist   the game saying it flatly. Incoming resists (`You resist <mob>'s <Spell>!`) are yours
//!            and out of scope entirely.
//!   Damage   the number goes into the row's histogram, from which the estimator derives
//!            full-versus-partial. A critical counts as a landing and stays out of the histogram:
//!            its number is not the spell's full damage and would invent a second "full" value.
//!   Land     the first tick of a DoT after its cast, and a cast-on-other emote joined back to your
//!            own `You begin casting` — never both for one spell on one mob, because a spell that
//!            emotes and damages produced one roll. The emote's landing is therefore deferred and
//!            cancelled by any damage line that follows it for the same mob and spell.
//!   Song     decided by spell identity, never by a begin line; see `songs.rs`. A song is never
//!            filed as a cast.
//!
//! It never reads the client's `spells_us.txt`: everything it writes is something the log printed,
//! so the ledger is meaningful without a file this project may not redistribute and a patch that
//! retunes a spell costs a re-estimate rather than a re-fold. The exclusions that need the table
//! live in the estimator.
//!
//! Other people's casts are recorded and never estimated from. A `pc` row carries no level, since
//! nothing this app reads states one; an `npc`'s level comes off the same catalog-or-`/con` ladder
//! the target's level climbs. An npc deliberately gets no armed cast: third-party cast-begins
//! outnumber yours nearly two to one, and arming them would put the join window in contention on
//! every landing sentence you earned.
//!
//! A row's target has to be a creature. `world.rs is_mob_target` gates every filing — resist,
//! damage, emote and song — because R is a statement about a creature.

pub mod cast_state;
pub mod catalog;
pub mod ledger;
pub mod ledger_file;
pub mod songs;
pub mod world;

use crate::event::{Event, Key, Kind};
use crate::modules::consider::mob_key;
use crate::EqModule;
use cast_state::{Armed, ArmedCasts, CastState};
use eqlog::names::{id_key, spell_canon_key, spell_rank};
use ledger::{
    add_damage, iso_week_key, CasterKind, Family, ResistBucket, ResistLedgerStore, RowSpec,
};
use serde_json::{json, Value};
use songs::{SongFold, SongOut, SONG_CONTACT_MS};
use std::collections::HashSet;
use world::{CasterIndex, DebuffWindows, MeleeContact, MobLevels, MobNames, TargetVerdicts};

/// How long a deferred emote-landing waits to see whether a damage line cancels it.
pub const LAND_DEFER_MS: i64 = 3_000;

/// The separator inside every composite key this module builds. A printable byte on purpose: a raw
/// control byte makes git classify the file as binary. No EQ mob or spell name contains a pipe.
const SEP: char = '|';

/// Is this name the player? The parser's `norm` produces exactly `You` for every spelling the log
/// uses, so the identity compare answers almost every call and `id_key` is the fallback for shapes
/// that reach here unnormalised. Ordered that way because this runs on every melee swing.
fn is_self(name: &str) -> bool {
    name == "You" || id_key(name) == "you"
}

/// One thing the log said, as this fold names it before the bucket pools it.
struct Observation {
    /// The mob's name as the line spelled it; the key is folded from it.
    mob: String,
    spell_key: String,
    family: Family,
    kind: CasterKind,
    /// The caster's level, or `None` when nothing has stated it.
    level: Option<i64>,
    ts: i64,
    /// The spell upgrade rank this observation was made at: -15 of resist adjust each.
    rank: i64,
    /// Whether the overchannel invocation was up. Three states — see `cast_state.rs`.
    overchannel: Option<bool>,
}

/// A landing waiting to see whether a damage line cancels it: an `Observation` held for
/// `LAND_DEFER_MS` before it is filed. The fields must stay identical to `Observation`'s, because a
/// deferred filing carrying a different set of facts from an immediate one is a bug with nowhere to
/// be caught. The family is always `cast`: a song pulse is never deferred, its sentence is the
/// landing.
struct Deferred {
    mob: String,
    spell_key: String,
    ts: i64,
    kind: CasterKind,
    level: Option<i64>,
    rank: i64,
    overchannel: Option<bool>,
}

#[derive(Default)]
pub struct ResistFold {
    levels: MobLevels,
    casters: CasterIndex,
    debuffs: DebuffWindows,
    contact: MeleeContact,
    songs: SongFold,
    zone: Option<String>,
    self_level: Option<i64>,
    /// The rank and invocation a self cast is filed under, and the rules for both: `cast_state.rs`.
    cast: CastState,
    casts: ArmedCasts,
    dot_seen: HashSet<String>,
    deferred: Option<Deferred>,
    /// Mob names both ways, memoised. The measurement behind the memo is in `world.rs`.
    names: MobNames,
    /// Per-fold rather than module-scoped, so no verdict cache outlives a `Fold`.
    targets: TargetVerdicts,
}

impl ResistFold {
    pub fn new() -> Self {
        Self::default()
    }

    /// One creature's level, for a reader. The `&self` form, so the ingest's one door can carry it;
    /// [`world::MobLevels::level_of_ref`] states why it answers the same as the fold's own.
    #[must_use]
    pub fn level_of_ref(&self, mob_key: &str, display: &str) -> Option<world::MobLevelFact> {
        self.levels.level_of_ref(mob_key, display)
    }

    /// Start folding a source: the session reset. The bucket discard that makes a re-fold idempotent
    /// belongs to whoever owns the ledger, and the bucket is threaded through `on_event` because a
    /// Rust fold cannot hold a second mutable handle on the ledger's graph.
    ///
    /// The invocation is not session state and is reset here anyway: a relog carries it across a
    /// camp, but a new source is a different log being folded from its own beginning.
    pub fn begin_source(&mut self) {
        self.levels.reset();
        self.casters.reset();
        self.debuffs.reset();
        self.contact.reset();
        self.songs.reset();
        self.zone = None;
        self.self_level = None;
        self.cast.reset();
        self.casts.reset();
        self.dot_seen.clear();
        self.deferred = None;
        self.names.reset();
    }

    /// The live tail's heartbeat: settle, never finish. A landing that has waited out its cancel
    /// window is decided and a song pulse that can gain no more witnesses is closed, but a bard
    /// mid-rotation still has an open run, and ending it here would forfeit the interpolation the
    /// next gap is entitled to. Hence `songs.settle` rather than `songs.flush`, which a zone line
    /// does call.
    ///
    /// It is not the persist: the engine's ledger is in memory, and a heartbeat that grew a disk
    /// write would be the engine taking ownership of an artifact the app still owns.
    pub fn settle(&mut self, now: i64, bucket: &mut ResistBucket) {
        self.flush_deferred(now, bucket);
        let mut out = Vec::new();
        self.songs.settle(now, &mut out);
        self.apply_song_out(out, bucket);
    }

    fn on_event(&mut self, ev: &Event, bucket: &mut ResistBucket) {
        self.flush_deferred(ev.ts(), bucket);
        // Two cascades: lines that move the world (where you are, what level you are, which mob is
        // which, which casts are in flight) and lines that are an outcome.
        if self.on_world_event(ev, bucket) {
            return;
        }
        self.on_outcome_event(ev, bucket);
    }

    /// State the outcomes are interpreted against. True when the event was one of these.
    fn on_world_event(&mut self, ev: &Event, bucket: &mut ResistBucket) -> bool {
        match ev.kind_of() {
            Kind::Zone => {
                let zone = ev.str(Key::Zone).unwrap_or_default().to_string();
                self.on_zone(zone, bucket);
                true
            }
            Kind::Level => {
                self.self_level = ev.int(Key::Level);
                true
            }
            Kind::SelfWho => {
                if self.self_level.is_none() {
                    self.self_level = ev.int(Key::Level);
                }
                // The one line in the game that states the loadout, and therefore the only thing
                // that can answer "how many non-hybrid caster classes" for the overchannel adjust.
                self.cast.note_classes(&str_array(ev, Key::Classes));
                true
            }
            Kind::InvocationChange => {
                self.cast
                    .note_invocation(ev.str(Key::Invocation).unwrap_or_default());
                true
            }
            Kind::Consider => {
                let mob = ev.str(Key::Mob).unwrap_or_default().to_string();
                self.names.remember(&mob);
                if let Some(level) = ev.int(Key::Level) {
                    let key = self.names.key(&mob);
                    self.levels.note(&key, level);
                }
                true
            }
            Kind::Death => {
                let key = self.names.key(ev.str(Key::Name).unwrap_or_default());
                self.debuffs.clear_mob(&key);
                // A dead mob stops being a song target immediately (rule 3: alive and in contact).
                // The song itself keeps running, so nothing here touches the reconstruction.
                self.contact.drop_mob(&key);
                true
            }
            Kind::PetClaim | Kind::PetSay => {
                self.casters.note_pet(ev.str(Key::Name).unwrap_or_default());
                true
            }
            Kind::AllyPetLeader => {
                self.casters.note_pet(ev.str(Key::Pet).unwrap_or_default());
                true
            }
            _ => self.on_cast_lifecycle(ev, bucket),
        }
    }

    /// The cast lifecycle: what is in flight, and what stopped being in flight. A fizzle or an
    /// interrupt disarms rather than filing anything — a cast that never happened is not a resist.
    fn on_cast_lifecycle(&mut self, ev: &Event, bucket: &mut ResistBucket) -> bool {
        match ev.kind_of() {
            Kind::CastBegin => {
                let spell = ev.str(Key::Spell).unwrap_or_default().to_string();
                self.on_cast_begin(&spell, ev.ts(), ev.bool(Key::Sung), bucket);
                true
            }
            Kind::OtherCastBegin => {
                let caster = ev.str(Key::Caster).unwrap_or_default().to_string();
                let spell = ev.str(Key::Spell).unwrap_or_default().to_string();
                self.on_other_cast(&caster, &spell, ev.ts());
                true
            }
            Kind::CastFizzle | Kind::CastInterrupted => {
                self.casts
                    .disarm(&spell_canon_key(ev.str(Key::Spell).unwrap_or_default()));
                true
            }
            _ => false,
        }
    }

    /// The lines that state what happened to a spell.
    fn on_outcome_event(&mut self, ev: &Event, bucket: &mut ResistBucket) {
        match ev.kind_of() {
            Kind::Resist => self.on_resist(ev, bucket),
            Kind::Damage => self.on_damage(ev, bucket),
            Kind::Miss => self.on_melee(
                ev.str(Key::Attacker).unwrap_or_default(),
                ev.str(Key::Target).unwrap_or_default(),
                ev.ts(),
            ),
            Kind::BuffApply => {
                let names = candidate_names(ev);
                if ev.str(Key::Target) == Some("self") {
                    self.songs.on_self_landing(ev.ts(), &names);
                } else {
                    let target = ev.str(Key::Target).unwrap_or_default().to_string();
                    self.on_emote(&target, ev.ts(), Some(&names), bucket);
                }
            }
            Kind::Cc | Kind::Charm => {
                let mob = ev.str(Key::Mob).unwrap_or_default().to_string();
                let names = ev.has(Key::Candidates).then(|| candidate_names(ev));
                self.on_emote(&mob, ev.ts(), names.as_deref(), bucket);
            }
            _ => {}
        }
    }

    fn on_zone(&mut self, zone: String, bucket: &mut ResistBucket) {
        self.flush_deferred(i64::MAX, bucket);
        // A zone change is a real discontinuity, so rule 2 extrapolates past nothing. Flushed
        // before the contact map is dropped, because a pulse filed here still asks who was in
        // melee range when it fired.
        let mut out = Vec::new();
        self.songs.flush(&mut out);
        self.apply_song_out(out, bucket);
        self.zone = Some(zone);
        self.debuffs.reset();
        self.contact.reset();
        self.casts.reset();
    }

    /// Melee proximity, which exists for one reader: song rule 3, which needs to know who was in
    /// range when a pulse fired. Not tracked until a song has been seen, because this is the
    /// busiest arm in the fold — two swings a second for hours. The cost is the contact from the
    /// six seconds before a session's first song evidence, which can only under-count a song's
    /// attempts: the direction rule 3 already errs in.
    fn on_melee(&mut self, attacker: &str, target: &str, ts: i64) {
        if !self.songs.active() {
            return;
        }
        if is_self(attacker) {
            self.note_contact(target, ts);
            return;
        }
        if is_self(target) {
            self.note_contact(attacker, ts);
        }
    }

    fn note_contact(&mut self, mob: &str, ts: i64) {
        let key = self.names.key(mob);
        self.contact.note(&key, ts);
        self.names.remember(mob);
    }

    fn on_cast_begin(&mut self, spell: &str, ts: i64, sung: bool, bucket: &mut ResistBucket) {
        let key = spell_canon_key(spell);
        let rank = spell_rank(spell);
        if sung {
            let mut out = Vec::new();
            self.songs.note_sung(&key, ts, &mut out);
            self.apply_song_out(out, bucket);
        }
        self.cast.note_song_rank(&key, rank);
        // A fresh cast re-arms the "first tick counts as a landing" memory for this spell.
        let tail = format!("{SEP}{key}");
        self.dot_seen.retain(|seen| !seen.ends_with(&tail));
        self.casts.arm(Armed {
            spell_key: key,
            display: spell.to_string(),
            ts,
            kind: CasterKind::SelfCast,
            level: self.self_level,
            rank,
            overchannel: self.cast.overchannel(),
            damaged: HashSet::new(),
        });
    }

    fn on_other_cast(&mut self, caster: &str, spell: &str, ts: i64) {
        if self.casters.kind_of(caster) != CasterKind::Pc {
            return;
        }
        self.casts.arm(Armed {
            spell_key: spell_canon_key(spell),
            display: spell.to_string(),
            ts,
            kind: CasterKind::Pc,
            level: None,
            rank: spell_rank(spell),
            // Nothing states a stranger's invocation, ever. Unknowable, and never assumed.
            overchannel: None,
            damaged: HashSet::new(),
        });
    }

    fn on_emote(
        &mut self,
        mob_display: &str,
        ts: i64,
        candidates: Option<&[String]>,
        bucket: &mut ResistBucket,
    ) {
        // A song pulse needs no armed cast: under the Symphonic Aura there is no cast line to arm,
        // and the sentence itself is the landing.
        let mob = self.names.key(mob_display);
        let mut out = Vec::new();
        let handled =
            self.songs
                .on_emote(mob_display, &mob, ts, candidates, self.self_level, &mut out);
        self.apply_song_out(out, bucket);
        if handled {
            return;
        }
        let Some(cast) = self.casts.take(ts, candidates) else {
            return;
        };
        // A buff landed on a groupmate prints the same sentence shape as a debuff on a mob, and
        // filed as a row it becomes a person's name in the ledger. See `world.rs`.
        if !self.targets.is_mob_target(mob_display) {
            return;
        }
        self.names.remember(mob_display);
        let key = self.names.key(mob_display);
        if catalog::is_resist_debuff(&cast.display) {
            self.debuffs.open(&key, &cast.spell_key, ts);
        }
        // One cast is one roll. If this cast already printed damage on this mob, the damage line is
        // the observation and the emote is the same roll saying so twice.
        if cast.damaged.contains(&key) {
            return;
        }
        // Deferred: a damage line for the same mob and spell cancels it.
        self.flush_deferred(i64::MAX, bucket);
        self.deferred = Some(Deferred {
            mob: mob_display.to_string(),
            spell_key: cast.spell_key,
            ts,
            kind: cast.kind,
            level: cast.level,
            rank: cast.rank,
            overchannel: self.cast.invocation_for(cast.kind, Some(cast.overchannel)),
        });
    }

    fn flush_deferred(&mut self, now: i64, bucket: &mut ResistBucket) {
        match &self.deferred {
            None => return,
            Some(d) if now - d.ts <= LAND_DEFER_MS => return,
            Some(_) => {}
        }
        let d = self.deferred.take().expect("checked above");
        // Only your own emote-landings are attributable. A stranger's sentence names no caster, and
        // an npc's cast is never armed in the first place.
        if d.kind != CasterKind::SelfCast {
            return;
        }
        self.row_for(
            bucket,
            &Observation {
                mob: d.mob,
                spell_key: d.spell_key,
                family: Family::Cast,
                kind: d.kind,
                level: d.level,
                ts: d.ts,
                rank: d.rank,
                overchannel: d.overchannel,
            },
        )
        .land += 1;
    }

    fn cancel_deferred(&mut self, mob_display: &str, spell_key: &str) {
        let Some(held) = self
            .deferred
            .as_ref()
            .filter(|d| d.spell_key == spell_key)
            .map(|d| d.mob.clone())
        else {
            return;
        };
        if self.names.key(&held) == self.names.key(mob_display) {
            self.deferred = None;
        }
    }

    fn on_resist(&mut self, ev: &Event, bucket: &mut ResistBucket) {
        // `You resist <mob>'s <Spell>!` is your own resist and a different feature entirely.
        if ev.bool(Key::Incoming) {
            return;
        }
        let target = ev.str(Key::Target).unwrap_or_default().to_string();
        if !self.targets.is_mob_target(&target) {
            return;
        }
        let caster = ev.str(Key::Caster).unwrap_or_default().to_string();
        let kind = self.casters.kind_of(&caster);
        let spell = ev.str(Key::Spell).unwrap_or_default().to_string();
        let spell_key = spell_canon_key(&spell);
        // The resist line is the one outcome line that often prints the rank, so it beats the armed
        // cast rather than falling back to it.
        let line_rank = spell_rank(&spell);
        if kind == CasterKind::SelfCast {
            self.cast.note_song_rank(&spell_key, line_rank);
        }
        self.names.remember(&target);
        let mob = self.names.key(&target);
        let ts = ev.ts();
        let mut out = Vec::new();
        let handled = self.songs.on_resist(
            &target,
            &mob,
            &spell_key,
            kind == CasterKind::SelfCast,
            ts,
            &mut out,
        );
        self.apply_song_out(out, bucket);
        if handled {
            return;
        }
        let level = self.caster_level(kind, &caster);
        let armed = self
            .casts
            .owned_by(kind, &spell_key, ts)
            .map(|a| (a.rank, a.overchannel));
        let overchannel = self.cast.invocation_for(kind, armed.map(|(_, oc)| oc));
        self.row_for(
            bucket,
            &Observation {
                mob: target,
                spell_key,
                family: Family::Cast,
                kind,
                level,
                ts,
                rank: if line_rank > 0 {
                    line_rank
                } else {
                    armed.map_or(0, |(r, _)| r)
                },
                overchannel,
            },
        )
        .resist += 1;
    }

    /// The caster's level, by kind. Self is the session level; another player's is never stated
    /// anywhere this app reads; an NPC's is the same catalog-or-`/con` ladder the target's level
    /// climbs. `None` is a first-class answer and simply drops the row from the fit.
    fn caster_level(&mut self, kind: CasterKind, caster: &str) -> Option<i64> {
        match kind {
            CasterKind::SelfCast => self.self_level,
            CasterKind::Pc => None,
            CasterKind::Npc => {
                let key = self.names.key(caster);
                self.levels.level_of(&key, caster).map(|f| f.level)
            }
        }
    }

    fn on_damage(&mut self, ev: &Event, bucket: &mut ResistBucket) {
        let attacker = ev.str(Key::Attacker).unwrap_or_default().to_string();
        if attacker.is_empty() {
            return;
        }
        let dtype = ev.str(Key::Dtype).unwrap_or_default().to_string();
        let target = ev.str(Key::Target).unwrap_or_default().to_string();
        // A swing either way is melee contact, which is the only proxy for point-blank range a song
        // pulse gets (rule 3). A damage shield firing means the mob hit you, so it counts too.
        if dtype == "melee" || dtype == "ds" {
            self.on_melee(&attacker, &target, ev.ts());
            // The behavioural guard runs whatever the songs are doing: a name you have landed damage
            // on is a mob, and that is what keeps a proper-named guard out of the player roster.
            if is_self(&attacker) {
                self.casters.note_struck(&target);
            }
            return;
        }
        if dtype != "spell" && dtype != "dot" {
            return;
        }
        let kind = self.casters.kind_of(&attacker);
        self.on_spell_damage(ev, &attacker, &target, &dtype, kind, bucket);
    }

    /// A spell or DoT line from somebody this fold is willing to learn from.
    fn on_spell_damage(
        &mut self,
        ev: &Event,
        attacker: &str,
        target: &str,
        dtype: &str,
        kind: CasterKind,
        bucket: &mut ResistBucket,
    ) {
        // Before the target test, not after: this is what makes a proper-named creature you have
        // nuked a creature, and it is the evidence the catalog most often lacks.
        if kind == CasterKind::SelfCast {
            self.casters.note_struck(target);
        }
        if !self.targets.is_mob_target(target) {
            return;
        }
        let skill = ev.str(Key::Skill).unwrap_or_default().to_string();
        let spell_key = spell_canon_key(&skill);
        self.names.remember(target);
        let ts = ev.ts();
        let mut out = Vec::new();
        let handled = self
            .songs
            .on_damage(&spell_key, kind == CasterKind::SelfCast, ts, &mut out);
        self.apply_song_out(out, bucket);
        if handled {
            return;
        }
        self.cancel_deferred(target, &spell_key);
        let target_key = self.names.key(target);
        if let Some(i) = self.casts.peek_at(&spell_key, ts) {
            self.casts.note_damaged(i, target_key);
        }
        let level = self.caster_level(kind, attacker);
        // A damage line almost never prints the rank, so the armed cast is the ordinary source and
        // the line is the rare exception that beats it.
        let line_rank = spell_rank(&skill);
        let armed = self
            .casts
            .owned_by(kind, &spell_key, ts)
            .map(|a| (a.rank, a.overchannel));
        let overchannel = self.cast.invocation_for(kind, armed.map(|(_, oc)| oc));
        let obs = Observation {
            mob: target.to_string(),
            spell_key: spell_key.clone(),
            family: Family::Cast,
            kind,
            level,
            ts,
            rank: if line_rank > 0 {
                line_rank
            } else {
                armed.map_or(0, |(r, _)| r)
            },
            overchannel,
        };
        if dtype == "dot" {
            // The row is minted whether or not the tick counts — see `ledger.rs ResistBucket::row`.
            let key = format!("{}{SEP}{}", self.names.key(target), spell_key);
            let fresh = self.dot_seen.insert(key);
            let row = self.row_for(bucket, &obs);
            if fresh {
                row.land += 1;
            }
        } else {
            let crit = ev.bool(Key::Crit);
            let modifiers = ev.arr_len(Key::Modifiers);
            let amount = ev.int(Key::Amount).unwrap_or(0);
            let row = self.row_for(bucket, &obs);
            // A critical counts as a landing and stays out of the histogram: its number is not the
            // spell's full damage, and would invent a second "full" value to read partials against.
            if crit || modifiers > 0 {
                row.land += 1;
            } else {
                add_damage(row, amount);
            }
        }
    }

    /// Apply what the song half asked for, in the order it asked. `SongOut::Pulse` is rule 3, which
    /// lives here because it needs the world: one reconstructed pulse becomes one attempt against
    /// every mob alive and in melee contact inside the last pulse interval, plus every mob the log
    /// named as resisting it — proof of range no proximity heuristic can improve on.
    fn apply_song_out(&mut self, out: Vec<SongOut>, bucket: &mut ResistBucket) {
        for item in out {
            match item {
                SongOut::File {
                    mob_display,
                    song_key,
                    ts,
                    resisted,
                } => self.file_song(bucket, &mob_display, &song_key, ts, resisted),
                SongOut::Pulse(pulse) => {
                    let mut targets: Vec<String> = self.contact.within(pulse.ts, SONG_CONTACT_MS);
                    for key in &pulse.resisted {
                        if !targets.contains(key) {
                            targets.push(key.clone());
                        }
                    }
                    for key in targets {
                        let display = self.names.display_for(&key);
                        let resisted = pulse.resisted.contains(&key);
                        self.file_song(bucket, &display, &pulse.spell_key, pulse.ts, resisted);
                    }
                }
            }
        }
    }

    /// The row one song pulse belongs to, or nothing when the pulse landed on a person.
    ///
    /// `kind` is always `self` by construction: `SongFold` recognises a song by spell identity and
    /// hands back anything that is not the tailed character's.
    ///
    /// The target test matters most on this arm: a bard's group songs pulse on groupmates and print
    /// a landing sentence naming each of them.
    fn file_song(
        &mut self,
        bucket: &mut ResistBucket,
        mob_display: &str,
        song_key: &str,
        ts: i64,
        resisted: bool,
    ) {
        if !self.targets.is_mob_target(mob_display) {
            return;
        }
        self.names.remember(mob_display);
        let obs = Observation {
            mob: mob_display.to_string(),
            spell_key: song_key.to_string(),
            family: Family::Song,
            kind: CasterKind::SelfCast,
            level: self.self_level,
            ts,
            rank: self.cast.song_rank(song_key),
            // A song is not a cast spell, so the -150 overchannel adjust does not reach it.
            overchannel: Some(false),
        };
        let row = self.row_for(bucket, &obs);
        if resisted {
            row.resist += 1;
        } else {
            row.land += 1;
        }
    }

    fn spec(&mut self, obs: &Observation) -> RowSpec {
        let key = self.names.key(&obs.mob);
        let level = self.levels.level_of(&key, &obs.mob);
        let ranged = level.filter(|l| l.lo != l.hi);
        RowSpec {
            debuffs: self.debuffs.active(&key, obs.ts),
            mob_key: key,
            // Only where it changes `rc`, which is what keeps it out of the key on every ordinary
            // row.
            caster_classes: (obs.overchannel == Some(true)).then(|| self.cast.caster_classes()),
            zone: self.zone.clone(),
            spell_key: obs.spell_key.clone(),
            family: obs.family,
            caster_kind: obs.kind,
            caster_level: obs.level,
            mob_level: level.map(|l| l.level),
            mob_level_lo: ranged.map(|l| l.lo),
            mob_level_hi: ranged.map(|l| l.hi),
            rank: obs.rank,
            overchannel: obs.overchannel,
            // The one key term that is not about `rc`: a row's age, so recent evidence can weigh
            // more than old. Off the log's own clock, never a wall clock — a replay must produce
            // the same ledger twice.
            week: Some(iso_week_key(obs.ts)),
        }
    }

    fn row_for<'b>(
        &mut self,
        bucket: &'b mut ResistBucket,
        obs: &Observation,
    ) -> &'b mut ledger::ResistRow {
        let spec = self.spec(obs);
        bucket.row(spec, obs.ts)
    }
}

fn str_array(ev: &Event, key: Key) -> Vec<String> {
    ev.arr_str(key).into_iter().map(str::to_string).collect()
}

/// The candidate spell names the parser handed over. EQ prints one sentence per spell family, so
/// the parser never claims which one it was.
fn candidate_names(ev: &Event) -> Vec<String> {
    ev.candidate_names(Key::Candidates)
}

/// The EqModule wrapper.
pub struct ResistModule {
    ledger: ResistLedgerStore,
    fold: ResistFold,
    seq: i64,
    source_key: String,
}

impl Default for ResistModule {
    fn default() -> Self {
        Self::new()
    }
}

impl ResistModule {
    pub fn new() -> Self {
        ResistModule {
            ledger: ResistLedgerStore::new(),
            fold: ResistFold::new(),
            seq: 0,
            // The constructed default. `begin_source` names the character whose log is about to be
            // folded; the bench never calls it, so this is the key the goldens were recorded under.
            source_key: "log".to_string(),
        }
    }

    /// Name the character whose log is about to be folded. Discards that character's bucket first,
    /// so re-reading the same log every launch replaces its contribution instead of doubling it.
    ///
    /// The parity bench never calls it, so the source key stays the constructed default there.
    pub fn begin_source(&mut self, key: &str) {
        self.source_key = key.to_string();
        self.ledger.begin_source(key);
        self.fold.begin_source();
    }

    /// Seed the persisted buckets.
    ///
    /// It must run before [`ResistModule::begin_source`], never after: seeding puts every persisted
    /// bucket back and the fold's own source is discarded afterwards by the one call that names it.
    /// Reversed, this run's character would be seeded with counts its own log is about to re-state.
    ///
    /// Nothing in this crate calls it — the one caller is `engined::foldsink`, which is handed the
    /// sources at attach. That is what keeps the parity oracle's world file-free by construction.
    pub fn seed(&mut self, sources: &[ledger_file::LedgerSource]) {
        ledger_file::seed_store(&mut self.ledger, sources);
    }

    /// The user's half of the ledger, as it goes on disk. The shipped baseline's bucket and every
    /// empty bucket are dropped.
    #[must_use]
    pub fn user_ledger_file(&self) -> ledger_file::UserLedgerFile {
        ledger_file::ledger_file_of(&self.ledger)
    }

    /// The pull seam for one creature's level, since this module publishes only counts and has no
    /// cursor to mirror.
    ///
    /// It takes both the key and the display name because the two are used for different things: a
    /// `/con` this session is filed under the folded key, and the committed catalog is looked up
    /// under the name the log spelled. The caller folds the key so one spelling rule serves the
    /// whole engine.
    ///
    /// `&self`, through [`MobLevels::level_of_ref`], for the ingest door's no-mutation law.
    #[must_use]
    pub fn level_of(&self, mob_key: &str, display: &str) -> Option<world::MobLevelFact> {
        self.fold.level_of_ref(mob_key, display)
    }
}

impl EqModule for ResistModule {
    fn id(&self) -> &'static str {
        "resist"
    }

    fn reset(&mut self) {
        self.seq = 0;
        // A fresh fold, and the ledger discards this source's bucket before its log is folded
        // again: the discard is what makes a re-fold idempotent.
        self.fold = ResistFold::new();
        self.ledger.begin_source(&self.source_key);
        self.fold.begin_source();
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        let Self {
            ledger,
            fold,
            source_key,
            ..
        } = self;
        fold.on_event(ev, ledger.bucket_mut(source_key));
    }

    /// See [`ResistFold::settle`].
    ///
    /// `seq` does not move: this module publishes the last event's seq and a settle is not an
    /// event. What it can change is the ledger's row and mob counts.
    fn on_tick(&mut self, now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        let Self {
            ledger,
            fold,
            source_key,
            ..
        } = self;
        fold.settle(now_ms, ledger.bucket_mut(source_key));
    }

    /// The same cursor `snapshot` publishes, without building the state to read it.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        let (rows, mobs) = self.ledger.counts();
        json!({ "seq": self.seq, "state": { "rows": rows, "mobs": mobs } })
    }

    /// The persisted-ledger seams.
    fn as_resist_mut(&mut self) -> Option<&mut ResistModule> {
        Some(self)
    }

    fn as_resist(&self) -> Option<&ResistModule> {
        Some(self)
    }
}
