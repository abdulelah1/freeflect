//! Incremental Annex-B H.264 parsing.
//!
//! WebCodecs decodes one `EncodedVideoChunk` per access unit (frame), so the
//! byte stream from a socket or file is regrouped here: bytes in, whole
//! frames out, each tagged with keyframe status and the `avc1.PPCCLL` codec
//! string taken from the most recent SPS.

const NAL_SLICE: u8 = 1;
const NAL_IDR: u8 = 5;
const NAL_SEI: u8 = 6;
const NAL_SPS: u8 = 7;
const NAL_PPS: u8 = 8;
const NAL_AUD: u8 = 9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessUnit {
    /// Annex-B bytes (start codes included) for every NAL in the frame.
    pub data: Vec<u8>,
    pub keyframe: bool,
    /// Set when the frame carries an SPS, i.e. the decoder may need configuring.
    pub codec_string: Option<String>,
}

pub fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map_or(0, |b| b & 0x1f)
}

fn is_vcl(t: u8) -> bool {
    (NAL_SLICE..=NAL_IDR).contains(&t)
}

/// `first_mb_in_slice` is the first ue(v) field of the slice header; a value
/// of 0 is encoded as a single `1` bit, so the top bit of byte 1 marks the
/// first slice of a new picture.
fn starts_new_picture(nal: &[u8]) -> bool {
    nal.get(1).is_some_and(|b| b & 0x80 != 0)
}

/// `avc1.PPCCLL` from an SPS NAL (header byte included).
pub fn codec_string_from_sps(sps: &[u8]) -> Option<String> {
    if sps.len() < 4 || nal_type(sps) != NAL_SPS {
        return None;
    }
    Some(format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]))
}

/// Returns `(index, start_code_len)` of the next start code at or after `from`.
fn find_start_code(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i + 3 <= buf.len() {
        if buf[i] == 0 && buf[i + 1] == 0 {
            if buf[i + 2] == 1 {
                return Some((i, 3));
            }
            if buf[i + 2] == 0 && buf.get(i + 3) == Some(&1) {
                return Some((i, 4));
            }
        }
        i += 1;
    }
    None
}

/// Iterates the NAL units (without start codes) of a complete Annex-B buffer.
pub fn nal_units(buf: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut pos = find_start_code(buf, 0);
    std::iter::from_fn(move || {
        let (start, sc_len) = pos?;
        let body = start + sc_len;
        pos = find_start_code(buf, body);
        let end = pos.map_or(buf.len(), |(next, _)| next);
        Some(&buf[body..end])
    })
}

/// Codec string from the first SPS found in an Annex-B buffer.
pub fn codec_string_from_annexb(buf: &[u8]) -> Option<String> {
    nal_units(buf).find_map(codec_string_from_sps)
}

#[derive(Default)]
pub struct AccessUnitAssembler {
    buf: Vec<u8>,
    current: Vec<u8>,
    current_has_vcl: bool,
    current_keyframe: bool,
    current_codec: Option<String>,
}

