//! THE ALERTS MODULE'S SPEECH HALF (JOS-500, owner ruling 27) — `shared/alertCaptures.ts` and
//! `shared/alertTargets.ts`, ported for the fields a fire frame grew.
//!
//! ── WHY THIS FILE EXISTS, AND WHY IT IS NOT `alerts_rules.rs` ──────────────────────────────────
//!
//! `alerts_rules.rs` decides WHETHER a line makes a sound. This decides what that sound may SAY,
//! and until this ticket the answer was "nothing it captured" — `FireMessage` had four fields and
//! `alertsAudioRules.ts` named the loss out loud ("costs a firing some of its WORDS"). That was a
//! survivable degradation only while the app still had an evaluator to fall back to; JOS-499
//! deleted it, and ruling 27 made the missing words release-gating. So the two shared modules that
//! own the answer are ported here, beside the matcher that feeds them and away from it — the same
//! cut `alertsFields.ts` makes app-side, and for the same reason: a matcher and a sanitizer are
//! different kinds of thing and one file holding both would be past the factoring ceiling.
//!
//! ── THE THREAT MODEL IS NOT RE-DERIVED HERE. IT IS OBEYED. ─────────────────────────────────────
//!
//! Read `src/shared/alertCaptures.ts` before changing anything below; it is the statement and this
//! is one of its enforcement points. The short form of why any of this is bounded at all: ALERT
//! DEFINITIONS ARE SHAREABLE (`shareSchema.ts` encodes them into `EQC1-` strings people paste to
//! each other, and the neighbouring ecosystem merges stranger-authored trigger sets out of chat
//! with no prompt), and LOG LINES ARE ATTACKER-INFLUENCED (other players' chosen names, and for the
//! chat families text a stranger TYPED). A capture group is therefore a channel with a third party
//! at each end: a pattern the user may not have written, selecting text a stranger did write, which
//! the app then SPEAKS ALOUD. Two controls answer it and both are enforced HERE as well as over
//! there, because a safety property that depends on the other side having been careful is not one:
//!
//!   1. THE SANITIZER IS UNCONDITIONAL ([`sanitize_capture`]). ANSI/VT sequences leave WHOLE, every
//!      C0/C1/DEL control is deleted, CR/LF/TAB collapse to one space, and the invisible + BiDi
//!      override class (the "Trojan Source" family, which makes one string RENDER as another) is
//!      deleted.
//!   2. A VALUE IS CAPPED AT [`MAX_CAPTURE_CHARS`] AND A FIRING AT [`MAX_CAPTURE_GROUPS`]. A hostile
//!      pattern may write `(?<x>.+)`; it cannot vacuum a 300-character log line into a speaker.
//!
//! Control 3 — that a value may only come from the text the def's OWN condition just tested — is
//! structural and lives in `alerts_rules.rs`, which is the only caller of [`harvest_captures`] and
//! hands it the one regex that just matched and the one text it matched against. There is no path
//! here to another event, another alert, or engine state, and there are no ambient tokens.
//!
//! ── ONE HONEST DIVERGENCE: WHERE THE CAP FALLS ────────────────────────────────────────────────
//!
//! JS `String.prototype.slice` counts UTF-16 CODE UNITS; this counts CHARS (`char_indices`), which
//! is the same number for everything either side can actually see. EQ character names are ASCII by
//! the game's own rules, mob display names in the shipped 7.9k-row DB are ASCII, and the parser's
//! sentinels are literals this file writes itself. The two answers could only differ for a value
//! containing astral-plane text at exactly the 48-character boundary, and the cap is a bound rather
//! than a contract — the divergence catalogue in docs/plans/data-server.md is where this belongs
//! rather than a `char::len_utf16` sum that would be slower and no more true.

use crate::event::Event;
use regex::{Captures, Regex};
use std::collections::BTreeMap;

