import Foundation

public enum SVNError: LocalizedError {
    case binaryNotFound
    case failed(code: Int32, message: String)
    case parse(String)

    public var errorDescription: String? {
        switch self {
        case .binaryNotFound:
            return "找不到 svn 命令行工具"
        case let .failed(_, message):
            return message
        case let .parse(msg):
            return "无法解析 SVN 输出：\(msg)"
        }
    }
}

public struct WCInfo {
    public let url: String
    public let revision: Int64
    public let branch: String
}

/// SVN 引擎适配层：唯一出入口。
/// 规则：只调用 svn 官方实现，只解析 `--xml` 与 unified diff；绝不直接读写 `.svn`。
public final class SVNEngine {

    public static let shared = SVNEngine()

    public let svnPath: String?

    public init() {
        svnPath = SVNEngine.resolveSVN()
    }

    /// GUI 进程的 PATH 很有限，必须显式探测常见安装位置。
    public static func resolveSVN() -> String? {
        let candidates = [
            "/opt/homebrew/bin/svn",
            "/usr/local/bin/svn",
            "/usr/bin/svn",
            "/opt/local/bin/svn",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        let envPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        for dir in envPath.split(separator: ":") {
            let p = String(dir) + "/svn"
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    // MARK: - 进程调用

    @discardableResult
    public func run(_ args: [String], cwd: String? = nil) throws -> String {
        guard let svn = svnPath else { throw SVNError.binaryNotFound }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: svn)
        // 参数数组传参，绝不拼接 shell 字符串
        p.arguments = ["--non-interactive"] + args

        var env = ProcessInfo.processInfo.environment
        env["LC_ALL"] = "en_US.UTF-8"
        env["LANG"] = "en_US.UTF-8"
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        p.environment = env
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }

        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err

        do { try p.run() } catch { throw SVNError.failed(code: -1, message: error.localizedDescription) }

        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()

        let stdout = String(data: outData, encoding: .utf8) ?? ""
        let stderr = String(data: errData, encoding: .utf8) ?? ""

        if p.terminationStatus != 0 {
            throw SVNError.failed(code: p.terminationStatus,
                                  message: SVNEngine.humanize(stderr: stderr, code: p.terminationStatus))
        }
        return stdout
    }

    /// 把 SVN 原始报错翻译成人话（FR-19）
    public static func humanize(stderr: String, code: Int32) -> String {
        let s = stderr
        if s.contains("E155004") {
            return "上次操作被中断，文件夹被锁住了。可以点「修复」自动清理。"
        }
        if s.contains("E170001") || s.contains("E215004")
            || s.lowercased().contains("authentication failed")
            || s.lowercased().contains("authorization failed") {
            return "账号或密码不对，或者你没有这个目录的权限。"
        }
        // 路径级写权限：能读，但提交时被服务器 403 拒绝
        if s.contains("E175013") || s.contains("403 Forbidden") {
            return "服务器拒绝了这次提交：当前账号没有这个目录的写权限。"
        }
        // 服务端钩子拒绝：原因在 "with output:" 后面
        let lower = s.lowercased()
        if lower.contains("pre-commit hook") || lower.contains("post-commit hook")
            || lower.contains("hook (exit code") {
            if let out = hookOutput(s), !out.isEmpty {
                return "服务器拒绝了这次提交：\(out)"
            }
            return "服务器拒绝了这次提交（钩子脚本返回失败，原始报错见下）。"
        }
        if s.contains("E155037") {
            return "工作副本需要先执行一次清理（cleanup）。"
        }
        if s.contains("E195020") {
            return "本地文件和服务器记录对不上，可能需要重新下载这个目录。"
        }
        if s.contains("E230001") || lower.contains("certificate verification failed") {
            return "服务器的 HTTPS 证书验证失败，检查一下仓库地址是否被代理替换过。"
        }
        // E175002 是「DAV 请求失败」的通用码，钩子拒绝 / 403 / 500 都会带它，
        // 不能一看到它就断言网络不通。只有真正的连接类报错才说"连不上"。
        let connectionMarkers = [
            "E170013", "Unable to connect to a repository", "could not connect to server",
            "Could not resolve", "Connection refused", "Connection reset",
            "Operation timed out", "Network is unreachable",
        ]
        if connectionMarkers.contains(where: { s.contains($0) }) && !lower.contains("authorization failed") {
            return "连不上服务器，检查一下网络或仓库地址。"
        }
        let lines = s.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        // 第一行往往只是 "Commit failed (details follow):"，取带错误码的细节行
        if let detail = lines.first(where: {
            $0.hasPrefix("svn: E") && !$0.contains("details follow") && !$0.contains("E200009")
        }) {
            return detail.replacingOccurrences(of: "svn: ", with: "")
        }
        if let plain = lines.first(where: { !$0.hasPrefix("svn:") && !$0.hasPrefix("<") && !$0.isEmpty }) {
            return plain
        }
        return lines.first(where: { $0.hasPrefix("svn:") })?.replacingOccurrences(of: "svn: ", with: "")
            ?? "操作失败（退出码 \(code)）"
    }

    /// 钩子脚本写在 "with output:" 后面的几行，才是人能看懂的原因
    private static func hookOutput(_ stderr: String) -> String? {
        guard let range = stderr.range(of: "with output:") else { return nil }
        let body = stderr[range.upperBound...]
        let text = body.split(separator: "\n")
            .map { $0.replacingOccurrences(of: "svn: ", with: "").trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("E") }
            .joined(separator: " ")
        return text.isEmpty ? nil : String(text.prefix(300))
    }

    // MARK: - info

    public func info(_ path: String) throws -> WCInfo {
        let xml = try run(["info", "--xml", path])
        let d = try XMLNode.parse(xml)
        guard let entry = d.first("entry") else { throw SVNError.parse("info: 缺少 entry") }
        let rev = Int64(entry.attr("revision") ?? "") ?? 0
        let url = entry.first("url")?.text ?? ""
        let root = entry.first("repository")?.first("root")?.text ?? ""
        var branch = ""
        if !root.isEmpty, url.hasPrefix(root) {
            let rest = url.dropFirst(root.count).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            branch = rest.split(separator: "/").first.map(String.init) ?? ""
        }
        return WCInfo(url: url, revision: rev, branch: branch.isEmpty ? "trunk" : branch)
    }

    // MARK: - status

    public func status(_ wcPath: String, includeRemote: Bool = false) throws -> [ChangedFile] {
        var args = ["status", "--xml"]
        if includeRemote { args.append("-u") }
        args.append(wcPath)
        let xml = try run(args)
        let root = try XMLNode.parse(xml)

        var files: [ChangedFile] = []
        for entry in root.all("entry") {
            let rel = entry.attr("path") ?? ""
            guard !rel.isEmpty else { continue }

            var kind: ChangeKind?
            if let wc = entry.first("wc-status"), let item = wc.attr("item") {
                kind = ChangeKind(statusItem: item)
            }
            // 仅远程变更（本地没改）
            if kind == nil, let repos = entry.first("repos-status"), let item = repos.attr("item") {
                kind = ChangeKind(statusItem: item)
                if kind != nil {
                    files.append(makeFile(wcPath: wcPath, rel: rel, kind: kind!, isRemote: true))
                    continue
                }
            }
            guard let k = kind, k != .ignored else { continue }
            // 根节点自身不展示
            if rel == "." || rel == (wcPath as NSString).lastPathComponent { continue }
            files.append(makeFile(wcPath: wcPath, rel: rel, kind: k, isRemote: false))
        }
        // 远程条目单独查（-u 会在每个 entry 上给 repos-status）
        if includeRemote {
            for entry in root.all("entry") {
                guard let repos = entry.first("repos-status"),
                      let item = repos.attr("item"),
                      let k = ChangeKind(statusItem: item),
                      entry.first("wc-status")?.attr("item") == "normal" || entry.first("wc-status") == nil else { continue }
                let rel = entry.attr("path") ?? ""
                guard !rel.isEmpty, rel != "." else { continue }
                if files.contains(where: { $0.relativePath == rel }) { continue }
                files.append(makeFile(wcPath: wcPath, rel: rel, kind: k, isRemote: true))
            }
        }
        return files.sorted { $0.relativePath.localizedStandardCompare($1.relativePath) == .orderedAscending }
    }

    private func makeFile(wcPath: String, rel: String, kind: ChangeKind, isRemote: Bool) -> ChangedFile {
        let abs = (wcPath as NSString).appendingPathComponent(rel)
        let attrs = try? FileManager.default.attributesOfItem(atPath: abs)
        let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = attrs?[.modificationDate] as? Date
        let ext = (rel as NSString).pathExtension.lowercased()
        let binaryExts: Set<String> = ["png", "jpg", "jpeg", "gif", "psd", "zip", "pdf", "sketch", "mp4", "ttf", "otf", "ico", "heic"]
        let isBinary = binaryExts.contains(ext)

        var risk: RiskFlag?
        let lower = rel.lowercased()
        if lower.hasSuffix(".env") || lower.hasSuffix(".env.local") || lower.contains("id_rsa")
            || ext == "pem" || lower.contains("secret") || lower.contains("credential") {
            risk = .secret
        } else if size > 50 * 1024 * 1024 {
            risk = .largeFile
        } else if isBinary && kind != .deleted {
            risk = .binaryGrowth
        }

        var sizeText: String?
        if size > 0 {
            sizeText = ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
        }

        return ChangedFile(relativePath: rel, kind: kind, added: 0, deleted: 0,
                           isBinary: isBinary, sizeText: sizeText, risk: risk,
                           mtime: mtime, isRemote: isRemote)
    }

    // MARK: - diff

    public struct DiffResult {
        public let lines: [DiffLine]
        public let added: Int
        public let deleted: Int
        public let isBinary: Bool
    }

    public func diff(_ wcPath: String, file: ChangedFile) throws -> DiffResult {
        let abs = (wcPath as NSString).appendingPathComponent(file.relativePath)

        if file.isBinary {
            return DiffResult(lines: [], added: 0, deleted: 0, isBinary: true)
        }

        // 新增/未纳入的文件不在版本控制里，svn diff 无输出，直接读全文
        if file.kind == .added || file.kind == .unversioned {
            guard let content = try? String(contentsOfFile: abs, encoding: .utf8) else {
                return DiffResult(lines: [], added: 0, deleted: 0, isBinary: true)
            }
            let raw = content.split(separator: "\n", omittingEmptySubsequences: false)
            var lines: [DiffLine] = [DiffLine(kind: .hunk, oldNo: nil, newNo: nil, text: "@@ 新文件，共 \(raw.count) 行 @@")]
            for (i, l) in raw.enumerated() {
                lines.append(DiffLine(kind: .added, oldNo: nil, newNo: i + 1, text: String(l)))
            }
            return DiffResult(lines: lines, added: raw.count, deleted: 0, isBinary: false)
        }

        let out = try run(["diff", abs])
        if out.contains("Cannot display: file marked as a binary type") {
            return DiffResult(lines: [], added: 0, deleted: 0, isBinary: true)
        }
        return SVNEngine.parseUnifiedDiff(out)
    }

    /// 解析 unified diff，维护双列行号
    public static func parseUnifiedDiff(_ text: String) -> DiffResult {
        var lines: [DiffLine] = []
        var oldNo = 0, newNo = 0
        var added = 0, deleted = 0
        var inHunk = false
        let hunkRegex = try? NSRegularExpression(pattern: "^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@(.*)$")

        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(raw)
            if s.hasPrefix("Index: ") || s.hasPrefix("====") || s.hasPrefix("--- ")
                || s.hasPrefix("+++ ") || s.hasPrefix("Property changes on:") {
                continue
            }
            if s.hasPrefix("@@") {
                if let re = hunkRegex,
                   let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) {
                    oldNo = Int((s as NSString).substring(with: m.range(at: 1))) ?? oldNo
                    newNo = Int((s as NSString).substring(with: m.range(at: 2))) ?? newNo
                }
                inHunk = true
                lines.append(DiffLine(kind: .hunk, oldNo: nil, newNo: nil, text: s))
                continue
            }
            guard inHunk else { continue }
            if s.hasPrefix("+") {
                lines.append(DiffLine(kind: .added, oldNo: nil, newNo: newNo, text: String(s.dropFirst())))
                newNo += 1; added += 1
            } else if s.hasPrefix("-") {
                lines.append(DiffLine(kind: .removed, oldNo: oldNo, newNo: nil, text: String(s.dropFirst())))
                oldNo += 1; deleted += 1
            } else if s.hasPrefix(" ") || s.isEmpty {
                let body = s.hasPrefix(" ") ? String(s.dropFirst()) : s
                lines.append(DiffLine(kind: .context, oldNo: oldNo, newNo: newNo, text: body))
                oldNo += 1; newNo += 1
            }
            if lines.count > 20000 { break }
        }
        return DiffResult(lines: lines, added: added, deleted: deleted, isBinary: false)
    }

    // MARK: - log

    public func log(_ wcPath: String, limit: Int = 50) throws -> [RevisionEntry] {
        let xml = try run(["log", "--xml", "-l", "\(limit)", wcPath])
        let root = try XMLNode.parse(xml)
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fmt2 = ISO8601DateFormatter()

        return root.all("logentry").compactMap { e in
            guard let rev = Int64(e.attr("revision") ?? "") else { return nil }
            let author = e.first("author")?.text ?? "未知"
            let dateStr = e.first("date")?.text ?? ""
            let date = fmt.date(from: dateStr) ?? fmt2.date(from: dateStr) ?? Date()
            let msg = (e.first("msg")?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return RevisionEntry(revision: rev, author: author, date: date, message: msg)
        }
    }

    // MARK: - 写操作

    @discardableResult
    public func commit(wcPath: String, files: [String], message: String) throws -> Int64 {
        guard !files.isEmpty else { throw SVNError.failed(code: -1, message: "没有选择任何文件") }
        let out = try run(["commit", "-m", message, "--depth", "empty"] + files, cwd: wcPath)
        if let range = out.range(of: "Committed revision ") {
            let tail = out[range.upperBound...].prefix(while: { $0.isNumber || $0 == "," })
            let clean = tail.replacingOccurrences(of: ",", with: "")
            return Int64(clean) ?? 0
        }
        return 0
    }

    @discardableResult
    public func update(_ wcPath: String) throws -> (revision: Int64, conflicts: Int) {
        let out = try run(["update", wcPath])
        var conflicts = 0
        for line in out.split(separator: "\n") where line.hasPrefix("C    ") || line.hasPrefix("C ") {
            conflicts += 1
        }
        let rev = out.split(separator: "\n")
            .first { $0.hasPrefix("Updated to revision") || $0.hasPrefix("At revision") }
            .flatMap { Int64($0.split(separator: " ").last ?? "") } ?? 0
        return (rev, conflicts)
    }

    public func revert(wcPath: String, files: [String]) throws {
        guard !files.isEmpty else { return }
        _ = try run(["revert", "--depth", "infinity"] + files, cwd: wcPath)
    }

    public func cleanup(_ wcPath: String) throws {
        _ = try run(["cleanup", wcPath])
    }

    /// 把将被撤销的文件备份到快照目录（信誉防线：撤销可恢复）
    @discardableResult
    public func snapshot(wcPath: String, files: [ChangedFile]) -> String? {
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/FastSVN/snapshots/\(stamp)")
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            for f in files where f.kind != .deleted {
                let src = URL(fileURLWithPath: (wcPath as NSString).appendingPathComponent(f.relativePath))
                let dst = base.appendingPathComponent(f.relativePath)
                try? FileManager.default.createDirectory(at: dst.deletingLastPathComponent(),
                                                         withIntermediateDirectories: true)
                try? FileManager.default.copyItem(at: src, to: dst)
            }
            return base.path
        } catch {
            return nil
        }
    }
}

