//! Desktop keys → Android `KeyEvent` keycodes and meta state.

use mirror_core::Key;
use mirror_core::input::modifiers;

/// Android keycode for a logical key, or `None` if it has no Android
/// equivalent (the desktop then sends it as text where possible).
pub fn android_keycode(key: &Key) -> Option<i32> {
    Some(match key {
        Key::Home => 3,
        Key::Back => 4,
        Key::Recents => 187,
        Key::VolumeUp => 24,
        Key::VolumeDown => 25,
        Key::Power => 26,
        Key::Code(code) => return dom_code_to_keycode(code),
    })
}

/// Maps a DOM `KeyboardEvent.code` (physical key position) to a keycode.
pub fn dom_code_to_keycode(code: &str) -> Option<i32> {
    if let Some(letter) = code.strip_prefix("Key") {
        let c = letter.bytes().next().filter(|c| c.is_ascii_uppercase() && letter.len() == 1)?;
        return Some(29 + i32::from(c - b'A'));
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let d = digit.bytes().next().filter(|c| c.is_ascii_digit() && digit.len() == 1)?;
        return Some(7 + i32::from(d - b'0'));
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<i32>().ok()) {
        return (1..=12).contains(&n).then_some(130 + n);
    }
    Some(match code {
        "Enter" | "NumpadEnter" => 66,
        "Backspace" => 67,
        "Delete" => 112,
        "Tab" => 61,
        "Space" => 62,
        "Escape" => 111,
        "ArrowUp" => 19,
        "ArrowDown" => 20,
        "ArrowLeft" => 21,
        "ArrowRight" => 22,
        "Home" => 122,
        "End" => 123,
        "PageUp" => 92,
        "PageDown" => 93,
        "Insert" => 124,
        "ShiftLeft" => 59,
        "ShiftRight" => 60,
        "ControlLeft" => 113,
        "ControlRight" => 114,
        "AltLeft" => 57,
        "AltRight" => 58,
        "MetaLeft" => 117,
        "MetaRight" => 118,
        "CapsLock" => 115,
        "Minus" => 69,
        "Equal" => 70,
        "BracketLeft" => 71,
        "BracketRight" => 72,
        "Backslash" => 73,
        "Semicolon" => 74,
        "Quote" => 75,
        "Slash" => 76,
        "Comma" => 55,
        "Period" => 56,
        "Backquote" => 68,
        _ => return None,
    })
}

/// Android `KeyEvent` meta state for platform-neutral modifier bits.
pub fn android_meta_state(mods: u8) -> i32 {
    let mut meta = 0;
    if mods & modifiers::SHIFT != 0 {
        meta |= 0x1 | 0x40; // META_SHIFT_ON | META_SHIFT_LEFT_ON
    }
    if mods & modifiers::CTRL != 0 {
        meta |= 0x1000 | 0x2000; // META_CTRL_ON | META_CTRL_LEFT_ON
    }
    if mods & modifiers::ALT != 0 {
        meta |= 0x2 | 0x10; // META_ALT_ON | META_ALT_LEFT_ON
    }
    if mods & modifiers::META != 0 {
        meta |= 0x10000 | 0x20000; // META_META_ON | META_META_LEFT_ON
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_keys() {
        assert_eq!(dom_code_to_keycode("KeyA"), Some(29));
        assert_eq!(dom_code_to_keycode("KeyZ"), Some(54));
        assert_eq!(dom_code_to_keycode("Digit0"), Some(7));
        assert_eq!(dom_code_to_keycode("F12"), Some(142));
        assert_eq!(dom_code_to_keycode("Backspace"), Some(67));
        assert_eq!(dom_code_to_keycode("KeyAB"), None);
        assert_eq!(dom_code_to_keycode("F13"), None);
        assert_eq!(android_keycode(&Key::Back), Some(4));
        assert_eq!(android_meta_state(modifiers::CTRL | modifiers::SHIFT), 0x1 | 0x40 | 0x1000 | 0x2000);
    }
}
