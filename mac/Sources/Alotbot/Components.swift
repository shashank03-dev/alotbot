import AppKit
import AlotbotCore
import SwiftUI

/// Colors and motion shared by every surface (matched to Grok Bot's call pill).
/// Colors from Grok Bot's own dark theme: a near-black chrome, slightly lighter panes, and text, fills and lines
/// made from one off-white at set strengths, so every grey belongs to the same family.
enum Theme {
    private static let base = Color(red: 0.941, green: 0.941, blue: 0.941)        // #f0f0f0
    static let chrome = Color(red: 0.078, green: 0.078, blue: 0.078)              // #141414: windows, the menu
    static let surface = Color(red: 0.094, green: 0.094, blue: 0.094)             // #181818: pill, trays, cards
    static let raised = Color(red: 0.149, green: 0.149, blue: 0.149)              // round buttons, inputs
    static let raisedHover = Color(red: 0.192, green: 0.192, blue: 0.192)
    static let fill = base.opacity(0.06)                                          // rows, quiet cards
    static let fillHover = base.opacity(0.1)
    static let hairline = base.opacity(0.08)
    static let stroke = base.opacity(0.12)
    static let text = base
    static let secondary = base.opacity(0.62)
    static let tertiary = base.opacity(0.42)
    static let accent = Color(red: 0.349, green: 0.612, blue: 0.906)              // #599ce7
    static let danger = Color(red: 0.906, green: 0.180, blue: 0.231)              // #e72e3b
    static let warn = Color(red: 0.961, green: 0.576, blue: 0.071)                // #f59312

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
}

/// Grok Bot's raised look: a faint light along the top edge (as if lit from above), a tight dark edge and a soft
/// shadow underneath. It reads as a layer above whatever is behind it, without a heavy outline.
struct Elevated<S: InsettableShape>: ViewModifier {
    let shape: S
    var fill: Color = Theme.surface
    var high = true
    func body(content: Content) -> some View {
        content
            .background(shape.fill(fill))
            .overlay(shape.strokeBorder(LinearGradient(colors: [Color.white.opacity(0.1), Color.white.opacity(0.03)], startPoint: .top, endPoint: .bottom), lineWidth: 1))
            .shadow(color: .black.opacity(0.5), radius: 1.5, y: 0.5)
            .shadow(color: .black.opacity(high ? 0.42 : 0.28), radius: high ? 22 : 10, y: high ? 14 : 6)
    }
}

extension View {
    func elevated<S: InsettableShape>(_ shape: S, fill: Color = Theme.surface, high: Bool = true) -> some View {
        modifier(Elevated(shape: shape, fill: fill, high: high))
    }
}

/// Every animation and transition, built from `MotionSpec`. Arrivals are springs (they keep their speed when
/// interrupted); departures ease in and are quicker; with Reduce Motion everything is a short crossfade.
enum Motion {
    private static var reduce: Bool { Theme.reduceMotion }
    private static var fade: Animation { .easeInOut(duration: MotionSpec.reduced) }

    static func spring(_ s: MotionSpec.Spring) -> Animation {
        reduce ? fade : .spring(duration: s.duration, bounce: s.bounce)
    }
    static var open: Animation { spring(MotionSpec.open) }
    static var close: Animation { spring(MotionSpec.close) }
    static var surface: Animation { spring(MotionSpec.surface) }
    static var layout: Animation { spring(MotionSpec.layout) }
    static var hover: Animation { spring(MotionSpec.hover) }
    static var press: Animation { spring(MotionSpec.press) }
    /// Leaving: accelerates away.
    static var exit: Animation { reduce ? fade : .timingCurve(0.4, 0, 1, 1, duration: MotionSpec.exit) }
    static var bigExit: Animation { reduce ? fade : .timingCurve(0.4, 0, 0.9, 1, duration: MotionSpec.bigExit) }
    static var crossfade: Animation { .easeInOut(duration: reduce ? MotionSpec.reduced : MotionSpec.crossfade) }
    static var glowIn: Animation { .easeOut(duration: reduce ? MotionSpec.reduced : MotionSpec.glowIn) }
    static var glowOut: Animation { .easeInOut(duration: reduce ? MotionSpec.reduced : MotionSpec.glowOut) }

