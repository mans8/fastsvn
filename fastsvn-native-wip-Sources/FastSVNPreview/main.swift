import SwiftUI
import AppKit
import FastSVNKit

// 预览渲染器：把 RootView 渲染成 PNG，用于无 GUI 会话下的视觉验证。
// 用法：FastSVNPreview --out out.png [--theme light|hc-light|dark|hc-dark]
//                      [--wc /path/to/workingcopy] [--panel commit|conflict] [--size 1280x820]

@MainActor
func main() {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)

    var out = "/tmp/fastsvn-preview.png"
    var themeID = ThemeID.light
    var wcPath: String?
    var panel: String?
    var width: CGFloat = 1280
    var height: CGFloat = 820

    var args = Array(CommandLine.arguments.dropFirst())
    while !args.isEmpty {
        let key = args.removeFirst()
        func next() -> String? { args.isEmpty ? nil : args.removeFirst() }
        switch key {
        case "--out": out = next() ?? out
        case "--theme":
            if let v = next() {
                switch v {
                case "dark": themeID = .dark
                case "hc-dark": themeID = .hcDark
                case "hc-light": themeID = .hcLight
                default: themeID = .light
                }
            }
        case "--wc": wcPath = next()
        case "--panel": panel = next()
        case "--size":
            if let v = next(), let w = Double(v.split(separator: "x").first ?? "") {
                width = CGFloat(w)
                if let h = v.split(separator: "x").last, let hh = Double(h) { height = CGFloat(hh) }
            }
        default: break
        }
    }

    let theme = Theme.of(themeID)
    let store = WorkspaceStore()
    if let wcPath {
        store.addWorkingCopy(path: wcPath)
    }

    // 等待异步数据加载完成（预览用途，不做超时异常处理）
    var waited = 0.0
    while store.busy && waited < 15 {
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        waited += 0.1
    }
    RunLoop.main.run(until: Date().addingTimeInterval(1.0))

    if panel == "commit" { store.showCommitSheet = true }
    if panel == "conflict" { store.showConflictSheet = true }
    RunLoop.main.run(until: Date().addingTimeInterval(0.4))

    let root = RootView(store: store)
        .theme(theme)
        .frame(width: width, height: height)
        .environment(\.colorScheme, theme.isDark ? .dark : .light)

    let host = NSHostingView(rootView: root)
    host.frame = NSRect(x: 0, y: 0, width: width, height: height)
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))

    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
        print("RENDER_FAIL: no bitmap rep")
        exit(1)
    }
    host.cacheDisplay(in: host.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        print("RENDER_FAIL: png encode failed")
        exit(1)
    }
    do {
        try png.write(to: URL(fileURLWithPath: out))
        print("RENDER_OK \(rep.pixelsWide)x\(rep.pixelsHigh) -> \(out)")
    } catch {
        print("RENDER_FAIL: \(error.localizedDescription)")
        exit(1)
    }
}

MainActor.assumeIsolated {
    main()
}
