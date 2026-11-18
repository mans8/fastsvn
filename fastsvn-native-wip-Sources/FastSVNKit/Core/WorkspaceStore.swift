import Foundation
import SwiftUI
import FastSVNKit

public enum ListTab: String, CaseIterable, Identifiable {
    case local, remote, all
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .local: return "待上传"
        case .remote: return "待同步"
        case .all: return "全部"
        }
    }
}

@MainActor
public final class WorkspaceStore: ObservableObject {

    @Published public var workingCopies: [WorkingCopy] = []
    @Published public var selectedWCID: String?
    @Published public var localFiles: [ChangedFile] = []
    @Published public var remoteFiles: [ChangedFile] = []
    @Published public var tab: ListTab = .local
    @Published public var onlyRisk = false
    @Published public var selectedFileID: String?

    @Published public var diffLines: [DiffLine] = []
    @Published public var diffBinary = false
    @Published public var diffLoading = false

    @Published public var task: CommitTaskState = .idle
    @Published public var statusText = "尚未同步"
    @Published public var lastSync: Date?

    @Published public var checked: Set<String> = []
    @Published public var commitMessage = ""
    @Published public var showCommitSheet = false
    @Published public var showConflictSheet = false
    @Published public var logEntries: [RevisionEntry] = []
    @Published public var errorMessage: String?
    @Published public var busy = false
    @Published public var conflictCount = 0

    public let engine = SVNEngine.shared
    private let defaultsKey = "fastsvn.workingCopies"

    public init() {
        loadSavedCopies()
        if let first = workingCopies.first {
            selectedWCID = first.id
            refresh()
        }
    }

    // MARK: - 工作副本

    public var selectedWC: WorkingCopy? {
        workingCopies.first { $0.id == selectedWCID }
    }

    private func loadSavedCopies() {
        let paths = UserDefaults.standard.stringArray(forKey: defaultsKey) ?? []
        workingCopies = paths.map { WorkingCopy(path: $0) }
    }

    private func persist() {
        UserDefaults.standard.set(workingCopies.map(\.path), forKey: defaultsKey)
    }

    public func addWorkingCopy(path: String) {
        guard !workingCopies.contains(where: { $0.path == path }) else { return }
        workingCopies.append(WorkingCopy(path: path))
        persist()
        selectedWCID = path
        refresh()
    }

    public func removeWorkingCopy(_ id: String) {
        workingCopies.removeAll { $0.id == id }
        persist()
        if selectedWCID == id {
            selectedWCID = workingCopies.first?.id
            refresh()
        }
    }

    public func select(_ id: String) {
        guard selectedWCID != id else { return }
        selectedWCID = id
        selectedFileID = nil
        diffLines = []
        refresh()
    }

    // MARK: - 刷新

