import AppKit
import AlotbotCore
import SwiftUI

enum SettingsTab: String, CaseIterable, Identifiable {
    case general = "General", incoming = "Calls to you", connections = "Connections", mac = "This Mac", calls = "Call history"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .general: "gearshape"
        case .incoming: "phone.arrow.down.left"
        case .connections: "puzzlepiece.extension"
        case .mac: "laptopcomputer"
        case .calls: "clock.arrow.circlepath"
        }
    }
}

/// The settings window: you and your bots, the apps bots can use, what bots can reach on this Mac, and past calls.
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var prefs: Prefs
    @Local private var tab = SettingsTab.general

    var body: some View {
        VStack(spacing: 0) {
            SlidingSegments(selection: $tab, items: SettingsTab.allCases.map { .init(value: $0, title: $0.rawValue, icon: $0.icon) })
                .frame(width: 720).padding(.vertical, 14)
            Divider().overlay(Theme.hairline)
            Group {
                switch tab {
                case .connections:
                    if model.login.state == "signed-in" { ConnectionsView(backend: model.backend, embedded: true) } else { signInFirst }
                case .general: page { account; look; callWindow; MeetingMicSettings(model: model); yourBots }
                case .incoming:
                    if model.login.state == "signed-in" { page { IncomingSettingsView(model: model) } } else { signInFirst }
                case .mac: page { LocalToolsSettings(model: model, tools: model.macTools) }
                case .calls: LibraryView(model: model)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .transition(.opacity)
            .animation(Motion.crossfade, value: tab)
        }
        .frame(minWidth: 900, minHeight: 650)
        .background(Theme.chrome)
        .environment(\.colorScheme, .dark)
    }

    /// A centered, readable column of grouped sections.
    private func page<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) { content() }
                .frame(maxWidth: 560, alignment: .leading)
                .padding(.vertical, 28)
                .frame(maxWidth: .infinity)
        }
    }

    private var signInFirst: some View {
        Text("Sign in first.").foregroundStyle(Theme.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var account: some View {
        SettingsGroup("Account") {
            HStack {
                switch model.login.state {
                case "signed-in":
                    Label("Signed in to Grok", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.text)
                    Spacer()
                    Button("Sign out") { Task { await model.signOut() } }.buttonStyle(FilledButton()).disabled(model.inCall).help(model.inCall ? "Leave the call first" : "")
                case "signing-in":
                    ProgressView().controlSize(.small); Text("Finish signing in in your browser.").foregroundStyle(Theme.text)
                    Spacer()
                default:
                    Text("Not signed in").foregroundStyle(Theme.secondary)
                    Spacer()
                    Button("Sign in") { Task { await model.signIn() } }.buttonStyle(FilledButton(primary: true)).disabled(model.connection != .ready)
                }
            }
        }
    }

    private var look: some View {
        SettingsGroup("You in calls") {
            HStack(spacing: 18) {
                HostAvatar(prefs: prefs, name: model.hostName, speaking: false, level: { 0 }).frame(width: 56, height: 56)
                Picker("", selection: $prefs.hostLook) { ForEach(HostLook.allCases) { Text($0.label).tag($0) } }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 280)
            }
            switch prefs.hostLook {
            case .initials: EmptyView()
            case .photo:
                Button(prefs.photo == nil ? "Choose photo…" : "Change photo…") { pickPhoto() }.buttonStyle(FilledButton())
            case .character:
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(40), spacing: 8), count: 10), alignment: .leading, spacing: 8) {
                    ForEach(model.choices?.shapes ?? ["blob"], id: \.self) { s in
                        Button { withAnimation(Motion.spring(MotionSpec.press)) { prefs.hostShape = s } } label: {
                            MorphAvatar(shape: s, color: prefs.hostColor).frame(width: 28, height: 28).frame(width: 40, height: 40)
                                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(prefs.hostShape == s ? Theme.fillHover : .clear))
                        }
                        .buttonStyle(.plain).accessibilityLabel("Shape \(s)").accessibilityAddTraits(prefs.hostShape == s ? .isSelected : [])
                    }
                }
                HStack(spacing: 10) {
                    ForEach(Palette.grok.keys.sorted(), id: \.self) { c in
                        Button { withAnimation(Motion.spring(MotionSpec.press)) { prefs.hostColor = c } } label: {
                            Circle().fill(Palette.body(c, onDark: false).color).frame(width: 20, height: 20)
                                .overlay(Circle().strokeBorder(Color.white, lineWidth: prefs.hostColor == c ? 2 : 0).padding(-4))
                        }
                        .buttonStyle(.plain).accessibilityLabel("Color \(c)").accessibilityAddTraits(prefs.hostColor == c ? .isSelected : [])
                    }
                }
            }
        }
    }

    private var callWindow: some View {
        SettingsGroup("During a call") {
            Toggle(isOn: $prefs.keepPill) { Text("Keep the call open when I switch apps").frame(maxWidth: .infinity, alignment: .leading) }.toggleStyle(.switch).foregroundStyle(Theme.text)
            Text("Press ⌥ Esc to stop every bot from talking.").font(.system(size: 12)).foregroundStyle(Theme.secondary)
        }
    }

    private var yourBots: some View {
        SettingsGroup("Your bots") {
            if model.bots.isEmpty { Text("No bots yet.").foregroundStyle(Theme.secondary) }
            ForEach(model.bots) { bot in
                HStack(spacing: 12) {
                    MorphAvatar(shape: bot.shape, color: bot.color).frame(width: 26, height: 26)
                    Text(bot.name).foregroundStyle(Theme.text)
                    Spacer()
                    Button("Open workspace") { model.openWorkspace(bot.id) }.buttonStyle(QuietButton())
                }
            }
        }
    }

    private func pickPhoto() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.image]
        p.allowsMultipleSelection = false
        guard p.runModal() == .OK, let url = p.url else { return }
        do { try prefs.setPhoto(from: url) } catch { model.show("Couldn't use that photo: \(error.localizedDescription)") }
    }
}

