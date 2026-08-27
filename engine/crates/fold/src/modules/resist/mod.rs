//! `src/main/resist/module.ts` + `fold.ts` — log lines in, POOLED OBSERVATIONS out (JOS-382).
//!
//! ── WHAT THIS MODULE PUBLISHES, AND WHY IT IS TWO INTEGERS ──────────────────────────────────────
//!
//! A PULL, NOT A PUSH. The generic delta transport exists so a renderer can mirror a module's state
//! incrementally; this module's state is a ~700 kB ledger whose only consumer wants ONE mob out of
//! it at a time, on a page the user has to navigate to. So `flush_delta` stays `None`, the mob page
//! asks a separate IPC for exactly what it is about to draw, and `snapshot()` carries COUNTS for
//! diagnostics. The one-transport rule deserves an explicit exception rather than a silent one.
//!
//! Two integers is a tiny published surface and an unforgiving one: `rows` is the number of distinct
//! pooling keys the ledger holds and `mobs` is the number of distinct creatures across them, so the
//! ENTIRE fold has to be exact. Every term of `ledger.rs row_key` is load-bearing — one wrong
//! `mobLevel`, one wrong ISO week, one landing filed that should have been cancelled, and a row
//! splits or merges and the count moves.
//!
//! ── IT DOES NOT RESET AT AN EPOCH BOUNDARY, AND THAT IS DELIBERATE ──────────────────────────────
//!
//! Character-scoped state (loot, kills, leveling) belongs to a character and dies with one. What a
//! mob RESISTS is GAME knowledge, like the mined message overlay and the mined respawn durations,
//! and a rebirth does not unlearn it. The per-character BUCKET still exists, so a re-fold of that
//! character's log replaces its own contribution and nothing else. So there is no `epoch` branch
//! below — the event is folded like any other, and the only thing it moves is `seq`.
//!
//! ── HOW THE GOLDEN'S WORLD WAS CONSTRUCTED ─────────────────────────────────────────────────────
//!
//! `foldArm.mts` builds the module with the WIKI spell catalog and NO ledger seam, so the module
//! makes its own in-memory store with nothing seeded — the shipped `resistBaseline.json` is NOT
//! loaded. It never calls `beginSource`, so the source key stays its constructed default `'log'` and
//! `reset()` opens exactly one bucket. `catalog.rs` carries the argument for how the same three
//! committed catalogs are reached from here.
//!
//! ── NO WALL CLOCK, AND WHAT THAT COSTS THE LEDGER (ruling 18) ───────────────────────────────────
//!
//! The TS module does two things on the registry's 1 s heartbeat: `fold.settle(nowMs)` and, every
//! sixtieth tick, a ledger persist. NEITHER IS PART OF A HISTORICAL FOLD. The registry does not tick
//! during a replay, which is exactly right for the persist (a replay is re-deriving what is already
//! on disk) — and it means the golden was recorded with `settle` NEVER CALLED.
//!
//! Since JOS-481 `on_tick` IS implemented, and it changes none of that: a live tail hands the wall
//! clock in ~1×/sec and `fold_bytes` never does, so a golden's world is still the unsettled one and
//! the end-of-fold state is deliberately:
//!
//!   * A DEFERRED LANDING that arrived within `LAND_DEFER_MS` of the last event is never filed.
//!     `flush_deferred` runs at the top of every event, so a deferred landing only survives to the
//!     end when nothing came more than three seconds after it.
//!   * A SONG'S LAST OPEN PULSE is never closed, so neither it nor the interpolation leading up to
//!     it is emitted. `close_open` is driven by the NEXT witness of that song, by a zone line, or by
//!     `finish()` — and `finish()` is the profile generator's call, not the module's.
//!
//! Both are faithful, both are what the recorded numbers contain, and a port that "helpfully"
//! settled at the end would fail all six slices in the same direction. THE PERSIST IS STILL NOT
//! HERE: the engine's ledger lives in memory and its disk IO is boundary verdict 4's later ticket.
//!
//! ── HOW EACH OUTCOME IS EARNED ─────────────────────────────────────────────────────────────────
//!
//!   RESIST   `<mob> resisted your <Spell>!` — the game saying it flatly. Incoming resists
//!            (`You resist <mob>'s <Spell>!`) are YOURS and out of scope entirely.
//!   DAMAGE   `X hit <mob> for N points of <type> damage by <Spell>.` — the number goes into the
//!            row's histogram, from which the estimator later derives full-versus-partial. A
//!            CRITICAL is counted as a landing and kept OUT of the histogram: its number is not the
//!            spell's full damage, and letting it in would invent a second "full" value.
//!   LAND     the first tick of a DoT after its cast, and a cast-on-other emote joined back to your
//!            own `You begin casting` — but NEVER both for one spell on one mob, because a spell
//!            that both emotes and prints damage produced ONE roll. The emote's landing is therefore
//!            DEFERRED and cancelled by any damage line that follows it for the same mob and spell,
//!            which is the log-only way of saying what the brief says with the client table.
//!   SONG     decided by spell IDENTITY, never by a begin line — `songs.rs` states why at length.
//!            A song is NEVER filed as a cast.
//!
//! ── IT NEVER READS THE CLIENT'S SPELL TABLE ────────────────────────────────────────────────────
//!
//! `spells_us.txt` knows a spell's resist axis, its resist adjust and its level caps. This fold
//! knows none of them, on purpose: everything it writes is something the LOG printed, so the ledger
//! is meaningful without a file this project may not redistribute, a shipped baseline is a
//! table-independent artifact, and a patch that retunes a spell costs a re-ESTIMATE rather than a
//! re-fold of every log the user has ever tailed. The two exclusions the brief asks for therefore
//! live in the estimator, where the facts are.
//!
//! ── OTHER PEOPLE'S CASTS ARE RECORDED, AND NEVER ESTIMATED FROM ────────────────────────────────
//!
//! The owner's ruling admits `self` and `pc` casters; JOS-385 added `npc` — charmed pets and
//! ordinary NPC casters. A stranger's rows carry no level (nothing this app reads states one) and
//! the estimator drops them by design; an npc's level comes off the same catalog-or-`/con` ladder
//! the TARGET's level climbs, so an npc row usually carries both levels and therefore an `rc`.
//!
//! WHAT AN NPC DOES **NOT** GET, deliberately: an armed cast. `on_other_cast` arms `pc` casts only,
//! so an npc's emote-only landing is never claimed. The log carries 45k third-party cast-begins
//! against 25k of yours, and arming all of them would put the join window in contention on every
//! landing sentence YOU earned.
//!
//! ── AND A ROW'S TARGET HAS TO BE A CREATURE ────────────────────────────────────────────────────
//!
//! `world.rs is_mob_target` gates EVERY filing — the resist arm, the damage arm, the emote arm and
//! the song sink. It is newer than the rest (JOS-385) even though it fixes something older: R is a
//! statement about a creature, and while only players could cast, nothing ever checked that the
//! thing being cast ON was one.

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