impl AccessUnitAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed raw bytes; returns every access unit completed by them.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<AccessUnit> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();

        let Some((mut start, mut sc_len)) = find_start_code(&self.buf, 0) else {
            return out;
        };
        // A NAL is only complete once the following start code has arrived.
        while let Some((next, next_sc_len)) = find_start_code(&self.buf, start + sc_len) {
            let nal = self.buf[start + sc_len..next].to_vec();
            self.add_nal(&nal, &mut out);
            start = next;
            sc_len = next_sc_len;
        }
        self.buf.drain(..start);
        out
    }

    /// Flush the trailing NAL and frame at end of stream.
    pub fn finish(&mut self) -> Vec<AccessUnit> {
        let mut out = Vec::new();
        if let Some((start, sc_len)) = find_start_code(&self.buf, 0) {
            let nal = self.buf[start + sc_len..].to_vec();
            self.add_nal(&nal, &mut out);
        }
        self.buf.clear();
        self.flush_current(&mut out);
        out
    }

    fn add_nal(&mut self, nal: &[u8], out: &mut Vec<AccessUnit>) {
        // Trailing zero bytes belong to the next start code, not this NAL.
        let end = nal.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
        let nal = &nal[..end];
        if nal.is_empty() {
            return;
        }
        let t = nal_type(nal);
        let boundary = matches!(t, NAL_AUD | NAL_SPS | NAL_PPS | NAL_SEI)
            || (is_vcl(t) && starts_new_picture(nal));
        if boundary && self.current_has_vcl {
            self.flush_current(out);
        }

        match t {
            NAL_SPS => self.current_codec = codec_string_from_sps(nal),
            NAL_IDR => self.current_keyframe = true,
            _ => {}
        }
        if is_vcl(t) {
            self.current_has_vcl = true;
        }
        self.current.extend_from_slice(&[0, 0, 0, 1]);
        self.current.extend_from_slice(nal);
    }

    fn flush_current(&mut self, out: &mut Vec<AccessUnit>) {
        if self.current_has_vcl {
            out.push(AccessUnit {
                data: std::mem::take(&mut self.current),
                keyframe: self.current_keyframe,
                codec_string: self.current_codec.take(),
            });
        }
        self.current.clear();
        self.current_has_vcl = false;
        self.current_keyframe = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: &[u8] = &[0x67, 0x64, 0x00, 0x1f, 0xac];
    const PPS: &[u8] = &[0x68, 0xee, 0x3c, 0x80];
    const IDR: &[u8] = &[0x65, 0x88, 0x84, 0x21];
    const P1: &[u8] = &[0x41, 0x9a, 0x02];
    const P2: &[u8] = &[0x41, 0x9a, 0x04];
    const P2_SLICE2: &[u8] = &[0x41, 0x7f, 0x10]; // first_mb_in_slice != 0

    fn annexb(nals: &[&[u8]]) -> Vec<u8> {
        nals.iter().flat_map(|n| [&[0u8, 0, 0, 1][..], n].concat()).collect()
    }

    #[test]
    fn codec_string_from_high_profile_sps() {
        assert_eq!(codec_string_from_sps(SPS).as_deref(), Some("avc1.64001f"));
        assert_eq!(codec_string_from_sps(PPS), None);
    }

    #[test]
    fn groups_nals_into_access_units() {
        let stream = annexb(&[SPS, PPS, IDR, P1, P2, P2_SLICE2]);
        let mut asm = AccessUnitAssembler::new();
        let mut aus = asm.push(&stream);
        aus.extend(asm.finish());

        assert_eq!(aus.len(), 3);
        assert!(aus[0].keyframe);
        assert_eq!(aus[0].codec_string.as_deref(), Some("avc1.64001f"));
        assert_eq!(aus[0].data, annexb(&[SPS, PPS, IDR]));
        assert!(!aus[1].keyframe && aus[1].codec_string.is_none());
        // Second slice of the same picture stays in the same access unit.
        assert_eq!(aus[2].data, annexb(&[P2, P2_SLICE2]));
    }

    #[test]
    fn iterates_nal_units_and_finds_codec() {
        let stream = annexb(&[SPS, PPS, IDR]);
        let nals: Vec<_> = nal_units(&stream).collect();
        assert_eq!(nals, vec![SPS, PPS, IDR]);
        assert_eq!(codec_string_from_annexb(&stream).as_deref(), Some("avc1.64001f"));
    }

    #[test]
    fn handles_arbitrary_chunk_boundaries() {
        let stream = annexb(&[SPS, PPS, IDR, P1, P2]);
        let mut whole = AccessUnitAssembler::new();
        let mut expected = whole.push(&stream);
        expected.extend(whole.finish());

        for chunk in 1..8 {
            let mut asm = AccessUnitAssembler::new();
            let mut got: Vec<_> = stream.chunks(chunk).flat_map(|c| asm.push(c)).collect();
            got.extend(asm.finish());
            assert_eq!(got, expected, "chunk size {chunk}");
        }
    }
}
