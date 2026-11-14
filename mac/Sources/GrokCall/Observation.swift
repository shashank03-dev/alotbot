import AppKit
import ScreenCaptureKit
import Vision
import GrokCallCore

/// Read-only capture. Never activates apps, changes Spaces, or presses controls.
@MainActor enum AppObservation {
    static func run(_ input: LocalToolCommand.Input, enabled: Bool) async throws -> String {
        guard enabled else { throw failure("Background app viewing is off. Enable it in Grok Call Settings → This Mac.") }
        guard CGPreflightScreenCaptureAccess() else { throw failure("macOS reports Screen Recording is unavailable to this running Grok Call build. Allow Grok Call in System Settings → Privacy & Security → Screen & System Audio Recording. If it is already enabled, quit and reopen Grok Call after changing access. Do not claim access is granted until a fresh capture succeeds.") }
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any], session["CGSSessionScreenIsLocked"] as? Bool != true else { throw failure("The Mac is locked; unlock it before viewing apps.") }
        guard ["list", "read", "read_all"].contains(input.operation) else { throw failure("Unknown observation operation.") }
        let app = input.app?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard app.count <= 200, (input.title?.count ?? 0) <= 500, input.operation == "list" || !app.isEmpty else { throw failure("Name the app to read (up to 200 characters), and optionally a window title (up to 500).") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let candidates = content.windows.filter { WindowSelection.isContentWindow(width: $0.frame.width, height: $0.frame.height, layer: $0.windowLayer) && $0.owningApplication?.processID != ProcessInfo.processInfo.processIdentifier }
        let rows = candidates.compactMap { w -> ObservedWindow? in
            guard let owner = w.owningApplication else { return nil }
            return ObservedWindow(id: w.windowID, app: owner.applicationName, bundle: owner.bundleIdentifier, title: w.title ?? "", onScreen: w.isOnScreen)
        }
        let matches = app.isEmpty ? rows.sorted { $0.id < $1.id } : WindowSelection.matches(rows, app: app, title: input.title, id: input.windowId)
        if input.operation == "list" { return try json(["status": "windows", "windows": Array(matches.prefix(100)).map(row), "truncated": matches.count > 100, "note": "Discovery only: no page has been read. onScreen=false does not prevent a background capture. Use read with an exact window ID or read_all to attempt actual captures before describing contents."]) }
        guard !matches.isEmpty else { return try json(["status": "not_found", "note": "I could not read the requested page. It may be in an inactive tab, a minimized window, or a window with a different title. Ask the user to select the requested page in their existing browser, then tell you when it is ready. Make a fresh read only after that confirmation. Do not activate apps or switch tabs yourself."]) }
        if input.operation == "read_all" {
            var captures: [[String: Any]] = []
            for match in matches.prefix(5) {
                var next = input
                next.operation = "read"
                next.windowId = match.id
                do {
                    let result = try await run(next, enabled: enabled)
                    var capture = try JSONSerialization.jsonObject(with: Data(result.utf8)) as! [String: Any]
                    if let text = capture["text"] as? String {
                        capture["text"] = String(text.prefix(4000))
                        capture["textTruncated"] = text.count > 4000 || capture["textTruncated"] as? Bool == true
                    }
                    captures.append(capture)
                } catch { captures.append(["status": "unavailable", "window": row(match), "error": error.localizedDescription]) }
            }
            return try json(["status": "read_all", "capturedCount": captures.filter { $0["status"] as? String == "captured" }.count, "windows": captures, "remaining": Array(matches.dropFirst(5).prefix(100)).map(row), "remainingCount": max(0, matches.count - 5), "note": "These are real capture attempts, including background windows. Report only successful captures as read. Explain failures, and clarify remaining windows before reading more. onScreen is discovery metadata, not a permission or capture limit."])
        }
        guard matches.count == 1 else { return try json(["status": "ambiguous", "windows": Array(matches.prefix(100)).map(row), "note": "No page has been read yet. Ask which window the user means, then read its ID; or use read_all if they ask to see the app broadly or all its windows. Background windows can be read without bringing them forward. Do not infer a restriction from onScreen=false."]) }
        let selected = matches[0]
        guard let window = candidates.first(where: { $0.windowID == selected.id }) else { throw failure("The window disappeared; discover it again.") }
        let config = SCStreamConfiguration()
        let scale = min(1, 2048 / max(window.frame.width, window.frame.height))
        config.width = max(1, Int(window.frame.width * scale)); config.height = max(1, Int(window.frame.height * scale))
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        let capturedAt = ISO8601DateFormatter().string(from: Date())
        // Re-enumerate after capture so a closed/replaced window is never presented as current.
        let current = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard current.windows.contains(where: { $0.windowID == window.windowID && $0.owningApplication?.processID == window.owningApplication?.processID && $0.title == window.title }) else { throw failure("The window closed or changed while being captured. Ask the user to select the requested page again, then make a fresh read.") }
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("GrokCall/artifacts")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Only prune this feature's artifacts; retain up to 50 recent observations for agent jobs.
        let old = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
            .filter { $0.lastPathComponent.hasPrefix("observation-") && $0.pathExtension == "png" }
            .sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for stale in old.dropFirst(49) { try FileManager.default.removeItem(at: stale) }
        let file = dir.appendingPathComponent("observation-\(UUID().uuidString).png")
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw failure("Could not encode this window.") }
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let text = try await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            try VNImageRequestHandler(cgImage: image).perform([request])
            return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        }.value
        return try json(["status": "captured", "window": row(selected), "capturedAt": capturedAt, "screenshot": file.path, "text": String(text.prefix(16000)), "textTruncated": text.count > 16000, "note": "Text is OCR of one window at capture time, not visual understanding or video/audio. For shapes, images or video-frame interpretation, send_task asking your agent to view this exact local screenshot on the host's Mac without activating apps or switching desktops. If the Mac agent is offline, report that. Never infer unseen content. Browser capture includes rendered content only, not inactive tabs. Do not ask the user to install or connect a separate tool."])
    }
    private static func row(_ w: ObservedWindow) -> [String: Any] { ["id": w.id, "app": String(w.app.prefix(200)), "bundle": String(w.bundle.prefix(200)), "title": String(w.title.prefix(500)), "onScreen": w.onScreen] }
    private static func json(_ value: [String: Any]) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private static func failure(_ text: String) -> NSError { NSError(domain: "GrokCall.Observation", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}
