import AppKit
import Carbon.HIToolbox
import Combine
import AlotbotCore
import SwiftUI

/// The overlay window: covers the screen, floats above apps on every Space, and only takes clicks
/// on the circle, pill, trays and card. Everywhere else, clicks reach the app underneath.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class OverlayController {
    let panel: OverlayPanel
    private let model: AppModel
    private var hitRects: [CGRect] = []
    private var botRects: [String: CGRect] = [:]
    private var mouseTimer: Timer?
    private var clickMonitor: Any?
    private var keyMonitor: Any?
    private var subs = Set<AnyCancellable>()
    private var appObserver: NSObjectProtocol?
    private var restoreObservers: [NSObjectProtocol] = []
    private var host: NSHostingView<OverlayRoot>!
    /// Takes the window down once the call's exit animation has played; cancelled if a call shows again first.
    private var hideTask: Task<Void, Never>?

    init(model: AppModel) {
        self.model = model
        let screen = NSScreen.main ?? NSScreen.screens[0]
        panel = OverlayPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.becomesKeyOnlyIfNeeded = true
        host = NSHostingView(rootView: Self.root(model: model, screen: screen.frame, onRects: { _ in }, onBots: { _ in }))
        panel.contentView = host
        fit(to: screen)
        // macOS can drop a floating window after sleep, a Space change or a display change. Put it back.
        let ws = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            restoreObservers.append(ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.restore() } })
        }
        restoreObservers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.fit(to: NSScreen.main ?? NSScreen.screens[0]); self?.restore() }
        })

        model.$overlayShown.combineLatest(model.$view.map { $0 != nil }).map { $0 && $1 }.removeDuplicates().receive(on: RunLoop.main).sink { [weak self] on in
            self?.setVisible(on)
        }.store(in: &subs)
        // Clicks pass through unless the pointer is over something we drew.
        mouseTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateMouse() }
        }
        // Folding when you use another app (unless "keep the pill open" is on).
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.focusLost() }
        }
        appObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            MainActor.assumeIsolated { if app?.processIdentifier != ProcessInfo.processInfo.processIdentifier { self?.focusLost() } }
        }
        // Esc while the pill is focused: close the tray/card, or stop every bot.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, e.keyCode == UInt16(kVK_Escape), e.window === self.panel else { return e }
            if self.model.tray != nil || self.model.cardBot != nil { self.model.tray = nil; self.model.cardBot = nil } else { self.model.stopAll() }
            return nil
        }
    }

    private static func root(model: AppModel, screen: CGRect, onRects: @escaping ([CGRect]) -> Void, onBots: @escaping ([String: CGRect]) -> Void) -> OverlayRoot {
        OverlayRoot(model: model, prefs: model.prefs, screen: screen, onHitRects: onRects, onBotRects: onBots)
    }

    /// Cover this screen, and pull the circle back onto it if it was left on a screen that's gone.
    private func fit(to screen: NSScreen) {
        let f = screen.frame
        let c = model.prefs.orbCenter
        let clamped = CGPoint(x: min(max(f.minX + 44, c.x), f.maxX - 44), y: min(max(f.minY + 44, c.y), f.maxY - 44))
        if clamped != c { model.prefs.orbCenter = clamped }
        host.rootView = Self.root(model: model, screen: f, onRects: { [weak self] in self?.hitRects = $0 }, onBots: { [weak self] in self?.botRects = $0 })
        host.frame = CGRect(origin: .zero, size: f.size)
        panel.setFrame(f, display: true)
    }

    private func restore() {
        if model.overlayShown && model.inCall { panel.orderFrontRegardless() }
    }

    /// Showing is at once (the pill then animates in). Hiding waits for the pill or full view to finish
    /// leaving: taking the window down at once cut the exit off, so the call just vanished.
    private func setVisible(_ on: Bool) {
        hideTask?.cancel()
        hideTask = nil
        if on { panel.orderFrontRegardless(); return }
        panel.ignoresMouseEvents = true // nothing is clickable while it leaves
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(MotionSpec.overlayLinger))
            guard !Task.isCancelled, let self, !(self.model.overlayShown && self.model.inCall) else { return }
            self.panel.orderOut(nil)
        }
    }

    private func updateMouse() {
        guard panel.isVisible else { if model.hoveredBot != nil { model.hoveredBot = nil }; return }
        let p = NSEvent.mouseLocation
        let f = panel.frame
        // Window coordinates have a top-left origin in SwiftUI.
        let local = CGPoint(x: p.x - f.minX, y: f.maxY - p.y)
        let over = hitRects.contains { $0.insetBy(dx: -4, dy: -4).contains(local) }
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
        let bot = model.expanded ? botRects.first { $0.value.contains(local) }?.key : nil
        if model.hoveredBot != bot { model.hoveredBot = bot }
    }

    private func focusLost() {
        // Only the pill folds away. The full view stays until you close it, so you can watch the bots from other apps.
        guard model.expanded, !model.prefs.keepPill else { return }
        // A click on our own window doesn't count (global monitors only see other apps' events).
        model.collapse()
    }
}

/// ⌥Esc, anywhere: stop every bot.
final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void

    init(action: @escaping () -> Void) {
        self.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, data in
            guard let data, let event else { return noErr }
            // Only ⌥Esc (id 1): other hot keys of this app, like the talk key, are theirs.
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard id.id == 1 else { return OSStatus(eventNotHandledErr) }
            Unmanaged<HotKey>.fromOpaque(data).takeUnretainedValue().action()
            return noErr
        }, 1, &spec, me, &handler)
        let id = EventHotKeyID(signature: OSType(0x4743_414C), id: 1) // "GCAL"
        RegisterEventHotKey(UInt32(kVK_Escape), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &ref)
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}

