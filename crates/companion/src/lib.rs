//! Server for the iOS companion app (native/ios/MirrorCompanion), on the
//! local network. The desktop advertises `_mirror-desk._tcp` with Bonjour;
//! the app and its broadcast extension connect. See docs/protocol.md.
//!
//! Every connection is TLS with the desktop's self-signed certificate, which
//! the phone pins when it pairs. The first line from the phone is a JSON hello:
//!   {"v":2,"role":"video"|"control","deviceId":"<uuid>","secret":"<hex>"}
//! answered by `{"ok":true,"name":"<desktop>"}` or `{"ok":false,"reason":"..."}`.
//! Only paired phones get in; nothing on the network can raise a prompt.
//!
//! Pairing happens only while the user has the pairing window open, with
//! either the QR code (`role: "pair"`, carries a one-time token and the
//! certificate fingerprint) or the typed code (`role: "pair-code"`, see
//! `pair_with_code`). It hands the phone a random secret for later hellos.
//!
//! video:   the phone streams the Android packet format (docs/protocol.md),
//!          with AAC audio packets interleaved after the audio marker;
//!          the desktop writes "k\n" to ask for a keyframe.
//! control: frames of u32 big-endian length + JSON both ways; a
//!          {"type":"file","name","size"} frame is followed by `size` bytes.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mirror_core::{AudioPacket, Error, Result, VideoPacket};
use ring::rand::{SecureRandom, SystemRandom};
use ring::{digest, hmac, pbkdf2};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::AbortHandle;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

pub const SERVICE_TYPE: &str = "_mirror-desk._tcp.local.";
const PROTOCOL_VERSION: u32 = 2;
const MAX_FILE_BYTES: u64 = 4 << 30;
const MAX_FRAME_BYTES: u32 = 1 << 20;
/// Received files never leave less than this free on the disk.
const MIN_FREE_BYTES: u64 = 1 << 30;
const MAX_LINE_BYTES: u64 = 4096;
/// TLS plus hello; a peer that stalls is dropped.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 10 });
/// The typed-code exchange includes the phone's key derivation.
const PAIR_CODE_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 20 } else { 30 });
/// Connections still in their handshake; more are closed straight away.
const MAX_PENDING: usize = 8;
const PAIRING_WINDOW: Duration = Duration::from_secs(120);
const MAX_PAIRING_FAILURES: u8 = 3;
/// Slows down guessing the typed code from a recorded exchange: every guess
/// costs this many HMACs, and the code dies when the pairing window closes.
pub const PBKDF2_ITERATIONS: u32 = 600_000;
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 8;

type Tls = TlsStream<TcpStream>;
type Writer = Arc<tokio::sync::Mutex<WriteHalf<Tls>>>;

