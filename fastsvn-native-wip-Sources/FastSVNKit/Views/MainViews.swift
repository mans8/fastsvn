import SwiftUI
import AppKit
import FastSVNKit

// MARK: - 根视图

public struct RootView: View {
    @StateObject private var store: WorkspaceStore
    @Environment(\.theme) private var t

    public init(store: WorkspaceStore = WorkspaceStore()) {
        _store = StateObject(wrappedValue: store)
    }

    public var body: some View {
        HStack(spacing: 0) {
            SidebarView(store: store)
            VStack(spacing: 0) {
                ToolbarView(store: store)
                if store.selectedWC == nil {
                    EmptyStateView(store: store)
                } else {
                    HStack(spacing: 0) {
                        FileListView(store: store)
                            .frame(width: Metrics.listMax)
                        Rectangle().fill(t.line).frame(width: 1)
                        DiffView(store: store)
                            .frame(maxWidth: .infinity)
                    }
                    .frame(maxHeight: .infinity)
                    StatusBarView(store: store)
                }
            }
            .background(t.canvas)
        }
        .background(t.canvas)
        .overlay(alignment: .top) {
            if store.showCommitSheet {
                CommitSheet(store: store)
            }
        }
        .overlay {
            if store.showConflictSheet {
                ConflictSheet(store: store)
            }
        }
    }
}

// MARK: - 侧栏

struct SidebarView: View {
    @Environment(\.theme) private var t
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Spacer(minLength: 62)   // 给系统交通灯留位
                (Text("Fast").foregroundColor(t.ink3)
                 + Text("SVN").foregroundColor(t.accent))
                    .font(.system(size: 12))
            }
            .padding(.top, 10)
            .padding(.trailing, 14)

            HStack {
                Text("我的项目")
                    .font(.system(size: 11))
                    .foregroundStyle(t.ink3)
                Spacer()
                Button {
                    pickFolder()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(t.ink3)
                }
                .buttonStyle(.plain)
                .help("添加项目")
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 6)

            ScrollView {
                VStack(spacing: 1) {
                    ForEach(store.workingCopies) { wc in
                        ProjectRow(wc: wc,
                                   selected: wc.id == store.selectedWCID,
                                   count: wc.id == store.selectedWCID ? store.localFiles.count : nil)
                        .contentShape(Rectangle())
                        .onTapGesture { store.select(wc.id) }
                        .contextMenu {
                            Button("从列表移除") { store.removeWorkingCopy(wc.id) }
                        }
                    }
                }
                .padding(.horizontal, 10)
            }

            Spacer(minLength: 0)

            Divider().overlay(t.line)
            Button {
                pickFolder()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                    Text("添加项目…").font(.system(size: 13))
                    Spacer()
                }
                .foregroundStyle(t.ink2)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(10)
        }
        .frame(width: Metrics.sidebarWidth)
        .background(t.sidebar)
        .overlay(alignment: .trailing) {
            Rectangle().fill(t.line).frame(width: 1)
        }
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "添加"
        panel.message = "选择一个 SVN 文件夹（含 .svn 目录）"
        if panel.runModal() == .OK, let url = panel.url {
            store.addWorkingCopy(path: url.path)
        }
    }
}

struct ProjectRow: View {
    @Environment(\.theme) private var t
    let wc: WorkingCopy
    let selected: Bool
    let count: Int?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder")
                .font(.system(size: 12))
                .foregroundStyle(selected ? t.accent : t.ink3)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(wc.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(t.ink)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(t.ink3)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if let count, count > 0 {
                Text("\(count)")
                    .font(.system(size: 11))
                    .foregroundStyle(t.ink2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(t.ink.opacity(0.07), in: Capsule())
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(selected ? t.accentSoft : Color.clear,
                    in: RoundedRectangle(cornerRadius: Metrics.controlRadius))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.controlRadius)
                .strokeBorder(selected ? t.accentSoft2 : .clear, lineWidth: 0.5)
        )
    }

    private var subtitle: String {
        if wc.revision > 0 {
            return "\(wc.branch.isEmpty ? "trunk" : wc.branch) · \(wc.displayRevision)"
        }
        return wc.branch.isEmpty ? "未连接" : wc.branch
    }
}

// MARK: - 工具栏

