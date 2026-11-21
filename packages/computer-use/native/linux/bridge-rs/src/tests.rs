//! Shared headless D-Bus fixtures.

use std::{future::pending, ops::AsyncFnOnce, time::Duration};

use tokio::{net::UnixStream, sync::mpsc};
use zbus::{connection::Builder, Connection, Guid};

/// Observe receipt of a request without ever replying to it.
pub(crate) struct StalledReply(mpsc::UnboundedSender<()>);

impl StalledReply {
    pub(crate) fn new() -> (Self, mpsc::UnboundedReceiver<()>) {
        let (started, requests) = mpsc::unbounded_channel();
        (Self(started), requests)
    }

    pub(crate) async fn wait<T>(&self) -> T {
        self.0.send(()).unwrap();
        pending().await
    }
}

/// Serve fixture interfaces over a private socket pair, keeping the server alive
/// until the client exercise finishes. Bound both the handshake and all requests.
pub(crate) async fn with_peer<T>(
    configure: impl FnOnce(Builder<'static>) -> zbus::Result<Builder<'static>>,
    exercise: impl AsyncFnOnce(Connection) -> T,
) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        let (server_socket, client_socket) = UnixStream::pair().unwrap();
        let server = Builder::unix_stream(server_socket)
            .server(Guid::generate())
            .unwrap()
            .p2p();
        let server = configure(server).unwrap().build();
        let client = Builder::unix_stream(client_socket).p2p().build();
        let (_server, connection) = tokio::try_join!(server, client).unwrap();
        exercise(connection).await
    })
    .await
    .expect("private D-Bus handshake or request timed out")
}
