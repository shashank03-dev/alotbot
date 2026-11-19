import AppKit
import ScreenCaptureKit
import Testing
import AlotbotCore
@testable import Alotbot

/// Explicit live acceptance test. Reads existing windows only; no browser launches or navigation.
@Suite struct ExistingBrowserTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["GROK_TEST_EXISTING_BROWSERS"] == "1", "Opt-in: reads the user's currently open browser windows"))
    @MainActor func capturesExistingBrowserWindowsWithoutLaunchingOrChangingFocus() async throws {
        _ = NSApplication.shared // initialize the AppKit/WindowServer connection in this standalone test runner
        #expect(CGPreflightScreenCaptureAccess(), "Screen Recording permission is required")
        let known = Set(["app.zen-browser.zen", "com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.Browser"])
        let apps = NSWorkspace.shared.runningApplications.filter { known.contains($0.bundleIdentifier ?? "") }
        #expect(!apps.isEmpty, "Open a browser in its normal user profile before this live test")
        let beforePIDs = Set(apps.map(\.processIdentifier))
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let windows = content.windows.filter { beforePIDs.contains($0.owningApplication?.processID ?? -1) && WindowSelection.isContentWindow(width: $0.frame.width, height: $0.frame.height, layer: $0.windowLayer) }
        #expect(!windows.isEmpty)
        var results: [[String: Any]] = []
        for window in windows {
            let owner = try #require(window.owningApplication)
            let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let input: [String: Any] = ["id": UUID().uuidString, "tool": "mac_observe", "input": ["operation": "read", "app": owner.bundleIdentifier, "windowId": window.windowID]]
            let command = try JSONDecoder().decode(LocalToolCommand.self, from: JSONSerialization.data(withJSONObject: input))
            let text = try await AppObservation.run(command.input, enabled: true)
            let result = try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
            #expect(result["status"] as? String == "captured")
            let identity = try #require(result["window"] as? [String: Any])
            #expect(identity["bundle"] as? String == owner.bundleIdentifier)
            #expect((identity["id"] as? NSNumber)?.uint32Value == window.windowID)
            #expect(NSWorkspace.shared.frontmostApplication?.processIdentifier == foreground)
            let after = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            let titleUnchanged = after.windows.first(where: { $0.windowID == window.windowID })?.title == identity["title"] as? String // Live pages can change independently after the snapshot.
            #expect(Set(NSWorkspace.shared.runningApplications.filter { known.contains($0.bundleIdentifier ?? "") }.map(\.processIdentifier)) == beforePIDs, "Observation must not launch a browser")
            results.append(["bundle": owner.bundleIdentifier, "windowId": window.windowID, "onScreen": window.isOnScreen, "ocrCharacters": (result["text"] as? String)?.count ?? 0, "screenshot": result["screenshot"] ?? "", "focusPreserved": true, "windowTitleUnchangedAfterCapture": titleUnchanged])
        }
        // No page text, URLs or titles enter the report. Screenshots stay in the private artifacts folder.
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("grok-existing-browser-proof.json")
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
