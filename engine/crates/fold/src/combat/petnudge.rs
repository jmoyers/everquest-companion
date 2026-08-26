//! THE NUDGE FOR A PET THE METER CANNOT SEE — `src/main/combat/petNudge.ts` (JOS-258).
//!
//! THE REPORT (0.23.0): a player swapped Monk/Shaman/Enchanter for Monk/Shaman/Magician and their
//! pet's damage vanished from the meter. There was no regression to fix — the combat engine has no
//! class gating and receives no loadout signal at all. It is JOS-49's ACCEPTED blind spot arriving in
//! the wild: a charmed pet binds off its own broadcast, but a SUMMONED pet binds only when the player
//! does something (order it once, ask `/pet who leader`, or land a pet-only buff on it — the three
//! routes `bind_pet_claim` collects), and a never-ordered auto-assisting pet matches none of them, so
//! its damage is dropped at routing.
//!
//! THE OWNER'S RULING (2026-08-12) was the honest stopgap rather than reopening JOS-49 —
//! auto-adopting the first unknown attacker after a summon is EXACTLY the detector that ruling cut —
//! and the ruling is a SHAPE as much as a feature. Verbatim: a simple nudge, not overly wordy;
//! rendered on the meter's own content background; it appears only for a time after summoning and
//! then TIMES OUT. Staleness or repetition is wrong: no persistent banner, no re-showing for the same
//! pet, no nagging.
//!
//! SO THE WHOLE MODULE IS A TIMEOUT, and every constant keeps one of those promises:
//!
//!   GRACE   a bind that arrives promptly must never draw a nudge at all. The commonest magician and
//!           necromancer sequence is summon → buff the pet → bound, and the `p2` fixture measures it
//!           at SIX SECONDS. A nudge drawn at the cast and yanked six seconds later is a flicker.
//!   SHOW    how long it then stays up. Tens of seconds, by the ruling.
//!   QUIET   what stops it nagging. Once a nudge has been shown and TIMED OUT unheeded the player has
//!           read it and chosen not to act; another summon does not get to say it again for a good
//!           while. A nudge that ended because the pet BOUND is not covered by this — that one
//!           worked, and a genuinely new unbound pet later is a new question.
//!
//! ONE SLOT, which is what makes it once-per-summon-BURST rather than once-per-line: while an arm is
//! live, further summon casts change nothing (chain-summoning cannot stack nudges), and the arm is
//! cleared by a bind, by the timeout, or by the summon cast failing to resolve.
//!
//! PURE + CLOCK-INJECTED, `charm.rs`'s rule: no wall clock, no engine state, no I/O. Every method
//! takes the timestamp it is reasoning at, so the ONLY thing that decides whether a nudge is on
//! screen is arithmetic over two numbers.
//!
//! ── WHY THIS FILE EXISTS NOW, AND WHAT IT REPLACES (JOS-488) ───────────────────────────────────
//!
//! It was PORTED BY PROOF OF ABSENCE until this ticket: the arm is gated on `!hydrating`, a
//! historical fold never leaves hydration, so `view(now)` answered nothing in every state it could
//! reach and the goldens carry no `combat.petNudge` key. That proof still holds for the ORACLE — the
//! parity/golden path never goes live — and it stops covering a LIVE engine the moment `set_live()`
//! has a caller. So the model is real code and the absence is now proven by the gate rather than by
//! the gate's unreachability.

use serde::Serialize;

/// How long a summon has to produce a bind before the player is told anything. See the header: the
/// measured fast path binds in six seconds, and a nudge that argues with it is noise.
pub const NUDGE_GRACE_MS: i64 = 10_000;

/// How long the nudge is then on screen. The ruling's "for a time … and then TIMES OUT".
pub const NUDGE_SHOW_MS: i64 = 45_000;

/// How long after a nudge has been shown and IGNORED before another summon may raise one.
///
/// The anti-nagging clause and nothing else. A player who chain-summons without ever ordering the pet
/// has already read the sentence; repeating it every time is the "repetition is wrong" half of the
/// ruling. Five minutes is long enough that the next nudge is about a new session's worth of play
/// rather than about the same decision.
pub const NUDGE_QUIET_MS: i64 = 300_000;

