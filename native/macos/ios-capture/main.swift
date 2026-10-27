// ios-capture: mirrors a USB-connected iPhone/iPad screen on macOS.
//
// macOS exposes trusted iOS devices as capture devices once
// kCMIOHardwarePropertyAllowScreenCaptureDevices is set (what QuickTime does).
// Frames are encoded to H.264 with VideoToolbox and written to stdout in the
// Android server's packet format (docs/protocol.md), so the desktop reuses
// the same reader and decoder:
//   session header: u64 0xFFFFFFFFFFFFFFFF, u16 width, u16 height
//   packet:         u64 flags|pts_us (bit 62 = keyframe), u32 length, Annex-B data
//   audio packet:   u64 0xFFFFFFFFFFFFFFFE, then a packet (bit 63 = AAC config)
//
// Usage: ios-capture --list            prints one JSON object per device
//        ios-capture --watch           stays running; prints a JSON array of
//                                      devices whenever the set changes
//        ios-capture <device-id> [bitrate] [audio]
// With "audio", the iPhone's sound plays on the Mac instead (as in QuickTime).
// Starting and exiting short-lived listing processes makes a capture started
// right after miss the device, so the desktop keeps one --watch process.
// stdin: "k" requests a keyframe, "q" or EOF quits.

import AVFoundation
import CoreMediaIO
import Foundation
import VideoToolbox

setvbuf(stdout, nil, _IOFBF, 1 << 16)

func log(_ message: String) {
    FileHandle.standardError.write(("[ios] " + message + "\n").data(using: .utf8)!)
}

func allowScreenCaptureDevices() {
    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil,
                              UInt32(MemoryLayout<UInt32>.size), &allow)
}

/// macOS 14 renamed the external device type; macOS 13 still needs the old one.
private let externalDeviceType: AVCaptureDevice.DeviceType = {
    if #available(macOS 14.0, *) { return .external }
    return .externalUnknown
}()

func iosDevices() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [externalDeviceType], mediaType: .muxed, position: .unspecified)
        .devices.filter { $0.modelID == "iOS Device" }
}

/// Devices appear a moment after enabling discovery.
func waitForDevices(timeout: TimeInterval) -> [AVCaptureDevice] {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        let found = iosDevices()
        if !found.isEmpty { return found }
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    return iosDevices()
}

func waitForDevice(id: String, timeout: TimeInterval) -> AVCaptureDevice? {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let device = iosDevices().first(where: { $0.uniqueID == id }) { return device }
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    return nil
}

let out = FileHandle.standardOutput
let writeLock = NSLock()

func write(_ data: Data) {
    writeLock.lock()
    defer { writeLock.unlock() }
    out.write(data)
}

func be<T: FixedWidthInteger>(_ value: T) -> Data {
    withUnsafeBytes(of: value.bigEndian) { Data($0) }
}

final class Capture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "capture")
    private var encoder: VTCompressionSession?
    private var size = (width: Int32(0), height: Int32(0))
    private let bitrate: Int
    private var forceKeyframe = false
    private let audioQueue = DispatchQueue(label: "capture-audio")
    private let aac = AacEncoder()

    init(device: AVCaptureDevice, bitrate: Int, audio: Bool) throws {
        self.bitrate = bitrate
        super.init()
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw NSError(domain: "ios-capture", code: 1) }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { throw NSError(domain: "ios-capture", code: 2) }
        session.addOutput(output)
        if audio {
            let audioOutput = AVCaptureAudioDataOutput()
            audioOutput.setSampleBufferDelegate(self, queue: audioQueue)
            if session.canAddOutput(audioOutput) {
                session.addOutput(audioOutput)
                aac.onConfig = { write(audioPacket($0, ptsUs: 0, config: true)) }
                aac.onFrame = { write(audioPacket($0, ptsUs: $1, config: false)) }
            } else {
                log("The iPhone's sound can't be captured; it stays on the phone")
            }
        }
    }

    func start() { session.startRunning() }
    func stop() { session.stopRunning() }
    func requestKeyframe() { queue.async { self.forceKeyframe = true } }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output is AVCaptureAudioDataOutput {
            aac.encode(sampleBuffer)
            return
        }
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = Int32(CVPixelBufferGetWidth(pixels))
        let height = Int32(CVPixelBufferGetHeight(pixels))
        if encoder == nil || width != size.width || height != size.height {
            makeEncoder(width: width, height: height)
        }
        guard let encoder else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        var options: CFDictionary?
        if forceKeyframe {
            forceKeyframe = false
            options = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
        }
        VTCompressionSessionEncodeFrame(encoder, imageBuffer: pixels, presentationTimeStamp: pts,
                                        duration: .invalid, frameProperties: options, infoFlagsOut: nil) { status, _, buffer in
            if status == noErr, let buffer { Capture.emit(buffer) }
        }
    }

    /// New encoder per size (rotation); the session header tells the desktop.
    private func makeEncoder(width: Int32, height: Int32) {
        if let old = encoder { VTCompressionSessionInvalidate(old) }
        var session: VTCompressionSession?
        VTCompressionSessionCreate(allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264,
                                   encoderSpecification: [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary,
                                   imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil,
                                   refcon: nil, compressionSessionOut: &session)
        guard let session else { log("Could not create the H.264 encoder"); return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 10 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(session)
        encoder = session
        size = (width, height)
        log("Encoding \(width)x\(height)")
        write(be(UInt64.max) + be(UInt16(width)) + be(UInt16(height)))
    }

    /// AVCC sample → Annex-B packet; keyframes carry their SPS/PPS.
    private static func emit(_ buffer: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(buffer),
              let format = CMSampleBufferGetFormatDescription(buffer) else { return }
        let notSync = (CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[CFString: Any]])?
            .first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
        let keyframe = !notSync
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
        var totalLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLength,
                                          dataPointerOut: &pointer) == noErr, let pointer else { return }
        let bytes = UnsafeRawPointer(pointer)
        var offset = 0
        while offset + 4 <= totalLength {
            let nalLength = Int(UInt32(bigEndian: bytes.load(fromByteOffset: offset, as: UInt32.self)))
            offset += 4
            guard offset + nalLength <= totalLength else { break }
            annexB += startCode + Data(bytes: bytes + offset, count: nalLength)
            offset += nalLength
        }
        let ptsUs = UInt64(max(0, CMSampleBufferGetPresentationTimeStamp(buffer).seconds * 1_000_000))
        let header = (ptsUs & ~(UInt64(3) << 62)) | (keyframe ? UInt64(1) << 62 : 0)
        write(be(header) + be(UInt32(annexB.count)) + annexB)
    }
}

