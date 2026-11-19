import AVFoundation
import Foundation
import Testing
import AlotbotCore
@testable import Alotbot

@Suite struct MacToolsTests {
    @Test @MainActor func everyPermissionChangeIsLoggedIncludingOnesMadeWhileClosed() throws {
        let name = "mactools-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var mic = AVAuthorizationStatus.authorized, screen = false, access = true, lines: [String] = []
        func tools() -> MacTools {
            MacTools(defaults: prefs, screenAllowed: { screen }, accessibilityAllowed: { access }, requestFileConsent: { false },
                     micStatus: { mic }, log: { lines.append($0) })
        }
        let first = tools()
        first.refreshPermissions()
        #expect(lines.isEmpty, "the first check has nothing to compare with")
        first.refreshPermissions()
        #expect(lines.isEmpty, "no change, no line")
        screen = true; access = false
        first.refreshPermissions()
        #expect(lines == ["permission on: screen", "permission off: accessibility"])
        // Turned off in System Settings while Alotbot was closed: logged on the next launch.
        lines.removeAll(); mic = .denied
        tools().refreshPermissions()
        #expect(lines == ["permission off: microphone"])
    }

    @Test @MainActor func grokBotFullDiskAccessOpensThePageAndShowsGrokBotOnlyWhenInstalled() throws {
        let name = "mactools-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        let app = URL(fileURLWithPath: "/Applications/Grok Bot.app")
        var installed: URL? = nil, opened: [URL] = [], revealed: [URL] = [], lines: [String] = []
        let tools = MacTools(defaults: prefs, requestFileConsent: { false }, openSettings: { opened.append($0) },
                             grokBotApp: { installed }, reveal: { revealed.append($0) }, log: { lines.append($0) })
        #expect(!tools.grokBotInstalled)
        tools.openGrokBotDiskAccess()
        #expect(opened.isEmpty && revealed.isEmpty && lines.isEmpty)
        installed = app
        #expect(tools.grokBotInstalled)
        tools.openGrokBotDiskAccess()
        #expect(opened == [URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!])
        #expect(revealed == [app])
        #expect(lines == ["opened Full Disk Access for Grok Bot"])
        #expect(MacTools.grokBotID == "com.anysphere.sand")
    }

    @Test @MainActor func setupShowsOnceLogsWhatWasLeftOffAndReplacesTheLaunchFileAlert() throws {
        let name = "mactools-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var consents = 0, lines: [String] = []
        func tools() -> MacTools {
            MacTools(defaults: prefs, screenAllowed: { true }, accessibilityAllowed: { false }, requestFileConsent: { consents += 1; return false },
                     micStatus: { .authorized }, log: { lines.append($0) })
        }
        let first = tools()
        #expect(first.needsSetup)
        first.requestLocalFileAccess() // "Allow all" in setup, then "Not now" in the alert
        #expect(lines == ["files: not allowed"])
        first.finishSetup()
        #expect(lines.last == "setup done; left off: [\"accessibility\", \"files\"]")
        let next = tools()
        #expect(!next.needsSetup, "never shown again")
        next.requestFileAccessIfNeeded()
        #expect(consents == 1, "no second file alert at a later launch")
    }

    @Test @MainActor func filesOnAndOffAreLogged() throws {
        let name = "mactools-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var lines: [String] = []
        let tools = MacTools(defaults: prefs, requestFileConsent: { true }, log: { lines.append($0) })
        tools.forgetFolder()
        #expect(lines.isEmpty, "turning off what was never on logs nothing")
        tools.requestLocalFileAccess()
        tools.forgetFolder()
        #expect(lines == ["files on: /", "files off"])
    }

    @Test @MainActor func permissionRowsReadLiveStateAndTurnOnPromptsOnceThenOpensSettings() async throws {
        let name = "mactools-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var mic = AVAuthorizationStatus.notDetermined, screen = false, access = false
        var micPrompts = 0, screenPrompts = 0, accessPrompts = 0, opened: [URL] = []
        let tools = MacTools(defaults: prefs, screenAllowed: { screen }, requestScreen: { screenPrompts += 1 },
                             accessibilityAllowed: { access }, requestAccessibility: { accessPrompts += 1 },
                             requestFileConsent: { false }, micStatus: { mic }, requestMic: { micPrompts += 1; mic = .denied; return false },
                             openSettings: { opened.append($0) }, log: { _ in })
        tools.refreshPermissions()
        #expect(tools.granted.isEmpty)
        for p in MacPermission.allCases { await tools.turnOn(p) }
        #expect(micPrompts == 1 && screenPrompts == 1 && accessPrompts == 1 && opened.isEmpty)
        // Pressed again after saying no: no second macOS prompt, the Settings page opens instead.
        for p in MacPermission.allCases { await tools.turnOn(p) }
        #expect(micPrompts == 1 && screenPrompts == 1 && accessPrompts == 1)
        #expect(opened == MacPermission.allCases.map(\.settingsURL))
        // Allowed in System Settings shows as on; turned off there shows as off again.
        mic = .authorized; screen = true; access = true
        tools.refreshPermissions()
        #expect(tools.granted == Set(MacPermission.allCases))
        mic = .denied; access = false
        tools.refreshPermissions()
        #expect(tools.granted == [.screen])
    }

