import CoreGraphics
import Foundation
import Testing
@testable import GrokCallCore

@Suite struct SVGPathTests {
    @Test func basicSquare() throws {
        let p = try #require(SVGPath.parse("M0 0 L10 0 L10 10 L0 10 Z"))
        #expect(p.boundingBoxOfPath == CGRect(x: 0, y: 0, width: 10, height: 10))
    }

    @Test func implicitLinesAfterMove() throws {
        let p = try #require(SVGPath.parse("M0,0 10,0 10,10z"))
        #expect(p.boundingBoxOfPath == CGRect(x: 0, y: 0, width: 10, height: 10))
    }

    @Test func compactNumbers() throws {
        // "-" and a second "." start new numbers; "e-" stays inside one.
        #expect(try #require(SVGPath.parse("M0-5L10-5L10 5Z")).boundingBoxOfPath == CGRect(x: 0, y: -5, width: 10, height: 10))
        #expect(try #require(SVGPath.parse("M.5.5L1.5.5L1.5 1.5Z")).boundingBoxOfPath == CGRect(x: 0.5, y: 0.5, width: 1, height: 1))
        #expect(try #require(SVGPath.parse("M1e-2 0L1E1 0L1e1 1e1Z")).boundingBoxOfPath.maxX == 10)
        #expect(try #require(SVGPath.parse("M0\t0\nL4 4")).boundingBoxOfPath.width == 4)
    }

    @Test func curves() throws {
        let c = try #require(SVGPath.parse("M0 0 C0 10 10 10 10 0 Q5 -10 0 0 Z"))
        #expect(c.boundingBoxOfPath.width == 10)
        #expect(c.boundingBoxOfPath.minY < 0 && c.boundingBoxOfPath.maxY > 0)
    }

    @Test(arguments: ["", "   ", "M0", "M0 0 L5", "M0 0 C1 1 2 2", "M0 0 Q1 1", "X1 2", "M0 0 A1 1 0 0 1 2 2", "M0 0 Lx 1", "1 2"])
    func rejects(_ d: String) {
        #expect(SVGPath.parse(d) == nil)
    }
}

@Suite struct GeometryTests {
    let square: Ring = [Point2(0, 0), Point2(10, 0), Point2(10, 10), Point2(0, 10)]

    @Test func lerpAndCentroid() {
        let b = square.map { $0 + Point2(10, 10) }
        #expect(Geometry.lerp(square, b, 0.5)[0] == Point2(5, 5))
        #expect(Geometry.centroid(square) == Point2(5, 5))
        #expect(Geometry.centroid([]) == Point2(0, 0))
    }

    @Test func outlineAndPolygon() {
        #expect(Geometry.outline([Point2(0, 0), Point2(1, 1)]).isEmpty)
        let o = Geometry.outline(square).boundingBoxOfPath
        #expect(o.minX < 0.01 && o.maxX > 9.99) // a smooth curve through every point
        #expect(Geometry.polygon([]).isEmpty)
        #expect(Geometry.polygon(square).boundingBoxOfPath == CGRect(x: 0, y: 0, width: 10, height: 10))
    }

    @Test func spanOfRing() {
        #expect(Geometry.span(square, y: 5, center: 5) == Point2(0, 10))
        #expect(Geometry.span(square, y: 50, center: 5) == Point2(5, 5)) // above or below the shape: no width
    }

    @Test func spanOfShapeMatchesRing() {
        let s = MorphData.shared.shape("blob")
        let mid = (s.top + s.bottom) / 2
        let fromSamples = Geometry.span(s, y: mid)
        let fromRing = Geometry.span(s.ring, y: mid, center: MorphData.shared.headC)
        #expect(abs(fromSamples.x - fromRing.x) < 3)
        #expect(abs(fromSamples.y - fromRing.y) < 3)
        // Outside the shape, the samples clamp to the ends instead of reading out of bounds.
        #expect(Geometry.span(s, y: -1000) == s.spanSamples.first)
        #expect(Geometry.span(s, y: 1000) == s.spanSamples.last)
    }

