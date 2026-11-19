import Foundation
import Testing
@testable import AlotbotCore

@Suite struct StageLayoutTests {
    func ids(_ n: Int) -> [String] { (0..<n).map { "b\($0)" } }

    @Test(arguments: [
        // bots, columns, rows in a wide 1100 × 560 area (host counts as a tile)
        (0, 1, 1), (1, 2, 1), (2, 3, 1), (3, 2, 2), (4, 3, 2), (5, 3, 2), (6, 4, 2), (7, 4, 2), (8, 3, 3), (11, 4, 3), (12, 5, 3),
    ])
    func gridFitsTheCount(bots: Int, cols: Int, rows: Int) {
        let l = StageLayout(botIds: ids(bots), width: 1100, height: 560)
        #expect(l.columns == cols)
        #expect(l.rows == rows)
        #expect(l.columns * l.rows >= bots + 1)
        #expect(l.centers.count == bots + 1)
    }

    @Test func tilesStayInsideTheArea() {
        for n in 0...15 {
            for (w, h) in [(1100.0, 560.0), (600.0, 700.0), (300.0, 200.0)] {
                let l = StageLayout(botIds: ids(n), width: w, height: h)
                #expect(abs(l.tileWidth / l.tileHeight - StageLayout.aspect) < 1e-9)
                for c in l.centers.values {
                    #expect(Double(c.x) - l.tileWidth / 2 >= -1e-9)
                    #expect(Double(c.x) + l.tileWidth / 2 <= w + 1e-9)
                    #expect(Double(c.y) - l.tileHeight / 2 >= -1e-9)
                    #expect(Double(c.y) + l.tileHeight / 2 <= h + 1e-9)
                }
            }
        }
    }

    @Test func tilesDontOverlap() {
        let l = StageLayout(botIds: ids(7), width: 1100, height: 560)
        let c = Array(l.centers.values)
        for i in c.indices { for j in c.indices where j > i {
            let apart = abs(c[i].x - c[j].x) >= l.tileWidth - 1e-9 || abs(c[i].y - c[j].y) >= l.tileHeight - 1e-9
            #expect(apart)
        } }
    }

    @Test func hostComesFirstAndShortRowIsCentered() {
        // 4 tiles in 3 columns: a full row, then one tile in the middle under the middle tile.
        let l = StageLayout(botIds: ["a", "b", "c"], width: 1100, height: 560)
        #expect(l.ids == ["host", "a", "b", "c"])
        let host = l.centers["host"]!, a = l.centers["a"]!, c = l.centers["c"]!
        #expect(l.columns == 2)
        #expect(host.y == a.y)
        #expect(host.x < a.x)
        #expect(c.y > host.y)
        let five = StageLayout(botIds: ids(4), width: 1100, height: 560) // 5 tiles: 3 + 2
        #expect(five.columns == 3)
        let mid = (five.centers["b2"]!.x + five.centers["b3"]!.x) / 2
        #expect(abs(mid - 550) < 1e-9)
    }

    @Test func tallAreaStacks() {
        let l = StageLayout(botIds: ["a"], width: 300, height: 700)
        #expect(l.columns == 1)
        #expect(l.rows == 2)
    }

    @Test func emptyAreaGivesZeroTiles() {
        let l = StageLayout(botIds: ["a"], width: 0, height: 0)
        #expect(l.tileWidth == 0)
        #expect(l.tileHeight == 0)
        #expect(l.centers.count == 2)
        #expect(l.centers["host"] == l.centers["a"])
    }

    @Test func gazePointsAtTheTarget() {
        let l = StageLayout(botIds: ["a", "b", "c"], width: 1100, height: 560) // 2 × 2: host a / b c
        #expect(l.gaze(from: "host", to: "a") == GazeTarget(x: 1, y: 0))
        #expect(l.gaze(from: "a", to: "host") == GazeTarget(x: -1, y: 0))
        #expect(l.gaze(from: "host", to: "b") == GazeTarget(x: 0, y: 1))
        let diag = l.gaze(from: "c", to: "host")!
        #expect(diag.x < 0 && diag.y < 0)
        #expect(abs(diag.x * diag.x + diag.y * diag.y - 1) < 1e-9)
    }

    @Test func gazeLooksAheadWhenItCant() {
        let l = StageLayout(botIds: ["a", "b"], width: 1100, height: 560)
        #expect(l.gaze(from: "a", to: nil) == nil)
        #expect(l.gaze(from: "a", to: "a") == nil)
        #expect(l.gaze(from: "a", to: "gone") == nil)
        #expect(l.gaze(from: "gone", to: "a") == nil)
        // Zero-size area: every tile sits on the same point, so there's no direction.
        let flat = StageLayout(botIds: ["a", "b"], width: 0, height: 0)
        #expect(flat.gaze(from: "a", to: "b") == nil)
    }

    func view(user: Bool = false, muted: Bool = false, statuses: [String]) -> CallView {
        CallView(phase: "in-call", muted: muted, userSpeaking: user, waitingForHost: false, focus: nil,
                 bots: statuses.enumerated().map { CallBot(id: "\($0.offset)", name: "B\($0.offset)", color: nil, shape: nil, status: $0.element, error: nil, search: false, looksAt: nil) },
                 live: nil, linesSeq: 0, tasksVersion: 0)
    }

    @Test func speaker() {
        #expect(StageLayout.speaker(nil) == nil)
        #expect(StageLayout.speaker(view(statuses: ["idle", "thinking"])) == nil)
        #expect(StageLayout.speaker(view(statuses: ["idle", "speaking"])) == "1")
        #expect(StageLayout.speaker(view(user: true, statuses: ["speaking"])) == "host")
        #expect(StageLayout.speaker(view(user: true, muted: true, statuses: ["speaking"])) == "0")
    }
}
