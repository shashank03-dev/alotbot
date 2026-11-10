import CoreGraphics
import Foundation

@inline(__always) public func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }
public func cubicInOut(_ t: Double) -> Double { t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }

/// Parses the subset of SVG path data Grok Bot's shapes use: M, L, C, Q and Z (absolute, as Grok writes them).
public enum SVGPath {
    public static func parse(_ d: String) -> CGPath? {
        var tokens: [String] = []
        var cur = ""
        func flush() { if !cur.isEmpty { tokens.append(cur); cur = "" } }
        var prev: Character = " "
        for ch in d {
            if ch.isLetter && ch != "e" && ch != "E" {
                flush(); tokens.append(String(ch))
            } else if ch == "," || ch == " " || ch == "\n" || ch == "\t" {
                flush()
            } else if ch == "-" && !cur.isEmpty && prev != "e" && prev != "E" {
                flush(); cur.append(ch)
            } else if ch == "." && cur.contains(".") && !cur.contains("e") {
                flush(); cur.append(ch)
            } else {
                cur.append(ch)
            }
            prev = ch
        }
        flush()
        let path = CGMutablePath()
        var i = 0
        var cmd: Character = " "
        func n() -> Double? {
            guard i < tokens.count, let v = Double(tokens[i]) else { return nil }
            i += 1
            return v
        }
        func pt() -> CGPoint? {
            guard let x = n(), let y = n() else { return nil }
            return CGPoint(x: x, y: y)
        }
        while i < tokens.count {
            if let c = tokens[i].first, tokens[i].count == 1, c.isLetter { cmd = c; i += 1 }
            switch cmd {
            case "M":
                guard let p = pt() else { return nil }
                path.move(to: p)
                cmd = "L" // extra pairs after M are lines
            case "L":
                guard let p = pt() else { return nil }
                path.addLine(to: p)
            case "C":
                guard let a = pt(), let b = pt(), let p = pt() else { return nil }
                path.addCurve(to: p, control1: a, control2: b)
            case "Q":
                guard let a = pt(), let p = pt() else { return nil }
                path.addQuadCurve(to: p, control: a)
            case "Z", "z":
                path.closeSubpath()
                cmd = " "
            default:
                return nil
            }
        }
        return path.isEmpty ? nil : path
    }
}

public enum Geometry {
    public static func lerp(_ a: Ring, _ b: Ring, _ t: Double) -> Ring {
        zip(a, b).map { $0 + ($1 - $0) * t }
    }

    public static func centroid(_ r: Ring) -> Point2 {
        r.reduce(Point2(0, 0), +) / Double(max(r.count, 1))
    }

    /// A smooth closed outline through every ring point (Catmull-Rom as cubic Béziers), as Grok Bot draws a changing shape.
    public static func outline(_ r: Ring) -> CGPath {
        let p = CGMutablePath()
        let n = r.count
        guard n > 2 else { return p }
        p.move(to: CGPoint(x: r[0].x, y: r[0].y))
        for i in 0..<n {
            let a = r[(i - 1 + n) % n], b = r[i], c = r[(i + 1) % n], d = r[(i + 2) % n]
            let c1 = b + (c - a) / 6, c2 = c - (d - b) / 6
            p.addCurve(to: CGPoint(x: c.x, y: c.y), control1: CGPoint(x: c1.x, y: c1.y), control2: CGPoint(x: c2.x, y: c2.y))
        }
        p.closeSubpath()
        return p
    }

    /// A closed polygon through the ring (eyes are drawn this way).
    public static func polygon(_ r: Ring) -> CGPath {
        let p = CGMutablePath()
        guard let first = r.first else { return p }
        p.move(to: CGPoint(x: first.x, y: first.y))
        for q in r.dropFirst() { p.addLine(to: CGPoint(x: q.x, y: q.y)) }
        p.closeSubpath()
        return p
    }

    /// Left and right edge of a ring at height y (the center line splits left from right).
    public static func span(_ ring: Ring, y: Double, center: Double) -> Point2 {
        var left = -Double.infinity, right = Double.infinity
        for i in 0..<ring.count {
            let s = ring[i], e = ring[(i + 1) % ring.count]
            if (s.y <= y) == (e.y <= y) { continue }
            let x = s.x + (e.x - s.x) * (y - s.y) / (e.y - s.y)
            if x <= center { left = max(left, x) } else { right = min(right, x) }
        }
        return Point2(left.isFinite ? left : center, right.isFinite ? right : center)
    }

    /// Same as span, read from the shape's precomputed samples.
    public static func span(_ shape: Shape, y: Double) -> Point2 {
        let s = shape.spanSamples
        let count = Double(s.count)
        let pos = clamp((y - shape.top) / (shape.bottom - shape.top) * count - 0.5, 0, count - 1)
        let a = Int(pos.rounded(.down)), b = min(a + 1, s.count - 1)
        return s[a] + (s[b] - s[a]) * (pos - Double(a))
    }
}
