import AVFoundation
import CoreMedia
import Foundation
import AlotbotCore
import ScreenCaptureKit
import Speech

/// One audio stream turned into lines on this Mac: the meeting, or your mic while you talk in the meeting.
protocol SpeechStream: AnyObject, Sendable {
    @MainActor func start()
    @MainActor func stop()
    /// Audio, from any thread (the mic tap or the meeting's capture queue).
    func append(_ buffer: AVAudioPCMBuffer)
}

/// Live on-device speech-to-text for one audio stream: the meeting, or your mic while you talk in the meeting. The
/// audio never leaves this Mac: if this Mac can't recognize speech on device, it says so and doesn't fall back to a
/// server. Two of these at once knock each other out (each ends the other with "no speech", kAFAssistantErrorDomain
/// 1110: seen on macOS 27), so a meeting uses only one; `AnalyzerTranscriber` does both sides where it can.
final class LiveTranscriber: SpeechStream, @unchecked Sendable {
    enum Problem: LocalizedError {
        case denied, unavailable(String), failing
        var errorDescription: String? {
            switch self {
            case .denied: return "Speech Recognition is off for Alotbot. Turn it on in System Settings › Privacy & Security › Speech Recognition."
            case .unavailable(let s): return s
            case .failing: return "Speech recognition keeps failing on this Mac, so the meeting is no longer transcribed. Leave and start again."
            }
        }
    }

    /// Asks once; true when allowed.
    static func authorize() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined: return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        default: return false
        }
    }

    /// Recognitions restart this often, so one never grows without end.
    static let restartSeconds = 55.0

    private let recognizer: SFSpeechRecognizer
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    // The rest is used on the main thread only.
    private var segmenter = TranscriptSegmenter()
    private var timer: Timer?
    private var startedAt = Date()
    private var running = false
    private var generation = 0
    /// Recognitions that failed right after starting, in a row.
    private var quickFailures = 0
    private let onLine: (String) -> Void
    private let onProblem: (String) -> Void
    /// Which side this is ("meeting" or "host"), for the app log.
    private let label: String

    init(label: String = "", locale: Locale = .current, onLine: @escaping (String) -> Void, onProblem: @escaping (String) -> Void) throws {
        guard let r = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
            throw Problem.unavailable("Speech recognition isn't available on this Mac.")
        }
        guard r.supportsOnDeviceRecognition else {
            throw Problem.unavailable("On-device speech recognition isn't installed for \(r.locale.identifier). Turn on Dictation in System Settings › Keyboard, let it finish downloading, then try again.")
        }
        recognizer = r
        self.label = label
        self.onLine = onLine
        self.onProblem = onProblem
    }

    @MainActor func start() {
        guard !running else { return }
        running = true
        quickFailures = 0
        begin()
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
    }

    @MainActor func stop() {
        guard running else { return }
        running = false
        timer?.invalidate()
        timer = nil
        end()
        emit(segmenter.finish(nil))
    }

    /// Audio, from any thread (the mic tap or the meeting's capture queue).
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        request?.append(buffer)
        lock.unlock()
    }

    @MainActor private func begin() {
        generation += 1
        let gen = generation
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.addsPunctuation = true
        req.taskHint = .dictation
        startedAt = Date()
        let t = recognizer.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            // The domain and code only: never words from the meeting.
            let why = (error as NSError?).map { "\($0.domain) \($0.code)" }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.handle(gen, text: text, final: final, failed: failed, why: why) } }
        }
        lock.lock()
        request = req
        task = t
        lock.unlock()
    }

    @MainActor private func end() {
        lock.lock()
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        lock.unlock()
    }

    @MainActor private func handle(_ gen: Int, text: String?, final: Bool, failed: Bool, why: String? = nil) {
        guard gen == generation, running else { return }
        if let text, !final { quickFailures = 0; emit(segmenter.partial(text, at: Date().timeIntervalSinceReferenceDate)) }
        guard final || failed else { return }
        emit(segmenter.finish(final ? text : nil))
        // A recognition also ends with an error after a long silence: start a new one. One that fails right away
        // again and again means recognition is broken here: stop instead of spinning.
        if failed && Date().timeIntervalSince(startedAt) < 1 {
            quickFailures += 1
            AppLog.write("speech \(label): recognition failed at once (\(why ?? "no error")), \(quickFailures) in a row")
            if quickFailures >= 5 {
                stop()
                onProblem(Problem.failing.localizedDescription)
                return
            }
        }
        end()
        begin()
    }

    @MainActor private func tick() {
        emit(segmenter.tick(at: Date().timeIntervalSinceReferenceDate))
        if Date().timeIntervalSince(startedAt) > Self.restartSeconds {
            emit(segmenter.finish(nil))
            end()
            begin()
        }
    }

    @MainActor private func emit(_ lines: [String]) {
        for l in lines where !l.isEmpty { onLine(l) }
    }
}