#[derive(Debug, Deserialize)]
struct Hello {
    v: u32,
    role: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    secret: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    nonce: String,
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
    /// A phone paired; save `secret_hash` with it and pass it to `start` next time.
    Paired { device_id: String, name: String, secret_hash: String },
    /// The pairing window closed: "paired", "expired" or "attempts".
    PairingClosed { reason: &'static str },
    ScreenStarted { device_id: String, name: String },
    ScreenStopped { device_id: String },
    Video { device_id: String, packet: VideoPacket },
    Audio { device_id: String, packet: AudioPacket },
    Clipboard { device_id: String, name: String, text: String },
    FileReceived { device_id: String, name: String, path: PathBuf },
    ControlConnected { device_id: String, name: String },
    ControlDisconnected { device_id: String },
}

/// A phone allowed earlier: its id and the SHA-256 of its secret (hex).
#[derive(Debug, Clone)]
pub struct PairedDevice {
    pub device_id: String,
    pub secret_hash: String,
}

/// What the pairing screen shows.
#[derive(Debug, Clone)]
pub struct PairingInfo {
    /// Contents of the QR code.
    pub qr: String,
    /// The typed-code alternative, grouped as `XXXX-XXXX`.
    pub code: String,
    pub expires_in_secs: u32,
}

struct Pairing {
    id: u64,
    token: [u8; 16],
    code: String,
    failures: u8,
}

/// A live video or control connection. `id` tells a replaced connection
/// from the current one when it ends.
struct Link {
    id: u64,
    writer: Writer,
    abort: AbortHandle,
}

#[derive(Default)]
struct Shared {
    paired: HashMap<String, [u8; 32]>,
    /// Where received files go; changeable while running.
    downloads: PathBuf,
    pairing: Option<Pairing>,
    video: HashMap<String, Link>,
    control: HashMap<String, Link>,
    /// Phones whose sound the desktop plays; the rest keep it on the phone.
    sound: std::collections::HashSet<String>,
    next_id: u64,
}

impl Shared {
    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
}

struct Context {
    shared: Mutex<Shared>,
    events: mpsc::UnboundedSender<Event>,
    desktop_name: String,
    fingerprint: [u8; 32],
}

#[derive(Clone)]
pub struct Server {
    ctx: Arc<Context>,
    pub port: u16,
    /// SHA-256 of the desktop certificate (hex), which paired phones pin.
    pub fingerprint: String,
    mdns: Arc<mdns_sd::ServiceDaemon>,
    /// Full mDNS name, withdrawn on shutdown so the network forgets it.
    service: String,
    accept: Arc<tokio::task::JoinHandle<()>>,
    /// Methods are also called from threads outside tokio (Node's JS thread).
    runtime: tokio::runtime::Handle,
}

/// A new desktop identity: self-signed certificate and its key, both PEM.
pub fn generate_identity() -> Result<(String, String)> {
    let key = rcgen::KeyPair::generate().map_err(|e| Error::Protocol(format!("key: {e}")))?;
    let mut params = rcgen::CertificateParams::new(vec!["freeflect.local".into()]).map_err(|e| Error::Protocol(format!("cert: {e}")))?;
    params.distinguished_name.push(rcgen::DnType::CommonName, "FreeFlect");
    // Phones check the pinned fingerprint, not the dates.
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2124, 1, 1);
    let cert = params.self_signed(&key).map_err(|e| Error::Protocol(format!("cert: {e}")))?;
    Ok((cert.pem(), key.serialize_pem()))
}

