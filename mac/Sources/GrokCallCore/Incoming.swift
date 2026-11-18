import Foundation

// Calls that come to you (src/overlay/incoming.ts): standing calls, bot call backs, and rings for bot work.

public struct QuietHours: Codable, Equatable, Sendable {
    public var enabled: Bool
    /// "HH:MM", 24-hour.
    public var start: String
    public var end: String
    public var timezone: String
    public init(enabled: Bool, start: String, end: String, timezone: String) { self.enabled = enabled; self.start = start; self.end = end; self.timezone = timezone }
}

public struct IncomingSettings: Codable, Equatable, Sendable {
    public var botCallbacks: Bool
    public var jobResults: Bool
    public var approvals: Bool
    public var quietHours: QuietHours
    /// Backend ms, or nil.
    public var doNotDisturbUntil: Double?
    public var ringSeconds: Int
    public init(botCallbacks: Bool, jobResults: Bool, approvals: Bool, quietHours: QuietHours, doNotDisturbUntil: Double?, ringSeconds: Int) {
        self.botCallbacks = botCallbacks; self.jobResults = jobResults; self.approvals = approvals; self.quietHours = quietHours; self.doNotDisturbUntil = doNotDisturbUntil; self.ringSeconds = ringSeconds
    }
}

public struct StandingCall: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var botIds: [String]
    public var agenda: String
    /// 0 = Sunday … 6 = Saturday
    public var days: [Int]
    public var time: String
    public var timezone: String
    public var enabled: Bool
    public var createdAt: Double
    /// When it next rings (ms), or nil when it is off.
    public var nextAt: Double?
}

public struct CallBack: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var botId: String
    public var botName: String
    public var reason: String
    /// When it rings (ms), or nil when it waits for jobs.
    public var at: Double?
    public var waitsFor: [String]
    public var createdAt: Double
}

public struct IncomingRing: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    /// schedule, callback, job, approval
    public var source: String
    public var title: String
    public var reason: String
    public var botIds: [String]
    public var agenda: String
    public var createdAt: Double
    /// ringing, held, answered, declined, missed
    public var state: String
    /// When it stops ringing (ms), while ringing.
    public var until: Double?
    public var note: String
    public var scheduleId: String?
    public init(id: String, source: String, title: String, reason: String, botIds: [String], agenda: String, createdAt: Double, state: String, until: Double?, note: String, scheduleId: String?) {
        self.id = id; self.source = source; self.title = title; self.reason = reason; self.botIds = botIds; self.agenda = agenda; self.createdAt = createdAt; self.state = state; self.until = until; self.note = note; self.scheduleId = scheduleId
    }

    /// One short line under the title.
    public var kindLabel: String {
        switch source {
        case "schedule": "Standing call"
        case "callback": "Calling you back"
        case "job": "Has results for you"
        case "approval": "Needs your OK"
        default: "Calling"
        }
    }
}

public struct IncomingState: Codable, Equatable, Sendable {
    public var settings: IncomingSettings
    public var schedules: [StandingCall]
    public var callbacks: [CallBack]
    public var ringing: IncomingRing?
    public var held: [IncomingRing]
    /// Newest first.
    public var missed: [IncomingRing]
    /// When the quiet hours you are in end (ms), or nil.
    public var quietUntil: Double?
}

/// Weekdays in words: "Weekdays", "Every day", "Weekends", or "Mon, Wed, Fri".
public enum Weekdays {
    public static let short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    public static func describe(_ days: [Int]) -> String {
        let set = Set(days.filter { (0...6).contains($0) })
        if set.isEmpty { return "Never" }
        if set.count == 7 { return "Every day" }
        if set == [1, 2, 3, 4, 5] { return "Weekdays" }
        if set == [0, 6] { return "Weekends" }
        // Monday first, as calendars in most places read.
        return [1, 2, 3, 4, 5, 6, 0].filter(set.contains).map { short[$0] }.joined(separator: ", ")
    }
}

/// A standing call being edited, checked here first so mistakes show before a round trip.
public struct StandingCallDraft: Equatable, Sendable {
    public var id: String?
    public var title: String
    public var botIds: [String]
    public var agenda: String
    public var days: Set<Int>
    public var hour: Int
    public var minute: Int
    public var timezone: String
    public var enabled: Bool

    public init(id: String? = nil, title: String = "", botIds: [String] = [], agenda: String = "", days: Set<Int> = [1, 2, 3, 4, 5], hour: Int = 9, minute: Int = 30, timezone: String, enabled: Bool = true) {
        self.id = id; self.title = title; self.botIds = botIds; self.agenda = agenda; self.days = days; self.hour = hour; self.minute = minute; self.timezone = timezone; self.enabled = enabled
    }

    public init(_ s: StandingCall) {
        let parts = s.time.split(separator: ":").compactMap { Int($0) }
        self.init(id: s.id, title: s.title, botIds: s.botIds, agenda: s.agenda, days: Set(s.days), hour: parts.first ?? 9, minute: parts.count > 1 ? parts[1] : 0, timezone: s.timezone, enabled: s.enabled)
    }

    public var time: String { String(format: "%02d:%02d", hour, minute) }

    /// What is wrong, in words, or nil. Same limits as the backend.
    public var problem: String? {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "Give it a name." }
        if t.count > 80 { return "The name is longer than 80 characters." }
        if botIds.isEmpty { return "Pick at least one bot." }
        if Set(botIds).count > 8 { return "A standing call can have at most 8 bots." }
        if days.isEmpty { return "Pick at least one day." }
        if !(0...23).contains(hour) || !(0...59).contains(minute) { return "Pick a time." }
        if agenda.trimmingCharacters(in: .whitespacesAndNewlines).count > 1000 { return "The agenda is longer than 1000 characters." }
        return nil
    }

    /// The request body for scheduleSave.
    public var body: [String: Any] {
        var b: [String: Any] = [
            "title": title.trimmingCharacters(in: .whitespacesAndNewlines), "botIds": botIds, "agenda": agenda.trimmingCharacters(in: .whitespacesAndNewlines),
            "days": days.sorted(), "time": time, "timezone": timezone, "enabled": enabled,
        ]
        if let id { b["id"] = id }
        return b
    }
}
