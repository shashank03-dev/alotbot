import AppKit
import SwiftUI
import Foundation
import Testing
@testable import Alotbot

@Suite @MainActor struct BotWorkspaceTests {
    @Test func olderActivityActionsCarryTheirDisplayedPositionForFreshLookup() async throws {
        var positions: [Int?] = []
        let model = BotWorkspaceModel(botId: "bot", name: "Research", request: { _, args in
            positions.append(args["seq"] as? Int); return Data("{}".utf8)
        })
        model.activity = try JSONDecoder().decode(WorkspaceActivity.self, from: Data(#"{"cards":[{"id":"old","seq":50,"kind":"email-draft","title":"Draft","text":"","status":"editable","requestId":"","sessionId":"s","actions":["sendDraft"],"options":[]}],"beforeSeq":50}"#.utf8))
        _ = try await model.data("draftSend", ["id": "old"])
        _ = try await model.data("cardDecision", ["id": "old"])
        _ = try await model.data("fileChunk", ["id": "old"])
        _ = try await model.data("draftSend", ["id": "other"])
        #expect(positions == [50, 50, nil, nil])
    }
    @Test func workspaceKeepsBotIdentityAndDoesNotWakeAComputerForResources() async throws {
        var commands: [(String,String)] = []
        let model = BotWorkspaceModel(botId: "bot-1", name: "Research", request: { action, args in
            commands.append((action, args["botId"] as? String ?? ""))
            return Data(#"{"bot":{"id":"bot-1","agentId":"uuid-1","name":"Research"},"routines":[],"skills":[],"files":[],"memory":{},"library":{},"plugins":{},"warnings":[],"nextFilesPage":null}"#.utf8)
        })
        await model.loadResources()
        #expect(commands.count == 1 && commands[0].0 == "resources" && commands[0].1 == "bot-1")
        #expect(model.resources?.bot.agentId == "uuid-1" && !model.busy)
    }
    @Test func failureRetainsDataAndEveryCommandUsesItsOwnBot() async {
        var targets: [String] = []
        let model = BotWorkspaceModel(botId: "a", name: "Same name", request: { _, args in
            targets.append(args["botId"] as? String ?? "")
            throw BackendError.setup("Offline")
        })
        await model.loadResources()
        #expect(model.error == "Offline" && !model.busy && targets == ["a"])
    }
}

@Suite @MainActor struct WorkspaceControlTests {
    @Test func closingViewerReleasesNativeStateBeforeBackendAcknowledges() async throws {
        var commands: [String] = []
        let model = BotWorkspaceModel(botId: "a", name: "A", request: { action, args in
            #expect(args["botId"] as? String == "a")
            commands.append(action)
            if action == "computerOpen" { return Data(#"{"id":"view","url":"http://127.0.0.1/computer/view/vnc.html","authorization":"Bearer local","state":"connecting","hasControl":false}"#.utf8) }
            if action == "computerControl" { return Data(#"{"hasControl":true}"#.utf8) }
            return Data(#"{"ok":true}"#.utf8)
        })
        await model.openComputer(); #expect(model.viewer?.id == "view" && !model.hasControl)
        await model.control(true); #expect(model.hasControl)
        await model.closeComputer(); #expect(model.viewer == nil && !model.hasControl && !model.viewerConnected)
        #expect(commands == ["computerOpen", "computerStatus", "teachStatus", "computerControl", "computerClose"])
    }
    @Test func closeFailureIsVisibleAndNeverRetainsInputControl() async {
        let model = BotWorkspaceModel(botId: "a", name: "A", request: { _, _ in throw BackendError.setup("Handoff could not finish") })
        model.viewer = WorkspaceViewer(id: "v", url: "http://127.0.0.1", authorization: "Bearer local", state: "ready", hasControl: false)
        model.hasControl = true
        await model.closeComputer()
        #expect(model.viewer == nil && !model.hasControl && model.error == "Handoff could not finish")
    }
    @Test func routinePermissionsAndActivityKeepProviderIdentity() throws {
        let routine = try JSONDecoder().decode(WorkspaceRoutine.self, from: Data(#"{"id":"r","name":"Routine","spec":{"prompt":"Report","trigger":{"type":"cron","schedule":"0 9 * * *"}},"enabled":true,"permissions":{"allowedActions":["GROK_BOT_AUTOMATION_ACTION_OPEN"]}}"#.utf8))
        #expect(routine.allows("OPEN") && !routine.allows("EDIT") && routine.triggerDescription == "0 9 * * *")
        let activity = try JSONDecoder().decode(WorkspaceActivity.self, from: Data(#"{"cards":[{"id":"entry","seq":5,"kind":"auto-review-approval","title":"Approval","text":"Deploy","status":"pending","requestId":"r","sessionId":"s","actions":["approve","deny"],"options":[]}],"beforeSeq":5}"#.utf8))
        #expect(activity.cards.first?.requestId == "r" && activity.cards.first?.sessionId == "s")
    }
}

@Suite @MainActor struct WorkspaceRenderingTests {
    @Test func setupCardsRenderWithTheirScopedControls() async throws {
        guard ProcessInfo.processInfo.environment["WORKSPACE_SCREENSHOTS"] == "1" else { return }
        _ = NSApplication.shared
        let model = BotWorkspaceModel(botId: "fixture", name: "Research", request: { _, _ in
            Data(##"{"shape":"cloud","color":"blue","shapes":["cloud","blob"],"colors":{"blue":"#00f","black":"#000"}}"##.utf8)
        })
        for kind in ["appearance-picker", "email-offer", "team-access", "publish-approval", "notifications-enable"] {
            let data: [String: Any] = ["id": "fixture", "seq": 1, "kind": kind, "title": kind.replacingOccurrences(of: "-", with: " ").capitalized, "text": "", "status": "pending", "requestId": "", "sessionId": "session", "actions": [], "options": [], "details": ["email": "research@example.test", "slug": "research-report", "apex": "apps.example.test", "controlRevision": "fixture"]]
            let card = try JSONDecoder().decode(WorkspaceActivity.Card.self, from: JSONSerialization.data(withJSONObject: data))
            let host = NSHostingView(rootView: WorkspaceSetupCardEditor(model: model, card: card).frame(width: 620, height: 580, alignment: .topLeading).background(Color(nsColor: .windowBackgroundColor)))
            host.frame = NSRect(x: 0, y: 0, width: 620, height: 580)
            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
            try await Task.sleep(for: .milliseconds(100))
            host.layoutSubtreeIfNeeded()
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "/tmp/grok-setup-\(kind).png"))
            #expect(bitmap.pixelsWide >= 620 && bitmap.pixelsHigh >= 580)
            window.close()
        }
    }
    @Test func workspaceRendersRoutineAndEmptyComputerStates() async throws {
        guard ProcessInfo.processInfo.environment["WORKSPACE_SCREENSHOTS"] == "1" else { return }
        _ = NSApplication.shared
        let model = BotWorkspaceModel(botId: "fixture", name: "Research", request: { _, _ in throw BackendError.setup("Fixture is offline") })
        model.resources = try JSONDecoder().decode(WorkspaceResources.self, from: Data(#"{"bot":{"id":"fixture","agentId":"uuid","name":"Research"},"routines":[{"id":"r","name":"Morning research","spec":{"prompt":"Review project updates and prepare a short report.","trigger":{"type":"cron","schedule":"0 9 * * 1-5"}},"enabled":true,"permissions":{"allowedActions":["GROK_BOT_AUTOMATION_ACTION_OPEN","GROK_BOT_AUTOMATION_ACTION_EDIT","GROK_BOT_AUTOMATION_ACTION_TOGGLE","GROK_BOT_AUTOMATION_ACTION_DELETE"]}}],"skills":[],"files":[],"memory":{},"library":{},"plugins":{},"warnings":[],"nextFilesPage":null}"#.utf8))
        for tab in [WorkspaceTab.routines, .computer] {
            model.tab = tab
            let host = NSHostingView(rootView: BotWorkspaceView(model: model))
            host.frame = NSRect(x: 0, y: 0, width: 1080, height: 740)
            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host
            host.layoutSubtreeIfNeeded()
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: "/tmp/grok-workspace-\(tab.rawValue).png"))
            #expect(bitmap.pixelsWide >= 1080 && bitmap.pixelsHigh >= 740)
            window.close()
        }
    }
}

import WebKit
import Vision
@Suite @MainActor struct LiveWorkspaceDesktopTests {
    @Test func providerDesktopLoadsInTheNativeWebKitViewWhenRequested() async throws {
        guard let path = ProcessInfo.processInfo.environment["WORKSPACE_VIEWER_INFO"] else { return }
        let viewer = try JSONDecoder().decode(WorkspaceViewer.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        _ = NSApplication.shared
        let host = NSHostingView(rootView: CloudDesktopView(viewer: viewer, controlled: false))
        host.frame = NSRect(x: 0, y: 0, width: 1000, height: 700)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; host.layoutSubtreeIfNeeded()
        window.orderBack(nil)
        defer { window.close() }
        func webView(_ view: NSView) -> WKWebView? {
            if let view = view as? WKWebView { return view }
            return view.subviews.compactMap { webView($0) }.first
        }
        var connected = false
        var foundWebView = false
        var lastError = 0
        var lastState = ""
        var lastException = ""
        for _ in 0..<90 {
            try await Task.sleep(nanoseconds: 500_000_000)
            guard let web = webView(host), web.url?.scheme == "http" else { continue }
            foundWebView = true
            do {
            if let state = try await web.callAsyncJavaScript("const ui=(await import(new URL('app/ui.js',location.href).href)).default; const c=document.querySelector('canvas');const painted=!!c&&c.width>0&&c.height>0&&c.getContext('2d').getImageData(0,0,1,1).data[3]===255;return {state:ui.rfb?._rfbConnectionState,viewOnly:ui.rfb?.viewOnly,painted};", arguments: [:], in: nil, contentWorld: .page) as? [String: Any], state["state"] as? String == "connected", state["painted"] as? Bool == true {
                #expect(state["viewOnly"] as? Bool == true)
                connected = true; break
            } else { lastState = (try? await web.evaluateJavaScript("document.readyState + ':' + !!document.querySelector('canvas')")) as? String ?? "no document" }
            } catch { lastError = (error as NSError).code; lastException = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? "" }
        }
        if !connected { print("Native desktop diagnostic: view=\(foundWebView), code=\(lastError), state=\(lastState), exception=\(lastException)") }
        #expect(connected, "The real provider desktop must complete RFB initialization inside the native WebKit view.")
        if connected, let snapshot = ProcessInfo.processInfo.environment["WORKSPACE_DESKTOP_SNAPSHOT"], let web = webView(host) {
            let diagnostic = try await web.callAsyncJavaScript("const ui=(await import(new URL('app/ui.js',location.href).href)).default;return {uiConnected:ui.connected,rootClass:document.documentElement.className,bodyClass:document.body.className,transitionClass:document.getElementById('noVNC_transition')?.className};", arguments: [:], in: nil, contentWorld: .page)
            print("Native desktop paint diagnostic: \(diagnostic ?? "none")")
            let captured = try await web.takeSnapshot(configuration: nil)
            let bitmap = try #require(captured.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
            try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: snapshot))
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: snapshot)
        }
        if connected, let signal = ProcessInfo.processInfo.environment["WORKSPACE_CONTROL_SIGNAL"] {
            let marker = ProcessInfo.processInfo.environment["WORKSPACE_DESKTOP_INPUT_MARKER"]
            func screenText() async throws -> String {
                let web = try #require(webView(host))
                let image = try await web.takeSnapshot(configuration: nil)
                let cg = try #require(image.cgImage(forProposedRect: nil, context: nil, hints: nil))
                let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
                try VNImageRequestHandler(cgImage: cg).perform([request])
                return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").uppercased().filter { $0.isLetter || $0.isNumber }
            }
            func clickFixture() async throws {
                let web = try #require(webView(host))
                _ = try await web.evaluateJavaScript("(()=>{const c=document.querySelector('canvas'),r=c.getBoundingClientRect(),p={bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};c.dispatchEvent(new MouseEvent('mousemove',p));c.dispatchEvent(new MouseEvent('mousedown',{...p,buttons:1}));c.dispatchEvent(new MouseEvent('mouseup',{...p,buttons:0}));})()")
            }
            if marker != nil {
                var fixtureVisible = false
                for _ in 0..<40 {
                    let text = try await screenText()
                    if text.contains("GROKCALLDISPOSABLECHECK") && text.contains("CLICKTOVERIFY") { fixtureVisible = true; break }
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                guard fixtureVisible else { Issue.record("Disposable page was not visible; no input was enabled."); return }
                try await clickFixture()
                try await Task.sleep(nanoseconds: 250_000_000)
                #expect(!(try await screenText()).contains(marker!))
            }
            try Data().write(to: URL(fileURLWithPath: signal + ".ready"))
            if let marker {
                for _ in 0..<80 {
                    if FileManager.default.fileExists(atPath: signal + ".enabled") { break }
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                guard FileManager.default.fileExists(atPath: signal + ".enabled") else { Issue.record("Server did not grant control."); return }
                host.rootView = CloudDesktopView(viewer: viewer, controlled: true)
                try await Task.sleep(nanoseconds: 500_000_000)
                try await clickFixture()
                var clicked = false
                for _ in 0..<40 {
                    if try await screenText().contains(marker) { clicked = true; break }
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                #expect(clicked, "The real remote page must change only after control was granted and the button was clicked.")
                guard clicked else { return }
                host.rootView = CloudDesktopView(viewer: viewer, controlled: false)
                try Data("passed".utf8).write(to: URL(fileURLWithPath: signal + ".clicked"))
            }
            for _ in 0..<80 {
                if FileManager.default.fileExists(atPath: signal + ".released") { break }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
            #expect(FileManager.default.fileExists(atPath: signal + ".released"))
        }
    }
}

@Suite @MainActor struct WorkspaceAuthenticationTests {
    @Test func authenticationLossClosesWorkAccessAndClearsTheRoster() {
        let backend = Backend()
        let model = AppModel(backend: backend)
        model.login = .init(state: "signed-in", error: nil)
        model.picked = ["old-bot"]
        backend.onAuthenticationLost?()
        #expect(model.login.state == "signed-out" && model.picked.isEmpty && model.bots.isEmpty)
    }
}

@Suite @MainActor struct WorkspaceMcpSafetyTests {
    @Test func appResourcesUsePublicHttpsOriginsOnly() {
        #expect(McpDocumentWebView.allowsNavigation(URL(string: "about:srcdoc")!))
        #expect(!McpDocumentWebView.allowsNavigation(URL(string: "https://example.com")!))
        #expect(!McpDocumentWebView.allowsNavigation(URL(string: "file:///tmp/file")!))
        for input in ["http://cdn.example.com", "https://u:p@example.com", "https://localhost", "https://127.0.0.1", "https://192.168.1.2", "https://[::1]", "https://host.local", "https://host.internal", "https://service.localhost", "https://example.com\";script-src *"] {
            #expect(McpDocumentWebView.allowedOrigin(input) == nil, "Rejected origin: \(input)")
        }
        #expect(McpDocumentWebView.allowedOrigin("https://cdn.example.com:8443/path?q=1") == "https://cdn.example.com:8443")
    }
    @Test func appDocumentIsOpaqueAndCannotInjectIntoItsNativeHost() {
        let document = WorkspaceMcpDocument(html: "</script><script>evil()</script>", metaJson: #"{"ui":{"csp":{"connectDomains":["https://127.0.0.1","https://api.example.com"]}}}"#, toolArgumentsJson: #"{"text":"</script>"}"#, toolResultJson: #"{"content":[]}"#)
        let host = McpDocumentWebView.sandboxDocument(document)
        #expect(host.contains("sandbox=\"allow-scripts\""))
        #expect(!host.contains("allow-same-origin"))
        #expect(!host.contains("evil()"))
        #expect(!host.contains("https://127.0.0.1"))
        #expect(host.contains("event.source!==frame.contentWindow"))
        #expect(host.contains("ui/notifications/tool-input"))
        #expect(host.contains("ui/notifications/tool-result"))
    }
}

@Suite struct WorkspaceFileSizeTests {
    @Test func malformedAndExtremeSizesDoNotCrashFileRows() {
        for size in [Double.infinity, Double.nan, -1, Double(Int64.max), 0.5] {
            #expect(WorkspaceFile(id: "f", name: "File", path: "/file", source: "agent", sizeBytes: size).sizeDescription == "Size unavailable")
        }
        #expect(WorkspaceFile(id: "f", name: "Empty", path: "/file", source: "agent", sizeBytes: 0).sizeDescription != "Size unavailable")
    }
}

@Suite struct WorkspaceRoutineTimeTests {
    @Test func providerInstantsDisplayInTheAccountZoneAcrossDaylightSaving() throws {
        let iso = ISO8601DateFormatter()
        let before = try #require(iso.date(from: "2026-03-08T06:30:00Z")).timeIntervalSince1970 * 1000
        let after = try #require(iso.date(from: "2026-03-08T07:30:00Z")).timeIntervalSince1970 * 1000
        #expect(workspaceDateLabel(before, timeZone: "America/New_York") == "8 Mar 2026, 1:30 AM (America/New_York)")
        #expect(workspaceDateLabel(after, timeZone: "America/New_York") == "8 Mar 2026, 3:30 AM (America/New_York)")
        #expect(workspaceDateLabel(String(after), timeZone: "Asia/Kolkata") == "8 Mar 2026, 1:00 PM (Asia/Kolkata)")
        for value: Any? in [nil, "bad", 0, -1, Double.infinity, 253_402_300_800_000.0] {
            #expect(workspaceDateLabel(value, timeZone: "Invalid/Zone") == nil)
        }
    }
}

@Suite @MainActor struct WorkspaceMcpWebKitTests {
    @Test func sandboxHandshakeDeliversExactToolContextWithoutExposingNativeExecution() async throws {
        _ = NSApplication.shared
        var executions = 0
        let model = BotWorkspaceModel(botId: "a", name: "Research", request: { _, _ in executions += 1; throw BackendError.setup("Unexpected native execution") })
        let card = try JSONDecoder().decode(WorkspaceActivity.Card.self, from: Data(#"{"id":"app","seq":1,"kind":"mcp-app","title":"App","text":"","status":"unresolved","requestId":"","sessionId":"s","actions":["openMcp"],"options":[]}"#.utf8))
        let html = """
        <script>
        let initialized=false,input=false,output=false;
        addEventListener('message',event=>{
          const m=event.data;
          if(m.id==='init'&&m.result){initialized=m.result.protocolVersion==='2026-01-26';parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');}
          if(m.method==='ui/notifications/tool-input')input=m.params.arguments.q==='original';
          if(m.method==='ui/notifications/tool-result')output=m.params.content[0].text==='safe';
        });
        setInterval(()=>{
          if(!initialized)parent.postMessage({jsonrpc:'2.0',id:'init',method:'ui/initialize'},'*');
          parent.postMessage({jsonrpc:'2.0',id:'status',method:'verify/status',params:{initialized,input,output}},'*');
        },100);
        try{window.webkit.messageHandlers.grokMcp.postMessage({id:'bad',method:'tools/call',params:{name:'blocked',arguments:{}}});}catch{}
        </script>
        """
        let document = WorkspaceMcpDocument(html: html, metaJson: "{}", toolArgumentsJson: #"{"q":"original"}"#, toolResultJson: #"{"content":[{"type":"text","text":"safe"}]}"#)
        let host = NSHostingView(rootView: McpDocumentWebView(model: model, card: card, document: document))
        host.frame = NSRect(x: 0, y: 0, width: 800, height: 600)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; host.layoutSubtreeIfNeeded(); defer { window.close() }
        func findWebView(_ view: NSView) -> WKWebView? { if let web = view as? WKWebView { return web }; return view.subviews.compactMap { findWebView($0) }.first }
        let web = try #require(findWebView(host))
        var verified = false
        for _ in 0..<40 {
            try await Task.sleep(nanoseconds: 100_000_000)
            let ready = try? await web.evaluateJavaScript("if(!window.verifying){window.verifying=true;addEventListener('message',e=>{if(e.source===document.getElementById('app').contentWindow&&e.data.method==='verify/status')window.verified=e.data.params});}window.verified?.initialized===true&&window.verified?.input===true&&window.verified?.output===true") as? Bool
            if ready == true { verified = true; break }
        }
        #expect(verified)
        #expect(executions == 0)
        let opaque = try await web.evaluateJavaScript("document.getElementById('app').contentDocument===null") as? Bool
        #expect(opaque == true)
    }
}

@Suite @MainActor struct WorkspaceLessonExitTests {
    @Test func leavingStopsTheOwnedLessonBeforeItCanClose() async {
        for save in [true, false] {
            var calls: [String] = []
            let model = BotWorkspaceModel(botId: "a", name: "A", request: { action, args in
                calls.append(action)
                if action == "teachStop" { #expect(args["save"] as? Bool == save) }
                return Data(#"{"state":"idle","owned":false}"#.utf8)
            })
            #expect(await model.finishLessonBeforeExit(save: save))
            #expect(calls.isEmpty)
            model.teaching = WorkspaceTeaching(state: "recording", owned: true, startedAtMs: 1)
            #expect(await model.finishLessonBeforeExit(save: save))
            #expect(calls == ["teachStop", "teachStatus"] && !model.recordingLesson)
        }
    }
    @Test func failedStopKeepsTheLessonAndPreventsNormalExit() async {
        let model = BotWorkspaceModel(botId: "a", name: "A", request: { _, _ in throw BackendError.setup("Offline") })
        model.teaching = WorkspaceTeaching(state: "recording", owned: true, startedAtMs: 1)
        #expect(!(await model.finishLessonBeforeExit(save: true)))
        #expect(model.recordingLesson && model.error == "Offline")
    }
}

@Suite @MainActor struct WorkspaceLessonConfirmationTests {
    @Test func anAcceptedStopCannotCloseAWindowWhileTheProviderStillRecords() async {
        let model = BotWorkspaceModel(botId: "a", name: "A", request: { _, _ in Data(#"{"state":"recording","owned":true}"#.utf8) })
        model.teaching = WorkspaceTeaching(state: "recording", owned: true, startedAtMs: 1)
        #expect(!(await model.finishLessonBeforeExit(save: true)))
        #expect(model.recordingLesson && model.error?.contains("not confirmed") == true)
    }
    @Test func startingCannotClaimARecordingThatHasNotStarted() async {
        let model = BotWorkspaceModel(botId: "a", name: "A", request: { _, _ in Data(#"{"state":"idle","owned":false}"#.utf8) })
        #expect(!(await model.teachingAction("teachStart")))
        #expect(!model.recordingLesson && model.notice == nil && model.error?.contains("not confirmed") == true)
    }
}
