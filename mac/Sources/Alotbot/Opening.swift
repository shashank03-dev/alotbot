import AppKit
import AlotbotCore
import SwiftUI

/// The launch animation: your bots spiral in from all over the screen onto an arc, talk, the name comes in under them,
/// and then they sink one by one into the middle of the screen, on a plain black stage. Plays once per launch, skipped with Reduce Motion. It never takes clicks.
@MainActor enum Opening {
    private static var panel: NSPanel?

    static func show(then next: @escaping () -> Void) {
        guard !Theme.reduceMotion, panel == nil, let screen = NSScreen.main else { next(); return }
        let p = makePanel(on: screen) {
            panel?.orderOut(nil)
            panel = nil
            next()
        }
        panel = p
        p.orderFrontRegardless()
    }

    /// The whole screen, see-through and click-through, so the bots can spiral in from its edges.
    static func makePanel(on screen: NSScreen, done: @escaping () -> Void) -> NSPanel {
        let p = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        p.isReleasedWhenClosed = false
        p.ignoresMouseEvents = true
        let host = NSHostingView(rootView: OpeningView(bots: OpeningBots.load(), done: done))
        // By default the hosting view shrinks the panel to the view's own 580 x 300, which left it in a corner.
        host.sizingOptions = []
        p.contentView = host
        p.setFrame(screen.frame, display: false)
        return p
    }
}

/// The last bots you had, so the opening can turn into them before the backend has started.
enum OpeningBots {
    static let key = "openingBots"
    /// The icon's tiles, in order.
    static let tiles = ["violet", "cyan", "orange", "magenta"]
    /// How many bots the opening shows.
    static let count = 7
    /// What fills the stage when fewer bots are known: the icon's four, then three more.
    static let fallback: [Look] = [Look(shape: "blob", color: "violet"), Look(shape: "gem", color: "cyan"), Look(shape: "cloud", color: "orange"),
                                   Look(shape: "heart", color: "magenta"), Look(shape: "star", color: "yellow"), Look(shape: "flower", color: "green"),
                                   Look(shape: "squircle", color: "blue")]

    struct Look: Equatable { var shape: String?; var color: String? }

    static func save(_ bots: [Bot], defaults: UserDefaults = .standard) {
        guard !bots.isEmpty else { return }
        defaults.set(bots.prefix(count).map { ["shape": $0.shape ?? "", "color": $0.color ?? ""] }, forKey: key)
    }

    /// Always `count`: your bots first, then the defaults.
    static func load(defaults: UserDefaults = .standard) -> [Look] {
        let saved = (defaults.array(forKey: key) as? [[String: String]] ?? []).prefix(count).map {
            Look(shape: $0["shape"].flatMap { $0.isEmpty ? nil : $0 }, color: $0["color"].flatMap { $0.isEmpty ? nil : $0 })
        }
        return Array(saved) + fallback.dropFirst(saved.count)
    }
}

/// The opening's own colors: a plain black stage and the app's ink. All other color comes from the bots.
enum OpeningPalette {
    static let stage = Color.black                                       // #000000
    static let ink = Color(red: 0.941, green: 0.941, blue: 0.941)        // #F0F0F0, the app's text
    static let inkText = Color(red: 0.078, green: 0.078, blue: 0.078)    // #141414, the app's chrome
}

/// The scene, drawn for each moment from `OpeningScene`: the stage, light motes rushing past in depth, the bots with
/// their light trails, their speech bubbles, and the name.
struct OpeningView: View {
    let bots: [OpeningBots.Look]
    let done: () -> Void
    /// A fixed moment to draw (seconds), for stills; nil plays it.
    var frozenAt: Double? = nil
    @Local private var began = Date()

    static let face: CGFloat = 96

