import AppKit
final class Counter: NSObject {
    var count = 0
    @objc func press(_ button: NSButton) { count += 1; button.title = "Press verification button (\(count))" }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let counter = Counter()
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 320, height: 160), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = CommandLine.arguments[1]
let button = NSButton(title: "Press verification button (0)", target: counter, action: #selector(Counter.press(_:)))
button.frame = NSRect(x: 30, y: 50, width: 250, height: 35)
window.contentView?.addSubview(button)
window.orderFrontRegardless()
app.run()
