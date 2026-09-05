//! Bard songs: which spells are songs, which song a landing sentence belongs to, and how a
//! denominator is reconstructed for the ones whose landings the log never prints.
//!
//! A cast rolls resistance once and the log prints the outcome either way. A song re-rolls on every
//! pulse and the log prints only the resists, so a naive denominator reads a song that landed forty
//! times and resisted twice as 100% resisted.
//!
//! Identity, not the begin line, decides what a song is: EQ Legends bards run under the Symphonic
//! Aura, which re-pulses every six seconds with no cast line at all. The owner's 2-million-line log
//! holds five begin-singing lines against 4,152 pulses of one song's landing emote. So a spell only
//! the Bard can learn is a song whether or not the log announced it, and the begin line is a
//! corroborating signal that can only add to the set.
//!
//! Two ways to count attempts, and the first reconstructs nothing:
//!
//!   1. The landing sentence is known. Every pulse that lands prints it and every pulse that misses
//!      prints a resist, so attempts are lands + resists per (song, mob) exactly. The pulse rules
//!      are deliberately not applied on top; they would count the same pulses twice.
//!   2. It is not known. Only then does the reconstruction run, on the witnesses there are: resist
//!      lines, DoT ticks, and the aura's own heartbeat.
//!
//! The pulse interval is 6 seconds, measured: gaps between consecutive resists of one song on one
//! mob are 6, 12, 18 and 24 seconds, never 7, never 9. "Still singing" cannot be read off the cast
//! lines because bards twist — a begin-singing line says one song started and nothing about any
//! other stopping.
//!
//! The four rules:
//!
//!   1. Witnessed. A pulse of song S at t is witnessed iff the log printed, within +-1 s, a resist,
//!      a landing emote or a DoT tick for S on any target.
//!   2. Interpolated. Pulses at t+6k strictly between two witnesses no more than 30 s apart are
//!      counted. Nothing is extrapolated before the first or after the last witness of a run, since
//!      the edges are where "it might have stopped" lives. A begin-singing line inside the gap
//!      re-anchors and the interior pulses before it are dropped: that line proves a restart.
//!   3. In range. A pulse is an attempt against mob M only if M was alive and in melee contact
//!      inside the previous 6 s; bard songs are point-blank and the log states no radius. This file
//!      owns 1 and 2; the fold owns 3, which needs the world.
//!   4. Separable. Songs are their own evidence family, so they can be excluded from R in one place.
//!
//! Which way each is wrong: rule 2 over-counts only if a song stopped and restarted inside a 30 s
//! window without printing a begin line, which the log shows no mechanism for. Rule 3 under-counts
//! attempts on mobs you are not meleeing, biasing R toward "more resistant" — the safe direction.
//!
//! A stranger's songs print a landing sentence naming no caster, so they have no denominator anyone
//! could see. Every arm below answers "handled" for a non-self caster without filing anything.
//!
//! Emissions are handed back to the caller in order rather than through a sink callback, because a
//! Rust module cannot hold a mutable reference back into its caller. The order is the only thing
//! the fold can observe: interpolated pulses precede the witnessed pulse that closed them.

use super::catalog::facts_for_key;
use crate::jsmap::JsMap;
use eqlog::names::spell_canon_key;
use std::collections::{HashMap, HashSet};

/// Measured, not chosen: consecutive song resists on one mob are 6, 12, 18, 24 s apart.
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
    /// The landing sentence is known, so the pulse files directly.
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
    /// Instants the Symphonic Aura stated outright, from the self-landing sentences it prints once
    /// per pulse. Interior pulses snap to these when the gap holds any: a real instant the log
    /// printed beats six-second arithmetic, which drifts as soon as the server tick does.
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
    /// is one pulse.
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

    /// Close any pulse that can no longer gain witnesses, without ending the runs they belong to.
    /// The live tail's heartbeat: a bard mid-rotation has an open pulse and an open run, and ending
    /// the run would forfeit every interpolated pulse across the next gap.
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

    /// The instants strictly inside a gap. The aura's own heartbeat wins where it has anything to
    /// say — those are instants the log printed rather than arithmetic, so they cannot drift
    /// against the server's tick. Six-second stepping is the fallback for a gap with no heartbeat.
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

/// True when the Bard is the only class the catalog says can learn it. "Only" is load-bearing: a
/// handful of lines are shared with other classes and those roll once per cast like anything else.
fn is_song_spell(spell_key: &str) -> bool {
    facts_for_key(spell_key).song
}

/// Does the catalog know a landing sentence? When it does, the denominator is exact and nothing is
/// reconstructed.
fn song_landing_observable(spell_key: &str) -> bool {
    facts_for_key(spell_key).landing
}

/// A song you have not learned yet is not the song you are singing: narrow the candidates by the
/// catalog's bard level against the level the log states for the character.
///
/// Two guards keep it from deciding more than it knows. An unknown level narrows nothing, and a
/// narrowing that would empty the list is discarded whole — a character singing a song the catalog
/// says is above them means the level or the catalog is wrong, and neither is grounds for throwing
/// the observation away.
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

/// Which song a landing sentence belongs to.
///
/// EQ prints one sentence per spell family, so the parser hands over a candidate list: narrow it
/// first by what the character could have learned, then by what the log has named, which for a song
/// is its resist lines. Candidates with nothing to separate them are refused rather than guessed
/// at, because pooling two songs would smear their resist adjusts together.
///
/// The level narrowing comes first because `named` is a running tally that says nothing about the
/// pulses before the log first spelled the song out, while the level is known from the first
/// `/who` and does not move.
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

/// Everything the fold does about songs, in one place.
#[derive(Debug, Default)]
pub struct SongFold {
    pulses: SongPulses,
    /// Songs the log has named in a resist line, newest first. Resolves an ambiguous sentence.
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

    /// The live tail's heartbeat: decide what the passage of wall-clock time has settled, and leave
    /// open what is genuinely still open.
    ///
    /// Unlike `flush` it does not end a run, which is why there are two methods: a bard mid-rotation
    /// has an open pulse and an open run, and ending the run would forfeit every interpolated pulse
    /// across the next gap. A zone line and the end of a profile are real discontinuities and call
    /// `flush`; a heartbeat is not one.
    ///
    /// A historical fold never reaches this, so a golden's world has a song's last open pulse
    /// unclosed and the interpolation leading up to it unemitted.
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
    /// starts by hand, and can only ever add to the set.
    fn is_song(&self, spell_key: &str) -> bool {
        self.sung.contains(spell_key) || is_song_spell(spell_key)
    }

    /// `You begin singing X.` — rare under the aura, and still worth believing when it appears.
    pub fn note_sung(&mut self, spell_key: &str, ts: i64, out: &mut Vec<SongOut>) {
        self.sung.insert(spell_key.to_string());
        self.pulses.note_sing(spell_key, ts, out);
    }

    /// A landing sentence on yourself. When it belongs to a song it is the aura's heartbeat: the
    /// self-landing sentence prints once per pulse whether or not anything was in range, and it is
    /// the only line that states a pulse instant directly.
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
        // A resist line spells the song out, so the key it carries is the answer: no family table
        // sits between the log's word and the ledger's row.
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

    /// A landing sentence naming a mob. Returns true when it belonged to a song — handled or
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
            // Either not a song, or two songs share the sentence and nothing separates them. An
            // ambiguous pulse is refused, and still counts as handled so no cast claims it.
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

    /// A song's own damage line. Where the landing sentence is known, the sentence is the
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
        // The restart re-anchors: the 6 s interior pulse is before it and is dropped.
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
