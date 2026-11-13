import AppKit
import SwiftUI

struct WorkspaceSetupCardEditor: View {
    @ObservedObject var model: BotWorkspaceModel
    let card: WorkspaceActivity.Card
    @Environment(\.dismiss) private var dismiss
    @Local private var shape = "blob"
    @Local private var color = "black"
    @Local private var shapes: [String] = []
    @Local private var colors: [String: String] = [:]
    @Local private var slug = ""
    @Local private var visibility = "private"
    @Local private var error: String?
    @Local private var status: String?
    @Local private var busy = false
    @Local private var confirming: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(card.title).font(.title2)
            Text(model.name).foregroundStyle(.secondary)
            switch card.kind {
            case "appearance-picker":
                Picker("Shape", selection: $shape) { ForEach(shapes, id: \.self) { Text($0.capitalized).tag($0) } }
                Picker("Color", selection: $color) { ForEach(colors.keys.sorted(), id: \.self) { Text($0.capitalized).tag($0) } }
                Button("Save appearance") { Task { await submit("appearanceSave", ["shape": shape, "color": color]) } }.disabled(shapes.isEmpty)
            case "email-offer":
                Text(card.details?["email"] ?? "Bot email address unavailable").font(.headline).textSelection(.enabled)
                Text("Use this email address for this bot? Nothing is sent.").font(.callout)
                HStack {
                    Button("Use this address") { Task { await submit("emailUse") } }
                    Button("Not now") { Task { await submit("emailDecline") } }
                }
            case "team-access":
                Text("Sharing lets your team use this bot and see its chats. A team copy is separate and has none of your secrets.").font(.callout)
                HStack {
                    Button("Share this bot…") { confirming = "teamShare" }
                    Button("Create team copy…") { confirming = "teamCopy" }
                }
                Button("Refresh sharing status") { Task { await sharingStatus() } }
            case "publish-approval":
                Text("Check who will see it before you publish.").font(.callout)
                if let site = card.details?["apex"] { Text("Domain: \(site)").font(.caption).textSelection(.enabled) }
                TextField("Site name", text: $slug)
                Picker("Audience", selection: $visibility) {
                    Text("Private").tag("private"); Text("Team").tag("team"); Text("Public").tag("public")
                }
                HStack {
                    Button("Publish…") { confirming = "publishConfirm" }.disabled(slug.isEmpty)
                    Button("Decline proposal…") { confirming = "publishDismiss" }
                }
            case "notifications-enable":
                Text("Turn on notifications in Grok Bot. This app can't do it for you.").font(.callout)
                Button("Open Grok Bot") { model.openNativeBot() }
                Button("Dismiss this reminder") { Task { await submit("setupDismiss") } }
            default: EmptyView()
            }
            if let status { Text(status).font(.callout).textSelection(.enabled) }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack { if busy { ProgressView().controlSize(.small) }; Spacer(); Button("Done") { dismiss() } }
        }.padding(24).frame(width: 560).disabled(busy)
        .task {
            slug = card.details?["slug"] ?? ""
            if card.kind == "appearance-picker" {
                do {
                    struct Appearance: Decodable { let shape, color: String; let shapes: [String]; let colors: [String: String] }
                    let value = try JSONDecoder().decode(Appearance.self, from: await model.data("appearanceOptions"))
                    shape = value.shape; color = value.color; shapes = value.shapes; colors = value.colors
                } catch { self.error = error.localizedDescription }
            }
        }
        .confirmationDialog("Confirm this action for \(model.name)?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
            Button("Confirm") { if let action = confirming { Task { await submit(action, ["slug": slug, "visibility": visibility, "userConfirmed": true]) } }; confirming = nil }
            Button("Cancel", role: .cancel) { confirming = nil }
        } message: {
            Text(confirming == "publishConfirm" ? "Publish \(slug) for the \(visibility) audience. Future updates require your confirmation." : confirming == "publishDismiss" ? "Decline only this publishing proposal." : confirming == "teamShare" ? "Share this bot’s conversations and resources with your current Grok team." : "Create a team copy without personal secrets. The original bot stays separate.")
        }
    }
    private func submit(_ control: String, _ fields: [String: Any] = [:]) async {
        busy = true; error = nil; defer { busy = false }
        do {
            var args = fields; args["id"] = card.id; args["sessionId"] = card.sessionId; args["control"] = control; args["controlRevision"] = card.details?["controlRevision"]
            _ = try await model.data("cardControl", args)
            if control == "teamShare" { status = "Sharing started. Refresh its status to confirm completion." }
            else { await model.loadActivity(); dismiss() }
        } catch { self.error = error.localizedDescription }
    }
    private func sharingStatus() async {
        busy = true; error = nil; defer { busy = false }
        do {
            struct Status: Decodable { let state, failureReason: String; let shared: Bool }
            let result = try JSONDecoder().decode(Status.self, from: await model.data("sharingStatus"))
            status = result.shared ? "Shared with your team" : !result.failureReason.isEmpty ? result.failureReason : result.state.isEmpty ? "Sharing status is unavailable. Try refreshing." : result.state
        } catch { self.error = error.localizedDescription }
    }
}
