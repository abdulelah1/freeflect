//! Minimal client for the ADB server's host protocol (TCP 127.0.0.1:5037).
//!
//! Requests are `<4 hex length><payload>`; replies start with `OKAY` or
//! `FAIL` followed by a hex-length-prefixed message. Device services are
//! reached by first switching the connection with `host:transport:<serial>`.

use std::net::SocketAddr;

use mirror_core::{DeviceId, DeviceInfo, Error, Platform, Result, Transport};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const DEFAULT_ADB_ADDR: &str = "127.0.0.1:5037";

/// Max payload of one sync `DATA` chunk.
const SYNC_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AdbState {
    Device,
    Unauthorized,
    Offline,
    Other,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdbDevice {
    pub serial: String,
    pub state: AdbState,
    pub model: Option<String>,
    pub product: Option<String>,
    pub transport: Transport,
}

impl AdbDevice {
    pub fn to_device_info(&self) -> DeviceInfo {
        DeviceInfo {
            id: DeviceId(self.serial.clone()),
            platform: Platform::Android,
            transport: self.transport,
            model: self.model.clone(),
            os_version: None,
        }
    }
}

/// One entry of a device directory listing (sync `LIST`).
#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub mtime: u64,
}

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

#[derive(Clone)]
pub struct AdbClient {
    addr: SocketAddr,
}

impl Default for AdbClient {
    fn default() -> Self {
        Self { addr: DEFAULT_ADB_ADDR.parse().expect("valid default address") }
    }
}

impl AdbClient {
    pub fn new(addr: SocketAddr) -> Self {
        Self { addr }
    }

    pub async fn devices(&self) -> Result<Vec<AdbDevice>> {
        let mut stream = self.connect().await?;
        request(&mut stream, "host:devices-l").await?;
        let body = read_hex_prefixed(&mut stream).await?;
        Ok(dedupe_devices(parse_devices_l(&body)))
    }

    /// Runs `cmd` on the device; the returned stream carries its stdout/stderr
    /// and closing it ends the command.
    pub async fn shell(&self, serial: &str, cmd: &str) -> Result<TcpStream> {
        self.device_service(serial, &format!("shell:{cmd}")).await
    }