/// The captures a firing carries — `FiredAlert.captures`, and the payload of `FireMessage.captures`.
///
/// A `BTreeMap` rather than an insertion-ordered map, and the difference is deliberate: the wire
/// type generated from the schema IS one (`protocol::generated::FireCaptures`), so a sorted map
/// here means the frame serializes reproducibly rather than in whichever order the pattern happened
/// to declare its groups. KEY ORDER IS NOT A CLAIM — every consumer looks a token up by name — but
/// WHICH KEYS SURVIVED the [`MAX_CAPTURE_GROUPS`] cap certainly is, and that is decided in
/// declaration order below, before anything is sorted.
pub type CaptureMap = BTreeMap<String, String>;

/// Longest a SINGLE captured value may be, in characters — control 2, and `MAX_CAPTURE_CHARS`.
///
/// 48 is a name's worth of text, not a line's. EQ character names are at most 15 characters and the
/// longest mob display names in the shipped DB sit under 40. It is 40% of the utterance cap, which
/// is the point: no single token can spend the whole budget on one stranger's sentence.
pub const MAX_CAPTURE_CHARS: usize = 48;

/// Most named groups carried from one firing — `MAX_CAPTURE_GROUPS`. No honest pattern names eight
/// things, and a pattern that names eighty must not turn every matching line into a payload. Groups
/// past the bound are DROPPED, so their tokens render literally (which is visible) rather than
/// resolving to something unbounded (which is not).
pub const MAX_CAPTURE_GROUPS: usize = 8;

// ── control 1: the sanitizer ───────────────────────────────────────────────────────────────────

/// Whether `c` is a C0 control, DEL, or a C1 control — `CONTROL_ANY_RE`. Nothing in this class is
/// content.
fn is_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1F}' | '\u{7F}'..='\u{9F}')
}

/// Whether `c` renders as nothing, or reorders what renders around it — `INVISIBLE_RE`.
///
/// ZWSP/ZWNJ/ZWJ and the LRM/RLM marks, LINE and PARAGRAPH SEPARATOR plus the BiDi embeddings and
/// OVERRIDES (the "Trojan Source" class), the word joiner and the invisible operators, the BiDi
/// isolates, and the BOM/ZWNBSP. Written as the same four ranges plus one the TS lists, in the same
/// order, so the two can be diffed by eye.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}'
        | '\u{2028}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}')
}

/// In a ONE-LINE rendering these three become a single space; every other control is deleted —
/// `AS_SPACE`. A captured value must not be able to forge a second line on any surface that prints
/// it.
fn is_space_control(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r')
}

/// Strip ANSI/VT escape sequences WHOLE — `stripAnsi`/`ANSI_RE`, ported arm for arm so the payload
/// (`[31m`, `]0;title`) leaves with the ESC instead of being left behind as visible litter.
///
/// Four ORDERED arms, and the order is the design:
///   1. CSI            `ESC [` params intermediates final — colours, cursor moves, erase-display
///   2. string-openers `ESC ] P ^ _ X` … BEL|ST — OSC (window title, and OSC 52, which WRITES THE
///      OPERATOR'S CLIPBOARD), DCS, PM, APC, SOS; payload eaten whole
///   3. nF             `ESC <0x20..0x2F>+ <0x30..0x7E>` — charset selection, e.g. `ESC ( B`
///   4. anything else  `ESC <one printable>` — the C1 twins, `ESC c` (full terminal reset), and the
///      private forms
///
/// ARM 4 IS THE CATCH-ALL ON PURPOSE: an ESC this function does not recognise must still lose its
/// ESC, so a malformed CSI/OSC falls out of arms 1-2 into it and is defanged rather than passed
/// through. A trailing lone ESC matches no arm and is deleted by the control class in
/// [`sanitize_one_line`], as are the C1 single-byte equivalents (0x9B CSI, 0x9D OSC).
///
/// HAND-WRITTEN RATHER THAN A `Regex`, because this runs on a value that just came off a log line
/// and the pattern is four alternations of character classes — a scanner is the shape the thing
/// actually is, and it costs no compile.
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
            // A trailing lone ESC. Consumed here so the control sweep does not have to be the only
            // thing standing between it and a terminal; either way it does not survive.
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
                    // `ESC \` is the String Terminator. A bare ESC that is NOT the `\` form opens a
                    // new sequence and is left for the next pass of the loop, which is what the
                    // TS's `(?:\x07|\x1B\\)?` optional tail does.
                    Some('\u{1B}') if chars.get(i + 1) == Some(&'\\') => i += 2,
                    _ => {}
                }
            }
            // Arm 3 — nF: one or more intermediates then one final. Falls through to arm 4's shape
            // when no final follows, which is the same "the ESC still goes" answer.
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
            // Arm 4 — the catch-all. One printable goes with the ESC; anything else (a control, a
            // non-ASCII char) keeps only the ESC's own deletion, so it is pushed back.
            c if ('\u{20}'..='\u{7E}').contains(&c) => {}
            _ => {
                i -= 1;
            }
        }
    }
    out
}

