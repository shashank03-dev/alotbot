import AppKit
import SwiftUI

struct WorkspaceActivity: Decodable {
    struct Card: Decodable, Identifiable {
        struct Option: Decodable { let label, value: String }
        struct Field: Decodable, Identifiable { let id, label, type: String; let required: Bool; let options: [Option] }
        let details: [String: String]?
        struct Link: Decodable, Identifiable { let label, url: String; var id: String { url } }
        let links: [Link]?
        let multiSelect: Bool?
        let nativeRequired: Bool?
        let draft: [String: ConnectionValue]?
        let fields: [Field]?
        let allowCustom: Bool?
        let id, kind, title, text, status, requestId, sessionId: String
        let seq: Int
        let actions: [String]
        let options: [Option]
    }
    let cards: [Card]
    let beforeSeq: Int?
    var stale: Bool? = nil
    var warning: String? = nil
}
struct WorkspaceActivityView: View {
    @ObservedObject var model: BotWorkspaceModel
    @Local private var showConnections = false
    @Local private var setupCard: WorkspaceActivity.Card?
    @Local private var payment: WorkspaceActivity.Card?
    @Local private var mcp: WorkspaceActivity.Card?
    @Local private var result: WorkspaceResult?
    @Local private var editingDraft: WorkspaceActivity.Card?
    @Local private var responding: WorkspaceActivity.Card?
    @Local private var decision: WorkspaceActivity.Card?
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text("Activity").font(.title2)
                if let activity = model.activity {
                    if let warning = activity.warning { Text(warning).font(.caption).foregroundStyle(.secondary) }
                    if activity.cards.isEmpty { ContentUnavailableView("No activity yet", systemImage: "bubble.left.and.text.bubble.right", description: Text("Results and requests show up here.")) }
                    ForEach(activity.cards) { card in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack { Text(card.title).font(.headline); Spacer(); Text(card.status).font(.caption).foregroundStyle(.secondary) }
                            if !card.text.isEmpty { Text(card.text).textSelection(.enabled) }
                            if let details = card.details {
                                ForEach(details.keys.sorted(), id: \.self) { key in
                                    if !["callId", "networkId", "confirmedAddSite"].contains(key) { Text("\(key): \(details[key] ?? "")").font(.callout).textSelection(.enabled) }
                                }
                            }
                            ForEach(card.links ?? []) { link in if let url = URL(string: link.url), url.scheme == "https" { Button(link.label) { result = WorkspaceResult(id: link.id, url: url, title: link.label) } } }
                            if ["appearance-picker", "email-offer", "team-access", "publish-approval", "notifications-enable"].contains(card.kind) && !card.actions.isEmpty {
                                Button("Review \(card.title.lowercased())…") { setupCard = card }
                            } else if card.actions.contains("manageConnections") {
                                Button("Manage connections…") { showConnections = true }.disabled(model.backend == nil)
                            } else if card.actions.contains("openKnowledge") {
                                Button("Open knowledge") { model.tab = .knowledge }
                            } else if card.actions.contains("openComputer") {
                                Button("Open computer") { model.tab = .computer }
                            } else if card.actions.contains("nativeSetup") {
                                Button("Continue in Grok Bot…") { model.openNativeBot() }
                                Text("Finish this in Grok Bot, then refresh.").font(.caption).foregroundStyle(.secondary)
                            } else if card.actions.contains("openMcp") {
                                Button("Open app") { mcp = card }
                            } else if card.kind == "phone-call" { WorkspacePhoneControls(model: model, card: card) }
                            if card.kind == "virtual-card-approval" && card.status == "pending" {
                                Button("Review payment…") { payment = card }
                            } else
                            if card.actions.contains("sendDraft") || card.actions.contains("discardDraft") {
                                Button("Review draft…") { editingDraft = card }.disabled(model.busy)
                            } else if card.actions.contains("respond") {
                                Button(card.kind == "secret-request" ? "Provide securely…" : "Respond…") { responding = card }.disabled(model.busy)
                            } else if card.actions.contains("approve") {
                                HStack {
                                    Button("Approve…") { decision = card }
                                    Button("Don't allow", role: .destructive) { Task { await model.resolve(card, decision: "deny") } }
                                }.disabled(model.busy)
                            } else if !["text", "message", "notice", "user-attachment"].contains(card.kind) && card.status != "info" && card.actions.isEmpty && (card.links ?? []).isEmpty {
                                Text("Open Grok Bot to answer this.").font(.caption).foregroundStyle(.secondary)
                                Button("Open Grok Bot…") { model.openNativeBot() }
                            }
                        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Theme.raised, in: RoundedRectangle(cornerRadius: 12))
                    }
                    if activity.beforeSeq != nil { Button("Show older") { Task { await model.loadActivity(older: true) } }.disabled(model.busy) }
                }
            }.padding(24)
        }
        .task {
            var failures = 0
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                guard model.tab == .activity else { return }
                await model.loadActivity()
                failures = model.error == nil && model.activity?.stale != true ? 0 : failures + 1
                if failures >= 3 { return }
            }
        }
        .sheet(isPresented: $showConnections) { if let backend = model.backend { ConnectionsView(backend: backend) } }
        .sheet(item: $setupCard) { WorkspaceSetupCardEditor(model: model, card: $0) }
        .sheet(item: $payment) { WorkspacePaymentEditor(model: model, card: $0) }
        .sheet(item: $mcp) { WorkspaceMcpView(model: model, card: $0) }
        .sheet(item: $result) { IsolatedResultView(result: $0) }
        .sheet(item: $editingDraft) { WorkspaceDraftEditor(model: model, card: $0) }
        .sheet(item: $responding) { WorkspaceResponseEditor(model: model, card: $0) }
        .confirmationDialog("Allow this?", isPresented: Binding(get: { decision != nil }, set: { if !$0 { decision = nil } })) {
            Button("Allow once") { if let card = decision { Task { await model.resolve(card, decision: "approve") } }; decision = nil }
        } message: { Text(decision?.text ?? "") }
    }
}
@MainActor extension BotWorkspaceModel {
    func openNativeBot() {
        let app = URL(fileURLWithPath: "/Applications/Grok Bot.app")
        guard FileManager.default.fileExists(atPath: app.path) else { error = "Install Grok Bot to use its native setup flow."; return }
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration()) { _, failure in
            if let failure { Task { @MainActor in self.error = failure.localizedDescription } }
        }
    }
    func loadActivity(older: Bool = false) async {
        guard !busy else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let page = try JSONDecoder().decode(WorkspaceActivity.self, from: await data("activity", older ? activity?.beforeSeq.map { ["beforeSeq": $0] } ?? [:] : [:]))
            if older, let previous = activity {
                let known = Set(previous.cards.map(\.id))
                activity = WorkspaceActivity(cards: previous.cards + page.cards.filter { !known.contains($0.id) }, beforeSeq: page.beforeSeq == previous.beforeSeq ? nil : page.beforeSeq)
            } else if let previous = activity, page.stale != true {
                let fresh = Set(page.cards.map(\.id))
                activity = WorkspaceActivity(cards: Array((page.cards + previous.cards.filter { !fresh.contains($0.id) }).prefix(1000)), beforeSeq: previous.beforeSeq ?? page.beforeSeq, stale: page.stale, warning: page.warning)
            } else { activity = page }
        } catch { self.error = error.localizedDescription }
    }
    func resolve(_ card: WorkspaceActivity.Card, decision: String) async {
        await perform("cardDecision", ["id": card.id, "requestId": card.requestId, "decision": decision, "confirmedAddSite": card.details?["confirmedAddSite"] ?? ""])
    }
}

