import CommonCrypto
import CryptoKit
import Foundation
import Network
import Security
import UIKit

/// The computer this phone is paired with. Every connection checks that the
/// computer's TLS certificate has `fingerprint`, and proves this phone with
/// `secret`; both come from pairing (see docs/protocol.md).
struct DesktopPairing: Codable, Equatable {
    /// SHA-256 of the computer's certificate, hex.
    var fingerprint: String
    var secret: String
    var desktopName: String

    /// The Bonjour name the computer advertises.
    var serviceName: String { DesktopPairing.serviceName(fingerprint: fingerprint) }

    static func serviceName(fingerprint: String) -> String { "FreeFlect-" + fingerprint.prefix(12) }
}

/// Keeps the pairing in the keychain, in a group the broadcast and share
/// extensions can read too.
enum PairingStore {
    private static let service = "FreeFlect desktop pairing"

    private static var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "desktop",
        ]
        if let group = Bundle.main.object(forInfoDictionaryKey: "FFKeychainGroup") as? String, !group.hasPrefix("$(") {
            query[kSecAttrAccessGroup as String] = group
        }
        return query
    }

    static func load() -> DesktopPairing? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(DesktopPairing.self, from: data)
    }

    @discardableResult
    static func save(_ pairing: DesktopPairing) -> Bool {
        clear()
        var query = baseQuery
        query[kSecValueData as String] = try? JSONEncoder().encode(pairing)
        // The broadcast extension may start while the phone is locked again.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

/// Connection to the FreeFlect desktop app on the local network. The desktop
/// advertises `_mirror-desk._tcp` with Bonjour as `FreeFlect-<fingerprint>`;
/// this connects only to the paired computer, over TLS pinned to its
/// certificate. The first line sent is a JSON hello with the pairing secret,
/// answered with {"ok":true} when the computer accepts it.
/// The device id is identifierForVendor, shared by the app and its extensions.
final class DesktopLink {
    enum Role: String { case video, control }
    enum State: Equatable {
        case notPaired
        case searching
        case connected(String)
        case failed(String)
    }

    let role: Role
    private let queue = DispatchQueue(label: "desktop-link")
    private var browser: NWBrowser?
    private var connection: DesktopConnection?
    private var pairing: DesktopPairing?

    var onState: ((State) -> Void)?
    /// Bytes received after the handshake.
    var onData: ((Data) -> Void)?

    init(role: Role) {
        self.role = role
    }

    static var deviceId: String { UIDevice.current.identifierForVendor?.uuidString ?? "unknown" }

    func start() {
        guard let pairing = PairingStore.load(), let pin = Data(hex: pairing.fingerprint) else {
            onState?(.notPaired)
            return
        }
        self.pairing = pairing
        onState?(.searching)
        browser = DesktopLink.browse(queue: queue, onFailure: { [weak self] message in self?.onState?(.failed(message)) }) { [weak self] names in
            guard let self, self.connection == nil, let endpoint = names[pairing.serviceName] else { return }
            self.connect(endpoint, pin: pin, pairing: pairing)
        }
    }

    func stop() {
        browser?.cancel()
        connection?.cancel()
        browser = nil
        connection = nil
    }

    private func connect(_ endpoint: NWEndpoint, pin: Data, pairing: DesktopPairing) {
        let connection = DesktopConnection(to: endpoint, pin: pin, queue: queue)
        self.connection = connection
        connection.onFailure = { [weak self] message in
            guard let self else { return }
            self.onState?(.failed(message ?? String(localized: "Couldn't reach \(pairing.desktopName).")))
            self.connection = nil
        }
        connection.onReady = { [weak self, weak connection] in
            guard let self, let connection else { return }
            connection.sendLine(["v": 2, "role": self.role.rawValue, "deviceId": Self.deviceId, "name": UIDevice.current.name, "secret": pairing.secret])
            connection.readLine { [weak self] reply in
                guard let self else { return }
                guard reply?["ok"] as? Bool == true else {
                    if reply?["paired"] as? Bool == false {
                        // Only the pinned computer can say this: it forgot this phone.
                        PairingStore.clear()
                        self.onState?(.notPaired)
                    } else {
                        self.onState?(.failed(reply?["reason"] as? String ?? String(localized: "The computer refused the connection.")))
                    }
                    connection.cancel()
                    return
                }
                let name = reply?["name"] as? String ?? pairing.desktopName
                self.onState?(.connected(name))
                connection.streamData(onData: { [weak self] in self?.onData?($0) }, onEnd: { [weak self] in
                    self?.onState?(.failed(String(localized: "Disconnected from \(name).")))
                })
            }
        }
        connection.start()
    }

    /// Browses for FreeFlect computers; `found` gets them by service name.
    fileprivate static func browse(queue: DispatchQueue, onFailure: @escaping (String) -> Void, found: @escaping ([String: NWEndpoint]) -> Void) -> NWBrowser {
        let browser = NWBrowser(for: .bonjour(type: "_mirror-desk._tcp", domain: nil), using: .tcp)
        // Without this, a blocked browse (Local Network access off) would leave
        // the app on "Looking for your computer" with no explanation.
        browser.stateUpdateHandler = { state in
            switch state {
            case let .failed(error), let .waiting(error):
                if case let .dns(code) = error, code == -65570 || code == -65555 {
                    onFailure(String(localized: "Turn on Local Network for FreeFlect in Settings, Privacy & Security, Local Network."))
                } else {
                    onFailure(String(localized: "Can't search this network: \(error.localizedDescription)"))
                }
            default:
                break
            }
        }
        browser.browseResultsChangedHandler = { results, _ in
            var names: [String: NWEndpoint] = [:]
            for result in results {
                if case let .service(name, _, _, _) = result.endpoint { names[name] = result.endpoint }
            }
            found(names)
        }
        browser.start(queue: queue)
        return browser
    }

    /// Sends bytes; `done` reports when the network has taken them.
    func send(_ data: Data, done: (() -> Void)? = nil) {
        connection?.send(data, done: done)
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

/// Pairs this phone with a computer that has its pairing window open, from
/// its QR code or the code typed by the user, and saves the pairing.
final class DesktopPairer {
    enum Method {
        /// From the QR code: the computer's fingerprint and a one-time token.
        case qr(fingerprint: String, token: String)
        case code(String)
    }

    private let queue = DispatchQueue(label: "desktop-pairing")
    private var browser: NWBrowser?
    private var connection: DesktopConnection?
    private var tried = Set<String>()
    private var finished = false
    private var completion: ((Result<DesktopPairing, PairingError>) -> Void)?

    struct PairingError: Error { let message: String }

    /// Reads `freeflect://pair?v=2&fp=<hex>&t=<hex>&n=<name>`.
    static func method(fromQR text: String) -> Method? {
        guard let url = URLComponents(string: text), url.scheme == "freeflect", url.host == "pair" else { return nil }
        let item = { (name: String) in url.queryItems?.first { $0.name == name }?.value }
        guard item("v") == "2", let fp = item("fp"), Data(hex: fp)?.count == 32, let token = item("t"), Data(hex: token)?.count == 16 else { return nil }
        return .qr(fingerprint: fp, token: token)
    }

    /// Calls `completion` once, on the main queue.
    func pair(_ method: Method, completion: @escaping (Result<DesktopPairing, PairingError>) -> Void) {
        self.completion = completion
        browser = DesktopLink.browse(queue: queue, onFailure: { [weak self] message in self?.finish(.failure(PairingError(message: message))) }) { [weak self] names in
            self?.found(names, method: method)
        }
        queue.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.finish(.failure(PairingError(message: String(localized: "No computer answered. Check that both are on the same Wi-Fi and that Pair iPhone is open on the computer."))))
        }
    }

    func cancel() {
        queue.async { [weak self] in
            self?.finished = true
            self?.stop()
        }
    }

    private func stop() {
        browser?.cancel()
        connection?.cancel()
        browser = nil
        connection = nil
    }

    private func finish(_ result: Result<DesktopPairing, PairingError>) {
        guard !finished else { return }
        finished = true
        stop()
        if case let .success(pairing) = result { PairingStore.save(pairing) }
        let completion = self.completion
        DispatchQueue.main.async { completion?(result) }
    }

    /// Tries the computers one at a time: the QR code names one, a typed code
    /// works only on the one showing it.
    private func found(_ names: [String: NWEndpoint], method: Method) {
        guard !finished, connection == nil else { return }
        let candidates: [String]
        switch method {
        case let .qr(fingerprint, _): candidates = [DesktopPairing.serviceName(fingerprint: fingerprint)]
        case .code: candidates = names.keys.filter { $0.hasPrefix("FreeFlect-") }.sorted()
        }
        guard let name = candidates.first(where: { names[$0] != nil && !tried.contains($0) }), let endpoint = names[name] else { return }
        tried.insert(name)
        switch method {
        case let .qr(fingerprint, token): pairWithToken(endpoint, fingerprint: fingerprint, token: token, names: names, method: method)
        case let .code(code): pairWithCode(endpoint, code: code, names: names, method: method)
        }
    }

    private func next(_ names: [String: NWEndpoint], method: Method, failure: String) {
        connection?.cancel()
        connection = nil
        let untried = names.keys.contains { $0.hasPrefix("FreeFlect-") && !tried.contains($0) }
        if case .code = method, untried { found(names, method: method) } else { finish(.failure(PairingError(message: failure))) }
    }

    private func hello(role: String) -> [String: Any] {
        ["v": 2, "role": role, "deviceId": DesktopLink.deviceId, "name": UIDevice.current.name]
    }

    private func pairWithToken(_ endpoint: NWEndpoint, fingerprint: String, token: String, names: [String: NWEndpoint], method: Method) {
        guard let pin = Data(hex: fingerprint) else { return }
        let connection = DesktopConnection(to: endpoint, pin: pin, queue: queue)
        self.connection = connection
        connection.onFailure = { [weak self] message in
            self?.finish(.failure(PairingError(message: message ?? String(localized: "Couldn't reach the computer."))))
        }
        connection.onReady = { [weak self, weak connection] in
            guard let self, let connection else { return }
            connection.sendLine(self.hello(role: "pair").merging(["token": token]) { $1 })
            connection.readLine { [weak self] reply in
                guard let self else { return }
                guard reply?["ok"] as? Bool == true, let secret = reply?["secret"] as? String else {
                    self.finish(.failure(PairingError(message: reply?["reason"] as? String ?? String(localized: "The computer refused the connection."))))
                    return
                }
                self.finish(.success(DesktopPairing(fingerprint: fingerprint, secret: secret, desktopName: reply?["name"] as? String ?? String(localized: "your computer"))))
            }
        }
        connection.start()
    }

    /// See `pair_with_code` in crates/companion: both sides derive a key from
    /// the code, the certificate fingerprint and two nonces, then prove it.
    private func pairWithCode(_ endpoint: NWEndpoint, code: String, names: [String: NWEndpoint], method: Method) {
        let connection = DesktopConnection(to: endpoint, pin: nil, queue: queue)
        self.connection = connection
        let phoneNonce = Data.random(count: 16)
        connection.onFailure = { [weak self] _ in
            self?.next(names, method: method, failure: String(localized: "Couldn't reach the computer."))
        }
        connection.onReady = { [weak self, weak connection] in
            guard let self, let connection else { return }
            connection.sendLine(self.hello(role: "pair-code").merging(["nonce": phoneNonce.hex]) { $1 })
            connection.readLine { [weak self] reply in
                guard let self else { return }
                guard let desktopNonce = (reply?["nonce"] as? String).flatMap(Data.init(hex:)), let fingerprint = connection.seenFingerprint else {
                    // Not pairing, or not FreeFlect: try the next computer.
                    self.next(names, method: method, failure: reply?["reason"] as? String ?? String(localized: "The computer refused the connection."))
                    return
                }
                // The key derivation is slow on purpose; keep it off the network queue.
                DispatchQueue.global(qos: .userInitiated).async {
                    guard let key = pairingKey(code: code, fingerprint: fingerprint, phoneNonce: phoneNonce, desktopNonce: desktopNonce) else { return }
                    let proof = Data(HMAC<SHA256>.authenticationCode(for: Data("phone".utf8), using: key))
                    self.queue.async {
                        connection.sendLine(["proof": proof.hex])
                        connection.readLine { [weak self] reply in
                            guard let self else { return }
                            guard reply?["ok"] as? Bool == true,
                                  let secret = reply?["secret"] as? String,
                                  let desktopProof = (reply?["proof"] as? String).flatMap(Data.init(hex:)),
                                  HMAC<SHA256>.isValidAuthenticationCode(desktopProof, authenticating: Data("desktop".utf8), using: key)
                            else {
                                self.finish(.failure(PairingError(message: reply?["reason"] as? String ?? String(localized: "That code doesn't match. Check the code on the computer and try again."))))
                                return
                            }
                            self.finish(.success(DesktopPairing(fingerprint: fingerprint.hex, secret: secret, desktopName: reply?["name"] as? String ?? String(localized: "your computer"))))
                        }
                    }
                }
            }
        }
        connection.start()
    }
}

/// Upper case without separators; letters people confuse with digits count as them.
func normalizePairingCode(_ code: String) -> String {
    String(code.compactMap { c -> Character? in
        guard c.isASCII, c.isLetter || c.isNumber else { return nil }
        switch Character(c.uppercased()) {
        case "O": return "0"
        case "I", "L": return "1"
        case let upper: return upper
        }
    })
}

/// PBKDF2-HMAC-SHA256, matching `pairing_key` in crates/companion.
func pairingKey(code: String, fingerprint: Data, phoneNonce: Data, desktopNonce: Data) -> SymmetricKey? {
    let salt = Data("freeflect-pair-v2".utf8) + fingerprint + phoneNonce + desktopNonce
    let password = normalizePairingCode(code)
    var key = [UInt8](repeating: 0, count: 32)
    let status = salt.withUnsafeBytes { saltBytes in
        CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2), password, password.utf8.count,
            saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 600_000, &key, key.count
        )
    }
    return status == kCCSuccess ? SymmetricKey(data: key) : nil
}

