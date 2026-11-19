import AppKit
import Combine
import Foundation
import AlotbotCore
import SwiftUI

/// How the host looks in the circle and the pill.
enum HostLook: String, CaseIterable, Identifiable {
    case initials, photo, character
    var id: String { rawValue }
    var label: String { ["initials": "Initials", "photo": "Photo", "character": "Character"][rawValue]! }
}

/// Settings kept on this Mac.
final class Prefs: ObservableObject {
    private let d = UserDefaults.standard
    @Published var hostLook: HostLook { didSet { d.set(hostLook.rawValue, forKey: "hostLook") } }
    @Published var hostShape: String { didSet { d.set(hostShape, forKey: "hostShape") } }
    @Published var hostColor: String { didSet { d.set(hostColor, forKey: "hostColor") } }
    @Published var keepPill: Bool { didSet { d.set(keepPill, forKey: "keepPill") } }
    /// The circle's center, in screen points from the bottom-left of the main screen.
    @Published var orbCenter: CGPoint { didSet { d.set([orbCenter.x, orbCenter.y], forKey: "orbCenter") } }
    @Published var photo: NSImage?

    var photoURL: URL {
        DataFolder.location.appendingPathComponent("host-photo.png")
    }

    init() {
        hostLook = HostLook(rawValue: d.string(forKey: "hostLook") ?? "") ?? .initials
        hostShape = d.string(forKey: "hostShape") ?? "blob"
        hostColor = d.string(forKey: "hostColor") ?? "blue"
        keepPill = d.bool(forKey: "keepPill")
        if let p = d.array(forKey: "orbCenter") as? [Double], p.count == 2 { orbCenter = CGPoint(x: p[0], y: p[1]) } else {
            let f = NSScreen.main?.visibleFrame ?? .init(x: 0, y: 0, width: 1440, height: 900)
            orbCenter = CGPoint(x: f.maxX - 120, y: f.maxY - 90)
        }
        photo = NSImage(contentsOf: photoURL)
    }

    /// Copies a picked photo in (as a 256 px PNG) so the original can move or be deleted.
    func setPhoto(from url: URL) throws {
        guard let img = NSImage(contentsOf: url) else { throw CocoaError(.fileReadCorruptFile) }
        let side = 256.0
        let out = NSImage(size: NSSize(width: side, height: side))
        out.lockFocus()
        let s = img.size, k = max(side / s.width, side / s.height)
        img.draw(in: NSRect(x: (side - s.width * k) / 2, y: (side - s.height * k) / 2, width: s.width * k, height: s.height * k))
        out.unlockFocus()
        guard let tiff = out.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try png.write(to: photoURL, options: .atomic)
        photo = out
    }
}

enum Tray: Equatable { case add, newBot, chat, share }

/// How the call shows on screen: the small circle, the pill with its buttons, or the full view (a tile per bot).
enum OverlayMode: Equatable { case circle, pill, full }

enum Connection: Equatable { case starting, ready, failed(String) }

@MainActor
final class AppModel: ObservableObject {
    lazy var workspaces = BotWorkspaceWindows(backend: backend)
    func openWorkspace(_ botId: String, tab: WorkspaceTab = .activity) {
        guard let name = bots.first(where: { $0.id == botId })?.name ?? callBots.first(where: { $0.id == botId })?.name else { show("This bot is no longer available."); return }
        workspaces.open(botId: botId, name: name, tab: tab)
    }
    let backend: Backend
    let audio = AudioIO()
    let prefs = Prefs()
    let macTools: MacTools
    private let requestMicrophone: () async -> Bool
    @Published var resourceText = ""
    @Published var browserEnabled = false

