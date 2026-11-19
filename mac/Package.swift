// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Alotbot",
    platforms: [.macOS(.v14)],
    targets: [
        // Everything that can be tested without a screen: the avatar engine, the backend protocol, layout math.
        .target(name: "AlotbotCore", resources: [.copy("Resources/morph-data.json")]),
        // The app: menu bar, overlay, audio, backend process.
        .executableTarget(name: "Alotbot", dependencies: ["AlotbotCore"]),
        .testTarget(name: "AlotbotCoreTests", dependencies: ["AlotbotCore"]),
        .testTarget(name: "AlotbotNativeTests", dependencies: ["Alotbot", "AlotbotCore"]),
    ],
    swiftLanguageModes: [.v5]
)
