import AppKit
import GrokCallCore
import SwiftUI

/// The launch animation: the icon's four tiles come alive, turn into your own bots, and the name slides in.
/// Plays once per launch, skipped with Reduce Motion. It never takes clicks.
@MainActor enum Opening {
    private static var panel: NSPanel?

    static func show(then next: @escaping () -> Void) {
        guard !Theme.reduceMotion, panel == nil, let screen = NSScreen.main else { next(); return }
        // The whole screen, see-through and click-through, so the closing zoom can fly past the edges.
        let p = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        p.isReleasedWhenClosed = false
        p.ignoresMouseEvents = true
        p.contentView = NSHostingView(rootView: OpeningView(bots: OpeningBots.load()) {
            panel?.orderOut(nil)
            panel = nil
            next()
        })
        panel = p
        p.orderFrontRegardless()
    }
}

/// The last bots you had, so the opening can turn into them before the backend has started.
enum OpeningBots {
    static let key = "openingBots"
    /// The icon's tiles, in order, and what they turn into when no bots are known yet.
    static let tiles = ["violet", "cyan", "orange", "magenta"]
    static let fallback: [Look] = [Look(shape: "blob", color: "violet"), Look(shape: "gem", color: "cyan"), Look(shape: "cloud", color: "orange"), Look(shape: "heart", color: "magenta")]

    struct Look: Equatable { var shape: String?; var color: String? }

    static func save(_ bots: [Bot], defaults: UserDefaults = .standard) {
        guard !bots.isEmpty else { return }
        defaults.set(bots.prefix(4).map { ["shape": $0.shape ?? "", "color": $0.color ?? ""] }, forKey: key)
    }

    /// Always four: your bots first, then the defaults.
    static func load(defaults: UserDefaults = .standard) -> [Look] {
        let saved = (defaults.array(forKey: key) as? [[String: String]] ?? []).prefix(4).map {
            Look(shape: $0["shape"].flatMap { $0.isEmpty ? nil : $0 }, color: $0["color"].flatMap { $0.isEmpty ? nil : $0 })
        }
        return Array(saved) + fallback.dropFirst(saved.count)
    }
}

/// "The call connects": the app's collapsed circle appears with its spinning color ring, stretches into the
/// call pill, the icon's four tiles hop out and turn into your bots, and the name is wiped in. It ends by
/// folding back into the circle.
struct OpeningView: View {
    let bots: [OpeningBots.Look]
    let done: () -> Void
    @Local private var circle = false
    @Local private var open = false
    @Local private var content = false
    @Local private var faces = 0
    @Local private var morphed = 0
    @Local private var landed = 0
    @Local private var speaking: Int?
    @Local private var said: [Date?] = [nil, nil, nil, nil]
    @Local private var leaving = false

    static let size = CGSize(width: 580, height: 300)
    private static let pill = CGSize(width: 452, height: 104)
    private static let dot: CGFloat = 84
    static let face: CGFloat = 42
    static let faceGap: CGFloat = 8
    static let gap: CGFloat = 18
    /// How far each face starts from its place: all four hop out of the pill's middle.
    private static var launch: [CGFloat] { (0..<4).map { -Wordmark.faceX($0) } }

    private var ring: [Color] { Palette.ringStops(bots.map(\.color)).map(\.color) }

