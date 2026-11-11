import AppKit
import ApplicationServices
import GrokCallCore
import ScreenCaptureKit

/// Native capabilities are off until the user selects their scope in settings.
@MainActor final class MacTools: NSObject, ObservableObject, SCContentSharingPickerObserver {
    @Published var folder: URL?
    @Published var sharedWindow = "No window shared"
    @Published var error: String?
    private var filter: SCContentFilter?
    private var window: SCWindow?
    private var controls: [String: AXUIElement] = [:]
    private var generation = 0

    override init() {
        super.init()
        if let data = UserDefaults.standard.data(forKey: "fileFolderBookmark") {
            var stale = false
            folder = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope], bookmarkDataIsStale: &stale)
            if stale { folder = nil }
            _ = folder?.startAccessingSecurityScopedResource()
        }
        SCContentSharingPicker.shared.add(self)
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.message = "Bots can list and read text files only inside this folder."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
            folder?.stopAccessingSecurityScopedResource()
            UserDefaults.standard.set(data, forKey: "fileFolderBookmark")
            folder = url
            _ = url.startAccessingSecurityScopedResource()
        } catch { self.error = error.localizedDescription }
    }

    func forgetFolder() {
        folder?.stopAccessingSecurityScopedResource(); folder = nil
        UserDefaults.standard.removeObject(forKey: "fileFolderBookmark")
    }

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
        if command.tool == "mac_files" { return try FolderReader.run(root: folder, operation: command.input.operation, path: command.input.path ?? ".") }
        guard command.tool == "mac_window", let window, let filter else { throw failure("Share one window in Grok Call settings first.") }
        if command.input.operation == "capture" {
            guard #available(macOS 14.0, *) else { throw failure("Capture needs macOS 14.") }
            let config = SCStreamConfiguration()
            config.width = max(1, Int(window.frame.width)); config.height = max(1, Int(window.frame.height))
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("GrokCall/artifacts")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let file = dir.appendingPathComponent("window-\(UUID().uuidString).png")
            guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw failure("Could not encode the capture.") }
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            return "Screenshot saved: \(file.path). Image interpretation is unavailable on this voice connection."
        }
        guard AXIsProcessTrusted() else {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            throw failure("Allow Grok Call in System Settings → Privacy & Security → Accessibility, then inspect again.")
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
    private func failure(_ text: String) -> NSError { NSError(domain: "GrokCall.Mac", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}
