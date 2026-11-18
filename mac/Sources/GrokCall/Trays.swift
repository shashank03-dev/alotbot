import GrokCallCore
import SwiftUI

/// The raised panel every tray and card sits on.
struct Panel<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(16)
            .elevated(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

struct SectionTitle: View {
    let text: String
    var body: some View { Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.tertiary).padding(.bottom, 8) }
}

// MARK: - bot card

/// Tap a bot in the call: anything it needs your OK for, its voice, its tasks, a message just for it.
struct BotCard: View {
    @ObservedObject var model: AppModel
    let bot: CallBot
    @Local private var text = ""
    @Local private var sending = false

    var body: some View {
        Panel {
            HStack(spacing: 12) {
                BotFace(bot: bot, state: avatarState(for: bot.status), gaze: GazeTarget(x: 0, y: 0.25), level: { [audio = model.audio] in audio.voiceLevel() })
                    .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(bot.status == "error" ? (bot.error ?? Labels.status(bot.status)) : Labels.status(bot.status))
                        .font(.system(size: 12)).foregroundStyle(bot.status == "error" ? Theme.danger : Theme.secondary).lineLimit(2)
                }
                Spacer()
                CloseButton { model.cardBot = nil }
            }
            .padding(.bottom, 14)

            ForEach(model.approvals(for: bot.id)) { a in ApprovalRow(model: model, action: a, showBot: false).padding(.bottom, 10) }

            if let b = model.bot(bot.id), let c = model.choices {
                VStack(spacing: 0) {
                    SettingRow("Voice") { PillMenu(title: "Voice", options: [nil] + c.voices.map { Optional($0) }, label: Labels.voice, selected: b.voice) { v in Task { await model.setVoice(b.id, voice: .some(v)) } } }
                    Divider().overlay(Theme.hairline)
                    SettingRow("Speed") { PillMenu(title: "Speed", options: c.speeds, label: Labels.speed, selected: b.speed) { s in Task { await model.setVoice(b.id, speed: s) } } }
                    Divider().overlay(Theme.hairline)
                    SettingRow("Language") { PillMenu(title: "Language", options: [nil] + c.languages.map { Optional($0) }, label: Labels.language, selected: b.language) { l in Task { await model.setVoice(b.id, language: .some(l)) } } }
                }
                .padding(.horizontal, 12)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.fill))
                .padding(.bottom, 14)
            }

            let mine = TaskSort.forBot(model.tasks, name: bot.name)
            if !mine.isEmpty {
                SectionTitle(text: "Tasks")
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(mine) { t in TaskLine(model: model, task: t, compact: true) }
                    }
                }
                .frame(maxHeight: 170)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 12)
            }

            DarkField(placeholder: "Message \(bot.name)", text: $text, disabled: sending) {
                let t = text
                sending = true
                Task {
                    if await model.say(t, to: bot.id) { text = "" }
                    sending = false
                }
            }
            .padding(.bottom, 12)

            HStack {
                Button { model.openWorkspace(bot.id) } label: { Label("Open workspace", systemImage: "square.grid.2x2") }
                    .buttonStyle(QuietButton())
                Spacer()
                Button { Task { await model.removeBot(bot.id) } } label: { Text("Remove from call") }
                    .buttonStyle(QuietButton(tint: Theme.danger))
            }
        }
    }
}

/// "Voice      Ara ⌄": a label with its control on the right.
struct SettingRow<C: View>: View {
    let label: String
    @ViewBuilder var control: C
    init(_ label: String, @ViewBuilder control: () -> C) { self.label = label; self.control = control() }
    var body: some View {
        HStack {
            Text(label).font(.system(size: 13.5)).foregroundStyle(Theme.text)
            Spacer()
            control
        }
        .frame(minHeight: 40)
    }
}

/// Something a bot wants to do that needs your OK first.
struct ApprovalRow: View {
    @ObservedObject var model: AppModel
    let action: RecordedAction
    var showBot = true

    var body: some View {
        let busy = model.resolvingActions.contains(action.id)
        VStack(alignment: .leading, spacing: 10) {
            Label(showBot ? "\(action.botName) needs your OK" : "Needs your OK", systemImage: "hand.raised.fill")
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.warn)
            Text(action.approval?.summary ?? action.summary ?? action.tool)
                .font(.system(size: 13.5)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Allow once") { Task { await model.resolveAction(action, decision: "approve") } }.buttonStyle(FilledButton(primary: true))
                Button("Don't allow") { Task { await model.resolveAction(action, decision: "deny") } }.buttonStyle(FilledButton())
            }
            .disabled(busy)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.warn.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.warn.opacity(0.25), lineWidth: 1))
        .transition(Motion.surfaceTransition(anchor: .top))
    }
}

