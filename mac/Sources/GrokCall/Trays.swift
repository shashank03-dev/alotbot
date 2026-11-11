import GrokCallCore
import SwiftUI

/// The dark panel every tray and card sits on (matches Grok Bot's settings drop-down).
struct Panel<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(18)
            .background(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
            .shadow(color: .black.opacity(0.45), radius: 18, y: 8)
    }
}

struct SectionTitle: View {
    let text: String
    var body: some View { Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary).textCase(.uppercase).padding(.bottom, 10) }
}

// MARK: - bot card

/// Tap a bot in the pill: its tasks, a message box for it alone, and End call.
struct BotCard: View {
    @ObservedObject var model: AppModel
    let bot: CallBot
    @Local private var text = ""
    @Local private var sending = false

    var body: some View {
        Panel {
            HStack(spacing: 12) {
                BotFace(bot: bot, state: avatarState(for: bot.status), gaze: GazeTarget(x: 0, y: 0.25), level: { [audio = model.audio] in audio.voiceLevel() })
                    .frame(width: 34, height: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(bot.status == "error" ? (bot.error ?? Labels.status(bot.status)) : Labels.status(bot.status) + (bot.search ? "" : " · Search off"))
                        .font(.system(size: 12)).foregroundStyle(bot.status == "error" ? Theme.danger : Theme.secondary)
                }
                Spacer()
                Button { model.cardBot = nil } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.secondary).frame(width: 24, height: 24) }
                    .buttonStyle(.plain).accessibilityLabel("Close")
            }
            .padding(.bottom, 14)

            let mine = TaskSort.forBot(model.tasks, name: bot.name)
            SectionTitle(text: "Tasks")
            if mine.isEmpty {
                Text("No tasks yet. Ask \(bot.name) to take one, or add one in the menu bar.").font(.system(size: 13)).foregroundStyle(Theme.secondary).padding(.bottom, 14)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(mine) { t in TaskLine(model: model, task: t, highlighted: model.highlightTask == t.id, compact: true) }
                    }
                }
                .frame(maxHeight: 190)
                .padding(.bottom, 14)
            }

            DarkField(placeholder: "Message \(bot.name)…", text: $text, disabled: sending) {
                let t = text
                sending = true
                Task {
                    if await model.say(t, to: bot.id) { text = "" }
                    sending = false
                }
            }
            .padding(.bottom, 12)

            Button { Task { await model.removeBot(bot.id) } } label: {
                HStack { Image(systemName: "phone.down.fill"); Text("End call for \(bot.name)") }
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.danger.opacity(0.12)))
            }
            .buttonStyle(.plain)
        }
    }
}

