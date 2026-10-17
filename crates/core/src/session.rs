use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::{Capabilities, DeviceInfo, InputEvent, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoConfig {
    pub codec: VideoCodec,
    pub max_size: Option<u32>,
    pub bitrate: u32,
    pub max_fps: Option<u32>,
    /// Backend-specific id of this desktop install (see `ServerOptions::owner`).
    pub owner: Option<String>,
    /// Also forward the phone's sound.
    pub audio: bool,
}

/// One encoded audio frame (AAC-LC), or the codec config when `config`.
#[derive(Debug, Clone)]
pub struct AudioPacket {
    pub data: Vec<u8>,
    /// Same clock as `VideoPacket::pts_us`, so the two can be synced.
    pub pts_us: i64,
    /// AudioSpecificConfig rather than a frame.
    pub config: bool,
}

/// One encoded access unit, ready for WebCodecs `EncodedVideoChunk`.
#[derive(Debug, Clone)]
pub struct VideoPacket {
    pub data: Vec<u8>,
    pub pts_us: i64,
    pub keyframe: bool,
    /// Codec string for `VideoDecoder.configure`, present on config/keyframes.
    pub codec_string: Option<String>,
    /// The stream restarted (e.g. rotation); the decoder must be reset.
    pub discontinuity: bool,
    /// Encoded frame size, set on keyframes (needed to start a recording).
    pub dimensions: Option<(u16, u16)>,
}

#[async_trait]
pub trait DeviceSession: Send + Sync {
    fn info(&self) -> &DeviceInfo;
    fn capabilities(&self) -> Capabilities;

    async fn start_video(&self, config: VideoConfig) -> Result<mpsc::Receiver<VideoPacket>>;
    async fn stop(&self) -> Result<()>;
    async fn inject(&self, event: InputEvent) -> Result<()>;
    async fn screenshot(&self) -> Result<Vec<u8>>;
    async fn push_file(&self, local: &std::path::Path, remote: &str) -> Result<()>;
    async fn clipboard_get(&self) -> Result<String>;
    async fn clipboard_set(&self, text: &str) -> Result<()>;
}
