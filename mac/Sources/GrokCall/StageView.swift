import AppKit
import GrokCallCore
import SwiftUI

/// Sizes in the full view.
enum StageMetrics {
    static let pad: CGFloat = 24
    static let header: CGFloat = 64
    static let controls: CGFloat = 96
    static let maxSize = CGSize(width: 1240, height: 840)
    static let margin: CGFloat = 36
    static let card: CGFloat = 320
    static let tray: CGFloat = 460

    /// The full view's frame in window coordinates (top-left origin): centered in the screen's usable
    /// area (below the menu bar, above the Dock), with a margin, up to `maxSize`.
    static func rect(screen: CGRect, visible: CGRect) -> CGRect {
        let v = CGRect(x: visible.minX - screen.minX, y: screen.maxY - visible.maxY, width: visible.width, height: visible.height)
        let w = min(maxSize.width, max(320, v.width - margin * 2)), h = min(maxSize.height, max(360, v.height - margin * 2))
        return CGRect(x: v.midX - w / 2, y: v.midY - h / 2, width: w, height: h)
    }
}

/// The full view: you and every bot as tiles in a grid sized to the count. When someone talks, the
/// speaker's tile lights up in its color, and the other bots turn toward it and perk up, nearest first.
struct StageView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var prefs: Prefs
    let rect: CGRect

    /// Inset a little more than the padding so the speaking tile can grow and glow without touching the edge.
    private var gridArea: CGRect {
        CGRect(x: StageMetrics.pad, y: StageMetrics.header, width: rect.width - StageMetrics.pad * 2,
               height: rect.height - StageMetrics.header - StageMetrics.controls).insetBy(dx: 10, dy: 6)
    }
    private var layout: StageLayout { StageLayout(botIds: model.callBots.map(\.id), width: gridArea.width, height: gridArea.height) }
    private var speaker: String? { StageLayout.speaker(model.view) }

    var body: some View {
        let l = layout
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 34, style: .continuous).fill(Theme.surface)
                .overlay(RoundedRectangle(cornerRadius: 34, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
                .shadow(color: .black.opacity(0.5), radius: 30, y: 14)
            header
            grid(l)
                .frame(width: gridArea.width, height: gridArea.height)
                .offset(x: gridArea.minX, y: gridArea.minY)
            controls
                .frame(width: rect.width, height: StageMetrics.controls)
                .offset(y: rect.height - StageMetrics.controls)
            overlays(l)
        }
        .frame(width: rect.width, height: rect.height, alignment: .topLeading)
        .animation(Theme.settle, value: model.tray)
        .animation(Theme.settle, value: model.cardBot)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Grok Call full view")
    }

    // MARK: header

    private var header: some View {
        let n = model.callBots.count
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("You and \(n) bot\(n == 1 ? "" : "s")").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Text(subtitle).font(.system(size: 12.5)).foregroundStyle(Theme.secondary).lineLimit(1)
                    .transaction { $0.animation = nil } // a crossfade draws both lines on top of each other
            }
            Spacer()
            CircleButton(symbol: "arrow.down.right.and.arrow.up.left", label: "Back to the pill", size: 38) { model.setMode(.pill) }
        }
        .padding(.horizontal, StageMetrics.pad)
        .frame(width: rect.width, height: StageMetrics.header)
    }

    /// Who is talking; else whether the bots are waiting for you, thinking, or quiet.
    private var subtitle: String {
        if let s = speaker { return s == "host" ? "You're talking" : "\(model.callBots.first { $0.id == s }?.name ?? "A bot") is talking" }
        if model.view?.waitingForHost == true { return "Waiting for you" }
        return model.callBots.contains { $0.status == "thinking" } ? "Thinking…" : "Quiet"
    }

    // MARK: grid

    private func grid(_ l: StageLayout) -> some View {
        let size = CGSize(width: l.tileWidth, height: l.tileHeight)
        return ZStack(alignment: .topLeading) {
            Color.clear
            if let c = l.centers["host"] {
                HostTile(model: model, prefs: prefs, speaking: speaker == "host")
                    .frame(width: size.width, height: size.height)
                    .position(c)
            }
            ForEach(model.callBots) { b in
                if let c = l.centers[b.id] {
                    BotTile(model: model, bot: b, layout: l, speaker: speaker)
                        .frame(width: size.width, height: size.height)
                        .position(c)
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                }
            }
        }
        .animation(Theme.bounce, value: l)
    }

    // MARK: controls

    private var controls: some View { CallButtons(model: model, opensFullView: false) }

    // MARK: card and trays

    @ViewBuilder private func overlays(_ l: StageLayout) -> some View {
        if let id = model.cardBot, let b = model.callBots.first(where: { $0.id == id }), let c = l.centers[id] {
            let p = cardOrigin(center: c, l)
            BotCard(model: model, bot: b)
                .frame(width: StageMetrics.card)
                .fixedSize(horizontal: false, vertical: true)
                .modifier(PlaceBelow(x: p.x, y: p.y, above: false))
                .transition(.scale(scale: 0.92).combined(with: .opacity))
                .zIndex(5)
        } else if let t = model.tray {
            TrayView(model: model, prefs: prefs, tray: t)
                .frame(width: StageMetrics.tray)
                .fixedSize(horizontal: false, vertical: true)
                .modifier(PlaceBelow(x: (rect.width - StageMetrics.tray) / 2, y: rect.height - StageMetrics.controls + 4, above: true))
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .zIndex(5)
        }
    }

    /// The card sits beside its tile (right if there's room, else left), top-aligned, inside the view.
    private func cardOrigin(center c: CGPoint, _ l: StageLayout) -> CGPoint {
        let tile = CGRect(x: gridArea.minX + c.x - l.tileWidth / 2, y: gridArea.minY + c.y - l.tileHeight / 2, width: l.tileWidth, height: l.tileHeight)
        let w = StageMetrics.card
        var x = tile.maxX + 12
        if x + w > rect.width - 12 { x = tile.minX - 12 - w }
        if x < 12 { x = max(12, min(rect.width - w - 12, tile.midX - w / 2)) }
        let y = max(12, min(tile.minY, rect.height - StageMetrics.controls - 430))
        return CGPoint(x: x, y: y)
    }
}