/// One task: tick circle, title, owner, and "waits on" chips that open the other task.
struct TaskLine: View {
    @ObservedObject var model: AppModel
    let task: TaskItem
    var highlighted = false
    var compact = false
    var indent = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Button {
                Task { await model.setTask(task.id, status: task.status == "done" ? "open" : "done") }
            } label: { StatusMark(status: task.status, blocked: !task.blockedBy.isEmpty) }
                .buttonStyle(.plain)
                .disabled(isParent)
                .help(isParent ? "Done when all of its parts are done" : task.status == "done" ? "Mark open" : "Mark done")
                .accessibilityLabel(task.status == "done" ? "Mark task \(task.id) open" : "Mark task \(task.id) done")
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(task.title).font(.system(size: 13.5)).foregroundStyle(task.status == "done" ? Theme.secondary : Theme.text)
                        .strikethrough(task.status == "done", color: Theme.secondary)
                    if isParent { Text(progress).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary) }
                }
                if !chips.isEmpty || (!compact && task.owner != nil) {
                    FlowChips(items: chips) { id in model.jump(toTask: id) } leading: {
                        if !compact, let o = task.owner { Text(o).font(.system(size: 11)).foregroundStyle(Theme.secondary) }
                    }
                }
            }
            Spacer(minLength: 0)
            Text("#\(task.id)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary.opacity(0.7))
            Menu {
                if task.status != "doing" && !isParent { Button("Mark doing") { Task { await model.setTask(task.id, status: "doing") } } }
                if !isParent { Button(task.status == "done" ? "Mark open" : "Mark done") { Task { await model.setTask(task.id, status: task.status == "done" ? "open" : "done") } } }
                Menu("Waits on") {
                    ForEach(model.tasks.filter { $0.id != task.id && $0.id != task.parent }) { o in
                        let on = task.waitsOn.contains(o.id)
                        Button { Task { on ? await model.unlinkTask(task.id, from: o.id) : await model.linkTask(task.id, waitsOn: o.id) } } label: {
                            if on { Label("#\(o.id) \(o.title)", systemImage: "checkmark") } else { Text("#\(o.id) \(o.title)") }
                        }
                    }
                }
                Divider()
                Button("Remove", role: .destructive) { Task { await model.removeTask(task.id) } }
            } label: { Image(systemName: "ellipsis").foregroundStyle(Theme.secondary).frame(width: 22, height: 18) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel("More for task \(task.id)")
        }
        .padding(.vertical, 6).padding(.horizontal, 8)
        .padding(.leading, indent ? 22 : 0)
        .background(RoundedRectangle(cornerRadius: 10).fill(highlighted ? Theme.accent.opacity(0.18) : Color.clear))
    }

    private var parts: [TaskItem] { model.tasks.filter { $0.parent == task.id } }
    private var isParent: Bool { !parts.isEmpty }
    private var progress: String { "\(parts.filter { $0.status == "done" }.count)/\(parts.count)" }

    /// "waits on #3 · Bot A" for each task it still waits on (done ones drop off).
    private var chips: [(Int, String)] {
        task.blockedBy.map { id in
            let other = model.tasks.first { $0.id == id }
            return (id, "waits on #\(id)\(other?.owner.map { " · \($0)" } ?? "")")
        }
    }
}

struct StatusMark: View {
    let status: String
    var blocked = false
    var body: some View {
        ZStack {
            Circle().stroke(blocked ? Color.orange.opacity(0.8) : Color.white.opacity(0.35), lineWidth: 1.5)
            if status == "done" { Circle().fill(Theme.accent); Image(systemName: "checkmark").font(.system(size: 8, weight: .black)).foregroundStyle(.white) }
            if status == "doing" { Circle().trim(from: 0, to: 0.5).fill(Theme.accent).rotationEffect(.degrees(90)) }
        }
        .frame(width: 15, height: 15)
        .offset(y: 2)
    }
}

/// Small chips in one wrapping row.
struct FlowChips<Leading: View>: View {
    let items: [(Int, String)]
    let tap: (Int) -> Void
    @ViewBuilder var leading: Leading
    var body: some View {
        HStack(spacing: 6) {
            leading
            ForEach(items, id: \.0) { id, label in
                Button { tap(id) } label: {
                    Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(Color.orange.opacity(0.95))
                        .padding(.horizontal, 7).padding(.vertical, 2.5)
                        .background(Capsule().fill(Color.orange.opacity(0.14)))
                }
                .buttonStyle(.plain)
                .help("Open task #\(id)")
            }
        }
    }
}

// MARK: - trays under the pill

struct TrayView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var prefs: Prefs
    let tray: Tray
    var body: some View {
        switch tray {
        case .add: AddTray(model: model)
        case .newBot: NewBotTray(model: model)
        case .chat: ChatTray(model: model, prefs: prefs)
        case .voice: VoiceTray(model: model)
        case .actions: ActionsView(model: model)
        }
    }
}

/// "+": call in one of your bots, or make a new one.
struct AddTray: View {
    @ObservedObject var model: AppModel
    @Local private var adding = Set<String>()

