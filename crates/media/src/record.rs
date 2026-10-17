//! MP4 recording of the H.264 stream, without re-encoding.
//!
//! Packets arrive as Annex-B access units (start codes); MP4 stores
//! length-prefixed NAL units plus an `avcC` box built from the SPS/PPS.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use mp4::{AacConfig, AudioObjectType, AvcConfig, ChannelConfig, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, SampleFreqIndex, TrackConfig, TrackType};

use crate::h264::{nal_type, nal_units};

/// 90 kHz, the usual MPEG timescale.
const TIMESCALE: u32 = 90_000;
const NAL_SPS: u8 = 7;
const NAL_PPS: u8 = 8;
const NAL_AUD: u8 = 9;
const VIDEO_TRACK: u32 = 1;
const AUDIO_TRACK: u32 = 2;
/// Samples per AAC-LC frame.
const AAC_FRAME: u32 = 1024;

#[derive(Debug)]
pub enum RecordError {
    Io(std::io::Error),
    Mp4(mp4::Error),
    /// The first packet must be a keyframe carrying SPS and PPS.
    NotAKeyframe,
}

impl std::fmt::Display for RecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecordError::Io(e) => write!(f, "{e}"),
            RecordError::Mp4(e) => write!(f, "mp4: {e}"),
            RecordError::NotAKeyframe => write!(f, "recording must start at a keyframe with SPS/PPS"),
        }
    }
}

impl std::error::Error for RecordError {}

impl From<std::io::Error> for RecordError {
    fn from(e: std::io::Error) -> Self {
        RecordError::Io(e)
    }
}

impl From<mp4::Error> for RecordError {
    fn from(e: mp4::Error) -> Self {
        RecordError::Mp4(e)
    }
}

struct Pending {
    pts_us: i64,
    keyframe: bool,
    avcc: Vec<u8>,
}

pub struct Mp4Recorder {
    path: PathBuf,
    writer: Mp4Writer<BufWriter<File>>,
    /// Start of the next sample in ticks. Cumulative, so decode timestamps
    /// always increase even if the encoder repeats a timestamp.
    next_start: u64,
    pending: Option<Pending>,
    last_duration: u32,
    samples: u32,
    /// Phone timestamp of the first video frame; audio is aligned to it.
    origin_us: i64,
    audio: Option<AudioTrack>,
}

struct AudioTrack {
    sample_rate: u32,
    /// Start of the next audio sample, in audio ticks; None until the first.
    next_start: Option<u64>,
}

/// Fields of an AAC AudioSpecificConfig needed for the MP4 `esds` box.
fn parse_asc(asc: &[u8]) -> Option<(AudioObjectType, SampleFreqIndex, ChannelConfig, u32)> {
    let (&a, &b) = (asc.first()?, asc.get(1)?);
    let object_type = AudioObjectType::try_from(a >> 3).ok()?;
    let freq_index = SampleFreqIndex::try_from(((a & 0x07) << 1) | (b >> 7)).ok()?;
    let channels = ChannelConfig::try_from((b >> 3) & 0x0f).ok()?;
    Some((object_type, freq_index, channels, freq_index.freq()))
}

