import SwiftUI

struct RoutineEditor: View {
    @ObservedObject var model: BotWorkspaceModel
    let routine: WorkspaceRoutine?
    @Environment(\.dismiss) private var dismiss
    @Local private var name = ""
    @Local private var prompt = ""
    @Local private var trigger = ""
    @Local private var schedule = "0 9 * * 1-5"
    @Local private var scheduled = true
    @Local private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(routine == nil ? "New routine" : "Edit routine").font(.title2)
            TextField("Name", text: $name)
            Text("Instructions").font(.headline)
            TextEditor(text: $prompt).frame(minHeight: 120)
            Text("Trigger").font(.headline)
            Toggle("Run on a schedule", isOn: $scheduled)
            if scheduled {
                TextField("Cron schedule", text: $schedule)
                Text("Example: 0 9 * * 1-5 means 9 AM on weekdays.").font(.caption).foregroundStyle(.secondary)
            } else {
                DisclosureGroup("Event trigger settings") {
                    Text("Runs when something happens in a connected app.").font(.caption).foregroundStyle(.secondary)
                    TextEditor(text: $trigger).font(.system(.body, design: .monospaced)).frame(minHeight: 110)
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("Cancel") { dismiss() }; Spacer()
                Button("Save") { Task { await save() } }.disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 570)
        .onAppear {
            name = routine?.name ?? ""; prompt = routine?.prompt ?? ""
            let value: [String: Any] = routine?.trigger ?? ["type": "cron", "schedule": "0 9 * * 1-5"]
            scheduled = value["type"] as? String == "cron"
            schedule = value["schedule"] as? String ?? "0 9 * * 1-5"
            trigger = String(decoding: (try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])) ?? Data(), as: UTF8.self)
        }
    }
    private func save() async {
        do {
            guard var object = try JSONSerialization.jsonObject(with: Data(trigger.utf8)) as? [String: Any], object["type"] is String else { throw BackendError.setup("Enter a trigger object with its provider type.") }
            if scheduled {
                if object["type"] as? String != "cron" { object = ["type": "cron"] }
                object["schedule"] = schedule
            }
            var args: [String: Any] = ["spec": ["name": name, "prompt": prompt, "trigger": object, "isEnabled": routine?.enabled ?? true]]
            if let routine { args["id"] = routine.id }
            await model.perform(routine == nil ? "routineCreate" : "routineUpdate", args)
            if let failure = model.error { error = failure } else { dismiss() }
        } catch { self.error = error.localizedDescription }
    }
}

struct SkillEditor: View {
    @ObservedObject var model: BotWorkspaceModel
    let skill: WorkspaceSkill?
    @Environment(\.dismiss) private var dismiss
    @Local private var name = ""
    @Local private var description = ""
    @Local private var content = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(skill == nil ? "New skill" : "Edit skill").font(.title2)
            TextField("Name", text: $name).disabled(skill != nil)
            TextField("Description", text: $description)
            TextEditor(text: $content).font(.system(.body, design: .monospaced)).frame(minHeight: 260)
            if let error = model.error { Text(error).foregroundStyle(.red) }
            HStack { Button("Cancel") { dismiss() }; Spacer(); Button("Save") { Task {
                await model.perform(skill == nil ? "skillCreate" : "skillUpdate", ["name": name, "description": description, "content": content])
                if model.error == nil { dismiss() }
            } }.disabled(model.busy || name.isEmpty || content.isEmpty) }
        }.padding(24).frame(width: 570)
        .onAppear { name = skill?.name ?? ""; description = skill?.description ?? ""; content = skill?.content ?? "" }
    }
}
