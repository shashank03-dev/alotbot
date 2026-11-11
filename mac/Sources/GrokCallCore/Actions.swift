import Foundation

public struct ActionApproval: Codable, Equatable, Sendable {
    public var kind: String
    public var requestId: String
    public var entryId: String?
    public var summary: String
    public var status: String
}

public struct RecordedAction: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var callId: String
    public var botId: String
    public var botName: String
    public var target: String
    public var tool: String
    public var status: String
    public var requestId: String?
    public var summary: String?
    public var result: String?
    public var error: String?
    public var approval: ActionApproval?
    public var createdAt: Double
    public var updatedAt: Double
    public var canResolve: Bool { status == "waiting_approval" && approval?.status == "pending" && approval?.kind != "connector" }
    public var statusLabel: String {
        switch status {
        case "waiting_approval": return "Waiting for approval"
        case "unknown": return "Outcome unknown"
        default: return status.capitalized
        }
    }
}

public struct ActionList: Decodable { public var actions: [RecordedAction] }
public struct ActionDetail: Decodable { public var action: RecordedAction? }

/// Read-only access to one user-selected folder. Resolve symlinks before checking containment.
public enum FolderReader {
    public static let maxBytes = 256 * 1024
    public static func run(root: URL?, operation: String, path: String) throws -> String {
        guard let root else { throw failure("Choose a folder in Grok Call first.") }
        guard !path.hasPrefix("/"), !path.contains("\0") else { throw failure("Use a relative path within the selected folder.") }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        let file = base.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path == base.path || file.path.hasPrefix(base.path == "/" ? "/" : base.path + "/") else { throw failure("That path leaves the selected folder.") }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory) else { throw failure("The path does not exist.") }
        if operation == "list" {
            guard isDirectory.boolValue else { throw failure("Choose a directory to list.") }
            let names = try FileManager.default.contentsOfDirectory(atPath: file.path).sorted()
            return names.prefix(500).joined(separator: "\n") + (names.count > 500 ? "\n[Only the first 500 entries are shown.]" : "")
        }
        guard operation == "read", !isDirectory.boolValue else { throw failure("Use read for a text file or list for a directory.") }
        guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw failure("Only regular text files can be read; pipes and devices are not supported.") }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maxBytes + 1) ?? Data()
        guard data.count <= maxBytes else { throw failure("This file exceeds the 256 KiB read limit.") }
        guard let text = String(data: data, encoding: .utf8), !text.contains("\0") else { throw failure("This file is not UTF-8 text.") }
        return text
    }
    private static func failure(_ text: String) -> NSError { NSError(domain: "GrokCall.Files", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}

public struct LocalToolCommand: Codable, Equatable, Sendable {
    public struct Input: Codable, Equatable, Sendable {
        public var operation: String
        public var path: String?
        public var control: String?
    }
    public var id: String
    public var tool: String
    public var input: Input
}