/// The DISPLAY normalizer for anything that must occupy exactly one line — `sanitizeOneLine`.
///
/// ANSI sequences go WHOLE first (so their payload leaves with the ESC), then CR/CRLF fold to LF,
/// then TAB/LF/CR become one space and every other control is deleted, then the invisibles go. The
/// ORDER is the contract: capping before stripping would let the byte count of an escape sequence
/// buy a hostile pattern extra room under the cap.
fn sanitize_one_line(raw: &str) -> String {
    let ansi_free = strip_ansi(raw);
    // `NEWLINE_RE` — CR and CRLF normalized to LF before anything else looks at the string. Both
    // ends fold to one space below, so this is expressed as "a CR followed by an LF is one break".
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

/// Take `n` CHARS of `text` — the cap's cut, and the one place the UTF-16 divergence in this file's
/// header lives.
fn take_chars(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((byte, _)) => &text[..byte],
        None => text,
    }
}

/// ONE captured value, made safe — controls 1 and 2, in the order that matters (`sanitizeCapture`).
///
/// SANITIZE BEFORE CAPPING. A truncation that cut an ANSI sequence in half would leave the ESC
/// behind for the control class to delete, but it would also let the byte count of an escape
/// sequence buy a hostile pattern extra room under the cap. Strip first, then measure what is left,
/// then trim again — the strip can expose new edge whitespace (`\x1B[31m ` becomes ` `).
///
/// `None` is "nothing survived", which every caller treats as "this group captured nothing": its
/// token renders LITERALLY rather than resolving to an empty string, so a phrase never silently
/// collapses into a shorter, different sentence.
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

// ── control 2 + 3: what one match may name ─────────────────────────────────────────────────────

/// Turn a match's NAMED groups into the bounded, sanitized map a firing may carry —
/// `harvestCaptures`.
///
/// The ONE place raw regex output becomes a firing's captures, so every producer gets the same
/// bounds whether it matched a raw line or a `where` field. `None` when nothing survived: an absent
/// key is the honest encoding of "this pattern named nothing", and it keeps the frame byte-identical
/// for the overwhelming majority of alerts, which capture nothing at all.
///
/// DECLARATION ORDER IS WHAT THE CAP CUTS ON, matching `Object.keys(m.groups)` over there — a JS
/// groups object is keyed in the order the pattern declared them, and `Regex::capture_names` yields
/// them in the same order. The map it collects into is sorted, but the DROP is decided before that.
/// Unnamed groups are skipped: a token is a declaration, and a positional group declares nothing.
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

/// Merge one condition's captures into an accumulator, FIRST WRITER WINS — `mergeCaptures`.
///
/// First-writer-wins is source order, which is the rule the whole evaluator reads by: an 'all'
/// composite means every condition matched this one event, so every one of them is "the condition
/// that matched" and all their names are in scope. `None` stays `None`, so an alert that captured
/// nothing carries nothing.
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

// ── the one auto token (JOS-353) ───────────────────────────────────────────────────────────────

