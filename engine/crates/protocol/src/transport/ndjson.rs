//! NDJSON framing — one JSON message per LF-terminated line. The only module in the crate that
//! knows a newline exists; a different wire is a sibling of this file.
//!
//! LF is safe as a delimiter because `serde_json` escapes every control character inside a string,
//! so a serialized message can never contain a raw newline however hostile its contents. That is a
//! property of JSON, not of this app's data.
//!
//! The delimiter is LF, never CRLF: every stream this transport touches is opened in binary, and a
//! trailing `\r` is stripped on decode rather than trusted, so a CRLF-framing peer still reads
//! correctly.

use std::io::{BufRead, Write};
use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use serde::Serialize;

use super::{Transport, TransportError};

/// The frame delimiter. One byte, and the only one this crate treats as structural.
pub const DELIMITER: u8 = b'\n';

/// The largest single frame this transport will assemble, in bytes.
///
/// A framing guard, not a protocol rule: a peer that never sends a delimiter would otherwise grow
/// the read buffer without bound. Payload budgets are a protocol concern and live engine-side.
/// 8 MiB is far above any legitimate message and far below anything that threatens the process.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Serialize one message into its wire form: the JSON, then the delimiter.
///
/// # Errors
/// [`TransportError::Encode`] if the message will not serialize.
pub fn encode_line<T: Serialize>(message: &T) -> Result<String, TransportError> {
    let mut line = serde_json::to_string(message).map_err(TransportError::Encode)?;
    line.push(char::from(DELIMITER));
    Ok(line)
}

/// Parse one wire line back into a message. The line must not carry its delimiter; a trailing `\r`
/// is tolerated so a CRLF-framing peer is still understood.
///
/// # Errors
/// [`TransportError::Decode`] if the line is not a message of this type.
pub fn decode_line<T: DeserializeOwned>(line: &str) -> Result<T, TransportError> {
    let trimmed = line.strip_suffix('\r').unwrap_or(line);
    serde_json::from_str(trimmed).map_err(TransportError::Decode)
}

/// Parse one complete frame's bytes back into a message — what [`NdjsonTransport::recv`] uses.
///
/// The text conversion happens exactly once, over a whole frame, for correctness rather than speed:
/// a UTF-8 character is up to four bytes and a read boundary falls wherever the OS puts it, so a
/// character routinely straddles two reads. Decoding each read separately (`from_utf8_lossy`)
/// replaces each half with U+FFFD, and because both halves sit inside a JSON string the corrupted
/// frame still parses — the message arrives looking fine and says something the peer never sent.
///
/// # Errors
/// [`TransportError::Decode`] if the frame is not valid UTF-8, or is not a message of this type.
/// Broken UTF-8 is a refusal, never a lossy accept.
pub fn decode_frame<T: DeserializeOwned>(frame: &[u8]) -> Result<T, TransportError> {
    let text = std::str::from_utf8(frame).map_err(|e| {
        TransportError::Decode(<serde_json::Error as serde::de::Error>::custom(format!(
            "a frame was not valid UTF-8 ({e})"
        )))
    })?;
    decode_line(text)
}

/// A [`Transport`] over any pair of byte streams.
///
/// Generic over the streams rather than tied to a socket, so the suite can drive it over in-memory
/// buffers. `R` is buffered because framing needs to read up to a delimiter.
pub struct NdjsonTransport<R: BufRead, W: Write, Out: Serialize, In: DeserializeOwned> {
    reader: R,
    writer: W,
    /// The frame being assembled, as bytes. Never a `String`: see [`decode_frame`] for why text
    /// conversion may only happen once a whole frame is in hand.
    frame: Vec<u8>,
    outbound: PhantomData<Out>,
    inbound: PhantomData<In>,
}

impl<R: BufRead, W: Write, Out: Serialize, In: DeserializeOwned> NdjsonTransport<R, W, Out, In> {
    /// Wrap a reader and a writer. Nothing is read or written until [`Transport::send`] or
    /// [`Transport::recv`] is called.
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader,
            writer,
            frame: Vec::new(),
            outbound: PhantomData,
            inbound: PhantomData,
        }
    }

    /// Give back the streams, so a test can inspect exactly what was written.
    pub fn into_inner(self) -> (R, W) {
        (self.reader, self.writer)
    }
}

impl<R: BufRead, W: Write, Out: Serialize, In: DeserializeOwned> Transport
    for NdjsonTransport<R, W, Out, In>
{
    type Outbound = Out;
    type Inbound = In;

    fn send(&mut self, message: &Out) -> Result<(), TransportError> {
        let line = encode_line(message)?;
        self.writer.write_all(line.as_bytes())?;
        // Flushed per message: this protocol is live, and a frame held in a buffer until the next
        // one pushes it out is a meter that reads one frame late.
        self.writer.flush()?;
        Ok(())
    }

    fn recv(&mut self) -> Result<Option<In>, TransportError> {
        self.frame.clear();
        loop {
            let available = self.reader.fill_buf()?;
            if available.is_empty() {
                // End of stream. A partial frame here is a truncated one, so it decodes and fails
                // rather than returning a quiet `None`: discarding half a message silently is how a
                // client ends up rendering a world that was never sent.
                if self.frame.is_empty() {
                    return Ok(None);
                }
                return decode_frame(&self.frame).map(Some);
            }
            let (chunk, found) = match available.iter().position(|b| *b == DELIMITER) {
                Some(at) => (&available[..at], true),
                None => (available, false),
            };
            // The limit is in bytes, which is what a frame is made of and what a hostile peer
            // spends.
            if self.frame.len() + chunk.len() > MAX_LINE_BYTES {
                return Err(TransportError::FrameTooLarge {
                    limit: MAX_LINE_BYTES,
                });
            }
            // Bytes in, bytes out: a read boundary is an OS artifact and must not be able to change
            // a message's contents. Text conversion happens once, in `decode_frame`.
            self.frame.extend_from_slice(chunk);
            let consumed = chunk.len() + usize::from(found);
            self.reader.consume(consumed);
            if found {
                return decode_frame(&self.frame).map(Some);
            }
        }
    }
}
