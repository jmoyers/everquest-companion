//! ============================================================================
//! eqlog — THE EVERQUEST LEGENDS LOG PARSER, IN RUST (JOS-459 phase 1, JOS-469).
//! ============================================================================
//!
//! Bytes in, canonical events out. Two ways in and ONE line law between them: `scan.rs` folds a
//! complete file, `tail.rs` (JOS-472) follows one EverQuest is still appending to, byte-exactly, and
//! the acceptance for the second is that its line sequence equals the first's over any chunking at
//! all. Wiring the tail into `engined`'s session is a later ticket.
//!
//! THE BAR IS BYTE IDENTITY, not equivalence (owner ruling 12, docs/plans/data-server.md). The TS
//! pipeline's event stream over six slices of the owner's real log is recorded as NDJSON — one
//! `JSON.stringify(ev)` per line — and this crate's serialized stream must equal it byte for byte
//! over all six. That bar is why several things here look stranger than they would if the goal were
//! merely "a correct parser":
//!
//!   * events are written key by key rather than derived (`event.rs`), because `JSON.stringify`
//!     writes INSERTION order and the insertion order is a property of the CODE PATH;
//!   * `\d`, `\w`, `\s`, `.trim()` and `JSON.stringify`'s escape set are all spelled out
//!     (`jsstr.rs`), because JavaScript's are ASCII-or-ECMA where Rust's are Unicode;
//!   * timestamps resolve through an IANA zone with historical DST (`timestamp.rs`), because the TS
//!     hands a zone-less string to `Date.parse` and gets HOST LOCAL TIME;
//!   * the whole spell-DB load path is reproduced (`spelldb/`), because the `candidates` list a
//!     `buffApply` carries IS that database.
//!
//! AND SINCE JOS-505 A PARSE PRODUCES TWO THINGS AT ONCE. The NDJSON line above is still built
//! eagerly and is still the bar; beside it, in the same calls, `event.rs` records the event as a
//! TYPED `Payload` — the kind as a discriminant, each field as a `(Key, Slot)` pair in the order it
//! was written, every string in one reused arena. That is what the FOLD reads: it used to parse the
//! line back into a `serde_json::Value`, which JOS-504 measured at 9.6% of a whole fold before any
//! module had looked at a field. `scan_bytes` and the ingest seam hand over both halves together
//! because they are one event written twice and the writer's buffers are reused — a caller that
//! took one of them could not ask for the other afterwards.
//!
//! CACHE TRANSPARENCY (ruling 18): a parse is a pure function of (bytes, spell-DB version,
//! character name). Everything stateful lives on `Parser`, nothing outlives it, and no state is
//! addressed by anything but a byte offset. The one memo the TS keeps — `spellCanonKey`'s cache — is
//! deliberately not ported; its own header says the behaviour is identical either way.

pub mod event;
pub mod jsstr;
pub mod names;
pub mod parse;
pub mod scan;
pub mod spelldb;
pub mod stems;
pub mod tail;
pub mod taxonomy;
pub mod timestamp;

/// Re-exported so a consumer names the zone type through this crate rather than pinning its own
/// `chrono-tz` version — two tz databases in one process is a way for two answers to appear.
pub use chrono_tz::Tz;
pub use parse::Parser;
pub use timestamp::{host_timezone, Civil, Clock};

/// Build the parser the app builds: the effective spell DB (spells.json + every load-time overlay +
/// the committed message-overlay corrections) installed, and the tailed character's name known.
///
/// THE CHARACTER NAME IS LOAD-BEARING and must be installed BEFORE the fold: the self-`/who` rule
/// and the pet-leader carve-out both decline every line until it is set, exactly as `session.ts`
/// (and `foldArm.mts`) arrange.
/// THE CATALOG IS THE PROCESS'S ONE COPY (JOS-478, `spelldb::shared`). It was `spelldb::load()`
/// here, which meant a second parser in one process paid the whole 386 ms build again for bytes
/// compiled into the binary — the knot `engined`'s README measured and named for the integrator.
pub fn parser_for(character: &str, tz: chrono_tz::Tz) -> Parser {
    Parser::new(
        Clock::new(tz),
        Some(spelldb::shared()),
        Some(character.to_string()),
    )
}

/// `tests/bench/goldenOracle.mts characterOf`'s pattern, spelled ONCE — `eqlog_<Name>_<server>.
/// <slice>.txt`. Two readers take two groups off it (below); a second copy of the pattern would be
/// a way for them to disagree about what a log file is called.
fn log_file_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)^eqlog_(.+?)_([^_]+?)\.[^.]+\.txt$").unwrap())
}

/// The character a slice was cut from, derived from its FILENAME. Hardcoding the name would let the
/// corpus and the harness drift apart silently.
pub fn character_of(file_name: &str) -> Option<String> {
    log_file_re().captures(file_name).map(|m| m[1].to_string())
}

