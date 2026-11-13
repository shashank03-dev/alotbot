import AVFoundation
import Foundation
import GrokCallCore

/// Where the backend lives and how to run it. Set by the build script in Info.plist; GROK_CALL_REPO and
/// GROK_CALL_NODE override it (for `swift run`).
struct BackendPaths {
    let repo: URL
    let node: URL
    let dataDir: URL

    static func resolve() throws -> BackendPaths {
        let env = ProcessInfo.processInfo.environment
        let info = Bundle.main.infoDictionary ?? [:]
        guard let repo = env["GROK_CALL_REPO"] ?? info["GCRepoPath"] as? String else {
            throw BackendError.setup("The app doesn't know where the Grok Call folder is. Rebuild it with mac/build-app.sh.")
        }
        let main = URL(fileURLWithPath: repo).appendingPathComponent("src/overlay/main.ts")
        guard FileManager.default.fileExists(atPath: main.path) else {
            throw BackendError.setup("The Grok Call folder moved: \(repo) has no src/overlay/main.ts. Rebuild the app from its new place.")
        }
        let candidates = [env["GROK_CALL_NODE"], info["GCNodePath"] as? String, "/opt/homebrew/bin/node", "/usr/local/bin/node"].compactMap { $0 }
        guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw BackendError.setup("Node.js was not found. Install Node 22.18 or newer, then reopen Grok Call.")
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("GrokCall", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return BackendPaths(repo: URL(fileURLWithPath: repo), node: URL(fileURLWithPath: node), dataDir: support)
    }
}

enum BackendError: LocalizedError, Equatable {
    case setup(String)
    case stopped(String)
    case refused(String, signedOut: Bool)
    case notConnected

    var errorDescription: String? {
        switch self {
        case .setup(let s), .stopped(let s): return s
        case .refused(let s, _): return s
        case .notConnected: return "Grok Call's backend isn't connected."
        }
    }

    var signedOut: Bool { if case .refused(_, true) = self { return true } else { return false } }
}

/// Runs `node src/overlay/main.ts` and talks to it over its local WebSocket.
final class Backend: NSObject, URLSessionWebSocketDelegate {
    var onAuthenticationLost: (() -> Void)?
    var onMessage: ((ServerMessage) -> Void)?
    var onAudio: ((AudioFrames.BotChunk) -> Void)?
    /// The hello reply, and the local clock reading that matches its `serverNow`.
    var onConnected: ((Hello, ClockMap) -> Void)?
    var onStopped: ((String) -> Void)?

    private(set) var paths: BackendPaths?
    private var process: Process?
    private var stdin: Pipe?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pending: [Int: CheckedContinuation<Data?, Error>] = [:]
    private var nextReq = 0
    private let lock = NSLock()
    private var stopping = false
    private let resolvePaths: () throws -> BackendPaths

    init(resolvePaths: @escaping () throws -> BackendPaths = BackendPaths.resolve) {
        self.resolvePaths = resolvePaths
        super.init()
    }

    /// Starts the backend and connects. Calls `onConnected` once it answered hello.
    func start() {
        stopping = false
        do {
            let p = try resolvePaths()
            paths = p
            try launch(p)
        } catch {
            fail(error.localizedDescription)
        }
    }

