import Foundation
import Testing
@testable import Alotbot

@Suite struct MigrationTests {
    /// A fresh temp folder per test, with the old and new data folders inside it (not created yet).
    private func sandbox() throws -> (root: URL, old: URL, new: URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("migration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return (root, root.appendingPathComponent("GrokCall", isDirectory: true), root.appendingPathComponent("Alotbot", isDirectory: true))
    }

    private func makeFolder(_ url: URL, file: String) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try Data("kept".utf8).write(to: url.appendingPathComponent(file))
    }

    @Test func onlyTheOldFolderIsMovedToTheNewName() throws {
        let (root, old, new) = try sandbox()
        defer { try? FileManager.default.removeItem(at: root) }
        try makeFolder(old, file: "app.log")

        let decision = FolderMigration.decide(old: old, new: new, fileManager: .default)

        #expect(decision == FolderMigration.Decision(folder: new, outcome: .moved))
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(try String(contentsOf: new.appendingPathComponent("app.log"), encoding: .utf8) == "kept")
    }

    /// The installer deleted Grok Call.app while it ran; its backend then made a new GrokCall folder next to the moved
    /// one. While Grok Call runs, the folder is not moved: it moves on a later launch.
    @Test func theFolderIsNotMovedWhileGrokCallRuns() throws {
        let (root, old, new) = try sandbox()
        defer { try? FileManager.default.removeItem(at: root) }
        try makeFolder(old, file: "auth.json")

        let waiting = FolderMigration.decide(old: old, new: new, fileManager: .default, oldAppRunning: { true })
        #expect(waiting == FolderMigration.Decision(folder: old, outcome: .oldAppRunning))
        #expect(FileManager.default.fileExists(atPath: old.appendingPathComponent("auth.json").path))
        #expect(!FileManager.default.fileExists(atPath: new.path))

        let later = FolderMigration.decide(old: old, new: new, fileManager: .default, oldAppRunning: { false })
        #expect(later == FolderMigration.Decision(folder: new, outcome: .moved))
        #expect(FileManager.default.fileExists(atPath: new.appendingPathComponent("auth.json").path))
        #expect(FolderMigration.grokCallBundleId == "me.shashankdev.grokcall")
        // Already moved, and a running Grok Call made a new GrokCall folder: Alotbot is still the one used.
        try makeFolder(old, file: "app.log")
        var asked = false
        let after = FolderMigration.decide(old: old, new: new, fileManager: .default, oldAppRunning: { asked = true; return true })
        #expect(after == FolderMigration.Decision(folder: new, outcome: .inPlace))
        #expect(!asked, "nothing to move: no need to ask")
    }

