import ReplayKit
import VideoToolbox

/// Screen broadcast (Control Center, Screen Recording, Mirror): encodes the
/// screen to H.264 and the app sound to AAC, and streams both to the desktop
/// in the Android server's packet format (audio interleaved after a marker). Broadcast extensions have a small memory budget, so frames
/// are dropped rather than queued when the network falls behind.
final class SampleHandler: RPBroadcastSampleHandler {
    private let link = DesktopLink(role: .video)
    private var encoder: VTCompressionSession?
    private var size = (width: Int32(0), height: Int32(0))
    private var connected = false
    private var inFlight = 0
    private var forceKeyframe = true
    private let lock = NSLock()
    private static let maxInFlight = 6
    private let aac = AacEncoder()
    private let audioQueue = DispatchQueue(label: "broadcast-audio")

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        link.onState = { [weak self] state in
            guard let self else { return }
            switch state {
            case .connected:
                self.lock.lock()
                self.connected = true
                self.forceKeyframe = true
                self.lock.unlock()
            case let .failed(reason):
                self.finishBroadcastWithError(NSError(domain: "Mirror", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]))
            default:
                break
            }
        }
        // "k\n" from the desktop asks for a keyframe (new window, decoder reset).
        link.onData = { [weak self] data in
            if data.contains(0x6B) {
                self?.lock.lock()
                self?.forceKeyframe = true
                self?.lock.unlock()
            }
        }
        // Audio is small and never dropped; the config goes first after connecting.
        aac.onConfig = { [weak self] in self?.link.send(audioPacket($0, ptsUs: 0, config: true)) }
        aac.onFrame = { [weak self] in self?.link.send(audioPacket($0, ptsUs: $1, config: false)) }
        link.start()
    }

    override func broadcastFinished() {
        link.stop()
        if let encoder { VTCompressionSessionInvalidate(encoder) }
        encoder = nil
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        if sampleBufferType == .audioApp {
            lock.lock()
            let ready = connected
            lock.unlock()
            if ready { audioQueue.sync { aac.encode(sampleBuffer) } }
            return
        }
        guard sampleBufferType == .video, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lock.lock()
        let ready = connected
        let backlog = inFlight
        var key = forceKeyframe
        lock.unlock()
        guard ready else { return }
        // Behind: drop this frame and restart from a keyframe once caught up.
        if backlog >= Self.maxInFlight {
            lock.lock()
            forceKeyframe = true
            lock.unlock()
            return
        }

        let width = Int32(CVPixelBufferGetWidth(pixels))
        let height = Int32(CVPixelBufferGetHeight(pixels))
        if encoder == nil || width != size.width || height != size.height {
            makeEncoder(width: width, height: height)
            key = true
        }
        guard let encoder else { return }
        lock.lock()
        forceKeyframe = false
        lock.unlock()
        let options = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(encoder, imageBuffer: pixels, presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
                                        duration: .invalid, frameProperties: options, infoFlagsOut: nil) { [weak self] status, _, buffer in
            if status == noErr, let buffer { self?.emit(buffer) }
        }
    }

    private func makeEncoder(width: Int32, height: Int32) {
        if let old = encoder { VTCompressionSessionInvalidate(old) }
        var session: VTCompressionSession?
        VTCompressionSessionCreate(allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264,
                                   encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                   outputCallback: nil, refcon: nil, compressionSessionOut: &session)
        guard let session else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: 6_000_000 as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 10 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(session)
        encoder = session
        size = (width, height)
        var header = Data()
        header.append(contentsOf: withUnsafeBytes(of: UInt64.max.bigEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(width).bigEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(height).bigEndian) { Array($0) })
        link.send(header)
    }

    /// AVCC sample → Annex-B packet; keyframes carry their SPS/PPS.
    private func emit(_ buffer: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(buffer), let format = CMSampleBufferGetFormatDescription(buffer) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        let startCode = Data([0, 0, 0, 1])
        var annexB = Data()
        if keyframe {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var length = 0
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &pointer,
                                                                   parameterSetSizeOut: &length, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                if let pointer { annexB += startCode + Data(bytes: pointer, count: length) }
            }
        }
        var total = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total, dataPointerOut: &pointer) == noErr,
              let pointer else { return }
        let bytes = UnsafeRawPointer(pointer)
        var offset = 0
        while offset + 4 <= total {
            let length = Int(UInt32(bigEndian: bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self)))
            offset += 4
            guard offset + length <= total else { break }
            annexB += startCode + Data(bytes: bytes + offset, count: length)
            offset += length
        }
        let ptsUs = UInt64(max(0, CMSampleBufferGetPresentationTimeStamp(buffer).seconds * 1_000_000))
        let header = (ptsUs & ~(UInt64(3) << 62)) | (keyframe ? UInt64(1) << 62 : 0)
        var packet = Data()
        packet.append(contentsOf: withUnsafeBytes(of: header.bigEndian) { Array($0) })
        packet.append(contentsOf: withUnsafeBytes(of: UInt32(annexB.count).bigEndian) { Array($0) })
        packet.append(annexB)
        lock.lock()
        inFlight += 1
        lock.unlock()
        link.send(packet) { [weak self] in
            self?.lock.lock()
            self?.inFlight -= 1
            self?.lock.unlock()
        }
    }
}