impl Server {
    /// Starts listening and advertising with the identity from
    /// `generate_identity`. `paired` are phones paired earlier; received files
    /// go to `downloads`.
    pub async fn start(
        desktop_name: &str,
        cert_pem: &str,
        key_pem: &str,
        paired: Vec<PairedDevice>,
        downloads: PathBuf,
        events: mpsc::UnboundedSender<Event>,
    ) -> Result<Self> {
        let (acceptor, fingerprint) = tls_acceptor(cert_pem, key_pem)?;
        let listener = TcpListener::bind("0.0.0.0:0").await?;
        let port = listener.local_addr()?.port();
        let fp_hex = hex(&fingerprint);

        // The advertised name says nothing about the computer or its owner;
        // the phone matches it against the fingerprint it pinned.
        let instance = format!("FreeFlect-{}", &fp_hex[..12]);
        let mdns = mdns_sd::ServiceDaemon::new().map_err(|e| Error::Protocol(format!("mdns: {e}")))?;
        let host = format!("{}.local.", instance.to_ascii_lowercase());
        let info = mdns_sd::ServiceInfo::new(SERVICE_TYPE, &instance, &host, "", port, &[("v", "2")][..])
            .map_err(|e| Error::Protocol(format!("mdns: {e}")))?
            .enable_addr_auto();
        let service = info.get_fullname().to_string();
        mdns.register(info).map_err(|e| Error::Protocol(format!("mdns: {e}")))?;

        let mut shared = Shared { downloads, ..Default::default() };
        for p in paired {
            if let Some(hash) = unhex::<32>(&p.secret_hash) {
                shared.paired.insert(p.device_id, hash);
            }
        }
        let ctx = Arc::new(Context { shared: Mutex::new(shared), events, desktop_name: desktop_name.into(), fingerprint });
        let accepting = ctx.clone();
        let pending = Arc::new(Semaphore::new(MAX_PENDING));
        let accept = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                // Under a flood of handshakes, new ones are refused rather than queued.
                let Ok(permit) = pending.clone().try_acquire_owned() else { continue };
                let (ctx, acceptor) = (accepting.clone(), acceptor.clone());
                tokio::spawn(async move {
                    if let Err(e) = handle(stream, acceptor, ctx, permit).await {
                        eprintln!("[companion] connection ended: {e}");
                    }
                });
            }
        });
        Ok(Self {
            ctx,
            port,
            fingerprint: fp_hex,
            mdns: Arc::new(mdns),
            service,
            accept: Arc::new(accept),
            runtime: tokio::runtime::Handle::current(),
        })
    }

    /// Opens the pairing window for two minutes (or until a phone pairs).
    pub fn begin_pairing(&self) -> Result<PairingInfo> {
        let token: [u8; 16] = random()?;
        let code = new_code()?;
        let id = {
            let mut shared = self.ctx.shared.lock().unwrap();
            let id = shared.next_id();
            shared.pairing = Some(Pairing { id, token, code: code.clone(), failures: 0 });
            id
        };
        let ctx = self.ctx.clone();
        self.runtime.spawn(async move {
            tokio::time::sleep(PAIRING_WINDOW).await;
            close_pairing(&ctx, Some(id), "expired");
        });
        let qr = format!(
            "freeflect://pair?v={PROTOCOL_VERSION}&fp={}&t={}&n={}",
            hex(&self.ctx.fingerprint),
            hex(&token),
            percent_encode(&self.ctx.desktop_name)
        );
        Ok(PairingInfo { qr, code: format!("{}-{}", &code[..4], &code[4..]), expires_in_secs: PAIRING_WINDOW.as_secs() as u32 })
    }

    /// Closes the pairing window early (the user closed it).
    pub fn end_pairing(&self) {
        self.ctx.shared.lock().unwrap().pairing = None;
    }

    /// Received files go here from now on.
    pub fn set_downloads(&self, dir: PathBuf) {
        self.ctx.shared.lock().unwrap().downloads = dir;
    }

    /// Unpairs the phone and drops its open connections.
    pub fn forget(&self, device_id: &str) {
        let mut shared = self.ctx.shared.lock().unwrap();
        shared.paired.remove(device_id);
        for link in [shared.video.remove(device_id), shared.control.remove(device_id)].into_iter().flatten() {
            link.abort.abort();
        }
    }

    /// Stops advertising and accepting, and closes every connection.
    pub fn shutdown(&self) {
        self.accept.abort();
        let _ = self.mdns.unregister(&self.service);
        let _ = self.mdns.shutdown();
        let mut guard = self.ctx.shared.lock().unwrap();
        let shared = &mut *guard;
        shared.pairing = None;
        let links: Vec<Link> = shared.video.drain().chain(shared.control.drain()).map(|(_, l)| l).collect();
        for link in links {
            link.abort.abort();
        }
    }

    /// Asks the phone's broadcast for a keyframe (a new window needs one).
    pub async fn request_keyframe(&self, device_id: &str) {
        send_command(&self.ctx, device_id, b"k\n").await;
    }

    /// Whether the phone sends its sound here. Off by default: the sound
    /// stays on the phone. Remembered for its next broadcast too.
    pub async fn set_sound(&self, device_id: &str, on: bool) {
        {
            let mut shared = self.ctx.shared.lock().unwrap();
            if on {
                shared.sound.insert(device_id.to_string());
            } else {
                shared.sound.remove(device_id);
            }
        }
        send_command(&self.ctx, device_id, if on { b"a\n" } else { b"m\n" }).await;
    }

    pub async fn send_clipboard(&self, device_id: &str, text: String) -> Result<()> {
        let w = self.control_writer(device_id)?;
        let mut w = w.lock().await;
        write_frame(&mut *w, &ControlFrame::Clipboard { text }).await
    }

    /// Sends a file into the companion app's documents (visible in Files).
    pub async fn send_file(&self, device_id: &str, path: &std::path::Path) -> Result<()> {
        let w = self.control_writer(device_id)?;
        let mut file = tokio::fs::File::open(path).await?;
        let size = file.metadata().await?.len();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let mut w = w.lock().await;
        write_frame(&mut *w, &ControlFrame::File { name, size }).await?;
        tokio::io::copy(&mut file, &mut *w).await?;
        w.flush().await?;
        Ok(())
    }

    fn control_writer(&self, device_id: &str) -> Result<Writer> {
        self.ctx
            .shared
            .lock()
            .unwrap()
            .control
            .get(device_id)
            .map(|l| l.writer.clone())
            .ok_or_else(|| Error::Protocol("Open the FreeFlect app on the iPhone first.".into()))
    }
}

