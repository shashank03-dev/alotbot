import SwiftUI
import WebKit

struct WorkspaceResult: Identifiable { let id: String; let url: URL; let title: String }
/// Untrusted results have a fresh cookie store, no RPC bridge, no device capture and no local-file navigation.
struct IsolatedResultView: View {
    let result: WorkspaceResult
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 0) {
            HStack { Text(result.title).font(.headline); Spacer(); Button("Done") { dismiss() } }.padding(16)
            ResultWebView(url: result.url)
        }.frame(minWidth: 720, minHeight: 520)
    }
}
private struct ResultWebView: NSViewRepresentable {
    let url: URL
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.scheme == "https", url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = .all; configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator; view.uiDelegate = context.coordinator
        if url.scheme == "https", url.user == nil, url.password == nil { view.load(URLRequest(url: url)) }
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil; view.loadHTMLString("", baseURL: nil) }
}
