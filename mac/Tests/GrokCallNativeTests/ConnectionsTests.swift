import AppKit
import SwiftUI
import Testing
@testable import GrokCall

@Suite @MainActor struct ConnectionsTests {
    private func fixture() -> Data {
        let names = [("cloud", "Cloudflare", "plugin"), ("native:messages", "Messages", "native"), ("native:onepassword", "1Password", "native"), ("datadog", "Datadog", "plugin")]
        let entries: [[String: Any]] = names.map { id, name, kind in
            ["id": id, "name": name, "summary": kind == "native" ? "Setup continues in Grok Bot. Refresh here after returning." : "Manage your \(name) apps and account resources.", "kind": kind, "category": "Apps", "installed": id != "datadog", "enabled": true, "required": false, "fields": [], "configuredKeys": [], "connectors": [], "skills": [], "servers": id == "cloud" ? [["id": "user-Cloudflare", "name": "Cloudflare", "status": "configured", "enabled": true, "accounts": [["key": "work", "name": "Work account", "connected": true]]]] : []]
        }
        return try! JSONSerialization.data(withJSONObject: ["entries": entries, "warnings": []])
    }
    @Test func searchAndRefreshPreserveSelection() async {
        let data = fixture()
        let model = ConnectionsModel(request: { action, _ in action == "list" ? data : Data((action == "check" ? #"{"status":"connected","message":"Ready for your bots."}"# : #"{"flow":null}"#).utf8) })
        await model.refresh()
        #expect(model.error == nil && model.visible.count == 3)
        model.selected = "native:messages"
        await model.refresh()
        #expect(model.selected == "native:messages")
        model.installedOnly = false; model.search = "datadog"
        #expect(model.visible.map(\.name) == ["Datadog"])
        model.search = "no match"; #expect(model.visible.isEmpty && model.selected == nil && !model.busy)
    }
    /// Each app shows its real logo (https only), Mac apps their own icon, and everything else a symbol for its kind.
    @Test func everyEntryGetsAnIcon() throws {
        func entry(_ id: String, _ name: String, kind: String = "plugin", category: String = "Apps", icon: Any = NSNull()) throws -> ConnectionEntry {
            let json: [String: Any] = ["id": id, "name": name, "summary": "", "kind": kind, "category": category, "installed": true, "enabled": true, "required": false, "fields": [], "configuredKeys": [], "connectors": [], "skills": [], "servers": [], "iconUrl": icon]
            return try JSONDecoder().decode(ConnectionEntry.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let logo = "https://cursor-cdn.com/plugin-logos/production/c3b28c9e077a9e0f.png"
        #expect(try entry("a", "Aave", icon: logo).icon == .logo(URL(string: logo)!))
        for bad in ["http://cursor-cdn.com/x.png", "file:///etc/passwd", "javascript:alert(1)", "", "not a url"] {
            #expect(try entry("a", "Aave", icon: bad).icon == .symbol("puzzlepiece.extension.fill"), "\(bad)")
        }
        #expect(try entry("native:messages", "Messages", kind: "native").icon == .app(bundle: "com.apple.MobileSMS", fallback: "message.fill"))
        #expect(try entry("native:email", "Mail on this Mac", kind: "native").icon == .app(bundle: "com.apple.mail", fallback: "envelope.fill"))
        #expect(try entry("native:onepassword", "1Password", kind: "native").icon == .app(bundle: "com.1password.1password", fallback: "key.fill"))
        #expect(try entry("server:cursor-github", "GitHub", kind: "connection").icon == .symbol("chevron.left.forwardslash.chevron.right"))
        #expect(try entry("server:origin", "Origin", kind: "connection").icon == .symbol("link"))
        #expect(try entry("p", "Pay", category: "PAYMENTS").icon == .symbol("creditcard.fill"))
        #expect(try entry("p", "Infra", category: "infrastructure").icon == .symbol("server.rack"))
        // Older backends send no iconUrl at all.
        let old = try JSONDecoder().decode(ConnectionEntry.self, from: Data(#"{"id":"x","name":"X","summary":"","kind":"plugin","category":"Apps","installed":true,"enabled":true,"required":false,"fields":[],"configuredKeys":[],"connectors":[],"skills":[],"servers":[]}"#.utf8))
        #expect(old.icon == .symbol("puzzlepiece.extension.fill"))
    }

    /// Logos with solid corners fill their tile; see-through ones sit on a tile their mark stays visible on.
    @Test func logosSitOnATileTheyStayVisibleOn() throws {
        func png(background: NSColor?, mark: NSColor, rounded: Bool = false) throws -> Data {
            let rep = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            if let background { background.setFill(); NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 64, height: 64), xRadius: rounded ? 14 : 0, yRadius: rounded ? 14 : 0).fill() }
            mark.setFill(); NSBezierPath(ovalIn: NSRect(x: 16, y: 16, width: 32, height: 32)).fill()
            NSGraphicsContext.restoreGraphicsState()
            return try #require(rep.representation(using: .png, properties: [:]))
        }
        #expect(LogoCache.inspect(try png(background: .systemBlue, mark: .white)) == (fillsTile: true, light: false))
        #expect(LogoCache.inspect(try png(background: .white, mark: .systemPurple, rounded: true)) == (fillsTile: true, light: false))
        #expect(LogoCache.inspect(try png(background: nil, mark: .white)) == (fillsTile: false, light: true))
        #expect(LogoCache.inspect(try png(background: nil, mark: .black)) == (fillsTile: false, light: false))
        #expect(LogoCache.inspect(Data("not an image".utf8)) == (fillsTile: false, light: false))
        #expect(LogoCache.inspect(Data()) == (fillsTile: false, light: false))
    }
    @Test func nativeSetupAndBrowserConsentStayExplicit() async throws {
        var opened: [URL] = []
        let flow = Data(#"{"flow":{"id":"f","server":"s","status":"waiting","authorizationUrl":"https://provider.test/consent","message":"Finish sign-in"}}"#.utf8)
        let model = ConnectionsModel(request: { action, _ in action == "native" ? Data(#"{"url":"grokbot://app/v1/settings?id=messages"}"#.utf8) : flow }, open: { opened.append($0); return true })
        await model.perform("native", ["id": "native:messages"])
        #expect(opened.first?.scheme == "grokbot")
        await model.perform("authenticate", ["id": "s"])
        #expect(model.flow?.pending == true && opened.last?.host == "provider.test")
        try model.updateFlow(flow)
        #expect(opened.count == 2, "Polling must not reopen the same consent page")
        model.stopPolling()
    }
    @Test func builtInAccountSetupOpensItsIntegrationPage() async {
        var opened: URL?
        let model = ConnectionsModel(request: { _, _ in Data(#"{"flow":null,"url":"https://cursor.com/dashboard?tab=integrations"}"#.utf8) }, open: { opened = $0; return true })
        await model.perform("authenticate", ["id": "cursor-github"])
        #expect(opened?.host == "cursor.com" && model.flow == nil && model.error == nil)
    }
    @Test func errorsAndMissingNativeAppsAreVisible() async {
        let failing = ConnectionsModel(request: { _, _ in throw BackendError.setup("Service unavailable") })
        await failing.refresh()
        #expect(failing.error == "Service unavailable" && !failing.busy)
        await failing.perform("install")
        #expect(failing.error == "Service unavailable" && !failing.busy)
        let missing = ConnectionsModel(request: { _, _ in Data(#"{"url":"grokbot://app/v1/plugin/native?id=onepassword"}"#.utf8) }, open: { _ in false })
        await missing.perform("native")
        #expect(missing.error?.contains("could not open") == true)
    }
    @Test func typedDefaultsAndOmittedSecrets() throws {
        let fields = try JSONDecoder().decode([ConnectionEntry.Field].self, from: Data(#"[{"key":"SECRET","title":"Token","description":"","type":"string","secret":true,"required":true,"choices":[],"initial":null},{"key":"COUNT","title":"Count","description":"","type":"integer","secret":false,"required":false,"choices":[],"initial":2},{"key":"OPTIONS","title":"Options","description":"","type":"object","secret":false,"required":false,"choices":[],"initial":{"list":[true,"a"]}}]"#.utf8))
        let installing = try ConnectionsModel.values(fields, text: ["SECRET": "entered"], installing: true)
        #expect(installing["SECRET"] as? String == "entered" && installing["COUNT"] as? Double == 2)
        #expect(installing["OPTIONS"] is [String: Any])
        #expect(try ConnectionsModel.values(fields, text: [:], installing: false).isEmpty)
        #expect(throws: (any Error).self) { try ConnectionsModel.values(fields, text: ["COUNT": "broken"], installing: false) }
    }
    @Test func permissionUpdatesAndEmptyTools() async {
        let data = fixture()
        var sent: [String: Any] = [:]
        let model = ConnectionsModel(request: { action, args in
            if action == "setRule" { sent = args; return Data("{}".utf8) }
            if action == "list" { return data }
            return Data(#"{"status":"unavailable","tools":[]}"#.utf8)
        })
        await model.perform("setRule", ["id": "s", "tool": "read", "permission": "ask"])
        #expect(sent["permission"] as? String == "ask")
        #expect(model.error == nil && model.tools["s"]?.isEmpty == true)
    }
    @Test func providerErrorsStayWithTheirAppAndChecksDoNotOpenConsent() async throws {
        let data = fixture()
        var opened = 0
        let model = ConnectionsModel(request: { action, _ in
            if action == "list" { return data }
            if action == "check" { return Data(#"{"status":"unavailable","message":"The app’s service is temporarily unavailable. Try again later; your connection was kept."}"#.utf8) }
            if action == "authenticate" { throw BackendError.setup("The app’s service is temporarily unavailable. Try again later; your connection was kept.") }
            return Data(#"{"flow":null}"#.utf8)
        }, open: { _ in opened += 1; return true })
        await model.refresh(); model.selected = "cloud"
        #expect(model.health["user-Cloudflare"]?.status == "unavailable")
        await model.perform("authenticate", ["id": "user-Cloudflare"])
        #expect(model.error == nil && model.serverErrors["user-Cloudflare"] != nil)
        #expect(opened == 0 && model.flow == nil)
        model.selected = "native:messages"
        #expect(model.error == nil)
        #expect(model.subtitle(try #require(model.entries.first { $0.id == "cloud" })) == "Service unavailable")
    }
    @Test func publicConnectionChecksCanBecomeReadyWithoutOAuthAndCategoriesAreReadable() async throws {
        let data = fixture()
        let model = ConnectionsModel(request: { action, _ in action == "list" ? data : Data((action == "check" ? #"{"status":"connected","message":"Ready"}"# : #"{"flow":null}"#).utf8) }, open: { _ in Issue.record("Read-only checks cannot open a browser"); return false })
        await model.refresh()
        #expect(model.subtitle(try #require(model.entries.first { $0.id == "cloud" })) == "Connected")
        #expect(model.checking.isEmpty)
    }
    @Test func failedChecksClearReadyStatusAndDoNotLeaveAStuckSpinner() async {
        let data = fixture()
        var failing = false
        let model = ConnectionsModel(request: { action, _ in
            if action == "list" { return data }
            if action == "check" {
                if failing { throw BackendError.setup("Network unavailable") }
                return Data(#"{"status":"connected","message":"Ready"}"#.utf8)
            }
            return Data(#"{"flow":null}"#.utf8)
        })
        await model.refresh(); failing = true
        await model.check("user-Cloudflare")
        #expect(model.health["user-Cloudflare"]?.status == "unknown")
        #expect(model.serverErrors["user-Cloudflare"] == "Network unavailable" && model.checking.isEmpty)
    }
    @Test func missingSetupFieldsLoadBeforeConnecting() async throws {
        var snapshot = try #require(JSONSerialization.jsonObject(with: fixture()) as? [String: Any])
        var entries = try #require(snapshot["entries"] as? [[String: Any]])
        entries[0]["needsManifest"] = true
        snapshot["entries"] = entries
        var detailed = entries[0]
        detailed["fields"] = [["key": "API_KEY", "title": "API key", "description": "Get a key from the provider", "type": "string", "secret": true, "required": true, "choices": [], "initial": NSNull()]] as [[String: Any]]
        let data = try JSONSerialization.data(withJSONObject: snapshot)
        let details = try JSONSerialization.data(withJSONObject: ["entry": detailed])
        let model = ConnectionsModel(request: { action, _ in
            if action == "list" { return data }
            if action == "details" { return details }
            if action == "check" { return Data(#"{"status":"unavailable","message":"Service unavailable"}"#.utf8) }
            return Data(#"{"flow":null}"#.utf8)
        })
        await model.refresh()
        let fields = try #require(model.selectedEntry).fields
        #expect(fields.count == 1 && fields[0].secret && fields[0].required)
        #expect(model.loadingDetails.isEmpty && model.error == nil)
    }
    @Test func connectInstallsThenUsesTheRequiredAuthorizationMethod() async throws {
        for needsAuth in [false, true] {
            var snapshot = try #require(JSONSerialization.jsonObject(with: fixture()) as? [String: Any])
            var rows = try #require(snapshot["entries"] as? [[String: Any]])
            rows[3]["installed"] = true
            rows[3]["servers"] = [["id": "user-Datadog", "name": "Datadog", "status": "configured", "enabled": true, "accounts": []]] as [[String: Any]]
            snapshot["entries"] = rows
            let before = fixture(), after = try JSONSerialization.data(withJSONObject: snapshot)
            var installed = false, opened = 0, commands: [String] = []
            let model = ConnectionsModel(request: { action, _ in
                commands.append(action)
                if action == "list" { return installed ? after : before }
                if action == "install" { installed = true; return Data("{}".utf8) }
                if action == "check" { return Data((needsAuth ? #"{"status":"needsAuth","message":"Sign in"}"# : #"{"status":"connected","message":"Ready"}"#).utf8) }
                if action == "authenticate" { return Data(#"{"flow":{"id":"f","server":"user-Datadog","status":"waiting","authorizationUrl":"https://provider.test/consent","message":"Finish sign-in"}}"#.utf8) }
                return Data(#"{"flow":null}"#.utf8)
            }, open: { _ in opened += 1; return true })
            await model.refresh()
            let entry = try #require(model.entries.first { $0.id == "datadog" })
            await model.connect(entry, values: [:])
            #expect(installed && commands.filter { $0 == "install" }.count == 1)
            #expect(opened == (needsAuth ? 1 : 0))
            #expect(model.error == nil)
            model.stopPolling()
        }
    }
    @Test func completedSignInStillChecksWhetherTheServiceIsReady() async {
        let model = ConnectionsModel(request: { action, _ in
            if action == "authenticate" { return Data(#"{"flow":{"id":"f","server":"s","status":"connected","authorizationUrl":null,"message":"Signed in"}}"#.utf8) }
            return Data(#"{"status":"unavailable","message":"Service unavailable"}"#.utf8)
        })
        await model.perform("authenticate", ["id": "s"])
        #expect(model.flow?.status == "connected")
        #expect(model.health["s"]?.status == "unavailable", "A valid login must not create a fake ready state")
    }
    @Test func decodeLiveCatalogWhenProvided() throws {
        guard let path = ProcessInfo.processInfo.environment["CONNECTIONS_LIVE_SNAPSHOT"] else { return }
        let snapshot = try JSONDecoder().decode(ConnectionSnapshot.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        #expect(snapshot.entries.count > 100)
        #expect(snapshot.entries.contains { $0.id == "native:messages" })
    }
    @Test func renderWhenRequested() async throws {
        guard let path = ProcessInfo.processInfo.environment["CONNECTIONS_SCREENSHOT"] else { return }
        _ = NSApplication.shared
        for state in ["ready", "outage", "new"] {
            let data = fixture()
            let model = ConnectionsModel(request: { action, _ in
                if action == "list" { return data }
                if action == "check" { return Data((state == "outage" ? #"{"status":"unavailable","message":"The app’s service is temporarily unavailable. Try again later; your connection was kept."}"# : #"{"status":"connected","message":"Ready for your bots."}"#).utf8) }
                return Data(#"{"flow":null}"#.utf8)
            })
            await model.refresh(); model.installedOnly = state != "new"; model.selected = state == "new" ? "datadog" : "cloud"
            let host = NSHostingView(rootView: ConnectionsView(model: model))
            host.frame = NSRect(x: 0, y: 0, width: 900, height: 650)
            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host; host.layoutSubtreeIfNeeded()
            let image = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: image)
            let target = state == "ready" ? path : path.replacingOccurrences(of: ".png", with: "-\(state).png")
            try #require(image.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: target))
            window.close()
        }
    }
}