/// One-line command to a phone's broadcast ("k", "a" or "m"), if it is connected.
async fn send_command(ctx: &Context, device_id: &str, command: &[u8]) {
    let writer = ctx.shared.lock().unwrap().video.get(device_id).map(|l| l.writer.clone());
    if let Some(w) = writer {
        let mut w = w.lock().await;
        let _ = w.write_all(command).await;
        let _ = w.flush().await;
    }
}

fn tls_acceptor(cert_pem: &str, key_pem: &str) -> Result<(TlsAcceptor, [u8; 32])> {
    use rustls_pki_types::pem::PemObject;
    use rustls_pki_types::{CertificateDer, PrivateKeyDer};
    let bad = |e: rustls_pki_types::pem::Error| Error::Protocol(format!("identity: {e}"));
    let cert = CertificateDer::from_pem_slice(cert_pem.as_bytes()).map_err(bad)?;
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).map_err(bad)?;
    let fingerprint = sha256(&cert);
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .and_then(|b| b.with_no_client_auth().with_single_cert(vec![cert], key))
        .map_err(|e| Error::Protocol(format!("tls: {e}")))?;
    Ok((TlsAcceptor::from(Arc::new(config)), fingerprint))
}

/// Ends the pairing window if it is still the one with `id` (any, for None).
fn close_pairing(ctx: &Context, id: Option<u64>, reason: &'static str) {
    let mut shared = ctx.shared.lock().unwrap();
    if shared.pairing.as_ref().is_some_and(|p| id.is_none_or(|id| p.id == id)) {
        shared.pairing = None;
        let _ = ctx.events.send(Event::PairingClosed { reason });
    }
}

/// Counts a wrong token or code; too many close the window.
fn pairing_failed(ctx: &Context) {
    let mut shared = ctx.shared.lock().unwrap();
    let Some(p) = shared.pairing.as_mut() else { return };
    p.failures += 1;
    if p.failures >= MAX_PAIRING_FAILURES {
        shared.pairing = None;
        let _ = ctx.events.send(Event::PairingClosed { reason: "attempts" });
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, frame: &ControlFrame) -> Result<()> {
    let json = serde_json::to_vec(frame).map_err(|e| Error::Protocol(e.to_string()))?;
    w.write_all(&(json.len() as u32).to_be_bytes()).await?;
    w.write_all(&json).await?;
    w.flush().await?;
    Ok(())
}

async fn send_json<W: AsyncWrite + Unpin>(w: &mut W, value: serde_json::Value) -> Result<()> {
    let mut line = value.to_string();
    line.push('\n');
    w.write_all(line.as_bytes()).await?;
    w.flush().await?;
    Ok(())
}

async fn refuse<W: AsyncWrite + Unpin>(w: &mut W, reason: &str) -> Result<()> {
    send_json(w, serde_json::json!({ "ok": false, "reason": reason })).await
}

/// One JSON line, at most `MAX_LINE_BYTES`.
async fn read_json<R: AsyncBufReadExt + Unpin, T: serde::de::DeserializeOwned>(reader: &mut R) -> Result<T> {
    let mut line = String::new();
    reader.take(MAX_LINE_BYTES).read_line(&mut line).await?;
    if !line.ends_with('\n') {
        return Err(Error::Protocol("handshake line too long or cut off".into()));
    }
    serde_json::from_str(line.trim()).map_err(|e| Error::Protocol(format!("bad handshake: {e}")))
}

fn valid_device_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

async fn handle(stream: TcpStream, acceptor: TlsAcceptor, ctx: Arc<Context>, permit: tokio::sync::OwnedSemaphorePermit) -> Result<()> {
    stream.set_nodelay(true)?;
    // Apps from before pairing speak plain JSON: tell them to update.
    let mut first = [0u8; 1];
    if tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.peek(&mut first)).await.map_err(|_| timed_out())?? == 1 && first[0] == b'{' {
        let mut stream = stream;
        return refuse(&mut stream, "Update the FreeFlect app on this iPhone, then pair it again.").await;
    }
    let tls = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await.map_err(|_| timed_out())??;
    let (read, mut write) = tokio::io::split(tls);
    let mut reader = BufReader::new(read);
    let hello: Hello = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_json(&mut reader)).await.map_err(|_| timed_out())??;
    if hello.v != PROTOCOL_VERSION {
        return refuse(&mut write, "Update the FreeFlect app on this iPhone.").await;
    }
    if !valid_device_id(&hello.device_id) {
        return refuse(&mut write, "Bad device id").await;
    }
    let name: String = hello.name.chars().filter(|c| !c.is_control()).take(100).collect();

    match hello.role.as_str() {
        "pair" => return pair_with_token(&ctx, &mut write, &hello, &name).await,
        "pair-code" => {
            return tokio::time::timeout(PAIR_CODE_TIMEOUT, pair_with_code(&ctx, &mut reader, &mut write, &hello, &name))
                .await
                .map_err(|_| timed_out())?;
        }
        "video" | "control" => {}
        other => return Err(Error::Protocol(format!("unknown role {other}"))),
    }

    let known = ctx.shared.lock().unwrap().paired.get(&hello.device_id).copied();
    let presented = unhex::<32>(&hello.secret).map(|s| sha256(&s));
    let allowed = matches!((known, presented), (Some(k), Some(p)) if bool::from(k.ct_eq(&p)));
    if !allowed {
        // `paired: false` lets the phone drop its stale pairing (only this
        // computer, behind the pinned certificate, can tell it that).
        let reason = "This iPhone isn't paired with the computer any more. Pair it again in FreeFlect's settings.";
        return send_json(&mut write, serde_json::json!({ "ok": false, "paired": false, "reason": reason })).await;
    }
    send_json(&mut write, serde_json::json!({ "ok": true, "name": ctx.desktop_name })).await?;
    drop(permit);
    serve(ctx, hello.device_id, name, hello.role == "video", reader, write).await
}

