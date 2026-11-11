import Foundation
import Testing
import GrokCallCore
@testable import GrokCall

@Suite struct MacToolsTests {
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
        let title = "Grok Call verification \(UUID().uuidString)"
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

@Suite struct ActionHistoryViewTests {
    @Test @MainActor func rendersActionStatesForVisualInspection() throws {
        let model = AppModel()
        model.actions = try ["running", "waiting_approval", "completed", "failed", "unknown"].enumerated().map { i, status in
            let row: [String: Any] = ["id": "action-\(i)", "callId": "test", "botId": "bot", "botName": "Verification bot", "target": i == 0 ? "mac" : "agent", "tool": "Read verification file", "status": status, "createdAt": 1, "updatedAt": 2, "summary": status == "unknown" ? "The connection dropped after dispatch. Verify the outcome before retrying." : "A test action recorded independently of the voice socket.", "approval": ["kind": "local_tool", "requestId": "ask", "summary": "Read proof.txt inside the selected folder", "status": "pending"]]
            return try JSONDecoder().decode(RecordedAction.self, from: JSONSerialization.data(withJSONObject: row))
        }
        let host = NSHostingView(rootView: ActionsView(model: model).padding(18).background(Theme.surface).environment(\.colorScheme, .dark))
        host.frame = NSRect(x: 0, y: 0, width: 380, height: 900)
        host.layoutSubtreeIfNeeded()
        let image = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: image)
        let png = try #require(image.representation(using: .png, properties: [:]))
        #expect(png.count > 1000)
        try png.write(to: URL(fileURLWithPath: "/tmp/grok-actions-ui.png"))
    }
}
