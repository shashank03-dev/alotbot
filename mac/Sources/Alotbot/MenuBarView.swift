import AlotbotCore
import SwiftUI

/// The menu bar panel: sign in, pick bots and start a call; during a call, what needs you, tasks and leaving.
struct MenuBarView: View {
    @ObservedObject var model: AppModel
    var openSettings: () -> Void
    var quit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Theme.hairline)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    switch model.connection {
                    case .starting:
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Starting…").foregroundStyle(Theme.secondary) }
                    case .failed(let why):
                        VStack(alignment: .leading, spacing: 10) {
                            Text(why).font(.system(size: 13)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
                            Button("Try again") { model.restartBackend() }.buttonStyle(WideButton())
                        }
                    case .ready:
                        ready
                    }
                }
                .padding(16)
                .animation(Motion.layout, value: model.inCall)
            }
            .frame(maxHeight: 540)
            Divider().overlay(Theme.hairline)
            HStack {
                Button("Settings", action: openSettings).buttonStyle(QuietButton(tint: Theme.text))
                Spacer()
                Button("Quit", action: quit).buttonStyle(QuietButton())
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
        }
        .frame(width: 360)
        .background(Theme.chrome)
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "waveform.circle.fill").font(.system(size: 20)).foregroundStyle(Theme.text)
            Text("Alotbot").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
            Spacer()
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    @ViewBuilder private var ready: some View {
        switch model.login.state {
        case "signed-in":
            if model.inCall { callSection.transition(Motion.fadeTransition()) } else { pickSection.transition(Motion.fadeTransition()) }
            if let missed = model.incoming?.missed, !missed.isEmpty { MissedCalls(model: model, missed: missed, compact: true) }
            ApprovalsView(model: model)
            TasksSection(model: model)
        case "signing-in":
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Finish signing in in your browser.").font(.system(size: 13)).foregroundStyle(Theme.text) }
                Button("Open the page again") { Task { await model.signIn() } }.buttonStyle(QuietButton())
            }
        default:
            VStack(alignment: .leading, spacing: 12) {
                Text("Sign in with your Grok account to call your bots.").font(.system(size: 13)).foregroundStyle(Theme.text)
                if let e = model.login.error { Text(e).font(.system(size: 12.5)).foregroundStyle(Theme.danger) }
                Button("Sign in") { Task { await model.signIn() } }.buttonStyle(WideButton(primary: true))
            }
        }
    }

    private var pickSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle(text: "Choose bots")
            if let err = model.botsError, model.bots.isEmpty {
                Text("Couldn't load your bots. \(err)").font(.system(size: 13)).foregroundStyle(Theme.danger)
                Button("Try again") { Task { await model.refreshBots() } }.buttonStyle(QuietButton())
            } else if model.bots.isEmpty {
                Text("No bots yet. Create one in the Grok Bot app.").font(.system(size: 13)).foregroundStyle(Theme.secondary)
                Button("Refresh") { Task { await model.refreshBots() } }.buttonStyle(QuietButton())
            } else {
                ForEach(model.bots) { b in
                    let on = model.picked.contains(b.id)
                    Button {
                        withAnimation(Motion.spring(MotionSpec.press)) { if on { model.picked.remove(b.id) } else { model.picked.insert(b.id) } }
                    } label: {
                        HStack(spacing: 12) {
                            MorphAvatar(shape: b.shape, color: b.color, state: on ? .listening : .idle).frame(width: 30, height: 30)
                            Text(b.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                            Spacer()
                            Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.system(size: 18))
                                .foregroundStyle(on ? Theme.accent : Theme.tertiary)
                                .scaleEffect(on ? 1.08 : 1)
                        }
                        .padding(.vertical, 6).padding(.horizontal, 8).contentShape(Rectangle())
                    }
                    .contextMenu { Button("Open workspace") { model.openWorkspace(b.id) } }
                    .buttonStyle(RowStyle())
                    .accessibilityLabel(b.name).accessibilityAddTraits(on ? .isSelected : [])
                }
                Button {
                    Task { await model.join() }
                } label: {
                    HStack { if model.joining { ProgressView().controlSize(.small) }; Text(model.picked.isEmpty ? "Choose a bot to start" : model.joining ? "Starting…" : "Start call") }
                }
                .buttonStyle(WideButton(primary: true))
                .disabled(model.picked.isEmpty || model.joining)
                .padding(.top, 10)
                MeetingStartView(model: model)
            }
        }
    }

    private var callSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                HStack(spacing: -8) {
                    ForEach(model.callBots) { b in
                        MorphAvatar(shape: b.shape, color: b.color, state: avatarState(for: b.status)).frame(width: 30, height: 30)
                            .transition(Motion.pop())
                    }
                }
                Text(model.callBots.map(\.name).joined(separator: ", ")).font(.system(size: 12.5)).foregroundStyle(Theme.secondary).lineLimit(2)
            }
            .animation(Motion.layout, value: model.callBots.map(\.id))
            if let m = model.view?.meeting {
                Label("Listening to \(m.app)", systemImage: "person.3.fill").font(.system(size: 12.5)).foregroundStyle(Theme.text)
            }
            if let sc = model.view?.screen {
                Label("Sharing \(sc.label)", systemImage: "rectangle.on.rectangle").font(.system(size: 12.5)).foregroundStyle(Theme.text)
            }
            HStack(spacing: 8) {
                Button(model.overlayShown ? "Hide call" : "Show call") { withAnimation(Motion.surface) { model.overlayShown.toggle() } }.buttonStyle(WideButton())
                Button { Task { await model.leave() } } label: { Text(model.leaving ? "Saving…" : "Leave call") }
                    .buttonStyle(WideButton(danger: true)).disabled(model.leaving)
            }
        }
    }
}

