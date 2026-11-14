// Draws the Grok Call app icon (four bot tiles with eyes) and writes mac/Resources/AppIcon.icns.
// Run: swift mac/tools/make-icon.swift   (needs iconutil, part of macOS)
import AppKit

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
}

/// Tiles: (x, y from top, light, dark) on a 1024 canvas.
let tiles: [(CGFloat, CGFloat, UInt32, UInt32)] = [
    (268, 268, 0xC3A6FF, 0x7340F0), (530, 268, 0x7FF5E3, 0x00A892),
    (268, 530, 0xFFB37A, 0xF05A00), (530, 530, 0xFF8FC8, 0xE81B86),
]

func draw(_ px: Int) -> Data {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let k = CGFloat(px) / 1024
    ctx.scaleBy(x: k, y: k)
    ctx.translateBy(x: 0, y: 1024); ctx.scaleBy(x: 1, y: -1) // y down, like the SVG
    let body = CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 185, cornerHeight: 185, transform: nil)
    // Drop shadow under the body.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 28, color: CGColor(gray: 0, alpha: 0.32))
    ctx.addPath(body); ctx.setFillColor(rgb(0xEDEDF2)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(body); ctx.clip()
    let bg = CGGradient(colorsSpace: cs, colors: [rgb(0xF8F8FB), rgb(0xD9D9E2)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    for (x, y, light, dark) in tiles {
        let r = CGRect(x: x, y: y, width: 226, height: 226)
        let tile = CGPath(roundedRect: r, cornerWidth: 70, cornerHeight: 70, transform: nil)
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: 10), blur: 18, color: CGColor(gray: 0, alpha: 0.18))
        ctx.addPath(tile); ctx.setFillColor(rgb(dark)); ctx.fillPath()
        ctx.restoreGState()
        ctx.saveGState()
        ctx.addPath(tile); ctx.clip()
        let g = CGGradient(colorsSpace: cs, colors: [rgb(light), rgb(dark)] as CFArray, locations: [0, 1])!
        ctx.drawRadialGradient(g, startCenter: CGPoint(x: r.minX + r.width * 0.38, y: r.minY + r.height * 0.32), startRadius: 0,
                               endCenter: CGPoint(x: r.minX + r.width * 0.38, y: r.minY + r.height * 0.32), endRadius: r.width * 0.95, options: [.drawsAfterEndLocation])
        ctx.restoreGState()
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        for ex in [r.minX + 73, r.minX + 127] {
            ctx.addPath(CGPath(roundedRect: CGRect(x: ex, y: r.minY + 77, width: 26, height: 56), cornerWidth: 13, cornerHeight: 13, transform: nil))
            ctx.fillPath()
        }
    }
    // Top gloss and a hairline edge.
    let gloss = CGGradient(colorsSpace: cs, colors: [CGColor(gray: 1, alpha: 0.16), CGColor(gray: 1, alpha: 0)] as CFArray, locations: [0, 0.45])!
    ctx.drawLinearGradient(gloss, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    ctx.restoreGState()
    ctx.addPath(CGPath(roundedRect: CGRect(x: 101.5, y: 101.5, width: 821, height: 821), cornerWidth: 184, cornerHeight: 184, transform: nil))
    ctx.setStrokeColor(CGColor(gray: 0, alpha: 0.08)); ctx.setLineWidth(3); ctx.strokePath()
    return NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
}

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let set = FileManager.default.temporaryDirectory.appendingPathComponent("GrokCall-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: set) }
for base in [16, 32, 128, 256, 512] {
    try draw(base).write(to: set.appendingPathComponent("icon_\(base)x\(base).png"))
    try draw(base * 2).write(to: set.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
try draw(256).write(to: root.appendingPathComponent("Resources/AppIcon.png")) // for the README
let out = root.appendingPathComponent("Resources/AppIcon.icns")
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", set.path, "-o", out.path]
try p.run(); p.waitUntilExit()
guard p.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Wrote \(out.path)")
