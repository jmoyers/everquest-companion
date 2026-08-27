//! `src/main/log/scanHistory.ts` — the byte-accurate line splitter, and the seq discipline.
//!
//! THE FOUR RULES THIS FILE EXISTS TO REPRODUCE, each with its TS line:
//!
//!   1. SPLIT ON THE NEWLINE BYTE, decode each line exactly once, whole (`consumeChunk`). The TS
//!      splits before decoding because a read boundary lands mid-character once a megabyte and a
//!      half-decoded character is destroyed permanently; here the whole file is one buffer, so the
//!      hazard is absent — but the ORDER (split as bytes, decode per line) is kept anyway, because
//!      it is what decides where a U+FFFD lands when a log really does hold invalid UTF-8.
//!   2. A TRAILING `\r` IS STRIPPED AS A BYTE, before the decoder sees it (:213).
//!   3. AN EMPTY LINE IS DROPPED BY THE SPLITTER — `if (end > 0) handle(...)` (:214). It never
//!      reaches the parser and never takes a seq.
//!   4. A LINE WITH NO TIMESTAMP RETURNS NULL AND DOES NOT ADVANCE `seq` (:292-294). `seq` starts
//!      at 0 and counts EVENTS, not lines.
//!
//! AND THE FIFTH, which is about what is NOT read: a trailing partial line — the bytes after the
//! last `\n` — is deliberately not folded. `consumeChunk` only ever hands `handle` a line whose
//! terminating newline it has in hand, and `scanLog` returns without flushing the carry, because
//! the live tailer will re-read those bytes when the game finishes the line.

use crate::event::{Ev, Payload};
use crate::parse::Parser;

/// Fold a complete file, calling `emit` with each event's serialized JSON AND its typed payload, in
/// emission order. Returns the number of events (which is `ScanResult.seq`).
///
/// BOTH HALVES, ALWAYS (JOS-505). The string is the parser oracle's artifact and the NDJSON modes'
/// output; the payload is what the fold reads. They are handed over together because they are one
/// event written twice, and a caller that took only one of them would have no way to ask for the
/// other afterwards — the writer's buffers are reused and the next line overwrites both.
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

/// `Buffer.indexOf(NEWLINE, …)`. Hand-rolled rather than a dependency: one byte, one scan.
/// Shared with `tail.rs` so the scan and the live tail cannot split on different bytes.
pub(crate) fn memchr(needle: u8, haystack: &[u8]) -> Option<usize> {
    haystack.iter().position(|&b| b == needle)
}
