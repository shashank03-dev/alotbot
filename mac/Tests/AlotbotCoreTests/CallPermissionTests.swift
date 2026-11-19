import Foundation
import Testing
@testable import AlotbotCore

@Suite struct CallPermissionTests {
    @Test @MainActor func firstCallRequestsOnceAndKeepsViewingEnabledAcrossRelaunch() throws {
        let name = "permissions-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var screen = false, access = false, screenRequests = 0, accessRequests = 0
        func prepare(_ setup: CallPermissionSetup) -> CallPermissionState {
            setup.prepare(screenAllowed: { screen }, requestScreen: { screenRequests += 1; screen = true }, accessibilityAllowed: { access }, requestAccessibility: { accessRequests += 1; access = true })
        }
        let first = prepare(CallPermissionSetup(defaults: prefs))
        #expect(first.viewingEnabled && first.screenAvailable && first.accessibilityAvailable)
        _ = prepare(CallPermissionSetup(defaults: prefs))
        #expect(screenRequests == 1 && accessRequests == 1)
        #expect(prefs.bool(forKey: "backgroundAppViewing"))
        // OS revocation must not be mistaken for a cached grant or cause another prompt.
        screen = false; access = false
        let revoked = prepare(CallPermissionSetup(defaults: prefs))
        #expect(!revoked.screenAvailable && !revoked.accessibilityAvailable)
        #expect(screenRequests == 1 && accessRequests == 1)
    }

    @Test @MainActor func denialDoesNotLoopAndLaterSettingsGrantIsRecognized() throws {
        let name = "permissions-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var allowed = false, requests = 0
        let setup = CallPermissionSetup(defaults: prefs)
        func prepare() -> CallPermissionState {
            setup.prepare(screenAllowed: { allowed }, requestScreen: { requests += 1 }, accessibilityAllowed: { allowed }, requestAccessibility: { requests += 1 })
        }
        let denied = prepare()
        #expect(denied.viewingEnabled && !denied.screenAvailable && !denied.accessibilityAvailable)
        _ = prepare()
        #expect(requests == 2)
        allowed = true
        let granted = prepare()
        #expect(granted.screenAvailable && granted.accessibilityAvailable)
        #expect(requests == 2)
    }

    @Test @MainActor func existingGrantNeedsNoPromptAndExplicitViewingOffIsPreserved() throws {
        let name = "permissions-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        prefs.set(false, forKey: "backgroundAppViewing")
        let setup = CallPermissionSetup(defaults: prefs)
        var requests = 0
        let state = setup.prepare(screenAllowed: { false }, requestScreen: { requests += 1 }, accessibilityAllowed: { true }, requestAccessibility: { requests += 1 })
        #expect(!state.viewingEnabled && requests == 0)
        #expect(!prefs.bool(forKey: "backgroundAppViewing"))
        prefs.set(true, forKey: "backgroundAppViewing")
        _ = setup.prepare(screenAllowed: { true }, requestScreen: { requests += 1 }, accessibilityAllowed: { true }, requestAccessibility: { requests += 1 })
        #expect(requests == 0)
        _ = setup.prepare(screenAllowed: { false }, requestScreen: { requests += 1 }, accessibilityAllowed: { false }, requestAccessibility: { requests += 1 })
        #expect(requests == 0)
    }

    @Test @MainActor func turnOnPromptsOnlyOnceAndSharesTheCallFlag() throws {
        let name = "permissions-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        let setup = CallPermissionSetup(defaults: prefs)
        #expect(setup.claimPrompt(screen: true) && !setup.claimPrompt(screen: true))
        #expect(setup.claimPrompt(screen: false) && !setup.claimPrompt(screen: false))
        // A call that already asked counts too: the button must not show a second macOS prompt.
        let other = "permissions-\(UUID())"
        let called = try #require(UserDefaults(suiteName: other))
        defer { called.removePersistentDomain(forName: other) }
        let afterCall = CallPermissionSetup(defaults: called)
        _ = afterCall.prepare(screenAllowed: { false }, requestScreen: {}, accessibilityAllowed: { false }, requestAccessibility: {})
        #expect(!afterCall.claimPrompt(screen: true) && !afterCall.claimPrompt(screen: false))
    }

    @Test func eachPermissionOpensItsOwnSettingsPage() {
        #expect(MacPermission.allCases.map(\.settingsURL.absoluteString) == [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ])
    }

    @Test func relaunchWaitsForTheOldCopyToExitThenOpensTheApp() throws {
        // A stand-in "app" that records it was opened, and a stand-in old process that exits after a moment.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let old = try Process.run(URL(fileURLWithPath: "/bin/sleep"), arguments: ["1"])
        var args = Relaunch.arguments(pid: old.processIdentifier, app: dir.appendingPathComponent("Fake App.app").path)
        #expect(args[2].hasSuffix("Fake App.app"))
        // Swap the real `open` for one that writes a marker, keeping the wait loop under test.
        let marker = dir.appendingPathComponent("opened")
        args[1] = args[1].replacingOccurrences(of: "exec /usr/bin/open \"$0\"", with: "test -n \"$0\" && touch '\(marker.path)'")
        let start = Date()
        let waiter = try Process.run(URL(fileURLWithPath: "/bin/sh"), arguments: args)
        waiter.waitUntilExit()
        #expect(!old.isRunning)
        #expect(Date().timeIntervalSince(start) >= 0.5)
        #expect(FileManager.default.fileExists(atPath: marker.path))
    }

    @Test @MainActor func accessibilityIsNeverAskedWhereTheWindowToolsCannotRun() throws {
        let name = "permissions-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var screenRequests = 0, accessRequests = 0
        let setup = CallPermissionSetup(defaults: prefs)
        for _ in 0..<2 {
            _ = setup.prepare(screenAllowed: { false }, requestScreen: { screenRequests += 1 }, accessibilityAllowed: { false }, requestAccessibility: { accessRequests += 1 }, accessibilityUsable: false)
        }
        #expect(screenRequests == 1 && accessRequests == 0)
    }
}
