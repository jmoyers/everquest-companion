//! BARD SONGS: which spells are songs, which song a landing sentence belongs to, and how a
//! denominator is reconstructed for the ones whose landings the log never prints
//! (`src/main/resist/songs.ts`, `songIdentity.ts`, `songFold.ts` — owner ruling 2026-08-16,
//! verbatim: "make sure you can verify the song is running").
//!
//! ── THE PROBLEM ────────────────────────────────────────────────────────────────────────────────
//!
//! A cast rolls resistance ONCE and the log prints the outcome either way. A SONG re-rolls on every
//! pulse and the log prints only the RESISTS. So the naive denominator reads a song that landed
//! forty times and resisted twice as 100% resisted, because thirty-eight of those pulses printed
//! nothing at all — and songs would dominate every bard's profile with a number that is pure
//! artifact.
//!
//! ── AND WHY IDENTITY, NOT THE BEGIN LINE, DECIDES WHAT A SONG IS ────────────────────────────────
//!
//! The first cut asked the log's own `You begin singing` line. That is a perfectly good signal and
//! it is almost never printed: EQ Legends bards run under the SYMPHONIC AURA, which re-pulses every
//! six seconds with NO cast line at all. The owner's 2,013,829-line log contains FIVE begin-singing
//! lines against 4,152 pulses of one song's landing emote. Nothing was ever flagged as a song, no
//! cast was ever armed for an emote to join, and every one of 400 Largo's resists was filed as an
//! ordinary cast with ZERO landings beside it — a spell 100% resisted by construction, dragging
//! magic toward "nearly immune" on every mob a bard ever sang at.
//!
//! So a spell only the Bard can learn IS a song, whether or not the log announced it; the begin
//! line stays a corroborating signal that can only ADD to the set.
//!
//! ── TWO WAYS TO COUNT ATTEMPTS, AND THE FIRST ONE RECONSTRUCTS NOTHING ──────────────────────────
//!
//!   1. THE SENTENCE IS KNOWN (the ordinary case). Every pulse that lands prints the song's
//!      cast-on-other sentence and every pulse that misses prints a resist, so attempts are lands +
//!      resists per (song, mob) EXACTLY. The pulse rules below are deliberately NOT applied on top:
//!      they would count the same pulses twice.
//!   2. THE SENTENCE IS NOT KNOWN. Only then does the reconstruction run, on the witnesses there
//!      are — resist lines, DoT ticks, and the aura's own heartbeat.
//!
//! ── THE MEASUREMENT THE RECONSTRUCTION RESTS ON ─────────────────────────────────────────────────
//!
//! Gaps between consecutive resists of one song on one mob in the owner's log are 6, 12, 18 and 24
//! seconds — never 7, never 9. THE PULSE INTERVAL IS 6 SECONDS. That is what makes interpolation
//! possible at all: between two things the log DID print six seconds apart, exactly zero pulses are
//! missing; twelve seconds apart, exactly one is. And what makes it necessary is that "still
//! singing" cannot be read off the cast lines: bards TWIST, so a begin-singing line says a song
//! started and says nothing about any other song stopping.
//!
//! ── THE FOUR RULES ─────────────────────────────────────────────────────────────────────────────
//!
//!   1. WITNESSED. A pulse of song S at t is witnessed iff the log printed, at t (+-1 s), a resist,
//!      a landing emote or a DoT tick for S on ANY target. Something happened; the song was running.
//!   2. INTERPOLATED. Pulses at t+6k strictly between two witnesses no more than 30 s apart are
//!      counted. NOTHING is extrapolated before the first or after the last witness of a run — the
//!      edges are exactly where "it might have stopped" lives. A begin-singing line inside the gap
//!      RE-ANCHORS and the interior pulses before it are dropped, because that line proves a restart.
//!   3. IN RANGE. A pulse is an attempt against mob M only if M was alive and in MELEE CONTACT
//!      inside the previous 6 s. Bard songs are point-blank area effects and the log states no
//!      radius. (This file owns 1 and 2; the fold owns 3, which needs the world.)
//!   4. SEPARABLE. Songs are their own evidence family in the ledger, so if the numbers ever look
//!      wrong they can be excluded from R in exactly one place.
//!
//! WHICH WAY EACH IS WRONG, because that is the whole argument: rule 2 can OVER-count only if a song
//! stopped and restarted inside a 30 s window without printing a begin line, and the log shows no
//! mechanism that does that. Rule 3 UNDER-counts attempts on rooted or ranged mobs you are not
//! meleeing, which biases R upward, toward "more resistant" — the safe direction, since the cost of
//! that error is being told to use a different spell rather than being told a resistant mob is easy.
//!
//! ── A STRANGER'S SONGS ARE NOT OURS TO READ ─────────────────────────────────────────────────────
//!
//! Another bard's pulses print a landing sentence that names no caster, so their songs have no
//! denominator we could ever see. Filing the resist half alone is the defect this round fixed;
//! refusing the whole spell is the honest half — which is why every arm below answers "handled"
//! for a non-self caster without filing anything.
//!
//! ── AND THE INVERSION THIS PORT MAKES, stated so it is not read as a change ─────────────────────
//!
//! Over there `SongPulses` takes an emit callback and `SongFold` takes a `SongSink` back into the
//! fold. A Rust module cannot hold a mutable reference back into the object that is calling it, so
//! both hand their emissions BACK to the caller in order instead. The order is the only thing the
//! fold can observe, and it is preserved exactly: interpolated pulses before the witnessed pulse
//! that closed them, and one `SongOut` per `sink` call the TS would have made.