    /// Runs `cmd` and collects its output.
    pub async fn shell_output(&self, serial: &str, cmd: &str) -> Result<String> {
        let mut stream = self.shell(serial, cmd).await?;
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// Writes `data` to `remote` on the device using the sync protocol.
    pub async fn push(&self, serial: &str, data: &[u8], remote: &str, mode: u32) -> Result<()> {
        self.push_reader(serial, data, data.len() as u64, remote, mode, |_, _| {}).await
    }

    /// Streams a local file to `remote`, reporting `(sent, total)` bytes.
    pub async fn push_file(
        &self,
        serial: &str,
        local: &std::path::Path,
        remote: &str,
        progress: impl FnMut(u64, u64),
    ) -> Result<()> {
        let file = tokio::fs::File::open(local).await?;
        let total = file.metadata().await?.len();
        self.push_reader(serial, file, total, remote, 0o644, progress).await
    }

    async fn push_reader<R: AsyncReadExt + Unpin>(
        &self,
        serial: &str,
        mut reader: R,
        total: u64,
        remote: &str,
        mode: u32,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<()> {
        let mut s = self.device_service(serial, "sync:").await?;
        let target = format!("{remote},{mode}");
        sync_header(&mut s, b"SEND", target.len()).await?;
        s.write_all(target.as_bytes()).await?;

        let mut buf = vec![0u8; SYNC_CHUNK];
        let mut sent = 0u64;
        loop {
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            sync_header(&mut s, b"DATA", n).await?;
            s.write_all(&buf[..n]).await?;
            sent += n as u64;
            progress(sent, total);
        }
        let mtime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as usize)
            .unwrap_or(0);
        sync_header(&mut s, b"DONE", mtime).await?;

        let mut status = [0u8; 8];
        s.read_exact(&mut status).await?;
        match &status[..4] {
            b"OKAY" => Ok(()),
            b"FAIL" => {
                let len = u32::from_le_bytes(status[4..].try_into().expect("4 bytes")) as usize;
                let mut msg = vec![0u8; len];
                s.read_exact(&mut msg).await?;
                Err(Error::Protocol(format!("adb push: {}", String::from_utf8_lossy(&msg))))
            }
            other => Err(Error::Protocol(format!("adb push: unexpected status {other:?}"))),
        }
    }

    /// Lists a device directory, without `.` and `..`, folders first.
    pub async fn list_dir(&self, serial: &str, path: &str) -> Result<Vec<DirEntry>> {
        let mut s = self.device_service(serial, "sync:").await?;
        sync_header(&mut s, b"LIST", path.len()).await?;
        s.write_all(path.as_bytes()).await?;
        let mut entries = Vec::new();
        loop {
            let mut head = [0u8; 4];
            s.read_exact(&mut head).await?;
            match &head {
                b"DENT" => {
                    let mode = s.read_u32_le().await?;
                    let size = s.read_u32_le().await?;
                    let mtime = s.read_u32_le().await?;
                    let len = s.read_u32_le().await? as usize;
                    let mut name = vec![0u8; len];
                    s.read_exact(&mut name).await?;
                    let name = String::from_utf8_lossy(&name).into_owned();
                    if name == "." || name == ".." {
                        continue;
                    }
                    // Symlinks (e.g. /sdcard) are usually folders; treat them as such.
                    let kind = mode & S_IFMT;
                    entries.push(DirEntry {
                        name,
                        is_dir: kind == S_IFDIR || kind == S_IFLNK,
                        size: size as u64,
                        mtime: mtime as u64,
                    });
                }
                b"DONE" => {
                    // DONE carries 16 bytes of zeros in the DENT layout.
                    let mut rest = [0u8; 16];
                    s.read_exact(&mut rest).await?;
                    break;
                }
                b"FAIL" => {
                    let len = s.read_u32_le().await? as usize;
                    let mut msg = vec![0u8; len];
                    s.read_exact(&mut msg).await?;
                    return Err(Error::Protocol(format!("list {path}: {}", String::from_utf8_lossy(&msg))));
                }
                other => return Err(Error::Protocol(format!("adb list: unexpected {other:?}"))),
            }
        }
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(entries)
    }

    /// Downloads `remote` to `local`, reporting `(received, total)` bytes
    /// (`total` comes from a stat first; 0 when unknown).
    pub async fn pull_file(
        &self,
        serial: &str,
        remote: &str,
        local: &std::path::Path,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<()> {
        let total = self.stat_size(serial, remote).await.unwrap_or(0);
        let mut s = self.device_service(serial, "sync:").await?;
        sync_header(&mut s, b"RECV", remote.len()).await?;
        s.write_all(remote.as_bytes()).await?;
        let mut file = tokio::fs::File::create(local).await?;
        let mut buf = vec![0u8; SYNC_CHUNK];
        let mut received = 0u64;
        loop {
            let mut head = [0u8; 8];
            s.read_exact(&mut head).await?;
            let len = u32::from_le_bytes(head[4..].try_into().expect("4 bytes")) as usize;
            match &head[..4] {
                b"DATA" => {
                    if len > buf.len() {
                        buf.resize(len, 0);
                    }
                    s.read_exact(&mut buf[..len]).await?;
                    file.write_all(&buf[..len]).await?;
                    received += len as u64;
                    progress(received, total);
                }
                b"DONE" => break,
                b"FAIL" => {
                    let mut msg = vec![0u8; len];
                    s.read_exact(&mut msg).await?;
                    drop(file);
                    let _ = tokio::fs::remove_file(local).await;
                    return Err(Error::Protocol(format!("pull {remote}: {}", String::from_utf8_lossy(&msg))));
                }
                other => return Err(Error::Protocol(format!("adb pull: unexpected {other:?}"))),
            }
        }
        file.flush().await?;
        progress(received, received);
        Ok(())
    }

    async fn stat_size(&self, serial: &str, remote: &str) -> Result<u64> {
        let mut s = self.device_service(serial, "sync:").await?;
        sync_header(&mut s, b"STAT", remote.len()).await?;
        s.write_all(remote.as_bytes()).await?;
        let mut head = [0u8; 4];
        s.read_exact(&mut head).await?;
        let _mode = s.read_u32_le().await?;
        let size = s.read_u32_le().await?;
        let _mtime = s.read_u32_le().await?;
        Ok(size as u64)
    }

    /// Pushes an APK and installs it with `pm install -r -t`.
    pub async fn install_apk(
        &self,
        serial: &str,
        local: &std::path::Path,
        progress: impl FnMut(u64, u64),
    ) -> Result<()> {
        let remote = format!("/data/local/tmp/mirror-install-{}.apk", std::process::id());
        self.push_file(serial, local, &remote, progress).await?;
        let output = self.shell_output(serial, &format!("pm install -r -t '{remote}'; rm -f '{remote}'")).await?;
        if output.contains("Success") {
            Ok(())
        } else {
            Err(Error::Protocol(format!("install failed: {}", output.trim())))
        }
    }

    /// `adb pair <host:port> <code>` (Android 11+ wireless debugging).
    pub async fn pair(&self, host_port: &str, code: &str) -> Result<String> {
        let reply = self.host_query(&format!("host:pair:{code}:{host_port}")).await?;
        if reply.to_lowercase().contains("success") {
            Ok(reply)
        } else {
            Err(Error::Protocol(format!("pairing failed: {reply}")))
        }
    }

    /// `adb connect <host:port>`.
    pub async fn connect_device(&self, host_port: &str) -> Result<String> {
        let reply = self.host_query(&format!("host:connect:{host_port}")).await?;
        if reply.starts_with("connected to") || reply.starts_with("already connected") {
            Ok(reply)
        } else {
            Err(Error::Protocol(reply))
        }
    }

    /// Services the ADB server sees over mDNS: `(instance, service type, host:port)`.
    pub async fn mdns_services(&self) -> Result<Vec<(String, String, String)>> {
        let body = self.host_query("host:mdns:services").await?;
        Ok(body
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\t');
                Some((p.next()?.to_string(), p.next()?.trim_end_matches('.').to_string(), p.next()?.to_string()))
            })
            .collect())
    }

