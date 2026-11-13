import AppKit
import Testing
import GrokCallCore
@testable import GrokCall

/// Opt-in adapter for a live backend/voice test. Executes the production native dispatch.
@Suite struct VoiceCaptureBridgeTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["GROK_CAPTURE_COMMAND"] != nil, "Live native-call adapter only"))
    @MainActor func executesNativeCaptureForLiveCall() async throws {
        _ = NSApplication.shared
        let input = try #require(ProcessInfo.processInfo.environment["GROK_CAPTURE_COMMAND"])
        let output = try #require(ProcessInfo.processInfo.environment["GROK_CAPTURE_RESULT"])
        let command = try JSONDecoder().decode(LocalToolCommand.self, from: Data(contentsOf: URL(fileURLWithPath: input)))
        #expect(command.tool == "mac_observe")
        let tools = MacTools()
        let enabled = tools.observationEnabled
        defer { tools.observationEnabled = enabled }
        tools.observationEnabled = true
        let before = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"
        let result = try await tools.run(command)
        let after = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"
        let context = ["foregroundBefore": before, "foregroundAfter": after]
        try JSONSerialization.data(withJSONObject: context).write(to: URL(fileURLWithPath: output + ".context"), options: .atomic)
        try Data(result.utf8).write(to: URL(fileURLWithPath: output), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output)
    }
}
