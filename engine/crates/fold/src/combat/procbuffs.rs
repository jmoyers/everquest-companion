//! The proc-buff catalog (`src/shared/procBuffs.ts`) — the curated self-buffs whose up/down span is
//! worth tracking as an active state.
//!
//! Curated, not the whole spell DB: feeding every spell into a span tracker would flood the model
//! with irrelevant states and make every co-occurrence number meaningless. A state earns a row only
//! when it plausibly modulates a proc rate and its landing and wear-off messages are unambiguous in
//! the shipped spell DB — otherwise the span edges would be guesses.
//!
//! `grants_proc` is a hint only. It pre-seeds a link label so the UI can put the two rows together;
//! it never attributes a proc. A proc line names no source, so a link's strength always comes from
//! the observed co-occurrence counts and the inactive-side exposure.

/// One tracked self-buff. Every field is copied verbatim from `spells.json` except `grants_proc`,
/// which is wiki-sourced.
pub struct ProcBuffDef {
    /// DB spell name, display casing.
    pub name: &'static str,
    /// The proc this buff grants, per the wiki.
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

/// The first catalog entry named by a candidate list, or `None`. Landings and wear-offs both arrive
/// as candidate lists because messages are shared between spells, so the gate is an intersection and
/// never a single-name equality.
pub fn proc_buff_in_candidates(candidates: &[String]) -> Option<&'static ProcBuffDef> {
    candidates.iter().find_map(|c| proc_buff_for(c))
}
