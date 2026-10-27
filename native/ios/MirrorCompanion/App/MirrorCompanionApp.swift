import AVFoundation
import PhotosUI
import ReplayKit
import SwiftUI
import UniformTypeIdentifiers

@main
struct MirrorCompanionApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

/// Keeps a control connection to the computer while the app is open.
@MainActor
final class Companion: ObservableObject {
    @Published var state: DesktopLink.State = .searching
    @Published var notice: String?
    @Published var pairing = PairingStore.load()
    @Published var pairingBusy = false
    @Published var pairingError: String?
    private var link: DesktopLink?
    private var pairer: DesktopPairer?
    private var incoming = Data()
    private var pendingFile: (name: String, size: Int)?

    func connect() {
        guard link == nil else { return }
        let link = DesktopLink(role: .control)
        link.onState = { [weak self] state in
            Task { @MainActor in
                guard let self, self.link === link else { return }
                self.state = state
                switch state {
                case .notPaired:
                    self.pairing = nil
                    self.link = nil
                case .failed:
                    self.link = nil
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if self.pairing != nil { self.connect() }
                default:
                    break
                }
            }
        }
        link.onData = { [weak self] data in Task { @MainActor in self?.receive(data) } }
        link.start()
        self.link = link
    }

    func pair(_ method: DesktopPairer.Method) {
        pairer?.cancel()
        pairingBusy = true
        pairingError = nil
        let pairer = DesktopPairer()
        self.pairer = pairer
        pairer.pair(method) { [weak self] result in
            guard let self, self.pairer === pairer else { return }
            self.pairingBusy = false
            self.pairer = nil
            switch result {
            case let .success(pairing):
                self.pairing = pairing
                self.link?.stop()
                self.link = nil
                self.connect()
            case let .failure(error):
                self.pairingError = error.message
            }
        }
    }

    /// Unpairs on this side; the computer keeps listing the phone until it forgets it too.
    func forget() {
        link?.stop()
        link = nil
        PairingStore.clear()
        pairing = nil
        state = .notPaired
    }

    func sendClipboard() {
        guard let text = UIPasteboard.general.string, !text.isEmpty else {
            notice = String(localized: "The clipboard has no text to send.")
            return
        }
        link?.sendClipboard(text)
        notice = String(localized: "Clipboard sent")
    }

    func send(name: String, data: Data) {
        link?.sendFile(name: name, data: data)
        notice = String(localized: "Sent \(name)")
    }

