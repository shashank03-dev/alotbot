import CoreGraphics
import Foundation

/// A damped spring (same integration as the web version).
public struct Spring: Sendable {
    public var x: Double, v: Double = 0, target: Double
    public init(_ value: Double) { x = value; target = value }

    public mutating func step(_ frequency: Double, _ damping: Double, _ dt: Double) {
        v += (-2 * damping * frequency * v - frequency * frequency * (x - target)) * dt
        x += v * dt
        if !x.isFinite || !v.isFinite { x = target; v = 0 }
    }
}

/// Small seedable random source, so tests are repeatable.
public struct SplitMix: RandomNumberGenerator, Sendable {
    var state: UInt64
    public init(seed: UInt64) { state = seed }
    public mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Where an avatar should look: straight ahead (nil) or toward a point, as a horizontal and
/// vertical direction in -1...1 (left/up negative).
public struct GazeTarget: Equatable, Sendable {
    public var x: Double, y: Double
    public init(x: Double, y: Double) { self.x = clamp(x, -1, 1); self.y = clamp(y, -1, 1) }
}

/// Everything needed to draw one frame, in the 228.5-unit avatar space.
public struct MorphFrame {
    public let head: CGPath
    /// Applied to the head and eyes together.
    public let transform: CGAffineTransform
    /// Eye shapes already placed (in head space, before `transform`). Empty while blinking shut is not a thing: eyes always draw.
    public let eyes: [CGPath]
    /// The avatar's drawing box: draw `viewBox` scaled to fit the view.
    public static let viewBox = CGRect(x: -15, y: -15, width: 259, height: 259)
}

/// The Grok Bot avatar: body shape, eyes, blinks, moods and gaze. Call `step` each frame, then `frame`.
public final class MorphEngine {
    public private(set) var state: AvatarState = .idle
    public var shapeId: String? { didSet { if shapeId != oldValue { beginShapeChange(from: oldValue) } } }
    /// 0...1 loudness of this bot's voice while it speaks (drives the speaking bounce).
    public var voiceLevel: Double = 0
    public var gaze: GazeTarget?
    public var reduceMotion = false

    let data: MorphData
    var rng: SplitMix
    /// Milliseconds of simulated time.
    public private(set) var now: Double = 0
    var stateStartedAt: Double = 0
    var startedAt: Double = 0

    var expressionFrom: [Ring]
    var expressionTo: [Ring]
    var expressionIndex = 0
    var expressionSpring = Spring(1)
    var expressionFrequency = 7.0
    var rotation = Spring(0), headX = Spring(0), headY = Spring(0), scaleY = Spring(1)
    var eyeOpen = Spring(1), eyeScale = Spring(1), aimX = Spring(0), aimY = Spring(0), shapeBlend = Spring(1)
    var expressionCursor = 0
    var expressionNext: Double = 0
    var blinkNext: Double = 0
    var gazeNext: Double = 0
    var blinkQueue: [(at: Double, value: Double)] = []
    var blinkTarget: Double?
    var listenNodUntil: Double = 0
    var listenNodNext: Double = 0
    var winkAt: Double = -.infinity
    var winkEye = 0
    var winkNext: Double = 0
    var shapeFromRing: Ring
    var shapeFromFace: Face
    var shapeFromTilt: Double
    var lastDelta: Double = 1.0 / 60

    public init(shape: String? = nil, data: MorphData = .shared, seed: UInt64 = UInt64.random(in: 0...UInt64.max)) {
        self.data = data
        rng = SplitMix(seed: seed)
        let s = data.shape(shape)
        shapeId = shape
        shapeFromRing = s.ring
        shapeFromFace = s.face
        shapeFromTilt = s.tiltScale
        expressionFrom = data.expressions[0]
        expressionTo = data.expressions[0]
        winkNext = random(3000, 8000)
        setState(.idle, force: true)
    }

    func random(_ a: Double, _ b: Double) -> Double { a + Double.random(in: 0..<1, using: &rng) * (b - a) }

    public func setState(_ s: AvatarState, force: Bool = false) {
        if !force && s == state { return }
        state = s
        stateStartedAt = now
        let t = data.timing[s]!
        expressionCursor = 0
        expressionNext = now + random(t.cadence.lowerBound, t.cadence.upperBound)
        blinkNext = now + random(1500, 7000)
        gazeNext = now + random(500, 1400)
        listenNodNext = now + random(1200, 2200)
        winkNext = now + random(3000, 8000)
        blinkQueue = []
        blinkTarget = nil
        scheduleBlink()
        setExpression(t.pool[0], frequency: 8)
    }

    func setExpression(_ index: Int, frequency: Double = 7) {
        if index == expressionIndex && expressionSpring.target == 1 { return }
        let amount = clamp(expressionSpring.x, 0, 1)
        expressionFrom = [Geometry.lerp(expressionFrom[0], expressionTo[0], amount), Geometry.lerp(expressionFrom[1], expressionTo[1], amount)]
        expressionTo = data.expressions[index]
        expressionIndex = index
        expressionSpring = Spring(0)
        expressionSpring.target = 1
        expressionFrequency = frequency
    }