use super::catalog::facts_for_key;
use crate::jsmap::JsMap;
use eqlog::names::spell_canon_key;
use std::collections::{HashMap, HashSet};

/// MEASURED, not chosen: consecutive song resists on one mob are 6, 12, 18, 24 s apart.
pub const SONG_PULSE_MS: i64 = 6_000;
/// Two witnesses further apart than this are two runs, and nothing is interpolated between them.
pub const SONG_RUN_GAP_MS: i64 = 30_000;
/// Everything the log prints for one pulse lands inside this window of it.
pub const SONG_WITNESS_JOIN_MS: i64 = 1_000;
/// Rule 3's window: melee contact inside the last pulse interval is "in range".
pub const SONG_CONTACT_MS: i64 = SONG_PULSE_MS;

/// How many aura heartbeat instants to remember. A run is 30 s, so five pulses is plenty.
const HEARTBEAT_MEMORY: usize = 32;

/// One reconstructed pulse. `witnessed: false` means rule 2 put it there.
#[derive(Debug, Clone)]
pub struct SongPulse {
    pub spell_key: String,
    pub ts: i64,
    pub witnessed: bool,
    /// Mobs the log named as resisting this pulse. Empty for an interpolated pulse, always.
    pub resisted: Vec<String>,
}

/// What the song half asks the fold to do, in the order the TS's sink would have been called.
#[derive(Debug, Clone)]
pub enum SongOut {
    /// `sink.land` / `sink.resist` — the landing sentence is known, so the pulse files directly.
    File {
        mob_display: String,
        song_key: String,
        ts: i64,
        resisted: bool,
    },
    /// A reconstructed pulse, to be spread over the mobs rule 3 admits.
    Pulse(SongPulse),
}

#[derive(Debug, Default, Clone, Copy)]
struct Run {
    /// The last witnessed pulse's instant, or `None` when no run is open.
    last_witness: Option<i64>,
    /// A begin-singing line inside the current gap, which re-anchors interpolation.
    reanchor: Option<i64>,
}

#[derive(Debug)]
struct Open {
    ts: i64,
    resisted: Vec<String>,
}

/// Reconstructs song pulses from what the log printed. Feed it witnesses in timestamp order; it
/// hands back every pulse it can justify, in order, once it is sure of them.
#[derive(Debug, Default)]
struct SongPulses {
    runs: HashMap<String, Run>,
    open: JsMap<Open>,
    /// Instants the SYMPHONIC AURA stated outright, from the self-landing sentences it prints once
    /// per pulse. Interior pulses snap to these when the gap contains any: a real instant the log
    /// printed beats six-second arithmetic from the last witness, which drifts as soon as the
    /// server tick does.
    beats: Vec<i64>,
}

impl SongPulses {
    fn reset(&mut self) {
        self.runs.clear();
        self.open.clear();
        self.beats.clear();
    }

    /// The aura printed one of its own landing sentences: a pulse happened at `ts`.
    fn note_heartbeat(&mut self, ts: i64) {
        if let Some(&last) = self.beats.last() {
            if ts - last < SONG_WITNESS_JOIN_MS {
                return;
            }
        }
        self.beats.push(ts);
        if self.beats.len() > HEARTBEAT_MEMORY {
            self.beats.drain(0..self.beats.len() - HEARTBEAT_MEMORY);
        }
    }

