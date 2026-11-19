import AppKit
import Foundation
import Testing
import AlotbotCore
@testable import Alotbot

@Suite struct CallSetupTests {
    @Test @MainActor func joinRunsPermissionSetupBeforeMicrophoneAndDoesNotRepeatAfterRelaunch() async throws {
        _ = NSApplication.shared
        let name = "first-call-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var events: [String] = []
        func tools() -> MacTools {
            MacTools(defaults: prefs, screenAllowed: { false }, requestScreen: { events.append("screen") }, accessibilityAllowed: { false }, requestAccessibility: { events.append("accessibility") })
        }
        let first = AppModel(demo: true, macTools: tools(), requestMicrophone: { events.append("microphone"); return false })
        first.picked = []
        await first.join()
        #expect(events.isEmpty, "Choosing no bots must not ask for permissions")
        first.picked = ["verification"]
        await first.join()
        #expect(events == ["screen", "accessibility", "microphone"])
        #expect(first.macTools.observationEnabled)
        #expect(!first.joining)
        await first.join()
        #expect(events == ["screen", "accessibility", "microphone", "microphone"])
        let next = AppModel(demo: true, macTools: tools(), requestMicrophone: { events.append("microphone"); return false })
        next.picked = ["verification"]
        await next.join()
        #expect(events == ["screen", "accessibility", "microphone", "microphone", "microphone"])
        #expect(next.macTools.observationEnabled, "The default must persist without caching a fake OS grant")
        #expect(next.macTools.error?.contains("macOS has not granted") == true)
    }

    @Test @MainActor func explicitSettingsChoicesPersistAndDoNotTriggerAutomaticRequests() throws {
        let name = "permission-settings-\(UUID())"
        let prefs = try #require(UserDefaults(suiteName: name))
        defer { prefs.removePersistentDomain(forName: name) }
        var allowed = false, requests = 0
        let tools = MacTools(defaults: prefs, screenAllowed: { allowed }, requestScreen: { requests += 1 }, accessibilityAllowed: { true }, requestAccessibility: { Issue.record("Already allowed") })
        tools.setObservationEnabled(true)
        #expect(requests == 1 && tools.observationEnabled)
        #expect(tools.error != nil)
        tools.prepareForCall()
        #expect(requests == 1)
        allowed = true
        tools.prepareForCall()
        #expect(tools.error == nil && tools.observationEnabled)
        tools.setObservationEnabled(false)
        tools.prepareForCall()
        #expect(!tools.observationEnabled && tools.error == nil)
        let relaunched = MacTools(defaults: prefs, screenAllowed: { false }, requestScreen: { requests += 1 }, accessibilityAllowed: { true }, requestAccessibility: {})
        relaunched.prepareForCall()
        #expect(!relaunched.observationEnabled && requests == 1)
    }
}