    /// A face moving between the circle and the pill, in a short wave.
    static func avatar(index: Int, count: Int, opening: Bool) -> Animation {
        if reduce { return fade }
        let s = opening ? MotionSpec.avatar : MotionSpec.close
        return .spring(duration: s.duration, bounce: s.bounce).delay(MotionSpec.avatarDelay(index: index, count: count, opening: opening))
    }

    /// A face popping in as the call appears: after the pill has started to arrive, one after another.
    static func wave(index: Int) -> Animation {
        if reduce { return fade }
        return spring(MotionSpec.avatar).delay(0.06 + Double(max(0, index)) * MotionSpec.stagger)
    }

    /// A surface (tray, card, toast) arriving from the side it belongs to: it grows from 97%, drifts `lift`
    /// points into place and fades in; it leaves quicker, a little smaller, the same way. A panel replacing
    /// another starts just after the old one has mostly faded, so their contents never show through each other.
    static func surfaceTransition(anchor: UnitPoint, lift: CGFloat = 0) -> AnyTransition {
        if reduce { return .opacity.animation(fade) }
        return .asymmetric(
            insertion: .scale(scale: 0.97, anchor: anchor).combined(with: .offset(y: lift)).combined(with: .opacity)
                .animation(surface.delay(MotionSpec.swapDelay)),
            removal: .scale(scale: 0.98, anchor: anchor).combined(with: .opacity).animation(.easeOut(duration: MotionSpec.fadeOut)))
    }

    /// The pill or the full view swapping places, or the call arriving and leaving.
    static func stageTransition(anchor: UnitPoint, delay: Double = 0) -> AnyTransition {
        if reduce { return .opacity.animation(fade) }
        return .asymmetric(
            insertion: .scale(scale: 0.95, anchor: anchor).combined(with: .opacity).animation(surface.delay(delay)),
            removal: .scale(scale: 0.97, anchor: anchor).combined(with: .opacity).animation(bigExit))
    }

    /// Something small popping in (a face that joins, a count bubble), and fading out. A transition scales the
    /// whole inserted view, and a view placed with `.position` fills its parent, so `anchor` must be the
    /// view's own center in the parent's units, or it grows from the parent's middle instead (a joining face
    /// was seen rising from below the pill).
    static func pop(anchor: UnitPoint = .center) -> AnyTransition {
        if reduce { return .opacity.animation(fade) }
        return .asymmetric(insertion: .scale(scale: 0.6, anchor: anchor).combined(with: .opacity).animation(spring(MotionSpec.avatar)),
                           removal: .scale(scale: 0.85, anchor: anchor).combined(with: .opacity).animation(exit))
    }

    /// `point` inside `size`, as a transition or scale anchor.
    static func anchor(_ point: CGPoint, in size: CGSize) -> UnitPoint {
        UnitPoint(x: point.x / max(1, size.width), y: point.y / max(1, size.height))
    }

    /// Plain fade, in at `delay`, out quickly.
    static func fadeTransition(delay: Double = 0) -> AnyTransition {
        .asymmetric(insertion: .opacity.animation(crossfade.delay(reduce ? 0 : delay)), removal: .opacity.animation(exit))
    }
}

extension RGB {
    var color: Color { Color(red: r, green: g, blue: b) }
    var cg: CGColor { CGColor(red: r, green: g, blue: b, alpha: 1) }
}

/// Drives one avatar engine from SwiftUI's frame clock.
final class AvatarDriver: ObservableObject {
    let engine: MorphEngine
    var last: Date?
    /// Drawn opacity, eased toward 0.45 (connecting, quiet) or 1, so a face never blinks between the two.
    var opacity: Double?
    init(shape: String?) {
        engine = MorphEngine(shape: shape)
        engine.reduceMotion = Theme.reduceMotion
    }
}

