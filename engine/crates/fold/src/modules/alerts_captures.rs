//! `shared/alertCaptures.ts` and `shared/alertTargets.ts` — what an alert firing may SAY.
//! `alerts_rules.rs` decides WHETHER a line makes a sound; this decides the words.
//!
//! THE THREAT MODEL. Alert definitions are shareable (people paste `EQC1-` bundles to each other)
//! and log lines are attacker-influenced (other players' chosen names, and text a stranger typed),
//! so a capture group is a channel with a third party at each end: a pattern the user may not have
//! written, selecting text a stranger did write, which the app then SPEAKS ALOUD. Three controls
//! answer it, and the first two are enforced here as well as app-side, because a safety property
//! that depends on the other side having been careful is not one:
//!
//!   1. The sanitizer is unconditional ([`sanitize_capture`]): ANSI/VT sequences leave WHOLE, every
//!      C0/C1/DEL control is deleted, CR/LF/TAB collapse to one space, and the invisible + BiDi
//!      override class (Trojan Source — one string RENDERING as another) is deleted.
//!   2. A value is capped at [`MAX_CAPTURE_CHARS`] and a firing at [`MAX_CAPTURE_GROUPS`].
//!   3. A value may only come from the text the def's OWN condition just tested. That one is
//!      structural: `alerts_rules.rs` is the only caller of [`harvest_captures`] and hands it the
//!      one regex that just matched and the one text it matched against.
//!
//! The cap counts CHARS where JS counts UTF-16 code units. Same number for anything either side can
//! see — EQ names and the shipped mob DB are ASCII — and the cap is a bound, not a contract.

use crate::event::Event;
use regex::{Captures, Regex};
use std::collections::BTreeMap;

/// The captures a firing carries.
///
/// Sorted rather than insertion-ordered so the wire frame serializes reproducibly. Key order is not
/// a claim (consumers look a token up by name), but WHICH keys survived the [`MAX_CAPTURE_GROUPS`]
/// cap is — and that is decided in declaration order, before anything is sorted.
pub type CaptureMap = BTreeMap<String, String>;

/// Longest a single captured value may be, in characters — control 2.
///
/// A name's worth of text, not a line's: EQ character names are at most 15 characters and the
/// longest mob display names in the shipped DB sit under 40. It is 40% of the utterance cap, so no
/// single token can spend the whole budget on one stranger's sentence.
pub const MAX_CAPTURE_CHARS: usize = 48;

/// Most named groups carried from one firing. No honest pattern names eight things. Groups past the
/// bound are DROPPED, so their tokens render literally (visible) rather than resolving to something
/// unbounded (not).
pub const MAX_CAPTURE_GROUPS: usize = 8;

/// Whether `c` is a C0 control, DEL, or a C1 control. Nothing in this class is content.
fn is_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1F}' | '\u{7F}'..='\u{9F}')
}

/// Whether `c` renders as nothing, or reorders what renders around it.
///
/// ZWSP/ZWNJ/ZWJ and the LRM/RLM marks; LINE and PARAGRAPH SEPARATOR plus the BiDi embeddings and
/// overrides (Trojan Source); the word joiner and invisible operators; the BiDi isolates; the
/// BOM/ZWNBSP. Same ranges in the same order as the TS, so the two can be diffed by eye.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}'
        | '\u{2028}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}')
}

/// These three become a single space; every other control is deleted. A captured value must not be
/// able to forge a second line on any surface that prints it.
fn is_space_control(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r')
}