    /// Restarts adbd on the device listening on TCP `port` (USB → Wi-Fi switch).
    pub async fn tcpip(&self, serial: &str, port: u16) -> Result<()> {
        let mut s = self.device_service(serial, &format!("tcpip:{port}")).await?;
        let mut reply = String::new();
        s.read_to_string(&mut reply).await?;
        if reply.contains("restarting") {
            Ok(())
        } else {
            Err(Error::Protocol(format!("tcpip: {}", reply.trim())))
        }
    }

    /// Restarts adbd in USB mode, closing the plaintext port `tcpip` opened.
    pub async fn usb(&self, serial: &str) -> Result<()> {
        let mut s = self.device_service(serial, "usb:").await?;
        let mut reply = String::new();
        s.read_to_string(&mut reply).await?;
        if reply.contains("restarting") {
            Ok(())
        } else {
            Err(Error::Protocol(format!("usb: {}", reply.trim())))
        }
    }

    /// IPv4 address of the device's Wi-Fi interface, if connected.
    pub async fn wifi_ip(&self, serial: &str) -> Result<Option<String>> {
        let out = self.shell_output(serial, "ip -o -4 addr show wlan0").await?;
        Ok(parse_inet(&out))
    }

    async fn host_query(&self, service: &str) -> Result<String> {
        let mut s = self.connect().await?;
        request(&mut s, service).await?;
        read_hex_prefixed(&mut s).await
    }