    var body: some View {
        Panel {
            SectionTitle(text: "Call in a bot")
            let inCall = Set(model.callBots.map(\.id))
            let others = model.bots.filter { !inCall.contains($0.id) }
            if model.bots.isEmpty, let err = model.botsError {
                Text("Couldn't load your bots: \(err)").font(.system(size: 13)).foregroundStyle(Theme.danger).padding(.bottom, 10)
                Button("Try again") { Task { await model.refreshBots() } }.buttonStyle(.plain).foregroundStyle(Theme.text)
            } else if others.isEmpty {
                Text("All your bots are in the call.").font(.system(size: 13)).foregroundStyle(Theme.secondary).padding(.bottom, 12)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(others) { b in
                            Button {
                                adding.insert(b.id)
                                Task { await model.addBot(b.id); adding.remove(b.id) }
                            } label: {
                                HStack(spacing: 12) {
                                    MorphAvatar(shape: b.shape, color: b.color).frame(width: 30, height: 30)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(b.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                                        Text(Labels.voice(b.voice)).font(.system(size: 12)).foregroundStyle(Theme.secondary)
                                    }
                                    Spacer()
                                    if adding.contains(b.id) { ProgressView().controlSize(.small) } else { Image(systemName: "phone.arrow.up.right").foregroundStyle(Theme.secondary) }
                                }
                                .padding(.vertical, 7).padding(.horizontal, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowStyle())
                            .disabled(adding.contains(b.id))
                            .accessibilityLabel("Call in \(b.name)")
                        }
                    }
                }
                .frame(maxHeight: 250)
                .padding(.bottom, 10)
            }
            Divider().overlay(Theme.hairline).padding(.vertical, 6)
            Button { model.tray = .newBot } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus").font(.system(size: 14, weight: .semibold)).frame(width: 30, height: 30).background(Circle().fill(Theme.raised))
                    Text("New bot").font(.system(size: 14, weight: .medium))
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
                }
                .foregroundStyle(Theme.text).padding(.vertical, 6).padding(.horizontal, 8).contentShape(Rectangle())
            }
            .buttonStyle(RowStyle())
        }
    }
}

struct RowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration)
    }
    struct RowBody: View {
        let configuration: Configuration
        @Local private var hover = false
        var body: some View {
            configuration.label
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(configuration.isPressed ? 0.1 : hover ? 0.06 : 0)))
                .onHover { hover = $0 }
        }
    }
}

/// Make a bot in Grok Bot, then pull it into the call.
struct NewBotTray: View {
    @ObservedObject var model: AppModel
    @Local private var name = ""
    @Local private var about = ""
    @Local private var shape = "blob"
    @Local private var color = "violet"
    @Local private var voice: String? = nil
    @Local private var creating = false

    var body: some View {
        Panel {
            HStack {
                Button { model.tray = .add } label: { Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.secondary).frame(width: 24, height: 24) }
                    .buttonStyle(.plain).accessibilityLabel("Back")
                Text("New bot").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                MorphAvatar(shape: shape, color: color, state: .listening).frame(width: 40, height: 40)
            }
            .padding(.bottom, 14)
            Text("Name").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.secondary).padding(.bottom, 6)
            DarkTextInput(placeholder: "e.g. Research bot", text: $name).padding(.bottom, 12)
            Text("What it's for").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.secondary).padding(.bottom, 6)
            DarkTextInput(placeholder: "Optional: one line about what it does", text: $about).padding(.bottom, 14)
            Text("Look").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.secondary).padding(.bottom, 8)
            let shapes = model.choices?.pickerShapes ?? ["blob"]
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(38), spacing: 8), count: 7), alignment: .leading, spacing: 8) {
                ForEach(shapes, id: \.self) { s in
                    Button { withAnimation(Theme.settle) { shape = s } } label: {
                        MorphAvatar(shape: s, color: color).frame(width: 30, height: 30).frame(width: 38, height: 38)
                            .background(RoundedRectangle(cornerRadius: 10).fill(shape == s ? Color.white.opacity(0.14) : Color.clear))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(shape == s ? Color.white.opacity(0.4) : Color.clear, lineWidth: 1))
                    }
                    .buttonStyle(.plain).accessibilityLabel("Shape \(s)").accessibilityAddTraits(shape == s ? .isSelected : [])
                }
            }
            .padding(.bottom, 10)
            HStack(spacing: 8) {
                ForEach(Palette.grok.keys.sorted { order($0) < order($1) }, id: \.self) { c in
                    Button { color = c } label: {
                        Circle().fill(Palette.body(c, onDark: false).color).frame(width: 20, height: 20)
                            .overlay(Circle().stroke(Color.white, lineWidth: color == c ? 2 : 0).padding(-3))
                    }
                    .buttonStyle(.plain).accessibilityLabel("Color \(c)").accessibilityAddTraits(color == c ? .isSelected : [])
                }
            }
            .padding(.bottom, 14)
            HStack {
                Text("Voice").font(.system(size: 15)).foregroundStyle(Theme.text)
                Spacer()
                PillMenu(title: "Voice", options: [nil] + (model.choices?.voices ?? []).map { Optional($0) }, label: Labels.voice, selected: voice) { voice = $0 }
            }
            .padding(.bottom, 12)
            Text("Grok Bot learns the rest about this bot when you chat with it in the Grok Bot app.")
                .font(.system(size: 11.5)).foregroundStyle(Theme.secondary).padding(.bottom, 14)
            Button {
                creating = true
                Task {
                    if await model.createBot(name: name, description: about, shape: shape, color: color, voice: voice) { model.tray = nil }
                    creating = false
                }
            } label: {
                HStack { if creating { ProgressView().controlSize(.small) }; Text(creating ? "Making \(name.trimmingCharacters(in: .whitespaces))…" : model.inCall ? "Make it and call it in" : "Make bot") }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(.black)
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(canCreate ? 1 : 0.35)))
            }
            .buttonStyle(.plain)
            .disabled(!canCreate)
        }
    }

    private var canCreate: Bool { !creating && !name.trimmingCharacters(in: .whitespaces).isEmpty && name.count <= 60 && about.count <= 500 }
    private func order(_ c: String) -> Int { ["violet", "blue", "cyan", "green", "yellow", "orange", "red", "magenta", "brown", "gray", "black"].firstIndex(of: c) ?? 99 }
}