/// The separator inside every composite key this module builds. A PRINTABLE byte, deliberately:
/// AGENTS.md's rule about raw control bytes in source exists because one makes git classify the file
/// as binary and blame, diff and grep go dark. No EQ mob or spell name has ever contained a pipe.
const SEP: char = '|';

/// Is this name the player? The parser's `norm` produces exactly `You` for every spelling the log
/// uses, so the identity compare answers almost every call and `id_key` (a trim plus a lower-case)
/// is the fallback for the shapes that reach here unnormalised. Worth spelling out because this runs
/// on every melee swing in a two-million-line replay.
fn is_self(name: &str) -> bool {
    name == "You" || id_key(name) == "you"
}

/// One thing the log said, as this fold names it before the bucket pools it.
struct Observation {
    /// The mob's name as the LINE spelled it; the key is folded from it (world-model law 2).
    mob: String,
    spell_key: String,
    family: Family,
    kind: CasterKind,
    /// The CASTER's level, or `None` when nothing has stated it.
    level: Option<i64>,
    ts: i64,
    /// The spell upgrade rank this observation was made at. -15 of resist adjust each (JOS-387).
    rank: i64,
    /// Whether the overchannel invocation was up. Three states — see `cast_state.rs`.
    overchannel: Option<bool>,
}

/// A LANDING WAITING TO SEE WHETHER A DAMAGE LINE CANCELS IT — which is an `Observation` and nothing
/// else, held for `LAND_DEFER_MS` before it is filed. Spelled as the same fields rather than as a
/// near-copy: the two lists had drifted apart once already (the rank and the invocation had to be
/// added to both by JOS-387), and a deferred filing that could carry a different set of facts from
/// an immediate one is a bug with nowhere to be caught. The family is always `cast`: a song pulse is
/// never deferred, because its sentence IS the landing.
struct Deferred {
    mob: String,
    spell_key: String,
    ts: i64,
    kind: CasterKind,
    level: Option<i64>,
    rank: i64,
    overchannel: Option<bool>,
}

/// `resist/fold.ts ResistFold`.
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
    /// The TS keeps this verdict cache at module scope; here it is per-fold, which is the same
    /// answers and nothing outliving a `Fold` (ruling 18).
    targets: TargetVerdicts,
}

