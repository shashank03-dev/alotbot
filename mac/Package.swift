// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "GrokCall",
    platforms: [.macOS(.v14)],
    targets: [
        // Everything that can be tested without a screen: the avatar engine, the backend protocol, layout math.
        .target(name: "GrokCallCore", resources: [.copy("Resources/morph-data.json")]),
        // The app: menu bar, overlay, audio, backend process.
        .executableTarget(name: "GrokCall", dependencies: ["GrokCallCore"]),
        .testTarget(name: "GrokCallCoreTests", dependencies: ["GrokCallCore"]),
    ],
    swiftLanguageModes: [.v5]
)
