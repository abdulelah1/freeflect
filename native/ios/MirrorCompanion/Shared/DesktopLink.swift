import Foundation
import Network
import UIKit

/// Connection to the Mirror desktop app on the local network. The desktop
/// advertises `_mirror-desk._tcp` with Bonjour; the first line sent is a JSON
/// hello, answered with {"ok":true} once the computer has allowed this phone.
/// The device id is identifierForVendor, shared by the app and its extensions,
/// so the computer only asks once.
final class DesktopLink {
    enum Role: String { case video, control }
    enum State: Equatable {
        case searching
        case waitingForApproval(String)
        case connected(String)
        case failed(String)
    }

    let role: Role
    private let queue = DispatchQueue(label: "desktop-link")
    private var browser: NWBrowser?
    private var connection: NWConnection?
    private var desktopName = String(localized: "your computer")
    private var buffer = Data()
    private var handshakeDone = false

    var onState: ((State) -> Void)?
    /// Bytes received after the handshake.
    var onData: ((Data) -> Void)?

    init(role: Role) {
        self.role = role
    }

    static var deviceId: String { UIDevice.current.identifierForVendor?.uuidString ?? "unknown" }

    func start() {
        onState?(.searching)
        let browser = NWBrowser(for: .bonjour(type: "_mirror-desk._tcp", domain: nil), using: .tcp)
        // Without this, a blocked browse (Local Network access off) would leave
        // the app on "Looking for your computer" with no explanation.
        browser.stateUpdateHandler = { [weak self] state in
            print("[mirror] browser state: \(state)")
            switch state {
            case let .failed(error), let .waiting(error):
                if case let .dns(code) = error, code == -65570 || code == -65555 {
                    self?.onState?(.failed(String(localized: "Turn on Local Network for FreeFlect in Settings, Privacy & Security, Local Network.")))
                } else {
                    self?.onState?(.failed(String(localized: "Can't search this network: \(error.localizedDescription)")))
                }
            default:
                break
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            print("[mirror] found \(results.count) computer(s): \(results.map { "\($0.endpoint)" })")
            guard let self, self.connection == nil, let first = results.first else { return }
            if case let .service(name, _, _, _) = first.endpoint { self.desktopName = name }
            self.connect(first.endpoint)
        }
        browser.start(queue: queue)
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        connection?.cancel()
        browser = nil
        connection = nil
    }

    private func connect(_ endpoint: NWEndpoint) {
        let params = NWParameters.tcp
        (params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options)?.noDelay = true
        let connection = NWConnection(to: endpoint, using: params)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            print("[mirror] connection state: \(state)")
            guard let self else { return }
            switch state {
            case .ready:
                self.sendHello()
                self.receive()
            case .failed, .cancelled:
                if !self.handshakeDone { self.onState?(.failed(String(localized: "Couldn't reach \(self.desktopName)."))) }
                self.connection = nil
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func sendHello() {
        let hello: [String: Any] = ["v": 1, "role": role.rawValue, "deviceId": Self.deviceId, "name": UIDevice.current.name]
        var data = try! JSONSerialization.data(withJSONObject: hello)
        data.append(0x0A)
        connection?.send(content: data, completion: .contentProcessed { _ in })
        onState?(.waitingForApproval(desktopName))
    }

    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                if self.handshakeDone {
                    self.onData?(data)
                } else {
                    self.buffer.append(data)
                    if let newline = self.buffer.firstIndex(of: 0x0A) {
                        let line = self.buffer[..<newline]
                        let rest = self.buffer[self.buffer.index(after: newline)...]
                        self.buffer = Data()
                        let reply = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
                        if reply?["ok"] as? Bool == true {
                            self.handshakeDone = true
                            self.onState?(.connected(self.desktopName))
                            if !rest.isEmpty { self.onData?(Data(rest)) }
                        } else {
                            self.onState?(.failed(reply?["reason"] as? String ?? String(localized: "The computer refused the connection.")))
                            self.connection?.cancel()
                            return
                        }
                    }
                }
            }
            if isComplete || error != nil {
                self.onState?(.failed(String(localized: "Disconnected from \(self.desktopName).")))
                self.connection?.cancel()
                return
            }
            self.receive()
        }
    }

    /// Sends bytes; `done` reports when the network has taken them.
    func send(_ data: Data, done: (() -> Void)? = nil) {
        connection?.send(content: data, completion: .contentProcessed { _ in done?() })
    }

    /// Control frame: u32 big-endian length + JSON.
    func sendFrame(_ object: [String: Any], then payload: Data? = nil) {
        guard let json = try? JSONSerialization.data(withJSONObject: object) else { return }
        var frame = Data()
        frame.append(contentsOf: withUnsafeBytes(of: UInt32(json.count).bigEndian) { Array($0) })
        frame.append(json)
        if let payload { frame.append(payload) }
        send(frame)
    }

    func sendFile(name: String, data: Data) {
        sendFrame(["type": "file", "name": name, "size": data.count], then: data)
    }

    func sendClipboard(_ text: String) {
        sendFrame(["type": "clipboard", "text": text])
    }
}
