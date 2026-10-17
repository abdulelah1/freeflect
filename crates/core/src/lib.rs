//! Platform-independent session model shared by Android and iOS backends.
//!
//! Every backend implements [`DeviceSession`]; the UI only talks to that trait
//! and uses [`Capabilities`] to decide which features to show for a device.

pub mod action;
pub mod device;
pub mod error;
pub mod input;
pub mod session;

pub use action::{Action, ActionBus, ActionRecord, ActionSource};
pub use device::{Capabilities, DeviceId, DeviceInfo, Platform, Transport};
pub use error::{Error, Result};
pub use input::{InputEvent, Key, PointerAction};
pub use session::{AudioPacket, DeviceSession, VideoCodec, VideoConfig, VideoPacket};
