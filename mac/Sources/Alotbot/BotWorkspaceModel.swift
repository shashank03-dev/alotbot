import AppKit
import SwiftUI

struct WorkspaceBot: Decodable { let id, agentId, name: String }
func workspaceDateLabel(_ value: Any?, timeZone: String?) -> String? {
    let milliseconds = (value as? NSNumber)?.doubleValue ?? (value as? String).flatMap(Double.init)
    guard let milliseconds, milliseconds.isFinite, milliseconds > 0, milliseconds < 253_402_300_800_000 else { return nil }
    let zone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = zone
    formatter.dateFormat = "d MMM yyyy, h:mm a"
    return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000)) + " (\(zone.identifier))"
}
struct WorkspaceRoutine: Decodable, Identifiable {
    let id, name: String
    let spec: [String: ConnectionValue]
    let enabled: Bool
    let permissions: ConnectionValue?
    func allows(_ action: String) -> Bool {
        guard let value = permissions?.value as? [String: Any], let allowed = value["allowedActions"] as? [String] else { return true }
        return allowed.contains { $0.hasSuffix("_" + action) }
    }
    var triggerDescription: String { (spec["triggerDescription"]?.value as? String) ?? (trigger["schedule"] as? String) ?? (trigger["type"] as? String) ?? "Event trigger" }
    var prompt: String { spec["prompt"]?.value as? String ?? "" }
    var trigger: [String: Any] { spec["trigger"]?.value as? [String: Any] ?? [:] }
}
struct WorkspaceSkill: Decodable, Identifiable { let id, name, description, content, source: String; let readOnly: Bool }
struct WorkspaceFile: Decodable, Identifiable {
    let id, name, path, source: String
    let sizeBytes: Double
    var sizeDescription: String {
        guard let size = Int64(exactly: sizeBytes), size >= 0 else { return "Size unavailable" }
        return ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }
}
struct WorkspaceResources: Decodable {
    let bot: WorkspaceBot
    let routines: [WorkspaceRoutine]
    let skills: [WorkspaceSkill]
    let availableSkills: [WorkspaceSkill]?
    var files: [WorkspaceFile]
    let memory, library, plugins: [String: ConnectionValue]
    let timeZone: String?
    let warnings: [String]
    var nextFilesPage: String?
}
struct WorkspaceComputer: Decodable {
    struct Handoff: Decodable { let requestId, reason: String }
    struct Monitor: Decodable, Identifiable { let id, title: String; let hasViewer: Bool }
    let state: String
    let hasViewer: Bool
    let handoff: Handoff?
    let monitors: [Monitor]
}
struct WorkspaceTeaching: Decodable { let state: String; let owned: Bool; let startedAtMs: Double? }
struct WorkspaceViewer: Decodable { let id, url, authorization, state: String; let hasControl: Bool }
enum WorkspaceTab: String, CaseIterable, Identifiable { case computer = "Computer", activity = "Activity", routines = "Routines", knowledge = "Knowledge", files = "Files", apps = "Apps"; var id: String { rawValue } }

