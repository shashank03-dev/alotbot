import Foundation
import Testing
@testable import GrokCall

@Suite struct ScreenShareTests {
    /// A whole-display share leaves out this app and every password manager, matched by name or bundle id.
    @Test func displayShareLeavesOutPasswordManagersAndThisApp() {
        let me: pid_t = 10
        #expect(ShareTarget.hiddenFromDisplay(pid: me, name: "Grok Call", bundleId: "dev.grokcall", me: me))
        #expect(ShareTarget.hiddenFromDisplay(pid: 11, name: "1Password", bundleId: "com.1password.1password", me: me))
        #expect(ShareTarget.hiddenFromDisplay(pid: 12, name: "Passwords", bundleId: "com.apple.Passwords", me: me))
        #expect(ShareTarget.hiddenFromDisplay(pid: 13, name: "Keychain Access", bundleId: "com.apple.keychainaccess", me: me))
        #expect(ShareTarget.hiddenFromDisplay(pid: 14, name: "Vault", bundleId: "com.bitwarden.desktop", me: me), "renamed, but its bundle id gives it away")
        #expect(!ShareTarget.hiddenFromDisplay(pid: 15, name: "Safari", bundleId: "com.apple.Safari", me: me))
        #expect(!ShareTarget.hiddenFromDisplay(pid: 16, name: "", bundleId: "", me: me))
    }
}
