// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FastSVN",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "FastSVN", targets: ["FastSVN"]),
        .executable(name: "FastSVNPreview", targets: ["FastSVNPreview"]),
        .library(name: "FastSVNKit", targets: ["FastSVNKit"]),
    ],
    targets: [
        .target(name: "FastSVNKit", path: "Sources/FastSVNKit"),
        .executableTarget(name: "FastSVN", dependencies: ["FastSVNKit"], path: "Sources/FastSVN"),
        .executableTarget(name: "FastSVNPreview", dependencies: ["FastSVNKit"], path: "Sources/FastSVNPreview"),
    ]
)