/// Alotbot Mic: installed or not, and how a meeting uses it.
struct MeetingMicSettings: View {
    @ObservedObject var model: AppModel
    var body: some View {
        let installed = model.meetingMicInstalled
        SettingsGroup("Meetings") {
            if !MeetingMic.supported {
                Text("Alotbot Mic needs macOS 14.2 or later. Until then, mute yourself in the meeting before you talk to your bots.")
                    .foregroundStyle(Theme.secondary)
            } else if installed {
                Text("Alotbot Mic is installed. Choose it as the microphone in your meeting app: the meeting hears you, and not what you say to your bots while you hold ⌥ Space.")
                    .foregroundStyle(Theme.text)
            } else {
                Text("So a meeting doesn't hear what you say to your bots, install Alotbot Mic, then choose it as the microphone in your meeting app.")
                    .foregroundStyle(Theme.text)
                Button("Install Alotbot Mic…") { model.installMeetingMic() }
                .buttonStyle(FilledButton())
                .disabled(model.inCall)
                Text(model.inCall ? "Available after this call: installing restarts your Mac's sound for a moment." : "Needs your admin password, and restarts your Mac's sound for a moment.")
                    .font(.system(size: 12)).foregroundStyle(Theme.secondary)
            }
            if let error = model.meetingMicError { Text(error).font(.system(size: 12.5)).foregroundStyle(Theme.danger) }
        }
        .onAppear { model.meetingMicInstalled = MeetingMic.device() != nil }
    }
}

/// A titled, raised group of settings.
struct SettingsGroup<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    init(_ title: String, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle(text: title).padding(.leading, 4)
            VStack(alignment: .leading, spacing: 12) { content }
                .font(.system(size: 13.5))
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .elevated(RoundedRectangle(cornerRadius: 16, style: .continuous), high: false)
        }
    }
}

/// What bots can reach on this Mac: files, a browser of their own, your open windows.
struct LocalToolsSettings: View {
    @ObservedObject var model: AppModel
    @ObservedObject var tools: MacTools
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            SettingsGroup("Permissions") { PermissionRows(tools: tools) }
            SettingsGroup("Files") {
                Text(tools.folder?.path == "/" ? "Bots can read any file on this Mac." : tools.folder.map { "Bots can read files in \($0.path)." } ?? "Bots can't read your files.")
                    .foregroundStyle(Theme.text).textSelection(.enabled)
                HStack(spacing: 8) {
                    if tools.folder?.path != "/" { Button("Allow all files") { tools.requestLocalFileAccess() }.buttonStyle(FilledButton()) }
                    Button("Choose a folder…") { tools.chooseFolder() }.buttonStyle(FilledButton())
                    if tools.folder != nil { Button("Turn off") { tools.forgetFolder() }.buttonStyle(QuietButton(tint: Theme.danger)) }
                }
                Text("Bots can only read files, never change them.").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                if tools.folder?.path == "/" {
                    Button("Open macOS file access settings") { if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") { NSWorkspace.shared.open(url) } }
                        .buttonStyle(QuietButton(tint: Theme.accent)).padding(.leading, -8)
                }
            }
            SettingsGroup("Browser") {
                Toggle(isOn: Binding(get: { model.browserEnabled }, set: { enabled in Task { await model.setBrowserEnabled(enabled) } })) { Text("Let bots use their own browser on this Mac").frame(maxWidth: .infinity, alignment: .leading) }
                    .toggleStyle(.switch)
            }
            SettingsGroup("Your screen") {
                Toggle(isOn: Binding(get: { tools.observationEnabled }, set: { tools.setObservationEnabled($0) })) { Text("Let bots see your open windows").frame(maxWidth: .infinity, alignment: .leading) }.toggleStyle(.switch)
                Divider().overlay(Theme.hairline)
                Text(tools.sharedWindow).foregroundStyle(Theme.text)
                HStack(spacing: 8) {
                    Button("Share one window…") { tools.chooseWindow() }.buttonStyle(FilledButton())
                    Button("Stop sharing") { tools.stopSharing() }.buttonStyle(QuietButton())
                }
            }
            if let error = tools.error { Text(error).font(.system(size: 12.5)).foregroundStyle(Theme.danger) }
        }
    }
}
