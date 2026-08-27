//! `src/main/log/parseSession.ts` — the three lines that say whether the character is IN THE WORLD
//! at all, plus the `/outputfile` receipt.

use crate::event::{Ev, Key, Kind};
use crate::jsstr::js_trim;

use super::Ctx;

const WELCOME_LINE: &str = "Welcome to EverQuest Legends!";
const CAMP_START_LINE: &str = "It will take you about 30 seconds to prepare your camp.";
const CAMP_ABORT_LINE: &str = "You abandon your preparations to camp.";
const OUTPUT_FILE_PREFIX: &str = "Outputfile Complete: ";

/// Gated on the leading `W` before the string compare, so the hot path pays one character test.
pub fn classify_session_start(c: &Ctx, out: &mut Ev) -> bool {
    if c.text.as_bytes().first() != Some(&b'W') || c.text != WELCOME_LINE {
        return false;
    }
    out.begin(Kind::SessionStart);
    out.envelope(c.seq, c.ts, c.raw);
    true
}

/// Camp initiation and cancellation — one fact with two outcomes.
pub fn classify_camp(c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.ends_with("camp.") {
        return false;
    }
    if c.text == CAMP_START_LINE {
        out.begin(Kind::CampStart);
        out.envelope(c.seq, c.ts, c.raw);
        return true;
    }
    if c.text == CAMP_ABORT_LINE {
        out.begin(Kind::CampAbort);
        out.envelope(c.seq, c.ts, c.raw);
        return true;
    }
    false
}

/// `Outputfile Complete: <file>` — a dump with an EMPTY name declines rather than emitting nothing.
pub fn classify_output_file(c: &Ctx, out: &mut Ev) -> bool {
    if c.text.as_bytes().first() != Some(&b'O') || !c.text.starts_with(OUTPUT_FILE_PREFIX) {
        return false;
    }
    let file = js_trim(&c.text[OUTPUT_FILE_PREFIX.len()..]);
    if file.is_empty() {
        return false;
    }
    out.begin(Kind::OutputFile);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::File, file);
    true
}
