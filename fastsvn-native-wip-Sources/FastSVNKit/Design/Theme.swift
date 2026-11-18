import SwiftUI

/// 四主题，对齐 JetBrains 平台标准主题集。
public enum ThemeID: String, CaseIterable, Identifiable {
    case light, hcLight, dark, hcDark

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .light: return "明亮"
        case .hcLight: return "强对比 · 亮"
        case .dark: return "深色"
        case .hcDark: return "强对比 · 暗"
        }
    }

    /// 跟随系统外观时用于自动选择默认主题。
    public static func systemDefault(dark: Bool) -> ThemeID { dark ? .dark : .light }
}

public struct Theme {
    public let id: ThemeID

    // 表面
    public let window: Color
    public let sidebar: Color
    public let canvas: Color
    public let elev: Color
    // 文本
    public let ink: Color
    public let ink2: Color
    public let ink3: Color
    // 分隔
    public let line: Color
    public let line2: Color
    // 主色
    public let accent: Color
    public let accentHi: Color
    public let accentSoft: Color
    public let accentSoft2: Color
    // 状态
    public let add: Color
    public let mod: Color
    public let del: Color
    public let conflict: Color
    public let unversioned: Color
    // diff 底
    public let diffAddBG: Color
    public let diffDelBG: Color
    public let diffAddGut: Color
    public let diffDelGut: Color
    // 主按钮文字
    public let onAccent: Color
    public let isDark: Bool

    public static func of(_ id: ThemeID) -> Theme {
        switch id {
        case .light: return .light
        case .hcLight: return .hcLight
        case .dark: return .dark
        case .hcDark: return .hcDark
        }
    }

    static func rgb(_ hex: UInt32, _ a: Double = 1) -> Color {
        Color(.sRGB,
              red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255,
              opacity: a)
    }

    public static let light = Theme(
        id: .light,
        window: rgb(0xFFFFFF), sidebar: rgb(0xF5F6F8), canvas: rgb(0xFAFBFD), elev: rgb(0xFFFFFF),
        ink: rgb(0x1F2328), ink2: rgb(0x515866), ink3: rgb(0x5F6872),
        line: rgb(0xE4E7EC), line2: rgb(0xCFD5DF),
        accent: rgb(0x2C6FD1), accentHi: rgb(0x1E5CB9),
        accentSoft: rgb(0x2C6FD1, 0.10), accentSoft2: rgb(0x2C6FD1, 0.20),
        add: rgb(0x1B7F4B), mod: rgb(0x0B6DB8), del: rgb(0xB04540),
        conflict: rgb(0xA85806), unversioned: rgb(0x71695B),
        diffAddBG: rgb(0x1B7F4B, 0.10), diffDelBG: rgb(0xB04540, 0.10),
        diffAddGut: rgb(0x1B7F4B, 0.18), diffDelGut: rgb(0xB04540, 0.18),
        onAccent: .white, isDark: false)

    public static let hcLight = Theme(
        id: .hcLight,
        window: rgb(0xFFFFFF), sidebar: rgb(0xFFFFFF), canvas: rgb(0xFFFFFF), elev: rgb(0xFFFFFF),
        ink: rgb(0x000000), ink2: rgb(0x2C3138), ink3: rgb(0x3D434C),
        line: rgb(0xC9CED6), line2: rgb(0xAEB5C0),
        accent: rgb(0x1C55B0), accentHi: rgb(0x144699),
        accentSoft: rgb(0x1C55B0, 0.12), accentSoft2: rgb(0x1C55B0, 0.24),
        add: rgb(0x0E6B3D), mod: rgb(0x0A5CA8), del: rgb(0xA83531),
        conflict: rgb(0x8F4E05), unversioned: rgb(0x615A4C),
        diffAddBG: rgb(0x0E6B3D, 0.13), diffDelBG: rgb(0xA83531, 0.13),
        diffAddGut: rgb(0x0E6B3D, 0.22), diffDelGut: rgb(0xA83531, 0.22),
        onAccent: .white, isDark: false)

