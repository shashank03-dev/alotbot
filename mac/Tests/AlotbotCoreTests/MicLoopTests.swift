import Testing
import AlotbotMicLoop

/// The Alotbot Mic loopback: what Alotbot plays into the device comes out of its microphone side, once.
@Suite struct MicLoopTests {
    let ring = Int(ALOTBOT_MIC_RING_FRAMES), ch = Int(ALOTBOT_MIC_CHANNELS)

    func frames(_ n: Int, from start: Float) -> [Float] { (0..<n * ch).map { start + Float($0) } }

    func loop() -> UnsafeMutablePointer<AlotbotMicLoop> {
        let p = UnsafeMutablePointer<AlotbotMicLoop>.allocate(capacity: 1)
        AlotbotMicLoopReset(p)
        return p
    }

    @Test func whatIsPlayedAtATimeIsHeardAtThatTime() {
        let l = loop(); defer { l.deallocate() }
        let played = frames(512, from: 1)
        AlotbotMicLoopWrite(l, 1000, 512, played)
        var heard = [Float](repeating: -1, count: 512 * ch)
        AlotbotMicLoopRead(l, 1000, 512, &heard)
        #expect(heard == played)
    }

    @Test func audioIsHeardOnceThenSilence() {
        let l = loop(); defer { l.deallocate() }
        AlotbotMicLoopWrite(l, 0, 256, frames(256, from: 1))
        var heard = [Float](repeating: -1, count: 256 * ch)
        AlotbotMicLoopRead(l, 0, 256, &heard)
        AlotbotMicLoopRead(l, 0, 256, &heard)
        #expect(heard.allSatisfy { $0 == 0 }, "a writer that stopped leaves silence, not a repeating loop")
        // One ring later the same slots are silent too.
        AlotbotMicLoopRead(l, Double(ring), 256, &heard)
        #expect(heard.allSatisfy { $0 == 0 })
    }

    @Test func writesAndReadsWrapAroundTheRing() {
        let l = loop(); defer { l.deallocate() }
        let at = Double(3 * ring - 100) // 100 frames before the end, three rings in
        let played = frames(300, from: 7)
        AlotbotMicLoopWrite(l, at, 300, played)
        var heard = [Float](repeating: -1, count: 300 * ch)
        AlotbotMicLoopRead(l, at, 300, &heard)
        #expect(heard == played)
    }

    @Test func nothingPlayedIsSilence() {
        let l = loop(); defer { l.deallocate() }
        var heard = [Float](repeating: -1, count: 64 * ch)
        AlotbotMicLoopRead(l, 12345, 64, &heard)
        #expect(heard.allSatisfy { $0 == 0 })
    }

    @Test func moreThanTheRingIsCutToTheRing() {
        let l = loop(); defer { l.deallocate() }
        let played = frames(ring + 10, from: 1)
        AlotbotMicLoopWrite(l, 0, UInt32(ring + 10), played)
        var heard = [Float](repeating: -1, count: (ring + 10) * ch)
        AlotbotMicLoopRead(l, 0, UInt32(ring + 10), &heard)
        #expect(Array(heard[0..<ring * ch]) == Array(played[0..<ring * ch]))
        #expect(heard.suffix(10 * ch).allSatisfy { $0 == -1 }, "nothing past the ring is touched")
    }
}
