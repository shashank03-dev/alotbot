import Foundation
import Testing
@testable import GrokCallCore

@Suite struct ServerMessageTests {
    @Test func replyWithResult() throws {
        let m = try ServerMessage.decode(#"{"t":"reply","req":4,"ok":true,"result":{"bots":[]}}"#)
        guard case let .reply(req, ok, result, error, signedOut) = m else { Issue.record("not a reply"); return }
        #expect(req == 4)
        #expect(ok)
        #expect(error == nil)
        #expect(!signedOut)
        let obj = try JSONSerialization.jsonObject(with: try #require(result)) as? [String: Any]
        #expect((obj?["bots"] as? [Any])?.isEmpty == true)
    }

    @Test func replyErrorAndSignedOut() throws {
        let m = try ServerMessage.decode(#"{"t":"reply","req":2,"ok":false,"error":"no","signedOut":true}"#)
        #expect(m == .reply(req: 2, ok: false, result: nil, error: "no", signedOut: true))
    }

    @Test func replyWithBareValue() throws {
        // A plain string or number result still decodes.
        guard case let .reply(_, _, result, _, _) = try ServerMessage.decode(#"{"t":"reply","req":1,"ok":true,"result":"x"}"#) else { Issue.record("not a reply"); return }
        #expect(String(decoding: try #require(result), as: UTF8.self) == #""x""#)
    }

    @Test func replyMissingFields() throws {
        #expect(try ServerMessage.decode(#"{"t":"reply"}"#) == .reply(req: nil, ok: false, result: nil, error: nil, signedOut: false))
    }

    @Test func view() throws {
        let json = #"{"t":"view","view":{"phase":"in-call","muted":false,"userSpeaking":true,"waitingForHost":false,"focus":"b1","bots":[{"id":"b1","name":"Eve","color":"blue","shape":"star","status":"speaking","search":true,"looksAt":"host"}],"live":{"botId":"b1","text":"hi"},"linesSeq":3,"tasksVersion":2}}"#
        guard case let .view(v) = try ServerMessage.decode(json) else { Issue.record("not a view"); return }
        #expect(v.focus == "b1")
        #expect(v.bots.first?.looksAt == "host")
        #expect(v.bots.first?.error == nil)
        #expect(v.live == Live(botId: "b1", text: "hi"))
        #expect(v.linesSeq == 3)
    }

    @Test func lines() throws {
        let m = try ServerMessage.decode(#"{"t":"lines","lines":[{"seq":1,"who":"Me","text":"hi","cut":false},{"seq":2,"who":"Eve","botId":"b1","text":"yo","cut":true}]}"#)
        #expect(m == .lines([Line(seq: 1, who: "Me", botId: nil, text: "hi", cut: false), Line(seq: 2, who: "Eve", botId: "b1", text: "yo", cut: true)]))
    }

    @Test func tasks() throws {
        let m = try ServerMessage.decode(#"{"t":"tasks","version":5,"tasks":[{"id":1,"title":"A","owner":null,"status":"open","waitsOn":[2],"by":"Me","blockedBy":[2]}]}"#)
        guard case let .tasks(list) = m else { Issue.record("not tasks"); return }
        #expect(list.version == 5)
        #expect(list.tasks.first?.blockedBy == [2])
        #expect(list.tasks.first?.parent == nil)
    }

    @Test func smallMessages() throws {
        #expect(try ServerMessage.decode(#"{"t":"workspaceChanged"}"#) == .workspaceChanged)
        #expect(try ServerMessage.decode(#"{"t":"stopAudio","id":7}"#) == .stopAudio(7))
        #expect(try ServerMessage.decode(#"{"t":"stopAudio"}"#) == .stopAudio(-1))
        #expect(try ServerMessage.decode(#"{"t":"ended"}"#) == .ended)
        #expect(try ServerMessage.decode(#"{"t":"future"}"#) == .unknown("future"))
    }

    @Test func malformed() {
        #expect(throws: (any Error).self) { try ServerMessage.decode("not json") }
        #expect(throws: (any Error).self) { try ServerMessage.decode(#"{"no":"type"}"#) }
        #expect(throws: (any Error).self) { try ServerMessage.decode("[1,2]") }
        #expect(throws: (any Error).self) { try ServerMessage.decode(#"{"t":"view","view":{"phase":1}}"#) }
        #expect(throws: (any Error).self) { try ServerMessage.decode(#"{"t":"lines"}"#) }
    }

    @Test func request() throws {
        let s = try encodeRequest(req: 3, op: "setVoice", args: ["botId": "b1", "speed": 1.5])
        #expect(s == #"{"botId":"b1","op":"setVoice","req":3,"speed":1.5}"#)
        #expect(try encodeRequest(req: 1, op: "state") == #"{"op":"state","req":1}"#)
        // The request's own fields win over args with the same names.
        #expect(try encodeRequest(req: 9, op: "x", args: ["req": 1, "op": "y"]) == #"{"op":"x","req":9}"#)
    }

    @Test func modelDecoding() throws {
        let bot = try JSONDecoder().decode(Bot.self, from: Data(#"{"id":"a","name":"A","speed":1.25}"#.utf8))
        #expect(bot == Bot(id: "a", name: "A", speed: 1.25))
        let hello = try JSONDecoder().decode(Hello.self, from: Data(##"{"version":1,"serverNow":12.5,"user":"Me","choices":{"voices":["eve"],"speeds":[1],"languages":["en"],"shapes":["blob"],"pickerShapes":["blob"],"colors":{"red":"#FF263C"},"statuses":["open"]}}"##.utf8))
        #expect(hello.version == protocolVersion)
        #expect(hello.choices.colors["red"] == "#FF263C")
        let left = try JSONDecoder().decode(LeaveResult.self, from: Data(#"{"file":null,"summary":"s","actionItems":["a"]}"#.utf8))
        #expect(left.file == nil)
        let past = try JSONDecoder().decode(PastCall.self, from: Data(#"{"file":"f.json","at":1,"summary":""}"#.utf8))
        #expect(past.id == "f.json")
        #expect(LoginState(state: "signed-in", error: nil).state == "signed-in")
        #expect(Line(seq: 4, who: "x", botId: nil, text: "", cut: false).id == 4)
    }
}

@Suite struct AudioFrameTests {
    @Test func micLayout() {
        let d = [UInt8](AudioFrames.encodeMic(level: 0.5, samples: [1, -1, 0x1234]))
        #expect(d.count == 5 + 6)
        #expect(d[0] == AudioFrames.mic)
        #expect(Array(d[1..<5]) == [0x00, 0x00, 0x00, 0x3F]) // 0.5 as little-endian f32
        #expect(Array(d[5...]) == [0x01, 0x00, 0xFF, 0xFF, 0x34, 0x12])
    }

    func botFrame(id: UInt32, when: Double, samples: [Int16]) -> Data {
        var d = Data([AudioFrames.botAudio])
        withUnsafeBytes(of: id.littleEndian) { d.append(contentsOf: $0) }
        withUnsafeBytes(of: when.bitPattern.littleEndian) { d.append(contentsOf: $0) }
        for s in samples { withUnsafeBytes(of: s.littleEndian) { d.append(contentsOf: $0) } }
        return d
    }

    @Test func botRoundTrip() throws {
        let c = try #require(AudioFrames.decodeBot(botFrame(id: 0xA1B2C3D4, when: 1234.5, samples: [32767, -32768, 0])))
        #expect(c.id == 0xA1B2C3D4)
        #expect(c.when == 1234.5)
        #expect(c.samples == [1, -1, 0])
        #expect(AudioFrames.decodeBot(botFrame(id: 1, when: 0, samples: []))?.samples == [])
    }

    @Test func badBotFrames() {
        #expect(AudioFrames.decodeBot(Data()) == nil)
        #expect(AudioFrames.decodeBot(Data(repeating: 2, count: 12)) == nil)
        var wrongType = botFrame(id: 1, when: 0, samples: [1])
        wrongType[0] = 1
        #expect(AudioFrames.decodeBot(wrongType) == nil)
        #expect(AudioFrames.decodeBot(botFrame(id: 1, when: 0, samples: [1]) + Data([0])) == nil) // half a sample
        #expect(AudioFrames.decodeBot(botFrame(id: 1, when: .nan, samples: [1])) == nil)
        #expect(AudioFrames.decodeBot(botFrame(id: 1, when: .infinity, samples: [1])) == nil)
    }

    @Test func pcm16() {
        #expect(AudioFrames.toPCM16([0, 1, -1, 2, -2, 0.5]) == [0, 32767, -32768, 32767, -32768, 16383])
        #expect(AudioFrames.toPCM16([]) == [])
    }

    @Test func rms() {
        #expect(AudioFrames.rms([]) == 0)
        #expect(AudioFrames.rms([1, -1]) == 1)
        #expect(abs(AudioFrames.rms([0.5, 0.5, 0.5, 0.5]) - 0.5) < 1e-6)
    }
}
