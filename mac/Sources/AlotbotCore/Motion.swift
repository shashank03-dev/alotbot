import Foundation

/// The overlay's motion as plain numbers, so its rules can be tested. Arrivals use Apple's spring model
/// (a duration and a bounce, as in SwiftUI's `.spring(duration:bounce:)`): things you open bounce a little,
/// big panels only lightly, folding away never; leaving is quicker than arriving, and nothing flashes fast.
public enum MotionSpec {
    public struct Spring: Equatable, Sendable {
        /// How long the spring takes to look finished (SwiftUI's perceptual duration).
        public let duration: Double
        /// 0 settles without passing its mark; Apple's `.snappy` is 0.15 and `.bouncy` 0.3.
        public let bounce: Double
        public init(duration: Double, bounce: Double) {
            self.duration = duration
            self.bounce = bounce
        }
        /// The same spring as a damping ratio (SwiftUI: dampingFraction = 1 - bounce, for bounce ≥ 0).
        public var damping: Double { 1 - bounce }
    }

    /// The circle growing into the pill: a clear, friendly bounce, like the Dynamic Island opening.
    public static let open = Spring(duration: 0.5, bounce: 0.24)
    /// The pill folding back into the circle: no bounce, it tucks away.
    public static let close = Spring(duration: 0.42, bounce: 0)
    /// Faces flying between the circle and the pill, or popping in: small, so the most life.
    public static let avatar = Spring(duration: 0.5, bounce: 0.3)
    /// Trays, cards, toasts and the full view arriving: a light bounce, so big panels don't wobble.
    public static let surface = Spring(duration: 0.42, bounce: 0.16)
    /// Tiles and avatars moving to new places when a bot joins or leaves.
    public static let layout = Spring(duration: 0.5, bounce: 0.14)
    /// Hover lifts and the avatars parting around the hovered one.
    public static let hover = Spring(duration: 0.3, bounce: 0.3)
    /// A button pressed down and let go: quick, with a little spring back.
    public static let press = Spring(duration: 0.24, bounce: 0.36)
    /// The selection sliding between tabs: lively, like the Dynamic Island, and settled before you look again.
    public static let segment = Spring(duration: 0.46, bounce: 0.3)
    /// While it slides, the selection smears along its path (blur) and stretches a little, then snaps back.
    public static let segmentBlur = 3.5
    public static let segmentStretch = 0.14

    /// Trays, cards, toasts and buttons leaving (ease-in: they speed up as they go).
    public static let exit = 0.2
    /// A tray or card fading out: quick at first (ease-out), so the one replacing it never shows through.
    public static let fadeOut = 0.14
    /// A tray or card fading in waits this long, so it doesn't overlap the one it replaces.
    public static let swapDelay = 0.07
    /// The full view, or the whole call, leaving.
    public static let bigExit = 0.28
    /// The pill's buttons wait this long, so the faces flying out of the circle have crossed them first.
    public static let controlsDelay = 0.2
    /// Gap between faces in the opening wave.
    public static let stagger = 0.03
    /// A speaker's glow arrives quickly and leaves slowly, so quick turns don't flicker.
    public static let glowIn = 0.28
    public static let glowOut = 0.55
    /// One-off fades: ring modes swapping, dimming, captions.
    public static let crossfade = 0.3
    /// With Reduce Motion, every change is a plain crossfade this long.
    public static let reduced = 0.2
    /// How often the ring pulses while you talk.
    public static let strobeHz = 1.6
    /// How long the window stays up after the call's exit starts, so the exit can finish.
    public static var overlayLinger: Double { bigExit + 0.08 }

    /// A spring's overshoot when it moves from rest, as a fraction of the distance (0 when critically damped).
    public static func overshoot(_ s: Spring) -> Double {
        guard s.damping < 1 else { return 0 }
        return exp(-Double.pi * s.damping / (1 - s.damping * s.damping).squareRoot())
    }

    /// Roughly how long a spring takes to settle within 1% of its target.
    public static func settleTime(_ s: Spring) -> Double {
        let omega = 2 * Double.pi / s.duration
        return -log(0.01) / (max(0.05, min(1, s.damping)) * omega)
    }

    /// When face `index` of `count` starts moving. Opening, a left-to-right wave; folding, all at once, on the
    /// pill's own spring, so no face lags outside the shrinking pill.
    public static func avatarDelay(index: Int, count: Int, opening: Bool) -> Double {
        guard opening else { return 0 }
        return Double(max(0, min(index, max(0, count - 1)))) * stagger
    }
}
