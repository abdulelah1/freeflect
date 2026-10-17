//! Deploys and talks to the on-device server (`android-server/`).

use std::time::Duration;

use mirror_core::{AudioPacket, Error, Result, VideoPacket};
use mirror_media::h264::codec_string_from_annexb;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::adb::AdbClient;
use crate::control::DeviceMessage;

pub const REMOTE_JAR: &str = "/data/local/tmp/mirror-server.jar";
const MAIN_CLASS: &str = "com.mirror.server.Server";
const PROTOCOL_VERSION: u8 = 1;

const FLAG_CONFIG: u64 = 1 << 63;
const FLAG_KEY: u64 = 1 << 62;
const PTS_MASK: u64 = !(FLAG_CONFIG | FLAG_KEY);
const SESSION_MARKER: u64 = u64::MAX;
/// iPhone streams interleave audio: this marker, then an audio packet.
const AUDIO_MARKER: u64 = u64::MAX - 1;

const CONNECT_ATTEMPTS: u32 = 50;
const CONNECT_RETRY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Default)]
pub struct ServerOptions {
    pub max_size: u32,
    pub bit_rate: u32,
    pub max_fps: u32,
    /// Hex id of the desktop install. Leftover servers are only cleaned up
    /// when they carry the same id, so two desktop apps (or a test run next
    /// to a real session) never kill each other's mirroring.
    pub owner: String,
    pub audio: bool,
}

/// Outcome of the audio socket handshake.
pub enum AudioChannel {
    Off,
    Unavailable(String),
    On(TcpStream),
}

/// Codec id the server sends for AAC (`"\0aac"`).
const AUDIO_CODEC_AAC: u32 = 0x0061_6163;

pub struct ServerConnection {
    pub device_name: String,
    pub port: u16,
    pub video: TcpStream,
    pub control: TcpStream,
    pub audio: AudioChannel,
    /// The `app_process` shell; dropping it does not stop the server, closing
    /// the control socket does.
    pub shell: TcpStream,
}

/// Pushes the server, starts it and opens the video + control sockets.
pub async fn start(adb: &AdbClient, serial: &str, jar: &[u8], opts: &ServerOptions) -> Result<ServerConnection> {
    // A server orphaned by a crashed or killed desktop keeps its encoder busy
    // and degrades the new stream, so clear this install's leftovers first.
    let owner: String = opts.owner.chars().filter(char::is_ascii_hexdigit).collect();
    // The `Serve[r]` bracket stops pkill from matching the shell that runs it
    // (its own command line contains the pattern text).
    let class = MAIN_CLASS.strip_suffix('r').map_or(MAIN_CLASS.to_string(), |c| format!("{c}[r]"));
    let pattern = if owner.is_empty() { class } else { format!("{class}.*owner={owner}") };
    adb.shell_output(serial, &format!("pkill -f '{pattern}'")).await?;
    adb.push(serial, jar, REMOTE_JAR, 0o644).await?;

    let scid = new_scid();
    let socket = format!("localabstract:mirror_{scid}");
    let port = adb.forward_any_port(serial, &socket).await?;

    let cmd = format!(
        "CLASSPATH={REMOTE_JAR} app_process / {MAIN_CLASS} scid={scid} max_size={} bit_rate={} max_fps={} owner={owner} audio={}",
        opts.max_size, opts.bit_rate, opts.max_fps, u8::from(opts.audio)
    );
    let shell = adb.shell(serial, &cmd).await?;

    match connect(port).await {
        Ok((video, device_name)) => {
            let control = TcpStream::connect(("127.0.0.1", port)).await?;
            control.set_nodelay(true)?;
            let audio = if opts.audio { open_audio(port).await? } else { AudioChannel::Off };
            Ok(ServerConnection { device_name, port, video, control, audio, shell })
        }
        Err(e) => {
            let _ = adb.remove_forward(serial, port).await;
            // The server's own output is the most useful diagnostic.
            let mut log = String::new();
            let mut shell = shell;
            let _ = tokio::time::timeout(Duration::from_millis(500), shell.read_to_string(&mut log)).await;
            Err(Error::Protocol(format!("server did not start: {e}. Output: {}", log.trim())))
        }
    }
}

async fn open_audio(port: u16) -> Result<AudioChannel> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await?;
    s.set_nodelay(true)?;
    match s.read_u32().await? {
        AUDIO_CODEC_AAC => Ok(AudioChannel::On(s)),
        0 => {
            let mut reason = vec![0u8; s.read_u8().await? as usize];
            s.read_exact(&mut reason).await?;
            Ok(AudioChannel::Unavailable(String::from_utf8_lossy(&reason).into_owned()))
        }
        other => Err(Error::Protocol(format!("unknown audio codec {other:#x}"))),
    }
}

