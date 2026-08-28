//! The data-server wire contract, engine side. No socket, no process, no game logic.
//!
//! 1. [`generated`] — the message types, generated from `protocol/schema/*.schema.json` by
//!    `npm run gen:protocol`. Committed, pinned by a staleness test that regenerates and diffs.
//!    Never hand-edit it.
//! 2. [`transport`] — the seam. A [`transport::Transport`] moves whole messages; exactly one module
//!    below it knows what a frame is, and a different wire is a sibling of that module. Nothing in
//!    `generated`, and nothing above this crate, may learn what a frame is.
//! 3. [`token`] — the per-launch shared secret's constant-time compare. The engine only verifies a
//!    token; minting belongs to whoever spawns the process and hands it the secret.
//!
//! The version is fatal, not negotiable: [`generated::PROTOCOL_VERSION`] is one integer bumped on
//! any breaking change, and a mismatch at hello closes the connection. There is no compatibility
//! mode — both sides generate from the same committed artifact, so skew means half a build shipped.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod cell;
pub mod generated;
pub mod token;
pub mod transport;

pub use cell::Cell;

pub use generated::PROTOCOL_VERSION;
pub use generated::{ClientMessage, EngineMessage, ProtocolMessage};