    @Test @MainActor func nativeDispatchReadsOnlySelectedFolder() async throws {
        let tools = MacTools()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let nonce = UUID().uuidString
        try nonce.write(to: dir.appendingPathComponent("proof.txt"), atomically: true, encoding: .utf8)
        let command = try JSONDecoder().decode(LocalToolCommand.self, from: Data(#"{"id":"test","tool":"mac_files","input":{"operation":"read","path":"proof.txt"}}"#.utf8))
        tools.folder = nil
        await #expect(throws: (any Error).self) { try await tools.run(command) }
        tools.folder = dir
        #expect(try await tools.run(command) == nonce)
        let window = try JSONDecoder().decode(LocalToolCommand.self, from: Data(#"{"id":"test","tool":"mac_window","input":{"operation":"inspect"}}"#.utf8))
        tools.stopSharing()
        await #expect(throws: (any Error).self) { try await tools.run(window) }
    }
}

import AppKit
import ApplicationServices
import ScreenCaptureKit

@Suite struct SharedWindowTests {
    @Test(.enabled(if: AXIsProcessTrusted() && CGPreflightScreenCaptureAccess(), "Needs Accessibility and screen capture access")) @MainActor func realSharedWindowInspectPressCaptureAndClosedWindow() async throws {
        guard #available(macOS 15.2, *) else { throw NSError(domain: "Test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Window tools require macOS 15.2"]) }
        let title = "Alotbot verification \(UUID().uuidString)"
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/Window.swift")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/swift")
        process.arguments = [fixture.path, title]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate() } }
        var selected: SCWindow?
        for _ in 0..<100 {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            selected = content.windows.first { $0.title == title && $0.owningApplication?.processID == process.processIdentifier }
            if selected != nil { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let chosen = try #require(selected)
        let tools = MacTools()
        tools.contentSharingPicker(.shared, didUpdateWith: SCContentFilter(desktopIndependentWindow: chosen), for: nil)
        await Task.yield()
        func command(_ operation: String, control: String? = nil) throws -> LocalToolCommand {
            var input = ["operation": operation]
            if let control { input["control"] = control }
            let data = try JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "tool": "mac_window", "input": input])
            return try JSONDecoder().decode(LocalToolCommand.self, from: data)
        }
        let tree = try await tools.run(command("inspect"))
        let line = try #require(tree.split(separator: "\n").first { $0.contains("AXButton") && $0.contains("Press verification button") })
        let control = String(try #require(line.split(separator: " ").first))
        let after = try await tools.run(command("press", control: control))
        #expect(after.contains("Press verification button (1)"))
        await #expect(throws: (any Error).self) { try await tools.run(command("press", control: control)) }
        let result = try await tools.run(command("capture"))
        #expect(result.hasPrefix("Screenshot saved:"))
        let filePath = String(result.dropFirst("Screenshot saved: ".count).components(separatedBy: ". Image interpretation")[0])
        #expect(FileManager.default.fileExists(atPath: filePath))
        try FileManager.default.removeItem(atPath: filePath)
        process.terminate()
        process.waitUntilExit()
        try await Task.sleep(nanoseconds: 100_000_000)
        await #expect(throws: (any Error).self) { try await tools.run(command("inspect")) }
        tools.stopSharing()
    }
}

import SwiftUI

@Suite struct ApprovalsViewTests {
    /// Only actions still waiting for your OK are shown, oldest first, and a bot's card shows only its own.
    @Test @MainActor func showsOnlyWhatStillNeedsYourOK() throws {
        let model = AppModel()
        model.actions = try [("running", "a", 5), ("waiting_approval", "b", 3), ("completed", "a", 1), ("waiting_approval", "a", 4), ("waiting_approval", "a", 2)].enumerated().map { i, x in
            let row: [String: Any] = ["id": "action-\(i)", "callId": "test", "botId": x.1, "botName": "Bot \(x.1)", "target": "agent", "tool": "Read file", "status": x.0, "createdAt": x.2, "updatedAt": 9,
                                      "approval": ["kind": i == 4 ? "connector" : "local_tool", "requestId": "ask", "summary": "Read proof.txt", "status": "pending"]]
            return try JSONDecoder().decode(RecordedAction.self, from: JSONSerialization.data(withJSONObject: row))
        }
        #expect(model.approvals().map(\.id) == ["action-1", "action-3"], "connector grants are answered in Grok Bot, not here")
        #expect(model.approvals(for: "a").map(\.id) == ["action-3"])
        #expect(model.approvals(for: "zzz").isEmpty)
        let host = NSHostingView(rootView: ApprovalsView(model: model).padding(18).frame(width: 360).background(Theme.chrome).environment(\.colorScheme, .dark))
        host.frame = NSRect(x: 0, y: 0, width: 360, height: 400)
        host.layoutSubtreeIfNeeded()
        let image = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: image)
        #expect(try #require(image.representation(using: .png, properties: [:])).count > 1000)
    }
}

@Suite struct BackgroundObservationTests {
    @Test @MainActor func refusesObservationUntilEnabled() async throws {
        let tools = MacTools()
        let previous = tools.observationEnabled
        defer { tools.observationEnabled = previous }
        tools.observationEnabled = false
        let command = try JSONDecoder().decode(LocalToolCommand.self, from: Data(#"{"id":"observation","tool":"mac_observe","input":{"operation":"read","app":"Zen"}}"#.utf8))
        do {
            _ = try await tools.run(command)
            Issue.record("Observation must require explicit enablement")
        } catch { #expect(error.localizedDescription.contains("Background app viewing is off")) }
    }

    @Test(.enabled(if: CGPreflightScreenCaptureAccess(), "Needs screen recording permission")) @MainActor func capturesBackgroundWindowWithoutChangingFocus() async throws {
        let title = "Observation proof \(UUID().uuidString)"
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/Window.swift")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/swift")
        process.arguments = [fixture.path, title, "--background"]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate() } }
        var selected: SCWindow?
        for _ in 0..<100 {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            selected = content.windows.first { $0.title == title && $0.owningApplication?.processID == process.processIdentifier }
            if selected != nil { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let window = try #require(selected)
        let owner = try #require(window.owningApplication)
        func command(_ operation: String, app: String = owner.applicationName) throws -> LocalToolCommand {
            let data = try JSONSerialization.data(withJSONObject: ["id": "proof", "tool": "mac_observe", "input": ["operation": operation, "app": app, "windowId": window.windowID]])
            return try JSONDecoder().decode(LocalToolCommand.self, from: data)
        }
        // Wait until the fixture has entered its event loop before measuring capture.
        try await Task.sleep(nanoseconds: 500_000_000)
        let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let response = try await AppObservation.run(command("read").input, enabled: true)
        let result = try #require(JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any])
        #expect(result["status"] as? String == "captured")
        #expect((result["text"] as? String)?.contains("Press verification button") == true)
        #expect(NSWorkspace.shared.frontmostApplication?.processIdentifier == foreground)
        let path = try #require(result["screenshot"] as? String)
        defer { try? FileManager.default.removeItem(atPath: path) }
        #expect((try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let missing = try await AppObservation.run(command("read", app: "No such app \(UUID())").input, enabled: true)
        #expect(missing.contains("not_found"))
        let batchText = try await AppObservation.run(command("read_all").input, enabled: true)
        let batch = try #require(JSONSerialization.jsonObject(with: Data(batchText.utf8)) as? [String: Any])
        #expect(batch["capturedCount"] as? Int == 1)
        let captures = try #require(batch["windows"] as? [[String: Any]])
        #expect((captures.first?["text"] as? String)?.contains("Press verification button") == true)
        if let artifact = captures.first?["screenshot"] as? String { try FileManager.default.removeItem(atPath: artifact) }
        await #expect(throws: (any Error).self) { try await AppObservation.run(command("invalid").input, enabled: true) }
        await #expect(throws: (any Error).self) { try await AppObservation.run(command("read", app: "").input, enabled: true) }

        let listed = try await AppObservation.run(command("list").input, enabled: true)
        #expect(listed.contains(title))
        process.terminate(); process.waitUntilExit()
        let closed = try await AppObservation.run(command("read").input, enabled: true)
        #expect(closed.contains("not_found"))
    }
}