/// Reads audio packets (same framing as video) until the socket closes.
pub async fn read_audio<R: AsyncReadExt + Unpin>(mut audio: R, tx: mpsc::Sender<AudioPacket>) -> Result<()> {
    loop {
        let header = match audio.read_u64().await {
            Ok(h) => h,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let len = audio.read_u32().await? as usize;
        let mut data = vec![0u8; len];
        audio.read_exact(&mut data).await?;
        let packet = AudioPacket { data, pts_us: (header & PTS_MASK) as i64, config: header & FLAG_CONFIG != 0 };
        if tx.send(packet).await.is_err() {
            return Ok(());
        }
    }
}

/// With `adb forward`, connecting succeeds even before the server listens, so
/// a connection only counts once the server's handshake arrives.
async fn connect(port: u16) -> Result<(TcpStream, String)> {
    let mut last_err = Error::Protocol("no attempt made".into());
    for _ in 0..CONNECT_ATTEMPTS {
        match try_handshake(port).await {
            Ok(ok) => return Ok(ok),
            Err(e) => last_err = e,
        }
        tokio::time::sleep(CONNECT_RETRY).await;
    }
    Err(last_err)
}

async fn try_handshake(port: u16) -> Result<(TcpStream, String)> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await?;
    let mut head = [0u8; 6];
    s.read_exact(&mut head).await?;
    if &head[..4] != b"MIRR" {
        return Err(Error::Protocol(format!("bad handshake magic {:?}", &head[..4])));
    }
    if head[4] != PROTOCOL_VERSION {
        return Err(Error::Protocol(format!("server protocol v{}, desktop v{PROTOCOL_VERSION}", head[4])));
    }
    let mut name = vec![0u8; head[5] as usize];
    s.read_exact(&mut name).await?;
    s.set_nodelay(true)?;
    Ok((s, String::from_utf8_lossy(&name).into_owned()))
}

/// Reads video packets until the socket closes.
///
/// Every keyframe is made self-contained: encoders such as Samsung's Exynos
/// send SPS/PPS only once per session, so a decoder created later (device
/// window, error recovery) could never configure from a requested keyframe.
/// The last config is therefore prepended to each keyframe that lacks one.
pub async fn read_video<R: AsyncReadExt + Unpin>(video: R, tx: mpsc::Sender<VideoPacket>) -> Result<()> {
    read_video_and_audio(video, tx, None).await
}

