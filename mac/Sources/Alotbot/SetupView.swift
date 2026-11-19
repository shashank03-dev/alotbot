import AppKit
import AlotbotCore
import SwiftUI

/// Every permission Alotbot can use, in one list: the first-run setup and Settings › This Mac both show it.
/// Each one can be turned off again in System Settings; the last line says how.
struct PermissionRows: View {
    @ObservedObject var tools: MacTools
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(MacPermission.allCases, id: \.self) { p in
                row(p.title, p.purpose) {
                    if tools.granted.contains(p) {
                        Label("On", systemImage: "checkmark").foregroundStyle(Theme.secondary)
                    } else {
                        Button("Turn on") { Task { await tools.turnOn(p) } }.buttonStyle(FilledButton())
                    }
                }
            }
            if tools.grokBotInstalled {
                row("Grok Bot: Full Disk Access", "Optional. Lets bots read things like your WhatsApp chats. Drag Grok Bot into the list, then reopen Grok Bot.") {
                    Button("Set up") { tools.openGrokBotDiskAccess() }.buttonStyle(FilledButton())
                }
            }
            if !tools.granted.contains(.screen) {
                HStack(spacing: 4) {
                    Text("After turning on Screen Recording, reopen Alotbot.").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                    Button("Reopen") { AppDelegate.reopenOnQuit = true; NSApp.terminate(nil) }.buttonStyle(QuietButton(tint: Theme.accent))
                }
            }
            HStack(spacing: 4) {
                Text("To turn one off, use System Settings.").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                Button("Open") { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")!) }
                    .buttonStyle(QuietButton(tint: Theme.accent))
            }
        }
        .onAppear { tools.refreshPermissions() }
    }

    private func row<Trailing: View>(_ title: String, _ purpose: String, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.text)
                Text(purpose).font(.system(size: 12)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            trailing()
        }
    }
}

/// Shown once, on first launch. Nothing is required: whatever isn't turned on stays off.
struct SetupView: View {
    @ObservedObject var tools: MacTools
    var done: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Set up Alotbot").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.text)
                Text("Turn on what you want. Anything you skip stays off. You can change all of it later in Settings › This Mac.")
                    .font(.system(size: 13)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            }
            SettingsGroup("Permissions") { PermissionRows(tools: tools) }
            SettingsGroup("Files") {
                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Your files").foregroundStyle(Theme.text)
                        Text("Bots can only read files, never change them.").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                    }
                    Spacer()
                    if tools.folder != nil {
                        Label("On", systemImage: "checkmark").foregroundStyle(Theme.secondary)
                    } else {
                        Button("Choose a folder…") { tools.chooseFolder() }.buttonStyle(QuietButton())
                        Button("Allow all") { tools.requestLocalFileAccess() }.buttonStyle(FilledButton())
                    }
                }
            }
            HStack { Spacer(); Button("Done", action: done).buttonStyle(FilledButton()).keyboardShortcut(.defaultAction) }
        }
        .font(.system(size: 13.5))
        .padding(28)
        .frame(width: 560)
        .background(Theme.chrome)
        .environment(\.colorScheme, .dark)
    }
}

private extension MacPermission {
    var title: String {
        switch self { case .microphone: "Microphone"; case .screen: "Screen Recording"; case .accessibility: "Accessibility" }
    }
    var purpose: String {
        switch self {
        case .microphone: "So bots can hear you."
        case .screen: "So bots can see windows you share."
        case .accessibility: "So bots can press buttons in a window you share."
        }
    }
}