/// The frame every tile shares: lights up in `glow` while that participant talks.
private struct TileChrome<Content: View>: View {
    var glow: Color?
    var dim = false
    @ViewBuilder var content: Content

    var body: some View {
        let on = glow != nil
        ZStack {
            RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color.white.opacity(0.045))
            if let g = glow {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(RadialGradient(colors: [g.opacity(0.22), g.opacity(0)], center: .center, startRadius: 0, endRadius: 260))
                    .transition(.opacity)
            }
            content
        }
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(glow ?? Theme.hairline, lineWidth: on ? 2 : 1))
        .shadow(color: (glow ?? .clear).opacity(on ? 0.45 : 0), radius: on ? 22 : 0)
        .opacity(dim ? 0.55 : 1)
        .scaleEffect(on && !Theme.reduceMotion ? 1.025 : 1)
        .animation(Theme.settle, value: on)
        .animation(Theme.settle, value: dim)
    }
}

/// Name, status and (while talking) the live words, under the avatar.
private struct TileLabel: View {
    var name: String
    var status: String
    var statusColor: Color = Theme.secondary
    var caption: String?
    var size: CGFloat

    var body: some View {
        VStack(spacing: 3) {
            Text(name).font(.system(size: max(12, min(17, size * 0.08)), weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
            Text(status).font(.system(size: max(11, min(13, size * 0.06)))).foregroundStyle(statusColor).lineLimit(1)
                .transaction { $0.animation = nil }
            if let caption, !caption.isEmpty {
                Text(caption).font(.system(size: max(11, min(13.5, size * 0.062)))).foregroundStyle(Theme.text.opacity(0.8))
                    .multilineTextAlignment(.center).lineLimit(2).truncationMode(.head)
                    .padding(.top, 4).padding(.horizontal, 14)
                    .transition(.opacity)
            }
        }
        .animation(Theme.settle, value: caption == nil)
    }
}

private struct BotTile: View {
    @ObservedObject var model: AppModel
    let bot: CallBot
    let layout: StageLayout
    let speaker: String?

    private var speaking: Bool { speaker == bot.id }
    /// Who this bot looks at, as the backend says (usually whoever is talking). The avatar turns its eyes and head that way.
    private var gaze: GazeTarget? { layout.gaze(from: bot.id, to: bot.looksAt) }
    /// How long after the speaker changes this tile perks up: a wave that spreads out from the speaker.
    private var delay: Double {
        guard let s = speaker, let a = layout.centers[bot.id], let b = layout.centers[s] else { return 0 }
        return min(0.3, Double(hypot(a.x - b.x, a.y - b.y)) / 1600)
    }

    var body: some View {
        GeometryReader { g in
            let side = min(g.size.width, g.size.height)
            let avatar = side * 0.5
            let color = Palette.body(bot.color).color
            TileChrome(glow: speaking ? color : nil, dim: bot.status == "quiet" || bot.status == "connecting" || bot.status == "reconnecting") {
                VStack(spacing: side * 0.05) {
                    BotFace(bot: bot, state: avatarState(for: bot.status), gaze: gaze, level: { [audio = model.audio] in audio.voiceLevel() })
                        .frame(width: avatar, height: avatar)
                        .keyframeAnimator(initialValue: 1.0, trigger: speaker) { v, s in v.scaleEffect(s) } keyframes: { _ in
                            // Listeners perk up when someone new starts talking; the speaker doesn't.
                            let peak = speaker != nil && !speaking && !Theme.reduceMotion ? 1.09 : 1.0
                            KeyframeTrack {
                                LinearKeyframe(1.0, duration: max(0.02, delay)) // a zero-length keyframe makes a non-finite scale and crashes AppKit
                                SpringKeyframe(peak, duration: 0.16, spring: .snappy)
                                SpringKeyframe(1.0, duration: 0.4, spring: .bouncy)
                            }
                        }
                    TileLabel(name: bot.name, status: statusText, statusColor: bot.status == "error" ? Theme.danger : speaking ? color : Theme.secondary,
                              caption: speaking ? caption : nil, size: side)
                }
                .padding(.vertical, 10)
            }
            .frame(width: g.size.width, height: g.size.height)
            .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .onTapGesture { model.openCard(bot.id) }
        }
        .accessibilityElement()
        .accessibilityLabel("\(bot.name), \(statusText)")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.openCard(bot.id) }
    }

    /// Its own state when it has one worth showing; otherwise who it's listening to.
    private var statusText: String {
        if bot.status == "error" { return bot.error ?? Labels.status(bot.status) }
        if ["speaking", "thinking", "quiet", "connecting", "reconnecting"].contains(bot.status) { return Labels.status(bot.status) }
        if let s = speaker, s != bot.id {
            return s == "host" ? "Listening to you" : "Listening to \(model.callBots.first { $0.id == s }?.name ?? "a bot")"
        }
        return Labels.status(bot.status)
    }

    /// The end of what the bot is saying now.
    private var caption: String? {
        guard let live = model.view?.live, live.botId == bot.id else { return nil }
        return live.text.count > 160 ? "…" + live.text.suffix(160) : live.text
    }
}

private struct HostTile: View {
    @ObservedObject var model: AppModel
    @ObservedObject var prefs: Prefs
    let speaking: Bool

    var body: some View {
        GeometryReader { g in
            let side = min(g.size.width, g.size.height)
            let muted = model.view?.muted == true
            TileChrome(glow: speaking ? Color.white.opacity(0.85) : nil) {
                VStack(spacing: side * 0.05) {
                    HostAvatar(prefs: prefs, name: model.hostName, speaking: speaking, level: { [audio = model.audio] in Double(min(1, audio.micLevel * 5)) })
                        .frame(width: side * 0.5, height: side * 0.5)
                    TileLabel(name: "You", status: muted ? "Muted" : speaking ? "Talking" : model.view?.waitingForHost == true ? "Bots are waiting for you" : "In the call",
                              statusColor: muted ? Theme.danger : Theme.secondary, size: side)
                }
                .padding(.vertical, 10)
            }
            .frame(width: g.size.width, height: g.size.height)
        }
        .accessibilityElement()
        .accessibilityLabel("You, \(model.hostName)\(speaking ? ", talking" : "")")
    }
}
