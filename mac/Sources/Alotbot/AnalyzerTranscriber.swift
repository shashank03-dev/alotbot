import AVFoundation
import Foundation
import AlotbotCore
import Speech

/// Live on-device speech-to-text with the speech analyzer of macOS 26 and later. Unlike `LiveTranscriber`, two of these
/// run at once, so a meeting hears both sides: the meeting, and your mic while you talk in it. The audio never leaves
/// this Mac.
@available(macOS 26, *)
final class AnalyzerTranscriber: SpeechStream, @unchecked Sendable {
    /// Both sides of a meeting, or nil when this Mac can't: no analyzer here, no model for the language, or the model
    /// still downloading (the download starts, and the next meeting uses it).
    static func pair(onMeeting: @escaping (String) -> Void, onHost: @escaping (String) -> Void, onProblem: @escaping (String) -> Void) async throws -> (SpeechStream, SpeechStream)? {
        guard SpeechTranscriber.isAvailable else { return nil }
        let wanted = await SpeechTranscriber.supportedLocale(equivalentTo: .current)
        let fallback = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US"))
        guard let locale = wanted ?? fallback else { return nil }
        let probe = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        // Each app reserves the languages it uses: without it, an installed model reads as only "supported".
        _ = try? await AssetInventory.reserve(locale: locale)
        guard await AssetInventory.status(forModules: [probe]) == .installed else {
            AppLog.write("meeting speech: the on-device model for \(locale.identifier) is not installed: downloading it")
            Task.detached { try? await AssetInventory.assetInstallationRequest(supporting: [probe])?.downloadAndInstall() }
            return nil
        }
        let m = try await AnalyzerTranscriber(label: "meeting", locale: locale, onLine: onMeeting, onProblem: onProblem)
        let h = try await AnalyzerTranscriber(label: "host", locale: locale, onLine: onHost, onProblem: onProblem)
        return (m, h)
    }

    private let label: String
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    /// The format the analyzer takes; audio in any other is converted.
    private let format: AVAudioFormat
    private let onLine: (String) -> Void
    private let onProblem: (String) -> Void
    private let lock = NSLock()
    // Under `lock` (the audio threads append).
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var converter: AVAudioConverter?
    // The rest is used on the main thread only.
    private var segmenter = TranscriptSegmenter()
    private var timer: Timer?
    private var running = false

    init(label: String, locale: Locale, onLine: @escaping (String) -> Void, onProblem: @escaping (String) -> Void) async throws {
        let t = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        guard let f = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t]) else {
            throw LiveTranscriber.Problem.unavailable("On-device speech recognition isn't available for \(locale.identifier) on this Mac.")
        }
        self.label = label
        transcriber = t
        format = f
        analyzer = SpeechAnalyzer(modules: [t])
        self.onLine = onLine
        self.onProblem = onProblem
    }

    @MainActor func start() {
        guard !running else { return }
        running = true
        let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
        lock.withLock { input = cont }
        let analyzer = self.analyzer, transcriber = self.transcriber
        Task { @MainActor [weak self] in
            do {
                try await analyzer.start(inputSequence: stream)
                // A volatile result is the words so far of the part not yet settled; a final one settles it.
                for try await r in transcriber.results {
                    guard let self, self.running else { return }
                    let text = String(r.text.characters)
                    self.emit(r.isFinal ? self.segmenter.finish(text) : self.segmenter.partial(text, at: Date().timeIntervalSinceReferenceDate))
                }
            } catch {
                guard let self, self.running else { return }
                // The domain and code only: never words from the meeting.
                let e = error as NSError
                AppLog.write("speech \(self.label): the analyzer stopped (\(e.domain) \(e.code))")
                self.stop()
                self.onProblem(LiveTranscriber.Problem.failing.localizedDescription)
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { guard let self else { return }; self.emit(self.segmenter.tick(at: Date().timeIntervalSinceReferenceDate)) }
        }
    }

    @MainActor func stop() {
        guard running else { return }
        running = false
        timer?.invalidate()
        timer = nil
        lock.withLock {
            input?.finish()
            input = nil
        }
        let analyzer = self.analyzer
        Task { await analyzer.cancelAndFinishNow() }
        emit(segmenter.finish(nil))
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard let input, buffer.frameLength > 0 else { return }
        if buffer.format == format {
            input.yield(AnalyzerInput(buffer: buffer))
            return
        }
        if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
        let room = AVAudioFrameCount((Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate).rounded(.up)) + 32
        guard let converter, let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: room) else { return }
        var given = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, state in
            if given { state.pointee = .noDataNow; return nil }
            given = true
            state.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0 else { return }
        input.yield(AnalyzerInput(buffer: out))
    }

    @MainActor private func emit(_ lines: [String]) {
        for l in lines where !l.isEmpty { onLine(l) }
    }
}