    public static let dark = Theme(
        id: .dark,
        window: rgb(0x3C3F41), sidebar: rgb(0x2B2B2B), canvas: rgb(0x313335), elev: rgb(0x45484A),
        ink: rgb(0xDEE2E6), ink2: rgb(0xA8AFB8), ink3: rgb(0xAEB5C0),
        line: rgb(0x3F4347), line2: rgb(0x4E535A),
        accent: rgb(0x7DB1F1), accentHi: rgb(0x8FC2F6),
        accentSoft: rgb(0x7DB1F1, 0.14), accentSoft2: rgb(0x7DB1F1, 0.26),
        add: rgb(0x73BD81), mod: rgb(0x79B0E2), del: rgb(0xEF9088),
        conflict: rgb(0xE99A4E), unversioned: rgb(0xB5AA92),
        diffAddBG: rgb(0x73BD81, 0.13), diffDelBG: rgb(0xEF9088, 0.13),
        diffAddGut: rgb(0x73BD81, 0.22), diffDelGut: rgb(0xEF9088, 0.22),
        onAccent: rgb(0x0F1626), isDark: true)

    public static let hcDark = Theme(
        id: .hcDark,
        window: rgb(0x191B1E), sidebar: rgb(0x101113), canvas: rgb(0x191B1E), elev: rgb(0x1E2124),
        ink: rgb(0xFFFFFF), ink2: rgb(0xC9CFD6), ink3: rgb(0xB4BAC2),
        line: rgb(0x3A3E44), line2: rgb(0x4C5158),
        accent: rgb(0x82B4FF), accentHi: rgb(0x9CC4FF),
        accentSoft: rgb(0x82B4FF, 0.16), accentSoft2: rgb(0x82B4FF, 0.30),
        add: rgb(0x6FC57F), mod: rgb(0x6BAEE8), del: rgb(0xF08A82),
        conflict: rgb(0xF09A4A), unversioned: rgb(0xBBAF98),
        diffAddBG: rgb(0x6FC57F, 0.16), diffDelBG: rgb(0xF08A82, 0.16),
        diffAddGut: rgb(0x6FC57F, 0.28), diffDelGut: rgb(0xF08A82, 0.28),
        onAccent: rgb(0x0F1626), isDark: true)

    // 状态色映射
    public func color(for kind: ChangeKind) -> Color {
        switch kind {
        case .modified: return mod
        case .added: return add
        case .deleted: return del
        case .conflicted: return conflict
        case .unversioned: return unversioned
        case .ignored: return ink3
        }
    }

    public func letterColor(for kind: ChangeKind) -> Color {
        switch kind {
        case .modified: return mod
        case .added: return add
        case .deleted: return del
        case .conflicted: return conflict
        case .unversioned: return unversioned
        case .ignored: return ink3
        }
    }
}

// MARK: - 字体与度量

public enum Metrics {
    public static let sidebarWidth: CGFloat = 238
    public static let toolbarHeight: CGFloat = 58
    public static let statusBarHeight: CGFloat = 30
    public static let rowHeight: CGFloat = 36
    public static let listMin: CGFloat = 320
    public static let listMax: CGFloat = 404
    public static let controlRadius: CGFloat = 6
    public static let windowRadius: CGFloat = 12
    public static let baseFont: CGFloat = 13
    public static let metaFont: CGFloat = 11
    public static let codeFont: CGFloat = 12.5
    public static let titleFont: CGFloat = 15
}

public enum Fonts {
    public static func ui(_ size: CGFloat = Metrics.baseFont, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    public static func mono(_ size: CGFloat = Metrics.codeFont, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

// MARK: - 环境注入

private struct ThemeKey: EnvironmentKey {
    static let defaultValue: Theme = .light
}

public extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

public extension View {
    func theme(_ t: Theme) -> some View { environment(\.theme, t) }
}
