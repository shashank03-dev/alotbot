import Foundation
import Testing
@testable import GrokCallCore

@Suite struct TranscriptSegmenterTests {
    @Test func aSentenceIsSentOnceSomethingFollowsIt() {
        var s = TranscriptSegmenter()
        #expect(s.partial("Revenue was up.", at: 0) == [], "the last sentence may still change")
        #expect(s.partial("Revenue was up. What", at: 0.5) == ["Revenue was up."])
        #expect(s.partial("Revenue was up. What drove it? Pricing", at: 1) == ["What drove it?"])
        #expect(s.partial("Revenue was up. What drove it? Pricing", at: 1.5) == [])
    }

    @Test func aPauseSendsTheRest() {
        var s = TranscriptSegmenter(pause: 1.6)
        _ = s.partial("we should ship on friday", at: 10)
        #expect(s.tick(at: 11) == [])
        #expect(s.tick(at: 11.7) == ["we should ship on friday"])
        #expect(s.tick(at: 20) == [], "nothing new")
        _ = s.partial("we should ship on friday or monday", at: 21)
        #expect(s.tick(at: 22.7) == ["or monday"])
    }

    @Test func revisedWordsAreNotSentTwiceAndTakeBacksAreSafe() {
        var s = TranscriptSegmenter(pause: 1)
        _ = s.partial("one two three", at: 0)
        #expect(s.tick(at: 1) == ["one two three"])
        // The recognizer took words back: nothing is resent, and later words still come.
        #expect(s.partial("one two", at: 2) == [])
        #expect(s.tick(at: 3) == [])
        _ = s.partial("one two four five", at: 4)
        #expect(s.tick(at: 5) == ["four five"])
    }

    @Test func longRunsWithoutPunctuationAreCut() {
        var s = TranscriptSegmenter(pause: 5, longRun: 10, chunk: 6)
        let words = (1...12).map { "w\($0)" }.joined(separator: " ")
        #expect(s.partial(words, at: 0) == ["w1 w2 w3 w4 w5 w6"])
        #expect(s.partial(words + " w13 w14 w15 w16", at: 1) == ["w7 w8 w9 w10 w11 w12"])
    }

    @Test func finishSendsTheRestAndStartsOver() {
        var s = TranscriptSegmenter()
        _ = s.partial("hello there. how are", at: 0)
        #expect(s.finish("hello there. how are you") == ["how are you"])
        #expect(s.finish(nil) == [])
        _ = s.partial("next one", at: 1)
        #expect(s.finish(nil) == ["next one"])
        _ = s.partial("a b", at: 2)
        #expect(s.tick(at: 10) == ["a b"])
        #expect(s.finish("a") == [], "already sent, and taken back")
    }
}

@Suite struct MeetingAppsTests {
    @Test func meetingAppsComeFirstThenTheRestByName() {
        let apps = [
            MeetingApp(name: "Notes", bundleId: "com.apple.Notes", pid: 5),
            MeetingApp(name: "Google Chrome", bundleId: "com.google.Chrome", pid: 3),
            MeetingApp(name: "zoom.us", bundleId: "us.zoom.xos", pid: 9),
            MeetingApp(name: "Grok Call", bundleId: "me.shashankdev.grokcall", pid: 1),
            MeetingApp(name: "agent", bundleId: "", pid: 2),
            MeetingApp(name: "", bundleId: "x.y", pid: 4),
            MeetingApp(name: "Arc", bundleId: "company.thebrowser.Browser", pid: 7),
            MeetingApp(name: "Calendar", bundleId: "com.apple.iCal", pid: 6),
            MeetingApp(name: "Google Chrome", bundleId: "com.google.Chrome", pid: 2),
        ]
        let ranked = MeetingApps.rank(apps, selfBundle: "me.shashankdev.grokcall")
        #expect(ranked.map(\.name) == ["zoom.us", "Google Chrome", "Google Chrome", "Arc", "Calendar", "Notes"])
        #expect(ranked[1].pid == 2, "two copies: the lower process id first")
        #expect(MeetingApps.browsers.contains("com.google.Chrome"))
        #expect(ranked[0].id == "us.zoom.xos#9")
    }
}

@Suite struct MicRouteTests {
    @Test func inAMeetingTheMicIsTheMeetingsUnlessYouHoldTalk() {
        #expect(MicRoute.of(inMeeting: false, talkHeld: false) == .bots)
        #expect(MicRoute.of(inMeeting: false, talkHeld: true) == .bots)
        #expect(MicRoute.of(inMeeting: true, talkHeld: false) == .meeting)
        #expect(MicRoute.of(inMeeting: true, talkHeld: true) == .bots)
    }
}

