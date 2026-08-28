//! The byte-accurate line splitter, and the seq discipline. Five rules:
//!
//!   1. Split on the newline byte, then decode each line once, whole. The order decides where a
//!      U+FFFD lands when a log holds invalid UTF-8.
//!   2. A trailing `\r` is stripped as a byte, before the decoder sees it.
//!   3. An empty line is dropped by the splitter: it never reaches the parser and never takes a seq.
//!   4. A line with no timestamp does not advance `seq`, which starts at 0 and counts events.
//!   5. A trailing partial line — the bytes after the last `\n` — is not folded, because the live
//!      tailer will re-read them when the game finishes the line.

use crate::event::{Ev, Payload};
use crate::parse::Parser;

/// Fold a complete file, calling `emit` with each event's serialized JSON and its typed payload, in
/// emission order. Returns the number of events.
///
/// Both halves, always: the string is the parser oracle's artifact, the payload is what the fold
/// reads, and the writer's buffers are reused — so a caller that took only one could not ask for
/// the other afterwards.
pub fn scan_bytes(parser: &Parser, bytes: &[u8], mut emit: impl FnMut(&str, &Payload)) -> u64 {
    let mut seq: i64 = 0;
    let mut ev = Ev::new();
    let mut start = 0usize;
    while let Some(off) = memchr(b'\n', &bytes[start..]) {
        let nl = start + off;
        let mut end = nl;
        if end > start && bytes[end - 1] == b'\r' {
            end -= 1;
        }
        if end > start {
            let line = String::from_utf8_lossy(&bytes[start..end]);
            if parser.parse_event(&line, seq, &mut ev) {
                seq += 1;
                let (json, payload) = ev.done();
                emit(json, payload);
            }
        }
        start = nl + 1;
    }
    seq as u64
}

/// Hand-rolled rather than a dependency: one byte, one scan. Shared with `tail.rs` so the scan and
/// the live tail cannot split on different bytes.
pub(crate) fn memchr(needle: u8, haystack: &[u8]) -> Option<usize> {
    haystack.iter().position(|&b| b == needle)
}