    /// Control frames from the computer: clipboard text, or files saved to Documents (Files app).
    private func receive(_ data: Data) {
        incoming.append(data)
        while true {
            if let file = pendingFile {
                guard incoming.count >= file.size else { return }
                let bytes = incoming.prefix(file.size)
                incoming.removeFirst(file.size)
                pendingFile = nil
                let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let safe = (file.name as NSString).lastPathComponent
                try? bytes.write(to: uniqueURL(in: docs, name: safe.isEmpty || safe.hasPrefix(".") ? "file" : safe), options: .withoutOverwriting)
                notice = String(localized: "Received \(safe). Find it in the Files app, On My iPhone, FreeFlect.")
                continue
            }
            guard incoming.count >= 4 else { return }
            let length = Int(incoming.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
            guard incoming.count >= 4 + length else { return }
            let json = incoming.subdata(in: incoming.startIndex + 4 ..< incoming.startIndex + 4 + length)
            incoming.removeFirst(4 + length)
            guard let frame = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else { continue }
            switch frame["type"] as? String {
            case "clipboard":
                UIPasteboard.general.string = frame["text"] as? String
                notice = String(localized: "Copied from your computer")
            case "file":
                pendingFile = (frame["name"] as? String ?? "file", frame["size"] as? Int ?? 0)
            default:
                break
            }
        }
    }
}

/// `name`, or `name (2)` and so on when a file already has it: nothing received overwrites a file.
private func uniqueURL(in dir: URL, name: String) -> URL {
    let base = dir.appendingPathComponent(name)
    guard FileManager.default.fileExists(atPath: base.path) else { return base }
    let stem = base.deletingPathExtension().lastPathComponent
    let ext = base.pathExtension.isEmpty ? "" : "." + base.pathExtension
    var i = 2
    while FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(stem) (\(i))\(ext)").path) { i += 1 }
    return dir.appendingPathComponent("\(stem) (\(i))\(ext)")
}

struct ContentView: View {
    @StateObject private var companion = Companion()
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var scanning = false
    @State private var typingCode = false
    /// Shown before iOS asks for anything pairing needs (local network, camera).
    @State private var primer: PairingPrimer.Method?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    statusRow
                }
                if companion.pairing == nil {
                    pairingSection
                } else {
                    connectedSections
                }
                if let notice = companion.notice {
                    Section { Text(notice).font(.subheadline).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("FreeFlect")
        }
        .onAppear { if companion.pairing != nil { companion.connect() } else { companion.state = .notPaired } }
        .sheet(isPresented: $scanning) {
            QRScannerSheet { text in
                scanning = false
                if let method = DesktopPairer.method(fromQR: text) {
                    companion.pair(method)
                } else {
                    companion.pairingError = String(localized: "That isn't a FreeFlect pairing code. On the computer, open Settings and choose Pair iPhone.")
                }
            }
        }
        .sheet(item: $primer) { method in
            PairingPrimer(method: method) {
                primer = nil
                PairingPrimer.markExplained()
                // Let the sheet go away before the next one opens.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { proceed(method) }
            } onCancel: {
                primer = nil
            }
        }
        .sheet(isPresented: $typingCode) {
            CodeEntrySheet { code in
                typingCode = false
                companion.pair(.code(code))
            }
        }
        .onChange(of: photos) { items in
            for item in items {
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                        companion.send(name: "Photo-\(Int(Date().timeIntervalSince1970)).\(ext)", data: data)
                    }
                }
            }
            photos = []
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            for url in (try? result.get()) ?? [] {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) { companion.send(name: url.lastPathComponent, data: data) }
            }
        }
    }

    /// Explains first if iOS is about to ask for something, then pairs.
    private func begin(_ method: PairingPrimer.Method) {
        if PairingPrimer.needed(for: method) { primer = method } else { proceed(method) }
    }

    private func proceed(_ method: PairingPrimer.Method) {
        switch method {
        case .scan: scanning = true
        case .code: typingCode = true
        }
    }

    @ViewBuilder private var pairingSection: some View {
        Section {
            Text("On your computer, open FreeFlect, then Settings, and choose Pair iPhone.").font(.subheadline).foregroundStyle(.secondary)
            Button { begin(.scan) } label: { Label("Scan the QR code", systemImage: "qrcode.viewfinder") }
            Button { begin(.code) } label: { Label("Type a code", systemImage: "keyboard") }
            if companion.pairingBusy {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Pairing").foregroundStyle(.secondary)
                }
            }
            if let error = companion.pairingError {
                Text(error).font(.subheadline).foregroundStyle(.orange)
            }
        } header: {
            Text("Pair with a computer")
        }
        .disabled(companion.pairingBusy)
    }

    @ViewBuilder private var connectedSections: some View {
        Section("Screen") {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Share screen").font(.headline)
                            Text("Tap the button, choose FreeFlect, then Start Broadcast.").font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        BroadcastButton().frame(width: 52, height: 52)
                    }
                }
                Section("Send to computer") {
                    Button { companion.sendClipboard() } label: { Label("Send clipboard", systemImage: "doc.on.clipboard") }
                    PhotosPicker(selection: $photos, maxSelectionCount: 20, matching: .any(of: [.images, .videos])) {
                        Label("Send photos or videos", systemImage: "photo.on.rectangle")
                    }
                    Button { importing = true } label: { Label("Send files", systemImage: "folder") }
                }
                .disabled(!isConnected)
                Section("Computer") {
                    if let pairing = companion.pairing {
                        Label("Paired with \(pairing.desktopName)", systemImage: "lock.laptopcomputer")
                    }
                    Button(role: .destructive) { companion.forget() } label: { Label("Forget this computer", systemImage: "xmark.circle") }
                }
    }

    private var isConnected: Bool {
        if case .connected = companion.state { return true }
        return false
    }

    @ViewBuilder private var statusRow: some View {
        switch companion.state {
        case .searching:
            Label("Looking for your computer", systemImage: "wifi")
            Text("Open FreeFlect on your computer and keep both on the same Wi-Fi.").font(.footnote).foregroundStyle(.secondary)
        case .notPaired:
            Label("Not paired with a computer", systemImage: "link")
        case let .connected(name):
            Label("Connected to \(name)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case let .failed(reason):
            Label(reason, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
        }
    }
}

/// The system broadcast picker, preselecting this app's extension.
struct BroadcastButton: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 52, height: 52))
        // The extension's id follows the app's (it depends on the signing team).
        picker.preferredExtension = (Bundle.main.bundleIdentifier ?? "") + ".broadcast"
        picker.showsMicrophoneButton = false
        return picker
    }

    func updateUIView(_ view: RPSystemBroadcastPickerView, context: Context) {}
}