// MARK: - 轻量 XML 树

public final class XMLNode {
    public let name: String
    public var attributes: [String: String] = [:]
    public var text: String = ""
    public fileprivate(set) var children: [XMLNode] = []

    init(name: String) { self.name = name }

    public func first(_ name: String) -> XMLNode? { children.first { $0.name == name } }
    public func all(_ name: String) -> [XMLNode] { children.filter { $0.name == name } }
    public func attr(_ key: String) -> String? { attributes[key] }

    public static func parse(_ xml: String) throws -> XMLNode {
        guard let data = xml.data(using: .utf8) else { throw SVNError.parse("编码失败") }
        let parser = XMLParser(data: data)
        let delegate = TreeBuilder()
        parser.delegate = delegate
        guard parser.parse(), let root = delegate.root else {
            throw SVNError.parse(delegate.errorText ?? "XML 格式错误")
        }
        return root
    }
}

private final class TreeBuilder: NSObject, XMLParserDelegate {
    var root: XMLNode?
    private var stack: [XMLNode] = []
    var errorText: String?

    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName qName: String?,
                attributes attributeDict: [String: String] = [:]) {
        let node = XMLNode(name: elementName)
        node.attributes = attributeDict
        if let parent = stack.last {
            parent.children.append(node)
        } else {
            root = node
        }
        stack.append(node)
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        stack.last?.text += string
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String,
                namespaceURI: String?, qualifiedName qName: String?) {
        stack.last?.text = stack.last?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !stack.isEmpty { stack.removeLast() }
    }

    func parser(_ parser: XMLParser, parseErrorOccurred parseError: Error) {
        errorText = parseError.localizedDescription
    }
}
