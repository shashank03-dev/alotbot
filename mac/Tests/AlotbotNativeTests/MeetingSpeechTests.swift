import AppKit
import AVFoundation
import Foundation
import AlotbotCore
import Speech
import Testing
@testable import Alotbot

/// Speech made with `say`, read back as float32 mono at `rate`.
private func spoken(_ text: String, rate: Double, in dir: URL) throws -> AVAudioPCMBuffer {
    let aiff = dir.appendingPathComponent("\(UUID()).aiff"), wav = dir.appendingPathComponent("\(UUID()).wav")
    for (tool, args) in [("/usr/bin/say", ["-o", aiff.path, text]), ("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEF32@\(Int(rate))", "-c", "1", aiff.path, wav.path])] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        try p.run()
        p.waitUntilExit()
        #expect(p.terminationStatus == 0)
    }
    let file = try AVAudioFile(forReading: wav)
    let buf = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
    try file.read(into: buf)
    return buf
}

/// `buf` in pieces of `frames`, then 2 s of silence, as a live stream sends it.
private func pieces(_ buf: AVAudioPCMBuffer, frames: AVAudioFrameCount) -> [AVAudioPCMBuffer] {
    var out: [AVAudioPCMBuffer] = []
    let total = buf.frameLength + AVAudioFrameCount(buf.format.sampleRate * 2)
    var at: AVAudioFrameCount = 0
    while at < total {
        let n = min(frames, total - at)
        let p = AVAudioPCMBuffer(pcmFormat: buf.format, frameCapacity: n)!
        p.frameLength = n
        let src = buf.floatChannelData![0], dst = p.floatChannelData![0]
        for i in 0..<Int(n) { dst[i] = at + AVAudioFrameCount(i) < buf.frameLength ? src[Int(at) + i] : 0 }
        out.append(p)
        at += n
    }
    return out
}

@Suite struct MeetingSpeechTests {
    // Local run of 2026-11-22: a meeting's two SFSpeechRecognizer tasks ended each other at once ("no speech",
    // kAFAssistantErrorDomain 1110) and the meeting was never transcribed. The analyzer must hear both at the same time.
    @Test @MainActor func bothSidesOfAMeetingAreTranscribedAtTheSameTime() async throws {
        guard #available(macOS 26, *), SpeechTranscriber.isAvailable else { return } // no speech analyzer on this Mac
        let locale = try #require(await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")))
        // As the app does: reserve the language, or this process sees the installed model as only "supported".
        try await AssetInventory.reserve(locale: locale)
        #expect(await AssetInventory.status(forModules: [SpeechTranscriber(locale: locale, preset: .progressiveTranscription)]) == .installed) // no analyzer model on this Mac: nothing to prove
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("speech-\(UUID())")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        // The meeting arrives at 48 kHz (its capture) and your mic at 24 kHz: both are converted.
        let meetingAudio = try spoken("The quarterly revenue went up by twelve percent.", rate: 48_000, in: dir)
        let hostAudio = try spoken("We should hire two more engineers before the launch.", rate: 24_000, in: dir)
        var meeting: [String] = [], host: [String] = [], problems: [String] = []
        let m = try await AnalyzerTranscriber(label: "meeting", locale: locale, onLine: { meeting.append($0) }, onProblem: { problems.append($0) })
        let h = try await AnalyzerTranscriber(label: "host", locale: locale, onLine: { host.append($0) }, onProblem: { problems.append($0) })
        m.start()
        h.start()
        m.start() // a second start changes nothing
        let a = pieces(meetingAudio, frames: 4800), b = pieces(hostAudio, frames: 2400)
        for i in 0..<max(a.count, b.count) {
            if i < a.count { m.append(a[i]) }
            if i < b.count { h.append(b[i]) }
            try await Task.sleep(nanoseconds: 50_000_000) // 100 ms of audio every 50 ms: both streams at once
        }
        // Up to 10 s more for the last words to settle.
        for _ in 0..<100 where !(meeting.joined().lowercased().contains("revenue") && host.joined().lowercased().contains("engineers")) {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        m.stop()
        h.stop()
        m.stop() // stopping twice is fine
        m.append(a[0]) // audio after the stop goes nowhere
        let heardMeeting = meeting.joined(separator: " ").lowercased(), heardHost = host.joined(separator: " ").lowercased()
        #expect(heardMeeting.contains("revenue"))
        #expect(heardHost.contains("engineers"))
        #expect(!heardMeeting.contains("engineers") && !heardHost.contains("revenue"), "each side hears only its own audio")
        #expect(problems.isEmpty)
    }

    /// The meeting asks for both sides through `pair`; on a Mac with the analyzer and the model, it gets both.
    @Test @MainActor func aMeetingGetsBothSidesWhereTheAnalyzerIsInstalled() async throws {
        guard #available(macOS 26, *), SpeechTranscriber.isAvailable else { return } // no speech analyzer on this Mac
        let both = try await AnalyzerTranscriber.pair(onMeeting: { _ in }, onHost: { _ in }, onProblem: { _ in })
        let (m, h) = try #require(both)
        #expect(m !== h)
    }
}

/// Live, 25 Nov: you quit Zen mid-meeting and Alotbot said nothing. The capture stream went quiet instead of stopping
/// with an error, so nothing told the app the meeting was gone.
@Suite struct MeetingAppQuitTests {
    @Test @MainActor func quittingTheMeetingAppStopsTheCaptureAndSaysSoOnce() {
        let center = NotificationCenter()
        let capture = MeetingAudioCapture { _ in }
        var stopped: [String] = []
        capture.onStopped = { why, quit in stopped.append(quit ? why : "not a quit: \(why)") }
        let me = NSRunningApplication.current
        capture.watchQuit(of: MeetingApp(name: "Zen", bundleId: "app.zen-browser.zen", pid: me.processIdentifier), center: center)
        func quit(_ app: NSRunningApplication?) {
            center.post(name: NSWorkspace.didTerminateApplicationNotification, object: nil, userInfo: app.map { [NSWorkspace.applicationUserInfoKey: $0] })
        }
        quit(nil)
        #expect(stopped.isEmpty, "a note without an app is not the meeting app")
        let other = NSWorkspace.shared.runningApplications.first { $0.processIdentifier != me.processIdentifier }
        quit(other)
        #expect(stopped.isEmpty, "another app quitting is not the meeting ending")
        quit(me)
        #expect(stopped == ["Zen quit."])
        quit(me)
        #expect(stopped == ["Zen quit."], "said once, no retry")
    }

