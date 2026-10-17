//! Encoding of desktop → device control messages (docs/protocol.md).

use mirror_core::{InputEvent, PointerAction};

use crate::keymap::{android_keycode, android_meta_state};

const TYPE_TOUCH: u8 = 0;
const TYPE_KEY: u8 = 1;
const TYPE_TEXT: u8 = 2;
const TYPE_SCROLL: u8 = 3;
const TYPE_REQUEST_KEYFRAME: u8 = 4;
const TYPE_SET_CLIPBOARD: u8 = 5;
const TYPE_SET_SCREEN_POWER: u8 = 6;

/// Max UTF-8 bytes per text message (the length field is a u16).
const MAX_TEXT_BYTES: usize = u16::MAX as usize;

#[derive(Debug, Clone, PartialEq)]
pub enum ControlMessage {
    Input(InputEvent),
    RequestKeyframe,
    /// Sets the phone clipboard; with `paste`, also injects the Paste key.
    SetClipboard { text: String, paste: bool },
    /// Turns the phone's physical screen on or off; mirroring continues.
    SetScreenPower { on: bool },
}

/// Messages the device sends back on the control socket.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceMessage {
    Clipboard(String),
}

/// Serializes a message, or `None` if the event has no Android equivalent.
pub fn encode(msg: &ControlMessage) -> Option<Vec<u8>> {
    let mut b = Vec::with_capacity(32);
    match msg {
        ControlMessage::RequestKeyframe => b.push(TYPE_REQUEST_KEYFRAME),
        ControlMessage::SetScreenPower { on } => {
            b.push(TYPE_SET_SCREEN_POWER);
            b.push(u8::from(*on));
        }
        ControlMessage::SetClipboard { text, paste } => {
            b.push(TYPE_SET_CLIPBOARD);
            b.push(u8::from(*paste));
            b.extend_from_slice(&(text.len() as u32).to_be_bytes());
            b.extend_from_slice(text.as_bytes());
        }
        ControlMessage::Input(InputEvent::Pointer { action, x, y, pointer_id, pressure }) => {
            b.push(TYPE_TOUCH);
            b.push(match action {
                PointerAction::Down => 0,
                PointerAction::Up => 1,
                PointerAction::Move => 2,
            });
            b.extend_from_slice(&pointer_id.to_be_bytes());
            b.extend_from_slice(&x.to_be_bytes());
            b.extend_from_slice(&y.to_be_bytes());
            b.extend_from_slice(&pressure.to_be_bytes());
        }
        ControlMessage::Input(InputEvent::Key { key, down, modifiers }) => {
            let keycode = android_keycode(key)?;
            b.push(TYPE_KEY);
            b.push(if *down { 0 } else { 1 });
            b.extend_from_slice(&keycode.to_be_bytes());
            b.extend_from_slice(&0i32.to_be_bytes());
            b.extend_from_slice(&android_meta_state(*modifiers).to_be_bytes());
        }
        ControlMessage::Input(InputEvent::Text { text }) => {
            let mut end = text.len().min(MAX_TEXT_BYTES);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            b.push(TYPE_TEXT);
            b.extend_from_slice(&(end as u16).to_be_bytes());
            b.extend_from_slice(&text.as_bytes()[..end]);
        }
        ControlMessage::Input(InputEvent::Scroll { x, y, dx, dy }) => {
            b.push(TYPE_SCROLL);
            for v in [x, y, dx, dy] {
                b.extend_from_slice(&v.to_be_bytes());
            }
        }
    }
    Some(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirror_core::Key;

    #[test]
    fn encodes_touch() {
        let msg = ControlMessage::Input(InputEvent::Pointer {
            action: PointerAction::Down,
            x: 0.5,
            y: 1.0,
            pointer_id: 7,
            pressure: 1.0,
        });
        let b = encode(&msg).unwrap();
        assert_eq!(b.len(), 18);
        assert_eq!(&b[..6], &[0, 0, 0, 0, 0, 7]);
        assert_eq!(&b[6..10], &0.5f32.to_be_bytes());
    }

    #[test]
    fn encodes_key_and_skips_unknown() {
        let enter = ControlMessage::Input(InputEvent::Key { key: Key::Code("Enter".into()), down: true, modifiers: 0 });
        assert_eq!(encode(&enter).unwrap()[..6], [1, 0, 0, 0, 0, 66]);
        let unknown = ControlMessage::Input(InputEvent::Key { key: Key::Code("Lang1".into()), down: true, modifiers: 0 });
        assert_eq!(encode(&unknown), None);
    }

    #[test]
    fn encodes_set_clipboard() {
        let b = encode(&ControlMessage::SetClipboard { text: "مرحبا".into(), paste: true }).unwrap();
        assert_eq!(&b[..6], &[5, 1, 0, 0, 0, 10]);
        assert_eq!(&b[6..], "مرحبا".as_bytes());
    }

    #[test]
    fn encodes_utf8_text() {
        let b = encode(&ControlMessage::Input(InputEvent::Text { text: "héllo".into() })).unwrap();
        assert_eq!(&b[..3], &[2, 0, 6]);
        assert_eq!(&b[3..], "héllo".as_bytes());
    }
}