fn timed_out() -> Error {
    Error::Protocol("handshake timed out".into())
}

/// Runs an authenticated connection until it ends or a newer one from the
/// same phone, in the same role, replaces it.
async fn serve(ctx: Arc<Context>, id: String, name: String, video: bool, reader: BufReader<ReadHalf<Tls>>, write: WriteHalf<Tls>) -> Result<()> {
    let writer = Arc::new(tokio::sync::Mutex::new(write));
    let work = {
        let (ctx, id, name) = (ctx.clone(), id.clone(), name.clone());
        async move {
            if video { stream_screen(&ctx, &id, reader).await } else { read_control(&ctx, &id, &name, reader).await }
        }
    };
    let task = tokio::spawn(work);
    let link_id = {
        let mut shared = ctx.shared.lock().unwrap();
        // Forgotten while its handshake was finishing.
        if !shared.paired.contains_key(&id) {
            task.abort();
            return Ok(());
        }
        let link_id = shared.next_id();
        let links = if video { &mut shared.video } else { &mut shared.control };
        if let Some(old) = links.insert(id.clone(), Link { id: link_id, writer, abort: task.abort_handle() }) {
            old.abort.abort();
        }
        link_id
    };
    // A new broadcast starts silent; ask for the sound if it is wanted here.
    let sound = video && ctx.shared.lock().unwrap().sound.contains(&id);
    if sound {
        send_command(&ctx, &id, b"a\n").await;
    }
    let _ = ctx.events.send(if video {
        Event::ScreenStarted { device_id: id.clone(), name }
    } else {
        Event::ControlConnected { device_id: id.clone(), name }
    });

    let result = task.await;
    let current = {
        let mut shared = ctx.shared.lock().unwrap();
        let links = if video { &mut shared.video } else { &mut shared.control };
        let current = links.get(&id).is_some_and(|l| l.id == link_id);
        if current {
            links.remove(&id);
        }
        current
    };
    // A replaced connection's successor is already live: say nothing.
    if current {
        let _ = ctx.events.send(if video { Event::ScreenStopped { device_id: id } } else { Event::ControlDisconnected { device_id: id } });
    }
    match result {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Ok(()),
        Err(e) => Err(Error::Protocol(format!("connection task failed: {e}"))),
    }
}

