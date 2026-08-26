//! THE SEAM. A transport moves whole MESSAGES; only what is below it knows about bytes.
//!
//! THE OWNER'S CONSTRAINT, VERBATIM (JOS-464): *"lets make sure the way this works we could change
//! the wire method at a later date and need to just swap an artifact. im thinking over the open
//! internet via websockets etc."*
//!
//! Its structural consequence is this module's whole reason to exist. `protocol/schema/` describes
//! MESSAGES and never bytes — no newline, no length prefix, no port, no host appears anywhere in
//! it — so the generated types carry no framing either. Everything that will eventually sit above
//! this crate (the API server, the view engine, the fold) talks to a [`Transport`] and therefore
//! cannot learn what a frame is even by accident.
//!
//! Today there are two implementations and today's WIRE is NDJSON:
//!
//! * [`ndjson::NdjsonTransport`] — one JSON message per LF-terminated line over any byte stream.
//!   [`ndjson`] is the ONLY module in this crate that mentions a newline, and the only one that
//!   would change if the framing did.
//! * [`memory::MemoryTransport`] — a connected pair with no bytes at all, for tests. It is not a
//!   toy: it is the proof that the seam is real, because the same protocol conversation runs over
//!   it and over NDJSON with byte-identical results, and a conversation that can run with no
//!   framing at all cannot be depending on one.
//!
//! ADDING WEBSOCKETS IS ADDING A THIRD FILE HERE. Nothing above it moves — not the schema, not the
//! generated types, not a line of protocol logic.

pub mod memory;
pub mod ndjson;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Everything that can go wrong moving a message, at the level a caller can act on.
#[derive(Debug)]
pub enum TransportError {
    /// The message could not be turned into its wire form.
    Encode(serde_json::Error),
    /// What arrived was not a message this side understands. THE PEER IS NOT TRUSTED to send
    /// well-formed input, even over loopback: a decode failure is a protocol error to report and a
    /// connection to close, never a panic.
    Decode(serde_json::Error),
    /// The underlying byte stream failed. Only framed transports can produce this.
    Io(std::io::Error),
    /// A frame exceeded the transport's own limit. A framing concern, never a protocol one — see
    /// [`ndjson::MAX_LINE_BYTES`].
    FrameTooLarge {
        /// The limit that was passed, in bytes.
        limit: usize,
    },
    /// The peer is gone. Not an error to retry: by ruling, a reconnect is a fresh launch and a
    /// resume is always a re-query.
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
/// NOTHING HERE MENTIONS BYTES. That absence is the contract — see the module header.
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
