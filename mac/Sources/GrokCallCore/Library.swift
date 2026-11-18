import Foundation

// The call library (src/overlay/library.ts): every saved call and meeting, searchable.

public struct LibraryMatch: Codable, Equatable, Sendable {
    public var callId: String
    public var startedAt: Double
    public var kind: String
    /// summary, decision, action or line
    public var field: String
    public var who: String?
    /// The matching text, with matched words marked «like this».
    public var snippet: String
}

public struct LibraryCall: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var file: String
    /// call or meeting
    public var kind: String
    public var startedAt: Double
    public var endedAt: Double
    public var bots: [String]
    public var summary: String
    public var decisions: [String]
    public var actionItems: [String]
    public var lineCount: Int
    /// The best matching passage when the list was searched.
    public var match: LibraryMatch?

    public var minutes: Int { max(0, Int(((endedAt - startedAt) / 60_000).rounded())) }
    public var isMeeting: Bool { kind == "meeting" }
}

public struct LibraryPage: Codable, Equatable, Sendable {
    public var calls: [LibraryCall]
    public var hasMore: Bool
    public var total: Int
}

public struct LibraryLine: Codable, Equatable, Identifiable, Sendable {
    public var seq: Int
    public var who: String
    public var text: String
    public var cut: Bool
    public var id: Int { seq }
}

public struct LibraryDetail: Codable, Equatable, Sendable {
    public var call: LibraryCall
    public var lines: [LibraryLine]
    /// The saved Markdown, or nil if the file was removed outside the app.
    public var markdown: String?
}

/// A snippet split into plain and matched runs, for bold matches.
public enum Snippet {
    public struct Run: Equatable, Sendable {
        public var text: String
        public var matched: Bool
        public init(_ text: String, _ matched: Bool) { self.text = text; self.matched = matched }
    }

    /// "a «b» c" → [a ][b*][ c]. An unclosed mark runs to the end; empty runs are left out.
    public static func runs(_ s: String) -> [Run] {
        var out: [Run] = []
        var current = ""
        var matched = false
        for ch in s {
            if ch == "«" || ch == "»" {
                if !current.isEmpty { out.append(Run(current, matched)) }
                current = ""
                matched = ch == "«"
            } else {
                current.append(ch)
            }
        }
        if !current.isEmpty { out.append(Run(current, matched)) }
        return out
    }

    /// Where a match came from, in words.
    public static func label(_ m: LibraryMatch) -> String {
        switch m.field {
        case "summary": "Summary"
        case "decision": "Decision"
        case "action": "Action item"
        default: m.who.map { "\($0) said" } ?? "Said"
        }
    }
}
