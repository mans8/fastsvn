import SwiftUI
import FastSVNKit

// MARK: - 文件列表

struct FileListView: View {
    @Environment(\.theme) private var t
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 9) {
                SegmentedTabs(selection: Binding(
                    get: { store.tab },
                    set: { store.setTab($0) }
                ), counts: store.counts)

                HStack(spacing: 10) {
                    Button {
                        store.onlyRisk.toggle()
                    } label: {
                        HStack(spacing: 6) {
                            CheckBox(isOn: Binding(get: { store.onlyRisk },
                                                   set: { _ in store.onlyRisk.toggle() }))
                            Text("只看有风险的")
                                .font(.system(size: 12))
                                .foregroundStyle(t.ink2)
                        }
                    }
                    .buttonStyle(.plain)

                    Spacer()
                    HStack(spacing: 4) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 10))
                            .foregroundStyle(t.ink3)
                        Text("筛选")
                            .font(.system(size: 12))
                            .foregroundStyle(t.ink3)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .overlay(alignment: .bottom) {
                Rectangle().fill(t.line).frame(height: 1)
            }

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(store.visibleFiles) { f in
                        FileRow(file: f,
                                selected: store.selectedFileID == f.id,
                                checked: Binding(
                                    get: { store.checked.contains(f.id) },
                                    set: { _ in store.toggleCheck(f.id) }
                                ),
                                onSelect: { store.selectFile(f.id) },
                                onConflict: {
                                    store.selectFile(f.id)
                                    store.showConflictSheet = true
                                })
                    }
                    if store.visibleFiles.isEmpty {
                        Text(store.busy ? "正在读取…" : "这个筛选下没有文件")
                            .font(.system(size: 12.5))
                            .foregroundStyle(t.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.top, 20)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .background(t.window)
    }
}

struct FileRow: View {
    @Environment(\.theme) private var t
    let file: ChangedFile
    let selected: Bool
    @Binding var checked: Bool
    let onSelect: () -> Void
    let onConflict: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 9) {
            CheckBox(isOn: $checked, enabled: !file.isRemote && file.kind != .ignored)

            StatusChip(kind: file.kind)

            VStack(alignment: .leading, spacing: 1) {
                Text(file.name)
                    .font(.system(size: 13))
                    .foregroundStyle(t.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(file.directory)
                    .font(.system(size: 11))
                    .foregroundStyle(t.ink3)
                    .lineLimit(1)
                    .truncationMode(.head)
            }

            Spacer(minLength: 6)

            statView

            Text(timeText)
                .font(.system(size: 11))
                .foregroundStyle(t.ink3)
                .frame(width: 56, alignment: .trailing)
        }
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .frame(height: Metrics.rowHeight)
        .background(rowBackground)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(selected ? t.accent : .clear)
                .frame(width: 2)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            onSelect()
            if file.kind == .conflicted { onConflict() }
        }
        .onHover { hover = $0 }
    }

    @ViewBuilder private var statView: some View {
        if file.isBinary {
            Text(file.risk == .secret ? "疑似密钥" : "二进制")
                .font(.system(size: 10))
                .foregroundStyle(t.conflict)
        } else if file.added == 0 && file.deleted == 0 {
            Text(file.kind == .unversioned ? "待加入" : "—")
                .font(.system(size: 11))
                .foregroundStyle(t.ink3)
        } else {
            HStack(spacing: 6) {
                Text("+\(file.added)").foregroundStyle(t.add)
                Text("−\(file.deleted)").foregroundStyle(t.del)
            }
            .font(.system(size: 11, design: .monospaced))
        }
    }

    private var rowBackground: Color {
        if selected { return t.accentSoft }
        if hover { return t.ink.opacity(0.04) }
        return .clear
    }

    private var timeText: String {
        guard let d = file.mtime else { return "—" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        if Calendar.current.isDateInToday(d) { f.dateFormat = "HH:mm" }
        else { f.dateFormat = "M/d" }
        return f.string(from: d)
    }
}

// MARK: - 差异阅读区

