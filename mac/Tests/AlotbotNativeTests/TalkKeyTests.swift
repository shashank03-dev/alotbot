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

    // Local run of 2026-11-22: you let go of the talk key while the bot's voice service still heard you speaking; with no
    // more audio it never heard the silence that ends a turn, so 8 s later the call gave up and prompted the bot, which
    // said its last answer again. Letting go now ends your turn with a second of silence.
    @Test @MainActor func lettingGoOfTheTalkKeyEndsYourTurnWithSilence() {
        let model = AppModel()
        var sent: [Data] = []
        model.sendMic = { sent.append($0) }
        model.view = CallView(phase: "in-call", muted: false, userSpeaking: false, waitingForHost: false, focus: nil, bots: [], live: nil, linesSeq: 0, tasksVersion: 0)
        model.view?.meeting = MeetingState(app: "Zoom", whisper: "text")
        model.setTalk(true)
        #expect(sent.isEmpty, "pressing sends nothing by itself")
        #expect(model.meetingMic.silenced, "a meeting listening to Alotbot Mic hears silence while you talk to the bots")
        model.setTalk(false)
        let samples = sent.reduce(0) { $0 + ($1.count - 5) / 2 }
        #expect(samples == Int(AudioFrames.sampleRate), "one second of audio")
        #expect(sent.allSatisfy { $0.first == AudioFrames.mic && $0.dropFirst(5).allSatisfy { $0 == 0 } }, "mic frames of silence")
        #expect(!model.meetingMic.silenced, "and hears you again once you let go")
        model.setTalk(false)
        #expect(samples == sent.reduce(0) { $0 + ($1.count - 5) / 2 }, "letting go twice sends it once")
    }
}
