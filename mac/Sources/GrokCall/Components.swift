import AppKit
import GrokCallCore
import SwiftUI

/// Colors and motion shared by every surface (matched to Grok Bot's call pill).
enum Theme {
    static let surface = Color(red: 0.118, green: 0.118, blue: 0.118)        // pill and trays
    static let raised = Color(red: 0.169, green: 0.169, blue: 0.169)         // round buttons
    static let raisedHover = Color(red: 0.215, green: 0.215, blue: 0.215)
    static let hairline = Color.white.opacity(0.08)
    static let text = Color.white.opacity(0.92)
    static let secondary = Color.white.opacity(0.55)
    static let danger = Color(red: 0.82, green: 0.19, blue: 0.24)
    static let accent = Color(red: 0.57, green: 0.35, blue: 1)

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    /// The bounce for the circle opening into the pill and bots popping out.
    static var bounce: Animation { reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.46, dampingFraction: 0.66) }
    static var settle: Animation { reduceMotion ? .easeInOut(duration: 0.18) : .spring(response: 0.34, dampingFraction: 0.86) }
}

extension RGB {
    var color: Color { Color(red: r, green: g, blue: b) }
    var cg: CGColor { CGColor(red: r, green: g, blue: b, alpha: 1) }
}

/// Drives one avatar engine from SwiftUI's frame clock.
final class AvatarDriver: ObservableObject {
    let engine: MorphEngine
    var last: Date?
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
                ctx.withCGContext { cg in
                    AvatarDrawing.draw(f, in: cg, rect: CGRect(origin: .zero, size: size), body: Palette.body(color).cg, eyes: Palette.eyes(color).cg, opacity: dimmed ? 0.45 : 1)
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
    var size: CGFloat = PillLayoutCG.button
    var action: () -> Void
    @Local private var hover = false
    @Local private var down = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.38, weight: .medium))
                .foregroundStyle(Theme.text)
                .frame(width: size, height: size)
                .background(Circle().fill(active ? Color.white.opacity(0.22) : (hover ? (tint == Theme.raised ? Theme.raisedHover : tint.opacity(0.88)) : tint)))
                .contentShape(Circle())
                .scaleEffect(down ? 0.92 : 1)
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
            .onChange(of: configuration.isPressed) { _, p in withAnimation(Theme.settle) { down = p } }
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
            HStack(spacing: 6) {
                Text(label(selected)).foregroundStyle(Theme.text)
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondary)
            }
            .font(.system(size: 15))
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.14), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .menuStyle(.borderlessButton)
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
         "quiet": "Staying quiet", "error": "Couldn't connect"][s] ?? "In the call"
    }
}
