import Foundation

public struct ObservedWindow: Codable, Equatable, Sendable {
    public var id: UInt32
    public var app: String
    public var bundle: String
    public var title: String
    public var onScreen: Bool
    public init(id: UInt32, app: String, bundle: String, title: String, onScreen: Bool) {
        self.id = id; self.app = app; self.bundle = bundle; self.title = title; self.onScreen = onScreen
    }
}

/// Resolves identities without picking the frontmost window or matching unrelated app titles.
public enum WindowSelection {
    /// ScreenCaptureKit includes menu-bar strips and tiny helper surfaces as layer-zero windows.
    public static func isContentWindow(width: Double, height: Double, layer: Int) -> Bool {
        layer == 0 && width.isFinite && height.isFinite && width > 60 && height > 40
    }

    public static func matches(_ windows: [ObservedWindow], app: String, title: String?, id: UInt32?) -> [ObservedWindow] {
        func normalized(_ s: String) -> String { s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX")).split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        func appName(_ s: String) -> String {
            let n = normalized(s)
            switch n {
            case "zen browser": return "zen"
            case "chrome": return "google chrome"
            case "edge": return "microsoft edge"
            default: return n
            }
        }
        let name = appName(app)
        guard !name.isEmpty else { return [] }
        var found = windows.filter { (appName($0.app) == name || normalized($0.bundle) == name) && (id == nil || $0.id == id) }
        if let title, !normalized(title).isEmpty {
            let query = normalized(title)
            let exact = found.filter { normalized($0.title) == query }
            found = exact.isEmpty ? found.filter { normalized($0.title).contains(query) } : exact
        }
        return found.sorted { $0.id < $1.id }
    }
}
