import Foundation

// Decisions behind meeting mode and screen sharing that need no screen: how a live transcript becomes lines, which
// apps are meetings, where the mic goes, and when a screen's text is worth sending again.

/// Turns a recognizer's growing transcript into finished lines. Speech recognizers revise their last words as they
/// hear more, so a line is sent only once it is settled: a sentence that something came after, a pause, the end of
/// the recognition, or a run of words too long to wait for.
public struct TranscriptSegmenter: Equatable, Sendable {
    /// Seconds without a change after which the rest is a line.
    public var pause: Double
    /// Words without a sentence end after which the first `chunk` are a line.
    public var longRun: Int
    public var chunk: Int
    /// Words of the current transcript already sent.
    private(set) var sent = 0
    private var words: [String] = []
    private var changedAt: Double = 0

    public init(pause: Double = 1.6, longRun: Int = 45, chunk: Int = 30) {
        self.pause = pause; self.longRun = longRun; self.chunk = chunk
    }

    static func split(_ text: String) -> [String] { text.split(whereSeparator: \.isWhitespace).map(String.init) }
    static func endsSentence(_ w: String) -> Bool { w.hasSuffix(".") || w.hasSuffix("?") || w.hasSuffix("!") }

    /// A new partial transcript (the whole text so far of this recognition). Returns lines now settled.
    public mutating func partial(_ text: String, at now: Double) -> [String] {
        let next = Self.split(text)
        if next != words { changedAt = now }
        words = next
        // The recognizer took back words already sent: carry on from what is left.
        sent = min(sent, words.count)
        var out: [String] = []
        // A sentence with words after it will not change any more.
        while let end = words[sent...].indices.dropLast().first(where: { Self.endsSentence(words[$0]) }) {
            out.append(take(upTo: end + 1))
        }
        while words.count - sent >= longRun { out.append(take(upTo: sent + chunk)) }
        return out
    }

    /// Time passed with no new words: after a pause, the rest is a line.
    public mutating func tick(at now: Double) -> [String] {
        guard sent < words.count, now - changedAt >= pause else { return [] }
        return [take(upTo: words.count)]
    }

    /// The recognition ended (its last result, or it was stopped): the rest is a line, and the next one starts fresh.
    public mutating func finish(_ text: String?) -> [String] {
        if let text { words = Self.split(text); sent = min(sent, words.count) }
        let rest = sent < words.count ? [take(upTo: words.count)] : []
        words = []
        sent = 0
        return rest
    }

    private mutating func take(upTo end: Int) -> String {
        let line = words[sent..<end].joined(separator: " ")
        sent = end
        return line
    }
}

/// An app that may be holding a meeting.
public struct MeetingApp: Equatable, Hashable, Sendable, Identifiable {
    public var name: String
    public var bundleId: String
    public var pid: Int32
    public var id: String { "\(bundleId)#\(pid)" }
    public init(name: String, bundleId: String, pid: Int32) { self.name = name; self.bundleId = bundleId; self.pid = pid }
}

