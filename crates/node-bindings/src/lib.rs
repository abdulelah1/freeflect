//! Node-API surface consumed by the Electron main process.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mirror_android::{AdbClient, AdbState, AndroidSession, AudioStatus};
use mirror_core::{DeviceSession, VideoCodec, VideoConfig};
use mirror_media::h264::AccessUnitAssembler;
use mirror_media::record::Mp4Recorder;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi(object)]
pub struct AndroidDevice {
    pub serial: String,
    /// "device" | "unauthorized" | "offline" | "other"
    pub state: String,
    pub model: Option<String>,
    /// "usb" | "wifi"
    pub transport: String,
}

#[napi]
pub async fn list_android_devices() -> Result<Vec<AndroidDevice>> {
    let devices = AdbClient::default()
        .devices()
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("[{}] {e}", e.code())))?;
    Ok(devices
        .into_iter()
        .map(|d| AndroidDevice {
            state: match d.state {
                AdbState::Device => "device",
                AdbState::Unauthorized => "unauthorized",
                AdbState::Offline => "offline",
                AdbState::Other => "other",
            }
            .into(),
            transport: match d.transport {
                mirror_core::Transport::Usb => "usb",
                mirror_core::Transport::Wifi => "wifi",
            }
            .into(),
            serial: d.serial,
            model: d.model,
        })
        .collect())
}

fn to_napi_err(e: mirror_core::Error) -> Error {
    Error::new(Status::GenericFailure, format!("[{}] {e}", e.code()))
}

#[napi(object)]
pub struct MirrorOptions {
    /// Long-side cap in pixels; omit for native resolution.
    pub max_size: Option<u32>,
    pub bit_rate: Option<u32>,
    pub max_fps: Option<u32>,
    /// Hex id of this desktop install; scopes cleanup of leftover servers.
    pub owner: Option<String>,
    /// Forward the phone's sound (Android 12+; silences the phone's speaker).
    pub audio: Option<bool>,
}

#[napi(object)]
pub struct AudioPacket {
    pub data: Buffer,
    pub pts_us: i64,
    /// AudioSpecificConfig (decoder description) rather than a frame.
    pub config: bool,
}

/// Recording state, shared between the packet loop and the JS-facing handle.
#[derive(Default)]
struct Recording {
    state: RecState,
    finished: Vec<PathBuf>,
    error: Option<String>,
    /// Latest AAC AudioSpecificConfig; a new recording gets an audio track if set.
    audio_config: Option<Vec<u8>>,
}

#[derive(Default)]
enum RecState {
    #[default]
    Idle,
    /// Waiting for a keyframe to start part `part`.
    Waiting { base: PathBuf, part: u32 },
    Active { rec: Mp4Recorder, base: PathBuf, part: u32 },
}

/// `clip.mp4`, then `clip (2).mp4`, `clip (3).mp4` for later parts.
fn part_path(base: &Path, part: u32) -> PathBuf {
    if part <= 1 {
        return base.to_path_buf();
    }
    let stem = base.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    base.with_file_name(format!("{stem} ({part}).mp4"))
}

impl Recording {
    fn on_packet(&mut self, p: &mirror_core::VideoPacket) {
        let state = std::mem::take(&mut self.state);
        self.state = match state {
            RecState::Idle => RecState::Idle,
            RecState::Active { rec, base, part } if p.discontinuity => {
                // Rotation changes the frame size, which an MP4 track can't do
                // mid-file: close this part and continue in a new one.
                self.finish(rec);
                self.start_if_keyframe(p, base, part + 1)
            }
            RecState::Active { mut rec, base, part } => match rec.push(&p.data, p.pts_us, p.keyframe) {
                Ok(()) => RecState::Active { rec, base, part },
                Err(e) => {
                    self.error = Some(e.to_string());
                    self.finish(rec);
                    RecState::Idle
                }
            },
            RecState::Waiting { base, part } => self.start_if_keyframe(p, base, part),
        };
    }

    fn start_if_keyframe(&mut self, p: &mirror_core::VideoPacket, base: PathBuf, part: u32) -> RecState {
        let Some((w, h)) = p.dimensions.filter(|_| p.keyframe) else {
            return RecState::Waiting { base, part };
        };
        match Mp4Recorder::create(&part_path(&base, part), w, h, &p.data, p.pts_us, self.audio_config.as_deref()) {
            Ok(rec) => RecState::Active { rec, base, part },
            Err(e) => {
                self.error = Some(e.to_string());
                RecState::Idle
            }
        }
    }

