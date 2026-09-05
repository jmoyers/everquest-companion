//! One connection, from hello to close.
//!
//! The handshake is the whole access control. Loopback is not a permission boundary — any process
//! running as this user can connect to 127.0.0.1 — so the first frame must be a `hello` carrying the
//! per-launch token, compared in constant time, and a failed connection is answered once and closed.
//!
//! The refusal is courteous and then final: a `HelloReply { ok: false }` before the socket closes,
//! and a client must treat a bare close as the same outcome. It carries both version fields
//! deliberately — a stale token and a skewed build are the two most likely failures on a developer's
//! machine, the constant-time compare leaks nothing about the secret, and a caller that can already
//! reach loopback learns nothing it could not read off the installed binary.
//!
//! Two threads, one outbox: the reader parses and dispatches, the writer drains the connection's
//! queue. Replies and connection-wide announcements share that queue, so a client observes one
//! ordered stream and the engine never reasons about two writers.

use std::net::TcpStream;
use std::sync::mpsc::{Receiver, Sender};
use std::thread;

use protocol::generated::{
    ClientMessage, EngineMessage, Hello, HelloReply, HelloReplyKind, PROTOCOL_VERSION,
};
use protocol::token::tokens_match;
use protocol::transport::{Transport, TransportError};

use crate::ops::{self, Outcome, Session, Unreadable};
use crate::spawn::DIAGNOSTIC_PREFIX;
use crate::wire::{self, Outgoing};
use crate::world::{ListenerId, World};

/// The engine binary's own version, reported at hello. Informational only — `protocolVersion` is the
/// compatibility check.
const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Everything a connection thread needs: the world it serves and the secret it checks against.
pub struct Server {
    world: World,
    /// The expected token. Never logged, never sent, and never compared with `==` —
    /// [`tokens_match`] exists because a byte-at-a-time compare over loopback is a timing oracle.
    token: String,
}

impl Server {
    /// Build the server. Takes the token by value so there is exactly one copy of it in the
    /// process.
    #[must_use]
    pub fn new(world: World, token: String) -> Self {
        Self { world, token }
    }

    /// Serve one accepted connection until it ends. Runs on its own thread; never panics out.
    pub fn serve(&self, stream: TcpStream) {
        let (mut incoming, outgoing) = match wire::split(stream) {
            Ok(halves) => halves,
            Err(e) => {
                eprintln!("{DIAGNOSTIC_PREFIX} a connection could not be set up: {e}");
                return;
            }
        };

        let membership = self.world.join();
        let outbox = membership.outbox;
        let inbox = membership.inbox;
        let writer = thread::Builder::new()
            .name("engined-write".to_owned())
            .spawn(move || pump(outgoing, &inbox));
        let Ok(writer) = writer else {
            eprintln!("{DIAGNOSTIC_PREFIX} a connection could not start its writer thread");
            self.world.leave(membership.id);
            return;
        };

        let ending = self.converse(membership.id, &mut incoming, &outbox);
        if let Some(why) = ending {
            eprintln!("{DIAGNOSTIC_PREFIX} connection closed: {why}");
        }

        // Tear-down in this order, and the order is the point: dropping the outbox ends the
        // writer's queue, and joining it waits for everything already queued to reach the wire —
        // which is what makes the courtesy refusal a real promise rather than a race against
        // `close()`. The join is bounded by `wire::WRITE_TIMEOUT`.
        self.world.leave(membership.id);
        drop(outbox);
        if writer.join().is_err() {
            eprintln!("{DIAGNOSTIC_PREFIX} a connection's writer thread ended badly");
        }
    }

