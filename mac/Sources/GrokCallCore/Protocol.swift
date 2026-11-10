import Foundation

// The messages the overlay backend (src/overlay/server.ts) sends and expects. Protocol version 1.

public let protocolVersion = 1

public struct Bot: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var voice: String?
    public var speed: Double
    public var language: String?
    public var color: String?
    public var shape: String?
    public init(id: String, name: String, voice: String? = nil, speed: Double = 1, language: String? = nil, color: String? = nil, shape: String? = nil) {
        self.id = id; self.name = name; self.voice = voice; self.speed = speed; self.language = language; self.color = color; self.shape = shape
    }
}

public struct CallBot: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var color: String?
    public var shape: String?
    /// connecting, reconnecting, ready, speaking, thinking, listening, quiet, idle, error
    public var status: String
    public var error: String?
    public var search: Bool
    /// "host", another bot's id, or nil.
    public var looksAt: String?
    public init(id: String, name: String, color: String?, shape: String?, status: String, error: String?, search: Bool, looksAt: String?) { self.id = id; self.name = name; self.color = color; self.shape = shape; self.status = status; self.error = error; self.search = search; self.looksAt = looksAt }
}

public struct Live: Codable, Equatable, Sendable {
    public var botId: String
    public var text: String
    public init(botId: String, text: String) { self.botId = botId; self.text = text }
}

public struct CallView: Codable, Equatable, Sendable {
    public var phase: String
    public var muted: Bool
    public var userSpeaking: Bool
    public var waitingForHost: Bool
    public var focus: String?
    public var bots: [CallBot]
    public var live: Live?
    public var linesSeq: Int
    public var tasksVersion: Int
    public init(phase: String, muted: Bool, userSpeaking: Bool, waitingForHost: Bool, focus: String?, bots: [CallBot], live: Live?, linesSeq: Int, tasksVersion: Int) { self.phase = phase; self.muted = muted; self.userSpeaking = userSpeaking; self.waitingForHost = waitingForHost; self.focus = focus; self.bots = bots; self.live = live; self.linesSeq = linesSeq; self.tasksVersion = tasksVersion }
}

public struct Line: Codable, Equatable, Identifiable, Sendable {
    public var seq: Int
    public var who: String
    public var botId: String?
    public var text: String
    public var cut: Bool
    public var id: Int { seq }
    public init(seq: Int, who: String, botId: String?, text: String, cut: Bool) { self.seq = seq; self.who = who; self.botId = botId; self.text = text; self.cut = cut }
}

public struct TaskItem: Codable, Equatable, Identifiable, Sendable {
    public var id: Int
    public var title: String
    public var owner: String?
    /// open, doing, done (a parent's status follows its parts)
    public var status: String
    public var parent: Int?
    public var waitsOn: [Int]
    public var by: String
    public var doneBy: String?
    /// Tasks it waits on that are not done yet.
    public var blockedBy: [Int]
    public init(id: Int, title: String, owner: String?, status: String, parent: Int?, waitsOn: [Int], by: String, doneBy: String?, blockedBy: [Int]) { self.id = id; self.title = title; self.owner = owner; self.status = status; self.parent = parent; self.waitsOn = waitsOn; self.by = by; self.doneBy = doneBy; self.blockedBy = blockedBy }
}

public struct TaskList: Codable, Equatable, Sendable {
    public var version: Int
    public var tasks: [TaskItem]
}

public struct Choices: Codable, Equatable, Sendable {
    public var voices: [String]
    public var speeds: [Double]
    public var languages: [String]
    public var shapes: [String]
    public var pickerShapes: [String]
    public var colors: [String: String]
    public var statuses: [String]
    public init(voices: [String], speeds: [Double], languages: [String], shapes: [String], pickerShapes: [String], colors: [String: String], statuses: [String]) { self.voices = voices; self.speeds = speeds; self.languages = languages; self.shapes = shapes; self.pickerShapes = pickerShapes; self.colors = colors; self.statuses = statuses }
}

public struct Hello: Codable, Equatable, Sendable {
    public var version: Int
    public var serverNow: Double
    public var user: String
    public var choices: Choices
}

public struct LoginState: Codable, Equatable, Sendable {
    /// signed-out, signing-in, signed-in
    public var state: String
    public var error: String?
    public init(state: String, error: String?) { self.state = state; self.error = error }
}

