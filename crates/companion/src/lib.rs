//! Server for the iOS companion app (native/ios/MirrorCompanion), on the
//! local network. The desktop advertises `_mirror-desk._tcp` with Bonjour;
//! the app and its broadcast extension connect.
//!
//! Every connection starts with one JSON line from the phone:
//!   {"v":1,"role":"video"|"control","deviceId":"<uuid>","name":"<device name>"}
//! answered by `{"ok":true}` or `{"ok":false,"reason":"..."}`. New devices
//! must be allowed by the user once (see `Event::ApprovalNeeded`).
//!
//! video:   the phone streams the Android packet format (docs/protocol.md),
//!          with AAC audio packets interleaved after the audio marker;
//!          the desktop writes "k\n" to ask for a keyframe.
//! control: frames of u32 big-endian length + JSON both ways; a
//!          {"type":"file","name","size"} frame is followed by `size` bytes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use mirror_core::{AudioPacket, Error, Result, VideoPacket};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

pub const SERVICE_TYPE: &str = "_mirror-desk._tcp.local.";
const MAX_FILE_BYTES: u64 = 4 << 30;
const MAX_FRAME_BYTES: u32 = 1 << 20;

#[derive(Debug, Deserialize)]
struct Hello {
    v: u32,
    role: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ControlFrame {
    Clipboard { text: String },
    File { name: String, size: u64 },
}

/// What the desktop hears about.
#[derive(Debug)]
pub enum Event {
    /// A device connected for the first time; answer with `approve`.
    ApprovalNeeded { device_id: String, name: String, reply: oneshot::Sender<bool> },
    ScreenStarted { device_id: String, name: String },
    ScreenStopped { device_id: String },
    Video { device_id: String, packet: VideoPacket },
    Audio { device_id: String, packet: AudioPacket },
    Clipboard { device_id: String, name: String, text: String },
    FileReceived { device_id: String, name: String, path: PathBuf },
    ControlConnected { device_id: String, name: String },
    ControlDisconnected { device_id: String },
}

#[derive(Default)]
struct Shared {
    allowed: Vec<String>,
    /// Where received files go; changeable while running.
    downloads: PathBuf,
    /// Writers for keyframe requests, per device.
    video: HashMap<String, Arc<tokio::sync::Mutex<OwnedWriteHalf>>>,
    control: HashMap<String, Arc<tokio::sync::Mutex<OwnedWriteHalf>>>,
}

#[derive(Clone)]
pub struct Server {
    shared: Arc<Mutex<Shared>>,
    pub port: u16,
    mdns: Arc<mdns_sd::ServiceDaemon>,
    accept: Arc<tokio::task::JoinHandle<()>>,
}

impl Server {
    /// Starts listening and advertising. `allowed` are device ids approved
    /// earlier; received files go to `downloads`.
    pub async fn start(
        desktop_name: &str,
        allowed: Vec<String>,
        downloads: PathBuf,
        events: mpsc::UnboundedSender<Event>,
    ) -> Result<Self> {
        let listener = TcpListener::bind("0.0.0.0:0").await?;
        let port = listener.local_addr()?.port();
        let mdns = mdns_sd::ServiceDaemon::new().map_err(|e| Error::Protocol(format!("mdns: {e}")))?;
        let host = format!("{}.local.", desktop_name.replace(|c: char| !c.is_ascii_alphanumeric(), "-"));
        let info = mdns_sd::ServiceInfo::new(SERVICE_TYPE, desktop_name, &host, "", port, &[("v", "1")][..])
            .map_err(|e| Error::Protocol(format!("mdns: {e}")))?
            .enable_addr_auto();
        mdns.register(info).map_err(|e| Error::Protocol(format!("mdns: {e}")))?;

        let shared = Arc::new(Mutex::new(Shared { allowed, downloads, ..Default::default() }));
        let accepting = shared.clone();
        let accept = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let downloads = accepting.lock().unwrap().downloads.clone();
                let (shared, events) = (accepting.clone(), events.clone());
                tokio::spawn(async move {
                    if let Err(e) = handle(stream, shared, events, downloads).await {
                        eprintln!("[companion] connection ended: {e}");
                    }
                });
            }
        });
        Ok(Self { shared, port, mdns: Arc::new(mdns), accept: Arc::new(accept) })
    }

    /// Received files go here from now on.
    pub fn set_downloads(&self, dir: PathBuf) {
        self.shared.lock().unwrap().downloads = dir;
    }

    /// The phone must be allowed again next time it connects.
    pub fn forget(&self, device_id: &str) {
        self.shared.lock().unwrap().allowed.retain(|d| d != device_id);
    }

    /// Stops advertising and accepting (open connections end when the phone closes them).
    pub fn shutdown(&self) {
        self.accept.abort();
        let _ = self.mdns.shutdown();
    }

    /// Asks the phone's broadcast for a keyframe (a new window needs one).
    pub async fn request_keyframe(&self, device_id: &str) {
        let writer = self.shared.lock().unwrap().video.get(device_id).cloned();
        if let Some(w) = writer {
            let _ = w.lock().await.write_all(b"k\n").await;
        }
    }

    pub async fn send_clipboard(&self, device_id: &str, text: String) -> Result<()> {
        let w = self.control_writer(device_id)?;
        let mut w = w.lock().await;
        write_frame(&mut w, &ControlFrame::Clipboard { text }).await
    }

    /// Sends a file into the companion app's documents (visible in Files).
    pub async fn send_file(&self, device_id: &str, path: &std::path::Path) -> Result<()> {
        let w = self.control_writer(device_id)?;
        let mut file = tokio::fs::File::open(path).await?;
        let size = file.metadata().await?.len();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let mut w = w.lock().await;
        write_frame(&mut w, &ControlFrame::File { name, size }).await?;
        tokio::io::copy(&mut file, &mut *w).await?;
        w.flush().await?;
        Ok(())
    }

    fn control_writer(&self, device_id: &str) -> Result<Arc<tokio::sync::Mutex<OwnedWriteHalf>>> {
        self.shared
            .lock()
            .unwrap()
            .control
            .get(device_id)
            .cloned()
            .ok_or_else(|| Error::Protocol("Open the FreeFlect app on the iPhone first.".into()))
    }
}