async fn pair_with_token<W: AsyncWrite + Unpin>(ctx: &Context, write: &mut W, hello: &Hello, name: &str) -> Result<()> {
    let ok = {
        let shared = ctx.shared.lock().unwrap();
        match (&shared.pairing, unhex::<16>(&hello.token)) {
            (Some(p), Some(t)) => bool::from(p.token.ct_eq(&t)),
            _ => false,
        }
    };
    if !ok {
        pairing_failed(ctx);
        return refuse(write, "The QR code has expired. Show a new one on the computer.").await;
    }
    finish_pairing(ctx, write, hello, name, None).await
}

/// Typed-code pairing. Both sides derive a key from the code, the
/// certificate fingerprint each of them sees and two fresh nonces, then prove
/// they have it. A man in the middle presents another certificate, so its
/// keys differ and both proofs fail; a recorded exchange can only be attacked
/// by guessing codes at `PBKDF2_ITERATIONS` per guess, and the code is dead
/// within two minutes.
///
///   phone → {"v":2,"role":"pair-code","deviceId","name","nonce":<16 bytes hex>}
///   desk  → {"nonce":<16 bytes hex>}
///   phone → {"proof": HMAC(key, "phone")}
///   desk  → {"ok":true,"proof":HMAC(key, "desktop"),"secret","name"}
async fn pair_with_code<R, W>(ctx: &Context, reader: &mut R, write: &mut W, hello: &Hello, name: &str) -> Result<()>
where
    R: AsyncBufReadExt + Unpin,
    W: AsyncWrite + Unpin,
{
    let code = ctx.shared.lock().unwrap().pairing.as_ref().map(|p| p.code.clone());
    let Some(code) = code else {
        return refuse(write, "Pairing isn't open on the computer. Choose Pair iPhone there first.").await;
    };
    let Some(phone_nonce) = unhex::<16>(&hello.nonce) else { return refuse(write, "Bad pairing request").await };
    let desktop_nonce: [u8; 16] = random()?;
    send_json(write, serde_json::json!({ "nonce": hex(&desktop_nonce) })).await?;

    #[derive(Deserialize)]
    struct Proof {
        proof: String,
    }
    let proof: Proof = read_json(reader).await?;
    let fingerprint = ctx.fingerprint;
    let key = tokio::task::spawn_blocking(move || pairing_key(&code, &fingerprint, &phone_nonce, &desktop_nonce))
        .await
        .map_err(|e| Error::Protocol(e.to_string()))?;
    let ok = unhex::<32>(&proof.proof).is_some_and(|p| hmac::verify(&key, b"phone", &p).is_ok());
    if !ok {
        pairing_failed(ctx);
        return refuse(write, "That code doesn't match. Check the code on the computer and try again.").await;
    }
    let desktop_proof = hex(hmac::sign(&key, b"desktop").as_ref());
    finish_pairing(ctx, write, hello, name, Some(desktop_proof)).await
}

async fn finish_pairing<W: AsyncWrite + Unpin>(ctx: &Context, write: &mut W, hello: &Hello, name: &str, proof: Option<String>) -> Result<()> {
    let secret: [u8; 32] = random()?;
    let hash = sha256(&secret);
    let open = {
        let mut shared = ctx.shared.lock().unwrap();
        // The window may have closed while the phone was answering.
        let open = shared.pairing.take().is_some();
        if open {
            shared.paired.insert(hello.device_id.clone(), hash);
        }
        open
    };
    if !open {
        return refuse(write, "Pairing closed on the computer. Try again.").await;
    }
    let mut reply = serde_json::json!({ "ok": true, "secret": hex(&secret), "name": ctx.desktop_name });
    if let Some(proof) = proof {
        reply["proof"] = proof.into();
    }
    send_json(write, reply).await?;
    let _ = ctx.events.send(Event::Paired { device_id: hello.device_id.clone(), name: name.into(), secret_hash: hex(&hash) });
    let _ = ctx.events.send(Event::PairingClosed { reason: "paired" });
    Ok(())
}

/// The key both sides derive in typed-code pairing (see `pair_with_code`).
pub fn pairing_key(code: &str, fingerprint: &[u8; 32], phone_nonce: &[u8; 16], desktop_nonce: &[u8; 16]) -> hmac::Key {
    let salt = [b"freeflect-pair-v2".as_slice(), fingerprint, phone_nonce, desktop_nonce].concat();
    let mut key = [0u8; 32];
    let iterations = NonZeroU32::new(PBKDF2_ITERATIONS).expect("non-zero");
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, iterations, &salt, normalize_code(code).as_bytes(), &mut key);
    hmac::Key::new(hmac::HMAC_SHA256, &key)
}

