import Foundation

/// An sRGB color as 0...1 components.
public struct RGB: Equatable, Sendable {
    public var r: Double, g: Double, b: Double
    public init(_ r: Double, _ g: Double, _ b: Double) { self.r = r; self.g = g; self.b = b }

    /// "#RRGGBB" or "#RGB".
    public init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(Double(v >> 16 & 255) / 255, Double(v >> 8 & 255) / 255, Double(v & 255) / 255)
    }

    public func mix(_ o: RGB, _ t: Double) -> RGB { RGB(r + (o.r - r) * t, g + (o.g - g) * t, b + (o.b - b) * t) }
    public static let gray = RGB(0.47, 0.47, 0.47)
}

public enum Palette {
    /// Grok Bot's avatar colors (also sent by the backend in `choices.colors`).
    public static let grok: [String: String] = [
        "black": "#000000", "brown": "#936439", "red": "#FF263C", "orange": "#FF6700", "yellow": "#FF9800", "green": "#00C972",
        "cyan": "#00BCA6", "blue": "#1084FE", "violet": "#9159FE", "magenta": "#FF309B", "gray": "#777777",
    ]

    /// A bot's body color. Black would vanish on the dark pill, so it draws as a light gray there.
    public static func body(_ name: String?, onDark: Bool = true) -> RGB {
        if name == "black" && onDark { return RGB(0.86, 0.86, 0.88) }
        return name.flatMap { grok[$0] }.flatMap(RGB.init(hex:)) ?? .gray
    }

    /// Eye color that reads on the body.
    public static func eyes(_ name: String?, onDark: Bool = true) -> RGB {
        name == "black" && onDark ? RGB(0.07, 0.07, 0.07) : RGB(1, 1, 1)
    }

    /// The ring around the collapsed circle: one color per bot (in call order), evenly spaced and
    /// closed back to the first. With no bots it is neutral gray.
    public static func ringStops(_ colors: [String?]) -> [RGB] {
        let c = colors.map { body($0) }
        guard let first = c.first else { return [.gray, .gray] }
        return c + [first]
    }
}

public enum Names {
    /// Initials as the web app makes them: "Shashank's X bot" -> "SX", "My Bot" -> "MB", "Eve" -> "EV".
    public static func initials(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "['’]s\\b", with: "", options: .regularExpression)
        let words = cleaned.split(whereSeparator: \.isWhitespace).map(String.init)
        guard words.count >= 2 else { return String(name.prefix(2)).uppercased() }
        let last = words.count > 2 && words.last!.range(of: "^bots?$", options: [.regularExpression, .caseInsensitive]) != nil ? words.count - 2 : words.count - 1
        return (String(words[0].prefix(1)) + String(words[last].prefix(1))).uppercased()
    }
}

/// Where everything sits in the expanded pill.
public struct PillLayout: Equatable {
    public static let maxShown = 5
    public static let height = 88.0
    public static let avatar = 44.0
    public static let spacing = 10.0
    public static let button = 56.0
    public static let buttonGap = 12.0
    public static let padding = 18.0
    public static let buttons = 5 // add, chat, gear, mic, hang up

    /// Bots drawn as avatars (call order) and how many fold into the +N bubble. When every bot is shown
    /// (`expandedOverflow`) and there are more than `maxShown`, the bubble stays at the end as "−" to fold them back.
    public let shown: [String]
    public let overflow: Int
    /// Center x of the host avatar, then of each shown bot, then of the +N bubble (if any).
    public let hostX: Double
    public let botX: [Double]
    public let overflowX: Double?
    public let width: Double

    public init(botIds: [String], expandedOverflow: Bool = false) {
        let limit = expandedOverflow ? botIds.count : Self.maxShown
        shown = Array(botIds.prefix(limit))
        overflow = max(0, botIds.count - shown.count)
        var x = Self.padding + Self.avatar / 2
        hostX = x
        var xs: [Double] = []
        for _ in shown { x += Self.avatar + Self.spacing; xs.append(x) }
        botX = xs
        if overflow > 0 || (expandedOverflow && botIds.count > Self.maxShown) { x += Self.avatar + Self.spacing; overflowX = x } else { overflowX = nil }
        let avatarsEnd = x + Self.avatar / 2
        width = avatarsEnd + 26 + Double(Self.buttons) * Self.button + Double(Self.buttons - 1) * Self.buttonGap + Self.padding
    }