struct ToolbarView: View {
    @Environment(\.theme) private var t
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        HStack(spacing: 14) {
            if let wc = store.selectedWC {
                HStack(spacing: 7) {
                    Text(wc.name)
                        .font(.system(size: Metrics.titleFont, weight: .semibold))
                        .foregroundStyle(t.ink)
                        .lineLimit(1)
                    Text("›").font(.system(size: 12)).foregroundStyle(t.ink3)
                    Text(wc.branch.isEmpty ? "trunk" : wc.branch)
                        .font(.system(size: 13))
                        .foregroundStyle(t.ink2)
                    if wc.revision > 0 {
                        Text(wc.displayRevision)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(t.ink2)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(t.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 5))
                    }
                }
            } else {
                Text("FastSVN")
                    .font(.system(size: Metrics.titleFont, weight: .semibold))
                    .foregroundStyle(t.ink)
            }

            Spacer(minLength: 8)

            Button {
                store.update()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 11, weight: .regular))
                    Text("同步最新")
                }
            }
            .buttonStyle(SecondaryButtonStyle())
            .disabled(store.busy || store.selectedWC == nil)

            Button {
                store.openCommit()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 11, weight: .semibold))
                    Text("上传我的改动")
                    Text("\(store.checkedFiles.count)")
                        .font(.system(size: 11))
                        .padding(.horizontal, 5)
                        .frame(height: 17)
                        .background(t.onAccent.opacity(0.22), in: Capsule())
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(store.busy || store.selectedWC == nil)
        }
        .padding(.horizontal, 16)
        .frame(height: Metrics.toolbarHeight)
        .background(t.canvas)
        .overlay(alignment: .bottom) {
            Rectangle().fill(t.line).frame(height: 1)
        }
    }
}

// MARK: - 状态栏

struct StatusBarView: View {
    @Environment(\.theme) private var t
    @ObservedObject var store: WorkspaceStore
    @AppStorage("fastsvn.theme") private var themeRaw = ThemeID.light.rawValue

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 4) {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                Text(store.statusText)
            }
            .font(.system(size: 11))
            .foregroundStyle(store.task.isFailure ? t.del : t.add)

            Spacer()

            Text("状态缓存命中")
                .font(.system(size: 11))
                .foregroundStyle(t.ink3)
            Text("⌘R 同步 · ⌘K 上传")
                .font(.system(size: 11))
                .foregroundStyle(t.ink3)

            Menu {
                ForEach(ThemeID.allCases) { id in
                    Button {
                        themeRaw = id.rawValue
                    } label: {
                        Text(id.title)
                    }
                }
            } label: {
                Image(systemName: "circle.lefthalf.filled")
                    .font(.system(size: 11))
                    .foregroundStyle(t.ink3)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .padding(.horizontal, 14)
        .frame(height: Metrics.statusBarHeight)
        .background(t.canvas)
        .overlay(alignment: .top) {
            Rectangle().fill(t.line).frame(height: 1)
        }
    }
}

extension CommitTaskState {
    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }
}

// MARK: - 空状态 / 首次引导

struct EmptyStateView: View {
    @Environment(\.theme) private var t
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "shippingbox")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(t.accent.opacity(0.85))
            Text("从一个 SVN 文件夹开始")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(t.ink)
            Text("选一个已经在电脑里的 SVN 文件夹，或先用命令行下载一个。\n不需要安装别的东西，FastSVN 自带 svn 引擎。")
                .font(.system(size: 13))
                .foregroundStyle(t.ink2)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
            HStack(spacing: 8) {
                Button("打开已有文件夹…") {
                    let panel = NSOpenPanel()
                    panel.canChooseDirectories = true
                    panel.canChooseFiles = false
                    panel.prompt = "打开"
                    if panel.runModal() == .OK, let url = panel.url {
                        store.addWorkingCopy(path: url.path)
                    }
                }
                .buttonStyle(PrimaryButtonStyle(large: true))
                Button("下载一个仓库…") {}
                    .buttonStyle(SecondaryButtonStyle(large: true))
            }
            .padding(.top, 4)

            if store.engine.svnPath == nil {
                Text("⚠️ 未检测到 svn 命令行工具")
                    .font(.system(size: 11))
                    .foregroundStyle(t.conflict)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.canvas)
    }
}
