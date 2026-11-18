import AppKit
import GrokCallCore
import SwiftUI

/// Settings › Calls to you: standing calls, when bots may call, quiet hours, call backs waiting, and missed calls.
struct IncomingSettingsView: View {
    @ObservedObject var model: AppModel
    @Local private var editing: StandingCallDraft?
    @Local private var problem: String?
    @Local private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            if let state = model.incoming {
                standing(state)
                whoMayCall(state.settings)
                quiet(state)
                let waiting = state.held + (state.snoozed ?? [])
                if !waiting.isEmpty { held(waiting) }
                if !state.callbacks.isEmpty { callbacks(state.callbacks) }
                if !state.missed.isEmpty { MissedCalls(model: model, missed: state.missed) }
            } else {
                Text("Loading…").foregroundStyle(Theme.secondary)
            }
        }
        .task { await model.refreshIncoming() }
    }

    private var zone: String { TimeZone.current.identifier }

    // MARK: standing calls

    @ViewBuilder private func standing(_ state: IncomingState) -> some View {
        SettingsGroup("Standing calls") {
            Text("Your bots call you at the same time each week, with an agenda. Answer from the card that appears.")
                .font(.system(size: 12.5)).foregroundStyle(Theme.secondary)
            ForEach(state.schedules) { s in
                if editing?.id == s.id { editor } else { row(s) }
            }
            if editing != nil && editing?.id == nil { editor }
            if editing == nil {
                Button("New standing call…") {
                    problem = nil
                    editing = StandingCallDraft(botIds: model.bots.prefix(2).map(\.id), timezone: zone)
                }
                .buttonStyle(FilledButton())
                .disabled(model.bots.isEmpty)
            }
        }
    }

    private func row(_ s: StandingCall) -> some View {
        let names = s.botIds.compactMap { id in model.bots.first { $0.id == id }?.name }
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(s.title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
                    if !s.enabled { Text("Paused").font(.system(size: 11)).foregroundStyle(Theme.tertiary) }
                }
                Text("\(Weekdays.describe(s.days)) at \(s.time)\(s.timezone == zone ? "" : " (\(s.timezone))") · \(names.isEmpty ? "No bots" : names.joined(separator: ", "))")
                    .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                if let next = s.nextAt {
                    Text("Next: \(Date(timeIntervalSince1970: next / 1000).formatted(date: .abbreviated, time: .shortened))").font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                }
            }
            Spacer()
            Button("Ring now") { Task { await model.ringNow(s.id) } }.buttonStyle(QuietButton(tint: Theme.accent)).disabled(model.inCall)
                .help(model.inCall ? "Leave the call first" : "Try it: it rings now")
            Button("Edit") { problem = nil; editing = StandingCallDraft(s) }.buttonStyle(QuietButton())
            Button("Delete") { Task { await model.deleteStandingCall(s.id) } }.buttonStyle(QuietButton(tint: Theme.danger))
        }
    }

    @ViewBuilder private var editor: some View {
        if let draft = editing {
            let bind = Binding(get: { editing ?? draft }, set: { editing = $0 })
            VStack(alignment: .leading, spacing: 10) {
                DarkTextInput(placeholder: "Name, e.g. Morning standup", text: bind.title)
                Text("Bots").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.tertiary)
                FlowRow(items: model.bots) { b in
                    let on = bind.wrappedValue.botIds.contains(b.id)
                    Button {
                        if on { bind.wrappedValue.botIds.removeAll { $0 == b.id } } else { bind.wrappedValue.botIds.append(b.id) }
                    } label: {
                        HStack(spacing: 6) {
                            MorphAvatar(shape: b.shape, color: b.color).frame(width: 18, height: 18)
                            Text(b.name).font(.system(size: 12.5))
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Capsule().fill(on ? Theme.accent.opacity(0.35) : Theme.fill))
                        .foregroundStyle(Theme.text)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
                Text("Days").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.tertiary)
                HStack(spacing: 6) {
                    ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { d in
                        let on = bind.wrappedValue.days.contains(d)
                        Button(Weekdays.short[d]) { if on { bind.wrappedValue.days.remove(d) } else { bind.wrappedValue.days.insert(d) } }
                            .buttonStyle(.plain).font(.system(size: 12, weight: .medium))
                            .frame(width: 40, height: 28)
                            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(on ? Theme.accent.opacity(0.35) : Theme.fill))
                            .foregroundStyle(Theme.text)
                            .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
                HStack(spacing: 10) {
                    Text("Time").foregroundStyle(Theme.secondary)
                    DatePicker("", selection: Binding(get: { clockDate(bind.wrappedValue.hour, bind.wrappedValue.minute) }, set: { d in
                        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
                        bind.wrappedValue.hour = c.hour ?? 9
                        bind.wrappedValue.minute = c.minute ?? 0
                    }), displayedComponents: .hourAndMinute).labelsHidden().frame(width: 110)
                    Text(bind.wrappedValue.timezone).font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                    Spacer()
                    Toggle("On", isOn: bind.enabled).toggleStyle(.switch).labelsHidden()
                }
                DarkTextInput(placeholder: "Agenda (optional): what the bots should cover", text: bind.agenda)
                if let problem { Text(problem).font(.system(size: 12.5)).foregroundStyle(Theme.danger) }
                HStack(spacing: 8) {
                    Button(saving ? "Saving…" : "Save") {
                        saving = true
                        Task {
                            problem = await model.saveStandingCall(bind.wrappedValue)
                            saving = false
                            if problem == nil { editing = nil }
                        }
                    }
                    .buttonStyle(FilledButton(primary: true)).disabled(saving)
                    Button("Cancel") { editing = nil; problem = nil }.buttonStyle(QuietButton())
                }
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.fill))
        }
    }

    private func clockDate(_ h: Int, _ m: Int) -> Date {
        Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date()) ?? Date()
    }

    // MARK: who may call

    private func whoMayCall(_ s: IncomingSettings) -> some View {
        SettingsGroup("Bots calling you") {
            toggle("Bots may promise to call you back", s.botCallbacks) { ["botCallbacks": $0] }
            toggle("Call me when a job from a call finishes", s.jobResults) { ["jobResults": $0] }
            toggle("Call me when a bot needs my OK", s.approvals) { ["approvals": $0] }
            HStack {
                Text("Ring for").foregroundStyle(Theme.text)
                Spacer()
                PillMenu(title: "Ring for", options: [15, 30, 45, 60, 90, 120], label: { "\($0) seconds" }, selected: s.ringSeconds) { v in
                    Task { await model.setIncomingSettings(["ringSeconds": v]) }
                }
            }
            Text("A bot you decline doesn't call about its work again for 30 minutes. Missed calls are listed below and in the menu.")
                .font(.system(size: 12)).foregroundStyle(Theme.secondary)
        }
    }

    private func toggle(_ title: String, _ on: Bool, _ change: @escaping (Bool) -> [String: Any]) -> some View {
        Toggle(isOn: Binding(get: { on }, set: { v in Task { await model.setIncomingSettings(change(v)) } })) {
            Text(title).frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch).foregroundStyle(Theme.text)
    }

    // MARK: quiet hours and do not disturb

    private func quiet(_ state: IncomingState) -> some View {
        let q = state.settings.quietHours
        return SettingsGroup("Quiet hours") {
            toggle("Bots don't call during quiet hours", q.enabled) { ["quietHours": ["enabled": $0]] }
            HStack(spacing: 10) {
                Text("From").foregroundStyle(Theme.secondary)
                clockPicker(q.start) { ["quietHours": ["start": $0, "timezone": zone]] }
                Text("to").foregroundStyle(Theme.secondary)
                clockPicker(q.end) { ["quietHours": ["end": $0, "timezone": zone]] }
                Spacer()
            }
            .disabled(!q.enabled)
            Text("Calls that come in then wait and ring when quiet hours end. Standing calls you set still ring.")
                .font(.system(size: 12)).foregroundStyle(Theme.secondary)
            Divider().overlay(Theme.hairline)
            HStack {
                if let until = state.settings.doNotDisturbUntil, until / 1000 > Date().timeIntervalSince1970 {
                    Label("Do not disturb until \(Date(timeIntervalSince1970: until / 1000).formatted(date: .omitted, time: .shortened))", systemImage: "moon.fill").foregroundStyle(Theme.text)
                    Spacer()
                    Button("Turn off") { Task { await model.setIncomingSettings(["doNotDisturbUntil": NSNull()]) } }.buttonStyle(QuietButton(tint: Theme.accent))
                } else {
                    Text("Do not disturb").foregroundStyle(Theme.text)
                    Spacer()
                    Menu {
                        Button("For 1 hour") { dnd(3600) }
                        Button("For 3 hours") { dnd(3 * 3600) }
                        Button("Until tomorrow morning") { dnd(untilMorning()) }
                    } label: { MenuLabel(text: "Turn on") }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                }
            }
        }
    }

    private func clockPicker(_ value: String, _ change: @escaping (String) -> [String: Any]) -> some View {
        let parts = value.split(separator: ":").compactMap { Int($0) }
        return DatePicker("", selection: Binding(get: { clockDate(parts.first ?? 0, parts.count > 1 ? parts[1] : 0) }, set: { d in
            let c = Calendar.current.dateComponents([.hour, .minute], from: d)
            Task { await model.setIncomingSettings(change(String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0))) }
        }), displayedComponents: .hourAndMinute).labelsHidden().frame(width: 110)
    }

    private func dnd(_ seconds: Double) {
        let until = Int((Date().timeIntervalSince1970 + seconds) * 1000)
        Task { await model.setIncomingSettings(["doNotDisturbUntil": until]) }
    }

    /// Seconds until 8:00 tomorrow.
    private func untilMorning() -> Double {
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        let eight = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        return min(eight.timeIntervalSinceNow, 7 * 86_400 - 60)
    }

    // MARK: call backs

    /// Rings held back (do not disturb, quiet hours, a call) or snoozed: shown so a press of Ring now or Later never looks lost.
    private func held(_ list: [IncomingRing]) -> some View {
        SettingsGroup("Waiting to ring") {
            ForEach(list) { r in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(r.title).foregroundStyle(Theme.text).lineLimit(1)
                        Text(r.waitingLabel).font(.system(size: 12)).foregroundStyle(Theme.secondary)
                    }
                    Spacer()
                    Button("Don't ring") { Task { await model.decline(r.id) } }.buttonStyle(QuietButton(tint: Theme.danger))
                }
            }
        }
    }

    private func callbacks(_ list: [CallBack]) -> some View {
        SettingsGroup("Call backs waiting") {
            ForEach(list) { c in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(c.botName): \(c.reason)").foregroundStyle(Theme.text).lineLimit(2)
                        Text(c.at.map { "At \(Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened))" } ?? "When its \(c.waitsFor.count == 1 ? "job finishes" : "\(c.waitsFor.count) jobs finish")")
                            .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                    }
                    Spacer()
                    Button("Cancel") { Task { await model.cancelCallback(c.id) } }.buttonStyle(QuietButton(tint: Theme.danger))
                }
            }
        }
    }
}

