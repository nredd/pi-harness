import ApplicationServices
import Foundation

/// Drive the root AX event log (`installRootObserver`, `recordRootAXEvent`, the event cursor, the change
/// generation and the bounded change wait) on observer states keyed by plain identity tokens, so no
/// `AXObserver` and no Accessibility trust is needed. The test records events itself and observes
/// `waitForRootChange` through a recording `RootChangeWaiter`, so nothing sleeps.
func runRootEventAssertions() {
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink)
    let pid = Int32.max
    let otherPid = Int32.max - 1
    let element = AXUIElementCreateApplication(pid)
    let token: CFTypeRef = NSObject()
    let otherToken: CFTypeRef = NSObject()

    expect(bridge.rootEventCursor(pid: pid) == 1, "an unobserved pid starts its cursor at 1")
    expect(bridge.rootChangeGeneration(pid: pid) == 0, "an unobserved pid has generation 0")
    expect(bridge.rootEvents(pid: pid, since: 0).isEmpty, "an unobserved pid has no events")
    assertUnobservedWait(bridge, pid: pid)
    bridge.recordRootAXEvent(observer: token, notification: "AXWindowCreated", element: element)
    expect(bridge.rootEvents(pid: pid, since: 0).isEmpty && bridge.rootChangeGeneration(pid: pid) == 0, "an event for an unknown observer is dropped")

    bridge.installRootObserver(RootAXObserverState(pid: pid, observer: token))
    bridge.installRootObserver(RootAXObserverState(pid: otherPid, observer: otherToken))
    for index in 1...70 {
        bridge.recordRootAXEvent(observer: token, notification: "AXNotification\(index)", element: element)
        expect(bridge.rootEvents(pid: pid, since: 0).count == min(index, 64), "the log holds \(min(index, 64)) events after \(index) records")
    }
    bridge.recordRootAXEvent(observer: otherToken, notification: "AXSheetCreated", element: element)

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

    assertObservedWait(bridge, pid: pid)
    assertEviction()
    recordObserverCreation(bridge)
    print("macos root AX event log assertions passed")
}

/// What a `RootChangeWaiter` was asked to do, against a fixed clock.
private final class WaitRecorder {
    let now = Date(timeIntervalSinceReferenceDate: 1_000_000)
    var sleeps: [TimeInterval] = []
    var waits: [Date] = []

    var waiter: RootChangeWaiter {
        RootChangeWaiter(now: { self.now }, sleep: { self.sleeps.append($0) }, wait: { _, deadline in self.waits.append(deadline) })
    }
}

/// An unobserved pid sleeps for the 200 ms bound, cut to the deadline and never negative.
private func assertUnobservedWait(_ bridge: Bridge, pid: Int32) {
    for (offset, expected) in [(-5.0, 0.0), (0.125, 0.125), (10.0, 0.2)] {
        let recorder = WaitRecorder()
        bridge.waitForRootChange(pid: pid, since: 0, until: recorder.now.addingTimeInterval(offset), waiter: recorder.waiter)
        expect(recorder.sleeps == [expected] && recorder.waits.isEmpty, "an unobserved wait \(offset)s from its deadline sleeps \(expected)s")
    }
    bridge.waitForRootChange(pid: pid, since: 0, until: .distantPast)
}

/// A moved generation returns without waiting; an unmoved one waits once, bounded by 200 ms and the deadline.
private func assertObservedWait(_ bridge: Bridge, pid: Int32) {
    let moved = WaitRecorder()
    bridge.waitForRootChange(pid: pid, since: 69, until: .distantFuture, waiter: moved.waiter)
    expect(moved.waits.isEmpty && moved.sleeps.isEmpty, "a moved generation returns without waiting")
    let past = WaitRecorder()
    let pastDeadline = past.now.addingTimeInterval(-5)
    bridge.waitForRootChange(pid: pid, since: 70, until: pastDeadline, waiter: past.waiter)
    expect(past.waits == [pastDeadline] && past.sleeps.isEmpty, "an unmoved generation past its deadline waits only until that deadline")
    let bounded = WaitRecorder()
    bridge.waitForRootChange(pid: pid, since: 70, until: .distantFuture, waiter: bounded.waiter)
    expect(bounded.waits == [bounded.now.addingTimeInterval(0.2)], "an unmoved generation waits at most 200 ms")
    bridge.waitForRootChange(pid: pid, since: 70, until: .distantPast)
    expect(bridge.rootChangeGeneration(pid: pid) == 70, "waiting records nothing")
}

/// At the cap of four roots, installing a fifth evicts the least recently used one.
private func assertEviction() {
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink)
    let pids: [Int32] = [Int32.max - 10, Int32.max - 11, Int32.max - 12, Int32.max - 13, Int32.max - 14]
    let lastUsed: [TimeInterval] = [40, 10, 30, 20, 50]
    for (pid, used) in zip(pids, lastUsed) {
        let state = RootAXObserverState(pid: pid, observer: NSObject())
        state.nextSequence = 2
        state.lastUsed = used
        bridge.installRootObserver(state)
    }
    expect(bridge.rootEventCursor(pid: pids[1]) == 1, "the least recently used root is evicted at the cap")
    expect([0, 2, 3, 4].allSatisfy { bridge.rootEventCursor(pid: pids[$0]) == 2 }, "the other roots stay installed")
}

/// The one check that needs a real `AXObserver`: route an event recorded under it. `AXObserverCreate` may
/// reject a caller without Accessibility trust; that is reported as an explicit SKIP, not a failure.
private func recordObserverCreation(_ bridge: Bridge) {
    let pid = Int32.max - 2
    var observer: AXObserver?
    let status = AXObserverCreate(pid, { _, _, _, _ in }, &observer)
    guard status == .success, let observer else {
        print("SKIP: AXObserverCreate(\(pid)) returned AXError \(status.rawValue) for this caller; the AXObserver-keyed route is not exercised")
        return
    }
    bridge.installRootObserver(RootAXObserverState(pid: pid, observer: observer))
    bridge.recordRootAXEvent(observer: observer, notification: "AXMenuOpened", element: AXUIElementCreateApplication(pid))
    expect(bridge.rootEvents(pid: pid, since: 0).map(\.notification) == ["AXMenuOpened"], "an event recorded under a real AXObserver reaches its log")
    print("macos root AX observer: AXObserverCreate accepted pid \(pid); the AXObserver-keyed route is exercised")
}
