import AppKit
import GrokCallCore
import SwiftUI

/// Downloads each app logo once and keeps it for the session, so scrolling the list never refetches or flickers.
/// Also notes whether the logo is see-through and light or dark, so it can sit on a tile it stays visible on.
@MainActor final class LogoCache {
    struct Logo { let image: NSImage; let fillsTile: Bool; let light: Bool }
    static let shared = LogoCache()
    private var done: [URL: Logo] = [:]
    private var failed: Set<URL> = []
    private var loading: [URL: Task<Logo?, Never>] = [:]

    func cached(_ url: URL) -> Logo? { done[url] }

    func load(_ url: URL) async -> Logo? {
        if let logo = done[url] { return logo }
        if failed.contains(url) { return nil }
        if let task = loading[url] { return await task.value }
        let task = Task.detached(priority: .utility) { () -> Logo? in
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200, data.count < 4_000_000,
                  let image = NSImage(data: data), image.size.width > 0 else { return nil }
            let (fillsTile, light) = LogoCache.inspect(data)
            return Logo(image: image, fillsTile: fillsTile, light: light)
        }
        loading[url] = task
        let logo = await task.value
        loading[url] = nil
        if let logo { done[url] = logo } else { failed.insert(url) }
        return logo
    }

    /// Opaque edges mean the logo is its own tile (square, or rounded with see-through corners).
    /// Otherwise: is the visible mark light (needs a dark tile) or dark?
    nonisolated static func inspect(_ data: Data) -> (fillsTile: Bool, light: Bool) {
        guard let rep = NSBitmapImageRep(data: data), rep.pixelsWide > 1, rep.pixelsHigh > 1 else { return (false, false) }
        let w = rep.pixelsWide, h = rep.pixelsHigh
        func color(_ x: Int, _ y: Int) -> NSColor? { rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) }
        let inset = max(1, min(w, h) / 20)  // past any faint outline drawn around the logo
        let edges = [(w / 2, inset), (w / 2, h - 1 - inset), (inset, h / 2), (w - 1 - inset, h / 2)].compactMap { color($0.0, $0.1) }
        if edges.count == 4, edges.allSatisfy({ $0.alphaComponent > 0.9 }) { return (true, false) }
        var sum = 0.0, weight = 0.0
        let step = max(1, min(w, h) / 32)
        for y in stride(from: 0, to: h, by: step) {
            for x in stride(from: 0, to: w, by: step) {
                guard let c = color(x, y), c.alphaComponent > 0.3 else { continue }
                sum += (0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent) * c.alphaComponent
                weight += c.alphaComponent
            }
        }
        return (false, weight > 0 && sum / weight > 0.6)
    }
}

/// An app's icon in a rounded tile: its real logo, the Mac app's icon, or a symbol while loading or when it has none.
struct ConnectionIcon: View {
    let entry: ConnectionEntry
    var size: CGFloat = 30
    @Local private var logo: LogoCache.Logo?

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
        ZStack {
            switch entry.icon {
            case .logo(let url):
                if let logo = logo ?? LogoCache.shared.cached(url) {
                    shape.fill(logo.light || logo.fillsTile ? Theme.raised : Color.white)
                    Image(nsImage: logo.image).resizable().interpolation(.high).aspectRatio(contentMode: logo.fillsTile ? .fill : .fit)
                        .padding(logo.fillsTile ? 0 : size * 0.16)
                        .transition(.opacity.combined(with: .scale(scale: 0.85)))
                } else {
                    shape.fill(Theme.raised)
                    symbol("puzzlepiece.extension.fill").opacity(0.5)
                }
            case .app(let bundle, let fallback):
                if let path = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle)?.path {
                    Image(nsImage: NSWorkspace.shared.icon(forFile: path)).resizable().interpolation(.high).scaleEffect(1.16)
                } else { shape.fill(Theme.raised); symbol(fallback) }
            case .symbol(let name):
                shape.fill(Theme.raised); symbol(name)
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Theme.hairline))
        .accessibilityHidden(true)
        .task(id: entry.id) {
            guard case .logo(let url) = entry.icon, LogoCache.shared.cached(url) == nil else { return }
            let loaded = await LogoCache.shared.load(url)
            withAnimation(Motion.spring(MotionSpec.hover)) { logo = loaded }
        }
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: size * 0.44, weight: .medium)).foregroundStyle(Theme.secondary)
    }
}
