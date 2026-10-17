//! AFC (Apple File Conduit): file access to an iPhone's media area
//! (/var/mobile/Media: DCIM camera roll, and more). Packets have a 40-byte
//! little-endian header: magic, total length, header+data length, packet
//! number, operation; then operation data, then payload.

use mirror_core::{Error, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::{lockdown, usbmux};

const MAGIC: &[u8; 8] = b"CFA6LPAA";
const OP_STATUS: u64 = 1;
const OP_DATA: u64 = 2;
const OP_READ_DIR: u64 = 3;
const OP_GET_FILE_INFO: u64 = 10;
const OP_FILE_OPEN: u64 = 13;
const OP_FILE_OPEN_RESULT: u64 = 14;
const OP_FILE_READ: u64 = 15;
const OP_FILE_CLOSE: u64 = 20;
const MODE_READ: u64 = 1;
const READ_CHUNK: u64 = 1 << 20;

#[derive(Debug, Clone)]
pub struct FileInfo {
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub mtime: u64,
}

pub struct Afc {
    stream: UnixStream,
    packet: u64,
}

impl Afc {
    /// Starts AFC on the USB-connected iPhone with `udid`.
    pub async fn connect(udid: &str) -> Result<Self> {
        let device = usbmux::list_devices()
            .await?
            .into_iter()
            .find(|d| d.serial == udid)
            .ok_or_else(|| Error::DeviceNotFound(udid.into()))?;
        let port = lockdown::start_service(device.device_id, udid, "com.apple.afc").await?;
        Ok(Self { stream: usbmux::connect(device.device_id, port).await?, packet: 0 })
    }

    async fn call(&mut self, op: u64, data: &[u8]) -> Result<(u64, Vec<u8>, Vec<u8>)> {
        let header_len = 40 + data.len() as u64;
        let mut packet = Vec::with_capacity(header_len as usize);
        packet.extend_from_slice(MAGIC);
        for v in [header_len, header_len, self.packet, op] {
            packet.extend_from_slice(&v.to_le_bytes());
        }
        packet.extend_from_slice(data);
        self.packet += 1;
        self.stream.write_all(&packet).await?;

        let mut head = [0u8; 40];
        self.stream.read_exact(&mut head).await?;
        if &head[..8] != MAGIC {
            return Err(Error::Protocol("afc: bad magic".into()));
        }
        let field = |i: usize| u64::from_le_bytes(head[8 + i * 8..16 + i * 8].try_into().expect("8 bytes"));
        let (entire, this, rop) = (field(0), field(1), field(3));
        let mut rest = vec![0u8; entire.saturating_sub(40) as usize];
        self.stream.read_exact(&mut rest).await?;
        let split = (this.saturating_sub(40) as usize).min(rest.len());
        let payload = rest.split_off(split);
        if rop == OP_STATUS {
            let code = rest.get(..8).map(|b| u64::from_le_bytes(b.try_into().expect("8 bytes"))).unwrap_or(0);
            if code != 0 {
                return Err(Error::Protocol(format!("afc error {code}")));
            }
        }
        Ok((rop, rest, payload))
    }

    fn path_arg(path: &str) -> Vec<u8> {
        let mut v = path.as_bytes().to_vec();
        v.push(0);
        v
    }

    pub async fn read_dir(&mut self, path: &str) -> Result<Vec<String>> {
        let (_, _, payload) = self.call(OP_READ_DIR, &Self::path_arg(path)).await?;
        Ok(payload
            .split(|&b| b == 0)
            .filter(|n| !n.is_empty() && *n != b"." && *n != b"..")
            .map(|n| String::from_utf8_lossy(n).into_owned())
            .collect())
    }

    pub async fn file_info(&mut self, path: &str) -> Result<FileInfo> {
        let (_, _, payload) = self.call(OP_GET_FILE_INFO, &Self::path_arg(path)).await?;
        let parts: Vec<String> = payload.split(|&b| b == 0).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
        let get = |key: &str| parts.chunks(2).find(|kv| kv[0] == key).and_then(|kv| kv.get(1)).cloned();
        Ok(FileInfo {
            is_dir: get("st_ifmt").as_deref() == Some("S_IFDIR"),
            size: get("st_size").and_then(|v| v.parse().ok()).unwrap_or(0),
            mtime: get("st_mtime").and_then(|v| v.parse::<u64>().ok()).map_or(0, |ns| ns / 1_000_000_000),
        })
    }

    /// Downloads `path` to `local`, reporting `(received, total)` bytes.
    pub async fn download(&mut self, path: &str, local: &std::path::Path, mut progress: impl FnMut(u64, u64)) -> Result<()> {
        let total = self.file_info(path).await?.size;
        let mut open = MODE_READ.to_le_bytes().to_vec();
        open.extend_from_slice(&Self::path_arg(path));
        let (rop, data, _) = self.call(OP_FILE_OPEN, &open).await?;
        if rop != OP_FILE_OPEN_RESULT || data.len() < 8 {
            return Err(Error::Protocol(format!("afc: could not open {path}")));
        }
        let handle = u64::from_le_bytes(data[..8].try_into().expect("8 bytes"));
        let mut file = tokio::fs::File::create(local).await?;
        let mut received = 0u64;
        let result = async {
            loop {
                let mut req = handle.to_le_bytes().to_vec();
                req.extend_from_slice(&READ_CHUNK.to_le_bytes());
                let (rop, _, payload) = self.call(OP_FILE_READ, &req).await?;
                if rop != OP_DATA || payload.is_empty() {
                    break;
                }
                file.write_all(&payload).await?;
                received += payload.len() as u64;
                progress(received, total);
            }
            file.flush().await?;
            Ok::<(), Error>(())
        }
        .await;
        let _ = self.call(OP_FILE_CLOSE, &handle.to_le_bytes()).await;
        result
    }
}

#[derive(Debug, Clone)]
pub struct MediaItem {
    /// AFC path, e.g. `/DCIM/125APPLE/IMG_5012.HEIC`.
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: u64,
    pub video: bool,
}

/// Camera roll items on the phone (originals kept in iCloud are absent),
/// newest first.
pub async fn list_media(udid: &str) -> Result<Vec<MediaItem>> {
    let mut afc = Afc::connect(udid).await?;
    let mut items = Vec::new();
    for folder in afc.read_dir("/DCIM").await? {
        let dir = format!("/DCIM/{folder}");
        let Ok(names) = afc.read_dir(&dir).await else { continue };
        for name in names {
            let path = format!("{dir}/{name}");
            let Ok(info) = afc.file_info(&path).await else { continue };
            if info.is_dir {
                continue;
            }
            let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
            items.push(MediaItem {
                video: matches!(ext.as_str(), "mov" | "mp4" | "m4v"),
                path,
                name,
                size: info.size,
                mtime: info.mtime,
            });
        }
    }
    items.sort_by_key(|m| std::cmp::Reverse(m.mtime));
    Ok(items)
}