/// One task: a tick to finish it, its title, and who it's for.
struct TaskLine: View {
    @ObservedObject var model: AppModel
    let task: TaskItem
    var compact = false
    var indent = false
    @Local private var hover = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Button {
                Task { await model.setTask(task.id, status: task.status == "done" ? "open" : "done") }
            } label: { StatusMark(status: task.status, waiting: !task.blockedBy.isEmpty) }
                .buttonStyle(.plain)
                .disabled(isParent)
                .help(isParent ? "Done when all its steps are done" : task.status == "done" ? "Mark not done" : "Mark done")
                .accessibilityLabel(task.status == "done" ? "Mark \(task.title) not done" : "Mark \(task.title) done")
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).font(.system(size: 13.5)).foregroundStyle(task.status == "done" ? Theme.tertiary : Theme.text)
                    .strikethrough(task.status == "done", color: Theme.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .animation(Motion.crossfade, value: task.status)
                if !meta.isEmpty { Text(meta).font(.system(size: 11.5)).foregroundStyle(task.blockedBy.isEmpty ? Theme.tertiary : Theme.warn) }
            }
            Spacer(minLength: 0)
            Menu {
                if !isParent {
                    if task.status != "doing" { Button("Working on it") { Task { await model.setTask(task.id, status: "doing") } } }
                    Button(task.status == "done" ? "Not done" : "Done") { Task { await model.setTask(task.id, status: task.status == "done" ? "open" : "done") } }
                    Divider()
                }
                Button("Remove", role: .destructive) { Task { await model.removeTask(task.id) } }
            } label: { Image(systemName: "ellipsis").foregroundStyle(Theme.secondary).frame(width: 22, height: 18) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .opacity(hover ? 1 : 0.0001)
                .accessibilityLabel("More for \(task.title)")
        }
        .padding(.vertical, 6).padding(.horizontal, 8)
        .padding(.leading, indent ? 22 : 0)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hover ? Theme.fill : .clear))
        .onHover { h in withAnimation(Motion.hover) { hover = h } }
    }

    private var parts: [TaskItem] { model.tasks.filter { $0.parent == task.id } }
    private var isParent: Bool { !parts.isEmpty }

    /// "Shashank's X bot · Waiting · 1 of 2 done"
    private var meta: String {
        var bits: [String] = []
        if !compact, let o = task.owner { bits.append(o == model.hostName ? "You" : o) }
        if !task.blockedBy.isEmpty { bits.append("Waiting") } else if task.status == "doing" { bits.append("Working on it") }
        if isParent { bits.append("\(parts.filter { $0.status == "done" }.count) of \(parts.count) done") }
        return bits.joined(separator: " · ")
    }
}

struct StatusMark: View {
    let status: String
    var waiting = false
    var body: some View {
        ZStack {
            Circle().strokeBorder(waiting ? Theme.warn.opacity(0.8) : Theme.tertiary, lineWidth: 1.5)
            if status == "done" {
                Circle().fill(Theme.accent).transition(.scale(scale: 0.4).combined(with: .opacity))
                Image(systemName: "checkmark").font(.system(size: 8, weight: .black)).foregroundStyle(.white).transition(.scale(scale: 0.4))
            }
            if status == "doing" { Circle().trim(from: 0, to: 0.5).fill(Theme.accent).rotationEffect(.degrees(90)).padding(3) }
        }
        .frame(width: 16, height: 16)
        .offset(y: 2)
        .animation(Motion.spring(MotionSpec.press), value: status)
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
        case .share: ShareTray(model: model)
        }
    }
}

/// Share a window (or your whole screen) with the bots: they get its text with your lines, and can look at all of it.
struct ShareTray: View {
    @ObservedObject var model: AppModel
    @Local private var loading = true

