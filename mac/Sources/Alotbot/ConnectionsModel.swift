import AppKit
import SwiftUI

struct ConnectionValue: Decodable {
    let value: Any
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = NSNull() }
        else if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode([String: ConnectionValue].self) { value = v.mapValues(\.value) }
        else { value = try c.decode([ConnectionValue].self).map(\.value) }
    }
    var text: String {
        if value is NSNull { return "" }
        if let s = value as? String { return s }
        return (try? String(data: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), encoding: .utf8)) ?? ""
    }
}
struct ConnectionEntry: Decodable, Identifiable {
    struct Field: Decodable, Identifiable {
        let key, title, description, type: String
        let secret, required: Bool
        let choices: [ConnectionValue]
        let initial: ConnectionValue
        var id: String { key }
    }
    struct Server: Decodable, Identifiable {
        struct Account: Decodable, Identifiable {
            let key, name: String
            let connected: Bool
            var id: String { key }
        }
        let id, name, status: String
        let enabled: Bool
        let setupUrl: String?
        let included: Bool?
        let accounts: [Account]
    }
    let id, name, summary, kind, category: String
    let installed, enabled, required: Bool
    let fields: [Field]
    let configuredKeys, connectors, skills: [String]
    let servers: [Server]
    let notice: String?
    let needsManifest: Bool?
    let iconUrl: String?

    enum Icon: Equatable { case logo(URL), app(bundle: String, fallback: String), symbol(String) }
    /// The app's own logo when Grok has one (https only), the Mac app's icon for native entries, else a symbol for its kind.
    var icon: Icon {
        if let raw = iconUrl, let url = URL(string: raw), url.scheme == "https", url.host != nil { return .logo(url) }
        switch id {
        case "native:messages": return .app(bundle: "com.apple.MobileSMS", fallback: "message.fill")
        case "native:email": return .app(bundle: "com.apple.mail", fallback: "envelope.fill")
        case "native:onepassword": return .app(bundle: "com.1password.1password", fallback: "key.fill")
        default: break
        }
        if name.localizedCaseInsensitiveContains("github") { return .symbol("chevron.left.forwardslash.chevron.right") }
        if kind == "connection" { return .symbol("link") }
        switch category.uppercased() {
        case "INFRASTRUCTURE": return .symbol("server.rack")
        case "PRODUCTIVITY": return .symbol("checklist")
        case "DATA_ANALYTICS": return .symbol("chart.bar.xaxis")
        case "AGENT_ORCHESTRATION": return .symbol("point.3.connected.trianglepath.dotted")
        case "SALES": return .symbol("chart.line.uptrend.xyaxis")
        case "PAYMENTS": return .symbol("creditcard.fill")
        case "INBOX_AND_COLLABORATION": return .symbol("tray.full.fill")
        case "DESIGN": return .symbol("paintbrush.pointed.fill")
        case "PASSWORD MANAGERS": return .symbol("key.fill")
        default: return .symbol("puzzlepiece.extension.fill")
        }
    }
}
struct ConnectionSnapshot: Decodable { let entries: [ConnectionEntry]; let warnings: [String] }
struct ConnectionFlow: Decodable {
    let id, server, status, message: String
    let authorizationUrl: String?
    var pending: Bool { status == "waiting" || status == "completing" }
}
struct ConnectionHealth: Decodable {
    let status, message: String
    var title: String {
        switch status {
        case "connected": return "Ready for your bots"
        case "needsAuth": return "Sign-in needed"
        case "disabled": return "Disabled"
        case "unavailable": return "Service unavailable"
        case "rateLimited": return "Try again shortly"
        case "blocked": return "Access restricted"
        default: return "Not ready yet"
        }
    }
}
struct ConnectionTool: Decodable, Identifiable {
    let name, key, description, permission: String
    var id: String { key }
}

