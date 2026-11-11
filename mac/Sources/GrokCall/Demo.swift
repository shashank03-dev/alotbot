import Foundation
import GrokCallCore

/// GROK_CALL_DEMO=1 plays a scripted call with no backend, for checking the overlay's look and motion.
/// GROK_CALL_DEMO_TRAY (add, chat, voice, newBot, card) opens a tray; GROK_CALL_DEMO_BOTS sets how many bots join;
/// GROK_CALL_DEMO_STAGE=1 opens the full view.
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
        let inCall = Array(bots.prefix(max(1, min(n, bots.count))))
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
        case "voice": tray = .voice; voiceBot = inCall.first?.id
        case "card": cardBot = inCall.first?.id
        default: break
        }
        audio.fakeLevel = { 0.35 + 0.35 * sin(Date().timeIntervalSinceReferenceDate * 11) }
        Timer.scheduledTimer(withTimeInterval: 1.4, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard env["GROK_CALL_DEMO_FREEZE"] != "1" else { return }
                tick += 1
                self.view = frame()
            }
        }
    }
}