/// The app icon's four tiles as a menu bar template: outlined when idle, filled during a call.
enum MenuBarIcon {
    static func image(inCall: Bool) -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            let cg = NSGraphicsContext.current!.cgContext
            for (x, y) in [(1.5, 1.5), (9.5, 1.5), (1.5, 9.5), (9.5, 9.5)] {
                let r = CGRect(x: x, y: y, width: 7, height: 7)
                cg.setFillColor(.black); cg.setStrokeColor(.black)
                if inCall {
                    cg.addPath(CGPath(roundedRect: r, cornerWidth: 2.3, cornerHeight: 2.3, transform: nil)); cg.fillPath()
                    cg.setBlendMode(.clear)
                } else {
                    cg.setLineWidth(1.2)
                    cg.addPath(CGPath(roundedRect: r.insetBy(dx: 0.6, dy: 0.6), cornerWidth: 2, cornerHeight: 2, transform: nil)); cg.strokePath()
                }
                for ex in [x + 2, x + 4.1] { cg.fill(CGRect(x: ex, y: y + 2.2, width: 0.9, height: 2.3)) }
                cg.setBlendMode(.normal)
            }
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = inCall ? "Alotbot, in a call" : "Alotbot"
        return img
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Set by "Reopen". Acted on only once quitting really happens, so a cancelled quit doesn't reopen later.
    static var reopenOnQuit = false

    func applicationWillTerminate(_ notification: Notification) {
        guard Self.reopenOnQuit else { return }
        _ = try? Process.run(URL(fileURLWithPath: "/bin/sh"), arguments: Relaunch.arguments(pid: getpid(), app: Bundle.main.bundlePath))
    }

    private var model: AppModel!
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var overlay: OverlayController!
    private var settings: NSWindow?
    private var hotKey: HotKey?
    private var talkKey: TalkKeySwitch?
    private var incomingCalls: IncomingCallController?
    private var subs = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ note: Notification) {
        model = AppModel()
        overlay = OverlayController(model: model)
        hotKey = HotKey { [weak self] in DispatchQueue.main.async { self?.model.stopAll() } }
        // ⌥Space is registered only during a meeting; ⌥Esc (hotKey) stays registered all the time.
        talkKey = TalkKeySwitch(wanted: model.talkKeyWanted, make: { [weak self] in
            let key = TalkKey { held in DispatchQueue.main.async { self?.model.setTalk(held) } }
            return (key, key.registered)
        }, registered: { [weak self] in self?.model.talkKeyAvailable = $0 })
        incomingCalls = IncomingCallController(model: model)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = MenuBarIcon.image(inCall: false)
        statusItem.button?.action = #selector(togglePopover)
        statusItem.button?.target = self
        model.$view.map { $0 != nil }.removeDuplicates().sink { [weak self] inCall in
            self?.statusItem.button?.image = MenuBarIcon.image(inCall: inCall)
        }.store(in: &subs)

        popover = NSPopover()
        popover.behavior = .transient
        popover.animates = true
        model.macTools.refreshPermissions()
        AppLog.write("permissions on at launch: \(MacPermission.allCases.filter(model.macTools.granted.contains).map(\.rawValue))")
        Opening.show { [weak self] in
            guard let self else { return }
            if model.macTools.needsSetup { showSetup() } else { model.macTools.requestFileAccessIfNeeded() }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.model.macTools.refreshPermissions() }
        }
        popover.contentViewController = NSHostingController(rootView: MenuBarView(model: model, openSettings: { [weak self] in self?.openSettings() }, quit: { NSApp.terminate(nil) }))
    }

    private var setup: NSWindow?

    private func showSetup() {
        let w = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Alotbot"
        w.isReleasedWhenClosed = false
        w.appearance = NSAppearance(named: .darkAqua)
        w.contentViewController = NSHostingController(rootView: SetupView(tools: model.macTools) { [weak self] in self?.setup?.close() })
        // Closing the window any way counts as done, so it never comes back on its own.
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.model.macTools.finishSetup(); self?.setup = nil }
        }
        w.center()
        setup = w
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown { popover.performClose(nil); return }
        Task { await model.refreshTasks(); if model.login.state == "signed-in", !model.inCall { await model.refreshBots() } }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    private func openSettings() {
        popover.performClose(nil)
        if settings == nil {
            let w = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 900, height: 650), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Alotbot Settings"
            w.isReleasedWhenClosed = false
            w.appearance = NSAppearance(named: .darkAqua)
            w.contentViewController = NSHostingController(rootView: SettingsView(model: model, prefs: model.prefs))
            w.center()
            settings = w
        }
        NSApp.activate(ignoringOtherApps: true)
        settings?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard model.inCall || model.workspaces.hasRecordingLesson else { model.workspaces.closeAll(); model.backend.stop(); return .terminateNow }
        // Save the call (summary included) before quitting.
        Task {
            guard await model.workspaces.prepareToClose() else { NSApp.reply(toApplicationShouldTerminate: false); return }
            if model.inCall { await model.leave() }
            model.workspaces.closeAll()
            model.backend.stop()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
