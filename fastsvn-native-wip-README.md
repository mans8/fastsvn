# 原生 SwiftUI 骨架（暂不可构建）

本目录保留 SwiftUI 版本的源码骨架，**当前环境无法编译**。

原因：本机只有 Command Line Tools，没有完整 Xcode。
SwiftUI 的 `@State` / `@StateObject` 等已是宏实现，编译器需要
`SwiftUIMacros` 插件，而该插件只随 Xcode 提供：

```
error: external macro implementation type 'SwiftUIMacros.StateMacro'
       could not be found for macro 'State()'
```

## 装上 Xcode 后如何继续

```bash
cd fastsvn
mv fastsvn-native-wip-Sources Sources
mv fastsvn-native-wip-Package.swift Package.swift
swift build --disable-sandbox
```

已完成的原生部分：Theme（四主题 token）、Models、SVNEngine（`--xml` 解析 + 进程调用）、
WorkspaceStore、RootView / Sidebar / Toolbar / List / Diff / CommitSheet / ConflictSheet。
