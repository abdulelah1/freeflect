//! iOS backend. On macOS, iPhone/iPad screens are captured over USB by the
//! `ios-capture` helper (native/macos/ios-capture), which writes the same
//! packet format as the Android device server.

pub mod afc;
pub mod lockdown;
pub mod usbmux;

use std::process::Stdio;

use mirror_core::{AudioPacket, Error, Result, VideoPacket};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

/// Prefix that marks iOS device ids in the desktop's device list.
pub const SERIAL_PREFIX: &str = "ios:";

#[derive(Debug, Clone, Deserialize)]
pub struct IosDevice {
    pub id: String,
    pub name: String,
}

/// Trusted iPhones/iPads connected by USB.
pub async fn list_devices(helper: &str) -> Result<Vec<IosDevice>> {
    let out = Command::new(helper).arg("--list").output().await?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect())
}

/// A running capture; dropping it ends the helper.
pub struct IosCapture {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl IosCapture {
    /// Starts capturing `id`; packets arrive on the returned channels until
    /// the helper exits (phone unplugged, stopped). With `audio`, the
    /// iPhone's sound comes to the Mac too (AAC packets).
    pub async fn start(
        helper: &str,
        id: &str,
        bitrate: u32,
        audio: bool,
    ) -> Result<(Self, mpsc::Receiver<VideoPacket>, mpsc::Receiver<AudioPacket>)> {
        let mut child = Command::new(helper)
            .arg(id)
            .arg(bitrate.to_string())
            .arg(if audio { "audio" } else { "noaudio" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child.stdout.take().ok_or_else(|| Error::Protocol("no helper stdout".into()))?;
        let stderr = child.stderr.take();
        let (tx, rx) = mpsc::channel(16);
        let (audio_tx, audio_rx) = mpsc::channel(64);
        tokio::spawn(async move {
            if let Err(e) = mirror_android::server::read_video_and_audio(stdout, tx, Some(audio_tx)).await {
                eprintln!("[ios] stream ended: {e}");
            }
        });
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("{line}");
                }
            });
        }
        let stdin = child.stdin.take();
        Ok((Self { child, stdin }, rx, audio_rx))
    }

    pub async fn request_keyframe(&mut self) {
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(b"k\n").await;
            let _ = stdin.flush().await;
        }
    }

    pub async fn stop(&mut self) {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"q\n").await;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), self.child.wait()).await;
        let _ = self.child.kill().await;
    }
}
