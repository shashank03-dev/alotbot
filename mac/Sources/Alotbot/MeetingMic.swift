import AlotbotCore
import AudioToolbox
import CoreAudio
import Foundation

/// Alotbot Mic, the meeting microphone. Its driver (mac/Driver) adds a device whose input is whatever Alotbot plays
/// into it. While another app (a meeting) listens to it, Alotbot passes your real mic through, and silence while you
/// hold the talk key, so the meeting does not hear what you say to the bots. Nothing runs while no other app listens.
@MainActor
final class MeetingMic {
    static let installPath = "/Library/Audio/Plug-Ins/HAL/AlotbotMic.driver"
    /// macOS 14.2 tells which apps listen to which input; earlier versions can't use it.
    static var supported: Bool { if #available(macOS 14.2, *) { return true } else { return false } }

    /// Silence instead of your mic (you are talking to the bots). Read from the audio thread.
    var silenced: Bool {
        get { passThrough.silenced }
        set { passThrough.silenced = newValue }
    }
    private(set) var passing = false
    nonisolated private let passThrough = PassThrough()

    /// The call's echo-cancelled mic (48 kHz mono), from the audio thread: while it comes in, it is what the meeting
    /// hears instead of the raw mic, so a bot speaking aloud on the speakers doesn't reach the meeting.
    nonisolated func feedClean(_ samples: UnsafeBufferPointer<Float>) { passThrough.pushClean(samples) }
    private var timer: Timer?

    /// The device, when its driver is installed and loaded.
    static func device() -> AudioObjectID? {
        var uid = MeetingMicLogic.deviceUID as CFString
        var id = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslateUIDToDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let status = withUnsafeMutablePointer(to: &uid) { q in
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, UInt32(MemoryLayout<CFString>.size), q, &size, &id)
        }
        return status == noErr && id != kAudioObjectUnknown ? id : nil
    }

    /// Watches for a meeting listening to Alotbot Mic, about once a second.
    func start() {
        guard Self.supported, timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.check() } }
        check()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        set(passing: false, device: nil)
    }

    private func check() {
        guard #available(macOS 14.2, *), let device = Self.device() else { return set(passing: false, device: nil) }
        let listening = MeetingMicLogic.othersListening(AudioSystem.processes(), device: device, ownPid: getpid(), ownBundle: Bundle.main.bundleIdentifier ?? "")
        // The call's mic is the default input: when that is Alotbot Mic, its clean feed would loop the meeting back.
        passThrough.acceptsClean = AudioSystem.defaultInput() != device
        set(passing: listening, device: device)
    }

    private func set(passing now: Bool, device: AudioObjectID?) {
        guard now != passing else { return }
        if now, let device,
           let source = MeetingMicLogic.source(defaultInput: AudioSystem.defaultInput(), inputs: AudioSystem.inputDevices(), device: device),
           let sourceUID = AudioSystem.uid(source) {
            if let why = passThrough.start(from: sourceUID, to: MeetingMicLogic.deviceUID) {
                AppLog.write("meeting mic: could not pass your mic through (\(why))")
                return
            }
            passing = true
            AppLog.write("meeting mic: an app is listening to Alotbot Mic: passing your mic through")
        } else if !now {
            passThrough.stop()
            passing = false
            AppLog.write("meeting mic: no app is listening to Alotbot Mic: stopped")
        }
    }

    /// Installs the driver from inside the app, with your admin password (macOS asks), then restarts Core Audio so the
    /// device appears. Returns why it failed, or nil.
    static func install() -> String? {
        guard let source = Bundle.main.url(forResource: "AlotbotMic", withExtension: "driver")?.path else { return "Alotbot Mic is missing from this copy of Alotbot." }
        let dest = installPath
        let quoted = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let shell = "rm -rf \(quoted(dest)) && /usr/bin/ditto \(quoted(source)) \(quoted(dest)) && /usr/sbin/chown -R root:wheel \(quoted(dest)) && /usr/bin/killall coreaudiod"
        let script = "do shell script \"\(shell.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\" with prompt \"Alotbot wants to install Alotbot Mic, its meeting microphone.\" with administrator privileges"
        var error: NSDictionary?
        NSAppleScript(source: script)?.executeAndReturnError(&error)
        if let error { return (error[NSAppleScript.errorMessage] as? String) ?? "The install did not finish." }
        return nil
    }
}