/// Upper case without separators; letters people confuse with digits count as them.
pub fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect()
}

fn new_code() -> Result<String> {
    let bytes: [u8; CODE_LEN] = random()?;
    // 256 is a multiple of 32, so every character is equally likely.
    Ok(bytes.iter().map(|b| CODE_ALPHABET[(b % 32) as usize] as char).collect())
}

async fn stream_screen<R: AsyncRead + Unpin>(ctx: &Context, id: &str, reader: R) -> Result<()> {
    let (tx, mut rx) = mpsc::channel(16);
    let (audio_tx, mut audio_rx) = mpsc::channel(64);
    let read = mirror_android::server::read_video_and_audio(reader, tx, Some(audio_tx));
    let video = async {
        while let Some(packet) = rx.recv().await {
            let _ = ctx.events.send(Event::Video { device_id: id.into(), packet });
        }
    };
    let audio = async {
        while let Some(packet) = audio_rx.recv().await {
            let _ = ctx.events.send(Event::Audio { device_id: id.into(), packet });
        }
    };
    let (result, (), ()) = tokio::join!(read, video, audio);
    result
}

async fn read_control<R: AsyncRead + Unpin>(ctx: &Context, id: &str, name: &str, mut reader: R) -> Result<()> {
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
                let _ = ctx.events.send(Event::Clipboard { device_id: id.into(), name: name.into(), text });
            }
            ControlFrame::File { name: file_name, size } => {
                if size > MAX_FILE_BYTES {
                    return Err(Error::Protocol("file too large".into()));
                }
                let downloads = ctx.shared.lock().unwrap().downloads.clone();
                tokio::fs::create_dir_all(&downloads).await?;
                if free_bytes(&downloads).is_some_and(|free| free < size.saturating_add(MIN_FREE_BYTES)) {
                    return Err(Error::Protocol("not enough free disk space for a received file".into()));
                }
                let path = unique_path(&downloads, &sanitize(&file_name));
                let mut file = tokio::fs::File::create(&path).await?;
                let mut limited = (&mut reader).take(size);
                tokio::io::copy(&mut limited, &mut file).await?;
                file.flush().await?;
                quarantine(&path);
                let _ = ctx.events.send(Event::FileReceived { device_id: id.into(), name: file_name, path });
            }
        }
    }
}

/// Marks a received file as downloaded, so macOS asks before opening it if it
/// is a script or an app (Gatekeeper), the same as for a browser download.
#[cfg(target_os = "macos")]
fn quarantine(path: &std::path::Path) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return };
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    // flags 0081: downloaded, not yet approved by the user.
    let value = format!("0081;{secs:08x};FreeFlect;");
    // SAFETY: both strings are NUL-terminated and outlive the call.
    let rc = unsafe {
        libc::setxattr(c_path.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_ptr().cast(), value.len(), 0, 0)
    };
    if rc != 0 {
        eprintln!("[companion] could not quarantine {}: {}", path.display(), std::io::Error::last_os_error());
    }
}

#[cfg(not(target_os = "macos"))]
fn quarantine(_path: &std::path::Path) {}

/// Free space available to us on the disk holding `dir`.
#[cfg(unix)]
fn free_bytes(dir: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `stat` is a valid out-pointer and `c_path` is NUL-terminated.
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(not(unix))]
fn free_bytes(_dir: &std::path::Path) -> Option<u64> {
    None
}

/// File names from the phone: keep the name, drop any path parts.
fn sanitize(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim_start_matches('.');
    let base: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    if base.is_empty() { "file".into() } else { base }
}

fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = name.rsplit_once('.').map_or((name, String::new()), |(s, e)| (s, format!(".{e}")));
    (2..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).expect("unbounded")
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    SystemRandom::new().fill(&mut bytes).map_err(|_| Error::Protocol("no system randomness".into()))?;
    Ok(bytes)
}

fn sha256(data: &[u8]) -> [u8; 32] {
    digest::digest(&digest::SHA256, data).as_ref().try_into().expect("32 bytes")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[cfg(test)]
mod tests;
