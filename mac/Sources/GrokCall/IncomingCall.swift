import AppKit
import Carbon.HIToolbox
import Combine
import GrokCallCore
import SwiftUI
import UserNotifications

/// The card that shows while a call rings: who is calling and why, Answer, Decline, or ring again later.
struct IncomingCallView: View {
    @ObservedObject var model: AppModel
    let ring: IncomingRing

    var body: some View {
        let bots = ring.botIds.compactMap { id in model.bots.first { $0.id == id } }
        let answering = model.answering == ring.id
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                HStack(spacing: -10) {
                    ForEach(bots.prefix(4)) { b in MorphAvatar(shape: b.shape, color: b.color, state: .speaking).frame(width: 40, height: 40) }
                    if bots.isEmpty { Image(systemName: "phone.arrow.down.left.fill").font(.system(size: 22)).foregroundStyle(Theme.text).frame(width: 40, height: 40) }
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(ring.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Text(ring.kindLabel).font(.system(size: 12)).foregroundStyle(Theme.secondary)
                }
                Spacer(minLength: 0)
            }
            if !ring.reason.isEmpty {
                Text(ring.reason).font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(4).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Button { Task { await model.answer(ring.id) } } label: {
                    HStack(spacing: 6) {
                        if answering { ProgressView().controlSize(.small) } else { Image(systemName: "phone.fill") }
                        Text(answering ? "Joining…" : "Answer")
                    }
                }
                .buttonStyle(FilledButton(primary: true, wide: true))
                .keyboardShortcut(.defaultAction)
                Menu {
                    ForEach([5, 10, 15, 30, 60], id: \.self) { m in Button("In \(m) minutes") { Task { await model.snooze(ring.id, minutes: m) } } }
                } label: { MenuLabel(text: "Later") }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                Button("Decline") { Task { await model.decline(ring.id) } }.buttonStyle(FilledButton(danger: true))
                    .keyboardShortcut(.cancelAction)
            }
            .disabled(answering)
        }
        .padding(18)
        .frame(width: 380)
        .elevated(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Incoming call: \(ring.title)")
    }
}

/// Shows the incoming call: a floating card in the top-right corner, a ring sound, and a notification when Grok Call
/// isn't in front. It follows the backend's state: the card goes when the ring is answered, declined or missed.
@MainActor
final class IncomingCallController: NSObject, UNUserNotificationCenterDelegate {
    private let model: AppModel
    private var panel: NSPanel?
    private var shown: String?
    private var subs = Set<AnyCancellable>()
    private var sound: Timer?
    private var asked = false

    init(model: AppModel) {
        self.model = model
        super.init()
        UNUserNotificationCenter.current().delegate = self
        let answer = UNNotificationAction(identifier: "answer", title: "Answer", options: [.foreground])
        let decline = UNNotificationAction(identifier: "decline", title: "Decline", options: [.destructive])
        UNUserNotificationCenter.current().setNotificationCategories([UNNotificationCategory(identifier: "ring", actions: [answer, decline], intentIdentifiers: [])])
        model.$incoming.map { $0?.ringing }.removeDuplicates().receive(on: RunLoop.main).sink { [weak self] ring in self?.update(ring) }.store(in: &subs)
    }

    private func update(_ ring: IncomingRing?) {
        guard let ring else { return hide() }
        if shown == ring.id { return }
        hide()
        shown = ring.id
        let host = NSHostingController(rootView: IncomingCallView(model: model, ring: ring))
        let p = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 400, height: 200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.contentViewController = host
        p.setContentSize(host.view.fittingSize)
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let f = screen.visibleFrame
        p.setFrameTopLeftPoint(CGPoint(x: f.maxX - p.frame.width - 16, y: f.maxY - 12))
        p.orderFrontRegardless()
        panel = p
        AppLog.write("ringing: \(ring.source) \(ring.title)")
        // A soft ring every 2.5 s while it rings.
        NSSound(named: "Glass")?.play()
        sound = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { _ in NSSound(named: "Glass")?.play() }
        notify(ring)
    }

    private func hide() {
        sound?.invalidate()
        sound = nil
        panel?.orderOut(nil)
        panel = nil
        if let id = shown { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id]) }
        shown = nil
    }

    private func notify(_ ring: IncomingRing) {
        let center = UNUserNotificationCenter.current()
        let post = {
            let c = UNMutableNotificationContent()
            c.title = ring.title
            c.body = ring.reason.isEmpty ? ring.kindLabel : ring.reason
            c.categoryIdentifier = "ring"
            c.userInfo = ["ring": ring.id]
            center.add(UNNotificationRequest(identifier: ring.id, content: c, trigger: nil))
        }
        if asked { post(); return }
        asked = true
        center.requestAuthorization(options: [.alert]) { ok, _ in if ok { DispatchQueue.main.async { post() } } }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["ring"] as? String
        let action = response.actionIdentifier
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let id else { return }
                if action == "decline" { Task { await self.model.decline(id) } } else if action == "answer" { Task { await self.model.answer(id) } }
                done()
            }
        }
    }

    /// The card already shows while Grok Call is in front: no banner on top of it.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([])
    }
}

/// ⌥Space, held anywhere: in a meeting, your mic goes to the bots instead of the meeting while you hold it.
final class TalkKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let changed: (Bool) -> Void
    /// False when another app already uses ⌥Space.
    private(set) var registered = false

    init(changed: @escaping (Bool) -> Void) {
        self.changed = changed
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, data in
            guard let data, let event else { return noErr }
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard id.id == 2 else { return OSStatus(eventNotHandledErr) } // ⌥Esc (id 1) is the stop key's
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            Unmanaged<TalkKey>.fromOpaque(data).takeUnretainedValue().changed(pressed)
            return noErr
        }, 2, &specs, me, &handler)
        let id = EventHotKeyID(signature: OSType(0x4743_414C), id: 2) // "GCAL"
        registered = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &ref) == noErr
        if !registered { AppLog.write("talk key: ⌥Space is taken by another app") }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}
