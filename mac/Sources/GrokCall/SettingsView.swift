import AppKit
import GrokCallCore
import SwiftUI

/// The settings window: account, how you look, the overlay, and past calls.
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var prefs: Prefs

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                account
                look
                overlay
                LocalToolsSettings(model: model, tools: model.macTools)
                VStack(alignment: .leading, spacing: 10) {
                    SectionTitle(text: "Bot skills, routines and files")
                    ForEach(model.bots) { bot in Button("Load \(bot.name)") { Task { await model.refreshResources(bot.id) } } }
                    if !model.resourceText.isEmpty { Text(model.resourceText).font(.system(size: 11, design: .monospaced)).textSelection(.enabled) }
                }
                calls
            }
            .padding(24)
        }
        .frame(width: 520, height: 620)
        .background(Theme.surface)
        .environment(\.colorScheme, .dark)
    }

    private var account: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "Account")
            switch model.login.state {
            case "signed-in":
                HStack {
                    Label("Signed in to Grok Bot", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.text)
                    Spacer()
                    Button("Sign out") { Task { await model.signOut() } }.disabled(model.inCall).help(model.inCall ? "Leave the call first" : "")
                }
            case "signing-in":
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Finish signing in in your browser.").foregroundStyle(Theme.text) }
            default:
                HStack {
                    Text("Not signed in").foregroundStyle(Theme.secondary)
                    Spacer()
                    Button("Sign in") { Task { await model.signIn() } }.disabled(model.connection != .ready)
                }
            }
            Text("Grok Call signs in the same way the Grok Bot app does. It's unofficial, so xAI could change or block it.")
                .font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
        }
        .font(.system(size: 13.5))
    }

    private var look: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(text: "How you look in the call")
            HStack(spacing: 18) {
                HostAvatar(prefs: prefs, name: model.hostName, speaking: false, level: { 0 }).frame(width: 64, height: 64)
                Picker("", selection: $prefs.hostLook) { ForEach(HostLook.allCases) { Text($0.label).tag($0) } }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 280)
            }
            switch prefs.hostLook {
            case .initials:
                Text("Shows \"\(String(model.hostName.prefix(1)).uppercased())\".").font(.system(size: 12.5)).foregroundStyle(Theme.secondary)
            case .photo:
                HStack {
                    Button(prefs.photo == nil ? "Choose photo…" : "Change photo…") { pickPhoto() }
                    if prefs.photo == nil { Text("Initials show until you pick one.").font(.system(size: 12.5)).foregroundStyle(Theme.secondary) }
                }
            case .character:
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(40), spacing: 8), count: 9), alignment: .leading, spacing: 8) {
                    ForEach(model.choices?.shapes ?? ["blob"], id: \.self) { s in
                        Button { prefs.hostShape = s } label: {
                            MorphAvatar(shape: s, color: prefs.hostColor).frame(width: 30, height: 30).frame(width: 40, height: 40)
                                .background(RoundedRectangle(cornerRadius: 10).fill(prefs.hostShape == s ? Color.white.opacity(0.14) : .clear))
                        }
                        .buttonStyle(.plain).accessibilityLabel("Shape \(s)")
                    }
                }
                HStack(spacing: 8) {
                    ForEach(Palette.grok.keys.sorted(), id: \.self) { c in
                        Button { prefs.hostColor = c } label: {
                            Circle().fill(Palette.body(c, onDark: false).color).frame(width: 20, height: 20)
                                .overlay(Circle().stroke(Color.white, lineWidth: prefs.hostColor == c ? 2 : 0).padding(-3))
                        }
                        .buttonStyle(.plain).accessibilityLabel("Color \(c)")
                    }
                }
            }
        }
    }

    private var overlay: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Overlay")
            Toggle("Keep the pill open when I switch apps", isOn: $prefs.keepPill).foregroundStyle(Theme.text)
            Text("Off: the pill folds into the circle when you click another app. You can always fold it by clicking your own avatar.")
                .font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
            Text("⌥Esc stops every bot from anywhere; Esc does the same while the pill is focused.").font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
        }
        .font(.system(size: 13.5))
    }

    private var calls: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "Past calls")
            if model.pastCalls.isEmpty {
                Text("No saved calls yet.").font(.system(size: 13)).foregroundStyle(Theme.secondary)
            }
            ForEach(model.pastCalls) { c in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(Date(timeIntervalSince1970: c.at / 1000).formatted(date: .abbreviated, time: .shortened)).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.text)
                        Spacer()
                        Button("Show in Finder") { if let u = model.callURL(c) { NSWorkspace.shared.activateFileViewerSelecting([u]) } }.buttonStyle(.plain).foregroundStyle(Theme.secondary)
                        Button("Save to Downloads") { model.saveToDownloads(c) }.buttonStyle(.plain).foregroundStyle(Theme.accent)
                    }
                    .font(.system(size: 12))
                    Text(c.summary.isEmpty ? "No summary was saved." : c.summary).font(.system(size: 12.5)).foregroundStyle(Theme.secondary).lineLimit(3)
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.04)))
            }
        }
        .task { await model.refreshCalls() }
    }

    private func pickPhoto() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.image]
        p.allowsMultipleSelection = false
        guard p.runModal() == .OK, let url = p.url else { return }
        do { try prefs.setPhoto(from: url) } catch { model.show("Couldn't use that photo: \(error.localizedDescription)") }
    }
}


struct LocalToolsSettings: View {
    @ObservedObject var model: AppModel
    @ObservedObject var tools: MacTools
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "This Mac")
            Text(tools.folder?.path ?? "File access is off").font(.caption).textSelection(.enabled)
            HStack {
                Button("Choose folder…") { tools.chooseFolder() }
                if tools.folder != nil { Button("Remove access") { tools.forgetFolder() } }
            }
            Text("Bots can list and read UTF-8 files up to 256 KiB inside this folder.").font(.caption).foregroundStyle(Theme.secondary)
            Toggle("Dedicated browser", isOn: Binding(get: { model.browserEnabled }, set: { enabled in Task { await model.setBrowserEnabled(enabled) } }))
            Text(tools.sharedWindow).font(.caption)
            HStack {
                Button("Share one window…") { tools.chooseWindow() }
                Button("Stop sharing") { tools.stopSharing() }
            }
            if let error = tools.error { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
    }
}
