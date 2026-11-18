import Foundation
import Security

let args = CommandLine.arguments
 guard args.count >= 3 else {
    fputs("usage: svn-credential-store <get|set|delete> <account-key>\n", stderr)
    exit(2)
}

let action = args[1]
let account = args[2]
let service = "com.fastsvn.svn-credentials"
let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

switch action {
case "get":
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { exit(status == errSecItemNotFound ? 1 : 2) }
    FileHandle.standardOutput.write(data)
case "set":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { exit(2) }
    let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            fputs("Keychain write failed: \(addStatus)\n", stderr)
            exit(2)
        }
    } else if status != errSecSuccess {
        fputs("Keychain update failed: \(status)\n", stderr)
        exit(2)
    }
case "delete":
    let status = SecItemDelete(base as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        fputs("Keychain delete failed: \(status)\n", stderr)
        exit(2)
    }
default:
    fputs("unknown operation\n", stderr)
    exit(2)
}