    @Test func easingAndClamp() {
        #expect(cubicInOut(0) == 0)
        #expect(cubicInOut(0.5) == 0.5)
        #expect(cubicInOut(1) == 1)
        #expect(clamp(5, 0, 1) == 1)
        #expect(clamp(-5, 0, 1) == 0)
    }

    @Test func faceLerp() {
        let a = Face.neutral, b = Face(x: 10, y: 4, sx: 2, sy: 3, eye: 0)
        #expect(a.lerp(to: b, 0.5) == Face(x: 5, y: 2, sx: 1.5, sy: 2, eye: 0.5))
    }
}

@Suite struct MorphDataTests {
    static let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/GrokCallCore/Resources/morph-data.json")

    func raw() throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: Self.file)) as? [String: Any])
    }

    func load(_ obj: Any) throws -> MorphData {
        try MorphData(json: JSONSerialization.data(withJSONObject: obj))
    }

    /// The shapes Grok Bot's picker offers (the rest are older names it still draws).
    static let grokShapes = ["blob", "cloud", "square", "sparkle", "clover", "heart", "flower", "teardrop", "tablet", "wedge", "house", "star", "hex"]

    @Test func everyShapeLoads() {
        let d = MorphData.shared
        #expect(d.shapes.count == 25)
        for id in Self.grokShapes { #expect(d.shapes[id] != nil, "missing \(id)") }
        for s in d.shapes.values {
            #expect(!s.path.isEmpty)
            #expect(s.ring.count == 96)
            #expect(s.spanSamples.count == 160)
            #expect(s.top < s.bottom)
        }
        #expect(d.expressions.allSatisfy { $0.count == 2 })
        #expect(Set(d.timing.keys) == Set(AvatarState.allCases))
    }

    @Test func unknownShapesUseBlob() {
        #expect(MorphData.shared.shape(nil).id == "blob")
        #expect(MorphData.shared.shape("not-a-shape").id == "blob")
        #expect(MorphData.shared.shape("star").id == "star")
    }

    @Test func loadsFromFileContents() throws {
        #expect(try load(raw()).shapes.count == 25)
    }

    @Test func rejectsBrokenFiles() throws {
        func expectBroken(_ what: String, _ edit: (inout [String: Any]) -> Void) throws {
            var obj = try raw()
            edit(&obj)
            #expect(throws: MorphData.LoadError.malformed(what)) { try load(obj) }
        }
        #expect(throws: MorphData.LoadError.malformed("root")) { try MorphData(json: Data("[]".utf8)) }
        try expectBroken("headC") { $0["headC"] = "x" }
        try expectBroken("eyeHalf") { $0.removeValue(forKey: "eyeHalf") }
        try expectBroken("circleRing") { $0["circleRing"] = 3 }
        try expectBroken("circleRing") { $0["circleRing"] = [[1, 2, 3]] }
        try expectBroken("expressions") { $0["expressions"] = 1 }
        try expectBroken("expression") { $0["expressions"] = [[[[1, 2]]]] }
        try expectBroken("shapes") { $0["shapes"] = [] }
        try expectBroken("no blob shape") { var s = $0["shapes"] as! [String: Any]; s.removeValue(forKey: "blob"); $0["shapes"] = s }
        try expectBroken("path of blob") { var s = $0["shapes"] as! [String: [String: Any]]; s["blob"]!["path"] = "nope"; $0["shapes"] = s }
        try expectBroken("face of blob") { var s = $0["shapes"] as! [String: [String: Any]]; s["blob"]!["face"] = nil; $0["shapes"] = s }
        try expectBroken("state timing") { $0["pools"] = nil }
        try expectBroken("timing of idle") { var p = $0["pools"] as! [String: [Int]]; p["idle"] = []; $0["pools"] = p }
        try expectBroken("timing of thinking") { var p = $0["pools"] as! [String: [Int]]; p["thinking"] = [9999]; $0["pools"] = p }
        try expectBroken("timing of listening") { var c = $0["cadence"] as! [String: [Double]]; c["listening"] = [1]; $0["cadence"] = c }
    }

    @Test func blinkRangeIsOptional() throws {
        var obj = try raw()
        var b = obj["blink"] as! [String: Any]
        b["thinking"] = [1]
        obj["blink"] = b
        #expect(try load(obj).timing[.thinking]?.blink == nil)
    }
}

