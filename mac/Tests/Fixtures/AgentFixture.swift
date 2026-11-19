import AppKit
final class Navigation: NSObject {
    weak var window: NSWindow?
    let phrase: String
    let proof: URL
    init(phrase: String, proof: URL) { self.phrase = phrase; self.proof = proof }
    @objc func details(_ sender: NSButton) {
        sender.title = "Details opened"
        window?.title = "Alotbot Verification — Details"
        let label = NSTextField(labelWithString: "Navigation proof: \(phrase)")
        label.font = .systemFont(ofSize: 24)
        label.frame = NSRect(x: 20, y: 110, width: 560, height: 45)
        window?.contentView?.addSubview(label)
        try? phrase.write(to: proof, atomically: true, encoding: .utf8)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let base = URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent()
let phrase = try String(contentsOf: base.appendingPathComponent("phrase.txt"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
let handler = Navigation(phrase: phrase, proof: base.appendingPathComponent("navigation-proof.txt"))
let window = NSWindow(contentRect: NSRect(x: 120, y: 150, width: 600, height: 220), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Alotbot Verification"
handler.window = window
let label = NSTextField(labelWithString: "Background proof: \(phrase)")
label.font = .systemFont(ofSize: 24)
label.frame = NSRect(x: 20, y: 150, width: 560, height: 45)
let button = NSButton(title: "Show details", target: handler, action: #selector(Navigation.details(_:)))
button.frame = NSRect(x: 20, y: 45, width: 180, height: 40)
window.contentView?.addSubview(label);window.contentView?.addSubview(button)
window.orderBack(nil)
let reference = NSWindow(contentRect: NSRect(x: 180, y: 220, width: 600, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
reference.title = "Alotbot Verification — Reference"
let referenceText = NSTextField(labelWithString: "Reference proof: " + phrase.split(separator: " ").reversed().joined(separator: " "))
referenceText.font = .systemFont(ofSize: 24)
referenceText.frame = NSRect(x: 20, y: 70, width: 560, height: 45)
reference.contentView?.addSubview(referenceText)
reference.orderBack(nil)
app.run()
