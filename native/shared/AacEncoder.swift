// Shared by the macOS capture helper and the iOS broadcast extension:
// PCM audio sample buffers → AAC-LC frames for the desktop, written as
// audio packets in the stream (docs/protocol.md, "Audio in the video stream").
//
// Any PCM layout comes in (16/32-bit integer or float, either endianness,
// interleaved or not); it is converted to stereo float and encoded at the
// input's sample rate. Gaps (ReplayKit sends nothing while the phone is
// silent) are filled with silence so the desktop can play and record the
// frames back to back.

import AVFoundation
import CoreMedia

final class AacEncoder {
    /// AudioSpecificConfig, sent before the first frame and after a format change.
    var onConfig: ((Data) -> Void)?
    /// One raw AAC frame (1024 samples) and its timestamp in microseconds.
    var onFrame: ((Data, Int64) -> Void)?

    private static let frameSamples = 1024
    /// Longer gaps are not filled; the stream restarts at the new time.
    private static let maxFillSeconds = 5.0
    private static let rates: [Double] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000]

    private var converter: AVAudioConverter?
    private var pcmFormat: AVAudioFormat?
    private var sampleRate: Double = 0
    /// Time of the first sample fed since (re)start, and samples fed since then.
    private var originUs: Int64 = 0
    private var samplesIn: Int64 = 0
    private var framesOut: Int64 = 0

    func encode(_ sampleBuffer: CMSampleBuffer) {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM else { return }
        let count = CMSampleBufferGetNumSamples(sampleBuffer)
        guard count > 0, asbd.mSampleRate > 0 else { return }
        let ptsUs = Int64(CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds * 1_000_000)

        if converter == nil || asbd.mSampleRate != sampleRate {
            guard start(rate: asbd.mSampleRate, at: ptsUs) else { return }
        }
        // Fill a gap with silence, or restart the timeline after a long one.
        let expectedUs = originUs + samplesIn * 1_000_000 / Int64(sampleRate)
        let gapSamples = Int64(Double(ptsUs - expectedUs) * sampleRate / 1_000_000)
        if gapSamples > Int64(sampleRate * Self.maxFillSeconds) || gapSamples < -Int64(sampleRate) {
            guard start(rate: sampleRate, at: ptsUs) else { return }
        } else if gapSamples > Int64(sampleRate / 50), let silence = AVAudioPCMBuffer(pcmFormat: pcmFormat!, frameCapacity: AVAudioFrameCount(gapSamples)) {
            silence.frameLength = AVAudioFrameCount(gapSamples)
            for channel in 0..<2 { memset(silence.floatChannelData![channel], 0, Int(gapSamples) * MemoryLayout<Float>.size) }
            feed(silence)
        }
        if let pcm = pcm(from: sampleBuffer, asbd: asbd, count: count) { feed(pcm) }
    }

    private func start(rate: Double, at ptsUs: Int64) -> Bool {
        guard let pcm = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false),
              let aac = AVAudioFormat(settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 2]),
              let converter = AVAudioConverter(from: pcm, to: aac),
              let index = Self.rates.firstIndex(of: rate) else { return false }
        converter.bitRate = 128_000
        self.converter = converter
        pcmFormat = pcm
        sampleRate = rate
        originUs = ptsUs
        samplesIn = 0
        framesOut = 0
        // AAC-LC (object type 2), sample rate index, 2 channels.
        let asc = UInt16(2) << 11 | UInt16(index) << 7 | UInt16(2) << 3
        onConfig?(Data([UInt8(asc >> 8), UInt8(asc & 0xFF)]))
        return true
    }

    /// Converts any PCM layout to the encoder's stereo float format.
    private func pcm(from sampleBuffer: CMSampleBuffer, asbd: AudioStreamBasicDescription, count: Int) -> AVAudioPCMBuffer? {
        guard let pcmFormat, let out = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: AVAudioFrameCount(count)),
              let dst = out.floatChannelData else { return nil }
        let channels = Int(max(1, asbd.mChannelsPerFrame))
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let buffers = nonInterleaved ? channels : 1
        var listSize = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: &listSize, bufferListOut: nil,
                                                                bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
                                                                flags: 0, blockBufferOut: nil)
        let raw = UnsafeMutableRawPointer.allocate(byteCount: max(listSize, AudioBufferList.sizeInBytes(maximumBuffers: buffers)), alignment: 16)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: max(listSize, AudioBufferList.sizeInBytes(maximumBuffers: buffers)),
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block) == noErr else { return nil }
        let abl = UnsafeMutableAudioBufferListPointer(list)

        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let bigEndian = asbd.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
        let bits = Int(asbd.mBitsPerChannel)
        let bytes = bits / 8
        guard bytes == 2 || bytes == 4 else { return nil }
        func sample(_ frame: Int, _ channel: Int) -> Float {
            let buffer = abl[nonInterleaved ? channel : 0]
            guard let data = buffer.mData else { return 0 }
            let index = nonInterleaved ? frame : frame * channels + channel
            guard (index + 1) * bytes <= Int(buffer.mDataByteSize) else { return 0 }
            if bytes == 2 {
                let v = data.loadUnaligned(fromByteOffset: index * 2, as: UInt16.self)
                return Float(Int16(bitPattern: bigEndian ? v.byteSwapped : v)) / 32768
            }
            var v = data.loadUnaligned(fromByteOffset: index * 4, as: UInt32.self)
            if bigEndian { v = v.byteSwapped }
            return isFloat ? Float(bitPattern: v) : Float(Int32(bitPattern: v)) / 2_147_483_648
        }
        for frame in 0..<count {
            dst[0][frame] = sample(frame, 0)
            dst[1][frame] = sample(frame, min(1, channels - 1))
        }
        out.frameLength = AVAudioFrameCount(count)
        return out
    }

    private func feed(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        samplesIn += Int64(buffer.frameLength)
        var supplied = false
        while true {
            let out = AVAudioCompressedBuffer(format: converter.outputFormat, packetCapacity: 16,
                                              maximumPacketSize: max(converter.maximumOutputPacketSize, 1536))
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, inputStatus in
                if supplied {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                supplied = true
                inputStatus.pointee = .haveData
                return buffer
            }
            if let descriptions = out.packetDescriptions {
                for i in 0..<Int(out.packetCount) {
                    let d = descriptions[i]
                    let frame = Data(bytes: out.data + Int(d.mStartOffset), count: Int(d.mDataByteSize))
                    let pts = originUs + framesOut * Int64(Self.frameSamples) * 1_000_000 / Int64(sampleRate)
                    framesOut += 1
                    onFrame?(frame, pts)
                }
            }
            if status != .haveData { break }
        }
    }
}

/// Audio packet in a video stream: marker, then a normal packet whose header
/// carries the config flag (bit 63) or the timestamp.
func audioPacket(_ payload: Data, ptsUs: Int64, config: Bool) -> Data {
    var data = Data()
    func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.bigEndian) { data.append(contentsOf: $0) } }
    append(UInt64.max - 1)
    append(config ? UInt64(1) << 63 : UInt64(max(0, ptsUs)) & ~(UInt64(3) << 62))
    append(UInt32(payload.count))
    data.append(payload)
    return data
}