/// Strip ANSI/VT escape sequences WHOLE, so the payload (`[31m`, `]0;title`) leaves with the ESC
/// instead of being left behind as visible litter.
///
/// Four ordered arms, and the order is the design:
///   1. CSI            `ESC [` params intermediates final — colours, cursor moves, erase-display
///   2. string-openers `ESC ] P ^ _ X` … BEL|ST — OSC (including OSC 52, which writes the
///      operator's clipboard), DCS, PM, APC, SOS; payload eaten whole
///   3. nF             `ESC <0x20..0x2F>+ <0x30..0x7E>` — charset selection, e.g. `ESC ( B`
///   4. anything else  `ESC <one printable>` — the C1 twins, `ESC c`, and the private forms
///
/// Arm 4 is the catch-all on purpose: an ESC this function does not recognise must still lose its
/// ESC, so a malformed CSI/OSC falls out of arms 1-2 into it. A trailing lone ESC and the C1
/// single-byte equivalents (0x9B, 0x9D) are deleted by the control class in [`sanitize_one_line`].
fn strip_ansi(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\u{1B}' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let Some(&next) = chars.get(i + 1) else {
            // A trailing lone ESC.
            i += 1;
            continue;
        };
        i += 2;
        match next {
            // Arm 1 — CSI: params, then intermediates, then one final byte.
            '[' => {
                while chars
                    .get(i)
                    .is_some_and(|&c| ('\u{30}'..='\u{3F}').contains(&c))
                {
                    i += 1;
                }
                while chars
                    .get(i)
                    .is_some_and(|&c| ('\u{20}'..='\u{2F}').contains(&c))
                {
                    i += 1;
                }
                if chars
                    .get(i)
                    .is_some_and(|&c| ('\u{40}'..='\u{7E}').contains(&c))
                {
                    i += 1;
                }
            }
            // Arm 2 — a string opener: everything up to BEL or ST, both of which go with it.
            ']' | 'P' | '^' | '_' | 'X' => {
                while chars.get(i).is_some_and(|&c| c != '\u{7}' && c != '\u{1B}') {
                    i += 1;
                }
                match chars.get(i) {
                    Some('\u{7}') => i += 1,
                    // `ESC \` is the String Terminator. A bare ESC that is not the `\` form opens a
                    // new sequence and is left for the next pass of the loop.
                    Some('\u{1B}') if chars.get(i + 1) == Some(&'\\') => i += 2,
                    _ => {}
                }
            }
            // Arm 3 — nF: one or more intermediates then one final.
            c if ('\u{20}'..='\u{2F}').contains(&c) => {
                while chars
                    .get(i)
                    .is_some_and(|&c| ('\u{20}'..='\u{2F}').contains(&c))
                {
                    i += 1;
                }
                if chars
                    .get(i)
                    .is_some_and(|&c| ('\u{30}'..='\u{7E}').contains(&c))
                {
                    i += 1;
                }
            }
            // Arm 4 — the catch-all. One printable goes with the ESC; anything else keeps only the
            // ESC's own deletion, so it is pushed back.
            c if ('\u{20}'..='\u{7E}').contains(&c) => {}
            _ => {
                i -= 1;
            }
        }
    }
    out
}

