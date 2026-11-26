import Foundation

/// The launch animation's motion, as plain numbers for any moment `t` (seconds from the start), so the view only draws
/// and the timing can be tested without a screen.
///
/// The bots start far back in depth, spread across the whole screen, and spiral in toward you, each a beat after the
/// one before, landing with a small overshoot on a round arc over the name, each a little off the perfect curve. They
/// take turns talking (the talker hops) and the name comes in under them. Then, one after another, each bot glides to
/// the middle of the screen and sinks back into the depth, and the name sinks after them.
public enum OpeningScene {
    /// Seconds the whole opening takes.
    public static let duration = 5.2
    /// Where the bots start, in points behind the screen.
    public static let farZ = 2600.0
    /// Focal length of the projection: a bot `focal` points back is drawn at half size.
    public static let focal = 900.0
    /// Seconds each bot takes to spiral in, and the beat between bots.
    public static let flight = 1.45
    public static let stagger = 0.08
    public static let firstStart = 0.3
    /// Turns each bot makes around its place on the way in, and how far out on the screen (points) the spiral starts.
    public static let turns = 1.25
    public static let reach = 950.0
    /// The middle of the arc (and where the name sits), below the screen's middle.
    public static let centerY = 60.0
    /// The circle the arc is part of: its radius, and how much flatter it is than wide.
    public static let radius = 280.0
    public static let squash = 1.0
    /// How much of a half circle the arc covers: all of it, so its ends come down beside the name.
    public static let arc = 1.0
    /// When the bots start talking, and how long each line lasts.
    public static let talkStart = 2.0
    public static let line = 0.25
    /// When the name starts to appear, and how long it takes.
    public static let nameStart = 2.85
    public static let nameTime = 0.55
    /// When the first bot starts leaving, the beat between bots leaving, and how long each takes.
    public static let exitStart = 3.75
    public static let leaveStagger = 0.09
    public static let leaveTime = 0.7
    /// When the name starts sinking back (after the last of up to seven bots has set off), and how long it takes.
    public static let nameOut = exitStart + 6 * leaveStagger + 0.25
    public static let nameOutTime = 0.6
    /// How far back a leaving bot sinks.
    public static let leaveZ = 2200.0

    /// A bot at one moment: offset from the middle of the screen (points), size factor, blur radius and opacity.
    public struct Pose: Equatable, Sendable {
        public var x: Double
        public var y: Double
        public var z: Double
        public var scale: Double
        public var blur: Double
        public var opacity: Double
    }

    /// Bot `i` of `n` on the circle: its angle (screen y grows down, so -π/2 is straight up) for a spread of `span`.
    static func angle(_ i: Int, of n: Int, span: Double) -> Double {
        -.pi / 2 + (Double(i) - Double(n - 1) / 2) * span / Double(n)
    }

    /// Each bot's own small miss from the perfect curve (radius, then angle), fixed so every launch looks the same.
    static func wobble(_ i: Int) -> (r: Double, a: Double) {
        ([8.0, -10, 5, -7, 10, -4, 7][i % 7], [0.01, -0.006, 0.01, -0.008, 0.005, -0.01, 0.007][i % 7])
    }

    /// Where bot `i` of `n` lands: on the round arc over the name.
    public static func home(_ i: Int, of n: Int) -> (x: Double, y: Double) {
        let w = wobble(i)
        let a = angle(i, of: n, span: arc * .pi) + w.a
        let r = radius + w.r
        return (r * cos(a), centerY + r * squash * sin(a))
    }

    public static func start(of i: Int) -> Double { firstStart + Double(i) * stagger }

    /// When bot `i` sets off to leave.
    public static func leaves(_ i: Int) -> Double { exitStart + Double(i) * leaveStagger }

    /// How far bot `i` is on its way out (0 in place ... 1 gone), eased in and out.
    public static func leaving(_ i: Int, at t: Double) -> Double { easeInOut(clamp((t - leaves(i)) / leaveTime)) }