private struct WorkspaceResponseEditor: View {
    @ObservedObject var model: BotWorkspaceModel
    let card: WorkspaceActivity.Card
    @Environment(\.dismiss) private var dismiss
    @Local private var answer = ""
    @Local private var selected = Set<String>()
    @Local private var values: [String: String] = [:]
    @Local private var sending = false
    @Local private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(card.title).font(.title2)
            if !card.text.isEmpty { Text(card.text).font(.callout) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if card.kind == "secret-request" {
                        SecureField("Requested secret", text: $answer)
                        Text("Goes only to this bot. It isn't saved in any log.").font(.caption).foregroundStyle(.secondary)
                    } else if card.kind == "widget" {
                        ForEach(Array(card.options.enumerated()), id: \.offset) { _, option in
                            Button { if card.multiSelect == true { if selected.contains(option.value) { selected.remove(option.value) } else { selected.insert(option.value) } } else { answer = option.value } } label: { HStack { Image(systemName: (card.multiSelect == true ? selected.contains(option.value) : answer == option.value) ? "checkmark.circle.fill" : "circle"); Text(option.label) } }
                        }
                        if card.allowCustom == true { TextField("Your answer", text: $answer) }
                    } else {
                        ForEach(card.fields ?? []) { field in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(field.label + (field.required ? " *" : "")).font(.callout)
                                if field.type == "password" { SecureField(field.label, text: value(field.id)) }
                                else if field.type == "checkbox" { Toggle(field.label, isOn: Binding(get: { values[field.id] == "true" }, set: { values[field.id] = $0 ? "true" : "false" })) }
                                else if field.type == "select" {
                                    Picker(field.label, selection: value(field.id)) { Text("Choose…").tag(""); ForEach(Array(field.options.enumerated()), id: \.offset) { _, option in Text(option.label).tag(option.value) } }
                                } else if field.type == "textarea" { TextEditor(text: value(field.id)).frame(minHeight: 90) }
                                else { TextField(field.label, text: value(field.id)) }
                            }
                        }
                    }
                }.padding(2)
            }.frame(maxHeight: 360)
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
            HStack {
                Button("Cancel") { dismiss() }.disabled(sending)
                if card.actions.contains("dismiss") { Button("Dismiss request", role: .destructive) { Task { await submit(dismissRequest: true) } }.disabled(sending) }
                Spacer()
                if sending { ProgressView().controlSize(.small) }
                Button("Submit") { Task { await submit(dismissRequest: false) } }.disabled(sending || model.busy)
            }
        }.padding(24).frame(width: 540)
        .onDisappear { answer = ""; values = [:] }
    }
    private func value(_ id: String) -> Binding<String> { Binding(get: { values[id] ?? "" }, set: { values[id] = $0 }) }
    private func submit(dismissRequest: Bool) async {
        sending = true; error = nil
        defer { sending = false }
        do {
            _ = try await model.data("cardRespond", ["id": card.id, "sessionId": card.sessionId, "dismiss": dismissRequest, "value": answer, "values": card.kind == "widget" && card.multiSelect == true ? Array(selected).sorted() + (answer.isEmpty ? [] : [answer]) as Any : values as Any])
            answer = ""; values = [:]; await model.loadActivity(); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

private struct WorkspaceDraftEditor: View {
    @ObservedObject var model: BotWorkspaceModel
    let card: WorkspaceActivity.Card
    @Environment(\.dismiss) private var dismiss
    @Local private var bodyText = ""
    @Local private var fromText = ""
    @Local private var toText = ""
    @Local private var ccText = ""
    @Local private var subjectText = ""
    @Local private var markInternal = false
    @Local private var confirming = false
    @Local private var sending = false
    @Local private var error: String?
    private var isEmail: Bool { card.kind == "email-draft" }
    private func field(_ key: String) -> String { card.draft?[key]?.value as? String ?? "" }
    private func list(_ key: String) -> [String] { card.draft?[key]?.value as? [String] ?? [] }
    private func flag(_ key: String) -> Bool { card.draft?[key]?.value as? Bool ?? false }
    private func recipients(_ text: String) -> [String] { text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var blockedReason: String? { card.actions.contains("sendDraft") ? nil : (field("blockedReason").isEmpty ? "This draft can’t be sent from Alotbot." : field("blockedReason")) }
    private var attachments: [(name: String, size: Int)] {
        (card.draft?["attachments"]?.value as? [[String: Any]] ?? []).map { ($0["filename"] as? String ?? "Attachment", ($0["sizeBytes"] as? Double).map { Int($0) } ?? 0) }
    }
    private var bodyLimit: Int { card.kind == "meeting-chat-draft" ? 4096 : 100_000 }
    /// Only fields the person actually changed go to the runtime, and only as an explicitly reviewed change.
    private var review: [String: Any] {
        var changes: [String: Any] = [:]
        if isEmail {
            if fromText.lowercased() != field("from").lowercased() { changes["from"] = fromText }
            if recipients(toText) != list("to") { changes["to"] = recipients(toText) }
            if recipients(ccText) != list("cc") { changes["cc"] = recipients(ccText) }
            if subjectText != field("subject") { changes["subject"] = subjectText }
        } else if card.kind == "meeting-chat-draft", flag("canMarkInternal"), markInternal { changes["markInternal"] = true }
        return changes
    }
    private var destination: String {
        switch card.kind {
        case "email-draft": return ([recipients(toText).joined(separator: ", ")] + (recipients(ccText).isEmpty ? [] : ["Cc " + recipients(ccText).joined(separator: ", ")])).joined(separator: "; ")
        case "slack-draft": return [field("target"), field("workspace")].filter { !$0.isEmpty }.joined(separator: " in ")
        case "meeting-chat-draft": return field("privateTo").isEmpty ? (field("meetingTitle").isEmpty ? field("meetingId") : field("meetingTitle")) : field("privateTo")
        default: return field("recipientName").isEmpty ? field("to") : field("recipientName")
        }
    }
    private var canSend: Bool {
        let text = bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
        return blockedReason == nil && !sending && !text.isEmpty && bodyText.utf16.count <= bodyLimit && (!isEmail || !recipients(toText).isEmpty)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(card.title).font(.title2)
                if let blockedReason { Label(blockedReason, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                if isEmail { emailFields } else { fixedRoute }
                Text("Message").font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $bodyText).frame(minHeight: 200).accessibilityLabel("Message body").disabled(blockedReason != nil)
                // Limits match the runtime and Grok Bot, which count UTF-16 code units (JavaScript string length).
                if bodyText.utf16.count > bodyLimit { Text("This message is \(bodyText.utf16.count) characters. The limit is \(bodyLimit).").font(.caption).foregroundStyle(.red) }
                if isEmail, !field("signature").isEmpty {
                    Text("Signature (added by the provider)").font(.caption).foregroundStyle(.secondary)
                    Text(field("signature")).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if !attachments.isEmpty {
                    Text("Attachments").font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(attachments.enumerated()), id: \.offset) { item in
                        Label("\(item.element.name) · \(ByteCountFormatter.string(fromByteCount: Int64(item.element.size), countStyle: .file))", systemImage: "paperclip").font(.callout)
                    }
                    Text("To change attachments, use Grok Bot.").font(.caption).foregroundStyle(.secondary)
                }
                if let error { Text(error).foregroundStyle(.red) }
                HStack {
                    Button("Cancel") { dismiss() }.disabled(sending).keyboardShortcut(.cancelAction)
                    Button("Discard draft", role: .destructive) { Task { await submit(send: false) } }.disabled(sending || !card.actions.contains("discardDraft"))
                    Spacer()
                    if sending { ProgressView().controlSize(.small) }
                    if blockedReason == nil { Button("Send…") { confirming = true }.disabled(!canSend) }
                }
            }.padding(24)
        }
        .frame(width: 620).frame(minHeight: 420)
        .onAppear {
            bodyText = field("body"); fromText = field("from"); subjectText = field("subject")
            toText = list("to").joined(separator: ", "); ccText = list("cc").joined(separator: ", "); markInternal = flag("markInternal")
        }
        .confirmationDialog("Send this message?", isPresented: $confirming) {
            Button("Send to \(destination)") { Task { await submit(send: true) } }
        } message: {
            Text(review.isEmpty ? "This sends the displayed message through this bot’s connected account." : "You changed \(review.keys.sorted().joined(separator: ", ")). This sends the displayed message through this bot’s connected account.")
        }
    }
    @ViewBuilder private var emailFields: some View {
        let addresses = list("sendingAddresses")
        if addresses.count > 1 {
            Picker("From", selection: $fromText) { ForEach(addresses, id: \.self) { Text($0).tag($0) } }.disabled(blockedReason != nil)
        } else if !fromText.isEmpty { Text("From: \(fromText)").font(.callout).textSelection(.enabled) }
        TextField("To (comma separated)", text: $toText).textFieldStyle(.roundedBorder).disabled(blockedReason != nil)
        TextField("Cc (comma separated)", text: $ccText).textFieldStyle(.roundedBorder).disabled(blockedReason != nil)
        TextField("Subject", text: $subjectText).textFieldStyle(.roundedBorder).disabled(blockedReason != nil)
        if !field("replyTo").isEmpty {
            HStack(spacing: 4) {
                Text("Reply to: \(field("replyTo"))").font(.caption).foregroundStyle(.secondary)
                if let url = URL(string: field("replyToUrl")), url.scheme == "https" { Link("Open", destination: url).font(.caption) }
            }
        }
        if !field("forwarding").isEmpty { Text("Forwarding: \(field("forwarding"))").font(.caption).foregroundStyle(.secondary) }
    }
    @ViewBuilder private var fixedRoute: some View {
        switch card.kind {
        case "slack-draft":
            if !field("workspace").isEmpty { Text("Workspace: \(field("workspace"))").font(.callout) }
            Text("To: \(field("target"))").font(.callout).textSelection(.enabled)
            if !field("thread").isEmpty { Text("In thread: \(field("thread"))").font(.callout) }
            Text(flag("verifiedRoute") ? "The destination is the bot’s verified Slack channel and can’t be changed here." : "The destination is fixed to what the bot drafted.").font(.caption).foregroundStyle(.secondary)
        case "meeting-chat-draft":
            Text("Meeting: \(field("meetingTitle").isEmpty ? field("meetingId") : field("meetingTitle"))").font(.callout)
            if !field("privateTo").isEmpty { Text("Private to: \(field("recipientName").isEmpty ? field("privateTo") : field("recipientName"))").font(.callout) }
            if flag("canMarkInternal") { Toggle("Mark as internal", isOn: $markInternal).disabled(blockedReason != nil) }
            else if flag("markInternal") { Text("This meeting chat is internal.").font(.caption).foregroundStyle(.secondary) }
        default:
            Text("To: \(destination)").font(.callout).textSelection(.enabled)
        }
    }
    private func submit(send: Bool) async {
        sending = true; error = nil; defer { sending = false }
        var args: [String: Any] = ["id": card.id, "sessionId": card.sessionId, "revision": field("revision")]
        if send {
            args["body"] = bodyText
            let changes = review
            if !changes.isEmpty { args["reviewed"] = true; args["review"] = changes }
        }
        do {
            _ = try await model.data(send ? "draftSend" : "draftDiscard", args)
            await model.loadActivity(); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
