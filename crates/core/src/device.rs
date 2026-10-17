use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DeviceId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Android,
    Ios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Usb,
    Wifi,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: DeviceId,
    pub platform: Platform,
    pub transport: Transport,
    pub model: Option<String>,
    pub os_version: Option<String>,
}

/// What a session can do with its current device + transport. The UI greys
/// out anything that is `false` and explains why.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Capabilities {
    pub video: bool,
    pub audio: bool,
    pub touch: bool,
    pub keyboard: bool,
    pub clipboard_read: bool,
    pub clipboard_write: bool,
    pub file_push: bool,
    pub file_browse: bool,
    pub app_install: bool,
    pub screen_off: bool,
    pub ui_tree: bool,
    pub logs: bool,
}