struct DarkTextInput: View {
    var placeholder: String
    @Binding var text: String
    @FocusState private var focused: Bool
    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.secondary))
            .textFieldStyle(.plain).font(.system(size: 14)).foregroundStyle(Theme.text)
            .focused($focused)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.06)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(focused ? Color.white.opacity(0.25) : Color.white.opacity(0.1), lineWidth: 1))
    }
}

/// The live transcript (who said what, in order) and a box to message every bot.
struct ChatTray: View {
    @ObservedObject var model: AppModel
    @ObservedObject var prefs: Prefs
    @Local private var text = ""
    @Local private var sending = false

    var body: some View {
        Panel {
            SectionTitle(text: "Transcript")
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if model.lines.isEmpty && model.view?.live == nil {
                            Text("Nobody has said anything yet.").font(.system(size: 13)).foregroundStyle(Theme.secondary)
                        }
                        ForEach(model.lines) { l in row(who: l.who, botId: l.botId, text: l.text, cut: l.cut).id(l.seq) }
                        if let live = model.view?.live, let b = model.callBots.first(where: { $0.id == live.botId }) {
                            row(who: b.name, botId: b.id, text: live.text, cut: false, live: true).id("live")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, 6)
                }
                .frame(height: 260)
                .onAppear { proxy.scrollTo(model.view?.live != nil ? AnyHashable("live") : AnyHashable(model.lines.last?.seq ?? 0), anchor: .bottom) }
                .onChange(of: model.lines.count) { _, _ in withAnimation(Theme.settle) { proxy.scrollTo(AnyHashable(model.lines.last?.seq ?? 0), anchor: .bottom) } }
                .onChange(of: model.view?.live?.text) { _, _ in proxy.scrollTo(AnyHashable("live"), anchor: .bottom) }
            }
            .padding(.bottom, 12)
            DarkField(placeholder: "Message all bots…", text: $text, disabled: sending) {
                let t = text
                sending = true
                Task {
                    if await model.say(t) { text = "" }
                    sending = false
                }
            }
        }
    }

    @ViewBuilder
    private func row(who: String, botId: String?, text: String, cut: Bool, live: Bool = false) -> some View {
        let b = botId.flatMap { id in model.callBots.first { $0.id == id } }
        HStack(alignment: .top, spacing: 10) {
            Group {
                if botId == nil && who == model.hostName {
                    HostAvatar(prefs: prefs, name: model.hostName, speaking: false, level: { 0 })
                } else {
                    MorphAvatar(shape: b?.shape ?? model.bots.first { $0.name == who }?.shape, color: b?.color ?? model.bots.first { $0.name == who }?.color)
                }
            }
            .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(botId == nil && who == model.hostName ? "You" : who).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.text)
                    if cut { Text("cut off").font(.system(size: 11)).foregroundStyle(Theme.secondary) }
                    if live { Text("speaking").font(.system(size: 11)).foregroundStyle(Theme.accent) }
                }
                Text(text).font(.system(size: 13.5)).foregroundStyle(Theme.text.opacity(live ? 0.75 : 0.92)).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Voice, speed and language for each bot in the call, saved to Grok Bot.
