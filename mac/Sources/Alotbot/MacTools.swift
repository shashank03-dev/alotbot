import AVFoundation
import AppKit
import ApplicationServices
import AlotbotCore
import ScreenCaptureKit

/// File access is opt-in at first launch; call permissions and window sharing keep their own scopes.
@MainActor final class MacTools: NSObject, ObservableObject, SCContentSharingPickerObserver {
    @Published var observationEnabled: Bool {
        didSet { preferences.set(observationEnabled, forKey: "backgroundAppViewing") }
    }
    @Published var folder: URL?
    @Published var sharedWindow = "No window shared"
    @Published var error: String?
    @Published private(set) var granted: Set<MacPermission> = []
    private var filter: SCContentFilter?
    private var window: SCWindow?
    private var controls: [String: AXUIElement] = [:]
    private var generation = 0
    private var observing = false
    private let preferences: UserDefaults
    private let permissionSetup: CallPermissionSetup
    private let screenAllowed: () -> Bool
    private let requestScreen: () -> Void
    private let accessibilityAllowed: () -> Bool
    private let requestAccessibility: () -> Void
    private let requestFileConsent: () -> Bool
    private let micStatus: () -> AVAuthorizationStatus
    private let requestMic: () async -> Bool
    private let openSettings: (URL) -> Void
    private let grokBotApp: () -> URL?
    private let reveal: (URL) -> Void
    private let log: (String) -> Void