/// A live Grok Bot avatar: shape, eyes, mood, gaze and the speaking bounce.
struct MorphAvatar: View {
    var shape: String?
    var color: String?
    var state: AvatarState = .idle
    var gaze: GazeTarget? = nil
    var level: () -> Double = { 0 }
    var dimmed = false
    @StateObject private var driver: AvatarDriver

    init(shape: String?, color: String?, state: AvatarState = .idle, gaze: GazeTarget? = nil, dimmed: Bool = false, level: @escaping () -> Double = { 0 }) {
        self.shape = shape
        self.color = color
        self.state = state
        self.gaze = gaze
        self.dimmed = dimmed
        self.level = level
        _driver = StateObject(wrappedValue: AvatarDriver(shape: shape))
    }

    var body: some View {
        TimelineView(.animation(paused: false)) { tl in
            Canvas { ctx, size in
                let e = driver.engine
                let dt = driver.last.map { tl.date.timeIntervalSince($0) } ?? 1.0 / 60
                driver.last = tl.date
                if e.shapeId != shape { e.shapeId = shape }
                e.setState(state)
                e.gaze = gaze
                e.voiceLevel = state == .speaking ? level() : 0
                e.step(dt)
                let f = e.frame()
                let target = dimmed ? 0.45 : 1
                let alpha = driver.opacity.map { $0 + (target - $0) * min(1, max(0, dt) / 0.12) } ?? target // about 0.3 s to settle
                driver.opacity = alpha
                ctx.withCGContext { cg in
                    AvatarDrawing.draw(f, in: cg, rect: CGRect(origin: .zero, size: size), body: Palette.body(color).cg, eyes: Palette.eyes(color).cg, opacity: alpha)
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// The host: initials, a photo, or their own character, as picked in Settings.
struct HostAvatar: View {
    @ObservedObject var prefs: Prefs
    var name: String
    var speaking: Bool
    var level: () -> Double

    var body: some View {
        GeometryReader { g in
            let side = min(g.size.width, g.size.height)
            Group {
                switch prefs.hostLook {
                case .initials:
                    Circle().fill(Theme.raised)
                        .overlay(Text(String(name.prefix(1)).uppercased()).font(.system(size: side * 0.44, weight: .semibold, design: .rounded)).foregroundStyle(Theme.text))
                case .photo:
                    if let p = prefs.photo {
                        Image(nsImage: p).resizable().scaledToFill().clipShape(Circle())
                    } else {
                        Circle().fill(Theme.raised).overlay(Text(String(name.prefix(1)).uppercased()).font(.system(size: side * 0.44, weight: .semibold, design: .rounded)).foregroundStyle(Theme.text))
                    }
                case .character:
                    MorphAvatar(shape: prefs.hostShape, color: prefs.hostColor, state: speaking ? .speaking : .idle, level: level)
                }
            }
            .frame(width: side, height: side)
            .scaleEffect(prefs.hostLook != .character && speaking ? 1 + 0.06 * level() : 1)
            .frame(width: g.size.width, height: g.size.height)
        }
        .accessibilityElement()
        .accessibilityLabel("You, \(name)\(speaking ? ", speaking" : "")")
    }
}

/// The round buttons in the pill (gear, chat, mic, hang up).
struct CircleButton: View {
    var symbol: String
    var label: String
    var tint: Color = Theme.raised
    var active = false
    /// Shows a spinner in place of the symbol (the button keeps its size, so the row never shifts).
    var busy = false
    var size: CGFloat = PillLayoutCG.button
    var action: () -> Void
    @Local private var hover = false
    @Local private var down = false

    var body: some View {
        Button(action: action) {
            ZStack {
                if busy {
                    ProgressView().controlSize(.small).tint(Theme.text).transition(.opacity)
                } else {
                    Image(systemName: symbol).font(.system(size: size * 0.38, weight: .medium)).transition(.opacity)
                }
            }
            .foregroundStyle(Theme.text)
            .frame(width: size, height: size)
            .background(Circle().fill(active ? Color.white.opacity(0.22) : (hover ? (tint == Theme.raised ? Theme.raisedHover : tint.opacity(0.88)) : tint)))
            .contentShape(Circle())
            .scaleEffect(down ? 0.93 : 1)
            .animation(Motion.hover, value: hover)
            .animation(Motion.hover, value: active)
            .animation(Motion.crossfade, value: busy)
        }
        .buttonStyle(PressStyle(down: $down))
        .onHover { hover = $0 }
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

struct PressStyle: ButtonStyle {
    @Binding var down: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .onChange(of: configuration.isPressed) { _, p in withAnimation(Motion.press) { down = p } }
    }
}

/// Layout numbers as CGFloat, for views.
enum PillLayoutCG {
    static let height = CGFloat(PillLayout.height)
    static let avatar = CGFloat(PillLayout.avatar)
    static let button = CGFloat(PillLayout.button)
    static let orb: CGFloat = 76
}

/// A rounded "Carina ⌄" menu, like Grok Bot's settings rows.
struct PillMenu<T: Hashable>: View {
    var title: String
    var options: [T]
    var label: (T) -> String
    var selected: T
    var onPick: (T) -> Void

    var body: some View {
        Menu {
            ForEach(options, id: \.self) { o in
                Button { onPick(o) } label: {
                    if o == selected { Label(label(o), systemImage: "checkmark") } else { Text(label(o)) }
                }
            }
        } label: {
            MenuLabel(text: label(selected))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("\(title): \(label(selected))")
    }
}

/// A dark text field that fits the pill.
struct DarkField: View {
    var placeholder: String
    @Binding var text: String
    var disabled = false
    var onSubmit: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.secondary))
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .foregroundStyle(Theme.text)
                .focused($focused)
                .onSubmit(onSubmit)
                .disabled(disabled)
            Button(action: onSubmit) {
                Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)).foregroundStyle(.black)
                    .frame(width: 26, height: 26).background(Circle().fill(text.trimmingCharacters(in: .whitespaces).isEmpty ? Color.white.opacity(0.3) : Color.white))
            }
            .buttonStyle(.plain)
            .disabled(disabled || text.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(focused ? Color.white.opacity(0.25) : Color.white.opacity(0.1), lineWidth: 1))
    }
}

/// A short label for a voice, speed or language.
enum Labels {
    static func voice(_ v: String?) -> String { v.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "Default" }
    static func speed(_ s: Double) -> String { s == s.rounded() ? "\(Int(s))x" : "\(s)x" }
    static let languages: [String: String] = [
        "en": "English", "ar-EG": "Arabic (Egypt)", "ar-SA": "Arabic (Saudi Arabia)", "ar-AE": "Arabic (UAE)", "bn": "Bengali", "ca": "Catalan",
        "zh": "Chinese (Simplified)", "da": "Danish", "nl": "Dutch", "fi": "Finnish", "fr": "French", "de": "German", "hi": "Hindi", "hu": "Hungarian",
        "id": "Indonesian", "it": "Italian", "ja": "Japanese", "ko": "Korean", "pl": "Polish", "pt-BR": "Portuguese (Brazil)", "pt-PT": "Portuguese (Portugal)",
        "ru": "Russian", "es-MX": "Spanish (Mexico)", "es-ES": "Spanish (Spain)", "sv": "Swedish", "th": "Thai", "tr": "Turkish", "vi": "Vietnamese",
    ]
    static func language(_ l: String?) -> String { l.map { languages[$0] ?? $0 } ?? "Auto-detect" }
    static func status(_ s: String) -> String {
        ["connecting": "Connecting…", "reconnecting": "Reconnecting…", "speaking": "Speaking", "thinking": "Thinking…", "listening": "Listening to you",
         "quiet": "Staying quiet", "error": "Couldn't connect"][s] ?? "Listening"
    }
}

/// "Ara ⌄" on a soft fill: what every dropdown looks like. (A borderless menu drew the arrow first and no fill.)
struct MenuLabel: View {
    let text: String
    @Local private var hover = false
    var body: some View {
        HStack(spacing: 5) {
            Text(text).foregroundStyle(Theme.text).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.tertiary)
        }
        .font(.system(size: 13))
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(hover ? Theme.fillHover : Theme.fill))
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .onHover { h in withAnimation(Motion.hover) { hover = h } }
    }
}