/// WHICH FIELD OF WHICH KIND NAMES THE ENTITY — `TARGET_FIELD_BY_KIND`, the closed table.
///
/// Returns the field holding the entity's display name, and what an ABSENT field MEANS when absence
/// is itself a statement. Only `buffFade` has the second: `Your <Spell> spell has worn off.` with no
/// "of <mob>" and no "pet's" IS the self form, and the parser omits `target` for exactly that shape.
/// Everywhere else an absent field is an absent answer and the token renders literally.
///
/// THE FAMILIES DIVIDE INTO THREE GROUPS and all three are here, because a user asking "who did this
/// land on" does not care which of the parser's kinds carried the answer:
///
///   * THE SPELL LANES — `buffApply`, `buffExpired`, `buffWearOff`, `illusionFade`, `buffFade`,
///     `resist`, `heal`, `healUnstated`, `poisonProc`.
///   * THE HOLD LANES, WHICH SPELL IT `mob` — and this is the whole reason the table exists rather
///     than a property read. `cc` is the mez/root landing and the break, `ccWake` is the hold ending
///     because something hit it, `charm`/`uncharm` are the charm pair. A user writing `{target}` on
///     a mez-break alert must not have to know the parser calls it `mob`.
///   * THE COMBAT LANES — `damage` and `miss`. A nuke alert saying which mob it hit is the same
///     question with a different verb.
///
/// `spellEmote.subject` is here too: it is 'self' or the pet name, resolved exactly like the rest.
///
/// EXCLUDED BY NAME, and the exclusions are the point. `itemMergeFailed` spells an ITEM name
/// `target` — speaking a Coldain Prayer Shawl as the mob a spell is affecting would be a wrong
/// answer wearing the right field name. `consider` names a mob no spell is touching. Both refusals
/// are the app's (`TARGET_FIELD_EXCLUDED_KINDS`) and are reproduced by OMISSION here, which is the
/// same answer: a kind absent from this table resolves nothing.
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

/// THE SENTINELS THE PARSER WRITES, AND WHAT THEY ARE ALOUD — `SENTINEL_SPEECH`.
///
/// `self` and `pet` are not names; they are the parser's words for "the first-person form" and "the
/// `Your pet's …` form". Speaking them raw would say "Clarity wore off self", which is nobody's
/// sentence. Rendering them as English is a reading of the parser's own vocabulary, not a guess
/// about the world.
///
/// MATCHED EXACTLY, NEVER CASE-FOLDED, and that matters: the sentinels are lowercase literals the
/// parser writes itself, while a real name arrives with the game's own casing. A player named `Self`
/// yields the string `Self` and is spoken as `Self`, which is their name.
fn sentinel_speech(value: &str) -> Option<&'static str> {
    match value {
        "self" => Some("you"),
        "pet" => Some("your pet"),
        _ => None,
    }
}

/// WHO THIS EVENT IS ABOUT, ready to speak — or `None` when this family names nobody
/// (`resolveTarget`).
///
/// `None` rather than an empty string is what makes the token render LITERALLY, which is the
/// documented behaviour for a value that is not there: `Mez broke on {target}` is a legible,
/// debuggable sentence and `Mez broke on` is a different, quietly wrong one.
///
/// THE EMPTY FIELD AND THE MISSING FIELD GET THE SAME ANSWER, deliberately — the app writes `||`
/// there rather than `??` for exactly this reason, so a whitespace-only target cannot win over the
/// stated meaning of an absence.
///
/// The dynamic field read mirrors the one every `where` matcher has always done, so it opens no new
/// escape hatch — and it is bounded to this table's own field names, never to a key any def
/// supplies. Sanitized AFTER the sentinel read (so a sentinel is matched against exactly what the
/// parser wrote) and BEFORE anything can speak it.
pub fn resolve_target(ev: &Event) -> Option<String> {
    let (field, absent) = target_field_of(ev.kind())?;
    let text = ev.str(field).unwrap_or_default().trim();
    let value = if text.is_empty() { absent? } else { text };
    sanitize_capture(sentinel_speech(value).unwrap_or(value))
}

