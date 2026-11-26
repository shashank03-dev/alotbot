import Testing
@testable import AlotbotCore

struct CaptionRevealTests {
    private func births(_ r: CaptionReveal) -> [Double] { r.words.map(\.born) }

    /// Words already shown keep their start as the caption grows, and new words start now.
    @Test func shownWordsKeepTheirStart() {
        var r = CaptionReveal()
        r.update("Hello there", now: 10)
        #expect(r.words.map(\.text) == ["Hello", "there"])
        #expect(births(r) == [10, 10 + CaptionReveal.stagger])
        r.update("Hello there friend", now: 11)
        #expect(births(r) == [10, 10 + CaptionReveal.stagger, 11])
    }

    /// The last word being spelled out (or losing a trailing comma) is the same word, not a new one.
    @Test func aWordStillBeingSpelledKeepsItsStart() {
        var r = CaptionReveal()
        r.update("Hel", now: 1)
        r.update("Hello,", now: 1.2)
        #expect(r.words == [.init(text: "Hello,", born: 1)])
        r.update("Hello", now: 1.3)
        #expect(r.words == [.init(text: "Hello", born: 1)])
        // A change before the last word is a different reply: everything starts again.
        r.update("Bye now", now: 2)
        #expect(births(r).first == 2)
        // Only the last word may grow: a middle word that changed starts again from there.
        r.update("Bye later", now: 3)
        #expect(births(r) == [2, 3])
    }

    /// Words that come together flow in one after another, after any still waiting, and never trail behind.
    @Test func wordsThatComeTogetherFlowIn() {
        var r = CaptionReveal()
        r.update("a b c", now: 0)
        #expect(births(r) == [0, CaptionReveal.stagger, 2 * CaptionReveal.stagger])
        r.update("a b c d", now: 0.01)
        #expect(births(r).last == 3 * CaptionReveal.stagger, "queues behind c, which has not started yet")
        var long = CaptionReveal()
        long.update((1...100).map(String.init).joined(separator: " "), now: 0)
        #expect(abs(births(long).last! - CaptionReveal.maxSpread) < 1e-9)
        #expect(long.settles == births(long).last! + CaptionReveal.duration)
    }

    /// Only the newest words are shown, with "…" in front once older ones are cut off.
    @Test func showsTheNewestWords() {
        var r = CaptionReveal()
        r.update("one two", now: 0)
        #expect(!r.trimmed && r.plain == "one two")
        r.update((1...40).map(String.init).joined(separator: " "), now: 1)
        #expect(r.visible.count == CaptionReveal.maxWords)
        #expect(r.trimmed)
        #expect(r.plain.hasPrefix("… 13 14"))
        r.update("", now: 2)
        #expect(r.words.isEmpty && r.plain.isEmpty && r.settles == -.infinity)
    }

    /// A word comes out of a soft blur into focus: quick at first, landing gently, and done in `duration`.
    @Test func aWordComesIntoFocus() {
        #expect(CaptionReveal.progress(born: 0, now: -1) == 0)
        #expect(CaptionReveal.progress(born: 0, now: CaptionReveal.duration) == 1)
        #expect(CaptionReveal.progress(born: 0, now: 5) == 1)
        let half = CaptionReveal.progress(born: 0, now: CaptionReveal.duration / 2)
        #expect(half > 0.8 && half < 0.9, "eases out")
        #expect(CaptionReveal.blurRadius(0) == CaptionReveal.blur)
        #expect(CaptionReveal.blurRadius(1) == 0)
        #expect(CaptionReveal.blurRadius(2) == 0 && CaptionReveal.blurRadius(-1) == CaptionReveal.blur)
        // Enough blur to read as a reveal, not so much it smears; quick enough to keep up with speech.
        #expect(CaptionReveal.blur >= 3 && CaptionReveal.blur <= 6)
        #expect(CaptionReveal.duration >= 0.3 && CaptionReveal.duration <= 0.6)
        #expect(CaptionReveal.rise > 0 && CaptionReveal.rise <= 3)
    }
}