/// The display normalizer for anything that must occupy exactly one line.
///
/// The ORDER is the contract: ANSI goes WHOLE first (so its payload leaves with the ESC), then
/// CR/CRLF fold, then TAB/LF/CR become one space and every other control is deleted, then the
/// invisibles go.
fn sanitize_one_line(raw: &str) -> String {
    let ansi_free = strip_ansi(raw);
    // A CR followed by an LF is one break. Both ends fold to one space below.
    let mut out = String::with_capacity(ansi_free.len());
    let mut chars = ansi_free.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push(' ');
            continue;
        }
        if is_invisible(c) {
            continue;
        }
        if is_control(c) {
            if is_space_control(c) {
                out.push(' ');
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Take `n` chars of `text` — the cap's cut, and the one place the UTF-16 divergence lives.
fn take_chars(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((byte, _)) => &text[..byte],
        None => text,
    }
}

/// One captured value, made safe — controls 1 and 2, in the order that matters.
///
/// SANITIZE BEFORE CAPPING, or the byte count of an escape sequence buys a hostile pattern extra
/// room under the cap. Trim again after: the strip can expose new edge whitespace.
///
/// `None` is "nothing survived", which every caller treats as "this group captured nothing": its
/// token renders LITERALLY rather than as an empty string, so a phrase never silently collapses
/// into a shorter, different sentence.
pub fn sanitize_capture(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let clean = sanitize_one_line(raw);
    let clean = clean.trim();
    if clean.is_empty() {
        return None;
    }
    let capped = take_chars(clean, MAX_CAPTURE_CHARS).trim();
    (!capped.is_empty()).then(|| capped.to_owned())
}

/// Turn a match's named groups into the bounded, sanitized map a firing may carry.
///
/// The one place raw regex output becomes a firing's captures, so every producer gets the same
/// bounds whether it matched a raw line or a `where` field. `None` when nothing survived: an absent
/// key is the honest encoding of "this pattern named nothing".
///
/// DECLARATION ORDER IS WHAT THE CAP CUTS ON — the map it collects into is sorted, but the drop is
/// decided before that. Unnamed groups are skipped: a token is a declaration, and a positional
/// group declares nothing.
pub fn harvest_captures(re: &Regex, caps: &Captures<'_>) -> Option<CaptureMap> {
    let mut out = CaptureMap::new();
    for name in re.capture_names().flatten() {
        if out.len() >= MAX_CAPTURE_GROUPS {
            break;
        }
        let Some(m) = caps.name(name) else {
            continue;
        };
        let Some(value) = sanitize_capture(m.as_str()) else {
            continue;
        };
        out.insert(name.to_owned(), value);
    }
    (!out.is_empty()).then_some(out)
}

/// Merge one condition's captures into an accumulator, FIRST WRITER WINS — which is source order.
/// An 'all' composite means every condition matched this one event, so all their names are in
/// scope. `None` stays `None`.
pub fn merge_captures(into: Option<CaptureMap>, from: Option<CaptureMap>) -> Option<CaptureMap> {
    let Some(from) = from else { return into };
    let Some(mut into) = into else {
        return Some(from);
    };
    for (k, v) in from {
        into.entry(k).or_insert(v);
    }
    Some(into)
}

/// Which field of which kind names the entity — the closed table behind the `{target}` auto token.
///
/// Returns the field holding the entity's display name, and what an ABSENT field means when absence
/// is itself a statement. Only `buffFade` has the second: `Your <Spell> spell has worn off.` with
/// no "of <mob>" and no "pet's" IS the self form, and the parser omits `target` for that shape.
/// Everywhere else an absent field is an absent answer and the token renders literally.
///
/// A table rather than a property read because the hold lanes spell it `mob`: a user writing
/// `{target}` on a mez-break alert must not have to know which of the parser's kinds carried the
/// answer.
///
/// The exclusions are the point, and are reproduced by OMISSION — a kind absent here resolves
/// nothing. `itemMergeFailed` spells an ITEM name `target`, and `consider` names a mob no spell is
/// touching; both would be a wrong answer wearing the right field name.
fn target_field_of(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
    match kind {
        "buffApply" | "buffExpired" | "buffWearOff" | "illusionFade" | "resist" | "heal"
        | "healUnstated" | "poisonProc" | "damage" | "miss" => Some(("target", None)),
        "buffFade" => Some(("target", Some("self"))),
        "cc" | "ccWake" | "charm" | "uncharm" => Some(("mob", None)),
        "spellEmote" => Some(("subject", None)),
        _ => None,
    }
}

/// The parser's sentinels, and what they are aloud.
///
/// `self` and `pet` are not names; they are the parser's words for the first-person form and the
/// `Your pet's …` form. Speaking them raw would say "Clarity wore off self".
///
/// MATCHED EXACTLY, NEVER CASE-FOLDED: the sentinels are lowercase literals the parser writes
/// itself, while a real name arrives with the game's casing. A player named `Self` is spoken as
/// `Self`, which is their name.
fn sentinel_speech(value: &str) -> Option<&'static str> {
    match value {
        "self" => Some("you"),
        "pet" => Some("your pet"),
        _ => None,
    }
}

