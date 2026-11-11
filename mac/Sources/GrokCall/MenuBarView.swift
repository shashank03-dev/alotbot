import GrokCallCore
import SwiftUI

/// The menu bar panel: sign-in, picking bots and joining, the call, and every task.
struct MenuBarView: View {
    @ObservedObject var model: AppModel
    var openSettings: () -> Void
    var quit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Theme.hairline)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    switch model.connection {
                    case .starting:
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Starting…").foregroundStyle(Theme.secondary) }
                    case .failed(let why):
                        VStack(alignment: .leading, spacing: 10) {
                            Text(why).font(.system(size: 13)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
                            Button("Start again") { model.restartBackend() }.buttonStyle(WideButton())
                        }
                    case .ready:
                        ready
                    }
                }
                .padding(16)
            }
            .frame(maxHeight: 520)
            Divider().overlay(Theme.hairline)
            HStack {
                Button("Settings…", action: openSettings).buttonStyle(.plain).foregroundStyle(Theme.text)
                Spacer()
                Button("Quit Grok Call", action: quit).buttonStyle(.plain).foregroundStyle(Theme.secondary)
            }
            .font(.system(size: 13))
            .padding(.horizontal, 16).padding(.vertical, 11)
        }
        .frame(width: 380)
        .background(Theme.surface)
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "waveform.circle.fill").font(.system(size: 20)).foregroundStyle(Theme.accent)
            Text("Grok Call").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
            Spacer()
            if model.inCall {
                Text("In a call").font(.system(size: 11.5, weight: .medium)).foregroundStyle(.green)
                    .padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(Color.green.opacity(0.14)))
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    @ViewBuilder private var ready: some View {
        switch model.login.state {
        case "signed-in":
            if model.inCall { callSection } else { pickSection }
            if let last = model.lastCall, !model.inCall { lastCallCard(last) }
            TasksSection(model: model)
            ActionsView(model: model)
        case "signing-in":
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Finish signing in on the page that opened. This updates by itself.").font(.system(size: 13)).foregroundStyle(Theme.text) }
                Button("Open the sign-in page again") { Task { await model.signIn() } }.buttonStyle(.plain).font(.system(size: 12.5)).foregroundStyle(Theme.secondary)
            }
        default:
            VStack(alignment: .leading, spacing: 10) {
                Text("Sign in with your Grok Bot account to call your bots.").font(.system(size: 13)).foregroundStyle(Theme.text)
                if let e = model.login.error { Text(e).font(.system(size: 12.5)).foregroundStyle(Theme.danger) }
                Button("Sign in") { Task { await model.signIn() } }.buttonStyle(WideButton())
            }
        }
    }

    private var pickSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Who's in the call")
            if let err = model.botsError, model.bots.isEmpty {
                Text("Couldn't load your bots: \(err)").font(.system(size: 13)).foregroundStyle(Theme.danger)
                Button("Try again") { Task { await model.refreshBots() } }.buttonStyle(.plain).foregroundStyle(Theme.text)
            } else if model.bots.isEmpty {
                Text("No Grok Bots on this account yet. Make one in the Grok Bot app, or with + during a call.").font(.system(size: 13)).foregroundStyle(Theme.secondary)
                Button("Check again") { Task { await model.refreshBots() } }.buttonStyle(.plain).foregroundStyle(Theme.text)
            } else {
                ForEach(model.bots) { b in
                    let on = model.picked.contains(b.id)
                    Button {
                        if on { model.picked.remove(b.id) } else { model.picked.insert(b.id) }
                    } label: {
                        HStack(spacing: 12) {
                            MorphAvatar(shape: b.shape, color: b.color, state: on ? .listening : .idle).frame(width: 30, height: 30)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(b.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                                Text(Labels.voice(b.voice)).font(.system(size: 12)).foregroundStyle(Theme.secondary)
                            }
                            Spacer()
                            Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.system(size: 18)).foregroundStyle(on ? Theme.accent : Theme.secondary)
                        }
                        .padding(.vertical, 5).padding(.horizontal, 8).contentShape(Rectangle())
                    }
                    .buttonStyle(RowStyle())
                    .accessibilityLabel(b.name).accessibilityAddTraits(on ? .isSelected : [])
                }
                Button {
                    Task { await model.join() }
                } label: {
                    HStack { if model.joining { ProgressView().controlSize(.small) }; Text(model.picked.isEmpty ? "Pick at least one bot" : model.joining ? "Joining…" : "Join call with \(model.picked.count) \(model.picked.count == 1 ? "bot" : "bots")") }
                }
                .buttonStyle(WideButton(primary: true))
                .disabled(model.picked.isEmpty || model.joining)
                .padding(.top, 6)
            }
        }
    }

    private var callSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "In the call")
            HStack(spacing: -6) {
                ForEach(model.callBots) { b in MorphAvatar(shape: b.shape, color: b.color, state: avatarState(for: b.status)).frame(width: 30, height: 30) }
            }
            Text(model.callBots.map(\.name).joined(separator: ", ")).font(.system(size: 12.5)).foregroundStyle(Theme.secondary)
            HStack(spacing: 8) {
                Button(model.overlayShown ? "Hide overlay" : "Show overlay") { model.overlayShown.toggle() }.buttonStyle(WideButton())
                Button(model.mode == .circle ? "Open pill" : "Fold to circle") { model.setMode(model.mode == .circle ? .pill : .circle) }.buttonStyle(WideButton())
            }
            Button(model.mode == .full ? "Close full view" : "Full view") { model.setMode(model.mode == .full ? .pill : .full) }.buttonStyle(WideButton())
            Button { Task { await model.leave() } } label: { Text(model.leaving ? "Saving the call…" : "Leave call") }
                .buttonStyle(WideButton(danger: true)).disabled(model.leaving)
            Text("⌥Esc stops every bot from anywhere.").font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
        }
    }

    private func lastCallCard(_ r: LeaveResult) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "Last call")
            Text(r.summary.isEmpty ? "No summary was saved." : r.summary).font(.system(size: 13)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            if !r.actionItems.isEmpty {
                ForEach(r.actionItems, id: \.self) { a in Text("• \(a)").font(.system(size: 12.5)).foregroundStyle(Theme.secondary) }
            }
            if let file = r.file, let c = model.pastCalls.first(where: { $0.file == file }) {
                Button("Save to Downloads") { model.saveToDownloads(c) }.buttonStyle(.plain).font(.system(size: 12.5)).foregroundStyle(Theme.accent)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.04)))
    }
}

