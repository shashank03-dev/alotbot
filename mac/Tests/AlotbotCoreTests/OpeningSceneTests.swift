import Foundation
import Testing
@testable import AlotbotCore

@Suite struct OpeningSceneTests {
    typealias S = OpeningScene

    @Test func eachBotStartsFarSmallBlurredAndFaint() {
        for i in 0..<7 {
            let p = S.pose(i, of: 7, at: S.start(of: i))
            #expect(p.z == S.farZ)
            #expect(p.scale < 0.3)
            #expect(p.blur > 10)
            #expect(p.opacity == 0)
        }
    }

    @Test func eachBotSettlesSharpAndInItsPlace() {
        let settled = S.start(of: 6) + S.flight
        for i in 0..<7 {
            let p = S.pose(i, of: 7, at: settled)
            let h = S.home(i, of: 7)
            #expect(abs(p.x - h.x) < 0.001 && abs(p.y - h.y) < 0.001)
            #expect(abs(p.scale - 1) < 0.001)
            #expect(p.blur < 1e-9)
            #expect(p.opacity == 1)
        }
    }

    @Test func theyComeOutOfTheDepthOnASpiralNotAStraightLine() {
        var lastZ = Double.infinity
        var angles: [Double] = []
        let h = S.home(0, of: 4)
        for k in 0...40 {
            let t = S.start(of: 0) + S.flight * 0.7 * Double(k) / 40
            let p = S.pose(0, of: 4, at: t)
            #expect(p.z <= lastZ, "always coming closer until the settle")
            lastZ = p.z
            angles.append(atan2(p.y / p.scale - h.y, p.x / p.scale - h.x))
        }
        // Unwrapped, the angle around its place sweeps most of a turn or more: a spiral.
        var total = 0.0
        for (a, b) in zip(angles, angles.dropFirst()) { var d = b - a; if d > .pi { d -= 2 * .pi }; if d < -.pi { d += 2 * .pi }; total += abs(d) }
        #expect(total > 1.5 * .pi)
    }

    @Test func theSettleOvershootsTowardYouThenComesBack() {
        let i = 2
        let near = S.pose(i, of: 4, at: S.start(of: i) + S.flight * 0.85)
        let rest = S.pose(i, of: 4, at: S.start(of: i) + S.flight)
        #expect(near.scale > rest.scale, "a little bigger just before it lands")
    }