    /// `adb forward tcp:0 <remote>`; returns the local port the server picked.
    pub async fn forward_any_port(&self, serial: &str, remote: &str) -> Result<u16> {
        let mut s = self.connect().await?;
        request(&mut s, &format!("host-serial:{serial}:forward:tcp:0;{remote}")).await?;
        // Newer servers send a second OKAY once the listener is installed,
        // then the resolved port as a hex-length-prefixed string.
        let mut next = [0u8; 4];
        s.read_exact(&mut next).await?;
        let port = if &next == b"OKAY" {
            read_hex_prefixed(&mut s).await?
        } else {
            let len = parse_hex_len(&next)?;
            let mut body = vec![0u8; len];
            s.read_exact(&mut body).await?;
            String::from_utf8_lossy(&body).into_owned()
        };
        port.trim().parse().map_err(|_| Error::Protocol(format!("adb forward: bad port {port:?}")))
    }

    pub async fn remove_forward(&self, serial: &str, port: u16) -> Result<()> {
        let mut s = self.connect().await?;
        request(&mut s, &format!("host-serial:{serial}:killforward:tcp:{port}")).await
    }

    async fn connect(&self) -> Result<TcpStream> {
        Ok(TcpStream::connect(self.addr).await?)
    }

    async fn device_service(&self, serial: &str, service: &str) -> Result<TcpStream> {
        let mut s = self.connect().await?;
        request(&mut s, &format!("host:transport:{serial}")).await.map_err(|e| match e {
            Error::Protocol(msg) if msg.contains("unauthorized") => Error::Unauthorized,
            Error::Protocol(msg) if msg.contains("not found") => Error::DeviceNotFound(serial.into()),
            other => other,
        })?;
        request(&mut s, service).await?;
        Ok(s)
    }
}

async fn request(stream: &mut TcpStream, service: &str) -> Result<()> {
    stream.write_all(format!("{:04x}{service}", service.len()).as_bytes()).await?;
    let mut status = [0u8; 4];
    stream.read_exact(&mut status).await?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => {
            let msg = read_hex_prefixed(stream).await?;
            Err(Error::Protocol(format!("adb: {msg}")))
        }
        other => Err(Error::Protocol(format!("adb: unexpected status {other:?}"))),
    }
}

async fn sync_header(stream: &mut TcpStream, id: &[u8; 4], arg: usize) -> Result<()> {
    let mut header = [0u8; 8];
    header[..4].copy_from_slice(id);
    header[4..].copy_from_slice(&(arg as u32).to_le_bytes());
    stream.write_all(&header).await?;
    Ok(())
}

fn parse_hex_len(bytes: &[u8; 4]) -> Result<usize> {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| usize::from_str_radix(s, 16).ok())
        .ok_or_else(|| Error::Protocol("adb: bad length prefix".into()))
}