    fn on_audio(&mut self, p: &mirror_core::AudioPacket) {
        if p.config {
            self.audio_config = Some(p.data.clone());
        } else if let RecState::Active { rec, .. } = &mut self.state
            && let Err(e) = rec.push_audio(&p.data, p.pts_us)
        {
            self.error = Some(e.to_string());
        }
    }

    fn finish(&mut self, rec: Mp4Recorder) {
        match rec.finish() {
            Ok(path) => self.finished.push(path),
            Err(e) => self.error = Some(e.to_string()),
        }
    }

    /// Ends the recording; returns every file written since it started.
    fn stop(&mut self) -> std::result::Result<Vec<PathBuf>, String> {
        if let RecState::Active { rec, .. } = std::mem::take(&mut self.state) {
            self.finish(rec);
        }
        let files = std::mem::take(&mut self.finished);
        match self.error.take() {
            Some(e) if files.is_empty() => Err(e),
            _ => Ok(files),
        }
    }
}

#[napi]
pub struct AndroidMirror {
    session: Arc<AndroidSession>,
    device_name: String,
    recording: Arc<Mutex<Recording>>,
}

#[napi]
impl AndroidMirror {
    #[napi(getter)]
    pub fn device_name(&self) -> String {
        self.device_name.clone()
    }

    /// "on", "off", or the reason sound isn't available on this phone.
    #[napi(getter)]
    pub fn audio_status(&self) -> String {
        match self.session.audio_status() {
            AudioStatus::On => "on".into(),
            AudioStatus::Off => "off".into(),
            AudioStatus::Unavailable(reason) => reason,
        }
    }

    /// `event` is a JSON-encoded `mirror_core::InputEvent`.
    #[napi]
    pub fn inject(&self, event: String) -> Result<bool> {
        let event = serde_json::from_str(&event).map_err(|e| Error::from_reason(format!("bad input event: {e}")))?;
        Ok(self.session.send_input(event))
    }

    #[napi]
    pub fn request_keyframe(&self) {
        self.session.request_keyframe();
    }

    /// Turns the phone's physical screen off (or on) while mirroring continues.
    /// It is turned back on when the session ends.
    #[napi]
    pub fn set_screen_power(&self, on: bool) -> bool {
        self.session.set_screen_power(on)
    }

    /// Sets the phone clipboard; with `paste`, also pastes it into the focused field.
    #[napi]
    pub fn set_clipboard(&self, text: String, paste: bool) -> bool {
        self.session.set_clipboard(text, paste)
    }

    /// Starts recording to `path` (MP4) from the next keyframe.
    #[napi]
    pub fn start_recording(&self, path: String) {
        self.recording.lock().unwrap().begin(path);
        self.session.request_keyframe();
    }