/// Every task, by owner, with a way to add one.
struct TasksSection: View {
    @ObservedObject var model: AppModel
    @Local private var openOnly = true
    @Local private var title = ""
    @Local private var owner: String? = nil
    @Local private var parent: Int? = nil
    @Local private var waitsOn: [Int] = []
    @Local private var adding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionTitle(text: "Tasks")
                Spacer()
                Picker("", selection: $openOnly) { Text("Open").tag(true); Text("All").tag(false) }
                    .pickerStyle(.segmented).frame(width: 120).labelsHidden()
                    .padding(.bottom, 10)
            }
            let groups = TaskSort.groups(model.tasks, host: model.hostName, openOnly: openOnly)
            if groups.isEmpty {
                Text(openOnly ? "No open tasks." : "No tasks yet. Add one below, or ask a bot in a call.").font(.system(size: 13)).foregroundStyle(Theme.secondary)
            }
            ForEach(groups) { g in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        if let o = g.owner, let b = model.bots.first(where: { $0.name == o }) {
                            MorphAvatar(shape: b.shape, color: b.color).frame(width: 18, height: 18)
                        }
                        Text(g.owner == model.hostName ? "You" : g.owner ?? "Nobody yet").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.text)
                    }
                    .padding(.leading, 8).padding(.bottom, 2)
                    ForEach(g.items) { row in
                        TaskLine(model: model, task: row.task)
                        ForEach(row.parts) { p in TaskLine(model: model, task: p, indent: true) }
                    }
                }
            }
            addRow
        }
    }

    private var addRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            DarkTextInput(placeholder: "Add a task…", text: $title)
                .onSubmit(add)
            HStack(spacing: 6) {
                Menu {
                    Button("Nobody yet") { owner = nil }
                    ForEach(model.owners, id: \.self) { o in Button(o == model.hostName ? "You" : o) { owner = o } }
                } label: { chip("person", owner.map { $0 == model.hostName ? "You" : $0 } ?? "Owner") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                Menu {
                    Button("No parent") { parent = nil }
                    ForEach(model.tasks.filter { $0.parent == nil }) { t in Button("#\(t.id) \(t.title)") { parent = t.id } }
                } label: { chip("arrow.turn.down.right", parent.map { "Part of #\($0)" } ?? "Parent") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                Menu {
                    ForEach(model.tasks.filter { $0.id != parent }) { t in
                        Button { if let i = waitsOn.firstIndex(of: t.id) { waitsOn.remove(at: i) } else { waitsOn.append(t.id) } } label: {
                            if waitsOn.contains(t.id) { Label("#\(t.id) \(t.title)", systemImage: "checkmark") } else { Text("#\(t.id) \(t.title)") }
                        }
                    }
                } label: { chip("link", waitsOn.isEmpty ? "Waits on" : "Waits on " + waitsOn.map { "#\($0)" }.joined(separator: ", ")) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .disabled(model.tasks.isEmpty)
                Spacer()
                Button(action: add) { if adding { ProgressView().controlSize(.small) } else { Text("Add").font(.system(size: 12.5, weight: .semibold)) } }
                    .buttonStyle(.plain).foregroundStyle(title.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.secondary : Theme.text)
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || adding)
            }
        }
        .padding(.top, 4)
    }

    private func chip(_ symbol: String, _ text: String) -> some View {
        HStack(spacing: 4) { Image(systemName: symbol).font(.system(size: 10)); Text(text).lineLimit(1) }
            .font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Capsule().stroke(Color.white.opacity(0.14), lineWidth: 1))
    }

    private func add() {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, !adding else { return }
        adding = true
        Task {
            if await model.addTask(title: t, owner: owner, parent: parent, waitsOn: waitsOn) {
                title = ""; parent = nil; waitsOn = []
            }
            adding = false
        }
    }
}

/// Full-width rounded buttons in the menu bar panel.
struct WideButton: ButtonStyle {
    var primary = false
    var danger = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13.5, weight: .semibold))
            .foregroundStyle(primary ? Color.black : danger ? Color.white : Theme.text)
            .frame(maxWidth: .infinity).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 12).fill(primary ? Color.white : danger ? Theme.danger : Theme.raised).opacity(configuration.isPressed ? 0.8 : 1))
    }
}