    /// The conversation. Returns a diagnostic when the connection ended for a reason worth naming,
    /// or [`None`] when the peer simply went away.
    fn converse(
        &self,
        listener: ListenerId,
        incoming: &mut wire::Incoming,
        outbox: &Sender<EngineMessage>,
    ) -> Option<String> {
        match self.handshake(incoming, outbox) {
            Ok(true) => {}
            Ok(false) => return None,
            Err(why) => return Some(why),
        }

        // The session is the membership's receipt: everything a connection owns that outlives one
        // request is keyed by this id inside the world, so a connection that dies takes them with
        // it through `leave` and nothing has to be reconciled.
        let mut session = Session::new(listener);
        loop {
            let raw = match incoming.recv() {
                Ok(Some(raw)) => raw,
                // The peer finished. Not an event worth a diagnostic: a renderer closing a window
                // ends here.
                Ok(None) => return None,
                // Malformed is fatal to the connection: a frame that is not a message means the two
                // sides no longer agree about where messages begin, so nothing after it is
                // trustworthy either.
                Err(e) => return Some(format!("{e}")),
            };

            let outcome = match serde_json::from_value::<ClientMessage>(raw.clone()) {
                Ok(message) => session.dispatch(&self.world, message),
                Err(_) => match ops::classify(&raw) {
                    Unreadable::Uncorrelatable => {
                        return Some(
                            "a frame carried no request this engine could answer or name"
                                .to_owned(),
                        )
                    }
                    what => match ops::refuse(&what) {
                        Some(refusal) => Outcome::Send(vec![refusal]),
                        None => return Some("a frame could not be refused".to_owned()),
                    },
                },
            };

            match outcome {
                Outcome::Send(messages) => {
                    for message in messages {
                        if outbox.send(message).is_err() {
                            return Some("the connection's writer is gone".to_owned());
                        }
                    }
                }
                Outcome::Close(why) => return Some(why),
            }
        }
    }

    /// Run the handshake. `Ok(true)` means the connection may proceed, `Ok(false)` that the peer
    /// left before or during it, `Err` that it was refused for a reason worth logging.
    fn handshake(
        &self,
        incoming: &mut wire::Incoming,
        outbox: &Sender<EngineMessage>,
    ) -> Result<bool, String> {
        let raw = match incoming.recv() {
            Ok(Some(raw)) => raw,
            Ok(None) => return Ok(false),
            Err(e) => return Err(format!("no hello arrived: {e}")),
        };

        // Every first-frame failure is answered the same way: one `HelloReply { ok: false }`, then
        // the socket closes. A first frame that is a perfectly good `echo` is still a handshake
        // failure, because nothing may precede the hello.
        let refuse = |why: String| -> Result<bool, String> {
            let _ignored = outbox.send(EngineMessage::HelloReply(hello_reply(false)));
            Err(why)
        };

        let Ok(hello) = serde_json::from_value::<Hello>(raw) else {
            return refuse("the first frame on the connection was not a hello".to_owned());
        };

        // Token first, then version: authenticate before diagnosing.
        if !tokens_match(&self.token, &hello.token) {
            return refuse("a connection presented the wrong token".to_owned());
        }
        if hello.protocol_version != PROTOCOL_VERSION {
            // Version skew is a build error, not a runtime state: both sides generate from one
            // committed artifact, so a mismatch means half a build shipped. There is no
            // compatibility mode, and inventing one would be inventing a second contract.
            return refuse(format!(
                "a client generated against protocol {} met an engine on protocol {PROTOCOL_VERSION}",
                hello.protocol_version
            ));
        }

        if outbox
            .send(EngineMessage::HelloReply(hello_reply(true)))
            .is_err()
        {
            return Err("the connection's writer is gone".to_owned());
        }
        Ok(true)
    }
}

/// Build the handshake answer. The two version fields are different claims: `engineVersion` says
/// which binary this is, `protocolVersion` says which contract it speaks, and only the second
/// decides anything.
fn hello_reply(ok: bool) -> HelloReply {
    HelloReply {
        kind: HelloReplyKind::Hello,
        ok,
        engine_version: ENGINE_VERSION.to_owned(),
        protocol_version: PROTOCOL_VERSION,
    }
}

/// Drain one connection's outbox onto its socket until the queue closes or the wire fails.
fn pump(mut outgoing: Outgoing, inbox: &Receiver<EngineMessage>) {
    for message in inbox {
        match outgoing.send(&message) {
            Ok(()) => {}
            // A write failure ends the writer, not the engine: the reader finds out when its own
            // socket fails, and the world drops this listener the next time it broadcasts.
            Err(TransportError::Io(_) | TransportError::Closed) => return,
            Err(e) => {
                eprintln!("{DIAGNOSTIC_PREFIX} a message could not be sent: {e}");
                return;
            }
        }
    }
}