    /// While Grok Call ran, Alotbot opened on the GrokCall folder too: two backends on one folder ring every standing
    /// call twice and refresh one sign-in from two places. Now it asks to quit Grok Call, moves once it has, and does not
    /// open at all while Grok Call keeps running.
    @Test func grokCallIsQuitBeforeTheMoveAndAlotbotDoesNotOpenBesideIt() throws {
        let (root, old, new) = try sandbox()
        defer { try? FileManager.default.removeItem(at: root) }
        try makeFolder(old, file: "auth.json")

        // You quit it: the folder moves.
        var running = true
        var asked = 0
        let quit = FolderMigration.decide(old: old, new: new, fileManager: .default, oldAppRunning: { running }, quitOldApp: { asked += 1; running = false; return true })
        #expect(quit == FolderMigration.Decision(folder: new, outcome: .moved))
        #expect(asked == 1)
        #expect(LaunchMigration.mayLaunch(quit.outcome))

        // You said not now, or it did not quit: nothing moves, and Alotbot does not open beside it.
        try FileManager.default.moveItem(at: new, to: old)
        let declined = FolderMigration.decide(old: old, new: new, fileManager: .default, oldAppRunning: { true }, quitOldApp: { false })
        #expect(declined == FolderMigration.Decision(folder: old, outcome: .oldAppRunning))
        let stuck = FolderMigration.decide(old: old, new: new, fileManager: .default, oldAppRunning: { true }, quitOldApp: { true })
        #expect(stuck == FolderMigration.Decision(folder: old, outcome: .oldAppRunning))
        #expect(!FileManager.default.fileExists(atPath: new.path))
        #expect(!LaunchMigration.mayLaunch(.oldAppRunning))

        // Not running, or nothing to move: never asked.
        var bothered = false
        #expect(FolderMigration.decide(old: old, new: new, fileManager: .default, oldAppRunning: { false }, quitOldApp: { bothered = true; return true }).outcome == .moved)
        #expect(FolderMigration.decide(old: old, new: new, fileManager: .default, oldAppRunning: { true }, quitOldApp: { bothered = true; return true }).outcome == .inPlace)
        #expect(!bothered)
        for outcome in [FolderMigration.Outcome.moved, .movedAfterSettingAside("x"), .inPlace, .failed("x")] { #expect(LaunchMigration.mayLaunch(outcome)) }
    }

    @Test func onlyTheNewFolderIsUsedAsItIs() throws {
        let (root, old, new) = try sandbox()
        defer { try? FileManager.default.removeItem(at: root) }
        try makeFolder(new, file: "host-photo.png")

        let decision = FolderMigration.decide(old: old, new: new, fileManager: .default)

        #expect(decision == FolderMigration.Decision(folder: new, outcome: .inPlace))
        #expect(FileManager.default.fileExists(atPath: new.appendingPathComponent("host-photo.png").path))
    }

    @Test func whenBothExistNothingIsMovedOrDeleted() throws {
        let (root, old, new) = try sandbox()
        defer { try? FileManager.default.removeItem(at: root) }
        try makeFolder(old, file: "old.log")
        try makeFolder(new, file: "new.log")

        let decision = FolderMigration.decide(old: old, new: new, fileManager: .default)

        #expect(decision == FolderMigration.Decision(folder: new, outcome: .inPlace))
        #expect(FileManager.default.fileExists(atPath: old.appendingPathComponent("old.log").path))
        #expect(FileManager.default.fileExists(atPath: new.appendingPathComponent("new.log").path))
    }

    /// Local run of 2026-11-19: a test run made an Alotbot folder (logs, artifacts) before the first launch, so the
    /// move was skipped and the app started with none of your calls.
    @Test func anAlotbotFolderWithNoDataIsSetAsideAndTheOldOneMovedIn() throws {
        let (root, old, new) = try sandbox()
        defer { try? FileManager.default.removeItem(at: root) }
        try makeFolder(old, file: "auth.json")
        try makeFolder(old.appendingPathComponent("calls"), file: "call-2026-11-18T18-11-02Z.md")
        try makeFolder(new.appendingPathComponent("artifacts"), file: "screen-1.png")

        let decision = FolderMigration.decide(old: old, new: new, fileManager: .default, now: Date(timeIntervalSince1970: 1_795_000_000))

        let spare = root.appendingPathComponent("Alotbot.unused-1795000000", isDirectory: true)
        #expect(decision == FolderMigration.Decision(folder: new, outcome: .movedAfterSettingAside(spare.path)))
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(FileManager.default.fileExists(atPath: new.appendingPathComponent("calls/call-2026-11-18T18-11-02Z.md").path))
        #expect(FileManager.default.fileExists(atPath: spare.appendingPathComponent("artifacts/screen-1.png").path), "set aside, never deleted")
    }

    @Test func anAlotbotFolderWithDataIsNeverReplaced() throws {
        let (root, old, new) = try sandbox()
        defer { try? FileManager.default.removeItem(at: root) }
        try makeFolder(old, file: "auth.json")
        try makeFolder(new.appendingPathComponent("calls"), file: "call-2026-11-20T09-00-00Z.md")

        let decision = FolderMigration.decide(old: old, new: new, fileManager: .default)

        #expect(decision == FolderMigration.Decision(folder: new, outcome: .inPlace))
        #expect(FileManager.default.fileExists(atPath: old.appendingPathComponent("auth.json").path))
        #expect(FileManager.default.fileExists(atPath: new.appendingPathComponent("calls/call-2026-11-20T09-00-00Z.md").path))
    }

    @Test func settingTheEmptyFolderAsideCanFailWithoutLosingAnything() throws {
        let (root, old, new) = try sandbox()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
            try? FileManager.default.removeItem(at: root)
        }
        try makeFolder(old, file: "auth.json")
        try makeFolder(new, file: "app.log")
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: root.path)

        let decision = FolderMigration.decide(old: old, new: new, fileManager: .default)

