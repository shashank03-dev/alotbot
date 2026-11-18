import AppKit
import GrokCallCore
import SwiftUI

/// Rects (in window coordinates, top-left origin) that take clicks; everywhere else clicks pass through.
struct HitRects: PreferenceKey {
    static let defaultValue: [CGRect] = []
    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) { value += nextValue() }
}

/// Where each bot's avatar sits in the open pill (window coordinates), for working out hover.
struct BotRects: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { $1 } }
}

extension View {
    /// Marks this view as clickable in the click-through overlay.
    func hitArea() -> some View {
        background(GeometryReader { g in Color.clear.preference(key: HitRects.self, value: [g.frame(in: .global)]) })
    }
}

/// Everything drawn in the full-screen, click-through overlay window.
struct OverlayRoot: View {
    @ObservedObject var model: AppModel
    @ObservedObject var prefs: Prefs
    /// The screen the overlay covers, in screen points.
    let screen: CGRect
    var onHitRects: ([CGRect]) -> Void
    var onBotRects: ([String: CGRect]) -> Void
    @Local private var dragFrom: CGPoint?
    /// False until the pill has appeared: then the faces pop in, one after another.
    @Local private var facesIn = false
    /// Set by the window from the pointer position. SwiftUI's own hover tracking misfires in a window
    /// that ignores the mouse outside the pill (it reported hover with the pointer far away).
    private var hovered: String? { model.hoveredBot }

    private var center: CGPoint { CGPoint(x: prefs.orbCenter.x - screen.minX, y: screen.maxY - prefs.orbCenter.y) }
    private var layout: PillLayout { PillLayout(botIds: model.callBots.map(\.id), expandedOverflow: model.showAllBots) }
    private var pillWidth: CGFloat { CGFloat(layout.width) }

    /// The pill's left edge: the host avatar sits where the circle was, unless that would run off screen.
    private var pillX: CGFloat {
        let ideal = center.x - CGFloat(PillLayout.padding + PillLayout.avatar / 2)
        return min(max(12, ideal), screen.width - pillWidth - 12)
    }
    private var pillY: CGFloat { min(max(12, center.y - PillLayoutCG.height / 2), screen.height - PillLayoutCG.height - 12) }
    /// The full view, centered in the screen's usable area.
    private var stageRect: CGRect {
        let visible = NSScreen.screens.first { $0.frame == screen }?.visibleFrame ?? screen
        return StageMetrics.rect(screen: screen, visible: visible)
    }

    /// Trays open below the pill, or above it when the pill is low on the screen.
    private var traysAbove: Bool { center.y > screen.height * 0.62 }

