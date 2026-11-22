//! Linux native bridge shared protocol and AT-SPI backend.

pub mod atspi;
pub mod error;
pub mod protocol;
pub mod state;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
pub mod wayland;
pub mod x11;

pub use error::{ErrorCode, ProtocolError};
pub use protocol::{Request, Response};
