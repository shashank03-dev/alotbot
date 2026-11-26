import Foundation

/// The live caption under a talking bot, word by word: each new word comes into focus out of a soft blur and
/// rises a touch into place. Plain words and times, so the matching and the timing can be tested.
public struct CaptionReveal: Equatable, Sendable {
    public struct Word: Equatable, Sendable {
        public let text: String
        /// When the word starts coming into focus (seconds, any steady clock).
        public let born: Double
        public init(text: String, born: Double) {
            self.text = text
            self.born = born
        }
    }

    /// How long one word takes to come into focus: quick enough to keep up with speech, slow enough to read as motion.
    public static let duration = 0.42
    /// The blur a word starts from, in points: a soft reveal at caption size that never smears into its neighbours.
    public static let blur = 4.0
    /// How far a word rises as it settles, in points.
    public static let rise = 2.0
    /// Words that come together start one after another, this far apart, so they flow in rather than pop in as a block.
    public static let stagger = 0.045
    /// However many words come at once, the last one starts within this long, so a whole reply never trails behind.
    public static let maxSpread = 0.6
    /// Most words shown: a little more than the two caption lines hold, so they always stay full.
    public static let maxWords = 28

    public private(set) var words: [Word] = []

    public init() {}

    /// Matches `text` with the words shown. Words already there keep their start (so does the last one while it is
    /// still being spelled out, "Hel" to "Hello"); new ones start now, one after another. Different words from the
    /// first one on (a new reply) all start again.
    public mutating func update(_ text: String, now: Double) {
        let next = text.split(whereSeparator: \.isWhitespace).map(String.init)
        var kept: [Word] = []
        for (i, w) in next.enumerated() where i < words.count {
            let old = words[i].text
            let growing = i == words.count - 1 && (w.hasPrefix(old) || old.hasPrefix(w))
            guard w == old || growing else { break }
            kept.append(Word(text: w, born: words[i].born))
        }
        let fresh = next.count - kept.count
        let gap = fresh > 1 ? min(Self.stagger, Self.maxSpread / Double(fresh - 1)) : Self.stagger
        // New words queue behind any still waiting to start.
        var start = max(now, (kept.map(\.born).max() ?? -.infinity) + gap)
        for w in next.dropFirst(kept.count) {
            kept.append(Word(text: w, born: start))
            start += gap
        }
        words = kept
    }

    /// The words on screen: the newest `maxWords`.
    public var visible: ArraySlice<Word> { words.suffix(Self.maxWords) }
    /// True when older words are cut off the front (the caption then starts with "…").
    public var trimmed: Bool { words.count > Self.maxWords }
    /// The caption as plain text, for Reduce Motion and accessibility.
    public var plain: String { (trimmed ? "… " : "") + visible.map(\.text).joined(separator: " ") }
    /// When the last word is fully in focus.
    public var settles: Double { (words.map(\.born).max() ?? -.infinity) + Self.duration }

    /// How far into focus a word is at `now`, 0 to 1, easing out (fast at first, gentle as it lands).
    public static func progress(born: Double, now: Double) -> Double {
        let t = min(1, max(0, (now - born) / duration))
        return 1 - pow(1 - t, 3)
    }

    /// The blur at a progress: from `blur` down to none.
    public static func blurRadius(_ progress: Double) -> Double { blur * (1 - min(1, max(0, progress))) }
}
