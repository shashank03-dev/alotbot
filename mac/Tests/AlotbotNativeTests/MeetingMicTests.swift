import AudioToolbox
import CoreAudio
import Foundation
import Testing
import AlotbotCore
@testable import Alotbot

@Suite struct PassThroughTests {
    func pulled(_ p: PassThrough, _ frames: Int) -> [Float] {
        var out = [Float](repeating: -1, count: frames * 2)
        out.withUnsafeMutableBufferPointer { p.pull(frames, into: $0.baseAddress!) }
        return out
    }

    func push(_ p: PassThrough, _ samples: [Float]) { samples.withUnsafeBufferPointer { p.push($0) } }

    @Test func yourMicGoesOutOnBothChannelsInOrder() {
        let p = PassThrough()
        push(p, [0.1, 0.2, 0.3])
        #expect(pulled(p, 2) == [0.1, 0.1, 0.2, 0.2])
        #expect(pulled(p, 2) == [0.3, 0.3, 0, 0], "what is missing is silence")
    }

    @Test func whileSilencedTheMeetingHearsNothing() {
        let p = PassThrough()
        push(p, [0.5, 0.5])
        p.silenced = true
        #expect(pulled(p, 2) == [0, 0, 0, 0], "what waited from before is not played either")
        push(p, [0.7])
        p.silenced = false
        #expect(pulled(p, 1) == [0, 0], "what came in while silenced stays silent")
        push(p, [0.9])
        #expect(pulled(p, 1) == [0.9, 0.9])
    }

    @Test func atMostAFifthOfASecondWaits() {
        let p = PassThrough()
        let max = Int(PassThrough.rate / 5)
        push(p, [Float](repeating: 0.1, count: max) + [0.9])
        let out = pulled(p, max + 1)
        #expect(out[0] == 0.1 && out[2 * (max - 1)] == 0.9, "the oldest went, the newest is last")
        #expect(out[2 * max] == 0, "nothing more")
    }

    /// Live, 25 Nov (row 45): with whisper aloud on the speakers, the meeting heard Satya. The raw mic hears the
    /// speakers; the call's echo-cancelled mic has the bots' voices taken out. While it comes in, it is what the meeting
    /// gets, and the raw mic is not used.
    @Test func whileTheCallsCleanMicComesInTheRawMicIsNotUsed() {
        let p = PassThrough()
        func raw(_ s: [Float], at t: Double) { s.withUnsafeBufferPointer { p.push($0, at: t) } }
        func clean(_ s: [Float], at t: Double) { s.withUnsafeBufferPointer { p.pushClean($0, at: t) } }
        clean([0.1, 0.2], at: 10)
        raw([0.8, 0.8], at: 10.01)
        #expect(pulled(p, 3) == [0.1, 0.1, 0.2, 0.2, 0, 0], "the raw mic, with a bot's voice in it, is left out")
        raw([0.8], at: 10 + PassThrough.cleanHold - 0.01)
        #expect(pulled(p, 1) == [0, 0], "still within the hold")
        // The call's audio stopped (no bot can play): the raw mic is used again.
        raw([0.4], at: 10 + PassThrough.cleanHold + 0.01)
        #expect(pulled(p, 1) == [0.4, 0.4])
        // Review of 25 Nov: with Alotbot Mic as the Mac's default input, the call's mic is Alotbot Mic itself, so its
        // "clean" feed is the meeting's own loop. Then it is not used, and the raw real mic is.
        p.acceptsClean = false
        clean([0.6], at: 15)
        raw([0.3], at: 15.01)
        #expect(pulled(p, 2) == [0.3, 0.3, 0, 0], "the loop is left out, your real mic goes through")
        p.acceptsClean = true
        // Holding the talk key silences the clean mic as well.
        p.silenced = true
        clean([0.5], at: 20)
        #expect(pulled(p, 1) == [0, 0])
    }
}