    var body: some View {
        Panel {
            SectionTitle(text: "Share with the bots")
            if let sc = model.view?.screen {
                HStack(spacing: 10) {
                    Image(systemName: "rectangle.on.rectangle").foregroundStyle(Theme.accent)
                    Text("Sharing \(sc.label)").font(.system(size: 13.5, weight: .medium)).foregroundStyle(Theme.text).lineLimit(2)
                    Spacer()
                    Button("Stop") { Task { await model.stopSharing() } }.buttonStyle(FilledButton(danger: true))
                }
                .padding(.bottom, 10)
            }
            Text("The bots read the text on it every few seconds. Password managers are never shared.").font(.system(size: 12)).foregroundStyle(Theme.secondary).padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if loading { ProgressView().controlSize(.small).padding(8) }
                    if !loading && model.shareTargets.isEmpty { Text("No windows to share. Allow Screen Recording for Grok Call in System Settings.").font(.system(size: 13)).foregroundStyle(Theme.secondary) }
                    ForEach(model.shareTargets) { t in
                        Button { Task { await model.share(t) } } label: {
                            HStack(spacing: 10) {
                                Image(systemName: t.kind == .display ? "display" : "macwindow").foregroundStyle(Theme.secondary).frame(width: 18)
                                Text(t.label).font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(1)
                                Spacer()
                                if model.screenShare?.target.id == t.id { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                            }
                            .padding(.vertical, 6).padding(.horizontal, 8).contentShape(Rectangle())
                        }
                        .buttonStyle(RowStyle())
                    }
                }
            }
            .frame(maxHeight: 260)
        }
        .task {
            await model.refreshShareTargets()
            loading = false
        }
    }
}

/// While the call listens to a meeting: how bots whisper, and hold to talk to them.
struct MeetingControls: View {
    @ObservedObject var model: AppModel
    let meeting: MeetingState
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "person.3.fill").font(.system(size: 11)).foregroundStyle(Theme.secondary)
            Text(meeting.app).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
            PillMenu(title: "Whispers", options: [false, true], label: { $0 ? "Whisper aloud (headphones)" : "Whisper in text" }, selected: meeting.aloud) { aloud in
                Task { await model.setWhisperAloud(aloud) }
            }
            Spacer(minLength: 4)
            Text(model.talkHeld ? "Talking to bots" : "Hold to talk")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(model.talkHeld ? Color.black : Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Capsule().fill(model.talkHeld ? Color.white : Theme.raised))
                .gesture(DragGesture(minimumDistance: 0).onChanged { _ in model.setTalk(true) }.onEnded { _ in model.setTalk(false) })
                .help(model.talkKeyAvailable ? "Or hold ⌥Space anywhere" : "Hold while you talk to your bots")
                .accessibilityLabel("Talk to your bots")
                .accessibilityValue(model.talkHeld ? "On" : "Off")
                .accessibilityHint("Turns talking to your bots on or off")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { model.toggleTalk() }
                // The keyboard toggles it too: Tab to it, then Space or Return.
                .focusable()
                .onKeyPress(keys: [.space, .return]) { _ in model.toggleTalk(); return .handled }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .elevated(Capsule())
    }
}

/// "+": add one of your bots to the call, or make a new one.
struct AddTray: View {
    @ObservedObject var model: AppModel
    @Local private var adding = Set<String>()

    var body: some View {
        Panel {
            SectionTitle(text: "Add to the call")
            let inCall = Set(model.callBots.map(\.id))
            let others = model.bots.filter { !inCall.contains($0.id) }
            if model.bots.isEmpty, let err = model.botsError {
                Text("Couldn't load your bots. \(err)").font(.system(size: 13)).foregroundStyle(Theme.danger).padding(.bottom, 10)
                Button("Try again") { Task { await model.refreshBots() } }.buttonStyle(QuietButton())
            } else if others.isEmpty {
                Text("All your bots are already here.").font(.system(size: 13)).foregroundStyle(Theme.secondary).padding(.bottom, 10)
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
                                    Text(b.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                                    Spacer()
                                    if adding.contains(b.id) { ProgressView().controlSize(.small) } else { Image(systemName: "plus").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.secondary) }
                                }
                                .padding(.vertical, 7).padding(.horizontal, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowStyle())
                            .disabled(adding.contains(b.id))
                            .accessibilityLabel("Add \(b.name)")
                        }
                    }
                }
                .frame(maxHeight: 250)
                .fixedSize(horizontal: false, vertical: true)
            }
            Divider().overlay(Theme.hairline).padding(.vertical, 8)
            Button { model.tray = .newBot } label: {
                HStack(spacing: 12) {
                    Image(systemName: "sparkles").font(.system(size: 13, weight: .semibold)).frame(width: 30, height: 30).background(Circle().fill(Theme.raised))
                    Text("New bot").font(.system(size: 14, weight: .medium))
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.tertiary)
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
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(configuration.isPressed ? Theme.fillHover : hover ? Theme.fill : .clear))
                .scaleEffect(configuration.isPressed ? 0.985 : 1)
                .animation(Motion.press, value: configuration.isPressed)
                .animation(Motion.hover, value: hover)
                .onHover { hover = $0 }
        }
    }
}