    var body: some View {
        TimelineView(.animation(paused: frozenAt != nil)) { tl in
            let t = frozenAt ?? tl.date.timeIntervalSince(began)
            GeometryReader { g in scene(at: t, in: g.size) }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityLabel("Alotbot")
        .task {
            guard frozenAt == nil else { return }
            try? await Task.sleep(for: .seconds(OpeningScene.duration))
            done()
        }
    }

    private func scene(at t: Double, in size: CGSize) -> some View {
        let n = bots.count
        let stage = OpeningScene.stage(at: t)
        let order = (0..<n).sorted { OpeningScene.pose($0, of: n, at: t).z > OpeningScene.pose($1, of: n, at: t).z }
        return ZStack {
            OpeningPalette.stage.opacity(stage)
            Canvas { ctx, sz in
                Motes.draw(in: &ctx, size: sz, t: t, stage: stage)
                Trails.draw(in: &ctx, size: sz, t: t, bots: bots)
            }
            ZStack {
                ForEach(order, id: \.self) { i in botView(i, of: n, at: t) }
                ForEach(0..<n, id: \.self) { i in bubble(i, of: n, at: t) }
                NameReveal(t: t).offset(y: OpeningScene.centerY)
            }
            .scaleEffect(OpeningScene.drift(at: t))
        }
        .frame(width: size.width, height: size.height)
    }

    private func botView(_ i: Int, of n: Int, at t: Double) -> some View {
        let p = OpeningScene.pose(i, of: n, at: t)
        let look = bots[i]
        let hop = OpeningScene.hop(i, of: n, at: t)
        let speaker = OpeningScene.speaker(at: t, of: n)
        let settled = t >= OpeningScene.start(of: i) + OpeningScene.flight
        // The others turn toward whoever is talking.
        let gaze = speaker.flatMap { s in s == i ? nil : GazeTarget(x: s < i ? -1 : 1, y: 0) }
        return MorphAvatar(shape: look.shape, color: look.color, state: speaker == i ? .speaking : settled ? .listening : .idle, gaze: gaze,
                           level: { 0.5 + 0.4 * abs(sin(Date().timeIntervalSinceReferenceDate * 17 + Double(i))) })
            .frame(width: Self.face, height: Self.face)
            // The talker hops up and swells a little as its line starts.
            .scaleEffect(1 + 0.12 * hop, anchor: .bottom)
            .offset(y: -18 * hop)
            .scaleEffect(p.scale)
            .blur(radius: p.blur)
            .opacity(p.opacity)
            .offset(x: p.x, y: p.y)
    }

    private func bubble(_ i: Int, of n: Int, at t: Double) -> some View {
        let b = OpeningScene.bubble(i, of: n, at: t)
        let p = OpeningScene.pose(i, of: n, at: t)
        return Text(OpeningScene.line(for: i, of: n))
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .foregroundStyle(OpeningPalette.inkText)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(BubbleShape().fill(OpeningPalette.ink))
            .shadow(color: .black.opacity(0.35), radius: 10, y: 5)
            .fixedSize()
            .scaleEffect(0.55 + 0.45 * Self.springy(b), anchor: .bottom)
            .opacity(b)
            .offset(x: p.x, y: p.y - (Double(Self.face) * 0.5 + 18 * OpeningScene.hop(i, of: n, at: t)) * p.scale - 30)
    }

    /// 0 to 1 with a small overshoot, for things that pop in.
    static func springy(_ p: Double) -> Double { p >= 1 ? 1 : 1 - pow(1 - p, 3) + sin(p * .pi) * 0.12 }
}

/// Small gray specks drifting toward you through the depth, a touch faster as the camera pushes in at the end.
private enum Motes {
    static let count = 150

    static func draw(in ctx: inout GraphicsContext, size: CGSize, t: Double, stage: Double) {
        let mid = CGPoint(x: size.width / 2, y: size.height / 2)
        let depth = 3000.0
        let travel = 260 * t + 1400 * pow(OpeningScene.exit(at: t), 2) * (OpeningScene.duration - OpeningScene.exitStart)
        for k in 0..<count {
            // Fixed pseudo-random spots, so every launch looks the same.
            let a = hash(k, 1), b = hash(k, 2), c = hash(k, 3)
            let x = (a - 0.5) * size.width * 2.2, y = (b - 0.5) * size.height * 2.2
            var z = c * depth - travel
            z = z.truncatingRemainder(dividingBy: depth); if z < 0 { z += depth }
            let s = OpeningScene.focal / (OpeningScene.focal + z)
            let px = mid.x + x * s, py = mid.y + y * s
            let near = 1 - z / depth
            let r = 0.6 + 2.2 * near
            ctx.fill(Path(ellipseIn: CGRect(x: px - r, y: py - r, width: r * 2, height: r * 2)), with: .color(OpeningPalette.ink.opacity(stage * (0.08 + 0.4 * near * near))))
        }
    }

