// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "ToneLT",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "LTKit", targets: ["LTKit"]),
        .executable(name: "ToneLT", targets: ["ToneLT"]),
    ],
    targets: [
        .target(name: "LTKit", linkerSettings: [.linkedFramework("IOKit")]),
        .executableTarget(name: "ToneLT", dependencies: ["LTKit"]),
        // swift-testing / XCTest are unusable with the Command Line Tools on this
        // machine, so the unit tests live in a plain executable: `swift run lt-selftest`.
        .executableTarget(name: "lt-selftest", dependencies: ["LTKit"]),
    ],
    swiftLanguageModes: [.v5]
)
