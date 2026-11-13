import AppKit
import SwiftUI

struct BotWorkspaceView: View {
    @ObservedObject var model: BotWorkspaceModel
    @Local private var showingConnections = false
    @Local private var editingRoutine: WorkspaceRoutine?
    @Local private var creatingRoutine = false
    @Local private var editingSkill: WorkspaceSkill?
    @Local private var creatingSkill = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.name).font(.system(size: 21, weight: .semibold))
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(QuietButton()).help("Refresh").accessibilityLabel("Refresh").disabled(model.busy)
            }.padding(20)
            Picker("Workspace", selection: $model.tab) { ForEach(WorkspaceTab.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented).labelsHidden().padding(.horizontal, 20).padding(.bottom, 16)
            Divider()
            if let notice = model.notice { Text(notice).font(.caption).foregroundStyle(Theme.secondary).padding(.horizontal, 20).padding(.top, 8) }
            if let error = model.error { Text(error).font(.callout).foregroundStyle(Theme.danger).textSelection(.enabled).padding(12).frame(maxWidth: .infinity, alignment: .leading) }
            Group {
                switch model.tab {
                case .computer: computer
                case .activity: WorkspaceActivityView(model: model)
                case .routines: routines
                case .knowledge: knowledge
                case .files: files
                case .apps: apps
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(Theme.chrome).foregroundStyle(Theme.text).environment(\.colorScheme, .dark)
        .task(id: model.tab) { await model.refresh() }
        .onChange(of: model.tab) { _, tab in if tab != .computer { Task { await model.closeComputer() } } }
        .sheet(isPresented: $showingConnections) { if let backend = model.backend { ConnectionsView(backend: backend) } }
        .sheet(isPresented: $creatingRoutine) { RoutineEditor(model: model, routine: nil) }
        .sheet(item: $editingRoutine) { RoutineEditor(model: model, routine: $0) }
        .sheet(isPresented: $creatingSkill) { SkillEditor(model: model, skill: nil) }
        .sheet(item: $editingSkill) { SkillEditor(model: model, skill: $0) }
    }
    private var computer: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                if model.viewer != nil {
                    Text(model.hasControl ? "You're in control" : model.viewerConnected ? "Watching" : "Connecting…").font(.callout)
                    Spacer()
                    Button(model.hasControl ? "Stop controlling" : "Take control") { Task { await model.control(!model.hasControl) } }.disabled(!model.viewerConnected)
                    if let handoff = model.computer?.handoff, !handoff.requestId.isEmpty { Button("Hand back") { Task { await model.perform("handBack", ["requestId": handoff.requestId]) } } }
                    Button("Close") { Task { await model.closeComputer() } }
                } else {
                    Text(model.computer?.state == "asleep" ? "The computer is asleep" : "\(model.name)'s computer").font(.headline)
                    Spacer()
                    Button(model.computer?.state == "asleep" ? "Wake up" : "Open") { Task { await model.openComputer() } }.disabled(model.busy)
                }
            }
            HStack {
                if model.recordingLesson {
                    Label("Recording lesson", systemImage: "record.circle").foregroundStyle(Theme.danger)
                    Spacer()
                    Button("Stop and save") { Task { await model.teachingAction("teachStop", save: true) } }
                    Button("Discard", role: .destructive) { Task { await model.teachingAction("teachStop", save: false) } }
                } else {
                    Text(model.teaching?.state == "recording" ? "Another bot is recording a lesson" : "Show this bot how to do something").font(.caption).foregroundStyle(Theme.secondary)
                    Spacer()
                    Button("Record a lesson") { Task { await model.teachingAction("teachStart") } }.disabled(!model.hasControl || model.teaching?.state == "recording")
                }
            }.disabled(model.busy)
            if let viewer = model.viewer { CloudDesktopView(viewer: viewer, controlled: model.hasControl).id(viewer.id).frame(maxWidth: .infinity, maxHeight: .infinity).background(.black) }
            else { ContentUnavailableView("Computer", systemImage: "desktopcomputer", description: Text("The computer this bot works on.")).frame(maxWidth: .infinity, maxHeight: .infinity) }
            if let monitors = model.computer?.monitors, !monitors.isEmpty {
                HStack { Text("Screens").font(.caption); ForEach(monitors) { monitor in Button(monitor.title) { Task { await model.openComputer(monitor: monitor.id) } } } }
            }
        }.padding(16)
    }
    private var routines: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack { Text("Routines").font(.title2); Spacer(); Button("New routine", systemImage: "plus") { creatingRoutine = true }.disabled(model.resources == nil) }
                if let resources = model.resources {
                    if let zone = resources.timeZone { Text("Times in \(zone)").font(.caption).foregroundStyle(Theme.secondary) }
                    if resources.routines.isEmpty { Text("No routines yet.").foregroundStyle(Theme.secondary) }
                    ForEach(resources.routines) { routine in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack { Text(routine.name).font(.headline); Spacer(); Text(routine.enabled ? "On" : "Paused").font(.caption).foregroundStyle(Theme.secondary) }
                            Text(routine.triggerDescription).font(.callout).foregroundStyle(Theme.secondary)
                            if let next = workspaceDateLabel(routine.spec["nextRunAt"]?.value, timeZone: resources.timeZone) { Text("Next run: \(next)").font(.caption).foregroundStyle(Theme.secondary) }
                            Text(routine.prompt).font(.callout).lineLimit(4).textSelection(.enabled)
                            HStack {
                                Button("Edit") { editingRoutine = routine }.disabled(!routine.allows("EDIT"))
                                Button(routine.enabled ? "Pause" : "Turn on") { Task { await model.perform("routineEnable", ["id": routine.id, "enabled": !routine.enabled]) } }.disabled(!routine.allows("TOGGLE"))
                                Button("Run now…") { model.pendingRun = routine.id }.disabled(!routine.allows("OPEN"))
                                Menu("More") { Button("Delete", role: .destructive) { model.pendingDeletion = routine.id }.disabled(!routine.allows("DELETE")) }
                            }.disabled(model.busy)
                            RoutineRunHistory(routine: routine, timeZone: resources.timeZone)
                        }.padding(16).elevated(RoundedRectangle(cornerRadius: 14, style: .continuous), high: false)
                    }
                    warnings(resources)
                }
            }.padding(24)
        }
        .confirmationDialog("Run this routine now?", isPresented: Binding(get: { model.pendingRun != nil }, set: { if !$0 { model.pendingRun = nil } })) {
            Button("Run now") { if let id = model.pendingRun { Task { await model.perform("routineRun", ["id": id]) } }; model.pendingRun = nil }
        }
        .confirmationDialog("Delete this routine?", isPresented: Binding(get: { model.pendingDeletion != nil }, set: { if !$0 { model.pendingDeletion = nil } })) {
            Button("Delete", role: .destructive) { if let id = model.pendingDeletion { Task { await model.perform("routineDelete", ["id": id]) } }; model.pendingDeletion = nil }
        }
    }
    private var knowledge: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack { Text("Skills and knowledge").font(.title2); Spacer(); Button("New skill", systemImage: "plus") { creatingSkill = true } }
                if let resources = model.resources {
                    if resources.skills.isEmpty { Text("No skills yet.").foregroundStyle(Theme.secondary) }
                    ForEach(resources.skills) { skill in
                        DisclosureGroup {
                            Text(skill.content).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                            if !skill.readOnly { HStack { Button("Edit skill") { editingSkill = skill }; Button("Delete…", role: .destructive) { model.pendingSkillDeletion = skill.name } }.disabled(model.busy) }
                        } label: { VStack(alignment: .leading, spacing: 4) { Text(skill.name).font(.headline); Text(skill.description).font(.callout).foregroundStyle(Theme.secondary) } }
                        Divider()
                    }
                    if let available = resources.availableSkills {
                        let active = Set(resources.skills.map(\.name))
                        ForEach(available.filter { !active.contains($0.name) }) { skill in
                            HStack { VStack(alignment: .leading) { Text(skill.name); Text(skill.description).font(.caption).foregroundStyle(Theme.secondary) }; Spacer(); Button("Add") { Task { await model.perform("skillEnable", ["id": skill.id]) } }.disabled(model.busy) }
                        }
                    }
                    WorkspaceMemoryView(model: model, memory: resources.memory)
                    warnings(resources)
                }
            }.padding(24)
        }
        .confirmationDialog("Delete this skill?", isPresented: Binding(get: { model.pendingSkillDeletion != nil }, set: { if !$0 { model.pendingSkillDeletion = nil } })) {
            Button("Delete", role: .destructive) { if let name = model.pendingSkillDeletion { Task { await model.perform("skillDelete", ["name": name]) } }; model.pendingSkillDeletion = nil }
        }
    }
    private var files: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("Files").font(.title2); Spacer(); Button("Upload file…", systemImage: "arrow.up.doc") { model.chooseUpload() }.disabled(model.busy) }
                if let resources = model.resources {
                    if resources.files.isEmpty { Text("No files yet.").foregroundStyle(Theme.secondary) }
                    ForEach(resources.files) { file in
                        HStack {
                            Image(systemName: "doc")
                            VStack(alignment: .leading, spacing: 3) { Text(file.name); Text("\(file.source) · \(file.sizeDescription)").font(.caption).foregroundStyle(Theme.secondary) }
                            Spacer(); Button("Preview") { Task { await model.download(file, preview: true) } }; Button("Save…") { Task { await model.download(file, preview: false) } }
                        }.padding(.vertical, 6)
                    }
                    if resources.nextFilesPage != nil { Button("Show more") { Task { await model.moreFiles() } } }
                    WorkspaceLibraryView(model: model, library: resources.library)
                    warnings(resources)
                }
            }.padding(24)
        }
    }
    private var apps: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Apps").font(.title2)
            if let resources = model.resources { WorkspacePluginsView(model: model, plugins: resources.plugins) }
            Button("Connect more apps…") { showingConnections = true }.disabled(model.backend == nil)
        }.padding(24)
    }
    private func warnings(_ resources: WorkspaceResources) -> some View { ForEach(resources.warnings, id: \.self) { Text($0).font(.caption).foregroundStyle(Theme.secondary) } }
}