    func scheduleBlink() {
        blinkTarget = eyeOpen.target
        blinkQueue += [(now, 0.05), (now + 70, 0.05), (now + 150, 1.08), (now + 300, 1)]
        if random(0, 1) < 0.14 { blinkQueue += [(now + 370, 0.05), (now + 480, 1)] }
    }

    func beginShapeChange(from old: String?) {
        let prev = data.shape(old)
        let amount = cubicInOut(clamp(shapeBlend.x, 0, 1))
        shapeFromRing = amount >= 1 ? prev.ring : Geometry.lerp(shapeFromRing, prev.ring, amount)
        shapeFromFace = amount >= 1 ? prev.face : shapeFromFace.lerp(to: prev.face, amount)
        shapeFromTilt += (prev.tiltScale - shapeFromTilt) * amount
        shapeBlend = Spring(0)
        shapeBlend.target = 1
    }

    /// Advances the animation by `dt` seconds (capped at 0.1 s so a stalled frame doesn't jump).
    public func step(_ dt: Double) {
        let delta = clamp(dt, 0, 0.1)
        lastDelta = delta
        now += delta * 1000
        updateTargets()
        let steps = max(1, Int((delta / (1.0 / 120)).rounded(.up)))
        let h = delta / Double(steps)
        for _ in 0..<steps {
            expressionSpring.step(expressionFrequency, 1, h)
            rotation.step(5, 0.9, h)
            headX.step(3.5, 1, h)
            headY.step(4, 1, h)
            scaleY.step(10, 0.8, h)
            eyeOpen.step(26, 1, h)
            eyeScale.step(9, 0.85, h)
            aimX.step(13, 1, h)
            aimY.step(13, 1, h)
            shapeBlend.step(10, 1, h)
        }
        if reduceMotion {
            expressionSpring.x = 1
            shapeBlend.x = shapeBlend.target
        }
    }

    func updateTargets() {
        let runtime = (now - startedAt) / 1000
        var rot = 0.0, x = 0.0, y = 0.0, sy = 1.0, eyeScaleT = 1.0
        if reduceMotion {
            setExpression(data.timing[state]!.pool[0])
        } else {
            switch state {
            case .idle:
                rot = 1.5 * sin(0.5 * runtime) + 0.6 * sin(0.17 * runtime)
                x = sin(0.27 * runtime); y = 1.2 * sin(0.85 * runtime); sy = 1 + 0.007 * sin(0.85 * runtime)
            case .listening:
                rot = 8 + 1.5 * sin(0.5 * runtime); x = 2; y = -2 + 0.8 * sin(0.8 * runtime); sy = 1.015
                if now >= listenNodNext { listenNodUntil = now + 380; listenNodNext = now + random(1800, 3200) }
                if now < listenNodUntil {
                    let phase = 1 - (listenNodUntil - now) / 380
                    y += 4.5 * sin(phase * .pi); rot += 2 * sin(phase * .pi)
                }
            case .thinking:
                rot = -9 + 5 * sin(0.35 * runtime); x = 5 * sin(0.3 * runtime); y = 2.5 * sin(0.6 * runtime)
            case .speaking:
                // Subtle: a small lift and stretch that follow the voice, over idle's sway.
                let level = clamp(voiceLevel, 0, 1)
                rot = 1.5 * sin(0.5 * runtime) + 2 * level * sin(9 * runtime)
                x = sin(0.27 * runtime); y = -1 - 4 * level; sy = 1 + 0.035 * level; eyeScaleT = 1 + 0.04 * level
            }
            if state == .idle, now >= winkNext {
                winkAt = now; winkEye = random(0, 1) < 0.5 ? 0 : 1; winkNext = now + random(4500, 10000)
            }
            updateExpressionAndBlink()
            updateAim()
        }
        rotation.target = rot * .pi / 180
        headX.target = x
        headY.target = y
        scaleY.target = sy
        eyeOpen.target = blinkOverride ?? 1
        eyeScale.target = eyeScaleT
    }

    var blinkOverride: Double?

    func updateExpressionAndBlink() {
        let t = data.timing[state]!
        if now >= expressionNext {
            if t.pool.count > 1 {
                expressionCursor = (expressionCursor + 1 + Int(random(0, Double(t.pool.count - 1)))) % t.pool.count
            }
            setExpression(t.pool[expressionCursor], frequency: 6)
            expressionNext = now + random(t.cadence.lowerBound, t.cadence.upperBound)
        }
        if let b = t.blink, now >= blinkNext {
            scheduleBlink()
            blinkNext = now + random(b.lowerBound, b.upperBound)
        }
        while let first = blinkQueue.first, now >= first.at { blinkTarget = first.value; blinkQueue.removeFirst() }
        if !blinkQueue.isEmpty { blinkOverride = blinkTarget; return }
        if let final = blinkTarget { blinkTarget = nil; blinkOverride = final; return }
        blinkOverride = nil
    }

