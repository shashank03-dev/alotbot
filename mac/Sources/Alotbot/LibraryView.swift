import AppKit
import AlotbotCore
import SwiftUI

/// Settings › Call history: every saved call and meeting, searchable. Open one to read it, continue it with bots,
/// save it, or delete it for good.
struct LibraryView: View {
    @ObservedObject var model: AppModel
    @Local private var query = ""
    @Local private var kind: String? = nil
    @Local private var search: Task<Void, Never>?

    var body: some View {
        HStack(spacing: 0) {
            list.frame(width: 340)
            Divider().overlay(Theme.hairline)
            Group {
                if let d = model.libraryDetail { LibraryDetailView(model: model, detail: d) } else {
                    Text("Choose a call to read it.").foregroundStyle(Theme.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await model.refreshLibrary() }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 10) {
            DarkTextInput(placeholder: "Search calls: words, a decision, a name", text: $query)
                .onChange(of: query) { _, _ in reload(delay: true) }
            HStack(spacing: 6) {
                ForEach([(nil, "All"), ("call", "Calls"), ("meeting", "Meetings")] as [(String?, String)], id: \.1) { k, title in
                    Button(title) { kind = k; reload(delay: false) }
                        .buttonStyle(.plain).font(.system(size: 12, weight: .medium))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(kind == k ? Theme.accent.opacity(0.35) : Theme.fill))
                        .foregroundStyle(Theme.text)
                        .accessibilityAddTraits(kind == k ? .isSelected : [])
                }
                Spacer()
                if let total = model.library?.total { Text("\(total) saved").font(.system(size: 11.5)).foregroundStyle(Theme.tertiary) }
            }
            if let e = model.libraryError { Text(e).font(.system(size: 12.5)).foregroundStyle(Theme.danger) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    let calls = model.library?.calls ?? []
                    if calls.isEmpty && model.library != nil {
                        Text(query.isEmpty ? "No saved calls yet." : "Nothing matches “\(query)”.").font(.system(size: 13)).foregroundStyle(Theme.secondary).padding(.top, 8)
                    }
                    ForEach(calls) { c in row(c) }
                    if model.library?.hasMore == true {
                        Button("Show more") { Task { await model.refreshLibrary(query: query, kind: kind, more: true) } }.buttonStyle(QuietButton(tint: Theme.accent))
                    }
                }
            }
        }
        .padding(16)
    }

    private func row(_ c: LibraryCall) -> some View {
        let selected = model.libraryDetail?.call.id == c.id
        return Button { Task { await model.openLibraryCall(c.id) } } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: c.isMeeting ? "person.3.fill" : "phone.fill").font(.system(size: 10)).foregroundStyle(Theme.tertiary)
                    Text(Date(timeIntervalSince1970: c.startedAt / 1000).formatted(date: .abbreviated, time: .shortened)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.text)
                    Spacer()
                    Text("\(c.minutes) min").font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                }
                if let m = c.match {
                    (Text("\(Snippet.label(m)): ").foregroundStyle(Theme.tertiary) + Snippet.runs(m.snippet).reduce(Text("")) { t, r in
                        t + Text(r.text).fontWeight(r.matched ? .semibold : .regular).foregroundStyle(r.matched ? Theme.text : Theme.secondary)
                    })
                    .font(.system(size: 12)).lineLimit(3)
                } else {
                    Text(c.summary.isEmpty ? "No summary." : c.summary).font(.system(size: 12)).foregroundStyle(Theme.secondary).lineLimit(2)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(selected ? Theme.fillHover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Searching waits for a pause in typing.
    private func reload(delay: Bool) {
        search?.cancel()
        let q = query, k = kind
        search = Task {
            if delay { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await model.refreshLibrary(query: q, kind: k)
        }
    }
}

/// One saved call: summary, decisions, action items and the transcript; continue it, save it, or delete it.
struct LibraryDetailView: View {
    @ObservedObject var model: AppModel
    let detail: LibraryDetail
    @Local private var continueWith = Set<String>()
    @Local private var confirmDelete = false

    var body: some View {
        let c = detail.call
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(c.isMeeting ? "Meeting" : "Call"), \(Date(timeIntervalSince1970: c.startedAt / 1000).formatted(date: .complete, time: .shortened))")
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    Text("\(c.minutes) min · \(c.bots.isEmpty ? "No bots" : c.bots.joined(separator: ", "))").font(.system(size: 12.5)).foregroundStyle(Theme.secondary)
                }
                section("Summary") { Text(c.summary.isEmpty ? "No summary was saved." : c.summary).textSelection(.enabled) }
                if !c.decisions.isEmpty { section("Decisions") { bullets(c.decisions) } }
                if !c.actionItems.isEmpty { section("Action items") { bullets(c.actionItems) } }
                section("Continue this call") {
                    Text("The bots start from its summary and decisions, and can look up anything said in it.").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                    FlowRow(items: model.bots) { b in
                        let on = continueWith.contains(b.id)
                        Button { if on { continueWith.remove(b.id) } else { continueWith.insert(b.id) } } label: {
                            HStack(spacing: 6) { MorphAvatar(shape: b.shape, color: b.color).frame(width: 18, height: 18); Text(b.name).font(.system(size: 12.5)) }
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(Capsule().fill(on ? Theme.accent.opacity(0.35) : Theme.fill)).foregroundStyle(Theme.text)
                        }
                        .buttonStyle(.plain)
                    }
                    Button(model.joining ? "Starting…" : "Continue the call") {
                        let ids = model.bots.map(\.id).filter(continueWith.contains)
                        Task { await model.continueCall(c.id, botIds: ids) }
                    }
                    .buttonStyle(FilledButton(primary: true)).disabled(continueWith.isEmpty || model.inCall || model.joining)
                    .help(model.inCall ? "Leave the current call first" : "")
                }
                section("Transcript") {
                    if detail.lines.isEmpty { Text("Nothing was said.").foregroundStyle(Theme.secondary) }
                    ForEach(detail.lines) { l in
                        (Text("\(l.who)\(l.cut ? " (cut off)" : ""): ").fontWeight(.semibold) + Text(l.text)).font(.system(size: 13)).foregroundStyle(Theme.text).textSelection(.enabled)
                    }
                }
                HStack(spacing: 8) {
                    Button("Save to Downloads") { model.saveToDownloads(file: c.file) }.buttonStyle(FilledButton()).disabled(detail.markdown == nil)
                    Button("Show in Finder") { if let u = model.callURL(file: c.file) { NSWorkspace.shared.activateFileViewerSelecting([u]) } }.buttonStyle(QuietButton()).disabled(detail.markdown == nil)
                    Spacer()
                    Button("Delete…") { confirmDelete = true }.buttonStyle(QuietButton(tint: Theme.danger))
                }
                if detail.markdown == nil { Text("The saved file was removed outside Alotbot; its words are still searchable here.").font(.system(size: 12)).foregroundStyle(Theme.tertiary) }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { continueWith = Set(model.bots.filter { c.bots.contains($0.name) }.map(\.id)) }
        .onChange(of: detail.call.id) { _, _ in continueWith = Set(model.bots.filter { detail.call.bots.contains($0.name) }.map(\.id)) }
        .alert("Delete this call?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await model.deleteLibraryCall(c.id) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its file and transcript are removed from this Mac, bots can no longer look it up, and the next call won't start from its summary.")
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: title)
            content()
        }
        .font(.system(size: 13.5))
        .foregroundStyle(Theme.text)
    }

    private func bullets(_ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) { ForEach(items, id: \.self) { Text("• \($0)").textSelection(.enabled) } }
    }
}