    var body: some View {
        let w = open ? Self.pill.width : Self.dot, h = open ? Self.pill.height : Self.dot
        ZStack {
            // Color light under the shape, from the same ring.
            SpinningRing(colors: ring, width: 10).frame(width: w, height: h).blur(radius: 22).opacity(0.55)
            Capsule()
                .fill(LinearGradient(colors: [Color(red: 0.12, green: 0.12, blue: 0.14), Color(red: 0.05, green: 0.05, blue: 0.06)], startPoint: .top, endPoint: .bottom))
                .overlay(Capsule().strokeBorder(LinearGradient(colors: [.white.opacity(0.14), .clear], startPoint: .top, endPoint: .center), lineWidth: 1).padding(3))
                .frame(width: w, height: h)
                .shadow(color: .black.opacity(0.55), radius: 26, y: 14)
            SpinningRing(colors: ring, width: 2.5).frame(width: w, height: h)
            HStack(spacing: Self.gap) {
                HStack(spacing: Self.faceGap) { ForEach(0..<4, id: \.self) { face($0) } }
                Wordmark(landed: landed, tints: bots.map { Palette.body($0.color) })
            }
            .opacity(content ? 1 : 0)
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .scaleEffect(leaving ? 4.5 : circle ? 1 : 0.2)
        .blur(radius: leaving ? 18 : 0)
        .opacity(leaving ? 0 : circle ? 1 : 0)
        .task { await run() }
        .accessibilityLabel("Grok Call")
    }

    private func face(_ i: Int) -> some View {
        let look = morphed > i ? bots[i] : OpeningBots.Look(shape: "squircle", color: OpeningBots.tiles[i])
        return MorphAvatar(shape: look.shape, color: look.color, state: speaking == i ? .speaking : morphed > i ? .listening : .idle,
                           gaze: landed > 0 && speaking != i ? GazeTarget(x: 1, y: 0) : nil,
                           level: { 0.55 + 0.35 * sin(Date().timeIntervalSinceReferenceDate * 22) })
            .frame(width: Self.face, height: Self.face)
            .background(SpeechRipple(color: Palette.body(look.color).color, at: said[i]))
            .scaleEffect(faces > i ? 1 : 0.05)
            .offset(x: faces > i ? 0 : Self.launch[i])
            .opacity(faces > i ? 1 : 0)
    }

    @MainActor private func run() async {
        withAnimation(.spring(response: 0.5, dampingFraction: 0.6)) { circle = true }
        await pause(0.6)
        withAnimation(.spring(response: 0.6, dampingFraction: 0.74)) { open = true }
        await pause(0.2)
        withAnimation(.easeOut(duration: 0.2)) { content = true }
        for i in 0..<4 {
            withAnimation(.spring(response: 0.48, dampingFraction: 0.56)) { faces = i + 1 }
            await pause(0.06)
        }
        await pause(0.4)
        // Each tile's shape springs into its bot (the avatar engine does the morph).
        for i in 0..<4 {
            morphed = i + 1
            await pause(0.1)
        }
        await pause(0.2)
        // Each bot says its part of the name; the letters fly out of it.
        for i in Wordmark.letters.indices {
            let bot = Wordmark.speaker[i]
            if bot != speaking { speaking = bot; await pause(0.05) }
            if Wordmark.letters[i] != " " { said[bot] = Date() }
            withAnimation(.spring(response: 0.8, dampingFraction: 0.7)) { landed = i + 1 }
            await pause(0.12)
        }
        await pause(0.4)
        speaking = nil
        await pause(1.2)
        finish()
    }

    /// Zooms out of the screen toward you and is gone.
    @MainActor private func finish() {
        withAnimation(.easeIn(duration: 0.5)) { leaving = true }
        Task { await pause(0.55); done() }
    }

    private func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
}

/// The app's color ring: one color per bot, turning, on whatever capsule it is given.
private struct SpinningRing: View {
    var colors: [Color]
    var width: CGFloat
    var body: some View {
        TimelineView(.animation) { tl in
            let a = tl.date.timeIntervalSinceReferenceDate * 150
            Capsule().strokeBorder(AngularGradient(colors: colors, center: .center, angle: .degrees(a)), lineWidth: width)
        }
        .allowsHitTesting(false)
    }
}

/// A ring that pushes out of a bot each time it says a letter.
private struct SpeechRipple: View {
    var color: Color
    var at: Date?
    var body: some View {
        TimelineView(.animation(paused: at == nil)) { tl in
            let p = at.map { tl.date.timeIntervalSince($0) / 0.55 } ?? 1
            Circle()
                .stroke(color, lineWidth: 2)
                .scaleEffect(1 + 0.9 * min(1, max(0, p)))
                .opacity(p < 1 ? 0.9 * (1 - p) : 0)
        }
        .allowsHitTesting(false)
    }
}

/// "Grok Call" in Helvetica Neue. Each letter flies out of the bot that says it, in a small arc, and lands.
private struct Wordmark: View {
    static let letters = Array("Grok Call")
    /// Which bot says each letter: "Gr", "ok", "Ca", "ll" (the space goes with the third).
    static let speaker = [0, 0, 1, 1, 2, 2, 2, 3, 3]
    static let font = NSFont(name: "HelveticaNeue-Bold", size: 38) ?? .boldSystemFont(ofSize: 38)
    static let tracking: CGFloat = -1.2
    static let widths = letters.map { NSAttributedString(string: String($0), attributes: [.font: font]).size().width }
    static let textWidth = widths.reduce(0, +) + tracking * CGFloat(letters.count - 1)
    private static let facesWidth = 4 * OpeningView.face + 3 * OpeningView.faceGap
    private static let left = -(facesWidth + OpeningView.gap + textWidth) / 2

    /// Centers, measured from the middle of the row, worked out from the font so nothing has to be measured on screen.
    static func faceX(_ i: Int) -> CGFloat { left + OpeningView.face / 2 + CGFloat(i) * (OpeningView.face + OpeningView.faceGap) }
    static func letterX(_ i: Int) -> CGFloat {
        left + facesWidth + OpeningView.gap + widths[..<i].reduce(0, +) + tracking * CGFloat(i) + widths[i] / 2
    }

    var landed: Int
    var tints: [RGB]

    var body: some View {
        HStack(spacing: Self.tracking) {
            ForEach(Self.letters.indices, id: \.self) { i in
                Text(String(Self.letters[i]))
                    .font(Font(Self.font))
                    .foregroundStyle(LinearGradient(colors: [.white, Color(white: 0.74)], startPoint: .top, endPoint: .bottom))
                    .fixedSize()
                    .frame(width: Self.widths[i])
                    .modifier(Fly(progress: landed > i ? 1 : 0, from: CGSize(width: Self.faceX(Self.speaker[i]) - Self.letterX(i), height: 4), tint: tints[Self.speaker[i]]))
                    .opacity(landed > i ? 1 : 0)
            }
        }
        .fixedSize()
    }
}

/// Moves a letter from `from` to its place along an arc, growing and untwisting as it goes.
private struct Fly: ViewModifier, Animatable {
    var progress: CGFloat
    var from: CGSize
    var tint: RGB
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }
    func body(content: Content) -> some View {
        let p = progress, q = 1 - progress
        let c = tint.mix(RGB(1, 1, 1), Double(min(1, p * 1.4)))
        content
            .colorMultiply(c.color)
            .scaleEffect(0.15 + 0.85 * p)
            .rotationEffect(.degrees(-50 * q))
            .offset(x: from.width * q, y: from.height * q - 36 * 4 * p * q)
    }
}
