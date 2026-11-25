import AVFoundation
import Foundation
import AlotbotCore

/// Mic in and bot voices out, through one engine with Apple's voice processing (echo cancellation), so the
/// bots don't hear themselves through the speakers.
final class AudioIO {
    /// 40 ms frames of 24 kHz PCM16, with their loudness.
    var onMic: ((Float, [Int16]) -> Void)?
    /// The echo-cancelled mic at 48 kHz mono, as it comes (for Alotbot Mic: the bots' voices are taken out of it).
    /// Called on the audio thread, muted or not.
    var onCleanMic: ((UnsafeBufferPointer<Float>) -> Void)?
    /// Smoothed mic loudness (0...1), for the host's avatar.
    private(set) var micLevel: Float = 0
    var muted = false
    /// Audio couldn't be restarted after a device change (the call has no sound until you rejoin).
    var onFailure: ((String) -> Void)?
    /// Demo mode only: a made-up voice level.
    var fakeLevel: (() -> Double)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: AudioFrames.sampleRate, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var cleanConverter: AVAudioConverter?
    private let cleanFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: PassThrough.rate, channels: 1, interleaved: false)!
    private var micMono: AVAudioFormat?
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
    private var configObserver: NSObjectProtocol?

    enum AudioError: LocalizedError {
        case micDenied, noMic, start(String)
        var errorDescription: String? {
            switch self {
            case .micDenied: return "Microphone access is off for Alotbot. Turn it on in System Settings › Privacy & Security › Microphone."
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
        do { try setUp() } catch {
            tearDown() // a failed start must leave nothing behind, or the next Join trips over the old mic tap
            throw error
        }
        running = true
    }

    private func setUp() throws {
        let input = engine.inputNode
        do { try input.setVoiceProcessingEnabled(true) } catch {
            AppLog.write("audio: echo cancellation unavailable: \(error)")
            throw AudioError.start("echo cancellation is unavailable (\(error.localizedDescription))")
        }
        // With voice processing on, the mic arrives as several channels; channel 0 is the cleaned-up voice.
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.channelCount > 0, inFormat.sampleRate > 0 else { throw AudioError.noMic }
        guard let mono = AVAudioFormat(standardFormatWithSampleRate: inFormat.sampleRate, channels: 1),
              let conv = AVAudioConverter(from: mono, to: format) else { throw AudioError.start("unsupported mic format \(inFormat)") }
        converter = conv
        cleanConverter = AVAudioConverter(from: mono, to: cleanFormat)
        micMono = mono
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        // Voice processing needs the speaker side in a format it can pair with the mic, or the engine won't start.
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: mono)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buf, _ in self?.micTap(buf) }
        engine.prepare()
        do { try engine.start() } catch { throw AudioError.start(error.localizedDescription) }
        player.play()
        AppLog.write("audio started: mic \(inFormat), speakers \(engine.outputNode.outputFormat(forBus: 0)), echo cancellation on")
        // A device change (headphones in or out, AirPods connecting) stops the engine, and nothing starts it
        // again: the call would go silent both ways. Rebuild the audio on the new devices instead.
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.deviceChanged()
        }
    }

    private func deviceChanged() {
        guard running else { return }
        AppLog.write("audio: device changed (engine running=\(engine.isRunning)); restarting audio")
        tearDown()
        lock.lock(); chunks.removeAll(); stopped.removeAll(); micBuffer.removeAll(); lock.unlock()
        do {
            try setUp()
        } catch {
            running = false
            tearDown()
            AppLog.write("audio: restart failed: \(error.localizedDescription)")
            onFailure?("Sound stopped after an audio device change: \(error.localizedDescription) Leave and join again.")
        }
    }

    private func tearDown() {
        if let o = configObserver { NotificationCenter.default.removeObserver(o) }
        configObserver = nil
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        if player.engine != nil { engine.detach(player) }
        converter = nil
        cleanConverter = nil
    }

    func stop() {
        guard running else { return }
        running = false
        tearDown()
        lock.lock(); chunks.removeAll(); stopped.removeAll(); micBuffer.removeAll(); lock.unlock()
        micLevel = 0
    }

    private func micTap(_ buf: AVAudioPCMBuffer) {
        guard let conv = converter, let mono = micMono, let src = buf.floatChannelData,
              let one = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buf.frameLength) else { return }
        one.frameLength = buf.frameLength
        one.floatChannelData![0].update(from: src[0], count: Int(buf.frameLength))
        if let onCleanMic, let clean = Self.convert(one, with: cleanConverter, to: cleanFormat), let ch = clean.floatChannelData?[0] {
            onCleanMic(UnsafeBufferPointer(start: ch, count: Int(clean.frameLength)))
        }
        let ratio = format.sampleRate / mono.sampleRate
        let cap = AVAudioFrameCount(Double(one.frameLength) * ratio + 32)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return }
        var given = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return one
        }
        guard err == nil, let ch = out.floatChannelData?[0] else { return }
        // The tap runs on the audio thread; stop() clears the buffer on main. Both go through the lock.
        var frames: [[Float]] = []
        lock.lock()
        micBuffer.append(contentsOf: UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
        while micBuffer.count >= frameSize {
            frames.append(Array(micBuffer.prefix(frameSize)))
            micBuffer.removeFirst(frameSize)
        }
        lock.unlock()
        for frame in frames {
            let level = AudioFrames.rms(frame)
            micLevel = micLevel * 0.7 + level * 0.3
            if !muted { onMic?(level, AudioFrames.toPCM16(frame)) }
        }
    }

    /// `buffer` in `format`, through a converter that keeps its state from one call to the next; nil if it failed.
    private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter?, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let converter else { return nil }
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate + 32)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return nil }
        var given = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return buffer
        }
        return err == nil && out.frameLength > 0 ? out : nil
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
        if dropped > 0 { NSLog("Alotbot: %d playing chunk(s) of another voice were cut with the stop", dropped) }
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