struct VoiceTray: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Panel {
            HStack(alignment: .top, spacing: 10) {
                ForEach(model.callBots) { b in
                    Button { model.voiceBot = b.id; model.savingVoice = nil } label: {
                        VStack(spacing: 5) {
                            MorphAvatar(shape: b.shape, color: b.color).frame(width: 30, height: 30)
                                .padding(5).background(Circle().fill(model.voiceBot == b.id ? Color.white.opacity(0.14) : .clear))
                                .overlay(Circle().stroke(model.voiceBot == b.id ? Color.white.opacity(0.45) : .clear, lineWidth: 1))
                            Text(b.name).font(.system(size: 10.5)).foregroundStyle(model.voiceBot == b.id ? Theme.text : Theme.secondary).lineLimit(2).multilineTextAlignment(.center).frame(width: 76, height: 28, alignment: .top)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Voice settings for \(b.name)").accessibilityAddTraits(model.voiceBot == b.id ? .isSelected : [])
                }
            }
            .padding(.bottom, 8)
            Divider().overlay(Theme.hairline).padding(.horizontal, -18).padding(.bottom, 4)
            if let id = model.voiceBot, let bot = model.bot(id), let c = model.choices {
                row("Voice") { PillMenu(title: "Voice", options: [nil] + c.voices.map { Optional($0) }, label: Labels.voice, selected: bot.voice) { v in Task { await model.setVoice(id, voice: .some(v)) } } }
                row("Speed") { PillMenu(title: "Speed", options: c.speeds, label: Labels.speed, selected: bot.speed) { s in Task { await model.setVoice(id, speed: s) } } }
                row("Language") { PillMenu(title: "Language", options: [nil] + c.languages.map { Optional($0) }, label: Labels.language, selected: bot.language) { l in Task { await model.setVoice(id, language: .some(l)) } } }
                Text(model.savingVoice ?? "Changes save to Grok Bot, and this bot speaks with them from its next reply.")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.secondary).padding(.top, 6)
            } else {
                Text("Loading this bot's settings…").font(.system(size: 13)).foregroundStyle(Theme.secondary).padding(.vertical, 12)
            }
        }
    }

    private func row<C: View>(_ label: String, @ViewBuilder _ control: () -> C) -> some View {
        HStack {
            Text(label).font(.system(size: 17)).foregroundStyle(Theme.text)
            Spacer()
            control()
        }
        .padding(.vertical, 12)
    }
}


struct ActionsView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Actions").font(.headline)
            if model.actions.isEmpty { Text("Actions taken during calls appear here and stay after you leave.").foregroundStyle(Theme.secondary) }
            ForEach(model.actions) { action in
                VStack(alignment: .leading, spacing: 5) {
                    Button { Task { await model.inspectAction(action.id) } } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(action.botName) · \(action.target) · \(action.tool)").font(.system(size: 12, weight: .medium))
                            Text(action.statusLabel).font(.caption).foregroundStyle(action.status == "failed" || action.status == "unknown" ? Theme.text : Theme.secondary)
                            Text(action.error ?? action.approval?.summary ?? action.summary ?? "Running…").lineLimit(3).font(.caption)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.buttonStyle(.plain)
                    if action.canResolve {
                        HStack {
                            Button("Approve once") { Task { await model.resolveAction(action, decision: "approve") } }
                            Button("Deny") { Task { await model.resolveAction(action, decision: "deny") } }
                        }.disabled(model.resolvingActions.contains(action.id))
                    }
                    if let detail = model.actionDetail, detail.id == action.id {
                        Text("Result · \(detail.id)").font(.caption).foregroundStyle(Theme.secondary)
                        ScrollView { Text(detail.result ?? detail.error ?? detail.approval?.summary ?? "No result yet.").font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 220)
                    }
                }.padding(.vertical, 5)
                Divider()
            }
        }
    }
}
