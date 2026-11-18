import Foundation
import SwiftUI

/// SVN 文件变更类型（映射 svn status 的 item 值）。
public enum ChangeKind: String, CaseIterable {
    case modified
    case added
    case deleted
    case conflicted
    case unversioned
    case ignored

    public init?(statusItem: String) {
        switch statusItem {
        case "modified", "replaced": self = .modified
        case "added": self = .added
        case "deleted", "missing": self = .deleted
        case "conflicted": self = .conflicted
        case "unversioned": self = .unversioned
        case "ignored": self = .ignored
        default: return nil
        }
    }

    /// 状态字母（色盲冗余编码的第二重）
    public var letter: String {
        switch self {
        case .modified: return "M"
        case .added: return "A"
        case .deleted: return "D"
        case .conflicted: return "C"
        case .unversioned: return "U"
        case .ignored: return "I"
        }
    }

    public var label: String {
        switch self {
        case .modified: return "已修改"
        case .added: return "新增"
        case .deleted: return "已删除"
        case .conflicted: return "有冲突"
        case .unversioned: return "未纳入"
        case .ignored: return "已忽略"
        }
    }
}

public struct WorkingCopy: Identifiable, Hashable {
    public var id: String { path }
    public let path: String
    public var name: String
    public var url: String
    public var revision: Int64
    public var branch: String
    public var lastSync: Date?

    public init(path: String, name: String? = nil, url: String = "", revision: Int64 = 0,
                branch: String = "", lastSync: Date? = nil) {
        self.path = path
        self.name = name ?? (path as NSString).lastPathComponent
        self.url = url
        self.revision = revision
        self.branch = branch
        self.lastSync = lastSync
    }

    public var displayRevision: String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        return "r" + (f.string(from: NSNumber(value: revision)) ?? "\(revision)")
    }
}

public struct ChangedFile: Identifiable, Hashable {
    public var id: String { relativePath }
    public let relativePath: String
    public var kind: ChangeKind
    public var added: Int
    public var deleted: Int
    public var isBinary: Bool
    public var sizeText: String?
    public var risk: RiskFlag?
    public var mtime: Date?
    public var isRemote: Bool

    public var name: String { (relativePath as NSString).lastPathComponent }
    public var directory: String {
        let d = (relativePath as NSString).deletingLastPathComponent
        return d.isEmpty ? "工作副本根目录" : d
    }

    public init(relativePath: String, kind: ChangeKind, added: Int = 0, deleted: Int = 0,
                isBinary: Bool = false, sizeText: String? = nil, risk: RiskFlag? = nil,
                mtime: Date? = nil, isRemote: Bool = false) {
        self.relativePath = relativePath
        self.kind = kind
        self.added = added
        self.deleted = deleted
        self.isBinary = isBinary
        self.sizeText = sizeText
        self.risk = risk
        self.mtime = mtime
        self.isRemote = isRemote
    }
}

public enum RiskFlag: String {
    case secret = "疑似密钥"
    case largeFile = "体积偏大"
    case binaryGrowth = "二进制变更"

    public var text: String { rawValue }
}

public struct DiffLine: Identifiable {
    public enum Kind { case context, added, removed, hunk }
    public let id = UUID()
    public let kind: Kind
    public let oldNo: Int?
    public let newNo: Int?
    public let text: String

    public init(kind: Kind, oldNo: Int?, newNo: Int?, text: String) {
        self.kind = kind
        self.oldNo = oldNo
        self.newNo = newNo
        self.text = text
    }
}

public struct RevisionEntry: Identifiable, Hashable {
    public var id: Int64 { revision }
    public let revision: Int64
    public let author: String
    public let date: Date
    public let message: String
}

public enum CommitTaskState: Equatable {
    case idle
    case running(String)
    case conflict(count: Int)
    case succeeded(String)
    case failed(String)
}

/// 待提交的一批改动（提交审查面板的数据源）
public struct CommitDraft {
    public var files: [ChangedFile]
    public var message: String = ""

    public var totalAdded: Int { files.reduce(0) { $0 + $1.added } }
    public var totalDeleted: Int { files.reduce(0) { $0 + $1.deleted } }
    public var risks: [ChangedFile] { files.filter { $0.risk != nil } }
    public var binaryCount: Int { files.filter(\.isBinary).count }
}
