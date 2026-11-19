import AppKit
import AlotbotCore
import SwiftUI

/// In the menu: listen to a meeting with the chosen bots. They hear it as text and whisper to you; nobody in the
/// meeting hears them.
struct MeetingStartView: View {
    @ObservedObject var model: AppModel
    @Local private var open = false
    @Local private var app: MeetingApp?
    @Local private var consent = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(Motion.layout) { open.toggle() }
                if open { model.refreshMeetingApps(); if app == nil { app = model.meetingApps.first } }
            } label: {
                HStack {
                    Image(systemName: "person.3.fill").font(.system(size: 12))
                    Text("Listen to a meeting").font(.system(size: 13, weight: .medium))
                    Spacer()
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 11))
                }
                .foregroundStyle(Theme.text).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Text("Your bots follow a meeting in another app and whisper to you. The meeting is transcribed on this Mac; nobody in it hears the bots.")
                    .font(.system(size: 12)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Text("Meeting in").foregroundStyle(Theme.secondary).font(.system(size: 12.5))
                    Menu {
                        ForEach(model.meetingApps) { a in Button(a.name) { app = a } }
                        Divider()
                        Button("Refresh") { model.refreshMeetingApps() }
                    } label: { MenuLabel(text: app?.name ?? "Choose the app") }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                }
                if let a = app, MeetingApps.browsers.contains(a.bundleId) {
                    Text("Everything \(a.name) plays is heard: keep only the meeting playing.").font(.system(size: 11.5)).foregroundStyle(Theme.tertiary)
                }
                Toggle(isOn: $consent) {
                    Text("The people in this meeting know it is being transcribed").font(.system(size: 12.5)).frame(maxWidth: .infinity, alignment: .leading)
                }
                .toggleStyle(.checkbox).foregroundStyle(Theme.text)
                Button {
                    guard let a = app else { return }
                    let ids = model.bots.map(\.id).filter(model.picked.contains)
                    Task { await model.startMeeting(app: a, botIds: ids, consent: consent) }
                } label: {
                    Text(model.picked.isEmpty ? "Choose bots above" : model.joining ? "Starting…" : "Listen with \(model.picked.count) bot\(model.picked.count == 1 ? "" : "s")")
                }
                .buttonStyle(WideButton(primary: true))
                .disabled(app == nil || !consent || model.picked.isEmpty || model.joining)
                Text(model.talkKeyAvailable ? "Hold ⌥Space to talk to your bots; otherwise your mic is part of the meeting." : "Hold the talk button in the call to talk to your bots; otherwise your mic is part of the meeting.")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.tertiary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 6)
    }
}
