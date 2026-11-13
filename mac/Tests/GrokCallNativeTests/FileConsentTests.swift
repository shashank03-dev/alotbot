import Foundation
import Testing
@testable import GrokCall

@Suite @MainActor struct FileConsentTests {
    @Test func firstLaunchAsksOnceAndRemembersDecline() throws {
        let name = "file-consent-\(UUID())", defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var asked = 0
        func tools() -> MacTools { MacTools(defaults: defaults, requestFileConsent: { asked += 1; return false }) }
        let first = tools()
        first.requestFileAccessIfNeeded(); first.requestFileAccessIfNeeded()
        #expect(asked == 1 && first.folder == nil)
        tools().requestFileAccessIfNeeded()
        #expect(asked == 1)
    }
    @Test func approvalPersistsBroadReadAccessAndRevocationDoesNotReprompt() throws {
        let name = "file-consent-\(UUID())", defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let first = MacTools(defaults: defaults, requestFileConsent: { true })
        first.requestFileAccessIfNeeded()
        #expect(first.folder?.path == "/")
        let next = MacTools(defaults: defaults, requestFileConsent: { Issue.record("Cannot prompt after approval"); return false })
        #expect(next.folder?.path == "/")
        next.requestFileAccessIfNeeded(); next.forgetFolder()
        let revoked = MacTools(defaults: defaults, requestFileConsent: { Issue.record("Cannot undo a revocation"); return true })
        revoked.requestFileAccessIfNeeded()
        #expect(revoked.folder == nil)
    }
    @Test func existingFolderChoiceIsNotBroadened() throws {
        let name = "file-consent-\(UUID())", defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let tools = MacTools(defaults: defaults, requestFileConsent: { Issue.record("An explicit folder already exists"); return true })
        tools.folder = FileManager.default.temporaryDirectory
        tools.requestFileAccessIfNeeded()
        #expect(tools.folder?.path != "/")
    }
}
