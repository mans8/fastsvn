import SwiftUI
import FastSVNKit

// MARK: - 状态芯片

struct StatusChip: View {
    @Environment(\.theme) private var t
    let kind: ChangeKind

    var body: some View {
        Text(kind.letter)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(t.color(for: kind))
            .frame(width: 20, height: 20)
            .background(t.color(for: kind).opacity(0.13), in: RoundedRectangle(cornerRadius: 5))
            .accessibilityLabel(kind.label)
    }
}

// MARK: - 按钮

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.theme) private var t
    var large = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(t.onAccent)
            .padding(.horizontal, large ? 16 : 12)
            .frame(height: large ? 32 : 30)
            .background(t.accent.opacity(configuration.isPressed ? 0.85 : 1),
                        in: RoundedRectangle(cornerRadius: Metrics.controlRadius))
            .opacity(configuration.isPressed ? 0.92 : 1)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.theme) private var t
    var large = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(t.ink)
            .padding(.horizontal, large ? 16 : 12)
            .frame(height: large ? 32 : 30)
            .background(t.elev, in: RoundedRectangle(cornerRadius: Metrics.controlRadius))
            .overlay(RoundedRectangle(cornerRadius: Metrics.controlRadius)
                .strokeBorder(t.line2, lineWidth: 0.5))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

struct GhostButtonStyle: ButtonStyle {
    @Environment(\.theme) private var t

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11))
            .foregroundStyle(t.ink2)
            .padding(.horizontal, 8)
            .frame(height: 24)
            .background(configuration.isPressed ? t.accent.opacity(0.12) : .clear,
                        in: RoundedRectangle(cornerRadius: 5))
    }
}

// MARK: - 分段控件

struct SegmentedTabs: View {
    @Environment(\.theme) private var t
    @Binding var selection: ListTab
    let counts: [ListTab: Int]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(ListTab.allCases) { tab in
                Button {
                    selection = tab
                } label: {
                    HStack(spacing: 5) {
                        Text(tab.title)
                            .font(.system(size: 12, weight: selection == tab ? .medium : .regular))
                            .foregroundStyle(selection == tab ? t.ink : t.ink2)
                        if let n = counts[tab], n > 0, tab != .all {
                            Text("\(n)")
                                .font(.system(size: 11))
                                .foregroundStyle(selection == tab ? t.ink2 : t.ink3)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 24)
                    .background(selection == tab ? t.elev : .clear,
                                in: RoundedRectangle(cornerRadius: 5))
                    .shadow(color: selection == tab ? .black.opacity(0.10) : .clear, radius: 1, y: 1)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(t.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
    }
}

// MARK: - 复选框

struct CheckBox: View {
    @Environment(\.theme) private var t
    @Binding var isOn: Bool
    var enabled: Bool = true

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            RoundedRectangle(cornerRadius: 4)
                .fill(isOn ? t.accent : t.elev)
                .frame(width: 15, height: 15)
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(isOn ? t.accent : t.line2, lineWidth: isOn ? 0 : 1)
                )
                .overlay {
                    if isOn {
                        Image(systemName: "checkmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.white)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
    }
}

// MARK: - 变更平衡条

struct BalanceBar: View {
    @Environment(\.theme) private var t
    let added: Int
    let deleted: Int

    var body: some View {
        GeometryReader { geo in
            let total = max(added + deleted, 1)
            let a = geo.size.width * CGFloat(added) / CGFloat(total)
            HStack(spacing: 2) {
                Rectangle().fill(t.add).frame(width: max(a, added > 0 ? 2 : 0))
                Rectangle().fill(t.del)
            }
        }
        .frame(height: 5)
        .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

// MARK: - 小标签

struct MetaText: View {
    @Environment(\.theme) private var t
    let text: String
    var body: some View {
        Text(text).font(.system(size: Metrics.metaFont)).foregroundStyle(t.ink3)
    }
}