    /// `You begin singing S` — a restart, which drops interpolation across the gap it sits in.
    fn note_sing(&mut self, spell_key: &str, ts: i64, out: &mut Vec<SongOut>) {
        self.close_open(spell_key, ts, out);
        self.run(spell_key).reanchor = Some(ts);
    }

    /// The log printed something for song S at `ts`: a resist naming `mob_key`, or a landing/tick
    /// naming nobody in particular. Everything inside `SONG_WITNESS_JOIN_MS` of the first such line
    /// is ONE pulse.
    fn witness(&mut self, spell_key: &str, ts: i64, mob_key: Option<&str>, out: &mut Vec<SongOut>) {
        if let Some(open) = self.open.get_mut(spell_key) {
            if ts - open.ts <= SONG_WITNESS_JOIN_MS {
                if let Some(mob) = mob_key {
                    if !open.resisted.iter().any(|k| k == mob) {
                        open.resisted.push(mob.to_string());
                    }
                }
                return;
            }
        }
        self.close_open(spell_key, ts, out);
        let mut fresh = Open {
            ts,
            resisted: Vec::new(),
        };
        if let Some(mob) = mob_key {
            fresh.resisted.push(mob.to_string());
        }
        self.open.insert(spell_key.to_string(), fresh);
    }

    /// Close any pulse that can no longer gain witnesses, WITHOUT ending the runs they belong to.
    /// This is what the live tail calls on its heartbeat: a bard mid-rotation has an open pulse and
    /// an open run, and ending the run would forfeit every interpolated pulse across the next gap.
    fn settle(&mut self, now: i64, out: &mut Vec<SongOut>) {
        let keys: Vec<String> = self.open.iter().map(|(k, _)| k.to_string()).collect();
        for key in keys {
            self.close_open(&key, now, out);
        }
    }

    /// End everything: close the buffered pulses AND end every run, so nothing is interpolated
    /// across the boundary. A zone change and the end of a fold are both real discontinuities.
    fn flush(&mut self, out: &mut Vec<SongOut>) {
        self.settle(i64::MAX, out);
        self.runs.clear();
    }

    fn run(&mut self, spell_key: &str) -> &mut Run {
        self.runs.entry(spell_key.to_string()).or_default()
    }

    /// Close the buffered pulse: interpolate back to the previous witness if the gap allows, then
    /// emit the witnessed pulse itself. `now` is only used to decide whether the buffer is stale.
    fn close_open(&mut self, spell_key: &str, now: i64, out: &mut Vec<SongOut>) {
        let Some(open) = self.open.get(spell_key) else {
            return;
        };
        if now - open.ts <= SONG_WITNESS_JOIN_MS {
            return;
        }
        let ts = open.ts;
        let resisted = open.resisted.clone();
        self.open.remove(spell_key);
        self.interpolate(spell_key, ts, out);
        out.push(SongOut::Pulse(SongPulse {
            spell_key: spell_key.to_string(),
            ts,
            witnessed: true,
            resisted,
        }));
        let run = self.run(spell_key);
        run.last_witness = Some(ts);
        run.reanchor = None;
    }

    /// Rule 2, in full: the interior pulses of one gap, minus anything before a restart.
    fn interpolate(&mut self, spell_key: &str, ts: i64, out: &mut Vec<SongOut>) {
        let run = *self.run(spell_key);
        let Some(prev) = run.last_witness else {
            return;
        };
        if ts - prev > SONG_RUN_GAP_MS {
            return;
        }
        let floor = run.reanchor.unwrap_or(prev);
        for at in self.interior_pulses(prev, ts) {
            if at <= floor {
                continue;
            }
            out.push(SongOut::Pulse(SongPulse {
                spell_key: spell_key.to_string(),
                ts: at,
                witnessed: false,
                resisted: Vec::new(),
            }));
        }
    }