@Suite struct MorphEngineTests {
    func run(_ e: MorphEngine, seconds: Double) {
        for _ in 0..<Int(seconds * 60) { e.step(1.0 / 60) }
    }

    @Test func sameSeedSameMotion() {
        let a = MorphEngine(shape: "cloud", seed: 7), b = MorphEngine(shape: "cloud", seed: 7)
        for e in [a, b] { e.setState(.thinking); run(e, seconds: 3) }
        #expect(a.debugAim == b.debugAim)
        #expect(a.debugExpression == b.debugExpression)
        #expect(a.frame().eyes.map(\.boundingBoxOfPath) == b.frame().eyes.map(\.boundingBoxOfPath))
    }

    @Test func everyShapeAndMoodDrawsTwoEyesInsideTheHead() {
        for (i, id) in MorphData.shared.shapes.keys.sorted().enumerated() {
            for state in AvatarState.allCases {
                let e = MorphEngine(shape: id, seed: UInt64(i))
                e.setState(state)
                e.voiceLevel = 0.8
                run(e, seconds: 1.5)
                let f = e.frame()
                #expect(f.eyes.count == 2)
                let head = f.head.boundingBoxOfPath
                for eye in f.eyes {
                    let r = eye.boundingBoxOfPath
                    #expect(r.minX.isFinite && r.maxY.isFinite, "\(id) \(state)")
                    #expect(head.insetBy(dx: -6, dy: -6).contains(r), "\(id) \(state): eye outside head")
                }
            }
        }
    }

    @Test func blinksCloseAndReopen() {
        let e = MorphEngine(seed: 1)
        var lowest = 1.0
        for _ in 0..<30 { e.step(1.0 / 60); lowest = min(lowest, e.debugEyeOpen) }
        #expect(lowest < 0.3) // the blink scheduled on start
        run(e, seconds: 1)
        #expect(abs(e.debugEyeOpen - 1) < 0.1)
    }

    /// The middle of both eyes, relative to the head's middle (head space, before the head's own transform).
    private func eyesMiddle(_ e: MorphEngine) -> Point2 {
        let boxes = e.frame().eyes.map(\.boundingBoxOfPath)
        let c = MorphData.shared.headC
        return Point2(boxes.map { Double($0.midX) }.reduce(0, +) / 2 - c, boxes.map { Double($0.midY) }.reduce(0, +) / 2 - c)
    }

    @Test func lookingAtSomeoneMovesTheEyesToThatSide() {
        // Every state and shape, even ones whose expression puts the eyes up and to the right on their own.
        for shape in [nil, "cloud", "square"] as [String?] {
            for state in [AvatarState.idle, .listening, .speaking] {
                let e = MorphEngine(shape: shape, seed: 2)
                e.setState(state)
                e.gaze = GazeTarget(x: -1, y: 0)
                run(e, seconds: 1.5)
                #expect(eyesMiddle(e).x < -20, "left: \(shape ?? "circle") \(state)")
                e.gaze = GazeTarget(x: 1, y: 0)
                run(e, seconds: 1.5)
                #expect(eyesMiddle(e).x > 20, "right: \(shape ?? "circle") \(state)")
                e.gaze = GazeTarget(x: 0, y: -1)
                run(e, seconds: 1.5)
                #expect(eyesMiddle(e).y < -15, "up: \(shape ?? "circle") \(state)")
                #expect(abs(eyesMiddle(e).x) < 12, "up: \(shape ?? "circle") \(state)")
            }
        }
        let e = MorphEngine(seed: 2)
        e.gaze = GazeTarget(x: -5, y: 5) // clamped to -1...1
        run(e, seconds: 1.5)
        #expect(e.debugAim == Point2(0, 0), "no wandering while looking at someone")
        #expect(eyesMiddle(e).x < -20 && eyesMiddle(e).y > 15)
        e.gaze = nil // back to its own expression
        run(e, seconds: 1.5)
        #expect(eyesMiddle(e).x > 0)
    }

