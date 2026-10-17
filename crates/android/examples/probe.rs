//! Hardware check: mirrors the first ADB device for a few seconds and
//! reports frame statistics.
//!
//!   cargo run -p mirror-android --example probe -- android-server/build/mirror-server.jar

use std::sync::Arc;
use std::time::{Duration, Instant};

use mirror_android::{AdbClient, AdbState, AndroidSession};
use mirror_core::{DeviceSession, VideoCodec, VideoConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let jar_path = std::env::args().nth(1).ok_or("usage: probe <mirror-server.jar>")?;
    let adb = AdbClient::default();
    let device = adb
        .devices()
        .await?
        .into_iter()
        .find(|d| d.state == AdbState::Device)
        .ok_or("no authorized device")?;
    println!("device: {} ({:?})", device.serial, device.model);

    let session = AndroidSession::new(device.to_device_info(), adb, Arc::new(std::fs::read(jar_path)?));
    let started = Instant::now();
    let mut rx = session
        .start_video(VideoConfig { codec: VideoCodec::H264, max_size: None, bitrate: 8_000_000, max_fps: None, owner: None, audio: false })
        .await?;
    println!("server up in {:?}: {:?}", started.elapsed(), session.device_name());

    let (mut frames, mut keyframes, mut bytes, mut codec) = (0u32, 0u32, 0usize, None);
    let deadline = Instant::now() + Duration::from_secs(4);
    while let Ok(Some(p)) = tokio::time::timeout_at(deadline.into(), rx.recv()).await {
        if frames == 0 {
            println!("first frame after {:?}", started.elapsed());
        }
        frames += 1;
        keyframes += p.keyframe as u32;
        bytes += p.data.len();
        codec = codec.or(p.codec_string);
    }
    session.stop().await?;
    println!("frames={frames} keyframes={keyframes} codec={codec:?} avg={} bytes", bytes / frames.max(1) as usize);
    Ok(())
}
