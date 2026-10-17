//! [`DeviceSession`] implementation for Android devices.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mirror_core::{AudioPacket, Capabilities, DeviceInfo, DeviceSession, Error, InputEvent, Result, VideoConfig, VideoPacket};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::adb::AdbClient;
use crate::control::{ControlMessage, DeviceMessage, encode};
use crate::server::{self, AudioChannel, ServerOptions};

const VIDEO_QUEUE: usize = 16;
const DEVICE_MESSAGE_QUEUE: usize = 8;
const AUDIO_QUEUE: usize = 64;

/// Whether sound is being forwarded for the current session.
#[derive(Debug, Clone, PartialEq)]
pub enum AudioStatus {
    Off,
    On,
    Unavailable(String),
}

struct Running {
    control: mpsc::UnboundedSender<ControlMessage>,
    port: u16,
    device_name: String,
    tasks: Vec<JoinHandle<()>>,
}

pub struct AndroidSession {
    info: DeviceInfo,
    adb: AdbClient,
    server_jar: Arc<Vec<u8>>,
    running: Mutex<Option<Running>>,
    device_messages: Mutex<Option<mpsc::Receiver<DeviceMessage>>>,
    audio: Mutex<(AudioStatus, Option<mpsc::Receiver<AudioPacket>>)>,
}

impl AndroidSession {
    pub fn new(info: DeviceInfo, adb: AdbClient, server_jar: Arc<Vec<u8>>) -> Self {
        Self {
            info,
            adb,
            server_jar,
            running: Mutex::new(None),
            device_messages: Mutex::new(None),
            audio: Mutex::new((AudioStatus::Off, None)),
        }
    }

    fn serial(&self) -> &str {
        &self.info.id.0
    }

    pub fn device_name(&self) -> Option<String> {
        self.running.lock().unwrap().as_ref().map(|r| r.device_name.clone())
    }

    /// Non-async input path for hot callers (pointer moves). Returns false
    /// when not mirroring.
    pub fn send_input(&self, event: InputEvent) -> bool {
        self.send(ControlMessage::Input(event))
    }

    pub fn request_keyframe(&self) {
        self.send(ControlMessage::RequestKeyframe);
    }

    pub fn set_screen_power(&self, on: bool) -> bool {
        self.send(ControlMessage::SetScreenPower { on })
    }

    pub fn set_clipboard(&self, text: String, paste: bool) -> bool {
        self.send(ControlMessage::SetClipboard { text, paste })
    }

    /// Audio packets for the current session, available once per `start_video`.
    pub fn take_audio(&self) -> Option<mpsc::Receiver<AudioPacket>> {
        self.audio.lock().unwrap().1.take()
    }

    pub fn audio_status(&self) -> AudioStatus {
        self.audio.lock().unwrap().0.clone()
    }

    /// Messages from the device (clipboard changes) for the current session.
    /// Available once per `start_video`.
    pub fn take_device_messages(&self) -> Option<mpsc::Receiver<DeviceMessage>> {
        self.device_messages.lock().unwrap().take()
    }

    fn send(&self, msg: ControlMessage) -> bool {
        self.running.lock().unwrap().as_ref().is_some_and(|r| r.control.send(msg).is_ok())
    }
}

#[async_trait]
impl DeviceSession for AndroidSession {
    fn info(&self) -> &DeviceInfo {
        &self.info
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities { video: true, touch: true, keyboard: true, file_push: true, ..Default::default() }
    }

    async fn start_video(&self, config: VideoConfig) -> Result<mpsc::Receiver<VideoPacket>> {
        self.stop().await?;
        let opts = ServerOptions {
            max_size: config.max_size.unwrap_or(0),
            bit_rate: config.bitrate,
            max_fps: config.max_fps.unwrap_or(0),
            owner: config.owner.unwrap_or_default(),
            audio: config.audio,
        };
        let conn = server::start(&self.adb, self.serial(), &self.server_jar, &opts).await?;

        let (video_tx, video_rx) = mpsc::channel(VIDEO_QUEUE);
        let (control_tx, mut control_rx) = mpsc::unbounded_channel::<ControlMessage>();
        let (device_tx, device_rx) = mpsc::channel(DEVICE_MESSAGE_QUEUE);
        let (control_read, mut control_sock) = conn.control.into_split();
        *self.device_messages.lock().unwrap() = Some(device_rx);
        let audio_task = match conn.audio {
            AudioChannel::Off => {
                *self.audio.lock().unwrap() = (AudioStatus::Off, None);
                None
            }
            AudioChannel::Unavailable(reason) => {
                *self.audio.lock().unwrap() = (AudioStatus::Unavailable(reason), None);
                None
            }
            AudioChannel::On(stream) => {
                let (tx, rx) = mpsc::channel(AUDIO_QUEUE);
                *self.audio.lock().unwrap() = (AudioStatus::On, Some(rx));
                Some(tokio::spawn(async move {
                    if let Err(e) = server::read_audio(stream, tx).await {
                        eprintln!("[android] audio stream ended: {e}");
                    }
                }))
            }
        };

        let tasks = vec![
            tokio::spawn(async move {
                if let Err(e) = server::read_video(conn.video, video_tx).await {
                    eprintln!("[android] video stream ended: {e}");
                }
            }),
            tokio::spawn(async move {
                while let Some(msg) = control_rx.recv().await {
                    let Some(bytes) = encode(&msg) else { continue };
                    if control_sock.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                // Dropping the socket tells the server to shut down.
            }),
            tokio::spawn(async move {
                if let Err(e) = server::read_device_messages(control_read, device_tx).await {
                    eprintln!("[android] control stream ended: {e}");
                }
            }),
            tokio::spawn(server::pipe_server_log(conn.shell)),
        ];
        let tasks = tasks.into_iter().chain(audio_task).collect();

        *self.running.lock().unwrap() =
            Some(Running { control: control_tx, port: conn.port, device_name: conn.device_name, tasks });
        Ok(video_rx)
    }

    async fn stop(&self) -> Result<()> {
        let running = self.running.lock().unwrap().take();
        if let Some(r) = running {
            drop(r.control);
            for t in &r.tasks {
                t.abort();
            }
            self.adb.remove_forward(self.serial(), r.port).await.ok();
        }
        Ok(())
    }

    async fn inject(&self, event: InputEvent) -> Result<()> {
        if self.send(ControlMessage::Input(event)) {
            Ok(())
        } else {
            Err(Error::Protocol("not mirroring".into()))
        }
    }

    async fn screenshot(&self) -> Result<Vec<u8>> {
        Err(Error::Unsupported("screenshot"))
    }

    async fn push_file(&self, local: &std::path::Path, remote: &str) -> Result<()> {
        let data = tokio::fs::read(local).await?;
        self.adb.push(self.serial(), &data, remote, 0o644).await
    }

    async fn clipboard_get(&self) -> Result<String> {
        Err(Error::Unsupported("clipboard"))
    }

    async fn clipboard_set(&self, _text: &str) -> Result<()> {
        Err(Error::Unsupported("clipboard"))
    }
}