        guard case .failed = decision.outcome else { Issue.record("Expected a failed move, got \(decision.outcome)"); return }
        #expect(decision.folder == old, "keeps using the folder with your data")
        #expect(FileManager.default.fileExists(atPath: old.appendingPathComponent("auth.json").path))
        #expect(FileManager.default.fileExists(atPath: new.appendingPathComponent("app.log").path))
    }

    /// mac/test.sh points the app at a temp folder, so no test can read, create or move your real data folder.
    @Test func theTestsNeverUseTheRealDataFolder() throws {
        let override = try #require(ProcessInfo.processInfo.environment["ALOTBOT_DATA_DIR"])
        #expect(DataFolder.location.path == URL(fileURLWithPath: override).path)
        #expect(DataFolder.migration.outcome == .inPlace)
        #expect(!DataFolder.location.path.contains("/Library/Application Support/"))
    }

    /// Grok Call's backend can outlive the app by a moment; its id is noted while it is still a child, then waited for.
    @Test func aChildProcessIsFoundAndItsExitIsSeen() throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        defer { if child.isRunning { child.terminate() } }
        let pid = child.processIdentifier
        #expect(ProcessTree.children(of: getpid()).contains(pid))
        #expect(ProcessTree.isRunning(pid))
        child.terminate()
        child.waitUntilExit()
        #expect(!ProcessTree.isRunning(pid))
        #expect(ProcessTree.children(of: -1).isEmpty)
    }

    @Test func whenNeitherExistsNothingIsCreatedHere() throws {
        let (root, old, new) = try sandbox()
        defer { try? FileManager.default.removeItem(at: root) }

        let decision = FolderMigration.decide(old: old, new: new, fileManager: .default)

        #expect(decision == FolderMigration.Decision(folder: new, outcome: .inPlace))
        #expect(!FileManager.default.fileExists(atPath: new.path))
        #expect(!FileManager.default.fileExists(atPath: old.path))
    }

    @Test func aFailedMoveKeepsTheOldFolderAndItsData() throws {
        let (root, old, new) = try sandbox()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
            try? FileManager.default.removeItem(at: root)
        }
        try makeFolder(old, file: "app.log")
        // A parent that can't be written to makes the rename fail.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: root.path)

        let decision = FolderMigration.decide(old: old, new: new, fileManager: .default)

        guard case .failed(let reason) = decision.outcome else {
            Issue.record("Expected a failed move, got \(decision.outcome)")
            return
        }
        #expect(!reason.isEmpty)
        #expect(decision.folder == old)
        #expect(try String(contentsOf: old.appendingPathComponent("app.log"), encoding: .utf8) == "kept")
        #expect(!FileManager.default.fileExists(atPath: new.path))
    }

    @Test func copiesOnlyTheKeysTheNewAppHasNotSet() throws {
        let oldName = "settings-old-\(UUID())", newName = "settings-new-\(UUID())"
        let old = try #require(UserDefaults(suiteName: oldName)), new = try #require(UserDefaults(suiteName: newName))
        defer { old.removePersistentDomain(forName: oldName); new.removePersistentDomain(forName: newName) }
        old.setPersistentDomain(["orbCenter": "left", "backgroundAppViewing": false], forName: oldName)
        new.set("right", forKey: "orbCenter")

        let copied = SettingsMigration.run(from: old, domain: oldName, to: new)

        #expect(copied == 1)
        #expect(new.string(forKey: "orbCenter") == "right")
        #expect(new.object(forKey: "backgroundAppViewing") as? Bool == false)
        #expect(new.bool(forKey: SettingsMigration.flag))
    }

    @Test func runsOnceAndLeavesLaterChangesAlone() throws {
        let oldName = "settings-old-\(UUID())", newName = "settings-new-\(UUID())"
        let old = try #require(UserDefaults(suiteName: oldName)), new = try #require(UserDefaults(suiteName: newName))
        defer { old.removePersistentDomain(forName: oldName); new.removePersistentDomain(forName: newName) }
        old.setPersistentDomain(["openingBots": "a"], forName: oldName)
        #expect(SettingsMigration.run(from: old, domain: oldName, to: new) == 1)
        new.removeObject(forKey: "openingBots")
        old.setPersistentDomain(["openingBots": "b", "newKey": "c"], forName: oldName)

        let second = SettingsMigration.run(from: old, domain: oldName, to: new)

        #expect(second == 0)
        #expect(new.object(forKey: "openingBots") == nil)
    }

    @Test func emptyOldSettingsStillSetTheFlag() throws {
        let oldName = "settings-old-\(UUID())", newName = "settings-new-\(UUID())"
        let old = try #require(UserDefaults(suiteName: oldName)), new = try #require(UserDefaults(suiteName: newName))
        defer { old.removePersistentDomain(forName: oldName); new.removePersistentDomain(forName: newName) }

        #expect(SettingsMigration.run(from: old, domain: oldName, to: new) == 0)
        #expect(new.bool(forKey: SettingsMigration.flag))
    }
}
