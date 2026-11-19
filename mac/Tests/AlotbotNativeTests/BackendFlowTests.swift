import Foundation
import Testing
import AlotbotCore
@testable import Alotbot

@Suite struct BackendFlowTests {
    @Test @MainActor func nativeHistoryApprovalsAndReconnectUseTheRealBackendConnection() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let entry = dir.appendingPathComponent("src/overlay")
        try FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = root.appendingPathComponent("mac/Tests/Fixtures/native-backend.ts")
        let source = "import { start } from \(String(data: try JSONSerialization.data(withJSONObject: fixture.path, options: .fragmentsAllowed), encoding: .utf8)!); await start();"
        try source.write(to: entry.appendingPathComponent("main.ts"), atomically: true, encoding: .utf8)
        let paths = BackendPaths(repo: dir, node: URL(fileURLWithPath: "/opt/homebrew/bin/node"), dataDir: dir.appendingPathComponent("data"))
        let backend = Backend(resolvePaths: { paths })
        let model = AppModel(backend: backend, demo: false)
        defer { backend.stop() }
        func wait(_ condition: () -> Bool) async throws {
            for _ in 0..<200 {
                if condition() { return }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            throw NSError(domain: "BackendFlowTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native flow timed out: \(model.connection)"])
        }
        try await wait { model.connection == .ready }
        await model.refreshActions()
        let pending = try #require(model.actions.first { $0.status == "waiting_approval" && $0.approval?.kind == "auto_review" })
        #expect(pending.canResolve)
        await model.inspectAction(pending.id)
        #expect(model.actionDetail?.id == pending.id)
        await model.resolveAction(pending, decision: "approve")
        #expect(model.actionDetail?.approval?.status == "approved")
        let denied = try #require(model.actions.first { $0.status == "waiting_approval" && $0.approval?.kind == "local_tool" })
        await model.resolveAction(denied, decision: "deny")
        #expect(model.actionDetail?.approval?.status == "denied")
        #expect(model.actionDetail?.status == "failed")
        await model.resolveAction(denied, decision: "approve")
        #expect(model.toast?.contains("pending") == true)
        #expect(model.resolvingActions.isEmpty)
        await model.setBrowserEnabled(true)
        #expect(model.browserEnabled)
        model.restartBackend()
        try await wait { model.connection == .ready }
        await model.refreshActions()
        #expect(!model.browserEnabled)
        #expect(model.actions.contains { $0.id == pending.id && $0.approval?.status == "approved" })
        #expect(model.actions.contains { $0.id == denied.id && $0.approval?.status == "denied" })
    }
}

extension BackendFlowTests {
    @Test @MainActor func stoppingTheBackendReleasesARequestAlreadySent() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let entry = dir.appendingPathComponent("src/overlay")
        try FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = root.appendingPathComponent("mac/Tests/Fixtures/native-backend.ts")
        let source = "import { start } from \(String(data: try JSONSerialization.data(withJSONObject: fixture.path, options: .fragmentsAllowed), encoding: .utf8)!); await start();"
        try source.write(to: entry.appendingPathComponent("main.ts"), atomically: true, encoding: .utf8)
        let paths = BackendPaths(repo: dir, node: URL(fileURLWithPath: "/opt/homebrew/bin/node"), dataDir: dir.appendingPathComponent("data"))
        let backend = Backend(resolvePaths: { paths })
        let model = AppModel(backend: backend, demo: false)
        defer { backend.stop() }
        for _ in 0..<200 {
            if model.connection == .ready && !model.bots.isEmpty { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(model.connection == .ready)
        try Data().write(to: paths.dataDir.appendingPathComponent("hold-bots"))
        var released = false
        let request = Task { @MainActor in
            defer { released = true }
            do { try await backend.send("bots"); Issue.record("The held request unexpectedly succeeded") } catch { #expect(error.localizedDescription.contains("stopped")) }
        }
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: paths.dataDir.appendingPathComponent("bots-waiting").path) { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(FileManager.default.fileExists(atPath: paths.dataDir.appendingPathComponent("bots-waiting").path))
        backend.stop()
        for _ in 0..<50 { if released { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        #expect(released, "Stop must reject pending continuations rather than leave the UI waiting forever")
        request.cancel()
    }
}

extension BackendFlowTests {
    /// Local run of 2026-11-19: Ring now during do not disturb showed nothing, so it was pressed 14 times and then
    /// rang 14 times in a row. It must say it is waiting, list the ring once, and let you drop it.
    @Test @MainActor func ringNowDuringDoNotDisturbSaysItIsWaitingAndQueuesOneRing() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let entry = dir.appendingPathComponent("src/overlay")
        try FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = root.appendingPathComponent("mac/Tests/Fixtures/native-backend.ts")
        let source = "import { start } from \(String(data: try JSONSerialization.data(withJSONObject: fixture.path, options: .fragmentsAllowed), encoding: .utf8)!); await start();"
        try source.write(to: entry.appendingPathComponent("main.ts"), atomically: true, encoding: .utf8)
        let paths = BackendPaths(repo: dir, node: URL(fileURLWithPath: "/opt/homebrew/bin/node"), dataDir: dir.appendingPathComponent("data"))
        let backend = Backend(resolvePaths: { paths })
        let model = AppModel(backend: backend, demo: false)
        defer { backend.stop() }
        for _ in 0..<200 where model.connection != .ready { try await Task.sleep(nanoseconds: 50_000_000) }
        #expect(model.connection == .ready)
        let draft = StandingCallDraft(title: "Standup", botIds: ["bot-test"], days: Set(0...6), hour: 9, minute: 30, timezone: "UTC")
        #expect(await model.saveStandingCall(draft) == nil)
        let id = try #require(model.incoming?.schedules.first?.id)
        await model.setIncomingSettings(["doNotDisturbUntil": Int((Date().timeIntervalSince1970 + 3600) * 1000)])
        for _ in 0..<3 { await model.ringNow(id) }
        #expect(model.toast == "Not ringing yet. Rings when do not disturb ends.")
        #expect(model.incoming?.ringing == nil)
        let held = try #require(model.incoming?.held)
        try #require(held.count == 1)
        await model.decline(held[0].id)
        #expect(model.incoming?.held.isEmpty == true)
        await model.setIncomingSettings(["doNotDisturbUntil": NSNull()])
        #expect(model.incoming?.ringing == nil, "a dropped ring does not ring later")
    }
}
