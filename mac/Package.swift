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
        // The loopback inside the Alotbot Mic audio driver (mac/Driver), plain C so the driver and the tests share it.
        .target(name: "AlotbotMicLoop"),
        .testTarget(name: "AlotbotCoreTests", dependencies: ["AlotbotCore", "AlotbotMicLoop"]),
        .testTarget(name: "AlotbotNativeTests", dependencies: ["Alotbot", "AlotbotCore"]),
    ],
    swiftLanguageModes: [.v5]
)