/// The sound of one app (the meeting), through ScreenCaptureKit: only that app, never this one, and no video kept.
final class MeetingAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "alotbot.meeting-audio")
    /// The first buffer's format goes in the app log once (used on `queue` only).
    private var loggedFormat = false
    private let onAudio: (AVAudioPCMBuffer) -> Void
    /// The capture ended on its own (the app quit, or access was taken away).
    var onStopped: ((String) -> Void)?
    /// Watches for the meeting app quitting: its stream may just go quiet instead of stopping with an error.
    private var quitWatch: (center: NotificationCenter, token: NSObjectProtocol)?

    init(onAudio: @escaping (AVAudioPCMBuffer) -> Void) {
        self.onAudio = onAudio
    }

    func start(app: MeetingApp) async throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw MeetingError.message("Alotbot needs Screen & System Audio Recording to hear the meeting. Allow it in System Settings › Privacy & Security, then quit and reopen Alotbot.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let target = content.applications.first(where: { $0.processID == app.pid }) ?? content.applications.first(where: { $0.bundleIdentifier == app.bundleId }) else {
            throw MeetingError.message("\(app.name) isn't running any more. Open the meeting, then try again.")
        }
        guard let display = content.displays.first else { throw MeetingError.message("No display was found to capture from.") }
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 1
        // Audio only: the smallest, slowest video the stream allows (it is never read).
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let s = SCStream(filter: SCContentFilter(display: display, including: [target], exceptingWindows: []), configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
        watchQuit(of: app, center: NSWorkspace.shared.notificationCenter)
    }

    func watchQuit(of app: MeetingApp, center: NotificationCenter) {
        let token = center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier == app.pid else { return }
            MainActor.assumeIsolated { self?.ended("\(app.name) quit.") }
        }
        quitWatch = (center, token)
    }

    func stop() {
        if let w = quitWatch { w.center.removeObserver(w.token) }
        quitWatch = nil
        guard let s = stream else { return }
        stream = nil
        Task { try? await s.stopCapture() }
    }

    /// Said once: whichever comes first, the app quitting or the stream stopping, and nothing after.
    @MainActor private func ended(_ why: String) {
        guard quitWatch != nil || stream != nil else { return }
        stop()
        onStopped?(why)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid, let desc = sb.formatDescription else { return }
        let frames = AVAudioFrameCount(sb.numSamples)
        let format = AVAudioFormat(cmAudioFormatDescription: desc)
        if !loggedFormat { loggedFormat = true; AppLog.write("meeting audio: \(format)") }
        guard frames > 0, let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        copy.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: copy.mutableAudioBufferList) == noErr else { return }
        onAudio(copy)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.stream === stream else { return }
            MainActor.assumeIsolated { self.ended(error.localizedDescription) }
        }
    }
}

enum MeetingError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let s) = self { return s }; return nil }
}

/// A transcriber the audio threads read while the main thread sets it.
final class TranscriberBox: @unchecked Sendable {
    private let lock = NSLock()
    private var t: SpeechStream?
    var value: SpeechStream? {
        get { lock.lock(); defer { lock.unlock() }; return t }
        set { lock.lock(); t = newValue; lock.unlock() }
    }
}

/// A meeting the call listens to: the meeting app's sound and your own words in it, each transcribed on this Mac and
/// sent to the backend as lines. The bots hear them as text; no meeting audio goes anywhere.
@MainActor
final class MeetingSession {
    let app: MeetingApp
    private let capture: MeetingAudioCapture
    private let meetingBox = TranscriberBox()
    /// Your own words in the meeting (fed from the mic thread while you aren't holding the talk key).
    nonisolated let hostBox = TranscriberBox()
    private let send: (String, String) -> Void
    private let problem: (String) -> Void
    nonisolated private static let micFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: AudioFrames.sampleRate, channels: 1, interleaved: false)!

    /// `send(who, text)`: who is "meeting" or "host".
    init(app: MeetingApp, send: @escaping (String, String) -> Void, problem: @escaping (String) -> Void) {
        self.app = app
        self.send = send
        self.problem = problem
        let box = meetingBox
        capture = MeetingAudioCapture { box.value?.append($0) }
    }

    /// Starts hearing the meeting. Throws with what to fix (permissions, dictation not installed, the app gone).
    func start() async throws {
        guard await LiveTranscriber.authorize() else { throw LiveTranscriber.Problem.denied }
        let line = { [weak self] (who: String) -> (String) -> Void in { (text: String) -> Void in self?.send(who, text) } }
        let trouble: (String) -> Void = { [weak self] in self?.problem($0) }
        let m: SpeechStream
        var h: SpeechStream?
        if #available(macOS 26, *), let both = try await AnalyzerTranscriber.pair(onMeeting: line("meeting"), onHost: line("host"), onProblem: trouble) {
            (m, h) = both
            AppLog.write("meeting speech: both sides, on-device speech analyzer")
        } else {
            // The older recognizer can run only one at a time: the meeting's side, the one the bots need.
            m = try LiveTranscriber(label: "meeting", onLine: line("meeting"), onProblem: trouble)
            AppLog.write("meeting speech: the meeting's side only (this Mac can't transcribe both at once)")
        }
        meetingBox.value = m
        hostBox.value = h
        capture.onStopped = { [weak self] why in self?.problem("Stopped hearing the meeting: \(why)") }
        m.start()
        h?.start()
        do { try await capture.start(app: app) } catch {
            stop()
            throw error
        }
    }

    func stop() {
        capture.stop()
        meetingBox.value?.stop()
        hostBox.value?.stop()
        meetingBox.value = nil
        hostBox.value = nil
    }

    /// Your mic (24 kHz PCM16) while it belongs to the meeting. Called from the audio thread.
    nonisolated func hostAudio(_ pcm: [Int16]) {
        guard let t = hostBox.value, !pcm.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: Self.micFormat, frameCapacity: AVAudioFrameCount(pcm.count)) else { return }
        buf.frameLength = AVAudioFrameCount(pcm.count)
        let out = buf.floatChannelData![0]
        for (i, s) in pcm.enumerated() { out[i] = s < 0 ? Float(s) / 32768 : Float(s) / 32767 }
        t.append(buf)
    }
}
