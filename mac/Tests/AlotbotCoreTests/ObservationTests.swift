import Testing
@testable import AlotbotCore

@Suite struct ObservationTests {
    let windows = [
        ObservedWindow(id: 1, app: "Zen", bundle: "app.zen-browser.zen", title: "YouTube — Zen", onScreen: false),
        ObservedWindow(id: 2, app: "Zen", bundle: "app.zen-browser.zen", title: "GitHub — Zen", onScreen: true),
        ObservedWindow(id: 3, app: "Notes", bundle: "com.apple.Notes", title: "YouTube ideas", onScreen: true)
    ]
    @Test func excludesToolbarSurfacesWithoutExcludingBackgroundContentWindows() {
        #expect(!WindowSelection.isContentWindow(width: 1470, height: 33, layer: 0))
        #expect(!WindowSelection.isContentWindow(width: 54, height: 54, layer: 0))
        #expect(!WindowSelection.isContentWindow(width: 800, height: 600, layer: 1000))
        #expect(WindowSelection.isContentWindow(width: 800, height: 600, layer: 0))
        #expect(!WindowSelection.isContentWindow(width: .infinity, height: 600, layer: 0))
        #expect(!WindowSelection.isContentWindow(width: 800, height: .nan, layer: 0))
        #expect(!WindowSelection.isContentWindow(width: 60, height: 600, layer: 0))
        #expect(!WindowSelection.isContentWindow(width: 800, height: 40, layer: 0))
    }
    @Test func matchesAppWithoutSpaceOrCase() {
        #expect(WindowSelection.matches(windows, app: "  ZEN browser  ", title: nil, id: nil).map(\.id) == [1, 2])
        #expect(WindowSelection.matches(windows, app: "app.zen-browser.zen", title: "youtube", id: nil).map(\.id) == [1])
        #expect(WindowSelection.matches(windows, app: "Zen", title: nil, id: 3).isEmpty)
        #expect(WindowSelection.matches(windows, app: "Zen", title: nil, id: 999).isEmpty)
    }
    @Test func resolvesCommonBrowserNamesWithoutRestrictingOtherApps() {
        let browsers = [
            ObservedWindow(id: 10, app: "Google Chrome", bundle: "com.google.Chrome", title: "YouTube", onScreen: false),
            ObservedWindow(id: 11, app: "Microsoft Edge", bundle: "com.microsoft.edgemac", title: "News", onScreen: false),
            ObservedWindow(id: 12, app: "Safari", bundle: "com.apple.Safari", title: "Social", onScreen: false),
            ObservedWindow(id: 13, app: "Unfamiliar Browser", bundle: "org.example.browser", title: "Docs", onScreen: false)
        ]
        #expect(WindowSelection.matches(browsers, app: "Chrome", title: nil, id: nil).map(\.id) == [10])
        #expect(WindowSelection.matches(browsers, app: "Edge", title: nil, id: nil).map(\.id) == [11])
        #expect(WindowSelection.matches(browsers, app: "Safari", title: nil, id: nil).map(\.id) == [12])
        #expect(WindowSelection.matches(browsers, app: "Unfamiliar Browser", title: nil, id: nil).map(\.id) == [13])
    }
    @Test func neverGuessesAppFromTitleOrEmptyRequest() {
        #expect(WindowSelection.matches(windows, app: "YouTube", title: nil, id: nil).isEmpty)
        #expect(WindowSelection.matches(windows, app: " ", title: nil, id: nil).isEmpty)
        #expect(WindowSelection.matches(windows, app: "en", title: nil, id: nil).isEmpty)
        #expect(WindowSelection.matches([], app: "Zen", title: nil, id: nil).isEmpty)
    }
    @Test func exactTitleWinsBeforeSubstring() {
        let more = windows + [ObservedWindow(id: 4, app: "Zen", bundle: "app.zen-browser.zen", title: "YouTube", onScreen: false)]
        #expect(WindowSelection.matches(more, app: "Zen", title: "YouTube", id: nil).map(\.id) == [4])
        #expect(WindowSelection.matches(more, app: "Zen", title: "missing", id: nil).isEmpty)
        #expect(WindowSelection.matches(windows, app: "Notes", title: "", id: 3).map(\.id) == [3])
    }
}