/// `shared/combat.ts PetSummonNudge` — what the snapshot carries when there is a nudge to carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSummonNudge {
    pub summoned_ts: i64,
    pub expires_ts: i64,
}

/// The one-slot state machine. It knows two facts: the timestamp of the summon cast currently
/// awaiting a bind, and the timestamp at which a SHOWN nudge last timed out unheeded.
#[derive(Debug, Default)]
pub struct PetNudgeState {
    /// The summon cast waiting on a bind, or `None` when nothing is armed.
    armed_ts: Option<i64>,
    /// When a nudge last came off the screen having been ignored. 0 = never.
    last_ignored_ts: i64,
}

impl PetNudgeState {
    #[must_use]
    pub fn new() -> Self {
        PetNudgeState::default()
    }

    pub fn reset(&mut self) {
        self.armed_ts = None;
        self.last_ignored_ts = 0;
    }

    /// `You begin casting <a pet summon>.` — the line only the player prints.
    ///
    /// Refuses in two cases, which together are the whole of "once per summon burst, no nagging":
    /// something is already armed (a chain of summons is ONE question), or a nudge was shown and
    /// ignored inside `NUDGE_QUIET_MS`.
    pub fn note_summon_cast(&mut self, ts: i64) {
        if self.armed_ts.is_some() {
            return;
        }
        if self.last_ignored_ts > 0 && ts - self.last_ignored_ts < NUDGE_QUIET_MS {
            return;
        }
        self.armed_ts = Some(ts);
    }

    /// The summon cast never resolved (fizzle / interrupt), so there is no pet to talk about.
    ///
    /// The same argument `charm.rs` makes about an armed charm, and it errs toward SILENCE: an
    /// interrupted summon that the player then RESUMES loses its nudge, because `castResumed` names
    /// no spell and re-deriving one would be a guess. A missed hint is the cheap direction; a nudge
    /// about a pet that was never summoned is exactly the staleness the ruling forbids.
    pub fn note_cast_failed(&mut self) {
        self.armed_ts = None;
    }

    /// A pet bound (any of the three claim routes). The nudge's whole question is answered, so it
    /// dismisses EARLY and — deliberately — does not count as ignored: a player who acted on it is
    /// not the player `NUDGE_QUIET_MS` exists to protect.
    pub fn note_bound(&mut self) {
        self.armed_ts = None;
    }

    /// Retire an arm whose window has fully elapsed. Driven from the event stream AND from
    /// `snapshot(now)`, whichever observes the deadline first — the `sweep_charm` pattern, for the
    /// same reason: the log can go quiet for minutes and a screen must not.
    ///
    /// Only an arm that was actually SHOWN records an ignored nudge. An arm cannot expire unshown
    /// (GRACE < GRACE + SHOW), but saying it in the code keeps the quiet period tied to what the
    /// player saw rather than to what the engine armed.
    pub fn sweep(&mut self, now: i64) {
        let Some(armed) = self.armed_ts else { return };
        let elapsed = now - armed;
        if elapsed < NUDGE_GRACE_MS + NUDGE_SHOW_MS {
            return;
        }
        if elapsed >= NUDGE_GRACE_MS {
            self.last_ignored_ts = armed + NUDGE_GRACE_MS + NUDGE_SHOW_MS;
        }
        self.armed_ts = None;
    }