    /// Bot `i` of `n` at time `t`.
    public static func pose(_ i: Int, of n: Int, at t: Double) -> Pose {
        let h = home(i, of: n)
        let p = clamp((t - start(of: i)) / flight)
        // Out of the depth fast, then easing into place with a small overshoot toward you.
        let e = easeOutCubic(p)
        let remaining = 1 - e
        var z = farZ * pow(remaining, 1.15) - overshoot(p) * 60
        // The spiral is measured on the screen, so it starts out at the screen's edges however far back the bot is.
        // Each bot starts three sevenths of a turn round from the one before, so neighbors come in from far apart.
        let swirl = Double(i) * 6 * .pi / 7 + remaining * turns * 2 * .pi
        let swirlR = reach * pow(remaining, 0.9)
        var sx = swirlR * cos(swirl), sy = swirlR * 0.62 * sin(swirl)
        var x = h.x, y = h.y
        // Leaving: glide to the middle of the screen while sinking back into the depth.
        let u = leaving(i, at: t)
        if u > 0 {
            x *= 1 - u
            y *= 1 - u
            z += leaveZ * u
            sx = 0
            sy = 0
        }
        let s = focal / (focal + z)
        let blur = min(18, max(0, z) / 140)
        let fadeIn = clamp(p * 8)
        let fadeOut = 1 - clamp((u - 0.45) / 0.55)
        return Pose(x: x * s + sx, y: y * s + sy, z: z, scale: s, blur: blur, opacity: fadeIn * fadeOut)
    }

    /// The bot talking at `t`, or nil. Each bot says one line, in a lively (not left-to-right) order.
    public static func speaker(at t: Double, of n: Int) -> Int? {
        let k = Int(floor((t - talkStart) / line))
        guard t >= talkStart, k < n else { return nil }
        return talkOrder(n)[k]
    }

    /// When bot `i` starts its line.
    public static func saidAt(_ i: Int, of n: Int) -> Double {
        talkStart + Double(talkOrder(n).firstIndex(of: i) ?? 0) * line
    }

    /// Who speaks in which turn: hopping around the arc, so it sounds like a conversation, not a roll call.
    public static func talkOrder(_ n: Int) -> [Int] {
        let order = [3, 1, 5, 0, 4, 2, 6]
        return order.filter { $0 < n } + (order.count..<max(order.count, n)).map { $0 }
    }

    /// What each bot says, in order of speaking.
    public static let lines = ["hey!", "you're back", "missed you", "let's talk", "hi there", "what's new?", "ready?"]

    public static func line(for i: Int, of n: Int) -> String {
        lines[(talkOrder(n).firstIndex(of: i) ?? 0) % lines.count]
    }

    /// How far a bot's speech bubble is out (0 gone, 1 fully shown) at `t`. Bubbles go as the bots start leaving.
    public static func bubble(_ i: Int, of n: Int, at t: Double) -> Double {
        let d = t - saidAt(i, of: n)
        guard d >= 0 else { return 0 }
        let inP = min(1, d / 0.16), out = 1 - clamp((d - line - 0.18) / 0.22)
        return min(inP, out) * (1 - clamp((t - exitStart) / 0.2))
    }

    /// The talker's hop as its line starts: 0 at rest, up to 1 at the top, back to 0.
    public static func hop(_ i: Int, of n: Int, at t: Double) -> Double {
        let d = (t - saidAt(i, of: n)) / 0.34
        return d > 0 && d < 1 ? sin(d * .pi) : 0
    }

    /// How much of the name is revealed (0...1), left to right.
    public static func name(at t: Double) -> Double { easeOutCubic(clamp((t - nameStart) / nameTime)) }

    /// The name and the stage sinking away at the end (0 there ... 1 gone), eased in and out.
    public static func exit(at t: Double) -> Double { easeInOut(clamp((t - nameOut) / nameOutTime)) }

    /// How much of the stage (the black behind everything) is up.
    public static func stage(at t: Double) -> Double { easeOutCubic(clamp(t / 0.45)) * (1 - exit(at: t)) }

    /// A slow camera drift: a tiny push in until the bots start leaving.
    public static func drift(at t: Double) -> Double { 1 + 0.035 * easeInOut(clamp(t / exitStart)) }

    static func clamp(_ v: Double) -> Double { min(1, max(0, v)) }
    static func easeOutCubic(_ p: Double) -> Double { 1 - pow(1 - p, 3) }
    static func easeInOut(_ p: Double) -> Double { p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2 }
    /// A small bump near the end of the flight (0 at the start and at rest): the settle's overshoot.
    static func overshoot(_ p: Double) -> Double { p <= 0.7 ? 0 : sin((p - 0.7) / 0.3 * .pi) }
}