/// Calls you missed, newest first, each with Call back.
struct MissedCalls: View {
    @ObservedObject var model: AppModel
    let missed: [IncomingRing]
    var compact = false

    var body: some View {
        let shown = compact ? Array(missed.prefix(3)) : missed
        let group = VStack(alignment: .leading, spacing: 10) {
            ForEach(shown) { r in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "phone.arrow.down.left").foregroundStyle(Theme.danger).frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                        Text("\(Date(timeIntervalSince1970: r.createdAt / 1000).formatted(date: .abbreviated, time: .shortened)) · \(r.note.isEmpty ? r.kindLabel : r.note)")
                            .font(.system(size: 11.5)).foregroundStyle(Theme.secondary).lineLimit(2)
                    }
                    Spacer()
                    Button("Call back") { Task { await model.answer(r.id) } }.buttonStyle(QuietButton(tint: Theme.accent)).disabled(model.inCall || model.answering != nil)
                }
            }
            HStack {
                if compact && missed.count > shown.count { Text("\(missed.count - shown.count) more in Settings").font(.system(size: 12)).foregroundStyle(Theme.tertiary) }
                Spacer()
                Button("Clear") { Task { await model.clearMissed() } }.buttonStyle(QuietButton())
            }
        }
        if compact {
            VStack(alignment: .leading, spacing: 4) { SectionTitle(text: "Missed calls"); group }
        } else {
            SettingsGroup("Missed calls") { group }
        }
    }
}

/// Items laid out left to right, wrapping onto new lines.
struct FlowRow<Item: Identifiable, Content: View>: View {
    let items: [Item]
    @ViewBuilder var content: (Item) -> Content
    var body: some View {
        // Bots are few: rows of three keep it simple and even.
        let rows = stride(from: 0, to: items.count, by: 3).map { Array(items[$0..<min($0 + 3, items.count)]) }
        VStack(alignment: .leading, spacing: 6) {
            ForEach(rows.indices, id: \.self) { i in
                HStack(spacing: 6) { ForEach(rows[i]) { content($0) } }
            }
        }
    }
}
