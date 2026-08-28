//! A connected transport pair with no bytes in it.
//!
//! Not a toy: the seam's claim is that protocol logic never touches framing, and that claim is only
//! worth something if a conversation can run with no framing at all. The suite drives the same
//! conversation over this and over [`super::ndjson`] and asserts they produce the same messages.
//!
//! Messages still travel as `serde_json::Value` rather than as the typed structs, so a type whose
//! `Serialize` and `Deserialize` disagree fails here too. Only the frame is absent.

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
            // An empty pipe reads the same as a finished one here: there is no blocking read to
            // distinguish them, and callers only drain a conversation already written in full.
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => Ok(None),
        }
    }
}