/// Your mic into Alotbot Mic: an input queue on the real mic and an output queue on the device, with up to 0.2 s
/// between them. The audio stays on this Mac.
final class PassThrough: @unchecked Sendable {
    static let rate = 48_000.0
    private static let maxQueued = Int(rate / 5)
    private let lock = NSLock()
    private var queued: [Float] = []
    private var _silenced = false
    private var input: AudioQueueRef?
    private var output: AudioQueueRef?

    var silenced: Bool {
        get { lock.withLock { _silenced } }
        set { lock.withLock { _silenced = newValue } }
    }

    // The queues' callbacks hold this object unretained: they are stopped and gone before it is.
    deinit { stop() }

    /// Seconds after the call's echo-cancelled mic last came in during which the raw mic is not used.
    static let cleanHold = 0.3
    private var cleanAt = -Double.infinity
    private var _acceptsClean = true

    /// False while Alotbot Mic is the Mac's default input: the call's mic is then Alotbot Mic itself, and its "clean"
    /// feed would be the meeting's own loop.
    var acceptsClean: Bool {
        get { lock.withLock { _acceptsClean } }
        set { lock.withLock { _acceptsClean = newValue } }
    }

    /// The raw mic (mono), used only while the call's echo-cancelled mic isn't coming in: then no call audio runs and
    /// no bot can be playing. The raw mic also hears the speakers.
    func push(_ samples: UnsafeBufferPointer<Float>, at now: Double = ProcessInfo.processInfo.systemUptime) {
        lock.withLock {
            guard now - cleanAt > Self.cleanHold else { return }
            append(samples)
        }
    }

    /// The call's mic with echo cancellation (48 kHz mono): bots' voices from the speakers are taken out of it.
    func pushClean(_ samples: UnsafeBufferPointer<Float>, at now: Double = ProcessInfo.processInfo.systemUptime) {
        lock.withLock {
            guard _acceptsClean else { return }
            cleanAt = now
            append(samples)
        }
    }

    /// Samples in, or silence while silenced; the oldest go when more than 0.2 s waits. Under `lock`.
    private func append(_ samples: UnsafeBufferPointer<Float>) {
        if _silenced { queued.append(contentsOf: repeatElement(0, count: samples.count)) } else { queued.append(contentsOf: samples) }
        if queued.count > Self.maxQueued { queued.removeFirst(queued.count - Self.maxQueued) }
    }

    /// `frames` stereo frames out; silence where nothing waits.
    func pull(_ frames: Int, into out: UnsafeMutablePointer<Float>) {
        lock.withLock {
            let n = min(frames, queued.count)
            for i in 0..<frames {
                let v: Float = i < n && !_silenced ? queued[i] : 0
                out[2 * i] = v
                out[2 * i + 1] = v
            }
            queued.removeFirst(n)
        }
    }