/// Who this event is about, ready to speak — or `None` when the family names nobody.
///
/// `None` rather than an empty string is what makes the token render LITERALLY: `Mez broke on
/// {target}` is a legible, debuggable sentence and `Mez broke on` is a quietly wrong one. An empty
/// field and a missing field get the same answer, so a whitespace-only target cannot win over the
/// stated meaning of an absence.
///
/// The dynamic field read is bounded to this table's own field names, never to a key a def
/// supplies. Sanitized AFTER the sentinel read (so a sentinel is matched against what the parser
/// wrote) and before anything can speak it.
pub fn resolve_target(ev: &Event) -> Option<String> {
    let (field, absent) = target_field_of(ev.kind())?;
    let text = ev.str(field).unwrap_or_default().trim();
    let value = if text.is_empty() { absent? } else { text };
    sanitize_capture(sentinel_speech(value).unwrap_or(value))
}

/// Does this def's spoken phrase write `{target}`, the closed list of one auto token.
///
/// IT READS THE PHRASE, NOT THE TRIGGER: whether a value is worth carrying is a question about what
/// the def will SAY, so a def with no custom phrase sends the frame it sent before the field
/// existed.
///
/// A substring test is the exact port, not an approximation. The token grammar
/// `\{([A-Za-z_][A-Za-z0-9_]*)\}` admits no whitespace, modifiers or nesting, so a token NAMED
/// `target` is the substring `{target}` and nothing else can produce it.
pub fn wants_target_token(phrase: Option<&str>) -> bool {
    phrase.is_some_and(|p| p.contains("{target}"))
}