/// Asks for the code shown on the computer.
struct CodeEntrySheet: View {
    let onSubmit: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("XXXX-XXXX", text: $code)
                        .font(.system(.title2, design: .monospaced))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .onSubmit(submit)
                } footer: {
                    Text("Enter the code shown under the QR code on your computer.")
                }
            }
            .navigationTitle("Type a code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Pair", action: submit).disabled(!complete) }
            }
            .onAppear { focused = true }
        }
    }

    private var complete: Bool { normalizePairingCode(code).count == 8 }

    private func submit() {
        if complete { onSubmit(code) }
    }
}

/// The camera, until it sees a QR code.
struct QRScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var denied = AVCaptureDevice.authorizationStatus(for: .video) == .denied

    var body: some View {
        NavigationStack {
            Group {
                if denied {
                    Text("Allow FreeFlect to use the camera in Settings, or type the code instead.")
                        .multilineTextAlignment(.center)
                        .padding()
                } else {
                    QRScanner(onCode: onCode, onDenied: { denied = true }).ignoresSafeArea(edges: .bottom)
                }
            }
            .navigationTitle("Scan the QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onDenied: () -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        controller.onDenied = onDenied
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        var onDenied: (() -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var done = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { granted ? self.configure() : self.onDenied?() }
            }
        }

        private func configure() {
            guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.addSublayer(preview)
            self.preview = preview
            DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            DispatchQueue.global(qos: .userInitiated).async { self.session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !done, let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            done = true
            onCode?(code)
        }
    }
}

/// Says what iOS is about to ask and why, before it asks: finding the
/// computer on the local network, and the camera for the QR code.
struct PairingPrimer: View {
    enum Method: Identifiable {
        case scan, code
        var id: Self { self }
    }

    let method: Method
    let onContinue: () -> Void
    let onCancel: () -> Void

    private static let explainedKey = "explainedLocalNetwork"

    static func needed(for method: Method) -> Bool {
        !UserDefaults.standard.bool(forKey: explainedKey) || (method == .scan && cameraUndecided)
    }

    static func markExplained() {
        UserDefaults.standard.set(true, forKey: explainedKey)
    }

    private static var cameraUndecided: Bool { AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined }

    var body: some View {
        NavigationStack {
            List {
                if !UserDefaults.standard.bool(forKey: Self.explainedKey) {
                    Section {
                        Text("FreeFlect finds your computer on your Wi-Fi to send it your screen, clipboard and files. It only talks to the computer you pair with, over an encrypted connection.")
                        Text("iOS asks whether FreeFlect may find devices on your local network. Tap Allow. Without it, FreeFlect can't reach your computer.")
                            .foregroundStyle(.secondary)
                    } header: {
                        Label("Local network", systemImage: "wifi")
                    }
                }
                if method == .scan && Self.cameraUndecided {
                    Section {
                        Text("FreeFlect needs the camera only to read the pairing code on your computer's screen. It's on only while you scan, and nothing is recorded or saved.")
                        Text("iOS asks whether FreeFlect may use the camera. Tap Allow. Or choose Type a code instead, which needs no camera.")
                            .foregroundStyle(.secondary)
                    } header: {
                        Label("Camera", systemImage: "camera")
                    }
                }
            }
            .navigationTitle("Before you pair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Not now", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) { Button("Continue", action: onContinue) }
            }
        }
        .presentationDetents([.medium])
    }
}
