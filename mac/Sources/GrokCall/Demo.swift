import Foundation
import GrokCallCore

/// GROK_CALL_DEMO=1 plays a scripted call with no backend, for checking the overlay's look and motion.
/// GROK_CALL_DEMO_TRAY (add, chat, newBot, card) opens a tray; GROK_CALL_DEMO_BOTS sets how many bots join;
/// GROK_CALL_DEMO_STAGE=1 opens the full view. GROK_CALL_DEMO_SCRIPT=motion loops through every transition
/// (fold, open, trays, card, full view, a bot joining and leaving, a toast, the call ending and starting again).
@MainActor
extension AppModel {
    static var demo: Bool { ProcessInfo.processInfo.environment["GROK_CALL_DEMO"] == "1" }

    func startDemo() {
        let env = ProcessInfo.processInfo.environment
        connection = .ready
        login = LoginState(state: "signed-in", error: nil)
        choices = Choices(voices: ["ara", "carina", "eve", "leo", "rex"], speeds: [0.5, 0.75, 1, 1.25, 1.5, 2], languages: ["en", "hi", "fr"],
                          shapes: MorphData.shared.shapes.keys.sorted(), pickerShapes: ["blob", "cloud", "square", "sparkle", "clover", "heart", "flower", "teardrop", "tablet", "wedge", "house", "star", "hex"],
                          colors: Palette.grok, statuses: ["open", "doing", "done"])
        bots = [
            Bot(id: "a", name: "My Bot", color: "black", shape: "blob"),
            Bot(id: "b", name: "Shashank's Bot", voice: "carina", color: "violet", shape: "cloud"),
            Bot(id: "c", name: "Shashank's X bot", color: "blue", shape: "square"),
            Bot(id: "d", name: "Research", voice: "eve", color: "green", shape: "star"),
            Bot(id: "e", name: "Designer", color: "magenta", shape: "heart"),
            Bot(id: "f", name: "Planner", color: "orange", shape: "house"),
            Bot(id: "g", name: "Critic", color: "cyan", shape: "sparkle"),
        ]
        let n = Int(env["GROK_CALL_DEMO_BOTS"] ?? "") ?? 3
        var inCall = Array(bots.prefix(max(1, min(n, bots.count))))
        tasks = [
            TaskItem(id: 1, title: "Launch plan", owner: hostName, status: "doing", parent: nil, waitsOn: [], by: hostName, doneBy: nil, blockedBy: []),
            TaskItem(id: 2, title: "Pick the angle", owner: "Shashank's Bot", status: "done", parent: 1, waitsOn: [], by: "My Bot", doneBy: "Shashank's Bot", blockedBy: []),
            TaskItem(id: 3, title: "Draft the X thread", owner: "Shashank's X bot", status: "open", parent: 1, waitsOn: [4], by: "My Bot", doneBy: nil, blockedBy: [4]),
            TaskItem(id: 4, title: "Check the launch date", owner: "My Bot", status: "open", parent: nil, waitsOn: [], by: hostName, doneBy: nil, blockedBy: []),
        ]
        lines = [
            Line(seq: 1, who: hostName, botId: nil, text: "Let's plan the launch post.", cut: false),
            Line(seq: 2, who: "My Bot", botId: "a", text: "Sure. I'll check the date first, then hand the thread to the X bot.", cut: false),
            Line(seq: 3, who: "Shashank's Bot", botId: "b", text: "I picked the angle: show the overlay in motion.", cut: true),
        ]
        var tick = 0
        func frame() -> CallView {
            let speaker = inCall[(tick / 3) % inCall.count].id
            let phase = tick % 3
            let hostTalks = tick % 9 == 8
            return CallView(phase: "in-call", muted: false, userSpeaking: hostTalks, waitingForHost: false, focus: nil,
                            bots: inCall.map { b in
                                let status = hostTalks ? (b.id == inCall[0].id ? "listening" : "idle") : b.id == speaker ? (phase == 0 ? "thinking" : "speaking") : "idle"
                                let looks: String? = hostTalks ? "host" : (b.id == speaker ? (phase == 0 ? nil : "host") : (phase == 0 ? nil : speaker))
                                return CallBot(id: b.id, name: b.name, color: b.color, shape: b.shape, status: status, error: nil, search: true, looksAt: looks)
                            },
                            live: phase == 2 && !hostTalks ? Live(botId: speaker, text: "Here's what I found about the launch…") : nil, linesSeq: 3, tasksVersion: 1)
        }
        view = frame()
        overlayShown = true
        mode = env["GROK_CALL_DEMO_STAGE"] == "1" ? .full : env["GROK_CALL_DEMO_EXPANDED"] == "0" ? .circle : .pill
        switch env["GROK_CALL_DEMO_TRAY"] {
        case "add": tray = .add
        case "newBot": tray = .newBot
        case "chat": tray = .chat
        case "card": cardBot = inCall.first?.id
        default: break
        }
        audio.fakeLevel = { 0.35 + 0.35 * sin(Date().timeIntervalSinceReferenceDate * 11) }
        if env["GROK_CALL_DEMO_SCRIPT"] == "motion" {
            let base = inCall
            let steps: [(Double, String, () -> Void)] = [
                (1.5, "fold", { self.setMode(.circle) }),
                (3.0, "open", { self.setMode(.pill) }),
                (4.5, "chat tray", { self.toggleTray(.chat) }),
                (6.0, "switch to add", { self.toggleTray(.add) }),
                (7.5, "close tray", { self.toggleTray(.add) }),
                (8.5, "card", { self.openCard(base[0].id) }),
                (10.0, "close card", { self.openCard(base[0].id) }),
                (11.0, "full view", { self.setMode(.full) }),
                (13.5, "back to pill", { self.setMode(.pill) }),
                (15.0, "bot joins", { if let extra = self.bots.first(where: { b in !inCall.contains { $0.id == b.id } }) { inCall.append(extra); self.view = frame() } }),
                (16.5, "bot leaves", { inCall = base; self.view = frame() }),
                (17.5, "toast", { self.show("Call saved.") }),
                (19.0, "call ends", { self.view = nil; self.overlayShown = false; self.mode = .circle }),
                (20.5, "call starts", { self.mode = .pill; self.view = frame(); self.overlayShown = true }),
            ]
            let cycle = 22.0
            func run(at start: Date) {
                for (t, name, step) in steps {
                    DispatchQueue.main.asyncAfter(deadline: .now() + t) { MainActor.assumeIsolated { AppLog.write("demo: \(name)"); step() } }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + cycle) { MainActor.assumeIsolated { run(at: Date()) } }
            }
            run(at: Date())
        }
        Timer.scheduledTimer(withTimeInterval: 1.4, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard env["GROK_CALL_DEMO_FREEZE"] != "1", self.view != nil else { return }
                tick += 1
                self.view = frame()
            }
        }
    }
}