    /// The instants strictly inside a gap. THE AURA'S OWN HEARTBEAT WINS where it has anything to
    /// say: those are instants the log PRINTED rather than arithmetic, so they cannot drift against
    /// the server's tick. Six-second stepping is the fallback for a run with no heartbeat in it.
    fn interior_pulses(&self, prev: i64, ts: i64) -> Vec<i64> {
        let beats: Vec<i64> = self
            .beats
            .iter()
            .copied()
            .filter(|&b| b > prev + SONG_WITNESS_JOIN_MS && b < ts - SONG_WITNESS_JOIN_MS)
            .collect();
        if !beats.is_empty() {
            return beats;
        }
        let mut at = prev + SONG_PULSE_MS;
        let mut all = Vec::new();
        while at < ts - SONG_WITNESS_JOIN_MS {
            all.push(at);
            at += SONG_PULSE_MS;
        }
        all
    }
}

/// `songIdentity.ts isSongSpell` — true when the Bard is the ONLY class the catalog says can learn
/// it. "Only" is load-bearing: a handful of lines are shared with other classes and those roll once
/// per cast like anything else.
fn is_song_spell(spell_key: &str) -> bool {
    facts_for_key(spell_key).song
}

/// `songIdentity.ts songLandingObservable` — does the catalog know a landing sentence? When it does,
/// the denominator is exact and nothing is reconstructed.
fn song_landing_observable(spell_key: &str) -> bool {
    facts_for_key(spell_key).landing
}

/// `songIdentity.ts learnable` — A SONG YOU HAVE NOT LEARNED YET IS NOT THE SONG YOU ARE SINGING
/// (JOS-384).
///
/// This replaced a hard-coded pair of spell names. It is a FACT the catalog already states — the
/// bard level of the line — read against the level the log states for the character. Two guards keep
/// it from deciding more than it knows: an UNKNOWN level narrows nothing, and a narrowing that would
/// empty the list is discarded whole, because a character singing a song the catalog says is above
/// them means the level is wrong or the catalog is, and neither is grounds for throwing the
/// observation away.
fn learnable(keys: Vec<String>, caster_level: Option<i64>) -> Vec<String> {
    let Some(level) = caster_level else {
        return keys;
    };
    let kept: Vec<String> = keys
        .iter()
        .filter(|k| facts_for_key(k).learned_at.is_none_or(|at| at <= level))
        .cloned()
        .collect();
    if kept.is_empty() {
        keys
    } else {
        kept
    }
}

/// `songIdentity.ts resolveSongEmote` — WHICH song a landing sentence belongs to.
///
/// EQ prints ONE sentence per spell FAMILY (world-model law 3), so the parser hands over a candidate
/// LIST and the model resolves it: first against what the CHARACTER could have learned, then against
/// what the log has NAMED, which for a song is its resist lines. Several candidates with nothing to
/// separate them are REFUSED rather than guessed at — pooling two songs would smear their resist
/// adjusts together, and a -100 proc adjust is exactly the thing this model exists to take out.
///
/// THE ORDER OF THE TWO NARROWINGS IS NOT ARBITRARY. `named` is the stronger evidence and would be
/// first if it were always THERE — but it is a running tally, so it says nothing about the pulses
/// before the log first spelled the song out, and on the owner's log that is 35 landings. The level
/// is known from the first `/who` and does not move, so it covers the opening of a session and
/// `named` decides everything the level cannot.
fn resolve_song_emote(
    candidates: &[String],
    named: &[String],
    caster_level: Option<i64>,
) -> Option<String> {
    let mut songs: Vec<String> = Vec::new();
    for name in candidates {
        let key = spell_canon_key(name);
        if is_song_spell(&key) {
            songs.push(key);
        }
    }
    if songs.is_empty() {
        return None;
    }
    let mut unique: Vec<String> = Vec::new();
    for key in songs {
        if !unique.contains(&key) {
            unique.push(key);
        }
    }
    let unique = learnable(unique, caster_level);
    if unique.len() == 1 {
        return Some(unique[0].clone());
    }
    for key in named {
        if unique.contains(key) {
            return Some(key.clone());
        }
    }
    None
}

/// `songFold.ts SongFold` — everything the fold does about songs, in one place.
#[derive(Debug, Default)]
pub struct SongFold {
    pulses: SongPulses,
    /// Songs the log has NAMED in a resist line, newest first. Resolves an ambiguous sentence.
    named: Vec<String>,
    /// Per mob: the songs a resist line named there. The better half of the same resolution.
    named_by_mob: HashMap<String, Vec<String>>,
    /// Songs a begin-singing line announced. Additive only; identity is the real answer.
    sung: HashSet<String>,
}

impl SongFold {
    pub fn reset(&mut self) {
        self.pulses.reset();
        self.named.clear();
        self.named_by_mob.clear();
        self.sung.clear();
    }