    @Published var connection: Connection = .starting
    @Published var login = LoginState(state: "signed-out", error: nil)
    @Published var hostName = HostName.current
    @Published var choices: Choices?
    @Published var bots: [Bot] = []
    @Published var botsError: String?
    @Published var picked = Set<String>()
    @Published var view: CallView?
    @Published var lines: [Line] = []
    @Published var actions: [RecordedAction] = []
    @Published var actionDetail: RecordedAction?
    @Published var resolvingActions = Set<String>()
    private var actionPoll: Task<Void, Never>?
    @Published var tasks: [TaskItem] = []
    @Published var pastCalls: [PastCall] = []
    // Calls to you: standing calls, call backs, rings and what you missed.
    @Published var incoming: IncomingState?
    /// While answering: the ring being answered (its panel shows a spinner).
    @Published var answering: String?
    // The call library.
    @Published var library: LibraryPage?
    @Published var libraryDetail: LibraryDetail?
    @Published var libraryError: String?
    // Meetings and screen sharing.
    @Published var meetingApps: [MeetingApp] = []
    @Published var talkHeld = false
    /// ⌥Space could be registered at the last meeting (another app may own it); the on-screen talk button always works.
    @Published var talkKeyAvailable = true
    /// True while a meeting is on: only then is ⌥Space registered.
    var talkKeyWanted: AnyPublisher<Bool, Never> { $view.map { $0?.meeting != nil }.removeDuplicates().eraseToAnyPublisher() }
    @Published var shareTargets: [ShareTarget] = []
    private(set) var meeting: MeetingSession?
    private(set) var screenShare: ScreenShareSession?
    /// Where the mic goes, read on the audio thread.
    let micRouter = MicRouter()
    @Published var joining = false
    @Published var leaving = false
    @Published var toast: String?

    // Overlay
    @Published var overlayShown = false
    /// The bot under the pointer in the open pill (set by the overlay window).
    @Published var hoveredBot: String?
    @Published var mode: OverlayMode = .circle
    /// The pill is open: its buttons, trays and bot cards show.
    var expanded: Bool { mode == .pill }
    @Published var tray: Tray?
    @Published var cardBot: String?
    @Published var showAllBots = false

    private var clock: ClockMap?
    private var toastTask: Task<Void, Never>?

    var inCall: Bool { view != nil }
    var callBots: [CallBot] { view?.bots ?? [] }

    init(backend: Backend = Backend(), demo: Bool? = nil, macTools: MacTools? = nil, requestMicrophone: (() async -> Bool)? = nil) {
        self.backend = backend
        self.macTools = macTools ?? MacTools()
        self.requestMicrophone = requestMicrophone ?? { await AudioIO.requestMic() }
        backend.onConnected = { [weak self] hello, clock in self?.connected(hello, clock) }
        backend.onStopped = { [weak self] why in self?.stopped(why) }
        backend.onAuthenticationLost = { [weak self] in
            let recording = self?.workspaces.hasRecordingLesson == true
            self?.workspaces.closeAll()
            self?.login = LoginState(state: "signed-out", error: recording ? "Sign in to Grok Bot to stop or save the computer lesson that was recording." : nil)
            self?.bots = []; self?.picked = []
        }
        backend.onMessage = { [weak self] msg in self?.handle(msg) }
        backend.onAudio = { [weak self] chunk in self?.audio.play(chunk) }
        let router = micRouter
        audio.onMic = { [weak self] level, pcm in
            // In a meeting your mic is part of the meeting (your own lines) unless you hold the talk key.
            switch router.route {
            case .bots: self?.backend.sendMic(AudioFrames.encodeMic(level: level, samples: pcm))
            case .meeting: router.meeting?.hostAudio(pcm)
            }
        }
        audio.onFailure = { [weak self] why in self?.show(why) }
        if demo ?? Self.demo { startDemo() } else { backend.start() }
    }

    // MARK: backend lifecycle