    init(defaults: UserDefaults = .standard,
         screenAllowed: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() },
         requestScreen: @escaping () -> Void = { _ = CGRequestScreenCaptureAccess() },
         accessibilityAllowed: @escaping () -> Bool = { AXIsProcessTrusted() },
         requestAccessibility: @escaping () -> Void = { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) },
         requestFileConsent: @escaping () -> Bool = { MainActor.assumeIsolated { MacTools.showFileConsent() } },
         micStatus: @escaping () -> AVAuthorizationStatus = { AVCaptureDevice.authorizationStatus(for: .audio) },
         requestMic: @escaping () async -> Bool = { await AVCaptureDevice.requestAccess(for: .audio) },
         openSettings: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) },
         grokBotApp: @escaping () -> URL? = { NSWorkspace.shared.urlForApplication(withBundleIdentifier: MacTools.grokBotID) },
         reveal: @escaping (URL) -> Void = { NSWorkspace.shared.activateFileViewerSelecting([$0]) },
         log: @escaping (String) -> Void = { AppLog.write($0) }) {
        preferences = defaults
        permissionSetup = CallPermissionSetup(defaults: defaults)
        observationEnabled = defaults.bool(forKey: "backgroundAppViewing")
        self.requestFileConsent = requestFileConsent
        self.micStatus = micStatus; self.requestMic = requestMic; self.openSettings = openSettings
        self.grokBotApp = grokBotApp; self.reveal = reveal; self.log = log
        self.screenAllowed = screenAllowed; self.requestScreen = requestScreen
        self.accessibilityAllowed = accessibilityAllowed; self.requestAccessibility = requestAccessibility
        super.init()
        if let data = preferences.data(forKey: "fileFolderBookmark") {
            var stale = false
            folder = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope], bookmarkDataIsStale: &stale)
            if stale { folder = nil }
            _ = folder?.startAccessingSecurityScopedResource()
        }
        SCContentSharingPicker.shared.add(self)
    }

    func prepareForCall() {
        let state = permissionSetup.prepare(screenAllowed: screenAllowed, requestScreen: requestScreen, accessibilityAllowed: accessibilityAllowed, requestAccessibility: requestAccessibility,
                                            accessibilityUsable: MacTools.windowToolsAvailable)
        observationEnabled = state.viewingEnabled
        error = state.viewingEnabled && !state.screenAvailable ? "macOS has not granted Screen Recording to this running Alotbot build. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording. If already enabled, quit and reopen Alotbot after changing access." : nil
        AppLog.write("permissions: viewing=\(state.viewingEnabled), screen=\(state.screenAvailable), accessibility=\(state.accessibilityAvailable)")
    }

    /// Reads what macOS allows right now. Nothing is cached, so a switch turned off in System Settings shows as off.
    /// Each change since the last check, even one made while Alotbot was closed, goes in the log.
    func refreshPermissions() {
        var now: Set<MacPermission> = []
        if micStatus() == .authorized { now.insert(.microphone) }
        if screenAllowed() { now.insert(.screen) }
        if accessibilityAllowed() { now.insert(.accessibility) }
        if let saved = preferences.stringArray(forKey: "lastPermissions") {
            let before = Set(saved.compactMap(MacPermission.init(rawValue:)))
            for p in MacPermission.allCases where now.contains(p) != before.contains(p) { log("permission \(now.contains(p) ? "on" : "off"): \(p.rawValue)") }
        }
        preferences.set(MacPermission.allCases.filter(now.contains).map(\.rawValue), forKey: "lastPermissions")
        granted = now
    }

    // MARK: Grok Bot's Full Disk Access. Bots' agents run in Grok Bot, so reading protected data (WhatsApp, Mail)
    // needs it there. macOS lets no other app turn it on or even see it, so this only opens the page with Grok Bot shown.

    nonisolated static let grokBotID = "com.anysphere.sand"
    nonisolated static let fullDiskAccessURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
    var grokBotInstalled: Bool { grokBotApp() != nil }

    func openGrokBotDiskAccess() {
        guard let app = grokBotApp() else { return }
        openSettings(Self.fullDiskAccessURL)
        reveal(app)
        log("opened Full Disk Access for Grok Bot")
    }

    // MARK: First-run setup, shown once. Anything not turned on stays off.

    var needsSetup: Bool { !preferences.bool(forKey: "setupDone") }

    func finishSetup() {
        preferences.set(true, forKey: "setupDone")
        preferences.set(true, forKey: "fileReadPermissionRequested") // setup already offered files; no second ask at launch
        refreshPermissions()
        let off = MacPermission.allCases.filter { !granted.contains($0) }.map(\.rawValue) + (folder == nil ? ["files"] : [])
        log("setup done; left off: \(off)")
    }

    /// First time: macOS's own prompt. After that: the System Settings page, where the user decides.
    func turnOn(_ permission: MacPermission) async {
        switch permission {
        case .microphone:
            if micStatus() == .notDetermined { _ = await requestMic() } else { openSettings(permission.settingsURL) }
        case .screen:
            if permissionSetup.claimPrompt(screen: true) { requestScreen() } else { openSettings(permission.settingsURL) }
        case .accessibility:
            if permissionSetup.claimPrompt(screen: false) { requestAccessibility() } else { openSettings(permission.settingsURL) }
        }
        refreshPermissions()
    }

    func setObservationEnabled(_ enabled: Bool) {
        observationEnabled = enabled
        if !enabled { error = nil; return }
        permissionSetup.markScreenRequestAttempted()
        if !screenAllowed() { requestScreen() }
        error = screenAllowed() ? nil : "Allow Alotbot in System Settings → Privacy & Security → Screen & System Audio Recording. If already enabled, quit and reopen Alotbot after changing access."
    }

    static func showFileConsent() -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Allow bots to read local files?"
        alert.informativeText = "Bots in your calls will be able to list and read files across this Mac that your account and macOS permissions allow. File contents they read are sent to the bot service. This enables reading only, not editing or deleting. You can remove access in Settings at any time. Protected data may also require Full Disk Access in macOS Settings."
        alert.addButton(withTitle: "Allow read access")
        alert.addButton(withTitle: "Not now")
        return alert.runModal() == .alertFirstButtonReturn
    }

    func requestFileAccessIfNeeded() {
        guard folder == nil, !preferences.bool(forKey: "fileReadPermissionRequested") else { return }
        requestLocalFileAccess()
    }

    func requestLocalFileAccess() {
        preferences.set(true, forKey: "fileReadPermissionRequested")
        guard requestFileConsent() else { log("files: not allowed"); return }
        setFolder(URL(fileURLWithPath: "/", isDirectory: true))
    }

    private func setFolder(_ url: URL) {
        do {
            let data = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
            folder?.stopAccessingSecurityScopedResource()
            preferences.set(data, forKey: "fileFolderBookmark")
            folder = url
            _ = url.startAccessingSecurityScopedResource()
            log("files on: \(url.path)")
        } catch { self.error = error.localizedDescription }
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.message = "Bots can list and read text files only inside this folder."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        preferences.set(true, forKey: "fileReadPermissionRequested")
        setFolder(url)
    }

    func forgetFolder() {
        preferences.set(true, forKey: "fileReadPermissionRequested")
        if folder != nil { log("files off") }
        folder?.stopAccessingSecurityScopedResource(); folder = nil
        preferences.removeObject(forKey: "fileFolderBookmark")
    }

    /// The window tools (and so Accessibility) need macOS 15.2 or newer.
    static var windowToolsAvailable: Bool { if #available(macOS 15.2, *) { true } else { false } }

    func chooseWindow() {
        guard #available(macOS 15.2, *) else { error = "Window controls need macOS 15.2 or newer."; return }
        let picker = SCContentSharingPicker.shared
        var config = SCContentSharingPickerConfiguration()
        config.allowedPickerModes = [.singleWindow]
        picker.defaultConfiguration = config
        picker.isActive = true
        picker.present()
    }

    func stopSharing() {
        filter = nil; window = nil; controls.removeAll(); sharedWindow = "No window shared"
        SCContentSharingPicker.shared.isActive = false
    }

    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {}
    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) { Task { @MainActor in self.error = error.localizedDescription } }
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task { @MainActor in
            guard #available(macOS 15.2, *), let window = filter.includedWindows.first, filter.includedWindows.count == 1 else { self.error = "Select one window."; return }
            self.filter = filter; self.window = window; self.controls.removeAll()
            self.sharedWindow = window.title ?? "Shared window"
        }
    }

    func run(_ command: LocalToolCommand) async throws -> String {
        if command.tool == "mac_observe" {
            guard !observing else { throw failure("An observation is already running. Wait for its result.") }
            observing = true
            defer { observing = false }
            let result = try await AppObservation.run(command.input, enabled: observationEnabled)
            guard observationEnabled else { throw failure("Background viewing was disabled during capture. The observation was not shared.") }
            return result
        }
        if command.tool == "mac_files" { return try FolderReader.run(root: folder, operation: command.input.operation, path: command.input.path ?? ".") }
        guard command.tool == "mac_window", let window, let filter else { throw failure("Share one window in Alotbot settings first.") }
        if command.input.operation == "capture" {
            guard #available(macOS 14.0, *) else { throw failure("Capture needs macOS 14.") }
            let config = SCStreamConfiguration()
            config.width = max(1, Int(window.frame.width)); config.height = max(1, Int(window.frame.height))
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Alotbot/artifacts")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let file = dir.appendingPathComponent("window-\(UUID().uuidString).png")
            guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw failure("Could not encode the capture.") }
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            return "Screenshot saved: \(file.path). Image interpretation is unavailable on this voice connection."
        }
        guard AXIsProcessTrusted() else {
            throw failure("Allow Alotbot in System Settings → Privacy & Security → Accessibility, then inspect again.")
        }
        guard let app = window.owningApplication else { throw failure("The shared window's app has closed.") }
        let axApp = AXUIElementCreateApplication(app.processID)
        let windows = attribute(axApp, kAXWindowsAttribute) as? [AXUIElement] ?? []
        // Require one title match; ambiguity or a closed window never falls back to another window.
        let matching = windows.filter { (attribute($0, kAXTitleAttribute) as? String ?? "") == (window.title ?? "") }
        guard matching.count == 1 else { controls.removeAll(); throw failure("The shared window closed or cannot be identified uniquely. Share it again.") }
        if command.input.operation == "press" {
            guard let id = command.input.control, let element = controls[id] else { throw failure("Inspect the shared window first and use a current control ID.") }
            controls.removeAll() // a control ID can be pressed once; inspect again for another action
            guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { throw failure("The control could not be pressed; inspect the current state before trying again.") }
        } else if command.input.operation != "inspect" { throw failure("Unknown window operation.") }
        generation += 1
        controls.removeAll()
        var rows: [String] = []
        var visited = 0
        func walk(_ element: AXUIElement, _ depth: Int) {
            guard depth < 20, visited < 500 else { return }
            visited += 1
            let role = attribute(element, kAXRoleAttribute) as? String ?? "control"
            let title = attribute(element, kAXTitleAttribute) as? String ?? attribute(element, kAXDescriptionAttribute) as? String ?? ""
            let id = "\(generation)-\(visited)"
            controls[id] = element
            rows.append("\(id) \(role) \(title.prefix(200))")
            for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child, depth + 1) }
        }
        walk(matching[0], 0)
        return "Window: \(sharedWindow)\n" + rows.joined(separator: "\n")
    }

    private func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
    }
    private func failure(_ text: String) -> NSError { NSError(domain: "Alotbot.Mac", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}
