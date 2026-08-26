//! THE GROUP ROSTER, as the combat engine reads it — `src/shared/roster.ts` plus the pull seam
//! `engine.ts setRoster` installs.
//!
//! ── WHY THIS IS A TRAIT AND NOT A PORT ────────────────────────────────────────────────────────
//!
//! The roster is `roster.ts`, cluster 2b's module. This crate must not hold a SECOND opinion about
//! who is in your group: two spellings of a membership ladder are two answers, and the one thing a
//! parity fold cannot afford is disagreeing with itself. So what lives here is the SHAPE the engine
//! consults and the door it consults it through — `EqModule::as_roster` (lib.rs) — and 2b's module
//! implements it. Nothing here folds a roster signal.
//!
//! ── WHAT THE GOLDENS SAY THIS SEAM IS ACTUALLY WORTH ──────────────────────────────────────────
//!
//! Measured over the recorded goldens rather than assumed, because it decides how much of 2d can be
//! proven before 2b lands. `combat.roster` reads:
//!
//! * patch-week / hate-pets / early-leveling / sky-era / mid-grind —
//!   `{"members":[],"seen":false,"lastSignalTs":0}`, i.e. `EMPTY_ROSTER` exactly.
//! * current — `{"members":[],"seen":true,"lastSignalTs":1787517003000}`.
//!
//! So on FIVE of the six slices the stub below is not an approximation, it is the right answer, and
//! on the sixth the whole divergence a missing roster can produce is two scalar fields — `seen` and
//! `lastSignalTs` — with the member list still empty. The other thing the roster decides is
//! ENGAGEMENT LICENCE (whose target counts as a mob your fight is engaged with) and the `'other'` →
//! `'member'` row upgrade; with an empty `admitted` set on every slice, neither can move a number
//! that the ported half of the fold produces. This is what "document which scopes need roster to go
//! green and prove the rest" resolves to: on this corpus, none of them do beyond those two fields.

/// One roster member, as the snapshot serializes it. Spelled here (rather than in 2b) because the
/// engine SERIALIZES it — `combat.roster` rides the combat snapshot rather than the module
/// transport, because two surfaces filter by it and the overlay windows already poll this snapshot;
/// teaching the module transport to reach them too would be a second path to the same five names,
/// and two paths can disagree.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterMember {
    /// Canonical (lowercased) identity key — `idKey(name)`.
    pub key: String,
    /// Display name, spelled the way the log spelled it (world-model law 2).
    pub name: String,
    pub source: String,
    pub since_ts: i64,
}

/// The serializable roster the snapshot carries to both renderer bundles.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterSnap {
    pub members: Vec<RosterMember>,
    /// Whether ANY group signal has been observed since the last epoch. THE DIFFERENCE BETWEEN
    /// "NO ROSTER" AND "SOLO": an empty roster means UNKNOWN, and unknown must not hide people, so
    /// the Group scope renders as Everyone and says so on the chip when this is false.
    pub seen: bool,
    /// ts of the most recent membership signal of any kind; 0 when there has been none.
    pub last_signal_ts: i64,
}

impl RosterSnap {
    /// `EMPTY_ROSTER` — what `rosterSnapProvider`'s default returns, and what five of the six
    /// recorded goldens carry verbatim.
    pub fn empty() -> Self {
        RosterSnap {
            members: Vec::new(),
            seen: false,
            last_signal_ts: 0,
        }
    }
}

/// THE PULL. Implemented by cluster 2b's `roster` module and by nothing else; reached through
/// `EqModule::as_roster`, which defaults to `None` so every other module says nothing.
///
/// Read ONCE PER UI TICK for `snap()`, never per line — so the rows the meter draws and the chip
/// that filters them always describe one group, read in one call.
pub trait RosterSource {
    /// The roster as the snapshot serializes it — provenance, names and staleness.
    fn snap(&self) -> RosterSnap;

    /// Canonical keys CURRENTLY in the roster: the Group allowlist, and the set nothing may treat
    /// as a hostile. `engageHostile` and the presence axis both consult it, because a group
    /// member's TARGET is what we are fighting and the member never is.
    fn members(&self) -> Vec<String> {
        Vec::new()
    }

    /// Canonical keys the engine treats as GROUP MEMBERS for attribution — every name that has been
    /// in the roster since the last epoch or self-leave, INCLUDING ones since removed. Wider than
    /// `members` on purpose: a member who left an hour ago is still the person whose row carries
    /// that fight's damage, and a user REMOVING someone in the popover must only ever hide a row.
    fn admitted(&self) -> Vec<String> {
        Vec::new()
    }

    /// `RosterView.nameOf` — the roster's own spelling for a key, which is the one a user has seen
    /// in the popover and therefore the label a recorded row prefers. Defaulted off `snap()` so 2b
    /// implements one method and this stays a read of the same list rather than a second one.
    fn name_of(&self, key: &str) -> Option<String> {
        self.snap()
            .members
            .into_iter()
            .find(|m| m.key == key)
            .map(|m| m.name)
    }
}
