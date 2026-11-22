import ApplicationServices
import Foundation

/// Drive the root AX event log (`recordRootAXEvent`, the event cursor, the change generation and the
/// bounded change wait) on observer states installed by hand. The observers are created for pids no
/// process owns and are never registered for notifications or attached to a run loop, so no callback fires;
/// the test records events itself. Every wait is given a deadline already past or a generation already
/// moved, so nothing sleeps.
func runRootEventAssertions() {
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink)
    let pid = Int32.max
    let otherPid = Int32.max - 1
    let element = AXUIElementCreateApplication(pid)
    guard let observer = rootTestObserver(pid), let otherObserver = rootTestObserver(otherPid) else {
        expect(false, "AXObserverCreate builds an unregistered observer")
        return
    }

    expect(bridge.rootEventCursor(pid: pid) == 1, "an unobserved pid starts its cursor at 1")
    expect(bridge.rootChangeGeneration(pid: pid) == 0, "an unobserved pid has generation 0")
    expect(bridge.rootEvents(pid: pid, since: 0).isEmpty, "an unobserved pid has no events")
    bridge.waitForRootChange(pid: pid, since: 0, until: .distantPast)
    bridge.recordRootAXEvent(observer: observer, notification: "AXWindowCreated", element: element)
    expect(bridge.rootEvents(pid: pid, since: 0).isEmpty && bridge.rootChangeGeneration(pid: pid) == 0, "an event for an unknown observer is dropped")

    let state = RootAXObserverState(pid: pid, observer: observer)
    let otherState = RootAXObserverState(pid: otherPid, observer: otherObserver)
    bridge.rootObservers[pid] = state
    bridge.rootObservers[otherPid] = otherState
    for index in 1...70 {
        bridge.recordRootAXEvent(observer: observer, notification: "AXNotification\(index)", element: element)
        expect(bridge.rootEvents(pid: pid, since: 0).count == min(index, 64), "the log holds \(min(index, 64)) events after \(index) records")
    }
    bridge.recordRootAXEvent(observer: otherObserver, notification: "AXSheetCreated", element: element)

    expect(bridge.rootEventCursor(pid: pid) == 71, "the cursor is the next sequence")
    expect(bridge.rootChangeGeneration(pid: pid) == 70, "every recorded event bumps the generation")
    let retained = bridge.rootEvents(pid: pid, since: 0)
    expect(retained.count == 64, "the log keeps the newest 64 events")
    expect(retained.map(\.sequence) == Array(7...70), "retained events keep their sequence order")
    expect(retained.first?.notification == "AXNotification7" && retained.last?.notification == "AXNotification70", "retained events keep their notifications")
    expect(retained.allSatisfy { $0.element.map { CFEqual($0, element) } == true }, "retained events keep their element")
    expect(bridge.rootEvents(pid: pid, since: 70).map(\.sequence) == [70], "the cursor is inclusive")
    expect(bridge.rootEvents(pid: pid, since: 71).isEmpty, "nothing is newer than the cursor")
    let other = bridge.rootEvents(pid: otherPid, since: 0)
    expect(other.map(\.notification) == ["AXSheetCreated"] && bridge.rootChangeGeneration(pid: otherPid) == 1, "an event goes only to its own observer's log")

    // A moved generation returns at once; an unmoved one waits only until the already past deadline.
    bridge.waitForRootChange(pid: pid, since: 69, until: .distantFuture)
    bridge.waitForRootChange(pid: pid, since: 70, until: .distantPast)
    expect(bridge.rootChangeGeneration(pid: pid) == 70, "waiting records nothing")
    print("macos root AX event log assertions passed")
}

private func rootTestObserver(_ pid: Int32) -> AXObserver? {
    var observer: AXObserver?
    guard AXObserverCreate(pid, { _, _, _, _ in }, &observer) == .success else { return nil }
    return observer
}