impl ResistFold {
    pub fn new() -> Self {
        Self::default()
    }

    /// ONE CREATURE'S LEVEL, FOR A READER (JOS-497 item 1) — `fold.ts levelOf`, whose whole body is
    /// `return this.levels.levelOf(key, display)`.
    ///
    /// The `&self` form, so the ingest's one door can carry it; [`world::MobLevels::level_of_ref`]
    /// is where the argument for the two forms answering identically lives.
    #[must_use]
    pub fn level_of_ref(&self, mob_key: &str, display: &str) -> Option<world::MobLevelFact> {
        self.levels.level_of_ref(mob_key, display)
    }

    /// `ResistFold.beginSource` — start folding a source.
    ///
    /// Over there the ledger's own freshly-discarded bucket is handed IN so the fold writes straight
    /// into it: the DISCARD is what makes a re-fold idempotent and it belongs to whoever owns the
    /// ledger (JOS-231). Here the bucket is threaded through `on_event` instead, for the same reason
    /// and with the same owner — a Rust fold cannot hold a second mutable handle on the ledger's
    /// graph — so what is left of `beginSource` is the SESSION RESET, which is the half that is
    /// about this fold's own state.
    ///
    /// THE INVOCATION IS NOT SESSION STATE and is reset here anyway, which is deliberate: a relog
    /// carries the invocation across a camp and a zone line must not forget it, but a new SOURCE is
    /// a different log being folded from its own beginning.
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

    /// `ResistFold.settle` — the live tail's heartbeat (JOS-481), and the two things it is careful
    /// NOT to be.
    ///
    /// SETTLE, NEVER FINISH: a landing that has waited out its cancel window is decided, and a song
    /// pulse that can gain no more witnesses is closed — but a bard mid-rotation still has an open
    /// RUN, and ending it here would forfeit the interpolation the next gap is entitled to. That is
    /// why this calls `songs.settle` and not `songs.flush`, which a zone line does call.
    ///
    /// AND IT IS NOT THE PERSIST. Over there `onTick` also writes the ledger to disk every sixtieth
    /// beat; the engine's ledger is in memory and its IO is a later ticket (boundary verdict 4, the
    /// cutover ledger's item 6). A heartbeat that quietly grew a disk write here would be the engine
    /// taking ownership of an artifact the app still owns.
    pub fn settle(&mut self, now: i64, bucket: &mut ResistBucket) {
        self.flush_deferred(now, bucket);
        let mut out = Vec::new();
        self.songs.settle(now, &mut out);
        self.apply_song_out(out, bucket);
    }