@MainActor final class BotWorkspaceModel: ObservableObject {
    typealias Request = (String, [String: Any]) async throws -> Data
    let botId, name: String
    let backend: Backend?
    private let request: Request
    @Published var tab: WorkspaceTab = .activity
    @Published var activity: WorkspaceActivity?
    @Published var resources: WorkspaceResources?
    @Published var computer: WorkspaceComputer?
    @Published var teaching: WorkspaceTeaching?
    @Published var viewer: WorkspaceViewer?
    @Published var hasControl = false
    @Published var viewerConnected = false
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    @Published var pendingDeletion: String?
    @Published var pendingRun: String?
    @Published var pendingSkillDeletion: String?
    private var controlGeneration = 0
    private var polling: Task<Void, Never>?
    init(botId: String, name: String, backend: Backend? = nil, request: @escaping Request) {
        self.botId = botId; self.name = name; self.backend = backend; self.request = request
    }
    convenience init(botId: String, name: String, backend: Backend) {
        self.init(botId: botId, name: name, backend: backend, request: { action, args in
            var args = args; args["action"] = action
            let value: ConnectionValue = try await backend.request("workspace", args)
            return try JSONSerialization.data(withJSONObject: value.value, options: .fragmentsAllowed)
        })
    }
    func data(_ action: String, _ values: [String: Any] = [:]) async throws -> Data {
        var args = values; args["botId"] = botId
        if ["cardControl", "cardDecision", "cardRespond", "draftSend", "draftDiscard", "phoneControl", "paymentMethods", "paymentBegin", "paymentFinish", "mcpOpen", "mcpCall"].contains(action),
           let id = args["id"] as? String, let card = activity?.cards.first(where: { $0.id == id }) {
            args["seq"] = card.seq
        }
        return try await request(action, args)
    }
    func loadResources() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { resources = try JSONDecoder().decode(WorkspaceResources.self, from: await data("resources")) }
        catch { self.error = error.localizedDescription }
    }
    func refresh() async {
        if tab == .computer { await loadComputer() } else if tab == .activity { await loadActivity() } else { await loadResources() }
    }
    func loadComputer() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { computer = try JSONDecoder().decode(WorkspaceComputer.self, from: await data("computerStatus")); teaching = try JSONDecoder().decode(WorkspaceTeaching.self, from: await data("teachStatus")) }
        catch { self.error = error.localizedDescription }
    }
    func openComputer(monitor: String? = nil) async {
        guard !busy else { return }
        await closeComputer()
        busy = true; error = nil
        defer { busy = false }
        do {
            viewer = try JSONDecoder().decode(WorkspaceViewer.self, from: await data("computerOpen", monitor.map { ["monitor": $0] } ?? [:]))
            computer = try? JSONDecoder().decode(WorkspaceComputer.self, from: await data("computerStatus"))
            teaching = try? JSONDecoder().decode(WorkspaceTeaching.self, from: await data("teachStatus"))
            hasControl = false; pollViewer()
        } catch { self.error = error.localizedDescription }
    }
    var recordingLesson: Bool { teaching?.state == "recording" && teaching?.owned == true }
    func finishLessonBeforeExit(save: Bool) async -> Bool {
        guard recordingLesson else { return true }
        return await teachingAction("teachStop", save: save)
    }
    @discardableResult func teachingAction(_ action: String, save: Bool = false) async -> Bool {
        guard !busy else { return false }
        busy = true; error = nil; defer { busy = false }
        do {
            _ = try await data(action, ["save": save])
            teaching = try JSONDecoder().decode(WorkspaceTeaching.self, from: await data("teachStatus"))
            if action == "teachStart" && !recordingLesson {
                error = "The provider has not confirmed that recording started. Refresh before trying again."
                return false
            }
            if action == "teachStop" && teaching?.state != "idle" {
                error = "The provider has not confirmed that recording stopped. Keep this window open and refresh."
                return false
            }
            notice = action == "teachStart" ? "Recording this bot’s lesson" : save ? "Lesson saved. Check Activity while the bot learns it." : "Recording discarded"
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func control(_ enabled: Bool) async {
        guard let viewer else { return }
        controlGeneration += 1
        let generation = controlGeneration
        if !enabled { hasControl = false }
        do {
            struct Reply: Decodable { let hasControl: Bool }
            let result = try JSONDecoder().decode(Reply.self, from: await data("computerControl", ["viewerId": viewer.id, "enabled": enabled]))
            guard self.viewer?.id == viewer.id, generation == controlGeneration else { return }
            hasControl = result.hasControl
        } catch { hasControl = false; self.error = error.localizedDescription }
    }
    func closeComputer() async {
        polling?.cancel(); polling = nil
        guard let viewer else { return }
        controlGeneration += 1
        self.viewer = nil; hasControl = false; viewerConnected = false
        do { _ = try await data("computerClose", ["viewerId": viewer.id]) } catch { self.error = error.localizedDescription }
    }
    private func pollViewer() {
        polling?.cancel()
        polling = Task { [weak self] in
            var polls = 0
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
                guard let self, let viewer = self.viewer else { return }
                do {
                    let generation = self.controlGeneration
                    struct Reply: Decodable { let connected, hasControl: Bool; let error: String? }
                    let result = try JSONDecoder().decode(Reply.self, from: await self.data("computerViewState", ["viewerId": viewer.id]))
                    guard self.viewer?.id == viewer.id else { return }
                    self.viewerConnected = result.connected
                    if let error = result.error { self.error = error }
                    if generation == self.controlGeneration { self.hasControl = result.hasControl }
                    polls += 1
                    if polls % 5 == 0, let status = try? JSONDecoder().decode(WorkspaceComputer.self, from: await self.data("computerStatus")), self.viewer?.id == viewer.id {
                        self.computer = status
                    }
                } catch { self.hasControl = false; self.viewerConnected = false; self.error = error.localizedDescription; return }
            }
        }
    }
    func perform(_ action: String, _ values: [String: Any] = [:]) async {
        guard !busy else { return }
        busy = true; error = nil; notice = nil
        do { _ = try await data(action, values); notice = ["routineRun", "routineCreate", "routineUpdate", "teachStart", "teachStop", "cardDecision"].contains(action) ? "Request accepted. Check activity for its result." : "Saved" }
        catch { self.error = error.localizedDescription }
        busy = false
        if error == nil { if tab == .computer { await loadComputer() } else if tab == .activity { await loadActivity() } else { await loadResources() } }
    }
}

