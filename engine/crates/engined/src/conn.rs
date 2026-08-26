//! ONE CONNECTION, FROM HELLO TO CLOSE.
//!
//! THE HANDSHAKE IS THE WHOLE ACCESS CONTROL. Loopback is not a permission boundary: any process
//! running as this user can connect to 127.0.0.1 on any port, so the port authenticates nobody
//! (`protocol::token` states the threat in full). The first frame must be a `hello` carrying the
//! per-launch token, compared in constant time, and a connection that fails is answered once and
//! closed.
//!
//! REFUSALS ARE COURTEOUS AND THEN FINAL. A failed handshake gets a `HelloReply { ok: false }`
//! before the socket closes — the schema calls it a courtesy and says a client must treat a bare
//! close as the same outcome. THE JUDGMENT CALL, STATED: that reply carries `engineVersion` and
//! `protocolVersion`, so a caller who guessed a token wrong learns two version numbers. That is
//! worth it. The supervisor's stale-token case and its skewed-build case are the two failures this
//! process is most likely to have on a developer's machine, and telling them apart from a bare TCP
//! reset is guesswork; the compare is constant-time, so the reply leaks nothing about the secret
//! itself, and a caller who can already reach loopback learns nothing it could not learn from the
//! installed binary.
//!
//! TWO THREADS, ONE OUTBOX. The reader thread parses and dispatches; a writer thread drains the
//! connection's queue. Replies and connection-wide announcements go through the SAME queue, so what
//! a client observes is one ordered stream and the engine never has to reason about two writers.
//! See [`crate::wire`] for why the socket is split rather than shared.

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

/// The engine binary's own version, reported at hello. INFORMATIONAL ONLY — `protocolVersion` is
/// the compatibility check, and the schema says so.
const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Everything a connection thread needs: the world it serves and the secret it checks against.
pub struct Server {
    world: World,
    /// The expected token. IT IS NEVER LOGGED, never sent, and never compared with `==` —
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

        // TEAR-DOWN, IN THIS ORDER, AND THE ORDER IS THE POINT. Dropping the outbox ends the
        // writer's queue; joining it waits for everything already queued to reach the wire —
        // which is what makes the courtesy refusal above a real promise rather than a race
        // against `close()`. The join is bounded by the socket's write timeout (see
        // `wire::WRITE_TIMEOUT`).
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

        // THE SESSION IS THE MEMBERSHIP'S RECEIPT. Everything a connection owns that outlives one
        // request — today its subscriptions — is keyed by this id inside the world, so a connection
        // that dies takes them with it through `leave` and nothing has to be reconciled.
        let mut session = Session::new(listener);
        loop {
            let raw = match incoming.recv() {
                Ok(Some(raw)) => raw,
                // The peer finished. Not an event worth a diagnostic: a renderer closing a window
                // ends here.
                Ok(None) => return None,
                // MALFORMED IS FATAL TO THE CONNECTION, per the transport's own semantics: a frame
                // that is not a message means the two sides no longer agree about where messages
                // begin, and nothing after it can be trusted either.
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

        // EVERY FIRST-FRAME FAILURE IS ANSWERED THE SAME WAY: one `HelloReply { ok: false }`, then
        // the socket closes. A first frame that is a perfectly good `echo` is still a handshake
        // failure, because nothing may precede the hello, and a client that meets one uniform
        // answer has one case to handle rather than three.
        let refuse = |why: String| -> Result<bool, String> {
            let _ignored = outbox.send(EngineMessage::HelloReply(hello_reply(false)));
            Err(why)
        };

        let Ok(hello) = serde_json::from_value::<Hello>(raw) else {
            return refuse("the first frame on the connection was not a hello".to_owned());
        };

        // TOKEN FIRST, THEN VERSION. Authenticate before diagnosing: it costs nothing here, and it
        // keeps the order of checks from being a thing anybody has to think about later.
        if !tokens_match(&self.token, &hello.token) {
            return refuse("a connection presented the wrong token".to_owned());
        }
        if hello.protocol_version != PROTOCOL_VERSION {
            // VERSION SKEW IS A BUILD ERROR, NOT A RUNTIME STATE. Both sides generate from one
            // committed artifact, so a mismatch means somebody shipped half a build. There is no
            // compatibility mode to fall back to and inventing one would be inventing a second
            // contract.
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

/// Build the handshake answer. The two version fields are DIFFERENT CLAIMS: `engineVersion` says
/// which binary this is, `protocolVersion` says which contract it speaks, and only the second one
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
            // A WRITE FAILURE ENDS THE WRITER, NOT THE ENGINE. The reader thread finds out when its
            // own socket fails, and the world drops this listener the next time it broadcasts.
            Err(TransportError::Io(_) | TransportError::Closed) => return,
            Err(e) => {
                eprintln!("{DIAGNOSTIC_PREFIX} a message could not be sent: {e}");
                return;
            }
        }
    }
}
