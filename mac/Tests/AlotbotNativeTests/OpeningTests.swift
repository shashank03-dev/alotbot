import AppKit
import Foundation
import SwiftUI
import Testing
import AlotbotCore
@testable import Alotbot

@Suite struct OpeningTests {
    private func defaults() -> UserDefaults {
        let name = "OpeningTests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func turnsIntoTheDefaultsWhenNoBotsAreKnown() {
        #expect(OpeningBots.load(defaults: defaults()) == OpeningBots.fallback)
    }

    @Test func turnsIntoYourBotsFirstThenFillsUpToFour() {
        let d = defaults()
        OpeningBots.save([Bot(id: "a", name: "A", color: "green", shape: "star"), Bot(id: "b", name: "B")], defaults: d)
        let looks = OpeningBots.load(defaults: d)
        #expect(looks.count == 4)
        #expect(looks[0] == .init(shape: "star", color: "green"))
        #expect(looks[1] == .init(shape: nil, color: nil))
        #expect(Array(looks[2...]) == Array(OpeningBots.fallback[2...]))
    }

    @Test func keepsOnlyTheFirstFourAndIgnoresAnEmptyList() {
        let d = defaults()
        let many = (0..<6).map { Bot(id: "\($0)", name: "\($0)", color: "red", shape: "hex") }
        OpeningBots.save(many, defaults: d)
        OpeningBots.save([], defaults: d)
        #expect(OpeningBots.load(defaults: d) == Array(repeating: .init(shape: "hex", color: "red"), count: 4))
    }

    @Test func menuBarIconIsATemplateInBothStates() {
        for inCall in [false, true] {
            let img = MenuBarIcon.image(inCall: inCall)
            #expect(img.isTemplate)
            #expect(img.size == NSSize(width: 18, height: 18))
            #expect(img.cgImage(forProposedRect: nil, context: nil, hints: nil) != nil)
        }
    }

    /// The panel stays the size of the screen, so the pill plays in the middle and not shrunk into a corner.
    @Test @MainActor func coversTheWholeScreenWithThePillInTheMiddle() async throws {
        _ = NSApplication.shared
        let screen = try #require(NSScreen.main)
        let panel = Opening.makePanel(on: screen) {}
        defer { panel.close() }
        panel.orderFrontRegardless()
        // The hosting view resizes its window on a later pass, once SwiftUI has measured the view (launch of
        // 2026-11-19: 580 x 300 at the bottom-left corner of a 1470 x 956 screen).
        for _ in 0..<5 {
            try await Task.sleep(for: .milliseconds(100))
            panel.displayIfNeeded()
        }
        #expect(panel.frame == screen.frame)
        #expect(panel.contentView?.frame.size == screen.frame.size)
    }

    /// Plays the opening in a real window and checks it draws, then ends by itself.
    /// With OPENING_FRAMES=<dir> it also saves a frame every 0.2 s for review.
    @Test @MainActor func playsAndEndsOnItsOwn() async throws {
        var ended = false
        let host = NSHostingView(rootView: OpeningView(bots: OpeningBots.fallback) { ended = true })
        host.frame = NSRect(x: 0, y: 0, width: 580, height: 300)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(white: 0.32, alpha: 1)
        window.contentView = host
        window.orderBack(nil)
        defer { window.close() }
        let dir = ProcessInfo.processInfo.environment["OPENING_FRAMES"].map { URL(fileURLWithPath: $0) }
        var drawn = 0
        for i in 0..<30 where !ended {
            try await Task.sleep(for: .milliseconds(200))
            host.layoutSubtreeIfNeeded()
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            if png.count > 20_000 { drawn += 1 }
            if let dir { try png.write(to: dir.appendingPathComponent(String(format: "frame-%02d.png", i))) }
        }
        #expect(drawn > 5)
        #expect(ended)
    }
}

@Suite struct HostNameTests {
    @Test func usesTheFirstNameThenTheAccountName() {
        #expect(HostName.from(fullName: "Priya Shah", account: "priya") == "Priya")
        #expect(HostName.from(fullName: "  Ana  ", account: "ana") == "Ana")
        #expect(HostName.from(fullName: "", account: "devon") == "Devon")
        #expect(!HostName.current.isEmpty)
    }
}

@Suite struct BackendPathTests {
    private let app = URL(fileURLWithPath: "/Applications/Alotbot.app")
    private let data = URL(fileURLWithPath: "/tmp/data")
    private func resolve(env: [String: String] = [:], info: [String: Any] = [:], files: Set<String>, exe: Set<String>) throws -> BackendPaths {
        try BackendPaths.resolve(env: env, info: info, bundle: app, dataDir: data, exists: { files.contains($0) }, executable: { exe.contains($0) })
    }

    @Test func aDownloadedAppRunsItsOwnBackendAndNode() throws {
        let backend = "/Applications/Alotbot.app/Contents/Resources/backend", node = "/Applications/Alotbot.app/Contents/MacOS/node"
        let p = try resolve(info: ["GCRepoPath": "/repo", "GCNodePath": "/usr/bin/node"], files: ["\(backend)/src/overlay/main.ts", "/repo/src/overlay/main.ts"], exe: [node, "/usr/bin/node", "/opt/homebrew/bin/node"])
        #expect(p.repo.path == backend && p.node.path == node && p.dataDir == data)
    }

    @Test func aDeveloperBuildUsesTheRepoAndItsNode() throws {
        let p = try resolve(info: ["GCRepoPath": "/repo", "GCNodePath": "/usr/bin/node"], files: ["/repo/src/overlay/main.ts"], exe: ["/usr/bin/node", "/opt/homebrew/bin/node"])
        #expect(p.repo.path == "/repo" && p.node.path == "/usr/bin/node")
        let fallback = try resolve(info: ["GCRepoPath": "/repo"], files: ["/repo/src/overlay/main.ts"], exe: ["/usr/local/bin/node"])
        #expect(fallback.node.path == "/usr/local/bin/node")
    }

    @Test func environmentOverridesWin() throws {
        let p = try resolve(env: ["GROK_CALL_REPO": "/dev", "GROK_CALL_NODE": "/n"], info: ["GCRepoPath": "/repo"], files: ["/dev/src/overlay/main.ts"], exe: ["/n", "/opt/homebrew/bin/node"])
        #expect(p.repo.path == "/dev" && p.node.path == "/n")
    }

    @Test func explainsWhatIsMissing() {
        #expect(throws: BackendError.self) { try resolve(files: [], exe: ["/n"]) }
        #expect { try resolve(files: [], exe: []) } throws: { ($0 as? BackendError)?.errorDescription?.contains("Download it again") == true }
        #expect { try resolve(info: ["GCRepoPath": "/gone"], files: [], exe: []) } throws: { ($0 as? BackendError)?.errorDescription?.contains("folder moved") == true }
        #expect { try resolve(info: ["GCRepoPath": "/repo"], files: ["/repo/src/overlay/main.ts"], exe: []) } throws: { ($0 as? BackendError)?.errorDescription?.contains("Node.js was not found") == true }
    }
}