public struct PastCall: Codable, Equatable, Identifiable, Sendable {
    public var file: String
    public var at: Double
    public var summary: String
    public var id: String { file }
}

public struct LeaveResult: Codable, Equatable, Sendable {
    public var file: String?
    public var summary: String
    public var actionItems: [String]
}

/// A message pushed by the backend.
public enum ServerMessage: Equatable {
    case reply(req: Int?, ok: Bool, result: Data?, error: String?, signedOut: Bool)
    case view(CallView)
    case lines([Line])
    case tasks(TaskList)
    case stopAudio(Int)
    case ended
    case unknown(String)

    public static func decode(_ text: String) throws -> ServerMessage {
        let data = Data(text.utf8)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], let t = obj["t"] as? String else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "no message type"))
        }
        let dec = JSONDecoder()
        func sub(_ key: String) throws -> Data { try JSONSerialization.data(withJSONObject: obj[key] ?? NSNull(), options: [.fragmentsAllowed]) }
        switch t {
        case "reply":
            let result = obj["result"].map { _ in try? sub("result") } ?? nil
            return .reply(req: (obj["req"] as? NSNumber)?.intValue, ok: obj["ok"] as? Bool ?? false, result: result, error: obj["error"] as? String, signedOut: obj["signedOut"] as? Bool ?? false)
        case "view": return .view(try dec.decode(CallView.self, from: try sub("view")))
        case "lines": return .lines(try dec.decode([Line].self, from: try sub("lines")))
        case "tasks": return .tasks(try dec.decode(TaskList.self, from: data))
        case "stopAudio": return .stopAudio((obj["id"] as? NSNumber)?.intValue ?? -1)
        case "ended": return .ended
        default: return .unknown(t)
        }
    }
}

/// Builds a request: `{ "req": n, "op": "...", ...args }`.
public func encodeRequest(req: Int, op: String, args: [String: Any] = [:]) throws -> String {
    var body = args
    body["req"] = req
    body["op"] = op
    let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
}

public enum AudioFrames {
    public static let mic: UInt8 = 1
    public static let botAudio: UInt8 = 2
    public static let sampleRate = 24_000.0

    /// Mic audio for the backend: [1][f32 level][PCM16 LE].
    public static func encodeMic(level: Float, samples: [Int16]) -> Data {
        var d = Data(capacity: 5 + samples.count * 2)
        d.append(mic)
        withUnsafeBytes(of: level.bitPattern.littleEndian) { d.append(contentsOf: $0) }
        for s in samples { withUnsafeBytes(of: s.littleEndian) { d.append(contentsOf: $0) } }
        return d
    }

    public struct BotChunk: Equatable {
        public let id: UInt32
        /// When to start playing, in backend seconds.
        public let when: Double
        public let samples: [Float]
    }

    /// Bot audio from the backend: [2][u32 id][f64 when][PCM16 LE]. Nil if malformed.
    public static func decodeBot(_ d: Data) -> BotChunk? {
        let b = [UInt8](d)
        guard b.count >= 13, b[0] == botAudio, (b.count - 13) % 2 == 0 else { return nil }
        func u32(_ o: Int) -> UInt32 { UInt32(b[o]) | UInt32(b[o + 1]) << 8 | UInt32(b[o + 2]) << 16 | UInt32(b[o + 3]) << 24 }
        var bits: UInt64 = 0
        for i in 0..<8 { bits |= UInt64(b[5 + i]) << (8 * UInt64(i)) }
        let when = Double(bitPattern: bits)
        guard when.isFinite else { return nil }
        let n = (b.count - 13) / 2
        var out = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let v = Int16(bitPattern: UInt16(b[13 + 2 * i]) | UInt16(b[14 + 2 * i]) << 8)
            out[i] = v < 0 ? Float(v) / 32768 : Float(v) / 32767
        }
        return BotChunk(id: u32(1), when: when, samples: out)
    }

    /// Float samples (-1...1) to PCM16, as the web app does.
    public static func toPCM16(_ f: [Float]) -> [Int16] {
        f.map { v in
            let s = max(-1, min(1, v))
            return s < 0 ? Int16(s * 32768) : Int16(s * 32767)
        }
    }

    public static func rms(_ f: [Float]) -> Float {
        guard !f.isEmpty else { return 0 }
        return (f.reduce(0) { $0 + $1 * $1 } / Float(f.count)).squareRoot()
    }
}