    /// Where the circle or pill is, as a point in the screen: the pill and the full view grow from and shrink
    /// toward it, so every change starts where your eye already is.
    private var pillAnchor: UnitPoint {
        let f = shellFrame
        return UnitPoint(x: f.midX / max(1, screen.width), y: f.midY / max(1, screen.height))
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            if model.overlayShown && model.inCall {
                if model.mode == .full {
                    StageView(model: model, prefs: prefs, rect: stageRect)
                        .frame(width: stageRect.width, height: stageRect.height)
                        .hitArea() // before `.position`, which would stretch it to the whole screen
                        // Placed with `.position`, it fills the screen: the anchor is the pill's spot in the screen.
                        .transition(Motion.stageTransition(anchor: pillAnchor, delay: 0.04))
                        .position(x: stageRect.midX, y: stageRect.midY)
                        .zIndex(4)
                } else {
                    // One layer, so the call arrives and leaves (and swaps with the full view) as one piece.
                    ZStack(alignment: .topLeading) {
                        shell
                        // Faces stay above the buttons while they fly across them as the pill opens.
                        if model.expanded { controls.zIndex(1); below.zIndex(3) }
                        avatars.zIndex(2)
                    }
                    .frame(width: screen.width, height: screen.height, alignment: .topLeading)
                    .transition(Motion.stageTransition(anchor: pillAnchor, delay: 0.04))
                    .onAppear { facesIn = true }
                    .onDisappear { facesIn = false }
                }
                toast.zIndex(6)
            }
        }
        .frame(width: screen.width, height: screen.height, alignment: .topLeading)
        .onPreferenceChange(HitRects.self) { onHitRects($0) }
        .onPreferenceChange(BotRects.self) { onBotRects($0) }
        // Opening springs out; folding settles without passing its mark.
        .animation(model.expanded ? Motion.open : Motion.close, value: model.mode)
        // A bot joining or leaving, or "+N" opening, resizes the pill smoothly instead of jumping.
        .animation(Motion.layout, value: model.callBots.map(\.id))
        .animation(Motion.layout, value: model.showAllBots)
    }

    // MARK: the circle / pill body

    private var shellFrame: CGRect {
        model.expanded
            ? CGRect(x: pillX, y: pillY, width: pillWidth, height: PillLayoutCG.height)
            : CGRect(x: center.x - PillLayoutCG.orb / 2, y: center.y - PillLayoutCG.orb / 2, width: PillLayoutCG.orb, height: PillLayoutCG.orb)
    }

    private var shell: some View {
        let f = shellFrame
        return ZStack {
            Color.clear
                .elevated(RoundedRectangle(cornerRadius: model.expanded ? 34 : PillLayoutCG.orb / 2, style: .continuous))
            if !model.expanded {
                // The ring comes back once the pill has mostly folded, and goes at once when it opens.
                RingLight(colors: model.callBots.map(\.color), mode: model.ringMode)
                    .frame(width: PillLayoutCG.orb + 12, height: PillLayoutCG.orb + 12)
                    .allowsHitTesting(false)
                    .transition(Motion.fadeTransition(delay: 0.16))
            }
        }
        .frame(width: f.width, height: f.height)
        .gesture(dragOrTap { if !model.expanded { model.setMode(.pill) } })
        // Measured before `.position`, which stretches the view to the whole screen: measuring after it
        // made the entire screen take clicks, so no other app could be used during a call.
        .hitArea()
        .position(x: f.midX, y: f.midY)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.expanded ? "Grok Call controls" : "Grok Call, \(model.callBots.count) bots. Click to open.")
    }

    /// Drag moves the overlay; a click without moving runs `tap`.
    private func dragOrTap(_ tap: @escaping () -> Void) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { g in
                if dragFrom == nil { dragFrom = prefs.orbCenter }
                guard let from = dragFrom, hypot(g.translation.width, g.translation.height) > 3 else { return }
                var p = CGPoint(x: from.x + g.translation.width, y: from.y - g.translation.height)
                p.x = min(max(screen.minX + 44, p.x), screen.maxX - 44)
                p.y = min(max(screen.minY + 44, p.y), screen.maxY - 44)
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { prefs.orbCenter = p }
            }
            .onEnded { g in
                dragFrom = nil
                if hypot(g.translation.width, g.translation.height) <= 3 { tap() }
            }
    }

    // MARK: avatars (they live in both shapes, so they fly between them)

    /// A bot's resting spot in the open pill (before avatars part around a hovered one).
    private func slotRect(_ id: String) -> CGRect {
        let x = pillX + CGFloat(layout.x(of: id) ?? layout.hostX)
        let y = pillY + PillLayoutCG.height / 2
        let half = PillLayoutCG.avatar / 2 + 5 // up to the middle of the gap to the next avatar
        return CGRect(x: x - half, y: y - half, width: half * 2, height: half * 2)
    }

    private func botPoint(_ i: Int, _ id: String) -> CGPoint {
        if model.expanded {
            let x = layout.x(of: id).map { CGFloat($0) } ?? CGFloat(layout.overflowX ?? layout.hostX)
            var p = CGPoint(x: pillX + x, y: pillY + PillLayoutCG.height / 2)
            if let h = hovered, h != id, let hi = layout.shown.firstIndex(of: h), let mine = layout.shown.firstIndex(of: id) {
                p.x += mine < hi ? -8 : 8 // part around the hovered avatar
            }
            return p
        }
        // Folded: bots peek out around the host inside the circle.
        let n = max(1, min(model.callBots.count, PillLayout.maxShown))
        let a = -Double.pi / 2 + Double(i % n) * 2 * .pi / Double(n) + 0.6
        return CGPoint(x: center.x + CGFloat(cos(a)) * 22, y: center.y + CGFloat(sin(a)) * 22)
    }

    private var avatars: some View {
        let bots = model.callBots
        let level: () -> Double = { [audio = model.audio] in audio.voiceLevel() }
        let hostLevel: () -> Double = { [audio = model.audio] in Double(min(1, audio.micLevel * 5)) }
        let size: CGFloat = model.expanded ? PillLayoutCG.avatar : 20
        let count = min(bots.count, PillLayout.maxShown)
        return ZStack(alignment: .topLeading) {
            ForEach(Array(bots.enumerated()), id: \.element.id) { i, b in
                let shown = model.expanded ? layout.shown.contains(b.id) : i < PillLayout.maxShown
                let lift = model.expanded && hovered == b.id
                BotFace(bot: b, state: avatarState(for: b.status), gaze: gaze(for: b), level: level)
                    .frame(width: size, height: size)
                    .scaleEffect(lift ? 1.08 : 1)
                    .overlay(alignment: .top) {
                        if lift {
                            Text(b.name).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.text)
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Capsule().fill(Color.black.opacity(0.85)))
                                .fixedSize().offset(y: -30)
                                .transition(.asymmetric(insertion: .offset(y: 4).combined(with: .opacity).animation(Motion.hover),
                                                        removal: .opacity.animation(Motion.exit)))
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if b.status == "error" { Circle().fill(Theme.danger).frame(width: 9, height: 9).transition(Motion.pop()) }
                    }
                    .overlay(alignment: .topTrailing) {
                        // This bot is waiting for your OK: tap it to answer.
                        if model.expanded && !model.approvals(for: b.id).isEmpty { AttentionDot().offset(x: 3, y: -3).transition(Motion.pop()) }
                    }
                    // The call's opening wave: each face pops in just after the one before it.
                    .scaleEffect(facesIn ? 1 : 0.55)
                    .opacity(facesIn ? 1 : 0)
                    .opacity(shown ? 1 : 0)
                    .transition(Motion.pop(anchor: Motion.anchor(botPoint(i, b.id), in: screen.size))) // a bot joining mid-call
                    .position(botPoint(i, b.id))
                    .offset(y: lift ? -3 : 0)
                    .animation(Motion.avatar(index: i, count: count, opening: model.expanded), value: model.expanded)
                    .animation(Motion.wave(index: i), value: facesIn)
                    .animation(Motion.hover, value: hovered)
                    .zIndex(model.expanded ? 2 : 0)
                    .preference(key: BotRects.self, value: model.expanded && shown ? [b.id: slotRect(b.id)] : [:])
                    .onTapGesture { if model.expanded { model.openCard(b.id) } else { model.setMode(.pill) } }
                    .allowsHitTesting(model.expanded && shown)
                    .accessibilityElement()
                    .accessibilityLabel("\(b.name), \(Labels.status(b.status))\(model.approvals(for: b.id).isEmpty ? "" : ", needs your OK")")
                    .accessibilityAddTraits(.isButton)
            }
            HostAvatar(prefs: prefs, name: model.hostName, speaking: model.view?.userSpeaking == true && model.view?.muted == false, level: hostLevel)
                .frame(width: model.expanded ? PillLayoutCG.avatar : 40, height: model.expanded ? PillLayoutCG.avatar : 40)
                .position(model.expanded ? CGPoint(x: pillX + CGFloat(layout.hostX), y: pillY + PillLayoutCG.height / 2) : center)
                .zIndex(1)
                .onTapGesture { model.setMode(model.expanded ? .circle : .pill) }
                .allowsHitTesting(true)
                .help(model.expanded ? "Fold into the circle" : "Open")
            if model.expanded, let ox = layout.overflowX {
                let p = CGPoint(x: pillX + CGFloat(ox), y: pillY + PillLayoutCG.height / 2)
                overflowBubble(count: layout.overflow).transition(Motion.pop(anchor: Motion.anchor(p, in: screen.size))).position(p).zIndex(3)
            }
        }
    }

    private func overflowBubble(count: Int) -> some View {
        Button { model.showAllBots.toggle() } label: {
            Text(count > 0 ? "+\(count)" : "−").font(.system(size: 14, weight: .semibold, design: .rounded)).foregroundStyle(.black)
                .frame(width: PillLayoutCG.avatar - 4, height: PillLayoutCG.avatar - 4).background(Circle().fill(Color.white.opacity(0.9)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count > 0 ? "Show \(count) more bots" : "Show fewer bots")
    }

    /// Who this bot looks at, turned into a direction from where it sits in the pill.
    private func gaze(for b: CallBot) -> GazeTarget? {
        guard let target = b.looksAt else { return nil }
        if !model.expanded { return target == "host" ? GazeTarget(x: 0, y: 0.3) : nil }
        return layout.gaze(from: b.id, to: target)
    }

    // MARK: buttons on the pill

    private var controls: some View {
        let x = pillX + pillWidth - CGFloat(PillLayout.padding) - controlsWidth / 2, y = pillY + PillLayoutCG.height / 2
        return CallButtons(model: model, opensFullView: true)
            .frame(height: PillLayoutCG.height)
            .transition(controlsTransition(from: Motion.anchor(CGPoint(x: x - controlsWidth / 2, y: y), in: screen.size)))
            .position(x: x, y: y)
    }

    /// The buttons wait for the pill to open, then fade and grow into place from the avatars' side;
    /// when it folds they go first, quickly, so the pill never shrinks over them.
    /// `anchor`: the buttons' left edge, in screen units (they are placed with `.position`, so they fill the screen).
    private func controlsTransition(from anchor: UnitPoint) -> AnyTransition {
        if Theme.reduceMotion { return Motion.fadeTransition() }
        return .asymmetric(
            insertion: .scale(scale: 0.94, anchor: anchor).combined(with: .opacity).animation(Motion.surface.delay(MotionSpec.controlsDelay)),
            removal: .opacity.animation(.easeIn(duration: MotionSpec.exit * 0.6)))
    }

    private var controlsWidth: CGFloat { CGFloat(PillLayout.buttons) * PillLayoutCG.button + CGFloat(PillLayout.buttons - 1) * CGFloat(PillLayout.buttonGap) }

    // MARK: trays and the bot card

    private var trayWidth: CGFloat { max(pillWidth, 420) }

    @ViewBuilder private var below: some View {
        let x = min(pillX, screen.width - trayWidth - 12)
        let gap: CGFloat = 10
        Group {
            if let id = model.cardBot, let b = model.callBots.first(where: { $0.id == id }) {
                BotCard(model: model, bot: b)
                    .frame(width: 320)
                    .fixedSize(horizontal: false, vertical: true)
                    .hitArea()
                    .alignmentGuide(.top) { _ in 0 }
                    .transition(Motion.surfaceTransition(anchor: traysAbove ? .bottom : .top, lift: traysAbove ? 6 : -6))
                    .modifier(PlaceBelow(x: cardX(for: id), y: traysAbove ? pillY - gap : pillY + PillLayoutCG.height + gap, above: traysAbove))
                    .id("card-\(id)") // another bot's card crossfades in
            } else if let t = model.tray {
                TrayView(model: model, prefs: prefs, tray: t)
                    .frame(width: trayWidth)
                    .fixedSize(horizontal: false, vertical: true)
                    .hitArea()
                    // It emerges from the pill: a few points of drift and a fade, never a slide by its whole height.
                    .transition(Motion.surfaceTransition(anchor: traysAbove ? .bottom : .top, lift: traysAbove ? 6 : -6))
                    .modifier(PlaceBelow(x: x, y: traysAbove ? pillY - gap : pillY + PillLayoutCG.height + gap, above: traysAbove))
                    .id(t) // switching trays crossfades one panel into the next
            } else if model.expanded, let m = model.view?.meeting {
                // In a meeting, with nothing else open: how bots whisper, and hold to talk to them.
                MeetingControls(model: model, meeting: m)
                    .frame(width: trayWidth)
                    .fixedSize(horizontal: false, vertical: true)
                    .hitArea()
                    .transition(Motion.surfaceTransition(anchor: traysAbove ? .bottom : .top, lift: traysAbove ? 6 : -6))
                    .modifier(PlaceBelow(x: x, y: traysAbove ? pillY - gap : pillY + PillLayoutCG.height + gap, above: traysAbove))
            }
        }
    }

    private func cardX(for id: String) -> CGFloat {
        let ax = layout.x(of: id).map { CGFloat($0) } ?? 0
        return min(max(12, pillX + ax - 40), screen.width - 332)
    }

    private var toast: some View {
        Group {
            if let t = model.toast {
                Text(t).font(.system(size: 12.5)).foregroundStyle(Theme.text).multilineTextAlignment(.leading)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .elevated(Capsule(), fill: Theme.raised, high: false)
                    .frame(maxWidth: 420)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(Motion.surfaceTransition(anchor: .bottom, lift: 6))
                    .id(t) // a new message replaces the old one with a crossfade
                    .modifier(model.mode == .full
                        ? PlaceBelow(x: stageRect.midX - 210, y: stageRect.maxY - StageMetrics.controls - 8, above: true)
                        : PlaceBelow(x: model.expanded ? pillX : center.x - 60, y: traysAbove ? (model.expanded ? pillY : center.y - 46) - 46 : (model.expanded ? pillY + PillLayoutCG.height : center.y + 46) + 8, above: false))
                    .allowsHitTesting(false)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
    }
}

/// Places a view with its top-left (or bottom-left, when `above`) at a point.
struct PlaceBelow: ViewModifier {
    let x: CGFloat, y: CGFloat, above: Bool
    func body(content: Content) -> some View {
        content
            .alignmentGuide(.leading) { _ in -x }
            .alignmentGuide(.top) { d in above ? -(y - d.height) : -y }
    }
}

/// One bot's avatar as the pill draws it.
struct BotFace: View {
    let bot: CallBot
    let state: AvatarState
    let gaze: GazeTarget?
    let level: () -> Double
    var body: some View {
        MorphAvatar(shape: bot.shape, color: bot.color, state: state, gaze: gaze, dimmed: bot.status == "connecting" || bot.status == "reconnecting" || bot.status == "error", level: level)
    }
}

/// The line of light around the folded circle, in the bots' colors: it spins while a bot thinks or speaks,
/// strobes while you speak, and rests otherwise.
struct RingLight: View {
    let colors: [String?]
    let mode: RingMode
    @StateObject private var spin = SpinState()

    final class SpinState: ObservableObject {
        var angle = 0.0
        var speed = 0.0
        var last: Date?
    }

    var body: some View {
        let stops = Palette.ringStops(colors).map(\.color)
        TimelineView(.animation(paused: Theme.reduceMotion && mode == .rest)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let dt = min(0.1, spin.last.map { tl.date.timeIntervalSince($0) } ?? 0)
            let _ = { spin.last = tl.date }()
            let target = Theme.reduceMotion ? 0 : (mode == .spin ? 3.2 : mode == .strobe ? 1.1 : 0)
            let _ = { spin.speed += (target - spin.speed) * min(1, dt * 4); spin.angle += spin.speed * dt }()
            ZStack {
                Circle().stroke(AngularGradient(colors: stops, center: .center), lineWidth: 1.5).opacity(mode == .rest ? 0.28 : 0.18)
                if mode == .strobe {
                    // You're talking: the segments pulse in a slow travelling wave (well under 3 flashes a second).
                    ForEach(0..<8, id: \.self) { i in
                        let wave = sin(t * 2 * .pi * MotionSpec.strobeHz - Double(i) * .pi / 4)
                        let flash = Theme.reduceMotion ? 0.8 : 0.4 + 0.6 * (0.5 + 0.5 * wave)
                        Circle().trim(from: Double(i) / 8 + 0.015, to: Double(i) / 8 + 0.095)
                            .stroke(stops[i % max(1, stops.count - 1)], style: StrokeStyle(lineWidth: 3, lineCap: .round))
                            .opacity(flash)
                            .shadow(color: stops[i % max(1, stops.count - 1)].opacity(0.8 * flash), radius: 5)
                    }
                    .rotationEffect(.radians(spin.angle))
                    .transition(.opacity)
                } else {
                    let arc = Circle().trim(from: 0, to: mode == .spin ? 0.32 : 0.18)
                        .stroke(AngularGradient(colors: [stops.first!.opacity(0)] + stops, center: .center, startAngle: .degrees(0), endAngle: .degrees(mode == .spin ? 115 : 65)),
                                style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    ZStack {
                        arc.blur(radius: 5).opacity(mode == .spin ? 0.9 : 0.35)
                        arc.opacity(mode == .spin ? 1 : 0.5)
                    }
                    .rotationEffect(.radians(spin.angle))
                    .transition(.opacity)
                }
            }
            // Switching between resting, spinning and pulsing crossfades; the arc grows and brightens smoothly.
            .animation(Motion.crossfade, value: mode)
        }
    }
}

/// The call's buttons, the same in the pill and the full view. `opensFullView` adds the pill's button that opens it.
struct CallButtons: View {
    @ObservedObject var model: AppModel
    let opensFullView: Bool

    var body: some View {
        let muted = model.view?.muted == true
        HStack(spacing: CGFloat(PillLayout.buttonGap)) {
            CircleButton(symbol: "plus", label: "Add a bot", active: model.tray == .add || model.tray == .newBot) { model.toggleTray(.add) }
            CircleButton(symbol: "text.bubble", label: "Conversation", active: model.tray == .chat) { model.toggleTray(.chat) }
            CircleButton(symbol: "rectangle.on.rectangle", label: model.view?.screen.map { "Sharing \($0.label)" } ?? "Share your screen", active: model.tray == .share || model.view?.screen != nil) { model.toggleTray(.share) }
            CircleButton(symbol: muted ? "mic.slash.fill" : "mic.fill", label: muted ? "Unmute" : "Mute", active: muted) { model.toggleMute() }
            if opensFullView {
                CircleButton(symbol: "arrow.up.left.and.arrow.down.right", label: "Full view", active: false) { model.setMode(.full) }
            }
            // While the call saves, the hang-up button spins: a "Saving the call…" label here used to widen the row
            // past the pill and over the avatars.
            CircleButton(symbol: "phone.down.fill", label: model.leaving ? "Saving the call…" : "Leave call", tint: Theme.danger, busy: model.leaving) { Task { await model.leave() } }
        }
        .disabled(model.leaving)
    }
}

/// A small orange dot that gently pulses: this needs you.
struct AttentionDot: View {
    @Local private var on = false
    var body: some View {
        Circle().fill(Theme.warn).frame(width: 11, height: 11)
            .overlay(Circle().strokeBorder(Theme.surface, lineWidth: 2))
            .background(Circle().fill(Theme.warn.opacity(0.45)).scaleEffect(on ? 1.9 : 1).opacity(on ? 0 : 0.8))
            .onAppear { if !Theme.reduceMotion { withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { on = true } } }
            .accessibilityHidden(true)
    }
}