async fn read_hex_prefixed(stream: &mut TcpStream) -> Result<String> {
    let mut len_hex = [0u8; 4];
    stream.read_exact(&mut len_hex).await?;
    let mut body = vec![0u8; parse_hex_len(&len_hex)?];
    stream.read_exact(&mut body).await?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Extracts the address from `ip -o -4 addr show` output
/// (`30: wlan0    inet 192.168.1.23/24 brd ... `).
fn parse_inet(out: &str) -> Option<String> {
    let mut words = out.split_whitespace();
    words.find(|w| *w == "inet")?;
    Some(words.next()?.split('/').next()?.to_string())
}

/// adb can list one phone several times (USB, `ip:port`, and the mDNS
/// `adb-<serial>-<id>._adb-tls-connect._tcp` name). Keep one entry per phone,
/// preferring USB, then `ip:port`, using model+product as the identity.
pub fn dedupe_devices(devices: Vec<AdbDevice>) -> Vec<AdbDevice> {
    fn rank(d: &AdbDevice) -> u8 {
        match (d.transport, d.serial.contains("._adb-tls-connect.")) {
            (Transport::Usb, _) => 0,
            (Transport::Wifi, false) => 1,
            (Transport::Wifi, true) => 2,
        }
    }
    let mut kept: Vec<AdbDevice> = Vec::with_capacity(devices.len());
    for d in devices {
        // Only authorized devices report model/product, so others never merge.
        let same = |k: &AdbDevice| {
            d.state == AdbState::Device && k.state == AdbState::Device && d.model.is_some() && k.model == d.model && k.product == d.product
        };
        match kept.iter().position(same) {
            Some(i) if rank(&d) < rank(&kept[i]) => kept[i] = d,
            Some(_) => {}
            None => kept.push(d),
        }
    }
    kept
}

/// Parses `host:devices-l` output, e.g.
/// `R5CT123  device usb:1-1 product:o1sxx model:SM_G991B device:o1s transport_id:2`.
pub fn parse_devices_l(body: &str) -> Vec<AdbDevice> {
    body.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = match parts.next()? {
                "device" => AdbState::Device,
                "unauthorized" => AdbState::Unauthorized,
                "offline" => AdbState::Offline,
                _ => AdbState::Other,
            };
            let (mut model, mut product) = (None, None);
            for kv in parts {
                match kv.split_once(':') {
                    Some(("model", v)) => model = Some(v.replace('_', " ")),
                    Some(("product", v)) => product = Some(v.to_string()),
                    _ => {}
                }
            }
            // `ip:port` for `adb connect`, `adb-<id>._adb-tls-connect._tcp` for
            // Android 11+ wireless debugging discovered over mDNS.
            let transport = if serial.contains(':') || serial.contains("._adb-tls-connect.") {
                Transport::Wifi
            } else {
                Transport::Usb
            };
            Some(AdbDevice { serial, state, model, product, transport })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupes_one_phone_listed_twice_over_wifi() {
        let body = "10.0.0.7:41234 device product:a35xjvxx model:SM_A356E device:a35x transport_id:34\n\
                    adb-R5XA00TEST-AbCdEf._adb-tls-connect._tcp device product:a35xjvxx model:SM_A356E device:a35x transport_id:2\n\
                    R5CT123 device usb:1-1 product:o1sxx model:SM_G991B device:o1s transport_id:5\n";
        let devices = dedupe_devices(parse_devices_l(body));
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "10.0.0.7:41234");
        assert_eq!(devices[1].serial, "R5CT123");
    }

    #[test]
    fn parses_wifi_ip() {
        let out = "30: wlan0    inet 192.168.1.23/24 brd 192.168.1.255 scope global wlan0\\       valid_lft forever";
        assert_eq!(parse_inet(out).as_deref(), Some("192.168.1.23"));
        assert_eq!(parse_inet(""), None);
    }

    #[test]
    fn parses_usb_wifi_and_unauthorized_devices() {
        let body = "R5CT123          device usb:1-1 product:o1sxx model:SM_G991B device:o1s transport_id:2\n\
                    192.168.1.20:5555 device product:panther model:Pixel_7 device:panther transport_id:3\n\
                    adb-2A1B-xyz._adb-tls-connect._tcp device product:husky model:Pixel_8_Pro transport_id:4\n\
                    0123456789ABCDEF unauthorized usb:1-2 transport_id:5\n";
        let devices = parse_devices_l(body);
        assert_eq!(devices.len(), 4);
        assert_eq!(devices[0].model.as_deref(), Some("SM G991B"));
        assert_eq!(devices[0].transport, Transport::Usb);
        assert_eq!(devices[1].transport, Transport::Wifi);
        assert_eq!(devices[2].transport, Transport::Wifi);
        assert_eq!(devices[3].state, AdbState::Unauthorized);
        assert_eq!(devices[3].model, None);
    }
}
