import AppKit
import SwiftUI

struct ConnectionsView: View {
    @StateObject var model: ConnectionsModel
    @Environment(\.dismiss) private var dismiss
    /// Inside the Settings window: no Done button, and it fills the tab.
    var embedded = false
    init(backend: Backend, embedded: Bool = false) { _model = StateObject(wrappedValue: ConnectionsModel(backend: backend)); self.embedded = embedded }
    init(model: ConnectionsModel) { _model = StateObject(wrappedValue: model) }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Connections").font(.system(size: 20, weight: .semibold))
                    Text("Apps your bots can use").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                }
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.help("Refresh connections").accessibilityLabel("Refresh connections").disabled(model.busy)
                if !embedded { Button("Done") { dismiss() }.keyboardShortcut(.cancelAction) }
            }.padding(20)
            Divider()
            HStack(spacing: 0) {
                VStack(spacing: 12) {
                    TextField("Search apps and skills", text: $model.search).textFieldStyle(.roundedBorder).accessibilityLabel("Search connections")
                    SlidingSegments(selection: $model.installedOnly, items: [.init(value: true, title: "Added", icon: "checkmark.circle"), .init(value: false, title: "All apps", icon: "square.grid.2x2")], compact: true)
                    ScrollView {
                        LazyVStack(spacing: 4) {
                            ForEach(model.visible) { entry in
                                Button { model.selected = entry.id } label: {
                                    HStack(spacing: 10) {
                                        ConnectionIcon(entry: entry)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(entry.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                            Text(model.subtitle(entry)).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    .padding(8).contentShape(Rectangle())
                                    .background(model.selected == entry.id ? Color.white.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 10))
                                }.buttonStyle(.plain).accessibilityLabel("\(entry.name), \(model.subtitle(entry))")
                            }
                        }
                    }
                    if model.visible.isEmpty { Text(model.busy ? "Loading…" : "No matching apps").font(.callout).foregroundStyle(Theme.secondary) }
                    Text("\(model.visible.count) apps and skills").font(.caption).foregroundStyle(Theme.secondary)
                }.padding(16).frame(width: 240)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let error = model.error { ConnectionNotice(text: error) }
                        if let flow = model.flow, flow.pending {
                            HStack {
                                ProgressView().controlSize(.small)
                                Text(flow.message).font(.callout)
                                if flow.status == "waiting" { Button("Cancel") { Task { await model.perform("cancelAuth") } } }
                            }
                        }
                        if let entry = model.selectedEntry { ConnectionDetails(model: model, entry: entry).id(entry.id) }
                        else { Text("Pick an app to see it here.").font(.callout).foregroundStyle(Theme.secondary) }
                        ForEach(model.warnings, id: \.self) { Text($0).font(.caption).foregroundStyle(Theme.secondary) }
                    }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: embedded ? nil : 900, height: embedded ? nil : 650).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.surface).foregroundStyle(Theme.text)
        .environment(\.colorScheme, .dark)
        .task { await model.refresh() }
        .task(id: model.selected) { await model.checkSelected() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await model.refresh() } }
        .onDisappear { model.stopPolling() }
    }
}

private struct ConnectionNotice: View {
    let text: String
    var body: some View {
        Label { Text(text).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) } icon: { Image(systemName: "info.circle") }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Theme.raised, in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct ConnectionDetails: View {
    @ObservedObject var model: ConnectionsModel
    let entry: ConnectionEntry
    @Local private var values: [String: String] = [:]
    @Local private var confirmRemove = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 16) {
                ConnectionIcon(entry: entry, size: 56)
                VStack(alignment: .leading, spacing: 8) {
                    Text(entry.name).font(.system(size: 25, weight: .semibold))
                    Text(entry.summary).font(.system(size: 13)).foregroundStyle(Theme.secondary).textSelection(.enabled)
                }
            }
            if let notice = entry.notice { ConnectionNotice(text: notice) }
            if entry.kind == "native" {
                Button("Open Grok Bot", systemImage: "arrow.up.forward.app") { Task { await model.perform("native", ["id": entry.id]) } }
            } else {
                if !entry.installed {
                    setupFields
                    Button(model.loadingDetails.contains(entry.id) ? "Loading setup…" : "Connect") { save(installing: true) }.buttonStyle(.borderedProminent).disabled(model.loadingDetails.contains(entry.id))
                }
                if !entry.enabled && entry.installed {
                    ConnectionNotice(text: "This app is disabled. Enable it to make it available to your bots.")
                    Button("Enable") { Task { await model.perform("enable", ["id": entry.id, "enabled": true]); await model.checkSelected() } }
                } else {
                    ForEach(entry.servers) { server in ConnectionServerView(model: model, server: server) }
                }
                if entry.installed && entry.servers.isEmpty {
                    Text(entry.connectors.isEmpty ? "Added to your Grok account." : "Setup is saved. Refresh to load the connection.").font(.callout).foregroundStyle(Theme.secondary)
                }
                if entry.installed && !entry.fields.isEmpty {
                    DisclosureGroup("Setup") { VStack(alignment: .leading, spacing: 12) { setupFields; Button("Save changes") { save(installing: false) } }.padding(.top, 12) }
                }
                if entry.installed && entry.kind == "plugin" {
                    Divider()
                    DisclosureGroup("Manage app") {
                        VStack(alignment: .leading, spacing: 12) {
                            if !entry.skills.isEmpty { Text("Skills: " + entry.skills.joined(separator: ", ")).font(.caption).foregroundStyle(Theme.secondary) }
                            if entry.required { Label("Required by your team", systemImage: "lock").font(.caption) }
                            HStack {
                                Button(entry.enabled ? "Disable" : "Enable") { Task { await model.perform("enable", ["id": entry.id, "enabled": !entry.enabled]) } }.disabled(entry.required)
                                Button("Remove…", role: .destructive) { confirmRemove = true }.disabled(entry.required)
                            }
                        }.padding(.top, 12)
                    }.font(.system(size: 12))
                }
            }
        }
        .disabled(model.busy)
        .confirmationDialog("Remove \(entry.name) from your Grok account?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { Task { await model.perform("uninstall", ["id": entry.id]) } }
        } message: { Text("It's removed from Grok Bot too.") }
    }
    private var setupFields: some View {
        ForEach(entry.fields) { field in
            VStack(alignment: .leading, spacing: 6) {
                Text(field.title + (field.required ? " *" : "")).font(.system(size: 12, weight: .medium))
                fieldInput(field)
                if !field.description.isEmpty { Text(field.description).font(.caption).foregroundStyle(Theme.secondary).textSelection(.enabled) }
                if entry.configuredKeys.contains(field.key) { Text("Saved. Leave empty to keep it.").font(.caption).foregroundStyle(Theme.secondary) }
            }
        }
    }
    private func save(installing: Bool) {
        Task {
            do {
                let parsed = try ConnectionsModel.values(entry.fields, text: values, installing: installing)
                if installing { await model.connect(entry, values: parsed) }
                else { await model.perform("configure", ["id": entry.id, "values": parsed]) }
                if model.error == nil { values = [:] }
            } catch { model.error = error.localizedDescription }
        }
    }
    @ViewBuilder private func fieldInput(_ field: ConnectionEntry.Field) -> some View {
        let binding = Binding(get: { values[field.key] ?? (entry.installed ? "" : field.initial.text) }, set: { values[field.key] = $0 })
        if !field.choices.isEmpty {
            Picker(field.title, selection: binding) { Text("Choose…").tag(""); ForEach(field.choices.map(\.text), id: \.self) { Text($0).tag($0) } }.labelsHidden()
        } else if field.secret { SecureField(field.title, text: binding).textFieldStyle(.roundedBorder) }
        else { TextField(field.type == "string" ? field.title : "\(field.type) as JSON", text: binding).textFieldStyle(.roundedBorder) }
    }
}