    public func refresh() {
        guard let wc = selectedWC else { return }
        guard engine.svnPath != nil else {
            statusText = "未找到 svn 命令行工具"
            return
        }
        busy = true
        let path = wc.path

        Task.detached(priority: .userInitiated) {
            do {
                let info = try SVNEngine.shared.info(path)
                let all = try SVNEngine.shared.status(path, includeRemote: true)

                var local: [ChangedFile] = []
                for var f in all where !f.isRemote {
                    if !f.isBinary, f.kind == .modified || f.kind == .added || f.kind == .unversioned {
                        if let d = try? SVNEngine.shared.diff(path, file: f) {
                            f.added = d.added
                            f.deleted = d.deleted
                            f.isBinary = d.isBinary
                        }
                    }
                    local.append(f)
                }
                let remote = all.filter(\.isRemote)
                let conflicts = local.filter { $0.kind == .conflicted }.count

                await MainActor.run {
                    self.applyInfo(info, path: path)
                    self.localFiles = local
                    self.remoteFiles = remote
                    self.conflictCount = conflicts
                    self.checked = Set(local.filter { $0.kind != .ignored }.map(\.id))
                    self.busy = false
                    self.lastSync = Date()
                    self.statusText = "已是最新"
                    if let first = local.first, self.selectedFileID == nil {
                        self.selectFile(first.id)
                    }
                }
            } catch {
                await MainActor.run {
                    self.busy = false
                    self.statusText = "读取失败"
                    self.errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func applyInfo(_ info: WCInfo, path: String) {
        guard let i = workingCopies.firstIndex(where: { $0.id == path }) else { return }
        workingCopies[i].url = info.url
        workingCopies[i].revision = info.revision
        workingCopies[i].branch = info.branch
        workingCopies[i].lastSync = Date()
    }

    // MARK: - 列表

    public var visibleFiles: [ChangedFile] {
        let base: [ChangedFile]
        switch tab {
        case .local: base = localFiles
        case .remote: base = remoteFiles
        case .all: base = localFiles + remoteFiles
        }
        return onlyRisk ? base.filter { $0.risk != nil } : base
    }

    public var counts: [ListTab: Int] {
        [.local: localFiles.count, .remote: remoteFiles.count, .all: localFiles.count + remoteFiles.count]
    }

    public var selectedFile: ChangedFile? {
        (localFiles + remoteFiles).first { $0.id == selectedFileID }
    }

    public func selectFile(_ id: String?) {
        selectedFileID = id
        guard let id, let wc = selectedWC,
              let f = (localFiles + remoteFiles).first(where: { $0.id == id }) else {
            diffLines = []
            return
        }
        diffLoading = true
        let path = wc.path
        Task.detached(priority: .userInitiated) {
            let result = try? SVNEngine.shared.diff(path, file: f)
            await MainActor.run {
                self.diffLines = result?.lines ?? []
                self.diffBinary = result?.isBinary ?? false
                self.diffLoading = false
            }
        }
    }

    public func setTab(_ t: ListTab) {
        tab = t
        if let first = visibleFiles.first { selectFile(first.id) }
    }

    // MARK: - 勾选

    public func toggleCheck(_ id: String) {
        if checked.contains(id) { checked.remove(id) } else { checked.insert(id) }
    }

    public var checkedFiles: [ChangedFile] {
        localFiles.filter { checked.contains($0.id) }
    }

    public var draft: CommitDraft {
        CommitDraft(files: checkedFiles, message: commitMessage)
    }

    // MARK: - 动作

    public func openCommit() {
        commitMessage = ""
        showCommitSheet = true
    }

    public func commit() {
        guard let wc = selectedWC else { return }
        let files = checkedFiles
        guard !files.isEmpty else {
            errorMessage = "没有选择任何文件"
            return
        }
        guard !commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        showCommitSheet = false
        busy = true
        task = .running("正在上传 \(files.count) 个文件…")
        let msg = commitMessage
        let rels = files.map(\.relativePath)
        let path = wc.path

        Task.detached(priority: .userInitiated) {
            do {
                let rev = try SVNEngine.shared.commit(wcPath: path, files: rels, message: msg)
                await MainActor.run {
                    self.busy = false
                    self.task = .succeeded("已上传 · 版本 r\(rev)")
                    self.statusText = "已上传 · 版本 r\(rev)"
                    self.refresh()
                }
            } catch {
                await MainActor.run {
                    self.busy = false
                    self.task = .failed(error.localizedDescription)
                    self.errorMessage = error.localizedDescription
                }
            }
        }
    }

    public func update() {
        guard let wc = selectedWC else { return }
        busy = true
        task = .running("正在同步最新…")
        let path = wc.path
        Task.detached(priority: .userInitiated) {
            do {
                let r = try SVNEngine.shared.update(path)
                await MainActor.run {
                    self.busy = false
                    if r.conflicts > 0 {
                        self.task = .conflict(count: r.conflicts)
                        self.statusText = "有 \(r.conflicts) 个文件需要处理冲突"
                        self.showConflictSheet = true
                    } else {
                        self.task = .succeeded("已同步到 r\(r.revision)")
                        self.statusText = "已同步 · r\(r.revision)"
                    }
                    self.refresh()
                }
            } catch {
                await MainActor.run {
                    self.busy = false
                    self.task = .failed(error.localizedDescription)
                    self.errorMessage = error.localizedDescription
                }
            }
        }
    }

    public func revert(_ files: [ChangedFile]) {
        guard let wc = selectedWC else { return }
        guard !files.isEmpty else { return }
        let rels = files.map(\.relativePath)
        let path = wc.path
        // 撤销前先做快照（信誉防线）
        let snap = SVNEngine.shared.snapshot(wcPath: path, files: files)
        Task.detached(priority: .userInitiated) {
            do {
                try SVNEngine.shared.revert(wcPath: path, files: rels)
                await MainActor.run {
                    self.statusText = snap != nil ? "已撤销修改（原内容已备份，可在快照目录恢复）" : "已撤销修改"
                    self.refresh()
                }
            } catch {
                await MainActor.run { self.errorMessage = error.localizedDescription }
            }
        }
    }

    public func loadLog() {
        guard let wc = selectedWC else { return }
        let path = wc.path
        Task.detached(priority: .userInitiated) {
            let entries = (try? SVNEngine.shared.log(path, limit: 50)) ?? []
            await MainActor.run { self.logEntries = entries }
        }
    }

    public func cleanup() {
        guard let wc = selectedWC else { return }
        let path = wc.path
        Task.detached(priority: .userInitiated) {
            do {
                try SVNEngine.shared.cleanup(path)
                await MainActor.run { self.refresh() }
            } catch {
                await MainActor.run { self.errorMessage = error.localizedDescription }
            }
        }
    }
}
