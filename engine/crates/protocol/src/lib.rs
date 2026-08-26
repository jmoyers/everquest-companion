//! The data-server wire contract, engine side.
//!
//! THREE THINGS LIVE HERE and nothing else does — no socket, no process, no game logic (JOS-464
//! is phase 0's first ticket: the artifact, the codegen and the checks only).
//!
//! 1. [`generated`] — the message types, generated from `protocol/schema/*.schema.json` by
//!    `npm run gen:protocol`. Committed, and pinned by a staleness test in `protocol-codegen`
//!    that regenerates and diffs. Never hand-edit it.
//! 2. [`transport`] — THE SEAM. A [`transport::Transport`] moves whole MESSAGES. Exactly one
//!    module below it knows that today's wire is one JSON object per LF-terminated line, and
//!    swapping that for WebSockets over the open internet is adding a sibling of it. Nothing in
//!    `generated`, and nothing that will later sit above this crate, may learn what a frame is.
//! 3. [`token`] — the per-launch shared secret's constant-time compare. The engine only ever
//!    VERIFIES a token; minting is Electron main's job, because main is what spawns the process
//!    and hands it the secret.
//!
//! THE VERSION IS FATAL, NOT NEGOTIABLE. [`generated::PROTOCOL_VERSION`] is a single integer
//! bumped on any breaking change. A client presents its own at hello; a mismatch closes the
//! connection with both sides logging. There is no compatibility mode, because both sides
//! generate from the same committed artifact — skew means somebody shipped half a build.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod cell;
pub mod generated;
pub mod token;
pub mod transport;

pub use cell::Cell;

pub use generated::PROTOCOL_VERSION;
pub use generated::{ClientMessage, EngineMessage, ProtocolMessage};
