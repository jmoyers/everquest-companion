//! ONE SOCKET, TWO DIRECTIONS, TWO TRANSPORTS — and no byte of framing knowledge in this crate.
//!
//! A connection has two threads: one blocked reading requests, one draining an outbox of replies
//! and connection-wide announcements. Two threads may not share one `Write` — `write_all` is not
//! atomic against a concurrent writer, and two half-written JSON lines interleaved on a socket is a
//! peer that closes the connection on a decode error it cannot explain. So the socket is split, the
//! writer half has exactly one owner, and each half is a full [`NdjsonTransport`] whose unused
//! direction is wired to a null stream: `io::empty()` for a writer that never reads,
//! `io::sink()` for a reader that never writes.
//!
//! THAT IS THE POINT, NOT A WORKAROUND. The alternative — reaching past the transport to write
//! bytes to the socket directly — would put a newline in this crate, and `protocol::transport` is
//! built so that the entire tree above it can be moved onto WebSockets by adding one sibling file
//! (owner ruling 15). A crate that framed even one message itself would be the exception that
//! makes that promise false.
//!
//! THE INBOUND TYPE IS `serde_json::Value`, NOT `ClientMessage`, AND THAT IS DELIBERATE — see
//! [`crate::ops::classify`] for the whole argument. In one line: `ClientMessage` is an untagged
//! union, so a request with an op this build has never heard of fails to deserialize as a WHOLE
//! message and takes its `id` down with it — and an error reply that cannot name a request id is a
//! client that hangs. The raw value is kept for exactly that correlation; every shape the engine
//! reads or writes still comes from the generated types.

use std::io::{self, BufReader};
use std::net::TcpStream;

use protocol::generated::EngineMessage;
use protocol::transport::ndjson::NdjsonTransport;

/// The read half: requests in, nothing out.
pub type Incoming =
    NdjsonTransport<BufReader<TcpStream>, io::Sink, EngineMessage, serde_json::Value>;

/// The write half: messages out, nothing in.
pub type Outgoing = NdjsonTransport<io::Empty, TcpStream, EngineMessage, serde_json::Value>;

/// How long a single write may take before the connection is treated as gone.
///
/// It exists so a peer that stops draining its socket cannot pin a writer thread forever — and
/// so the connection tear-down, which joins that thread to make sure a courtesy refusal actually
/// reached the wire, is bounded. Thirty seconds is absurdly generous for messages this size and
/// far short of forever, which is the only other number available.
const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Split one accepted connection into its two transports.
///
/// # Errors
/// [`std::io::Error`] if the socket cannot be duplicated or configured — which is a connection that
/// never really existed, and is answered by dropping it.
pub fn split(stream: TcpStream) -> io::Result<(Incoming, Outgoing)> {
    let write_half = stream.try_clone()?;
    write_half.set_write_timeout(Some(WRITE_TIMEOUT))?;
    // NODELAY, because every message this protocol sends is one the other side is waiting for: a
    // reply, a reset, a meter tick. Nagle would hold a small frame back looking for company that
    // is not coming.
    write_half.set_nodelay(true)?;
    Ok((
        NdjsonTransport::new(BufReader::new(stream), io::sink()),
        NdjsonTransport::new(io::empty(), write_half),
    ))
}