async fn write_frame(w: &mut OwnedWriteHalf, frame: &ControlFrame) -> Result<()> {
    let json = serde_json::to_vec(frame).map_err(|e| Error::Protocol(e.to_string()))?;
    w.write_all(&(json.len() as u32).to_be_bytes()).await?;
    w.write_all(&json).await?;
    w.flush().await?;
    Ok(())
}

async fn reply(w: &mut OwnedWriteHalf, ok: bool, reason: &str) -> Result<()> {
    let line = if ok { "{\"ok\":true}\n".to_string() } else { format!("{{\"ok\":false,\"reason\":{}}}\n", serde_json::json!(reason)) };
    w.write_all(line.as_bytes()).await?;
    w.flush().await?;
    Ok(())
}

async fn handle(stream: TcpStream, shared: Arc<Mutex<Shared>>, events: mpsc::UnboundedSender<Event>, downloads: PathBuf) -> Result<()> {
    stream.set_nodelay(true)?;
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let hello: Hello = serde_json::from_str(line.trim()).map_err(|e| Error::Protocol(format!("bad hello: {e}")))?;
    if hello.v != 1 {
        reply(&mut write, false, "Update the FreeFlect app").await?;
        return Ok(());
    }

    let known = shared.lock().unwrap().allowed.contains(&hello.device_id);
    if !known {
        let (tx, rx) = oneshot::channel();
        let _ = events.send(Event::ApprovalNeeded { device_id: hello.device_id.clone(), name: hello.name.clone(), reply: tx });
        if !rx.await.unwrap_or(false) {
            reply(&mut write, false, "Not allowed on the computer").await?;
            return Ok(());
        }
        shared.lock().unwrap().allowed.push(hello.device_id.clone());
    }
    reply(&mut write, true, "").await?;
    let id = hello.device_id.clone();
    let writer = Arc::new(tokio::sync::Mutex::new(write));

    match hello.role.as_str() {
        "video" => {
            shared.lock().unwrap().video.insert(id.clone(), writer);
            let _ = events.send(Event::ScreenStarted { device_id: id.clone(), name: hello.name.clone() });
            let (tx, mut rx) = mpsc::channel(16);
            let (audio_tx, mut audio_rx) = mpsc::channel(64);
            let reader_task = tokio::spawn(mirror_android::server::read_video_and_audio(reader, tx, Some(audio_tx)));
            let audio_events = events.clone();
            let audio_id = id.clone();
            let audio_task = tokio::spawn(async move {
                while let Some(packet) = audio_rx.recv().await {
                    let _ = audio_events.send(Event::Audio { device_id: audio_id.clone(), packet });
                }
            });
            while let Some(packet) = rx.recv().await {
                let _ = events.send(Event::Video { device_id: id.clone(), packet });
            }
            let _ = audio_task.await;
            let _ = reader_task.await;
            shared.lock().unwrap().video.remove(&id);
            let _ = events.send(Event::ScreenStopped { device_id: id });
        }
        "control" => {
            shared.lock().unwrap().control.insert(id.clone(), writer);
            let _ = events.send(Event::ControlConnected { device_id: id.clone(), name: hello.name.clone() });
            let result = read_control(&mut reader, &id, &hello.name, &events, &downloads).await;
            shared.lock().unwrap().control.remove(&id);
            let _ = events.send(Event::ControlDisconnected { device_id: id });
            result?;
        }
        other => return Err(Error::Protocol(format!("unknown role {other}"))),
    }
    Ok(())
}