/// The SERVER out of the same filename. It exists because the character module (JOS-475) publishes
/// the whole `CharacterRef` — `{ name, server, logPath }` — and the golden recorder derives every
/// field of it from the filename.
pub fn server_of(file_name: &str) -> Option<String> {
    log_file_re().captures(file_name).map(|m| m[2].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Ev;

    fn parse_one(p: &Parser, raw: &str) -> String {
        let mut ev = Ev::new();
        assert!(p.parse_event(raw, 0, &mut ev), "line was not timestamped");
        ev.finish().to_string()
    }

    fn bare() -> Parser {
        Parser::new(
            Clock::new(chrono_tz::America::Los_Angeles),
            None,
            Some("Primitive".to_string()),
        )
    }

    #[test]
    fn the_character_comes_off_the_filename() {
        assert_eq!(
            character_of("eqlog_Primitive_freeport.patch-week.txt").as_deref(),
            Some("Primitive")
        );
        assert_eq!(character_of("not-a-log.txt"), None);
    }

    #[test]
    fn an_unclassified_line_is_the_unknown_envelope() {
        let p = bare();
        assert_eq!(
            parse_one(
                &p,
                "[Wed Aug 19 16:21:47 2026] You are not currently assigned to an adventure."
            ),
            r#"{"kind":"unknown","seq":0,"ts":1787181707000,"raw":"[Wed Aug 19 16:21:47 2026] You are not currently assigned to an adventure."}"#
        );
    }

    #[test]
    fn a_line_with_no_timestamp_is_no_event_at_all() {
        let p = bare();
        let mut ev = Ev::new();
        assert!(!p.parse_event("no bracket here", 0, &mut ev));
    }

    /// A chat line carrying bare CARRIAGE RETURNS is not a log line at all — see `jsstr::JS_DOT`
    /// for the sky-era divergence this pins. It must produce NO event, so `seq` does not advance.
    #[test]
    fn a_line_with_an_embedded_carriage_return_is_no_event_at_all() {
        let p = bare();
        let mut ev = Ev::new();
        assert!(!p.parse_event(
            "[Sun Aug 16 20:09:40 2026] Velkator tells general2:1, 'rebaseline\rCount items from\r/outputfile inventory'",
            0,
            &mut ev
        ));
        // …but a CR sitting where the ONE optional space goes is consumed by `\s?` and the line
        // parses, because that is what the TS pattern does too.
        assert!(p.parse_event(
            "[Sun Aug 16 20:09:40 2026]\rWelcome to EverQuest Legends!",
            0,
            &mut ev
        ));
        assert!(ev.finish().starts_with(r#"{"kind":"sessionStart""#));
    }

    #[test]
    fn the_group_kind_writes_change_before_the_envelope() {
        let p = bare();
        assert_eq!(
            parse_one(
                &p,
                "[Wed Aug 19 16:21:47 2026] Dranix has joined the group."
            ),
            r#"{"kind":"group","change":"join","name":"Dranix","seq":0,"ts":1787181707000,"raw":"[Wed Aug 19 16:21:47 2026] Dranix has joined the group."}"#
        );
    }

    #[test]
    fn a_typed_nuke_carries_dclass_and_an_empty_modifier_list() {
        let p = bare();
        let raw = "[Wed Aug 19 16:21:54 2026] Atesc hit a thunder spirit princess for 231 points of magic damage by Spirit Tap.";
        assert_eq!(
            parse_one(&p, raw),
            format!(
                r#"{{"kind":"damage","seq":0,"ts":1787181714000,"raw":{},"attacker":"Atesc","target":"a thunder spirit princess","amount":231,"dtype":"spell","dclass":"magic","skill":"Spirit Tap","crit":false,"modifiers":[],"category":"spell"}}"#,
                serde_json::to_string(raw).unwrap()
            )
        );
    }

    #[test]
    fn a_damage_shield_carries_no_modifier_list_at_all() {
        let p = bare();
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] a thunder spirit princess is burned by YOUR flames for 12 points of non-melee damage.",
        );
        assert!(out.contains(r#""attacker":"You""#), "{out}");
        assert!(!out.contains("modifiers"), "{out}");
        assert!(out.ends_with(r#""category":"ds"}"#), "{out}");
    }

    #[test]
    fn a_caster_less_dot_says_null_rather_than_omitting_the_attacker() {
        let p = bare();
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] a thunder spirit princess has taken 30 damage by Ignite Blood.",
        );
        assert!(out.contains(r#""attacker":null"#), "{out}");
    }

    #[test]
    fn the_experience_percentage_is_the_one_float_in_the_stream() {
        let p = bare();
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] You gain experience! (3.288%)",
        );
        assert!(out.ends_with(r#""party":false,"pct":3.288}"#), "{out}");
        // …and an integral one prints as JS prints it: no fraction.
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] You gain party experience! (3%)",
        );
        assert!(out.ends_with(r#""party":true,"pct":3}"#), "{out}");
        // …and a line that states none omits the key rather than saying zero.
        let out = parse_one(&p, "[Wed Aug 19 16:21:54 2026] You gain experience!");
        assert!(out.ends_with(r#""party":false}"#), "{out}");
    }

    #[test]
    fn the_spell_db_puts_a_candidate_list_on_a_landing() {
        let p = parser_for("Primitive", chrono_tz::America::Los_Angeles);
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] A thunder spirit princess staggers.",
        );
        assert!(out.starts_with(r#"{"kind":"buffApply","#), "{out}");
        assert!(out.contains(r#""candidates":[{"name":"#), "{out}");
    }
}
