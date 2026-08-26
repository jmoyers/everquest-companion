//! THE PROC-BUFF CATALOG (`src/shared/procBuffs.ts`) — the curated set of self-buffs whose up/down
//! span is worth tracking as an active state.
//!
//! CURATED, NOT THE WHOLE SPELL DB, and the gate is the same one the dispel family applies, for the
//! same reason: feeding 1,926 spells into a span tracker would flood the model with irrelevant states
//! and make every co-occurrence number meaningless. A state earns a row only when (a) it plausibly
//! modulates a proc rate and (b) its landing and wear-off messages are UNAMBIGUOUS in the shipped
//! spell DB — otherwise the span edges would be guesses and law 1 would break at the very first field.
//!
//! v1 IS ONE ENTRY, and that is the honest state of the evidence rather than a stub. `Instrument of
//! Nife` is the Paladin L15 self-buff (`Permanent`, `Add Melee Proc: Condemnation of Nife`) and both
//! of its messages are unique in the DB. It is also the feature's HONEST-LIMITS case: the real log
//! carries 97 landings against ONE observed fade, and 261,505 melee swings with the aura up against
//! 289 with it down. Tier A is exact; Tier B is impossible, because 289 swings is not a control group.
//! That asymmetry is the RESULT, not a defect to engineer around.
//!
//! `grants_proc` IS A HINT ONLY. It pre-seeds a link LABEL so the UI can put the two rows next to each
//! other; it is NEVER used to attribute a proc. A proc line in this log names no source (law 6), so a
//! link's STRENGTH always comes from the observed co-occurrence counts and the inactive-side exposure.

/// One tracked self-buff. Every field is copied verbatim from `spells.json` except `grants_proc`,
/// which is the one wiki-sourced field.
pub struct ProcBuffDef {
    /// DB spell name, display casing.
    pub name: &'static str,
    /// The proc this buff GRANTS, per the wiki.
    pub grants_proc: Option<&'static str>,
}

pub const PROC_BUFF_CATALOG: [ProcBuffDef; 1] = [ProcBuffDef {
    name: "Instrument of Nife",
    grants_proc: Some("Condemnation of Nife"),
}];

/// The catalog entry a candidate spell name names, or `None`. Case-insensitive: buff landing
/// candidates arrive in DB display casing, wears-off candidates need not.
fn proc_buff_for(name: &str) -> Option<&'static ProcBuffDef> {
    let key = name.to_lowercase();
    PROC_BUFF_CATALOG
        .iter()
        .find(|b| b.name.to_lowercase() == key)
}

/// The FIRST catalog entry named by a candidate list, or `None` when none is. Buff landings and
/// wear-offs both arrive as CANDIDATE LISTS (law 3: shared messages are the norm), so the gate has to
/// be a set intersection, never a single-name equality.
pub fn proc_buff_in_candidates(candidates: &[String]) -> Option<&'static ProcBuffDef> {
    candidates.iter().find_map(|c| proc_buff_for(c))
}
