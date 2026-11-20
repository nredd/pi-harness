import Foundation

/// Fail fast, keeping each test runner's diagnostic stream.
func expect(_ condition: @autoclosure () -> Bool, _ message: String, toStandardOutput: Bool = false) {
    guard !condition() else { return }
    let failure = "FAIL: \(message)"
    if toStandardOutput {
        print(failure)
    } else {
        FileHandle.standardError.write(Data("\(failure)\n".utf8))
    }
    exit(1)
}
