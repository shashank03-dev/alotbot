import Foundation
import Testing
@testable import GrokCallCore

@Suite struct ActionTests {
    @Test func testHistoryAndApprovalDecode() throws {
        let raw = #"{"t":"actions","actions":[{"id":"a","callId":"c","botId":"b","botName":"Bot","target":"mac","tool":"read","status":"waiting_approval","approval":{"kind":"local_tool","requestId":"r","summary":"Read selected file","status":"pending"},"createdAt":1,"updatedAt":2}]}"#
        guard case .actions(let actions) = try ServerMessage.decode(raw) else { Issue.record("actions were discarded"); return }
        #expect(actions[0].canResolve)
        #expect(actions[0].statusLabel == "Waiting for approval")
    }
    @Test func testFolderBoundaryAndRealRead() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let value = UUID().uuidString
        try value.write(to: dir.appendingPathComponent("proof.txt"), atomically: true, encoding: .utf8)
        #expect(try FolderReader.run(root: dir, operation: "read", path: "proof.txt") == value)
        #expect(try FolderReader.run(root: dir, operation: "list", path: ".") == "proof.txt")
        for path in ["../outside", "/etc/passwd", "missing", "\0"] { #expect(throws: (any Error).self) { try FolderReader.run(root: dir, operation: "read", path: path) } }
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("escape"), withDestinationURL: URL(fileURLWithPath: "/etc/passwd"))
        #expect(throws: (any Error).self) { try FolderReader.run(root: dir, operation: "read", path: "escape") }
        #expect(throws: (any Error).self) { try FolderReader.run(root: nil, operation: "read", path: "proof.txt") }
        #expect(throws: (any Error).self) { try FolderReader.run(root: dir, operation: "read", path: ".") }
        try Data(repeating: 1, count: FolderReader.maxBytes + 1).write(to: dir.appendingPathComponent("large"))
        #expect(throws: (any Error).self) { try FolderReader.run(root: dir, operation: "read", path: "large") }
        try Data([0xff]).write(to: dir.appendingPathComponent("binary"))
        #expect(throws: (any Error).self) { try FolderReader.run(root: dir, operation: "read", path: "binary") }
    }
}

import Darwin
@Suite struct SpecialFileTests {
    @Test func namedPipesAreRejectedWithoutBlockingTheCall() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let pipe = dir.appendingPathComponent("pipe")
        #expect(mkfifo(pipe.path, 0o600) == 0)
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            defer { finished.signal() }
            _ = try? FolderReader.run(root: dir, operation: "read", path: "pipe")
        }
        let returned = finished.wait(timeout: .now() + 0.3) == .success
        // Unblock the old implementation so a failed test still exits cleanly.
        if !returned {
            let writer = open(pipe.path, O_WRONLY | O_NONBLOCK)
            if writer >= 0 { _ = close(writer) }
            _ = finished.wait(timeout: .now() + 1)
        }
        #expect(returned, "Reading a special file must not block the call thread")
    }
}

@Suite struct FolderBoundaryTests {
    @Test func rootFolderAndExactSizeAndListCaps() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("proof.txt")
        try "root-proof".write(to: file, atomically: true, encoding: .utf8)
        let relative = String(file.resolvingSymlinksInPath().path.dropFirst())
        #expect(try FolderReader.run(root: URL(fileURLWithPath: "/"), operation: "read", path: relative) == "root-proof")
        try Data(repeating: 97, count: FolderReader.maxBytes).write(to: file)
        #expect(try FolderReader.run(root: dir, operation: "read", path: "proof.txt").utf8.count == FolderReader.maxBytes)
        for i in 0..<500 { FileManager.default.createFile(atPath: dir.appendingPathComponent("file-\(i)").path, contents: Data()) }
        #expect(try FolderReader.run(root: dir, operation: "list", path: ".").contains("Only the first 500"))
        #expect(throws: (any Error).self) { try FolderReader.run(root: dir, operation: "list", path: "proof.txt") }
        #expect(throws: (any Error).self) { try FolderReader.run(root: dir, operation: "delete", path: "proof.txt") }
    }
}

@Suite struct BroadFileReadTests {
    @Test func absolutePathsRequireAnExplicitBroadGrant() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("proof.txt")
        try "read only".write(to: file, atomically: true, encoding: .utf8)
        #expect(try FolderReader.run(root: URL(fileURLWithPath: "/"), operation: "read", path: file.path) == "read only")
        #expect(throws: (any Error).self) { try FolderReader.run(root: dir, operation: "read", path: file.path) }
    }
}