    fn on_event(&mut self, ev: &Event, bucket: &mut ResistBucket) {
        self.flush_deferred(ev.ts(), bucket);
        // TWO CASCADES, along the seam the module already has: lines that move the WORLD (where you
        // are, what level you are, which mob is which, which casts are in flight) and lines that ARE
        // an outcome. Split because one switch over both is a single method with more branches than
        // the factoring rules allow, and because the two halves are read for different reasons.
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
                // The ONE line in the game that states the loadout, and therefore the only thing
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
                // A dead mob stops being a song target immediately (rule 3: alive AND in contact).
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
    /// interrupt DISARMS rather than filing anything — a cast that never happened is not a resist.
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

    // ---- world housekeeping ---------------------------------------------------------------

    fn on_zone(&mut self, zone: String, bucket: &mut ResistBucket) {
        self.flush_deferred(i64::MAX, bucket);
        // A zone change is a real discontinuity: the song may well have stopped, so rule 2
        // extrapolates past nothing. Flushed BEFORE the contact map is dropped, because a pulse
        // being filed here still asks who was in melee range when it fired.
        let mut out = Vec::new();
        self.songs.flush(&mut out);
        self.apply_song_out(out, bucket);
        self.zone = Some(zone);
        self.debuffs.reset();
        self.contact.reset();
        self.casts.reset();
    }

    /// Melee proximity, which exists for ONE reader: song rule 3, which needs to know who was in
    /// range when a pulse fired. So it is not tracked until a song has been seen — MEASURED, because
    /// this is the busiest arm in the whole fold (two swings a second for hours) and the owner's
    /// two-million-line log contains five sing lines. The priced cost is the contact from the six
    /// seconds before the very first song evidence of a session, which can only UNDER-count a song's
    /// attempts: the safe direction, and the one rule 3 already errs in.
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

    // ---- casts ---------------------------------------------------------------------------

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
        // A SONG PULSE NEEDS NO ARMED CAST, and that is the whole point: under the Symphonic Aura
        // there is no cast line to arm. The sentence itself is the landing.
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
        // A buff you landed on a GROUPMATE prints the same sentence shape as a debuff on a mob, and
        // filed as a row it becomes a person's name in the ledger. See `world.rs`.
        if !self.targets.is_mob_target(mob_display) {
            return;
        }
        self.names.remember(mob_display);
        let key = self.names.key(mob_display);
        if catalog::is_resist_debuff(&cast.display) {
            self.debuffs.open(&key, &cast.spell_key, ts);
        }
        // ONE CAST IS ONE ROLL. If this cast already printed damage on this mob, the damage line IS
        // the observation and the emote is the same roll saying so twice.
        if cast.damaged.contains(&key) {
            return;
        }
        // DEFERRED: a damage line for the same mob and spell cancels it.
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
        // Only YOUR emote-landings are attributable. A stranger's sentence names no caster, and an
        // npc's cast is never armed in the first place.
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

    // ---- outcomes ------------------------------------------------------------------------

    fn on_resist(&mut self, ev: &Event, bucket: &mut ResistBucket) {
        // `You resist <mob>'s <Spell>!` is YOUR resist and a different feature entirely.
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
        // The resist line is the one outcome line that PRINTS the rank (719 of the owner's 3,304
        // do), so it beats the armed cast rather than falling back to it.
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

    /// The CASTER's level, by kind. Self is the session level; another player's is never stated
    /// anywhere this app reads; an NPC's is the same catalog-or-`/con` ladder the target's level
    /// climbs (JOS-385). `None` is a first-class answer and simply drops the row from the fit.
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
        // A swing either way is MELEE CONTACT, which is the only proxy for point-blank range a song
        // pulse gets (rule 3). A damage shield firing means the mob hit you, so it counts too.
        if dtype == "melee" || dtype == "ds" {
            self.on_melee(&attacker, &target, ev.ts());
            // The behavioural guard runs whatever the songs are doing: a name YOU have landed damage
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
        // BEFORE the target test, not after: this is what makes a proper-named creature you have
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
        // A damage line almost never prints the rank (four lines in two million, all Harm Touch), so
        // the armed cast is the ordinary source and the line is the exception that beats it.
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
            // A CRITICAL is counted as a landing and kept OUT of the histogram: its number is not
            // the spell's full damage, and letting it in would invent a second "full" value for the
            // estimator to read partials against.
            if crit || modifiers > 0 {
                row.land += 1;
            } else {
                add_damage(row, amount);
            }
        }
    }

    // ---- songs ---------------------------------------------------------------------------

    /// Apply what the song half asked for, in the order it asked. `SongOut::File` is one `sink`
    /// call; `SongOut::Pulse` is `filePulse` — RULE 3, which lives here because it needs the world:
    /// one reconstructed pulse becomes one attempt against every mob that was alive and in melee
    /// contact inside the last pulse interval, PLUS every mob the log NAMED as resisting it, which
    /// is proof of range no proximity heuristic can improve on.
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

    /// The row one song pulse belongs to, or nothing at all when the pulse landed on a PERSON.
    ///
    /// Songs are never filed as an ordinary cast and NPC casters are never filed as a song:
    /// `SongFold` recognises a song by spell identity and hands back anything that is not the tailed
    /// character's, so `kind` here is always `self` by construction.
    ///
    /// The target test is not decoration on this arm — it is the arm it matters most on. A bard's
    /// group songs pulse on GROUPMATES and print a landing sentence naming each of them, so the
    /// JOS-382 baseline carries a group song filed against five people's names.
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
            // A SONG IS NOT A CAST SPELL, so the wiki's -150 does not reach it (JOS-387). If the
            // owner's log ever shows a song's resist rate moving with the invocation state, that is
            // a finding to report, not a term to model.
            overchannel: Some(false),
        };
        let row = self.row_for(bucket, &obs);
        if resisted {
            row.resist += 1;
        } else {
            row.land += 1;
        }
    }

    // ---- rows ----------------------------------------------------------------------------

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
            // THE ONE KEY TERM THAT IS NOT ABOUT `rc` (JOS-397): a row's age, so recent evidence can
            // weigh more than old. Taken off the LOG's own clock, like every other fact here, and
            // never off a wall clock — a replay must produce the same ledger twice.
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

/// `ev.classes` — the `/who` row's class codes.
fn str_array(ev: &Event, key: Key) -> Vec<String> {
    ev.arr_str(key).into_iter().map(str::to_string).collect()
}

