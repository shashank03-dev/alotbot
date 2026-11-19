import Foundation
import Testing
@testable import Alotbot

@Suite struct ScreenShareTests {
    /// A whole-display share leaves out this app and every password manager, matched by name or bundle id.
    @Test func displayShareLeavesOutPasswordManagersAndThisApp() {
        let me: pid_t = 10
        #expect(ShareTarget.hiddenFromDisplay(pid: me, name: "Alotbot", bundleId: "dev.alotbot", me: me))
        #expect(ShareTarget.hiddenFromDisplay(pid: 11, name: "1Password", bundleId: "com.1password.1password", me: me))
        #expect(ShareTarget.hiddenFromDisplay(pid: 12, name: "Passwords", bundleId: "com.apple.Passwords", me: me))
        #expect(ShareTarget.hiddenFromDisplay(pid: 13, name: "Keychain Access", bundleId: "com.apple.keychainaccess", me: me))
        #expect(ShareTarget.hiddenFromDisplay(pid: 14, name: "Vault", bundleId: "com.bitwarden.desktop", me: me), "renamed, but its bundle id gives it away")
        #expect(!ShareTarget.hiddenFromDisplay(pid: 15, name: "Safari", bundleId: "com.apple.Safari", me: me))
        #expect(!ShareTarget.hiddenFromDisplay(pid: 16, name: "", bundleId: "", me: me))
    }

    /// A browser tab titled like a password vault was still captured in a whole-display share: only apps were left out.
    @Test func displayShareLeavesOutPrivateWindowsOfAnyApp() {
        let me: pid_t = 10
        let windows = [
            ShareTarget.WindowInfo(id: 1, pid: 20, app: "Safari", bundleId: "com.apple.Safari", title: "Bitwarden Web Vault"),
            ShareTarget.WindowInfo(id: 2, pid: 20, app: "Safari", bundleId: "com.apple.Safari", title: "Pricing page"),
            ShareTarget.WindowInfo(id: 3, pid: 21, app: "1Password", bundleId: "com.1password.1password", title: ""),
            ShareTarget.WindowInfo(id: 4, pid: me, app: "Alotbot", bundleId: "dev.alotbot", title: "Call"),
            ShareTarget.WindowInfo(id: 5, pid: 22, app: "Google Chrome", bundleId: "com.google.Chrome", title: "1password.com — Sign in"),
            ShareTarget.WindowInfo(id: 6, pid: nil, app: "", bundleId: "", title: ""),
            ShareTarget.WindowInfo(id: 7, pid: nil, app: "", bundleId: "", title: "LastPass"),
        ]
        #expect(ShareTarget.hiddenWindows(windows, me: me) == [1, 3, 4, 5, 7])
        #expect(ShareTarget.hiddenWindows([], me: me).isEmpty)
    }
}