    /// `SongFold.settle` — THE LIVE TAIL'S HEARTBEAT (JOS-481): decide what the passage of
    /// WALL-CLOCK time has settled, and leave open what is genuinely still open.
    ///
    /// UNLIKE `flush` IT DOES NOT END A RUN, and that difference is the whole reason there are two
    /// methods: a bard mid-rotation has an open pulse and an open run, and ending the run would
    /// forfeit every interpolated pulse across the next gap. A zone line and the end of a profile
    /// are real discontinuities and call `flush`; a heartbeat is not one.
    ///
    /// A HISTORICAL FOLD NEVER REACHES THIS, so the six goldens are still what a world with settle
    /// never called produces — a song's last open pulse unclosed, and the interpolation leading up
    /// to it unemitted, exactly as this module's header records.
    pub fn settle(&mut self, now: i64, out: &mut Vec<SongOut>) {
        self.pulses.settle(now, out);
    }

    pub fn flush(&mut self, out: &mut Vec<SongOut>) {
        self.pulses.flush(out);
    }

    /// True once any song has been seen; the fold uses it to skip melee-contact bookkeeping.
    pub fn active(&self) -> bool {
        !self.named.is_empty() || !self.sung.is_empty()
    }

    /// A song, by identity. A begin-singing line is a corroborating signal for the rare song a bard
    /// starts by hand, and can only ever ADD to the set.
    fn is_song(&self, spell_key: &str) -> bool {
        self.sung.contains(spell_key) || is_song_spell(spell_key)
    }

    /// `You begin singing X.` — rare under the aura, and still worth believing when it appears.
    pub fn note_sung(&mut self, spell_key: &str, ts: i64, out: &mut Vec<SongOut>) {
        self.sung.insert(spell_key.to_string());
        self.pulses.note_sing(spell_key, ts, out);
    }

    /// A landing sentence on YOURSELF. When it belongs to a song it is the aura's HEARTBEAT:
    /// `Your feet move faster.` prints 6,966 times in the owner's log, once per pulse, whether or
    /// not anything was in range. It is the only line that states a pulse instant directly.
    pub fn on_self_landing(&mut self, ts: i64, candidates: &[String]) {
        for name in candidates {
            if !self.is_song(&spell_canon_key(name)) {
                continue;
            }
            self.pulses.note_heartbeat(ts);
            return;
        }
    }

    /// A resist line naming a song. Returns false when it was not a song at all.
    pub fn on_resist(
        &mut self,
        mob_display: &str,
        mob_key: &str,
        spell_key: &str,
        is_self: bool,
        ts: i64,
        out: &mut Vec<SongOut>,
    ) -> bool {
        if !self.is_song(spell_key) {
            return false;
        }
        if !is_self {
            return true;
        }
        // A resist line SPELLS THE SONG OUT, so the key it carries is the answer — there is no
        // family table between the log's word and the ledger's row (JOS-384).
        self.note_named(mob_key, spell_key);
        if song_landing_observable(spell_key) {
            out.push(SongOut::File {
                mob_display: mob_display.to_string(),
                song_key: spell_key.to_string(),
                ts,
                resisted: true,
            });
        } else {
            self.pulses.witness(spell_key, ts, Some(mob_key), out);
        }
        true
    }

    /// A landing sentence naming a mob. Returns true when it belonged to a song — handled OR
    /// refused, because either way no armed cast may claim it afterwards.
    pub fn on_emote(
        &mut self,
        mob_display: &str,
        mob_key: &str,
        ts: i64,
        candidates: Option<&[String]>,
        caster_level: Option<i64>,
        out: &mut Vec<SongOut>,
    ) -> bool {
        let Some(candidates) = candidates else {
            return false;
        };
        if candidates.is_empty() {
            return false;
        }
        let named = self.named_for(mob_key);
        let Some(song_key) = resolve_song_emote(candidates, &named, caster_level) else {
            // Either not a song, or two songs share the sentence and nothing separates them.
            // Pooling two songs would smear their resist adjusts together, so an ambiguous pulse is
            // refused — and still counts as handled, so no cast claims the sentence either.
            return candidates.iter().any(|c| self.is_song(&spell_canon_key(c)));
        };
        if song_landing_observable(&song_key) {
            out.push(SongOut::File {
                mob_display: mob_display.to_string(),
                song_key,
                ts,
                resisted: false,
            });
        } else {
            self.pulses.witness(&song_key, ts, None, out);
        }
        true
    }