/// Merge the auto token into a match's own captures.
///
/// THE PATTERN'S OWN GROUP ALWAYS WINS: a def that declared `(?<target>…)` and matched it said
/// something more specific than the table can. The auto token widens what a phrase can say; it does
/// not overrule what a pattern said.
///
/// The group bound still governs — the cap is a property of the FIRING, not of any one producer, or
/// a def could buy itself a ninth value by asking for it a different way.
pub fn with_auto_captures(
    captures: Option<CaptureMap>,
    wants_target: bool,
    ev: &Event,
) -> Option<CaptureMap> {
    if !wants_target {
        return captures;
    }
    if captures
        .as_ref()
        .is_some_and(|c| c.contains_key("target") || c.len() >= MAX_CAPTURE_GROUPS)
    {
        return captures;
    }
    let Some(value) = resolve_target(ev) else {
        return captures;
    };
    let mut out = captures.unwrap_or_default();
    out.insert("target".to_owned(), value);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;
    use serde_json::json;

    fn ev(v: serde_json::Value) -> Event<'static> {
        Event::from_value(v)
    }

    fn harvest(pattern: &str, text: &str) -> Option<CaptureMap> {
        let re = Regex::new(pattern).expect("a valid pattern");
        let caps = re.captures(text)?;
        harvest_captures(&re, &caps)
    }

    #[test]
    fn an_ordinary_name_survives_untouched() {
        assert_eq!(sanitize_capture("Fail").as_deref(), Some("Fail"));
        assert_eq!(
            sanitize_capture("Coercer T`vala").as_deref(),
            Some("Coercer T`vala")
        );
    }

    /// OSC 52 writes the operator's clipboard and `ESC c` resets a terminal. Both leave whole,
    /// payload included, rather than being defanged into visible litter.
    #[test]
    fn ansi_sequences_leave_whole_payload_and_all() {
        assert_eq!(
            sanitize_capture("\u{1B}[31mFail\u{1B}[0m").as_deref(),
            Some("Fail")
        );
        assert_eq!(
            sanitize_capture("\u{1B}]52;c;cGF5bG9hZA==\u{7}Fail").as_deref(),
            Some("Fail")
        );
        assert_eq!(sanitize_capture("\u{1B}cFail").as_deref(), Some("Fail"));
        // ST-terminated rather than BEL-terminated.
        assert_eq!(
            sanitize_capture("\u{1B}]0;title\u{1B}\\Fail").as_deref(),
            Some("Fail")
        );
        // A malformed CSI falls out of arm 1 into arm 4 and still loses its ESC.
        assert_eq!(sanitize_capture("\u{1B}[Fail").as_deref(), Some("ail"));
        // A trailing lone ESC is consumed rather than passed through.
        assert_eq!(sanitize_capture("Fail\u{1B}").as_deref(), Some("Fail"));
    }

    /// A captured value must not be able to forge a second line on any surface that prints it.
    #[test]
    fn newlines_and_controls_cannot_forge_a_line() {
        assert_eq!(
            sanitize_capture("Fail\r\nGuild Officer").as_deref(),
            Some("Fail Guild Officer")
        );
        assert_eq!(sanitize_capture("Fa\u{0}il").as_deref(), Some("Fail"));
        assert_eq!(sanitize_capture("Fa\u{9B}il").as_deref(), Some("Fail"));
    }

    /// The Trojan Source class: one string RENDERING as another.
    #[test]
    fn the_bidi_and_invisible_class_is_deleted() {
        assert_eq!(sanitize_capture("Fa\u{202E}il").as_deref(), Some("Fail"));
        assert_eq!(sanitize_capture("\u{FEFF}Fail").as_deref(), Some("Fail"));
        assert_eq!(sanitize_capture("Fa\u{200B}il").as_deref(), Some("Fail"));
    }

    /// Nothing survived is `None`, so the token renders literally rather than collapsing the phrase
    /// into a shorter, different sentence.
    #[test]
    fn a_value_with_nothing_left_is_none() {
        assert_eq!(sanitize_capture(""), None);
        assert_eq!(sanitize_capture("   "), None);
        assert_eq!(sanitize_capture("\u{1B}[31m\u{1B}[0m"), None);
        assert_eq!(sanitize_capture("\u{200B}\u{FEFF}"), None);
    }

    #[test]
    fn a_hostile_pattern_cannot_vacuum_a_line_into_the_speaker() {
        let long = "A".repeat(300);
        let got = sanitize_capture(&long).expect("something survives");
        assert_eq!(got.chars().count(), MAX_CAPTURE_CHARS);
        // The cut is trimmed AFTER the cap.
        let padded = format!("{}     tail", "B".repeat(46));
        assert_eq!(sanitize_capture(&padded).as_deref(), Some(&*"B".repeat(46)));
    }

    #[test]
    fn a_pattern_that_names_eighty_things_carries_eight() {
        let pattern: String = (0..12)
            .map(|i| format!("(?<g{i}>[a-z])"))
            .collect::<Vec<_>>()
            .join("");
        let got = harvest(&pattern, "abcdefghijkl").expect("some captures");
        assert_eq!(got.len(), MAX_CAPTURE_GROUPS);
        // The cut is declaration order, not the sorted order the map ends up in.
        assert!(got.contains_key("g0") && got.contains_key("g7"));
        assert!(!got.contains_key("g8"));
    }

    /// A group that matched nothing does not spend a slot, so a pattern with optional alternatives
    /// still carries eight real values rather than eight mostly-empty ones.
    #[test]
    fn a_group_that_captured_nothing_is_skipped_and_costs_no_slot() {
        let got = harvest(r"(?<a>x)?(?<b>y)", "y").expect("some captures");
        assert_eq!(got.get("b").map(String::as_str), Some("y"));
        assert!(!got.contains_key("a"));
    }

    #[test]
    fn a_pattern_that_names_nothing_carries_nothing() {
        assert_eq!(harvest(r"(\w+) on (\w+)", "Puma on Fail"), None);
    }

    #[test]
    fn first_writer_wins_on_a_merge() {
        let a = harvest(r"(?<who>\w+)", "Fail");
        let b = harvest(r"(?<who>\w+) (?<what>\w+)", "Rowel Puma");
        let merged = merge_captures(a.clone(), b).expect("a merge");
        assert_eq!(merged.get("who").map(String::as_str), Some("Fail"));
        assert_eq!(merged.get("what").map(String::as_str), Some("Puma"));
        // Either side being absent is not a loss of the other.
        assert_eq!(merge_captures(None, a.clone()), a);
        assert_eq!(merge_captures(a.clone(), None), a);
        assert_eq!(merge_captures(None, None), None);
    }

    #[test]
    fn the_table_reads_the_field_each_family_actually_uses() {
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "buffApply", "target": "King Tranix" }))).as_deref(),
            Some("King Tranix")
        );
        // The hold lanes spell it `mob`, which is the whole reason the table exists.
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "cc", "mob": "a young puma" }))).as_deref(),
            Some("a young puma")
        );
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "spellEmote", "subject": "Rowel" }))).as_deref(),
            Some("Rowel")
        );
    }

    /// Speaking an item as the mob a spell is affecting would be a wrong answer wearing the right
    /// field name, and a con names a mob no spell is touching.
    #[test]
    fn the_excluded_kinds_name_nobody() {
        assert_eq!(
            resolve_target(&ev(
                json!({ "kind": "itemMergeFailed", "target": "Coldain Prayer Shawl" })
            )),
            None
        );
        assert_eq!(
            resolve_target(&ev(
                json!({ "kind": "consider", "mob": "a fire giant warlord" })
            )),
            None
        );
        // …and a family with no entity field at all.
        assert_eq!(resolve_target(&ev(json!({ "kind": "zone" }))), None);
    }

    #[test]
    fn the_parsers_sentinels_are_spoken_as_english() {
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "buffFade", "target": "self" }))).as_deref(),
            Some("you")
        );
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "buffFade", "target": "pet" }))).as_deref(),
            Some("your pet")
        );
        // An absent `buffFade.target` is the self form — the one entry in the table where absence
        // is itself a statement.
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "buffFade" }))).as_deref(),
            Some("you")
        );
        // …and an EMPTY field is as absent as a missing one.
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "buffFade", "target": "  " }))).as_deref(),
            Some("you")
        );
        // A player named `Self` is spoken as `Self`: the sentinels are matched exactly, never folded.
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "buffApply", "target": "Self" }))).as_deref(),
            Some("Self")
        );
        // Every other family's absent field is an absent answer, not a self form.
        assert_eq!(resolve_target(&ev(json!({ "kind": "buffApply" }))), None);
    }

    #[test]
    fn only_a_phrase_that_writes_the_token_wants_it() {
        assert!(wants_target_token(Some("Mez broke on {target}")));
        assert!(!wants_target_token(Some("Mez broke")));
        assert!(!wants_target_token(None));
        // The grammar admits no whitespace and no modifiers, so neither of these is the token.
        assert!(!wants_target_token(Some("{ target }")));
        assert!(!wants_target_token(Some("{target.capitalize}")));
    }

    #[test]
    fn the_auto_token_rides_only_when_the_phrase_asked() {
        let event = ev(json!({ "kind": "cc", "mob": "King Tranix" }));
        assert_eq!(with_auto_captures(None, false, &event), None);
        let got = with_auto_captures(None, true, &event).expect("a target");
        assert_eq!(got.get("target").map(String::as_str), Some("King Tranix"));
    }

    /// A group the pattern declared under that name is more specific than the table, and wins.
    #[test]
    fn a_declared_group_beats_the_auto_token() {
        let event = ev(json!({ "kind": "cc", "mob": "King Tranix" }));
        let declared = harvest(r"(?<target>\w+)", "Rowel");
        let got = with_auto_captures(declared, true, &event).expect("the declared value");
        assert_eq!(got.get("target").map(String::as_str), Some("Rowel"));
    }

    /// The cap is a property of the firing, so a def cannot buy a ninth value by asking for it a
    /// different way.
    #[test]
    fn a_full_firing_takes_no_auto_token() {
        let event = ev(json!({ "kind": "cc", "mob": "King Tranix" }));
        let pattern: String = (0..MAX_CAPTURE_GROUPS)
            .map(|i| format!("(?<g{i}>[a-z])"))
            .collect::<Vec<_>>()
            .join("");
        let full = harvest(&pattern, "abcdefgh");
        let got = with_auto_captures(full, true, &event).expect("the eight");
        assert_eq!(got.len(), MAX_CAPTURE_GROUPS);
        assert!(!got.contains_key("target"));
    }

    /// A family the table does not carry leaves the token unresolved, which renders literally rather
    /// than as an empty string.
    #[test]
    fn a_family_that_names_nobody_adds_no_key() {
        let event = ev(json!({ "kind": "zone", "zone": "Freeport" }));
        assert_eq!(with_auto_captures(None, true, &event), None);
    }
}
