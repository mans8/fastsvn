import SwiftUI
import AppKit
import FastSVNKit

@main
struct FastSVNApp: App {
    @AppStorage("fastsvn.theme") private var themeRaw = ThemeID.light.rawValue

    private var theme: Theme {
        Theme.of(ThemeID(rawValue: themeRaw) ?? .light)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .theme(theme)
                .preferredColorScheme(theme.isDark ? .dark : .light)
                .frame(minWidth: 1040, minHeight: 620)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appSettings) {
                Menu("主题") {
                    ForEach(ThemeID.allCases) { id in
                        Button(id.title) { themeRaw = id.rawValue }
                    }
                }
            }
            CommandGroup(replacing: .newItem) {}
        }
    }
}