    private func launch(_ p: BackendPaths) throws {
        let token = (0..<48).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        let proc = Process()
        proc.executableURL = p.node
        proc.arguments = [p.repo.appendingPathComponent("src/overlay/main.ts").path]
        proc.currentDirectoryURL = p.repo
        var env = ProcessInfo.processInfo.environment
        env["OVERLAY_TOKEN"] = token
        env["OVERLAY_PORT"] = "0"
        env["OVERLAY_DATA_DIR"] = p.dataDir.path
        proc.environment = env
        let input = Pipe(), output = Pipe(), errors = Pipe()
        proc.standardInput = input // closing it (or this app dying) stops the backend
        proc.standardOutput = output
        proc.standardError = errors
        var errText = ""
        errors.fileHandleForReading.readabilityHandler = { h in
            if let s = String(data: h.availableData, encoding: .utf8), !s.isEmpty {
                errText = String((errText + s).suffix(2000))
                AppLog.write("backend stderr: \(s.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        }
        var started = false
        output.fileHandleForReading.readabilityHandler = { [weak self, weak proc] h in
            guard let self, let proc, self.process === proc, let s = String(data: h.availableData, encoding: .utf8) else { return }
            if !started, let r = s.range(of: #"READY (\d+)"#, options: .regularExpression), let port = Int(s[r].dropFirst(6)) {
                started = true
                DispatchQueue.main.async { guard self.process === proc else { return }; self.connect(port: port, token: token) }
            }
        }
        proc.terminationHandler = { [weak self] pr in
            DispatchQueue.main.async {
                guard let self, !self.stopping, self.process === pr else { return }
                let last = errText.split(separator: "\n").last.map(String.init) ?? ""
                self.fail("The backend stopped (exit \(pr.terminationStatus))\(last.isEmpty ? "." : ": \(last)")")
            }
        }
        process = proc
        try proc.run()
        stdin = input
    }

    private func connect(port: Int, token: String) {
        var req = URLRequest(url: URL(string: "ws://127.0.0.1:\(port)/ws")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let s = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        let ws = s.webSocketTask(with: req)
        ws.maximumMessageSize = 4 * 1024 * 1024
        session = s
        socket = ws
        ws.resume()
        receive(ws)
        Task {
            do {
                let sent = Clock.now()
                let hello: Hello = try await self.request("hello")
                // The backend read its clock somewhere between send and reply: take the middle.
                let clock = ClockMap(localAtHello: (sent + Clock.now()) / 2, serverAtHello: hello.serverNow)
                guard hello.version == protocolVersion else {
                    DispatchQueue.main.async { guard self.socket === ws else { return }; self.fail("The backend speaks protocol \(hello.version); this app needs \(protocolVersion). Rebuild the app.") }
                    return
                }
                DispatchQueue.main.async { guard self.socket === ws else { return }; self.onConnected?(hello, clock) }
            } catch {
                DispatchQueue.main.async { guard self.socket === ws else { return }; self.fail("Couldn't talk to the backend: \(error.localizedDescription)") }
            }
        }
    }

    private func receive(_ ws: URLSessionWebSocketTask) {
        ws.receive { [weak self] result in
            guard let self, self.socket === ws else { return }
            switch result {
            case .failure(let err):
                DispatchQueue.main.async { if !self.stopping && self.socket === ws { self.fail("Lost the backend connection: \(err.localizedDescription)") } }
            case .success(.string(let text)):
                self.handle(text, from: ws)
                self.receive(ws)
            case .success(.data(let data)):
                if let chunk = AudioFrames.decodeBot(data) { self.onAudio?(chunk) }
                self.receive(ws)
            @unknown default:
                self.receive(ws)
            }
        }
    }

    private func handle(_ text: String, from ws: URLSessionWebSocketTask) {
        guard let msg = try? ServerMessage.decode(text) else { return }
        if case let .reply(req?, ok, result, error, signedOut) = msg {
            lock.lock()
            let cont = pending.removeValue(forKey: req)
            lock.unlock()
            if signedOut { DispatchQueue.main.async { [weak self] in self?.onAuthenticationLost?() } }
            if ok { cont?.resume(returning: result) } else { cont?.resume(throwing: BackendError.refused(error ?? "Request failed.", signedOut: signedOut)) }
            return
        }
        DispatchQueue.main.async { guard self.socket === ws else { return }; self.onMessage?(msg) }
    }

    /// Sends a command and waits for its reply.
    func request<T: Decodable>(_ op: String, _ args: [String: Any] = [:], as: T.Type = T.self) async throws -> T {
        let data = try await raw(op, args)
        return try JSONDecoder().decode(T.self, from: data ?? Data("null".utf8))
    }

    /// Sends a command whose reply has no useful result.
    func send(_ op: String, _ args: [String: Any] = [:]) async throws {
        _ = try await raw(op, args)
    }

    private func raw(_ op: String, _ args: [String: Any]) async throws -> Data? {
        guard let ws = socket else { throw BackendError.notConnected }
        let req = takeReq()
        let text = try encodeRequest(req: req, op: op, args: args)
        return try await withCheckedThrowingContinuation { cont in
            lock.lock()
            pending[req] = cont
            lock.unlock()
            ws.send(.string(text)) { [weak self] err in
                guard let err, let self else { return }
                self.lock.lock()
                let c = self.pending.removeValue(forKey: req)
                self.lock.unlock()
                c?.resume(throwing: err)
            }
        }
    }

    private func takeReq() -> Int {
        lock.lock()
        defer { lock.unlock() }
        nextReq += 1
        return nextReq
    }

    /// Mic audio, straight from the audio thread.
    func sendMic(_ data: Data) {
        socket?.send(.data(data)) { _ in }
    }

    private func fail(_ why: String) {
        AppLog.write("backend failed: \(why)")
        lock.lock()
        let waiting = pending
        pending.removeAll()
        lock.unlock()
        for c in waiting.values { c.resume(throwing: BackendError.stopped(why)) }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
        if process?.isRunning == true { stopping = true; process?.terminate() }
        process = nil
        onStopped?(why)
    }

    /// Stops the backend (it also stops by itself if this app dies, because its stdin closes).
    func stop() {
        stopping = true
        lock.lock()
        let waiting = pending
        pending.removeAll()
        lock.unlock()
        for c in waiting.values { c.resume(throwing: BackendError.stopped("The backend stopped.")) }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
        try? stdin?.fileHandleForWriting.close()
        process?.terminate()
        process = nil
    }

    func restart() {
        stop()
        start()
    }
}

/// This Mac's steady clock in seconds (the same one Core Audio's host time uses).
enum Clock {
    static func now() -> Double { AVHostTime.seconds(mach_absolute_time()) }
}

enum AVHostTime {
    static func seconds(_ host: UInt64) -> Double { AVAudioTime.seconds(forHostTime: host) }
    static func host(_ seconds: Double) -> UInt64 { AVAudioTime.hostTime(forSeconds: seconds) }
}
