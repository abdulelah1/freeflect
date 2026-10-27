import UIKit
import UniformTypeIdentifiers

/// "Mirror" in the share sheet: sends text, links, photos, videos and files
/// to the computer, then closes.
final class ShareViewController: UIViewController {
    private let link = DesktopLink(role: .control)
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.text = String(localized: "Looking for your computer")
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24)
        ])

        link.onState = { [weak self] state in
            DispatchQueue.main.async {
                guard let self else { return }
                switch state {
                case .searching: self.label.text = String(localized: "Looking for your computer")
                case .notPaired: self.finish(message: String(localized: "Open the FreeFlect app and pair this iPhone with your computer first."))
                case let .connected(name):
                    self.label.text = String(localized: "Sending to \(name)")
                    self.sendItems()
                case let .failed(reason): self.finish(message: reason)
                }
            }
        }
        link.start()
    }

    private func sendItems() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let group = DispatchGroup()
        for provider in providers {
            group.enter()
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) && !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, _ in
                    if let url = item as? URL { self?.link.sendClipboard(url.absoluteString) }
                    group.leave()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [weak self] item, _ in
                    if let text = item as? String { self?.link.sendClipboard(text) }
                    group.leave()
                }
            } else {
                let type = provider.registeredTypeIdentifiers.first ?? UTType.data.identifier
                provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] url, _ in
                    if let url, let data = try? Data(contentsOf: url) {
                        self?.link.sendFile(name: provider.suggestedName.map { $0 + "." + url.pathExtension } ?? url.lastPathComponent, data: data)
                    }
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) { [weak self] in
            // Give the last frames a moment to leave before the extension ends.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.finish(message: String(localized: "Sent")) }
        }
    }

    private func finish(message: String) {
        label.text = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.link.stop()
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }
}
