import Foundation
import Testing
@testable import GrokCallCore

@Suite struct ColorTests {
    @Test func hexForms() {
        #expect(RGB(hex: "#FFFFFF") == RGB(1, 1, 1))
        #expect(RGB(hex: "fff") == RGB(1, 1, 1))
        #expect(RGB(hex: " #000 ") == RGB(0, 0, 0))
        #expect(RGB(hex: "#1084FE") == RGB(16.0 / 255, 132.0 / 255, 254.0 / 255))
    }

    @Test func badHex() {
        #expect(RGB(hex: "#12345") == nil)
        #expect(RGB(hex: "zzzzzz") == nil)
        #expect(RGB(hex: "") == nil)
    }

    @Test func mix() {
        #expect(RGB(0, 0, 0).mix(RGB(1, 1, 1), 0.5) == RGB(0.5, 0.5, 0.5))
    }

    @Test func bodyColors() {
        #expect(Palette.body("black") == RGB(0.86, 0.86, 0.88)) // black would vanish on the dark pill
        #expect(Palette.body("black", onDark: false) == RGB(0, 0, 0))
        #expect(Palette.body("blue") == RGB(hex: "#1084FE"))
        #expect(Palette.body(nil) == .gray)
        #expect(Palette.body("plaid") == .gray)
    }

    @Test func eyeColors() {
        #expect(Palette.eyes("black") == RGB(0.07, 0.07, 0.07))
        #expect(Palette.eyes("black", onDark: false) == RGB(1, 1, 1))
        #expect(Palette.eyes("red") == RGB(1, 1, 1))
    }

    @Test func ringStopsCloseTheLoop() {
        #expect(Palette.ringStops([]) == [.gray, .gray])
        let stops = Palette.ringStops(["red", "blue"])
        #expect(stops.count == 3)
        #expect(stops.first == stops.last)
        #expect(stops[1] == Palette.body("blue"))
    }
}

@Suite struct InitialsTests {
    @Test(arguments: [
        ("Shashank's X bot", "SX"), ("My Bot", "MB"), ("Eve", "EV"), ("Research Team Bots", "RT"),
        ("Ann Lee Smith", "AS"), ("x", "X"), ("Bob’s Helper", "BH"),
    ])
    func initials(name: String, expected: String) {
        #expect(Names.initials(name) == expected)
    }
}

@Suite struct PillLayoutTests {
    let seven = ["a", "b", "c", "d", "e", "f", "g"]

    @Test func threeBots() {
        let l = PillLayout(botIds: ["a", "b", "c"])
        #expect(l.shown == ["a", "b", "c"])
        #expect(l.overflow == 0)
        #expect(l.hostX == 40)
        #expect(l.botX == [94, 148, 202])
        #expect(l.overflowX == nil)
        #expect(l.width == 596) // 224 + 26 + 5 buttons of 56 + 4 gaps of 12 + 18
    }

    @Test func noBots() {
        let l = PillLayout(botIds: [])
        #expect(l.shown.isEmpty)
        #expect(l.botX.isEmpty)
        #expect(l.overflowX == nil)
        #expect(l.width == 434) // 62 + 26 + 280 + 48 + 18
    }

    @Test func fiveFitWithoutBubble() {
        let l = PillLayout(botIds: Array(seven.prefix(5)))
        #expect(l.overflow == 0)
        #expect(l.overflowX == nil)
    }

    @Test func extraBotsFoldIntoBubble() {
        let l = PillLayout(botIds: seven)
        #expect(l.shown == ["a", "b", "c", "d", "e"])
        #expect(l.overflow == 2)
        #expect(l.overflowX == 364)
        #expect(l.x(of: "g") == 364) // folded bots sit at the bubble
    }

    @Test func showingAllKeepsBubbleToFoldBack() {
        let l = PillLayout(botIds: seven, expandedOverflow: true)
        #expect(l.shown == seven)
        #expect(l.overflow == 0)
        #expect(l.overflowX == 472)
        #expect(PillLayout(botIds: ["a", "b"], expandedOverflow: true).overflowX == nil)
    }

    @Test func positions() {
        let l = PillLayout(botIds: ["a", "b"])
        #expect(l.x(of: "host") == 40)
        #expect(l.x(of: "b") == 148)
        #expect(l.x(of: "zzz") == nil)
    }

