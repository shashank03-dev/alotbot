import AppKit
import AlotbotCore

// `Alotbot --contact-sheet out.png` draws every avatar shape (used to check the shapes by eye).
if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--contact-sheet" {
    do {
        try AvatarDrawing.contactSheet(shapes: MorphData.shared.shapes.keys.sorted(), url: URL(fileURLWithPath: CommandLine.arguments[2]))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("contact sheet failed: \(error)\n".utf8))
        exit(1)
    }
}

// Moves the data folder and settings from the old GrokCall name before anything else reads them. While Grok Call still
// runs (you chose not to quit it), Alotbot does not open beside it.
guard LaunchMigration.run() else { exit(0) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
