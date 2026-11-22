import Testing
import AlotbotCore

@Suite struct MeetingMicLogicTests {
    typealias P = MeetingMicLogic.Process

    @Test func yourMicIsPassedThroughOnlyWhileAnotherAppListensToAlotbotMic() {
        let mic: UInt32 = 84, own: Int32 = 10, app = "me.shashankdev.alotbot"
        #expect(!MeetingMicLogic.othersListening([], device: mic, ownPid: own, ownBundle: app))
        #expect(MeetingMicLogic.othersListening([P(pid: 20, runningInput: true, inputDevices: [mic])], device: mic, ownPid: own, ownBundle: app))
        #expect(!MeetingMicLogic.othersListening([P(pid: own, runningInput: true, inputDevices: [mic])], device: mic, ownPid: own, ownBundle: app), "Alotbot itself does not count")
        #expect(!MeetingMicLogic.othersListening([P(pid: 20, runningInput: false, inputDevices: [mic])], device: mic, ownPid: own, ownBundle: app), "chosen but not listening")
        #expect(!MeetingMicLogic.othersListening([P(pid: 20, runningInput: true, inputDevices: [79])], device: mic, ownPid: own, ownBundle: app), "listening to another mic")
        // Local run of 2026-11-23: a copy of Alotbot passing your mic through is listed with Alotbot Mic among its inputs.
        #expect(!MeetingMicLogic.othersListening([P(pid: 30, bundleID: app, runningInput: true, inputDevices: [79, mic])], device: mic, ownPid: own, ownBundle: app), "another copy of Alotbot does not count")
    }

    @Test func theSourceIsYourDefaultMicNeverAlotbotMicItself() {
        let mic: UInt32 = 84
        #expect(MeetingMicLogic.source(defaultInput: 79, inputs: [79, mic], device: mic) == 79)
        #expect(MeetingMicLogic.source(defaultInput: mic, inputs: [mic, 79, 90], device: mic) == 79, "default is Alotbot Mic: the first other mic")
        #expect(MeetingMicLogic.source(defaultInput: 55, inputs: [mic, 90], device: mic) == 90, "a default that is gone")
        #expect(MeetingMicLogic.source(defaultInput: nil, inputs: [mic], device: mic) == nil, "no real mic")
    }
}