/// A segmented control whose selection is one pill that springs between choices. As it travels it smears a little
/// (a short blur and stretch, like motion blur) and the new choice's icon bounces. Reduce Motion: a plain crossfade.
struct SlidingSegments<Value: Hashable>: View {
    struct Item { let value: Value; let title: String; var icon: String? = nil }
    @Binding var selection: Value
    let items: [Item]
    var compact = false
    @Local private var hovered: Value?
    @Local private var bounces: [Value: Int] = [:]
    @Local private var trips = 0

    private let spacing: CGFloat = 2
    private var radius: CGFloat { compact ? 7 : 9 }
    private var index: Int { items.firstIndex { $0.value == selection } ?? 0 }

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in segment(item) }
        }
        .background(alignment: .leading) {
            GeometryReader { g in
                let width = (g.size.width - spacing * CGFloat(max(items.count - 1, 0))) / CGFloat(max(items.count, 1))
                pill.frame(width: width, height: g.size.height).offset(x: CGFloat(index) * (width + spacing))
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: radius + 3, style: .continuous).fill(Theme.fill))
        .overlay(RoundedRectangle(cornerRadius: radius + 3, style: .continuous).strokeBorder(Theme.hairline))
        .animation(Motion.spring(MotionSpec.segment), value: index)
        .accessibilityElement(children: .contain)
    }

    private func segment(_ item: Item) -> some View {
        let on = item.value == selection
        let hover = hovered == item.value && !on
        return Button { select(item.value) } label: {
            HStack(spacing: 6) {
                if let icon = item.icon {
                    Image(systemName: icon).font(.system(size: compact ? 11 : 12, weight: .medium))
                        .symbolEffect(.bounce.up, options: .speed(1.4), value: Theme.reduceMotion ? 0 : bounces[item.value, default: 0])
                }
                Text(item.title).lineLimit(1)
            }
            .font(.system(size: compact ? 12 : 13, weight: on ? .semibold : .medium))
            .foregroundStyle(on ? Theme.text : hover ? Theme.text.opacity(0.85) : Theme.secondary)
            .frame(maxWidth: .infinity).padding(.vertical, compact ? 5 : 7).padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(hover ? Theme.fill : .clear))
            .contentShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
        .buttonStyle(SegmentPress())
        .onHover { inside in withAnimation(Motion.hover) { hovered = inside ? item.value : (hovered == item.value ? nil : hovered) } }
        .animation(Motion.crossfade, value: on)
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }

    private var pill: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Theme.raisedHover)
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(LinearGradient(colors: [Color.white.opacity(0.12), Color.white.opacity(0.03)], startPoint: .top, endPoint: .bottom), lineWidth: 1))
            .shadow(color: .black.opacity(0.35), radius: 3, y: 1)
            .keyframeAnimator(initialValue: Smear(), trigger: trips) { content, smear in
                content.scaleEffect(x: 1 + smear.stretch, y: 1 - smear.stretch * 0.4).blur(radius: smear.blur)
            } keyframes: { _ in
                let reduce = Theme.reduceMotion
                KeyframeTrack(\.blur) {
                    CubicKeyframe(reduce ? 0 : MotionSpec.segmentBlur, duration: 0.08)
                    CubicKeyframe(0, duration: 0.24)
                }
                KeyframeTrack(\.stretch) {
                    CubicKeyframe(reduce ? 0 : MotionSpec.segmentStretch, duration: 0.1)
                    SpringKeyframe(0, duration: 0.36, spring: .init(duration: 0.36, bounce: 0.4))
                }
            }
            .allowsHitTesting(false)
    }

    private func select(_ value: Value) {
        guard value != selection else { return }
        trips += 1
        bounces[value, default: 0] += 1
        selection = value
    }
}

private struct Smear { var blur = 0.0; var stretch = 0.0 }

/// Segments dip slightly under the finger and spring back.
private struct SegmentPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !Theme.reduceMotion ? 0.95 : 1)
            .animation(Motion.press, value: configuration.isPressed)
    }
}
