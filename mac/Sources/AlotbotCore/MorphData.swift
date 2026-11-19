import CoreGraphics
import Foundation

/// A point in the avatar's 228.5 x 228.5 drawing space.
public typealias Point2 = SIMD2<Double>
public typealias Ring = [Point2]

/// Where the eyes sit on a shape, and how big they are.
public struct Face: Equatable, Sendable {
    public var x: Double, y: Double, sx: Double, sy: Double, eye: Double
    public static let neutral = Face(x: 0, y: 0, sx: 1, sy: 1, eye: 1)

    public func lerp(to b: Face, _ t: Double) -> Face {
        Face(x: x + (b.x - x) * t, y: y + (b.y - y) * t, sx: sx + (b.sx - sx) * t, sy: sy + (b.sy - sy) * t, eye: eye + (b.eye - eye) * t)
    }
}

/// One body shape: its outline (as an SVG path and as a 96-point ring), eye placement and how much it tilts.
public struct Shape: @unchecked Sendable { // CGPath is immutable once built
    public let id: String
    public let path: CGPath
    public let ring: Ring
    public let top: Double
    public let bottom: Double
    public let beltRadius: Double
    /// Left and right edge of the shape at 160 evenly spaced heights between top and bottom.
    public let spanSamples: [Point2]
    public let face: Face
    public let tiltScale: Double
}

/// Moods the avatar has in a call.
public enum AvatarState: String, CaseIterable, Sendable {
    case idle, listening, thinking, speaking
}

public struct StateTiming: Sendable {
    public let pool: [Int]
    public let cadence: ClosedRange<Double>
    public let blink: ClosedRange<Double>?
}

/// Geometry and timing taken from Grok Bot (see mac/tools for how the file is made).
public final class MorphData: @unchecked Sendable {
    public let headC: Double
    public let eyeHalf: Double
    public let circleRing: Ring
    /// Each expression is a pair of eye rings (left, right).
    public let expressions: [[Ring]]
    public let shapes: [String: Shape]
    public let timing: [AvatarState: StateTiming]

    public static let shared: MorphData = {
        guard let url = Bundle.module.url(forResource: "morph-data", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let parsed = try? MorphData(json: data)
        else { fatalError("morph-data.json is missing or broken: rebuild with mac/tools/build-morph-data.mjs") }
        return parsed
    }()

    public enum LoadError: Error, Equatable { case malformed(String) }

    public init(json: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: json) as? [String: Any] else { throw LoadError.malformed("root") }
        func num(_ v: Any?, _ what: String) throws -> Double {
            guard let n = v as? NSNumber else { throw LoadError.malformed(what) }
            return n.doubleValue
        }
        func ring(_ v: Any?, _ what: String) throws -> Ring {
            guard let pts = v as? [[Any]] else { throw LoadError.malformed(what) }
            return try pts.map { p in
                guard p.count == 2 else { throw LoadError.malformed(what) }
                return Point2(try num(p[0], what), try num(p[1], what))
            }
        }
        headC = try num(root["headC"], "headC")
        eyeHalf = try num(root["eyeHalf"], "eyeHalf")
        circleRing = try ring(root["circleRing"], "circleRing")
        guard let exprs = root["expressions"] as? [Any] else { throw LoadError.malformed("expressions") }
        expressions = try exprs.map { e in
            guard let pair = e as? [Any], pair.count == 2 else { throw LoadError.malformed("expression") }
            return [try ring(pair[0], "eye"), try ring(pair[1], "eye")]
        }
        guard let rawShapes = root["shapes"] as? [String: [String: Any]] else { throw LoadError.malformed("shapes") }
        var shapes: [String: Shape] = [:]
        for (id, s) in rawShapes {
            guard let d = s["path"] as? String, let path = SVGPath.parse(d) else { throw LoadError.malformed("path of \(id)") }
            guard let f = s["face"] as? [String: Any] else { throw LoadError.malformed("face of \(id)") }
            shapes[id] = Shape(
                id: id, path: path, ring: try ring(s["ring"], "ring of \(id)"),
                top: try num(s["top"], "top"), bottom: try num(s["bottom"], "bottom"), beltRadius: try num(s["beltRadius"], "beltRadius"),
                spanSamples: try ring(s["spanSamples"], "spanSamples of \(id)"),
                face: Face(x: try num(f["x"], "face"), y: try num(f["y"], "face"), sx: try num(f["sx"], "face"), sy: try num(f["sy"], "face"), eye: try num(f["eye"], "face")),
                tiltScale: try num(s["tiltScale"], "tiltScale"))
        }
        guard shapes["blob"] != nil else { throw LoadError.malformed("no blob shape") }
        self.shapes = shapes
        guard let pools = root["pools"] as? [String: [Int]], let cadence = root["cadence"] as? [String: [Double]], let blink = root["blink"] as? [String: Any] else {
            throw LoadError.malformed("state timing")
        }
        func readTiming(_ key: String) throws -> StateTiming {
            guard let p = pools[key], !p.isEmpty, p.allSatisfy({ $0 >= 0 && $0 < exprs.count }), let c = cadence[key], c.count == 2 else { throw LoadError.malformed("timing of \(key)") }
            let b = (blink[key] as? [Double]).flatMap { $0.count == 2 ? $0[0]...$0[1] : nil }
            return StateTiming(pool: p, cadence: c[0]...c[1], blink: b)
        }
        // Speaking keeps idle's calm eyes; its motion comes from the voice level instead.
        self.timing = [.idle: try readTiming("idle"), .listening: try readTiming("listening"), .thinking: try readTiming("thinking"), .speaking: try readTiming("idle")]
    }

    /// A shape by Grok Bot's name for it; unknown names (or none) get the default blob.
    public func shape(_ id: String?) -> Shape { id.flatMap { shapes[$0] } ?? shapes["blob"]! }
}
