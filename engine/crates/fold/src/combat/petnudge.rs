//! The nudge for a pet the meter cannot see.
//!
//! A charmed pet binds off its own broadcast, but a SUMMONED pet binds only when the player does
//! something — order it once, ask `/pet who leader`, or land a pet-only buff on it. A never-ordered
//! auto-assisting pet matches none of those, so its damage is dropped at routing and the player is
//! told rather than guessed for: auto-adopting the first unknown attacker after a summon is exactly
//! the inference this app refuses.
//!
//! The whole module is therefore a timeout, and each constant keeps one promise: GRACE means a bind
//! that arrives promptly draws no nudge at all, SHOW is how long it then stays up, QUIET is what
//! stops it nagging. No persistent banner, no re-showing for the same pet.
//!
//! ONE SLOT, which makes it once-per-summon-BURST rather than once-per-line: while an arm is live
//! further summon casts change nothing, and the arm is cleared by a bind, by the timeout, or by the
//! summon cast failing to resolve.
//!
//! Pure and clock-injected: no wall clock, no engine state, no I/O. Every method takes the timestamp
//! it is reasoning at, so whether a nudge is on screen is arithmetic over two numbers.

use serde::Serialize;

/// How long a summon has to produce a bind before the player is told anything. Above the measured
/// fast path (summon → buff the pet → bound, about six seconds), so that path draws no nudge.
pub const NUDGE_GRACE_MS: i64 = 10_000;

/// How long the nudge is then on screen before it times out.
pub const NUDGE_SHOW_MS: i64 = 45_000;

/// How long after a nudge has been shown and IGNORED before another summon may raise one. Long
/// enough that the next nudge is about a new session's worth of play rather than the same decision.
pub const NUDGE_QUIET_MS: i64 = 300_000;

/// What the snapshot carries when there is a nudge to carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSummonNudge {
    pub summoned_ts: i64,
    pub expires_ts: i64,
}

/// The one-slot state machine: the summon cast currently awaiting a bind, and when a shown nudge
/// last timed out unheeded.
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
    /// Refuses when something is already armed (a chain of summons is ONE question) or when a nudge
    /// was shown and ignored inside `NUDGE_QUIET_MS`.
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
    /// It errs toward SILENCE: an interrupted summon the player then resumes loses its nudge,
    /// because a resume line names no spell and re-deriving one would be a guess. A missed hint is
    /// cheaper than a nudge about a pet that was never summoned.
    pub fn note_cast_failed(&mut self) {
        self.armed_ts = None;
    }

    /// A pet bound (any of the three claim routes). The question is answered, so the nudge dismisses
    /// early and does not count as ignored — `NUDGE_QUIET_MS` is not for a player who acted.
    pub fn note_bound(&mut self) {
        self.armed_ts = None;
    }

    /// Retire an arm whose window has fully elapsed. Driven from the event stream AND from
    /// `snapshot(now)`, whichever observes the deadline first: the log can go quiet for minutes and
    /// a screen must not.
    ///
    /// Only an arm that was actually SHOWN records an ignored nudge, which keeps the quiet period
    /// tied to what the player saw rather than to what the engine armed.
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
    /// `None` in every state but one — nothing armed, inside the grace, or past the timeout — which
    /// makes "no persistent banner" structural rather than a promise the renderer has to keep.
    #[must_use]
    pub fn view(&self, now: i64) -> Option<PetSummonNudge> {
        let armed = self.armed_ts?;
        let elapsed = now - armed;
        // The range is half-open on purpose: the grace instant DRAWS the nudge, the expiry does not.
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
    /// after the timeout. Every boundary is pinned because each is a deliberate `<` or `>=`.
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

    /// A bind answers it and costs nothing: the arm clears, nothing was ignored, and the next summon
    /// may raise a nudge of its own. That is the difference between a bind and a timeout.
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

    /// One slot: a chain of summons is one question, so the second cast does not move the arm and
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

    /// A summon that fizzled summoned nothing, so there is no pet to nudge about.
    #[test]
    fn a_failed_cast_disarms_it() {
        let mut n = PetNudgeState::new();
        n.note_summon_cast(1_000);
        n.note_cast_failed();
        assert_eq!(n.view(1_000 + NUDGE_GRACE_MS), None);
    }

    /// A sweep inside the window changes nothing: only the deadline retires an arm.
    #[test]
    fn a_sweep_before_the_deadline_leaves_the_arm_alone() {
        let mut n = PetNudgeState::new();
        n.note_summon_cast(1_000);
        n.sweep(1_000 + NUDGE_GRACE_MS + NUDGE_SHOW_MS - 1);
        assert!(n.view(1_000 + NUDGE_GRACE_MS).is_some());
    }
}