allowScreenCaptureDevices()
let args = CommandLine.arguments

if args.count > 1 && args[1] == "--list" {
    for device in waitForDevices(timeout: 3) {
        let json = try! JSONSerialization.data(withJSONObject: ["id": device.uniqueID, "name": device.localizedName])
        print(String(data: json, encoding: .utf8)!)
    }
    fflush(stdout)
    exit(0)
}

if args.count > 1 && args[1] == "--watch" {
    var last = ""
    func report() {
        let list = iosDevices().map { ["id": $0.uniqueID, "name": $0.localizedName] }
        let line = String(data: try! JSONSerialization.data(withJSONObject: list), encoding: .utf8)!
        if line != last {
            last = line
            print(line)
            fflush(stdout)
        }
    }
    for name in [AVCaptureDevice.wasConnectedNotification, AVCaptureDevice.wasDisconnectedNotification] {
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in report() }
    }
    // Notifications cover plug/unplug; the timer covers lock/unlock changes too.
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in report() }
    report()
    // Exit when the desktop goes away (stdin closes).
    DispatchQueue.global().async {
        while readLine() != nil {}
        exit(0)
    }
    RunLoop.main.run()
}

guard args.count > 1 else {
    log("usage: ios-capture --list | ios-capture <device-id> [bitrate]")
    exit(2)
}

/// macOS treats the iPhone screen as a camera: frames only flow once access
/// is granted. The first time, this shows the system prompt and waits.
func ensureCameraAccess() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        return true
    case .notDetermined:
        log("Asking macOS for camera access")
        let done = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .video) { ok in
            granted = ok
            done.signal()
        }
        done.wait()
        return granted
    default:
        return false
    }
}

guard ensureCameraAccess() else {
    log("Camera access is off for this app. Allow it in System Settings, Privacy & Security, Camera.")
    exit(3)
}

guard let device = waitForDevice(id: args[1], timeout: 8) else {
    log("iPhone not found. Unlock it, tap Trust if asked, and reconnect the cable.")
    exit(4)
}

/// The iPhone's sound counts as a microphone to macOS; without access the
/// screen still mirrors and the sound stays on the phone.
func ensureAudioAccess() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .notDetermined:
        log("Asking macOS for access to the iPhone's sound")
        let done = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            granted = ok
            done.signal()
        }
        done.wait()
        return granted
    default:
        log("Sound access is off for this app, so the sound stays on the iPhone. Allow it in System Settings, Privacy & Security, Microphone.")
        return false
    }
}

let bitrate = args.count > 2 ? Int(args[2]) ?? 8_000_000 : 8_000_000
let wantsAudio = args.count > 3 && args[3] == "audio" && ensureAudioAccess()
let capture: Capture
do {
    capture = try Capture(device: device, bitrate: bitrate, audio: wantsAudio)
} catch {
    log("Could not open the iPhone screen: \(error.localizedDescription)")
    exit(5)
}
capture.start()
log("Mirroring \(device.localizedName)")

// stdin commands; EOF (desktop went away) ends the capture.
DispatchQueue.global().async {
    while let line = readLine() {
        if line == "k" { capture.requestKeyframe() }
        if line == "q" { break }
    }
    capture.stop()
    fflush(stdout)
    exit(0)
}

RunLoop.main.run()
