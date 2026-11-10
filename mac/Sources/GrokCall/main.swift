import AppKit
import GrokCallCore

// `GrokCall --contact-sheet out.png` draws every avatar shape (used to check the shapes by eye).
if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--contact-sheet" {
    do {
        try AvatarDrawing.contactSheet(shapes: MorphData.shared.shapes.keys.sorted(), url: URL(fileURLWithPath: CommandLine.arguments[2]))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("contact sheet failed: \(error)\n".utf8))
        exit(1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
