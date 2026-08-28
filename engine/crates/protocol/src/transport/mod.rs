//! The seam: a transport moves whole messages, and only what is below it knows about bytes.
//!
//! The wire method must be swappable, so `protocol/schema/` describes messages and never bytes — no
//! newline, no length prefix, no port, no host — and the generated types carry no framing either.
//! Everything above this crate talks to a [`Transport`] and cannot learn what a frame is.
//!
//! * [`ndjson::NdjsonTransport`] — one JSON message per LF-terminated line. The only module in this
//!   crate that mentions a newline, and the only one that changes if the framing does.
//! * [`memory::MemoryTransport`] — a connected pair with no bytes at all, for tests. It is the proof
//!   the seam is real: the same conversation runs over it and over NDJSON with identical results,
//!   and a conversation that runs with no framing cannot be depending on one.
//!
//! A new wire is a new sibling file here. Nothing above it moves.

pub mod memory;
pub mod ndjson;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Everything that can go wrong moving a message, at the level a caller can act on.
#[derive(Debug)]
pub enum TransportError {
    /// The message could not be turned into its wire form.
    Encode(serde_json::Error),
    /// What arrived was not a message this side understands. The peer is not trusted to send
    /// well-formed input, even over loopback: a decode failure is a protocol error to report and a
    /// connection to close, never a panic.
    Decode(serde_json::Error),
    /// The underlying byte stream failed. Only framed transports can produce this.
    Io(std::io::Error),
    /// A frame exceeded the transport's own limit — a framing concern, never a protocol one.
    FrameTooLarge {
        /// The limit that was passed, in bytes.
        limit: usize,
    },
    /// The peer is gone. Not an error to retry: a reconnect is a fresh launch and a resume is a
    /// re-query.
    Closed,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Encode(e) => write!(f, "could not encode message: {e}"),
            Self::Decode(e) => write!(f, "could not decode message: {e}"),
            Self::Io(e) => write!(f, "transport io: {e}"),
            Self::FrameTooLarge { limit } => write!(f, "frame exceeded {limit} bytes"),
            Self::Closed => write!(f, "transport closed"),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<std::io::Error> for TransportError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// One end of a connection, in terms of messages.
///
/// The two associated types are what make one trait serve both ends: the engine's transport sends
/// [`crate::EngineMessage`] and receives [`crate::ClientMessage`], the app's the other way round,
/// and neither end can send the other's messages by mistake.
///
/// Nothing here mentions bytes; that absence is the contract.
pub trait Transport {
    /// What this end sends.
    type Outbound: Serialize;
    /// What this end receives.
    type Inbound: DeserializeOwned;

    /// Hand one message to the peer.
    ///
    /// # Errors
    /// [`TransportError::Encode`] if the message will not serialize, [`TransportError::Io`] or
    /// [`TransportError::Closed`] if the peer is unreachable.
    fn send(&mut self, message: &Self::Outbound) -> Result<(), TransportError>;

    /// Take the next message from the peer, or `Ok(None)` when the peer has finished and there is
    /// nothing left to read.
    ///
    /// # Errors
    /// [`TransportError::Decode`] if what arrived is not a message, [`TransportError::Io`] or
    /// [`TransportError::FrameTooLarge`] from the wire beneath.
    fn recv(&mut self) -> Result<Option<Self::Inbound>, TransportError>;
}
