use super::*;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream as ClientTls;

const SECRET: [u8; 32] = [7; 32];

/// Accepts exactly the pinned certificate, like the iPhone app.
#[derive(Debug)]
struct Pinned([u8; 32]);

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(&self, cert: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if sha256(cert) == self.0 { Ok(ServerCertVerified::assertion()) } else { Err(rustls::Error::General("not the pinned computer".into())) }
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.3 only".into()))
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

struct Fixture {
    server: Server,
    events: mpsc::UnboundedReceiver<Event>,
    _dir: TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Withdraws the mDNS advert, which is real: tests advertise on the LAN.
        self.server.shutdown();
    }
}

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn start(paired: Vec<PairedDevice>) -> Fixture {
    let (cert, key) = generate_identity().unwrap();
    let dir = std::env::temp_dir().join(format!("freeflect-companion-test-{}", hex(&random::<8>().unwrap())));
    let (tx, events) = mpsc::unbounded_channel();
    let server = Server::start("Test Mac", &cert, &key, paired, dir.clone(), tx).await.unwrap();
    Fixture { server, events, _dir: TempDir(dir) }
}

fn paired_phone() -> Vec<PairedDevice> {
    vec![PairedDevice { device_id: "PHONE-1".into(), secret_hash: hex(&sha256(&SECRET)) }]
}

async fn connect(f: &Fixture) -> std::io::Result<BufReader<ClientTls<TcpStream>>> {
    let pin = unhex::<32>(&f.server.fingerprint).unwrap();
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned(pin)))
        .with_no_client_auth();
    let tcp = TcpStream::connect(("127.0.0.1", f.server.port)).await?;
    let tls = TlsConnector::from(Arc::new(config)).connect(ServerName::try_from("freeflect.local").unwrap(), tcp).await?;
    Ok(BufReader::new(tls))
}

async fn send(s: &mut BufReader<ClientTls<TcpStream>>, value: serde_json::Value) {
    let mut line = value.to_string();
    line.push('\n');
    s.get_mut().write_all(line.as_bytes()).await.unwrap();
    s.get_mut().flush().await.unwrap();
}

async fn recv(s: &mut BufReader<ClientTls<TcpStream>>) -> serde_json::Value {
    let mut line = String::new();
    s.read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap_or(serde_json::Value::Null)
}

async fn hello(f: &Fixture, role: &str, secret: &[u8]) -> (BufReader<ClientTls<TcpStream>>, serde_json::Value) {
    let mut s = connect(f).await.unwrap();
    send(&mut s, serde_json::json!({ "v": 2, "role": role, "deviceId": "PHONE-1", "name": "iPhone", "secret": hex(secret) })).await;
    let reply = recv(&mut s).await;
    (s, reply)
}

/// Waits for the next event that isn't media.
async fn next_event(f: &mut Fixture) -> Option<Event> {
    tokio::time::timeout(Duration::from_millis(500), f.events.recv()).await.ok().flatten()
}

#[tokio::test]
async fn paired_phone_with_its_secret_connects() {
    let mut f = start(paired_phone()).await;
    let (_s, reply) = hello(&f, "control", &SECRET).await;
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["name"], "Test Mac");
    assert!(matches!(next_event(&mut f).await, Some(Event::ControlConnected { .. })));
}

#[tokio::test]
async fn wrong_secret_is_refused_without_any_event() {
    let mut f = start(paired_phone()).await;
    let (_s, reply) = hello(&f, "video", &[8; 32]).await;
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["paired"], false);
    let (_s, reply) = hello(&f, "control", b"short").await;
    assert_eq!(reply["ok"], false);
    assert!(next_event(&mut f).await.is_none());
}

#[tokio::test]
async fn unknown_phone_is_refused_without_any_event() {
    let mut f = start(vec![]).await;
    let (_s, reply) = hello(&f, "control", &SECRET).await;
    assert_eq!(reply["ok"], false);
    assert!(next_event(&mut f).await.is_none());
}

#[tokio::test]
async fn oversized_hello_is_dropped() {
    let f = start(paired_phone()).await;
    let mut s = connect(&f).await.unwrap();
    s.get_mut().write_all(&[b'a'; 8192]).await.unwrap();
    s.get_mut().flush().await.unwrap();
    let mut rest = Vec::new();
    let _ = s.read_to_end(&mut rest).await;
    assert!(rest.is_empty());
}

#[tokio::test]
async fn silent_peer_is_dropped() {
    let f = start(paired_phone()).await;
    let mut tcp = TcpStream::connect(("127.0.0.1", f.server.port)).await.unwrap();
    let mut buf = [0u8; 1];
    let closed = tokio::time::timeout(HANDSHAKE_TIMEOUT * 3, tcp.read(&mut buf)).await;
    assert!(matches!(closed, Ok(Ok(0)) | Ok(Err(_))));
}

