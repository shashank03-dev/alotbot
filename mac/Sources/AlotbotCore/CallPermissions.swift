import Foundation

public struct CallPermissionState: Equatable, Sendable {
    public let viewingEnabled: Bool
    public let screenAvailable: Bool
    public let accessibilityAvailable: Bool
}

/// Persists request attempts, never OS grants. Current access is checked again on every call.
@MainActor public final class CallPermissionSetup {
    private let defaults: UserDefaults
    private static let screenRequested = "callScreenPermissionRequested"
    private static let accessibilityRequested = "callAccessibilityPermissionRequested"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// `accessibilityUsable` is false where the window tools can't run (before macOS 15.2): Accessibility is then never asked for.
    public func prepare(screenAllowed: () -> Bool, requestScreen: () -> Void, accessibilityAllowed: () -> Bool, requestAccessibility: () -> Void, accessibilityUsable: Bool = true) -> CallPermissionState {
        if defaults.object(forKey: "backgroundAppViewing") == nil { defaults.set(true, forKey: "backgroundAppViewing") }
        let viewing = defaults.bool(forKey: "backgroundAppViewing")
        if viewing && !defaults.bool(forKey: Self.screenRequested) {
            defaults.set(true, forKey: Self.screenRequested)
            if !screenAllowed() { requestScreen() }
        }
        if accessibilityUsable && !defaults.bool(forKey: Self.accessibilityRequested) {
            defaults.set(true, forKey: Self.accessibilityRequested)
            if !accessibilityAllowed() { requestAccessibility() }
        }
        return CallPermissionState(viewingEnabled: viewing, screenAvailable: screenAllowed(), accessibilityAvailable: accessibilityAllowed())
    }

    /// Explicit Settings actions may request again; automatic call setup must not repeat them.
    public func markScreenRequestAttempted() { defaults.set(true, forKey: Self.screenRequested) }

    /// For a "Turn on" button: true only the first time, so macOS shows its own prompt once.
    /// After that only System Settings can change the answer.
    public func claimPrompt(screen: Bool) -> Bool {
        let key = screen ? Self.screenRequested : Self.accessibilityRequested
        defer { defaults.set(true, forKey: key) }
        return !defaults.bool(forKey: key)
    }
}

/// The macOS permissions Alotbot uses, with the System Settings page for each.
public enum MacPermission: String, CaseIterable, Sendable {
    case microphone, screen, accessibility
    public var settingsURL: URL {
        let page = switch self { case .microphone: "Privacy_Microphone"; case .screen: "Privacy_ScreenCapture"; case .accessibility: "Privacy_Accessibility" }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(page)")!
    }
}

/// Starts the app again after this process exits. Waiting for the exit matters:
/// opening while the old copy is still alive would only bring that copy forward.
public enum Relaunch {
    public static func arguments(pid: Int32, app: String) -> [String] {
        ["-c", "while kill -0 \(pid) 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open \"$0\"", app]
    }
}
