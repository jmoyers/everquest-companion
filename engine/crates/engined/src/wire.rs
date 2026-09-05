//! One socket, two directions, two transports — and no byte of framing knowledge in this crate.
//!
//! Two threads may not share one `Write`: `write_all` is not atomic against a concurrent writer, and
//! two half-written JSON lines interleaved on a socket is a peer closing the connection on a decode
//! error it cannot explain. So the socket is split, the writer half has exactly one owner, and each
//! half is a full [`NdjsonTransport`] whose unused direction is wired to a null stream.
//!
//! That is the point rather than a workaround: reaching past the transport to write bytes directly
//! would put a newline in this crate, and `protocol::transport` is built so the whole tree above it
//! can move onto WebSockets by adding one sibling file.
//!
//! The inbound type is `serde_json::Value` and not `ClientMessage` deliberately — see
//! [`crate::ops::classify`]. In one line: an untagged union takes a request's `id` down with it when
//! the op is unknown, and an error reply that cannot name a request id is a client that hangs.

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
/// A peer that stops draining its socket must not pin a writer thread forever, and the connection
/// tear-down joins that thread to make sure a courtesy refusal reached the wire. Thirty seconds is
/// generous for messages this size and far short of forever, the only other number available.
const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Split one accepted connection into its two transports.
///
/// # Errors
/// [`std::io::Error`] if the socket cannot be duplicated or configured — which is a connection that
/// never really existed, and is answered by dropping it.
pub fn split(stream: TcpStream) -> io::Result<(Incoming, Outgoing)> {
    let write_half = stream.try_clone()?;
    write_half.set_write_timeout(Some(WRITE_TIMEOUT))?;
    // Nodelay, because every message this protocol sends is one the other side is waiting for.
    // Nagle would hold a small frame back looking for company that is not coming.
    write_half.set_nodelay(true)?;
    Ok((
        NdjsonTransport::new(BufReader::new(stream), io::sink()),
        NdjsonTransport::new(io::empty(), write_half),
    ))
}