struct DiffView: View {
    @Environment(\.theme) private var t
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(t.line).frame(height: 1)
            content
        }
        .background(t.canvas)
    }

    private var header: some View {
        HStack(spacing: 10) {
            if let f = store.selectedFile {
                Text(f.name)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(t.ink)
                    .lineLimit(1)
                Text("·").foregroundStyle(t.ink3)
                Text(f.directory)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(t.ink2)
                    .lineLimit(1)
                    .truncationMode(.head)
            } else {
                Text("选择一个文件查看它改了什么")
                    .font(.system(size: 12.5))
                    .foregroundStyle(t.ink3)
            }

            Spacer(minLength: 6)

            if let f = store.selectedFile, !f.isBinary, f.added + f.deleted > 0 {
                HStack(spacing: 6) {
                    Text("+\(f.added)").foregroundStyle(t.add)
                    Text("−\(f.deleted)").foregroundStyle(t.del)
                }
                .font(.system(size: 11, design: .monospaced))
            }

            HStack(spacing: 6) {
                Text("行内")
                    .font(.system(size: 11))
                    .foregroundStyle(t.accent)
                    .padding(.horizontal, 8)
                    .frame(height: 24)
                    .background(t.accentSoft, in: RoundedRectangle(cornerRadius: 5))
                Text("并排")
                    .font(.system(size: 11))
                    .foregroundStyle(t.ink2)
                    .padding(.horizontal, 8)
                    .frame(height: 24)
                Text("外部工具 ↗")
                    .font(.system(size: 11))
                    .foregroundStyle(t.ink2)
                    .padding(.horizontal, 8)
                    .frame(height: 24)
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 46)
    }

    @ViewBuilder private var content: some View {
        if store.diffLoading {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.diffLines.isEmpty {
            VStack(spacing: 0) {
                Text(store.diffBinary
                     ? "二进制文件不做逐行对比"
                     : "这个文件还没有可预览的改动内容")
                    .font(.system(size: 12.5))
                    .foregroundStyle(t.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                Spacer()
            }
        } else {
            HStack(spacing: 0) {
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(store.diffLines) { line in
                            DiffRow(line: line)
                        }
                    }
                    .padding(.vertical, 8)
                }
                ChangeMap(lines: store.diffLines)
                    .frame(width: 12)
                    .padding(.vertical, 4)
            }
        }
    }
}

struct DiffRow: View {
    @Environment(\.theme) private var t
    let line: DiffLine

    var body: some View {
        HStack(spacing: 0) {
            Text(line.oldNo.map(String.init) ?? "")
                .frame(width: 36, alignment: .trailing)
                .padding(.trailing, 7)
            Text(line.newNo.map(String.init) ?? "")
                .frame(width: 36, alignment: .trailing)
                .padding(.trailing, 7)
            Text(symbol)
                .frame(width: 22)
            Text(line.text)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.trailing, 24)
            Spacer(minLength: 0)
        }
        .font(.system(size: Metrics.codeFont, design: .monospaced))
        .foregroundStyle(isHunk ? t.ink2 : t.ink)
        .lineLimit(1)
        .padding(.vertical, isHunk ? 1 : 0)
        .frame(height: isHunk ? 20 : 21, alignment: .leading)
        .background(background)
    }

    private var isHunk: Bool { line.kind == .hunk }

    private var symbol: String {
        switch line.kind {
        case .added: return "+"
        case .removed: return "−"
        default: return ""
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: return t.diffAddBG
        case .removed: return t.diffDelBG
        case .hunk: return t.accent.opacity(0.08)
        case .context: return .clear
        }
    }
}

/// 变更地图：右侧竖条标出改动位置
struct ChangeMap: View {
    @Environment(\.theme) private var t
    let lines: [DiffLine]

    var body: some View {
        GeometryReader { geo in
            let changes = indexedChanges
            let total = max(Double(lines.count), 1)
            ZStack(alignment: .top) {
                Rectangle().fill(t.line).frame(width: 1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(Array(changes.enumerated()), id: \.offset) { item in
                    Rectangle()
                        .fill(item.element.1 == .added ? t.add : t.del)
                        .frame(height: 2)
                        .offset(y: CGFloat(Double(item.element.0) / total) * (geo.size.height - 2))
                        .padding(.horizontal, 4)
                }
            }
        }
    }

    private var indexedChanges: [(Int, DiffLine.Kind)] {
        var out: [(Int, DiffLine.Kind)] = []
        for (i, l) in lines.enumerated() {
            if l.kind == .added || l.kind == .removed { out.append((i, l.kind)) }
            if out.count > 400 { break }
        }
        return out
    }
}
