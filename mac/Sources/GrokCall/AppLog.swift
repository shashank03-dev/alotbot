import Foundation

/// The app's own log: ~/Library/Application Support/GrokCall/logs/app.log, next to the backend's per-call logs.
/// It records what the backend can't see: messages shown to you, audio start-up and device changes, and the
/// backend process's own errors. Only this user can read it. Writing never blocks or breaks the app.
enum AppLog {
    private static let queue = DispatchQueue(label: "me.shashankdev.grokcall.applog")
    private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static var url: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("GrokCall/logs/app.log")
    }

    static func write(_ text: String) {
        let line = "\(stamp.string(from: Date())) \(text.replacingOccurrences(of: "\n", with: " ⏎ "))\n"
        queue.async {
            let fm = FileManager.default
            let file = url
            do {
                try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                if !fm.fileExists(atPath: file.path) { fm.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
                let h = try FileHandle(forWritingTo: file)
                defer { try? h.close() }
                try h.seekToEnd()
                try h.write(contentsOf: Data(line.utf8))
            } catch {
                // A full disk or a missing folder must never stop the call.
            }
        }
    }
}
