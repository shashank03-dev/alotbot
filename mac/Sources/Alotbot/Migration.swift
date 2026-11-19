import Foundation

/// Where the app keeps its files: ~/Library/Application Support/Alotbot. Before the rename they lived in GrokCall,
/// and `FolderMigration` moves them once at launch.
enum DataFolder {
    static let name = "Alotbot"
    static let legacyName = "GrokCall"

    /// The folder every file uses: Alotbot, or GrokCall when the move from it failed.
    static var location: URL { migration.folder }

    /// Decided once, on first use. `LaunchMigration.run()` asks before anything else touches the folder.
    static let migration: FolderMigration.Decision = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return FolderMigration.decide(old: support.appendingPathComponent(legacyName, isDirectory: true),
                                      new: support.appendingPathComponent(name, isDirectory: true),
                                      fileManager: .default)
    }()
}

/// The folder decision. Its only side effect is the one move it may make, so tests can run it on temp folders.
enum FolderMigration {
    enum Outcome: Equatable {
        /// GrokCall was renamed to Alotbot.
        case moved
        /// Alotbot is used and nothing was moved: it already exists, or neither folder exists.
        case inPlace
        /// The move failed, so GrokCall is kept and used. The reason is for the log.
        case failed(String)
    }

    struct Decision: Equatable {
        let folder: URL
        let outcome: Outcome
    }

    static func decide(old: URL, new: URL, fileManager: FileManager) -> Decision {
        // Both folders present: leave both and use the new one. Only the new one, or neither: nothing to move.
        guard !fileManager.fileExists(atPath: new.path), fileManager.fileExists(atPath: old.path) else {
            return Decision(folder: new, outcome: .inPlace)
        }
        do {
            try fileManager.moveItem(at: old, to: new)
            return Decision(folder: new, outcome: .moved)
        } catch {
            return Decision(folder: old, outcome: .failed(error.localizedDescription))
        }
    }
}

/// Copies the old app's settings once, after the rename. Only keys the new app has not set yet.
enum SettingsMigration {
    static let legacySuite = "me.shashankdev.grokcall"
    static let flag = "migratedFromGrokCall"

    /// Returns how many keys were copied. The flag is set even when nothing was copied, so this runs once.
    /// Reads the old app's own domain only: `dictionaryRepresentation()` would also bring in macOS's global keys.
    @discardableResult
    static func run(from old: UserDefaults, domain: String, to new: UserDefaults) -> Int {
        guard new.object(forKey: flag) == nil else { return 0 }
        var copied = 0
        for (key, value) in old.persistentDomain(forName: domain) ?? [:] where new.object(forKey: key) == nil {
            new.set(value, forKey: key)
            copied += 1
        }
        new.set(true, forKey: flag)
        return copied
    }
}

/// Both moves, run first thing at launch, before anything else touches the data folder or the settings.
enum LaunchMigration {
    static func run() {
        let folder = DataFolder.migration
        switch folder.outcome {
        case .moved:
            AppLog.write("Moved the data folder from GrokCall to Alotbot.")
        case .failed(let why):
            AppLog.write("Could not move the data folder from GrokCall to Alotbot (\(why)). Using GrokCall, so no data is lost.")
        case .inPlace:
            break
        }
        if let old = UserDefaults(suiteName: SettingsMigration.legacySuite) {
            let copied = SettingsMigration.run(from: old, domain: SettingsMigration.legacySuite, to: .standard)
            if copied > 0 { AppLog.write("Copied \(copied) settings from GrokCall.") }
        }
    }
}