    static func hash(_ k: Int, _ salt: Int) -> Double {
        var h = UInt64(truncatingIfNeeded: k &* 2654435761 &+ salt &* 40503)
        h ^= h >> 33; h = h &* 0xff51afd7ed558ccd; h ^= h >> 33; h = h &* 0xc4ceb9fe1a85ec53; h ^= h >> 33
        return Double(h % 100_000) / 100_000
    }
}

/// A tail behind each bot while it flies in, in the bot's own color: one smooth stroke that thins and fades toward its end.
private enum Trails {
    static let samples = 28

    static func draw(in ctx: inout GraphicsContext, size: CGSize, t: Double, bots: [OpeningBots.Look]) {
        let mid = CGPoint(x: size.width / 2, y: size.height / 2)
        let n = bots.count
        let drift = OpeningScene.drift(at: t)
        for i in 0..<n {
            // Only while flying in: no tail once it has landed.
            guard t < OpeningScene.start(of: i) + OpeningScene.flight * 0.9 else { continue }
            let tint = Palette.body(bots[i].color).color
            let pts = (0...samples).map { k -> (CGPoint, Double, Double) in
                let p = OpeningScene.pose(i, of: n, at: t - Double(k) * 0.006)
                return (CGPoint(x: mid.x + p.x * drift, y: mid.y + p.y * drift), p.scale, p.opacity)
            }
            for k in 0..<samples {
                let (a, s, o) = pts[k], (b, _, _) = pts[k + 1]
                let fade = 1 - Double(k) / Double(samples)
                guard o > 0 else { continue }
                var seg = Path()
                seg.move(to: a)
                seg.addLine(to: b)
                ctx.stroke(seg, with: .color(tint.opacity(0.75 * fade * o)),
                           style: StrokeStyle(lineWidth: max(0.5, Double(OpeningView.face) * 0.16 * s * fade), lineCap: .round))
            }
        }
    }
}

/// A rounded bubble with a small tail pointing down at the bot.
private struct BubbleShape: SwiftUI.Shape {
    func path(in r: CGRect) -> Path {
        var p = Path(roundedRect: r, cornerRadius: min(14, r.height / 2), style: .continuous)
        p.move(to: CGPoint(x: r.midX - 6, y: r.maxY - 1))
        p.addLine(to: CGPoint(x: r.midX, y: r.maxY + 7))
        p.addLine(to: CGPoint(x: r.midX + 6, y: r.maxY - 1))
        p.closeSubpath()
        return p
    }
}

/// "Alotbot", wiped in from the left behind a soft edge and rising a touch into place.
private struct NameReveal: View {
    let t: Double
    var body: some View {
        let v = OpeningScene.name(at: t)
        let out = OpeningScene.exit(at: t)
        let word = Text("Alotbot").font(.system(size: 64, weight: .bold, design: .rounded)).tracking(-0.5)
        word
            .foregroundStyle(OpeningPalette.ink)
            .fixedSize()
            .mask {
                GeometryReader { g in
                    LinearGradient(stops: [.init(color: .white, location: 0), .init(color: .white, location: 0.8), .init(color: .clear, location: 1)],
                                   startPoint: .leading, endPoint: .trailing)
                        .frame(width: g.size.width * (0.25 + 1.1 * v))
                }
            }
            .offset(y: 10 * (1 - v))
            .opacity(v > 0 ? 1 - out : 0)
            // Sinks back into the depth after the bots.
            .scaleEffect(1 - 0.55 * out)
            .blur(radius: 4 * out)
    }
}
