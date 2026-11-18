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
    /// When a snoozed ring rings again (ms).
    public var at: Double?
    public init(id: String, source: String, title: String, reason: String, botIds: [String], agenda: String, createdAt: Double, state: String, until: Double?, note: String, scheduleId: String?, at: Double? = nil) {
        self.id = id; self.source = source; self.title = title; self.reason = reason; self.botIds = botIds; self.agenda = agenda; self.createdAt = createdAt; self.state = state; self.until = until; self.note = note; self.scheduleId = scheduleId; self.at = at
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

    /// When a held ring will sound, from the reason the backend gave for holding it (written for the missed list).
    public var waitingLabel: String {
        if state == "snoozed", let at { return "Snoozed. Rings again at \(Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .shortened))." }
        return switch note {
        case "You were in a call.": "Rings when your call ends."
        case "Another call was ringing.": "Rings after the call that is ringing now."
        case "Do not disturb was on.": "Rings when do not disturb ends."
        case "It was during your quiet hours.": "Rings when your quiet hours end."
        default: note.isEmpty ? "Waiting to ring." : note
        }
    }
}

public struct IncomingState: Codable, Equatable, Sendable {
    public var settings: IncomingSettings
    public var schedules: [StandingCall]
    public var callbacks: [CallBack]
    public var ringing: IncomingRing?
    public var held: [IncomingRing]
    /// Rings put off with Later; each rings again as the same call at its `at`. Nil from an older backend.
    public var snoozed: [IncomingRing]?
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

/// Do not disturb's "Until tomorrow morning".
public enum DoNotDisturb {
    /// The next 08:00 after `now`: today's when it is not 08:00 yet (pressed after midnight), else tomorrow's.
    public static func morning(after now: Date, calendar: Calendar = .current) -> Date {
        let today = calendar.date(bySettingHour: 8, minute: 0, second: 0, of: now) ?? now
        if today > now { return today }
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
}

/// Settings words about held rings, kept to the backend's limit (HELD_MAX_MS in src/overlay/incoming.ts: an hour).
public enum IncomingText {
    public static let quietHours = "Calls that come in then wait and ring when quiet hours end. One that waits more than an hour is listed as missed instead. Standing calls you set still ring."
    public static let heldLimit = "A call that waits more than an hour is listed as missed instead."
}