async fn read_control<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    id: &str,
    name: &str,
    events: &mpsc::UnboundedSender<Event>,
    downloads: &std::path::Path,
) -> Result<()> {
    loop {
        let len = match reader.read_u32().await {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if len > MAX_FRAME_BYTES {
            return Err(Error::Protocol("frame too large".into()));
        }
        let mut buf = vec![0u8; len as usize];
        reader.read_exact(&mut buf).await?;
        match serde_json::from_slice::<ControlFrame>(&buf).map_err(|e| Error::Protocol(e.to_string()))? {
            ControlFrame::Clipboard { text } => {
                let _ = events.send(Event::Clipboard { device_id: id.into(), name: name.into(), text });
            }
            ControlFrame::File { name: file_name, size } => {
                if size > MAX_FILE_BYTES {
                    return Err(Error::Protocol("file too large".into()));
                }
                tokio::fs::create_dir_all(downloads).await?;
                let path = unique_path(downloads, &sanitize(&file_name));
                let mut file = tokio::fs::File::create(&path).await?;
                let mut limited = reader.take(size);
                tokio::io::copy(&mut limited, &mut file).await?;
                file.flush().await?;
                let _ = events.send(Event::FileReceived { device_id: id.into(), name: file_name, path });
            }
        }
    }
}

/// File names from the phone: keep the name, drop any path parts.
fn sanitize(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim_start_matches('.');
    if base.is_empty() { "file".into() } else { base.chars().take(200).collect() }
}

fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = name.rsplit_once('.').map_or((name, String::new()), |(s, e)| (s, format!(".{e}")));
    (2..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).expect("unbounded")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(sanitize("../../etc/passwd"), "passwd");
        assert_eq!(sanitize("C:\\x\\photo.jpg"), "photo.jpg");
        assert_eq!(sanitize(".hidden"), "hidden");
        assert_eq!(sanitize(""), "file");
    }
}
