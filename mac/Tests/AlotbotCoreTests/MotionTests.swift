import Testing
@testable import AlotbotCore

struct MotionTests {
    /// Opening the call bounces like Apple's springs (between .snappy and .bouncy); big panels only lightly,
    /// so they don't wobble; folding away never bounces.
    @Test func arrivalsBounceLikeApplesSprings() {
        for s in [MotionSpec.open, MotionSpec.avatar, MotionSpec.hover, MotionSpec.press, MotionSpec.segment] {
            #expect(s.bounce >= 0.15 && s.bounce <= 0.4, "\(s)")
        }
        for s in [MotionSpec.surface, MotionSpec.layout] {
            #expect(s.bounce > 0 && s.bounce < MotionSpec.open.bounce, "\(s)")
            #expect(MotionSpec.overshoot(s) < 0.02, "\(s)")
        }
        #expect(MotionSpec.close.bounce == 0 && MotionSpec.overshoot(MotionSpec.close) == 0, "folding never springs past")
        #expect(MotionSpec.overshoot(MotionSpec.open) > 0.02, "the pill visibly bounces open")
        #expect(MotionSpec.Spring(duration: 0.5, bounce: 0.3).damping == 0.7)
    }

    /// The tab selection visibly bounces, settles quickly, and its blur and stretch stay subtle so labels stay readable.
    @Test func tabSelectionBouncesButStaysCalm() {
        #expect(MotionSpec.overshoot(MotionSpec.segment) > 0.02)
        #expect(MotionSpec.overshoot(MotionSpec.segment) < 0.08)
        #expect(MotionSpec.settleTime(MotionSpec.segment) <= MotionSpec.settleTime(MotionSpec.open))
        #expect(MotionSpec.segmentBlur > 0 && MotionSpec.segmentBlur <= 4)
        #expect(MotionSpec.segmentStretch > 0 && MotionSpec.segmentStretch <= 0.2)
    }

    /// Faces are small, so they get the most life, but never so much they look loose.
    @Test func facesHaveTheMostLife() {
        #expect(MotionSpec.overshoot(MotionSpec.avatar) > MotionSpec.overshoot(MotionSpec.open))
        #expect(MotionSpec.overshoot(MotionSpec.avatar) < 0.08)
    }

    /// Leaving is quicker than arriving, and nothing takes so long it feels slow.
    @Test func exitsAreQuickerThanEntrances() {
        #expect(MotionSpec.exit < MotionSpec.settleTime(MotionSpec.surface))
        #expect(MotionSpec.bigExit < MotionSpec.settleTime(MotionSpec.open))
        #expect(MotionSpec.exit < MotionSpec.bigExit)
        for s in [MotionSpec.open, MotionSpec.close, MotionSpec.surface, MotionSpec.layout, MotionSpec.avatar] {
            #expect(MotionSpec.settleTime(s) < 0.8, "\(s)")
        }
        #expect(MotionSpec.overlayLinger > MotionSpec.bigExit, "the window stays up until the exit ends")
    }

    /// The opening wave over five faces is short; folding moves every face with the pill (a delayed face was
    /// seen lagging outside the shrinking pill); the buttons arrive while the pill is still settling.
    @Test func theOpeningWaveIsShort() {
        #expect(MotionSpec.avatarDelay(index: 0, count: 5, opening: true) == 0)
        #expect(MotionSpec.avatarDelay(index: 4, count: 5, opening: true) <= 0.15)
        for i in 0..<5 { #expect(MotionSpec.avatarDelay(index: i, count: 5, opening: false) == 0) }
        #expect(MotionSpec.avatarDelay(index: 9, count: 5, opening: true) == MotionSpec.avatarDelay(index: 4, count: 5, opening: true), "clamped")
        #expect(MotionSpec.avatarDelay(index: -1, count: 0, opening: true) == 0)
        #expect(MotionSpec.controlsDelay < MotionSpec.settleTime(MotionSpec.open) / 2)
        #expect(MotionSpec.controlsDelay > MotionSpec.avatarDelay(index: 4, count: 5, opening: true), "the faces start before the buttons")
    }

    /// Switching trays: the old panel is mostly gone before the new one starts (both texts were seen on top of
    /// each other), and the wait is too short to notice.
    @Test func swappedPanelsDontOverlap() {
        #expect(MotionSpec.swapDelay >= MotionSpec.fadeOut / 2)
        #expect(MotionSpec.swapDelay <= 0.1)
        #expect(MotionSpec.fadeOut < MotionSpec.exit)
    }

    /// Fast turns don't flicker the glow, the ring pulses well under 3 Hz, and Reduce Motion stays brief.
    @Test func noFlickerOrFastFlashing() {
        #expect(MotionSpec.glowOut > MotionSpec.glowIn)
        #expect(MotionSpec.strobeHz < 2, "the old strobe ran at about 4 Hz")
        #expect(MotionSpec.reduced <= 0.25)
    }
}