    func updateAim() {
        // Looking at someone wins over wandering eyes.
        if let g = gaze {
            aimX.target = 15 * g.x
            aimY.target = 9 * g.y
            gazeNext = now
            return
        }
        guard now >= gazeNext else { return }
        let dir = { self.random(0, 1) < 0.5 ? -1.0 : 1.0 }
        var x = 0.0, y = 0.0, lo = 2500.0, hi = 5000.0
        switch state {
        case .idle: lo = 2500; hi = 5500
        case .listening: x = 15 * random(-0.3, 0.3); y = 9 * random(-0.25, 0.25); lo = 2200; hi = 4200
        case .thinking: x = dir() * random(0.5, 1) * 15; y = -9 * random(0.4, 1); lo = 1500; hi = 2800
        case .speaking: x = 15 * random(-0.2, 0.2); y = 9 * random(-0.15, 0.15); lo = 1800; hi = 3500
        }
        aimX.target = x
        aimY.target = y
        gazeNext = now + random(lo, hi)
    }

    /// The pose to draw now.
    public func frame() -> MorphFrame {
        let c = data.headC
        let shape = data.shape(shapeId)
        let amount = cubicInOut(clamp(shapeBlend.x, 0, 1))
        let transitioning = amount < 0.999
        let ring = transitioning ? Geometry.lerp(shapeFromRing, shape.ring, amount) : shape.ring
        let face = transitioning ? shapeFromFace.lerp(to: shape.face, amount) : shape.face
        let tilt = transitioning ? shapeFromTilt + (shape.tiltScale - shapeFromTilt) * amount : shape.tiltScale
        let top = transitioning ? ring.map(\.y).min()! : shape.top
        let bottom = transitioning ? ring.map(\.y).max()! : shape.bottom
        let head = transitioning ? Geometry.outline(ring) : shape.path
        let spanAt: (Double) -> Point2 = transitioning ? { Geometry.span(ring, y: $0, center: c) } : { Geometry.span(shape, y: $0) }

        let ea = clamp(expressionSpring.x, 0, 1)
        let eyeRings = [Geometry.lerp(expressionFrom[0], expressionTo[0], ea), Geometry.lerp(expressionFrom[1], expressionTo[1], ea)]
        let centers = eyeRings.map(Geometry.centroid)
        let halves = (0..<2).map { i in eyeRings[i].reduce(0.0) { max($0, abs($1.x - centers[i].x)) } }
        let distance = abs(centers[1].x - centers[0].x) * face.sx
        let fit = halves[0] + halves[1] > 0.5 ? clamp((distance - 5) / (halves[0] + halves[1]), 0.35, 4) : 4
        var eyes: [CGPath] = []
        for i in 0..<2 {
            let r = eyeRings[i], center = centers[i]
            let pulse = 1 + 0.07 * sin(ea * .pi)
            var driftX = 1.4 * sin(0.00042 * now + Double(i)) + 0.5 * sin(0.001 * now + 2 * Double(i))
            var driftY = 0.9 * sin(0.00058 * now + Double(i))
            driftX += aimX.x
            driftY += aimY.x
            let es = min(clamp(eyeScale.x, 0.2, 2) * face.eye, fit / pulse)
            let sx = clamp(es * pulse, 0.02, 2.4)
            var wink = 1.0
            if i == winkEye && now < winkAt + 320 {
                let p = (now - winkAt) / 320
                wink = max(p < 0.42 ? 1 - p / 0.42 : (p - 0.42) / 0.58, 0.04)
            }
            let sy = clamp(max(eyeOpen.x * wink, 0.04) * es * pulse, 0.02, 2.4)
            let halfH = data.eyeHalf * sy + 2
            let y = clamp(c + face.y + (center.y + driftY - c) * face.sy, top + halfH, bottom - halfH)
            var maxLeft = -Double.infinity, minRight = Double.infinity
            var k = 0
            while k < r.count {
                let scaledX = (r[k].x - center.x) * sx
                let span = spanAt(y + (r[k].y - center.y) * sy)
                maxLeft = max(maxLeft, span.x - scaledX)
                minRight = min(minRight, span.y - scaledX)
                k += 2
            }
            let desired = c + face.x + (center.x - c) * face.sx + driftX * face.sx
            let fx = maxLeft <= minRight ? clamp(desired, maxLeft, minRight) : (maxLeft + minRight) / 2
            var t = CGAffineTransform(translationX: fx, y: y).scaledBy(x: sx, y: sy).translatedBy(x: -center.x, y: -center.y)
            eyes.append(Geometry.polygon(r).copy(using: &t)!)
        }
        let deg = rotation.x * 180 / .pi * tilt
        let transform = CGAffineTransform(translationX: c + headX.x, y: c + headY.x)
            .rotated(by: deg * .pi / 180)
            .scaledBy(x: 1, y: scaleY.x)
            .translatedBy(x: -c, y: -c)
        return MorphFrame(head: head, transform: transform, eyes: eyes)
    }

    // For tests: a peek at the live values.
    public var debugEyeOpen: Double { eyeOpen.x }
    public var debugAim: Point2 { Point2(aimX.x, aimY.x) }
    public var debugExpression: Int { expressionIndex }
    public var debugHead: Point2 { Point2(headX.x, headY.x) }
    public var debugShapeBlend: Double { shapeBlend.x }
}