/// Make a bot in Grok Bot, then bring it into the call.
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
            HStack(spacing: 6) {
                Button { model.tray = .add } label: { Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.secondary).frame(width: 26, height: 26) }
                    .buttonStyle(.plain).accessibilityLabel("Back")
                Text("New bot").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                MorphAvatar(shape: shape, color: color, state: .listening).frame(width: 40, height: 40)
                    .id(shape + color).transition(Motion.pop())
            }
            .padding(.bottom, 12)
            DarkTextInput(placeholder: "Name", text: $name).padding(.bottom, 8)
            DarkTextInput(placeholder: "What it does (optional)", text: $about).padding(.bottom, 14)
            let shapes = model.choices?.pickerShapes ?? ["blob"]
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(38), spacing: 8), count: 7), alignment: .leading, spacing: 8) {
                ForEach(shapes, id: \.self) { s in
                    Button { withAnimation(Motion.spring(MotionSpec.press)) { shape = s } } label: {
                        MorphAvatar(shape: s, color: color).frame(width: 28, height: 28).frame(width: 38, height: 38)
                            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(shape == s ? Theme.fillHover : .clear))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(shape == s ? Theme.stroke : .clear, lineWidth: 1))
                    }
                    .buttonStyle(.plain).accessibilityLabel("Shape \(s)").accessibilityAddTraits(shape == s ? .isSelected : [])
                }
            }
            .padding(.bottom, 10)
            HStack(spacing: 10) {
                ForEach(Palette.grok.keys.sorted { order($0) < order($1) }, id: \.self) { c in
                    Button { withAnimation(Motion.spring(MotionSpec.press)) { color = c } } label: {
                        Circle().fill(Palette.body(c, onDark: false).color).frame(width: 20, height: 20)
                            .overlay(Circle().strokeBorder(Color.white, lineWidth: color == c ? 2 : 0).padding(-4))
                            .scaleEffect(color == c ? 1.1 : 1)
                    }
                    .buttonStyle(.plain).accessibilityLabel("Color \(c)").accessibilityAddTraits(color == c ? .isSelected : [])
                }
            }
            .padding(.bottom, 8)
            SettingRow("Voice") { PillMenu(title: "Voice", options: [nil] + (model.choices?.voices ?? []).map { Optional($0) }, label: Labels.voice, selected: voice) { voice = $0 } }
                .padding(.bottom, 10)
            Button {
                creating = true
                Task {
                    if await model.createBot(name: name, description: about, shape: shape, color: color, voice: voice) { model.tray = nil }
                    creating = false
                }
            } label: {
                HStack { if creating { ProgressView().controlSize(.small) }; Text(creating ? "Creating…" : model.inCall ? "Create and add" : "Create") }
            }
            .buttonStyle(FilledButton(primary: true, wide: true))
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
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.tertiary))
            .textFieldStyle(.plain).font(.system(size: 14)).foregroundStyle(Theme.text)
            .focused($focused)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.fill))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(focused ? Theme.accent.opacity(0.7) : Theme.hairline, lineWidth: 1))
            .animation(Motion.hover, value: focused)
    }
}

/// Everything said in the call, in order, and a box to message every bot.
struct ChatTray: View {
    @ObservedObject var model: AppModel
    @ObservedObject var prefs: Prefs
    @Local private var text = ""
    @Local private var sending = false