#[tokio::test]
async fn old_plaintext_app_is_told_to_update() {
    let f = start(paired_phone()).await;
    let mut tcp = BufReader::new(TcpStream::connect(("127.0.0.1", f.server.port)).await.unwrap());
    tcp.get_mut().write_all(b"{\"v\":1,\"role\":\"video\",\"deviceId\":\"PHONE-1\",\"name\":\"x\"}\n").await.unwrap();
    let mut line = String::new();
    tcp.read_line(&mut line).await.unwrap();
    let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(reply["ok"], false);
}

#[tokio::test]
async fn rogue_computer_fails_the_pin() {
    let real = start(paired_phone()).await;
    let rogue = start(vec![]).await;
    // A phone pinned to `real` must not complete TLS with `rogue`.
    let fake = Fixture { server: Server { port: rogue.server.port, ..real.server.clone() }, events: mpsc::unbounded_channel().1, _dir: TempDir(PathBuf::new()) };
    assert!(connect(&fake).await.is_err());
}

#[tokio::test]
async fn qr_token_pairs_once() {
    let mut f = start(vec![]).await;
    let info = f.server.begin_pairing().unwrap();
    let token = info.qr.split("t=").nth(1).unwrap().split('&').next().unwrap().to_string();
    assert!(info.qr.contains(&format!("fp={}", f.server.fingerprint)));

    let mut s = connect(&f).await.unwrap();
    send(&mut s, serde_json::json!({ "v": 2, "role": "pair", "deviceId": "PHONE-1", "name": "iPhone", "token": token })).await;
    let reply = recv(&mut s).await;
    assert_eq!(reply["ok"], true);
    let secret = unhex::<32>(reply["secret"].as_str().unwrap()).unwrap();
    match next_event(&mut f).await {
        Some(Event::Paired { device_id, secret_hash, .. }) => {
            assert_eq!(device_id, "PHONE-1");
            assert_eq!(secret_hash, hex(&sha256(&secret)));
        }
        other => panic!("expected Paired, got {other:?}"),
    }
    assert!(matches!(next_event(&mut f).await, Some(Event::PairingClosed { reason: "paired" })));

    // The same QR code again: refused.
    let mut s = connect(&f).await.unwrap();
    send(&mut s, serde_json::json!({ "v": 2, "role": "pair", "deviceId": "PHONE-2", "name": "x", "token": token })).await;
    assert_eq!(recv(&mut s).await["ok"], false);

    // The secret it got works for streaming.
    let (_s, reply) = hello(&f, "video", &secret).await;
    assert_eq!(reply["ok"], true);
}

#[tokio::test]
async fn pairing_can_start_outside_the_runtime() {
    let f = start(vec![]).await;
    let server = f.server.clone();
    // Node calls synchronous methods on its own thread, with no tokio context.
    let info = std::thread::spawn(move || server.begin_pairing().unwrap()).join().unwrap();
    assert_eq!(info.code.len(), 9);
}

#[tokio::test]
async fn token_without_open_window_is_refused() {
    let mut f = start(vec![]).await;
    let mut s = connect(&f).await.unwrap();
    send(&mut s, serde_json::json!({ "v": 2, "role": "pair", "deviceId": "PHONE-1", "name": "x", "token": hex(&[0u8; 16]) })).await;
    assert_eq!(recv(&mut s).await["ok"], false);
    assert!(next_event(&mut f).await.is_none());
}

/// Runs the phone's side of typed-code pairing.
async fn pair_code(f: &Fixture, code: &str) -> serde_json::Value {
    let mut s = connect(f).await.unwrap();
    let phone_nonce: [u8; 16] = random().unwrap();
    send(&mut s, serde_json::json!({ "v": 2, "role": "pair-code", "deviceId": "PHONE-1", "name": "iPhone", "nonce": hex(&phone_nonce) })).await;
    let reply = recv(&mut s).await;
    let Some(desktop_nonce) = reply["nonce"].as_str().and_then(unhex::<16>) else { return reply };
    let fp = unhex::<32>(&f.server.fingerprint).unwrap();
    let key = pairing_key(code, &fp, &phone_nonce, &desktop_nonce);
    send(&mut s, serde_json::json!({ "proof": hex(hmac::sign(&key, b"phone").as_ref()) })).await;
    let reply = recv(&mut s).await;
    if reply["ok"] == true {
        let proof = unhex::<32>(reply["proof"].as_str().unwrap()).unwrap();
        assert!(hmac::verify(&key, b"desktop", &proof).is_ok(), "desktop proof must check out");
    }
    reply
}

#[tokio::test]
async fn typed_code_pairs() {
    let mut f = start(vec![]).await;
    let info = f.server.begin_pairing().unwrap();
    // People type it lower case, with or without the dash.
    let reply = pair_code(&f, &info.code.to_lowercase().replace('-', "")).await;
    assert_eq!(reply["ok"], true);
    assert!(matches!(next_event(&mut f).await, Some(Event::Paired { .. })));
}

#[tokio::test]
async fn wrong_codes_close_the_window() {
    let mut f = start(vec![]).await;
    let info = f.server.begin_pairing().unwrap();
    let wrong = if info.code.starts_with('0') { "11111111" } else { "00000000" };
    for _ in 0..MAX_PAIRING_FAILURES {
        assert_eq!(pair_code(&f, wrong).await["ok"], false);
    }
    assert!(matches!(next_event(&mut f).await, Some(Event::PairingClosed { reason: "attempts" })));
    // Even the right code is useless now.
    assert_eq!(pair_code(&f, &info.code).await["ok"], false);
}

