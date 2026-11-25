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

    /// A window on screen, as far as a whole-display share needs it. `pid` is nil for a window with no owning app.
    struct WindowInfo {
        let id: CGWindowID
        let pid: pid_t?
        let app: String
        let bundleId: String
        let title: String
    }

    /// Windows a whole-display share leaves out: every window of a hidden app, and any window whose title shows a
    /// password manager (a browser tab on a vault, say), whatever app it belongs to. Ordered by id.
    static func hiddenWindows(_ windows: [WindowInfo], me: pid_t) -> [CGWindowID] {
        windows.filter { w in
            isPrivate(w.title) || w.pid.map { hiddenFromDisplay(pid: $0, name: w.app, bundleId: w.bundleId, me: me) } == true
        }.map(\.id).sorted()
    }

    /// The screenShare request: app and title tidied and cut to the backend's limits (100 and 300 characters), so a long
    /// window title is shared, not refused.
    var screenShareArgs: [String: Any] {
        // The backend counts UTF-16 units, as JavaScript does; an emoji is never split.
        func clean(_ s: String, _ max: Int) -> String {
            var out = ""
            for ch in s.split(whereSeparator: \.isWhitespace).joined(separator: " ") {
                if out.utf16.count + ch.utf16.count > max { break }
                out.append(ch)
            }
            return out
        }
        return ["app": clean(app, 100), "title": clean(title, 300), "kind": kind.rawValue]
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
    private let send: ([String: Any]) async throws -> Bool
    private let stopped: (String) -> Void
    /// Reads the screen once; tests replace it (the real one needs ScreenCaptureKit).
    private let read: ((ScreenShareSession) async throws -> Void)?
    /// Seconds a read may take before it counts as failed. A capture can hang for good (live, after a window was renamed).
    private let readLimit: Double
    /// The read under way, kept while it is late, so a stuck one is waited for again rather than piled on.
    private var reading: Task<Void, Error>?
    /// What the read under way is doing, for the log when it is late.
    private var step = "reading the screen"

    /// `send` posts a screenUpdate and says whether the backend took it in; `stopped` is told why sharing ended on its own.
    init(target: ShareTarget, send: @escaping ([String: Any]) async throws -> Bool, stopped: @escaping (String) -> Void,
         read: ((ScreenShareSession) async throws -> Void)? = nil, readLimit: Double = 15) {
        self.target = target
        self.send = send
        self.stopped = stopped
        self.read = read
        self.readLimit = readLimit
        lastTitle = target.title
    }

    struct ReadTooSlow: LocalizedError {
        let step: String
        var errorDescription: String? { "it stopped responding (\(step))." }
    }

    /// One read, or the one still under way, given `readLimit` seconds to finish.
    private func readInTime() async throws {
        if reading == nil {
            step = "reading the screen"
            reading = Task { [weak self] in
                guard let self else { return }
                if let read = self.read { try await read(self) } else { try await self.readOnce() }
            }
        }
        let current = reading!
        let limit = readLimit
        let finished = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            let once = Once(done)
            Task { _ = await current.result; once.resume(true) }
            Task { try? await Task.sleep(for: .seconds(limit)); once.resume(false) }
        }
        guard finished else { throw ReadTooSlow(step: step) }
        reading = nil
        try await current.value
    }

    /// Resumes a continuation once: whichever of the read and the time limit comes first.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done: CheckedContinuation<Bool, Never>?
        init(_ c: CheckedContinuation<Bool, Never>) { done = c }
        func resume(_ value: Bool) {
            lock.lock(); let c = done; done = nil; lock.unlock()
            c?.resume(returning: value)
        }
    }

    func start() {
        loop?.cancel()
        gate.reset()
        loop = Task { [weak self] in
            var failures = 0
            var first = true
            let began = Date()
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    try await self.readInTime()
                    failures = 0
                    if first { first = false; AppLog.write(String(format: "screen share: first read after %.1f s", Date().timeIntervalSince(began))) }
                } catch let e as ShareEnded {
                    // Stopped (switched away from) while this read was on its way: the share it would end is gone.
                    if !Task.isCancelled { self.end(e.why) }
                    return
                } catch {
                    if Task.isCancelled { return }
                    // The domain and code only: never what is on the screen.
                    if let slow = error as? ReadTooSlow {
                        AppLog.write("screen share: a read took over \(Int(self.readLimit)) s (\(slow.step))")
                    } else {
                        let e = error as NSError
                        AppLog.write("screen share: a read failed (\(e.domain) \(e.code))")
                    }
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
        reading?.cancel()
        reading = nil
    }

    private func end(_ why: String) {
        loop = nil
        stopped(why)
    }

    struct ShareEnded: Error { let why: String }

    private func readOnce() async throws {
        guard CGPreflightScreenCaptureAccess() else { throw ShareEnded(why: "Screen Recording is off for Alotbot, so sharing stopped.") }
        step = "listing windows"
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
            let info = content.windows.map { w in
                ShareTarget.WindowInfo(id: w.windowID, pid: w.owningApplication?.processID, app: w.owningApplication?.applicationName ?? "",
                                       bundleId: w.owningApplication?.bundleIdentifier ?? "", title: w.title ?? "")
            }
            let hidden = Set(ShareTarget.hiddenWindows(info, me: ProcessInfo.processInfo.processIdentifier))
            filter = SCContentFilter(display: d, excludingWindows: content.windows.filter { hidden.contains($0.windowID) })
        }
        step = "capturing"
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        step = "reading text"
        let text = try await Task.detached(priority: .utility) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: image).perform([request])
            return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        }.value
        let retitled = title != lastTitle
        guard let changed = gate.accept(text, at: Date().timeIntervalSinceReferenceDate) ?? (retitled ? ScreenTextGate.normalize(text) : nil) else { return }
        step = "sending"
        var args: [String: Any] = ["text": changed, "title": title]
        if let shot = try? Self.save(image) { args["screenshot"] = shot }
        // Not taken in (too soon for the backend): it is not counted as sent, so the next read sends it again.
        if try await send(args) { lastTitle = title } else { gate.reset() }
    }

    /// Saves a screenshot (readable only by you) for an agent to look at; keeps the newest few.
    static func save(_ image: CGImage) throws -> String {
        let dir = DataFolder.location.appendingPathComponent("artifacts")
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