    @Test func theHeadTurnsTowardWhoItLooksAt() {
        let e = MorphEngine(seed: 4)
        e.setState(.listening)
        run(e, seconds: 1.5)
        #expect(e.debugRotation > 0.05, "listening leans right when looking at no one")
        e.gaze = GazeTarget(x: -1, y: 0)
        run(e, seconds: 1.5)
        #expect(e.debugRotation < -0.05, "and left toward someone on the left")
        #expect(e.debugHead.x < 0)
        let idle = MorphEngine(seed: 4)
        idle.gaze = GazeTarget(x: 1, y: 1)
        run(idle, seconds: 1.5)
        #expect(idle.debugHead.x > 1.5 && idle.debugHead.y > 0.5)
    }

    @Test func wanderingEyesWhenNoOneToLookAt() {
        let e = MorphEngine(seed: 3)
        e.setState(.thinking)
        run(e, seconds: 4)
        #expect(e.debugAim.y < 0) // thinking looks up
        for s in [AvatarState.listening, .speaking, .idle] { e.setState(s); run(e, seconds: 4) }
    }

    @Test func moodsMoveTheHead() {
        let speaking = MorphEngine(seed: 4)
        speaking.setState(.speaking)
        speaking.voiceLevel = 1
        run(speaking, seconds: 2)
        #expect(speaking.debugHead.y < -3)

        let listening = MorphEngine(seed: 5)
        listening.setState(.listening)
        run(listening, seconds: 3)
        #expect(abs(listening.debugHead.x - 2) < 0.6)
    }

    @Test func expressionsChangeOverTime() {
        let e = MorphEngine(seed: 6)
        e.setState(.thinking)
        var seen = Set<Int>()
        for _ in 0..<600 { e.step(1.0 / 60); seen.insert(e.debugExpression) }
        #expect(seen.count > 1)
    }

    @Test func settingTheSameStateIsANoOp() {
        let e = MorphEngine(seed: 8)
        e.setState(.listening)
        run(e, seconds: 0.5)
        let expr = e.debugExpression
        e.setState(.listening)
        #expect(e.state == .listening)
        #expect(e.debugExpression == expr)
    }

    @Test func shapeChangesMorph() {
        let e = MorphEngine(shape: "blob", seed: 9)
        run(e, seconds: 0.5)
        e.shapeId = "square"
        #expect(e.debugShapeBlend == 0)
        e.step(1.0 / 60)
        let mid = e.frame().head.boundingBoxOfPath
        #expect(mid != MorphData.shared.shape("square").path.boundingBoxOfPath)
        // Changing again mid-morph starts from where it is now, not from scratch.
        run(e, seconds: 0.05)
        e.shapeId = "star"
        run(e, seconds: 1.5)
        #expect(e.debugShapeBlend > 0.99)
        #expect(e.frame().head === MorphData.shared.shape("star").path)
        e.shapeId = "star" // same shape: nothing restarts
        #expect(e.debugShapeBlend > 0.99)
    }

    @Test func reduceMotionSkipsTheMorph() {
        let e = MorphEngine(shape: "blob", seed: 10)
        e.reduceMotion = true
        e.shapeId = "heart"
        e.step(1.0 / 60)
        #expect(e.debugShapeBlend == 1)
        e.setState(.thinking)
        run(e, seconds: 2)
        #expect(e.debugHead.x == 0 && e.debugHead.y == 0)
    }

