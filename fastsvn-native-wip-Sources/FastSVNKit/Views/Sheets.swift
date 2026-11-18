import SwiftUI
import FastSVNKit

// MARK: - 提交审查面板

struct CommitSheet: View {
    @Environment(\.theme) private var t
    @ObservedObject var store: WorkspaceStore
    @FocusState private var messageFocused: Bool
    @State private var invalidMessage = false

    private var draft: CommitDraft { store.draft }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(t.isDark ? 0.42 : 0.26)
                .ignoresSafeArea()
                .onTapGesture { store.showCommitSheet = false }

            VStack(spacing: 0) {
                header
                Divider().overlay(t.line)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        summaryGrid
                        BalanceBar(added: draft.totalAdded, deleted: draft.totalDeleted)
                            .padding(.top, 2)
                            .padding(.bottom, 18)
                        riskBox
                        fileList
                        messageField
                    }
                    .padding(20)
                }
                .frame(maxHeight: 460)
                Divider().overlay(t.line)
                footer
            }
            .frame(width: 660)
            .background(t.elev)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .shadow(color: .black.opacity(0.28), radius: 22, y: 12)
        }
        .transition(.opacity)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("上传我的改动")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(t.ink)
            Text("这些内容会以一个新版本保存到服务器，同事同步后就能看到。")
                .font(.system(size: 12))
                .foregroundStyle(t.ink2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 12)
    }

    private var summaryGrid: some View {
        HStack(spacing: 10) {
            summaryCell(title: "文件", value: "\(draft.files.count)", color: t.ink)
            summaryCell(title: "新增行", value: "+\(draft.totalAdded)", color: t.add)
            summaryCell(title: "删除行", value: "−\(draft.totalDeleted)", color: t.del)
            summaryCell(title: "风险项", value: "\(draft.risks.count)",
                        color: draft.risks.isEmpty ? t.ink3 : t.conflict)
        }
        .padding(.bottom, 10)
    }

    private func summaryCell(title: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 11))
                .foregroundStyle(t.ink3)
            Text(value)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(color)
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(t.ink.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder private var riskBox: some View {
        if !draft.risks.isEmpty {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 12))
                    .foregroundStyle(t.conflict)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(draft.risks.count) 项需要你确认")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(t.ink)
                    Text(riskDescription)
                        .font(.system(size: 12))
                        .foregroundStyle(t.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(11)
            .background(t.conflict.opacity(0.09), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(t.conflict.opacity(0.30), lineWidth: 0.5))
            .padding(.bottom, 16)
        }
    }

    private var riskDescription: String {
        draft.risks
            .map { "\($0.name) \($0.risk?.text ?? "需要确认")" }
            .joined(separator: "；") + "。"
    }

    private var fileList: some View {
        VStack(spacing: 0) {
            ForEach(draft.files) { f in
                HStack(spacing: 9) {
                    StatusChip(kind: f.kind)
                    Text(f.name)
                        .font(.system(size: 12.5))
                        .foregroundStyle(t.ink)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(f.isBinary ? "二进制" : (f.added + f.deleted == 0 ? "待加入" : "+\(f.added) −\(f.deleted)"))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(t.ink3)
                }
                .padding(.horizontal, 8)
                .frame(height: 28)
            }
        }
        .padding(.bottom, 16)
    }

    private var messageField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("这次改了什么（必填）")
                .font(.system(size: 12))
                .foregroundStyle(t.ink2)
            ZStack(alignment: .topLeading) {
                TextEditor(text: $store.commitMessage)
                    .font(.system(size: 13))
                    .foregroundStyle(t.ink)
                    .scrollContentBackground(.hidden)
                    .focused($messageFocused)
                    .frame(height: 64)
                    .padding(4)
                    .background(t.window, in: RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7)
                        .strokeBorder(invalidMessage ? t.del : t.line2, lineWidth: invalidMessage ? 1.5 : 0.5))
                if store.commitMessage.isEmpty {
                    Text(invalidMessage ? "请填一句说明，方便同事看懂这次改了什么" : "例如：修复下单时并发导致的库存超卖")
                        .font(.system(size: 13))
                        .foregroundStyle(invalidMessage ? t.del.opacity(0.85) : t.ink3)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 10)
                        .allowsHitTesting(false)
                }
            }
            HStack(spacing: 6) {
                ForEach(["修复下单并发问题", "补充接口文档", "更新品牌资源"], id: \.self) { tpl in
                    Button(tpl) { store.commitMessage = tpl }
                        .buttonStyle(GhostButtonStyle())
                        .background(t.ink.opacity(0.05), in: Capsule())
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Text("已选 \(draft.files.count) 个文件")
                .font(.system(size: 12))
                .foregroundStyle(t.ink3)
            Spacer()
            Button("取消") { store.showCommitSheet = false }
                .buttonStyle(SecondaryButtonStyle(large: true))
            Button("上传") {
                if store.commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    invalidMessage = true
                    messageFocused = true
                    return
                }
                store.commit()
            }
            .buttonStyle(PrimaryButtonStyle(large: true))
            .disabled(draft.files.isEmpty)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(t.elev)
    }
}

// MARK: - 冲突解决

struct ConflictSheet: View {
    @Environment(\.theme) private var t
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        ZStack {
            Color.black.opacity(t.isDark ? 0.42 : 0.26)
                .ignoresSafeArea()
                .onTapGesture { store.showConflictSheet = false }

            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("这个文件你和同事都改了")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(t.ink)
                    Text("\(store.selectedFile?.relativePath ?? "文件") · 改动落在同一位置。选一个处理方式，或者逐行挑。")
                        .font(.system(size: 12))
                        .foregroundStyle(t.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)

                HStack(spacing: 8) {
                    choice("全部用我的", "你的改动会覆盖同事的")
                    choice("全部用同事的", "放弃你在这几处的改动")
                    choice("逐行挑选", "左右对照，一处一处选")
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)

                HStack(alignment: .top, spacing: 1) {
                    versionColumn(title: "我的版本", text: mineText, strong: true)
                    versionColumn(title: "同事的版本", text: theirsText, strong: false)
                }
                .background(t.line)
                .padding(.top, 14)

                HStack(spacing: 8) {
                    Text("还有 \(max(store.conflictCount - 1, 0)) 个文件也有冲突")
                        .font(.system(size: 11))
                        .foregroundStyle(t.ink3)
                    Spacer()
                    Button("稍后处理") { store.showConflictSheet = false }
                        .buttonStyle(SecondaryButtonStyle(large: true))
                    Button("完成并标记已解决") { store.showConflictSheet = false }
                        .buttonStyle(PrimaryButtonStyle(large: true))
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
            }
            .frame(width: 620)
            .background(t.elev)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .shadow(color: .black.opacity(0.30), radius: 24, y: 10)
        }
    }

    private func choice(_ title: String, _ detail: String) -> some View {
        VStack(spacing: 3) {
            Text(title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(t.ink)
            Text(detail).font(.system(size: 11)).foregroundStyle(t.ink3)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(t.ink.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    private func versionColumn(title: String, text: String, strong: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 11))
                .foregroundStyle(t.ink3)
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(strong ? t.ink : t.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(t.elev)
    }

    private var mineText: String {
        "function total(items) {\n  const n = items.length;\n  return items.reduce(\n    (s, i) => s + i.price, 0);\n}"
    }
    private var theirsText: String {
        "function total(items) {\n  return items.reduce(\n    (s, i) => s + i.price * i.qty, 0);\n}"
    }
}