/// TLS 1.3 to a FreeFlect computer, with newline-terminated JSON for the
/// handshake and raw bytes after it. With `pin`, only the computer whose
/// certificate has that SHA-256 is accepted; without, `seenFingerprint`
/// records who answered (typed-code pairing then proves it is the right one).
final class DesktopConnection {
    private final class Box { var fingerprint: Data? }

    private let connection: NWConnection
    private let queue: DispatchQueue
    private let seen = Box()
    private var buffer = Data()
    private var ended = false

    var onReady: (() -> Void)?
    /// Before the handshake; nil means no specific reason.
    var onFailure: ((String?) -> Void)?
    var seenFingerprint: Data? { seen.fingerprint }

    init(to endpoint: NWEndpoint, pin: Data?, queue: DispatchQueue) {
        self.queue = queue
        let tls = NWProtocolTLS.Options()
        let security = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(security, .TLSv13)
        let seen = self.seen
        sec_protocol_options_set_verify_block(security, { _, trust, complete in
            let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let chain = SecTrustCopyCertificateChain(secTrust) as? [SecCertificate], let leaf = chain.first else {
                complete(false)
                return
            }
            let fingerprint = Data(SHA256.hash(data: SecCertificateCopyData(leaf) as Data))
            seen.fingerprint = fingerprint
            complete(pin == nil || pin == fingerprint)
        }, queue)
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        connection = NWConnection(to: endpoint, using: NWParameters(tls: tls, tcp: tcp))
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.onReady?()
            case let .waiting(error), let .failed(error):
                self.fail(Self.describe(error))
            case .cancelled:
                self.fail(nil)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    func cancel() {
        ended = true
        connection.cancel()
    }

    private func fail(_ message: String?) {
        guard !ended else { return }
        ended = true
        connection.cancel()
        onFailure?(message)
    }

    private static func describe(_ error: NWError) -> String? {
        if case .tls = error {
            return String(localized: "This isn't the computer this iPhone is paired with. If you reinstalled FreeFlect there, pair again.")
        }
        return nil
    }

    func sendLine(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        send(data)
    }

    func send(_ data: Data, done: (() -> Void)? = nil) {
        connection.send(content: data, completion: .contentProcessed { _ in done?() })
    }

    /// The next JSON line (nil if it isn't JSON, or the connection ends first).
    func readLine(_ completion: @escaping ([String: Any]?) -> Void) {
        if let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer = Data(buffer[buffer.index(after: newline)...])
            completion((try? JSONSerialization.jsonObject(with: line)) as? [String: Any])
            return
        }
        guard buffer.count < 8192 else { return completion(nil) }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data { self.buffer.append(data) }
            if (data?.isEmpty ?? true) && (isComplete || error != nil) {
                self.fail(nil)
                return completion(nil)
            }
            self.readLine(completion)
        }
    }

    /// After the handshake: everything else the computer sends.
    func streamData(onData: @escaping (Data) -> Void, onEnd: @escaping () -> Void) {
        if !buffer.isEmpty {
            onData(buffer)
            buffer = Data()
        }
        // Past the handshake, an ending is reported by onEnd instead.
        onFailure = { _ in onEnd() }
        receiveLoop(onData: onData, onEnd: onEnd)
    }

    private func receiveLoop(onData: @escaping (Data) -> Void, onEnd: @escaping () -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty { onData(data) }
            if isComplete || error != nil {
                self.fail(nil)
                return
            }
            self.receiveLoop(onData: onData, onEnd: onEnd)
        }
    }
}

extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }

    static func random(count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }
}