#[tokio::test]
async fn newer_connection_replaces_the_old_one_quietly() {
    let mut f = start(paired_phone()).await;
    let (mut first, reply) = hello(&f, "control", &SECRET).await;
    assert_eq!(reply["ok"], true);
    assert!(matches!(next_event(&mut f).await, Some(Event::ControlConnected { .. })));
    let (_second, reply) = hello(&f, "control", &SECRET).await;
    assert_eq!(reply["ok"], true);
    assert!(matches!(next_event(&mut f).await, Some(Event::ControlConnected { .. })));

    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(2), first.read_to_end(&mut rest)).await;
    assert!(closed.is_ok(), "the replaced connection is closed");
    // Its end is not reported: the phone is still connected.
    assert!(next_event(&mut f).await.is_none());
}

#[tokio::test]
async fn forget_drops_live_connections_and_the_secret() {
    let mut f = start(paired_phone()).await;
    let (mut s, reply) = hello(&f, "control", &SECRET).await;
    assert_eq!(reply["ok"], true);
    let _ = next_event(&mut f).await;
    f.server.forget("PHONE-1");
    let mut rest = Vec::new();
    assert!(tokio::time::timeout(Duration::from_secs(2), s.read_to_end(&mut rest)).await.is_ok());
    let (_s, reply) = hello(&f, "control", &SECRET).await;
    assert_eq!(reply["ok"], false);
}

#[tokio::test]
async fn received_files_are_quarantined() {
    let mut f = start(paired_phone()).await;
    let (mut s, _) = hello(&f, "control", &SECRET).await;
    let _ = next_event(&mut f).await;
    let frame = serde_json::to_vec(&ControlFrame::File { name: "../run.command".into(), size: 5 }).unwrap();
    s.get_mut().write_all(&(frame.len() as u32).to_be_bytes()).await.unwrap();
    s.get_mut().write_all(&frame).await.unwrap();
    s.get_mut().write_all(b"hello").await.unwrap();
    s.get_mut().flush().await.unwrap();
    let Some(Event::FileReceived { path, .. }) = next_event(&mut f).await else { panic!("no file") };
    assert_eq!(path.file_name().unwrap(), "run.command");
    assert_eq!(std::fs::read(&path).unwrap(), b"hello");
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("xattr").arg("-p").arg("com.apple.quarantine").arg(&path).output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).starts_with("0081;"));
    }
}

#[tokio::test]
async fn sound_stays_on_the_phone_until_asked() {
    let f = start(paired_phone()).await;
    // Wanted before the broadcast starts: asked for right after the handshake.
    f.server.set_sound("PHONE-1", true).await;
    let (mut s, reply) = hello(&f, "video", &SECRET).await;
    assert_eq!(reply["ok"], true);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(2), s.read_line(&mut line)).await.unwrap().unwrap();
    assert_eq!(line, "a\n");
    f.server.set_sound("PHONE-1", false).await;
    line.clear();
    tokio::time::timeout(Duration::from_secs(2), s.read_line(&mut line)).await.unwrap().unwrap();
    assert_eq!(line, "m\n");

    // Not wanted: a new broadcast gets no command at all.
    let (mut s, _) = hello(&f, "video", &SECRET).await;
    line.clear();
    assert!(tokio::time::timeout(Duration::from_millis(300), s.read_line(&mut line)).await.is_err());
}

#[test]
fn sanitizes_file_names() {
    assert_eq!(sanitize("../../etc/passwd"), "passwd");
    assert_eq!(sanitize("C:\\x\\photo.jpg"), "photo.jpg");
    assert_eq!(sanitize(".hidden"), "hidden");
    assert_eq!(sanitize(""), "file");
}

#[test]
fn normalizes_typed_codes() {
    assert_eq!(normalize_code("ab0o-il1z"), "AB00111Z");
    assert_eq!(normalize_code(" 7K3M 9QXT "), "7K3M9QXT");
}

#[test]
fn hex_round_trips() {
    let bytes: [u8; 16] = random().unwrap();
    assert_eq!(unhex::<16>(&hex(&bytes)), Some(bytes));
    assert_eq!(unhex::<16>("zz"), None);
    assert_eq!(unhex::<2>("é1é1"), None);
}

/// Fixed inputs; the iPhone app's `pairingKey` must give the same proofs.
#[test]
fn pairing_key_test_vector() {
    let key = pairing_key("ab12-cd3o", &[0x11; 32], &[0x22; 16], &[0x33; 16]);
    assert_eq!(hex(hmac::sign(&key, b"phone").as_ref()), PHONE_PROOF_VECTOR);
}

/// Checked against the Swift implementation (native/ios/MirrorCompanion/Shared/DesktopLink.swift).
const PHONE_PROOF_VECTOR: &str = "b4d556222f73310261116d1cae406f89a12fcf06e7a7eca4ac0e37ac056ced7d";
