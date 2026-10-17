//! lockdownd: the iPhone's service broker (port 62078). A session is upgraded
//! to TLS with this Mac's pairing certificate, then asked to start services
//! such as AFC. Messages are XML plists with a 4-byte big-endian length.

use std::sync::Arc;

use mirror_core::{Error, Result};
use plist::{Dictionary, Value};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::usbmux;

const LOCKDOWN_PORT: u16 = 62078;
const LABEL: &str = "mirror";

async fn send<S: AsyncWrite + Unpin>(s: &mut S, message: Dictionary) -> Result<()> {
    let mut body = Vec::new();
    Value::Dictionary(message).to_writer_xml(&mut body).map_err(|e| Error::Protocol(format!("lockdown plist: {e}")))?;
    s.write_all(&(body.len() as u32).to_be_bytes()).await?;
    s.write_all(&body).await?;
    s.flush().await?;
    Ok(())
}

async fn receive<S: AsyncRead + Unpin>(s: &mut S) -> Result<Dictionary> {
    let len = s.read_u32().await? as usize;
    let mut body = vec![0u8; len];
    s.read_exact(&mut body).await?;
    let reply = Value::from_reader(std::io::Cursor::new(body))
        .ok()
        .and_then(Value::into_dictionary)
        .ok_or_else(|| Error::Protocol("lockdown: bad reply".into()))?;
    if let Some(err) = reply.get("Error").and_then(Value::as_string) {
        return Err(match err {
            "PasswordProtected" => Error::Protocol("Unlock your iPhone and try again.".into()),
            "InvalidHostID" | "PairingDialogResponsePending" => Error::Unauthorized,
            other => Error::Protocol(format!("lockdown: {other}")),
        });
    }
    Ok(reply)
}

fn dict(entries: &[(&str, Value)]) -> Dictionary {
    let mut d = Dictionary::new();
    d.insert("Label".into(), Value::String(LABEL.into()));
    for (k, v) in entries {
        d.insert((*k).into(), v.clone());
    }
    d
}

fn pem(record: &Dictionary, key: &str) -> Result<Vec<u8>> {
    record
        .get(key)
        .and_then(Value::as_data)
        .map(<[u8]>::to_vec)
        .ok_or_else(|| Error::Protocol(format!("pair record has no {key}")))
}

/// The phone presents a self-signed certificate from the pairing; trust is
/// already established by the pair record, as in Apple's own tools.
#[derive(Debug)]
struct AcceptPairedDevice;

impl ServerCertVerifier for AcceptPairedDevice {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

/// The name set on the iPhone (Settings, General, About). Readable without a
/// session; macOS shows the same name for the phone's screen capture device.
pub async fn device_name(device_id: u64) -> Result<String> {
    let mut s = usbmux::connect(device_id, LOCKDOWN_PORT).await?;
    send(&mut s, dict(&[("Request", Value::String("GetValue".into())), ("Key", Value::String("DeviceName".into()))])).await?;
    receive(&mut s)
        .await?
        .get("Value")
        .and_then(Value::as_string)
        .map(str::to_owned)
        .ok_or_else(|| Error::Protocol("lockdown: no DeviceName".into()))
}

/// Starts `service` on the iPhone and returns its port (connect via usbmux).
pub async fn start_service(device_id: u64, udid: &str, service: &str) -> Result<u16> {
    let record = usbmux::read_pair_record(udid).await?;
    let mut plain = usbmux::connect(device_id, LOCKDOWN_PORT).await?;
    let host_id = record.get("HostID").cloned().ok_or_else(|| Error::Protocol("pair record has no HostID".into()))?;
    let buid = record.get("SystemBUID").cloned().ok_or_else(|| Error::Protocol("pair record has no SystemBUID".into()))?;
    send(&mut plain, dict(&[("Request", Value::String("StartSession".into())), ("HostID", host_id), ("SystemBUID", buid)])).await?;
    let session = receive(&mut plain).await?;

    let request = dict(&[("Request", Value::String("StartService".into())), ("Service", Value::String(service.into()))]);
    let reply = if session.get("EnableSessionSSL").and_then(Value::as_boolean) == Some(true) {
        let cert = CertificateDer::from_pem_slice(&pem(&record, "HostCertificate")?).map_err(|e| Error::Protocol(format!("host certificate: {e}")))?;
        let key = PrivateKeyDer::from_pem_slice(&pem(&record, "HostPrivateKey")?).map_err(|e| Error::Protocol(format!("host key: {e}")))?;
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
            .map_err(|e| Error::Protocol(format!("tls: {e}")))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptPairedDevice))
            .with_client_auth_cert(vec![cert], key)
            .map_err(|e| Error::Protocol(format!("tls: {e}")))?;
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        let name = ServerName::try_from("iphone").expect("valid name");
        let mut tls = connector.connect(name, plain).await.map_err(|e| Error::Protocol(format!("lockdown TLS: {e}")))?;
        send(&mut tls, request).await?;
        receive(&mut tls).await?
    } else {
        send(&mut plain, request).await?;
        receive(&mut plain).await?
    };
    reply
        .get("Port")
        .and_then(Value::as_unsigned_integer)
        .map(|p| p as u16)
        .ok_or_else(|| Error::Protocol(format!("lockdown: {service} did not start")))
}