/// Does this def's spoken phrase write `{target}` — `autoTokensWanted`, for the closed list of one.
///
/// IT READS THE PHRASE, NOT THE TRIGGER, and that is the compile-time gate that keeps a target off
/// every firing that never asked for one: whether a value is worth carrying is a question about what
/// the def will SAY. A def with no custom phrase wants nothing, so its frame is byte-identical to
/// the one it sent before this field existed.
///
/// A SUBSTRING TEST IS THE EXACT PORT, not an approximation of one. Over there the phrase is scanned
/// with the token grammar `\{([A-Za-z_][A-Za-z0-9_]*)\}` and the result filtered against the auto
/// token list, whose only member is `target`. A token whose NAME is `target` is the substring
/// `{target}` and nothing else can produce it — the grammar admits no whitespace, no modifiers and
/// no nesting (control 5: the template language is not a language). So the two agree by
/// construction, and this stays one line instead of compiling a regex per def.
pub fn wants_target_token(phrase: Option<&str>) -> bool {
    phrase.is_some_and(|p| p.contains("{target}"))
}

/// Merge the auto token into a match's own captures — `withAutoCaptures`.
///
/// THE PATTERN'S OWN GROUP ALWAYS WINS. A def that declared `(?<target>…)` and matched it has said
/// something more specific than the table can, and control 4 ("a token is a declaration") is exactly
/// what that rule protects: the exemption widens what a phrase can say, it does not overrule what a
/// pattern said.
///
/// AND THE GROUP BOUND STILL GOVERNS. A firing already carrying [`MAX_CAPTURE_GROUPS`] values takes
/// no auto token — the cap is a property of the FIRING, not of any one producer, or a def could buy
/// itself a ninth value by asking for it a different way.
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

    // ── control 1 ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn an_ordinary_name_survives_untouched() {
        assert_eq!(sanitize_capture("Fail").as_deref(), Some("Fail"));
        assert_eq!(
            sanitize_capture("Coercer T`vala").as_deref(),
            Some("Coercer T`vala")
        );
    }

    /// OSC 52 WRITES THE OPERATOR'S CLIPBOARD and `ESC c` resets a terminal. Both leave WHOLE —
    /// payload included — rather than being defanged into visible litter.
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

    // ── control 2 ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_hostile_pattern_cannot_vacuum_a_line_into_the_speaker() {
        let long = "A".repeat(300);
        let got = sanitize_capture(&long).expect("something survives");
        assert_eq!(got.chars().count(), MAX_CAPTURE_CHARS);
        // The strip can expose new edge whitespace, and the cut is trimmed AFTER the cap.
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
        // THE CUT IS DECLARATION ORDER, not the sorted order the map ends up in — the first eight
        // the pattern declared are what survived.
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

    // ── the auto token ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_table_reads_the_field_each_family_actually_uses() {
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "buffApply", "target": "King Tranix" }))).as_deref(),
            Some("King Tranix")
        );
        // THE HOLD LANES SPELL IT `mob`, which is the whole reason the table exists.
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "cc", "mob": "a young puma" }))).as_deref(),
            Some("a young puma")
        );
        assert_eq!(
            resolve_target(&ev(json!({ "kind": "spellEmote", "subject": "Rowel" }))).as_deref(),
            Some("Rowel")
        );
    }

    /// Speaking an ITEM as the mob a spell is affecting would be a wrong answer wearing the right
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
        // AN ABSENT `buffFade.target` IS THE SELF FORM — absence as a statement, and the one entry
        // in the table that has one.
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
        // Every other family's absent field is an absent ANSWER, not a self form.
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

    /// Control 4: a token is a DECLARATION. A group the pattern declared under that name is more
    /// specific than the table, and always wins.
    #[test]
    fn a_declared_group_beats_the_auto_token() {
        let event = ev(json!({ "kind": "cc", "mob": "King Tranix" }));
        let declared = harvest(r"(?<target>\w+)", "Rowel");
        let got = with_auto_captures(declared, true, &event).expect("the declared value");
        assert_eq!(got.get("target").map(String::as_str), Some("Rowel"));
    }

    /// The cap is a property of the FIRING, so a def cannot buy a ninth value by asking for it a
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