    /// A song's own damage line. Where the landing sentence is known, the SENTENCE is the
    /// observation and the tick is the same pulse printing twice. Where it is not, the tick is one
    /// of the few witnesses there are.
    pub fn on_damage(
        &mut self,
        spell_key: &str,
        is_self: bool,
        ts: i64,
        out: &mut Vec<SongOut>,
    ) -> bool {
        if !self.is_song(spell_key) {
            return false;
        }
        if !is_self {
            return true;
        }
        if !song_landing_observable(spell_key) {
            self.pulses.witness(spell_key, ts, None, out);
        }
        true
    }

    fn note_named(&mut self, mob_key: &str, song_key: &str) {
        let mut next = vec![song_key.to_string()];
        next.extend(self.named.iter().filter(|k| *k != song_key).cloned());
        next.truncate(8);
        self.named = next;
        let here = self.named_by_mob.entry(mob_key.to_string()).or_default();
        let mut mine = vec![song_key.to_string()];
        mine.extend(here.iter().filter(|k| *k != song_key).cloned());
        mine.truncate(4);
        *here = mine;
    }

    fn named_for(&self, mob_key: &str) -> Vec<String> {
        let mut out: Vec<String> = self.named_by_mob.get(mob_key).cloned().unwrap_or_default();
        out.extend(self.named.iter().cloned());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pulses(out: &[SongOut]) -> Vec<(i64, bool)> {
        out.iter()
            .filter_map(|o| match o {
                SongOut::Pulse(p) => Some((p.ts, p.witnessed)),
                SongOut::File { .. } => None,
            })
            .collect()
    }

    #[test]
    fn a_twelve_second_gap_interpolates_exactly_one_pulse_and_a_restart_drops_it() {
        let mut p = SongPulses::default();
        let mut out = Vec::new();
        p.witness("largo's melodic binding", 0, Some("a rat"), &mut out);
        p.witness("largo's melodic binding", 12_000, Some("a rat"), &mut out);
        // Closing the first pulse emitted it; the interpolated 6 s pulse waits for the second close.
        p.flush(&mut out);
        assert_eq!(
            pulses(&out),
            vec![(0, true), (6_000, false), (12_000, true)]
        );

        let mut p = SongPulses::default();
        let mut out = Vec::new();
        p.witness("largo's melodic binding", 0, None, &mut out);
        p.note_sing("largo's melodic binding", 7_000, &mut out);
        p.witness("largo's melodic binding", 12_000, None, &mut out);
        p.flush(&mut out);
        // The restart re-anchors: the 6 s interior pulse is BEFORE it and is dropped.
        assert_eq!(pulses(&out), vec![(0, true), (12_000, true)]);
    }

    #[test]
    fn nothing_is_interpolated_across_a_gap_longer_than_a_run() {
        let mut p = SongPulses::default();
        let mut out = Vec::new();
        p.witness("s", 0, None, &mut out);
        p.witness("s", SONG_RUN_GAP_MS + 6_000, None, &mut out);
        p.flush(&mut out);
        assert_eq!(
            pulses(&out),
            vec![(0, true), (SONG_RUN_GAP_MS + 6_000, true)]
        );
    }

    #[test]
    fn the_auras_heartbeat_beats_six_second_arithmetic_inside_a_gap() {
        let mut p = SongPulses::default();
        let mut out = Vec::new();
        p.note_heartbeat(5_500);
        p.witness("s", 0, None, &mut out);
        p.witness("s", 12_000, None, &mut out);
        p.flush(&mut out);
        // 5,500 — the instant the log printed — rather than the arithmetic 6,000.
        assert_eq!(
            pulses(&out),
            vec![(0, true), (5_500, false), (12_000, true)]
        );
    }

    #[test]
    fn everything_inside_one_second_of_a_witness_is_the_same_pulse() {
        let mut p = SongPulses::default();
        let mut out = Vec::new();
        p.witness("s", 0, Some("a rat"), &mut out);
        p.witness("s", 800, Some("a bat"), &mut out);
        p.flush(&mut out);
        let SongOut::Pulse(pulse) = &out[0] else {
            panic!("a pulse");
        };
        assert_eq!(
            pulse.resisted,
            vec!["a rat".to_string(), "a bat".to_string()]
        );
        assert_eq!(out.len(), 1);
    }
}
