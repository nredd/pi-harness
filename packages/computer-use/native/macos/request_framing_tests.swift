import Foundation
import Darwin

/// Real Bridge framing, completion and coercion paths with only IO/dispatch substituted.
func runRequestFramingAssertions() {
	var failures = 0
	func check(_ ok: Bool, _ name: String) {
		if !ok { failures += 1; print("FAIL: request framing: \(name)") }
	}
	func failure(_ code: String, _ message: String, _ body: () throws -> Any) {
		do { _ = try body(); check(false, "expected \(code): \(message)") }
		catch let error as BridgeFailure { check(error.code == code && error.message == message, "exact failure \(message)") }
		catch { check(false, "wrong error type: \(error)") }
	}
	var frames: [Data] = []
	var requests: [String] = []
	let client = UUID()
	let bridge = Bridge(dispatchRequest: { request, receivedClient in
		check(receivedClient == nil || receivedClient == client, "client identity preserved")
		requests.append(request["id"] as? String ?? "invalid")
		if request["cmd"] as? String == "refuse" { throw BridgeFailure(message: "refused", code: "blocked") }
		if request["cmd"] as? String == "throw" { throw NSError(domain: "fixture", code: 7, userInfo: [NSLocalizedDescriptionKey: "unexpected fixture failure"]) }
		return ["echo": request["text"] as? String ?? "ok"]
	}, readSession: { fatalError("injected dispatch must not read session") }, writeOutput: { frames.append($0) }, writeSocket: { _, bytes, count in
		frames.append(Data(bytes: bytes, count: count)); return count
	})
	func response(_ index: Int) -> [String: Any] {
		guard frames.indices.contains(index), let object = try? JSONSerialization.jsonObject(with: frames[index]) as? [String: Any] else {
			check(false, "response is JSON object"); return [:]
		}
		check(frames[index].last == 10 && frames[index].filter { $0 == 10 }.count == 1, "exactly one newline")
		return object
	}
	bridge.receiveInput(Data("\n  \n".utf8))
	bridge.receiveInput(Data([0xff, 10]))
	bridge.receiveInput(Data("{\"id\":\"one\",\"text\":\"".utf8))
	let unicode = Array("雪".utf8)
	bridge.receiveInput(Data(unicode.prefix(1)))
	check(frames.isEmpty && requests.isEmpty && bridge.completedRequestIds().isEmpty, "incomplete, blank and invalid UTF8 do not dispatch or complete")
	bridge.receiveInput(Data(unicode.dropFirst()) + Data("\"}\n{\"id\":\"two\"}\n".utf8))
	check(requests == ["one", "two"] && frames.count == 2, "split unicode and multiple frames dispatch in order")
	check(response(0)["id"] as? String == "one" && response(0)["ok"] as? Bool == true, "success id and status")
	check((response(0)["result"] as? [String: String]) == ["echo": "雪"], "unicode result preserved")
	check(Set(response(0).keys) == Set(["id", "ok", "result"]), "success keys")
	check(bridge.completedRequestIds().isEmpty, "stdio never records completion")
	for (index, line) in ["{", "[]", "{\"cmd\":\"refuse\",\"id\":\"blocked-id\"}", "{\"cmd\":\"throw\",\"id\":\"error-id\"}", "{}", "{\"id\":17}", "{\"id\":null}"].enumerated() {
		bridge.handleLine(line, to: 42, clientID: client)
		if index < 2 { check(bridge.completedRequestIds().isEmpty, "malformed and nonobject input never complete") }
	}
	let malformed = response(2)
	check(malformed["id"] as? String == "invalid" && malformed["ok"] as? Bool == false, "malformed JSON fallback id")
	check((malformed["error"] as? [String: String])?["code"] == "internal_error", "JSON parser retains internal_error wire behavior")
	check((response(3)["error"] as? [String: String]) == ["message": "Request must be a JSON object", "code": "invalid_request"], "nonobject exact failure")
	check((response(4)["error"] as? [String: String]) == ["message": "refused", "code": "blocked"] && response(4)["id"] as? String == "blocked-id", "BridgeFailure exact serialization")
	check((response(5)["error"] as? [String: String]) == ["message": "unexpected fixture failure", "code": "internal_error"] && response(5)["id"] as? String == "error-id", "unexpected error exact serialization")
	check(Set(response(4).keys) == Set(["id", "ok", "error"]), "failure keys")
	check((6...8).allSatisfy { response($0)["id"] as? String == "invalid" }, "missing numeric and null ids use fallback")
	check(bridge.completedRequestIds() == ["blocked-id", "error-id", "invalid"], "only parsed socket requests complete, fallback deduplicated")
	for index in 0..<34 { bridge.recordCompletedRequest("r\(index)") }
	check(bridge.completedRequestIds() == (2..<34).map { "r\($0)" }, "completion eviction keeps latest 32")
	bridge.recordCompletedRequest("r2")
	check(bridge.completedRequestIds() == (3..<34).map { "r\($0)" } + ["r2"], "duplicate completion refreshes recency")

	// A blocked writer proves completion is after send, not merely after dispatch.
	let entered = DispatchSemaphore(value: 0)
	let release = DispatchSemaphore(value: 0)
	let done = DispatchSemaphore(value: 0)
	let ordered = Bridge(dispatchRequest: { _, _ in ["ok": true] }, writeSocket: { _, _, count in
		entered.signal(); _ = release.wait(timeout: .now() + 5); return count
	})
	DispatchQueue.global().async { ordered.handleLine("{\"id\":\"pending\"}", to: 42); done.signal() }
	check(entered.wait(timeout: .now() + 5) == .success, "writer reached")
	check(ordered.completedRequestIds().isEmpty, "no completion before response write returns")
	release.signal()
	check(done.wait(timeout: .now() + 5) == .success && ordered.completedRequestIds() == ["pending"], "completion follows response write")

	// Exercise the production Darwin.send default on a disposable local socket, not the daemon.
	var sockets: [Int32] = [-1, -1]
	if socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 {
		defer { close(sockets[0]); close(sockets[1]) }
		Bridge().send(["id": "socketpair"], to: sockets[0])
		_ = shutdown(sockets[0], SHUT_WR)
		let reader = FileHandle(fileDescriptor: sockets[1], closeOnDealloc: false)
		let data = reader.readDataToEndOfFile()
		check((try? JSONSerialization.jsonObject(with: data) as? [String: String]) == ["id": "socketpair"] && data.last == 10, "default socket writer sends actual NDJSON")
	} else { check(false, "socketpair creation") }

	var bytes = Data()
	var remaining: [Int] = []
	let short = Bridge(writeSocket: { socket, pointer, count in
		check(socket == 42, "socket forwarded"); remaining.append(count)
		let sent = min(3, count); bytes.append(pointer.assumingMemoryBound(to: UInt8.self), count: sent); return sent
	})
	short.send(["id": "short"], to: 42)
	check((try? JSONSerialization.jsonObject(with: bytes) as? [String: String]) == ["id": "short"] && bytes.last == 10, "short writes preserve full NDJSON")
	check(remaining.count > 1 && zip(remaining, remaining.dropFirst()).allSatisfy { $0 - $1 == 3 }, "short writes advance offset and remaining length")
	for result in [0, -1] {
		var calls = 0
		let stopped = Bridge(dispatchRequest: { _, _ in [:] }, writeSocket: { _, _, _ in calls += 1; return result })
		stopped.handleLine("{\"id\":\"failed-write\"}", to: 42)
		check(calls == 1 && stopped.completedRequestIds() == ["failed-write"], "nonpositive write stops and still records processed request")
	}
	let before = frames.count
	bridge.send(["invalid": Double.nan])
	bridge.send(["invalid": Date()], to: 42)
	check(frames.count == before, "invalid output JSON is silently dropped")
	var stdioCalls = 0
	Bridge(writeOutput: { _ in stdioCalls += 1; throw NSError(domain: "fixture", code: 1) }).send(["ok": true])
	check(stdioCalls == 1, "stdio write failure remains ignored")

	var sessionReads = 0
	var routed: [Data] = []
	let actual = Bridge(readSession: { sessionReads += 1; return ["CGSSessionScreenIsLocked": true] }, writeOutput: { routed.append($0) })
	failure("invalid_args", "Missing string argument 'cmd'") { try actual.handleRequest([:], clientID: nil) }
	check(sessionReads == 0, "missing command validated before session read")
	failure("unknown_command", "Unknown command 'fixture-unknown'") { try actual.handleRequest(["cmd": "fixture-unknown"], clientID: nil) }
	failure("screen_locked", "screen_locked: the macOS session is locked, so 'act' is refused until it is unlocked") { try actual.handleRequest(["cmd": "act"], clientID: nil) }
	check(sessionReads == 2, "actual dispatch consults injected session")
	actual.handleLine("{\"id\":\"real-router\",\"cmd\":\"fixture-unknown\"}")
	actual.handleLine("{\"id\":\"locked-router\",\"cmd\":\"act\"}")
	let routedResponses = routed.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
	check(routedResponses.count == 2 && routedResponses[0]["id"] as? String == "real-router" && (routedResponses[0]["error"] as? [String: String])?["code"] == "unknown_command" && (routedResponses[1]["error"] as? [String: String])?["code"] == "screen_locked" && sessionReads == 4, "framing invokes actual router for unknown and locked commands")
	// No live command or shutdown is invoked here.
	for invalid: Any in [NSNull(), true, 7, 1.5, [], [:]] {
		failure("invalid_args", "Missing string argument 'value'") { try actual.stringArg(["value": invalid], "value") }
		check(actual.optionalStringArg(["value": invalid], "value") == nil, "optional string rejects \(invalid)")
	}
	check((try? actual.stringArg(["value": ""], "value")) == "" && actual.optionalStringArg(["value": "text"], "value") == "text", "string accepts empty and nonempty")
	check(actual.optionalStringArg([:], "value") == nil, "absent optional string")
	for request: [String: Any] in [[:], ["value": NSNull()], ["value": "7"], ["value": []]] {
		failure("invalid_args", "Missing integer argument 'value'") { try actual.intArg(request, "value") }
		failure("invalid_args", "Missing numeric argument 'value'") { try actual.doubleArg(request, "value") }
		check(actual.optionalIntArg(request, "value") == nil && actual.boolArg(request, "value") == nil, "optional numeric and bool reject invalid values")
	}
	for (value, expected): (Any, Int) in [(true, 1), (false, 0), (7, 7), (1.75, 1), (-1.75, -1), (NSNumber(value: 4.25), 4), (Int.max, Int.max), (Int.min, Int.min)] {
		check((try? actual.intArg(["value": value], "value")) == expected && actual.optionalIntArg(["value": value], "value") == expected, "integer coercion \(value)")
	}
	for (value, expected): (Any, Double) in [(true, 1), (7, 7), (1.75, 1.75), (NSNumber(value: -4.25), -4.25)] {
		check((try? actual.doubleArg(["value": value], "value")) == expected, "double coercion \(value)")
	}
	for (value, expected): (Any, Bool) in [(true, true), (false, false), (0, false), (2, true), (-0.5, true)] {
		check(actual.boolArg(["value": value], "value") == expected, "bool coercion \(value)")
	}
	for value: Any in [NSNull(), "12", 0, -1, UInt64(UInt32.max) + 1] {
		check(actual.positiveWindowId(["windowId": value]) == nil, "invalid window id \(value)")
	}
	check(actual.positiveWindowId([:]) == nil && actual.positiveWindowId(["windowId": UInt32.max]) == UInt32.max && actual.positiveWindowId(["windowId": 12.75]) == 12 && actual.positiveWindowId(["windowId": true]) == 1, "window id preserves numeric coercion and UInt32 bound")
	if failures > 0 { print("\(failures) request framing assertion(s) failed"); exit(1) }
	print("request framing assertions passed")
}