    /// What the snapshot carries: the nudge, or nothing at all.
    ///
    /// `None` in every state but one — nothing armed, still inside the grace, or past the timeout —
    /// which is what makes "no persistent banner" structural rather than a promise the renderer has
    /// to keep.
    #[must_use]
    pub fn view(&self, now: i64) -> Option<PetSummonNudge> {
        let armed = self.armed_ts?;
        let elapsed = now - armed;
        // `elapsed < GRACE || elapsed >= GRACE + SHOW` over there, and the half-open range is the
        // same two boundaries: the grace instant DRAWS the nudge and the expiry instant does not.
        if !(NUDGE_GRACE_MS..NUDGE_GRACE_MS + NUDGE_SHOW_MS).contains(&elapsed) {
            return None;
        }
        Some(PetSummonNudge {
            summoned_ts: armed,
            expires_ts: armed + NUDGE_GRACE_MS + NUDGE_SHOW_MS,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three windows, in order: nothing during the grace, the nudge during the show, nothing
    /// after the timeout. Every boundary is stated because every one of them is a `<` or a `>=` the
    /// TypeScript picked deliberately.
    #[test]
    fn the_nudge_is_absent_before_the_grace_and_after_the_show() {
        let mut n = PetNudgeState::new();
        n.note_summon_cast(1_000);
        assert_eq!(n.view(1_000), None, "nothing at the cast");
        assert_eq!(
            n.view(1_000 + NUDGE_GRACE_MS - 1),
            None,
            "nothing one ms before the grace closes"
        );
        assert_eq!(
            n.view(1_000 + NUDGE_GRACE_MS),
            Some(PetSummonNudge {
                summoned_ts: 1_000,
                expires_ts: 1_000 + NUDGE_GRACE_MS + NUDGE_SHOW_MS,
            })
        );
        assert!(n.view(1_000 + NUDGE_GRACE_MS + NUDGE_SHOW_MS - 1).is_some());
        assert_eq!(
            n.view(1_000 + NUDGE_GRACE_MS + NUDGE_SHOW_MS),
            None,
            "the expiry instant itself is off the screen"
        );
    }

    /// A BIND ANSWERS IT AND COSTS NOTHING. The arm clears, nothing was ignored, and the very next
    /// summon may raise a nudge of its own — which is the difference between this and the timeout.
    #[test]
    fn a_bind_dismisses_the_nudge_and_does_not_start_the_quiet_period() {
        let mut n = PetNudgeState::new();
        n.note_summon_cast(1_000);
        n.note_bound();
        assert_eq!(n.view(1_000 + NUDGE_GRACE_MS), None);
        n.note_summon_cast(2_000);
        assert!(n.view(2_000 + NUDGE_GRACE_MS).is_some(), "a new question");
    }

    /// …and a nudge that TIMED OUT unheeded silences the next summon for `NUDGE_QUIET_MS` measured
    /// from the moment it left the screen, not from the cast that raised it.
    #[test]
    fn an_ignored_nudge_silences_the_next_summon_for_the_quiet_period() {
        let mut n = PetNudgeState::new();
        n.note_summon_cast(1_000);
        let gone = 1_000 + NUDGE_GRACE_MS + NUDGE_SHOW_MS;
        n.sweep(gone);
        assert_eq!(n.view(gone), None);

        n.note_summon_cast(gone + NUDGE_QUIET_MS - 1);
        assert_eq!(
            n.view(gone + NUDGE_QUIET_MS - 1 + NUDGE_GRACE_MS),
            None,
            "inside the quiet period nothing arms at all"
        );
        n.note_summon_cast(gone + NUDGE_QUIET_MS);
        assert!(n.view(gone + NUDGE_QUIET_MS + NUDGE_GRACE_MS).is_some());
    }

    /// ONE SLOT: a chain of summons is one question, so the second cast does not move the arm and
    /// cannot stack a second nudge.
    #[test]
    fn chain_summoning_does_not_stack_or_move_the_arm() {
        let mut n = PetNudgeState::new();
        n.note_summon_cast(1_000);
        n.note_summon_cast(3_000);
        assert_eq!(
            n.view(1_000 + NUDGE_GRACE_MS)
                .expect("the first arm still stands")
                .summoned_ts,
            1_000
        );
    }

    /// A summon that fizzled summoned nothing, and a nudge about a pet that does not exist is the
    /// staleness the ruling forbids.
    #[test]
    fn a_failed_cast_disarms_it() {
        let mut n = PetNudgeState::new();
        n.note_summon_cast(1_000);
        n.note_cast_failed();
        assert_eq!(n.view(1_000 + NUDGE_GRACE_MS), None);
    }

    /// A SWEEP INSIDE THE WINDOW CHANGES NOTHING — the deadline is the only thing that retires an
    /// arm, so a poll landing mid-show leaves the nudge exactly where it was.
    #[test]
    fn a_sweep_before_the_deadline_leaves_the_arm_alone() {
        let mut n = PetNudgeState::new();
        n.note_summon_cast(1_000);
        n.sweep(1_000 + NUDGE_GRACE_MS + NUDGE_SHOW_MS - 1);
        assert!(n.view(1_000 + NUDGE_GRACE_MS).is_some());
    }
}