private struct ConnectionServerView: View {
    @ObservedObject var model: ConnectionsModel
    let server: ConnectionEntry.Server
    @Local private var account = ""
    @Local private var removing: String?
    @Local private var rename = ""
    @Local private var renaming: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            let health = model.health[server.id]
            HStack(spacing: 8) {
                if model.checking.contains(server.id) { ProgressView().controlSize(.small) }
                else { Image(systemName: health?.status == "connected" ? "checkmark.circle.fill" : "circle").foregroundStyle(health?.status == "connected" ? Color.green : Theme.secondary) }
                Text(health?.title ?? "Checking connection…").font(.system(size: 13, weight: .medium))
            }
            if let message = model.serverErrors[server.id] ?? (health?.status == "connected" ? nil : health?.message) { ConnectionNotice(text: message) }
            if server.included == true {
                Text("Included with your Grok account.").font(.caption).foregroundStyle(Theme.secondary)
            } else if server.setupUrl != nil {
                Button("Manage GitHub account…") { signIn("default", false) }.disabled(model.flow?.pending == true)
            } else if health?.status == "needsAuth" {
                Button("Sign in") { signIn("default", false) }.buttonStyle(.borderedProminent).disabled(model.flow?.pending == true)
            }
            Button(health?.status == "connected" ? "Check connection" : "Check again") { Task { await model.check(server.id) } }.disabled(model.checking.contains(server.id))
            DisclosureGroup("Accounts and permissions") {
                VStack(alignment: .leading, spacing: 12) {
                    if server.included != true && server.setupUrl == nil {
                        HStack {
                            TextField("New account name", text: $account).textFieldStyle(.roundedBorder)
                            Button("Add account") { signIn(account, false) }.disabled(account.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.flow?.pending == true)
                        }
                    }
                    ForEach(server.accounts) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.name).font(.system(size: 12, weight: .medium))
                            HStack {
                                Button("Reconnect") { signIn(item.key, true) }.disabled(model.flow?.pending == true)
                                Button("Rename…") { rename = item.key; renaming = item.key }
                                Button("Disconnect…", role: .destructive) { removing = item.key }
                            }
                        }
                    }
                    Button("Show tool permissions") { Task { await model.showTools(server.id) } }
                    if let tools = model.tools[server.id] {
                        if tools.isEmpty { Text("No tools yet.").font(.caption).foregroundStyle(Theme.secondary) }
                        ForEach(tools) { tool in
                            Picker(tool.name, selection: Binding(get: { tool.permission }, set: { value in Task { await model.perform("setRule", ["id": server.id, "tool": tool.key, "permission": value]) } })) {
                                Text("Grok default").tag("auto"); Text("Ask first").tag("ask"); Text("Allow").tag("allow"); Text("Block").tag("blocked")
                            }.help(tool.description)
                        }
                    }
                }.padding(.top, 12)
            }.font(.system(size: 12))
        }
        .confirmationDialog("Disconnect this account from Grok?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Disconnect", role: .destructive) { if let key = removing { Task { await model.perform("disconnect", ["id": server.id, "account": key]); await model.check(server.id) } }; removing = nil }
        }
        .alert("Rename account", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Account name", text: $rename)
            Button("Save") { if let key = renaming { Task { await model.perform("renameAccount", ["id": server.id, "account": key, "name": rename]) } }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }
    private func signIn(_ key: String, _ reconnect: Bool) { Task { await model.perform("authenticate", ["id": server.id, "account": key, "reconnect": reconnect]) } }
}