@MainActor final class ConnectionsModel: ObservableObject {
    typealias Request = (String, [String: Any]) async throws -> Data
    @Published var entries: [ConnectionEntry] = []
    @Published var warnings: [String] = []
    @Published var error: String?
    @Published var busy = false
    @Published var flow: ConnectionFlow?
    @Published var tools: [String: [ConnectionTool]] = [:]
    @Published var search = "" { didSet { selectVisible() } }
    @Published var installedOnly = true { didSet { selectVisible() } }
    @Published var selected: String? { didSet { if selected != oldValue { error = nil } } }
    @Published var health: [String: ConnectionHealth] = [:]
    @Published var loadingDetails: Set<String> = []
    @Published var checking: Set<String> = []
    @Published var serverErrors: [String: String] = [:]
    private let request: Request
    private let open: (URL) -> Bool
    private var polling: Task<Void, Never>?
    private var openedURL: String?

    init(request: @escaping Request, open: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }) {
        self.request = request; self.open = open
    }
    convenience init(backend: Backend) {
        self.init(request: { action, args in
            var args = args; args["action"] = action
            // Decode to a JSON value so the existing typed backend transport can be reused.
            let value: ConnectionValue = try await backend.request("connections", args)
            return try JSONSerialization.data(withJSONObject: value.value, options: .fragmentsAllowed)
        })
    }
    var visible: [ConnectionEntry] {
        entries.filter { (!installedOnly || $0.installed) && (search.isEmpty || "\($0.name) \($0.summary) \($0.category)".localizedCaseInsensitiveContains(search)) }
    }
    private func selectVisible() {
        if !visible.contains(where: { $0.id == selected }) { selected = visible.first?.id }
    }
    var selectedEntry: ConnectionEntry? { entries.first { $0.id == selected } }
    func refresh() async {
        guard !busy else { return }
        busy = true; error = nil
        do {
            try await load()
            try updateFlow(await request("authStatus", [:]))
            if flow?.pending == true { startPolling() }
        } catch { self.error = error.localizedDescription }
        busy = false
        await checkSelected()
    }
    private func load() async throws {
        let result = try JSONDecoder().decode(ConnectionSnapshot.self, from: await request("list", [:]))
        entries = result.entries; warnings = result.warnings
        selectVisible()
    }
    func perform(_ action: String, _ args: [String: Any] = [:]) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            if let id = args["id"] as? String { serverErrors[id] = nil }
            let data = try await request(action, args)
            if action == "native" {
                struct Reply: Decodable { let url: String }
                let reply = try JSONDecoder().decode(Reply.self, from: data)
                guard let url = URL(string: reply.url), url.scheme == "grokbot", open(url) else { throw BackendError.setup("Grok Bot could not open its setup. Install or open Grok Bot, then try again.") }
            } else if action == "authenticate" || action == "cancelAuth" {
                try updateFlow(data)
                struct Setup: Decodable { let url: String? }
                if let raw = try JSONDecoder().decode(Setup.self, from: data).url {
                    guard let url = URL(string: raw), url.scheme == "https", open(url) else { throw BackendError.setup("The account integrations page could not open.") }
                }
                if flow?.pending == true { startPolling() }
                else if let flow, flow.status == "connected" { await check(flow.server) }
            } else {
                try await load()
                if action == "setRule", let id = args["id"] as? String { try await loadTools(id) }
            }
        } catch {
            if let id = args["id"] as? String, entries.contains(where: { $0.servers.contains(where: { $0.id == id }) }) {
                serverErrors[id] = error.localizedDescription
            } else { self.error = error.localizedDescription }
        }
    }
    func showTools(_ id: String) async {
        guard !busy else { return }
        busy = true; serverErrors[id] = nil
        defer { busy = false }
        do { try await loadTools(id) } catch { serverErrors[id] = error.localizedDescription }
    }
    private func loadTools(_ id: String) async throws {
        struct Reply: Decodable { let tools: [ConnectionTool]; let status: String; let message: String? }
        let reply = try JSONDecoder().decode(Reply.self, from: await request("tools", ["id": id]))
        tools[id] = reply.tools
        if let message = reply.message { serverErrors[id] = message }
    }
    func updateFlow(_ data: Data) throws {
        struct Reply: Decodable { let flow: ConnectionFlow? }
        flow = try JSONDecoder().decode(Reply.self, from: data).flow
        if let flow, flow.status == "failed" { serverErrors[flow.server] = flow.message }
        if let flow, flow.status == "connected" {
            serverErrors[flow.server] = nil
        }
        if let raw = flow?.authorizationUrl, raw != openedURL {
            guard let url = URL(string: raw), ["https", "http"].contains(url.scheme ?? ""), open(url) else { throw BackendError.setup("The sign-in browser could not open. Cancel and try again.") }
            openedURL = raw
        }
    }
    private func startPolling() {
        polling?.cancel()
        polling = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
                guard let self else { return }
                do {
                    try self.updateFlow(await self.request("authStatus", [:]))
                    if self.flow?.pending != true { await self.refresh(); return }
                } catch { self.error = error.localizedDescription; return }
            }
        }
    }
    func stopPolling() { polling?.cancel(); polling = nil }

    func check(_ id: String, account: String = "default") async {
        guard !checking.contains(id) else { return }
        checking.insert(id); serverErrors[id] = nil
        defer { checking.remove(id) }
        do {
            health[id] = try JSONDecoder().decode(ConnectionHealth.self, from: await request("check", ["id": id, "account": account]))
        } catch {
            health[id] = ConnectionHealth(status: "unknown", message: "The connection could not be checked. Try again.")
            serverErrors[id] = error.localizedDescription
        }
    }
    func checkSelected() async {
        guard let entry = selectedEntry else { return }
        if entry.needsManifest == true, entry.fields.isEmpty {
            guard !loadingDetails.contains(entry.id) else { return }
            loadingDetails.insert(entry.id)
            defer { loadingDetails.remove(entry.id) }
            do {
                struct Reply: Decodable { let entry: ConnectionEntry }
                let reply = try JSONDecoder().decode(Reply.self, from: await request("details", ["id": entry.id]))
                if let index = entries.firstIndex(where: { $0.id == entry.id }) { entries[index] = reply.entry }
            } catch { if selected == entry.id { self.error = "Setup fields could not be loaded. Refresh and try again." }; return }
        }
        for server in entry.servers { await check(server.id) }
    }
    func connect(_ entry: ConnectionEntry, values: [String: Any]) async {
        if !entry.installed { await perform("install", ["id": entry.id, "values": values]) }
        guard error == nil, let updated = entries.first(where: { $0.id == entry.id }) else { return }
        for server in updated.servers {
            await check(server.id)
            if health[server.id]?.status == "needsAuth", server.setupUrl == nil, server.included != true {
                await perform("authenticate", ["id": server.id])
                break
            }
        }
    }
    func subtitle(_ entry: ConnectionEntry) -> String {
        if entry.kind == "native" { return "Uses Grok Bot" }
        if !entry.installed { return entry.category.replacingOccurrences(of: "_", with: " ").lowercased().capitalized }
        if !entry.enabled { return "Disabled" }
        let states = entry.servers.compactMap { health[$0.id] }
        if let problem = states.first(where: { $0.status != "connected" }) { return problem.title }
        if !states.isEmpty && states.count == entry.servers.count { return "Connected" }
        return entry.servers.isEmpty && !entry.skills.isEmpty ? "Skills added" : "Added"
    }

    static func values(_ fields: [ConnectionEntry.Field], text: [String: String], installing: Bool) throws -> [String: Any] {
        var out: [String: Any] = [:]
        for field in fields {
            let raw = text[field.key] ?? (installing ? field.initial.text : "")
            if raw.isEmpty { continue }
            if field.type == "string" { out[field.key] = raw }
            else {
                guard let data = raw.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) else { throw BackendError.setup("\(field.title) needs a valid \(field.type) value.") }
                out[field.key] = value
            }
        }
        return out
    }
}