    @Test func winksUseEitherEye() {
        var eyes = Set<Int>()
        for seed in 0..<12 {
            let e = MorphEngine(seed: UInt64(seed))
            run(e, seconds: 12)
            eyes.insert(e.winkEye)
        }
        #expect(eyes == [0, 1])
    }

    /// Data whose eyes have no width and whose blob has no width either, to reach the fallbacks.
    func degenerateData() throws -> MorphData {
        var obj = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: MorphDataTests.file)) as? [String: Any])
        let dot = [[100.0, 100.0], [100.0, 100.0], [100.0, 100.0]]
        obj["expressions"] = (obj["expressions"] as! [Any]).map { _ in [dot, dot] }
        var shapes = obj["shapes"] as! [String: [String: Any]]
        shapes["blob"]!["spanSamples"] = Array(repeating: [114.0, 114.0], count: 160)
        obj["shapes"] = shapes
        return try MorphData(json: JSONSerialization.data(withJSONObject: obj))
    }

    @Test func eyesStayFiniteOnOddData() throws {
        let data = try degenerateData()
        let e = MorphEngine(shape: "blob", data: data, seed: 1)
        run(e, seconds: 0.5)
        for eye in e.frame().eyes { #expect(eye.boundingBoxOfPath.minX.isFinite) }
        // Wide eyes on a shape with no width: they center instead of flipping sides.
        var obj = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: MorphDataTests.file)) as? [String: Any])
        var shapes = obj["shapes"] as! [String: [String: Any]]
        shapes["blob"]!["spanSamples"] = Array(repeating: [114.0, 114.0], count: 160)
        obj["shapes"] = shapes
        let narrow = MorphEngine(shape: "blob", data: try MorphData(json: JSONSerialization.data(withJSONObject: obj)), seed: 1)
        run(narrow, seconds: 0.5)
        let xs = narrow.frame().eyes.map(\.boundingBoxOfPath.midX)
        #expect(xs.allSatisfy { $0.isFinite })
    }

    @Test func longStallsAreCapped() {
        let e = MorphEngine(seed: 11)
        e.step(5)
        #expect(e.now == 100)
        e.step(-1)
        #expect(e.now == 100)
    }

    @Test func springRecoversFromBadNumbers() {
        var s = Spring(2)
        s.x = .nan
        s.step(10, 1, 0.01)
        #expect(s.x == 2 && s.v == 0)
        var g = SplitMix(seed: 1), h = SplitMix(seed: 1)
        #expect(g.next() == h.next())
    }
}

@Suite struct DrawingTests {
    @Test func contactSheetWritesAPNG() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("grokcall-sheet-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: url) }
        try AvatarDrawing.contactSheet(shapes: ["blob", "star", "heart"], state: .listening, cell: 64, columns: 2, settle: 0.2, url: url)
        let bytes = [UInt8](try Data(contentsOf: url).prefix(8))
        #expect(bytes == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    }

    @Test func drawsTheBodyColor() throws {
        let ctx = try #require(CGContext(data: nil, width: 40, height: 40, bitsPerComponent: 8, bytesPerRow: 160, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let e = MorphEngine(shape: "square", seed: 1)
        AvatarDrawing.draw(e.frame(), in: ctx, rect: CGRect(x: 0, y: 0, width: 40, height: 40), body: CGColor(red: 1, green: 0, blue: 0, alpha: 1), eyes: .white)
        let px = try #require(ctx.data).assumingMemoryBound(to: UInt8.self)
        // Bottom-center of the square body is red (the eyes sit higher).
        let i = (40 - 8) * 160 + 20 * 4
        #expect(px[i] > 200 && px[i + 1] < 40 && px[i + 3] > 200)
    }

    @Test func failsCleanlyOnABadPath() {
        let url = URL(fileURLWithPath: "/nonexistent-dir/x.png")
        #expect(throws: (any Error).self) { try AvatarDrawing.contactSheet(shapes: ["blob"], url: url) }
    }
}