    /// Center x of a participant ("host" or a bot id); bots folded into +N sit at the bubble.
    public func x(of who: String) -> Double? {
        if who == "host" { return hostX }
        if let i = shown.firstIndex(of: who) { return botX[i] }
        return overflowX
    }

    /// Where a bot at `from` should look to see `target` ("host" or a bot id). Nil looks ahead.
    public func gaze(from botId: String, to target: String?) -> GazeTarget? {
        guard let target, let a = x(of: botId), let b = x(of: target), a != b else {
            // Looking at the host from the host's own spot can't happen; looking at yourself means ahead.
            return target == "host" ? GazeTarget(x: -1, y: 0.2) : nil
        }
        return GazeTarget(x: b < a ? -1 : 1, y: 0.15)
    }
}

/// The avatar mood for a bot's call status.
public func avatarState(for status: String) -> AvatarState {
    switch status {
    case "speaking": return .speaking
    case "thinking": return .thinking
    case "listening": return .listening
    default: return .idle
    }
}

/// What the ring around the collapsed circle does.
public enum RingMode: Equatable { case rest, spin, strobe }

public func ringMode(_ v: CallView?) -> RingMode {
    guard let v else { return .rest }
    if v.userSpeaking && !v.muted { return .strobe }
    return v.bots.contains { $0.status == "speaking" || $0.status == "thinking" } ? .spin : .rest
}

/// Tasks grouped the way the menu bar view shows them.
public struct TaskGroup: Equatable, Identifiable {
    /// The owner's name, or nil for tasks nobody owns.
    public let owner: String?
    /// Top-level tasks of this owner, each with its parts (parts may belong to other owners).
    public let items: [TaskRow]
    public var id: String { owner ?? "\u{0}nobody" }
}

public struct TaskRow: Equatable, Identifiable {
    public let task: TaskItem
    public let parts: [TaskItem]
    public var id: Int { task.id }
}

public enum TaskSort {
    /// Groups top-level tasks by owner: the host first, then bots by name, then unowned. Parts stay under
    /// their parent. With `openOnly`, done tasks (and parents whose parts are all done) are left out.
    public static func groups(_ tasks: [TaskItem], host: String, openOnly: Bool) -> [TaskGroup] {
        let keep = { (t: TaskItem) in !openOnly || t.status != "done" }
        let tops = tasks.filter { $0.parent == nil && keep($0) }
        let owners = Array(Set(tops.map(\.owner))).sorted { a, b in
            func rank(_ o: String?) -> (Int, String) { o == host ? (0, "") : o == nil ? (2, "") : (1, o!.lowercased()) }
            return rank(a) < rank(b)
        }
        return owners.map { o in
            TaskGroup(owner: o, items: tops.filter { $0.owner == o }.map { t in TaskRow(task: t, parts: tasks.filter { $0.parent == t.id && keep($0) }) })
        }
    }

    /// One bot's own tasks for its card: open and doing first (by id), then done.
    public static func forBot(_ tasks: [TaskItem], name: String) -> [TaskItem] {
        let mine = tasks.filter { $0.owner == name }
        return mine.filter { $0.status != "done" }.sorted { ($0.status == "doing" ? 0 : 1, $0.id) < ($1.status == "doing" ? 0 : 1, $1.id) } + mine.filter { $0.status == "done" }
    }
}

/// Backend clock → this Mac's clock. `offset` = local seconds − backend seconds, measured at hello.
public struct ClockMap: Equatable, Sendable {
    public let offset: Double
    public init(localAtHello: Double, serverAtHello: Double) { offset = localAtHello - serverAtHello }
    public func local(_ server: Double) -> Double { server + offset }
}
