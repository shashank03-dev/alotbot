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