/// Like `read_video`, for streams that interleave audio packets after
/// `AUDIO_MARKER` (the iPhone helper and companion app). Audio is dropped
/// when `audio` is None or its receiver is gone.
pub async fn read_video_and_audio<R: AsyncReadExt + Unpin>(
    mut video: R,
    tx: mpsc::Sender<VideoPacket>,
    audio: Option<mpsc::Sender<AudioPacket>>,
) -> Result<()> {
    let mut pending_config: Option<Vec<u8>> = None;
    let mut last_config: Option<Vec<u8>> = None;
    let mut discontinuity = false;
    let mut dimensions: Option<(u16, u16)> = None;
    loop {
        let header = match video.read_u64().await {
            Ok(h) => h,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if header == AUDIO_MARKER {
            let header = video.read_u64().await?;
            let len = video.read_u32().await? as usize;
            let mut data = vec![0u8; len];
            video.read_exact(&mut data).await?;
            if let Some(a) = &audio {
                // Never block video on a slow audio consumer.
                let _ = a.try_send(AudioPacket { data, pts_us: (header & PTS_MASK) as i64, config: header & FLAG_CONFIG != 0 });
            }
            continue;
        }
        if header == SESSION_MARKER {
            let width = video.read_u16().await?;
            let height = video.read_u16().await?;
            dimensions = Some((width, height));
            discontinuity = true;
            last_config = None;
            continue;
        }
        let len = video.read_u32().await? as usize;
        let mut data = vec![0u8; len];
        video.read_exact(&mut data).await?;

        if header & FLAG_CONFIG != 0 {
            last_config = Some(data.clone());
            pending_config = Some(data);
            continue;
        }
        let keyframe = header & FLAG_KEY != 0;
        let has_inline_sps = keyframe && codec_string_from_annexb(&data).is_some();
        if keyframe && pending_config.is_none() && !has_inline_sps {
            pending_config.clone_from(&last_config);
        }
        let codec_string = pending_config.as_deref().and_then(codec_string_from_annexb).or_else(|| {
            has_inline_sps.then(|| codec_string_from_annexb(&data)).flatten()
        });
        if let Some(mut config) = pending_config.take() {
            config.extend_from_slice(&data);
            data = config;
        }
        let packet = VideoPacket {
            data,
            pts_us: (header & PTS_MASK) as i64,
            keyframe,
            codec_string,
            discontinuity: std::mem::take(&mut discontinuity),
            dimensions: if keyframe { dimensions } else { None },
        };
        if tx.send(packet).await.is_err() {
            return Ok(()); // Consumer stopped.
        }
    }
}

const DEVICE_CLIPBOARD: u8 = 0;
/// Upper bound on a clipboard message, to reject a corrupt length.
const MAX_CLIPBOARD_BYTES: usize = 16 * 1024 * 1024;

/// Reads device → desktop messages from the control socket until it closes.
pub async fn read_device_messages<R: AsyncReadExt + Unpin>(mut control: R, tx: mpsc::Sender<DeviceMessage>) -> Result<()> {
    loop {
        let kind = match control.read_u8().await {
            Ok(k) => k,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        match kind {
            DEVICE_CLIPBOARD => {
                let len = control.read_u32().await? as usize;
                if len > MAX_CLIPBOARD_BYTES {
                    return Err(Error::Protocol(format!("clipboard message too large: {len}")));
                }
                let mut buf = vec![0u8; len];
                control.read_exact(&mut buf).await?;
                let text = String::from_utf8_lossy(&buf).into_owned();
                if tx.send(DeviceMessage::Clipboard(text)).await.is_err() {
                    return Ok(());
                }
            }
            other => return Err(Error::Protocol(format!("unknown device message {other}"))),
        }
    }
}

/// Forwards server log lines to stderr until the shell closes.
pub async fn pipe_server_log(shell: TcpStream) {
    let mut lines = BufReader::new(shell).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("{line}");
    }
}

fn new_scid() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() ^ d.as_secs() as u32)
        .unwrap_or(0);
    format!("{:08x}", nanos ^ std::process::id().rotate_left(16))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: &[u8] = &[0, 0, 0, 1, 0x67, 0x64, 0x00, 0x33, 0xac];
    const PPS: &[u8] = &[0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80];
    const IDR: &[u8] = &[0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21];
    const P: &[u8] = &[0, 0, 0, 1, 0x41, 0x9a, 0x02];

    fn packet(flags: u64, pts: u64, data: &[u8]) -> Vec<u8> {
        let mut b = (flags | pts).to_be_bytes().to_vec();
        b.extend_from_slice(&(data.len() as u32).to_be_bytes());
        b.extend_from_slice(data);
        b
    }

    #[tokio::test]
    async fn prepends_cached_config_to_later_keyframes() {
        let config = [SPS, PPS].concat();
        let stream = [
            packet(FLAG_CONFIG, 0, &config),
            packet(FLAG_KEY, 1, IDR),
            packet(0, 2, P),
            // Requested keyframe: the encoder sends no new SPS/PPS.
            packet(FLAG_KEY, 3, IDR),
        ]
        .concat();
        let (tx, mut rx) = mpsc::channel(8);
        read_video(&stream[..], tx).await.unwrap();

        let first = rx.recv().await.unwrap();
        assert_eq!(first.codec_string.as_deref(), Some("avc1.640033"));
        assert_eq!(first.data, [config.as_slice(), IDR].concat());
        let delta = rx.recv().await.unwrap();
        assert!(delta.codec_string.is_none() && delta.data == P);
        let later = rx.recv().await.unwrap();
        assert!(later.keyframe);
        assert_eq!(later.codec_string.as_deref(), Some("avc1.640033"));
        assert_eq!(later.data, [config.as_slice(), IDR].concat());
    }

    #[tokio::test]
    async fn separates_interleaved_audio() {
        let asc = [0x12, 0x10];
        let aac = [0x21, 0x10, 0x05];
        let stream = [
            AUDIO_MARKER.to_be_bytes().to_vec(),
            packet(FLAG_CONFIG, 0, &asc),
            packet(FLAG_KEY, 1_000, &[SPS, PPS, IDR].concat()),
            AUDIO_MARKER.to_be_bytes().to_vec(),
            packet(0, 1_500, &aac),
            packet(0, 2_000, P),
        ]
        .concat();
        let (tx, mut rx) = mpsc::channel(8);
        let (atx, mut arx) = mpsc::channel(8);
        read_video_and_audio(&stream[..], tx, Some(atx)).await.unwrap();

        assert!(rx.recv().await.unwrap().keyframe);
        assert_eq!(rx.recv().await.unwrap().data, P);
        assert!(rx.recv().await.is_none());
        let config = arx.recv().await.unwrap();
        assert!(config.config && config.data == asc);
        let frame = arx.recv().await.unwrap();
        assert!(!frame.config && frame.data == aac && frame.pts_us == 1_500);
    }
}
