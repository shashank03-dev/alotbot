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
