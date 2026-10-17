//! Minimal usbmuxd client: list USB-connected iOS devices and open a TCP
//! connection to a port on one (what `iproxy` does). Used to reach
//! WebDriverAgent, which listens on the phone's loopback interface.
//!
//! Wire format: 16-byte little-endian header (length, version 1, type 8 =
//! plist, tag) followed by an XML plist.

use std::collections::BTreeMap;

use mirror_core::{Error, Result};
use plist::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixStream};

const SOCKET: &str = "/var/run/usbmuxd";
const PLIST_MESSAGE: u32 = 8;

#[derive(Debug, Clone)]
pub struct UsbDevice {
    pub device_id: u64,
    /// The device UDID, e.g. `00008101-000A1B2C3D4E5F60`.
    pub serial: String,
}

async fn send(stream: &mut UnixStream, message: Value, tag: u32) -> Result<()> {
    let mut body = Vec::new();
    message.to_writer_xml(&mut body).map_err(|e| Error::Protocol(format!("usbmux plist: {e}")))?;
    let mut header = Vec::with_capacity(16);
    for v in [16 + body.len() as u32, 1, PLIST_MESSAGE, tag] {
        header.extend_from_slice(&v.to_le_bytes());
    }
    stream.write_all(&header).await?;
    stream.write_all(&body).await?;
    Ok(())
}

async fn receive(stream: &mut UnixStream) -> Result<plist::Dictionary> {
    let mut header = [0u8; 16];
    stream.read_exact(&mut header).await?;
    let len = u32::from_le_bytes(header[..4].try_into().expect("4 bytes")) as usize;
    let mut body = vec![0u8; len.saturating_sub(16)];
    stream.read_exact(&mut body).await?;
    Value::from_reader(std::io::Cursor::new(body))
        .ok()
        .and_then(Value::into_dictionary)
        .ok_or_else(|| Error::Protocol("usbmux: bad reply".into()))
}

fn request(kind: &str, extra: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut dict = BTreeMap::new();
    dict.insert("MessageType".to_string(), Value::String(kind.into()));
    dict.insert("ClientVersionString".to_string(), Value::String("mirror".into()));
    dict.insert("ProgName".to_string(), Value::String("mirror".into()));
    for (k, v) in extra {
        dict.insert(k.to_string(), v);
    }
    Value::Dictionary(dict.into_iter().collect())
}

/// iOS devices connected by USB (network-paired devices are skipped).
pub async fn list_devices() -> Result<Vec<UsbDevice>> {
    let mut s = UnixStream::connect(SOCKET).await?;
    send(&mut s, request("ListDevices", []), 1).await?;
    let reply = receive(&mut s).await?;
    let list = reply.get("DeviceList").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_dictionary()?;
            let props = entry.get("Properties")?.as_dictionary()?;
            if props.get("ConnectionType").and_then(Value::as_string) != Some("USB") {
                return None;
            }
            Some(UsbDevice {
                device_id: entry.get("DeviceID")?.as_unsigned_integer()?,
                serial: props.get("SerialNumber")?.as_string()?.to_string(),
            })
        })
        .collect())
}

/// This Mac's pairing record for `udid` (certificates and host ids), as
/// stored by usbmuxd; readable without administrator rights.
pub async fn read_pair_record(udid: &str) -> Result<plist::Dictionary> {
    let mut s = UnixStream::connect(SOCKET).await?;
    send(&mut s, request("ReadPairRecord", [("PairRecordID", Value::String(udid.into()))]), 3).await?;
    let reply = receive(&mut s).await?;
    let data = reply
        .get("PairRecordData")
        .and_then(Value::as_data)
        .ok_or_else(|| Error::Protocol("This iPhone is not paired with this Mac. Unlock it and tap Trust.".into()))?;
    Value::from_reader(std::io::Cursor::new(data))
        .ok()
        .and_then(Value::into_dictionary)
        .ok_or_else(|| Error::Protocol("usbmux: bad pair record".into()))
}

/// Opens a raw TCP stream to `port` on the device.
pub async fn connect(device_id: u64, port: u16) -> Result<UnixStream> {
    let mut s = UnixStream::connect(SOCKET).await?;
    send(
        &mut s,
        request(
            "Connect",
            [
                ("DeviceID", Value::Integer(device_id.into())),
                // usbmuxd expects the port in network byte order.
                ("PortNumber", Value::Integer((port.swap_bytes() as u64).into())),
            ],
        ),
        2,
    )
    .await?;
    let reply = receive(&mut s).await?;
    match reply.get("Number").and_then(Value::as_unsigned_integer) {
        Some(0) => Ok(s),
        other => Err(Error::Protocol(format!("usbmux connect to port {port} failed ({other:?})"))),
    }
}

/// Forwards a local `127.0.0.1` port to `device_port` on the device until the
/// returned handle is dropped. Returns the local port.
pub async fn forward(device_id: u64, device_port: u16) -> Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let task = tokio::spawn(async move {
        while let Ok((mut local, _)) = listener.accept().await {
            tokio::spawn(async move {
                if let Ok(mut remote) = connect(device_id, device_port).await {
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                }
            });
        }
    });
    Ok((port, task))
}