/// `ev.candidates.map((c) => c.name)` — the candidate SPELL NAMES the parser handed over. EQ prints
/// one sentence per spell FAMILY, so the parser never claims which one it was (world-model law 3).
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
            // The constructed default. `beginSource` names the character whose log is about to be
            // folded, and the bench never calls it — so this is the key the golden was recorded
            // under.
            source_key: "log".to_string(),
        }
    }

    /// Name the character whose log is about to be folded. DISCARDS that character's bucket first
    /// (JOS-231), so re-reading the same log every launch REPLACES its contribution instead of
    /// doubling it.
    ///
    /// `pipeline.ts` is the caller; `foldArm.mts` — and therefore every golden — is not, which is
    /// why the source key below stays `'log'` for the whole of a parity run.
    pub fn begin_source(&mut self, key: &str) {
        self.source_key = key.to_string();
        self.ledger.begin_source(key);
        self.fold.begin_source();
    }

    /// SEED THE PERSISTED BUCKETS (JOS-496 item 3) — `store.ts resistLedger()`'s
    /// `for (const src of loadUserSources()) created.bucket(src.key).seed(src.rows)`.
    ///
    /// IT MUST RUN BEFORE [`ResistModule::begin_source`], never after, and the two-call shape is
    /// what makes that orderable at all: seeding puts every persisted bucket back, and the fold's
    /// own source is discarded afterwards by the one call that names it. Reversed, this run's
    /// character would be seeded with the counts its own log is about to re-state — the JOS-231
    /// doubling, on the resist ledger this time.
    ///
    /// NOTHING IN THIS CRATE CALLS IT. `registered()` cannot reach a file and does not know a state
    /// directory exists; the one caller is `engined::foldsink`, which is handed one at attach. That
    /// is the same structural argument `Registry::install_knowledge` makes, and it is what keeps
    /// the six-slice oracle's world file-free by construction rather than by discipline.
    pub fn seed(&mut self, sources: &[ledger_file::LedgerSource]) {
        ledger_file::seed_store(&mut self.ledger, sources);
    }

    /// THE USER'S HALF OF THE LEDGER, as it goes on disk — `store.ts saveUserSources`'s filter and
    /// both of its sort orders. The shipped baseline's bucket and every empty bucket are dropped.
    #[must_use]
    pub fn user_ledger_file(&self) -> ledger_file::UserLedgerFile {
        ledger_file::ledger_file_of(&self.ledger)
    }

    /// THE PULL SEAM FOR ONE CREATURE'S LEVEL (JOS-497 item 1) — `resist/module.ts levelOf`.
    ///
    /// It is the LAST thing `src/main/ipc/resist.ts` still asked the app's own fold synchronously,
    /// and JOS-496 named it in place rather than leaving it: the resist module publishes COUNTS
    /// (`{rows, mobs}`) and nothing else, so there was no op to ask and no cursor to mirror. This is
    /// the op's half.
    ///
    /// IT TAKES BOTH THE KEY AND THE DISPLAY NAME, exactly as the TypeScript does, because the two
    /// are used for different things: a `/con` this session is filed under the folded key, and the
    /// committed catalog is looked up under the name the log spelled. The caller folds the key
    /// (`consider::mob_key`) so that one spelling rule serves the whole engine.
    ///
    /// `&self`, THROUGH [`MobLevels::level_of_ref`], for the ingest door's no-mutation law — that
    /// function carries the argument for why the answer is the same as the fold's own.
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
        // A fresh fold, and the ledger DISCARDS this source's bucket before its log is folded again
        // (JOS-231). The discard is what makes a re-fold idempotent and it belongs to whoever owns
        // the ledger.
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

    /// `resist/module.ts onTick`, minus its second half. See [`ResistFold::settle`] for both.
    ///
    /// `seq` DOES NOT MOVE, exactly as over there: this module publishes the last event's seq, and
    /// a settle is not an event. What it can change is the ledger's row and mob COUNTS, which is
    /// the published state — a deferred landing filed by the passage of time is a row the app would
    /// already be showing.
    fn on_tick(&mut self, now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        let Self {
            ledger,
            fold,
            source_key,
            ..
        } = self;
        fold.settle(now_ms, ledger.bucket_mut(source_key));
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        let (rows, mobs) = self.ledger.counts();
        json!({ "seq": self.seq, "state": { "rows": rows, "mobs": mobs } })
    }

    /// THE PERSISTED-LEDGER SEAMS (JOS-496 item 3). See `EqModule::as_resist_mut`.
    fn as_resist_mut(&mut self) -> Option<&mut ResistModule> {
        Some(self)
    }

    fn as_resist(&self) -> Option<&ResistModule> {
        Some(self)
    }
}
