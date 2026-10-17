//! Android backend: ADB host protocol client, device-server deployment, and
//! the video/control sockets behind [`AndroidSession`].

pub mod adb;
pub mod control;
pub mod keymap;
pub mod server;
pub mod session;

pub use adb::{AdbClient, AdbDevice, AdbState};
pub use session::{AndroidSession, AudioStatus};
