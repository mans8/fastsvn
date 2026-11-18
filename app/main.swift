import AppKit
import WebKit

// FastSVN 桌面启动器
// 职责：拉起内嵌 node 服务 → 等它报出端口 → 用 WKWebView 显示界面 → 退出时收掉子进程

let LOG_PATH = NSString(string: "~/Library/Logs/FastSVN.log").expandingTildeInPath

func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    if !FileManager.default.fileExists(atPath: LOG_PATH) {
        FileManager.default.createFile(atPath: LOG_PATH, contents: nil)
    }
    if let h = FileHandle(forWritingAtPath: LOG_PATH) {
        h.seekToEndOfFile()
        h.write(data)
        h.closeFile()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
                          WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var nodeProcess: Process?
    private var signalSources: [DispatchSourceSignal] = []
    private var portReady = false
    private var outputBuffer = ""
    private var selfTestStarted = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        log("=== FastSVN 启动 ===")
        buildMenu()
        buildWindow()
        installSignalHandlers()
        startServer()

        // 自测用：FASTSVN_AUTOTERM=秒 到点自动退出，用于验证子进程是否被正确收掉
        if let raw = ProcessInfo.processInfo.environment["FASTSVN_AUTOTERM"], let sec = Double(raw) {
            log("自测模式：\(Int(sec)) 秒后自动退出")
            DispatchQueue.main.asyncAfter(deadline: .now() + sec) {
                NSApp.terminate(nil)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    /// 兜住"非正常退出"：被 kill、终端关闭（SIGHUP）、Ctrl-C 时
    /// applicationWillTerminate 不会执行，子进程就会残留成僵尸。
    /// 这里把信号转成正常终止流程，让 stopServer() 一定跑到。
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                log("收到信号 \(sig)，走正常退出流程")
                NSApp.terminate(nil)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    // MARK: - 菜单

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 FastSVN", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 FastSVN", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 FastSVN", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: - 窗口

    private func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1280, height: 820)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "FastSVN"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 1040, height: 620)
        // 允许拖动窗口背景移动窗口（标题栏区域仍然有效）
        window.isMovableByWindowBackground = true
        window.center()
        window.setFrameAutosaveName("FastSVNMainWindow")

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // 网页侧通过这个通道请求原生窗口行为（最大化等）
        config.userContentController.add(self, name: "windowAction")
        // 带回复的通道：网页请求在访达里选目录，原生把路径回传给页面
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "pickFolder")

        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showPlaceholder(title: "正在启动…", detail: "正在启动本地服务")
    }

    private func showPlaceholder(title: String, detail: String) {
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html,body{height:100%;margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
          background:#FAFBFD;color:#1F2328;display:flex;align-items:center;justify-content:center}
        .box{text-align:center;max-width:420px}
        h1{font-size:17px;font-weight:600;margin:0 0 8px}
        p{font-size:13px;color:#515866;line-height:1.6;margin:0}
        code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#EFF1F5;padding:1px 5px;border-radius:4px}
        </style></head><body><div class="box"><h1>\(title)</h1><p>\(detail)</p></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - 服务

    private func resources() -> URL? {
        Bundle.main.resourceURL
    }

    private func startServer() {
        guard let res = resources() else {
            showPlaceholder(title: "启动失败", detail: "找不到应用资源目录")
            log("资源目录缺失")
            return
        }
        let nodeURL = res.appendingPathComponent("node")
        let serverURL = res.appendingPathComponent("server.js")

        guard FileManager.default.isExecutableFile(atPath: nodeURL.path) else {
            showPlaceholder(title: "启动失败", detail: "应用内置的 node 运行时缺失")
            log("缺少 node：\(nodeURL.path)")
            return
        }

        let p = Process()
        p.executableURL = nodeURL
        p.arguments = [serverURL.path]
        p.currentDirectoryURL = res

        var env = ProcessInfo.processInfo.environment
        env["PORT"] = "0"                     // 由系统分配空闲端口，避免和开发实例冲突
        env["FASTSVN_BUNDLED"] = "1"
        // 数据放用户目录，应用更新时不会覆盖用户的项目列表与缓存
        env["FASTSVN_HOME"] = NSString(string: "~/Library/Application Support/FastSVN").expandingTildeInPath
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consume(text) }
        }

        do {
            try p.run()
            nodeProcess = p
            log("node 已启动 pid=\(p.processIdentifier)")
        } catch {
            showPlaceholder(title: "启动失败", detail: "无法启动内置服务：\(error.localizedDescription)")
            log("spawn 失败：\(error)")
            return
        }

        // 10 秒内没拿到端口就报错，而不是无限转圈
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, !self.portReady else { return }
            self.showPlaceholder(
                title: "服务没能启动",
                detail: "请查看日志 <code>~/Library/Logs/FastSVN.log</code> 了解原因。"
            )
            log("等待端口超时")
        }
    }

    private func consume(_ text: String) {
        outputBuffer += text
        // 逐行处理，拿到 LISTENING <port> 就加载界面
        while let idx = outputBuffer.firstIndex(of: "\n") {
            let line = String(outputBuffer[outputBuffer.startIndex..<idx])
            outputBuffer = String(outputBuffer[outputBuffer.index(after: idx)...])
            handleLine(line)
        }
    }

    private func handleLine(_ line: String) {
        if line.hasPrefix("LISTENING ") {
            let port = line.replacingOccurrences(of: "LISTENING ", with: "").trimmingCharacters(in: .whitespaces)
            guard !portReady, let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
            portReady = true
            log("服务就绪：\(url.absoluteString)")
            webView.load(URLRequest(url: url))
            return
        }
        if !line.isEmpty { log("node: \(line)") }
    }

    private func stopServer() {
        guard let p = nodeProcess, p.isRunning else { return }
        log("终止 node pid=\(p.processIdentifier)")
        p.terminate()
        // 给 1.5 秒优雅退出，否则强杀
        let deadline = Date().addingTimeInterval(1.5)
        while p.isRunning && Date() < deadline {
            usleep(100_000)
        }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("界面加载完成 visible=\(window.isVisible) frame=\(Int(window.frame.width))x\(Int(window.frame.height))")

        // didFinish 会触发两次（占位页 + 真实页），自检只跑一次
        guard !selfTestStarted else { return }
        selfTestStarted = true

        // 自检用：FASTSVN_SNAPSHOT=1 时把网页内容截图存盘，便于无 GUI 会话下核对渲染
        if ProcessInfo.processInfo.environment["FASTSVN_SNAPSHOT"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.snapshotWebView()
            }
        }
        // 自检用：FASTSVN_SELFTEST=zoom 时从页面里真实触发一次窗口最大化请求
        // 自检用：从页面真实触发一次"访达选目录"，验证通道往返（面板 1 秒后自动取消）
        if ProcessInfo.processInfo.environment["FASTSVN_SELFTEST"] == "pick" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                self?.webView.evaluateJavaScript(
                    """
                    void window.webkit.messageHandlers.pickFolder
                      .postMessage({ defaultPath: '~/Downloads' })
                      .then(function (p) { document.title = 'PICK=' + (p || 'null'); });
                    """
                ) { _, err in
                    log("JS 触发 pickFolder，错误=\(err?.localizedDescription ?? "无")")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) {
                        self?.webView.evaluateJavaScript("document.title") { value, _ in
                            log("自检结果 title=\(value ?? "nil")")
                        }
                    }
                }
            }
        }

        if ProcessInfo.processInfo.environment["FASTSVN_SELFTEST"] == "zoom" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                self?.webView.evaluateJavaScript(
                    "void window.webkit.messageHandlers.windowAction.postMessage('zoom')"
                ) { _, err in
                    log("JS 触发 zoom，错误=\(err?.localizedDescription ?? "无")")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        log("自检结果 isZoomed=\(self?.window.isZoomed == true)")
                    }
                }
            }
        }
    }

    private func snapshotWebView() {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = webView.bounds
        webView.takeSnapshot(with: cfg) { [weak self] image, error in
            guard let image,
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                log("截图失败：\(error?.localizedDescription ?? "未知原因")")
                return
            }
            let path = "/tmp/fastsvn-app-snapshot.png"
            try? png.write(to: URL(fileURLWithPath: path))
            log("截图已保存 \(path) \(Int(image.size.width))x\(Int(image.size.height))")
            log("页面标题：\(self?.webView.title ?? "")")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled { return }
        log("界面加载失败：\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // -999 是占位页被真实页面替换时的正常取消，不是错误
        let code = (error as NSError).code
        if code == NSURLErrorCancelled {
            log("占位页已被替换（忽略 -999）")
            return
        }
        log("界面加载失败(provisional)：\(error.localizedDescription)")
        showPlaceholder(title: "界面加载失败", detail: error.localizedDescription)
    }

    // 让 ⌘R / ⌘K 等快捷键不被浏览器行为占用，交给页面处理
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(.allow)
    }

    // MARK: - 访达选目录（网页 → 原生 → 回复路径）

    /// 用 NSOpenPanel 选一个目录。
    /// 为什么放在原生侧：沙盒/权限模型下，由 App 自己弹出面板最自然，
    /// 也能记住上次位置；浏览器里没有这个通道，前端会降级为手填路径。
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "pickFolder" else {
            replyHandler(nil, "unknown message")
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "选择"
        panel.message = "选择保存位置"

        // 初始位置：优先用页面传过来的路径（展开 ~），否则落到「下载」
        if let body = message.body as? [String: Any],
           let raw = body["defaultPath"] as? String,
           !raw.isEmpty {
            var dir = raw
            if dir.hasPrefix("~/") {
                dir = NSHomeDirectory() + String(dir.dropFirst())
            }
            // 传进来的可能是"目录/名字"，面板要的是目录
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue {
                panel.directoryURL = URL(fileURLWithPath: dir)
            } else {
                panel.directoryURL = URL(fileURLWithPath: (dir as NSString).deletingLastPathComponent)
            }
        } else {
            panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        }

        log("打开目录选择面板")
        let finish: (NSApplication.ModalResponse) -> Void = { resp in
            if resp == .OK, let url = panel.url {
                log("已选择目录：\(url.path)")
                replyHandler(url.path, nil)
            } else {
                log("目录选择已取消")
                replyHandler(nil, nil)
            }
        }
        if let w = window {
            panel.beginSheetModal(for: w, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }

        // 自检：无人工介入时 1 秒后自动取消，验证通道可用且能收尾
        if ProcessInfo.processInfo.environment["FASTSVN_SELFTEST"] == "pick" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                log("自检：自动取消目录选择")
                panel.cancel(nil)
            }
        }
    }

    // MARK: - WKScriptMessageHandler（网页 → 原生窗口动作）

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "windowAction", let cmd = message.body as? String else { return }
        switch cmd {
        case "zoom":
            window.performZoom(nil)
            log("窗口缩放切换 -> \(window.isZoomed ? "最大化" : "还原")")
        case "minimize":
            window.miniaturize(nil)
            log("窗口最小化")
        default:
            log("未知窗口动作：\(cmd)")
        }
    }

    // MARK: - WKUIDelegate
    // WKWebView 默认不实现 alert / confirm / prompt，不接这三个回调的话
    // 页面里的 window.confirm 会直接返回 false，表现为「点了没反应」

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "FastSVN"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "FastSVN"
        alert.informativeText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "FastSVN"
        alert.informativeText = prompt
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
