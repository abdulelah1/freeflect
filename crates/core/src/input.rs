use serde::{Deserialize, Serialize};

/// Coordinates are normalized to 0.0..=1.0 of the device screen so the same
/// event can be broadcast to devices with different resolutions (device farm).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputEvent {
    Pointer { action: PointerAction, x: f32, y: f32, pointer_id: u32, pressure: f32 },
    Scroll { x: f32, y: f32, dx: f32, dy: f32 },
    Key { key: Key, down: bool, modifiers: u8 },
    Text { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerAction {
    Down,
    Move,
    Up,
}

/// Logical keys; backends translate to Android keycodes or HID usages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Key {
    Home,
    Back,
    Recents,
    VolumeUp,
    VolumeDown,
    Power,
    /// A physical desktop key, identified by its DOM `KeyboardEvent.code`.
    Code(String),
}

/// Platform-neutral modifier bits for [`InputEvent::Key`].
pub mod modifiers {
    pub const SHIFT: u8 = 1;
    pub const CTRL: u8 = 2;
    pub const ALT: u8 = 4;
    pub const META: u8 = 8;
}
