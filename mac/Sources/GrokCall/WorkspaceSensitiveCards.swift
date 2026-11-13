import AppKit
import SwiftUI

struct WorkspacePhoneControls: View {
    @ObservedObject var model: BotWorkspaceModel
    let card: WorkspaceActivity.Card
    @Local private var selected: String?
    var body: some View {
        HStack {
            ForEach(card.actions, id: \.self) { action in
                if ["hangUp", "transfer", "retryRecording"].contains(action) {
                    Button(action == "hangUp" ? "Hang up…" : action == "transfer" ? "Transfer to me…" : "Retry recording") { selected = action }.disabled(model.busy)
                }
            }
        }.confirmationDialog("Apply this phone-call control?", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
            Button("Confirm") { if let control = selected { Task { await model.perform("phoneControl", ["id": card.id, "control": control]) } }; selected = nil }
        }
    }
}
struct WorkspacePaymentEditor: View {
    @ObservedObject var model: BotWorkspaceModel
    let card: WorkspaceActivity.Card
    @Environment(\.dismiss) private var dismiss
    struct Methods: Decodable {
        struct Method: Decodable, Identifiable { let id, name, last4: String; let ineligibleReason: String? }
        let methods: [Method]
    }
    struct Verification: Decodable { let id: String; let url: String?; let requiresVerification: Bool }
    @Local private var methods: [Methods.Method] = []
    @Local private var selected = ""
    @Local private var verification: Verification?
    @Local private var busy = false
    @Local private var error: String?
    @Local private var confirm = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Review payment").font(.title2)
            Text(card.details?["merchantName"] ?? card.title).font(.headline)
            if let cents = card.details?["amountCents"], let amount = Double(cents), let currency = card.details?["currency"] { Text(amount / 100, format: .currency(code: currency)).font(.title) }
            Text(card.text).textSelection(.enabled)
            if verification == nil {
                Picker("Payment method", selection: $selected) { Text("Choose…").tag(""); ForEach(methods) { method in Text("\(method.name) · \(method.last4)").tag(method.id).disabled(method.ineligibleReason != nil) } }
                Text("You'll confirm with your Grok passkey. Card details aren't stored here.").font(.caption).foregroundStyle(.secondary)
            } else { Text("Finish the check on the page that opened, then come back here.").font(.callout) }
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("Cancel") { dismiss() }.disabled(busy)
                Button("Don't allow", role: .destructive) { Task { await model.resolve(card, decision: "deny"); if model.error == nil { dismiss() } else { error = model.error } } }.disabled(busy)
                Spacer(); if busy { ProgressView().controlSize(.small) }
                if verification == nil { Button("Approve…") { confirm = true }.disabled(busy || selected.isEmpty || card.details?["amountCents"] == nil || card.details?["merchantName"] == nil) }
                else { Button("Finish approval") { Task { await finish() } }.disabled(busy) }
            }
        }.padding(24).frame(width: 540)
        .task { await load() }
        .confirmationDialog("Approve this payment for the displayed amount and merchant?", isPresented: $confirm) { Button("Verify and approve") { Task { await begin() } } }
    }
    private func load() async {
        busy = true; defer { busy = false }
        do { methods = try JSONDecoder().decode(Methods.self, from: await model.data("paymentMethods", ["id": card.id])).methods }
        catch { self.error = error.localizedDescription }
    }
    private func begin() async {
        busy = true; error = nil; defer { busy = false }
        do {
            let reply = try JSONDecoder().decode(Verification.self, from: await model.data("paymentBegin", ["id": card.id, "paymentMethodId": selected]))
            verification = reply
            if let raw = reply.url, let url = URL(string: raw), url.scheme == "https" { guard NSWorkspace.shared.open(url) else { throw BackendError.setup("Could not open the provider’s verification page.") } }
        } catch { self.error = error.localizedDescription }
    }
    private func finish() async {
        guard let verification else { return }; busy = true; error = nil; defer { busy = false }
        do { _ = try await model.data("paymentFinish", ["id": card.id, "ceremonyId": verification.id]); await model.loadActivity(); dismiss() }
        catch { self.error = error.localizedDescription }
    }
}
