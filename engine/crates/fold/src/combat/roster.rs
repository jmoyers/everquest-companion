//! The group roster, as the combat engine reads it: a SHAPE and a pull seam, not a port.
//!
//! Membership is the roster module's opinion and must not have a second one here — two spellings of
//! a membership ladder are two answers, and a parity fold cannot afford to disagree with itself. So
//! this file holds only the serialized shape and the door (`EqModule::as_roster`), and the roster
//! module implements it. Nothing here folds a roster signal.

/// One roster member, as the snapshot serializes it. Spelled here because the ENGINE serializes it:
/// `combat.roster` rides the combat snapshot rather than the module transport, since the surfaces
/// that filter by it already poll this snapshot and a second path could disagree with the first.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterMember {
    /// Canonical (lowercased) identity key.
    pub key: String,
    /// Display name, spelled the way the log spelled it (law 2).
    pub name: String,
    pub source: String,
    pub since_ts: i64,
}

/// The serializable roster the snapshot carries to both renderer bundles.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterSnap {
    pub members: Vec<RosterMember>,
    /// Whether any group signal has been observed since the last epoch — the difference between "no
    /// roster" and "solo". An empty roster means UNKNOWN, and unknown must not hide people, so the
    /// Group scope renders as Everyone and says so on the chip when this is false.
    pub seen: bool,
    /// ts of the most recent membership signal of any kind; 0 when there has been none.
    pub last_signal_ts: i64,
}

impl RosterSnap {
    /// The empty roster: no members, nothing seen.
    pub fn empty() -> Self {
        RosterSnap {
            members: Vec::new(),
            seen: false,
            last_signal_ts: 0,
        }
    }
}

/// The pull. Implemented by the `roster` module and by nothing else; reached through
/// `EqModule::as_roster`, which defaults to `None` so every other module says nothing.
///
/// Read once per UI tick, never per line, so the rows the meter draws and the chip that filters them
/// always describe one group read in one call.
pub trait RosterSource {
    /// The roster as the snapshot serializes it — provenance, names and staleness.
    fn snap(&self) -> RosterSnap;

    /// Canonical keys CURRENTLY in the roster: the Group allowlist, and the set nothing may treat
    /// as a hostile. `engageHostile` and the presence axis both consult it, because a group
    /// member's TARGET is what we are fighting and the member never is.
    fn members(&self) -> Vec<String> {
        Vec::new()
    }

    /// Canonical keys the engine treats as GROUP MEMBERS for attribution — every name in the roster
    /// since the last epoch or self-leave, including ones since removed. Wider than `members` on
    /// purpose: a member who left an hour ago still owns that fight's damage, and removing someone
    /// in the popover must only ever hide a row.
    fn admitted(&self) -> Vec<String> {
        Vec::new()
    }

    /// The roster's own spelling for a key — what the user saw in the popover, so it is the label a
    /// recorded row prefers. Defaulted off `snap()` so this stays a read of the same list.
    fn name_of(&self, key: &str) -> Option<String> {
        self.snap()
            .members
            .into_iter()
            .find(|m| m.key == key)
            .map(|m| m.name)
    }
}
