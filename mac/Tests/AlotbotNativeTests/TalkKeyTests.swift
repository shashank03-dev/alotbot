import Combine
import Foundation
import Testing
import AlotbotCore
@testable import Alotbot

@Suite struct TalkKeyTests {
    /// ⌥Space was registered at launch and swallowed in every app, even with no meeting on.
    @Test @MainActor func theTalkKeyIsWantedOnlyDuringAMeeting() {
        let model = AppModel()
        var wanted: [Bool] = []
        let sub = model.talkKeyWanted.sink { wanted.append($0) }
        defer { sub.cancel() }
        func view(_ meeting: MeetingState?) -> CallView {
            CallView(phase: "in-call", muted: false, userSpeaking: false, waitingForHost: false, focus: nil, bots: [], live: nil, linesSeq: 0, tasksVersion: 0, meeting: meeting)
        }
        model.view = nil
        model.view = view(nil)
        model.view = view(MeetingState(app: "Zoom", whisper: "text"))
        model.view = view(MeetingState(app: "Zoom", whisper: "voice"))
        model.view = nil
        #expect(wanted == [false, true, false], "a plain call does not need it; a meeting does, until it ends")
    }

    @Test @MainActor func theTalkKeyIsRegisteredWhileWantedAndReleasedAfter() {
        final class Key {}
        let wanted = PassthroughSubject<Bool, Never>()
        var made = 0, available: [Bool] = []
        weak var last: Key?
        let talk = TalkKeySwitch(wanted: wanted.eraseToAnyPublisher(), make: {
            made += 1
            let k = Key()
            last = k
            return (k, made == 1)
        }, registered: { available.append($0) })
        #expect(!talk.isOn && made == 0, "nothing is registered at launch")
        wanted.send(true)
        #expect(talk.isOn && made == 1 && available == [true])
        wanted.send(true)
        #expect(made == 1, "registered once per meeting")
        wanted.send(false)
        #expect(!talk.isOn && last == nil, "released, so it is unregistered")
        wanted.send(true)
        #expect(made == 2 && available == [true, false], "taken by another app this time")
    }
}

@Suite struct TalkButtonTests {
    /// "Hold to talk" was a drag gesture only, so VoiceOver and the keyboard could not use it. They toggle it instead.
    @Test @MainActor func toggleTalkTurnsTalkingOnAndOffOnlyInAMeeting() {
        let model = AppModel()
        model.view = CallView(phase: "in-call", muted: false, userSpeaking: false, waitingForHost: false, focus: nil, bots: [], live: nil, linesSeq: 0, tasksVersion: 0)
        model.toggleTalk()
        #expect(!model.talkHeld, "no meeting: nothing to talk over")
        model.view?.meeting = MeetingState(app: "Zoom", whisper: "text")
        model.toggleTalk()
        #expect(model.talkHeld)
        model.toggleTalk()
        #expect(!model.talkHeld)
    }
}