impl Mp4Recorder {
    /// Creates the file from the first keyframe (Annex-B, with SPS/PPS).
    /// With `audio_config` (an AAC AudioSpecificConfig) an audio track is added.
    pub fn create(
        path: &Path,
        width: u16,
        height: u16,
        keyframe: &[u8],
        pts_us: i64,
        audio_config: Option<&[u8]>,
    ) -> Result<Self, RecordError> {
        let sps = nal_units(keyframe).find(|n| nal_type(n) == NAL_SPS).ok_or(RecordError::NotAKeyframe)?;
        let pps = nal_units(keyframe).find(|n| nal_type(n) == NAL_PPS).ok_or(RecordError::NotAKeyframe)?;

        let config = Mp4Config {
            major_brand: str::parse("isom").expect("valid fourcc"),
            minor_version: 512,
            compatible_brands: ["isom", "iso2", "avc1", "mp41"].iter().map(|b| str::parse(b).expect("valid fourcc")).collect(),
            timescale: TIMESCALE,
        };
        let mut writer = Mp4Writer::write_start(BufWriter::new(File::create(path)?), &config)?;
        writer.add_track(&TrackConfig {
            track_type: TrackType::Video,
            timescale: TIMESCALE,
            language: "und".into(),
            media_conf: MediaConfig::AvcConfig(AvcConfig {
                width,
                height,
                seq_param_set: trim_trailing_zeros(sps).to_vec(),
                pic_param_set: trim_trailing_zeros(pps).to_vec(),
            }),
        })?;

        let mut audio = None;
        if let Some((profile, freq_index, chan_conf, sample_rate)) = audio_config.and_then(parse_asc) {
            writer.add_track(&TrackConfig {
                track_type: TrackType::Audio,
                timescale: sample_rate,
                language: "und".into(),
                media_conf: MediaConfig::AacConfig(AacConfig { bitrate: 128_000, profile, freq_index, chan_conf }),
            })?;
            audio = Some(AudioTrack { sample_rate, next_start: None });
        }

        let mut rec = Self {
            path: path.to_path_buf(),
            writer,
            next_start: 0,
            pending: None,
            last_duration: TIMESCALE / 60,
            samples: 0,
            origin_us: pts_us,
            audio,
        };
        rec.push(keyframe, pts_us, true)?;
        Ok(rec)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Adds one access unit. A sample's duration is only known once the next
    /// one arrives, so each sample is written one step late.
    pub fn push(&mut self, annexb: &[u8], pts_us: i64, keyframe: bool) -> Result<(), RecordError> {
        let next = Pending { pts_us, keyframe, avcc: to_avcc(annexb) };
        if next.avcc.is_empty() {
            return Ok(());
        }
        if let Some(prev) = self.pending.replace(next) {
            let duration = to_ticks(pts_us - prev.pts_us).max(1);
            self.last_duration = duration;
            self.write(prev, duration)?;
        }
        Ok(())
    }

    /// Adds one raw AAC frame. Frames from before the recording started are
    /// dropped; the first one is placed by its timestamp, later ones follow
    /// back to back (each AAC frame is exactly 1024 samples).
    pub fn push_audio(&mut self, frame: &[u8], pts_us: i64) -> Result<(), RecordError> {
        let Some(track) = self.audio.as_mut() else { return Ok(()) };
        let offset_us = pts_us - self.origin_us;
        let start = match track.next_start {
            Some(t) => t,
            None if offset_us < 0 => return Ok(()),
            None => offset_us as u64 * track.sample_rate as u64 / 1_000_000,
        };
        track.next_start = Some(start + AAC_FRAME as u64);
        self.writer.write_sample(
            AUDIO_TRACK,
            &Mp4Sample {
                start_time: start,
                duration: AAC_FRAME,
                rendering_offset: 0,
                is_sync: true,
                bytes: frame.to_vec().into(),
            },
        )?;
        Ok(())
    }

    /// Writes the last sample and the `moov` index. Returns the file path.
    pub fn finish(mut self) -> Result<PathBuf, RecordError> {
        if let Some(last) = self.pending.take() {
            let duration = self.last_duration;
            self.write(last, duration)?;
        }
        self.writer.write_end()?;
        Ok(self.path)
    }

    pub fn samples(&self) -> u32 {
        self.samples
    }

    fn write(&mut self, s: Pending, duration: u32) -> Result<(), RecordError> {
        self.writer.write_sample(
            VIDEO_TRACK,
            &Mp4Sample {
                start_time: self.next_start,
                duration,
                rendering_offset: 0,
                is_sync: s.keyframe,
                bytes: s.avcc.into(),
            },
        )?;
        self.next_start += duration as u64;
        self.samples += 1;
        Ok(())
    }
}

fn to_ticks(us: i64) -> u32 {
    (us.max(0) as u64 * TIMESCALE as u64 / 1_000_000) as u32
}

fn trim_trailing_zeros(nal: &[u8]) -> &[u8] {
    let end = nal.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    &nal[..end]
}

/// Annex-B → 4-byte length-prefixed NAL units, dropping parameter sets and
/// access unit delimiters (those live in `avcC`).
pub fn to_avcc(annexb: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(annexb.len());
    for nal in nal_units(annexb) {
        let nal = trim_trailing_zeros(nal);
        if nal.is_empty() || matches!(nal_type(nal), NAL_SPS | NAL_PPS | NAL_AUD) {
            continue;
        }
        out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        out.extend_from_slice(nal);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: &[u8] = &[0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50];
    const PPS: &[u8] = &[0x68, 0xee, 0x3c, 0x80];
    const IDR: &[u8] = &[0x65, 0x88, 0x84, 0x21];
    const P: &[u8] = &[0x41, 0x9a, 0x02, 0x11];

    fn annexb(nals: &[&[u8]]) -> Vec<u8> {
        nals.iter().flat_map(|n| [&[0u8, 0, 0, 1][..], n].concat()).collect()
    }

    #[test]
    fn converts_annexb_to_length_prefixed() {
        let avcc = to_avcc(&annexb(&[SPS, PPS, IDR]));
        assert_eq!(avcc, [&[0, 0, 0, 4][..], IDR].concat());
    }

    #[test]
    fn repeated_timestamps_still_increase() {
        let path = std::env::temp_dir().join(format!("mirror-rec-dup-{}.mp4", std::process::id()));
        let mut rec = Mp4Recorder::create(&path, 64, 64, &annexb(&[SPS, PPS, IDR]), 0, None).unwrap();
        for pts in [16_667, 16_667, 33_333, 33_334, 50_000] {
            rec.push(&annexb(&[P]), pts, false).unwrap();
        }
        let path = rec.finish().unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        let mut reader = mp4::Mp4Reader::read_header(std::io::BufReader::new(File::open(&path).unwrap()), size).unwrap();
        let mut last = None;
        for i in 1..=6 {
            let sample = reader.read_sample(1, i).unwrap().unwrap();
            assert!(last.is_none_or(|l| sample.start_time > l), "sample {i} not increasing");
            last = Some(sample.start_time);
        }
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn writes_a_readable_mp4() {
        let path = std::env::temp_dir().join(format!("mirror-rec-test-{}.mp4", std::process::id()));
        let mut rec = Mp4Recorder::create(&path, 1080, 2336, &annexb(&[SPS, PPS, IDR]), 1_000_000, Some(&[0x11, 0x90])).unwrap();
        for i in 1..=59 {
            rec.push(&annexb(&[P]), 1_000_000 + i * 16_667, false).unwrap();
        }
        // Audio from before the recording started is dropped; ~1 s after it is kept.
        rec.push_audio(&[0x21, 0x00], 900_000).unwrap();
        for i in 0..47 {
            rec.push_audio(&[0x21, 0x00, 0x49], 1_000_000 + i * 21_333).unwrap();
        }
        let path = rec.finish().unwrap();

        let size = std::fs::metadata(&path).unwrap().len();
        let reader = mp4::Mp4Reader::read_header(std::io::BufReader::new(File::open(&path).unwrap()), size).unwrap();
        let track = reader.tracks().get(&1).unwrap();
        assert_eq!(track.sample_count(), 60);
        assert_eq!((track.width(), track.height()), (1080, 2336));
        let audio = reader.tracks().get(&2).unwrap();
        assert_eq!(audio.sample_count(), 47);
        assert_eq!(audio.sample_freq_index().unwrap().freq(), 48_000);
        // 60 frames at 60 fps is about one second.
        let secs = reader.duration().as_secs_f64();
        assert!((secs - 1.0).abs() < 0.05, "duration {secs}");
        std::fs::remove_file(path).ok();
    }
}