    @Test func botsArriveOneAfterAnotherAndLandOnABentArcThatIsNotPerfect() {
        #expect(abs(S.start(of: 1) - S.start(of: 0) - S.stagger) < 1e-9)
        for n in 1...7 {
            let hs = (0..<n).map { S.home($0, of: n) }
            #expect(zip(hs, hs.dropFirst()).allSatisfy { hypot($1.x - $0.x, $1.y - $0.y) >= 112 }, "room for a 96-point face and a gap")
            #expect(zip(hs, hs.dropFirst()).allSatisfy { $1.x > $0.x }, "left to right along the arc")
            #expect(abs(hs.map(\.x).reduce(0, +)) / Double(n) < 20, "about centered")
            #expect(hs.allSatisfy { $0.y < S.centerY - 40 }, "all over the name")
            if n >= 3 { #expect(hs[n / 2].y < hs[0].y - 60 && hs[n / 2].y < hs[n - 1].y - 60, "bent: the middle sits higher than the ends") }
            let radii = (0..<n).map { i -> Double in let h = hs[i]; return hypot(h.x, (h.y - S.centerY) / S.squash) }
            if n >= 2 { #expect(radii.max()! - radii.min()! > 5, "not a perfect curve") }
        }
    }

    @Test func theyComeInFromAllOverTheScreen() {
        let n = 7
        // Once each is visible, it is still far out on the screen, and together they come from every side.
        var sides = Set<Int>()
        for i in 0..<n {
            let p = S.pose(i, of: n, at: S.start(of: i) + S.flight * 0.13)
            #expect(p.opacity == 1)
            #expect(hypot(p.x, p.y / 0.62) > 500)
            sides.insert((p.x > 0 ? 1 : 0) + (p.y > 0 ? 2 : 0))
        }
        #expect(sides.count == 4)
    }

    @Test func theTalkerHopsAsItsLineStarts() {
        let n = 7
        for i in 0..<n {
            let at = S.saidAt(i, of: n)
            #expect(S.hop(i, of: n, at: at - 0.01) == 0)
            #expect(S.hop(i, of: n, at: at + 0.17) > 0.95)
            #expect(S.hop(i, of: n, at: at + 0.5) == 0)
        }
    }

    @Test func theyTalkOneAtATimeEachOnceAndNotLeftToRight() {
        for n in 1...7 {
            var heard: [Int] = []
            var t = S.talkStart
            while t < S.talkStart + S.line * Double(n) {
                if let s = S.speaker(at: t, of: n), heard.last != s { heard.append(s) }
                t += 0.01
            }
            #expect(heard.sorted() == Array(0..<n))
            if n >= 3 { #expect(heard != Array(0..<n)) }
            #expect(S.speaker(at: S.talkStart - 0.01, of: n) == nil)
            #expect(S.speaker(at: S.talkStart + S.line * Double(n) + 0.01, of: n) == nil)
            #expect(Set((0..<n).map { S.line(for: $0, of: n) }).count == n, "each says something different")
        }
        #expect(S.talkOrder(9).sorted() == Array(0..<9))
    }

    @Test func aBubbleShowsWhileItsBotTalksAndGoesAfter() {
        let i = 0, n = 4
        let at = S.saidAt(i, of: n)
        #expect(S.bubble(i, of: n, at: at - 0.05) == 0)
        #expect(S.bubble(i, of: n, at: at + 0.3) == 1)
        #expect(S.bubble(i, of: n, at: at + S.line + 0.5) == 0)
    }

    @Test func theNameIsRevealedLeftToRight() {
        #expect(S.name(at: S.nameStart) == 0)
        #expect(S.name(at: S.nameStart + S.nameTime) == 1)
        var last = -1.0
        for k in 0...20 {
            let v = S.name(at: S.nameStart + S.nameTime * Double(k) / 20)
            #expect(v >= last)
            last = v
        }
    }

    @Test func theyLeaveOneAfterAnotherIntoTheMiddleOfTheScreenAndTheDepth() {
        let n = 7
        #expect(S.exitStart >= S.talkStart + S.line * Double(n) - 1e-9, "every line is said first")
        for i in 0..<n {
            let go = S.leaves(i)
            if i > 0 { #expect(abs(go - S.leaves(i - 1) - S.leaveStagger) < 1e-9, "one after another") }
            #expect(S.pose(i, of: n, at: go) == S.pose(i, of: n, at: go - 0.05), "still in place until it sets off")
            let half = S.pose(i, of: n, at: go + S.leaveTime / 2), gone = S.pose(i, of: n, at: go + S.leaveTime)
            let h = S.home(i, of: n)
            #expect(hypot(half.x, half.y) < hypot(h.x, h.y), "heading to the middle")
            #expect(abs(gone.x) < 1e-9 && abs(gone.y) < 1e-9, "ends in the middle of the screen")
            #expect(gone.scale < 0.35 && gone.blur > 10 && gone.opacity == 0, "small, soft and gone: back in the depth")
            // Eased: slow to set off and slow to arrive, fastest in between.
            let step = 0.02
            func moved(_ a: Double) -> Double {
                let p = S.pose(i, of: n, at: go + a), q = S.pose(i, of: n, at: go + a + step)
                return hypot(q.x - p.x, q.y - p.y) + abs(q.z - p.z)
            }
            #expect(moved(0) < moved(S.leaveTime / 2 - step / 2) / 4)
            #expect(moved(S.leaveTime - step) < moved(S.leaveTime / 2 - step / 2) / 4)
        }
    }

    @Test func theNameAndStageSinkAwayLastAndAllIsGoneAtTheEnd() {
        #expect(S.nameOut > S.leaves(6) && S.nameOut + S.nameOutTime <= S.duration + 1e-9)
        #expect(S.exit(at: S.nameOut) == 0 && S.exit(at: S.duration) == 1)
        #expect(S.stage(at: 0) == 0 && S.stage(at: 1) == 1 && S.stage(at: S.duration) == 0)
        for i in 0..<7 { #expect(S.pose(i, of: 7, at: S.duration).opacity == 0) }
        #expect(S.bubble(0, of: 7, at: S.exitStart + 0.2) == 0, "bubbles are gone before anyone leaves far")
        #expect(S.drift(at: 0) == 1 && S.drift(at: S.exitStart) > 1)
    }

    @Test func nothingEverComesPastTheCamera() {
        for k in 0...200 {
            let t = S.duration * Double(k) / 200
            for i in 0..<7 { #expect(S.focal + S.pose(i, of: 7, at: t).z > 100) }
        }
    }
}