private struct RoutineRunHistory: View {
    let routine: WorkspaceRoutine
    let timeZone: String?
    var body: some View {
        if let runs = routine.spec["runs"]?.value as? [[String: Any]], !runs.isEmpty {
            DisclosureGroup("Recent runs") { ForEach(Array(runs.prefix(30).enumerated()), id: \.offset) { _, run in Text([run["status"] as? String, workspaceDateLabel(run["startedAt"], timeZone: timeZone), run["summary"] as? String].compactMap { $0 }.joined(separator: " · ")).font(.caption).textSelection(.enabled) } }
        }
    }
}
private struct WorkspaceMemoryView: View {
    @ObservedObject var model: BotWorkspaceModel
    let memory: [String: ConnectionValue]
    @Local private var sharing: String?
    var body: some View {
        if let rows = memory["memories"]?.value as? [[String: Any]], !rows.isEmpty {
            Text("What it remembers").font(.headline)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 6) {
                    Text(row["text"] as? String ?? "Saved memory").font(.callout).textSelection(.enabled)
                    if let id = row["factId"] as? String { Button("Share with team…") { sharing = id }.disabled(model.busy) }
                }
            }
            Color.clear.frame(height: 0).confirmationDialog("Share this remembered context with the bot’s team?", isPresented: Binding(get: { sharing != nil }, set: { if !$0 { sharing = nil } })) {
                Button("Share with team") { if let id = sharing { Task { await model.perform("memoryShare", ["id": id]) } }; sharing = nil }
            }
        }
    }
}
private struct WorkspaceLibraryView: View {
    @ObservedObject var model: BotWorkspaceModel
    let library: [String: ConnectionValue]
    @Local private var preview: WorkspaceResult?
    var body: some View {
        if let docs = library["docs"]?.value as? [[String: Any]], !docs.isEmpty {
            Divider(); Text("Library").font(.headline)
            ForEach(Array(docs.enumerated()), id: \.offset) { _, doc in
                if let raw = doc["url"] as? String, let url = URL(string: raw), url.scheme == "https", let id = doc["key"] as? String {
                    let pins = library["pins"]?.value as? [[String: Any]] ?? []
                    let pinned = pins.contains { $0["externalDocKey"] as? String == id }
                    HStack {
                        Button(doc["title"] as? String ?? "Open result") { preview = WorkspaceResult(id: id, url: url, title: doc["title"] as? String ?? "Result") }
                        Spacer()
                        Button(pinned ? "Unpin" : "Pin") { Task { await model.perform("libraryPin", ["id": id, "enabled": !pinned]) } }.disabled(model.busy)
                    }
                }
            }
            Color.clear.frame(height: 0).sheet(item: $preview) { IsolatedResultView(result: $0) }
        }
    }
}
private struct WorkspacePluginsView: View {
    @ObservedObject var model: BotWorkspaceModel
    let plugins: [String: ConnectionValue]
    var body: some View {
        if let rows = plugins["plugins"]?.value as? [[String: Any]] {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                if let id = row["id"] as? String { Toggle(row["name"] as? String ?? id, isOn: Binding(get: { row["enabled"] as? Bool ?? false }, set: { enabled in Task { await model.perform("pluginEnable", ["id": id, "enabled": enabled]) } })).disabled(model.busy || row["managed"] as? Bool == true) }
            }
        }
    }
}