@MainActor final class BotWorkspaceWindows: NSObject, NSWindowDelegate {
    private let backend: Backend
    private var windows: [String: NSWindow] = [:]
    private var models: [String: BotWorkspaceModel] = [:]
    init(backend: Backend) { self.backend = backend }
    var hasRecordingLesson: Bool { models.values.contains { $0.recordingLesson } }
    func prepareToClose() async -> Bool {
        let recording = models.values.filter { $0.recordingLesson }
        guard !recording.isEmpty else { return true }
        let alert = NSAlert(); alert.messageText = "Save your lesson before leaving?"
        alert.informativeText = "A bot is recording a computer lesson. Save it or discard it before closing Alotbot."
        alert.addButton(withTitle: "Save lesson"); alert.addButton(withTitle: "Discard"); alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        guard response != .alertThirdButtonReturn else { return false }
        for model in recording { if !(await model.finishLessonBeforeExit(save: response == .alertFirstButtonReturn)) { return false } }
        return true
    }
    func open(botId: String, name: String, tab: WorkspaceTab) {
        if let window = windows[botId], let model = models[botId] { model.tab = tab; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let model = BotWorkspaceModel(botId: botId, name: name, backend: backend); model.tab = tab
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 740), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "\(name) · Alotbot"; window.isReleasedWhenClosed = false; window.minSize = NSSize(width: 800, height: 560)
        window.contentViewController = NSHostingController(rootView: BotWorkspaceView(model: model))
        window.delegate = self; window.center(); windows[botId] = window; models[botId] = model
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let id = windows.first(where: { $0.value === sender })?.key, let model = models[id], model.recordingLesson else { return true }
        let alert = NSAlert(); alert.messageText = "Save this lesson before closing?"
        alert.informativeText = "This bot is recording your computer lesson. Save it, discard the recording, or keep the window open."
        alert.addButton(withTitle: "Save lesson"); alert.addButton(withTitle: "Discard"); alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        if response != .alertThirdButtonReturn { Task { if await model.teachingAction("teachStop", save: response == .alertFirstButtonReturn) { sender.close() } } }
        return false
    }
    func windowDidResignKey(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let id = windows.first(where: { $0.value === window })?.key, let model = models[id] else { return }
        Task { await model.control(false) }
    }
    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let id = windows.first(where: { $0.value === window })?.key, let model = models.removeValue(forKey: id) else { return }
        windows[id] = nil; Task { await model.closeComputer() }
    }
    func refreshVisible() { for (id, window) in windows where window.isVisible { if let model = models[id] { Task { await model.refresh() } } } }
    func closeAll() { for w in Array(windows.values) { w.close() } }
}
