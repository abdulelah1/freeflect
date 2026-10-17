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
    private var link: DesktopLink?
    private var incoming = Data()
    private var pendingFile: (name: String, size: Int)?

    func connect() {
        guard link == nil else { return }
        let link = DesktopLink(role: .control)
        link.onState = { [weak self] state in
            Task { @MainActor in
                self?.state = state
                if case .failed = state {
                    self?.link = nil
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    self?.connect()
                }
            }
        }
        link.onData = { [weak self] data in Task { @MainActor in self?.receive(data) } }
        link.start()
        self.link = link
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
                try? bytes.write(to: docs.appendingPathComponent(safe.isEmpty ? "file" : safe))
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

struct ContentView: View {
    @StateObject private var companion = Companion()
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    statusRow
                }
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
                if let notice = companion.notice {
                    Section { Text(notice).font(.subheadline).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("FreeFlect")
        }
        .onAppear { companion.connect() }
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

    private var isConnected: Bool {
        if case .connected = companion.state { return true }
        return false
    }

    @ViewBuilder private var statusRow: some View {
        switch companion.state {
        case .searching:
            Label("Looking for your computer", systemImage: "wifi")
            Text("Open FreeFlect on your computer and keep both on the same Wi-Fi.").font(.footnote).foregroundStyle(.secondary)
        case let .waitingForApproval(name):
            Label("Allow this iPhone on \(name)", systemImage: "hand.raised")
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