    var body: some View {
        Panel {
            if let m = model.view?.meeting { MeetingControls(model: model, meeting: m).padding(.bottom, 12) }
            SectionTitle(text: model.view?.meeting == nil ? "Conversation" : "Meeting and whispers")
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if model.lines.isEmpty && model.view?.live == nil {
                            Text("Nothing said yet.").font(.system(size: 13)).foregroundStyle(Theme.secondary)
                        }
                        ForEach(model.lines) { l in
                            row(who: l.who, botId: l.botId, text: l.text, cut: l.cut).id(l.seq)
                                .transition(.asymmetric(insertion: .offset(y: 8).combined(with: .opacity), removal: .opacity))
                        }
                        if let live = model.view?.live, let b = model.callBots.first(where: { $0.id == live.botId }) {
                            row(who: b.name, botId: b.id, text: live.text, cut: false, live: true).id("live")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, 6)
                    .animation(Motion.surface, value: model.lines.count)
                }
                .frame(height: 280)
                .onAppear { proxy.scrollTo(model.view?.live != nil ? AnyHashable("live") : AnyHashable(model.lines.last?.seq ?? 0), anchor: .bottom) }
                .onChange(of: model.lines.count) { _, _ in withAnimation(Motion.surface) { proxy.scrollTo(AnyHashable(model.lines.last?.seq ?? 0), anchor: .bottom) } }
                .onChange(of: model.view?.live?.text) { _, _ in proxy.scrollTo(AnyHashable("live"), anchor: .bottom) }
            }
            .padding(.bottom, 12)
            DarkField(placeholder: "Message everyone", text: $text, disabled: sending) {
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
        let isYou = botId == nil && who == model.hostName
        HStack(alignment: .top, spacing: 10) {
            Group {
                if isYou {
                    HostAvatar(prefs: prefs, name: model.hostName, speaking: false, level: { 0 })
                } else {
                    MorphAvatar(shape: b?.shape ?? model.bots.first { $0.name == who }?.shape, color: b?.color ?? model.bots.first { $0.name == who }?.color)
                }
            }
            .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(isYou ? "You" : who).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.text)
                    if cut { Text("cut off").font(.system(size: 11)).foregroundStyle(Theme.tertiary) }
                    if live { Text("speaking").font(.system(size: 11)).foregroundStyle(Theme.accent) }
                }
                Text(text).font(.system(size: 13.5)).foregroundStyle(live ? Theme.secondary : Theme.text).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Everything waiting for your OK, across all bots.
struct ApprovalsView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        let pending = model.approvals()
        if !pending.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(pending) { a in ApprovalRow(model: model, action: a) }
            }
            .animation(Motion.layout, value: pending.map(\.id))
        }
    }
}

// MARK: - buttons

/// A plain text button: secondary actions like "Open workspace".
struct QuietButton: ButtonStyle {
    var tint: Color = Theme.secondary
    func makeBody(configuration: Configuration) -> some View {
        QuietBody(configuration: configuration, tint: tint)
    }
    struct QuietBody: View {
        let configuration: Configuration
        let tint: Color
        @Local private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(hover ? (tint == Theme.secondary ? Theme.text : tint) : tint)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(Capsule().fill(hover ? Theme.fill : .clear))
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .animation(Motion.press, value: configuration.isPressed)
                .animation(Motion.hover, value: hover)
                .onHover { hover = $0 }
        }
    }
}

/// A solid button. Primary is white on dark (Grok Bot's main action); the rest are a soft fill.
struct FilledButton: ButtonStyle {
    var primary = false
    var danger = false
    var wide = false
    func makeBody(configuration: Configuration) -> some View {
        FilledBody(configuration: configuration, primary: primary, danger: danger, wide: wide)
    }
    struct FilledBody: View {
        let configuration: Configuration
        let primary: Bool, danger: Bool, wide: Bool
        @Environment(\.isEnabled) private var enabled
        @Local private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(primary ? Color.black : Theme.text)
                .frame(maxWidth: wide ? .infinity : nil)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(fill))
                .opacity(enabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(Motion.press, value: configuration.isPressed)
                .animation(Motion.hover, value: hover)
                .onHover { hover = $0 }
        }
        private var fill: Color {
            if primary { return Color.white.opacity(hover ? 0.88 : 1) }
            if danger { return Theme.danger.opacity(hover ? 0.9 : 1) }
            return hover ? Theme.raisedHover : Theme.raised
        }
    }
}

/// A small round "×" in a card's corner.
struct CloseButton: View {
    var action: () -> Void
    @Local private var hover = false
    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(hover ? Theme.text : Theme.secondary)
                .frame(width: 24, height: 24).background(Circle().fill(hover ? Theme.fillHover : Theme.fill))
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(Motion.hover) { hover = h } }
        .accessibilityLabel("Close")
    }
}
