import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum AvatarDrawing {
    /// Draws one avatar frame into `rect` (fit, centered). Eyes are cut to the head's outline, as in Grok Bot.
    public static func draw(_ f: MorphFrame, in ctx: CGContext, rect: CGRect, body: CGColor, eyes eyeColor: CGColor, opacity: Double = 1) {
        let box = MorphFrame.viewBox
        let k = min(rect.width / box.width, rect.height / box.height)
        ctx.saveGState()
        ctx.setAlpha(opacity)
        ctx.translateBy(x: rect.midX, y: rect.midY)
        ctx.scaleBy(x: k, y: k)
        ctx.translateBy(x: -box.midX, y: -box.midY)
        ctx.concatenate(f.transform)
        ctx.addPath(f.head)
        ctx.setFillColor(body)
        ctx.fillPath()
        ctx.addPath(f.head)
        ctx.clip()
        ctx.setFillColor(eyeColor)
        for e in f.eyes {
            ctx.addPath(e)
            ctx.fillPath()
        }
        ctx.restoreGState()
    }

    /// A PNG of every shape in a grid (top-left origin), for checking shapes and eyes by eye.
    public static func contactSheet(shapes: [String], state: AvatarState = .idle, cell: Int = 160, columns: Int = 5, settle: Double = 1.2, url: URL) throws {
        let rows = (shapes.count + columns - 1) / columns
        let w = columns * cell, h = rows * cell
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw CocoaError(.fileWriteUnknown)
        }
        ctx.setFillColor(CGColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        // Flip so the avatar's y-down space draws upright.
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        for (i, id) in shapes.enumerated() {
            let e = MorphEngine(shape: id, seed: UInt64(i + 1))
            e.setState(state)
            for _ in 0..<Int(settle * 60) { e.step(1.0 / 60) }
            let r = CGRect(x: (i % columns) * cell, y: (i / columns) * cell, width: cell, height: cell).insetBy(dx: 14, dy: 14)
            draw(e.frame(), in: ctx, rect: r, body: CGColor(red: 0.57, green: 0.35, blue: 1, alpha: 1), eyes: .white)
        }
        guard let img = ctx.makeImage(), let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(dest, img, nil)
        guard CGImageDestinationFinalize(dest) else { throw CocoaError(.fileWriteUnknown) }
    }
}