/// With the driver installed (it is on the Mac these tests ran on): the device works end to end.
@Suite struct AlotbotMicDeviceTests {
    @Test @MainActor func aToneThroughAlotbotMicIsHeardAndTheListenerIsSeen() async throws {
        guard FileManager.default.fileExists(atPath: MeetingMic.installPath) else { return } // not installed here
        let device = try #require(MeetingMic.device(), "installed but not loaded")
        var fmt = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
        final class Box: @unchecked Sendable { var rms: [Double] = []; var phase = 0.0 }
        let box = Box()
        let me = Unmanaged.passUnretained(box).toOpaque()
        var iq: AudioQueueRef?, oq: AudioQueueRef?
        #expect(AudioQueueNewInput(&fmt, { user, q, buf, _, _, _ in
            let b = Unmanaged<Box>.fromOpaque(user!).takeUnretainedValue()
            let n = Int(buf.pointee.mAudioDataByteSize) / 4
            let p = buf.pointee.mAudioData.assumingMemoryBound(to: Float.self)
            var s = 0.0
            for i in 0..<n { s += Double(p[i] * p[i]) }
            b.rms.append(n > 0 ? (s / Double(n)).squareRoot() : 0)
            AudioQueueEnqueueBuffer(q, buf, 0, nil)
        }, me, nil, nil, 0, &iq) == noErr)
        #expect(AudioQueueNewOutput(&fmt, { user, q, buf in
            let b = Unmanaged<Box>.fromOpaque(user!).takeUnretainedValue()
            let n = Int(buf.pointee.mAudioDataBytesCapacity) / 8
            let p = buf.pointee.mAudioData.assumingMemoryBound(to: Float.self)
            for i in 0..<n { let v = Float(0.5 * sin(b.phase)); p[2 * i] = v; p[2 * i + 1] = v; b.phase += 2 * .pi * 1000 / 48_000 }
            buf.pointee.mAudioDataByteSize = UInt32(n * 8)
            AudioQueueEnqueueBuffer(q, buf, 0, nil)
        }, me, nil, nil, 0, &oq) == noErr)
        let input = try #require(iq), output = try #require(oq)
        // The callbacks hold `box` unretained: it must outlive the queues, so it is kept until they are gone.
        defer { AudioQueueStop(input, true); AudioQueueStop(output, true); AudioQueueDispose(input, true); AudioQueueDispose(output, true); withExtendedLifetime(box) {} }
        var uid: CFString? = MeetingMicLogic.deviceUID as CFString
        let size = UInt32(MemoryLayout<CFString?>.size)
        #expect(AudioQueueSetProperty(input, kAudioQueueProperty_CurrentDevice, &uid, size) == noErr)
        #expect(AudioQueueSetProperty(output, kAudioQueueProperty_CurrentDevice, &uid, size) == noErr)
        for _ in 0..<3 {
            var b: AudioQueueBufferRef?
            AudioQueueAllocateBuffer(input, 4096, &b)
            AudioQueueEnqueueBuffer(input, b!, 0, nil)
            var o: AudioQueueBufferRef?
            AudioQueueAllocateBuffer(output, 4096, &o)
            o!.pointee.mAudioDataByteSize = 4096
            memset(o!.pointee.mAudioData, 0, 4096)
            AudioQueueEnqueueBuffer(output, o!, 0, nil)
        }
        #expect(AudioQueueStart(input, nil) == noErr)
        #expect(AudioQueueStart(output, nil) == noErr)
        try await Task.sleep(nanoseconds: 1_500_000_000)
        // A 0.5 sine has an RMS of 0.354: the device hands back exactly what was played.
        let late = box.rms.suffix(10)
        #expect(late.count == 10 && late.allSatisfy { abs($0 - 0.3536) < 0.01 }, "heard \(late)")
        // This process now listens to Alotbot Mic: seen, and not counted as another app.
        if #available(macOS 14.2, *) {
            let procs = AudioSystem.processes()
            let mine = procs.filter { $0.pid == getpid() }
            #expect(MeetingMicLogic.othersListening(mine, device: device, ownPid: -1, ownBundle: "me.shashankdev.alotbot"), "this process is seen listening")
            #expect(!MeetingMicLogic.othersListening(mine, device: device, ownPid: getpid(), ownBundle: "me.shashankdev.alotbot"), "and is not another app")
        }
    }
}