/// Every task, grouped by who it's for, and a box to add one.
struct TasksSection: View {
    @ObservedObject var model: AppModel
    @Local private var openOnly = true
    @Local private var title = ""
    @Local private var owner: String? = nil
    @Local private var adding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                SectionTitle(text: "Tasks")
                Spacer()
                Button(openOnly ? "Show done" : "Hide done") { withAnimation(Motion.layout) { openOnly.toggle() } }.buttonStyle(QuietButton())
            }
            let groups = TaskSort.groups(model.tasks, host: model.hostName, openOnly: openOnly)
            if groups.isEmpty {
                Text(openOnly ? "Nothing to do." : "No tasks yet. Add one, or ask a bot during a call.").font(.system(size: 13)).foregroundStyle(Theme.secondary)
            }
            ForEach(groups) { g in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        if let o = g.owner, let b = model.bots.first(where: { $0.name == o }) {
                            MorphAvatar(shape: b.shape, color: b.color).frame(width: 18, height: 18)
                        }
                        Text(g.owner == model.hostName ? "You" : g.owner ?? "Anyone").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.text)
                    }
                    .padding(.leading, 8).padding(.bottom, 2)
                    ForEach(g.items) { row in
                        TaskLine(model: model, task: row.task, compact: true)
                        ForEach(row.parts) { p in TaskLine(model: model, task: p, compact: true, indent: true) }
                    }
                }
            }
            HStack(spacing: 8) {
                DarkTextInput(placeholder: "Add a task", text: $title).onSubmit(add)
                Menu {
                    Button("Anyone") { owner = nil }
                    ForEach(model.owners, id: \.self) { o in Button(o == model.hostName ? "You" : o) { owner = o } }
                } label: { MenuLabel(text: owner.map { $0 == model.hostName ? "You" : $0 } ?? "Anyone") }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel("Who it's for")
            }
            .padding(.top, 4)
            .disabled(adding)
        }
        .animation(Motion.layout, value: model.tasks.map(\.id))
    }

    private func add() {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, !adding else { return }
        adding = true
        Task {
            if await model.addTask(title: t, owner: owner, parent: nil, waitsOn: []) { title = "" }
            adding = false
        }
    }
}

/// Full-width rounded buttons in the menu bar panel.
struct WideButton: ButtonStyle {
    var primary = false
    var danger = false
    func makeBody(configuration: Configuration) -> some View {
        FilledButton(primary: primary, danger: danger, wide: true).makeBody(configuration: configuration)
    }
}