public enum MeetingApps {
    /// Meeting apps, most likely first.
    public static let known = [
        "us.zoom.xos", "com.microsoft.teams2", "com.microsoft.teams", "com.apple.FaceTime", "com.cisco.webexmeetingsapp", "Cisco-Systems.Spark",
        "com.tinyspeck.slackmacgap", "com.hnc.Discord", "com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "com.microsoft.edgemac",
        "org.mozilla.firefox", "com.brave.Browser",
    ]
    /// Browsers: Google Meet and other web meetings run in one.
    public static let browsers: Set<String> = ["com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "com.microsoft.edgemac", "org.mozilla.firefox", "com.brave.Browser"]

    /// Running apps to offer: known meeting apps first (in `known` order), then the rest by name. Alotbot itself and
    /// apps without a bundle are left out.
    public static func rank(_ apps: [MeetingApp], selfBundle: String) -> [MeetingApp] {
        let usable = apps.filter { !$0.bundleId.isEmpty && $0.bundleId != selfBundle && !$0.name.isEmpty }
        let order = Dictionary(uniqueKeysWithValues: known.enumerated().map { ($1, $0) })
        return usable.sorted { a, b in
            switch (order[a.bundleId], order[b.bundleId]) {
            case let (x?, y?): return x != y ? x < y : a.pid < b.pid
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
        }
    }
}

/// Where your mic goes. In a meeting it is part of the meeting (transcribed as your lines) unless you hold the talk key,
/// which sends it to the bots instead. Outside a meeting it always goes to the bots.
public enum MicRoute: Equatable, Sendable {
    case bots, meeting

    public static func of(inMeeting: Bool, talkHeld: Bool) -> MicRoute { inMeeting && !talkHeld ? .meeting : .bots }
}

/// OCR of a shared screen, tidied so a blinking cursor or a ticking clock is not news. Decides when to send it again.
public struct ScreenTextGate: Equatable, Sendable {
    /// Seconds between sends at most once text changed.
    public var minInterval: Double
    private(set) var last: String?
    private var sentAt = -Double.infinity

    public init(minInterval: Double = 2) { self.minInterval = minInterval }

    /// Lines trimmed and single-spaced; empty lines, single characters and bare clock times dropped.
    public static func normalize(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline)
            .map { $0.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ") }
            .filter { $0.count > 1 && !isClock($0) }
            .joined(separator: "\n")
    }

    static func isClock(_ s: String) -> Bool {
        s.range(of: #"^\d{1,2}:\d{2}(:\d{2})?(\s?[AaPp][Mm])?$"#, options: .regularExpression) != nil
    }

    /// The text to send now, or nil when it is the same as last time or too soon after the last send.
    public mutating func accept(_ raw: String, at now: Double) -> String? {
        let t = Self.normalize(raw)
        guard t != last, now - sentAt >= minInterval else { return nil }
        last = t
        sentAt = now
        return t
    }

    /// A new window or display: anything is news again.
    public mutating func reset() { last = nil; sentAt = -.infinity }
}

/// The backend's answer to screenShare or screenUpdate.
public struct ScreenShareReply: Decodable, Equatable, Sendable {
    /// screenShare: this share's number, sent with each of its updates so a late one from the share before is ignored.
    public var share: Int?
    /// screenUpdate: not taken in (too soon after the last, or from an earlier share).
    public var ignored: Bool?
    /// The update was taken in; when not, its text must be sent again.
    public var taken: Bool { ignored != true }
}

/// Alotbot Mic, the meeting microphone: when to pass your mic through, and which mic that is.
public enum MeetingMicLogic {
    /// The device's UID, as its driver publishes it.
    public static let deviceUID = "AlotbotMic_UID"

    /// One process's audio input, as Core Audio reports it.
    public struct Process: Equatable, Sendable {
        public var pid: Int32
        public var bundleID: String
        public var runningInput: Bool
        public var inputDevices: [UInt32]
        public init(pid: Int32, bundleID: String = "", runningInput: Bool, inputDevices: [UInt32]) {
            self.pid = pid; self.bundleID = bundleID; self.runningInput = runningInput; self.inputDevices = inputDevices
        }
    }

    /// Another app (a meeting) is listening to Alotbot Mic right now: your mic should be passed through. Alotbot itself
    /// never counts, nor does another copy of it: Core Audio lists the device it plays into among its inputs too, and
    /// two copies would each start for the other.
    public static func othersListening(_ processes: [Process], device: UInt32, ownPid: Int32, ownBundle: String) -> Bool {
        processes.contains { $0.pid != ownPid && $0.bundleID != ownBundle && $0.runningInput && $0.inputDevices.contains(device) }
    }

    /// The real mic to pass through: the default input, unless that is Alotbot Mic itself (it would hear only itself),
    /// then the first other input. Nil when there is none.
    public static func source(defaultInput: UInt32?, inputs: [UInt32], device: UInt32) -> UInt32? {
        if let d = defaultInput, d != device, inputs.contains(d) { return d }
        return inputs.first { $0 != device }
    }
}