    /// Stops recording; returns the files written (more than one if the phone rotated).
    #[napi]
    pub fn stop_recording(&self) -> Result<Vec<String>> {
        let files = self.recording.lock().unwrap().stop().map_err(Error::from_reason)?;
        Ok(files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
    }

    #[napi]
    pub async fn stop(&self) -> Result<()> {
        self.session.stop().await.map_err(to_napi_err)
    }
}

/// Starts the device server and streams packets to `on_packet`. `on_closed`
/// fires once when the stream ends (phone unplugged, server exit, `stop()`).
#[napi]
pub async fn start_android_mirror(
    serial: String,
    server_jar_path: String,
    options: Option<MirrorOptions>,
    on_packet: ThreadsafeFunction<VideoPacket, (), VideoPacket, Status, false>,
    on_closed: ThreadsafeFunction<String, (), String, Status, false>,
    on_clipboard: ThreadsafeFunction<String, (), String, Status, false>,
    on_audio: ThreadsafeFunction<AudioPacket, (), AudioPacket, Status, false>,
) -> Result<AndroidMirror> {
    let jar = tokio::fs::read(&server_jar_path)
        .await
        .map_err(|e| Error::from_reason(format!("[server_missing] read {server_jar_path}: {e}")))?;
    let adb = AdbClient::default();
    let device = adb
        .devices()
        .await
        .map_err(to_napi_err)?
        .into_iter()
        .find(|d| d.serial == serial)
        .ok_or_else(|| to_napi_err(mirror_core::Error::DeviceNotFound(serial.clone())))?;
    if device.state == AdbState::Unauthorized {
        return Err(to_napi_err(mirror_core::Error::Unauthorized));
    }

    let session = Arc::new(AndroidSession::new(device.to_device_info(), adb, Arc::new(jar)));
    let opts = options.unwrap_or(MirrorOptions { max_size: None, bit_rate: None, max_fps: None, owner: None, audio: None });
    let rx = session
        .start_video(VideoConfig {
            codec: VideoCodec::H264,
            max_size: opts.max_size,
            bitrate: opts.bit_rate.unwrap_or(8_000_000),
            max_fps: opts.max_fps,
            owner: opts.owner,
            audio: opts.audio.unwrap_or(false),
        })
        .await
        .map_err(to_napi_err)?;

    if let Some(mut messages) = session.take_device_messages() {
        tokio::spawn(async move {
            while let Some(mirror_android::control::DeviceMessage::Clipboard(text)) = messages.recv().await {
                on_clipboard.call(text, ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
    }

    let recording = Arc::new(Mutex::new(Recording::default()));
    let rec_in_loop = recording.clone();

    if let Some(mut audio) = session.take_audio() {
        let rec = recording.clone();
        tokio::spawn(async move {
            while let Some(p) = audio.recv().await {
                rec.lock().unwrap().on_audio(&p);
                on_audio.call(
                    AudioPacket { data: p.data.into(), pts_us: p.pts_us, config: p.config },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        });
    }
    spawn_video_loop(rx, rec_in_loop, on_packet, on_closed);

    let device_name = session.device_name().unwrap_or(serial);
    Ok(AndroidMirror { session, device_name, recording })
}

type VideoCallback = ThreadsafeFunction<VideoPacket, (), VideoPacket, Status, false>;
type ClosedCallback = ThreadsafeFunction<String, (), String, Status, false>;

/// Forwards packets to JS and into any active recording; closes the
/// recording and reports the end when the stream stops.
fn spawn_video_loop(
    mut rx: tokio::sync::mpsc::Receiver<mirror_core::VideoPacket>,
    recording: Arc<Mutex<Recording>>,
    on_packet: VideoCallback,
    on_closed: ClosedCallback,
) {
    tokio::spawn(async move {
        while let Some(p) = rx.recv().await {
            recording.lock().unwrap().on_packet(&p);
            on_packet.call(
                VideoPacket {
                    data: p.data.into(),
                    pts_us: p.pts_us,
                    keyframe: p.keyframe,
                    codec: p.codec_string,
                    discontinuity: p.discontinuity,
                    sent_at_ms: now_ms(),
                },
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
        // Close the file so an unplugged phone still leaves a playable recording.
        {
            let mut rec = recording.lock().unwrap();
            if let RecState::Active { rec: r, .. } = std::mem::take(&mut rec.state) {
                rec.finish(r);
            }
        }
        on_closed.call("ended".to_string(), ThreadsafeFunctionCallMode::NonBlocking);
    });
}

impl Recording {
    fn begin(&mut self, path: String) {
        let audio_config = self.audio_config.take();
        *self = Recording { state: RecState::Waiting { base: PathBuf::from(path), part: 1 }, audio_config, ..Default::default() };
    }
}

#[napi(object)]
pub struct VideoPacket {
    pub data: Buffer,
    pub pts_us: i64,
    pub keyframe: bool,
    /// WebCodecs codec string, present when the packet carries an SPS.
    pub codec: Option<String>,
    /// Stream restarted (rotation); reset the decoder before this packet.
    pub discontinuity: bool,
    /// Wall-clock send time (ms since epoch) for latency measurement.
    pub sent_at_ms: f64,
}

#[napi]
pub struct StreamHandle {
    stop: Arc<AtomicBool>,
}

#[napi]
impl StreamHandle {
    #[napi]
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Spike/dev harness: replays an Annex-B `.h264` file as a paced packet
/// stream, standing in for a phone until the Android server exists.
#[napi]
pub fn stream_h264_file(
    path: String,
    fps: u32,
    looped: bool,
    on_packet: ThreadsafeFunction<VideoPacket, (), VideoPacket, Status, false>,
) -> Result<StreamHandle> {
    let bytes = std::fs::read(&path).map_err(|e| Error::from_reason(format!("read {path}: {e}")))?;
    let mut asm = AccessUnitAssembler::new();
    let mut units = asm.push(&bytes);
    units.extend(asm.finish());
    if units.is_empty() {
        return Err(Error::from_reason("no H.264 access units found"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let frame = Duration::from_secs_f64(1.0 / fps.max(1) as f64);

    std::thread::spawn(move || {
        let start = Instant::now();
        let mut n: u64 = 0;
        'outer: loop {
            for unit in &units {
                if stop_flag.load(Ordering::Relaxed) {
                    break 'outer;
                }
                let due = start + frame * n as u32;
                if let Some(wait) = due.checked_duration_since(Instant::now()) {
                    std::thread::sleep(wait);
                }
                let packet = VideoPacket {
                    data: unit.data.clone().into(),
                    pts_us: (frame.as_micros() as i64) * n as i64,
                    keyframe: unit.keyframe,
                    codec: unit.codec_string.clone(),
                    discontinuity: false,
                    sent_at_ms: now_ms(),
                };
                on_packet.call(packet, ThreadsafeFunctionCallMode::NonBlocking);
                n += 1;
            }
            if !looped {
                break;
            }
        }
    });

    Ok(StreamHandle { stop })
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[napi(object)]
pub struct TransferProgress {
    pub sent: f64,
    pub total: f64,
}

/// Calls `on_progress` at most every 100 ms, plus once at the end.
fn throttled_progress(
    on_progress: ThreadsafeFunction<TransferProgress, (), TransferProgress, Status, false>,
) -> impl FnMut(u64, u64) {
    let mut last = Instant::now() - Duration::from_secs(1);
    move |sent, total| {
        if sent == total || last.elapsed() >= Duration::from_millis(100) {
            last = Instant::now();
            on_progress.call(
                TransferProgress { sent: sent as f64, total: total as f64 },
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    }
}

#[napi(object)]
pub struct PhoneFile {
    pub name: String,
    pub is_dir: bool,
    pub size: f64,
    /// Milliseconds since the Unix epoch.
    pub modified_ms: f64,
}

/// Lists a folder on the phone (folders first).
#[napi]
pub async fn list_phone_dir(serial: String, path: String) -> Result<Vec<PhoneFile>> {
    let entries = AdbClient::default().list_dir(&serial, &path).await.map_err(to_napi_err)?;
    Ok(entries
        .into_iter()
        .map(|e| PhoneFile { name: e.name, is_dir: e.is_dir, size: e.size as f64, modified_ms: e.mtime as f64 * 1000.0 })
        .collect())
}

/// Downloads a file from the phone to `local_path`.
#[napi]
pub async fn pull_file(
    serial: String,
    remote_path: String,
    local_path: String,
    on_progress: ThreadsafeFunction<TransferProgress, (), TransferProgress, Status, false>,
) -> Result<()> {
    AdbClient::default()
        .pull_file(&serial, &remote_path, std::path::Path::new(&local_path), throttled_progress(on_progress))
        .await
        .map_err(to_napi_err)
}

/// Copies a local file to `remote_path` on the device.
#[napi]
pub async fn push_file(
    serial: String,
    local_path: String,
    remote_path: String,
    on_progress: ThreadsafeFunction<TransferProgress, (), TransferProgress, Status, false>,
) -> Result<()> {
    AdbClient::default()
        .push_file(&serial, std::path::Path::new(&local_path), &remote_path, throttled_progress(on_progress))
        .await
        .map_err(to_napi_err)
}

/// Installs (or updates) an APK on the device.
#[napi]
pub async fn install_apk(
    serial: String,
    local_path: String,
    on_progress: ThreadsafeFunction<TransferProgress, (), TransferProgress, Status, false>,
) -> Result<()> {
    AdbClient::default()
        .install_apk(&serial, std::path::Path::new(&local_path), throttled_progress(on_progress))
        .await
        .map_err(to_napi_err)
}

#[napi(object)]
pub struct MdnsService {
    pub name: String,
    pub service_type: String,
    pub address: String,
}

/// Wireless-debugging services the ADB server currently sees on the network.
#[napi]
pub async fn mdns_services() -> Result<Vec<MdnsService>> {
    let services = AdbClient::default().mdns_services().await.map_err(to_napi_err)?;
    Ok(services
        .into_iter()
        .map(|(name, service_type, address)| MdnsService { name, service_type, address })
        .collect())
}

#[napi]
pub async fn pair_device(host_port: String, code: String) -> Result<String> {
    AdbClient::default().pair(&host_port, &code).await.map_err(to_napi_err)
}

#[napi]
pub async fn connect_device(host_port: String) -> Result<String> {
    AdbClient::default().connect_device(&host_port).await.map_err(to_napi_err)
}

/// Switches a USB-connected device to Wi-Fi debugging and connects to it.
/// Returns the new `ip:port` serial.
#[napi]
pub async fn enable_wifi(serial: String) -> Result<String> {
    const PORT: u16 = 5555;
    let adb = AdbClient::default();
    let ip = adb
        .wifi_ip(&serial)
        .await
        .map_err(to_napi_err)?
        .ok_or_else(|| Error::from_reason("[no_wifi] The phone is not connected to Wi-Fi"))?;
    adb.tcpip(&serial, PORT).await.map_err(to_napi_err)?;
    let target = format!("{ip}:{PORT}");
    // adbd needs a moment to restart in TCP mode.
    let mut last_err = None;
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        match adb.connect_device(&target).await {
            Ok(_) => return Ok(target),
            Err(e) => last_err = Some(e),
        }
    }
    Err(to_napi_err(last_err.expect("at least one attempt")))
}

/// Runs a shell command on the device and returns its output. Only called by
/// the main process with fixed commands, never with renderer-supplied text.
#[napi]
pub async fn device_shell(serial: String, command: String) -> Result<String> {
    AdbClient::default().shell_output(&serial, &command).await.map_err(to_napi_err)
}

#[napi(object)]
pub struct DeviceProps {
    pub manufacturer: String,
    pub model: String,
    /// Marketing name where the vendor sets one (e.g. Xiaomi), else empty.
    pub market_name: String,
    pub android_version: String,
    pub sdk: u32,
}

/// Brand, model and Android version, for setup guidance and diagnostics.
#[napi]
pub async fn device_props(serial: String) -> Result<DeviceProps> {
    let out = AdbClient::default()
        .shell_output(
            &serial,
            "getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.product.marketname; \
             getprop ro.build.version.release; getprop ro.build.version.sdk",
        )
        .await
        .map_err(to_napi_err)?;
    let mut lines = out.lines().map(str::trim);
    let mut next = || lines.next().unwrap_or_default().to_string();
    Ok(DeviceProps {
        manufacturer: next(),
        model: next(),
        market_name: next(),
        android_version: next(),
        sdk: next().parse().unwrap_or(0),
    })
}

#[napi]
pub struct ShellStream {
    stop: Arc<AtomicBool>,
}

#[napi]
impl ShellStream {
    #[napi]
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Batches of at most this many lines, flushed at least this often.
const LINE_BATCH: usize = 200;
const LINE_FLUSH: Duration = Duration::from_millis(100);

/// Runs a long-lived shell command (e.g. logcat) and delivers its output in
/// line batches. Only called by the main process with fixed commands.
#[napi]
pub async fn stream_shell(
    serial: String,
    command: String,
    on_lines: ThreadsafeFunction<Vec<String>, (), Vec<String>, Status, false>,
) -> Result<ShellStream> {
    use tokio::io::AsyncBufReadExt;
    let stream = AdbClient::default().shell(&serial, &command).await.map_err(to_napi_err)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stream).lines();
        let mut batch = Vec::with_capacity(LINE_BATCH);
        let mut tick = tokio::time::interval(LINE_FLUSH);
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(l)) => {
                        batch.push(l);
                        if batch.len() >= LINE_BATCH {
                            on_lines.call(std::mem::take(&mut batch), ThreadsafeFunctionCallMode::NonBlocking);
                        }
                    }
                    _ => break,
                },
                _ = tick.tick() => {
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    if !batch.is_empty() {
                        on_lines.call(std::mem::take(&mut batch), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
            }
        }
        // Dropping the socket ends the command on the device.
    });
    Ok(ShellStream { stop })
}

#[napi(object)]
pub struct IosDeviceInfo {
    /// AVFoundation unique id of the device.
    pub id: String,
    pub name: String,
}

/// Trusted iPhones/iPads connected by USB (macOS, via the capture helper).
#[napi]
pub async fn list_ios_devices(helper_path: String) -> Result<Vec<IosDeviceInfo>> {
    let devices = mirror_ios::list_devices(&helper_path).await.map_err(to_napi_err)?;
    Ok(devices.into_iter().map(|d| IosDeviceInfo { id: d.id, name: d.name }).collect())
}

/// Mirroring session for an iPhone/iPad. Same surface as `AndroidMirror` so
/// the desktop treats both alike; control features report "not available".
#[napi]
pub struct IosMirror {
    capture: Arc<tokio::sync::Mutex<mirror_ios::IosCapture>>,
    device_name: String,
    recording: Arc<Mutex<Recording>>,
    audio: bool,
}

#[napi]
impl IosMirror {
    #[napi(getter)]
    pub fn device_name(&self) -> String {
        self.device_name.clone()
    }

    #[napi(getter)]
    pub fn audio_status(&self) -> String {
        if self.audio { "on".into() } else { "off".into() }
    }

    /// iPhone control is not available yet (Phase 5).
    #[napi]
    pub fn inject(&self, _event: String) -> bool {
        false
    }

    #[napi]
    pub fn set_clipboard(&self, _text: String, _paste: bool) -> bool {
        false
    }

    #[napi]
    pub fn set_screen_power(&self, _on: bool) -> bool {
        false
    }

    #[napi]
    pub fn request_keyframe(&self) {
        // JS thread: use napi's runtime (tokio::spawn would panic here).
        let capture = self.capture.clone();
        spawn(async move { capture.lock().await.request_keyframe().await });
    }

    #[napi]
    pub fn start_recording(&self, path: String) {
        self.recording.lock().unwrap().begin(path);
        self.request_keyframe();
    }

    #[napi]
    pub fn stop_recording(&self) -> Result<Vec<String>> {
        let files = self.recording.lock().unwrap().stop().map_err(Error::from_reason)?;
        Ok(files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
    }

    #[napi]
    pub async fn stop(&self) -> Result<()> {
        self.capture.lock().await.stop().await;
        Ok(())
    }
}

/// Starts mirroring an iPhone/iPad over USB (macOS).
#[napi]
#[allow(clippy::too_many_arguments)] // One JS function, its arguments as JS sees them.
pub async fn start_ios_mirror(
    helper_path: String,
    device_id: String,
    device_name: String,
    bit_rate: Option<u32>,
    // Spelled out (not the aliases) so the generated TypeScript types resolve.
    on_packet: ThreadsafeFunction<VideoPacket, (), VideoPacket, Status, false>,
    on_closed: ThreadsafeFunction<String, (), String, Status, false>,
    // With audio, the iPhone's sound plays on the Mac (as in QuickTime).
    audio: bool,
    on_audio: ThreadsafeFunction<AudioPacket, (), AudioPacket, Status, false>,
) -> Result<IosMirror> {
    let (capture, rx, mut audio_rx) = mirror_ios::IosCapture::start(&helper_path, &device_id, bit_rate.unwrap_or(8_000_000), audio)
        .await
        .map_err(to_napi_err)?;
    let recording = Arc::new(Mutex::new(Recording::default()));
    let rec = recording.clone();
    tokio::spawn(async move {
        while let Some(p) = audio_rx.recv().await {
            rec.lock().unwrap().on_audio(&p);
            on_audio.call(
                AudioPacket { data: p.data.into(), pts_us: p.pts_us, config: p.config },
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    });
    spawn_video_loop(rx, recording.clone(), on_packet, on_closed);
    Ok(IosMirror { capture: Arc::new(tokio::sync::Mutex::new(capture)), device_name, recording, audio })
}

#[napi]
pub struct PortForward {
    port: u16,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[napi]
impl PortForward {
    #[napi(getter)]
    pub fn port(&self) -> u32 {
        self.port as u32
    }

    #[napi]
    pub fn stop(&self) {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
    }
}

/// UDIDs of iOS devices connected by USB (usbmuxd).
#[napi]
pub async fn list_ios_usb_devices() -> Result<Vec<String>> {
    let devices = mirror_ios::usbmux::list_devices().await.map_err(to_napi_err)?;
    Ok(devices.into_iter().map(|d| d.serial).collect())
}

#[napi(object)]
pub struct IosUsbDevice {
    pub udid: String,
    /// The name set on the iPhone, when it could be read.
    pub name: Option<String>,
}

/// USB iPhones with their names, to match them to screen capture devices
/// (which macOS names after the phone).
#[napi]
pub async fn list_ios_usb_devices_named() -> Result<Vec<IosUsbDevice>> {
    let devices = mirror_ios::usbmux::list_devices().await.map_err(to_napi_err)?;
    let mut out = Vec::with_capacity(devices.len());
    for d in devices {
        let name = mirror_ios::lockdown::device_name(d.device_id).await.ok();
        out.push(IosUsbDevice { udid: d.serial, name });
    }
    Ok(out)
}

/// Forwards a local port to `device_port` on the iOS device with `udid`.
#[napi]
pub async fn forward_ios_port(udid: String, device_port: u32) -> Result<PortForward> {
    let device = mirror_ios::usbmux::list_devices()
        .await
        .map_err(to_napi_err)?
        .into_iter()
        .find(|d| d.serial == udid)
        .ok_or_else(|| Error::from_reason("[device_not_found] iPhone not connected by USB"))?;
    let (port, task) = mirror_ios::usbmux::forward(device.device_id, device_port as u16).await.map_err(to_napi_err)?;
    Ok(PortForward { port, task: Mutex::new(Some(task)) })
}

#[napi(object)]
pub struct IosMediaItem {
    pub path: String,
    pub name: String,
    pub size: f64,
    pub modified_ms: f64,
    pub video: bool,
}

/// Photos and videos in the iPhone's camera roll (USB), newest first.
#[napi]
pub async fn list_ios_media(udid: String) -> Result<Vec<IosMediaItem>> {
    let items = mirror_ios::afc::list_media(&udid).await.map_err(to_napi_err)?;
    Ok(items
        .into_iter()
        .map(|m| IosMediaItem { path: m.path, name: m.name, size: m.size as f64, modified_ms: m.mtime as f64 * 1000.0, video: m.video })
        .collect())
}

/// Downloads a file from the iPhone's media area to `local_path`.
#[napi]
pub async fn pull_ios_file(
    udid: String,
    remote_path: String,
    local_path: String,
    on_progress: ThreadsafeFunction<TransferProgress, (), TransferProgress, Status, false>,
) -> Result<()> {
    let mut afc = mirror_ios::afc::Afc::connect(&udid).await.map_err(to_napi_err)?;
    afc.download(&remote_path, std::path::Path::new(&local_path), throttled_progress(on_progress))
        .await
        .map_err(to_napi_err)
}

#[napi(object)]
pub struct CompanionEvent {
    /// approval | screen-started | screen-stopped | clipboard | file | control-connected | control-disconnected
    pub kind: String,
    pub device_id: String,
    pub name: Option<String>,
    pub text: Option<String>,
    pub path: Option<String>,
    /// For `approval`: pass to `CompanionServer.approve`.
    pub request_id: Option<u32>,
}

#[napi(object)]
pub struct CompanionVideoPacket {
    pub device_id: String,
    pub data: Buffer,
    pub pts_us: i64,
    pub keyframe: bool,
    pub codec: Option<String>,
    pub discontinuity: bool,
    pub sent_at_ms: f64,
}

#[napi(object)]
pub struct CompanionAudioPacket {
    pub device_id: String,
    pub data: Buffer,
    pub pts_us: i64,
    /// AudioSpecificConfig (decoder description) rather than a frame.
    pub config: bool,
}

type CompanionRecordings = Arc<Mutex<std::collections::HashMap<String, Recording>>>;

/// Local-network server for the iOS companion app.
#[napi]
pub struct CompanionServer {
    server: mirror_companion::Server,
    approvals: Arc<Mutex<std::collections::HashMap<u32, tokio::sync::oneshot::Sender<bool>>>>,
    /// Per phone; kept between broadcasts so the audio config survives.
    recordings: CompanionRecordings,
}

#[napi]
impl CompanionServer {
    #[napi(getter)]
    pub fn port(&self) -> u32 {
        self.server.port as u32
    }

    /// Answers an `approval` event: allow or refuse the new device.
    #[napi]
    pub fn approve(&self, request_id: u32, allow: bool) {
        if let Some(reply) = self.approvals.lock().unwrap().remove(&request_id) {
            let _ = reply.send(allow);
        }
    }

    #[napi]
    pub fn request_keyframe(&self, device_id: String) {
        // Called on the JS thread, outside tokio: napi's spawn uses its runtime
        // (tokio::spawn here panics and aborts the whole app).
        let server = self.server.clone();
        spawn(async move { server.request_keyframe(&device_id).await });
    }

    #[napi]
    pub fn set_downloads_dir(&self, dir: String) {
        self.server.set_downloads(PathBuf::from(dir));
    }

    #[napi]
    pub fn forget(&self, device_id: String) {
        self.server.forget(&device_id);
    }

    #[napi]
    pub fn shutdown(&self) {
        self.server.shutdown();
    }

    /// Starts recording a broadcasting phone to `path` (MP4) from the next keyframe.
    #[napi]
    pub fn start_recording(&self, device_id: String, path: String) {
        self.recordings.lock().unwrap().entry(device_id.clone()).or_default().begin(path);
        self.request_keyframe(device_id);
    }

    #[napi]
    pub fn stop_recording(&self, device_id: String) -> Result<Vec<String>> {
        let mut recordings = self.recordings.lock().unwrap();
        let Some(rec) = recordings.get_mut(&device_id) else { return Ok(vec![]) };
        let files = rec.stop().map_err(Error::from_reason)?;
        Ok(files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
    }

    #[napi]
    pub async fn send_clipboard(&self, device_id: String, text: String) -> Result<()> {
        self.server.send_clipboard(&device_id, text).await.map_err(to_napi_err)
    }

    #[napi]
    pub async fn send_file(&self, device_id: String, path: String) -> Result<()> {
        self.server.send_file(&device_id, std::path::Path::new(&path)).await.map_err(to_napi_err)
    }
}

/// Starts the companion server and advertises it on the local network.
#[napi]
pub async fn start_companion_server(
    desktop_name: String,
    allowed: Vec<String>,
    downloads_dir: String,
    on_event: ThreadsafeFunction<CompanionEvent, (), CompanionEvent, Status, false>,
    on_video: ThreadsafeFunction<CompanionVideoPacket, (), CompanionVideoPacket, Status, false>,
    on_audio: ThreadsafeFunction<CompanionAudioPacket, (), CompanionAudioPacket, Status, false>,
) -> Result<CompanionServer> {
    use mirror_companion::Event;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let server = mirror_companion::Server::start(&desktop_name, allowed, PathBuf::from(downloads_dir), tx)
        .await
        .map_err(to_napi_err)?;
    let approvals = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let pending = approvals.clone();
    let recordings: CompanionRecordings = Arc::default();
    let recs = recordings.clone();
    tokio::spawn(async move {
        let mut next_id = 0u32;
        let event = |kind: &str, device_id: String| CompanionEvent {
            kind: kind.into(),
            device_id,
            name: None,
            text: None,
            path: None,
            request_id: None,
        };
        while let Some(e) = rx.recv().await {
            let out = match e {
                Event::Video { device_id, packet } => {
                    if let Some(rec) = recs.lock().unwrap().get_mut(&device_id) {
                        rec.on_packet(&packet);
                    }
                    on_video.call(
                        CompanionVideoPacket {
                            device_id,
                            data: packet.data.into(),
                            pts_us: packet.pts_us,
                            keyframe: packet.keyframe,
                            codec: packet.codec_string,
                            discontinuity: packet.discontinuity,
                            sent_at_ms: now_ms(),
                        },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                    continue;
                }
                Event::ApprovalNeeded { device_id, name, reply } => {
                    next_id += 1;
                    pending.lock().unwrap().insert(next_id, reply);
                    CompanionEvent { name: Some(name), request_id: Some(next_id), ..event("approval", device_id) }
                }
                Event::ScreenStarted { device_id, name } => CompanionEvent { name: Some(name), ..event("screen-started", device_id) },
                Event::Audio { device_id, packet } => {
                    recs.lock().unwrap().entry(device_id.clone()).or_default().on_audio(&packet);
                    on_audio.call(
                        CompanionAudioPacket { device_id, data: packet.data.into(), pts_us: packet.pts_us, config: packet.config },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                    continue;
                }
                Event::ScreenStopped { device_id } => {
                    // Close the file so a stopped broadcast still leaves a playable recording.
                    if let Some(rec) = recs.lock().unwrap().get_mut(&device_id)
                        && let RecState::Active { rec: r, .. } = std::mem::take(&mut rec.state)
                    {
                        rec.finish(r);
                    }
                    event("screen-stopped", device_id)
                }
                Event::Clipboard { device_id, name, text } => CompanionEvent { name: Some(name), text: Some(text), ..event("clipboard", device_id) },
                Event::FileReceived { device_id, name, path } => CompanionEvent {
                    name: Some(name),
                    path: Some(path.to_string_lossy().into_owned()),
                    ..event("file", device_id)
                },
                Event::ControlConnected { device_id, name } => CompanionEvent { name: Some(name), ..event("control-connected", device_id) },
                Event::ControlDisconnected { device_id } => event("control-disconnected", device_id),
            };
            on_event.call(out, ThreadsafeFunctionCallMode::NonBlocking);
        }
    });
    Ok(CompanionServer { server, approvals, recordings })
}