    @Test func gaze() {
        let l = PillLayout(botIds: ["a", "b", "c"])
        #expect(l.gaze(from: "b", to: "host") == GazeTarget(x: -1, y: 0.15))
        #expect(l.gaze(from: "b", to: "a") == GazeTarget(x: -1, y: 0.15))
        #expect(l.gaze(from: "b", to: "c") == GazeTarget(x: 1, y: 0.15))
        #expect(l.gaze(from: "b", to: nil) == nil)
        #expect(l.gaze(from: "b", to: "b") == nil)
        // A bot not in the pill still looks toward the host when told to.
        #expect(l.gaze(from: "gone", to: "host") == GazeTarget(x: -1, y: 0.2))
        #expect(l.gaze(from: "gone", to: "a") == nil)
    }

    @Test func foldedBotsLookingAtEachOtherLookAhead() {
        let l = PillLayout(botIds: seven)
        #expect(l.gaze(from: "f", to: "g") == nil)
    }
}

@Suite struct CallStateTests {
    func view(user: Bool = false, muted: Bool = false, statuses: [String]) -> CallView {
        CallView(phase: "in-call", muted: muted, userSpeaking: user, waitingForHost: false, focus: nil,
                 bots: statuses.enumerated().map { CallBot(id: "\($0.offset)", name: "B\($0.offset)", color: nil, shape: nil, status: $0.element, error: nil, search: false, looksAt: nil) },
                 live: nil, linesSeq: 0, tasksVersion: 0)
    }

    @Test(arguments: [("speaking", AvatarState.speaking), ("thinking", .thinking), ("listening", .listening), ("idle", .idle), ("connecting", .idle), ("error", .idle)])
    func avatarStates(status: String, expected: AvatarState) {
        #expect(avatarState(for: status) == expected)
    }

    @Test func ring() {
        #expect(ringMode(nil) == .rest)
        #expect(ringMode(view(statuses: ["idle", "listening"])) == .rest)
        #expect(ringMode(view(statuses: ["idle", "speaking"])) == .spin)
        #expect(ringMode(view(statuses: ["thinking"])) == .spin)
        #expect(ringMode(view(user: true, statuses: ["speaking"])) == .strobe)
        // Muted talking doesn't count as talking.
        #expect(ringMode(view(user: true, muted: true, statuses: ["idle"])) == .rest)
        #expect(ringMode(view(user: true, muted: true, statuses: ["speaking"])) == .spin)
    }

    @Test func clock() {
        let c = ClockMap(localAtHello: 100, serverAtHello: 40)
        #expect(c.offset == 60)
        #expect(c.local(50) == 110)
    }
}

@Suite struct TaskSortTests {
    func t(_ id: Int, _ owner: String?, _ status: String = "open", parent: Int? = nil) -> TaskItem {
        TaskItem(id: id, title: "T\(id)", owner: owner, status: status, parent: parent, waitsOn: [], by: "Me", doneBy: nil, blockedBy: [])
    }

    var tasks: [TaskItem] {
        [t(1, "Me", "doing"), t(2, "zed", "done", parent: 1), t(3, "Alpha", parent: 1), t(4, "zed"), t(5, nil), t(6, "Alpha", "done"), t(7, "Me", "done")]
    }

    @Test func allTasksGroupedHostFirstUnownedLast() {
        let g = TaskSort.groups(tasks, host: "Me", openOnly: false)
        #expect(g.map(\.owner) == ["Me", "Alpha", "zed", nil])
        #expect(g[0].items.map(\.id) == [1, 7])
        #expect(g[0].items[0].parts.map(\.id) == [2, 3]) // parts stay under their parent, whoever owns them
        #expect(g[1].items.map(\.id) == [6]) // Alpha's part #3 isn't listed again at the top
        #expect(g[3].id == "\u{0}nobody")
        #expect(g[0].id == "Me")
    }

    @Test func openOnlyHidesDone() {
        let g = TaskSort.groups(tasks, host: "Me", openOnly: true)
        #expect(g.map(\.owner) == ["Me", "zed", nil])
        #expect(g[0].items.map(\.id) == [1])
        #expect(g[0].items[0].parts.map(\.id) == [3])
    }

    @Test func emptyList() {
        #expect(TaskSort.groups([], host: "Me", openOnly: true).isEmpty)
    }

    @Test func botCardOrder() {
        let list = [t(9, "A", "open"), t(3, "A", "done"), t(5, "A", "doing"), t(2, "A", "open"), t(1, "B", "doing")]
        #expect(TaskSort.forBot(list, name: "A").map(\.id) == [5, 2, 9, 3])
        #expect(TaskSort.forBot(list, name: "Nobody").isEmpty)
    }
}
