import AppKit
import SwiftUI
import WebKit

private final class ControlledDesktopWebView: WKWebView {
    var controlled = false
    override var acceptsFirstResponder: Bool { controlled }
    override func hitTest(_ point: NSPoint) -> NSView? { controlled ? super.hitTest(point) : nil }
}
struct CloudDesktopView: NSViewRepresentable {
    let viewer: WorkspaceViewer
    let controlled: Bool
    final class Coordinator: NSObject, WKNavigationDelegate {
        var base: URL?
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url, let base, target.scheme == base.scheme, target.host == base.host, target.port == base.port, target.path.hasPrefix(base.deletingLastPathComponent().path + "/") else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Alotbot owns connection/control feedback; retain provider DOM nodes required by noVNC.
            webView.evaluateJavaScript("for(const id of ['noVNC_control_bar','noVNC_transition']){const element=document.getElementById(id);if(element)element.style.display='none';}document.getElementById('noVNC_status')?.setAttribute('aria-live','polite');") { _, _ in }
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = ControlledDesktopWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        if let url = URL(string: viewer.url) { context.coordinator.base = url; var request = URLRequest(url: url); request.setValue(viewer.authorization, forHTTPHeaderField: "Authorization"); view.load(request) }
        return view
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard let view = nsView as? ControlledDesktopWebView else { return }
        view.controlled = controlled
        let value = controlled ? "false" : "true"
        view.evaluateJavaScript("import(new URL('app/ui.js',location.href).href).then(m=>{const ui=m.default;ui.forceSetting('view_only',\(value));if(ui.rfb)ui.rfb.viewOnly=\(value);});") { _, _ in }
        if !controlled && view.window?.firstResponder === view { view.window?.makeFirstResponder(nil) }
    }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { view.stopLoading(); view.navigationDelegate = nil; view.loadHTMLString("", baseURL: nil) }
}
