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

    /// A window title over 300 characters was refused by the backend, after the app had already stopped the old share.
    @Test func screenShareArgsFitTheBackendLimits() {
        let long = ShareTarget(kind: .window, app: "Safari", title: "  Very   long\n" + String(repeating: "x", count: 400), windowID: 1, displayID: nil)
        let args = long.screenShareArgs
        let title = args["title"] as? String ?? ""
        #expect(title.count == 300)
        #expect(title.hasPrefix("Very long x"), "spaces collapsed as the backend does before it counts")
        #expect(args["app"] as? String == "Safari")
        #expect(args["kind"] as? String == "window")
        let app = ShareTarget(kind: .display, app: String(repeating: "a", count: 150), title: "", windowID: nil, displayID: 1).screenShareArgs
        #expect((app["app"] as? String)?.count == 100)
        #expect(app["title"] as? String == "")
        let emoji = ShareTarget(kind: .window, app: "Notes", title: String(repeating: "x", count: 299) + "🙂🙂", windowID: 2, displayID: nil).screenShareArgs
        #expect(emoji["title"] as? String == String(repeating: "x", count: 299), "counted as the backend counts, and never split")
    }

    /// A read still on its way when the share was switched away from (or stopped) found its window gone and ended
    /// sharing: the stop it reported ended the new share instead. A stopped session reports nothing.
    @MainActor @Test func aStoppedShareNeverReportsThatItEnded() async {
        final class Box { var stops: [String] = []; var reads = 0; var waiting: CheckedContinuation<Void, Never>? }
        let target = ShareTarget(kind: .window, app: "Mail", title: "Inbox", windowID: 1, displayID: nil)
        func session(_ box: Box) -> ScreenShareSession {
            ScreenShareSession(target: target, send: { _ in true }, stopped: { box.stops.append($0) }, read: { _ in
                box.reads += 1
                await withCheckedContinuation { box.waiting = $0 }
                throw ScreenShareSession.ShareEnded(why: "The shared window closed, so sharing stopped.")
            })
        }
        // Still sharing: the end is reported.
        let live = Box()
        let a = session(live)
        a.start()
        while live.waiting == nil { await Task.yield() }
        live.waiting?.resume()
        for _ in 0..<200 where live.stops.isEmpty { await Task.yield() }
        #expect(live.stops == ["The shared window closed, so sharing stopped."])
        // Stopped while its read was on its way: nothing is reported.
        let switched = Box()
        let b = session(switched)
        b.start()
        while switched.waiting == nil { await Task.yield() }
        b.stop()
        switched.waiting?.resume()
        for _ in 0..<200 { await Task.yield() }
        #expect(switched.stops.isEmpty)
        #expect(switched.reads == 1)
    }

    /// Live, 25 Nov: after renaming the shared TextEdit window, one read failed and the next never finished. For 6
    /// minutes nothing was read and nothing was said, while the pill still showed TextEdit as shared.
    @MainActor @Test func aReadThatNeverFinishesDoesNotFreezeSharing() async {
        final class Box { var stops: [String] = []; var reads = 0; var sent = 0 }
        let box = Box()
        let s = ScreenShareSession(target: ShareTarget(kind: .window, app: "TextEdit", title: "notes.txt", windowID: 1, displayID: nil),
                                   send: { _ in box.sent += 1; return true }, stopped: { box.stops.append($0) }, read: { _ in
            box.reads += 1
            // The first read hangs for good; it is waited for, not started again on top of itself.
            if box.reads == 1 { try await Task.sleep(for: .seconds(3600)) }
        }, readLimit: 0.2)
        s.start()
        for _ in 0..<200 where box.stops.isEmpty { try? await Task.sleep(for: .milliseconds(50)) }
        #expect(box.stops == ["Couldn't read the shared screen: it stopped responding (reading the screen)."])
        #expect(box.reads == 1, "a stuck read is not started again on top of itself")
    }

    @MainActor @Test func aSlowReadThatFinishesInTimeIsFine() async {
        final class Box { var stops: [String] = []; var reads = 0 }
        let box = Box()
        let s = ScreenShareSession(target: ShareTarget(kind: .window, app: "TextEdit", title: "notes.txt", windowID: 1, displayID: nil),
                                   send: { _ in true }, stopped: { box.stops.append($0) }, read: { _ in
            box.reads += 1
            // Over the limit once, then it finishes: the share goes on.
            if box.reads == 1 { try await Task.sleep(for: .milliseconds(300)) }
        }, readLimit: 0.2)
        s.start()
        for _ in 0..<200 where box.reads < 3 { try? await Task.sleep(for: .milliseconds(50)) }
        s.stop()
        #expect(box.reads >= 3)
        #expect(box.stops.isEmpty)
    }

    /// The same for a third failed read in a row (which ends a share that is still on): stopped first, it reports nothing.
    @MainActor @Test func aStoppedShareNeverReportsItsThirdFailedRead() async {
        final class Box { var stops: [String] = []; var reads = 0; var waiting: CheckedContinuation<Void, Never>? }
        struct Unreadable: Error {}
        let box = Box()
        let s = ScreenShareSession(target: ShareTarget(kind: .window, app: "Mail", title: "Inbox", windowID: 1, displayID: nil), send: { _ in true },
                                   stopped: { box.stops.append($0) }, read: { _ in
            box.reads += 1
            if box.reads == 3 { await withCheckedContinuation { box.waiting = $0 } }
            throw Unreadable()
        })
        s.start()
        while box.waiting == nil { try? await Task.sleep(for: .milliseconds(50)) }
        s.stop()
        box.waiting?.resume()
        for _ in 0..<200 { await Task.yield() }
        #expect(box.reads == 3)
        #expect(box.stops.isEmpty)
    }
}