    private func connected(_ hello: Hello, _ clock: ClockMap) {
        self.clock = clock
        hostName = hello.user
        choices = hello.choices
        connection = .ready
        browserEnabled = false
        AppLog.write("backend connected")
        Task { [self] in
            await refreshLogin()
            await refreshTasks()
            await refreshCalls()
            await refreshIncoming()
            actionPoll?.cancel()
            actionPoll = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self else { return }
                    await self.refreshActions()
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                }
            }
        }
    }

    private func stopped(_ why: String) {
        AppLog.write("backend stopped: \(why)")
        actionPoll?.cancel()
        browserEnabled = false
        connection = .failed(why)
        if inCall { endCallLocally() }
    }

    func restartBackend() {
        connection = .starting
        backend.restart()
    }

    private func handle(_ msg: ServerMessage) {
        switch msg {
        case .view(let v):
            let wasIn = view != nil
            view = v
            if !wasIn { overlayShown = true }
        case .lines(let l):
            lines.append(contentsOf: l)
            if lines.count > 500 { lines.removeFirst(lines.count - 500) }
        case .localTool(let command):
            Task {
                do {
                    let text = try await macTools.run(command)
                    try await backend.send("localResult", ["id": command.id, "text": text])
                } catch { try? await backend.send("localResult", ["id": command.id, "error": error.localizedDescription]) }
            }
        case .workspaceChanged:
            workspaces.refreshVisible()
        case .actions(let a):
            actions = a
        case .tasks(let t):
            tasks = t.tasks
        case .stopAudio(let id):
            audio.stopChunk(id)
        case .incoming(let state):
            incoming = state
        case .ended:
            endCallLocally()
        case .reply, .unknown:
            break
        }
    }

    func show(_ message: String) {
        AppLog.write("shown: \(message)")
        toast = message
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3.5))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    /// Runs a backend call; a failure becomes a toast (and a signed-out failure updates the sign-in state).
    @discardableResult
    func attempt<T>(_ what: String, _ body: () async throws -> T) async -> T? {
        do { return try await body() } catch {
            if let e = error as? BackendError, e.signedOut { login = LoginState(state: "signed-out", error: nil) }
            show("\(what): \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: sign-in

    func refreshLogin() async {
        guard let s: LoginState = await attempt("Couldn't check sign-in", { try await backend.request("state") }) else { return }
        login = s
        if s.state == "signed-in" { await refreshBots() }
    }

    func signIn() async {
        struct R: Decodable { let loginUrl: String }
        guard let r: R = await attempt("Couldn't start sign-in", { try await backend.request("login") }), let url = URL(string: r.loginUrl) else { return }
        login = LoginState(state: "signing-in", error: nil)
        NSWorkspace.shared.open(url)
        // The backend finishes the sign-in by itself; check until it's done.
        for _ in 0..<400 {
            try? await Task.sleep(for: .seconds(1.5))
            guard let s: LoginState = try? await backend.request("state") else { continue }
            login = s
            if s.state != "signing-in" { break }
        }
        if login.state == "signed-in" { await refreshBots() }
    }

    func signOut() async {
        guard await workspaces.prepareToClose() else { return }
        workspaces.closeAll()
        guard let s: LoginState = await attempt("Couldn't sign out", { try await backend.request("logout") }) else { return }
        login = s
        bots = []
        picked = []
    }

    // MARK: bots and calls

    func refreshBots() async {
        struct R: Decodable { let bots: [Bot] }
        do {
            let r: R = try await backend.request("bots")
            bots = r.bots
            OpeningBots.save(r.bots)
            botsError = nil
            picked = picked.filter { id in r.bots.contains { $0.id == id } }
        } catch {
            if let e = error as? BackendError, e.signedOut { login = LoginState(state: "signed-out", error: nil) }
            botsError = error.localizedDescription
        }
    }

    func bot(_ id: String) -> Bot? { bots.first { $0.id == id } }

    /// Everything a call needs before the backend joins it: the mic, and audio running on the backend's clock.
    private func startAudio() async -> Bool {
        macTools.prepareForCall()
        guard await requestMicrophone() else { show(AudioIO.AudioError.micDenied.localizedDescription); return false }
        guard let clock else { show(BackendError.notConnected.localizedDescription); return false }
        do { try audio.start(clock: clock) } catch { show(error.localizedDescription); return false }
        lines = []
        tray = nil
        cardBot = nil
        showAllBots = false
        return true
    }

    /// Starts a call: audio first, then the backend's join request (`op` with `args`). False if it didn't start.
    @discardableResult
    private func startCall(_ what: String, op: String, args: [String: Any]) async -> Bool {
        guard !joining else { return false }
        joining = true
        defer { joining = false }
        guard await startAudio() else { return false }
        struct R: Decodable { let joined: [String] }
        guard let _: R = await attempt(what, { try await backend.request(op, args) }) else {
            audio.stop()
            return false
        }
        mode = .pill
        overlayShown = true
        await refreshTasks()
        return true
    }

    func join() async {
        guard !picked.isEmpty else { return }
        let ids = bots.map(\.id).filter(picked.contains) // keep the account's order
        AppLog.write("join: \(bots.filter { picked.contains($0.id) }.map(\.name).joined(separator: ", "))")
        await startCall("Couldn't join", op: "join", args: ["botIds": ids])
    }

    /// Picks up an earlier call where it left off, with these bots.
    func continueCall(_ id: String, botIds: [String]) async {
        guard !botIds.isEmpty else { show("Choose a bot to continue the call with."); return }
        AppLog.write("continue call \(id)")
        await startCall("Couldn't continue the call", op: "join", args: ["botIds": botIds, "continueFrom": id])
    }

    // MARK: calls to you

    func refreshIncoming() async {
        if let s: IncomingState = try? await backend.request("incoming") { incoming = s }
    }

    /// Picks up a ringing (or missed) call: its bots join and the one that called opens.
    func answer(_ ringId: String) async {
        guard answering == nil else { return }
        if inCall { show("Leave this call first."); return }
        answering = ringId
        defer { answering = nil }
        AppLog.write("answer ring \(ringId)")
        await startCall("Couldn't answer", op: "ringAnswer", args: ["id": ringId])
        await refreshIncoming()
    }

    func incomingOp(_ op: String, _ args: [String: Any] = [:], _ what: String) async {
        if let s: IncomingState = await attempt(what, { try await backend.request(op, args) }) { incoming = s }
    }

    func decline(_ ringId: String) async { await incomingOp("ringDecline", ["id": ringId], "Couldn't decline") }
    func snooze(_ ringId: String, minutes: Int) async { await incomingOp("ringSnooze", ["id": ringId, "minutes": minutes], "Couldn't snooze") }
    func cancelCallback(_ id: String) async { await incomingOp("callbackCancel", ["id": id], "Couldn't cancel the call back") }
    func clearMissed() async { await incomingOp("missedClear", [:], "Couldn't clear missed calls") }
    func deleteStandingCall(_ id: String) async { await incomingOp("scheduleDelete", ["id": id], "Couldn't delete the standing call") }
    func ringNow(_ id: String) async {
        await incomingOp("scheduleRingNow", ["id": id], "Couldn't ring it")
        if let r = incoming?.held.first(where: { $0.scheduleId == id }) { show("Not ringing yet. \(r.waitingLabel)") }
    }
    func setIncomingSettings(_ settings: [String: Any]) async { await incomingOp("incomingSettings", ["settings": settings], "Couldn't save") }

    /// Saves a standing call (new or edited). Returns the problem in words, or nil when saved.
    func saveStandingCall(_ draft: StandingCallDraft) async -> String? {
        if let p = draft.problem { return p }
        do {
            let s: IncomingState = try await backend.request("scheduleSave", ["schedule": draft.body])
            incoming = s
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // MARK: meetings

    /// The apps that could be holding a meeting, meeting apps first.
    func refreshMeetingApps() {
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map {
            MeetingApp(name: $0.localizedName ?? "", bundleId: $0.bundleIdentifier ?? "", pid: $0.processIdentifier)
        }
        meetingApps = MeetingApps.rank(running, selfBundle: Bundle.main.bundleIdentifier ?? "")
    }

    /// Joins `botIds` to listen to `app`'s meeting. `consent`: you confirmed the meeting knows it is transcribed.
    func startMeeting(app: MeetingApp, botIds: [String], consent: Bool) async {
        guard consent else { show("Confirm that the people in the meeting know it is being transcribed."); return }
        guard !botIds.isEmpty else { show("Choose a bot to listen with."); return }
        let session = MeetingSession(app: app, send: { [weak self] who, text in self?.meetingLine(who, text) }, problem: { [weak self] in self?.show($0) })
        // Your mic belongs to the meeting from the start; hold the talk key to speak to the bots.
        micRouter.set(route: .meeting, meeting: session)
        AppLog.write("meeting: \(app.name) with \(botIds.count) bot(s)")
        guard await startCall("Couldn't start listening", op: "join", args: ["botIds": botIds, "meeting": ["app": app.name, "consent": true] as [String: Any]]) else {
            micRouter.set(route: .bots, meeting: nil)
            return
        }
        do {
            try await session.start()
            meeting = session
        } catch {
            micRouter.set(route: .bots, meeting: nil)
            show(error.localizedDescription)
            await leave()
        }
    }

    private func meetingLine(_ who: String, _ text: String) {
        guard inCall, meeting != nil else { return }
        Task { try? await backend.send("meetingLine", ["who": who, "text": String(text.prefix(1000))]) }
    }

    /// Talk on or off in one press, for VoiceOver and the keyboard (they can't hold the button).
    func toggleTalk() { setTalk(!talkHeld) }

    /// Hold to talk: while held, your mic goes to the bots instead of the meeting.
    func setTalk(_ held: Bool) {
        guard view?.meeting != nil, talkHeld != held else { return }
        talkHeld = held
        micRouter.set(route: MicRoute.of(inMeeting: true, talkHeld: held), meeting: meeting)
    }

    func setWhisperAloud(_ aloud: Bool) async {
        await attempt("Couldn't change how bots whisper") { try await backend.send("setWhisper", ["mode": aloud ? "voice" : "text"]) }
    }

    // MARK: sharing your screen

    func refreshShareTargets() async {
        do { shareTargets = try await ShareTarget.available() } catch { show("Couldn't list your windows: \(error.localizedDescription)") }
    }

    func share(_ target: ShareTarget) async {
        guard inCall else { return }
        // The current share pauses while the switch is asked for, so it reads nothing more; it ends once the backend takes
        // the new one, and goes on if the switch is refused. A read already on its way carries the old share's number.
        let old = screenShare
        old?.stop()
        guard let reply: ScreenShareReply = await attempt("Couldn't share", { try await backend.request("screenShare", target.screenShareArgs) }) else {
            old?.start()
            return
        }
        screenShare = nil
        let share = reply.share
        let session = ScreenShareSession(target: target, send: { [weak self] args in
            guard let self else { return false }
            var args = args
            if let share { args["share"] = share }
            let r: ScreenShareReply = try await self.backend.request("screenUpdate", args)
            return r.taken
        }, stopped: { [weak self] why in
            guard let self else { return }
            self.show(why)
            Task { await self.stopSharing() }
        })
        screenShare = session
        session.start()
    }

    func stopSharing() async {
        screenShare?.stop()
        screenShare = nil
        if inCall { await attempt("Couldn't stop sharing") { try await backend.send("screenStop") } }
    }

    func leave() async {
        guard inCall, !leaving else { return }
        leaving = true
        tray = nil
        cardBot = nil
        AppLog.write("leave")
        let r: LeaveResult? = await attempt("Couldn't save the call", { try await backend.request("leave") })
        AppLog.write("left: saved \(r?.file ?? "nothing")")
        leaving = false
        endCallLocally()
        if let r {
            show(r.file == nil ? "Call ended. Nothing was said, so it wasn't saved." : "Call saved.")
            await refreshCalls()
            if library != nil { await refreshLibrary() }
        }
        await refreshIncoming()
        await refreshTasks()
    }

    private func endCallLocally() {
        meeting?.stop()
        meeting = nil
        screenShare?.stop()
        screenShare = nil
        micRouter.set(route: .bots, meeting: nil)
        talkHeld = false
        audio.stop()
        view = nil
        tray = nil
        cardBot = nil
        mode = .circle
        overlayShown = false
        leaving = false
    }

    func addBot(_ id: String) async {
        await attempt("Couldn't add the bot") { try await backend.send("addBot", ["botId": id]) }
    }

    func removeBot(_ id: String) async {
        if cardBot == id { cardBot = nil }
        await attempt("Couldn't remove the bot") { try await backend.send("removeBot", ["botId": id]) }
    }

    /// Message everyone (botId nil) or one bot. Returns true if it was sent.
    func say(_ text: String, to botId: String? = nil) async -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return false }
        struct R: Decodable { let sent: Bool }
        var args: [String: Any] = ["text": String(t.prefix(1000))]
        if let botId { args["botId"] = botId }
        guard let r: R = await attempt("Couldn't send", { try await backend.request("say", args) }) else { return false }
        if !r.sent { show("No bot is ready to hear that yet.") }
        return r.sent
    }

    func stopAll() {
        guard inCall else { return }
        Task { await attempt("Couldn't stop the bots") { try await backend.send("stop") } }
        show("Stopped every bot. They wait for you.")
    }

    func toggleMute() {
        guard let v = view else { return }
        let next = !v.muted
        audio.muted = next
        view?.muted = next
        Task { await attempt("Couldn't change mute") { try await backend.send("mute", ["muted": next]) } }
    }

    func setVoice(_ botId: String, voice: String?? = nil, speed: Double? = nil, language: String?? = nil) async {
        var s: [String: Any] = [:]
        if let voice { s["voice"] = voice ?? NSNull() }
        if let speed { s["speed"] = speed }
        if let language { s["language"] = language ?? NSNull() }
        struct R: Decodable { let bot: Bot }
        if let r: R = await attempt("Couldn't save to Grok Bot", { try await backend.request("setVoice", ["botId": botId, "settings": s]) }) {
            if let i = bots.firstIndex(where: { $0.id == r.bot.id }) { bots[i] = r.bot } else { bots.append(r.bot) }
        }
    }

    func createBot(name: String, description: String, shape: String, color: String, voice: String?) async -> Bool {
        struct R: Decodable { let bot: Bot }
        var b: [String: Any] = ["name": name, "description": description, "shape": shape, "color": color]
        b["voice"] = voice ?? NSNull()
        guard let r: R = await attempt("Couldn't make the bot", { try await backend.request("createBot", ["bot": b, "addToCall": inCall]) }) else { return false }
        await refreshBots()
        show("\(r.bot.name) is ready\(inCall ? " and joining the call" : "").")
        return true
    }

    func setBrowserEnabled(_ enabled: Bool) async {
        do { try await backend.send("localConfig", ["browser": enabled]); browserEnabled = enabled }
        catch { show(error.localizedDescription) }
    }

    func refreshResources(_ botId: String) async {
        struct Resources: Decodable { var text: String }
        if let r: Resources = await attempt("Load bot resources", { try await backend.request("botResources", ["botId": botId]) }) { resourceText = r.text }
    }

    func refreshActions() async {
        if let list: ActionList = try? await backend.request("actions") {
            actions = list.actions
            if let detail = actionDetail, let latest = actions.first(where: { $0.id == detail.id }), latest.updatedAt != detail.updatedAt { await inspectAction(detail.id) }
        }
    }

    /// What bots are waiting for your OK on, oldest first; `botId` narrows it to one bot.
    func approvals(for botId: String? = nil) -> [RecordedAction] {
        actions.filter { $0.canResolve && (botId == nil || $0.botId == botId) }.sorted { $0.createdAt < $1.createdAt }
    }

    func inspectAction(_ id: String) async {
        if let detail: ActionDetail = await attempt("Read action", { try await backend.request("action", ["id": id]) }) { actionDetail = detail.action }
    }

    func resolveAction(_ action: RecordedAction, decision: String) async {
        guard !resolvingActions.contains(action.id) else { return }
        resolvingActions.insert(action.id)
        defer { resolvingActions.remove(action.id) }
        if let detail: ActionDetail = await attempt("Resolve approval", { try await backend.request("resolveApproval", ["id": action.id, "decision": decision]) }) { actionDetail = detail.action }
        await refreshActions()
    }

    // MARK: tasks

    func refreshTasks() async {
        guard let t: TaskList = try? await backend.request("tasks") else { return }
        tasks = t.tasks
    }

    func addTask(title: String, owner: String?, parent: Int?, waitsOn: [Int]) async -> Bool {
        var a: [String: Any] = ["title": title, "waitsOn": waitsOn]
        a["owner"] = owner ?? NSNull()
        a["parent"] = parent ?? NSNull()
        guard let t: TaskList = await attempt("Couldn't add the task", { try await backend.request("taskAdd", a) }) else { return false }
        tasks = t.tasks
        return true
    }

    func taskOp(_ op: String, _ args: [String: Any], _ what: String) async {
        if let t: TaskList = await attempt(what, { try await backend.request(op, args) }) { tasks = t.tasks }
    }

    func setTask(_ id: Int, status: String) async { await taskOp("taskStatus", ["id": id, "status": status], "Couldn't update task #\(id)") }
    func removeTask(_ id: Int) async { await taskOp("taskRemove", ["id": id], "Couldn't remove task #\(id)") }

    /// Owners a task can have: the host, then every bot on the account.
    var owners: [String] { [hostName] + bots.map(\.name) }

    // MARK: past calls

    func refreshCalls() async {
        struct R: Decodable { let calls: [PastCall] }
        if let r: R = try? await backend.request("calls") { pastCalls = r.calls }
    }

    func callURL(_ c: PastCall) -> URL? { callURL(file: c.file) }
    func callURL(file: String) -> URL? { backend.paths?.dataDir.appendingPathComponent("calls").appendingPathComponent(file) }

    func saveToDownloads(_ c: PastCall) { saveToDownloads(file: c.file) }

    // MARK: call library

    /// Lists saved calls, newest first; with a query, the ones that match. `more` pages on from what is shown.
    func refreshLibrary(query: String = "", kind: String? = nil, more: Bool = false) async {
        var args: [String: Any] = ["query": query, "limit": 40]
        if let kind { args["kind"] = kind }
        // The last call shown, by start time and id: calls that started in the same second are not skipped.
        if more, let last = library?.calls.last { args["before"] = Int(last.startedAt); args["beforeId"] = last.id }
        do {
            let page: LibraryPage = try await backend.request("library", args)
            if more, var current = library {
                current.calls += page.calls.filter { c in !current.calls.contains { $0.id == c.id } }
                current.hasMore = page.hasMore
                current.total = page.total
                library = current
            } else {
                library = page
            }
            libraryError = nil
        } catch {
            libraryError = error.localizedDescription
        }
    }

    func openLibraryCall(_ id: String) async {
        if let d: LibraryDetail = await attempt("Couldn't open the call", { try await backend.request("libraryCall", ["id": id]) }) { libraryDetail = d }
    }

    /// Deletes a saved call for good: its file, its place in search, and the summary the next call would start from.
    func deleteLibraryCall(_ id: String) async {
        struct R: Decodable { let deleted: String }
        guard let _: R = await attempt("Couldn't delete the call", { try await backend.request("libraryDelete", ["id": id]) }) else { return }
        if libraryDetail?.call.id == id { libraryDetail = nil }
        library?.calls.removeAll { $0.id == id }
        if let total = library?.total { library?.total = max(0, total - 1) }
        await refreshCalls()
    }

    func saveToDownloads(file: String) {
        guard let src = callURL(file: file) else { return }
        let dest = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0].appendingPathComponent("grok-\(file)")
        do {
            if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.removeItem(at: dest) }
            try FileManager.default.copyItem(at: src, to: dest)
            NSWorkspace.shared.activateFileViewerSelecting([dest])
        } catch {
            show("Couldn't save the call: \(error.localizedDescription)")
        }
    }

    // MARK: overlay helpers

    func toggleTray(_ t: Tray) {
        cardBot = nil
        tray = tray == t ? nil : t
    }

    func openCard(_ botId: String) {
        tray = nil
        cardBot = cardBot == botId ? nil : botId
    }

    /// Shows the call as the circle, the pill or the full view. Trays and cards close: each mode has its own place for them.
    func setMode(_ m: OverlayMode) {
        tray = nil
        cardBot = nil
        overlayShown = true
        mode = m
    }

    func collapse() { setMode(.circle) }

    var ringMode: RingMode { AlotbotCore.ringMode(view) }
}

/// Where the mic goes, readable from the audio thread: the bots, or the meeting (your own lines).
final class MicRouter: @unchecked Sendable {
    private let lock = NSLock()
    private var _route: MicRoute = .bots
    private var _meeting: MeetingSession?
    var route: MicRoute { lock.lock(); defer { lock.unlock() }; return _route }
    var meeting: MeetingSession? { lock.lock(); defer { lock.unlock() }; return _meeting }
    func set(route: MicRoute, meeting: MeetingSession?) {
        lock.lock()
        _route = route
        _meeting = meeting
        lock.unlock()
    }
}
