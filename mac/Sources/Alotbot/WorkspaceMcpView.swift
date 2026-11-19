import AppKit
import SwiftUI
import WebKit

struct WorkspaceMcpDocument: Decodable { let html, metaJson: String; let toolArgumentsJson, toolResultJson: String? }
struct WorkspaceMcpView: View {
    @ObservedObject var model: BotWorkspaceModel
    let card: WorkspaceActivity.Card
    @Environment(\.dismiss) private var dismiss
    @Local private var document: WorkspaceMcpDocument?
    @Local private var error: String?
    var body: some View {
        VStack(spacing: 0) {
            HStack { Text("App · \(model.name)").font(.headline); Spacer(); Button("Done") { dismiss() } }.padding(16)
            if let error { Text(error).foregroundStyle(.red).padding(16) }
            if let document { McpDocumentWebView(model: model, card: card, document: document) }
            else if error == nil { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.frame(minWidth: 760, minHeight: 540)
        .task { do { document = try JSONDecoder().decode(WorkspaceMcpDocument.self, from: await model.data("mcpOpen", ["id": card.id])) } catch { self.error = error.localizedDescription } }
    }
}
struct McpDocumentWebView: NSViewRepresentable {
    let model: BotWorkspaceModel
    let card: WorkspaceActivity.Card
    let document: WorkspaceMcpDocument
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        let model: BotWorkspaceModel
        let card: WorkspaceActivity.Card
        weak var view: WKWebView?
        private var running = false
        private var closed = false
        init(model: BotWorkspaceModel, card: WorkspaceActivity.Card) { self.model = model; self.card = card }
        func close() { closed = true; view = nil }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !closed, message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let id = body["id"], let method = body["method"] as? String else { return }
            guard !running else { reply(id, error: "Another app tool request is awaiting its result"); return }
            guard method == "tools/call", let params = body["params"] as? [String: Any], let name = params["name"] as? String, name.count <= 500, let arguments = params["arguments"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: arguments), data.count <= 500_000 else { reply(id, error: "Unsupported app request"); return }
            running = true
            let alert = NSAlert(); alert.messageText = "Allow this app to run \(name)?"
            alert.informativeText = "Bot: \(model.name). Review the full arguments before allowing this tool."
            let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 500, height: 220)); text.isEditable = false; text.isRichText = false; text.string = String(decoding: data, as: UTF8.self)
            let scroll = NSScrollView(frame: text.frame); scroll.documentView = text; scroll.hasVerticalScroller = true; alert.accessoryView = scroll
            alert.addButton(withTitle: "Allow once"); alert.addButton(withTitle: "Deny")
            guard alert.runModal() == .alertFirstButtonReturn else { running = false; reply(id, error: "The user denied this request"); return }
            Task { @MainActor in
                defer { self.running = false }
                do {
                    struct Result: Decodable { let resultJson: String }
                    let result = try JSONDecoder().decode(Result.self, from: await self.model.data("mcpCall", ["id": self.card.id, "toolName": name, "arguments": arguments, "userConfirmed": true]))
                    let object = try JSONSerialization.jsonObject(with: Data(result.resultJson.utf8))
                    self.reply(id, result: object)
                } catch { self.reply(id, error: error.localizedDescription) }
            }
        }
        private func reply(_ id: Any, result: Any? = nil, error: String? = nil) {
            guard !closed, let view else { return }
            var object: [String: Any] = ["jsonrpc": "2.0", "id": id]
            if let error { object["error"] = ["code": -32000, "message": error] } else { object["result"] = result ?? [:] }
            guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
            let encoded = data.base64EncodedString()
            view.evaluateJavaScript("window.grokAppReply(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('\(encoded)'),c=>c.charCodeAt(0)))));") { _, _ in }
        }
        func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            // Navigation would replace the document and discard its resource policy.
            // HTTPS subresources are governed by the original document's CSP instead.
            decisionHandler(McpDocumentWebView.allowsNavigation(url) ? .allow : .cancel)
        }
        func webView(_ view: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
    }
    func makeCoordinator() -> Coordinator { Coordinator(model: model, card: card) }
    static func allowsNavigation(_ url: URL) -> Bool {
        ["about:blank", "about:srcdoc"].contains(url.absoluteString)
    }
    static func allowedOrigin(_ raw: String) -> String? {
        guard let url = URL(string: raw), url.scheme == "https", url.user == nil, url.password == nil,
              let host = url.host?.lowercased(), host.contains("."),
              host.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-").contains($0) }),
              host.contains(where: { $0.isLetter }),
              ![".localhost", ".local", ".internal", ".test", ".invalid"].contains(where: { host.hasSuffix($0) }) else { return nil }
        return "https://" + host + (url.port.map { ":\($0)" } ?? "")
    }
    static func sandboxDocument(_ document: WorkspaceMcpDocument) -> String {
        let metadata = (try? JSONSerialization.jsonObject(with: Data(document.metaJson.utf8))) as? [String: Any] ?? [:]
        let ui = metadata["ui"] as? [String: Any] ?? [:], csp = ui["csp"] as? [String: Any] ?? [:]
        func domains(_ key: String) -> String {
            (csp[key] as? [String] ?? []).compactMap(allowedOrigin).joined(separator: " ")
        }
        let resources = domains("resourceDomains"), connections = domains("connectDomains")
        let policy = "default-src 'none'; script-src 'unsafe-inline' \(resources); style-src 'unsafe-inline' \(resources); img-src data: blob: \(resources); font-src \(resources); media-src blob: \(resources); connect-src \(connections); frame-src 'none'; form-action 'none'; base-uri 'none'"
        let child = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">" + document.html
        let encoded = Data(child.utf8).base64EncodedString()
        let input = Data((document.toolArgumentsJson ?? "{}").utf8).base64EncodedString()
        let output = Data((document.toolResultJson ?? "{}").utf8).base64EncodedString()
        return """
        <!doctype html><html><head><meta name="referrer" content="no-referrer"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe id="app" sandbox="allow-scripts"></iframe><script>
        const frame=document.getElementById('app');
        const decode=value=>{try{return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0))))}catch{return {}}};
        const input=decode('\(input)'),output=decode('\(output)');
        frame.srcdoc=new TextDecoder().decode(Uint8Array.from(atob('\(encoded)'),c=>c.charCodeAt(0)));
        window.grokAppReply=message=>frame.contentWindow.postMessage(message,'*');
        addEventListener('message',event=>{
          if(event.source!==frame.contentWindow)return;
          const m=event.data;if(!m||m.jsonrpc!=='2.0'||typeof m.method!=='string')return;
          if(m.method==='ui/initialize'){grokAppReply({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'Alotbot',version:'1.0'},hostCapabilities:{serverTools:{}},hostContext:{theme:'dark',displayMode:'inline',availableDisplayModes:['inline']}}});return;}
          if(m.method==='ui/notifications/initialized'){frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:input}},'*');frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:output},'*');return;}
          if(m.id===undefined)return;
          if(m.method==='tools/call'){window.webkit.messageHandlers.grokMcp.postMessage(m);return;}
          grokAppReply({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'This host does not support that method'}});
        });</script></body></html>
        """
    }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent(); configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false; configuration.userContentController.add(context.coordinator, name: "grokMcp")
        let view = WKWebView(frame: .zero, configuration: configuration); view.navigationDelegate = context.coordinator; view.uiDelegate = context.coordinator; context.coordinator.view = view
        view.loadHTMLString(Self.sandboxDocument(document), baseURL: nil); return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { coordinator.close(); view.configuration.userContentController.removeScriptMessageHandler(forName: "grokMcp"); view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil; view.loadHTMLString("", baseURL: nil) }
}
