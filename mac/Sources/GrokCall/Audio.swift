import AVFoundation
import Foundation
import GrokCallCore

/// Mic in and bot voices out, through one engine with Apple's voice processing (echo cancellation), so the
/// bots don't hear themselves through the speakers.
final class AudioIO {
    /// 40 ms frames of 24 kHz PCM16, with their loudness.
    var onMic: ((Float, [Int16]) -> Void)?
    /// Smoothed mic loudness (0...1), for the host's avatar.
    private(set) var micLevel: Float = 0
    var muted = false
    /// Demo mode only: a made-up voice level.
    var fakeLevel: (() -> Double)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: AudioFrames.sampleRate, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var micBuffer: [Float] = []
    private let frameSize = 960
    private var running = false
    private var clock: ClockMap?

    private struct Chunk {
        let id: UInt32
        let start: Double // local seconds
        let end: Double
        let buffer: AVAudioPCMBuffer
        /// Loudness per 20 ms, for the speaking animation.
        let levels: [Float]
    }
    private var chunks: [Chunk] = []
    private var stopped = Set<UInt32>()
    private var flushQueued = false
    private let lock = NSLock()

    enum AudioError: LocalizedError {
        case micDenied, noMic, start(String)
        var errorDescription: String? {
            switch self {
            case .micDenied: return "Microphone access is off for Grok Call. Turn it on in System Settings › Privacy & Security › Microphone."
            case .noMic: return "No microphone found. Connect one and join again."
            case .start(let s): return "Couldn't start audio: \(s)"
            }
        }
    }

    static func requestMic() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    func start(clock: ClockMap) throws {
        guard !running else { return }
        self.clock = clock
        let input = engine.inputNode
        do { try input.setVoiceProcessingEnabled(true) } catch { throw AudioError.start("echo cancellation is unavailable (\(error.localizedDescription))") }
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.channelCount > 0, inFormat.sampleRate > 0 else { throw AudioError.noMic }
        guard let conv = AVAudioConverter(from: inFormat, to: format) else { throw AudioError.start("unsupported mic format \(inFormat)") }
        converter = conv
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buf, _ in self?.micTap(buf) }
        engine.prepare()
        do { try engine.start() } catch { throw AudioError.start(error.localizedDescription) }
        player.play()
        running = true
    }

    func stop() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        engine.detach(player)
        lock.lock(); chunks.removeAll(); stopped.removeAll(); lock.unlock()
        micBuffer.removeAll()
        micLevel = 0
    }

    private func micTap(_ buf: AVAudioPCMBuffer) {
        guard let conv = converter else { return }
        let ratio = format.sampleRate / buf.format.sampleRate
        let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio + 32)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return }
        var given = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, let ch = out.floatChannelData?[0] else { return }
        micBuffer.append(contentsOf: UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
        while micBuffer.count >= frameSize {
            let frame = Array(micBuffer.prefix(frameSize))
            micBuffer.removeFirst(frameSize)
            let level = AudioFrames.rms(frame)
            micLevel = micLevel * 0.7 + level * 0.3
            if !muted { onMic?(level, AudioFrames.toPCM16(frame)) }
        }
    }

    /// Schedules a bot's voice at the time the backend chose (so voices never overlap).
    func play(_ c: AudioFrames.BotChunk) {
        guard running, let clock, !c.samples.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(c.samples.count)) else { return }
        buf.frameLength = AVAudioFrameCount(c.samples.count)
        c.samples.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress!, count: c.samples.count) }
        let start = clock.local(c.when)
        let window = 480
        let levels = stride(from: 0, to: c.samples.count, by: window).map { AudioFrames.rms(Array(c.samples[$0..<min($0 + window, c.samples.count)])) }
        let chunk = Chunk(id: c.id, start: start, end: start + Double(c.samples.count) / AudioFrames.sampleRate, buffer: buf, levels: levels)
        lock.lock(); chunks.append(chunk); lock.unlock()
        schedule(chunk)
    }

    private func schedule(_ c: Chunk) {
        let now = Clock.now()
        // Late chunks play right away; on time ones start exactly when the backend planned.
        let at: AVAudioTime? = c.start > now + 0.002 ? AVAudioTime(hostTime: AVHostTime.host(c.start)) : nil
        player.scheduleBuffer(c.buffer, at: at, options: [], completionHandler: nil)
    }

    /// The backend cut this chunk (someone was interrupted). Stops come in bursts, so they're applied together.
    func stopChunk(_ id: Int) {
        lock.lock()
        stopped.insert(UInt32(truncatingIfNeeded: id))
        let queue = !flushQueued
        flushQueued = true
        lock.unlock()
        if queue { DispatchQueue.main.async { self.applyStops() } }
    }

    private func applyStops() {
        guard running else { return }
        let now = Clock.now()
        lock.lock()
        flushQueued = false
        // Keep chunks that weren't cut and haven't started yet; everything else goes.
        chunks = chunks.filter { !stopped.contains($0.id) && $0.end > now }
        let keep = chunks.filter { $0.start > now }
        let dropped = chunks.count - keep.count
        chunks = keep
        stopped.removeAll()
        lock.unlock()
        player.stop()
        player.play()
        for c in keep { schedule(c) }
        if dropped > 0 { NSLog("GrokCall: %d playing chunk(s) of another voice were cut with the stop", dropped) }
    }

    /// How loud the bot voice playing right now is (0...1). The call view says which bot that is.
    func voiceLevel() -> Double {
        if let fakeLevel { return fakeLevel() }
        let now = Clock.now()
        lock.lock()
        defer { lock.unlock() }
        chunks.removeAll { $0.end < now - 0.5 }
        guard let c = chunks.first(where: { $0.start <= now && now < $0.end }) else { return 0 }
        let i = min(c.levels.count - 1, max(0, Int((now - c.start) * AudioFrames.sampleRate / 480)))
        return min(1, Double(c.levels[i]) * 4)
    }
}
