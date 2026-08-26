//! A connected transport pair with no bytes in it.
//!
//! WHY THIS IS NOT A TOY. The seam's claim is that protocol logic never touches framing. A claim
//! like that is only worth something if something can run WITHOUT any framing at all — so the
//! suite drives the same conversation over this and over [`super::ndjson`], and asserts the two
//! produce the same messages. A conversation that survives having its wire removed is a
//! conversation that was not depending on one, which is precisely what has to stay true for a
//! WebSocket transport to be addable later by writing one more file.
//!
//! Messages still travel as `serde_json::Value` rather than as the typed structs, so the serde
//! contract is exercised even here: a type whose `Serialize` and `Deserialize` disagree fails on
//! this transport too. What is absent is only the FRAME.

use std::marker::PhantomData;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};

use serde::de::DeserializeOwned;
use serde::Serialize;

use super::{Transport, TransportError};

/// One end of an in-memory pair. Create both ends with [`pair`].
pub struct MemoryTransport<Out: Serialize, In: DeserializeOwned> {
    tx: Sender<serde_json::Value>,
    rx: Receiver<serde_json::Value>,
    outbound: PhantomData<Out>,
    inbound: PhantomData<In>,
}

/// Two ends of one connection. `A` is what the first end sends and the second end receives.
#[must_use]
pub fn pair<A, B>() -> (MemoryTransport<A, B>, MemoryTransport<B, A>)
where
    A: Serialize + DeserializeOwned,
    B: Serialize + DeserializeOwned,
{
    let (a_tx, a_rx) = channel();
    let (b_tx, b_rx) = channel();
    (
        MemoryTransport {
            tx: a_tx,
            rx: b_rx,
            outbound: PhantomData,
            inbound: PhantomData,
        },
        MemoryTransport {
            tx: b_tx,
            rx: a_rx,
            outbound: PhantomData,
            inbound: PhantomData,
        },
    )
}

impl<Out: Serialize, In: DeserializeOwned> Transport for MemoryTransport<Out, In> {
    type Outbound = Out;
    type Inbound = In;

    fn send(&mut self, message: &Out) -> Result<(), TransportError> {
        let value = serde_json::to_value(message).map_err(TransportError::Encode)?;
        self.tx.send(value).map_err(|_| TransportError::Closed)
    }

    fn recv(&mut self) -> Result<Option<In>, TransportError> {
        match self.rx.try_recv() {
            Ok(value) => serde_json::from_value(value)
                .map(Some)
                .map_err(TransportError::Decode),
            // Nothing queued and nothing gone: an empty pipe reads the same as a finished one at
            // this level, because phase 0 has no blocking read to distinguish them. The suite only
            // ever drains a conversation it has already written in full.
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => Ok(None),
        }
    }
}