@Suite struct ScreenTextGateTests {
    @Test func normalizeDropsNoise() {
        #expect(ScreenTextGate.normalize("  Plan   A  $10 \n\n x \n10:42\n10:42 PM\n9:05:30\nTotal\t 4") == "Plan A $10\nTotal 4")
        #expect(ScreenTextGate.isClock("12:30am"))
        #expect(!ScreenTextGate.isClock("12:30 meeting"))
    }

    @Test func sendsOnlyChangesAndNotTooOften() {
        var g = ScreenTextGate(minInterval: 2)
        #expect(g.accept("Plan A", at: 0) == "Plan A")
        #expect(g.accept("Plan A  ", at: 5) == nil, "the same text")
        #expect(g.accept("Plan A\n10:43", at: 6) == nil, "only the clock moved")
        #expect(g.accept("Plan B", at: 6.5) == "Plan B")
        #expect(g.accept("Plan C", at: 7) == nil, "too soon")
        #expect(g.accept("Plan C", at: 8.5) == "Plan C")
        g.reset()
        #expect(g.accept("Plan C", at: 8.6) == "Plan C", "a new window: news again")
    }
}

@Suite struct IncomingTypesTests {
    static let state = #"""
    {"settings":{"botCallbacks":true,"jobResults":false,"approvals":true,"quietHours":{"enabled":true,"start":"22:00","end":"08:00","timezone":"Europe/London"},"doNotDisturbUntil":null,"ringSeconds":45},
     "schedules":[{"id":"s1","title":"Standup","botIds":["a","b"],"agenda":"Blockers","days":[1,2,3,4,5],"time":"09:30","timezone":"Europe/London","enabled":true,"createdAt":1,"nextAt":1795000000000}],
     "callbacks":[{"id":"c1","botId":"a","botName":"Bot A","reason":"Numbers","at":null,"waitsFor":["j1"],"createdAt":2}],
     "ringing":{"id":"r1","source":"callback","title":"Bot A is calling back","reason":"Numbers","botIds":["a"],"agenda":"","createdAt":3,"state":"ringing","until":4,"note":"","scheduleId":null},
     "held":[],"missed":[{"id":"r0","source":"job","title":"Bot B has results","reason":"Done","botIds":["b"],"agenda":"","createdAt":0,"state":"missed","until":null,"note":"Nobody answered.","scheduleId":null}],
     "quietUntil":null}
    """#

    @Test func theIncomingPushDecodes() throws {
        guard case let .incoming(s) = try ServerMessage.decode(#"{"t":"incoming","state":\#(Self.state)}"#) else { Issue.record("not incoming"); return }
        #expect(s.settings.quietHours.timezone == "Europe/London")
        #expect(s.schedules[0].nextAt == 1795000000000)
        #expect(s.callbacks[0].at == nil)
        #expect(s.ringing?.kindLabel == "Calling you back")
        #expect(s.missed[0].note == "Nobody answered.")
    }

    @Test func ringLabels() {
        func ring(_ source: String) -> IncomingRing { IncomingRing(id: "x", source: source, title: "t", reason: "r", botIds: [], agenda: "", createdAt: 0, state: "ringing", until: nil, note: "", scheduleId: nil) }
        #expect(["schedule", "callback", "job", "approval", "other"].map { ring($0).kindLabel } == ["Standing call", "Calling you back", "Has results for you", "Needs your OK", "Calling"])
    }

    @Test func heldRingsSayWhenTheyWillRing() {
        func held(_ note: String) -> String { IncomingRing(id: "x", source: "schedule", title: "t", reason: "r", botIds: [], agenda: "", createdAt: 0, state: "held", until: nil, note: note, scheduleId: "s").waitingLabel }
        #expect(held("Do not disturb was on.") == "Rings when do not disturb ends.")
        #expect(held("You were in a call.") == "Rings when your call ends.")
        #expect(held("Another call was ringing.") == "Rings after the call that is ringing now.")
        #expect(held("It was during your quiet hours.") == "Rings when your quiet hours end.")
        #expect(held("Something new.") == "Something new.")
        #expect(held("") == "Waiting to ring.")
    }

    /// "Later" rings the same call again: the backend lists it as snoozed, with when it rings.
    @Test func snoozedRingsDecodeAndSayWhenTheyRing() throws {
        let json = Self.state.replacingOccurrences(of: #""held":[]"#, with: #""held":[],"snoozed":[{"id":"r2","source":"schedule","title":"Standup","reason":"Standing call.","botIds":["a","b"],"agenda":"Blockers","createdAt":5,"state":"snoozed","until":null,"note":"Snoozed for 5 min.","scheduleId":"s1","at":1795000000000}]"#)
        guard case let .incoming(s) = try ServerMessage.decode(#"{"t":"incoming","state":\#(json)}"#) else { Issue.record("not incoming"); return }
        let r = try #require(s.snoozed?.first)
        #expect([r.title, r.scheduleId] == ["Standup", "s1"])
        #expect(r.at == 1795000000000)
        #expect(r.waitingLabel == "Snoozed. Rings again at \(Date(timeIntervalSince1970: 1795000000).formatted(date: .omitted, time: .shortened)).")
        guard case let .incoming(old) = try ServerMessage.decode(#"{"t":"incoming","state":\#(Self.state)}"#) else { Issue.record("not incoming"); return }
        #expect(old.snoozed == nil && old.ringing?.at == nil, "an older backend sends neither")
    }

    /// "Until tomorrow morning" pressed after midnight lasted until the next day's 08:00.
    @Test func doNotDisturbUntilMorningIsTheNext8am() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: "Europe/London"))
        func at(_ d: Int, _ h: Int, _ m: Int) -> Date { cal.date(from: DateComponents(year: 2026, month: 11, day: d, hour: h, minute: m))! }
        #expect(DoNotDisturb.morning(after: at(19, 23, 30), calendar: cal) == at(20, 8, 0), "evening: tomorrow")
        #expect(DoNotDisturb.morning(after: at(20, 0, 0), calendar: cal) == at(20, 8, 0), "midnight: this morning")
        #expect(DoNotDisturb.morning(after: at(20, 1, 15), calendar: cal) == at(20, 8, 0), "after midnight: this morning")
        #expect(DoNotDisturb.morning(after: at(20, 7, 59), calendar: cal) == at(20, 8, 0))
        #expect(DoNotDisturb.morning(after: at(20, 8, 0), calendar: cal) == at(21, 8, 0), "8:00 itself: tomorrow")
        #expect(DoNotDisturb.morning(after: at(20, 13, 0), calendar: cal) == at(21, 8, 0))
    }

    @Test func weekdaysInWords() {
        #expect(Weekdays.describe([1, 2, 3, 4, 5]) == "Weekdays")
        #expect(Weekdays.describe([0, 1, 2, 3, 4, 5, 6]) == "Every day")
        #expect(Weekdays.describe([6, 0]) == "Weekends")
        #expect(Weekdays.describe([0, 3, 1]) == "Mon, Wed, Sun")
        #expect(Weekdays.describe([]) == "Never")
        #expect(Weekdays.describe([9]) == "Never")
    }

    @Test func draftsAreCheckedLikeTheBackendDoes() {
        var d = StandingCallDraft(timezone: "UTC")
        #expect(d.problem == "Give it a name.")
        d.title = String(repeating: "x", count: 81)
        #expect(d.problem == "The name is longer than 80 characters.")
        d.title = "  Standup "
        #expect(d.problem == "Pick at least one bot.")
        d.botIds = (1...9).map { "b\($0)" }
        #expect(d.problem == "A standing call can have at most 8 bots.")
        d.botIds = ["a"]
        d.days = []
        #expect(d.problem == "Pick at least one day.")
        d.days = [1]
        d.hour = 24
        #expect(d.problem == "Pick a time.")
        d.hour = 7
        d.minute = 5
        d.agenda = String(repeating: "y", count: 1001)
        #expect(d.problem == "The agenda is longer than 1000 characters.")
        d.agenda = " Blockers "
        #expect(d.problem == nil)
        #expect(d.time == "07:05")
        let body = d.body
        #expect(body["title"] as? String == "Standup")
        #expect(body["agenda"] as? String == "Blockers")
        #expect(body["days"] as? [Int] == [1])
        #expect(body["id"] == nil)
        let saved = StandingCall(id: "s1", title: "Standup", botIds: ["a"], agenda: "", days: [2, 4], time: "18:45", timezone: "Asia/Kolkata", enabled: false, createdAt: 0, nextAt: nil)
        let edit = StandingCallDraft(saved)
        #expect(edit.hour == 18 && edit.minute == 45)
        #expect(edit.days == [2, 4])
        #expect(edit.body["id"] as? String == "s1")
        #expect(edit.body["enabled"] as? Bool == false)
        var odd = saved
        odd.time = "bad"
        #expect(StandingCallDraft(odd).hour == 9)
    }
}

@Suite struct LibraryTypesTests {
    @Test func pagesDecodeWithAndWithoutMatches() throws {
        let json = #"""
        {"calls":[{"id":"call-1","file":"call-1.md","kind":"meeting","startedAt":0,"endedAt":150000,"bots":["Bot A"],"summary":"S","decisions":["D"],"actionItems":[],"lineCount":3,
                   "match":{"callId":"call-1","startedAt":0,"kind":"meeting","field":"line","who":"Meeting","snippet":"the «price» is"}},
                  {"id":"call-0","file":"call-0.md","kind":"call","startedAt":0,"endedAt":0,"bots":[],"summary":"","decisions":[],"actionItems":[],"lineCount":0,"match":null}],
         "hasMore":true,"total":12}
        """#
        let page = try JSONDecoder().decode(LibraryPage.self, from: Data(json.utf8))
        #expect(page.total == 12 && page.hasMore)
        #expect(page.calls[0].isMeeting && page.calls[0].minutes == 3)
        #expect(!page.calls[1].isMeeting && page.calls[1].minutes == 0)
        #expect(Snippet.label(page.calls[0].match!) == "Meeting said")
        let call0 = #"{"id":"call-0","file":"call-0.md","kind":"call","startedAt":0,"endedAt":0,"bots":[],"summary":"","decisions":[],"actionItems":[],"lineCount":0}"#
        let detail = try JSONDecoder().decode(LibraryDetail.self, from: Data(#"{"call":\#(call0),"lines":[{"seq":1,"who":"Bot A","text":"hi","cut":false}],"markdown":null}"#.utf8))
        #expect(detail.call.match == nil, "a missing match is nil")
        #expect(detail.lines[0].id == 1)
        #expect(detail.markdown == nil)
    }

    @Test func snippetRuns() {
        #expect(Snippet.runs("the «price» is «ten»") == [.init("the ", false), .init("price", true), .init(" is ", false), .init("ten", true)])
        #expect(Snippet.runs("«open ended") == [.init("open ended", true)])
        #expect(Snippet.runs("") == [])
        #expect(Snippet.runs("»«") == [])
        func m(_ field: String, _ who: String? = nil) -> LibraryMatch { LibraryMatch(callId: "c", startedAt: 0, kind: "call", field: field, who: who, snippet: "") }
        #expect([m("summary"), m("decision"), m("action"), m("line", "Bot A"), m("line")].map(Snippet.label) == ["Summary", "Decision", "Action item", "Bot A said", "Said"])
    }
}

@Suite struct CallViewFeatureTests {
    @Test func meetingAndScreenDecodeAndAreOptional() throws {
        let base = #""phase":"in-call","muted":false,"userSpeaking":false,"waitingForHost":false,"focus":null,"bots":[],"live":null,"linesSeq":0,"tasksVersion":0"#
        guard case let .view(old) = try ServerMessage.decode(#"{"t":"view","view":{\#(base)}}"#) else { Issue.record("not a view"); return }
        #expect(old.meeting == nil && old.screen == nil)
        guard case let .view(v) = try ServerMessage.decode(#"{"t":"view","view":{\#(base),"meeting":{"app":"zoom.us","whisper":"voice"},"screen":{"app":"Safari","title":"Pricing","kind":"window","at":5}}}"#) else { Issue.record("not a view"); return }
        #expect(v.meeting == MeetingState(app: "zoom.us", whisper: "voice"))
        #expect(v.meeting!.aloud)
        #expect(v.screen!.label == "Safari: Pricing")
        #expect(SharedScreen(app: "Safari", title: "", kind: "window", at: 0).label == "Safari")
        #expect(SharedScreen(app: "Display", title: "x", kind: "display", at: 0).label == "Whole screen")
        #expect(!MeetingState(app: "a", whisper: "text").aloud)
    }

    @Test func leaveResultCarriesTheLibraryIdWhenThereIsOne() throws {
        let new = try JSONDecoder().decode(LeaveResult.self, from: Data(#"{"file":"call-1.md","id":"call-1","summary":"S","decisions":["D"],"actionItems":[]}"#.utf8))
        #expect(new.id == "call-1" && new.decisions == ["D"])
        let old = try JSONDecoder().decode(LeaveResult.self, from: Data(#"{"file":null,"summary":"","actionItems":[]}"#.utf8))
        #expect(old.id == nil && old.decisions == nil)
    }
}