    /// Starts both queues. Returns why it failed, or nil.
    func start(from sourceUID: String, to deviceUID: String) -> String? {
        stop()
        var mono = AudioStreamBasicDescription(mSampleRate: Self.rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var stereo = mono
        stereo.mChannelsPerFrame = 2; stereo.mBytesPerFrame = 8; stereo.mBytesPerPacket = 8
        let me = Unmanaged.passUnretained(self).toOpaque()
        var iq: AudioQueueRef?, oq: AudioQueueRef?
        var status = AudioQueueNewInput(&mono, { user, q, buf, _, _, _ in
            let this = Unmanaged<PassThrough>.fromOpaque(user!).takeUnretainedValue()
            let n = Int(buf.pointee.mAudioDataByteSize) / 4
            this.push(UnsafeBufferPointer(start: buf.pointee.mAudioData.assumingMemoryBound(to: Float.self), count: n))
            AudioQueueEnqueueBuffer(q, buf, 0, nil)
        }, me, nil, nil, 0, &iq)
        guard status == noErr, let iq else { return "mic queue \(status)" }
        status = AudioQueueNewOutput(&stereo, { user, q, buf in
            let this = Unmanaged<PassThrough>.fromOpaque(user!).takeUnretainedValue()
            let frames = Int(buf.pointee.mAudioDataBytesCapacity) / 8
            this.pull(frames, into: buf.pointee.mAudioData.assumingMemoryBound(to: Float.self))
            buf.pointee.mAudioDataByteSize = UInt32(frames * 8)
            AudioQueueEnqueueBuffer(q, buf, 0, nil)
        }, me, nil, nil, 0, &oq)
        guard status == noErr, let oq else { AudioQueueDispose(iq, true); return "device queue \(status)" }
        input = iq; output = oq
        var src: CFString? = sourceUID as CFString, dst: CFString? = deviceUID as CFString
        let size = UInt32(MemoryLayout<CFString?>.size)
        status = AudioQueueSetProperty(iq, kAudioQueueProperty_CurrentDevice, &src, size)
        if status == noErr { status = AudioQueueSetProperty(oq, kAudioQueueProperty_CurrentDevice, &dst, size) }
        guard status == noErr else { stop(); return "choosing devices \(status)" }
        // 10 ms buffers: little delay for the meeting.
        let frames = UInt32(Self.rate / 100)
        for _ in 0..<3 {
            var b: AudioQueueBufferRef?
            AudioQueueAllocateBuffer(iq, frames * 4, &b)
            if let b { AudioQueueEnqueueBuffer(iq, b, 0, nil) }
            var o: AudioQueueBufferRef?
            AudioQueueAllocateBuffer(oq, frames * 8, &o)
            if let o {
                o.pointee.mAudioDataByteSize = frames * 8
                memset(o.pointee.mAudioData, 0, Int(frames * 8))
                AudioQueueEnqueueBuffer(oq, o, 0, nil)
            }
        }
        status = AudioQueueStart(iq, nil)
        if status == noErr { status = AudioQueueStart(oq, nil) }
        guard status == noErr else { stop(); return "starting \(status)" }
        return nil
    }

    func stop() {
        for q in [input, output].compactMap({ $0 }) { AudioQueueStop(q, true); AudioQueueDispose(q, true) }
        input = nil; output = nil
        lock.withLock { queued.removeAll() }
    }
}

/// Small reads of the Core Audio system object.
enum AudioSystem {
    static func get<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ value: inout T) -> Bool {
        var a = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<T>.size)
        return AudioObjectGetPropertyData(object, &a, 0, nil, &size, &value) == noErr
    }

    static func list(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
        var a = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(object, &a, 0, nil, &size, &ids) == noErr else { return [] }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    static let system = AudioObjectID(kAudioObjectSystemObject)

    static func defaultInput() -> AudioObjectID? {
        var id = AudioObjectID(kAudioObjectUnknown)
        return get(system, kAudioHardwarePropertyDefaultInputDevice, &id) && id != kAudioObjectUnknown ? id : nil
    }

    /// Devices with an input stream.
    static func inputDevices() -> [AudioObjectID] {
        list(system, kAudioHardwarePropertyDevices).filter { !list($0, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput).isEmpty }
    }

    static func uid(_ device: AudioObjectID) -> String? {
        var uid: Unmanaged<CFString>?
        guard get(device, kAudioDevicePropertyDeviceUID, &uid), let uid else { return nil }
        return uid.takeRetainedValue() as String
    }

    @available(macOS 14.2, *)
    static func processes() -> [MeetingMicLogic.Process] {
        list(system, kAudioHardwarePropertyProcessObjectList).map { p in
            var pid: pid_t = 0, running: UInt32 = 0
            var bundle: Unmanaged<CFString>?
            _ = get(p, kAudioProcessPropertyPID, &pid)
            _ = get(p, kAudioProcessPropertyIsRunningInput, &running)
            let bundleID = get(p, kAudioProcessPropertyBundleID, &bundle) ? (bundle?.takeRetainedValue() as String?) ?? "" : ""
            return MeetingMicLogic.Process(pid: pid, bundleID: bundleID, runningInput: running != 0, inputDevices: list(p, kAudioProcessPropertyDevices, scope: kAudioObjectPropertyScopeInput))
        }
    }
}
