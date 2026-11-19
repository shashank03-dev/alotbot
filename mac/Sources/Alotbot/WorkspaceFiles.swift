import AppKit
import CryptoKit
import QuickLookUI
import UniformTypeIdentifiers

@MainActor extension BotWorkspaceModel {
    func chooseUpload() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await upload(url) }
    }
    func upload(_ url: URL) async {
        guard !busy else { return }
        busy = true; error = nil; notice = nil
        defer { busy = false }
        do {
            let metadata = try await Task.detached { () -> (Int, String) in
                let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
                var hash = SHA256(), count = 0
                while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
                    count += chunk.count
                    guard count <= 1024 * 1024 * 1024 else { throw BackendError.setup("Choose a file up to 1 GiB.") }
                    hash.update(data: chunk)
                }
                return (count, hash.finalize().map { String(format: "%02x", $0) }.joined())
            }.value
            struct Upload: Decodable { let id, url: String; let headers: [String: String] }
            let reply = try JSONDecoder().decode(Upload.self, from: await data("fileUploadBegin", ["name": url.lastPathComponent, "sizeBytes": metadata.0, "sha256": metadata.1, "contentType": UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"]))
            guard let destination = URL(string: reply.url), destination.scheme == "https" else { throw BackendError.setup("Invalid upload destination.") }
            var request = URLRequest(url: destination); request.httpMethod = "PUT"; request.allHTTPHeaderFields = reply.headers
            let session = URLSession(configuration: .ephemeral, delegate: NoUploadRedirects(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            let (_, response) = try await session.upload(for: request, fromFile: url)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw BackendError.setup("The upload failed. The file was not added to this bot.") }
            _ = try await data("fileUploadFinish", ["id": reply.id]); notice = "Uploaded \(url.lastPathComponent)"
            busy = false; await loadResources()
        } catch { self.error = error.localizedDescription }
    }
    func moreFiles() async {
        guard !busy, let cursor = resources?.nextFilesPage else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            struct Page: Decodable {
                struct File: Decodable { let name, path: String; let sizeBytes: ConnectionValue? }
                let files: [File]; let nextPageToken: String?
            }
            let page = try JSONDecoder().decode(Page.self, from: await data("filesPage", ["pageToken": cursor]))
            let known = Set(resources?.files.map(\.id) ?? [])
            let additions = page.files.map { WorkspaceFile(id: "agent:\($0.path)", name: $0.name, path: $0.path, source: "agent", sizeBytes: Double($0.sizeBytes?.text ?? "") ?? 0) }.filter { !known.contains($0.id) }
            resources?.files.append(contentsOf: additions)
            resources?.nextFilesPage = page.nextPageToken == cursor || page.nextPageToken == "" ? nil : page.nextPageToken
        } catch { self.error = error.localizedDescription }
    }
    func download(_ file: WorkspaceFile, preview: Bool) async {
        guard !busy else { return }
        var saveTo: URL?
        if !preview {
            let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: file.name).lastPathComponent
            guard panel.runModal() == .OK else { return }; saveTo = panel.url
        }
        busy = true; error = nil; notice = nil; defer { busy = false }
        var temporary: URL?
        do {
            struct Start: Decodable { let id: String; let size: Int }
            struct Chunk: Decodable { let data: String; let totalSize: Int }
            let start = try JSONDecoder().decode(Start.self, from: await data("fileDownloadBegin", ["path": file.path]))
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Alotbot-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            temporary = dir
            let target = dir.appendingPathComponent(URL(fileURLWithPath: file.name).lastPathComponent)
            guard FileManager.default.createFile(atPath: target.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
            let handle = try FileHandle(forWritingTo: target); defer { try? handle.close() }
            var offset = 0, firstChunk = true
            while firstChunk || offset < start.size {
                firstChunk = false
                try Task.checkCancellation()
                let chunk = try JSONDecoder().decode(Chunk.self, from: await data("fileChunk", ["id": start.id, "offset": offset]))
                guard chunk.totalSize == start.size, let bytes = Data(base64Encoded: chunk.data), (!bytes.isEmpty || start.size == 0), bytes.count <= 128 * 1024, offset + bytes.count <= start.size else { throw BackendError.setup("The file changed or its download was incomplete. Try again.") }
                try handle.write(contentsOf: bytes); offset += bytes.count
            }
            try handle.synchronize(); try handle.close()
            if let saveTo {
                // Stage beside the destination so the final replace stays atomic across volumes.
                let staged = saveTo.deletingLastPathComponent().appendingPathComponent(".grok-download-\(UUID().uuidString)")
                defer { try? FileManager.default.removeItem(at: staged) }
                try FileManager.default.copyItem(at: target, to: staged)
                if FileManager.default.fileExists(atPath: saveTo.path) { _ = try FileManager.default.replaceItemAt(saveTo, withItemAt: staged) }
                else { try FileManager.default.moveItem(at: staged, to: saveTo) }
                notice = "Saved \(saveTo.lastPathComponent)"
            } else {
                WorkspacePreview.shared.show(target, directory: dir); temporary = nil
            }
        } catch { self.error = error.localizedDescription }
        if let temporary { try? FileManager.default.removeItem(at: temporary) }
    }
}
private final class NoUploadRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor private final class WorkspacePreview: NSObject, @preconcurrency QLPreviewPanelDataSource, @preconcurrency QLPreviewPanelDelegate {
    static let shared = WorkspacePreview()
    private var file: URL?
    private var directory: URL?
    func show(_ file: URL, directory: URL) {
        if let old = self.directory { try? FileManager.default.removeItem(at: old) }
        self.file = file; self.directory = directory
        guard let panel = QLPreviewPanel.shared() else { return }
        panel.dataSource = self; panel.delegate = self; panel.reloadData(); panel.makeKeyAndOrderFront(nil)
    }
    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { file == nil ? 0 : 1 }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! { file as NSURL? }
    func windowWillClose(_ notification: Notification) {
        if let directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil; file = nil
    }
}
