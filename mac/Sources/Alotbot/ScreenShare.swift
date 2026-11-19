import AppKit
import Foundation
import AlotbotCore
import ScreenCaptureKit
import Vision

/// Something you can share with the bots: one window, or a whole display.
struct ShareTarget: Identifiable, Hashable {
    enum Kind: String { case window, display }
    let kind: Kind
    let app: String
    let title: String
    let windowID: CGWindowID?
    let displayID: CGDirectDisplayID?
    var id: String { kind == .window ? "w\(windowID ?? 0)" : "d\(displayID ?? 0)" }
    var label: String { kind == .display ? "Whole screen" : title.isEmpty ? app : "\(app) — \(title)" }

    /// Password managers are never offered (the backend refuses them too).
    static let privateApps = try! NSRegularExpression(pattern: "(1password|keychain|passwords|bitwarden|lastpass|dashlane|keeper|enpass|proton pass)", options: .caseInsensitive)
    static func isPrivate(_ s: String) -> Bool { privateApps.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
    /// Apps a whole-display share leaves out: this app (the call, its trays) and every password manager, by name or bundle id.
    static func hiddenFromDisplay(pid: pid_t, name: String, bundleId: String, me: pid_t) -> Bool {
        pid == me || isPrivate(name) || isPrivate(bundleId)
    }

    /// Windows you could share (other apps' content windows, on screen), then each display.
    static func available() async throws -> [ShareTarget] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let me = ProcessInfo.processInfo.processIdentifier
        let windows = content.windows.compactMap { w -> ShareTarget? in
            guard let owner = w.owningApplication, owner.processID != me,
                  WindowSelection.isContentWindow(width: w.frame.width, height: w.frame.height, layer: w.windowLayer),
                  !isPrivate(owner.applicationName), !isPrivate(w.title ?? "") else { return nil }
            return ShareTarget(kind: .window, app: owner.applicationName, title: w.title ?? "", windowID: w.windowID, displayID: nil)
        }
        .sorted { $0.app == $1.app ? $0.title < $1.title : $0.app.localizedCaseInsensitiveCompare($1.app) == .orderedAscending }
        let displays = content.displays.map { ShareTarget(kind: .display, app: "Display", title: "", windowID: nil, displayID: $0.displayID) }
        return windows + displays
    }
}

/// Reads the shared window every few seconds (text by OCR, plus a local screenshot) and sends it when it changed.
@MainActor
final class ScreenShareSession {
    /// Seconds between reads.
    static let every: Double = 2
    /// Screenshots kept in the artifacts folder.
    static let keepShots = 5

    let target: ShareTarget
    private var loop: Task<Void, Never>?
    private var gate = ScreenTextGate(minInterval: ScreenShareSession.every)
    private var lastTitle: String
    private let send: ([String: Any]) async throws -> Void
    private let stopped: (String) -> Void

    /// `send` posts a screenUpdate; `stopped` is told why sharing ended on its own.
    init(target: ShareTarget, send: @escaping ([String: Any]) async throws -> Void, stopped: @escaping (String) -> Void) {
        self.target = target
        self.send = send
        self.stopped = stopped
        lastTitle = target.title
    }

    func start() {
        loop?.cancel()
        gate.reset()
        loop = Task { [weak self] in
            var failures = 0
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    try await self.readOnce()
                    failures = 0
                } catch let e as ShareEnded {
                    self.end(e.why)
                    return
                } catch {
                    // A missed read now and then is fine; three in a row means it can't be read.
                    failures += 1
                    if failures >= 3 { self.end("Couldn't read the shared screen: \(error.localizedDescription)"); return }
                }
                try? await Task.sleep(for: .seconds(Self.every))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    private func end(_ why: String) {
        loop = nil
        stopped(why)
    }

    private struct ShareEnded: Error { let why: String }

    private func readOnce() async throws {
        guard CGPreflightScreenCaptureAccess() else { throw ShareEnded(why: "Screen Recording is off for Alotbot, so sharing stopped.") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let config = SCStreamConfiguration()
        config.showsCursor = false
        let filter: SCContentFilter
        var title = target.title
        switch target.kind {
        case .window:
            guard let w = content.windows.first(where: { $0.windowID == target.windowID }) else { throw ShareEnded(why: "The shared window closed, so sharing stopped.") }
            title = w.title ?? ""
            if ShareTarget.isPrivate(title) { throw ShareEnded(why: "The shared window shows a password manager, so sharing stopped.") }
            let k = min(1, 2048 / max(w.frame.width, w.frame.height, 1))
            config.width = max(1, Int(w.frame.width * k))
            config.height = max(1, Int(w.frame.height * k))
            filter = SCContentFilter(desktopIndependentWindow: w)
        case .display:
            guard let d = content.displays.first(where: { $0.displayID == target.displayID }) else { throw ShareEnded(why: "The shared display is gone, so sharing stopped.") }
            let k = min(1, 2048 / Double(max(d.width, d.height, 1)))
            config.width = max(1, Int(Double(d.width) * k))
            config.height = max(1, Int(Double(d.height) * k))
            let me = ProcessInfo.processInfo.processIdentifier
            let hidden = content.applications.filter { ShareTarget.hiddenFromDisplay(pid: $0.processID, name: $0.applicationName, bundleId: $0.bundleIdentifier, me: me) }
            filter = SCContentFilter(display: d, excludingApplications: hidden, exceptingWindows: [])
        }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let text = try await Task.detached(priority: .utility) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: image).perform([request])
            return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        }.value
        let retitled = title != lastTitle
        guard let changed = gate.accept(text, at: Date().timeIntervalSinceReferenceDate) ?? (retitled ? ScreenTextGate.normalize(text) : nil) else { return }
        lastTitle = title
        var args: [String: Any] = ["text": changed, "title": title]
        if let shot = try? Self.save(image) { args["screenshot"] = shot }
        try await send(args)
    }

    /// Saves a screenshot (readable only by you) for an agent to look at; keeps the newest few.
    static func save(_ image: CGImage) throws -> String {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Alotbot/artifacts")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = dir.appendingPathComponent("screen-\(UUID().uuidString).png")
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let old = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let shots = old.filter { $0.lastPathComponent.hasPrefix("screen-") && $0.pathExtension == "png" }
            .sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for stale in shots.dropFirst(keepShots) { try? FileManager.default.removeItem(at: stale) }
        return file.path
    }
}