    @Test @MainActor func stoppingTheMeetingStopsWatchingTheApp() {
        let center = NotificationCenter()
        let capture = MeetingAudioCapture { _ in }
        var stopped: [String] = []
        capture.onStopped = { why, quit in stopped.append(quit ? why : "not a quit: \(why)") }
        let me = NSRunningApplication.current
        capture.watchQuit(of: MeetingApp(name: "Zen", bundleId: "z", pid: me.processIdentifier), center: center)
        capture.stop()
        center.post(name: NSWorkspace.didTerminateApplicationNotification, object: nil, userInfo: [NSWorkspace.applicationUserInfoKey: me])
        #expect(stopped.isEmpty, "you ended the meeting: the app quitting later is not news")
    }
}

/// Live, 25 Nov retest: the quit was noticed, but the message was a 3.5 s toast you never saw.
@Suite struct MeetingEndedNoticeTests {
    @Test @MainActor func theMeetingAppQuittingReachesTheEndedNoticeNotAPassingProblem() {
        let center = NotificationCenter()
        var ended: [String] = [], lost: [String] = [], problems: [String] = []
        let me = NSRunningApplication.current
        let session = MeetingSession(app: MeetingApp(name: "Zen", bundleId: "z", pid: me.processIdentifier), send: { _, _ in },
                                     problem: { problems.append($0) }, ended: { ended.append($0) }, lost: { lost.append($0) })
        session.capture.watchQuit(of: session.app, center: center)
        center.post(name: NSWorkspace.didTerminateApplicationNotification, object: nil, userInfo: [NSWorkspace.applicationUserInfoKey: me])
        #expect(ended == ["Stopped hearing the meeting: Zen quit."])
        #expect(lost.isEmpty && problems.isEmpty)
    }

    /// Review of 25 Nov: a capture error while the meeting app still runs went the "app quit" way, so a bot would say it
    /// aloud and answer aloud from then on, in a meeting that can still hear the speakers.
    @Test @MainActor func aCaptureErrorWhileTheMeetingRunsIsNotTheAppQuitting() {
        var ended: [String] = [], lost: [String] = []
        let session = MeetingSession(app: MeetingApp(name: "Zen", bundleId: "z", pid: NSRunningApplication.current.processIdentifier), send: { _, _ in },
                                     problem: { _ in }, ended: { ended.append($0) }, lost: { lost.append($0) })
        session.capture.watchQuit(of: session.app, center: NotificationCenter())
        session.capture.ended("The user declined TCCs", quit: false)
        #expect(ended.isEmpty, "no bot is asked to speak")
        #expect(lost == ["Stopped hearing the meeting: The user declined TCCs"])
    }

    /// Review of 25 Nov: after the meeting app quit, your mic still went to the meeting's transcript, so the bot you
    /// were told answers aloud ignored you unless you held the talk key.
    @Test @MainActor func afterTheMeetingAppQuitsYourMicGoesToTheBots() {
        let model = AppModel(backend: Backend(), demo: false)
        let session = MeetingSession(app: MeetingApp(name: "Zen", bundleId: "z", pid: 1), send: { _, _ in }, problem: { _ in }, ended: { _ in }, lost: { _ in })
        model.micRouter.set(route: .meeting, meeting: session)
        model.meetingMic.silenced = true
        model.meetingEnded("Stopped hearing the meeting: Zen quit.")
        #expect(model.micRouter.route == .bots)
        #expect(model.micRouter.meeting == nil)
        #expect(model.meetingMic.silenced == false)
        #expect(model.notice == "Stopped hearing the meeting: Zen quit.")
    }

    @Test @MainActor func aNoticeStaysUntilYouCloseIt() async throws {
        let model = AppModel(backend: Backend(), demo: false)
        model.stick("Stopped hearing the meeting: Zen quit.")
        model.show("Call saved.")
        #expect(model.notice == "Stopped hearing the meeting: Zen quit.")
        // The toast goes after 3.5 s (later when the machine is busy with other suites).
        for _ in 0..<100 where model.toast != nil { try await Task.sleep(for: .milliseconds(100)) }
        #expect(model.toast == nil, "a toast still goes")
        #expect(model.notice == "Stopped hearing the meeting: Zen quit.", "the notice stays")
        model.closeNotice()
        #expect(model.notice == nil)
    }
}
